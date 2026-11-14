import { assertDefined, normalizeCompressorParams, normalizeEqParams, serializeNormalizedEqParams, type AutomationEnvelope, type EqParams } from '@daw-browser/shared'
import { connectFxChain, createCompressorNodeChain, createGainTransitionOwner, disconnectAudioNodes, type FxChainStageConfig, type GainTransitionOwner, type GainTransitionScheduler } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { createCompressorChainState, type CompressorChainState } from './effects/compressor-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import { createDelayChainState, type DelayChainState } from './effects/delay-chain-state'
import { createReverbChainState, type ReverbChainState } from './effects/reverb-chain-state'
import { createSaturatorChainState, type SaturatorChainState } from './effects/saturator-chain-state'
import { applyLiveMixerGraph, clearLiveMixerEdges, removeLiveMixerEdgesForNodes, type LiveMixerEdgeRuntime } from './mixer/apply-live-routing'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import { resolveMixerTiming } from './mixer/resolve-timing'
import type { MixerTrackFx, ResolveMixerGraphOptions, ResolvedMixerGraph } from './mixer/types'
import type { ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import type { AutomationAudioBinding } from './automation'
import { forgetAudioParamValue, rampAudioParam } from './audio-param-ramp'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from './automation-bindings'
import { normalizeAudioEffectRuntimeInstances, type AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { createCueBus } from './mixer/cue-routing'
import { applyStaticWorkletNodeParams, createStaticWorkletNodeChain, disconnectStaticWorkletNodeChain, resolveStaticWorkletAutomationBinding, subscribeStaticGateMeter, type GateMeterListener, type StaticWorkletKind, type StaticWorkletNodeChain } from './effects/static-worklet-chain'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'
import { countStaticWorklets, isStaticWorkletKind, type LiveWorkletTransaction } from './effects/live-worklet-budget'
import { getEffectChainTiming } from './effects/timing'
import { createChainAdmission } from './chain-admission'
import type { EngineDisposition } from './engine-disposition'

const isStaticWorkletInstance = (
  instance: AudioEffectRuntimeInstance,
): instance is Extract<AudioEffectRuntimeInstance, { kind: StaticWorkletKind }> => isStaticWorkletKind(instance.kind)

export const sidechainRouteIdentity = (targetTrackId: string, effectInstanceId: string) => (
  JSON.stringify([targetTrackId, effectInstanceId])
)

export const findExternalSidechainTarget = (
  instances: readonly AudioEffectRuntimeInstance[] | undefined,
  effectInstanceId: string,
) => {
  const instance = instances?.find((candidate) => candidate.id === effectInstanceId)
  return instance?.kind === 'compressor' || instance?.kind === 'gate' || instance?.kind === 'spectral'
    ? instance
    : undefined
}

type RuntimeTrack = Track<AudioBuffer | null>

type MasterMixerFx = Pick<ResolveMixerGraphOptions, 'masterFxInstances' | 'masterVolume'>

export function resolveLiveMixerGraph(
  tracks: readonly RuntimeTrack[],
  trackFx: Record<string, MixerTrackFx>,
  masterFx: MasterMixerFx = {},
): ResolvedMixerGraph {
  return resolveMixerGraph({
    channels: createMixerChannels(tracks),
    sourceChannelCounts: Object.fromEntries(tracks.map((track) => [
      track.id,
      track.clips.flatMap((clip) => clip.buffer
        ? [clip.buffer.numberOfChannels]
        : clip.sourceChannelCount !== undefined ? [clip.sourceChannelCount] : []),
    ])),
    trackFx,
    ...masterFx,
  })
}

type TrackNodeGroup = {
  input: GainNode
  postFx: GainNode
  mute: GainNode
  gain: GainNode
  output: GainNode
}

type LiveMixerRuntimeOptions = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getMasterInput: () => GainNode | null
  getDestination: () => AudioDestinationNode | null
  reconnectTrackMeters: (trackId: string, output: GainNode, isCurrentOutput: () => boolean) => void
  disposeTrackMeters: (trackId: string) => void
  disposeSynthTrack: (trackId: string) => void
  getMasterFx: () => MasterMixerFx
  workletBudget: {
    begin: (owner: string, count: number) => LiveWorkletTransaction
    commit: (transaction: LiveWorkletTransaction, count: number) => boolean
    isCurrent: (transaction: LiveWorkletTransaction) => boolean
    rollback: (transaction: LiveWorkletTransaction) => void
    releaseOwner: (owner: string) => void
  }
  getFaultGeneration: () => number
  transitionScheduler?: GainTransitionScheduler
  onGraphLatencyChange?: (frames: number | null) => void
  onWorkletFault?: (generation: number, kind: 'compressor' | 'owned-processor', code: string, context: string) => void
  resourceObserver?: ResourceObserver
}

type TrackInstanceResources = {
  eq: Map<string, BiquadFilterNode[]>
  eqByBand: Map<string, Map<string, BiquadFilterNode>>
  eqSignatures: Map<string, string>
  eqTopologySignatures: Map<string, string>
  compressors: Map<string, CompressorChainState>
  reverbs: Map<string, ReverbChainState>
  saturators: Map<string, SaturatorChainState>
  delays: Map<string, DelayChainState>
  staticWorklets: Map<string, StaticWorkletNodeChain>
}

type StaticWorkletChainHolder = {
  chain: StaticWorkletNodeChain | undefined
}

type TrackCandidate = {
  instances: AudioEffectRuntimeInstance[]
  transaction: LiveWorkletTransaction
  resources: TrackInstanceResources
  ownedIds: Set<string>
  requiresRoutingRebuild: boolean
  desiredStaticCount: number
  eqParamUpdates: Array<{ instance: AudioEffectRuntimeInstance; nodes: BiquadFilterNode[]; params: EqParams }>
  // Instances whose parameters were written to the nodes that already held them.
  writtenInPlace: AudioEffectRuntimeInstance[]
}

// A request that joins work is 'joined' only when that work installed; any other outcome is the joined request's too.
const joinedDisposition = (underlying: EngineDisposition): EngineDisposition => underlying === 'applied' ? 'joined' : underlying

export function createLiveMixerRuntime(options: LiveMixerRuntimeOptions) {
  const inputs = new Map<string, GainNode>()
  const postFxOutputs = new Map<string, GainNode>()
  const muteGains = new Map<string, GainNode>()
  const gains = new Map<string, GainNode>()
  const outputs = new Map<string, GainNode>()
  const trackNodeReleases = new Map<string, Array<() => void>>()
  const routingTransitionOwners = new Map<string, GainTransitionOwner>()
  const edgeRuntimes = new Map<string, LiveMixerEdgeRuntime>()
  const sidechainEdges = new Map<string, LiveMixerEdgeRuntime>()
  const cueEdges = new Map<string, LiveMixerEdgeRuntime>()
  let sidechainRoutes: ExternalSidechainRoute[] = []
  let cueTrackIds = new Set<string>()
  let cueDestination: AudioNode | null = null
  let cueBus: GainNode | null = null
  const trackFxInstances = new Map<string, AudioEffectRuntimeInstance[]>()
  const trackChainInstances = new Map<string, AudioEffectRuntimeInstance[]>()
  const chainAdmissions = new Map<string, ReturnType<typeof createChainAdmission<EngineDisposition>>>()
  const trackFxInstanceRevisions = new Map<string, number>()
  // What the live nodes are known to hold, recorded when a request commits. A request that was superseded after it
  // changed a node leaves the node on its value, so the installed chain alone cannot say whether a request is in place.
  const liveParams = new Map<string, Map<string, AudioEffectRuntimeInstance['params']>>()
  const trackFx = new Map<string, MixerTrackFx>()
  const admissionFor = (trackId: string) => {
    const held = chainAdmissions.get(trackId)
    if (held) return held
    const created = createChainAdmission<EngineDisposition>(joinedDisposition)
    chainAdmissions.set(trackId, created)
    return created
  }
  const instanceEqChains = new Map<string, Map<string, BiquadFilterNode[]>>()
  const instanceEqNodesByBand = new Map<string, Map<string, Map<string, BiquadFilterNode>>>()
  const instanceEqSignatures = new Map<string, Map<string, string>>()
  const instanceEqTopologySignatures = new Map<string, Map<string, string>>()
  const instanceCompressorChains = new Map<string, Map<string, CompressorChainState>>()
  const instanceReverbChains = new Map<string, Map<string, ReverbChainState>>()
  const instanceSaturatorChains = new Map<string, Map<string, SaturatorChainState>>()
  const instanceDelayChains = new Map<string, Map<string, DelayChainState>>()
  const instanceStaticWorkletChains = new Map<string, Map<string, StaticWorkletNodeChain>>()
  const compressorMeterListeners = new Map<string, Map<string, Set<CompressorMeterListener>>>()
  const compressorMeterSubscriptions = new Map<string, Map<string, () => void>>()
  const gateMeterListeners = new Map<string, Map<string, Set<GateMeterListener>>>()
  const gateMeterSubscriptions = new Map<string, Map<string, () => void>>()
  let currentBpm = 120
  let currentTracks: RuntimeTrack[] = []
  const retiredTrackResources = new Map<string, Array<{ resources: TrackInstanceResources; ids: Set<string> }>>()
  const unfinishedGraphPublications = new Set<string>()
  const appliedStaticGains = new Map<string, { gain: number; outputGain: number; muteGain: number }>()
  let automatedVolumeTargets = new Set<string>()
  const dirtyStaticGainTargets = new Set<string>()

  const currentTrackResources = (trackId: string): TrackInstanceResources => ({
    eq: instanceEqChains.get(trackId) ?? new Map(),
    eqByBand: instanceEqNodesByBand.get(trackId) ?? new Map(),
    eqSignatures: instanceEqSignatures.get(trackId) ?? new Map(),
    eqTopologySignatures: instanceEqTopologySignatures.get(trackId) ?? new Map(),
    compressors: instanceCompressorChains.get(trackId) ?? new Map(),
    reverbs: instanceReverbChains.get(trackId) ?? new Map(),
    saturators: instanceSaturatorChains.get(trackId) ?? new Map(),
    delays: instanceDelayChains.get(trackId) ?? new Map(),
    staticWorklets: instanceStaticWorkletChains.get(trackId) ?? new Map(),
  })

  const snapshotTrackResources = (trackId: string): TrackInstanceResources => {
    const resources = currentTrackResources(trackId)
    return {
      eq: new Map(resources.eq),
      eqByBand: new Map(resources.eqByBand),
      eqSignatures: new Map(resources.eqSignatures),
      eqTopologySignatures: new Map(resources.eqTopologySignatures),
      compressors: new Map(resources.compressors),
      reverbs: new Map(resources.reverbs),
      saturators: new Map(resources.saturators),
      delays: new Map(resources.delays),
      staticWorklets: new Map(resources.staticWorklets),
    }
  }

  const closeTrackResources = (resources: TrackInstanceResources, ids?: Iterable<string>) => {
    const resourceIds = ids ? new Set(ids) : new Set([
      ...resources.eq.keys(), ...resources.compressors.keys(), ...resources.reverbs.keys(),
      ...resources.saturators.keys(), ...resources.delays.keys(), ...resources.staticWorklets.keys(),
    ])
    for (const id of resourceIds) {
      const eq = resources.eq.get(id)
      if (eq) disconnectAudioNodes(eq)
      resources.compressors.get(id)?.close()
      resources.reverbs.get(id)?.close()
      resources.saturators.get(id)?.close()
      resources.delays.get(id)?.close()
      const staticWorklet = resources.staticWorklets.get(id)
      if (staticWorklet) disconnectStaticWorkletNodeChain(staticWorklet)
    }
  }

  const replaceNestedMap = <Value,>(target: Map<string, Map<string, Value>>, trackId: string, source: Map<string, Value>) => {
    target.set(trackId, new Map(source))
  }

  const publishTrackResources = (trackId: string, resources: TrackInstanceResources) => {
    replaceNestedMap(instanceEqChains, trackId, resources.eq)
    replaceNestedMap(instanceEqNodesByBand, trackId, resources.eqByBand)
    replaceNestedMap(instanceEqSignatures, trackId, resources.eqSignatures)
    replaceNestedMap(instanceEqTopologySignatures, trackId, resources.eqTopologySignatures)
    replaceNestedMap(instanceCompressorChains, trackId, resources.compressors)
    replaceNestedMap(instanceReverbChains, trackId, resources.reverbs)
    replaceNestedMap(instanceSaturatorChains, trackId, resources.saturators)
    replaceNestedMap(instanceDelayChains, trackId, resources.delays)
    replaceNestedMap(instanceStaticWorkletChains, trackId, resources.staticWorklets)
  }

  const removeTrackCandidateResources = (resources: TrackInstanceResources, id: string) => {
    resources.eq.delete(id)
    resources.eqByBand.delete(id)
    resources.eqSignatures.delete(id)
    resources.eqTopologySignatures.delete(id)
    resources.compressors.delete(id)
    resources.reverbs.delete(id)
    resources.saturators.delete(id)
    resources.delays.delete(id)
    resources.staticWorklets.delete(id)
  }

  const drainRetiredTrackResources = (trackId: string) => {
    for (const { resources, ids } of retiredTrackResources.get(trackId) ?? []) closeTrackResources(resources, ids)
    retiredTrackResources.delete(trackId)
  }

  const publishGraphLatency = () => {
    const ctx = options.getAudioContext()
    if (!ctx) {
      options.onGraphLatencyChange?.(null)
      return
    }
    const graph = resolveLiveMixerGraph(currentTracks, Object.fromEntries(trackFx), options.getMasterFx())
    options.onGraphLatencyChange?.(resolveMixerTiming(graph, ctx.sampleRate, currentBpm).graphLatencyFrames)
  }

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
      const targetInstance = findExternalSidechainTarget(
        trackFxInstances.get(route.targetTrackId),
        route.effectInstanceId,
      )
      if (!source || !targetInstance) continue
      const compressor = instanceCompressorChains.get(route.targetTrackId)?.get(route.effectInstanceId)?.chain()
      const owned = instanceStaticWorkletChains.get(route.targetTrackId)?.get(route.effectInstanceId)
      const targetNode = compressor?.workletNode ?? (owned?.kind === 'gate' || owned?.kind === 'spectral' ? owned.node : undefined)
      if (!targetNode) continue
      const edgeId = `sidechain:${sidechainRouteIdentity(route.targetTrackId, route.effectInstanceId)}`
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

  const bindCompressorMeter = (trackId: string, instanceId: string, state: CompressorChainState) => {
    compressorMeterSubscriptions.get(trackId)?.get(instanceId)?.()
    compressorMeterSubscriptions.get(trackId)?.delete(instanceId)
    const listeners = compressorMeterListeners.get(trackId)?.get(instanceId)
    if (!listeners || listeners.size === 0) return
    const unsubscribe = state.subscribeMeter((frame) => {
      for (const listener of listeners) listener(frame)
    })
    ensureNestedMap(compressorMeterSubscriptions, trackId).set(instanceId, unsubscribe)
  }

  const closeInstanceState = (trackId: string, instanceId: string) => {
    compressorMeterSubscriptions.get(trackId)?.get(instanceId)?.()
    compressorMeterSubscriptions.get(trackId)?.delete(instanceId)
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
    liveParams.get(trackId)?.delete(instanceId)
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
    liveParams.delete(trackId)
  }

  const createInstanceStageConfigs = (
    trackId: string,
    instances: AudioEffectRuntimeInstance[],
    resources: TrackInstanceResources = currentTrackResources(trackId),
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

  const rebuildTrackRouting = (
    trackId: string,
    nodes: TrackNodeGroup,
  ) => {
    let wasUnfinished = false
    const reconnect = () => {
      wasUnfinished = unfinishedGraphPublications.has(trackId)
      unfinishedGraphPublications.add(trackId)
      disconnectAudioNodes([nodes.input, nodes.mute, nodes.gain])
      connectFxChain(nodes.input, nodes.postFx, {
        instances: createInstanceStageConfigs(trackId, trackFxInstances.get(trackId) ?? []),
      })
      nodes.postFx.connect(nodes.mute)
      nodes.mute.connect(nodes.gain)
      nodes.gain.connect(nodes.output)
      drainRetiredTrackResources(trackId)
    }
    const ctx = options.getAudioContext()
    if (!ctx) {
      routingTransitionOwners.get(trackId)?.cancel()
      reconnect()
      return
    }
    let transitionOwner = routingTransitionOwners.get(trackId)
    if (!transitionOwner) {
      transitionOwner = createGainTransitionOwner(nodes.postFx, () => ctx.currentTime, options.transitionScheduler)
      routingTransitionOwners.set(trackId, transitionOwner)
    }
    transitionOwner.request(
      reconnect,
      () => {
        if (!wasUnfinished) unfinishedGraphPublications.delete(trackId)
      },
    )
  }

  const ensureTrackNodes = (trackId: string): TrackNodeGroup => {
    options.ensureAudio()
    const ctx = assertDefined(options.getAudioContext(), 'Audio runtime was not initialized')

    let input = inputs.get(trackId)
    const createdInput = !input
    if (!input) {
      input = ctx.createGain()
      inputs.set(trackId, input)
      const releases = trackNodeReleases.get(trackId) ?? []
      releases.push(observeResource(options.resourceObserver, 'audio-nodes', input))
      trackNodeReleases.set(trackId, releases)
    }

    let gain = gains.get(trackId)
    if (!gain) {
      gain = ctx.createGain()
      gain.gain.value = 1
      gains.set(trackId, gain)
      trackNodeReleases.get(trackId)?.push(observeResource(options.resourceObserver, 'audio-nodes', gain))
    }

    let mute = muteGains.get(trackId)
    if (!mute) {
      mute = ctx.createGain()
      mute.gain.value = 1
      muteGains.set(trackId, mute)
      trackNodeReleases.get(trackId)?.push(observeResource(options.resourceObserver, 'audio-nodes', mute))
    }

    let output = outputs.get(trackId)
    if (!output) {
      output = ctx.createGain()
      output.gain.value = 1
      outputs.set(trackId, output)
      trackNodeReleases.get(trackId)?.push(observeResource(options.resourceObserver, 'audio-nodes', output))
    }

    let postFx = postFxOutputs.get(trackId)
    if (!postFx) {
      postFx = ctx.createGain()
      postFxOutputs.set(trackId, postFx)
      trackNodeReleases.get(trackId)?.push(observeResource(options.resourceObserver, 'audio-nodes', postFx))
    }


    if (createdInput) {
      disconnectAudioNodes([input])
      input.connect(postFx)
      // The chain asked for before there was a context installs through the same path as any request. runTrackFxInstances
      // has already reported a failure.
      void chainAdmissions.get(trackId)?.replay((instances) => runTrackFxInstances(trackId, instances, ctx), 'dropped')?.catch(() => undefined)
    }

    return { input, postFx, mute, gain, output }
  }

  const bypassStaticWorklet = (
    trackId: string,
    instanceId: string,
    chain: StaticWorkletNodeChain,
  ) => {
    if (instanceStaticWorkletChains.get(trackId)?.get(instanceId) !== chain) return
    trackFxInstanceRevisions.set(trackId, (trackFxInstanceRevisions.get(trackId) ?? 0) + 1)
    closeInstanceState(trackId, instanceId)
    const admission = chainAdmissions.get(trackId)
    const requested = admission?.intent()
    if (requested) admission?.adopt(requested.filter((instance) => instance.id !== instanceId))
    const instances = (trackChainInstances.get(trackId) ?? []).filter((instance) => instance.id !== instanceId)
    trackChainInstances.set(trackId, instances)
    trackFxInstances.set(trackId, instances)
    trackFx.set(trackId, { instances })
    const transaction = options.workletBudget.begin(`track:${trackId}`, 0)
    options.workletBudget.commit(transaction, countStaticWorklets(instances))
    const nodes = inputs.has(trackId) && gains.has(trackId) ? ensureTrackNodes(trackId) : null
    try {
      if (nodes) rebuildTrackRouting(trackId, nodes)
      applyAuxiliaryRoutes()
      if (chain.kind === 'spectral') refreshMixerRouting()
    } catch (error) {
      unfinishedGraphPublications.add(trackId)
      throw error
    }
  }

  type InPlaceEdit = Pick<TrackCandidate, 'requiresRoutingRebuild' | 'eqParamUpdates' | 'writtenInPlace'>

  // Applies an instance's new parameters to the nodes that already hold it, replacing none. False when nothing holds it
  // that way, so the caller builds it. The one parameter path for a whole-chain update and for a single-instance edit.
  // Its proof leaves liveParams before a node is written and returns only when the request commits (recordCommittedParams):
  // a write that throws, or a request superseded after it, leaves a node holding what no proof names.
  const applyParamsInPlace = async (
    trackId: string,
    instance: AudioEffectRuntimeInstance,
    prior: AudioEffectRuntimeInstance | undefined,
    resources: TrackInstanceResources,
    edit: InPlaceEdit,
    stale: () => boolean,
  ): Promise<boolean> => {
    const ctx = options.getAudioContext()
    if (!ctx) return false
    // The EQ is the exception: its node write waits for the commit.
    const forgetLive = () => liveParams.get(trackId)?.delete(instance.id)
    if (instance.kind === 'eq') {
      const params = normalizeEqParams(instance.params)
      const priorParams = prior?.kind === 'eq' ? normalizeEqParams(prior.params) : undefined
      const priorNodes = resources.eq.get(instance.id)
      if (!priorParams || !priorNodes || getEqTopologySignature(priorParams) !== getEqTopologySignature(params)) return false
      resources.eqSignatures.set(instance.id, serializeNormalizedEqParams(params))
      edit.eqParamUpdates.push({ instance, nodes: priorNodes, params })
      return true
    }
    if (isStaticWorkletInstance(instance)) {
      const retained = instanceStaticWorkletChains.get(trackId)?.get(instance.id)
      if (prior?.kind !== instance.kind || retained?.state !== 'active') return false
      forgetLive()
      applyStaticWorkletNodeParams(retained, instance.params)
      resources.staticWorklets.set(instance.id, retained)
      edit.writtenInPlace.push(instance)
      return true
    }
    if (instance.kind === 'compressor' && prior?.kind === 'compressor') {
      const state = resources.compressors.get(instance.id)
      if (!state) return false
      forgetLive()
      const params = normalizeCompressorParams(instance.params)
      const result = await state.set(ctx, params)
      // The state keeps a faulted chain when its replacement cannot be built and still reports success. A newer request
      // owns the chain by now and cancelled the construction this one awaited: it reports the outcome, not this check.
      if (!stale() && params.enabled && state.chain()?.state !== 'active') throw new Error('Failed to recover compressor chain.')
      edit.requiresRoutingRebuild = result.requiresRoutingRebuild || edit.requiresRoutingRebuild
      edit.writtenInPlace.push(instance)
      return true
    }
    if (instance.kind === 'saturator' && prior?.kind === 'saturator') {
      const state = resources.saturators.get(instance.id)
      if (!state) return false
      forgetLive()
      edit.requiresRoutingRebuild = state.set(ctx, instance.params).requiresRoutingRebuild || edit.requiresRoutingRebuild
      edit.writtenInPlace.push(instance)
      return true
    }
    if (instance.kind === 'delay' && prior?.kind === 'delay') {
      const state = resources.delays.get(instance.id)
      if (!state) return false
      forgetLive()
      edit.requiresRoutingRebuild = state.set(ctx, instance.params, currentBpm).requiresRoutingRebuild || edit.requiresRoutingRebuild
      edit.writtenInPlace.push(instance)
      return true
    }
    if (instance.kind === 'reverb' && prior?.kind === 'reverb') {
      const state = resources.reverbs.get(instance.id)
      if (!state) return false
      forgetLive()
      const result = await state.set(ctx, instance.params)
      edit.requiresRoutingRebuild = result.requiresRoutingRebuild || edit.requiresRoutingRebuild
      edit.writtenInPlace.push(instance)
      return true
    }
    return false
  }

  // What the graph needs after a chain update: latency, routing and auxiliary routes. One in-place parameter edit
  // (same ids and kinds, no node replaced, no rebuild, same latency) changes none of them, so a live gesture skips it.
  const settleTrackGraph = (
    trackId: string,
    previous: AudioEffectRuntimeInstance[] | undefined,
    normalized: AudioEffectRuntimeInstance[],
    wasInstanceMode: boolean,
    changed: readonly AudioEffectRuntimeInstance[],
    update: { ownedIds: ReadonlySet<string>; requiresRoutingRebuild: boolean },
    forceRoutingRebuild: boolean,
  ): boolean => {
    const ctx = options.getAudioContext()
    if (!ctx) return false
    const requiresRoutingRebuild = update.requiresRoutingRebuild || forceRoutingRebuild
    const inPlace = wasInstanceMode && update.ownedIds.size === 0 && !update.requiresRoutingRebuild &&
      !forceRoutingRebuild &&
      !changed.some((instance) => instance.kind === 'spectral') &&
      getEffectChainTiming(previous ?? [], ctx.sampleRate, currentBpm).latencyFrames ===
        getEffectChainTiming(normalized, ctx.sampleRate, currentBpm).latencyFrames
    if (!inPlace) publishGraphLatency()
    const nodes = inputs.has(trackId) && gains.has(trackId) ? ensureTrackNodes(trackId) : null
    if (requiresRoutingRebuild && nodes) {
      rebuildTrackRouting(trackId, nodes)
    } else if (!routingTransitionOwners.get(trackId)?.pending()) {
      drainRetiredTrackResources(trackId)
    }
    if (inPlace) {
      return true
    }
    applyAuxiliaryRoutes()
    if (normalized.some((instance) => instance.kind === 'spectral')) refreshMixerRouting()
    return true
  }

  // A commit is when new resources, confirmed in-place writes and deferred EQ writes become what the nodes hold. Ids that
  // left the chain hold nothing any more. A candidate that was discarded never reaches this, so it records nothing.
  const recordCommittedParams = (
    trackId: string,
    instances: readonly AudioEffectRuntimeInstance[],
    createdIds: ReadonlySet<string>,
    edit: InPlaceEdit,
  ) => {
    const held = ensureNestedMap(liveParams, trackId)
    const ids = new Set(instances.map((instance) => instance.id))
    for (const id of held.keys()) if (!ids.has(id)) held.delete(id)
    for (const instance of instances) if (createdIds.has(instance.id)) held.set(instance.id, instance.params)
    for (const instance of edit.writtenInPlace) held.set(instance.id, instance.params)
    for (const update of edit.eqParamUpdates) {
      // The proof leaves before the nodes are written: a write that throws partway leaves them holding no named value.
      held.delete(update.instance.id)
      applyEqNodeParams(update.nodes, update.params)
      held.set(update.instance.id, update.instance.params)
    }
  }

  const applyTrackFxInstances = async (trackId: string, instances: AudioEffectRuntimeInstance[], ctx: AudioContext): Promise<EngineDisposition> => {
    const publicationPending = unfinishedGraphPublications.has(trackId)
    const revision = (trackFxInstanceRevisions.get(trackId) ?? 0) + 1
    trackFxInstanceRevisions.set(trackId, revision)
    const wasInstanceMode = trackChainInstances.has(trackId)
    const inputIds = new Set<string>()
    for (const instance of instances) {
      if (inputIds.has(instance.id)) throw new Error(`Duplicate effect instance ID: ${instance.id}`)
      inputIds.add(instance.id)
    }
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    const previous = trackChainInstances.get(trackId)
    const previousById = new Map(previous?.map((instance) => [instance.id, instance]))
    // Equal means the nodes hold the requested parameters, not that the installed chain lists them: a superseded
    // request can have moved a node and left the installed chain on its old value.
    const unchanged = (instance: AudioEffectRuntimeInstance) => {
      const prior = previousById.get(instance.id)
      const held = liveParams.get(trackId)?.get(instance.id)
      if (!prior || prior.kind !== instance.kind || held === undefined || JSON.stringify(held) !== JSON.stringify(instance.params)) return false
      if (isStaticWorkletKind(instance.kind)) return instanceStaticWorkletChains.get(trackId)?.get(instance.id)?.state === 'active'
      if (instance.kind === 'compressor') return !instance.params.enabled || instanceCompressorChains.get(trackId)?.get(instance.id)?.chain()?.state === 'active'
      return true
    }
    const changed = normalized.filter((instance) => !unchanged(instance))
    const changedInstances = new Set(changed)
    const sameChainOrder = previous !== undefined && previous.length === normalized.length &&
      previous.every((prior, index) => prior.id === normalized[index]?.id && prior.kind === normalized[index]?.kind)
    // The revision is already bumped, so an older request still in flight cannot commit over what the nodes hold.
    if (!publicationPending && sameChainOrder && changed.length === 0) return 'skipped'
    const candidateWorkletCount = changed.filter((instance) => isStaticWorkletKind(instance.kind)).length
    const transaction = options.workletBudget.begin(`track:${trackId}`, candidateWorkletCount)
    const stale = () => trackFxInstanceRevisions.get(trackId) !== revision || !options.workletBudget.isCurrent(transaction)
    // Exactly one instance changed, with the same id and kind in the same place: its parameters go straight to the
    // nodes that hold it, before any resource snapshot, whole-chain loop, meter rebind or retirement scan.
    const [instance] = changed
    if (!publicationPending && previous && instance && changed.length === 1 && sameChainOrder) {
      const edit: InPlaceEdit = { requiresRoutingRebuild: false, eqParamUpdates: [], writtenInPlace: [] }
      let applied: boolean
      try {
        applied = await applyParamsInPlace(trackId, instance, previousById.get(instance.id), currentTrackResources(trackId), edit, stale)
      } catch (error) {
        options.workletBudget.rollback(transaction)
        throw error
      }
      if (applied) {
        if (stale()) {
          options.workletBudget.rollback(transaction)
          return 'superseded'
        }
        if (!options.workletBudget.commit(transaction, countStaticWorklets(normalized))) {
          options.workletBudget.rollback(transaction)
          return 'dropped'
        }
        unfinishedGraphPublications.add(trackId)
        trackChainInstances.set(trackId, normalized)
        trackFxInstances.set(trackId, normalized)
        trackFx.set(trackId, { instances: normalized })
        recordCommittedParams(trackId, normalized, new Set(), edit)
        const settled = settleTrackGraph(
          trackId,
          previous,
          normalized,
          wasInstanceMode,
          changed,
          { ownedIds: new Set(), requiresRoutingRebuild: edit.requiresRoutingRebuild },
          publicationPending,
        )
        if (settled) unfinishedGraphPublications.delete(trackId)
        return 'applied'
      }
    }
    const oldResources = snapshotTrackResources(trackId)
    const candidate: TrackCandidate = {
      instances: normalized,
      transaction,
      resources: snapshotTrackResources(trackId),
      ownedIds: new Set(),
      requiresRoutingRebuild: !wasInstanceMode || previous?.length !== normalized.length ||
        previous?.some((instance, index) => instance.id !== normalized[index]?.id || instance.kind !== normalized[index]?.kind) === true,
      desiredStaticCount: countStaticWorklets(normalized),
      eqParamUpdates: [],
      writtenInPlace: [],
    }
    const discard = () => {
      closeTrackResources(candidate.resources, candidate.ownedIds)
      options.workletBudget.rollback(transaction)
    }
    try {
      for (const instance of normalized) {
      if (!changedInstances.has(instance)) continue
      // Every instance after the first is reached through an await: a newer request may own the nodes by now.
      if (stale()) {
        discard()
        return 'superseded'
      }
      if (await applyParamsInPlace(trackId, instance, previousById.get(instance.id), candidate.resources, candidate, stale)) continue
      candidate.ownedIds.add(instance.id)
      removeTrackCandidateResources(candidate.resources, instance.id)
      if (isStaticWorkletInstance(instance)) {
        const faultGeneration = options.getFaultGeneration()
        const createdHolder: StaticWorkletChainHolder = { chain: undefined }
        const created = await createStaticWorkletNodeChain(ctx, instance.kind, instance.params, (code) => {
          const chain = createdHolder.chain
          if (!chain) return
          bypassStaticWorklet(trackId, instance.id, chain)
          options.onWorkletFault?.(faultGeneration, 'owned-processor', code, `track:${trackId}:effect:${instance.id}`)
        })
        createdHolder.chain = created
        if (stale()) {
          disconnectStaticWorkletNodeChain(created)
          discard()
          return 'superseded'
        }
        candidate.resources.staticWorklets.set(instance.id, created)
        candidate.requiresRoutingRebuild = true
        continue
      }
      if (instance.kind === 'eq') {
        const params = normalizeEqParams(instance.params)
        const targetChannels = options.getDestination()?.maxChannelCount ?? ctx.destination.maxChannelCount ?? 2
        const nodes = createEqNodes(ctx, params, targetChannels)
        candidate.resources.eq.set(instance.id, nodes)
        candidate.resources.eqByBand.set(instance.id, new Map(params.bands.filter((band) => band.enabled).flatMap((band, index) => {
          const node = nodes[index]
          return node ? [[band.id, node]] : []
        })))
        candidate.resources.eqSignatures.set(instance.id, serializeNormalizedEqParams(params))
        candidate.resources.eqTopologySignatures.set(instance.id, getEqTopologySignature(params))
        candidate.requiresRoutingRebuild = true
        continue
      }
      if (instance.kind === 'compressor') {
        const faultGeneration = options.getFaultGeneration()
        const state = createCompressorChainState((audioContext, params) =>
          createCompressorNodeChain(audioContext, params, (code) => options.onWorkletFault?.(faultGeneration, 'compressor', code, `track:${trackId}:effect:${instance.id}`)))
        const result = await state.set(ctx, normalizeCompressorParams(instance.params))
        if (stale()) {
          state.close()
          discard()
          return 'superseded'
        }
        if (instance.params.enabled && !state.chain()) throw new Error('Failed to construct compressor chain.')
        candidate.resources.compressors.set(instance.id, state)
        candidate.requiresRoutingRebuild = result.changed || candidate.requiresRoutingRebuild
        continue
      }
      if (instance.kind === 'saturator') {
        const state = createSaturatorChainState()
        state.set(ctx, instance.params)
        candidate.resources.saturators.set(instance.id, state)
        candidate.requiresRoutingRebuild = true
        continue
      }
      if (instance.kind === 'delay') {
        const state = createDelayChainState()
        state.set(ctx, instance.params, currentBpm)
        candidate.resources.delays.set(instance.id, state)
        candidate.requiresRoutingRebuild = true
        continue
      }
      if (instance.kind !== 'reverb') throw new Error('Unsupported audio effect kind.')
      const state = createReverbChainState()
      await state.set(ctx, instance.params)
      candidate.resources.reverbs.set(instance.id, state)
      candidate.requiresRoutingRebuild = true
      }
    } catch (error) {
      discard()
      throw error
    }
    if (stale()) {
      discard()
      return 'superseded'
    }
    if (!options.workletBudget.commit(transaction, candidate.desiredStaticCount)) {
      discard()
      return 'dropped'
    }
    unfinishedGraphPublications.add(trackId)
    trackChainInstances.set(trackId, candidate.instances)
    trackFxInstances.set(trackId, candidate.instances)
    trackFx.set(trackId, { instances: candidate.instances })
    const installedIds = new Set(candidate.instances.map((instance) => instance.id))
    const displaced = new Set<string>()
    for (const id of candidate.ownedIds) {
      if (oldResources.eq.has(id) || oldResources.compressors.has(id) || oldResources.reverbs.has(id) ||
        oldResources.saturators.has(id) || oldResources.delays.has(id) || oldResources.staticWorklets.has(id)) displaced.add(id)
    }
    for (const id of [
      ...oldResources.eq.keys(), ...oldResources.compressors.keys(), ...oldResources.reverbs.keys(),
      ...oldResources.saturators.keys(), ...oldResources.delays.keys(), ...oldResources.staticWorklets.keys(),
    ]) {
      if (!installedIds.has(id)) displaced.add(id)
    }
    for (const id of displaced) {
      if (!installedIds.has(id)) removeTrackCandidateResources(candidate.resources, id)
    }
    if (displaced.size > 0) {
      const retired = retiredTrackResources.get(trackId) ?? []
      retired.push({ resources: oldResources, ids: displaced })
      retiredTrackResources.set(trackId, retired)
    }
    publishTrackResources(trackId, candidate.resources)
    recordCommittedParams(trackId, candidate.instances, candidate.ownedIds, candidate)
    for (const instance of candidate.instances) {
      const staticWorklet = candidate.resources.staticWorklets.get(instance.id)
      if (staticWorklet) bindGateMeter(trackId, instance.id, staticWorklet)
      const compressor = candidate.resources.compressors.get(instance.id)
      if (compressor) bindCompressorMeter(trackId, instance.id, compressor)
    }
    if (settleTrackGraph(trackId, previous, normalized, wasInstanceMode, changed, candidate, publicationPending)) {
      unfinishedGraphPublications.delete(trackId)
    }
    return 'applied'
  }

  const runTrackFxInstances = async (trackId: string, normalized: AudioEffectRuntimeInstance[], ctx: AudioContext) => {
    try {
      return await applyTrackFxInstances(trackId, normalized, ctx)
    } catch (error) {
      options.onWorkletFault?.(
        options.getFaultGeneration(),
        'owned-processor',
        'effect-chain-construction-failed',
        `track:${trackId}:${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  // Every chain request, whole or single, goes through the track's admission: an equal request joins the work still
  // running (failure included) and a different one supersedes it in applyTrackFxInstances. Without a context the request
  // is only kept, and the revision moves so the work of the chain it replaces cannot commit over it.
  const setTrackFxInstances = (trackId: string, instances: AudioEffectRuntimeInstance[]): Promise<EngineDisposition> => {
    const ctx = options.getAudioContext()
    if (!ctx) trackFxInstanceRevisions.set(trackId, (trackFxInstanceRevisions.get(trackId) ?? 0) + 1)
    return admissionFor(trackId).admit(
      normalizeAudioEffectRuntimeInstances(instances),
      ctx ? (chain) => runTrackFxInstances(trackId, chain, ctx) : undefined,
      'dropped',
    )
  }

  // Replaces one instance of the chain last requested, installed or not. Resolves 'not-held' when that chain does not
  // hold the id, so the caller sends the whole chain instead.
  const replaceTrackFxInstance = async (trackId: string, instance: AudioEffectRuntimeInstance): Promise<EngineDisposition | 'not-held'> => {
    const requested = chainAdmissions.get(trackId)?.intent()
    if (!requested?.some((entry) => entry.id === instance.id)) return 'not-held'
    return setTrackFxInstances(trackId, requested.map((entry) => entry.id === instance.id ? instance : entry))
  }

  const disposeTrack = (trackId: string) => {
    routingTransitionOwners.get(trackId)?.dispose()
    routingTransitionOwners.delete(trackId)
    const gain = gains.get(trackId)
    const mute = muteGains.get(trackId)
    const input = inputs.get(trackId)
    const postFx = postFxOutputs.get(trackId)
    const output = outputs.get(trackId)
    const removedNodes = new Set([gain, mute, input, postFx, output].flatMap((node) => node ? [node] : []))
    removeLiveMixerEdgesForNodes(edgeRuntimes, removedNodes)
    removeLiveMixerEdgesForNodes(sidechainEdges, removedNodes)
    removeLiveMixerEdgesForNodes(cueEdges, removedNodes)
    disconnectAudioNodes([gain, mute])
    gains.delete(trackId)
    muteGains.delete(trackId)
    appliedStaticGains.delete(trackId)
    dirtyStaticGainTargets.delete(trackId)
    disconnectAudioNodes([input])
    inputs.delete(trackId)
    disconnectAudioNodes([postFx])
    postFxOutputs.delete(trackId)
    disconnectAudioNodes([output])
    outputs.delete(trackId)

    trackFxInstances.delete(trackId)
    trackChainInstances.delete(trackId)
    unfinishedGraphPublications.delete(trackId)
    chainAdmissions.delete(trackId)
    trackFxInstanceRevisions.delete(trackId)
    trackFx.delete(trackId)
    options.workletBudget.releaseOwner(`track:${trackId}`)
    closeTrackInstanceStates(trackId)
    drainRetiredTrackResources(trackId)
    for (const release of trackNodeReleases.get(trackId) ?? []) release()
    trackNodeReleases.delete(trackId)

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
    muteGains.clear()
    postFxOutputs.clear()
    inputs.clear()
    for (const trackId of trackFxInstances.keys()) options.workletBudget.releaseOwner(`track:${trackId}`)
    trackFxInstances.clear()
    chainAdmissions.clear()
    trackChainInstances.clear()
    trackFxInstanceRevisions.clear()
    liveParams.clear()
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
    for (const trackId of retiredTrackResources.keys()) drainRetiredTrackResources(trackId)
    gateMeterSubscriptions.clear()
    gateMeterListeners.clear()
    compressorMeterSubscriptions.clear()
    compressorMeterListeners.clear()
    options.onGraphLatencyChange?.(null)
    currentTracks = []
    appliedStaticGains.clear()
    automatedVolumeTargets.clear()
    dirtyStaticGainTargets.clear()
  }

  const refreshMixerRouting = () => {
    const ctx = options.getAudioContext()
    const masterInput = options.getMasterInput()
    if (!ctx || !masterInput) return
    const graph = resolveLiveMixerGraph(currentTracks, Object.fromEntries(trackFx), options.getMasterFx())
    publishGraphLatency()
    const trackNodes = new Map<string, TrackNodeGroup>()
    const staticGainSync = new Map<string, { gain: boolean; outputGain: boolean; muteGain: boolean; created: boolean }>()
    for (const resolvedTrack of graph.channels) {
      const trackId = resolvedTrack.channel.id
      const prior = appliedStaticGains.get(trackId)
      const created = !prior || !gains.has(trackId) || !outputs.has(trackId)
      const trackVolume = Number.isFinite(resolvedTrack.channel.volume) ? resolvedTrack.channel.volume : 0
      const gain = created || dirtyStaticGainTargets.has(trackId) || prior?.gain !== trackVolume
      const outputGain = created || prior?.outputGain !== resolvedTrack.outputGain
      const muteGain = created || prior?.muteGain !== (resolvedTrack.channel.muted ? 0 : 1)
      if (gain || outputGain || muteGain) staticGainSync.set(trackId, { gain, outputGain, muteGain, created })
      trackNodes.set(trackId, ensureTrackNodes(trackId))
    }
    const activeMeterTrackIds = new Set<string>(
      graph.channels.filter((entry) => entry.outputGain > 0 || entry.sends.length > 0).map((entry) => entry.channel.id),
    )
    applyLiveMixerGraph({
      graph,
      masterInput,
      trackNodes,
      edgeRuntimes,
      staticGainSync,
      automatedVolumeTargets,
      createGain: () => ctx.createGain(),
      createDelay: () => ctx.createDelay(),
      observeEdgeResource: (node) => observeResource(options.resourceObserver, 'audio-nodes', node),
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
    for (const resolvedTrack of graph.channels) {
      appliedStaticGains.set(resolvedTrack.channel.id, {
        gain: Number.isFinite(resolvedTrack.channel.volume) ? resolvedTrack.channel.volume : 0,
        outputGain: resolvedTrack.outputGain,
        muteGain: resolvedTrack.channel.muted ? 0 : 1,
      })
      dirtyStaticGainTargets.delete(resolvedTrack.channel.id)
    }
    const activeTrackIds = new Set<string>(graph.channels.map((entry) => entry.channel.id))
    for (const id of Array.from(gains.keys())) if (!activeTrackIds.has(id)) disposeTrack(id)
    applyAuxiliaryRoutes()
  }

  return {
    publishGraphLatency,
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
      currentTracks = tracks
      refreshMixerRouting()
    },
    previewTrackVolume: (trackId: string, volume: number, muted: boolean) => {
      const gain = gains.get(trackId)
      const mute = muteGains.get(trackId)
      const ctx = options.getAudioContext()
      if (!gain || !mute || !ctx) return
      const targetVolume = Number.isFinite(volume) ? Math.max(0, volume) : 0
      try {
        rampAudioParam(gain.gain, targetVolume, ctx.currentTime)
        rampAudioParam(mute.gain, muted ? 0 : 1, ctx.currentTime)
      } catch {}
    },
    setTrackFxInstances,
    replaceTrackFxInstance,
    setExternalSidechainRoutes: (routes: ExternalSidechainRoute[]) => {
      const seen = new Set<string>()
      for (const route of routes) {
        if (route.sourceTrackId === route.targetTrackId) throw new Error('An effect cannot sidechain from its own track.')
        const identity = sidechainRouteIdentity(route.targetTrackId, route.effectInstanceId)
        if (seen.has(identity)) throw new Error('An effect can have only one external sidechain route.')
        seen.add(identity)
      }
      sidechainRoutes = routes
      applyAuxiliaryRoutes()
      publishGraphLatency()
    },
    setCueTrackIds: (trackIds: readonly string[]) => {
      cueTrackIds = new Set(trackIds)
      applyAuxiliaryRoutes()
      publishGraphLatency()
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
      publishGraphLatency()
    },
    resolveTrackAutomationBindings: (trackId: string, parameterId: string, effectInstanceId?: string): AutomationAudioBinding[] => {
      const trackNodes = ensureTrackNodes(trackId)
      if (parameterId === 'volume') return [{ param: trackNodes.gain.gain, valueToAudioValue: (value) => value }]
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
    },
    setAutomatedVolumeTargets: (envelopes: readonly AutomationEnvelope[]) => {
      const nextTargets = new Set(envelopes.flatMap((envelope) => {
        if (!envelope.enabled || envelope.parameterId !== 'volume') return []
        if (envelope.target.kind === 'master') return ['master']
        if (envelope.target.kind === 'track') return [envelope.target.trackId]
        return []
      }))
      for (const target of automatedVolumeTargets) {
        if (nextTargets.has(target)) continue
        if (target === 'master') {
          const parameter = options.getMasterInput()?.gain
          if (parameter) forgetAudioParamValue(parameter)
        } else {
          const parameter = gains.get(target)?.gain
          dirtyStaticGainTargets.add(target)
          if (parameter) forgetAudioParamValue(parameter)
        }
      }
      for (const target of nextTargets) {
        if (automatedVolumeTargets.has(target)) continue
        const parameter = target === 'master'
          ? options.getMasterInput()?.gain
          : gains.get(target)?.gain
        if (parameter) forgetAudioParamValue(parameter)
      }
      automatedVolumeTargets = nextTargets
      refreshMixerRouting()
    },
    subscribeTrackCompressorMeter: (trackId: string, instanceId: string, listener: CompressorMeterListener) => {
      const listeners = ensureNestedMap(compressorMeterListeners, trackId).get(instanceId) ?? new Set<CompressorMeterListener>()
      ensureNestedMap(compressorMeterListeners, trackId).set(instanceId, listeners)
      listeners.add(listener)
      const state = instanceCompressorChains.get(trackId)?.get(instanceId)
      if (state && !compressorMeterSubscriptions.get(trackId)?.has(instanceId)) bindCompressorMeter(trackId, instanceId, state)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        compressorMeterSubscriptions.get(trackId)?.get(instanceId)?.()
        compressorMeterSubscriptions.get(trackId)?.delete(instanceId)
        compressorMeterListeners.get(trackId)?.delete(instanceId)
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
    setBpm: (bpm: number) => {
      currentBpm = bpm
      let failure: unknown
      for (const [trackId, states] of instanceDelayChains) {
        for (const [instanceId, state] of states) {
          try {
            state.setBpm(bpm)
          } catch (error) {
            trackFxInstanceRevisions.set(trackId, (trackFxInstanceRevisions.get(trackId) ?? 0) + 1)
            liveParams.get(trackId)?.delete(instanceId)
            failure ??= error
          }
        }
      }
      try {
        publishGraphLatency()
      } catch (error) {
        failure ??= error
      }
      if (failure !== undefined) throw failure
    },
    disposeTrack,
    clear,
  }
}
