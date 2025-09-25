import { type Component, type JSX, Show, For, createEffect, createSignal, onCleanup, batch, untrack } from 'solid-js'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '~/components/ui/dialog'
import type { Track, Clip, SelectedClip } from '~/types/timeline'
import { AudioEngine } from '~/lib/audio-engine'
import { timelineDurationSec, clientXToSec, yToLaneIndex, willOverlap, calcNonOverlapStart, PPS, RULER_HEIGHT, LANE_HEIGHT } from '~/lib/timeline-utils'
import { useTimelineKeyboard } from '~/hooks/useTimelineKeyboard'
import TransportControls from './timeline/TransportControls'
import TimelineRuler from './timeline/TimelineRuler'
import TrackLane from './timeline/TrackLane'
import TrackSidebar from './timeline/TrackSidebar'
import EffectsPanel from './timeline/EffectsPanel'
import { Button } from './ui/button'
import { convexClient, convexApi } from '~/lib/convex'
import { useTimelineData } from '~/hooks/useTimelineData'
import { usePlayheadControls } from '~/hooks/usePlayheadControls'
import { useClipDrag } from '~/hooks/useClipDrag'
import { useClipResize } from '~/hooks/useClipResize'
import { useTimelineSelection } from '~/hooks/useTimelineSelection'
import { useClipBuffers } from '~/hooks/useClipBuffers'

let audioEngineSingleton: AudioEngine | null = null
const volumeTimers = new Map<string, number>()
const optimisticMoves = new Map<string, { trackId: string; startSec: number }>()

const getAudioEngine = () => {
  if (!audioEngineSingleton) {
    audioEngineSingleton = new AudioEngine()
  }
  return audioEngineSingleton
}

const canUseLocalStorage = () => {
  if (typeof window === 'undefined') return false
  try {
    const storage = window.localStorage
    if (!storage) return false
    return true
  } catch {
    return false
  }
}

