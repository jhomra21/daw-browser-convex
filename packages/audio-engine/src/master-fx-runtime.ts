import { areAudioEffectOrdersEqual, normalizeAudioEffectOrder, normalizeCompressorParams, normalizeEqParams, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, serializeNormalizedEqParams, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { connectFxChain, disconnectAudioNodes, type CreateReverbImpulseResponse, type FxChainStageConfig } from './effects/chain'
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

export function createMasterFxRuntime() {
  let eqChain: BiquadFilterNode[] = []
  let eqNodesByBand = new Map<string, BiquadFilterNode>()
  let eqSignature: string | null = null
  let eqTopologySignature: string | null = null
  let analyser: AnalyserNode | null = null
  let spectrumTmp: Uint8Array<ArrayBuffer> | null = null
  let spectrumLast: SpectrumFrame | null = null
  let analyserConnected = false
  const compressorState = createCompressorChainState()
  const reverbState = createReverbChainState()
  const saturatorState = createSaturatorChainState()
  const delayState = createDelayChainState()
  let pendingEqParams: EqParamsLite | null = null
  let pendingCompressorParams: CompressorParamsLite | null = null
  let pendingReverbParams: ReverbParamsLite | null = null
  let pendingSaturatorParams: SaturatorParamsLite | null = null
  let pendingDelayParams: DelayParamsLite | null = null
  let masterFxOrder: AudioEffectKind[] | undefined
  let masterFxInstances: AudioEffectRuntimeInstance[] | null = null
  let pendingFxInstances: AudioEffectRuntimeInstance[] | null = null
  let fxInstanceRevision = 0
  const instanceEqChains = new Map<string, BiquadFilterNode[]>()
  const instanceEqNodesByBand = new Map<string, Map<string, BiquadFilterNode>>()
  const instanceEqSignatures = new Map<string, string>()
  const instanceEqTopologySignatures = new Map<string, string>()
  const instanceCompressorChains = new Map<string, ReturnType<typeof createCompressorChainState>>()
  const instanceReverbChains = new Map<string, ReturnType<typeof createReverbChainState>>()
  const instanceSaturatorChains = new Map<string, ReturnType<typeof createSaturatorChainState>>()
  const instanceDelayChains = new Map<string, ReturnType<typeof createDelayChainState>>()
  let currentBpm = 120

  const closeInstanceState = (instanceId: string) => {
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
  }

  const closeAllInstanceStates = () => {
    const ids = new Set<string>()
    for (const id of instanceEqChains.keys()) ids.add(id)
    for (const id of instanceCompressorChains.keys()) ids.add(id)
    for (const id of instanceReverbChains.keys()) ids.add(id)
    for (const id of instanceSaturatorChains.keys()) ids.add(id)
    for (const id of instanceDelayChains.keys()) ids.add(id)
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
  }))

  const rebuildRouting = (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode) => {
    disconnectAudioNodes([masterGain])
    if (analyserConnected) analyserConnected = false
    if (masterFxInstances) {
      connectFxChain(masterGain, destination, {
        instances: createInstanceStageConfigs(masterFxInstances),
      })
      if (analyser) {
        try {
          masterGain.connect(analyser)
          analyserConnected = true
        } catch {}
      }
      return
    }
    connectFxChain(masterGain, destination, {
      eqNodes: eqChain,
      compressorChain: compressorState.chain(),
      saturatorChain: saturatorState.chain(),
      delayChain: delayState.chain(),
      reverbChain: reverbState.chain(),
      order: masterFxOrder,
    })
    if (analyser) {
      try {
        masterGain.connect(analyser)
        analyserConnected = true
      } catch {}
    }
  }

  const ensureAnalyser = (ctx: AudioContext | null, masterGain: GainNode | null) => {
    if (!ctx || !masterGain) return
    if (!analyser) {
      const next = ctx.createAnalyser()
      next.fftSize = 2048
      next.smoothingTimeConstant = 0.8
      analyser = next
    }
    if (analyser && !analyserConnected) {
      try {
        masterGain.connect(analyser)
        analyserConnected = true
      } catch {}
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

  const applyFxInstances = async (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    createImpulseResponse: CreateReverbImpulseResponse,
    instances: AudioEffectRuntimeInstance[],
  ) => {
    const revision = ++fxInstanceRevision
    const wasInstanceMode = masterFxInstances !== null
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    const previous = masterFxInstances
    const orderChanged = Boolean(previous && (
      previous.length !== normalized.length ||
      previous.some((instance, index) => instance.id !== normalized[index]?.id || instance.kind !== normalized[index]?.kind)
    ))
    if (normalized.length === 0) {
      masterFxInstances = null
      pendingFxInstances = null
      closeAllInstanceStates()
      if (wasInstanceMode) rebuildRouting(ctx, masterGain, destination)
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
    for (const id of staleIds) closeInstanceState(id)

    let requiresRoutingRebuild = !wasInstanceMode || staleIds.size > 0 || orderChanged
    for (const instance of normalized) {
      if (instance.kind === 'eq') {
        requiresRoutingRebuild = applyInstanceEq(ctx, instance.id, instance.params) || requiresRoutingRebuild
        continue
      }
      if (instance.kind === 'compressor') {
        let state = instanceCompressorChains.get(instance.id)
        if (!state) {
          state = createCompressorChainState()
          instanceCompressorChains.set(instance.id, state)
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
      let state = instanceReverbChains.get(instance.id)
      if (!state) {
        state = createReverbChainState()
        instanceReverbChains.set(instance.id, state)
      }
      const result = state.set(ctx, instance.params, createImpulseResponse)
      requiresRoutingRebuild = (result.changed && result.requiresRoutingRebuild) || requiresRoutingRebuild
    }
    if (requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination)
  }

  return {
    applyPending: (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode, createImpulseResponse: CreateReverbImpulseResponse) => {
      if (pendingEqParams) {
        const params = pendingEqParams
        pendingEqParams = null
        const signature = serializeNormalizedEqParams(params)
        const topologySignature = getEqTopologySignature(params)
        eqChain = createEqNodes(ctx, params, ctx.destination.maxChannelCount || 2)
        eqNodesByBand = new Map(params.bands.filter((band) => band.enabled).flatMap((band, index) => {
          const node = eqChain[index]
          return node ? [[band.id, node]] : []
        }))
        eqSignature = signature
        eqTopologySignature = topologySignature
      }
      if (pendingCompressorParams) {
        const params = pendingCompressorParams
        pendingCompressorParams = null
        void compressorState.set(ctx, params).then((result) => { if (result.changed && result.requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination) })
      }
      if (pendingReverbParams) {
        const params = pendingReverbParams
        pendingReverbParams = null
        reverbState.set(ctx, params, createImpulseResponse)
      }
      if (pendingSaturatorParams) {
        const params = pendingSaturatorParams
        pendingSaturatorParams = null
        saturatorState.set(ctx, params)
      }
      if (pendingDelayParams) {
        const params = pendingDelayParams
        pendingDelayParams = null
        delayState.set(ctx, params, currentBpm)
      }
      if (pendingFxInstances) {
        const instances = pendingFxInstances
        pendingFxInstances = null
        void applyFxInstances(ctx, masterGain, destination, createImpulseResponse, instances)
      }
      rebuildRouting(ctx, masterGain, destination)
    },
    setEq: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: EqParamsLite) => {
      const normalized = normalizeEqParams(params)
      if (!ctx || !masterGain) {
        pendingEqParams = normalized
        return
      }
      const signature = serializeNormalizedEqParams(normalized)
      if (eqSignature === signature) return
      const topologySignature = getEqTopologySignature(normalized)
      if (eqTopologySignature === topologySignature) {
        applyEqNodeParams(eqChain, normalized)
        eqSignature = signature
        return
      }
      disconnectAudioNodes(eqChain)
      eqChain = createEqNodes(ctx, normalized, ctx.destination.maxChannelCount || 2)
      eqNodesByBand = new Map(normalized.bands.filter((band) => band.enabled).flatMap((band, index) => {
        const node = eqChain[index]
        return node ? [[band.id, node]] : []
      }))
      eqSignature = signature
      eqTopologySignature = topologySignature
      rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
    },
    setReverb: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: ReverbParamsLite, createImpulseResponse: CreateReverbImpulseResponse) => {
      if (!ctx || !masterGain) {
        pendingReverbParams = params
        return
      }
      const result = reverbState.set(ctx, params, createImpulseResponse)
      if (!result.changed) return
      if (result.requiresRoutingRebuild) {
        rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
      }
    },
    setCompressor: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: CompressorParamsLite) => {
      if (!ctx || !masterGain) {
        pendingCompressorParams = params
        return
      }
      void compressorState.set(ctx, params).then((result) => {
        if (result.changed && result.requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
      })
    },
    subscribeCompressorMeter: (listener: CompressorMeterListener) => compressorState.subscribeMeter(listener),
    setSaturator: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: SaturatorParamsLite) => {
      if (!ctx || !masterGain) {
        pendingSaturatorParams = params
        return
      }
      const result = saturatorState.set(ctx, params)
      if (result.changed && result.requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
    },
    setDelay: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: DelayParamsLite) => {
      if (!ctx || !masterGain) {
        pendingDelayParams = params
        return
      }
      const result = delayState.set(ctx, params, currentBpm)
      if (result.changed && result.requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
    },
    setOrder: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, order: AudioEffectKind[]) => {
      const normalized = normalizeAudioEffectOrder(order, order)
      if (areAudioEffectOrdersEqual(masterFxOrder, normalized)) return
      masterFxOrder = normalized
      if (!ctx || !masterGain) return
      rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
    },
    setFxInstances: (
      ctx: AudioContext | null,
      masterGain: GainNode | null,
      destination: AudioDestinationNode | null,
      instances: AudioEffectRuntimeInstance[],
      createImpulseResponse: CreateReverbImpulseResponse,
    ) => {
      const normalized = normalizeAudioEffectRuntimeInstances(instances)
      if (normalized.length === 0) {
        const wasInstanceMode = masterFxInstances !== null || pendingFxInstances !== null
        if (!wasInstanceMode) return
        fxInstanceRevision += 1
        masterFxInstances = null
        pendingFxInstances = null
        closeAllInstanceStates()
        if (ctx && masterGain) rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
        return
      }
      if (!ctx || !masterGain) {
        masterFxInstances = normalized
        pendingFxInstances = normalized
        return
      }
      void applyFxInstances(ctx, masterGain, destination ?? ctx.destination, createImpulseResponse, normalized)
    },
    setBpm: (bpm: number) => {
      currentBpm = bpm
      delayState.setBpm(bpm)
      for (const state of instanceDelayChains.values()) state.setBpm(bpm)
    },
    resolveMasterAutomationBindings: (parameterId: string, masterGain: GainNode | null, effectInstanceId?: string): AutomationAudioBinding[] => {
      if (parameterId === 'volume') return masterGain ? [{ param: masterGain.gain, valueToAudioValue: (value) => value }] : []
      if (masterFxInstances) {
        if (effectInstanceId) {
          return [
            ...resolveEqAutomationBindings(instanceEqNodesByBand.get(effectInstanceId) ?? new Map(), parameterId),
            ...resolveSaturatorAutomationBindings(instanceSaturatorChains.get(effectInstanceId), parameterId),
            ...resolveDelayAutomationBindings(instanceDelayChains.get(effectInstanceId), parameterId),
            ...resolveReverbAutomationBindings(instanceReverbChains.get(effectInstanceId), parameterId),
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
      }
      return [
        ...resolveEqAutomationBindings(eqNodesByBand, parameterId),
        ...resolveSaturatorAutomationBindings(saturatorState, parameterId),
        ...resolveDelayAutomationBindings(delayState, parameterId),
        ...resolveReverbAutomationBindings(reverbState, parameterId),
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
      eqSignature = null
      eqTopologySignature = null
      pendingEqParams = null
      pendingCompressorParams = null
      pendingReverbParams = null
      pendingSaturatorParams = null
      pendingDelayParams = null
      masterFxOrder = undefined
      masterFxInstances = null
      pendingFxInstances = null
      fxInstanceRevision += 1
      closeAllInstanceStates()
      disconnectAudioNodes(eqChain)
      eqChain = []
      eqNodesByBand = new Map()
      compressorState.close()
      reverbState.close()
      saturatorState.close()
      delayState.close()
      disconnectAudioNodes([analyser])
      analyser = null
      spectrumTmp = null
      spectrumLast = null
      analyserConnected = false
    },
  }
}
