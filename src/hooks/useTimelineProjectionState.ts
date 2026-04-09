import type { FunctionReturnType } from 'convex/server'
import { createEffect, createSignal, on, type Accessor } from 'solid-js'

import { convexApi } from '~/lib/convex'
import {
  buildServerTimelineIndex,
  isClipPatchReflected,
  type ClipTimelinePatch,
  type PendingTrackEntry,
} from '~/lib/resolve-timeline-tracks'
import type { Track } from '~/types/timeline'

type FullTimelineView = FunctionReturnType<typeof convexApi.timeline.fullView>

type FullTimelineViewLike<TTrackId extends string = Track['id']> = {
  tracks: Array<{ _id: TTrackId; lockedBy?: string | null }>
  clips: Array<{ _id: string; trackId: TTrackId; startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number }>
}

type PendingClipCreate<TTrackId extends string = Track['id']> = { trackId: TTrackId; clip: Track['clips'][number] }

type TimelineProjectionSnapshot<TTrackId extends string = Track['id']> = {
  committedClipEditsById: Map<string, ClipTimelinePatch<TTrackId>>
  pendingTrackEntriesById: Map<TTrackId, PendingTrackEntry<TTrackId>>
  pendingClipCreatesById: Map<string, PendingClipCreate<TTrackId>>
  removedTrackIds: Set<TTrackId>
  removedClipIds: Set<string>
  pendingTrackLocksById: Map<TTrackId, string | null>
}

type UseTimelineProjectionStateOptions = {
  roomId: Accessor<string>
  serverData: Accessor<FullTimelineView | undefined>
  rememberTrackProjection: (track: Pick<Track, 'id' | 'historyRef' | 'name'> | null | undefined) => void
  rememberClipHistoryRef: (clip: Pick<Track['clips'][number], 'id' | 'historyRef'> | null | undefined) => void
}

type UseTimelineProjectionStateReturn = {
  pendingTrackEntriesById: Accessor<Map<Track['id'], PendingTrackEntry>>
  pendingClipCreatesById: Accessor<Map<string, PendingClipCreate>>
  removedTrackIds: Accessor<Set<Track['id']>>
  removedClipIds: Accessor<Set<string>>
  pendingTrackLocksById: Accessor<Map<Track['id'], string | null>>
  committedClipEditsById: Accessor<Map<string, ClipTimelinePatch>>
  draftClipEditsById: Accessor<Map<string, ClipTimelinePatch>>
  previewClipsByTrackId: Accessor<Map<Track['id'], Track['clips']>>
  insertLocalTrack: (track: Track, index: number) => void
  insertLocalClip: (trackId: Track['id'], clip: Track['clips'][number]) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  removeLocalTrack: (trackId: Track['id']) => void
  setDraftClipTiming: (clipId: string, patch: ClipTimelinePatch | null) => void
  commitClipTiming: (clipId: string, patch: { startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number }) => void
  replaceDraftClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
  clearDraftClipMoves: (clipIds: Iterable<string>) => void
  commitClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
  setPreviewClipsByTrackId: (value: Map<Track['id'], Track['clips']>) => void
  setTrackLock: (trackId: Track['id'], lockedBy: string | null) => void
  clearTrackLock: (trackId: Track['id']) => void
}

