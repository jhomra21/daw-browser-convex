import { areAudioEffectOrdersEqual, assert, normalizeAudioEffectOrder, normalizeCompressorParams, normalizeEqParams, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, serializeNormalizedEqParams, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { connectFxChain, disconnectAudioNodes, type CreateReverbImpulseResponse, type FxChainStageConfig } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { createCompressorChainState, type CompressorChainState } from './effects/compressor-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import { createDelayChainState, type DelayChainState } from './effects/delay-chain-state'
import { createReverbChainState, type ReverbChainState } from './effects/reverb-chain-state'
import { createSaturatorChainState, type SaturatorChainState } from './effects/saturator-chain-state'
import { applyLiveMixerGraph } from './mixer/apply-live-routing'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import type { Track } from '@daw-browser/timeline-core/types'
import type { AutomationAudioBinding } from './automation'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from './automation-bindings'
import { normalizeAudioEffectRuntimeInstances, type AudioEffectRuntimeInstance } from './effects/runtime-instance'

type RuntimeTrack = Track<AudioBuffer>

type TrackNodeGroup = {
  input: GainNode
  gain: GainNode
  output: GainNode
}

type LiveMixerRuntimeOptions = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getMasterInput: () => GainNode | null
  getDestination: () => AudioDestinationNode | null
  createImpulseResponse: CreateReverbImpulseResponse
  reconnectTrackMeters: (trackId: string, output: GainNode, isCurrentOutput: () => boolean) => void
  disposeTrackMeters: (trackId: string) => void
  disposeSynthTrack: (trackId: string) => void
}

