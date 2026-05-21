import type { Accessor } from 'solid-js'

import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { buildTrackCreateMutationInput } from '~/lib/track-mutation-args'
import { buildTrackCreateHistoryEntry } from '~/lib/undo/builders'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Clip, Track } from '~/types/timeline'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type CreateLocalTrackOptions = {
  id: Track['id']
  historyRef?: string
  index: number
  name?: string
  kind?: Track['kind']
  channelRole?: Track['channelRole']
  volume?: number
  muted?: boolean
  soloed?: boolean
  lockedBy?: string | null
  clips?: Clip[]
  sends?: Track['sends']
  outputTargetId?: Track['id']
}

type EnsureLocalTrackOptions = Omit<CreateLocalTrackOptions, 'index'> & {
  index?: number
  insertLocalTrack: (track: Track, index: number) => void
}

type CreateOptimisticTrackOptions = Omit<CreateLocalTrackOptions, 'id' | 'index'> & {
  index?: number
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  projectId: string
  userId: string
  insertLocalTrack: (track: Track, index: number) => void
  grantWrite?: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
  grantScope?: OptimisticGrantScope
}

type HistoryPush = (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void

type CreateOptimisticTrackWithHistoryOptions = CreateOptimisticTrackOptions & {
  tracks: Accessor<Track[]>
  historyPush?: HistoryPush
}

export function createLocalTrack(options: CreateLocalTrackOptions): Track {
  const track: Track = {
    id: options.id,
    historyRef: options.historyRef ?? options.id,
    name: options.name ?? `Track ${options.index + 1}`,
    volume: typeof options.volume === 'number' && Number.isFinite(options.volume) ? options.volume : 0.8,
    clips: options.clips ?? [],
    muted: options.muted ?? false,
    soloed: options.soloed ?? false,
    kind: options.kind ?? 'audio',
    channelRole: options.channelRole ?? 'track',
    sends: options.sends ?? [],
    outputTargetId: options.outputTargetId,
  }
  if (options.lockedBy !== undefined) {
    track.lockedBy = options.lockedBy
  }
  return track
}

function ensureLocalTrack(options: EnsureLocalTrackOptions): Track {
  let index = options.index
  if (index === undefined) {
    index = 0
  }
  const next = createLocalTrack({
    id: options.id,
    historyRef: options.historyRef,
    index,
    name: options.name,
    kind: options.kind,
    channelRole: options.channelRole,
    volume: options.volume,
    muted: options.muted,
    soloed: options.soloed,
    lockedBy: options.lockedBy,
    clips: options.clips,
    sends: options.sends,
    outputTargetId: options.outputTargetId,
  })
  options.insertLocalTrack(next, index)
  return next
}

export async function createOptimisticTrack(options: CreateOptimisticTrackOptions): Promise<Track | null> {
  const payload = buildTrackCreateMutationInput({
    projectId: options.projectId,
    userId: options.userId,
    index: options.index,
    kind: options.kind,
    channelRole: options.channelRole,
  })
  const trackId = await options.convexClient.mutation(options.convexApi.tracks.create, payload)
  if (!trackId) return null

  options.grantWrite?.(trackId, options.grantScope)

  return ensureLocalTrack({
    id: trackId,
    historyRef: options.historyRef,
    index: options.index,
    name: options.name,
    kind: options.kind,
    channelRole: options.channelRole,
    volume: options.volume,
    muted: options.muted,
    soloed: options.soloed,
    lockedBy: options.lockedBy,
    clips: options.clips,
    sends: options.sends,
    outputTargetId: options.outputTargetId,
    insertLocalTrack: options.insertLocalTrack,
  })
}

export function pushTrackCreateHistory(
  historyPush: HistoryPush | undefined,
  projectId: string | undefined,
  tracks: Track[],
  track: Pick<Track, 'id' | 'kind' | 'channelRole'> | null | undefined,
) {
  if (!track || !projectId || typeof historyPush !== 'function') return
  const index = tracks.findIndex((entry) => entry.id === track.id)

  historyPush(buildTrackCreateHistoryEntry({
    projectId,
    trackId: track.id,
    index,
    kind: track.kind,
    channelRole: track.channelRole,
  }))
}

export async function createOptimisticTrackWithHistory(
  options: CreateOptimisticTrackWithHistoryOptions,
): Promise<Track | null> {
  const track = await createOptimisticTrack(options)
  pushTrackCreateHistory(options.historyPush, options.projectId, options.tracks(), track)
  return track
}