function reconcileTimelineProjectionSnapshot<TTrackId extends string>(
  current: TimelineProjectionSnapshot<TTrackId>,
  data: FullTimelineViewLike<TTrackId>,
): TimelineProjectionSnapshot<TTrackId> {
  const serverIndex = buildServerTimelineIndex(data)

  const committedClipEditsById = (() => {
    let next: Map<string, ClipTimelinePatch<TTrackId>> | null = null
    for (const [clipId, patch] of current.committedClipEditsById) {
      const serverClip = serverIndex.clipRowsById.get(clipId)
      if (!serverClip) continue
      if (!isClipPatchReflected(patch, serverClip)) continue
      if (!next) next = new Map(current.committedClipEditsById)
      next.delete(clipId)
    }
    return next ?? current.committedClipEditsById
  })()

  const pendingTrackEntriesById = (() => {
    let next: Map<TTrackId, PendingTrackEntry<TTrackId>> | null = null
    for (const [trackId] of current.pendingTrackEntriesById) {
      if (!serverIndex.trackIds.has(trackId)) continue
      if (!next) next = new Map(current.pendingTrackEntriesById)
      next.delete(trackId)
    }
    return next ?? current.pendingTrackEntriesById
  })()

  const pendingClipCreatesById = (() => {
    let next: Map<string, PendingClipCreate<TTrackId>> | null = null
    for (const [clipId] of current.pendingClipCreatesById) {
      if (!serverIndex.clipIds.has(clipId)) continue
      if (!next) next = new Map(current.pendingClipCreatesById)
      next.delete(clipId)
    }
    return next ?? current.pendingClipCreatesById
  })()

  const removedTrackIds = (() => {
    const next = new Set<TTrackId>(Array.from(current.removedTrackIds).filter((trackId) => serverIndex.trackIds.has(trackId)))
    return next.size === current.removedTrackIds.size ? current.removedTrackIds : next
  })()

  const removedClipIds = (() => {
    const next = new Set(Array.from(current.removedClipIds).filter((clipId) => serverIndex.clipIds.has(clipId)))
    return next.size === current.removedClipIds.size ? current.removedClipIds : next
  })()

  const pendingTrackLocksById = (() => {
    let next: Map<TTrackId, string | null> | null = null
    for (const [trackId, lockedBy] of current.pendingTrackLocksById) {
      if (serverIndex.trackLocksById.get(trackId) !== lockedBy) continue
      if (!next) next = new Map(current.pendingTrackLocksById)
      next.delete(trackId)
    }
    return next ?? current.pendingTrackLocksById
  })()

  return {
    committedClipEditsById,
    pendingTrackEntriesById,
    pendingClipCreatesById,
    removedTrackIds,
    removedClipIds,
    pendingTrackLocksById,
  }
}

function collectTrackClipIds(options: {
  trackId: Track['id']
  serverData: FullTimelineView | undefined
  pendingClipCreatesById: Map<string, PendingClipCreate>
  removedClipIds: Set<string>
  committedClipEditsById: Map<string, ClipTimelinePatch>
  draftClipEditsById: Map<string, ClipTimelinePatch>
}): Set<string> {
  const clipIds = new Set<string>()

  const assignClipTrack = (clipId: string, trackId: Track['id']) => {
    if (trackId === options.trackId) {
      clipIds.add(clipId)
    } else {
      clipIds.delete(clipId)
    }
  }

  if (options.serverData) {
    for (const clip of options.serverData.clips) {
      const clipId = String(clip._id)
      if (options.removedClipIds.has(clipId)) continue
      assignClipTrack(clipId, clip.trackId)
    }
  }

  for (const [clipId, pending] of options.pendingClipCreatesById) {
    if (options.removedClipIds.has(clipId)) continue
    assignClipTrack(clipId, pending.trackId)
  }

  const applyPatchMap = (patches: Map<string, ClipTimelinePatch>) => {
    for (const [clipId, patch] of patches) {
      if (options.removedClipIds.has(clipId) || patch.trackId === undefined) continue
      assignClipTrack(clipId, patch.trackId)
    }
  }

  applyPatchMap(options.committedClipEditsById)
  applyPatchMap(options.draftClipEditsById)

  return clipIds
}

