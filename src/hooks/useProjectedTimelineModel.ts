import { createEffect, createMemo, createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { FunctionReturnType } from 'convex/server'

import { convexApi, useConvexQuery } from '~/lib/convex'
import {
  buildOptimisticGrantScopeKey,
  isOptimisticGrantScopeCurrent,
  type OptimisticGrantScope,
} from '~/lib/optimistic-grant-scope'
import type { PendingTrackEntry } from '~/lib/resolve-timeline-tracks'
import type { Track, TrackRouting, TrackSend } from '~/types/timeline'

type ProjectedTimelineRouting = TrackRouting & { sends: TrackSend[] }
type OptimisticGrantState = 'pending' | 'seen'

type PendingClipCreate = { trackId: Track['id']; clip: Track['clips'][number] }

type UseProjectedTimelineModelOptions = {
  roomId: Accessor<string>
  userId: Accessor<string>
  fullViewData: Accessor<FunctionReturnType<typeof convexApi.timeline.fullView> | undefined>
  pendingTrackEntriesById: Accessor<Map<Track['id'], PendingTrackEntry>>
  pendingClipCreatesById: Accessor<Map<string, PendingClipCreate>>
  removedTrackIds: Accessor<Set<Track['id']>>
  removedClipIds: Accessor<Set<string>>
}

type UseProjectedTimelineModelReturn = {
  writableTrackIds: Accessor<Set<Track['id']>>
  writableClipIds: Accessor<Set<string>>
  optimisticTrackIds: Accessor<Set<Track['id']>>
  canWriteTrack: (trackId: Track['id']) => boolean
  canWriteClip: (clipId: string) => boolean
  grantTrackWrite: (trackId: Track['id'] | null | undefined, scope?: OptimisticGrantScope | null) => void
  grantClipWrite: (clipId: string | null | undefined, scope?: OptimisticGrantScope | null) => void
  grantClipWrites: (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => void
  serverTrackState: Accessor<{
    serverVolumes: Map<Track['id'], number>
    serverMuted: Map<Track['id'], boolean>
    serverSoloed: Map<Track['id'], boolean>
    serverRouting: Map<Track['id'], ProjectedTimelineRouting>
  } | null>
}

const addIdsToMap = <TId extends string>(current: Map<TId, OptimisticGrantState>, ids: Iterable<TId>) => {
  let next: Map<TId, OptimisticGrantState> | null = null
  for (const id of ids) {
    if (!id) continue
    const existing = (next ?? current).get(id)
    if (existing) continue
    if (!next) next = new Map(current)
    next.set(id, 'pending')
  }
  return next ?? current
}

const mergeIdSets = <TId extends string>(serverIds: Set<TId>, optimisticIds: Iterable<TId>) => {
  const merged = new Set(serverIds)
  for (const id of optimisticIds) {
    merged.add(id)
  }
  return merged
}

const reconcileOptimisticGrants = <TId extends string>(
  current: Map<TId, OptimisticGrantState>,
  existingIds: Set<TId>,
  serverIds: Set<TId>,
) => {
  let next: Map<TId, OptimisticGrantState> | null = null
  for (const [id, state] of current) {
    if (serverIds.has(id)) {
      if (!next) next = new Map(current)
      next.delete(id)
      continue
    }
    if (state === 'pending' && existingIds.has(id)) {
      if (!next) next = new Map(current)
      next.set(id, 'seen')
      continue
    }
    if (state === 'seen' && !existingIds.has(id)) {
      if (!next) next = new Map(current)
      next.delete(id)
    }
  }
  if (!next) return current
  if (next.size === current.size) {
    let unchanged = true
    for (const [id, state] of next) {
      if (current.get(id) !== state) {
        unchanged = false
        break
      }
    }
    if (unchanged) return current
  }
  return next
}

export function useProjectedTimelineModel(
  options: UseProjectedTimelineModelOptions,
): UseProjectedTimelineModelReturn {
  const [optimisticTrackWriteIds, setOptimisticTrackWriteIds] = createSignal<Map<Track['id'], OptimisticGrantState>>(new Map())
  const [optimisticClipWriteIds, setOptimisticClipWriteIds] = createSignal<Map<string, OptimisticGrantState>>(new Map<string, OptimisticGrantState>())

  const ownedTracksQ = useConvexQuery(
    convexApi.ownerships.listOwnedTrackIds,
    () => {
      const roomId = options.roomId()
      const userId = options.userId()
      return roomId && userId ? { roomId, ownerUserId: userId } : null
    },
    () => ['owned-tracks', options.roomId(), options.userId()],
  )

  const ownedTrackIds = createMemo(() => {
    return new Set<Track['id']>(ownedTracksQ.data ?? [])
  })

  const ownedClipsQ = useConvexQuery(
    convexApi.ownerships.listOwnedClipIds,
    () => {
      const roomId = options.roomId()
      const userId = options.userId()
      return roomId && userId ? { roomId, ownerUserId: userId } : null
    },
    () => ['owned-clips', options.roomId(), options.userId()],
  )

  const ownedClipIds = createMemo(() => {
    return new Set<string>((ownedClipsQ.data ?? []).map((value: string) => String(value)))
  })

  const existingTrackIds = createMemo(() => {
    const trackIds = new Set<Track['id']>()
    const data = options.fullViewData()
    if (data) {
      for (const track of data.tracks) {
        if (!options.removedTrackIds().has(track._id)) {
          trackIds.add(track._id)
        }
      }
    }
    for (const [trackId] of options.pendingTrackEntriesById()) {
      trackIds.add(trackId)
    }
    return trackIds
  })

  const existingClipIds = createMemo(() => {
    const clipIds = new Set<string>()
    const data = options.fullViewData()
    if (data) {
      for (const clip of data.clips) {
        const clipId = String(clip._id)
        if (!options.removedClipIds().has(clipId)) {
          clipIds.add(clipId)
        }
      }
    }
    for (const [clipId] of options.pendingClipCreatesById()) {
      clipIds.add(clipId)
    }
    return clipIds
  })

  const writableTrackIds = createMemo(() => {
    const optimistic = optimisticTrackWriteIds()
    return optimistic.size === 0 ? ownedTrackIds() : mergeIdSets(ownedTrackIds(), optimistic.keys())
  })
  const writableClipIds = createMemo(() => {
    const optimistic = optimisticClipWriteIds()
    return optimistic.size === 0 ? ownedClipIds() : mergeIdSets(ownedClipIds(), optimistic.keys())
  })
  const optimisticTrackIds = createMemo(() => new Set<Track['id']>(optimisticTrackWriteIds().keys()))
  const currentGrantScopeKey = createMemo(() => buildOptimisticGrantScopeKey({
    roomId: options.roomId(),
    userId: options.userId(),
  }))

  const grantTrackWrite = (trackId: Track['id'] | null | undefined, scope?: OptimisticGrantScope | null) => {
    if (!trackId || !isOptimisticGrantScopeCurrent(currentGrantScopeKey(), scope)) return
    setOptimisticTrackWriteIds((current) => addIdsToMap(current, [trackId]))
  }

  const grantClipWrite = (clipId: string | null | undefined, scope?: OptimisticGrantScope | null) => {
    if (!clipId || !isOptimisticGrantScopeCurrent(currentGrantScopeKey(), scope)) return
    setOptimisticClipWriteIds((current) => addIdsToMap(current, [clipId]))
  }

  const grantClipWrites = (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => {
    if (!isOptimisticGrantScopeCurrent(currentGrantScopeKey(), scope)) return
    setOptimisticClipWriteIds((current) => addIdsToMap(current, clipIds))
  }

  createEffect(() => {
    currentGrantScopeKey()
    setOptimisticTrackWriteIds(new Map())
    setOptimisticClipWriteIds(new Map<string, OptimisticGrantState>())
  })

  createEffect(() => {
    setOptimisticTrackWriteIds((current) => reconcileOptimisticGrants(current, existingTrackIds(), ownedTrackIds()))
  })

  createEffect(() => {
    setOptimisticClipWriteIds((current) => reconcileOptimisticGrants(current, existingClipIds(), ownedClipIds()))
  })

  const serverTrackState = createMemo(() => {
    const data = options.fullViewData()
    if (!data) return null
    const serverVolumes = new Map<Track['id'], number>()
    const serverMuted = new Map<Track['id'], boolean>()
    const serverSoloed = new Map<Track['id'], boolean>()
    const serverRouting = new Map<Track['id'], ProjectedTimelineRouting>()

    for (const track of data.tracks) {
      if (track.volume === undefined) {
        throw new Error(`Missing mixer channel volume for track ${String(track._id)}`)
      }
      if (track.sends === undefined) {
        throw new Error(`Missing mixer channel sends for track ${String(track._id)}`)
      }
      serverVolumes.set(track._id, track.volume)
      if (typeof track.muted === 'boolean') {
        serverMuted.set(track._id, track.muted)
      }
      if (typeof track.soloed === 'boolean') {
        serverSoloed.set(track._id, track.soloed)
      }
      serverRouting.set(track._id, {
        outputTargetId: track.outputTargetId,
        sends: track.sends.map((send) => {
          if (!send?.targetId) {
            throw new Error(`Missing mixer send target for track ${String(track._id)}`)
          }
          const amount = Number(send.amount)
          if (!Number.isFinite(amount)) {
            throw new Error(`Invalid mixer send amount for track ${String(track._id)}`)
          }
          return { targetId: send.targetId, amount }
        }),
      })
    }

    return {
      serverVolumes,
      serverMuted,
      serverSoloed,
      serverRouting,
    }
  })

  return {
    writableTrackIds,
    writableClipIds,
    optimisticTrackIds,
    canWriteTrack: (trackId) => writableTrackIds().has(trackId),
    canWriteClip: (clipId) => writableClipIds().has(clipId),
    grantTrackWrite,
    grantClipWrite,
    grantClipWrites,
    serverTrackState,
  }
}
