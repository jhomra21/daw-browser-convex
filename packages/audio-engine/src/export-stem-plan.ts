import { assert, type AutomationEnvelope, assertDefined, isNonlinearKind } from '@daw-browser/shared'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import type { ResolvedMixerGraph } from './mixer/types'

export type StemMode =
  | 'dry-source'
  | 'post-track-fx'
  | 'reachable-routing'
  | 'channel-output'
  | 'full-master-contribution'

export type StemDefinition = {
  id: string
  name: string
  mode: StemMode
  targetTrackId: string
}

export type StemRecombinationMetadata = {
  recombinesToMaster: boolean
  conditions: readonly string[]
}

export type SourceIsolatedRenderOptions = {
  sourceTrackIds?: ReadonlySet<string>
  detectorOnlyTrackIds?: ReadonlySet<string>
  includeMasterFx?: boolean
  graph?: ResolvedMixerGraph
}

export type SourceAutomationScope = {
  trackIds?: ReadonlySet<string>
  includeMasterFx: boolean
}

export function isAutomationEnvelopeInSourceScope(
  scope: SourceAutomationScope,
  envelope: AutomationEnvelope,
): boolean {
  if (scope.trackIds && envelope.target.kind === 'track' && !scope.trackIds.has(envelope.target.trackId)) return false

  if (!scope.includeMasterFx && envelope.target.kind === 'master' && envelope.parameterId !== 'volume') return false

  return true
}


function collectOutputPathChannelIds(
  channelId: string,
  outputTargetByChannelId: ReadonlyMap<string, string | undefined>,
): string[] {
  const path: string[] = []
  const visited = new Set<string>()
  let currentId: string | undefined = channelId

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    path.push(currentId)
    currentId = outputTargetByChannelId.get(currentId)
  }

  return path
}

export function createSourceAutomationScope(
  graph: ResolvedMixerGraph,
  options: SourceIsolatedRenderOptions,
): SourceAutomationScope {
  const { sourceTrackIds, includeMasterFx = true } = options

  if (!sourceTrackIds) return { includeMasterFx }

  const channelById = new Map(
    graph.channels.map((resolvedTrack) => [resolvedTrack.channel.id, resolvedTrack] as const),
  )

  const outputTargetByChannelId = new Map(
    graph.channels.map((resolvedTrack) => [resolvedTrack.channel.id, resolvedTrack.outputTargetId] as const),
  )

  const scopedTrackIds = new Set<string>()

  const addReachableChannel = (channelId: string, queue: string[]) => {
    if (!channelById.has(channelId) || scopedTrackIds.has(channelId)) return
    scopedTrackIds.add(channelId)
    queue.push(channelId)
  }

  const queue: string[] = []

  for (const sourceTrackId of sourceTrackIds) {
    addReachableChannel(sourceTrackId, queue)
  }

  for (let index = 0; index < queue.length; index += 1) {
    const channelId = queue[index]
    const channel = channelById.get(channelId)

    if (!channel) continue
    const outputPath = collectOutputPathChannelIds(channelId, outputTargetByChannelId)

    for (const pathChannelId of outputPath) addReachableChannel(pathChannelId, queue)

    for (const send of channel.sends) addReachableChannel(send.targetId, queue)
  }

  return { trackIds: scopedTrackIds, includeMasterFx }
}

const emptyMasterFx = (graph: ResolvedMixerGraph): ResolvedMixerGraph['master'] => ({
  volume: 1,
  instances: [],
  inputLayout: graph.master.inputLayout,
  outputLayout: graph.master.inputLayout,
})

const collectReachableChannelIds = (
  graph: ResolvedMixerGraph,
  sourceTrackIds: ReadonlySet<string>,
): Set<string> => new Set(createSourceAutomationScope(graph, {
  sourceTrackIds,
  includeMasterFx: false,
}).trackIds ?? [])