export function useTimelineProjectionState(
  options: UseTimelineProjectionStateOptions,
): UseTimelineProjectionStateReturn {
  const [pendingTrackEntriesById, setPendingTrackEntriesById] = createSignal<Map<Track['id'], PendingTrackEntry>>(new Map())
  const [pendingClipCreatesById, setPendingClipCreatesById] = createSignal<Map<string, PendingClipCreate>>(new Map())
  const [removedTrackIds, setRemovedTrackIds] = createSignal<Set<Track['id']>>(new Set())
  const [removedClipIds, setRemovedClipIds] = createSignal<Set<string>>(new Set<string>())
  const [pendingTrackLocksById, setPendingTrackLocksById] = createSignal<Map<Track['id'], string | null>>(new Map())
  const [committedClipEditsById, setCommittedClipEditsById] = createSignal<Map<string, ClipTimelinePatch>>(new Map())
  const [draftClipEditsById, setDraftClipEditsById] = createSignal<Map<string, ClipTimelinePatch>>(new Map())
  const [previewClipsByTrackId, setPreviewClipsByTrackId] = createSignal<Map<Track['id'], Track['clips']>>(new Map())

  createEffect(on(options.roomId, () => {
    setPendingTrackEntriesById(new Map())
    setPendingClipCreatesById(new Map())
    setRemovedTrackIds(new Set<Track['id']>())
    setRemovedClipIds(new Set<string>())
    setPendingTrackLocksById(new Map())
    setCommittedClipEditsById(new Map<string, ClipTimelinePatch>())
    setDraftClipEditsById(new Map<string, ClipTimelinePatch>())
    setPreviewClipsByTrackId(new Map())
  }))

  createEffect(() => {
    const data = options.serverData()
    if (!data) return
    const next = reconcileTimelineProjectionSnapshot({
      committedClipEditsById: committedClipEditsById(),
      pendingTrackEntriesById: pendingTrackEntriesById(),
      pendingClipCreatesById: pendingClipCreatesById(),
      removedTrackIds: removedTrackIds(),
      removedClipIds: removedClipIds(),
      pendingTrackLocksById: pendingTrackLocksById(),
    }, data)
    setCommittedClipEditsById(next.committedClipEditsById)
    setPendingTrackEntriesById(next.pendingTrackEntriesById)
    setPendingClipCreatesById(next.pendingClipCreatesById)
    setRemovedTrackIds(next.removedTrackIds)
    setRemovedClipIds(next.removedClipIds)
    setPendingTrackLocksById(next.pendingTrackLocksById)
  })

  const clearDraftClipMoves = (clipIds: Iterable<string>) => {
    const targetIds = new Set(clipIds)
    setDraftClipEditsById((current) => {
      let next: Map<string, ClipTimelinePatch> | null = null
      for (const clipId of targetIds) {
        const patch = current.get(clipId)
        if (!patch) continue
        const remaining: ClipTimelinePatch = { ...patch }
        delete remaining.trackId
        delete remaining.startSec
        const hasRemainingFields = remaining.duration !== undefined
          || remaining.leftPadSec !== undefined
          || remaining.bufferOffsetSec !== undefined
          || remaining.midiOffsetBeats !== undefined
        if (!next) next = new Map(current)
        if (hasRemainingFields) {
          next.set(clipId, remaining)
        } else {
          next.delete(clipId)
        }
      }
      return next ?? current
    })
  }

  const removeLocalClips = (clipIds: Iterable<string>) => {
    const removed = new Set(clipIds)
    if (removed.size === 0) return
    setPendingClipCreatesById((current) => {
      let next: Map<string, PendingClipCreate> | null = null
      for (const clipId of removed) {
        if (!current.has(clipId)) continue
        if (!next) next = new Map(current)
        next.delete(clipId)
      }
      return next ?? current
    })
    setRemovedClipIds((current) => {
      const next = new Set(current)
      for (const clipId of removed) next.add(clipId)
      return next
    })
    clearDraftClipMoves(removed)
    setCommittedClipEditsById((current) => {
      let next: Map<string, ClipTimelinePatch> | null = null
      for (const clipId of removed) {
        if (!current.has(clipId)) continue
        if (!next) next = new Map(current)
        next.delete(clipId)
      }
      return next ?? current
    })
  }

  return {
    pendingTrackEntriesById,
    pendingClipCreatesById,
    removedTrackIds,
    removedClipIds,
    pendingTrackLocksById,
    committedClipEditsById,
    draftClipEditsById,
    previewClipsByTrackId,
    insertLocalTrack: (track, index) => {
      options.rememberTrackProjection(track)
      setRemovedTrackIds((current) => {
        if (!current.has(track.id)) return current
        const next = new Set(current)
        next.delete(track.id)
        return next
      })
      setPendingTrackEntriesById((current) => {
        const next = new Map(current)
        next.set(track.id, { index, track })
        return next
      })
    },
    insertLocalClip: (trackId, clip) => {
      options.rememberClipHistoryRef(clip)
      setRemovedClipIds((current) => {
        if (!current.has(clip.id)) return current
        const next = new Set(current)
        next.delete(clip.id)
        return next
      })
      setPendingClipCreatesById((current) => {
        const next = new Map(current)
        next.set(clip.id, { trackId, clip })
        return next
      })
    },
    removeLocalClips,
    removeLocalTrack: (trackId) => {
      const clipIds = collectTrackClipIds({
        trackId,
        serverData: options.serverData(),
        pendingClipCreatesById: pendingClipCreatesById(),
        removedClipIds: removedClipIds(),
        committedClipEditsById: committedClipEditsById(),
        draftClipEditsById: draftClipEditsById(),
      })
      setPendingTrackEntriesById((current) => {
        if (!current.has(trackId)) return current
        const next = new Map(current)
        next.delete(trackId)
        return next
      })
      setRemovedTrackIds((current) => {
        const next = new Set(current)
        next.add(trackId)
        return next
      })
      if (clipIds.size > 0) {
        removeLocalClips(clipIds)
      }
    },
    setDraftClipTiming: (clipId, patch) => {
      setDraftClipEditsById((current) => {
        const next = new Map(current)
        if (!patch) {
          next.delete(clipId)
          return next
        }
        next.set(clipId, patch)
        return next
      })
    },
    commitClipTiming: (clipId, patch) => {
      setDraftClipEditsById((current) => {
        if (!current.has(clipId)) return current
        const next = new Map(current)
        next.delete(clipId)
        return next
      })
      setCommittedClipEditsById((current) => {
        const next = new Map(current)
        next.set(clipId, patch)
        return next
      })
    },
    replaceDraftClipMoves: (moves) => {
      const moveIds = new Set(moves.map((move) => move.clipId))
      setDraftClipEditsById((current) => {
        const next = new Map(current)
        for (const [clipId, patch] of current) {
          if (!moveIds.has(clipId)) continue
          if (patch.duration !== undefined || patch.leftPadSec !== undefined || patch.bufferOffsetSec !== undefined || patch.midiOffsetBeats !== undefined) continue
          next.delete(clipId)
        }
        for (const move of moves) {
          const previous = current.get(move.clipId)
          next.set(move.clipId, {
            ...previous,
            trackId: move.trackId,
            startSec: move.startSec,
          })
        }
        return next
      })
    },
    clearDraftClipMoves,
    commitClipMoves: (moves) => {
      clearDraftClipMoves(moves.map((move) => move.clipId))
      setCommittedClipEditsById((current) => {
        const next = new Map(current)
        for (const move of moves) {
          const previous = current.get(move.clipId)
          next.set(move.clipId, {
            ...previous,
            trackId: move.trackId,
            startSec: move.startSec,
          })
        }
        return next
      })
    },
    setPreviewClipsByTrackId: setPreviewClipsByTrackId,
    setTrackLock: (trackId, lockedBy) => {
      setPendingTrackLocksById((current) => {
        const next = new Map(current)
        next.set(trackId, lockedBy)
        return next
      })
    },
    clearTrackLock: (trackId) => {
      setPendingTrackLocksById((current) => {
        if (!current.has(trackId)) return current
        const next = new Map(current)
        next.delete(trackId)
        return next
      })
    },
  }
}
