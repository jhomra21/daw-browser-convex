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
  // Stateasa
  const [tracks, setTracks] = createSignal<Track[]>([])
  const [selectedTrackId, setSelectedTrackId] = createSignal('')
  const [selectedClip, setSelectedClip] = createSignal<SelectedClip>(null)
  // Multi-selection: set of selected clip IDs (selectedClip is the primary/last-selected)
  const [selectedClipIds, setSelectedClipIds] = createSignal<Set<string>>(new Set<string>())
  const [bottomFXOpen, setBottomFXOpen] = createSignal(true)
  const [selectedFXTarget, setSelectedFXTarget] = createSignal<string>('master')
  const [sidebarWidth, setSidebarWidth] = createSignal(260)
  const [confirmOpen, setConfirmOpen] = createSignal(false)
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<string | null>(null)
  // Mix sync toggle (per room, persisted locally)
  const [syncMix, setSyncMix] = createSignal(false)

  // Audio engine
  const audioEngine = new AudioEngine()
  // Collaboration: roomId from ?roomId=; ownership tied to Better Auth userId
  const [roomId, setRoomId] = createSignal<string>('')
  const session = useSessionQuery()
  const userId = () => (session()?.data?.user as any)?.id ?? ''
  // Track if we auto-generated a roomId before the user signed in
  const [ridAutoCreated, setRidAutoCreated] = createSignal(false)

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
        setRoomId(rid)
        setRidAutoCreated(true)
      } else {
        setRoomId(rid)
        setRidAutoCreated(false)
      }
    } catch {
      setRoomId('default')
      setRidAutoCreated(true)
    }

    // Cloud-only mode: no local clip name cache
  })

  // Local storage helpers for mix persistence
  function mixKey(rid: string) { return `mb:mix:${rid}` }
  function mixSyncKey(rid: string) { return `mb:mix-sync:${rid}` }
  function loadLocalMixMap(rid: string): Record<string, { muted?: boolean; soloed?: boolean }> {
    try { return JSON.parse(localStorage.getItem(mixKey(rid)) || '{}') } catch { return {} }
  }
  function saveLocalMix(rid: string, trackId: string, update: Partial<{ muted: boolean; soloed: boolean }>) {
    const map = loadLocalMixMap(rid)
    map[trackId] = { ...(map[trackId] || {}), ...update }
    try { localStorage.setItem(mixKey(rid), JSON.stringify(map)) } catch {}
  }
  // Load syncMix per room
  createEffect(() => {
    const rid = roomId()
    if (!rid) return
    try {
      const stored = localStorage.getItem(mixSyncKey(rid))
      setSyncMix(stored === '1')
    } catch {}
  })

  // Query the user's existing projects (roomId + name) when signed in
  const myProjects = useConvexQuery(
    convexApi.projects.listMineDetailed,
    () => userId() ? ({ userId: userId() }) : null,
    () => ['my-projects', userId()]
  )

  // Ensure the current room appears in the user's project list, but
  // if we auto-created a room before sign-in and the user has existing projects,
  // redirect to the first existing project instead of creating a new one.
  createEffect(() => {
    const uid = userId()
    if (!uid) return
    const rid = roomId()
    const projectsRaw = (myProjects as any)?.data
    const projects = typeof projectsRaw === 'function' ? projectsRaw() : projectsRaw

    // If we generated a temporary roomId earlier and the user already has projects,
    // prefer redirecting to an existing project rather than creating a new Untitled one.
    if (ridAutoCreated()) {
      // Wait until projects are loaded before deciding to create or redirect
      if (!Array.isArray(projects)) return
      if (projects.length > 0) {
        const target = projects[0]?.roomId
        if (target && target !== rid) {
          navigateToRoom(target)
        }
        setRidAutoCreated(false)
        return
      } else {
        // No existing projects: create ownership for the auto-created rid
        if (rid) {
          void convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: rid, userId: uid })
        }
        setRidAutoCreated(false)
        return
      }
    }

    // URL-provided roomId or already decided path: ensure ownership
    if (rid) {
      void convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: rid, userId: uid })
    }
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
  // Optimistic positions for clips that have been moved locally but the server
  // hasn't reflected the change yet. Prevents revert-then-flash on drop.
  const optimisticMoves = new Map<string, { trackId: string; startSec: number }>()
  
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

  // Clip resize state
  const MIN_CLIP_SEC = 0.05
  let clipResizing = false
  let resizingIds: { trackId: string; clipId: string; edge: 'left' | 'right' } | null = null
  let resizeOrigStart = 0
  let resizeOrigDuration = 0
  let resizeOrigPad = 0
  let resizeAudioStart = 0
  let resizeFixedLeft = 0
  let resizeFixedRight = 0

  // Scrubbing helpers
  let scrubbing = false
  // Marquee selection helpers
  let marqueeActive = false
  let marqueeAdditive = false
  let mStartX = 0
  let mStartY = 0
  const [marqueeRect, setMarqueeRect] = createSignal<{ x: number; y: number; width: number; height: number } | null>(null)

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

    const sm = syncMix()
    const localMix = loadLocalMixMap(roomId())
    const projected: Track[] = data.tracks.map((t: any, idx: number) => {
      const id = t._id as string
      const prev = oldTrackMap.get(id)
      const serverMuted = (t as any).muted as boolean | undefined
      const serverSoloed = (t as any).soloed as boolean | undefined
      return {
        id,
        name: prev?.name ?? `Track ${idx + 1}`,
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

    // If a drag is in progress, overlay the currently dragged clips' local positions
    if (draggingIds) {
      const localTracks = untrack(() => tracks())
      const sel = untrack(() => selectedClipIds())
      const idsToOverlay = sel && sel.size > 0 ? Array.from(sel) : [draggingIds.clipId]
      for (const id of idsToOverlay) {
        let localClip: Clip | undefined
        let localTid: string | undefined
        for (const lt of localTracks) {
          const found = lt.clips.find(cc => cc.id === id)
          if (found) { localClip = found; localTid = lt.id; break }
        }
        if (!localClip || !localTid) continue
        // Remove from all projected tracks to avoid duplicates
        for (const t of projected) {
          t.clips = t.clips.filter(cc => cc.id !== id)
        }
        const targetProjected = projectedMap.get(localTid)
        if (targetProjected) {
          targetProjected.clips.push({
            id: localClip.id,
            name: localClip.name,
            buffer: localClip.buffer ?? null,
            startSec: localClip.startSec,
            duration: localClip.duration,
            leftPadSec: localClip.leftPadSec ?? 0,
            color: localClip.color,
            sampleUrl: localClip.sampleUrl,
          })
        }
      }
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
    try { window.removeEventListener('mousemove', onScrubMove) } catch {}
    try { window.removeEventListener('mouseup', onScrubEnd) } catch {}
    try { window.removeEventListener('mousemove', onWindowMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onWindowMouseUp) } catch {}
    try { window.removeEventListener('mousemove', onLaneDragMove) } catch {}
    try { window.removeEventListener('mouseup', onLaneDragUp) } catch {}
    try { window.removeEventListener('mousemove', onSidebarMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onSidebarMouseUp) } catch {}
    try { window.removeEventListener('mousemove', onResizeMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onResizeMouseUp) } catch {}
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

  // Drag a clip (allow vertical track reassign)
  let dragging = false
  let dragDeltaX = 0
  let draggingIds: { trackId: string; clipId: string } | null = null
  let addedTrackDuringDrag: string | null = null
  let creatingTrackDuringDrag = false
  // Multi-drag snapshot captured on mouse down
  let multiDragging: null | {
    anchorClipId: string
    anchorOrigTrackIdx: number
    anchorOrigStartSec: number
    items: Array<{ clipId: string; origTrackIdx: number; origStartSec: number; duration: number }>
  } = null

  function onClipMouseDown(trackId: string, clipId: string, e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const t = tracks().find(t => t.id === trackId)
    const c = t?.clips.find(c => c.id === clipId)
    if (!t || !c) return
    // Shift-click should add to selection rather than start a drag
    if (e.shiftKey) {
      batch(() => {
        setSelectedTrackId(trackId)
        setSelectedClip({ trackId, clipId })
        setSelectedClipIds(prev => { const next = new Set(prev); next.add(clipId); return next })
      })
      return
    }
    const sel = selectedClipIds()
    const isMultiDrag = sel.has(clipId) && sel.size > 1

    dragging = true
    draggingIds = { trackId, clipId }
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
      if (!isMultiDrag) {
        // Replace multi-selection with this single clip when starting a drag
        setSelectedClipIds(new Set([clipId]))
      }
    })

    // Capture multi-drag snapshot if applicable
    if (isMultiDrag) {
      const ts = tracks()
      const anchorTrackIdx = ts.findIndex(tt => tt.id === trackId)
      const items: Array<{ clipId: string; origTrackIdx: number; origStartSec: number; duration: number }> = []
      for (const id of sel) {
        for (let i = 0; i < ts.length; i++) {
          const found = ts[i].clips.find(cc => cc.id === id)
          if (found) {
            items.push({ clipId: id, origTrackIdx: i, origStartSec: found.startSec, duration: found.duration })
            break
          }
        }
      }
      multiDragging = {
        anchorClipId: clipId,
        anchorOrigTrackIdx: anchorTrackIdx,
        anchorOrigStartSec: c.startSec,
        items,
      }
    } else {
      multiDragging = null
    }

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
            : [...ts, { id: newTrackId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [], muted: false, soloed: false }])
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
    if (multiDragging) {
      const snapshot = multiDragging!
      const selIds = new Set(snapshot.items.map(it => it.clipId))
      setTracks(ts => {
        const targetIdx = ts.findIndex(t => t.id === targetId)
        if (targetIdx < 0) return ts
        const deltaIdx = targetIdx - snapshot.anchorOrigTrackIdx

        // Remove all moving clips from their current tracks
        const base = ts.map(t => ({ ...t, clips: t.clips.filter(c => !selIds.has(c.id)) }))

        // Build additions per track index
        const adds: Map<number, Clip[]> = new Map()
        const findClip = (id: string): Clip | null => {
          for (const t of ts) {
            const f = t.clips.find(c => c.id === id)
            if (f) return f
          }
          return null
        }
        for (const it of snapshot.items) {
          const orig = findClip(it.clipId)
          if (!orig) continue
          const targetIndex = Math.max(0, Math.min(base.length - 1, it.origTrackIdx + deltaIdx))
          const newStart = Math.max(0, desiredStart + (it.origStartSec - snapshot.anchorOrigStartSec))
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
    }

    // Update drag tracking and selection if track changed
    if (draggingIds.trackId !== targetId) {
      const clipId = draggingIds.clipId
      draggingIds = { trackId: targetId, clipId }
      batch(() => {
        setSelectedTrackId(targetId!)
        setSelectedFXTarget(targetId!)
        setSelectedClip({ trackId: targetId!, clipId })
        if (!multiDragging) setSelectedClipIds(new Set([clipId]))
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
        const mdOuter = multiDragging
        setTracks(ts => {
          const hasNew = ts.some(t => t.id === newTrackId)
          const newTrack: Track = { id: newTrackId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [], muted: false, soloed: false }
          const base = hasNew ? ts : [...ts, newTrack]
          if (mdOuter) {
            const md = mdOuter
            const selIds = new Set(md.items.map(it => it.clipId))
            // Remove all moving clips
            const cleared = base.map(t => ({ ...t, clips: t.clips.filter(c => !selIds.has(c.id)) }))
            // Add all to their target tracks (offset by delta from anchor), clamped into bounds
            const anchorTargetIdx = cleared.findIndex(t => t.id === newTrackId)
            const adds: Map<number, Clip[]> = new Map()
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
          } else {
            // Single drag
            return base.map((t, i) => {
              const srcIdx = t.clips.some(c => c.id === moving.clipId) ? i : -1
              if (srcIdx === i) return { ...t, clips: t.clips.filter(c => c.id !== moving.clipId) }
              if (t.id === newTrackId) {
                // Find original clip in pre-base tracks
                for (const tt of ts) {
                  const moved = tt.clips.find(c => c.id === moving.clipId)
                  if (moved) return { ...t, clips: [...t.clips, { ...moved, startSec: desiredStart }] }
                }
              }
              return t
            })
          }
        })
        // Persist all moved clips
        if (multiDragging) {
          const md = multiDragging!
          const anchorTargetIdx = tracks().findIndex(tt => tt.id === newTrackId)
          for (const it of md.items) {
            const targetIndex = Math.max(0, Math.min(tracks().length - 1, anchorTargetIdx + (it.origTrackIdx - md.anchorOrigTrackIdx)))
            const targetTid = tracks()[targetIndex]?.id || newTrackId
            const newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
            void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, startSec: newStart, toTrackId: targetTid as any })
            // Optimistic: hold new position until server reflects it
            optimisticMoves.set(it.clipId, { trackId: targetTid, startSec: newStart })
          }
          // Keep selection; focus anchor
          batch(() => {
            setSelectedTrackId(newTrackId)
            setSelectedFXTarget(newTrackId)
            setSelectedClip({ trackId: newTrackId, clipId: moving.clipId })
          })
        } else {
          batch(() => {
            setSelectedTrackId(newTrackId)
            setSelectedFXTarget(newTrackId)
            setSelectedClip({ trackId: newTrackId, clipId: moving.clipId })
            setSelectedClipIds(new Set([moving.clipId]))
          })
          void convexClient.mutation(convexApi.clips.move, {
            clipId: moving.clipId as any,
            startSec: desiredStart,
            toTrackId: newTrackId as any,
          })
          // Optimistic single-clip move
          optimisticMoves.set(moving.clipId, { trackId: newTrackId, startSec: desiredStart })
        }
      } else {
        // Commit final clip position to server in the resolved target track
        if (multiDragging) {
          const md = multiDragging!
          const ts = tracks()
          // Resolve target track index from pointer
          let targetIdx = yToLaneIndex(e.clientY, scrollRef)
          targetIdx = Math.max(0, Math.min(targetIdx, ts.length - 1))
          const deltaIdx = targetIdx - md.anchorOrigTrackIdx
          for (const it of md.items) {
            const newStart = Math.max(0, desiredStart + (it.origStartSec - md.anchorOrigStartSec))
            const idx = Math.max(0, Math.min(ts.length - 1, it.origTrackIdx + deltaIdx))
            const tid = ts[idx].id
            void convexClient.mutation(convexApi.clips.move, { clipId: it.clipId as any, startSec: newStart, toTrackId: tid as any })
            // Optimistic: hold new position until server reflects it
            optimisticMoves.set(it.clipId, { trackId: tid, startSec: newStart })
          }
          // Keep selection; focus anchor
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
            // Optimistic single-clip move
            optimisticMoves.set(c.id, { trackId: t!.id, startSec: c.startSec })
            batch(() => {
              setSelectedClip({ trackId: t!.id, clipId: c.id })
              setSelectedClipIds(new Set([c.id]))
            })
          }
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
  }

  // --- Clip edge resize ---
  function onClipResizeStart(trackId: string, clipId: string, edge: 'left' | 'right', e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const t = tracks().find(t => t.id === trackId)
    const c = t?.clips.find(c => c.id === clipId)
    if (!t || !c) return
    // Do not allow simultaneous drag
    dragging = false
    draggingIds = null
    // Select
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
      setSelectedClipIds(new Set([clipId]))
    })
    // Capture original
    clipResizing = true
    resizingIds = { trackId, clipId, edge }
    resizeOrigStart = c.startSec
    resizeOrigDuration = c.duration
    resizeOrigPad = c.leftPadSec ?? 0
    resizeAudioStart = resizeOrigStart + resizeOrigPad
    resizeFixedLeft = c.startSec
    resizeFixedRight = c.startSec + c.duration

    window.addEventListener('mousemove', onResizeMouseMove)
    window.addEventListener('mouseup', onResizeMouseUp)
  }

  function onResizeMouseMove(e: MouseEvent) {
    if (!clipResizing || !resizingIds || !scrollRef) return
    const ids = resizingIds!
    const t = tracks().find(tt => tt.id === ids.trackId)
    if (!t) return
    const rect = scrollRef.getBoundingClientRect()
    const x = e.clientX - rect.left + (scrollRef?.scrollLeft || 0)
    const sec = Math.max(0, x / PPS)
    const others = t.clips.filter(cc => cc.id !== ids.clipId)
    const edge = ids.edge

    if (edge === 'left') {
      // Keep right edge fixed
      const right = resizeFixedRight
      const maxStartByLen = right - MIN_CLIP_SEC
      // Nearest left neighbor end
      let neighborEnd = 0
      for (const oc of others) {
        const end = oc.startSec + oc.duration
        if (end <= resizeOrigStart && end > neighborEnd) neighborEnd = end
      }
      const minStartBound = Math.max(0, neighborEnd + 0.0001)
      const maxStartBound = Math.min(resizeAudioStart, maxStartByLen)
      const newStart = Math.max(minStartBound, Math.min(sec, maxStartBound))
      const newDuration = Math.max(MIN_CLIP_SEC, right - newStart)
      const newLeftPad = Math.max(0, resizeAudioStart - newStart)
      setTracks(ts => ts.map(tr => tr.id !== t.id ? tr : ({
        ...tr,
        clips: tr.clips.map(cc => cc.id !== ids.clipId ? cc : ({ ...cc, startSec: newStart, duration: newDuration, leftPadSec: newLeftPad }))
      })))
    } else {
      // edge === 'right', keep left edge fixed
      const left = resizeFixedLeft
      const minRightByLen = left + MIN_CLIP_SEC
      // Nearest right neighbor start (>= original start)
      let neighborStart = Number.POSITIVE_INFINITY
      for (const oc of others) {
        if (oc.startSec >= resizeOrigStart && oc.startSec < neighborStart) neighborStart = oc.startSec
      }
      let newRight = Math.max(sec, minRightByLen)
      if (Number.isFinite(neighborStart)) newRight = Math.min(newRight, neighborStart - 0.0001)
      const newDuration = Math.max(MIN_CLIP_SEC, newRight - left)
      setTracks(ts => ts.map(tr => tr.id !== t.id ? tr : ({
        ...tr,
        clips: tr.clips.map(cc => cc.id !== ids.clipId ? cc : ({ ...cc, duration: newDuration }))
      })))
    }
  }

  function onResizeMouseUp() {
    if (!clipResizing || !resizingIds) return
    const ids = resizingIds!
    const t = tracks().find(tt => tt.id === ids.trackId)
    const c = t?.clips.find(cc => cc.id === ids.clipId)
    clipResizing = false
    resizingIds = null
    window.removeEventListener('mousemove', onResizeMouseMove)
    window.removeEventListener('mouseup', onResizeMouseUp)
    if (t && c) {
      // Persist
      void convexClient.mutation((convexApi as any).clips.setTiming, {
        clipId: c.id as any,
        startSec: c.startSec,
        duration: c.duration,
        leftPadSec: c.leftPadSec ?? 0,
      })
    }
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
        // If not additive drag, clear selection on background click
        if (!e.shiftKey) setSelectedClipIds(new Set<string>())
      })
    }

    // Prepare for marquee selection; start scrubbing by default and switch to marquee on drag beyond threshold
    marqueeAdditive = !!e.shiftKey
    const rect = scrollRef!.getBoundingClientRect()
    mStartX = e.clientX - rect.left + (scrollRef?.scrollLeft || 0)
    mStartY = e.clientY - rect.top
    marqueeActive = false
    window.addEventListener('mousemove', onLaneDragMove)
    window.addEventListener('mouseup', onLaneDragUp)
    startScrub(e.clientX)
  }

  function onLaneDragMove(e: MouseEvent) {
    if (!scrollRef) return
    const rect = scrollRef.getBoundingClientRect()
    const currX = e.clientX - rect.left + (scrollRef?.scrollLeft || 0)
    const currY = e.clientY - rect.top
    const dx = Math.abs(currX - mStartX)
    const dy = Math.abs(currY - mStartY)
    if (!marqueeActive && (dx > 4 || dy > 4)) {
      // Activate marquee; stop scrubbing if it was started
      marqueeActive = true
      try { onScrubEnd() } catch {}
    }
    if (!marqueeActive) return
    const x = Math.min(mStartX, currX)
    const y = Math.min(mStartY, currY) - RULER_HEIGHT
    const width = Math.abs(currX - mStartX)
    const height = Math.abs(currY - mStartY)
    const normY = Math.max(0, y)
    setMarqueeRect({ x, y: normY, width, height })

    // Compute selected clips intersecting the marquee
    const selected = new Set<string>()
    const ts = tracks()
    for (let i = 0; i < ts.length; i++) {
      const laneTop = i * LANE_HEIGHT
      const laneBottom = laneTop + LANE_HEIGHT
      const rTop = normY
      const rBottom = normY + height
      const verticalOverlap = !(laneBottom <= rTop || laneTop >= rBottom)
      if (!verticalOverlap) continue
      const t = ts[i]
      for (const c of t.clips) {
        const cx1 = c.startSec * PPS
        const cx2 = cx1 + c.duration * PPS
        const rx1 = x
        const rx2 = x + width
        const horizontalOverlap = !(cx2 <= rx1 || cx1 >= rx2)
        if (horizontalOverlap) selected.add(c.id)
      }
    }
    if (marqueeAdditive) {
      setSelectedClipIds(prev => {
        const next = new Set(prev)
        for (const id of selected) next.add(id)
        return next
      })
    } else {
      setSelectedClipIds(selected)
    }
  }

  function onLaneDragUp() {
    window.removeEventListener('mousemove', onLaneDragMove)
    window.removeEventListener('mouseup', onLaneDragUp)
    setMarqueeRect(null)
    marqueeActive = false
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
