import { DEFAULT_BPM } from '@daw-browser/timeline-core/project-defaults'
import { assertDefined, isGainReductionMeterKind, isOwnedProcessorKind, isSidechainCapableKind, type AutomationEnvelope } from '@daw-browser/shared'
import { connectFxChain, createGainTransitionOwner, disconnectAudioNodes, type FxChainStageConfig, type GainTransitionOwner, type GainTransitionScheduler } from './effects/chain'
import type { CompressorChainState } from './effects/compressor-chain-state'
import type { EqChainState } from './effects/eq-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import type { DelayChainState } from './effects/delay-chain-state'
import type { ReverbChainState } from './effects/reverb-chain-state'
import type { SaturatorChainState } from './effects/saturator-chain-state'
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
import { disconnectStaticWorkletNodeChain, resolveStaticWorkletAutomationBinding, subscribeStaticGateMeter, type GateMeterListener, type StaticWorkletNodeChain } from './effects/static-worklet-chain'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'
import { countStaticWorklets, type LiveWorkletBudget } from './effects/live-worklet-budget'
import { getEffectChainTiming } from './effects/timing'
import { createChainAdmission } from './chain-admission'
import type { EngineDisposition } from './engine-disposition'
import { closeResources, createEffectChainTransaction, type ChainCommit, type InstanceResources } from './effect-chain-transaction'

export const sidechainRouteIdentity = (targetTrackId: string, effectInstanceId: string) => (
  JSON.stringify([targetTrackId, effectInstanceId])
)