const Timeline: Component = () => {
  // Stateasa
  const [tracks, setTracks] = createSignal<Track[]>([])
  const [selectedTrackId, setSelectedTrackId] = createSignal('')
  const [selectedClip, setSelectedClip] = createSignal<SelectedClip>(null)
  // Multi-selection: set of selected clip IDs (selectedClip is the primary/last-selected)
  const [selectedClipIds, setSelectedClipIds] = createSignal<Set<string>>(new Set<string>(), { equals: false })
  const [bottomFXOpen, setBottomFXOpen] = createSignal(true)
  const [selectedFXTarget, setSelectedFXTarget] = createSignal<string>('master')
  const [sidebarWidth, setSidebarWidth] = createSignal(260)
  const [confirmOpen, setConfirmOpen] = createSignal(false)
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<string | null>(null)
  // Mix sync toggle (per room, persisted locally)
  const [syncMix, setSyncMix] = createSignal(false)

  // Audio engine
  const audioEngine = getAudioEngine()
  // Collaboration: roomId from ?roomId=; ownership tied to Better Auth userId
  const { roomId, setRoomId, userId, myProjects, fullView, navigateToRoom } = useTimelineData()

  const {
    audioBufferCache,
    ensureClipBuffer,
    uploadToR2,
    clearClipBufferCaches,
  } = useClipBuffers({ audioEngine, tracks, setTracks })

  // Local storage helpers for mix persistence
  function mixKey(rid: string) { return `mb:mix:${rid}` }
  function mixSyncKey(rid: string) { return `mb:mix-sync:${rid}` }
  function loadLocalMixMap(rid: string): Record<string, { muted?: boolean; soloed?: boolean }> {
    if (!canUseLocalStorage()) return {}
    try { return JSON.parse(localStorage.getItem(mixKey(rid)) || '{}') } catch { return {} }
  }
  function saveLocalMix(rid: string, trackId: string, update: Partial<{ muted: boolean; soloed: boolean }>) {
    if (!canUseLocalStorage()) return
    const map = loadLocalMixMap(rid)
    map[trackId] = { ...(map[trackId] || {}), ...update }
    try { localStorage.setItem(mixKey(rid), JSON.stringify(map)) } catch {}
  }
  // Load syncMix per room
  createEffect(() => {
    if (!canUseLocalStorage()) {
      setSyncMix(false)
      return
    }
    const rid = roomId()
    if (!rid) return
    try {
      const stored = localStorage.getItem(mixSyncKey(rid))
      setSyncMix(stored === '1')
    } catch {}
  })

  // Local caches for responsiveness
  // Optimistic positions for clips that have been moved locally but the server
  // hasn't reflected the change yet. Prevents revert-then-flash on drop.
  
  // Playback & playhead controls
  const {
    isPlaying,
    playheadSec,
    handlePlay,
    handlePause,
    handleStop,
    setPlayhead,
    requestPlay,
    startScrub,
    stopScrub,
    setScrollElement,
  } = usePlayheadControls({ audioEngine, tracks, ensureClipBuffer })

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

  const { onClipMouseDown, activeDrag } = useClipDrag({
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
    getScrollElement: () => scrollRef,
  })

  const {
    onClipResizeStart,
    onResizeMouseMove,
    onResizeMouseUp,
  } = useClipResize({
    tracks,
    setTracks,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
    convexClient,
    convexApi,
    getScrollElement: () => scrollRef,
  })

  const {
    marqueeRect,
    onLaneMouseDown,
    onLaneDragUp,
  } = useTimelineSelection({
    tracks,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
    startScrub,
    stopScrub,
  })

  const handleLaneMouseDown: JSX.EventHandler<HTMLDivElement, MouseEvent> = (event) => {
    onLaneMouseDown(event, scrollRef)
  }

  const onRulerMouseDown = (event: MouseEvent) => {
    event.preventDefault()
    startScrub(event.clientX)
  }

  // Keep audio engine synced with tracks
  createEffect(() => {
    audioEngine.updateTrackGains(tracks())
  })

  // Project server state into local Track[] while preserving ephemeral fields
  createEffect(() => {
    const raw = (fullView as any).data
    const data = typeof raw === 'function' ? raw() : raw
    if (!data) return

    // Read old tracks without tracking to avoid creating a feedback loop
    const oldTracks = untrack(() => tracks())
    const oldTrackMap = new Map(oldTracks.map(t => [t.id, t]))

    const sm = syncMix()
    const dragSnapshot = activeDrag()
    const addedTrackDuringDrag = dragSnapshot?.addedTrackDuringDrag
    const localMix = loadLocalMixMap(roomId())
    const projected: Track[] = data.tracks.map((t: any, idx: number) => {
      const id = t._id as string
      const prev = oldTrackMap.get(id)
      const serverMuted = (t as any).muted as boolean | undefined
      const serverSoloed = (t as any).soloed as boolean | undefined
      const serverName = typeof (t as any).name === 'string' ? (t as any).name : undefined
      return {
        id,
        name: serverName ?? prev?.name ?? `Track ${idx + 1}`,
        volume: typeof t.volume === 'number' ? t.volume : 0.8,
        clips: [],
        muted: sm
          ? (typeof serverMuted === 'boolean' ? serverMuted : (prev?.muted ?? localMix[id]?.muted ?? false))
          : (prev?.muted ?? localMix[id]?.muted ?? false),
        soloed: sm
          ? (typeof serverSoloed === 'boolean' ? serverSoloed : (prev?.soloed ?? localMix[id]?.soloed ?? false))
          : (prev?.soloed ?? localMix[id]?.soloed ?? false),
      }
    })

    const projectedMap = new Map(projected.map(t => [t.id, t]))
    // Track server clip positions to clear optimistic entries when in-sync
    const serverClipPos = new Map<string, { trackId: string; startSec: number }>()

    // If we've created a track during drag that hasn't arrived from the server yet,
    // inject a placeholder so the UI remains stable while dragging.
    if (addedTrackDuringDrag && !projectedMap.has(addedTrackDuringDrag)) {
      const prev = oldTrackMap.get(addedTrackDuringDrag)
      const placeholder: Track = {
        id: addedTrackDuringDrag,
        name: prev?.name ?? `Track ${projected.length + 1}`,
        volume: prev?.volume ?? 0.8,
        clips: [],
        muted: prev?.muted ?? false,
        soloed: prev?.soloed ?? false,
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
      serverClipPos.set(c._id as string, { trackId, startSec: c.startSec as number })
      t.clips.push({
        id: c._id as string,
        name,
        buffer,
        startSec: c.startSec as number,
        duration: c.duration as number,
        leftPadSec: (c as any).leftPadSec ?? prevClip?.leftPadSec ?? 0,
        color,
        sampleUrl: (c as any).sampleUrl as string | undefined,
      })
    }

    // Apply optimistic post-drop moves to prevent revert-then-flash while server catches up
    if (optimisticMoves.size > 0) {
      const localTracks = untrack(() => tracks())
      for (const [id, pos] of optimisticMoves) {
        let localClip: Clip | undefined
        for (const lt of localTracks) {
          const found = lt.clips.find(cc => cc.id === id)
          if (found) { localClip = found; break }
        }
        if (!localClip) continue
        for (const t of projected) {
          t.clips = t.clips.filter(cc => cc.id !== id)
        }
        const targetProjected = projectedMap.get(pos.trackId)
        if (targetProjected) {
          targetProjected.clips.push({
            id: localClip.id,
            name: localClip.name,
            buffer: localClip.buffer ?? null,
            startSec: pos.startSec,
            duration: localClip.duration,
            leftPadSec: localClip.leftPadSec ?? 0,
            color: localClip.color,
            sampleUrl: localClip.sampleUrl,
          })
        }
      }
      // Clear any optimistic entries that the server has now reflected
      const EPS = 1e-3
      for (const [id, pos] of Array.from(optimisticMoves.entries())) {
        const server = serverClipPos.get(id)
        if (server && server.trackId === pos.trackId && Math.abs(server.startSec - pos.startSec) < EPS) {
          optimisticMoves.delete(id)
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
    try { onLaneDragUp() } catch {}
    try { window.removeEventListener('mousemove', onSidebarMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onSidebarMouseUp) } catch {}
    try { window.removeEventListener('mousemove', onResizeMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onResizeMouseUp) } catch {}
    audioEngine.close()
    audioEngineSingleton = null
    for (const timer of volumeTimers.values()) {
      clearTimeout(timer)
    }
    volumeTimers.clear()
    clearClipBufferCaches()
    optimisticMoves.clear()
  })

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
        const newTrack: Track = { id: targetTrackId, name: `Track ${ts.length + 1}` , volume: 0.8, clips: [], muted: false, soloed: false }
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
      setSelectedClipIds(new Set([createdClipId]))
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
        const newTrack: Track = { id: targetTrackId, name: `Track ${ts.length + 1}` , volume: 0.8, clips: [], muted: false, soloed: false }
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
      setSelectedClipIds(new Set([createdClipId]))
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
            const newTrack: Track = { id: targetTrackId, name: `Track ${ts.length + 1}` , volume: 0.8, clips: [], muted: false, soloed: false }
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
          setSelectedClipIds(new Set([createdClipId]))
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

  function onClipClick(trackId: string, clipId: string, e: MouseEvent) {
    e.stopPropagation()
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
      if (e.shiftKey) {
        setSelectedClipIds(prev => { const next = new Set(prev); next.add(clipId); return next })
      } else {
        setSelectedClipIds(new Set([clipId]))
      }
    })
  }

  function deleteSelectedClips() {
    const ids = Array.from(selectedClipIds())
    if (ids.length === 0) return
    // Optimistic local removal
    setTracks(ts => ts.map(t => ({
      ...t,
      clips: t.clips.filter(c => !ids.includes(c.id))
    })))
    // Server removals
    for (const id of ids) {
      void convexClient.mutation(convexApi.clips.remove, { clipId: id as any, userId: userId() })
    }
    batch(() => {
      setSelectedClip(null)
      setSelectedClipIds(new Set<string>())
    })
  }

  // Duplicate the currently selected clip on the same track, placing it to the right
  async function duplicateSelectedClips() {
    const ids = Array.from(selectedClipIds())
    if (ids.length === 0) return
    const tsSnap = tracks()
    // Group selected clips by track
    const byTrack = new Map<string, Clip[]>()
    for (const t of tsSnap) {
      const sels = t.clips.filter(c => ids.includes(c.id))
      if (sels.length > 0) byTrack.set(t.id, sels)
    }
    const createdIds: { trackId: string; clipId: string }[] = []
    for (const [trackId, clipsToDup] of byTrack.entries()) {
      const t = tsSnap.find(tt => tt.id === trackId)!
      for (const c of clipsToDup) {
        let desiredStart = c.startSec + c.duration + 0.0001
        let startSec = desiredStart
        if (willOverlap(t.clips, null, startSec, c.duration)) {
          startSec = calcNonOverlapStart(t.clips, null, startSec, c.duration)
        }
        const createdClipId = await convexClient.mutation(convexApi.clips.create, {
          roomId: roomId(),
          trackId: t.id as any,
          startSec,
          duration: c.duration,
          userId: userId(),
          name: c.name,
        }) as any as string
        if (c.buffer) audioBufferCache.set(createdClipId, c.buffer)
        createdIds.push({ trackId: t.id, clipId: createdClipId })
        // Optimistic local insert
        setTracks(ts => ts.map(tr => tr.id !== t.id ? tr : ({
          ...tr,
          clips: [...tr.clips, {
            id: createdClipId,
            name: c.name,
            buffer: c.buffer ?? null,
            startSec,
            duration: c.duration,
            leftPadSec: c.leftPadSec ?? 0,
            color: c.color,
            sampleUrl: c.sampleUrl,
          }]
        })))
        if (c.sampleUrl) {
          void convexClient.mutation(convexApi.clips.setSampleUrl, { clipId: createdClipId as any, sampleUrl: c.sampleUrl })
        }
        if (typeof c.leftPadSec === 'number' && isFinite(c.leftPadSec)) {
          void convexClient.mutation((convexApi as any).clips.setTiming, {
            clipId: createdClipId as any,
            startSec,
            duration: c.duration,
            leftPadSec: c.leftPadSec ?? 0,
          })
        }
      }
    }
    // Select the last created clip and update selection set
    const last = createdIds[createdIds.length - 1]
    if (last) {
      batch(() => {
        setSelectedTrackId(last.trackId)
        setSelectedClip({ trackId: last.trackId, clipId: last.clipId })
        setSelectedFXTarget(last.trackId)
        setSelectedClipIds(new Set(createdIds.map(x => x.clipId)))
      })
    }
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
    const hasMulti = selectedClipIds().size > 0
    if (hasMulti) {
      deleteSelectedClips()
    } else {
      requestDeleteSelectedTrack()
    }
  }

  useTimelineKeyboard({
    onSpace: () => isPlaying() ? handlePause() : requestPlay(),
    onDelete: handleKeyboardAction,
    onDuplicate: () => { void duplicateSelectedClips() }
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
  // Jump to a specific clip (from Samples dropdown): select it, move playhead, and scroll into view
  function jumpToClip(trackId: string, clipId: string, startSec: number) {
    // Ensure selection states are consistent
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
      setSelectedFXTarget(trackId)
      setSelectedClipIds(new Set([clipId]))
    })
    // Move playhead to the start of the clip
    setPlayhead(Math.max(0, startSec), tracks())
    // Try to load buffer if missing
    try {
      const t = tracks().find(tt => tt.id === trackId)
      const c = t?.clips.find(cc => cc.id === clipId)
      if (c && !c.buffer) {
        void ensureClipBuffer(clipId, c.sampleUrl)
      }
    } catch {}
    // Center the clip horizontally in view
    try {
      if (scrollRef) {
        const centerLeft = Math.max(0, startSec * PPS - (scrollRef.clientWidth / 2))
        scrollRef.scrollLeft = Math.floor(centerLeft)
      }
    } catch {}
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
        onJumpToClip={(clipId, trackId, startSec) => jumpToClip(trackId, clipId, startSec)}
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
          // If deleting the active project, navigate to an existing other project FIRST
          // (if any), otherwise create a fresh one. Only then delete the old project
          // to avoid the ensureOwnedRoom effect re-adding it.
          if (rid === roomId()) {
            const old = rid
            // Snapshot current projects and pick another one, if available
            const projectsRaw: any = (myProjects as any)?.data
            const projectsLocal = typeof projectsRaw === 'function' ? projectsRaw() : projectsRaw
            let other: string | undefined = Array.isArray(projectsLocal)
              ? (projectsLocal.find((p: any) => p?.roomId && p.roomId !== old)?.roomId as string | undefined)
              : undefined
            // If local cache isn't ready, fetch a fresh snapshot to avoid creating an unnecessary new project
            if (!other) {
              try {
                const freshList: any[] = await convexClient.query((convexApi as any).projects.listMineDetailed, { userId: uid } as any)
                other = freshList?.find?.((p: any) => p?.roomId && p.roomId !== old)?.roomId
              } catch {}
            }

            if (other) {
              navigateToRoom(other)
              await convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: other, userId: uid })
              await convexClient.mutation(convexApi.projects.deleteOwnedInRoom, { roomId: old, userId: uid })
            } else {
              const fresh = crypto.randomUUID()
              navigateToRoom(fresh)
              await convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: fresh, userId: uid })
              await convexClient.mutation(convexApi.projects.deleteOwnedInRoom, { roomId: old, userId: uid })
            }
          } else {
            await convexClient.mutation(convexApi.projects.deleteOwnedInRoom, { roomId: rid, userId: uid })
          }
        }}
        onRenameProject={async (rid, name) => {
          const uid = userId()
          if (!uid) return
          await convexClient.mutation((convexApi as any).projects.setName, { roomId: rid, userId: uid, name })
        }}
      />

      <div class="flex-1 flex min-h-0" ref={el => (containerRef = el!)}>
        <div
        class="flex-1 relative overflow-x-auto"
        ref={el => {
          scrollRef = el!
          setScrollElement(el || undefined)
        }}
      >
          <div 
            class="relative select-none" 
            style={{ width: `${duration() * PPS}px`, height: `${RULER_HEIGHT + tracks().length * LANE_HEIGHT}px` }} 
            onMouseDown={handleLaneMouseDown}
          >
            <TimelineRuler durationSec={duration()} onMouseDown={onRulerMouseDown} />
            
            <div class="absolute left-0 right-0" style={{ top: `${RULER_HEIGHT}px`, height: `${tracks().length * LANE_HEIGHT}px` }}>
              <For each={tracks()}>
                {(track, i) => (
                  <TrackLane
                    track={track}
                    index={i()}
                    selectedClipIds={selectedClipIds()}
                    onClipMouseDown={onClipMouseDown}
                    onClipClick={onClipClick}
                    onClipResizeStart={onClipResizeStart}
                  />
                )}
              </For>
              {(() => {
                const r = marqueeRect()
                if (!r) return null
                return (
                  <div
                    class="absolute border border-blue-400 bg-blue-400/10 pointer-events-none z-50"
                    style={{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` }}
                  />
                )
              })()}
              
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
          onToggleMute={(trackId) => {
            const rid = roomId()
            let nextMuted = false
            setTracks(ts => ts.map(t => {
              if (t.id !== trackId) return t
              nextMuted = !t.muted
              return { ...t, muted: nextMuted }
            }))
            if (rid) saveLocalMix(rid, trackId, { muted: nextMuted })
            if (syncMix()) {
              const uid = userId()
              if (uid) void convexClient.mutation(convexApi.tracks.setMix, { trackId: trackId as any, muted: nextMuted, userId: uid })
            }
          }}
          onToggleSolo={(trackId) => {
            const rid = roomId()
            let nextSoloed = false
            setTracks(ts => ts.map(t => {
              if (t.id !== trackId) return t
              nextSoloed = !t.soloed
              return { ...t, soloed: nextSoloed }
            }))
            if (rid) saveLocalMix(rid, trackId, { soloed: nextSoloed })
            if (syncMix()) {
              const uid = userId()
              if (uid) void convexClient.mutation(convexApi.tracks.setMix, { trackId: trackId as any, soloed: nextSoloed, userId: uid })
            }
          }}
          syncMix={syncMix()}
          onToggleSyncMix={() => {
            const rid = roomId()
            if (rid) {
              const next = !syncMix()
              setSyncMix(next)
              try { localStorage.setItem(mixSyncKey(rid), next ? '1' : '0') } catch {}
            }
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
        audioEngine={audioEngine}
        roomId={roomId()}
        userId={userId()}
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
