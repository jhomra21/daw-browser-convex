import { createSignal, onCleanup, type Accessor, type Setter } from 'solid-js'

import { createManyClips, pushClipCreateHistory, type BatchClipCreateItem } from '~/lib/clip-create'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import { useDrag } from '~/hooks/useDrag'
import { isClipCompatibleWithTrack } from '~/lib/track-routing'
import { createOptimisticTrack, pushTrackCreateHistory } from '~/lib/tracks'
import { appendClipToSelection, selectClipGroup, selectPrimaryClip } from '~/lib/timeline-selection'
import { PPS, willOverlap, calcNonOverlapStart, yToLaneIndex, quantizeSecToGrid, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import { buildClipsMoveHistoryEntry } from '~/lib/undo/builders'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { Track, Clip, SelectedClip } from '~/types/timeline'
import type { HistoryEntry } from '~/lib/undo/types'

type MultiDragSnapshot = {
  anchorClipId: string
  anchorOrigTrackIdx: number
  anchorOrigStartSec: number
  items: Array<{ clipId: string; origTrackIdx: number; origStartSec: number; duration: number }>
}

type DragSnapshot = {
  draggingIds: { trackId: string; clipId: string }
  multiDragging: MultiDragSnapshot | null
  addedTrackDuringDrag: string | null
  duplicationActive?: boolean
}


type PendingClipCreate = BatchClipCreateItem
type TrackLookup = {
  trackById: Map<string, Track>
  trackIndexById: Map<string, number>
  clipById: Map<string, Clip>
  clipTrackIdById: Map<string, string>
}

export type ClipDragHandlers = {
  onClipPointerDown: (trackId: string, clipId: string, event: PointerEvent) => void
  activeDrag: Accessor<DragSnapshot | null>
}

export type ClipDragOptions = {
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
  canWriteClip: (clipId: string) => boolean
  selectedClipIds: Accessor<Set<string>>
  setSelectedClipIds: Setter<Set<string>>
  setSelectedTrackId: Setter<string>
  setSelectedClip: Setter<SelectedClip>
  setSelectedFXTarget: Setter<string>
  roomId: Accessor<string>
  userId: () => string
  convexClient: typeof import('~/lib/convex').convexClient
  convexApi: typeof import('~/lib/convex').convexApi
  optimisticMoves: Map<string, { trackId: string; startSec: number }>
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
  grantWrite?: (trackId: string) => void
  grantClipWrites?: (clipIds: Iterable<string>) => void
}

export function useClipDrag(options: ClipDragOptions): ClipDragHandlers {
  const {
    tracks,
    setTracks,
    canWriteClip,
    selectedClipIds,
    setSelectedClipIds,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedFXTarget,
    roomId,
    userId,
    convexClient,
    convexApi,
    optimisticMoves,
    getScrollElement,
    grantWrite,
    grantClipWrites,
  } = options

  const selectionSetters = { setSelectedTrackId, setSelectedClip, setSelectedClipIds, setSelectedFXTarget }

  let dragging = false
  let dragDeltaX = 0
  let draggingIds: { trackId: string; clipId: string } | null = null
  let addedTrackDuringDrag: string | null = null
  let creatingTrackDuringDrag = false
  let multiDragging: MultiDragSnapshot | null = null
  // Ctrl-drag duplication state
  let duplicationActive = false
  // Pre-move snapshot for undo
  let prePositions = new Map<string, { trackId: string; startSec: number }>()

  const PREVIEW_PREFIX = '__dup_preview:'
  const isPreviewId = (id: string) => id.startsWith(PREVIEW_PREFIX)
  const stripPreviews = (ts: Track[]) => ts.map(t => ({ ...t, clips: t.clips.filter(c => !isPreviewId(c.id)) }))
  const createTrackLookup = (ts: Track[]): TrackLookup => {
    const trackById = new Map<string, Track>()
    const trackIndexById = new Map<string, number>()
    const clipById = new Map<string, Clip>()
    const clipTrackIdById = new Map<string, string>()
    for (let index = 0; index < ts.length; index++) {
      const track = ts[index]
      trackById.set(track.id, track)
      trackIndexById.set(track.id, index)
      for (const clip of track.clips) {
        clipById.set(clip.id, clip)
        clipTrackIdById.set(clip.id, track.id)
      }
    }
    return { trackById, trackIndexById, clipById, clipTrackIdById }
  }
  const findClipIn = (lookup: TrackLookup, id: string): Clip | null => lookup.clipById.get(id) ?? null
  const getScrollRef = () => getScrollElement()
  const canPlaceClipOnTrack = (track: Track | undefined, clip: Clip | null | undefined) => !!track && !!clip && isClipCompatibleWithTrack(track, clip)
  const getDraggedTrackKind = (ts: Track[], lookup = createTrackLookup(ts)) => {
    const ids = multiDragging ? multiDragging.items.map(item => item.clipId) : draggingIds ? [draggingIds.clipId] : []
    if (ids.length === 0) return 'audio' as Track['kind']
    const allMidi = ids.every((id) => !!findClipIn(lookup, id)?.midi)
    return allMidi ? 'instrument' : 'audio'
  }
  const canPlaceMultiDrag = (ts: Track[], multi: MultiDragSnapshot, anchorTargetIdx: number, lookup = createTrackLookup(ts)) => {
    const deltaIdx = anchorTargetIdx - multi.anchorOrigTrackIdx
    for (const item of multi.items) {
      const clip = findClipIn(lookup, item.clipId)
      if (!clip) return false
      const targetIndex = Math.max(0, Math.min(ts.length - 1, item.origTrackIdx + deltaIdx))
      if (!canPlaceClipOnTrack(ts[targetIndex], clip)) return false
    }
    return true
  }

  const [dragState, setDragState] = createSignal<DragSnapshot | null>(null)

  const cleanupUnusedAddedTrack = () => {
    const trackId = addedTrackDuringDrag
    if (!trackId) return
    const track = stripPreviews(tracks()).find(entry => entry.id === trackId)
    if (track && track.clips.length > 0) return
    const uid = userId()
    if (!uid) return
    void convexClient.mutation(convexApi.tracks.remove, { trackId: trackId as any, userId: uid as any })
      .then((result: any) => {
        if (result?.status !== 'deleted') return
        setTracks(ts => ts.filter(entry => entry.id !== trackId))
      })
      .catch(() => null)
  }

  const resetDragState = () => {
    cleanupUnusedAddedTrack()
    dragging = false
    duplicationActive = false
    multiDragging = null
    addedTrackDuringDrag = null
    creatingTrackDuringDrag = false
    draggingIds = null
    updateDragState()
  }

  const updateDragState = () => {
    if (dragging && draggingIds) {
      setDragState({
        draggingIds,
        multiDragging,
        addedTrackDuringDrag,
        duplicationActive,
      })
    } else {
      setDragState(null)
    }
  }

  const ensureAddedTrackDuringDrag = async (ts: Track[], lookup = createTrackLookup(ts)) => {
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
        tracks,
        setTracks,
        grantWrite,
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
  })

  const onClipPointerDown = (trackId: string, clipId: string, event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const currentTracks = tracks()
    const currentLookup = createTrackLookup(currentTracks)
    const track = currentLookup.trackById.get(trackId)
    const clip = currentLookup.clipById.get(clipId)
    if (!track || !clip) return

    if (event.shiftKey) {
      appendClipToSelection(selectionSetters, { trackId, clipId })
      return
    }

    const ownsClip = canWriteClip(clipId)
    if (!ownsClip) {
      selectPrimaryClip(selectionSetters, { trackId, clipId })
      return
    }

    const uid = userId()
    if (track.lockedBy && track.lockedBy !== uid) {
      return
    }

    const selection = selectedClipIds()
    const ownedSelectionIds = Array.from(selection).filter((id) => canWriteClip(id))
    const dragSelectionIds = selection.has(clipId) && ownedSelectionIds.length > 1
      ? ownedSelectionIds
      : [clipId]
    const isMultiDrag = dragSelectionIds.length > 1
    if (isMultiDrag && dragSelectionIds.length !== selection.size) {
      setSelectedClipIds(new Set(dragSelectionIds))
    }

    dragging = true
    duplicationActive = !!event.ctrlKey
    draggingIds = { trackId, clipId }
    // capture pre-positions
    prePositions = new Map<string, { trackId: string; startSec: number }>()
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
    selectPrimaryClip(
      selectionSetters,
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
        items.push({ clipId: id, origTrackIdx: foundTrackIdx, origStartSec: found.startSec, duration: found.duration })
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
    if (!scroll) return
    const rect = scroll.getBoundingClientRect()
    const leftPx = clip.startSec * PPS - (scroll.scrollLeft || 0)
    dragDeltaX = event.clientX - (rect.left + leftPx)
    updateDragState()
    beginPointerDrag(event)
  }

  const cancelDuplicationDrag = () => {
    setTracks(ts => stripPreviews(ts))
    cancelPointerDrag()
    resetDragState()
  }

  const onPointerDragMove = async (event: PointerEvent) => {
    if (!dragging || !draggingIds) return
    const scroll = getScrollRef()
    if (!scroll) return

    let snapshot = tracks()
    let lookup = createTrackLookup(snapshot)
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
        await ensureAddedTrackDuringDrag(snapshot, lookup)
        snapshot = tracks()
        lookup = createTrackLookup(snapshot)
        updateDragState()
      }
    }

    let targetId: string | undefined
    if (laneIdx >= snapshot.length && addedTrackDuringDrag) {
      targetId = addedTrackDuringDrag
    } else {
      laneIdx = Math.max(0, Math.min(laneIdx, snapshot.length - 1))
      targetId = snapshot[laneIdx]?.id
    }
    if (!targetId) {
      if (duplicationActive) setTracks(ts => stripPreviews(ts))
      return
    }

    const targetTrack = lookup.trackById.get(targetId)
    const uid = userId()
    if (targetTrack && targetTrack.lockedBy && targetTrack.lockedBy !== uid) {
      if (duplicationActive) setTracks(ts => stripPreviews(ts))
      return
    }

    const movingClipId = draggingIds.clipId
    const movingClip = lookup.clipById.get(movingClipId)
    if (targetTrack && movingClip && !canPlaceClipOnTrack(targetTrack, movingClip)) {
      if (duplicationActive) setTracks(ts => stripPreviews(ts))
      return
    }

    // Duplication mode: create visual ghost previews (no server calls, originals untouched)
    if (duplicationActive) {
      const base = stripPreviews(snapshot)
      const baseLookup = createTrackLookup(base)
      const targetIdx = baseLookup.trackIndexById.get(targetId) ?? -1
      if (targetIdx < 0) return
      // build preview clones without removing originals
      const adds = new Map<number, Clip[]>()
      const pushClone = (orig: Clip, toIdx: number, newStart: number) => {
        const existing = base[toIdx]?.clips ?? []
        const pending = adds.get(toIdx) ?? []
        const trackClipsForOverlap = [...existing, ...pending]
        const overlap = willOverlap(trackClipsForOverlap, null, newStart, orig.duration)
        const safeStart = options.gridEnabled()
          ? calcNonOverlapStartGridAligned(trackClipsForOverlap, null, newStart, orig.duration, options.bpm(), options.gridDenominator())
          : (overlap
              ? calcNonOverlapStart(trackClipsForOverlap, null, newStart, orig.duration)
              : newStart)
        const preview: Clip = { ...orig, id: `${PREVIEW_PREFIX}${orig.id}`, startSec: safeStart }
        const arr = adds.get(toIdx) ?? []
        arr.push(preview)
        adds.set(toIdx, arr)
      }
      if (multiDragging) {
        const md = multiDragging
        if (!canPlaceMultiDrag(base, md, targetIdx, baseLookup)) {
          setTracks(ts => stripPreviews(ts))
          return
        }
        const deltaIdx = targetIdx - md.anchorOrigTrackIdx
        for (const it of md.items) {
          const orig = findClipIn(baseLookup, it.clipId)
          if (!orig) continue
          const idx = Math.max(0, Math.min(base.length - 1, it.origTrackIdx + deltaIdx))
          let ns = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
          if (options.gridEnabled()) ns = quantizeSecToGrid(ns, options.bpm(), options.gridDenominator(), 'round')
          pushClone(orig, idx, ns)
        }
      } else {
        const orig = findClipIn(baseLookup, movingClipId)
        if (!orig) return
        if (!canPlaceClipOnTrack(targetTrack, orig)) {
          setTracks(ts => stripPreviews(ts))
          return
        }
        pushClone(orig, targetIdx, desiredStart)
      }
      setTracks(ts => {
        const stripped = stripPreviews(ts)
        return stripped.map((t, i) => ({ ...t, clips: [...t.clips, ...(adds.get(i) ?? [])] }))
      })
    } else if (multiDragging) {
      const multi = multiDragging
      const selIds = new Set(multi.items.map(it => it.clipId))
      setTracks(ts => {
        const tsLookup = createTrackLookup(ts)
        const targetIdx = tsLookup.trackIndexById.get(targetId) ?? -1
        if (targetIdx < 0) return ts
        const deltaIdx = targetIdx - multi.anchorOrigTrackIdx
        const base = ts.map(t => ({ ...t, clips: t.clips.filter(c => !selIds.has(c.id)) }))
        const adds = new Map<number, Clip[]>()
        for (const it of multi.items) {
          const orig = tsLookup.clipById.get(it.clipId)
          if (!orig) continue
          const targetIndex = Math.max(0, Math.min(base.length - 1, it.origTrackIdx + deltaIdx))
          let newStart = Math.max(0, desiredStart + (it.origStartSec - multi.anchorOrigStartSec))
          if (options.gridEnabled()) newStart = quantizeSecToGrid(newStart, options.bpm(), options.gridDenominator(), 'round')
          const trackClips = [...base[targetIndex]?.clips ?? [], ...(adds.get(targetIndex) ?? [])]
          const overlap = willOverlap(trackClips, orig.id, newStart, orig.duration)
          const safeStart = options.gridEnabled()
            ? calcNonOverlapStartGridAligned(trackClips, orig.id, newStart, orig.duration, options.bpm(), options.gridDenominator())
            : (overlap ? calcNonOverlapStart(trackClips, orig.id, newStart, orig.duration) : newStart)
          const arr = adds.get(targetIndex) ?? []
          arr.push({ ...orig, startSec: safeStart })
          adds.set(targetIndex, arr)
        }
        return base.map((t, i) => ({ ...t, clips: [...t.clips, ...(adds.get(i) ?? [])] }))
      })
    } else {
      setTracks(ts => {
        const tsLookup = createTrackLookup(ts)
        const sourceTrackId = draggingIds?.trackId
        const srcIdx = sourceTrackId ? (tsLookup.trackIndexById.get(sourceTrackId) ?? -1) : -1
        if (srcIdx < 0) return ts
        const movingClip = tsLookup.clipById.get(movingClipId)
        if (!movingClip) return ts
        const duration = movingClip.duration
        const targetIdx = tsLookup.trackIndexById.get(targetId) ?? -1
        if (targetIdx < 0) return ts
        const targetTrack = ts[targetIdx]
        if (!canPlaceClipOnTrack(targetTrack, movingClip)) {
          return ts
        }

        if (srcIdx === targetIdx) {
          const overlap = willOverlap(targetTrack.clips, movingClip.id, desiredStart, duration)
          const newStart = options.gridEnabled()
            ? calcNonOverlapStartGridAligned(targetTrack.clips, movingClip.id, desiredStart, duration, options.bpm(), options.gridDenominator())
            : (overlap
                ? calcNonOverlapStart(targetTrack.clips, movingClip.id, desiredStart, duration)
                : desiredStart)
          return ts.map((t, i) => i !== srcIdx ? t : ({
            ...t,
            clips: t.clips.map(c => c.id === movingClip.id ? { ...c, startSec: newStart } : c)
          }))
        }

        const overlap = willOverlap(targetTrack.clips, null, desiredStart, duration)
        const newStart = options.gridEnabled()
          ? calcNonOverlapStartGridAligned(targetTrack.clips, null, desiredStart, duration, options.bpm(), options.gridDenominator())
          : (overlap
              ? calcNonOverlapStart(targetTrack.clips, null, desiredStart, duration)
              : desiredStart)
        const prunedTargetClips = targetTrack.clips.filter(c => c.id !== movingClip.id)
        return ts.map((t, i) => {
          if (i === srcIdx) return { ...t, clips: t.clips.filter(c => c.id !== movingClip.id) }
          if (i === targetIdx) return { ...t, clips: [...prunedTargetClips, { ...movingClip, startSec: newStart }] }
          return t
        })
      })
    }

    if (draggingIds.trackId !== targetId) {
      const clipId = draggingIds.clipId
      draggingIds = { trackId: targetId, clipId }
      if (!duplicationActive) {
        selectPrimaryClip(
          selectionSetters,
          { trackId: targetId, clipId },
          { preserveClipIds: !!multiDragging },
        )
      }
      updateDragState()
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
      let base = stripPreviews(tracks())

      // If dropping beyond last lane and no track was created during move, create one now
      if (laneIdx >= base.length && !addedTrackDuringDrag) {
        try {
          await ensureAddedTrackDuringDrag(tracks())
          base = stripPreviews(tracks())
        } catch {
          // if failed to create new track, cancel duplication cleanly
          cancelDuplicationDrag()
          return
        }
      }

      // Determine target track id
      let targetId: string | undefined
      if (laneIdx >= base.length && addedTrackDuringDrag) {
        targetId = addedTrackDuringDrag
      } else {
        laneIdx = Math.max(0, Math.min(laneIdx, base.length - 1))
        targetId = base[laneIdx]?.id
      }
      if (!targetId) { cancelDuplicationDrag(); return }

      const targetTrack = base.find(t => t.id === targetId)
      const uid = userId()
      if (targetTrack && targetTrack.lockedBy && targetTrack.lockedBy !== uid) { cancelDuplicationDrag(); return }

      // If Ctrl is not held anymore at drop, treat as cancel
      if (!event.ctrlKey) { cancelDuplicationDrag(); return }

      const plan: PendingClipCreate[] = []
      const baseLookup = createTrackLookup(base)
      const targetIdx = baseLookup.trackIndexById.get(targetId) ?? -1
      if (targetIdx < 0) { cancelDuplicationDrag(); return }

      // Build per-track pending adds to compute safe non-overlap starts
      const adds = new Map<number, Clip[]>()
      const pushPlan = (orig: Clip, toIdx: number, newStartSec: number) => {
        const existing = base[toIdx]?.clips ?? []
        const pending = adds.get(toIdx) ?? []
        const trackClipsForOverlap = [...existing, ...pending.filter(c => !isPreviewId(c.id))]
        const overlap = willOverlap(trackClipsForOverlap, null, newStartSec, orig.duration)
        const safeStart = options.gridEnabled()
          ? calcNonOverlapStartGridAligned(trackClipsForOverlap, null, newStartSec, orig.duration, options.bpm(), options.gridDenominator())
          : (overlap
              ? calcNonOverlapStart(trackClipsForOverlap, null, newStartSec, orig.duration)
              : newStartSec)
        const arr = adds.get(toIdx) ?? []
        arr.push({ ...orig, startSec: safeStart })
        adds.set(toIdx, arr)
        plan.push({
          trackId: base[toIdx].id,
          buffer: orig.buffer ?? options.audioBufferCache.get(orig.id) ?? null,
          clip: {
            startSec: safeStart,
            duration: orig.duration,
            name: orig.name,
            sampleUrl: orig.sampleUrl,
            source: getPersistableAudioSourceMetadata(orig),
            sourceAssetKey: orig.sourceAssetKey,
            sourceKind: orig.sourceKind,
            midi: orig.midi,
            timing: {
              leftPadSec: orig.leftPadSec,
              bufferOffsetSec: orig.bufferOffsetSec,
              midiOffsetBeats: orig.midiOffsetBeats,
            },
          },
        })
      }

      if (multiDragging) {
        const md = multiDragging
        if (!canPlaceMultiDrag(base, md, targetIdx, baseLookup)) { cancelDuplicationDrag(); return }
        const deltaIdx = targetIdx - md.anchorOrigTrackIdx
        for (const it of md.items) {
          const orig = findClipIn(baseLookup, it.clipId)
          if (!orig) continue
          const idx = Math.max(0, Math.min(base.length - 1, it.origTrackIdx + deltaIdx))
          let ns = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
          if (options.gridEnabled()) ns = quantizeSecToGrid(ns, options.bpm(), options.gridDenominator(), 'round')
          pushPlan(orig, idx, ns)
        }
      } else {
        const orig = findClipIn(baseLookup, draggingIds!.clipId)
        if (!orig) { cancelDuplicationDrag(); return }
        if (!canPlaceClipOnTrack(targetTrack, orig)) { cancelDuplicationDrag(); return }
        pushPlan(orig, targetIdx, desiredStart)
      }

      // Create duplicates on server
      const rid = roomId() as any
      const uidAny = userId() as any
      const created = await createManyClips({
        roomId: rid,
        userId: uidAny,
        items: plan,
        createMany: async (items) => await convexClient.mutation((convexApi as any).clips.createMany, { items }) as any as string[],
        audioBufferCache: options.audioBufferCache,
        grantClipWrites,
      })

      // Remove any previews and select freshly created clips
      setTracks(ts => stripPreviews(ts))
      const last = created[created.length - 1]
      if (last) {
        selectClipGroup(
          selectionSetters,
          { trackId: last.trackId, clipIds: created.map((item) => item.clipId), primaryClipId: last.clipId },
        )
      }

      // finalize
      if (addedTrackDuringDrag && created.some((item) => item.trackId === addedTrackDuringDrag)) {
        pushTrackCreateHistory(options.historyPush, roomId(), tracks(), tracks().find((entry) => entry.id === addedTrackDuringDrag))
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

    const currentTracks = tracks()

    if (laneIdx >= currentTracks.length && !addedTrackDuringDrag) {
      const newTrackId = await ensureAddedTrackDuringDrag(tracks())
      if (!newTrackId) {
        resetDragState()
        return
      }
      const moving = draggingIds!
      const mdOuter = multiDragging
      setTracks(ts => {
        const base = ts
        if (mdOuter) {
          const md = mdOuter
          const selIds = new Set(md.items.map(it => it.clipId))
          const cleared = base.map(t => ({ ...t, clips: t.clips.filter(c => !selIds.has(c.id)) }))
          const anchorTargetIdx = cleared.findIndex(t => t.id === newTrackId)
          const adds = new Map<number, Clip[]>()
          const findClip = (id: string): Clip | null => {
            for (const t of base) {
              const f = t.clips.find(c => c.id === id)
              if (f) return f
            }
            return null
          }
          for (const it of md.items) {
            const orig = findClip(it.clipId)
            if (!orig) continue
            const targetIndex = Math.max(0, Math.min(cleared.length - 1, anchorTargetIdx + (it.origTrackIdx - md.anchorOrigTrackIdx)))
            let newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
            if (options.gridEnabled()) {
              newStart = quantizeSecToGrid(newStart, options.bpm(), options.gridDenominator(), 'round')
            }
            const arr = adds.get(targetIndex) ?? []
            arr.push({ ...orig, startSec: newStart })
            adds.set(targetIndex, arr)
          }
          return cleared.map((t, i) => ({ ...t, clips: [...t.clips, ...(adds.get(i) ?? [])] }))
        }

        return base.map((t, i) => {
          const srcIdx = t.clips.some(c => c.id === moving!.clipId) ? i : -1
          if (srcIdx === i) return { ...t, clips: t.clips.filter(c => c.id !== moving!.clipId) }
          if (t.id === newTrackId) {
            for (const tt of ts) {
              const moved = tt.clips.find(c => c.id === moving!.clipId)
              if (moved) return { ...t, clips: [...t.clips, { ...moved, startSec: desiredStart }] }
            }
          }
          return t
        })
      })

      if (multiDragging) {
        const md = multiDragging
        const anchorTargetIdx = tracks().findIndex(tt => tt.id === newTrackId)
        for (const it of md.items) {
          const targetIndex = Math.max(0, Math.min(tracks().length - 1, anchorTargetIdx + (it.origTrackIdx - md.anchorOrigTrackIdx)))
          const targetTid = tracks()[targetIndex]?.id || newTrackId
          let newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
          if (options.gridEnabled()) {
            newStart = quantizeSecToGrid(newStart, options.bpm(), options.gridDenominator(), 'round')
          }
          void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, userId: userId() as any, startSec: newStart, toTrackId: targetTid as any })
          optimisticMoves.set(it.clipId, { trackId: targetTid, startSec: newStart })
        }
        selectPrimaryClip(
          selectionSetters,
          { trackId: newTrackId, clipId: moving!.clipId },
          { preserveClipIds: true },
        )
        // Notify moved clips committed
        try { options.onCommitMoves?.(md.items.map(it => it.clipId)) } catch {}
        // Push history move entry
        try {
          const rid = roomId()
          if (rid && typeof options.historyPush === 'function') {
            if (addedTrackDuringDrag === newTrackId) {
              pushTrackCreateHistory(options.historyPush, rid, tracks(), tracks().find((entry) => entry.id === newTrackId))
            }
            const tsNow = tracks()
            const anchorIdxNow = tsNow.findIndex(tt => tt.id === newTrackId)
            const deltaIdxNow = anchorIdxNow >= 0 ? anchorIdxNow - md.anchorOrigTrackIdx : 0
            const moves = md.items.map(it => {
              const fallbackTrackId = tsNow[it.origTrackIdx]?.id ?? prePositions.get(it.clipId)?.trackId ?? newTrackId
              const pre = prePositions.get(it.clipId) || { trackId: fallbackTrackId, startSec: it.origStartSec }
              const idx = Math.max(0, Math.min(tsNow.length - 1, (it.origTrackIdx + deltaIdxNow)))
              const postTrackId = tsNow[idx]?.id ?? newTrackId
              const postStart = optimisticMoves.get(it.clipId)?.startSec ?? it.origStartSec
              return { clipId: it.clipId, from: pre, to: { trackId: postTrackId, startSec: postStart } }
            })
            options.historyPush(buildClipsMoveHistoryEntry({ roomId: rid, tracks: tsNow, moves }))
          }
        } catch {}
      } else {
        selectPrimaryClip(
          selectionSetters,
          { trackId: newTrackId, clipId: moving!.clipId },
        )
        void convexClient.mutation(convexApi.clips.move, {
          clipId: moving!.clipId as any,
          userId: userId() as any,
          startSec: desiredStart,
          toTrackId: newTrackId as any,
        })
        optimisticMoves.set(moving!.clipId, { trackId: newTrackId, startSec: desiredStart })
        // Notify moved clip committed
        try { options.onCommitMoves?.([moving!.clipId]) } catch {}
        // Push history entries for auto-created track + move
        try {
          const rid = roomId()
          if (rid && typeof options.historyPush === 'function') {
            if (addedTrackDuringDrag === newTrackId) {
              pushTrackCreateHistory(options.historyPush, rid, tracks(), tracks().find((entry) => entry.id === newTrackId))
            }
            const pre = prePositions.get(moving!.clipId) || { trackId: newTrackId, startSec: desiredStart }
            options.historyPush(buildClipsMoveHistoryEntry({
              roomId: rid,
              tracks: tracks(),
              moves: [{ clipId: moving!.clipId, from: pre, to: { trackId: newTrackId, startSec: desiredStart } }],
            }))
          }
        } catch {}
      }
    } else {
      if (multiDragging) {
        const md = multiDragging
        const ts = tracks()
        laneIdx = Math.max(0, Math.min(laneIdx, ts.length - 1))
        const deltaIdx = laneIdx - md.anchorOrigTrackIdx
        const targetIdx = Math.max(0, Math.min(ts.length - 1, md.anchorOrigTrackIdx + deltaIdx))
        if (!canPlaceMultiDrag(ts, md, targetIdx)) {
          const tsLookup = createTrackLookup(ts)
          const selIds = new Set(md.items.map(it => it.clipId))
          const base = ts.map(track => ({ ...track, clips: track.clips.filter(clip => !selIds.has(clip.id)) }))
          const adds = new Map<string, Clip[]>()
          const moves: Array<{ clipId: string; from: { trackId: string; startSec: number }; to: { trackId: string; startSec: number } }> = []
          for (const it of md.items) {
            const orig = tsLookup.clipById.get(it.clipId)
            const pre = prePositions.get(it.clipId)
            const tid = pre?.trackId ?? ts[it.origTrackIdx]?.id
            if (!orig || !tid) continue
            let newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
            if (options.gridEnabled()) newStart = quantizeSecToGrid(newStart, options.bpm(), options.gridDenominator(), 'round')
            const trackIdx = base.findIndex(track => track.id === tid)
            if (trackIdx < 0) continue
            const trackClips = [...(base[trackIdx]?.clips ?? []), ...(adds.get(tid) ?? [])]
            const safeStart = options.gridEnabled()
              ? calcNonOverlapStartGridAligned(trackClips, it.clipId, newStart, it.duration, options.bpm(), options.gridDenominator())
              : (willOverlap(trackClips, it.clipId, newStart, it.duration)
                  ? calcNonOverlapStart(trackClips, it.clipId, newStart, it.duration)
                  : newStart)
            const arr = adds.get(tid) ?? []
            arr.push({ ...orig, startSec: safeStart })
            adds.set(tid, arr)
            moves.push({
              clipId: it.clipId,
              from: pre || { trackId: tid, startSec: it.origStartSec },
              to: { trackId: tid, startSec: safeStart },
            })
            void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, userId: userId() as any, startSec: safeStart, toTrackId: tid as any })
            optimisticMoves.set(it.clipId, { trackId: tid, startSec: safeStart })
          }
          if (moves.length === 0) {
            resetDragState()
            return
          }
          setTracks(base.map(track => ({ ...track, clips: [...track.clips, ...(adds.get(track.id) ?? [])] })))
          const anchorTrackId = prePositions.get(md.anchorClipId)?.trackId ?? ts[md.anchorOrigTrackIdx]?.id
          if (anchorTrackId) {
            selectPrimaryClip(
              selectionSetters,
              { trackId: anchorTrackId, clipId: md.anchorClipId },
              { preserveClipIds: true },
            )
          }
          try { options.onCommitMoves?.(moves.map(move => move.clipId)) } catch {}
          try {
            const rid = roomId()
            if (rid && typeof options.historyPush === 'function' && moves.length > 0) {
              options.historyPush(buildClipsMoveHistoryEntry({ roomId: rid, tracks: ts, moves }))
            }
          } catch {}
          resetDragState()
          return
        }
        for (const it of md.items) {
          let newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
          if (options.gridEnabled()) newStart = quantizeSecToGrid(newStart, options.bpm(), options.gridDenominator(), 'round')
          const idx = Math.max(0, Math.min(ts.length - 1, it.origTrackIdx + deltaIdx))
          const tid = ts[idx].id
          const trackClips = ts[idx].clips
          const safeStart = options.gridEnabled()
            ? calcNonOverlapStartGridAligned(trackClips, it.clipId, newStart, it.duration, options.bpm(), options.gridDenominator())
            : (willOverlap(trackClips, it.clipId, newStart, it.duration)
                ? calcNonOverlapStart(trackClips, it.clipId, newStart, it.duration)
                : newStart)
          void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, userId: userId() as any, startSec: safeStart, toTrackId: tid as any })
          optimisticMoves.set(it.clipId, { trackId: tid, startSec: safeStart })
        }
        const anchorIdx = Math.max(0, Math.min(ts.length - 1, md.anchorOrigTrackIdx + deltaIdx))
        const anchorTid = ts[anchorIdx].id
        selectPrimaryClip(
          selectionSetters,
          { trackId: anchorTid, clipId: md.anchorClipId },
          { preserveClipIds: true },
        )
        // Notify moved clips committed
        try { options.onCommitMoves?.(md.items.map(it => it.clipId)) } catch {}
      } else {
        const t = tracks().find(tt => tt.id === draggingIds!.trackId)
        const c = t?.clips.find(cc => cc.id === draggingIds!.clipId)
        if (c) {
          const destTrack = t
          if (!canPlaceClipOnTrack(destTrack, c)) {
            void convexClient.mutation(convexApi.clips.move, { clipId: c.id as any, userId: userId() as any, startSec: c.startSec })
            optimisticMoves.set(c.id, { trackId: t!.id, startSec: c.startSec })
          } else {
            void convexClient.mutation(convexApi.clips.move, {
            clipId: c.id as any,
            userId: userId() as any,
            startSec: c.startSec,
            toTrackId: t?.id as any,
            })
            optimisticMoves.set(c.id, { trackId: t!.id, startSec: c.startSec })
          }
          selectPrimaryClip(
            selectionSetters,
            { trackId: t!.id, clipId: c.id },
          )
          // Notify moved clip committed
          try { options.onCommitMoves?.([c.id]) } catch {}
          // Push history move entry (single)
          try {
            const rid = roomId()
            const pre = prePositions.get(c.id) || { trackId: t!.id, startSec: c.startSec }
            const to = { trackId: t!.id, startSec: c.startSec }
            if (rid && typeof options.historyPush === 'function') {
              options.historyPush(buildClipsMoveHistoryEntry({ roomId: rid, tracks: tracks(), moves: [{ clipId: c.id, from: pre, to }] }))
            }
          } catch {}
        }
      }
    }

    resetDragState()
  }

  onCleanup(() => {
    // remove any preview ghosts if present
    try { setTracks(ts => stripPreviews(ts)) } catch {}
    cleanupUnusedAddedTrack()
    setDragState(null)
  })

  return {
    onClipPointerDown,
    activeDrag: dragState,
  }
}
