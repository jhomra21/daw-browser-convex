import { type Component, Show, For, createEffect, createSignal, onCleanup, onMount, batch, untrack } from 'solid-js'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '~/components/ui/dialog'
import type { Track, Clip, SelectedClip } from '~/types/timeline'
import { AudioEngine } from '~/lib/audio-engine'
import { timelineDurationSec, clientXToSec, yToLaneIndex, willOverlap, calcNonOverlapStart, PPS, RULER_HEIGHT, LANE_HEIGHT } from '~/lib/timeline-utils'
import { useTimelineKeyboard } from '~/hooks/useTimelineKeyboard'
import { useTimelinePlayback } from '~/hooks/useTimelinePlayback'
import TransportControls from './timeline/TransportControls'
import TimelineRuler from './timeline/TimelineRuler'
import TrackLane from './timeline/TrackLane'
import TrackSidebar from './timeline/TrackSidebar'
import EffectsPanel from './timeline/EffectsPanel'
import { Button } from './ui/button'
import { useConvexQuery, convexClient, convexApi } from '~/lib/convex'
import { useSessionQuery } from '~/lib/session'
const Timeline: Component = () => {
  // State
  const [tracks, setTracks] = createSignal<Track[]>([])
  const [selectedTrackId, setSelectedTrackId] = createSignal('')
  const [selectedClip, setSelectedClip] = createSignal<SelectedClip>(null)
  const [bottomFXOpen, setBottomFXOpen] = createSignal(true)
  const [selectedFXTarget, setSelectedFXTarget] = createSignal<string>('master')
  const [sidebarWidth, setSidebarWidth] = createSignal(260)
  const [confirmOpen, setConfirmOpen] = createSignal(false)
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<string | null>(null)

  // Audio engine
  const audioEngine = new AudioEngine()
  // Collaboration: roomId from ?roomId=; ownership tied to Better Auth userId
  const [roomId, setRoomId] = createSignal<string>('')
  const session = useSessionQuery()
  const userId = () => (session()?.data?.user as any)?.id ?? ''

  // Track clip loading state to avoid duplicate fetches/decodes
  const loadingClipIds = new Set<string>()

  async function uploadToR2(room: string, clip: string, file: File, durationSec?: number): Promise<string | null> {
    try {
      const fd = new FormData()
      fd.append('roomId', room)
      fd.append('clipId', clip)
      fd.append('file', file, file.name)
      if (typeof durationSec === 'number' && isFinite(durationSec)) {
        fd.append('duration', String(durationSec))
      }
      const res = await fetch('/api/samples', { method: 'POST', body: fd })
      if (!res.ok) return null
      const data: any = await res.json().catch(() => null as any)
      return data?.url ?? null
    } catch {
      return null
    }
  }

  async function ensureClipBuffer(clipId: string, sampleUrl?: string) {
    if (audioBufferCache.has(clipId) || loadingClipIds.has(clipId)) return
    loadingClipIds.add(clipId)
    try {
      if (sampleUrl) {
        const res = await fetch(sampleUrl)
        if (res.ok) {
          const ab = await res.arrayBuffer()
          const decoded = await audioEngine.decodeAudioData(ab)
          audioBufferCache.set(clipId, decoded)
          setTracks(ts => ts.map(t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? { ...c, buffer: decoded } : c)
          })))
        }
      }
    } catch {
      // Ignore errors; buffer remains unset
    } finally {
      loadingClipIds.delete(clipId)
    }
  }

  onMount(() => {
    // Resolve roomId from URL or create a new one
    try {
      const url = new URL(window.location.href)
      let rid = url.searchParams.get('roomId')
      if (!rid) {
        rid = crypto.randomUUID()
        url.searchParams.set('roomId', rid)
        history.replaceState(null, '', url.toString())
      }
      setRoomId(rid)
    } catch {
      setRoomId('default')
    }

    // Cloud-only mode: no local clip name cache
  })

  // Ensure the current room appears in the user's project list
  createEffect(() => {
    const rid = roomId()
    const uid = userId()
    if (!rid || !uid) return
    // Fire and forget; if it already exists, this is a no-op
    void convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: rid, userId: uid })
  })

  function navigateToRoom(rid: string) {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('roomId', rid)
      history.pushState(null, '', url.toString())
      setRoomId(rid)
    } catch {
      setRoomId(rid)
    }
  }
  // Local caches for responsiveness
  const audioBufferCache = new Map<string, AudioBuffer>()
  const volumeTimers = new Map<string, number>()
  
  // Playback hook
  const { isPlaying, playheadSec, handlePlay, handlePause, handleStop, setPlayhead } = useTimelinePlayback(audioEngine)

  // Share current URL with ?roomId=
  async function handleShare() {
    try {
      const url = new URL(window.location.href)
      let rid = url.searchParams.get('roomId')
      if (!rid) {
        rid = roomId() || crypto.randomUUID()
        url.searchParams.set('roomId', rid)
        history.replaceState(null, '', url.toString())
        setRoomId(rid)
      }
    } catch {}
  }

  // DOM refs
  let scrollRef: HTMLDivElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let containerRef: HTMLDivElement | undefined
  
  // Sidebar resize state
  let resizing = false
  let resizeStartX = 0
  let resizeStartWidth = 0

  // Scrubbing helpers
  let scrubbing = false

  function startScrub(clientX: number) {
    const sec = clientXToSec(clientX, scrollRef!)
    setPlayhead(sec, tracks())
    scrubbing = true
    window.addEventListener('mousemove', onScrubMove)
    window.addEventListener('mouseup', onScrubEnd)
  }

  function onScrubMove(e: MouseEvent) {
    if (!scrubbing) return
    const sec = clientXToSec(e.clientX, scrollRef!)
    setPlayhead(sec, tracks())
  }

  function onScrubEnd() {
    if (!scrubbing) return
    scrubbing = false
    window.removeEventListener('mousemove', onScrubMove)
    window.removeEventListener('mouseup', onScrubEnd)
  }

  // Keep audio engine synced with tracks
  createEffect(() => {
    audioEngine.updateTrackGains(tracks())
  })

  // Subscribe to Convex shared state (tracks + clips) for this room
  const fullView = useConvexQuery(
    convexApi.timeline.fullView,
    () => roomId() ? ({ roomId: roomId() }) : null,
    () => ['timeline', roomId()]
  )

  // Project server state into local Track[] while preserving ephemeral fields
  createEffect(() => {
    const raw = (fullView as any).data
    const data = typeof raw === 'function' ? raw() : raw
    if (!data) return

    // Read old tracks without tracking to avoid creating a feedback loop
    const oldTracks = untrack(() => tracks())
    const oldTrackMap = new Map(oldTracks.map(t => [t.id, t]))

    const projected: Track[] = data.tracks.map((t: any, idx: number) => {
      const id = t._id as string
      const prev = oldTrackMap.get(id)
      return {
        id,
        name: prev?.name ?? `Track ${idx + 1}`,
        volume: typeof t.volume === 'number' ? t.volume : 0.8,
        clips: []
      }
    })

    const projectedMap = new Map(projected.map(t => [t.id, t]))

    // If we've created a track during drag that hasn't arrived from the server yet,
    // inject a placeholder so the UI remains stable while dragging.
    if (addedTrackDuringDrag && !projectedMap.has(addedTrackDuringDrag)) {
      const prev = oldTrackMap.get(addedTrackDuringDrag)
      const placeholder: Track = {
        id: addedTrackDuringDrag,
        name: prev?.name ?? `Track ${projected.length + 1}`,
        volume: prev?.volume ?? 0.8,
        clips: []
      }
      projected.push(placeholder)
      projectedMap.set(placeholder.id, placeholder)
    }

    for (const c of data.clips as any[]) {
      const trackId = c.trackId as string
      const t = projectedMap.get(trackId)
      if (!t) continue
      const prevTrack = oldTrackMap.get(trackId)
      const prevClip = prevTrack?.clips.find(cc => cc.id === (c._id as string))
      const buffer = audioBufferCache.get(c._id as string) ?? prevClip?.buffer ?? null
      const name = (c as any).name ?? prevClip?.name ?? 'Clip'
      const color = prevClip?.color ?? '#22c55e'
      t.clips.push({
        id: c._id as string,
        name,
        buffer,
        startSec: c.startSec as number,
        duration: c.duration as number,
        color,
        sampleUrl: (c as any).sampleUrl as string | undefined,
      })
    }

    // If a drag is in progress, override the dragged clip's projected location with the local (optimistic) one
    if (draggingIds) {
      const localTracks = untrack(() => tracks())
      const localTrack = localTracks.find(tt => tt.clips.some(cc => cc.id === draggingIds!.clipId))
      const localClip = localTrack?.clips.find(cc => cc.id === draggingIds!.clipId)
      if (localClip) {
        // Remove the dragged clip from any projected track to avoid duplicates
        for (const t of projected) {
          t.clips = t.clips.filter(cc => cc.id !== localClip.id)
        }
        // Place it into the projected target track according to current draggingIds
        const targetProjected = projectedMap.get(draggingIds!.trackId)
        if (targetProjected) {
          targetProjected.clips.push({
            id: localClip.id,
            name: localClip.name,
            buffer: localClip.buffer ?? null,
            startSec: localClip.startSec,
            duration: localClip.duration,
            color: localClip.color,
            sampleUrl: localClip.sampleUrl,
          })
        }
      }
    }

    setTracks(projected)
    if (!selectedTrackId() && projected.length > 0) {
      batch(() => {
        setSelectedTrackId(projected[0].id)
        setSelectedFXTarget(projected[0].id)
      })
    }
  })

  onCleanup(() => {
    try { window.removeEventListener('mousemove', onScrubMove) } catch {}
    try { window.removeEventListener('mouseup', onScrubEnd) } catch {}
    try { window.removeEventListener('mousemove', onWindowMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onWindowMouseUp) } catch {}
    try { window.removeEventListener('mousemove', onSidebarMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onSidebarMouseUp) } catch {}
    audioEngine.close()
  })

  // Drag & drop
  function onDragOver(e: DragEvent) {
    e.preventDefault()
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (!file || !file.type.startsWith('audio')) return

    // We no longer capture or persist FileSystemFileHandle; rely on cloud URL (R2)

    const ab = await file.arrayBuffer()
    const decoded = await audioEngine.decodeAudioData(ab)

    const desiredStart = clientXToSec(e.clientX, scrollRef!)
    let laneIdx = yToLaneIndex(e.clientY, scrollRef!)

    const ts0 = tracks()
    let targetTrackId: string
    if (ts0.length === 0 || laneIdx >= ts0.length || laneIdx < 0) {
      // Create a new shared track on the server
      const createdId = await convexClient.mutation(convexApi.tracks.create, { roomId: roomId(), userId: userId() }) as any as string
      targetTrackId = createdId
    } else {
      laneIdx = Math.max(0, Math.min(laneIdx, ts0.length - 1))
      targetTrackId = ts0[laneIdx]?.id || ''
    }

    // Resolve non-overlapping start against current local clips of the target track
    let startSec = desiredStart
    const targetTrack = tracks().find(t => t.id === targetTrackId)
    if (targetTrack && willOverlap(targetTrack.clips, null, startSec, decoded.duration)) {
      startSec = calcNonOverlapStart(targetTrack.clips, null, startSec, decoded.duration)
    }

    // Create a shared clip on the server and attach the decoded buffer locally
    const createdClipId = await convexClient.mutation(convexApi.clips.create, {
      roomId: roomId(),
      trackId: targetTrackId as any,
      startSec,
      duration: decoded.duration,
      userId: userId(),
      name: file.name,
    }) as any as string

    audioBufferCache.set(createdClipId, decoded)
    // No local file handle persistence
    ;(async () => {
      const url = await uploadToR2(roomId(), createdClipId, file, decoded.duration)
      if (url) {
        try { await convexClient.mutation(convexApi.clips.setSampleUrl, { clipId: createdClipId as any, sampleUrl: url }) } catch {}
        // Update local state with sampleUrl
        setTracks(ts => ts.map(t => ({
          ...t,
          clips: t.clips.map(c => c.id === createdClipId ? { ...c, sampleUrl: url } : c)
        })))
      }
    })()
    // Optimistic local insert so playback works immediately (de-duped)
    setTracks(ts => {
      const idx = ts.findIndex(t => t.id === targetTrackId)
      if (idx === -1) {
        // Add local placeholder track then insert the clip
        const newTrack: Track = { id: targetTrackId, name: `Track ${ts.length + 1}` , volume: 0.8, clips: [] }
        const newClip: Clip = { id: createdClipId, name: file.name, buffer: decoded, startSec, duration: decoded.duration, color: '#22c55e' }
        return [...ts, { ...newTrack, clips: [newClip] }]
      }
      const track = ts[idx]
      const existsIdx = track.clips.findIndex(c => c.id === createdClipId)
      if (existsIdx >= 0) {
        // Update existing clip in place (name/buffer) to avoid duplicate overlay
        const updatedClips = track.clips.map(c => c.id === createdClipId ? { ...c, name: file.name, buffer: decoded } : c)
        return ts.map((t, i) => i !== idx ? t : { ...t, clips: updatedClips })
      } else {
        const newClip: Clip = { id: createdClipId, name: file.name, buffer: decoded, startSec, duration: decoded.duration, color: '#22c55e' }
        return ts.map((t, i) => i !== idx ? t : { ...t, clips: [...t.clips, newClip] })
      }
    })
    batch(() => {
      setSelectedTrackId(targetTrackId)
      setSelectedClip({ trackId: targetTrackId, clipId: createdClipId })
      setSelectedFXTarget(targetTrackId)
    })
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const file = Array.from(files).find(f => f.type.startsWith('audio'))
    if (!file) return
    
    const ab = await file.arrayBuffer()
    const decoded = await audioEngine.decodeAudioData(ab)
    let targetTrackId = selectedTrackId()
    if (!targetTrackId) {
      // Ensure at least one track exists
      targetTrackId = await convexClient.mutation(convexApi.tracks.create, { roomId: roomId(), userId: userId() }) as any as string
      setSelectedTrackId(targetTrackId)
      setSelectedFXTarget(targetTrackId)
    }
    const ts0 = tracks()
    const tIdx = ts0.findIndex(t => t.id === targetTrackId)
    let startSec = Math.max(0, playheadSec())
    
    if (tIdx >= 0) {
      const tgt = ts0[tIdx]
      if (willOverlap(tgt.clips, null, startSec, decoded.duration)) {
        startSec = calcNonOverlapStart(tgt.clips, null, startSec, decoded.duration)
      }
    }

    // Create a shared clip on the server and attach buffer locally
    const createdClipId = await convexClient.mutation(convexApi.clips.create, {
      roomId: roomId(),
      trackId: targetTrackId as any,
      startSec,
      duration: decoded.duration,
      userId: userId(),
      name: file.name,
    }) as any as string

    audioBufferCache.set(createdClipId, decoded)
    // Upload to R2 in background and set sampleUrl
    ;(async () => {
      const url = await uploadToR2(roomId(), createdClipId, file, decoded.duration)
      if (url) {
        try { await convexClient.mutation(convexApi.clips.setSampleUrl, { clipId: createdClipId as any, sampleUrl: url }) } catch {}
        setTracks(ts => ts.map(t => ({
          ...t,
          clips: t.clips.map(c => c.id === createdClipId ? { ...c, sampleUrl: url } : c)
        })))
      }
    })()
    // Optimistic local insert so playback works immediately (de-duped)
    setTracks(ts => {
      const idx = ts.findIndex(t => t.id === targetTrackId)
      if (idx === -1) {
        const newTrack: Track = { id: targetTrackId, name: `Track ${ts.length + 1}` , volume: 0.8, clips: [] }
        const newClip: Clip = { id: createdClipId, name: file.name, buffer: decoded, startSec, duration: decoded.duration, color: '#22c55e' }
        return [...ts, { ...newTrack, clips: [newClip] }]
      }
      const track = ts[idx]
      const existsIdx = track.clips.findIndex(c => c.id === createdClipId)
      if (existsIdx >= 0) {
        const updatedClips = track.clips.map(c => c.id === createdClipId ? { ...c, name: file.name, buffer: decoded } : c)
        return ts.map((t, i) => i !== idx ? t : { ...t, clips: updatedClips })
      } else {
        const newClip: Clip = { id: createdClipId, name: file.name, buffer: decoded, startSec, duration: decoded.duration, color: '#22c55e' }
        return ts.map((t, i) => i !== idx ? t : { ...t, clips: [...t.clips, newClip] })
      }
    })
    batch(() => {
      setSelectedClip({ trackId: targetTrackId, clipId: createdClipId })
      setSelectedFXTarget(targetTrackId)
    })
  }

  async function onFileInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    await handleFiles(input.files)
    input.value = ''
  }

  // Add audio via persistent file handle when supported, otherwise fall back to <input type="file">
  async function handleAddAudio() {
    const w: any = window as any
    if (typeof w.showOpenFilePicker === 'function') {
      try {
        const handles: any[] = await w.showOpenFilePicker({
          multiple: false,
          types: [
            {
              description: 'Audio files',
              accept: { 'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.webm'] },
            },
          ],
        })
        const fileHandle: any = Array.isArray(handles) ? handles[0] : handles
        if (!fileHandle) return

        const file: File = await fileHandle.getFile?.()
        if (!file) return

        const ab = await file.arrayBuffer()
        const decoded = await audioEngine.decodeAudioData(ab)

        // Determine target track
        let targetTrackId = selectedTrackId()
        if (!targetTrackId) {
          targetTrackId = await convexClient.mutation(convexApi.tracks.create, { roomId: roomId(), userId: userId() }) as any as string
          setSelectedTrackId(targetTrackId)
          setSelectedFXTarget(targetTrackId)
        }

        // Compute start position avoiding overlap
        const ts0 = tracks()
        const tIdx = ts0.findIndex(t => t.id === targetTrackId)
        let startSec = Math.max(0, playheadSec())
        if (tIdx >= 0) {
          const tgt = ts0[tIdx]
          if (willOverlap(tgt.clips, null, startSec, decoded.duration)) {
            startSec = calcNonOverlapStart(tgt.clips, null, startSec, decoded.duration)
          }
        }

        // Create clip on server
        const createdClipId = await convexClient.mutation(convexApi.clips.create, {
          roomId: roomId(),
          trackId: targetTrackId as any,
          startSec,
          duration: decoded.duration,
          userId: userId(),
          name: file.name,
        }) as any as string

        audioBufferCache.set(createdClipId, decoded)
        // No local file handle persistence

        // Upload to R2 in background and set sampleUrl
        ;(async () => {
          const url = await uploadToR2(roomId(), createdClipId, file, decoded.duration)
          if (url) {
            try { await convexClient.mutation(convexApi.clips.setSampleUrl, { clipId: createdClipId as any, sampleUrl: url }) } catch {}
            setTracks(ts => ts.map(t => ({
              ...t,
              clips: t.clips.map(c => c.id === createdClipId ? { ...c, sampleUrl: url } : c)
            })))
          }
        })()

        // Optimistic local insert
        setTracks(ts => {
          const idx = ts.findIndex(t => t.id === targetTrackId)
          if (idx === -1) {
            const newTrack: Track = { id: targetTrackId, name: `Track ${ts.length + 1}` , volume: 0.8, clips: [] }
            const newClip: Clip = { id: createdClipId, name: file.name, buffer: decoded, startSec, duration: decoded.duration, color: '#22c55e' }
            return [...ts, { ...newTrack, clips: [newClip] }]
          }
          const track = ts[idx]
          const existsIdx = track.clips.findIndex(c => c.id === createdClipId)
          if (existsIdx >= 0) {
            const updatedClips = track.clips.map(c => c.id === createdClipId ? { ...c, name: file.name, buffer: decoded } : c)
            return ts.map((t, i) => i !== idx ? t : { ...t, clips: updatedClips })
          } else {
            const newClip: Clip = { id: createdClipId, name: file.name, buffer: decoded, startSec, duration: decoded.duration, color: '#22c55e' }
            return ts.map((t, i) => i !== idx ? t : { ...t, clips: [...t.clips, newClip] })
          }
        })
        batch(() => {
          setSelectedClip({ trackId: targetTrackId!, clipId: createdClipId })
          setSelectedFXTarget(targetTrackId!)
        })
        return
      } catch (err) {
        // If user cancels the picker, just return; otherwise fall back
        // @ts-ignore
        if (err && (err.name === 'AbortError' || err.code === 20)) return
      }
    }
    // Fallback: file input
    fileInputRef?.click()
  }

  // Drag a clip (allow vertical track reassign)
  let dragging = false
  let dragDeltaX = 0
  let draggingIds: { trackId: string; clipId: string } | null = null
  let addedTrackDuringDrag: string | null = null
  let creatingTrackDuringDrag = false

  function onClipMouseDown(trackId: string, clipId: string, e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const t = tracks().find(t => t.id === trackId)
    const c = t?.clips.find(c => c.id === clipId)
    if (!t || !c) return
    
    dragging = true
    draggingIds = { trackId, clipId }
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
    })
    addedTrackDuringDrag = null
    creatingTrackDuringDrag = false

    const rect = scrollRef!.getBoundingClientRect()
    const leftPx = c.startSec * PPS - (scrollRef?.scrollLeft || 0)
    dragDeltaX = e.clientX - (rect.left + leftPx)

    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
  }

  async function onWindowMouseMove(e: MouseEvent) {
    if (!dragging || !draggingIds) return
    
    const rect = scrollRef!.getBoundingClientRect()
    const x = e.clientX - rect.left - dragDeltaX + (scrollRef?.scrollLeft || 0)
    const desiredStart = Math.max(0, x / PPS)
    let laneIdx = yToLaneIndex(e.clientY, scrollRef!)

    // If dragging below the last lane, create a new track during drag (once)
    if (laneIdx >= tracks().length) {
      if (!addedTrackDuringDrag && !creatingTrackDuringDrag) {
        creatingTrackDuringDrag = true
        try {
          const newTrackId = await convexClient.mutation(convexApi.tracks.create, { roomId: roomId(), userId: userId() }) as any as string
          addedTrackDuringDrag = newTrackId
          // Optimistically ensure the new track exists locally for immediate visual feedback
          setTracks(ts => ts.some(t => t.id === newTrackId)
            ? ts
            : [...ts, { id: newTrackId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [] }])
        } finally {
          creatingTrackDuringDrag = false
        }
      }
    }

    // Resolve target track id (prefer newly created one)
    let targetId: string | undefined
    {
      const tsSnap = tracks()
      if (laneIdx >= tsSnap.length && addedTrackDuringDrag) {
        targetId = addedTrackDuringDrag
      } else {
        laneIdx = Math.max(0, Math.min(laneIdx, tsSnap.length - 1))
        targetId = tsSnap[laneIdx]?.id
      }
    }
    if (!targetId) return

    const movingClipId = draggingIds!.clipId

    // Apply the move using the latest state to avoid stale snapshots and duplicates
    setTracks(ts => {
      const srcIdx = ts.findIndex(t => t.clips.some(c => c.id === movingClipId))
      if (srcIdx < 0) return ts
      const movingClip = ts[srcIdx].clips.find(c => c.id === movingClipId)!
      const duration = movingClip.duration
      const targetIdx = ts.findIndex(t => t.id === targetId)
      if (targetIdx < 0) return ts
      const targetTrack = ts[targetIdx]

      if (srcIdx === targetIdx) {
        // Same track: prevent overlap and update startSec in place
        const overlap = willOverlap(targetTrack.clips, movingClip.id, desiredStart, duration)
        const newStart = overlap ? calcNonOverlapStart(targetTrack.clips, movingClip.id, desiredStart, duration) : desiredStart
        return ts.map((t, i) => i !== srcIdx ? t : ({
          ...t,
          clips: t.clips.map(c => c.id === movingClip.id ? { ...c, startSec: newStart } : c)
        }))
      } else {
        // Different track: move clip across tracks, deduping in target
        const overlap = willOverlap(targetTrack.clips, null, desiredStart, duration)
        const newStart = overlap ? calcNonOverlapStart(targetTrack.clips, null, desiredStart, duration) : desiredStart
        const prunedTargetClips = targetTrack.clips.filter(c => c.id !== movingClip.id)
        return ts.map((t, i) => {
          if (i === srcIdx) return { ...t, clips: t.clips.filter(c => c.id !== movingClip.id) }
          if (i === targetIdx) return { ...t, clips: [...prunedTargetClips, { ...movingClip, startSec: newStart }] }
          return t
        })
      }
    })

    // Update drag tracking and selection if track changed
    if (draggingIds.trackId !== targetId) {
      const clipId = draggingIds.clipId
      draggingIds = { trackId: targetId, clipId }
      batch(() => {
        setSelectedTrackId(targetId!)
        setSelectedFXTarget(targetId!)
        setSelectedClip({ trackId: targetId!, clipId })
      })
    }
  }

  async function onWindowMouseUp(e: MouseEvent) {
    // Commit final clip position to server; fallback-create a track only if none was created during drag
    if (dragging && draggingIds && scrollRef) {
      const rect = scrollRef.getBoundingClientRect()
      const x = e.clientX - rect.left - dragDeltaX + (scrollRef?.scrollLeft || 0)
      const desiredStart = Math.max(0, x / PPS)
      const laneIdx = yToLaneIndex(e.clientY, scrollRef)

      if (laneIdx >= tracks().length && !addedTrackDuringDrag) {
        // Fallback: create a new track on drop if drag-time creation didn't happen
        const newTrackId = await convexClient.mutation(convexApi.tracks.create, { roomId: roomId(), userId: userId() }) as any as string
        const moving = draggingIds
        setTracks(ts => {
          const srcIdx = ts.findIndex(t => t.clips.some(c => c.id === moving.clipId))
          if (srcIdx < 0) return ts
          const movingClip = ts[srcIdx].clips.find(c => c.id === moving.clipId)!
          const newClip = { ...movingClip, startSec: desiredStart }
          const hasNew = ts.some(t => t.id === newTrackId)
          const newTrack: Track = { id: newTrackId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [] }
          const base = hasNew ? ts : [...ts, newTrack]
          return base.map((t, i) => {
            if (i === srcIdx) return { ...t, clips: t.clips.filter(c => c.id !== moving.clipId) }
            if (t.id === newTrackId) return { ...t, clips: [...t.clips, newClip] }
            return t
          })
        })
        batch(() => {
          setSelectedTrackId(newTrackId)
          setSelectedFXTarget(newTrackId)
          setSelectedClip({ trackId: newTrackId, clipId: moving.clipId })
        })
        void convexClient.mutation(convexApi.clips.move, {
          clipId: moving.clipId as any,
          startSec: desiredStart,
          toTrackId: newTrackId as any,
        })
      } else {
        // Commit final clip position to server in the resolved target track
        const t = tracks().find(tt => tt.id === draggingIds!.trackId)
        const c = t?.clips.find(cc => cc.id === draggingIds!.clipId)
        if (c) {
          void convexClient.mutation(convexApi.clips.move, {
            clipId: c.id as any,
            startSec: c.startSec,
            toTrackId: t?.id as any,
          })
        }
      }
    }
    dragging = false
    addedTrackDuringDrag = null
    creatingTrackDuringDrag = false
    draggingIds = null
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
  }

  function onRulerMouseDown(e: MouseEvent) {
    e.preventDefault()
    startScrub(e.clientX)
  }

  function onLaneMouseDown(e: MouseEvent) {
    e.preventDefault()
    let trackIdx = yToLaneIndex(e.clientY, scrollRef!)
    trackIdx = Math.max(0, Math.min(trackIdx, tracks().length - 1))
    const id = tracks()[trackIdx]?.id
    if (id) {
      batch(() => {
        setSelectedTrackId(id)
        setSelectedFXTarget(id)
        setSelectedClip(null)
      })
    }
    startScrub(e.clientX)
  }

  function onClipClick(trackId: string, clipId: string, e: MouseEvent) {
    e.stopPropagation()
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
    })
  }

  function deleteSelectedClip() {
    const sel = selectedClip()
    if (!sel) return
    // Optimistic local removal
    setTracks(ts => ts.map(t => t.id !== sel.trackId ? t : ({
      ...t,
      clips: t.clips.filter(c => c.id !== sel.clipId)
    })))
    // Server removal
    void convexClient.mutation(convexApi.clips.remove, { clipId: sel.clipId as any, userId: userId() })
    setSelectedClip(null)
  }

  function performDeleteTrack(id: string) {
    // Server removal
    void convexClient.mutation(convexApi.tracks.remove, { trackId: id as any, userId: userId() })
    // Local selection updates
    const next = tracks().filter(t => t.id !== id)
    batch(() => {
      setSelectedClip(null)
      if (next.length > 0) {
        setSelectedTrackId(next[0].id)
        setSelectedFXTarget(next[0].id)
      } else {
        setSelectedTrackId('')
        setSelectedFXTarget('master')
      }
    })
  }

  function requestDeleteSelectedTrack() {
    const id = selectedTrackId()
    if (!id) return
    const t = tracks().find(tt => tt.id === id)
    if (!t) return
    if (t.clips.length > 0) {
      setPendingDeleteTrackId(id)
      setConfirmOpen(true)
    } else {
      performDeleteTrack(id)
    }
  }

  function handleKeyboardAction() {
    const hasClip = !!selectedClip()
    if (hasClip) {
      deleteSelectedClip()
    } else {
      requestDeleteSelectedTrack()
    }
  }

  useTimelineKeyboard({
    onSpace: () => isPlaying() ? handlePause() : requestPlay(),
    onDelete: handleKeyboardAction
  })

  // Sidebar resizer
  function onSidebarMouseDown(e: MouseEvent) {
    e.preventDefault()
    resizing = true
    resizeStartX = e.clientX
    resizeStartWidth = sidebarWidth()
    window.addEventListener('mousemove', onSidebarMouseMove)
    window.addEventListener('mouseup', onSidebarMouseUp)
  }

  function onSidebarMouseMove(e: MouseEvent) {
    if (!resizing) return
    const containerW = containerRef?.clientWidth ?? 0
    const delta = resizeStartX - e.clientX // dragging left increases width
    const minW = 220
    const maxW = Math.max(minW, Math.floor(containerW * 0.7))
    const next = Math.max(minW, Math.min(maxW, resizeStartWidth + delta))
    setSidebarWidth(next)
  }

  function onSidebarMouseUp() {
    resizing = false
    window.removeEventListener('mousemove', onSidebarMouseMove)
    window.removeEventListener('mouseup', onSidebarMouseUp)
  }

  // Duration helper
  const duration = () => timelineDurationSec(tracks())

  // Ensure missing clip buffers are loaded (local handle first, then R2)
  createEffect(() => {
    const ts = tracks()
    for (const t of ts) {
      for (const c of t.clips) {
        if (!c.buffer) {
          void ensureClipBuffer(c.id, c.sampleUrl)
        }
      }
    }
  })

  // Before starting playback, try to (re)load any missing buffers in a user-gesture context.
  async function requestPlay() {
    const ts = tracks()
    for (const t of ts) {
      for (const c of t.clips) {
        if (!c.buffer) {
          await ensureClipBuffer(c.id, c.sampleUrl)
        }
      }
    }
    await handlePlay(tracks())
  }

  return (
    <div class="h-full w-full flex flex-col bg-neutral-950 text-neutral-200" onDragOver={onDragOver} onDrop={onDrop}>
      <input ref={el => (fileInputRef = el!)} type="file" accept="audio/*" class="hidden" onChange={onFileInput} />
      
      <TransportControls
        isPlaying={isPlaying()}
        playheadSec={playheadSec()}
        onPlay={() => requestPlay()}
        onPause={handlePause}
        onStop={handleStop}
        onAddAudio={() => handleAddAudio()}
        onShare={handleShare}
        onMasterFX={() => { setSelectedFXTarget('master'); setBottomFXOpen(true) }}
        currentRoomId={roomId()}
        onOpenProject={(rid) => {
          navigateToRoom(rid)
          const uid = userId()
          if (uid) void convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: rid, userId: uid })
        }}
        onCreateProject={async () => {
          const rid = crypto.randomUUID()
          navigateToRoom(rid)
          const uid = userId()
          if (uid) await convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: rid, userId: uid })
        }}
        onDeleteProject={async (rid) => {
          const uid = userId()
          if (!uid) return
          await convexClient.mutation(convexApi.projects.deleteOwnedInRoom, { roomId: rid, userId: uid })
          if (rid === roomId()) {
            // Move to a fresh empty room after deleting current project
            const fresh = crypto.randomUUID()
            navigateToRoom(fresh)
            await convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: fresh, userId: uid })
          }
        }}
        onRenameProject={async (rid, name) => {
          const uid = userId()
          if (!uid) return
          await convexClient.mutation((convexApi as any).projects.setName, { roomId: rid, userId: uid, name })
        }}
      />

      <div class="flex-1 flex min-h-0" ref={el => (containerRef = el!)}>
        <div class="flex-1 relative overflow-x-auto" ref={el => (scrollRef = el!)}>
          <div 
            class="relative select-none" 
            style={{ width: `${duration() * PPS}px`, height: `${RULER_HEIGHT + tracks().length * LANE_HEIGHT}px` }} 
            onMouseDown={onLaneMouseDown}
          >
            <TimelineRuler durationSec={duration()} onMouseDown={onRulerMouseDown} />
            
            <div class="absolute left-0 right-0" style={{ top: `${RULER_HEIGHT}px`, height: `${tracks().length * LANE_HEIGHT}px` }}>
              <For each={tracks()}>
                {(track, i) => (
                  <TrackLane
                    track={track}
                    index={i()}
                    selectedClip={selectedClip()}
                    onClipMouseDown={onClipMouseDown}
                    onClipClick={onClipClick}
                  />
                )}
              </For>
              
              {/* Playhead */}
              <div class="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none" style={{ left: `${playheadSec() * PPS}px` }} />
            </div>
          </div>
        </div>

        <TrackSidebar
          tracks={tracks()}
          selectedTrackId={selectedTrackId()}
          sidebarWidth={sidebarWidth()}
          onTrackClick={(id) => {
            batch(() => {
              setSelectedTrackId(id)
              setSelectedFXTarget(id)
            })
          }}
          onAddTrack={async () => {
            const id = await convexClient.mutation(convexApi.tracks.create, { roomId: roomId(), userId: userId() }) as any as string
            batch(() => {
              setSelectedTrackId(id)
              setSelectedFXTarget(id)
            })
          }}
          onVolumeChange={(trackId, volume) => {
            setTracks(ts => ts.map(t => t.id !== trackId ? t : ({ ...t, volume })))
            const prev = volumeTimers.get(trackId)
            if (prev) clearTimeout(prev)
            const timer = window.setTimeout(() => {
              void convexClient.mutation(convexApi.tracks.setVolume, { trackId: trackId as any, volume })
              volumeTimers.delete(trackId)
            }, 150)
            volumeTimers.set(trackId, timer)
          }}
          onSidebarMouseDown={onSidebarMouseDown}
        />
      </div>

      <EffectsPanel
        isOpen={bottomFXOpen()}
        selectedFXTarget={selectedFXTarget()}
        tracks={tracks()}
        onClose={() => setBottomFXOpen(false)}
        onOpen={() => setBottomFXOpen(true)}
      />

      <Dialog open={confirmOpen()} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this track?</DialogTitle>
            <DialogDescription>
              {(() => {
                const id = pendingDeleteTrackId()
                const t = tracks().find(tt => tt.id === id)
                const count = t?.clips.length ?? 0
                return count > 0
                  ? `This track contains ${count} audio clip${count === 1 ? '' : 's'}. Deleting the track will remove them. This action cannot be undone.`
                  : `This track has no audio clips. Deleting it cannot be undone.`
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfirmOpen(false); setPendingDeleteTrackId(null) }}>Cancel</Button>
            <Button variant="destructive" onClick={() => { 
              const id = pendingDeleteTrackId()
              if (id) performDeleteTrack(id)
              setPendingDeleteTrackId(null)
              setConfirmOpen(false)
            }}>Delete Track</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cloud-only mode: no browser capability notice needed */}
    </div>
  )
}

export default Timeline