export function createLiveMixerRuntime(options: LiveMixerRuntimeOptions) {
  const inputs = new Map<string, GainNode>()
  const gains = new Map<string, GainNode>()
  const outputs = new Map<string, GainNode>()
  const sendGains = new Map<string, Map<string, GainNode>>()
  const routingSignatures = new Map<string, string>()
  const eqChains = new Map<string, BiquadFilterNode[]>()
  const eqNodesByBand = new Map<string, Map<string, BiquadFilterNode>>()
  const pendingEqParams = new Map<string, EqParamsLite>()
  const eqSignatures = new Map<string, string>()
  const eqTopologySignatures = new Map<string, string>()
  const compressorChains = new Map<string, CompressorChainState>()
  const pendingCompressorParams = new Map<string, CompressorParamsLite>()
  const reverbChains = new Map<string, ReverbChainState>()
  const pendingReverbParams = new Map<string, ReverbParamsLite>()
  const saturatorChains = new Map<string, SaturatorChainState>()
  const pendingSaturatorParams = new Map<string, SaturatorParamsLite>()
  const delayChains = new Map<string, DelayChainState>()
  const pendingDelayParams = new Map<string, DelayParamsLite>()
  const trackFxOrders = new Map<string, AudioEffectKind[]>()
  const trackFxInstances = new Map<string, AudioEffectRuntimeInstance[]>()
  const pendingTrackFxInstances = new Map<string, AudioEffectRuntimeInstance[]>()
  const instanceEqChains = new Map<string, Map<string, BiquadFilterNode[]>>()
  const instanceEqNodesByBand = new Map<string, Map<string, Map<string, BiquadFilterNode>>>()
  const instanceEqSignatures = new Map<string, Map<string, string>>()
  const instanceEqTopologySignatures = new Map<string, Map<string, string>>()
  const instanceCompressorChains = new Map<string, Map<string, CompressorChainState>>()
  const instanceReverbChains = new Map<string, Map<string, ReverbChainState>>()
  const instanceSaturatorChains = new Map<string, Map<string, SaturatorChainState>>()
  const instanceDelayChains = new Map<string, Map<string, DelayChainState>>()
  let currentBpm = 120

  const cleanupTrackSendGains = (trackId: string) => {
    const sendMap = sendGains.get(trackId)
    if (!sendMap) return
    disconnectAudioNodes(Array.from(sendMap.values()))
    sendGains.delete(trackId)
  }

  const ensureNestedMap = <Value,>(map: Map<string, Map<string, Value>>, trackId: string): Map<string, Value> => {
    const existing = map.get(trackId)
    if (existing) return existing
    const next = new Map<string, Value>()
    map.set(trackId, next)
    return next
  }

  const closeInstanceState = (trackId: string, instanceId: string) => {
    const eq = instanceEqChains.get(trackId)?.get(instanceId)
    if (eq) disconnectAudioNodes(eq)
    instanceEqChains.get(trackId)?.delete(instanceId)
    instanceEqNodesByBand.get(trackId)?.delete(instanceId)
    instanceEqSignatures.get(trackId)?.delete(instanceId)
    instanceEqTopologySignatures.get(trackId)?.delete(instanceId)
    instanceCompressorChains.get(trackId)?.get(instanceId)?.close()
    instanceCompressorChains.get(trackId)?.delete(instanceId)
    instanceReverbChains.get(trackId)?.get(instanceId)?.close()
    instanceReverbChains.get(trackId)?.delete(instanceId)
    instanceSaturatorChains.get(trackId)?.get(instanceId)?.close()
    instanceSaturatorChains.get(trackId)?.delete(instanceId)
    instanceDelayChains.get(trackId)?.get(instanceId)?.close()
    instanceDelayChains.get(trackId)?.delete(instanceId)
  }

  const closeTrackInstanceStates = (trackId: string) => {
    const ids = new Set<string>()
    for (const map of [
      instanceEqChains,
      instanceCompressorChains,
      instanceReverbChains,
      instanceSaturatorChains,
      instanceDelayChains,
    ]) {
      for (const id of map.get(trackId)?.keys() ?? []) ids.add(id)
    }
    for (const id of ids) closeInstanceState(trackId, id)
    instanceEqChains.delete(trackId)
    instanceEqNodesByBand.delete(trackId)
    instanceEqSignatures.delete(trackId)
    instanceEqTopologySignatures.delete(trackId)
    instanceCompressorChains.delete(trackId)
    instanceReverbChains.delete(trackId)
    instanceSaturatorChains.delete(trackId)
    instanceDelayChains.delete(trackId)
  }

  const createInstanceStageConfigs = (trackId: string, instances: AudioEffectRuntimeInstance[]): FxChainStageConfig[] => instances.map((instance) => ({
    id: instance.id,
    kind: instance.kind,
    eqNodes: instance.kind === 'eq' ? instanceEqChains.get(trackId)?.get(instance.id) : undefined,
    compressorChain: instance.kind === 'compressor' ? instanceCompressorChains.get(trackId)?.get(instance.id)?.chain() : undefined,
    saturatorChain: instance.kind === 'saturator' ? instanceSaturatorChains.get(trackId)?.get(instance.id)?.chain() : undefined,
    delayChain: instance.kind === 'delay' ? instanceDelayChains.get(trackId)?.get(instance.id)?.chain() : undefined,
    reverbChain: instance.kind === 'reverb' ? instanceReverbChains.get(trackId)?.get(instance.id)?.chain() : undefined,
  }))

  const rebuildTrackRouting = (trackId: string, nodes: Pick<TrackNodeGroup, 'input' | 'gain'>) => {
    disconnectAudioNodes([nodes.input])
    const instances = trackFxInstances.get(trackId)
    if (instances) {
      connectFxChain(nodes.input, nodes.gain, {
        instances: createInstanceStageConfigs(trackId, instances),
      })
      return
    }
    connectFxChain(nodes.input, nodes.gain, {
      eqNodes: eqChains.get(trackId) || [],
      compressorChain: compressorChains.get(trackId)?.chain(),
      saturatorChain: saturatorChains.get(trackId)?.chain(),
      delayChain: delayChains.get(trackId)?.chain(),
      reverbChain: reverbChains.get(trackId)?.chain(),
      order: trackFxOrders.get(trackId),
    })
  }

  const ensureTrackNodes = (trackId: string): TrackNodeGroup => {
    options.ensureAudio()
    const ctx = options.getAudioContext()
    assert(ctx, 'Audio runtime was not initialized')

    let input = inputs.get(trackId)
    const createdInput = !input
    if (!input) {
      input = ctx.createGain()
      inputs.set(trackId, input)
    }

    let gain = gains.get(trackId)
    if (!gain) {
      gain = ctx.createGain()
      gain.gain.value = 1
      gains.set(trackId, gain)
    }

    let output = outputs.get(trackId)
    if (!output) {
      output = ctx.createGain()
      output.gain.value = 1
      outputs.set(trackId, output)
    }

    if (createdInput) {
      disconnectAudioNodes([input])
      input.connect(gain)

      const pendingEq = pendingEqParams.get(trackId)
      if (pendingEq) {
        pendingEqParams.delete(trackId)
        applyTrackEq(ctx, trackId, pendingEq)
      }

      const pendingCompressor = pendingCompressorParams.get(trackId)
      if (pendingCompressor) {
        pendingCompressorParams.delete(trackId)
        void setTrackCompressor(trackId, pendingCompressor)
      }

      const pendingReverb = pendingReverbParams.get(trackId)
      if (pendingReverb) {
        pendingReverbParams.delete(trackId)
        setTrackReverb(trackId, pendingReverb)
      }
      const pendingSaturator = pendingSaturatorParams.get(trackId)
      if (pendingSaturator) {
        pendingSaturatorParams.delete(trackId)
        setTrackSaturator(trackId, pendingSaturator)
      }
      const pendingDelay = pendingDelayParams.get(trackId)
      if (pendingDelay) {
        pendingDelayParams.delete(trackId)
        setTrackDelay(trackId, pendingDelay)
      }
      const pendingInstances = pendingTrackFxInstances.get(trackId)
      if (pendingInstances) {
        pendingTrackFxInstances.delete(trackId)
        setTrackFxInstances(trackId, pendingInstances)
      }
    }

    return { input, gain, output }
  }

  const applyTrackEq = (ctx: AudioContext, trackId: string, normalized: EqParamsLite) => {
    const signature = serializeNormalizedEqParams(normalized)
    if (eqSignatures.get(trackId) === signature) return
    const trackNodes = ensureTrackNodes(trackId)
    const topologySignature = getEqTopologySignature(normalized)
    const old = eqChains.get(trackId)
    if (old && eqTopologySignatures.get(trackId) === topologySignature) {
      applyEqNodeParams(old, normalized)
      eqSignatures.set(trackId, signature)
      return
    }
    if (old) disconnectAudioNodes(old)
    const destination = options.getDestination()
    const targetChannels = destination?.maxChannelCount ?? ctx.destination.maxChannelCount ?? 2
    const eqNodes = createEqNodes(ctx, normalized, targetChannels)
    eqChains.set(trackId, eqNodes)
    eqNodesByBand.set(trackId, new Map(normalized.bands.filter((band) => band.enabled).flatMap((band, index) => {
      const node = eqNodes[index]
      return node ? [[band.id, node]] : []
    })))
    eqSignatures.set(trackId, signature)
    eqTopologySignatures.set(trackId, topologySignature)
    rebuildTrackRouting(trackId, trackNodes)
  }

  const setTrackEq = (trackId: string, params: EqParamsLite) => {
    const normalized = normalizeEqParams(params)
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingEqParams.set(trackId, normalized)
      return
    }
    applyTrackEq(ctx, trackId, normalized)
  }

  const setTrackReverb = (trackId: string, params: ReverbParamsLite) => {
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingReverbParams.set(trackId, params)
      return
    }
    let reverbState = reverbChains.get(trackId)
    if (!reverbState) {
      reverbState = createReverbChainState()
      reverbChains.set(trackId, reverbState)
    }
    const result = reverbState.set(ctx, params, options.createImpulseResponse)
    if (!result.changed) return
    if (result.requiresRoutingRebuild) {
      const trackNodes = ensureTrackNodes(trackId)
      rebuildTrackRouting(trackId, trackNodes)
    }
  }

  const setTrackCompressor = async (trackId: string, params: CompressorParamsLite) => {
    const normalized = normalizeCompressorParams(params)
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingCompressorParams.set(trackId, normalized)
      return
    }
    let state = compressorChains.get(trackId)
    if (!state && !normalized.enabled) return
    if (!state) {
      state = createCompressorChainState()
      compressorChains.set(trackId, state)
    }
    const result = await state.set(ctx, normalized)
    if (state.isIdle()) compressorChains.delete(trackId)
    if (result.changed && result.requiresRoutingRebuild) rebuildTrackRouting(trackId, ensureTrackNodes(trackId))
  }

  const setTrackSaturator = (trackId: string, params: SaturatorParamsLite) => {
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingSaturatorParams.set(trackId, params)
      return
    }
    let state = saturatorChains.get(trackId)
    if (!state) {
      state = createSaturatorChainState()
      saturatorChains.set(trackId, state)
    }
    const result = state.set(ctx, params)
    if (result.changed && result.requiresRoutingRebuild) rebuildTrackRouting(trackId, ensureTrackNodes(trackId))
  }

  const setTrackDelay = (trackId: string, params: DelayParamsLite) => {
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingDelayParams.set(trackId, params)
      return
    }
    let state = delayChains.get(trackId)
    if (!state) {
      state = createDelayChainState()
      delayChains.set(trackId, state)
    }
    const result = state.set(ctx, params, currentBpm)
    if (result.changed && result.requiresRoutingRebuild) rebuildTrackRouting(trackId, ensureTrackNodes(trackId))
  }

  const applyTrackInstanceEq = (ctx: AudioContext, trackId: string, instanceId: string, params: EqParamsLite): boolean => {
    const normalized = normalizeEqParams(params)
    const signature = serializeNormalizedEqParams(normalized)
    const signatureMap = ensureNestedMap(instanceEqSignatures, trackId)
    if (signatureMap.get(instanceId) === signature) return false
    const topologySignature = getEqTopologySignature(normalized)
    const topologyMap = ensureNestedMap(instanceEqTopologySignatures, trackId)
    const chainMap = ensureNestedMap(instanceEqChains, trackId)
    const old = chainMap.get(instanceId)
    if (old && topologyMap.get(instanceId) === topologySignature) {
      applyEqNodeParams(old, normalized)
      signatureMap.set(instanceId, signature)
      return false
    }
    if (old) disconnectAudioNodes(old)
    const destination = options.getDestination()
    const targetChannels = destination?.maxChannelCount ?? ctx.destination.maxChannelCount ?? 2
    const eqNodes = createEqNodes(ctx, normalized, targetChannels)
    chainMap.set(instanceId, eqNodes)
    ensureNestedMap(instanceEqNodesByBand, trackId).set(instanceId, new Map(normalized.bands.filter((band) => band.enabled).flatMap((band, index) => {
      const node = eqNodes[index]
      return node ? [[band.id, node]] : []
    })))
    signatureMap.set(instanceId, signature)
    topologyMap.set(instanceId, topologySignature)
    return true
  }

  const applyTrackFxInstances = async (trackId: string, instances: AudioEffectRuntimeInstance[]) => {
    const wasInstanceMode = trackFxInstances.has(trackId)
    const ctx = options.getAudioContext()
    if (!ctx) {
      trackFxInstances.set(trackId, instances)
      pendingTrackFxInstances.set(trackId, instances)
      return
    }
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    trackFxInstances.set(trackId, normalized)
    const activeIds = new Set(normalized.map((instance) => instance.id))
    const staleIds = new Set<string>()
    for (const map of [
      instanceEqChains,
      instanceCompressorChains,
      instanceReverbChains,
      instanceSaturatorChains,
      instanceDelayChains,
    ]) {
      for (const id of map.get(trackId)?.keys() ?? []) {
        if (!activeIds.has(id)) staleIds.add(id)
      }
    }
    for (const id of staleIds) closeInstanceState(trackId, id)

    let requiresRoutingRebuild = !wasInstanceMode || staleIds.size > 0
    for (const instance of normalized) {
      if (instance.kind === 'eq') {
        requiresRoutingRebuild = applyTrackInstanceEq(ctx, trackId, instance.id, instance.params) || requiresRoutingRebuild
        continue
      }
      if (instance.kind === 'compressor') {
        const stateMap = ensureNestedMap(instanceCompressorChains, trackId)
        let state = stateMap.get(instance.id)
        if (!state) {
          state = createCompressorChainState()
          stateMap.set(instance.id, state)
        }
        const result = await state.set(ctx, normalizeCompressorParams(instance.params))
        if (state.isIdle()) stateMap.delete(instance.id)
        requiresRoutingRebuild = (result.changed && result.requiresRoutingRebuild) || requiresRoutingRebuild
        continue
      }
      if (instance.kind === 'saturator') {
        const stateMap = ensureNestedMap(instanceSaturatorChains, trackId)
        let state = stateMap.get(instance.id)
        if (!state) {
          state = createSaturatorChainState()
          stateMap.set(instance.id, state)
        }
        const result = state.set(ctx, instance.params)
        requiresRoutingRebuild = (result.changed && result.requiresRoutingRebuild) || requiresRoutingRebuild
        continue
      }
      if (instance.kind === 'delay') {
        const stateMap = ensureNestedMap(instanceDelayChains, trackId)
        let state = stateMap.get(instance.id)
        if (!state) {
          state = createDelayChainState()
          stateMap.set(instance.id, state)
        }
        const result = state.set(ctx, instance.params, currentBpm)
        requiresRoutingRebuild = (result.changed && result.requiresRoutingRebuild) || requiresRoutingRebuild
        continue
      }
      const stateMap = ensureNestedMap(instanceReverbChains, trackId)
      let state = stateMap.get(instance.id)
      if (!state) {
        state = createReverbChainState()
        stateMap.set(instance.id, state)
      }
      const result = state.set(ctx, instance.params, options.createImpulseResponse)
      requiresRoutingRebuild = (result.changed && result.requiresRoutingRebuild) || requiresRoutingRebuild
    }
    if (requiresRoutingRebuild) rebuildTrackRouting(trackId, ensureTrackNodes(trackId))
  }

  const setTrackFxInstances = (trackId: string, instances: AudioEffectRuntimeInstance[]) => {
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    void applyTrackFxInstances(trackId, normalized)
  }

  const disposeTrack = (trackId: string) => {
    const gain = gains.get(trackId)
    disconnectAudioNodes([gain])
    gains.delete(trackId)
    routingSignatures.delete(trackId)
    cleanupTrackSendGains(trackId)

    const input = inputs.get(trackId)
    disconnectAudioNodes([input])
    inputs.delete(trackId)

    const output = outputs.get(trackId)
    disconnectAudioNodes([output])
    outputs.delete(trackId)

    const nodes = eqChains.get(trackId)
    if (nodes) disconnectAudioNodes(nodes)
    eqChains.delete(trackId)
    eqNodesByBand.delete(trackId)
    eqSignatures.delete(trackId)
    eqTopologySignatures.delete(trackId)

    compressorChains.get(trackId)?.close()
    compressorChains.delete(trackId)
    reverbChains.get(trackId)?.close()
    reverbChains.delete(trackId)
    saturatorChains.get(trackId)?.close()
    saturatorChains.delete(trackId)
    delayChains.get(trackId)?.close()
    delayChains.delete(trackId)
    pendingEqParams.delete(trackId)
    pendingCompressorParams.delete(trackId)
    pendingReverbParams.delete(trackId)
    pendingSaturatorParams.delete(trackId)
    pendingDelayParams.delete(trackId)
    trackFxOrders.delete(trackId)
    trackFxInstances.delete(trackId)
    pendingTrackFxInstances.delete(trackId)
    closeTrackInstanceStates(trackId)

    options.disposeSynthTrack(trackId)
    options.disposeTrackMeters(trackId)
  }

  const clear = () => {
    for (const trackId of Array.from(gains.keys())) disposeTrack(trackId)
    for (const trackId of Array.from(inputs.keys())) disposeTrack(trackId)
    sendGains.clear()
    outputs.clear()
    gains.clear()
    routingSignatures.clear()
    inputs.clear()
    eqChains.clear()
    eqNodesByBand.clear()
    pendingEqParams.clear()
    eqSignatures.clear()
    eqTopologySignatures.clear()
    for (const compressorState of compressorChains.values()) compressorState.close()
    compressorChains.clear()
    pendingCompressorParams.clear()
    for (const reverbState of reverbChains.values()) reverbState.close()
    reverbChains.clear()
    pendingReverbParams.clear()
    for (const state of saturatorChains.values()) state.close()
    saturatorChains.clear()
    pendingSaturatorParams.clear()
    for (const state of delayChains.values()) state.close()
    delayChains.clear()
    pendingDelayParams.clear()
    trackFxOrders.clear()
    trackFxInstances.clear()
    pendingTrackFxInstances.clear()
    for (const trackId of Array.from(instanceEqChains.keys())) closeTrackInstanceStates(trackId)
    instanceEqChains.clear()
    instanceEqNodesByBand.clear()
    instanceEqSignatures.clear()
    instanceEqTopologySignatures.clear()
    instanceCompressorChains.clear()
    instanceReverbChains.clear()
    instanceSaturatorChains.clear()
    instanceDelayChains.clear()
  }

  return {
    ensureTrackInput: (trackId: string) => ensureTrackNodes(trackId).input,
    getTrackOutput: (trackId: string) => outputs.get(trackId),
    updateTrackGains: (tracks: RuntimeTrack[]) => {
      const ctx = options.getAudioContext()
      const masterInput = options.getMasterInput()
      if (!ctx || !masterInput) return

      const graph = resolveMixerGraph({ channels: createMixerChannels(tracks) })
      const trackNodes = new Map<string, TrackNodeGroup>()
      for (const resolvedTrack of graph.channels) {
        const channelId = resolvedTrack.channel.id
        trackNodes.set(channelId, ensureTrackNodes(channelId))
      }

      const activeMeterTrackIds = new Set<string>(
        graph.channels
          .filter((entry) => entry.outputGain > 0 || entry.sends.length > 0)
          .map((entry) => entry.channel.id),
      )
      applyLiveMixerGraph({
        graph,
        masterInput,
        trackNodes,
        trackSendGains: sendGains,
        trackRoutingSignatures: routingSignatures,
        createGain: () => ctx.createGain(),
        reconnectTrackMeters: (trackId, gain) => {
          if (!activeMeterTrackIds.has(trackId)) {
            options.disposeTrackMeters(trackId)
            return
          }
          options.reconnectTrackMeters(trackId, gain, () => outputs.get(trackId) === gain)
        },
      })

      const activeTrackIds = new Set<string>(graph.channels.map((entry) => entry.channel.id))
      for (const id of Array.from(gains.keys())) {
        if (activeTrackIds.has(id)) continue
        disposeTrack(id)
      }
    },
    previewTrackVolume: (trackId: string, volume: number, muted: boolean) => {
      const gain = gains.get(trackId)
      if (!gain) return
      const next = !muted && Number.isFinite(volume) ? Math.max(0, volume) : 0
      try { gain.gain.value = next } catch {}
    },
    setTrackEq,
    setTrackSaturator,
    setTrackDelay,
    setTrackFxInstances,
    resolveTrackAutomationBindings: (trackId: string, parameterId: string): AutomationAudioBinding[] => {
      const trackNodes = ensureTrackNodes(trackId)
      if (parameterId === 'volume') return [{ param: trackNodes.gain.gain, valueToAudioValue: (value) => value }]
      if (trackFxInstances.has(trackId)) {
        const eqNodes = new Map<string, BiquadFilterNode>()
        for (const nodesByBand of instanceEqNodesByBand.get(trackId)?.values() ?? []) {
          for (const [bandId, node] of nodesByBand) eqNodes.set(bandId, node)
        }
        return [
          ...resolveEqAutomationBindings(eqNodes, parameterId),
          ...Array.from(instanceSaturatorChains.get(trackId)?.values() ?? []).flatMap((state) => resolveSaturatorAutomationBindings(state, parameterId)),
          ...Array.from(instanceDelayChains.get(trackId)?.values() ?? []).flatMap((state) => resolveDelayAutomationBindings(state, parameterId)),
          ...Array.from(instanceReverbChains.get(trackId)?.values() ?? []).flatMap((state) => resolveReverbAutomationBindings(state, parameterId)),
        ]
      }
      return [
        ...resolveEqAutomationBindings(eqNodesByBand.get(trackId) ?? new Map(), parameterId),
        ...resolveSaturatorAutomationBindings(saturatorChains.get(trackId), parameterId),
        ...resolveDelayAutomationBindings(delayChains.get(trackId), parameterId),
        ...resolveReverbAutomationBindings(reverbChains.get(trackId), parameterId),
      ]
    },
    setTrackFxOrder: (trackId: string, order: AudioEffectKind[]) => {
      const normalized = normalizeAudioEffectOrder(order, order)
      if (areAudioEffectOrdersEqual(trackFxOrders.get(trackId), normalized)) return
      trackFxOrders.set(trackId, normalized)
      const input = inputs.get(trackId)
      const gain = gains.get(trackId)
      if (input && gain) rebuildTrackRouting(trackId, { input, gain })
    },
    setTrackCompressor: (trackId: string, params: CompressorParamsLite) => { void setTrackCompressor(trackId, params) },
    subscribeTrackCompressorMeter: (trackId: string, listener: CompressorMeterListener) => {
      let state = compressorChains.get(trackId)
      if (!state) {
        state = createCompressorChainState()
        compressorChains.set(trackId, state)
      }
      const unsubscribe = state.subscribeMeter(listener)
      return () => {
        unsubscribe()
        if (state.isIdle()) compressorChains.delete(trackId)
      }
    },
    setTrackReverb,
    setBpm: (bpm: number) => {
      currentBpm = bpm
      for (const state of delayChains.values()) state.setBpm(bpm)
      for (const states of instanceDelayChains.values()) {
        for (const state of states.values()) state.setBpm(bpm)
      }
    },
    disposeTrack,
    clear,
  }
}
