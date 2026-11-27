import type { SpectrumSettings } from '@daw-browser/shared'
import { DEFAULT_BPM } from '@daw-browser/timeline-core/project-defaults'
import { connectFxChain, createGainTransitionOwner, disconnectAudioNodes, type GainTransitionOwner, type GainTransitionScheduler } from './effects/chain'
import { createSpectrumTap } from './spectrum-analyser'
import type { AutomationAudioBinding } from './automation'
import { normalizeAudioEffectRuntimeInstances, type AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { ResolveMixerGraphOptions } from './mixer/types'
import type { StaticWorkletNodeChain } from './effects/static-worklet-chain'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'
import { countStaticWorklets, type LiveWorkletBudget } from './effects/live-worklet-budget'
import { getEffectChainTiming } from './effects/timing'
import { createChainAdmission } from './chain-admission'
import { createEffectChainTransaction, type EffectChainOutcome } from './effect-chain-transaction'
import { createChainInstanceState } from './chain-instance-state'

type MasterFxRuntimeOptions = {
  getFaultGeneration: () => number
  workletBudget: LiveWorkletBudget
  transitionScheduler?: GainTransitionScheduler
  onWorkletFault?: (generation: number, kind: 'compressor' | 'owned-processor', code: string, context: string) => void
  resourceObserver?: ResourceObserver
}

type MasterFxOutcome = EffectChainOutcome

// A request that joins work is 'joined' only when that work installed; any other outcome is the joined request's too.
const joinedOutcome = (underlying: MasterFxOutcome): MasterFxOutcome => (
  { ...underlying, disposition: underlying.disposition === 'applied' ? 'joined' : underlying.disposition }
)

export function createMasterFxRuntime(options: MasterFxRuntimeOptions) {
  let spectrumTap: ReturnType<typeof createSpectrumTap> | null = null
  let analyserConnected = false
  let masterFxInstances: AudioEffectRuntimeInstance[] = []
  let masterChainInstances: AudioEffectRuntimeInstance[] = []
  const admission = createChainAdmission<MasterFxOutcome>(joinedOutcome)
  let fxInstanceRevision = 0
  let routingGain: GainNode | null = null
  let releaseRoutingGain: () => void = () => undefined
  let routingTransitionOwner: GainTransitionOwner | null = null
  const instanceState = createChainInstanceState()
  let currentBpm = DEFAULT_BPM
  let graphPublicationPending = false

  const rebuildRouting = (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
  ) => {
    let wasPending = false
    let nextRoutingGain = routingGain

    if (!nextRoutingGain) {
      nextRoutingGain = ctx.createGain()
      nextRoutingGain.gain.value = 1
      routingGain = nextRoutingGain
      releaseRoutingGain = observeResource(options.resourceObserver, 'audio-nodes', nextRoutingGain)
      masterGain.connect(nextRoutingGain)
      routingTransitionOwner = createGainTransitionOwner(nextRoutingGain, () => ctx.currentTime, options.transitionScheduler)
    }

    if (analyserConnected) spectrumTap?.detach()

    analyserConnected = false

    const reconnect = () => {
      wasPending = graphPublicationPending
      graphPublicationPending = true
      disconnectAudioNodes([nextRoutingGain])
      connectFxChain(nextRoutingGain, destination, {
        instances: instanceState.stageConfigs(masterChainInstances),
      })

      if (spectrumTap) {
        spectrumTap.attach()
        analyserConnected = true
      }

      instanceState.drainRetired()
    }

    routingTransitionOwner?.request(
      reconnect,
      () => {
        if (!wasPending) graphPublicationPending = false
      },
    )
  }

  const ensureSpectrumTap = (ctx: AudioContext | null, masterGain: GainNode | null) => {
    if (!ctx || !masterGain) return

    if (spectrumTap && spectrumTap.source !== masterGain) {
      spectrumTap.dispose()
      spectrumTap = null
    }

    spectrumTap ??= createSpectrumTap(ctx, masterGain, (node) => observeResource(options.resourceObserver, 'audio-nodes', node))

    if (!analyserConnected) {
      spectrumTap.attach()
      analyserConnected = true
    }
  }

  const bypassStaticWorklet = (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    instanceId: string,
    staticWorklet: StaticWorkletNodeChain,
  ) => {
    if (instanceState.resources.staticWorklets.get(instanceId) !== staticWorklet) return
    fxInstanceRevision += 1
    instanceState.close(instanceId)
    const requested = admission.intent()

    if (requested) admission.adopt(requested.filter((instance) => instance.id !== instanceId))
    masterChainInstances = masterChainInstances.filter((instance) => instance.id !== instanceId)
    masterFxInstances = masterChainInstances
    const transaction = options.workletBudget.begin('master', 0)
    options.workletBudget.commit(transaction, countStaticWorklets(masterChainInstances))

    try {
      rebuildRouting(ctx, masterGain, destination)
    } catch (error) {
      graphPublicationPending = true
      throw error
    }
  }

  const installFxInstances = (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    instances: AudioEffectRuntimeInstance[],
  ) => createEffectChainTransaction({
    owner: 'master',
    budget: options.workletBudget,
    bpm: () => currentBpm,
    eqChannelCount: () => ctx.destination.maxChannelCount || 2,
    faultGeneration: options.getFaultGeneration,
    reportFault: (generation, kind, code, context) => options.onWorkletFault?.(generation, kind, code, context),
    installed: () => masterChainInstances,
    install: (installed) => {
      masterChainInstances = installed
      masterFxInstances = installed
    },
    resources: () => instanceState.resources,
    publishResources: instanceState.publish,
    retire: instanceState.retire,
    liveParams: () => instanceState.liveParams,
    revision: () => fxInstanceRevision,
    bumpRevision: () => ++fxInstanceRevision,
    publicationPending: () => graphPublicationPending,
    beginPublication: () => { graphPublicationPending = true },
    finishPublication: () => { graphPublicationPending = false },
    bypassStaticWorklet: (instanceId, staticWorklet) => bypassStaticWorklet(ctx, masterGain, destination, instanceId, staticWorklet),
    bindStaticWorkletMeter: instanceState.bindGateMeter,
    bindCompressorMeter: instanceState.bindCompressorMeter,
    route: ({ previous, instances: installed, ownedIds, requiresRoutingRebuild, publicationPending }) => {
      const rebuild = requiresRoutingRebuild || publicationPending

      if (rebuild) {
        rebuildRouting(ctx, masterGain, destination)
      } else if (!routingTransitionOwner?.pending()) {
        instanceState.drainRetired()
      }

      return {
        settled: true,
        inPlace: ownedIds.size === 0 && !rebuild &&
          getEffectChainTiming(previous ?? [], ctx.sampleRate, currentBpm).latencyFrames ===
            getEffectChainTiming(installed, ctx.sampleRate, currentBpm).latencyFrames,
      }
    },
  }).apply(ctx, instances)

  const noInstall: MasterFxOutcome = { disposition: 'dropped', inPlace: false }

  return {
    // The chain asked for before there was a context installs through the same path as any request. installFxInstances
    // has already reported a failure.
    applyPending: (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode) => {
      void admission.replay((instances) => installFxInstances(ctx, masterGain, destination, instances), noInstall)?.catch(() => undefined)
      rebuildRouting(ctx, masterGain, destination)
    },
    subscribeCompressorMeter: instanceState.subscribeCompressorMeter,
    subscribeGateMeter: instanceState.subscribeGateMeter,
    // Gate and Limiter share the static worklet's positive gain-reduction frame.
    subscribeLimiterMeter: instanceState.subscribeGateMeter,
    // Every chain request, whole or single, goes through the admission: an equal request joins the work still running
    // (failure included) and a different one supersedes it in applyFxInstances. Without a context the request is only
    // kept, and the revision moves so the work of the chain it replaces cannot commit over it.
    setFxInstances: (
      ctx: AudioContext | null,
      masterGain: GainNode | null,
      destination: AudioDestinationNode | null,
      instances: AudioEffectRuntimeInstance[],
    ): Promise<MasterFxOutcome> => {
      if (!ctx || !masterGain) fxInstanceRevision += 1

      return admission.admit(
        normalizeAudioEffectRuntimeInstances(instances),
        ctx && masterGain ? (chain) => installFxInstances(ctx, masterGain, destination ?? ctx.destination, chain) : undefined,
        noInstall,
      )
    },
    // The chain last requested, installed or not.
    retainedInstances: (): readonly AudioEffectRuntimeInstance[] => admission.intent() ?? masterChainInstances,
    setBpm: (bpm: number) => {
      currentBpm = bpm
      let failure: unknown

      for (const [instanceId, state] of instanceState.resources.delays) {
        try {
          state.setBpm(bpm)
        } catch (error) {
          fxInstanceRevision += 1
          instanceState.liveParams.delete(instanceId)
          failure ??= error
        }
      }

      if (failure !== undefined) throw failure
    },
    getMixerFx: (): Pick<
      ResolveMixerGraphOptions,
      'masterFxInstances'
    > => ({
      masterFxInstances,
    }),
    resolveMasterAutomationBindings: (parameterId: string, masterGain: GainNode | null, effectInstanceId?: string): AutomationAudioBinding[] => {
      if (parameterId === 'volume') return masterGain ? [{ param: masterGain.gain, valueToAudioValue: (value) => value }] : []

      return instanceState.automationBindings(parameterId, effectInstanceId)
    },
    rebuildRouting,
    getSpectrum: (ctx: AudioContext | null, masterGain: GainNode | null, settings: SpectrumSettings) => {
      ensureSpectrumTap(ctx, masterGain)

      return spectrumTap?.read(settings) ?? null
    },
    close: () => {
      releaseRoutingGain()
      releaseRoutingGain = () => undefined
      routingTransitionOwner?.dispose()
      routingTransitionOwner = null
      disconnectAudioNodes([routingGain])
      routingGain = null
      masterFxInstances = []
      masterChainInstances = []
      graphPublicationPending = false
      fxInstanceRevision += 1
      admission.reset()
      instanceState.closeAll()
      instanceState.drainRetired()
      options.workletBudget.releaseOwner('master')
      instanceState.forgetCompressorMeterListeners()
      spectrumTap?.dispose()
      spectrumTap = null
      analyserConnected = false
    },
  }
}
