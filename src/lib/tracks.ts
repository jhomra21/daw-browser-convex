import type { Accessor, Setter } from 'solid-js'

import { buildTrackCreateHistoryEntry } from '~/lib/undo/builders'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Clip, Track } from '~/types/timeline'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type CreateLocalTrackOptions = {
  id: string
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
  outputTargetId?: string
}

type EnsureLocalTrackOptions = Omit<CreateLocalTrackOptions, 'index'> & {
  index?: number
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
}

type CreateOptimisticTrackOptions = Omit<CreateLocalTrackOptions, 'id' | 'index'> & {
  index?: number
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  roomId: string
  userId: string
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
  grantWrite?: (trackId: string) => void
}

type HistoryPush = (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void

type CreateOptimisticTrackWithHistoryOptions = CreateOptimisticTrackOptions & {
  historyPush?: HistoryPush
}

export function createLocalTrack(options: CreateLocalTrackOptions): Track {
  const track: Track = {
    id: options.id,
    historyRef: options.historyRef ?? options.id,
    name: options.name ?? `Track ${options.index + 1}`,
    volume: Number.isFinite(options.volume) ? (options.volume as number) : 0.8,
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
  const existing = options.tracks().find((track) => track.id === options.id)
  if (existing) return existing

  let index = options.index
  if (index === undefined) {
    index = options.tracks().length
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

  options.setTracks((current) => {
    if (current.some((track) => track.id === options.id)) return current
    if (index >= current.length) return [...current, next]
    return [...current.slice(0, index), next, ...current.slice(index)]
  })
  return next
}

export async function createOptimisticTrack(options: CreateOptimisticTrackOptions): Promise<Track | null> {
  const payload: Record<string, unknown> = {
    roomId: options.roomId as any,
    userId: options.userId as any,
    kind: options.kind,
    channelRole: options.channelRole,
  }
  if (options.index !== undefined) {
    payload.index = options.index
  }
  const trackId = await options.convexClient.mutation(options.convexApi.tracks.create, payload as any) as any as string
  if (!trackId) return null

  options.grantWrite?.(trackId)

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
    tracks: options.tracks,
    setTracks: options.setTracks,
  })
}

export function pushTrackCreateHistory(
  historyPush: HistoryPush | undefined,
  roomId: string | undefined,
  tracks: Track[],
  track: Pick<Track, 'id' | 'kind' | 'channelRole'> | null | undefined,
) {
  if (!track || !roomId || typeof historyPush !== 'function') return
  const index = tracks.findIndex((entry) => entry.id === track.id)

  historyPush(buildTrackCreateHistoryEntry({
    roomId,
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
  pushTrackCreateHistory(options.historyPush, options.roomId, options.tracks(), track)
  return track
}
