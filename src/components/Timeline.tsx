import { type Component, type JSX, For, Show, createEffect, createSignal, onCleanup, onMount, batch, untrack } from 'solid-js'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '~/components/ui/dialog'
import type { Track, Clip, SelectedClip } from '~/types/timeline'
import { getAudioEngine, resetAudioEngine } from '~/lib/audio-engine-singleton'
import { timelineDurationSec, PPS, RULER_HEIGHT, LANE_HEIGHT, yToLaneIndex } from '~/lib/timeline-utils'
import { canUseLocalStorage, loadLocalMixMap, saveLocalMix, loadMixSyncFlag, saveMixSyncFlag, loadGridSettings, saveGridSettings, loadBpm, saveBpm } from '~/lib/timeline-storage'
import { ensureRoomShareLink } from '~/lib/timeline-share'
import { useTimelineKeyboard } from '~/hooks/useTimelineKeyboard'
import { useTimelineClipImport } from '~/hooks/useTimelineClipImport'
import { useTimelineClipActions } from '~/hooks/useTimelineClipActions'
import TransportControls from './timeline/TransportControls'
import TimelineRuler from './timeline/TimelineRuler'
import TrackLane from './timeline/TrackLane'
import TrackSidebar from './timeline/TrackSidebar'
import EffectsPanel from './timeline/EffectsPanel'
import MidiEditorCard from './midi/MidiEditorCard'
import { Button } from './ui/button'
import { convexClient, convexApi } from '~/lib/convex'
import { useTimelineData } from '~/hooks/useTimelineData'
import { usePlayheadControls } from '~/hooks/usePlayheadControls'
import { useClipDrag } from '~/hooks/useClipDrag'
import { useClipResize } from '~/hooks/useClipResize'
import { useTimelineSelection } from '~/hooks/useTimelineSelection'
import { useClipBuffers } from '~/hooks/useClipBuffers'
import { useTrackRecording } from '~/hooks/useTrackRecording'
import RecordingPreview from './timeline/RecordingPreview'
import GridOverlay from './timeline/GridOverlay'