const collectUpstreamChannelIds = (
  graph: ResolvedMixerGraph,
  targetTrackId: string,
): Set<string> => {
  const upstream = new Set([targetTrackId])
  let changed = true

  while (changed) {
    changed = false

    for (const channel of graph.channels) {
      if (upstream.has(channel.channel.id)) continue

      if (channel.outputTargetId && upstream.has(channel.outputTargetId)) {
        upstream.add(channel.channel.id)
        changed = true
        continue
      }

      if (channel.sends.some((send) => upstream.has(send.targetId))) {
        upstream.add(channel.channel.id)
        changed = true
      }
    }
  }

  return upstream
}

export type StemRenderPlan = {
  sourceTrackIds: Set<string>
  detectorOnlyTrackIds: Set<string>
  graph: ResolvedMixerGraph
  metadata: StemRecombinationMetadata
}

export function createStemRenderPlan(
  graph: ResolvedMixerGraph,
  stem: StemDefinition,
  sidechainRoutes: readonly ExternalSidechainRoute[] = [],
): StemRenderPlan {
  const target = assertDefined(
    graph.channels.find((channel) => channel.channel.id === stem.targetTrackId),
    `Missing stem target ${stem.targetTrackId}`,
  )

  if (stem.mode === 'channel-output') {
    assert(target.channel.role === 'group' || target.channel.role === 'return', 'Channel-output stems require a group or return target.')
  } else {
    assert(target.channel.role === 'track', `${stem.mode} stems require a source track target.`)
  }

  const sourceTrackIds = stem.mode === 'channel-output'
    ? collectUpstreamChannelIds(graph, stem.targetTrackId)
    : new Set([stem.targetTrackId])

  const reachableIds = collectReachableChannelIds(graph, sourceTrackIds)
  const detectorOnlyTrackIds = new Set<string>()

  for (const route of sidechainRoutes) {
    if (reachableIds.has(route.targetTrackId) && !sourceTrackIds.has(route.sourceTrackId)) {
      detectorOnlyTrackIds.add(route.sourceTrackId)
    }
  }

  const graphForMode: ResolvedMixerGraph = {
    channels: graph.channels.map((channel) => {
      const id = channel.channel.id

      if (detectorOnlyTrackIds.has(id)) {
        return { ...channel, outputGain: 0, sends: [] }
      }

      if (stem.mode === 'dry-source') {
        const audible = !channel.channel.muted && channel.outputGain > 0

        return {
          ...channel,
          gain: id === stem.targetTrackId && audible ? 1 : 0,
          outputGain: id === stem.targetTrackId && audible ? 1 : 0,
          outputTargetId: undefined,
          sends: [],
          fx: undefined,
        }
      }

      if (stem.mode === 'post-track-fx') {
        return {
          ...channel,
          outputGain: id === stem.targetTrackId ? channel.outputGain : 0,
          outputTargetId: id === stem.targetTrackId ? undefined : channel.outputTargetId,
          sends: [],
        }
      }

      if (stem.mode === 'channel-output') {
        return {
          ...channel,
          outputGain: id === stem.targetTrackId ? channel.outputGain : channel.outputGain,
          outputTargetId: id === stem.targetTrackId ? undefined : channel.outputTargetId,
          sends: id === stem.targetTrackId ? [] : channel.sends,
        }
      }

      return channel
    }),
    master: stem.mode === 'full-master-contribution' ? graph.master : emptyMasterFx(graph),
  }

  const nonlinearMaster = graph.master.instances.some((instance) => isNonlinearKind(instance.kind))

  return {
    sourceTrackIds,
    detectorOnlyTrackIds,
    graph: graphForMode,
    metadata: {
      recombinesToMaster: stem.mode !== 'full-master-contribution' || !nonlinearMaster,
      conditions: stem.mode === 'full-master-contribution'
        ? nonlinearMaster
          ? ['Shared nonlinear master processing prevents linear stem recombination.']
          : ['Master processing must remain linear and stem normalization must be disabled.']
        : ['Export every required stem over the same range with normalization disabled.'],
    },
  }
}

