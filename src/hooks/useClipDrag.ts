import { createEffect, on, onCleanup, type Accessor } from 'solid-js'
import { assertDefined } from '@daw-browser/shared'

import type { convexApi, convexClient } from '~/lib/convex'
import { commitDuplicatedClipDrag, commitMovedClipDrag } from '~/lib/clip-drag-commit'
import { createClipDragPersistence } from '~/lib/clip-drag-persistence'
import {
  buildClipDragStart,
  buildDuplicateClipCreateItems,
  createDragTrackLookupCache,
  createDuplicatePreviews,
  draftMovesChanged,
  previousMovesFrom,
  readDragPointer,
} from '~/lib/clip-drag-session'
import {
  canPlaceClipOnTrack,
  planDuplicatedClipPlacements,
  resolveNonDupClipDragPlacement,
  resolveNonDupTargetTrackId,
  type MultiDragSnapshot,
} from '~/lib/clip-drag-placement'
import { useDrag } from '~/hooks/useDrag'
import type { ClipBuffers } from '~/lib/clip-buffer-cache'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { buildSharedClipCreateManyOperation, publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { TimelineTrackLayoutRow } from '~/lib/timeline-track-layout'
import type { Track, Clip, TrackId } from '@daw-browser/timeline-core/types'
import type { HistoryEntry } from '~/lib/undo/types'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type ClipDragHandlers = {
  onClipPointerDown: (trackId: Track['id'], clipId: string, event: PointerEvent) => void
  isDragging: () => boolean
}

const isString = (cause: unknown): cause is string => typeof cause === 'string'

type ClipDragOptions = {
  placementTracks: Accessor<Track[]>
  trackLayout: Accessor<TimelineTrackLayoutRow[]>
  resolvedTracks: Accessor<Track[]>
  defaultTrackCreateColor?: () => string | undefined
  insertLocalTrack: (track: Track, index: number) => void
  insertLocalClip: (trackId: Track['id'], clip: Clip) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  removeLocalTrack: (trackId: Track['id']) => void
  replaceDraftClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
  clearDraftClipMoves: (clipIds: Iterable<string>) => void
  setPreviewClipsByTrack: (previews: Map<TrackId, Clip[]>) => void
  commitClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
  canWriteClip: (clipId: string) => boolean
  canEditClip?: (clipId: string) => boolean
  selection: TimelineSelectionController
  projectId: Accessor<string>
  userId: () => string
  convexClient: typeof convexClient
  convexApi: typeof convexApi
  getScrollElement: () => HTMLDivElement | undefined
  // snapping
  bpm: Accessor<number>
  gridEnabled: Accessor<boolean>
  gridDenominator: Accessor<number>
  pixelsPerSecond: Accessor<number>
  visibleStartSec?: Accessor<number>
  // buffer cache to prime newly created duplicates
  audioBufferCache: ClipBuffers
  // Notify timeline that a set of clip moves has been committed (drop finished)
  onCommitMoves?: (clipIds: string[]) => void
  notify?: (title: string, message: string) => void
  // optional history push
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  grantWrite?: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
  grantClipWrites?: (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => void
  onRangeSelectionPointerDown?: (trackId: Track['id'], event: PointerEvent) => boolean
}

export function useClipDrag(options: ClipDragOptions): ClipDragHandlers {
  const {
    placementTracks,
    trackLayout,
    resolvedTracks,
    insertLocalTrack,
    insertLocalClip,
    removeLocalClips,
    removeLocalTrack,
    replaceDraftClipMoves,
    clearDraftClipMoves,
    setPreviewClipsByTrack,
    commitClipMoves,
    canWriteClip,
    canEditClip,
    selection,
    projectId,
    userId,
    convexClient,
    convexApi,
    getScrollElement,
    grantWrite,
    grantClipWrites,
    onRangeSelectionPointerDown,
  } = options
  const persistence = createClipDragPersistence({
    projectId,
    userId,
    convexClient,
    convexApi,
    insertLocalTrack,
    removeLocalTrack,
    placementTrackCount: () => placementTracks().length,
    defaultTrackColor: options.defaultTrackCreateColor,
    grantWrite,
  })

  let dragging = false
  // Identity of the active gesture and the project scope it edits. Async
  // continuations compare their captured gesture with this before writing.
  let gesture: { projectId: string; userId: string } | null = null
  let dragDeltaX = 0
  let draggingIds: { trackId: Track['id']; clipId: string } | null = null
  let addedTrackDuringDrag: Track['id'] | null = null
  let prePositions = new Map<string, { clipId: string; trackId: Track['id']; startSec: number }>()
  let multiDragging: MultiDragSnapshot | null = null
  // Ctrl-drag duplication state
  let duplicationActive = false
  let pendingAddedTrack: Promise<Track['id'] | null> | null = null
  let lastDraftMoves: Array<{ clipId: string; trackId: Track['id']; startSec: number }> | null = null
  const dragLookupCache = createDragTrackLookupCache()
  let visiblePlacementTracksCache: {
    placementTracks: Track[]
    trackLayout: TimelineTrackLayoutRow[]
    addedTrackId: Track['id'] | null
    result: Track[]
  } | null = null

  const PREVIEW_PREFIX = '__dup_preview:'
  const getScrollRef = () => getScrollElement()
  const visiblePlacementTracks = () => {
    const tracks = placementTracks()
    const layout = trackLayout()
    const cached = visiblePlacementTracksCache
    if (
      cached &&
      cached.placementTracks === tracks &&
      cached.trackLayout === layout &&
      cached.addedTrackId === addedTrackDuringDrag
    ) {
      return cached.result
    }
    const trackById = new Map(tracks.map((track) => [track.id, track]))
    const visible = layout.map((row) => {
      const track = trackById.get(row.trackId)
      return assertDefined(track, `Timeline layout row references missing track ${row.trackId}`)
    })
    let result = visible
    if (addedTrackDuringDrag) {
      const addedTrack = trackById.get(addedTrackDuringDrag)
      if (addedTrack && !visible.some((track) => track.id === addedTrack.id)) result = [...visible, addedTrack]
    }
    visiblePlacementTracksCache = {
      placementTracks: tracks,
      trackLayout: layout,
      addedTrackId: addedTrackDuringDrag,
      result,
    }
    return result
  }
  const getDraggedTrackKind = (ts: Track[], lookup = createTimelineTrackIndex(ts)) => {
    const ids = multiDragging ? multiDragging.items.map((item) => item.clipId) : draggingIds ? [draggingIds.clipId] : []
    if (ids.length === 0) return 'audio'
    const allMidi = ids.every((id) => !!lookup.clipById.get(id)?.midi)
    return allMidi ? 'instrument' : 'audio'
  }

  // Emptiness is only proven for a track visible in its own, still-current
  // project; a missing track or a switched project is left untouched.
  const cleanupUnusedAddedTrack = (trackId: Track['id'] | null, scope: typeof gesture) => {
    if (!trackId || !scope || scope.projectId !== projectId()) return
    const track = resolvedTracks().find(entry => entry.id === trackId)
    if (!track || track.clips.length > 0) return
    void persistence.deleteEmptyTrack(trackId, scope).catch(() => null)
  }

  const resetDragState = () => {
    clearDraftClipMoves(prePositions.keys())
    setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
    cleanupUnusedAddedTrack(addedTrackDuringDrag, gesture)
    gesture = null
    dragging = false
    duplicationActive = false
    multiDragging = null
    addedTrackDuringDrag = null
    pendingAddedTrack = null
    draggingIds = null
    lastDraftMoves = null
    dragLookupCache.clear()
  }

  // Resolves to null when creation fails or the gesture is superseded; a
  // failure cancels the gesture, so callers only need to recheck ownership.
  const createAddedTrack = async (kind: Track['kind']) => {
    const owner = gesture
    try {
      const trackId = await persistence.createTrackForDrag(kind, () => owner === gesture)
      if (owner !== gesture) return null
      addedTrackDuringDrag = trackId
      return trackId
    } catch {
      if (owner === gesture) {
        cancelPointerDrag()
        resetDragState()
      }
      return null
    } finally {
      if (owner === gesture) pendingAddedTrack = null
    }
  }

  // One creation per gesture: a release joins the creation a move started.
  const ensureAddedTrackDuringDrag = async (ts: Track[], lookup = createTimelineTrackIndex(ts)) => {
    if (addedTrackDuringDrag) return addedTrackDuringDrag
    pendingAddedTrack ??= createAddedTrack(getDraggedTrackKind(ts, lookup))
    return await pendingAddedTrack
  }

  const {
    cancelDrag: cancelPointerDrag,
    onPointerDown: beginPointerDrag,
  } = useDrag({
    onDragMove: (_, event) => onPointerDragMove(event),
    onDragEnd: (_, event) => onPointerDragEnd(event),
    onDragCancel: resetDragState,
    dragCursorClass: 'cursor-grabbing',
  })

  createEffect(on([projectId, userId], () => {
    if (!gesture) return
    cancelPointerDrag()
    resetDragState()
  }, { defer: true }))

  const onClipPointerDown = (trackId: Track['id'], clipId: string, event: PointerEvent) => {
    if (event.button !== 0) return
    if (canEditClip && !canEditClip(clipId)) return
    event.preventDefault()
    event.stopPropagation()
    const currentTracks = visiblePlacementTracks()
    const currentLookup = createTimelineTrackIndex(currentTracks)
    const track = currentLookup.trackById.get(trackId)
    const clip = currentLookup.clipById.get(clipId)
    if (!track || !clip) return

    if (event.shiftKey) {
      if (onRangeSelectionPointerDown?.(trackId, event)) return
      selection.appendClipToSelection({ trackId, clipId })
      return
    }

    const ownsClip = canWriteClip(clipId)
    if (!ownsClip) {
      selection.selectPrimaryClip({ trackId, clipId })
      return
    }

    const uid = userId()
    if (track.lockedBy && track.lockedBy !== uid) {
      return
    }

    const dragStart = buildClipDragStart({
      trackId,
      clipId,
      clip,
      tracks: currentTracks,
      lookup: currentLookup,
      selectedClipIds: selection.selectedClipIds(),
      canWriteClip,
    })
    if (dragStart.preserveSelection && dragStart.prePositions.size !== selection.selectedClipIds().size) {
      selection.setSelectedClipIds(new Set(dragStart.prePositions.keys()))
    }

    // A released gesture can still be awaiting track creation or its commit;
    // tear it down so its continuation cannot write into this gesture.
    if (gesture) {
      cancelPointerDrag()
      resetDragState()
    }
    gesture = { projectId: projectId(), userId: uid }
    dragging = true
    duplicationActive = !!event.ctrlKey
    draggingIds = dragStart.draggingIds
    prePositions = dragStart.prePositions
    multiDragging = dragStart.multiDragging
    selection.selectPrimaryClip(
      { trackId, clipId },
      { preserveClipIds: dragStart.preserveSelection },
    )

    const scroll = getScrollRef()
    if (!scroll) {
      resetDragState()
      return
    }
    const rect = scroll.getBoundingClientRect()
    const leftPx = (clip.startSec - (options.visibleStartSec?.() ?? 0)) * options.pixelsPerSecond()
    dragDeltaX = event.clientX - (rect.left + leftPx)
    beginPointerDrag(event)
  }

  const cancelDuplicationDrag = () => {
    setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
    cancelPointerDrag()
    resetDragState()
  }

  const onPointerDragMove = async (event: PointerEvent) => {
    if (!dragging || !draggingIds) return
    const owner = gesture
    const scroll = getScrollRef()
    if (!scroll) return

    let snapshot = visiblePlacementTracks()
    const { desiredStart, laneIdx } = readDragPointer({
      event,
      scroll,
      dragDeltaX,
      trackLayout: trackLayout(),
      gridEnabled: options.gridEnabled(),
      bpm: options.bpm(),
      gridDenominator: options.gridDenominator(),
      pixelsPerSecond: options.pixelsPerSecond(),
      visibleStartSec: options.visibleStartSec?.(),
    })

    // If duplicating and Ctrl released, cancel
    if (duplicationActive && !event.ctrlKey) {
      cancelDuplicationDrag()
      return
    }

    if (laneIdx >= snapshot.length) {
      if (!addedTrackDuringDrag && !pendingAddedTrack) {
        await ensureAddedTrackDuringDrag(snapshot, dragLookupCache.get(snapshot))
        if (owner !== gesture) return
        snapshot = visiblePlacementTracks()
        dragLookupCache.clear()
      }
    }

    const lookup = dragLookupCache.get(snapshot)
    const targetId = resolveNonDupTargetTrackId(snapshot, laneIdx, addedTrackDuringDrag)
    if (!targetId) {
      if (duplicationActive) setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
      return
    }

    const targetTrack = lookup.trackById.get(targetId)
    const uid = userId()
    if (targetTrack && targetTrack.lockedBy && targetTrack.lockedBy !== uid) {
      if (duplicationActive) setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
      return
    }

    const movingClipId = draggingIds.clipId
    const movingClip = lookup.clipById.get(movingClipId)
    if (targetTrack && movingClip && !canPlaceClipOnTrack(targetTrack, movingClip)) {
      if (duplicationActive) setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
      return
    }

    // Duplication mode: create visual ghost previews (no server calls, originals untouched)
    if (duplicationActive) {
      const placements = planDuplicatedClipPlacements({
        tracks: snapshot,
        lookup,
        draggingIds,
        multiDragging,
        targetTrackId: targetId,
        desiredStart,
        gridEnabled: options.gridEnabled(),
        bpm: options.bpm(),
        gridDenominator: options.gridDenominator(),
      })
      if (!placements) {
        setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
        return
      }
      setPreviewClipsByTrack(createDuplicatePreviews(placements, PREVIEW_PREFIX))
    } else {
      const plannedPlacement = resolveNonDupClipDragPlacement({
        tracks: snapshot,
        lookup,
        draggingIds,
        multiDragging,
        addedTrackDuringDrag,
        userId: uid,
        desiredStart,
        laneIdx,
        gridEnabled: options.gridEnabled(),
        bpm: options.bpm(),
        gridDenominator: options.gridDenominator(),
      })
      if (plannedPlacement.status === 'needs-track' || plannedPlacement.status === 'invalid') {
        clearDraftClipMoves(prePositions.keys())
        lastDraftMoves = null
        return
      }

      if (draftMovesChanged(lastDraftMoves, plannedPlacement.moves)) {
        replaceDraftClipMoves(plannedPlacement.moves)
        lastDraftMoves = plannedPlacement.moves
      }
      if (draggingIds.trackId !== plannedPlacement.targetTrackId) {
        const clipId = draggingIds.clipId
        draggingIds = { trackId: plannedPlacement.targetTrackId, clipId }
        selection.selectPrimaryClip(
          { trackId: plannedPlacement.selection.trackId, clipId: plannedPlacement.selection.clipId },
          plannedPlacement.selection.preserveClipIds ? { preserveClipIds: true } : undefined,
        )
      }
      return
    }

    if (draggingIds.trackId !== targetId) {
      const clipId = draggingIds.clipId
      draggingIds = { trackId: targetId, clipId }
      if (!duplicationActive) {
        selection.selectPrimaryClip(
          { trackId: targetId, clipId },
          { preserveClipIds: !!multiDragging },
        )
      }
    }
  }

  const onPointerDragEnd = async (event: PointerEvent) => {
    if (!dragging || !draggingIds) {
      resetDragState()
      return
    }
    const owner = gesture
    const activeDraggingIds = draggingIds
    const scroll = getScrollRef()
    if (!scroll) {
      resetDragState()
      return
    }

    const { desiredStart, laneIdx: initialLaneIdx } = readDragPointer({
      event,
      scroll,
      dragDeltaX,
      trackLayout: trackLayout(),
      gridEnabled: options.gridEnabled(),
      bpm: options.bpm(),
      gridDenominator: options.gridDenominator(),
      pixelsPerSecond: options.pixelsPerSecond(),
      visibleStartSec: options.visibleStartSec?.(),
    })
    let laneIdx = initialLaneIdx

    // If we are in duplication mode, handle commit or cancel here and exit.
    if (duplicationActive) {
      // Work against a base without previews
      let base = visiblePlacementTracks()

      // If dropping beyond last lane and no track was created during move, create one now
      if (laneIdx >= base.length && !addedTrackDuringDrag) {
        await ensureAddedTrackDuringDrag(placementTracks())
        if (owner !== gesture) return
        base = visiblePlacementTracks()
      }

      // Determine target track id
      let targetId: Track['id'] | undefined
      if (laneIdx >= base.length && addedTrackDuringDrag) {
        targetId = addedTrackDuringDrag
      } else {
        laneIdx = Math.max(0, Math.min(laneIdx, base.length - 1))
        targetId = base[laneIdx]?.id
      }
      if (!targetId) { cancelDuplicationDrag(); return }

      const lookup = createTimelineTrackIndex(base)
      const targetTrack = lookup.trackById.get(targetId)
      const targetUserId = userId()
      if (targetTrack && targetTrack.lockedBy && targetTrack.lockedBy !== targetUserId) { cancelDuplicationDrag(); return }

      // If Ctrl is not held anymore at drop, treat as cancel
      if (!event.ctrlKey) { cancelDuplicationDrag(); return }

      const placements = planDuplicatedClipPlacements({
        tracks: base,
        lookup,
        draggingIds: activeDraggingIds,
        multiDragging,
        targetTrackId: targetId,
        desiredStart,
        gridEnabled: options.gridEnabled(),
        bpm: options.bpm(),
        gridDenominator: options.gridDenominator(),
      })
      if (!placements) { cancelDuplicationDrag(); return }

      const plan = buildDuplicateClipCreateItems(placements, options.audioBufferCache)

      const rid = projectId()
      const createUserId = userId()
      if (!rid || (!persistence.isLocalProject() && !createUserId)) {
        resetDragState()
        return
      }
      // The released duplication owns its added track from here on, so a
      // superseding gesture's teardown cannot delete it while clips are created.
      const addedTrackId = addedTrackDuringDrag
      addedTrackDuringDrag = null
      try {
        const created = await commitDuplicatedClipDrag({
          projectId: rid,
          userId: createUserId,
          items: plan,
          baseTracks: base,
          addedTrackId,
          placementTracks,
          insertLocalClip,
          removeLocalClips,
          audioBufferCache: options.audioBufferCache.writer,
          canProject: () => projectId() === rid,
          grantClipWrites,
          historyPush: options.historyPush,
          createManyCloudClips: async (items, operationId) => {
            const result = await publishSharedTimelineOperation(rid, buildSharedClipCreateManyOperation({ items }, operationId))
            return Array.isArray(result) ? result.map((item) => isString(item) ? item : null) : []
          },
          selection,
        })
        if (!created.some((item) => item.trackId === addedTrackId)) cleanupUnusedAddedTrack(addedTrackId, owner)
      } catch {
        cleanupUnusedAddedTrack(addedTrackId, owner)
      }
      if (owner === gesture) resetDragState()
      return
    }

    const currentTracks = visiblePlacementTracks()
    let currentLookup = createTimelineTrackIndex(currentTracks)
    let plannedPlacement = resolveNonDupClipDragPlacement({
      tracks: currentTracks,
      lookup: currentLookup,
      draggingIds,
      multiDragging,
      addedTrackDuringDrag,
      userId: userId(),
      desiredStart,
      laneIdx,
      gridEnabled: options.gridEnabled(),
      bpm: options.bpm(),
      gridDenominator: options.gridDenominator(),
    })
    let finalTracks = currentTracks
    if (plannedPlacement.status === 'needs-track') {
      const newTrackId = await ensureAddedTrackDuringDrag(currentTracks)
      if (owner !== gesture) return
      if (!newTrackId) {
        resetDragState()
        return
      }
      finalTracks = visiblePlacementTracks()
      currentLookup = createTimelineTrackIndex(finalTracks)
      plannedPlacement = resolveNonDupClipDragPlacement({
        tracks: finalTracks,
        lookup: currentLookup,
        draggingIds,
        multiDragging,
        addedTrackDuringDrag,
        userId: userId(),
        desiredStart,
        laneIdx,
        gridEnabled: options.gridEnabled(),
        bpm: options.bpm(),
        gridDenominator: options.gridDenominator(),
      })
    }

    if (plannedPlacement.status !== 'ready') {
      resetDragState()
      return
    }

    const plannedMoves = plannedPlacement.moves.filter(move => {
      const previous = prePositions.get(move.clipId)
      return !previous || previous.trackId !== move.trackId || Math.abs(previous.startSec - move.startSec) > 1e-9
    })
    // A plain selection click must not persist a move or rebuild playback.
    if (plannedMoves.length === 0) {
      resetDragState()
      return
    }
    const previousPositions = new Map(prePositions)
    const previousMoves = previousMovesFrom(plannedMoves, previousPositions)
    const selectionAfterCommit = plannedPlacement.selection
    const preserveCommittedSelection = plannedPlacement.selection.preserveClipIds ? { preserveClipIds: true } : undefined
    const historyProjectId = projectId()
    const addedTrackIdForCommit = addedTrackDuringDrag
    const trackSnapshotForHistory = finalTracks
    const uid = userId()

    if (!persistence.isLocalProject() && !uid) {
      resetDragState()
      return
    }

    commitClipMoves(plannedMoves)
    selection.selectPrimaryClip(
      { trackId: selectionAfterCommit.trackId, clipId: selectionAfterCommit.clipId },
      preserveCommittedSelection,
    )
    // The committed move now owns this track; teardown must not delete it.
    if (plannedMoves.some(move => move.trackId === addedTrackIdForCommit)) addedTrackDuringDrag = null
    resetDragState()
    let moveFailureNotified = false
    const notifyMoveFailure = () => {
      if (moveFailureNotified) return
      moveFailureNotified = true
      options.notify?.("Clip move failed", "Clip move could not be saved.")
    }

    void commitMovedClipDrag({
      projectId: historyProjectId,
      userId: uid,
      plannedMoves,
      previousMoves,
      previousPositions,
      selectionAfterCommit,
      addedTrackId: addedTrackIdForCommit,
      trackSnapshotForHistory,
      commitClipMoves,
      cleanupUnusedAddedTrack: (trackId) => cleanupUnusedAddedTrack(trackId ?? null, owner),
      onCommitMoves: options.onCommitMoves,
      historyPush: options.historyPush,
      moveLocalClips: persistence.moveLocalClips,
      moveCloudClip: async (move) => {
        try {
          const applied = await persistence.moveCloudClip(move)
          if (!applied) notifyMoveFailure()
          return applied
        } catch {
          notifyMoveFailure()
          return false
        }
      },
      selection,
    }).catch(() => {
      commitClipMoves(previousMoves)
      notifyMoveFailure()
      if (addedTrackIdForCommit && plannedMoves.some((move) => move.trackId === addedTrackIdForCommit)) {
        cleanupUnusedAddedTrack(addedTrackIdForCommit, owner)
      }
    })
  }

  onCleanup(resetDragState)

  return {
    onClipPointerDown,
    isDragging: () => dragging,
  }
}