export const findExternalSidechainTarget = (
  instances: readonly AudioEffectRuntimeInstance[] | undefined,
  effectInstanceId: string,
) => {
  const instance = instances?.find((candidate) => candidate.id === effectInstanceId)

  return instance && isSidechainCapableKind(instance.kind)
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
  workletBudget: LiveWorkletBudget
  getFaultGeneration: () => number
  transitionScheduler?: GainTransitionScheduler
  onGraphLatencyChange?: (frames: number | null) => void
  onWorkletFault?: (generation: number, kind: 'compressor' | 'owned-processor', code: string, context: string) => void
  resourceObserver?: ResourceObserver
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

  const instanceEqChains = new Map<string, Map<string, EqChainState>>()
  const instanceCompressorChains = new Map<string, Map<string, CompressorChainState>>()
  const instanceReverbChains = new Map<string, Map<string, ReverbChainState>>()
  const instanceSaturatorChains = new Map<string, Map<string, SaturatorChainState>>()
  const instanceDelayChains = new Map<string, Map<string, DelayChainState>>()
  const instanceStaticWorkletChains = new Map<string, Map<string, StaticWorkletNodeChain>>()
  const compressorMeterListeners = new Map<string, Map<string, Set<CompressorMeterListener>>>()
  const compressorMeterSubscriptions = new Map<string, Map<string, () => void>>()
  const gateMeterListeners = new Map<string, Map<string, Set<GateMeterListener>>>()
  const gateMeterSubscriptions = new Map<string, Map<string, () => void>>()
  let currentBpm = DEFAULT_BPM
  let currentTracks: RuntimeTrack[] = []
  const retiredTrackResources = new Map<string, Array<{ resources: InstanceResources; ids: Set<string> }>>()
  const unfinishedGraphPublications = new Set<string>()
  const appliedStaticGains = new Map<string, { gain: number; outputGain: number; muteGain: number }>()
  let automatedVolumeTargets = new Set<string>()
  const dirtyStaticGainTargets = new Set<string>()

  const currentTrackResources = (trackId: string): InstanceResources => ({
    eqs: instanceEqChains.get(trackId) ?? new Map(),
    compressors: instanceCompressorChains.get(trackId) ?? new Map(),
    reverbs: instanceReverbChains.get(trackId) ?? new Map(),
    saturators: instanceSaturatorChains.get(trackId) ?? new Map(),
    delays: instanceDelayChains.get(trackId) ?? new Map(),
    staticWorklets: instanceStaticWorkletChains.get(trackId) ?? new Map(),
  })

  const replaceNestedMap = <Value,>(target: Map<string, Map<string, Value>>, trackId: string, source: Map<string, Value>) => {
    target.set(trackId, new Map(source))
  }

  const publishTrackResources = (trackId: string, resources: InstanceResources) => {
    replaceNestedMap(instanceEqChains, trackId, resources.eqs)
    replaceNestedMap(instanceCompressorChains, trackId, resources.compressors)
    replaceNestedMap(instanceReverbChains, trackId, resources.reverbs)
    replaceNestedMap(instanceSaturatorChains, trackId, resources.saturators)
    replaceNestedMap(instanceDelayChains, trackId, resources.delays)
    replaceNestedMap(instanceStaticWorkletChains, trackId, resources.staticWorklets)
  }

  const drainRetiredTrackResources = (trackId: string) => {
    for (const { resources, ids } of retiredTrackResources.get(trackId) ?? []) closeResources(resources, ids)
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
      const targetNode = compressor?.workletNode ?? (owned && isSidechainCapableKind(owned.kind) ? owned.node : undefined)

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

    if (!isGainReductionMeterKind(chain.kind) || !listeners || listeners.size === 0) return

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
    instanceEqChains.get(trackId)?.get(instanceId)?.close()
    instanceEqChains.get(trackId)?.delete(instanceId)
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
    resources: InstanceResources = currentTrackResources(trackId),
  ): FxChainStageConfig[] => instances.map((instance) => ({
    id: instance.id,
    kind: instance.kind,
    eqNodes: instance.kind === 'eq' ? resources.eqs.get(instance.id)?.nodes() : undefined,
    compressorChain: instance.kind === 'compressor' ? resources.compressors.get(instance.id)?.chain() : undefined,
    saturatorChain: instance.kind === 'saturator' ? resources.saturators.get(instance.id)?.chain() : undefined,
    delayChain: instance.kind === 'delay' ? resources.delays.get(instance.id)?.chain() : undefined,
    reverbChain: instance.kind === 'reverb' ? resources.reverbs.get(instance.id)?.chain() : undefined,
    staticWorkletChain: isOwnedProcessorKind(instance.kind) ? resources.staticWorklets.get(instance.id) : undefined,
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

  // What the graph needs after a chain update: latency, routing and auxiliary routes. One in-place parameter edit
  // (same ids and kinds, no node replaced, no rebuild, same latency) changes none of them, so a live gesture skips it.
  const settleTrackGraph = (
    trackId: string,
    { previous, instances, changed, ownedIds, requiresRoutingRebuild, publicationPending }: ChainCommit,
  ) => {
    const ctx = options.getAudioContext()

    if (!ctx) return { settled: false, inPlace: false }
    const rebuild = requiresRoutingRebuild || publicationPending

    const inPlace = previous !== undefined && ownedIds.size === 0 && !rebuild &&
      !changed.some((instance) => instance.kind === 'spectral') &&
      getEffectChainTiming(previous, ctx.sampleRate, currentBpm).latencyFrames ===
        getEffectChainTiming(instances, ctx.sampleRate, currentBpm).latencyFrames

    if (!inPlace) publishGraphLatency()
    const nodes = inputs.has(trackId) && gains.has(trackId) ? ensureTrackNodes(trackId) : null

    if (rebuild && nodes) {
      rebuildTrackRouting(trackId, nodes)
    } else if (!routingTransitionOwners.get(trackId)?.pending()) {
      drainRetiredTrackResources(trackId)
    }

    if (inPlace) return { settled: true, inPlace }
    applyAuxiliaryRoutes()

    if (instances.some((instance) => instance.kind === 'spectral')) refreshMixerRouting()

    return { settled: true, inPlace }
  }

  const runTrackFxInstances = async (trackId: string, instances: AudioEffectRuntimeInstance[], ctx: AudioContext) => (
    await createEffectChainTransaction({
      owner: `track:${trackId}`,
      budget: options.workletBudget,
      bpm: () => currentBpm,
      eqChannelCount: () => options.getDestination()?.maxChannelCount ?? ctx.destination.maxChannelCount ?? 2,
      faultGeneration: options.getFaultGeneration,
      reportFault: (generation, kind, code, context) => options.onWorkletFault?.(generation, kind, code, context),
      installed: () => trackChainInstances.get(trackId),
      install: (installed) => {
        trackChainInstances.set(trackId, installed)
        trackFxInstances.set(trackId, installed)
        trackFx.set(trackId, { instances: installed })
      },
      resources: () => currentTrackResources(trackId),
      publishResources: (resources) => publishTrackResources(trackId, resources),
      retire: (resources, ids) => {
        const retired = retiredTrackResources.get(trackId) ?? []
        retired.push({ resources, ids })
        retiredTrackResources.set(trackId, retired)
      },
      liveParams: () => ensureNestedMap(liveParams, trackId),
      revision: () => trackFxInstanceRevisions.get(trackId),
      bumpRevision: () => {
        const revision = (trackFxInstanceRevisions.get(trackId) ?? 0) + 1
        trackFxInstanceRevisions.set(trackId, revision)

        return revision
      },
      publicationPending: () => unfinishedGraphPublications.has(trackId),
      beginPublication: () => { unfinishedGraphPublications.add(trackId) },
      finishPublication: () => { unfinishedGraphPublications.delete(trackId) },
      bypassStaticWorklet: (instanceId, chain) => bypassStaticWorklet(trackId, instanceId, chain),
      bindStaticWorkletMeter: (instanceId, chain) => bindGateMeter(trackId, instanceId, chain),
      bindCompressorMeter: (instanceId, state) => bindCompressorMeter(trackId, instanceId, state),
      route: (commit) => settleTrackGraph(trackId, commit),
    }).apply(ctx, instances)
  ).disposition

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
      createRetirementSource: () => ctx.createConstantSource(),
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
          ...resolveEqAutomationBindings(instanceEqChains.get(trackId)?.get(effectInstanceId)?.nodesByBand() ?? new Map(), parameterId),
          ...resolveSaturatorAutomationBindings(instanceSaturatorChains.get(trackId)?.get(effectInstanceId), parameterId),
          ...resolveDelayAutomationBindings(instanceDelayChains.get(trackId)?.get(effectInstanceId), parameterId),
          ...resolveReverbAutomationBindings(instanceReverbChains.get(trackId)?.get(effectInstanceId), parameterId),
          ...resolveStaticWorkletAutomationBinding(instanceStaticWorkletChains.get(trackId)?.get(effectInstanceId), parameterId),
        ]
      }

      const eqInstances = instanceEqChains.get(trackId) ?? new Map()
      const saturatorInstances = instanceSaturatorChains.get(trackId) ?? new Map()
      const delayInstances = instanceDelayChains.get(trackId) ?? new Map()
      const reverbInstances = instanceReverbChains.get(trackId) ?? new Map()
      const eqNodes = new Map<string, BiquadFilterNode>()

      for (const state of eqInstances.size === 1 ? eqInstances.values() : []) {
        for (const [bandId, node] of state.nodesByBand()) eqNodes.set(bandId, node)
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
