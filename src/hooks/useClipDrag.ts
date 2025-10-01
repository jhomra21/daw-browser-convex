import { batch, createSignal, onCleanup, type Accessor, type Setter } from 'solid-js'

import { PPS, willOverlap, calcNonOverlapStart, yToLaneIndex, quantizeSecToGrid, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import type { Track, Clip, SelectedClip } from '~/types/timeline'

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

export type ClipDragHandlers = {
  onClipMouseDown: (trackId: string, clipId: string, event: MouseEvent) => void
  activeDrag: Accessor<DragSnapshot | null>
}

export type ClipDragOptions = {
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
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
}

export function useClipDrag(options: ClipDragOptions): ClipDragHandlers {
  const {
    tracks,
    setTracks,
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
  } = options

  let dragging = false
  let dragDeltaX = 0
  let draggingIds: { trackId: string; clipId: string } | null = null
  let addedTrackDuringDrag: string | null = null
  let creatingTrackDuringDrag = false
  let multiDragging: MultiDragSnapshot | null = null
  // Ctrl-drag duplication state
  let duplicationActive = false

  const PREVIEW_PREFIX = '__dup_preview:'
  const isPreviewId = (id: string) => id.startsWith(PREVIEW_PREFIX)
  const stripPreviews = (ts: Track[]) => ts.map(t => ({ ...t, clips: t.clips.filter(c => !isPreviewId(c.id)) }))
  const findClipIn = (ts: Track[], id: string): Clip | null => {
    for (const t of ts) {
      const c = t.clips.find(cc => cc.id === id)
      if (c) return c
    }
    return null
  }

  const getScrollRef = () => getScrollElement()

  const [dragState, setDragState] = createSignal<DragSnapshot | null>(null)

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

  const onClipMouseDown = (trackId: string, clipId: string, event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const currentTracks = tracks()
    const track = currentTracks.find(t => t.id === trackId)
    const clip = track?.clips.find(c => c.id === clipId)
    if (!track || !clip) return
    const uid = userId()
    if (track.lockedBy && track.lockedBy !== uid) {
      return
    }

    if (event.shiftKey) {
      batch(() => {
        setSelectedTrackId(trackId)
        setSelectedClip({ trackId, clipId })
        setSelectedFXTarget(trackId)
        setSelectedClipIds(prev => {
          const next = new Set<string>(prev)
          next.add(clipId)
          return next
        })
      })
      return
    }

    const selection = selectedClipIds()
    const isMultiDrag = selection.has(clipId) && selection.size > 1

    dragging = true
    duplicationActive = !!event.ctrlKey
    draggingIds = { trackId, clipId }
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
      setSelectedFXTarget(trackId)
      if (!isMultiDrag) {
        setSelectedClipIds(new Set([clipId]))
      }
    })

    if (isMultiDrag) {
      const anchorTrackIdx = currentTracks.findIndex(tt => tt.id === trackId)
      const items: MultiDragSnapshot['items'] = []
      for (const id of selection) {
        for (let i = 0; i < currentTracks.length; i++) {
          const found = currentTracks[i].clips.find(cc => cc.id === id)
          if (found) {
            items.push({ clipId: id, origTrackIdx: i, origStartSec: found.startSec, duration: found.duration })
            break
          }
        }
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

    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
    updateDragState()
  }

  const cancelDuplicationDrag = () => {
    setTracks(ts => stripPreviews(ts))
    dragging = false
    duplicationActive = false
    multiDragging = null
    addedTrackDuringDrag = null
    creatingTrackDuringDrag = false
    draggingIds = null
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    updateDragState()
  }

  const onWindowMouseMove = async (event: MouseEvent) => {
    if (!dragging || !draggingIds) return
    const scroll = getScrollRef()
    if (!scroll) return

    const currentTracks = tracks()
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

    if (laneIdx >= currentTracks.length) {
      if (!addedTrackDuringDrag && !creatingTrackDuringDrag) {
        creatingTrackDuringDrag = true
        try {
          const newTrackId = await convexClient.mutation(convexApi.tracks.create, { roomId: roomId(), userId: userId() }) as unknown as string
          addedTrackDuringDrag = newTrackId
          setTracks(ts => ts.some(t => t.id === newTrackId)
            ? ts
            : [...ts, { id: newTrackId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [], muted: false, soloed: false }])
        } finally {
          creatingTrackDuringDrag = false
        }
        updateDragState()
      }
    }

    let targetId: string | undefined
    const snapshot = tracks()
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

    const targetTrack = snapshot.find(t => t.id === targetId)
    const uid = userId()
    if (targetTrack && targetTrack.lockedBy && targetTrack.lockedBy !== uid) {
      if (duplicationActive) setTracks(ts => stripPreviews(ts))
      return
    }

    const movingClipId = draggingIds.clipId
    const movingClipSrcTrack = snapshot.find(t => t.clips.some(c => c.id === movingClipId))
    const movingClip = movingClipSrcTrack?.clips.find(c => c.id === movingClipId)
    // Block audio -> instrument during drag preview
    if (targetTrack?.kind === 'instrument' && movingClip && !(movingClip as any).midi) {
      if (duplicationActive) setTracks(ts => stripPreviews(ts))
      return
    }
    // Block MIDI -> audio during drag preview
    if (targetTrack && targetTrack.kind !== 'instrument' && movingClip && (movingClip as any).midi) {
      if (duplicationActive) setTracks(ts => stripPreviews(ts))
      return
    }

    // Duplication mode: create visual ghost previews (no server calls, originals untouched)
    if (duplicationActive) {
      const base = stripPreviews(tracks())
      const targetIdx = base.findIndex(t => t.id === targetId)
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
        if (targetTrack?.kind === 'instrument') {
          // if any audio in selection, skip preview into instrument
          const hasAudio = md.items.some(it => {
            const c = findClipIn(base, it.clipId)
            return c && !(c as any).midi
          })
          if (hasAudio) {
            setTracks(ts => stripPreviews(ts))
            return
          }
        } else if (targetTrack) {
          // if any MIDI in selection, skip preview into audio track
          const hasMidi = md.items.some(it => {
            const c = findClipIn(base, it.clipId)
            return c && (c as any).midi
          })
          if (hasMidi) {
            setTracks(ts => stripPreviews(ts))
            return
          }
        }
        const deltaIdx = targetIdx - md.anchorOrigTrackIdx
        for (const it of md.items) {
          const orig = findClipIn(base, it.clipId)
          if (!orig) continue
          const idx = Math.max(0, Math.min(base.length - 1, it.origTrackIdx + deltaIdx))
          let ns = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
          if (options.gridEnabled()) ns = quantizeSecToGrid(ns, options.bpm(), options.gridDenominator(), 'round')
          pushClone(orig, idx, ns)
        }
      } else {
        const orig = findClipIn(base, movingClipId)
        if (!orig) return
        if (targetTrack?.kind === 'instrument' && !(orig as any).midi) {
          setTracks(ts => stripPreviews(ts))
          return
        }
        if (targetTrack && targetTrack.kind !== 'instrument' && (orig as any).midi) {
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
        const targetIdx = ts.findIndex(t => t.id === targetId)
        if (targetIdx < 0) return ts
        const deltaIdx = targetIdx - multi.anchorOrigTrackIdx
        const base = ts.map(t => ({ ...t, clips: t.clips.filter(c => !selIds.has(c.id)) }))
        const adds = new Map<number, Clip[]>()
        const findClip = (id: string): Clip | null => {
          for (const t of ts) {
            const f = t.clips.find(c => c.id === id)
            if (f) return f
          }
          return null
        }
        for (const it of multi.items) {
          const orig = findClip(it.clipId)
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
        const srcIdx = ts.findIndex(t => t.clips.some(c => c.id === movingClipId))
        if (srcIdx < 0) return ts
        const movingClip = ts[srcIdx].clips.find(c => c.id === movingClipId)!
        const duration = movingClip.duration
        const targetIdx = ts.findIndex(t => t.id === targetId)
        if (targetIdx < 0) return ts
        const targetTrack = ts[targetIdx]
        // Block moving audio into instrument track
        if (targetTrack.kind === 'instrument' && !(movingClip as any).midi) {
          return ts
        }
        // Block moving MIDI into audio track
        if (targetTrack.kind !== 'instrument' && (movingClip as any).midi) {
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
        batch(() => {
          setSelectedTrackId(targetId)
          setSelectedFXTarget(targetId)
          setSelectedClip({ trackId: targetId, clipId })
          if (!multiDragging) setSelectedClipIds(new Set([clipId]))
        })
      }
      updateDragState()
    }
  }

  const onWindowMouseUp = async (event: MouseEvent) => {
    if (!dragging || !draggingIds) {
      dragging = false
      multiDragging = null
      addedTrackDuringDrag = null
      creatingTrackDuringDrag = false
      window.removeEventListener('mousemove', onWindowMouseMove)
      window.removeEventListener('mouseup', onWindowMouseUp)
      updateDragState()
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
          const newTrackId = await convexClient.mutation(convexApi.tracks.create, { roomId: roomId(), userId: userId() }) as unknown as string
          addedTrackDuringDrag = newTrackId
          setTracks(ts => ts.some(t => t.id === newTrackId)
            ? ts
            : [...ts, { id: newTrackId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [], muted: false, soloed: false }])
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

      type Pending = { trackId: string; name?: string; duration: number; startSec: number; buffer: AudioBuffer | null; color: string; sampleUrl?: string; midi?: any; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number }
      const plan: Pending[] = []
      const targetIdx = base.findIndex(t => t.id === targetId)
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
          name: orig.name,
          duration: orig.duration,
          startSec: safeStart,
          buffer: orig.buffer ?? options.audioBufferCache.get(orig.id) ?? null,
          color: orig.color,
          sampleUrl: orig.sampleUrl,
          midi: (orig as any).midi,
          leftPadSec: orig.leftPadSec,
          bufferOffsetSec: (orig as any).bufferOffsetSec,
          midiOffsetBeats: (orig as any).midiOffsetBeats,
        })
      }

      if (multiDragging) {
        const md = multiDragging
        if (targetTrack?.kind === 'instrument') {
          const hasAudio = md.items.some(it => {
            const c = findClipIn(base, it.clipId)
            return c && !(c as any).midi
          })
          if (hasAudio) { cancelDuplicationDrag(); return }
        } else if (targetTrack) {
          const hasMidi = md.items.some(it => {
            const c = findClipIn(base, it.clipId)
            return c && (c as any).midi
          })
          if (hasMidi) { cancelDuplicationDrag(); return }
        }
        const deltaIdx = targetIdx - md.anchorOrigTrackIdx
        for (const it of md.items) {
          const orig = findClipIn(base, it.clipId)
          if (!orig) continue
          const idx = Math.max(0, Math.min(base.length - 1, it.origTrackIdx + deltaIdx))
          let ns = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
          if (options.gridEnabled()) ns = quantizeSecToGrid(ns, options.bpm(), options.gridDenominator(), 'round')
          pushPlan(orig, idx, ns)
        }
      } else {
        const orig = findClipIn(base, draggingIds!.clipId)
        if (!orig) { cancelDuplicationDrag(); return }
        if (targetTrack?.kind === 'instrument' && !(orig as any).midi) { cancelDuplicationDrag(); return }
        if (targetTrack && targetTrack.kind !== 'instrument' && (orig as any).midi) { cancelDuplicationDrag(); return }
        pushPlan(orig, targetIdx, desiredStart)
      }

      // Create duplicates on server
      const rid = roomId() as any
      const uidAny = userId() as any
      const idsCreated = await convexClient.mutation((convexApi as any).clips.createMany, {
        items: plan.map(p => ({
          roomId: rid,
          trackId: p.trackId as any,
          startSec: p.startSec,
          duration: p.duration,
          userId: uidAny,
          name: p.name,
          ...(p.midi ? { midi: p.midi } : {}),
          leftPadSec: p.leftPadSec,
          bufferOffsetSec: p.bufferOffsetSec,
          midiOffsetBeats: p.midiOffsetBeats,
        }))
      }) as any as string[]

      const createdIds: { trackId: string; clipId: string }[] = []
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i]
        const newId = idsCreated[i]
        if (!newId) continue
        if (p.buffer) options.audioBufferCache.set(newId, p.buffer)
        createdIds.push({ trackId: p.trackId, clipId: newId })
        if (p.sampleUrl) {
          void convexClient.mutation((convexApi as any).clips.setSampleUrl, { clipId: newId as any, sampleUrl: p.sampleUrl })
        }
        if (p.midi) {
          try { await convexClient.mutation((convexApi as any).clips.setMidi, { clipId: newId as any, midi: p.midi, userId: uidAny }) } catch {}
        }
        if (
          (typeof p.leftPadSec === 'number' && Number.isFinite(p.leftPadSec)) ||
          (typeof p.bufferOffsetSec === 'number' && Number.isFinite(p.bufferOffsetSec)) ||
          (typeof p.midiOffsetBeats === 'number' && Number.isFinite(p.midiOffsetBeats))
        ) {
          void convexClient.mutation((convexApi as any).clips.setTiming, { clipId: newId as any, startSec: p.startSec, duration: p.duration, leftPadSec: p.leftPadSec ?? 0, bufferOffsetSec: p.bufferOffsetSec ?? 0, midiOffsetBeats: p.midiOffsetBeats ?? 0 })
        }
      }

      // Remove any previews and select freshly created clips
      setTracks(ts => stripPreviews(ts))
      const last = createdIds[createdIds.length - 1]
      if (last) {
        batch(() => {
          setSelectedTrackId(last.trackId)
          setSelectedFXTarget(last.trackId)
          setSelectedClip({ trackId: last.trackId, clipId: last.clipId })
          setSelectedClipIds(new Set<string>(createdIds.map(i => i.clipId)))
        })
      }

      // finalize
      dragging = false
      duplicationActive = false
      multiDragging = null
      addedTrackDuringDrag = null
      creatingTrackDuringDrag = false
      draggingIds = null
      window.removeEventListener('mousemove', onWindowMouseMove)
      window.removeEventListener('mouseup', onWindowMouseUp)
      updateDragState()
      return
    }

    const currentTracks = tracks()

    if (laneIdx >= currentTracks.length && !addedTrackDuringDrag) {
      const newTrackId = await convexClient.mutation(convexApi.tracks.create, { roomId: roomId(), userId: userId() }) as unknown as string
      const moving = draggingIds!
      const mdOuter = multiDragging
      setTracks(ts => {
        const hasNew = ts.some(t => t.id === newTrackId)
        const newTrack: Track = { id: newTrackId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [], muted: false, soloed: false }
        const base = hasNew ? ts : [...ts, newTrack]
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
          void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, startSec: newStart, toTrackId: targetTid as any })
          optimisticMoves.set(it.clipId, { trackId: targetTid, startSec: newStart })
        }
        batch(() => {
          setSelectedTrackId(newTrackId)
          setSelectedFXTarget(newTrackId)
          setSelectedClip({ trackId: newTrackId, clipId: moving!.clipId })
        })
        // Notify moved clips committed
        try { options.onCommitMoves?.(md.items.map(it => it.clipId)) } catch {}
      } else {
        batch(() => {
          setSelectedTrackId(newTrackId)
          setSelectedFXTarget(newTrackId)
          setSelectedClip({ trackId: newTrackId, clipId: moving!.clipId })
          setSelectedClipIds(new Set([moving!.clipId]))
        })
        void convexClient.mutation(convexApi.clips.move, {
          clipId: moving!.clipId as any,
          startSec: desiredStart,
          toTrackId: newTrackId as any,
        })
        optimisticMoves.set(moving!.clipId, { trackId: newTrackId, startSec: desiredStart })
        // Notify moved clip committed
        try { options.onCommitMoves?.([moving!.clipId]) } catch {}
      }
    } else {
      if (multiDragging) {
        const md = multiDragging
        const ts = tracks()
        laneIdx = Math.max(0, Math.min(laneIdx, ts.length - 1))
        const deltaIdx = laneIdx - md.anchorOrigTrackIdx
        // Block any audio item moving into an instrument target
        const targetIdx = Math.max(0, Math.min(ts.length - 1, md.anchorOrigTrackIdx + deltaIdx))
        const targetTrack = ts[targetIdx]
        if (targetTrack?.kind === 'instrument') {
          const hasAudio = md.items.some(it => {
            const t = ts.find(tt => tt.clips.some(c => c.id === it.clipId))
            const c = t?.clips.find(cc => cc.id === it.clipId)
            return c && !(c as any).midi
          })
          if (hasAudio) {
            // Cancel cross-track move; just snap start within original tracks
            for (const it of md.items) {
              let newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
              if (options.gridEnabled()) newStart = quantizeSecToGrid(newStart, options.bpm(), options.gridDenominator(), 'round')
              const trackClips = ts[it.origTrackIdx].clips
              const safeStart = options.gridEnabled()
                ? calcNonOverlapStartGridAligned(trackClips, it.clipId, newStart, it.duration, options.bpm(), options.gridDenominator())
                : (willOverlap(trackClips, it.clipId, newStart, it.duration)
                    ? calcNonOverlapStart(trackClips, it.clipId, newStart, it.duration)
                    : newStart)
              void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, startSec: safeStart })
              optimisticMoves.set(it.clipId, { trackId: ts[it.origTrackIdx].id, startSec: safeStart })
            }
            updateDragState()
            dragging = false
            multiDragging = null
            addedTrackDuringDrag = null
            creatingTrackDuringDrag = false
            window.removeEventListener('mousemove', onWindowMouseMove)
            window.removeEventListener('mouseup', onWindowMouseUp)
            return
          }
        } else if (targetTrack) {
          const hasMidi = md.items.some(it => {
            const t = ts.find(tt => tt.clips.some(c => c.id === it.clipId))
            const c = t?.clips.find(cc => cc.id === it.clipId)
            return c && (c as any).midi
          })
          if (hasMidi) {
            // Cancel cross-track move; just snap start within original tracks
            for (const it of md.items) {
              let newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
              if (options.gridEnabled()) newStart = quantizeSecToGrid(newStart, options.bpm(), options.gridDenominator(), 'round')
              const trackClips = ts[it.origTrackIdx].clips
              const safeStart = options.gridEnabled()
                ? calcNonOverlapStartGridAligned(trackClips, it.clipId, newStart, it.duration, options.bpm(), options.gridDenominator())
                : (willOverlap(trackClips, it.clipId, newStart, it.duration)
                    ? calcNonOverlapStart(trackClips, it.clipId, newStart, it.duration)
                    : newStart)
              void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, startSec: safeStart })
              optimisticMoves.set(it.clipId, { trackId: ts[it.origTrackIdx].id, startSec: safeStart })
            }
            updateDragState()
            dragging = false
            multiDragging = null
            addedTrackDuringDrag = null
            creatingTrackDuringDrag = false
            window.removeEventListener('mousemove', onWindowMouseMove)
            window.removeEventListener('mouseup', onWindowMouseUp)
            return
          }
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
          void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, startSec: safeStart, toTrackId: tid as any })
          optimisticMoves.set(it.clipId, { trackId: tid, startSec: safeStart })
        }
        const anchorIdx = Math.max(0, Math.min(ts.length - 1, md.anchorOrigTrackIdx + deltaIdx))
        const anchorTid = ts[anchorIdx].id
        batch(() => {
          setSelectedTrackId(anchorTid)
          setSelectedFXTarget(anchorTid)
          setSelectedClip({ trackId: anchorTid, clipId: md.anchorClipId })
        })
        // Notify moved clips committed
        try { options.onCommitMoves?.(md.items.map(it => it.clipId)) } catch {}
      } else {
        const t = tracks().find(tt => tt.id === draggingIds!.trackId)
        const c = t?.clips.find(cc => cc.id === draggingIds!.clipId)
        if (c) {
          // If destination is instrument but clip is audio, keep track and only update start
          const destTrack = t
          if (destTrack?.kind === 'instrument' && !(c as any).midi) {
            void convexClient.mutation(convexApi.clips.move, { clipId: c.id as any, startSec: c.startSec })
            optimisticMoves.set(c.id, { trackId: t!.id, startSec: c.startSec })
          } else if (destTrack && destTrack.kind !== 'instrument' && (c as any).midi) {
            // If destination is audio but clip is MIDI, keep track and only update start
            void convexClient.mutation(convexApi.clips.move, { clipId: c.id as any, startSec: c.startSec })
            optimisticMoves.set(c.id, { trackId: t!.id, startSec: c.startSec })
          } else {
            void convexClient.mutation(convexApi.clips.move, {
            clipId: c.id as any,
            startSec: c.startSec,
            toTrackId: t?.id as any,
            })
            optimisticMoves.set(c.id, { trackId: t!.id, startSec: c.startSec })
          }
          batch(() => {
            setSelectedClip({ trackId: t!.id, clipId: c.id })
            setSelectedClipIds(new Set([c.id]))
          })
          // Notify moved clip committed
          try { options.onCommitMoves?.([c.id]) } catch {}
        }
      }
    }

    dragging = false
    multiDragging = null
    addedTrackDuringDrag = null
    creatingTrackDuringDrag = false
    draggingIds = null
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    updateDragState()
  }

  onCleanup(() => {
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    // remove any preview ghosts if present
    try { setTracks(ts => stripPreviews(ts)) } catch {}
    setDragState(null)
  })

  return {
    onClipMouseDown,
    activeDrag: dragState,
  }
}
