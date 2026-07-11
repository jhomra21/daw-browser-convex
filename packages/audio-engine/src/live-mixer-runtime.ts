import { areAudioEffectOrdersEqual, assert, normalizeAudioEffectOrder, normalizeCompressorParams, normalizeEqParams, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, serializeNormalizedEqParams, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { connectFxChain, disconnectAudioNodes, type CreateReverbImpulseResponse, type FxChainStageConfig } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { createCompressorChainState, type CompressorChainState } from './effects/compressor-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import { createDelayChainState, type DelayChainState } from './effects/delay-chain-state'
import { createReverbChainState, type ReverbChainState } from './effects/reverb-chain-state'
import { createSaturatorChainState, type SaturatorChainState } from './effects/saturator-chain-state'
import { applyLiveMixerGraph, clearLiveMixerEdges, removeLiveMixerEdgesForNodes, type LiveMixerEdgeRuntime } from './mixer/apply-live-routing'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import type { MixerTrackFx, ResolveMixerGraphOptions, ResolvedMixerGraph } from './mixer/types'
import type { ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import type { AutomationAudioBinding } from './automation'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from './automation-bindings'
import { normalizeAudioEffectRuntimeInstances, type AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { createCueBus } from './mixer/cue-routing'
import { applyStaticWorkletNodeParams, createStaticWorkletNodeChain, disconnectStaticWorkletNodeChain, resolveStaticWorkletAutomationBinding, subscribeStaticGateMeter, type GateMeterListener, type StaticWorkletKind, type StaticWorkletNodeChain } from './effects/static-worklet-chain'

const MAX_EFFECTS_PER_CHAIN = 16
const MAX_LIVE_STATIC_WORKLETS = 64
const isStaticWorkletKind = (kind: AudioEffectKind): kind is StaticWorkletKind =>
  kind === 'utility' || kind === 'autofilter' || kind === 'gate' || kind === 'limiter' || kind === 'lofi' ||
  kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo' || kind === 'autopan' || kind === 'ensemble'
const isStaticWorkletInstance = (
  instance: AudioEffectRuntimeInstance,
): instance is Extract<AudioEffectRuntimeInstance, { kind: StaticWorkletKind }> => isStaticWorkletKind(instance.kind)

type RuntimeTrack = Track<AudioBuffer>

type MasterMixerFx = Pick<
  ResolveMixerGraphOptions,
  'masterEq' | 'masterCompressor' | 'masterSaturator' | 'masterDelay' | 'masterReverb' | 'masterFxOrder' | 'masterFxInstances'
>

export function resolveLiveMixerGraph(
  tracks: RuntimeTrack[],
  trackFx: Record<string, MixerTrackFx>,
  masterFx: MasterMixerFx = {},
): ResolvedMixerGraph {
  return resolveMixerGraph({
    channels: createMixerChannels(tracks),
    sourceChannelCounts: Object.fromEntries(tracks.map((track) => [
      track.id,
      track.clips.flatMap((clip) => clip.buffer ? [clip.buffer.numberOfChannels] : []),
    ])),
    trackFx,
    ...masterFx,
  })
}

type TrackNodeGroup = {
  input: GainNode
  postFx: GainNode
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
  getMasterFx: () => MasterMixerFx
}

export function createLiveMixerRuntime(options: LiveMixerRuntimeOptions) {
  const inputs = new Map<string, GainNode>()
  const postFxOutputs = new Map<string, GainNode>()
  const gains = new Map<string, GainNode>()
  const outputs = new Map<string, GainNode>()
  const edgeRuntimes = new Map<string, LiveMixerEdgeRuntime>()
  const sidechainEdges = new Map<string, LiveMixerEdgeRuntime>()
  const cueEdges = new Map<string, LiveMixerEdgeRuntime>()
  let sidechainRoutes: ExternalSidechainRoute[] = []
  let cueTrackIds = new Set<string>()
  let cueDestination: AudioNode | null = null
  let cueBus: GainNode | null = null
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
  const trackFxInstanceRevisions = new Map<string, number>()
  const trackFx = new Map<string, MixerTrackFx>()
  const instanceEqChains = new Map<string, Map<string, BiquadFilterNode[]>>()
  const instanceEqNodesByBand = new Map<string, Map<string, Map<string, BiquadFilterNode>>>()
  const instanceEqSignatures = new Map<string, Map<string, string>>()
  const instanceEqTopologySignatures = new Map<string, Map<string, string>>()
  const instanceCompressorChains = new Map<string, Map<string, CompressorChainState>>()
  const instanceReverbChains = new Map<string, Map<string, ReverbChainState>>()
  const instanceSaturatorChains = new Map<string, Map<string, SaturatorChainState>>()
  const instanceDelayChains = new Map<string, Map<string, DelayChainState>>()
  const instanceStaticWorkletChains = new Map<string, Map<string, StaticWorkletNodeChain>>()
  const gateMeterListeners = new Map<string, Map<string, Set<GateMeterListener>>>()
  const gateMeterSubscriptions = new Map<string, Map<string, () => void>>()
  let currentBpm = 120

  const disconnectRuntimeEdge = (edge: LiveMixerEdgeRuntime) => {
    try { edge.source.disconnect(edge.gain ?? edge.delay) } catch {}
    try { edge.gain?.disconnect(edge.delay) } catch {}
    try { edge.delay.disconnect(edge.target) } catch {}
    try { edge.gain?.disconnect() } catch {}
    try { edge.delay.disconnect() } catch {}
  }

  const applyAuxiliaryRoutes = () => {
    const ctx = options.getAudioContext()
    if (!ctx) return
    const activeSidechains = new Set<string>()
    for (const route of sidechainRoutes) {
      const source = outputs.get(route.sourceTrackId)
      const compressor = instanceCompressorChains.get(route.targetTrackId)?.get(route.effectInstanceId)?.chain()
      const gate = instanceStaticWorkletChains.get(route.targetTrackId)?.get(route.effectInstanceId)
      const targetNode = compressor?.workletNode ?? (gate?.kind === 'gate' ? gate.node : undefined)
      if (!source || !targetNode) continue
      const edgeId = `sidechain:${route.effectInstanceId}`
      activeSidechains.add(edgeId)
      const existing = sidechainEdges.get(edgeId)
      if (existing?.source === source && existing.target === targetNode) continue
      if (existing) disconnectRuntimeEdge(existing)
      const delay = ctx.createDelay()
      source.connect(delay)
      delay.connect(targetNode, 0, 1)
      sidechainEdges.set(edgeId, { source, target: targetNode, delay })
    }
    for (const [edgeId, edge] of sidechainEdges) {
      if (activeSidechains.has(edgeId)) continue
      disconnectRuntimeEdge(edge)
      sidechainEdges.delete(edgeId)
    }

    if (cueTrackIds.size > 0 && cueDestination && !cueBus) {
      cueBus = createCueBus(ctx, cueDestination)
    }
    const activeCues = new Set<string>()
    if (cueBus) {
      for (const trackId of cueTrackIds) {
        const source = outputs.get(trackId)
        if (!source) continue
        const edgeId = `cue:${trackId}`
        activeCues.add(edgeId)
        if (cueEdges.has(edgeId)) continue
        const delay = ctx.createDelay()
        source.connect(delay)
        delay.connect(cueBus)
        cueEdges.set(edgeId, { source, target: cueBus, delay })
      }
    }
    for (const [edgeId, edge] of cueEdges) {
      if (activeCues.has(edgeId)) continue
      disconnectRuntimeEdge(edge)
      cueEdges.delete(edgeId)
    }
    if ((!cueDestination || cueTrackIds.size === 0) && cueBus) {
      cueBus.disconnect()
      cueBus = null
    }
  }

  const ensureNestedMap = <Value,>(map: Map<string, Map<string, Value>>, trackId: string): Map<string, Value> => {
    const existing = map.get(trackId)
    if (existing) return existing
    const next = new Map<string, Value>()
    map.set(trackId, next)
    return next
  }

  const bindGateMeter = (trackId: string, instanceId: string, chain: StaticWorkletNodeChain) => {
    gateMeterSubscriptions.get(trackId)?.get(instanceId)?.()
    gateMeterSubscriptions.get(trackId)?.delete(instanceId)
    const listeners = gateMeterListeners.get(trackId)?.get(instanceId)
    if (chain.kind !== 'gate' && chain.kind !== 'limiter' || !listeners || listeners.size === 0) return
    const unsubscribe = subscribeStaticGateMeter(chain, (frame) => {
      for (const listener of listeners) listener(frame)
    })
    ensureNestedMap(gateMeterSubscriptions, trackId).set(instanceId, unsubscribe)
  }

  const closeInstanceState = (trackId: string, instanceId: string) => {
    gateMeterSubscriptions.get(trackId)?.get(instanceId)?.()
    gateMeterSubscriptions.get(trackId)?.delete(instanceId)
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
    const staticWorklet = instanceStaticWorkletChains.get(trackId)?.get(instanceId)
    if (staticWorklet) disconnectStaticWorkletNodeChain(staticWorklet)
    instanceStaticWorkletChains.get(trackId)?.delete(instanceId)
  }

  const closeTrackInstanceStates = (trackId: string) => {
    const ids = new Set<string>()
    for (const map of [
      instanceEqChains,
      instanceCompressorChains,
      instanceReverbChains,
      instanceSaturatorChains,
      instanceDelayChains,
      instanceStaticWorkletChains,
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
    instanceStaticWorkletChains.delete(trackId)
  }

  const createInstanceStageConfigs = (trackId: string, instances: AudioEffectRuntimeInstance[]): FxChainStageConfig[] => instances.map((instance) => ({
    id: instance.id,
    kind: instance.kind,
    eqNodes: instance.kind === 'eq' ? instanceEqChains.get(trackId)?.get(instance.id) : undefined,
    compressorChain: instance.kind === 'compressor' ? instanceCompressorChains.get(trackId)?.get(instance.id)?.chain() : undefined,
    saturatorChain: instance.kind === 'saturator' ? instanceSaturatorChains.get(trackId)?.get(instance.id)?.chain() : undefined,
    delayChain: instance.kind === 'delay' ? instanceDelayChains.get(trackId)?.get(instance.id)?.chain() : undefined,
    reverbChain: instance.kind === 'reverb' ? instanceReverbChains.get(trackId)?.get(instance.id)?.chain() : undefined,
    staticWorkletChain: isStaticWorkletKind(instance.kind) ? instanceStaticWorkletChains.get(trackId)?.get(instance.id) : undefined,
  }))

  const rebuildTrackRouting = (trackId: string, nodes: Pick<TrackNodeGroup, 'input' | 'postFx'>) => {
    disconnectAudioNodes([nodes.input])
    const instances = trackFxInstances.get(trackId)
    if (instances) {
      connectFxChain(nodes.input, nodes.postFx, {
        instances: createInstanceStageConfigs(trackId, instances),
      })
      return
    }
    connectFxChain(nodes.input, nodes.postFx, {
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

    let postFx = postFxOutputs.get(trackId)
    if (!postFx) {
      postFx = ctx.createGain()
      postFxOutputs.set(trackId, postFx)
    }

    if (createdInput) {
      disconnectAudioNodes([input])
      input.connect(postFx)

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

    return { input, postFx, gain, output }
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
    trackFx.set(trackId, { ...trackFx.get(trackId), eq: normalized })
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingEqParams.set(trackId, normalized)
      return
    }
    applyTrackEq(ctx, trackId, normalized)
  }

  const setTrackReverb = (trackId: string, params: ReverbParamsLite) => {
    trackFx.set(trackId, { ...trackFx.get(trackId), reverb: params })
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
    trackFx.set(trackId, { ...trackFx.get(trackId), compressor: normalized })
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
    trackFx.set(trackId, { ...trackFx.get(trackId), saturator: params })
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
    trackFx.set(trackId, { ...trackFx.get(trackId), delay: params })
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
    const revision = (trackFxInstanceRevisions.get(trackId) ?? 0) + 1
    trackFxInstanceRevisions.set(trackId, revision)
    const wasInstanceMode = trackFxInstances.has(trackId)
    const inputIds = new Set<string>()
    for (const instance of instances) {
      if (inputIds.has(instance.id)) throw new Error(`Duplicate effect instance ID: ${instance.id}`)
      inputIds.add(instance.id)
    }
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    if (normalized.length > MAX_EFFECTS_PER_CHAIN) throw new Error(`Effect chains are limited to ${MAX_EFFECTS_PER_CHAIN} instances.`)
    const otherWorklets = [...trackFxInstances.entries()].reduce((count, [id, values]) => (
      id === trackId ? count : count + values.filter((instance) => isStaticWorkletKind(instance.kind)).length
    ), 0)
    const requestedWorklets = normalized.filter((instance) => isStaticWorkletKind(instance.kind)).length
    if (otherWorklets + requestedWorklets > MAX_LIVE_STATIC_WORKLETS) throw new Error(`Live processing is limited to ${MAX_LIVE_STATIC_WORKLETS} static worklets.`)
    const previous = trackFxInstances.get(trackId)
    const orderChanged = Boolean(previous && (
      previous.length !== normalized.length ||
      previous.some((instance, index) => instance.id !== normalized[index]?.id || instance.kind !== normalized[index]?.kind)
    ))
    if (normalized.length === 0) {
      const currentFx = trackFx.get(trackId)
      trackFx.set(trackId, { ...currentFx, instances: undefined })
      trackFxInstances.delete(trackId)
      pendingTrackFxInstances.delete(trackId)
      closeTrackInstanceStates(trackId)
      const nodes = inputs.has(trackId) && gains.has(trackId) ? ensureTrackNodes(trackId) : null
      if (wasInstanceMode && nodes) rebuildTrackRouting(trackId, nodes)
      return
    }
    const ctx = options.getAudioContext()
    trackFx.set(trackId, { ...trackFx.get(trackId), instances: normalized })
    if (!ctx) {
      trackFxInstances.set(trackId, normalized)
      pendingTrackFxInstances.set(trackId, normalized)
      return
    }
    trackFxInstances.set(trackId, normalized)
    const activeIds = new Set(normalized.map((instance) => instance.id))
    const staleIds = new Set<string>()
    for (const map of [
      instanceEqChains,
      instanceCompressorChains,
      instanceReverbChains,
      instanceSaturatorChains,
      instanceDelayChains,
      instanceStaticWorkletChains,
    ]) {
      for (const id of map.get(trackId)?.keys() ?? []) {
        if (!activeIds.has(id)) staleIds.add(id)
      }
    }
    for (const id of staleIds) closeInstanceState(trackId, id)

    let requiresRoutingRebuild = !wasInstanceMode || staleIds.size > 0 || orderChanged
    for (const instance of normalized) {
      if (isStaticWorkletInstance(instance)) {
        const stateMap = ensureNestedMap(instanceStaticWorkletChains, trackId)
        const existing = stateMap.get(instance.id)
        if (existing?.kind === instance.kind && existing.state === 'active') {
          applyStaticWorkletNodeParams(existing, instance.params)
        } else {
          if (existing) disconnectStaticWorkletNodeChain(existing)
          try {
            const created = await createStaticWorkletNodeChain(ctx, instance.kind, instance.params)
            if (trackFxInstanceRevisions.get(trackId) !== revision) {
              disconnectStaticWorkletNodeChain(created)
              return
            }
            stateMap.set(instance.id, created)
            bindGateMeter(trackId, instance.id, created)
          } catch {
            stateMap.delete(instance.id)
          }
          requiresRoutingRebuild = true
        }
        continue
      }
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
        if (trackFxInstanceRevisions.get(trackId) !== revision) return
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
      if (instance.kind !== 'reverb') continue
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
    applyAuxiliaryRoutes()
  }

  const setTrackFxInstances = (trackId: string, instances: AudioEffectRuntimeInstance[]) => {
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    void applyTrackFxInstances(trackId, normalized)
  }

  const disposeTrack = (trackId: string) => {
    const gain = gains.get(trackId)
    const input = inputs.get(trackId)
    const postFx = postFxOutputs.get(trackId)
    const output = outputs.get(trackId)
    const removedNodes = new Set([gain, input, postFx, output].flatMap((node) => node ? [node] : []))
    removeLiveMixerEdgesForNodes(edgeRuntimes, removedNodes)
    removeLiveMixerEdgesForNodes(sidechainEdges, removedNodes)
    removeLiveMixerEdgesForNodes(cueEdges, removedNodes)
    disconnectAudioNodes([gain])
    gains.delete(trackId)
    disconnectAudioNodes([input])
    inputs.delete(trackId)
    disconnectAudioNodes([postFx])
    postFxOutputs.delete(trackId)

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
    trackFxInstanceRevisions.delete(trackId)
    trackFx.delete(trackId)
    closeTrackInstanceStates(trackId)

    options.disposeSynthTrack(trackId)
    options.disposeTrackMeters(trackId)
  }

  const clear = () => {
    for (const trackId of Array.from(gains.keys())) disposeTrack(trackId)
    for (const trackId of Array.from(inputs.keys())) disposeTrack(trackId)
    clearLiveMixerEdges(edgeRuntimes)
    for (const edge of sidechainEdges.values()) disconnectRuntimeEdge(edge)
    for (const edge of cueEdges.values()) disconnectRuntimeEdge(edge)
    sidechainEdges.clear()
    cueEdges.clear()
    cueBus?.disconnect()
    cueBus = null
    cueDestination = null
    sidechainRoutes = []
    cueTrackIds.clear()
    outputs.clear()
    gains.clear()
    postFxOutputs.clear()
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
    trackFxInstanceRevisions.clear()
    trackFx.clear()
    for (const trackId of Array.from(instanceEqChains.keys())) closeTrackInstanceStates(trackId)
    instanceEqChains.clear()
    instanceEqNodesByBand.clear()
    instanceEqSignatures.clear()
    instanceEqTopologySignatures.clear()
    instanceCompressorChains.clear()
    instanceReverbChains.clear()
    instanceSaturatorChains.clear()
    instanceDelayChains.clear()
    instanceStaticWorkletChains.clear()
    gateMeterSubscriptions.clear()
    gateMeterListeners.clear()
  }

  return {
    ensureTrackInput: (trackId: string) => ensureTrackNodes(trackId).input,
    connectRecordingMonitor: (trackId: string, source: AudioNode) => {
      const input = ensureTrackNodes(trackId).input
      source.connect(input)
      return () => {
        try { source.disconnect(input) } catch {}
      }
    },
    getTrackOutput: (trackId: string) => outputs.get(trackId),
    updateTrackGains: (tracks: RuntimeTrack[]) => {
      const ctx = options.getAudioContext()
      const masterInput = options.getMasterInput()
      if (!ctx || !masterInput) return

      const graph = resolveLiveMixerGraph(tracks, Object.fromEntries(trackFx), options.getMasterFx())
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
        edgeRuntimes,
        createGain: () => ctx.createGain(),
        createDelay: () => ctx.createDelay(),
        currentTime: ctx.currentTime,
        sampleRate: ctx.sampleRate,
        bpm: currentBpm,
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
      applyAuxiliaryRoutes()
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
    setExternalSidechainRoutes: (routes: ExternalSidechainRoute[]) => {
      const seen = new Set<string>()
      for (const route of routes) {
        if (route.sourceTrackId === route.targetTrackId) throw new Error('An effect cannot sidechain from its own track.')
        if (seen.has(route.effectInstanceId)) throw new Error('An effect can have only one external sidechain route.')
        seen.add(route.effectInstanceId)
      }
      sidechainRoutes = routes
      applyAuxiliaryRoutes()
    },
    setCueTrackIds: (trackIds: readonly string[]) => {
      cueTrackIds = new Set(trackIds)
      applyAuxiliaryRoutes()
    },
    setCueDestination: (destination: AudioNode | null) => {
      const ctx = options.getAudioContext()
      if (destination && ctx && destination === ctx.destination) {
        throw new Error('Cue destination must be distinct from the main audio destination.')
      }
      if (cueDestination === destination) return
      for (const edge of cueEdges.values()) disconnectRuntimeEdge(edge)
      cueEdges.clear()
      cueBus?.disconnect()
      cueBus = null
      cueDestination = destination
      applyAuxiliaryRoutes()
    },
    resolveTrackAutomationBindings: (trackId: string, parameterId: string, effectInstanceId?: string): AutomationAudioBinding[] => {
      const trackNodes = ensureTrackNodes(trackId)
      if (parameterId === 'volume') return [{ param: trackNodes.gain.gain, valueToAudioValue: (value) => value }]
      if (trackFxInstances.has(trackId)) {
        if (effectInstanceId) {
          return [
            ...resolveEqAutomationBindings(instanceEqNodesByBand.get(trackId)?.get(effectInstanceId) ?? new Map(), parameterId),
            ...resolveSaturatorAutomationBindings(instanceSaturatorChains.get(trackId)?.get(effectInstanceId), parameterId),
            ...resolveDelayAutomationBindings(instanceDelayChains.get(trackId)?.get(effectInstanceId), parameterId),
            ...resolveReverbAutomationBindings(instanceReverbChains.get(trackId)?.get(effectInstanceId), parameterId),
            ...resolveStaticWorkletAutomationBinding(instanceStaticWorkletChains.get(trackId)?.get(effectInstanceId), parameterId),
          ]
        }
        const eqInstances = instanceEqNodesByBand.get(trackId) ?? new Map()
        const saturatorInstances = instanceSaturatorChains.get(trackId) ?? new Map()
        const delayInstances = instanceDelayChains.get(trackId) ?? new Map()
        const reverbInstances = instanceReverbChains.get(trackId) ?? new Map()
        const eqNodes = new Map<string, BiquadFilterNode>()
        for (const nodesByBand of eqInstances.size === 1 ? eqInstances.values() : []) {
          for (const [bandId, node] of nodesByBand) eqNodes.set(bandId, node)
        }
        return [
          ...resolveEqAutomationBindings(eqNodes, parameterId),
          ...Array.from(saturatorInstances.size === 1 ? saturatorInstances.values() : []).flatMap((state) => resolveSaturatorAutomationBindings(state, parameterId)),
          ...Array.from(delayInstances.size === 1 ? delayInstances.values() : []).flatMap((state) => resolveDelayAutomationBindings(state, parameterId)),
          ...Array.from(reverbInstances.size === 1 ? reverbInstances.values() : []).flatMap((state) => resolveReverbAutomationBindings(state, parameterId)),
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
      trackFx.set(trackId, { ...trackFx.get(trackId), order: normalized })
      const input = inputs.get(trackId)
      const postFx = postFxOutputs.get(trackId)
      if (input && postFx) rebuildTrackRouting(trackId, { input, postFx })
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
    subscribeTrackGateMeter: (trackId: string, instanceId: string, listener: GateMeterListener) => {
      const listeners = ensureNestedMap(gateMeterListeners, trackId)
      let instanceListeners = listeners.get(instanceId)
      if (!instanceListeners) {
        instanceListeners = new Set()
        listeners.set(instanceId, instanceListeners)
      }
      instanceListeners.add(listener)
      const chain = instanceStaticWorkletChains.get(trackId)?.get(instanceId)
      if (chain && !gateMeterSubscriptions.get(trackId)?.has(instanceId)) bindGateMeter(trackId, instanceId, chain)
      return () => {
        listener({ gainReductionDb: 0 })
        instanceListeners.delete(listener)
        if (instanceListeners.size > 0) return
        gateMeterSubscriptions.get(trackId)?.get(instanceId)?.()
        gateMeterSubscriptions.get(trackId)?.delete(instanceId)
        listeners.delete(instanceId)
        if (listeners.size === 0) gateMeterListeners.delete(trackId)
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
