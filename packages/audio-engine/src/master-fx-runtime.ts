import { normalizeCompressorParams, normalizeEqParams, serializeNormalizedEqParams, type EqParamsLite } from '@daw-browser/shared'
import { connectFxChain, createCompressorNodeChain, createGainTransitionOwner, disconnectAudioNodes, type CreateReverbImpulseResponse, type FxChainStageConfig, type GainTransitionOwner } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { createCompressorChainState } from './effects/compressor-chain-state'
import { createDelayChainState } from './effects/delay-chain-state'
import { createReverbChainState } from './effects/reverb-chain-state'
import { createSaturatorChainState } from './effects/saturator-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import type { SpectrumFrame } from './metering-runtime'
import type { AutomationAudioBinding } from './automation'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from './automation-bindings'
import { normalizeAudioEffectRuntimeInstances, type AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { ResolveMixerGraphOptions } from './mixer/types'
import { applyStaticWorkletNodeParams, createStaticWorkletNodeChain, disconnectStaticWorkletNodeChain, resolveStaticWorkletAutomationBinding, subscribeStaticGateMeter, type GateMeterListener, type StaticWorkletKind, type StaticWorkletNodeChain } from './effects/static-worklet-chain'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'
import { countStaticWorklets, isStaticWorkletKind, type LiveWorkletReservation } from './effects/live-worklet-budget'
const isStaticWorkletInstance = (
  instance: AudioEffectRuntimeInstance,
): instance is Extract<AudioEffectRuntimeInstance, { kind: StaticWorkletKind }> => isStaticWorkletKind(instance.kind)

type MasterFxRuntimeOptions = {
  getFaultGeneration: () => number
  workletBudget: {
    reserve: (owner: string, count: number) => LiveWorkletReservation
    rollback: (reservation: LiveWorkletReservation) => void
    releaseOwner: (owner: string) => void
  }
  onWorkletFault?: (generation: number, kind: 'compressor' | 'owned-processor', code: string, context: string) => void
  resourceObserver?: ResourceObserver
}

export function createMasterFxRuntime(options: MasterFxRuntimeOptions) {
  let analyser: AnalyserNode | null = null
  let spectrumTmp: Uint8Array<ArrayBuffer> | null = null
  let spectrumLast: SpectrumFrame | null = null
  let analyserConnected = false
  let releaseAnalyser: () => void = () => undefined
  let masterFxInstances: AudioEffectRuntimeInstance[] = []
  let pendingFxInstances: AudioEffectRuntimeInstance[] | null = null
  let fxInstanceRevision = 0
  let routingGain: GainNode | null = null
  let releaseRoutingGain: () => void = () => undefined
  let routingTransitionOwner: GainTransitionOwner | null = null
  const instanceEqChains = new Map<string, BiquadFilterNode[]>()
  const instanceEqNodesByBand = new Map<string, Map<string, BiquadFilterNode>>()
  const instanceEqSignatures = new Map<string, string>()
  const instanceEqTopologySignatures = new Map<string, string>()
  const instanceCompressorChains = new Map<string, ReturnType<typeof createCompressorChainState>>()
  const instanceReverbChains = new Map<string, ReturnType<typeof createReverbChainState>>()
  const instanceSaturatorChains = new Map<string, ReturnType<typeof createSaturatorChainState>>()
  const instanceDelayChains = new Map<string, ReturnType<typeof createDelayChainState>>()
  const instanceStaticWorkletChains = new Map<string, StaticWorkletNodeChain>()
  const compressorMeterListeners = new Map<string, Set<CompressorMeterListener>>()
  const compressorMeterSubscriptions = new Map<string, () => void>()
  const gateMeterListeners = new Map<string, Set<GateMeterListener>>()
  const gateMeterSubscriptions = new Map<string, () => void>()
  let currentBpm = 120

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

  const bindCompressorMeter = (instanceId: string, state: ReturnType<typeof createCompressorChainState>) => {
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

  const createInstanceStageConfigs = (instances: AudioEffectRuntimeInstance[]): FxChainStageConfig[] => instances.map((instance) => ({
    id: instance.id,
    kind: instance.kind,
    eqNodes: instance.kind === 'eq' ? instanceEqChains.get(instance.id) : undefined,
    compressorChain: instance.kind === 'compressor' ? instanceCompressorChains.get(instance.id)?.chain() : undefined,
    saturatorChain: instance.kind === 'saturator' ? instanceSaturatorChains.get(instance.id)?.chain() : undefined,
    delayChain: instance.kind === 'delay' ? instanceDelayChains.get(instance.id)?.chain() : undefined,
    reverbChain: instance.kind === 'reverb' ? instanceReverbChains.get(instance.id)?.chain() : undefined,
    staticWorkletChain: isStaticWorkletKind(instance.kind) ? instanceStaticWorkletChains.get(instance.id) : undefined,
  }))

  const rebuildRouting = (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode) => {
    let nextRoutingGain = routingGain
    if (!nextRoutingGain) {
      nextRoutingGain = ctx.createGain()
      nextRoutingGain.gain.value = 1
      routingGain = nextRoutingGain
      releaseRoutingGain = observeResource(options.resourceObserver, 'audio-nodes', nextRoutingGain)
      masterGain.connect(nextRoutingGain)
      routingTransitionOwner = createGainTransitionOwner(nextRoutingGain, () => ctx.currentTime)
    }
    if (analyserConnected && analyser) {
      try { masterGain.disconnect(analyser) } catch {}
    }
    analyserConnected = false
    const reconnect = () => {
      disconnectAudioNodes([nextRoutingGain])
      connectFxChain(nextRoutingGain, destination, {
        instances: createInstanceStageConfigs(masterFxInstances),
      })
      if (analyser) {
        masterGain.connect(analyser)
        analyserConnected = true
      }
    }
    routingTransitionOwner?.request(reconnect)
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

  const applyInstanceEq = (ctx: AudioContext, instanceId: string, params: EqParamsLite): boolean => {
    const normalized = normalizeEqParams(params)
    const signature = serializeNormalizedEqParams(normalized)
    if (instanceEqSignatures.get(instanceId) === signature) return false
    const topologySignature = getEqTopologySignature(normalized)
    const old = instanceEqChains.get(instanceId)
    if (old && instanceEqTopologySignatures.get(instanceId) === topologySignature) {
      applyEqNodeParams(old, normalized)
      instanceEqSignatures.set(instanceId, signature)
      return false
    }
    if (old) disconnectAudioNodes(old)
    const nodes = createEqNodes(ctx, normalized, ctx.destination.maxChannelCount || 2)
    instanceEqChains.set(instanceId, nodes)
    instanceEqNodesByBand.set(instanceId, new Map(normalized.bands.filter((band) => band.enabled).flatMap((band, index) => {
      const node = nodes[index]
      return node ? [[band.id, node]] : []
    })))
    instanceEqSignatures.set(instanceId, signature)
    instanceEqTopologySignatures.set(instanceId, topologySignature)
    return true
  }

  const bypassStaticWorklet = (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    instanceId: string,
    chain: StaticWorkletNodeChain,
    revision: number,
  ) => {
    if (fxInstanceRevision !== revision || instanceStaticWorkletChains.get(instanceId) !== chain) return
    closeInstanceState(instanceId)
    masterFxInstances = masterFxInstances.filter((instance) => instance.id !== instanceId)
    options.workletBudget.reserve('master', countStaticWorklets(masterFxInstances))
    rebuildRouting(ctx, masterGain, destination)
  }

  const applyFxInstances = async (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    createImpulseResponse: CreateReverbImpulseResponse,
    instances: AudioEffectRuntimeInstance[],
  ) => {
    const revision = ++fxInstanceRevision
    const inputIds = new Set<string>()
    for (const instance of instances) {
      if (inputIds.has(instance.id)) throw new Error(`Duplicate effect instance ID: ${instance.id}`)
      inputIds.add(instance.id)
    }
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    const reservation = options.workletBudget.reserve('master', countStaticWorklets(normalized))
    const previous = masterFxInstances
    const orderChanged = Boolean(previous && (
      previous.length !== normalized.length ||
      previous.some((instance, index) => instance.id !== normalized[index]?.id || instance.kind !== normalized[index]?.kind)
    ))
    const spectralTimingChanged = normalized.some((instance) => {
      if (instance.kind !== 'spectral') return false
      const prior = previous.find((candidate) => candidate.id === instance.id)
      return prior?.kind !== 'spectral' ||
        prior.params.state.fftSize !== instance.params.state.fftSize ||
        prior.params.state.overlap !== instance.params.state.overlap
    })
    if (normalized.length === 0) {
      masterFxInstances = []
      pendingFxInstances = null
      closeAllInstanceStates()
      options.workletBudget.releaseOwner('master')
      rebuildRouting(ctx, masterGain, destination)
      return
    }
    masterFxInstances = normalized
    const activeIds = new Set(normalized.map((instance) => instance.id))
    const staleIds = new Set<string>()
    for (const id of instanceEqChains.keys()) if (!activeIds.has(id)) staleIds.add(id)
    for (const id of instanceCompressorChains.keys()) if (!activeIds.has(id)) staleIds.add(id)
    for (const id of instanceReverbChains.keys()) if (!activeIds.has(id)) staleIds.add(id)
    for (const id of instanceSaturatorChains.keys()) if (!activeIds.has(id)) staleIds.add(id)
    for (const id of instanceDelayChains.keys()) if (!activeIds.has(id)) staleIds.add(id)
    for (const id of instanceStaticWorkletChains.keys()) if (!activeIds.has(id)) staleIds.add(id)
    for (const id of staleIds) closeInstanceState(id)

    let requiresRoutingRebuild = staleIds.size > 0 || orderChanged || spectralTimingChanged
    try {
      for (const instance of normalized) {
      if (isStaticWorkletInstance(instance)) {
        const existing = instanceStaticWorkletChains.get(instance.id)
        if (existing?.kind === instance.kind && existing.state === 'active') {
          applyStaticWorkletNodeParams(existing, instance.params)
        } else {
          if (existing) disconnectStaticWorkletNodeChain(existing)
          try {
            const faultGeneration = options.getFaultGeneration()
            let created: StaticWorkletNodeChain | undefined
            created = await createStaticWorkletNodeChain(ctx, instance.kind, instance.params, (code) => {
              if (!created) return
              bypassStaticWorklet(ctx, masterGain, destination, instance.id, created, revision)
              options.onWorkletFault?.(faultGeneration, 'owned-processor', code, `master:effect:${instance.id}`)
            })
            if (fxInstanceRevision !== revision) {
              disconnectStaticWorkletNodeChain(created)
              return
            }
            instanceStaticWorkletChains.set(instance.id, created)
            bindGateMeter(instance.id, created)
          } catch (error) {
            instanceStaticWorkletChains.delete(instance.id)
            throw error
          }
          requiresRoutingRebuild = true
        }
        continue
      }
      if (instance.kind === 'eq') {
        requiresRoutingRebuild = applyInstanceEq(ctx, instance.id, instance.params) || requiresRoutingRebuild
        continue
      }
      if (instance.kind === 'compressor') {
        let state = instanceCompressorChains.get(instance.id)
        if (!state) {
          const faultGeneration = options.getFaultGeneration()
          state = createCompressorChainState((ctx, params) =>
            createCompressorNodeChain(ctx, params, (code) =>
              options.onWorkletFault?.(faultGeneration, 'compressor', code, `master:effect:${instance.id}`)))
          instanceCompressorChains.set(instance.id, state)
          bindCompressorMeter(instance.id, state)
        }
        const result = await state.set(ctx, normalizeCompressorParams(instance.params))
        if (fxInstanceRevision !== revision) return
        if (state.isIdle()) instanceCompressorChains.delete(instance.id)
        requiresRoutingRebuild = (result.changed && result.requiresRoutingRebuild) || requiresRoutingRebuild
        continue
      }
      if (instance.kind === 'saturator') {
        let state = instanceSaturatorChains.get(instance.id)
        if (!state) {
          state = createSaturatorChainState()
          instanceSaturatorChains.set(instance.id, state)
        }
        const result = state.set(ctx, instance.params)
        requiresRoutingRebuild = (result.changed && result.requiresRoutingRebuild) || requiresRoutingRebuild
        continue
      }
      if (instance.kind === 'delay') {
        let state = instanceDelayChains.get(instance.id)
        if (!state) {
          state = createDelayChainState()
          instanceDelayChains.set(instance.id, state)
        }
        const result = state.set(ctx, instance.params, currentBpm)
        requiresRoutingRebuild = (result.changed && result.requiresRoutingRebuild) || requiresRoutingRebuild
        continue
      }
      if (instance.kind !== 'reverb') throw new Error('Unsupported audio effect kind.')
      let state = instanceReverbChains.get(instance.id)
      if (!state) {
        state = createReverbChainState()
        instanceReverbChains.set(instance.id, state)
      }
      const result = state.set(ctx, instance.params, createImpulseResponse)
      requiresRoutingRebuild = (result.changed && result.requiresRoutingRebuild) || requiresRoutingRebuild
      }
    } catch (error) {
      options.workletBudget.rollback(reservation)
      throw error
    }
    if (requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination)
  }

  return {
    applyPending: (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode, createImpulseResponse: CreateReverbImpulseResponse) => {
      if (pendingFxInstances) {
        const instances = pendingFxInstances
        pendingFxInstances = null
        void applyFxInstances(ctx, masterGain, destination, createImpulseResponse, instances).catch((error) => {
          masterFxInstances = []
          options.workletBudget.releaseOwner('master')
          options.onWorkletFault?.(
            options.getFaultGeneration(),
            'owned-processor',
            'effect-chain-construction-failed',
            `master:${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }
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
    setFxInstances: async (
      ctx: AudioContext | null,
      masterGain: GainNode | null,
      destination: AudioDestinationNode | null,
      instances: AudioEffectRuntimeInstance[],
      createImpulseResponse: CreateReverbImpulseResponse,
    ) => {
      const normalized = normalizeAudioEffectRuntimeInstances(instances)
      if (normalized.length === 0) {
        fxInstanceRevision += 1
        masterFxInstances = []
        pendingFxInstances = null
        closeAllInstanceStates()
        options.workletBudget.releaseOwner('master')
        if (ctx && masterGain) rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
        return
      }
      if (!ctx || !masterGain) {
        options.workletBudget.reserve('master', countStaticWorklets(normalized))
        masterFxInstances = normalized
        pendingFxInstances = normalized
        return
      }
      try {
        await applyFxInstances(ctx, masterGain, destination ?? ctx.destination, createImpulseResponse, normalized)
      } catch (error) {
        options.onWorkletFault?.(
          options.getFaultGeneration(),
          'owned-processor',
          'effect-chain-construction-failed',
          `master:${error instanceof Error ? error.message : String(error)}`,
        )
        throw error
      }
    },
    setBpm: (bpm: number) => {
      currentBpm = bpm
      for (const state of instanceDelayChains.values()) state.setBpm(bpm)
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
      spectrumLast = { data: out, sampleRate: ctx?.sampleRate ?? 44100 }
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
      pendingFxInstances = null
      fxInstanceRevision += 1
      closeAllInstanceStates()
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
