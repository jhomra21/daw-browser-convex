import { connectFxChain, createGainTransitionOwner, disconnectAudioNodes, type FxChainStageConfig, type GainTransitionOwner, type GainTransitionScheduler } from './effects/chain'
import type { CompressorChainState } from './effects/compressor-chain-state'
import type { DelayChainState } from './effects/delay-chain-state'
import type { ReverbChainState } from './effects/reverb-chain-state'
import type { SaturatorChainState } from './effects/saturator-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import type { SpectrumFrame } from './metering-runtime'
import type { AutomationAudioBinding } from './automation'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from './automation-bindings'
import { normalizeAudioEffectRuntimeInstances, type AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { ResolveMixerGraphOptions } from './mixer/types'
import { disconnectStaticWorkletNodeChain, resolveStaticWorkletAutomationBinding, subscribeStaticGateMeter, type GateMeterListener, type StaticWorkletNodeChain } from './effects/static-worklet-chain'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'
import { countStaticWorklets, isStaticWorkletKind, type LiveWorkletBudget } from './effects/live-worklet-budget'
import { getEffectChainTiming } from './effects/timing'
import { createChainAdmission } from './chain-admission'
import { closeResources, createEffectChainTransaction, type EffectChainOutcome, type InstanceResources } from './effect-chain-transaction'

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
  let analyser: AnalyserNode | null = null
  let spectrumTmp: Uint8Array<ArrayBuffer> | null = null
  let spectrumLast: SpectrumFrame | null = null
  let analyserConnected = false
  let releaseAnalyser: () => void = () => undefined
  let masterFxInstances: AudioEffectRuntimeInstance[] = []
  let masterChainInstances: AudioEffectRuntimeInstance[] = []
  const admission = createChainAdmission<MasterFxOutcome>(joinedOutcome)
  let fxInstanceRevision = 0
  // What the live nodes are known to hold, recorded when a request commits. A request superseded after it changed a node
  // leaves the node on its value, so the installed chain alone cannot say whether a request is already in place.
  const liveParams = new Map<string, AudioEffectRuntimeInstance['params']>()
  let routingGain: GainNode | null = null
  let releaseRoutingGain: () => void = () => undefined
  let routingTransitionOwner: GainTransitionOwner | null = null
  const instanceEqChains = new Map<string, BiquadFilterNode[]>()
  const instanceEqNodesByBand = new Map<string, Map<string, BiquadFilterNode>>()
  const instanceEqSignatures = new Map<string, string>()
  const instanceEqTopologySignatures = new Map<string, string>()
  const instanceCompressorChains = new Map<string, CompressorChainState>()
  const instanceReverbChains = new Map<string, ReverbChainState>()
  const instanceSaturatorChains = new Map<string, SaturatorChainState>()
  const instanceDelayChains = new Map<string, DelayChainState>()
  const instanceStaticWorkletChains = new Map<string, StaticWorkletNodeChain>()
  const compressorMeterListeners = new Map<string, Set<CompressorMeterListener>>()
  const compressorMeterSubscriptions = new Map<string, () => void>()
  const gateMeterListeners = new Map<string, Set<GateMeterListener>>()
  const gateMeterSubscriptions = new Map<string, () => void>()
  let currentBpm = 120
  let retiredResources: Array<{ resources: InstanceResources; ids: Set<string> }> = []
  let graphPublicationPending = false

  const currentResources = (): InstanceResources => ({
    eq: instanceEqChains,
    eqByBand: instanceEqNodesByBand,
    eqSignatures: instanceEqSignatures,
    eqTopologySignatures: instanceEqTopologySignatures,
    compressors: instanceCompressorChains,
    reverbs: instanceReverbChains,
    saturators: instanceSaturatorChains,
    delays: instanceDelayChains,
    staticWorklets: instanceStaticWorkletChains,
  })

  const drainRetiredResources = () => {
    for (const { resources, ids } of retiredResources) closeResources(resources, ids)
    retiredResources = []
  }

  const replaceMap = <Value,>(target: Map<string, Value>, source: Map<string, Value>) => {
    target.clear()
    for (const [id, value] of source) target.set(id, value)
  }

  const publishResources = (resources: InstanceResources) => {
    replaceMap(instanceEqChains, resources.eq)
    replaceMap(instanceEqNodesByBand, resources.eqByBand)
    replaceMap(instanceEqSignatures, resources.eqSignatures)
    replaceMap(instanceEqTopologySignatures, resources.eqTopologySignatures)
    replaceMap(instanceCompressorChains, resources.compressors)
    replaceMap(instanceReverbChains, resources.reverbs)
    replaceMap(instanceSaturatorChains, resources.saturators)
    replaceMap(instanceDelayChains, resources.delays)
    replaceMap(instanceStaticWorkletChains, resources.staticWorklets)
  }

  const closeInstanceState = (instanceId: string) => {
    compressorMeterSubscriptions.get(instanceId)?.()
    compressorMeterSubscriptions.delete(instanceId)
    gateMeterSubscriptions.get(instanceId)?.()
    gateMeterSubscriptions.delete(instanceId)
    const eq = instanceEqChains.get(instanceId)
    if (eq) disconnectAudioNodes(eq)
    instanceEqChains.delete(instanceId)
    instanceEqNodesByBand.delete(instanceId)
    instanceEqSignatures.delete(instanceId)
    instanceEqTopologySignatures.delete(instanceId)
    instanceCompressorChains.get(instanceId)?.close()
    instanceCompressorChains.delete(instanceId)
    instanceReverbChains.get(instanceId)?.close()
    instanceReverbChains.delete(instanceId)
    instanceSaturatorChains.get(instanceId)?.close()
    instanceSaturatorChains.delete(instanceId)
    instanceDelayChains.get(instanceId)?.close()
    instanceDelayChains.delete(instanceId)
    const staticWorklet = instanceStaticWorkletChains.get(instanceId)
    if (staticWorklet) disconnectStaticWorkletNodeChain(staticWorklet)
    instanceStaticWorkletChains.delete(instanceId)
    liveParams.delete(instanceId)
  }

  const bindGateMeter = (instanceId: string, chain: StaticWorkletNodeChain) => {
    gateMeterSubscriptions.get(instanceId)?.()
    gateMeterSubscriptions.delete(instanceId)
    const listeners = gateMeterListeners.get(instanceId)
    if (chain.kind !== 'gate' && chain.kind !== 'limiter' || !listeners || listeners.size === 0) return
    gateMeterSubscriptions.set(instanceId, subscribeStaticGateMeter(chain, (frame) => {
      for (const listener of listeners) listener(frame)
    }))
  }

  const bindCompressorMeter = (instanceId: string, state: CompressorChainState) => {
    compressorMeterSubscriptions.get(instanceId)?.()
    compressorMeterSubscriptions.delete(instanceId)
    const listeners = compressorMeterListeners.get(instanceId)
    if (!listeners || listeners.size === 0) return
    compressorMeterSubscriptions.set(instanceId, state.subscribeMeter((frame) => {
      for (const listener of listeners) listener(frame)
    }))
  }

  const closeAllInstanceStates = () => {
    const ids = new Set<string>()
    for (const id of instanceEqChains.keys()) ids.add(id)
    for (const id of instanceCompressorChains.keys()) ids.add(id)
    for (const id of instanceReverbChains.keys()) ids.add(id)
    for (const id of instanceSaturatorChains.keys()) ids.add(id)
    for (const id of instanceDelayChains.keys()) ids.add(id)
    for (const id of instanceStaticWorkletChains.keys()) ids.add(id)
    for (const id of ids) closeInstanceState(id)
  }

  const createInstanceStageConfigs = (
    instances: AudioEffectRuntimeInstance[],
    resources: InstanceResources = currentResources(),
  ): FxChainStageConfig[] => instances.map((instance) => ({
    id: instance.id,
    kind: instance.kind,
    eqNodes: instance.kind === 'eq' ? resources.eq.get(instance.id) : undefined,
    compressorChain: instance.kind === 'compressor' ? resources.compressors.get(instance.id)?.chain() : undefined,
    saturatorChain: instance.kind === 'saturator' ? resources.saturators.get(instance.id)?.chain() : undefined,
    delayChain: instance.kind === 'delay' ? resources.delays.get(instance.id)?.chain() : undefined,
    reverbChain: instance.kind === 'reverb' ? resources.reverbs.get(instance.id)?.chain() : undefined,
    staticWorkletChain: isStaticWorkletKind(instance.kind) ? resources.staticWorklets.get(instance.id) : undefined,
  }))

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
    if (analyserConnected && analyser) {
      try { masterGain.disconnect(analyser) } catch {}
    }
    analyserConnected = false
    const reconnect = () => {
      wasPending = graphPublicationPending
      graphPublicationPending = true
      disconnectAudioNodes([nextRoutingGain])
      connectFxChain(nextRoutingGain, destination, {
        instances: createInstanceStageConfigs(masterChainInstances),
      })
      if (analyser) {
        masterGain.connect(analyser)
        analyserConnected = true
      }
      drainRetiredResources()
    }
    routingTransitionOwner?.request(
      reconnect,
      () => {
        if (!wasPending) graphPublicationPending = false
      },
    )
  }

  const ensureAnalyser = (ctx: AudioContext | null, masterGain: GainNode | null) => {
    if (!ctx || !masterGain) return
    if (!analyser) {
      const next = ctx.createAnalyser()
      next.fftSize = 2048
      next.smoothingTimeConstant = 0.8
      analyser = next
      releaseAnalyser = observeResource(options.resourceObserver, 'audio-nodes', next)
    }
    if (analyser && !analyserConnected) {
      masterGain.connect(analyser)
      analyserConnected = true
    }
  }

  const bypassStaticWorklet = (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    instanceId: string,
    chain: StaticWorkletNodeChain,
  ) => {
    if (instanceStaticWorkletChains.get(instanceId) !== chain) return
    fxInstanceRevision += 1
    closeInstanceState(instanceId)
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
    resources: currentResources,
    publishResources,
    retire: (resources, ids) => { retiredResources.push({ resources, ids }) },
    liveParams: () => liveParams,
    revision: () => fxInstanceRevision,
    bumpRevision: () => ++fxInstanceRevision,
    publicationPending: () => graphPublicationPending,
    beginPublication: () => { graphPublicationPending = true },
    finishPublication: () => { graphPublicationPending = false },
    bypassStaticWorklet: (instanceId, chain) => bypassStaticWorklet(ctx, masterGain, destination, instanceId, chain),
    bindStaticWorkletMeter: bindGateMeter,
    bindCompressorMeter,
    route: ({ previous, instances: installed, ownedIds, requiresRoutingRebuild, publicationPending }) => {
      const rebuild = requiresRoutingRebuild || publicationPending
      if (rebuild) {
        rebuildRouting(ctx, masterGain, destination)
      } else if (!routingTransitionOwner?.pending()) {
        drainRetiredResources()
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
    subscribeCompressorMeter: (instanceId: string, listener: CompressorMeterListener) => {
      let listeners = compressorMeterListeners.get(instanceId)
      if (!listeners) {
        listeners = new Set()
        compressorMeterListeners.set(instanceId, listeners)
      }
      listeners.add(listener)
      const state = instanceCompressorChains.get(instanceId)
      if (state && !compressorMeterSubscriptions.has(instanceId)) bindCompressorMeter(instanceId, state)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        compressorMeterSubscriptions.get(instanceId)?.()
        compressorMeterSubscriptions.delete(instanceId)
        compressorMeterListeners.delete(instanceId)
      }
    },
    subscribeGateMeter: (instanceId: string, listener: GateMeterListener) => {
      let listeners = gateMeterListeners.get(instanceId)
      if (!listeners) {
        listeners = new Set()
        gateMeterListeners.set(instanceId, listeners)
      }
      listeners.add(listener)
      const chain = instanceStaticWorkletChains.get(instanceId)
      if (chain && !gateMeterSubscriptions.has(instanceId)) bindGateMeter(instanceId, chain)
      return () => {
        listener({ gainReductionDb: 0 })
        listeners.delete(listener)
        if (listeners.size > 0) return
        gateMeterSubscriptions.get(instanceId)?.()
        gateMeterSubscriptions.delete(instanceId)
        gateMeterListeners.delete(instanceId)
      }
    },
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
      for (const [instanceId, state] of instanceDelayChains) {
        try {
          state.setBpm(bpm)
        } catch (error) {
          fxInstanceRevision += 1
          liveParams.delete(instanceId)
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
      if (effectInstanceId) {
        return [
          ...resolveEqAutomationBindings(instanceEqNodesByBand.get(effectInstanceId) ?? new Map(), parameterId),
          ...resolveSaturatorAutomationBindings(instanceSaturatorChains.get(effectInstanceId), parameterId),
          ...resolveDelayAutomationBindings(instanceDelayChains.get(effectInstanceId), parameterId),
          ...resolveReverbAutomationBindings(instanceReverbChains.get(effectInstanceId), parameterId),
          ...resolveStaticWorkletAutomationBinding(instanceStaticWorkletChains.get(effectInstanceId), parameterId),
        ]
      }
      const eqNodes = new Map<string, BiquadFilterNode>()
      for (const nodesByBand of instanceEqNodesByBand.size === 1 ? instanceEqNodesByBand.values() : []) {
        for (const [bandId, node] of nodesByBand) eqNodes.set(bandId, node)
      }
      return [
        ...resolveEqAutomationBindings(eqNodes, parameterId),
        ...Array.from(instanceSaturatorChains.size === 1 ? instanceSaturatorChains.values() : []).flatMap((state) => resolveSaturatorAutomationBindings(state, parameterId)),
        ...Array.from(instanceDelayChains.size === 1 ? instanceDelayChains.values() : []).flatMap((state) => resolveDelayAutomationBindings(state, parameterId)),
        ...Array.from(instanceReverbChains.size === 1 ? instanceReverbChains.values() : []).flatMap((state) => resolveReverbAutomationBindings(state, parameterId)),
      ]
    },
    rebuildRouting,
    getSpectrum: (ctx: AudioContext | null, masterGain: GainNode | null) => {
      ensureAnalyser(ctx, masterGain)
      if (!analyser) return spectrumLast
      if (!spectrumTmp || spectrumTmp.length !== analyser.frequencyBinCount) {
        spectrumTmp = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      }
      try { analyser.getByteFrequencyData(spectrumTmp) } catch { return spectrumLast }
      let sum = 0
      for (let i = 0; i < spectrumTmp.length; i++) sum += spectrumTmp[i]
      if (sum === 0) {
        spectrumLast = null
        return null
      }
      let out = spectrumLast?.data
      if (!out || out.length !== spectrumTmp.length) out = new Float32Array(spectrumTmp.length)
      for (let i = 0; i < out.length; i++) out[i] = spectrumTmp[i] / 255
      spectrumLast = {
        data: out,
        sampleRate: ctx?.sampleRate ?? 44100,
        fftSize: analyser.fftSize,
        binCount: analyser.frequencyBinCount,
      }
      return spectrumLast
    },
    close: () => {
      releaseAnalyser()
      releaseAnalyser = () => undefined
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
      closeAllInstanceStates()
      drainRetiredResources()
      options.workletBudget.releaseOwner('master')
      compressorMeterSubscriptions.clear()
      compressorMeterListeners.clear()
      disconnectAudioNodes([analyser])
      analyser = null
      spectrumTmp = null
      spectrumLast = null
      analyserConnected = false
    },
  }
}
