import { onCleanup, type Accessor } from 'solid-js'

import { buildCreatedClipSelection, createProjectedClips, pushClipCreateHistory, type BatchClipCreateItem } from '~/lib/clip-create'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import { buildClipMoveMutationInput } from '~/lib/clip-mutation-args'
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
import { buildTrackDeleteMutationInput } from '~/lib/track-mutation-args'
import { createOptimisticTrack, pushTrackCreateHistory } from '~/lib/tracks'
import { PPS, yToLaneIndex, quantizeSecToGrid } from '~/lib/timeline-utils'
import { buildClipsMoveHistoryEntry } from '~/lib/undo/builders'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { Track, Clip, TrackId } from '~/types/timeline'
import type { HistoryEntry } from '~/lib/undo/types'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type PendingClipCreate = BatchClipCreateItem

type ClipDragHandlers = {
  onClipPointerDown: (trackId: Track['id'], clipId: string, event: PointerEvent) => void
}

type ClipDragOptions = {
  placementTracks: Accessor<Track[]>
  resolvedTracks: Accessor<Track[]>
  insertLocalTrack: (track: Track, index: number) => void
  insertLocalClip: (trackId: Track['id'], clip: Clip) => void
  removeLocalTrack: (trackId: Track['id']) => void
  replaceDraftClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
  clearDraftClipMoves: (clipIds: Iterable<string>) => void
  setPreviewClipsByTrack: (previews: Map<TrackId, Clip[]>) => void
  commitClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
  canWriteClip: (clipId: string) => boolean
  selection: TimelineSelectionController
  roomId: Accessor<string>
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
    removeLocalTrack,
    replaceDraftClipMoves,
    clearDraftClipMoves,
    setPreviewClipsByTrack,
    commitClipMoves,
    canWriteClip,
    selection,
    roomId,
    userId,
    convexClient,
    convexApi,
    getScrollElement,
    grantWrite,
    grantClipWrites,
  } = options

  let dragging = false
  let dragDeltaX = 0
  let draggingIds: { trackId: Track['id']; clipId: string } | null = null
  let addedTrackDuringDrag: Track['id'] | null = null
  let prePositions = new Map<string, { trackId: Track['id']; startSec: number }>()
  let multiDragging: MultiDragSnapshot | null = null
  // Ctrl-drag duplication state
  let duplicationActive = false
  let creatingTrackDuringDrag = false
  let lastDraftMoves: Array<{ clipId: string; trackId: Track['id']; startSec: number }> | null = null
  let dragTracksSnapshot: Track[] | null = null
  let dragTrackLookup: ReturnType<typeof createTimelineTrackIndex> | null = null

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
    const uid = userId()
    if (!uid) return
    void convexClient.mutation(convexApi.tracks.remove, buildTrackDeleteMutationInput({ trackId, userId: uid }))
      .then((result) => {
        if (result?.status !== 'deleted') return
        removeLocalTrack(trackId)
      })
      .catch(() => null)
  }

  const clearDragLocals = () => {
    dragging = false
    duplicationActive = false
    multiDragging = null
    addedTrackDuringDrag = null
    creatingTrackDuringDrag = false
    draggingIds = null
    lastDraftMoves = null
    dragTracksSnapshot = null
    dragTrackLookup = null
  }

  const draftMovesChanged = (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => {
    if (!lastDraftMoves || lastDraftMoves.length !== moves.length) return true
    for (let i = 0; i < moves.length; i++) {
      const prev = lastDraftMoves[i]
      const next = moves[i]
      if (prev.clipId !== next.clipId || prev.trackId !== next.trackId || prev.startSec !== next.startSec) return true
    }
    return false
  }

  const getDragTrackLookup = (tracks: Track[]) => {
    if (dragTracksSnapshot === tracks && dragTrackLookup) return dragTrackLookup
    dragTracksSnapshot = tracks
    dragTrackLookup = createTimelineTrackIndex(tracks)
    return dragTrackLookup
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
      const track = await createOptimisticTrack({
        convexClient,
        convexApi,
        roomId: roomId(),
        userId: userId(),
        insertLocalTrack,
        index: placementTracks().length,
        grantWrite,
        grantScope: { roomId: roomId(), userId: userId() },
        kind,
      })
      if (!track) return null
      addedTrackDuringDrag = track.id
      return track.id
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

    const selectedIds = selection.selectedClipIds()
    const ownedSelectionIds = Array.from(selectedIds).filter((id) => canWriteClip(id))
    const dragSelectionIds = selectedIds.has(clipId) && ownedSelectionIds.length > 1
      ? ownedSelectionIds
      : [clipId]
    const isMultiDrag = dragSelectionIds.length > 1
    if (isMultiDrag && dragSelectionIds.length !== selectedIds.size) {
      selection.setSelectedClipIds(new Set(dragSelectionIds))
    }

    dragging = true
    duplicationActive = !!event.ctrlKey
    draggingIds = { trackId, clipId }
    // capture pre-positions
    prePositions = new Map<string, { trackId: Track['id']; startSec: number }>()
    if (isMultiDrag) {
      for (const id of dragSelectionIds) {
        const clipEntry = currentLookup.clipById.get(id)
        const clipTrackId = currentLookup.clipTrackIdById.get(id)
        if (!clipEntry || !clipTrackId) continue
        prePositions.set(id, { trackId: clipTrackId, startSec: clipEntry.startSec })
      }
    } else {
      prePositions.set(clipId, { trackId, startSec: clip.startSec })
    }
    selection.selectPrimaryClip(
      { trackId, clipId },
      { preserveClipIds: isMultiDrag },
    )

    if (isMultiDrag) {
      const anchorTrackIdx = currentTracks.findIndex(tt => tt.id === trackId)
      const items: MultiDragSnapshot['items'] = []
      for (const id of dragSelectionIds) {
        const found = currentLookup.clipById.get(id)
        const foundTrackId = currentLookup.clipTrackIdById.get(id)
        const foundTrackIdx = foundTrackId ? (currentLookup.trackIndexById.get(foundTrackId) ?? -1) : -1
        if (!found || foundTrackIdx < 0) continue
        items.push({ clipId: id, origTrackIdx: foundTrackIdx, origStartSec: found.startSec })
      }
      multiDragging = {
        anchorClipId: clipId,
        anchorOrigTrackIdx: anchorTrackIdx,
        anchorOrigStartSec: clip.startSec,
        items,
      }
    } else {
      multiDragging = null
    }

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
    const rect = scroll.getBoundingClientRect()
    const x = event.clientX - rect.left - dragDeltaX + (scroll.scrollLeft || 0)
    let desiredStart = Math.max(0, x / PPS)
    if (options.gridEnabled()) {
      desiredStart = quantizeSecToGrid(desiredStart, options.bpm(), options.gridDenominator(), 'round')
    }
    let laneIdx = yToLaneIndex(event.clientY, scroll)

    // If duplicating and Ctrl released, cancel
    if (duplicationActive && !event.ctrlKey) {
      cancelDuplicationDrag()
      return
    }

    if (laneIdx >= snapshot.length) {
      if (!addedTrackDuringDrag && !creatingTrackDuringDrag) {
        await ensureAddedTrackDuringDrag(snapshot, getDragTrackLookup(snapshot))
        snapshot = placementTracks()
        dragTracksSnapshot = null
        dragTrackLookup = null
      }
    }

    const lookup = getDragTrackLookup(snapshot)
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
      const previews = new Map<TrackId, Clip[]>()
      for (const placement of placements) {
        const trackPreviews = previews.get(placement.trackId) ?? []
        trackPreviews.push({
          ...placement.originalClip,
          id: `${PREVIEW_PREFIX}${placement.originalClip.id}`,
          startSec: placement.startSec,
        })
        previews.set(placement.trackId, trackPreviews)
      }
      setPreviewClipsByTrack(previews)
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

      if (draftMovesChanged(plannedPlacement.moves)) {
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
    if (!scroll) return

    const rect = scroll.getBoundingClientRect()
    const x = event.clientX - rect.left - dragDeltaX + (scroll.scrollLeft || 0)
    let desiredStart = Math.max(0, x / PPS)
    if (options.gridEnabled()) desiredStart = quantizeSecToGrid(desiredStart, options.bpm(), options.gridDenominator(), 'round')
    let laneIdx = yToLaneIndex(event.clientY, scroll)

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

      const plan: PendingClipCreate[] = placements.map((placement) => ({
        trackId: placement.trackId,
        buffer: placement.originalClip.buffer ?? options.audioBufferCache.get(placement.originalClip.id) ?? null,
        clip: {
          startSec: placement.startSec,
          duration: placement.originalClip.duration,
          name: placement.originalClip.name,
          sampleUrl: placement.originalClip.sampleUrl,
          source: getPersistableAudioSourceMetadata(placement.originalClip),
          sourceAssetKey: placement.originalClip.sourceAssetKey,
          sourceKind: placement.originalClip.sourceKind,
          midi: placement.originalClip.midi,
          timing: {
            leftPadSec: placement.originalClip.leftPadSec,
            bufferOffsetSec: placement.originalClip.bufferOffsetSec,
            midiOffsetBeats: placement.originalClip.midiOffsetBeats,
          },
        },
      }))

      // Create duplicates on server
      const rid = roomId()
      const createUserId = userId()
      if (!rid || !createUserId) {
        resetDragState()
        return
      }
      let created: Awaited<ReturnType<typeof createProjectedClips>>
      try {
        created = await createProjectedClips({
          roomId: rid,
          userId: createUserId,
          items: plan,
          createMany: async (items) => await convexClient.mutation(convexApi.clips.createMany, { items }),
          insertLocalClip,
          audioBufferCache: options.audioBufferCache,
          grantClipWrites,
          grantScope: { roomId: rid, userId: createUserId },
        })
      } catch {
        setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
        if (addedTrackDuringDrag) {
          cleanupUnusedAddedTrack(addedTrackDuringDrag)
        }
        resetDragState()
        return
      }

      // Remove any previews and select freshly created clips
      setPreviewClipsByTrack(new Map<TrackId, Clip[]>())
      const nextSelection = buildCreatedClipSelection(created)
      if (nextSelection) {
        selection.selectClipGroup(nextSelection)
      }

      // finalize
      if (addedTrackDuringDrag && created.some((item) => item.trackId === addedTrackDuringDrag)) {
        pushTrackCreateHistory(options.historyPush, roomId(), placementTracks(), placementTracks().find((entry) => entry.id === addedTrackDuringDrag))
      }
      const historyRoomId = roomId()
      for (const item of created) {
        pushClipCreateHistory({
          historyPush: options.historyPush,
          roomId: historyRoomId,
          trackId: item.trackId,
          trackRef: getTrackHistoryRef(base.find((entry) => entry.id === item.trackId)),
          clipId: item.clipId,
          clip: item.clip,
        })
      }

      if (addedTrackDuringDrag && created.some((item) => item.trackId === addedTrackDuringDrag)) {
        addedTrackDuringDrag = null
      }
      dragging = false
      resetDragState()
      return
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

    const uid = userId()
    if (!uid) {
      resetDragState()
      return
    }

    const plannedMoves = plannedPlacement.moves
    const previousPositions = new Map(prePositions)
    const previousMoves = plannedMoves.map((move) => ({
      clipId: move.clipId,
      trackId: previousPositions.get(move.clipId)?.trackId ?? move.trackId,
      startSec: previousPositions.get(move.clipId)?.startSec ?? move.startSec,
    }))
    const selectionAfterCommit = plannedPlacement.selection
    const preserveCommittedSelection = plannedPlacement.selection.preserveClipIds ? { preserveClipIds: true } : undefined
    const historyRoomId = roomId()
    const addedTrackIdForCommit = addedTrackDuringDrag
    const trackSnapshotForHistory = finalTracks

    commitClipMoves(plannedMoves)
    selection.selectPrimaryClip(
      { trackId: selectionAfterCommit.trackId, clipId: selectionAfterCommit.clipId },
      preserveCommittedSelection,
    )
    resetDragState()

    void Promise.all(plannedMoves.map(async (move) => {
      try {
        const result = await convexClient.mutation(convexApi.clips.move, buildClipMoveMutationInput({
          clipId: move.clipId,
          userId: uid,
          startSec: move.startSec,
          toTrackId: move.trackId,
        }))
        return result?.status === 'applied'
      } catch {
        return false
      }
    })).then((moveApplied) => {
      const successfulMoves = plannedMoves.filter((_, index) => moveApplied[index])
      const failedMoves = previousMoves.filter((_, index) => !moveApplied[index])

      if (failedMoves.length > 0) {
        commitClipMoves(failedMoves)
        if (addedTrackIdForCommit && failedMoves.some((move) => move.trackId === addedTrackIdForCommit)) {
          cleanupUnusedAddedTrack(addedTrackIdForCommit)
        }
        if (failedMoves.some((move) => move.clipId === selectionAfterCommit.clipId)) {
          const rollbackAnchor = failedMoves.find((move) => move.clipId === selectionAfterCommit.clipId)
            ?? failedMoves[0]
          if (rollbackAnchor) {
            selection.selectPrimaryClip(
              { trackId: rollbackAnchor.trackId, clipId: rollbackAnchor.clipId },
              preserveCommittedSelection,
            )
          }
        }
      }

      if (successfulMoves.length > 0) {
        try { options.onCommitMoves?.(successfulMoves.map((move) => move.clipId)) } catch {}
        try {
          if (historyRoomId && typeof options.historyPush === 'function') {
            if (addedTrackIdForCommit && successfulMoves.some((move) => move.trackId === addedTrackIdForCommit)) {
              pushTrackCreateHistory(options.historyPush, historyRoomId, trackSnapshotForHistory, trackSnapshotForHistory.find((entry) => entry.id === addedTrackIdForCommit))
            }
            options.historyPush(buildClipsMoveHistoryEntry({
              roomId: historyRoomId,
              tracks: trackSnapshotForHistory,
              moves: successfulMoves.map((move) => ({
                clipId: move.clipId,
                from: previousPositions.get(move.clipId) ?? { trackId: move.trackId, startSec: move.startSec },
                to: { trackId: move.trackId, startSec: move.startSec },
              })),
            }))
          }
        } catch {}
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
