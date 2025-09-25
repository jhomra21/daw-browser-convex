import { batch, createSignal, onCleanup, type Accessor, type Setter } from 'solid-js'

import { PPS, willOverlap, calcNonOverlapStart, yToLaneIndex } from '~/lib/timeline-utils'
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

  const getScrollRef = () => getScrollElement()

  const [dragState, setDragState] = createSignal<DragSnapshot | null>(null)

  const updateDragState = () => {
    if (dragging && draggingIds) {
      setDragState({
        draggingIds,
        multiDragging,
        addedTrackDuringDrag,
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

    if (event.shiftKey) {
      batch(() => {
        setSelectedTrackId(trackId)
        setSelectedClip({ trackId, clipId })
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
    draggingIds = { trackId, clipId }
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
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

  const onWindowMouseMove = async (event: MouseEvent) => {
    if (!dragging || !draggingIds) return
    const scroll = getScrollRef()
    if (!scroll) return

    const rect = scroll.getBoundingClientRect()
    const x = event.clientX - rect.left - dragDeltaX + (scroll.scrollLeft || 0)
    const desiredStart = Math.max(0, x / PPS)
    let laneIdx = yToLaneIndex(event.clientY, scroll)

    if (laneIdx >= tracks().length) {
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
    if (!targetId) return

    const movingClipId = draggingIds.clipId

    if (multiDragging) {
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
          const newStart = Math.max(0, desiredStart + (it.origStartSec - multi.anchorOrigStartSec))
          const arr = adds.get(targetIndex) ?? []
          arr.push({ ...orig, startSec: newStart })
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

        if (srcIdx === targetIdx) {
          const overlap = willOverlap(targetTrack.clips, movingClip.id, desiredStart, duration)
          const newStart = overlap ? calcNonOverlapStart(targetTrack.clips, movingClip.id, desiredStart, duration) : desiredStart
          return ts.map((t, i) => i !== srcIdx ? t : ({
            ...t,
            clips: t.clips.map(c => c.id === movingClip.id ? { ...c, startSec: newStart } : c)
          }))
        }

        const overlap = willOverlap(targetTrack.clips, null, desiredStart, duration)
        const newStart = overlap ? calcNonOverlapStart(targetTrack.clips, null, desiredStart, duration) : desiredStart
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
      batch(() => {
        setSelectedTrackId(targetId)
        setSelectedFXTarget(targetId)
        setSelectedClip({ trackId: targetId, clipId })
        if (!multiDragging) setSelectedClipIds(new Set([clipId]))
      })
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
    const desiredStart = Math.max(0, x / PPS)
    let laneIdx = yToLaneIndex(event.clientY, scroll)

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
            const newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
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
          const newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
          void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, startSec: newStart, toTrackId: targetTid as any })
          optimisticMoves.set(it.clipId, { trackId: targetTid, startSec: newStart })
        }
        batch(() => {
          setSelectedTrackId(newTrackId)
          setSelectedFXTarget(newTrackId)
          setSelectedClip({ trackId: newTrackId, clipId: moving!.clipId })
        })
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
      }
    } else {
      if (multiDragging) {
        const md = multiDragging
        const ts = tracks()
        laneIdx = Math.max(0, Math.min(laneIdx, ts.length - 1))
        const deltaIdx = laneIdx - md.anchorOrigTrackIdx
        for (const it of md.items) {
          const newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
          const idx = Math.max(0, Math.min(ts.length - 1, it.origTrackIdx + deltaIdx))
          const tid = ts[idx].id
          void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, startSec: newStart, toTrackId: tid as any })
          optimisticMoves.set(it.clipId, { trackId: tid, startSec: newStart })
        }
        const anchorIdx = Math.max(0, Math.min(ts.length - 1, md.anchorOrigTrackIdx + deltaIdx))
        const anchorTid = ts[anchorIdx].id
        batch(() => {
          setSelectedTrackId(anchorTid)
          setSelectedFXTarget(anchorTid)
          setSelectedClip({ trackId: anchorTid, clipId: md.anchorClipId })
        })
      } else {
        const t = tracks().find(tt => tt.id === draggingIds!.trackId)
        const c = t?.clips.find(cc => cc.id === draggingIds!.clipId)
        if (c) {
          void convexClient.mutation(convexApi.clips.move, {
            clipId: c.id as any,
            startSec: c.startSec,
            toTrackId: t?.id as any,
          })
          optimisticMoves.set(c.id, { trackId: t!.id, startSec: c.startSec })
          batch(() => {
            setSelectedClip({ trackId: t!.id, clipId: c.id })
            setSelectedClipIds(new Set([c.id]))
          })
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
    setDragState(null)
  })

  return {
    onClipMouseDown,
    activeDrag: dragState,
  }
}
