import { onCleanup, type Accessor } from 'solid-js'

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
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { createTimelineTrackIndex } from '~/lib/timeline-track-index'
import { PPS } from '~/lib/timeline-utils'
import type { Track, Clip, TrackId } from '~/types/timeline'
import type { HistoryEntry } from '~/lib/undo/types'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type ClipDragHandlers = {
  onClipPointerDown: (trackId: Track['id'], clipId: string, event: PointerEvent) => void
}

type ClipDragOptions = {
  placementTracks: Accessor<Track[]>
  resolvedTracks: Accessor<Track[]>
  insertLocalTrack: (track: Track, index: number) => void
  insertLocalClip: (trackId: Track['id'], clip: Clip) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  removeLocalTrack: (trackId: Track['id']) => void
  replaceDraftClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
  clearDraftClipMoves: (clipIds: Iterable<string>) => void
  setPreviewClipsByTrack: (previews: Map<TrackId, Clip[]>) => void
  commitClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
  canWriteClip: (clipId: string) => boolean
  selection: TimelineSelectionController
  projectId: Accessor<string>
  userId: () => string
  convexClient: typeof import('~/lib/convex').convexClient
  convexApi: typeof import('~/lib/convex').convexApi
  getScrollElement: () => HTMLDivElement | undefined
  // snapping
  bpm: Accessor<number>
  gridEnabled: Accessor<boolean>
  gridDenominator: Accessor<number>
  // buffer cache to prime newly created duplicates
  audioBufferCache: Map<string, AudioBuffer>
  // Notify timeline that a set of clip moves has been committed (drop finished)
  onCommitMoves?: (clipIds: string[]) => void
  // optional history push
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  grantWrite?: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
  grantClipWrites?: (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => void
}

function teardownClipDragSession(input: {
  draftClipIds: Iterable<string>
  clearDraftClipMoves: (clipIds: Iterable<string>) => void
  setPreviewClipsByTrack: (previews: Map<TrackId, Clip[]>) => void
  cleanupUnusedAddedTrack: () => void
  resetLocals?: () => void
}) {
  input.clearDraftClipMoves(input.draftClipIds)
  input.setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
  input.cleanupUnusedAddedTrack()
  input.resetLocals?.()
}

export function useClipDrag(options: ClipDragOptions): ClipDragHandlers {
  const {
    placementTracks,
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
    selection,
    projectId,
    userId,
    convexClient,
    convexApi,
    getScrollElement,
    grantWrite,
    grantClipWrites,
  } = options
  const persistence = createClipDragPersistence({
    projectId,
    userId,
    convexClient,
    convexApi,
    insertLocalTrack,
    removeLocalTrack,
    placementTrackCount: () => placementTracks().length,
    grantWrite,
  })

  let dragging = false
  let dragDeltaX = 0
  let draggingIds: { trackId: Track['id']; clipId: string } | null = null
  let addedTrackDuringDrag: Track['id'] | null = null
  let prePositions = new Map<string, { clipId: string; trackId: Track['id']; startSec: number }>()
  let multiDragging: MultiDragSnapshot | null = null
  // Ctrl-drag duplication state
  let duplicationActive = false
  let creatingTrackDuringDrag = false
  let addedTrackDuringDragScope: { projectId: string; userId: string } | null = null
  let lastDraftMoves: Array<{ clipId: string; trackId: Track['id']; startSec: number }> | null = null
  const dragLookupCache = createDragTrackLookupCache()

  const PREVIEW_PREFIX = '__dup_preview:'
  const getScrollRef = () => getScrollElement()
  const getDraggedTrackKind = (ts: Track[], lookup = createTimelineTrackIndex(ts)) => {
    const ids = multiDragging ? multiDragging.items.map((item) => item.clipId) : draggingIds ? [draggingIds.clipId] : []
    if (ids.length === 0) return 'audio'
    const allMidi = ids.every((id) => !!lookup.clipById.get(id)?.midi)
    return allMidi ? 'instrument' : 'audio'
  }

  const cleanupUnusedAddedTrack = (trackId = addedTrackDuringDrag) => {
    if (!trackId) return
    const track = resolvedTracks().find(entry => entry.id === trackId)
    if (track && track.clips.length > 0) return
    void persistence.deleteEmptyTrack(trackId, addedTrackDuringDragScope ?? undefined).catch(() => null)
  }

  const clearDragLocals = () => {
    dragging = false
    duplicationActive = false
    multiDragging = null
    addedTrackDuringDrag = null
    addedTrackDuringDragScope = null
    creatingTrackDuringDrag = false
    draggingIds = null
    lastDraftMoves = null
    dragLookupCache.clear()
  }

  const resetDragState = () => {
    teardownClipDragSession({
      draftClipIds: prePositions.keys(),
      clearDraftClipMoves,
      setPreviewClipsByTrack,
      cleanupUnusedAddedTrack,
      resetLocals: clearDragLocals,
    })
  }

  const ensureAddedTrackDuringDrag = async (ts: Track[], lookup = createTimelineTrackIndex(ts)) => {
    if (addedTrackDuringDrag) return addedTrackDuringDrag
    if (creatingTrackDuringDrag) return null

    creatingTrackDuringDrag = true
    try {
      const kind = getDraggedTrackKind(ts, lookup)
      const scope = { projectId: projectId(), userId: userId() }
      const trackId = await persistence.createTrackForDrag(kind)
      if (!trackId) return null
      addedTrackDuringDrag = trackId
      addedTrackDuringDragScope = scope
      return trackId
    } finally {
      creatingTrackDuringDrag = false
    }
  }

  const {
    cancelDrag: cancelPointerDrag,
    onPointerDown: beginPointerDrag,
  } = useDrag({
    onDragMove: (_, event) => onPointerDragMove(event),
    onDragEnd: (_, event) => onPointerDragEnd(event),
    dragCursorClass: 'cursor-grabbing',
  })

  const onClipPointerDown = (trackId: Track['id'], clipId: string, event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const currentTracks = placementTracks()
    const currentLookup = createTimelineTrackIndex(currentTracks)
    const track = currentLookup.trackById.get(trackId)
    const clip = currentLookup.clipById.get(clipId)
    if (!track || !clip) return

    if (event.shiftKey) {
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

    dragging = true
    duplicationActive = !!event.ctrlKey
    draggingIds = dragStart.draggingIds
    prePositions = dragStart.prePositions
    multiDragging = dragStart.multiDragging
    selection.selectPrimaryClip(
      { trackId, clipId },
      { preserveClipIds: dragStart.preserveSelection },
    )

    addedTrackDuringDrag = null
    creatingTrackDuringDrag = false

    const scroll = getScrollRef()
    if (!scroll) {
      resetDragState()
      return
    }
    const rect = scroll.getBoundingClientRect()
    const leftPx = clip.startSec * PPS - (scroll.scrollLeft || 0)
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
    const scroll = getScrollRef()
    if (!scroll) return

    let snapshot = placementTracks()
    const { desiredStart, laneIdx } = readDragPointer({
      event,
      scroll,
      dragDeltaX,
      gridEnabled: options.gridEnabled(),
      bpm: options.bpm(),
      gridDenominator: options.gridDenominator(),
    })

    // If duplicating and Ctrl released, cancel
    if (duplicationActive && !event.ctrlKey) {
      cancelDuplicationDrag()
      return
    }

    if (laneIdx >= snapshot.length) {
      if (!addedTrackDuringDrag && !creatingTrackDuringDrag) {
        await ensureAddedTrackDuringDrag(snapshot, dragLookupCache.get(snapshot))
        snapshot = placementTracks()
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
    const scroll = getScrollRef()
    if (!scroll) {
      resetDragState()
      return
    }

    let { desiredStart, laneIdx } = readDragPointer({
      event,
      scroll,
      dragDeltaX,
      gridEnabled: options.gridEnabled(),
      bpm: options.bpm(),
      gridDenominator: options.gridDenominator(),
    })

    // If we are in duplication mode, handle commit or cancel here and exit.
    if (duplicationActive) {
      // Work against a base without previews
      let base = placementTracks()

      // If dropping beyond last lane and no track was created during move, create one now
      if (laneIdx >= base.length && !addedTrackDuringDrag) {
        try {
          await ensureAddedTrackDuringDrag(placementTracks())
          base = placementTracks()
        } catch {
          // if failed to create new track, cancel duplication cleanly
          cancelDuplicationDrag()
          return
        }
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
        draggingIds: draggingIds!,
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
      try {
        const created = await commitDuplicatedClipDrag({
          projectId: rid,
          userId: createUserId,
          items: plan,
          baseTracks: base,
          addedTrackId: addedTrackDuringDrag,
          placementTracks,
          insertLocalClip,
          removeLocalClips,
          audioBufferCache: options.audioBufferCache,
          canProject: () => projectId() === rid,
          grantClipWrites,
          historyPush: options.historyPush,
          createManyCloudClips: async (items) => await convexClient.mutation(convexApi.clips.createMany, { items }),
          selection,
        })
        setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
        if (addedTrackDuringDrag && created.some((item) => item.trackId === addedTrackDuringDrag)) {
          addedTrackDuringDrag = null
        }
        dragging = false
        resetDragState()
        return
      } catch {
        setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
        if (addedTrackDuringDrag) {
          cleanupUnusedAddedTrack(addedTrackDuringDrag)
        }
        resetDragState()
        return
      }
    }

    const currentTracks = placementTracks()
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
      if (!newTrackId) {
        resetDragState()
        return
      }
      finalTracks = placementTracks()
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

    const plannedMoves = plannedPlacement.moves
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
    resetDragState()

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
      cleanupUnusedAddedTrack,
      onCommitMoves: options.onCommitMoves,
      historyPush: options.historyPush,
      moveLocalClips: persistence.moveLocalClips,
      moveCloudClip: persistence.moveCloudClip,
      selection,
    }).catch(() => {
      commitClipMoves(previousMoves)
      if (addedTrackIdForCommit && plannedMoves.some((move) => move.trackId === addedTrackIdForCommit)) {
        cleanupUnusedAddedTrack(addedTrackIdForCommit)
      }
    })
  }

  onCleanup(() => {
    teardownClipDragSession({
      draftClipIds: prePositions.keys(),
      clearDraftClipMoves,
      setPreviewClipsByTrack,
      cleanupUnusedAddedTrack,
      resetLocals: () => {
        dragging = false
        duplicationActive = false
        multiDragging = null
        addedTrackDuringDrag = null
        creatingTrackDuringDrag = false
        draggingIds = null
      },
    })
  })

  return {
    onClipPointerDown,
  }
}