const volumeTimers = new Map<string, number>()
const optimisticMoves = new Map<string, { trackId: string; startSec: number }>()

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
  // Transport tempo & metronome
  const [bpm, setBpm] = createSignal(120)
  const [metronomeEnabled, setMetronomeEnabled] = createSignal(false)
  const [recordArmTrackId, setRecordArmTrackId] = createSignal<string | null>(null)
  const [isRecording, setIsRecording] = createSignal(false)
  // Grid / snapping state
  const [gridEnabled, setGridEnabled] = createSignal(true)
  const [gridDenominator, setGridDenominator] = createSignal(4) // 1/4 notes by default

  // Drag-drop visual target lane
  const [dropTargetLane, setDropTargetLane] = createSignal<number | null>(null)
  const [dropAtNewTrack, setDropAtNewTrack] = createSignal(false)

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
  // Load syncMix per room
  createEffect(() => {
    if (!canUseLocalStorage()) {
      setSyncMix(false)
      return
    }
    setSyncMix(loadMixSyncFlag(roomId()))
  })

  // Load grid settings per room
  createEffect(() => {
    const rid = roomId()
    if (!canUseLocalStorage() || !rid) return
    const settings = loadGridSettings(rid)
    batch(() => {
      setGridEnabled(settings.enabled)
      setGridDenominator(settings.denominator)
    })
  })

  // Save grid settings when they change
  createEffect(() => {
    const rid = roomId()
    const enabled = gridEnabled()
    const denom = gridDenominator()
    if (!rid) return
    saveGridSettings(rid, enabled, denom)
  })

  // Load BPM per room (local-only, like grid)
  createEffect(() => {
    const rid = roomId()
    if (!canUseLocalStorage() || !rid) return
    const loaded = loadBpm(rid)
    setBpm(loaded)
  })

  // Save BPM when it changes
  createEffect(() => {
    const rid = roomId()
    if (!canUseLocalStorage() || !rid) return
    const value = bpm()
    saveBpm(rid, value)
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
    ensureRoomShareLink(roomId(), (rid) => setRoomId(rid))
  }

  // DOM refs
  let scrollRef: HTMLDivElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let containerRef: HTMLDivElement | undefined
  let rootRef: HTMLDivElement | undefined
  // Sidebar resize state
  let resizing = false
  let resizeStartX = 0
  let resizeStartWidth = 0

  const {
    handleDrop: onDrop,
    handleFiles,
    handleAddAudio,
    handleInsertSample,
  } = useTimelineClipImport({
    audioEngine,
    tracks,
    setTracks,
    selectedTrackId,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
    playheadSec,
    roomId,
    userId,
    convexClient,
    convexApi,
    audioBufferCache,
    uploadToR2,
    getScrollElement: () => scrollRef,
    getFileInput: () => fileInputRef,
    // snapping
    bpm,
    gridEnabled,
    gridDenominator,
  })

  const {
    onClipMouseDown,
    activeDrag,
  } = useClipDrag({
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
    // snapping
    bpm,
    gridEnabled,
    gridDenominator,
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
    // snapping
    bpm,
    gridEnabled,
    gridDenominator,
  })

  const {
    onClipClick,
    deleteSelectedClips,
    duplicateSelectedClips,
    performDeleteTrack,
    requestDeleteSelectedTrack,
    handleKeyboardAction,
  } = useTimelineClipActions({
    tracks,
    setTracks,
    selectedTrackId,
    setSelectedTrackId,
    selectedClipIds,
    setSelectedClipIds,
    setSelectedClip,
    setSelectedFXTarget,
    setPendingDeleteTrackId,
    setConfirmOpen,
    roomId,
    userId,
    convexClient,
    convexApi,
    audioBufferCache,
    bpm,
    gridEnabled,
    gridDenominator,
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

  const notifyRecording = (message: string) => {
    console.warn('[Timeline][recording]', message)
  }

  // ===== Floating MIDI editor state =====
  const [midiEditorClipId, setMidiEditorClipId] = createSignal<string | null>(null)
  const [midiCard, setMidiCard] = createSignal<{ x: number; y: number; w: number; h: number }>({ x: 80, y: 80, w: 720, h: 360 })
  let midiCardPersistTimer: number | null = null
  const midiCardStorageKey = () => {
    const rid = roomId() || 'default'
    return `mb:midi_card:${rid}`
  }
  // Load persisted position/size per room
  createEffect(() => {
    const key = midiCardStorageKey()
    if (!canUseLocalStorage()) return
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          const { x, y, w, h } = parsed
          if ([x, y, w, h].every((v: any) => typeof v === 'number' && isFinite(v))) {
            setMidiCard({ x, y, w, h })
          }
        }
      }
    } catch {}
  })
  const persistMidiCard = () => {
    if (!canUseLocalStorage()) return
    try { window.localStorage.setItem(midiCardStorageKey(), JSON.stringify(midiCard())) } catch {}
  }
  const schedulePersistMidiCard = () => {
    if (midiCardPersistTimer) {
      clearTimeout(midiCardPersistTimer)
      midiCardPersistTimer = null
    }
    midiCardPersistTimer = window.setTimeout(() => {
      midiCardPersistTimer = null
      persistMidiCard()
    }, 250)
  }
  const closeMidiEditor = () => setMidiEditorClipId(null)
  const openMidiEditorFor = (clipId: string) => {
    // Only open for clips that have MIDI payload
    try {
      for (const t of tracks()) {
        const c = t.clips.find(cc => cc.id === clipId)
        if (c && (c as any).midi) {
          setMidiEditorClipId(clipId)
          return
        }
      }
    } catch {}
  }

  // Auto-close editor if the clip disappears or no longer has MIDI
  createEffect(() => {
    const id = midiEditorClipId()
    if (!id) return
    let ok = false
    for (const t of tracks()) {
      const c = t.clips.find(cc => cc.id === id)
      if (c && (c as any).midi) { ok = true; break }
    }
    if (!ok) setMidiEditorClipId(null)
  })

  const recordingControls = useTrackRecording({
    audioEngine,
    tracks,
    setTracks,
    recordArmTrackId,
    setRecordArmTrackId,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
    playheadSec,
    uploadToR2,
    audioBufferCache,
    roomId,
    userId,
    convexClient,
    convexApi,
    requestTransportPlay: requestPlay,
    setIsRecording,
    isPlaying,
    notify: notifyRecording,
  })

  const {
    toggleRecording: toggleRecordingSession,
    stopRecording: stopRecordingSession,
    previewPoints,
    previewStartSec,
    recordingTrackId,
  } = recordingControls

  const handleTransportStop = () => {
    if (isRecording()) {
      void stopRecordingSession()
    }
    handleStop()
  }

  const handleTransportPause = () => {
    if (isRecording()) {
      void stopRecordingSession()
    }
    handlePause()
  }

  const ensureTrackForRecording = async (): Promise<string | null> => {
    const uid = userId()
    const rid = roomId()
    if (!uid || !rid) {
      notifyRecording('Recording is only available when signed in to a project.')
      return null
    }

    const currentTracks = tracks()
    const armed = recordArmTrackId()
    if (armed) {
      const armedTrack = currentTracks.find(t => t.id === armed)
      if (armedTrack && (!armedTrack.lockedBy || armedTrack.lockedBy === uid)) {
        return armedTrack.id
      }
    }

    const available = currentTracks.find(t => !t.lockedBy || t.lockedBy === uid)
    if (available) {
      setRecordArmTrackId(available.id)
      return available.id
    }

    try {
      const newTrackId = await convexClient.mutation(convexApi.tracks.create, { roomId: rid as any, userId: uid } as any) as any as string
      setTracks(ts => ts.some(t => t.id === newTrackId) ? ts : [
        ...ts,
        {
          id: newTrackId,
          name: `Track ${ts.length + 1}`,
          volume: 0.8,
          clips: [],
          muted: false,
          soloed: false,
          lockedBy: null,
        },
      ])
      batch(() => {
        setSelectedTrackId(newTrackId)
        setSelectedFXTarget(newTrackId)
        setRecordArmTrackId(newTrackId)
      })
      return newTrackId
    } catch (err) {
      console.error('[Timeline] failed to create track for recording', err)
      notifyRecording('Failed to create a new track for recording.')
      return null
    }
  }

  const handleToggleRecordArm = (trackId: string) => {
    if (isRecording()) return
    const uid = userId()
    const target = tracks().find(t => t.id === trackId)
    if (target && target.lockedBy && target.lockedBy !== uid) return
    setRecordArmTrackId(prev => (prev === trackId ? null : trackId))
  }

  const handleRecordToggle = async () => {
    const trackId = await ensureTrackForRecording()
    if (!trackId) return
    const result = await toggleRecordingSession(trackId)
    if (!result.ok && result.reason) {
      notifyRecording(result.reason)
    } else if (result.ok) {
      batch(() => {
        setSelectedTrackId(trackId)
        setSelectedFXTarget(trackId)
        setRecordArmTrackId(trackId)
      })
    }
  }

  const handleLaneMouseDown: JSX.EventHandler<HTMLDivElement, MouseEvent> = (event) => {
    if (midiEditorClipId()) { event.preventDefault(); event.stopPropagation(); return }
    onLaneMouseDown(event, scrollRef)
  }

  const onRulerMouseDown = (event: MouseEvent) => {
    event.preventDefault()
    if (midiEditorClipId()) { event.stopPropagation(); return }
    startScrub(event.clientX)
  }

  // Keep audio engine synced with tracks
  createEffect(() => {
    audioEngine.updateTrackGains(tracks())
  })

  createEffect(() => {
    audioEngine.setBpm(bpm())
  })

  createEffect(() => {
    audioEngine.setMetronomeEnabled(metronomeEnabled())
  })

  const clampBpm = (value: number) => {
    if (!Number.isFinite(value)) return bpm()
    return Math.min(300, Math.max(30, Math.round(value)))
  }

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
      const serverLockedBy = typeof (t as any).lockedBy === 'string' ? (t as any).lockedBy : null
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
        lockedBy: serverLockedBy ?? prev?.lockedBy ?? null,
        kind: (t as any).kind ?? prev?.kind ?? 'audio',
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
        lockedBy: prev?.lockedBy ?? null,
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
        midi: (c as any).midi,
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
            midi: (localClip as any).midi,
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
    const armedId = recordArmTrackId()
    if (armedId) {
      const uid = userId()
      const available = projected.find(t => t.id === armedId)
      if (!available || (available.lockedBy && available.lockedBy !== uid)) {
        setRecordArmTrackId(null)
      }
    }
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
    resetAudioEngine()
    if (midiCardPersistTimer) { clearTimeout(midiCardPersistTimer); midiCardPersistTimer = null }
    for (const timer of volumeTimers.values()) {
      clearTimeout(timer)
    }
    volumeTimers.clear()
    clearClipBufferCaches()
    optimisticMoves.clear()
  })

  function onDragOver(e: DragEvent) {
    e.preventDefault()
    try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy' } catch {}
    // Update target lane highlight
    if (scrollRef) {
      const idx = yToLaneIndex(e.clientY, scrollRef)
      const len = tracks().length
      if (idx >= 0 && idx < len) {
        setDropTargetLane(idx)
        setDropAtNewTrack(false)
      } else if (idx >= len) {
        setDropTargetLane(null)
        setDropAtNewTrack(true)
      } else {
        setDropTargetLane(null)
        setDropAtNewTrack(false)
      }
    }
  }

  // Global fallback to ensure drops are received when dragging from floating menus
  function onDragOverGlobal(e: DragEvent) {
    const dt = e.dataTransfer
    const types = Array.from(dt?.types ?? [])
    const hasCustom = types.includes('application/x-mediabunny-sample')
    const urlText = dt?.getData('text/uri-list') || dt?.getData('text/plain')
    const looksLikeUrl = !!urlText && (/^https?:\/\//i.test(urlText) || urlText.startsWith('blob:'))
    if (!hasCustom && !looksLikeUrl) return
    // Only signal copy inside our app root
    const root = rootRef
    if (!root) return
    const r = root.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
    e.preventDefault()
    try { if (dt) dt.dropEffect = 'copy' } catch {}
    // Update lane highlight using global handler as well
    if (scrollRef) {
      const idx = yToLaneIndex(e.clientY, scrollRef)
      const len = tracks().length
      if (idx >= 0 && idx < len) {
        setDropTargetLane(idx)
        setDropAtNewTrack(false)
      } else if (idx >= len) {
        setDropTargetLane(null)
        setDropAtNewTrack(true)
      } else {
        setDropTargetLane(null)
        setDropAtNewTrack(false)
      }
    }
  }

  function onWindowDrop(e: DragEvent) {
    const dt = e.dataTransfer
    const types = Array.from(dt?.types ?? [])
    const hasCustom = types.includes('application/x-mediabunny-sample')
    const urlText = dt?.getData('text/uri-list') || dt?.getData('text/plain')
    const looksLikeUrl = !!urlText && (/^https?:\/\//i.test(urlText) || urlText.startsWith('blob:'))
    if (!hasCustom && !looksLikeUrl) return
    // Only handle drops inside our app root
    const root = rootRef
    if (!root) return
    const r = root.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
    // Prevent default navigation and delegate to normal handler
    e.preventDefault()
    void onDrop(e)
    setDropTargetLane(null)
    setDropAtNewTrack(false)
  }

  onMount(() => {
    window.addEventListener('dragover', onDragOverGlobal, { capture: true })
    window.addEventListener('drop', onWindowDrop as any, { capture: true })
  })
  onCleanup(() => {
    window.removeEventListener('dragover', onDragOverGlobal, { capture: true } as any)
    window.removeEventListener('drop', onWindowDrop as any, { capture: true } as any)
  })

  async function onFileInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    await handleFiles(input.files)
    input.value = ''
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
        // Skip MIDI clips (no audio buffer to fetch)
        if ((c as any).midi) continue
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

  // Audition helper: preview a short note using the target track's synth chain
  const auditionNote = (pitch: number, velocity = 0.9, durSec = 0.35) => {
    try {
      audioEngine.ensureAudio()
      const ctx: AudioContext | undefined = (audioEngine as any).audioCtx
      if (!ctx) return
      // Resolve track id from currently edited MIDI clip if possible
      const id = midiEditorClipId()
      let trackId = selectedFXTarget() || selectedTrackId()
      if (id) {
        for (const t of tracks()) {
          if (t.clips.some(cc => cc.id === id)) { trackId = t.id; break }
        }
      }
      const synthGain: GainNode | undefined = (audioEngine as any).ensureTrackSynthGainNode?.(trackId || 'master')
      if (!synthGain) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = ctx.currentTime
      const end = start + Math.max(0.05, durSec)
      const amp = Math.max(0, Math.min(1.5, velocity))
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(440 * Math.pow(2, (pitch - 69) / 12), start)
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(amp, start + 0.01)
      gain.gain.linearRampToValueAtTime(0, end)
      osc.connect(gain)
      gain.connect(synthGain)
      osc.start(start)
      osc.stop(end)
    } catch {}
  }

  return (
    <div ref={el => (rootRef = el!)} class="h-full w-full flex flex-col bg-neutral-950 text-neutral-200" onDragOver={onDragOver} onDrop={async (e) => { if (e.defaultPrevented) return; await onDrop(e); setDropTargetLane(null); setDropAtNewTrack(false) }} onDragLeave={() => { setDropTargetLane(null); setDropAtNewTrack(false) }}>
      <input ref={el => (fileInputRef = el!)} type="file" accept="audio/*" class="hidden" onChange={onFileInput} />
      
      <TransportControls
        isPlaying={isPlaying()}
        playheadSec={playheadSec()}
        onPlay={() => requestPlay()}
        onPause={handleTransportPause}
        onStop={handleTransportStop}
        onAddAudio={() => handleAddAudio()}
        onShare={handleShare}
        onMasterFX={() => { setSelectedFXTarget('master'); setBottomFXOpen(true) }}
        bpm={bpm()}
        onChangeBpm={(next) => setBpm(clampBpm(next))}
        metronomeEnabled={metronomeEnabled()}
        onToggleMetronome={() => setMetronomeEnabled((prev) => !prev)}
        gridEnabled={gridEnabled()}
        onToggleGrid={() => setGridEnabled(prev => !prev)}
        gridDenominator={gridDenominator()}
        onChangeGridDenominator={(n: number) => setGridDenominator(n)}
        isRecording={isRecording()}
        onToggleRecord={handleRecordToggle}
        onJumpToClip={(clipId, trackId, startSec) => jumpToClip(trackId, clipId, startSec)}
        onInsertSample={(payload) => { void handleInsertSample(payload) }}
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
            style={{ width: `${duration() * PPS}px`, height: `${RULER_HEIGHT + (tracks().length + (dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}px` }} 
            onMouseDown={handleLaneMouseDown}
          >
            <TimelineRuler
              durationSec={duration()}
              bpm={bpm()}
              denom={gridDenominator()}
              gridEnabled={gridEnabled()}
              onMouseDown={onRulerMouseDown}
            />
            
            <div class="absolute left-0 right-0" style={{ top: `${RULER_HEIGHT}px`, height: `${(tracks().length + (dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}px` }}>
              <For each={tracks()}>
                {(track, i) => (
                  <TrackLane
                    track={track}
                    index={i()}
                    isDropTarget={dropTargetLane() === i()}
                    selectedClipIds={selectedClipIds()}
                    onClipMouseDown={onClipMouseDown}
                    onClipClick={onClipClick}
                    onClipResizeStart={onClipResizeStart}
                    bpm={bpm()}
                    onClipDblClick={(_, clipId) => {
                      try {
                        const t = tracks().find(tt => tt.id === track.id)
                        const c = t?.clips.find(cc => cc.id === clipId)
                        if (c && (c as any).midi) {
                          openMidiEditorFor(clipId)
                        }
                      } catch {}
                    }}
                  />
                )}
              </For>
              {(() => {
                const start = previewStartSec()
                const points = previewPoints()
                const rid = recordingTrackId()
                if (!isRecording() || start == null || points.length === 0 || !rid) return null
                const trackIndex = tracks().findIndex(t => t.id === rid)
                if (trackIndex < 0) return null
                return (
                  <div
                    class="absolute left-0 right-0 pointer-events-none"
                    style={{ top: `${trackIndex * LANE_HEIGHT}px`, height: `${LANE_HEIGHT}px` }}
                  >
                    <RecordingPreview startSec={start} points={points} />
                  </div>
                )
              })()}
              {dropAtNewTrack() && (
                <div
                  class="absolute left-0 right-0 border-t border-green-500/40 bg-green-500/10 pointer-events-none"
                  style={{ top: `${tracks().length * LANE_HEIGHT}px`, height: `${LANE_HEIGHT}px` }}
                />
              )}
              {/* Grid overlay: render above lanes (faint) and below selection/playhead; clipped to lanes by container */}
              <GridOverlay
                durationSec={duration()}
                heightPx={(tracks().length + (dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}
                bpm={bpm()}
                denom={gridDenominator()}
                enabled={gridEnabled()}
              />
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

              {/* Floating MIDI Editor Card */}
              <Show when={midiEditorClipId()}>
                {/* Invisible overlay to prevent interactions with content behind the editor */}
                <div
                  class="absolute inset-0 z-40 bg-transparent"
                  style={{ 'touch-action': 'none' }}
                  onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                  onPointerMove={(e) => { e.preventDefault(); e.stopPropagation() }}
                  onPointerUp={(e) => { e.preventDefault(); e.stopPropagation() }}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
                  onWheel={(e) => { e.preventDefault(); e.stopPropagation() }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
                />
                <MidiEditorCard
                  clipId={midiEditorClipId()!}
                  bpm={bpm()}
                  gridDenominator={gridDenominator()}
                  clipDurationSec={(() => {
                    const id = midiEditorClipId()
                    if (!id) return 1
                    for (const t of tracks()) {
                      const c = t.clips.find(cc => cc.id === id)
                      if (c) return c.duration
                    }
                    return 1
                  })()}
                  x={midiCard().x}
                  y={midiCard().y}
                  w={midiCard().w}
                  h={midiCard().h}
                  onClose={() => closeMidiEditor()}
                  onChangeBounds={(next: { x: number; y: number; w: number; h: number }) => { setMidiCard(next); schedulePersistMidiCard() }}
                  midi={(() => {
                    const id = midiEditorClipId()
                    if (!id) return undefined
                    for (const t of tracks()) {
                      const c = t.clips.find(cc => cc.id === id)
                      if (c) return (c as any).midi
                    }
                    return undefined
                  })()}
                  userId={userId() ?? undefined}
                  onAuditionNote={(p, v, d) => auditionNote(p, v, d)}
                />
              </Show>
            </div>
          </div>
        </div>

        <TrackSidebar
          tracks={tracks()}
          selectedTrackId={selectedTrackId()}
          sidebarWidth={sidebarWidth()}
          isPlaying={isPlaying()}
          getTrackLevel={(id) => {
            try { return (audioEngine as any).getTrackLevel?.(id) ?? 0 } catch { return 0 }
          }}
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
          onAddInstrumentTrack={async () => {
            const id = await convexClient.mutation(convexApi.tracks.create as any, { roomId: roomId(), userId: userId(), kind: 'instrument' } as any) as any as string
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
              saveMixSyncFlag(rid, next)
            }
          }}
          onSidebarMouseDown={onSidebarMouseDown}
          recordArmTrackId={recordArmTrackId()}
          onToggleRecordArm={handleToggleRecordArm}
          currentUserId={userId()}
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
        playheadSec={playheadSec()}
        onSelectClip={(trackId, clipId, startSec) => {
          // Select the created clip and jump to it
          batch(() => {
            setSelectedTrackId(trackId)
            setSelectedClip({ trackId, clipId })
            setSelectedFXTarget(trackId)
            setSelectedClipIds(new Set([clipId]))
          })
          setPlayhead(Math.max(0, startSec), tracks())
          openMidiEditorFor(clipId)
          try {
            if (scrollRef) {
              const centerLeft = Math.max(0, startSec * PPS - (scrollRef.clientWidth / 2))
              scrollRef.scrollLeft = Math.floor(centerLeft)
            }
          } catch {}
        }}
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
