import { type Component, type JSX, For, createEffect, createMemo, createSignal, onCleanup, onMount, batch, untrack } from 'solid-js'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '~/components/ui/dialog'
import type { Track, Clip, SelectedClip, TrackRouting, TrackSend } from '~/types/timeline'
import { getAudioEngine, resetAudioEngine } from '~/lib/audio-engine-singleton'
import { timelineDurationSec, PPS, RULER_HEIGHT, LANE_HEIGHT, yToLaneIndex, FX_OFFSET_PX } from '~/lib/timeline-utils'
import { canUseLocalStorage, loadLocalMixMap, saveLocalMix, loadMixSyncFlag, saveMixSyncFlag, loadGridSettings, saveGridSettings, loadBpm, saveBpm, loadLoopSettings, saveLoopSettings } from '~/lib/timeline-storage'
import { ensureRoomShareLink } from '~/lib/timeline-share'
import { useTimelineKeyboard } from '~/hooks/useTimelineKeyboard'
import { useTimelineClipImport } from '~/hooks/useTimelineClipImport'
import { useTimelineClipActions } from '~/hooks/useTimelineClipActions'
import TransportControls from './timeline/TransportControls'
import TimelineRuler from './timeline/TimelineRuler'
import TrackLane from './timeline/TrackLane'
import TrackSidebar from './timeline/TrackSidebar'
import { Button } from './ui/button'
import { convexClient, convexApi, useConvexQuery } from '~/lib/convex'
import { useTimelineData } from '~/hooks/useTimelineData'
import { usePlayheadControls } from '~/hooks/usePlayheadControls'
import { useClipDrag } from '~/hooks/useClipDrag'
import { useClipResize } from '~/hooks/useClipResize'
import { useTimelineSelection } from '~/hooks/useTimelineSelection'
import { useClipBuffers } from '~/hooks/useClipBuffers'
import { normalizeCommandTrackIndices } from '~/lib/agent-command-targets'
import { canTrackReceiveAudioClip, normalizeTrackRouting } from '~/lib/track-routing'
import { buildTrackRoutingMutationInput, isTrackRoutingEqual } from '~/lib/track-routing-state'
import { selectMasterTarget, selectPrimaryClip, selectTrackTarget } from '~/lib/timeline-selection'
import { createOptimisticTrackWithHistory } from '~/lib/tracks'
import { useTrackRecording } from '~/hooks/useTrackRecording'
import { createUndoManager, type UndoManager } from '~/lib/undo/manager'
import type { HistoryEntry } from '~/lib/undo/types'
import { loadHistory, saveHistory } from '~/lib/timeline-storage'
import { buildEffectParamsHistoryEntry, buildTrackBooleanHistoryEntry, buildTrackRoutingHistoryEntry, buildTrackVolumeHistoryEntry } from '~/lib/undo/builders'
import { execUndo, execRedo } from '~/lib/undo/exec'
import TimelineOverlays from './timeline/timeline-overlays'
import TimelinePanels from './timeline/timeline-panels'

type ScheduledTrackWrite = { timer: number; token: number }

const optimisticMoves = new Map<string, { trackId: string; startSec: number }>()
type LocalTrackRouting = TrackRouting & { sends: TrackSend[] }
type ProjectDeleteConflictReason = 'foreign-clips' | 'not-empty'
type ProjectDeleteConflict = {
  trackId: string
  reason: ProjectDeleteConflictReason
}
type ProjectDeletePreflightResult = {
  status: 'ok' | 'conflict'
  conflictTrackIds: string[]
  conflicts: ProjectDeleteConflict[]
}
type ProjectDeleteResult = {
  status: 'deleted' | 'conflict'
  conflictTrackIds: string[]
  conflicts: ProjectDeleteConflict[]
}
type AgentMixOp = { type: 'setMute' | 'setSolo'; indices: number[]; value: boolean; exclusive?: boolean }

const addIdsToSet = (current: Set<string>, ids: Iterable<string>) => {
  let next: Set<string> | null = null
  for (const id of ids) {
    if (!id) continue
    if (next) {
      next.add(id)
      continue
    }
    if (current.has(id)) continue
    next = new Set(current)
    next.add(id)
  }
  return next ?? current
}

const mergeIdSets = (serverIds: Set<string>, optimisticIds: Set<string>) => {
  if (optimisticIds.size === 0) return serverIds
  const merged = new Set(serverIds)
  for (const id of optimisticIds) merged.add(id)
  return merged
}

const pruneOptimisticIds = (
  current: Set<string>,
  serverIds: Set<string>,
  existingIds: Set<string>,
  seenIds: Set<string>,
) => {
  const next = new Set<string>()
  for (const id of current) {
    if (serverIds.has(id)) continue
    if (!seenIds.has(id) || existingIds.has(id)) next.add(id)
  }
  if (next.size === current.size) {
    let unchanged = true
    for (const id of next) {
      if (!current.has(id)) {
        unchanged = false
        break
      }
    }
    if (unchanged) return current
  }
  return next
}

const resolveProjectedTrackVolume = (input: {
  canWriteSharedMix: boolean
  syncMix: boolean
  serverVolume: number
  localVolume?: number
  pendingSharedVolume?: number
}) => {
  const { canWriteSharedMix, syncMix, serverVolume, localVolume, pendingSharedVolume } = input
  if (canWriteSharedMix) return pendingSharedVolume ?? serverVolume
  return syncMix ? serverVolume : (localVolume ?? serverVolume)
}

const Timeline: Component = () => {
  const volumeTimers = new Map<string, ScheduledTrackWrite>()
  const routingTimers = new Map<string, ScheduledTrackWrite>()
  // State
  const [tracks, setTracks] = createSignal<Track[]>([])
  const [selectedTrackId, setSelectedTrackId] = createSignal('')
  const [selectedClip, setSelectedClip] = createSignal<SelectedClip>(null)
  // Multi-selection: set of selected clip IDs (selectedClip is the primary/last-selected)
  const [selectedClipIds, setSelectedClipIds] = createSignal<Set<string>>(new Set<string>(), { equals: false })
  const [bottomFXOpen, setBottomFXOpen] = createSignal(true)
  const [selectedFXTarget, setSelectedFXTarget] = createSignal<string>('master')
  const [agentPanelOpen, setAgentPanelOpen] = createSignal(false)
  const [sharedChatOpen, setSharedChatOpen] = createSignal(false)
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
  const [loopEnabled, setLoopEnabled] = createSignal(false)
  const [loopStartSec, setLoopStartSec] = createSignal(0)
  const [loopEndSec, setLoopEndSec] = createSignal(8)
  const [exportOpen, setExportOpen] = createSignal(false)

  // Drag-drop visual target lane
  const [dropTargetLane, setDropTargetLane] = createSignal<number | null>(null)
  const [dropAtNewTrack, setDropAtNewTrack] = createSignal(false)
  const [optimisticTrackWriteIds, setOptimisticTrackWriteIds] = createSignal<Set<string>>(new Set<string>(), { equals: false })
  const [optimisticClipWriteIds, setOptimisticClipWriteIds] = createSignal<Set<string>>(new Set<string>(), { equals: false })
  const [pendingSharedTrackVolumes, setPendingSharedTrackVolumes] = createSignal<Map<string, number>>(new Map<string, number>(), { equals: false })
  const [pendingSharedTrackRouting, setPendingSharedTrackRouting] = createSignal<Map<string, LocalTrackRouting>>(new Map<string, LocalTrackRouting>(), { equals: false })

  // Audio engine
  const audioEngine = getAudioEngine()
  // Undo/Redo manager (per room)
  let undoMgr: UndoManager | null = null
  const pushHistory = (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => {
    if (undoMgr) undoMgr.push(entry, mergeKey, mergeWindowMs)
  }
  const persistLocalTrackMix = (historyRoomId: string, trackId: string, patch: { volume?: number; muted?: boolean; soloed?: boolean }) => {
    saveLocalMix(historyRoomId, trackId, patch)
  }
  const selectionSetters = { setSelectedTrackId, setSelectedClip, setSelectedClipIds, setSelectedFXTarget }
  const seenOptimisticTrackIds = new Set<string>()
  const seenOptimisticClipIds = new Set<string>()
  // Collaboration: roomId from ?roomId=; ownership tied to Better Auth userId
  const { roomId, setRoomId, userId, myProjects, fullView, navigateToRoom } = useTimelineData()

  // Tracks owned by current user (server-authoritative share permissions)
  const ownedTracksQ = useConvexQuery(
    (convexApi as any).ownerships.listOwnedTrackIds,
    () => {
      const rid = roomId()
      const uid = userId()
      return rid && uid ? ({ roomId: rid, ownerUserId: uid } as any) : null
    },
    () => ['owned-tracks', roomId(), userId()]
  )

  const ownedTrackIds = createMemo(() => {
    const ownedRaw: any = (ownedTracksQ as any)?.data
    const ownedArr: any = typeof ownedRaw === 'function' ? ownedRaw() : ownedRaw
    return new Set<string>(Array.isArray(ownedArr) ? ownedArr.map((value: any) => String(value)) : [])
  })

  const ownedClipsQ = useConvexQuery(
    (convexApi as any).ownerships.listOwnedClipIds,
    () => {
      const rid = roomId()
      const uid = userId()
      return rid && uid ? ({ roomId: rid, ownerUserId: uid } as any) : null
    },
    () => ['owned-clips', roomId(), userId()]
  )

  const ownedClipIds = createMemo(() => {
    const ownedRaw: any = (ownedClipsQ as any)?.data
    const ownedArr: any = typeof ownedRaw === 'function' ? ownedRaw() : ownedRaw
    return new Set<string>(Array.isArray(ownedArr) ? ownedArr.map((value: any) => String(value)) : [])
  })

  const grantTrackWrite = (trackId: string | null | undefined) => {
    if (!trackId) return
    setOptimisticTrackWriteIds((current) => addIdsToSet(current, [trackId]))
  }

  const grantClipWrite = (clipId: string | null | undefined) => {
    if (!clipId) return
    setOptimisticClipWriteIds((current) => addIdsToSet(current, [clipId]))
  }

  const grantClipWrites = (clipIds: Iterable<string>) => {
    setOptimisticClipWriteIds((current) => addIdsToSet(current, clipIds))
  }

  const writableTrackIds = createMemo(() => mergeIdSets(ownedTrackIds(), optimisticTrackWriteIds()))
  const writableClipIds = createMemo(() => mergeIdSets(ownedClipIds(), optimisticClipWriteIds()))
  const canWriteTrack = (trackId: string) => writableTrackIds().has(trackId)
  const canWriteClip = (clipId: string) => writableClipIds().has(clipId)
  const serverTrackState = createMemo(() => {
    const data = fullView.data
    if (!data) return null
    const serverVolumes = new Map<string, number>()
    const serverRouting = new Map<string, LocalTrackRouting>()
    const routingTracks = (data.tracks as any[]).map((track) => ({
      id: String(track._id),
      channelRole: track.channelRole,
    }))
    const routingTrackById = new Map(routingTracks.map((track) => [track.id, track]))
    for (const track of data.tracks as any[]) {
      if (track.volume === undefined) {
        throw new Error(`Missing mixer channel volume for track ${String(track._id)}`)
      }
      if (track.channelRole !== 'track' && track.channelRole !== 'group' && track.channelRole !== 'return') {
        throw new Error(`Missing mixer channel role for track ${String(track._id)}`)
      }
      if (track.sends === undefined) {
        throw new Error(`Missing mixer channel sends for track ${String(track._id)}`)
      }
      serverVolumes.set(String(track._id), track.volume)
      serverRouting.set(String(track._id), {
        outputTargetId: track.outputTargetId === undefined ? undefined : String(track.outputTargetId),
        sends: track.sends.map((send: any) => {
          if (!send?.targetId) {
            throw new Error(`Missing mixer send target for track ${String(track._id)}`)
          }
          const amount = Number(send.amount)
          if (!Number.isFinite(amount)) {
            throw new Error(`Invalid mixer send amount for track ${String(track._id)}`)
          }
          return { targetId: String(send.targetId), amount }
        }),
      })
    }
    return {
      serverVolumes,
      serverRouting,
      routingTracks,
      routingTrackById,
    }
  })

  createEffect(() => {
    roomId()
    for (const timer of volumeTimers.values()) {
      clearTimeout(timer.timer)
    }
    volumeTimers.clear()
    for (const timer of routingTimers.values()) {
      clearTimeout(timer.timer)
    }
    routingTimers.clear()
    seenOptimisticTrackIds.clear()
    seenOptimisticClipIds.clear()
    setOptimisticTrackWriteIds(new Set<string>())
    setOptimisticClipWriteIds(new Set<string>())
    setPendingSharedTrackVolumes(new Map<string, number>())
    setPendingSharedTrackRouting(new Map<string, LocalTrackRouting>())
  })

  createEffect(() => {
    const snapshot = tracks()
    const existingTrackIds = new Set(snapshot.map((track) => track.id))
    const existingClipIds = new Set(snapshot.flatMap((track) => track.clips.map((clip) => clip.id)))
    const serverTrackIds = ownedTrackIds()
    const serverClipIds = ownedClipIds()
    const optimisticTracks = optimisticTrackWriteIds()
    const optimisticClips = optimisticClipWriteIds()

    for (const trackId of existingTrackIds) {
      if (optimisticTracks.has(trackId)) seenOptimisticTrackIds.add(trackId)
    }
    for (const clipId of existingClipIds) {
      if (optimisticClips.has(clipId)) seenOptimisticClipIds.add(clipId)
    }

    setOptimisticTrackWriteIds((current) => pruneOptimisticIds(current, serverTrackIds, existingTrackIds, seenOptimisticTrackIds))
    setOptimisticClipWriteIds((current) => pruneOptimisticIds(current, serverClipIds, existingClipIds, seenOptimisticClipIds))
    setPendingSharedTrackVolumes((current) => {
      let changed = false
      const next = new Map<string, number>()
      for (const [trackId, volume] of current) {
        if (!existingTrackIds.has(trackId)) {
          changed = true
          continue
        }
        next.set(trackId, volume)
      }
      return changed ? next : current
    })
    setPendingSharedTrackRouting((current) => {
      let changed = false
      const next = new Map<string, LocalTrackRouting>()
      for (const [trackId, routing] of current) {
        if (!existingTrackIds.has(trackId)) {
          changed = true
          continue
        }
        next.set(trackId, routing)
      }
      return changed ? next : current
    })
  })

  createEffect(() => {
    const data = serverTrackState()
    pendingSharedTrackVolumes()
    pendingSharedTrackRouting()
    if (!data) return

    setPendingSharedTrackVolumes((current) => {
      let changed = false
      const next = new Map<string, number>()
      for (const [trackId, volume] of current) {
        const serverVolume = data.serverVolumes.get(trackId)
        if (typeof serverVolume === 'number' && Math.abs(serverVolume - volume) < 1e-6) {
          changed = true
          continue
        }
        next.set(trackId, volume)
      }
      return changed ? next : current
    })
    setPendingSharedTrackRouting((current) => {
      let changed = false
      const next = new Map<string, LocalTrackRouting>()
      for (const [trackId, routing] of current) {
        const serverValue = data.serverRouting.get(trackId)
        const normalized = normalizeTrackRouting(data.routingTrackById.get(trackId), routing, data.routingTracks)
        if (serverValue && isTrackRoutingEqual(serverValue, normalized)) {
          changed = true
          continue
        }
        next.set(trackId, normalized)
        if (!isTrackRoutingEqual(normalized, routing)) {
          changed = true
        }
      }
      return changed ? next : current
    })
  })

  const {
    audioBufferCache,
    ensureClipBuffer,
    uploadToR2,
    clearClipBufferCaches,
  } = useClipBuffers({
    audioEngine,
    tracks,
    setTracks,
  })

  // Local storage helpers for mix persistence

  const applyAgentMixOps = (ops: AgentMixOp[]) => {
    try {
      const rid = roomId()
      if (!rid || !Array.isArray(ops) || ops.length === 0) return
      setTracks(ts => {
        const arr = ts.map(t => ({ ...t }))
        const ownedSet = writableTrackIds()
        for (const op of ops) {
          const targets0 = Array.from(new Set(normalizeCommandTrackIndices(Array.isArray(op.indices) ? op.indices : undefined)))
            .filter(i => i >= 0 && i < arr.length && ownedSet.has(arr[i].id))
          if (op.type === 'setSolo') {
            const exclusive = !!op.exclusive && !!op.value && targets0.length === 1
            if (exclusive) {
              for (let i = 0; i < arr.length; i++) {
                if (!ownedSet.has(arr[i].id)) continue
                const next = i === targets0[0]
                arr[i].soloed = next
                saveLocalMix(rid, arr[i].id, { soloed: next })
              }
              continue
            }
            for (const i of targets0) {
              arr[i].soloed = op.value
              saveLocalMix(rid, arr[i].id, { soloed: op.value })
            }
            continue
          }
          for (const i of targets0) {
            arr[i].muted = op.value
            saveLocalMix(rid, arr[i].id, { muted: op.value })
          }
        }
        return arr
      })
    } catch {}
  }

  // Initialize Undo manager when room is known; hydrate persisted stacks
  createEffect(() => {
    const rid = roomId()
    if (!rid) return
    undoMgr = createUndoManager({ onChange: (state) => saveHistory(rid, state) })
    try {
      const persisted = loadHistory(rid)
      undoMgr.hydrate(persisted as any)
    } catch {}
  })
  // Load syncMix per room
  createEffect(() => {
    if (!canUseLocalStorage()) {
      setSyncMix(false)
      return
    }
    setSyncMix(loadMixSyncFlag(roomId()))
  })

  // Loop region setter used by ruler interactions
  const setLoopRegion = (start: number, end: number) => {
    const s = Math.max(0, Math.min(start, end - 0.05))
    const e = Math.max(s + 0.05, end)
    batch(() => {
      setLoopStartSec(s)
      setLoopEndSec(e)
    })
  }

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

  // Load loop settings per room
  createEffect(() => {
    const rid = roomId()
    if (!canUseLocalStorage() || !rid) return
    const loop = loadLoopSettings(rid)
    batch(() => {
      setLoopEnabled(loop.enabled)
      setLoopStartSec(loop.startSec)
      setLoopEndSec(loop.endSec)
    })
  })

  // Save loop settings when they change
  createEffect(() => {
    const rid = roomId()
    if (!rid) return
    saveLoopSettings(rid, {
      enabled: loopEnabled(),
      startSec: loopStartSec(),
      endSec: loopEndSec(),
    })
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
  } = usePlayheadControls({
    audioEngine,
    tracks,
    ensureClipBuffer,
    loopEnabled,
    loopStartSec,
    loopEndSec,
  })

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
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantWrite: grantTrackWrite,
    grantClipWrite,
  })

  // Open FX panel when selecting a clip on a different track
  // Only triggers when FX target switches to the selected clip's track
  let lastFxTargetForPanel: string | null = null
  createEffect(() => {
    const fx = selectedFXTarget()
    const sel = selectedClip()
    const changed = fx !== lastFxTargetForPanel
    lastFxTargetForPanel = fx
    if (!changed) return
    if (!fx || fx === 'master') return
    if (!sel) return
    if (sel.trackId === fx) {
      setBottomFXOpen(true)
    }
  })

  const {
    onClipPointerDown,
    activeDrag,
  } = useClipDrag({
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
    getScrollElement: () => scrollRef,
    // snapping
    bpm,
    gridEnabled,
    gridDenominator,
    audioBufferCache,
    onCommitMoves: (ids) => {
      // When clips are moved during playback, reschedule only those clips to avoid restarting other audio/MIDI sources
      if (isPlaying() && ids && ids.length) {
        try {
          const enabled = loopEnabled()
          const start = loopStartSec()
          const end = loopEndSec()
          const lenOk = enabled && end - start > 1e-3
          audioEngine.rescheduleClipsAtPlayhead(tracks(), playheadSec(), ids, lenOk ? { endLimitSec: end } : undefined)
        } catch {}
      }
    },
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantWrite: grantTrackWrite,
    grantClipWrites,
  })

  const {
    onClipResizeStart,
    onResizeMouseMove,
    onResizeMouseUp,
  } = useClipResize({
    tracks,
    setTracks,
    canWriteClip,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
    convexClient,
    convexApi,
    userId,
    getScrollElement: () => scrollRef,
    // snapping
    bpm,
    gridEnabled,
    gridDenominator,
    audioEngine,
    isPlaying,
    playheadSec,
    loopEnabled,
    loopEndSec,
    roomId,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
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
    canWriteClip,
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
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantClipWrites,
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

  // (moved) ensure any live notes stop when editor closes

  const recordingControls = useTrackRecording({
    audioEngine,
    tracks,
    setTracks,
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
    notify: notifyRecording,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantClipWrite,
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

  const getTrackRoutingSnapshot = (trackId: string): LocalTrackRouting => {
    const track = tracks().find(entry => entry.id === trackId)
    return {
      sends: track?.sends ?? [],
      outputTargetId: track?.outputTargetId,
    }
  }

  function scheduleTrackWrite(
    timers: Map<string, ScheduledTrackWrite>,
    trackId: string,
    write: () => Promise<unknown>,
  ) {
    const prevState = timers.get(trackId)
    if (prevState) clearTimeout(prevState.timer)
    const token = (prevState?.token ?? 0) + 1
    const timer = window.setTimeout(() => {
      void write().finally(() => {
        const current = timers.get(trackId)
        if (current?.token === token) {
          timers.delete(trackId)
        }
      })
    }, 150)
    timers.set(trackId, { timer, token })
  }

  const updateTrackRouting = (trackId: string, next: LocalTrackRouting) => {
    const rid = roomId()
    const uid = userId()
    const track = tracks().find(entry => entry.id === trackId)
    if (!track || !canWriteTrack(trackId)) return

    const previous = getTrackRoutingSnapshot(trackId)
    const normalized = normalizeTrackRouting(track, next, tracks())
    if (isTrackRoutingEqual(previous, normalized)) return

    setPendingSharedTrackRouting((current) => {
      if (isTrackRoutingEqual(current.get(trackId) ?? { sends: [], outputTargetId: undefined }, normalized)) return current
      const nextRouting = new Map(current)
      nextRouting.set(trackId, normalized)
      return nextRouting
    })
    setTracks(ts => ts.map(entry => entry.id !== trackId ? entry : ({ ...entry, sends: normalized.sends, outputTargetId: normalized.outputTargetId })))

    if (uid) {
      // Debounce routing writes so rapid edits stay optimistic locally while the
      // rendered state still converges against server-authored fullView data.
      scheduleTrackWrite(routingTimers, trackId, () =>
        convexClient.mutation(
          (convexApi as any).tracks.setRouting,
          buildTrackRoutingMutationInput({ trackId, userId: uid, routing: normalized }) as any,
        ).catch(() => {
          setPendingSharedTrackRouting((current) => {
            const pending = current.get(trackId)
            if (!pending || !isTrackRoutingEqual(pending, normalized)) return current
            const nextRouting = new Map(current)
            nextRouting.delete(trackId)
            return nextRouting
          })
        }),
      )
    }

    if (rid) {
      pushHistory(buildTrackRoutingHistoryEntry({ roomId: rid, track, tracks: tracks(), from: previous, to: normalized }), 'track:routing:' + trackId, 400)
    }
  }

  const createTimelineTrack = async (options: { kind?: 'audio' | 'instrument'; channelRole?: 'track' | 'return' | 'group' } = {}) => {
    const rid = roomId()
    const uid = userId()
    if (!rid || !uid) return null

    const channelRole = options.channelRole ?? 'track'
    const track = await createOptimisticTrackWithHistory({
      convexClient,
      convexApi,
      roomId: rid,
      userId: uid,
      tracks,
      setTracks,
      grantWrite: grantTrackWrite,
      kind: options.kind,
      channelRole,
      historyPush: pushHistory,
    })
    if (!track) return null

    selectTrackTarget(selectionSetters, track.id)

    return track.id
  }

  const updateTrackSends = (trackId: string, sends: TrackSend[]) => {
    const current = getTrackRoutingSnapshot(trackId)
    updateTrackRouting(trackId, { ...current, sends })
  }

  const updateTrackOutputTargetId = (trackId: string, outputTargetId?: string) => {
    const current = getTrackRoutingSnapshot(trackId)
    updateTrackRouting(trackId, { ...current, outputTargetId })
  }

  const preflightOwnedRoomDelete = async (targetRoomId: string, uid: string) => {
    return await convexClient.query(
      (convexApi as any).projects.preflightDeleteOwnedInRoom,
      { roomId: targetRoomId, userId: uid } as any,
    ) as ProjectDeletePreflightResult
  }

  const showProjectDeleteConflict = (result: { conflicts?: ProjectDeleteConflict[] } | null | undefined) => {
    const conflicts = Array.isArray(result?.conflicts) ? result!.conflicts : []
    const hasForeignClips = conflicts.some((conflict) => conflict.reason === 'foreign-clips' || conflict.reason === 'not-empty')
    const message = hasForeignClips
      ? 'This project cannot be deleted yet because you still own a track that contains another collaborator\'s clips.'
      : 'This project could not be deleted.'
    window.alert(message)
  }

  const deleteOwnedRoom = async (
    targetRoomId: string,
    uid: string,
  ) => {
    const result = await convexClient.mutation(convexApi.projects.deleteOwnedInRoom, {
      roomId: targetRoomId,
      userId: uid,
    } as any) as ProjectDeleteResult
    if (result?.status === 'conflict') {
      showProjectDeleteConflict(result)
      return false
    }
    return true
  }

  const selectRecordingTrack = (trackId: string) => {
    batch(() => {
      selectTrackTarget(selectionSetters, trackId)
      setRecordArmTrackId(trackId)
    })
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
      if (armedTrack && canTrackReceiveAudioClip(armedTrack) && (!armedTrack.lockedBy || armedTrack.lockedBy === uid)) {
        return armedTrack.id
      }
    }

    const available = currentTracks.find(t => canTrackReceiveAudioClip(t) && (!t.lockedBy || t.lockedBy === uid))
    if (available) {
      setRecordArmTrackId(available.id)
      return available.id
    }

    try {
      const track = await createOptimisticTrackWithHistory({
        convexClient,
        convexApi,
        roomId: rid,
        userId: uid,
        tracks,
        setTracks,
        grantWrite: grantTrackWrite,
        lockedBy: null,
        historyPush: pushHistory,
      })
      if (!track) return null
      selectRecordingTrack(track.id)
      return track.id
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
    if (!canTrackReceiveAudioClip(target)) return
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
      selectRecordingTrack(trackId)
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
    const data = fullView.data
    if (!data) return

    // Read old tracks without tracking to avoid creating a feedback loop
    const oldTracks = untrack(() => tracks())
    const oldTrackMap = new Map(oldTracks.map(t => [t.id, t]))

    const sm = syncMix()
    const ownedSet = writableTrackIds()
    const pendingVolumes = pendingSharedTrackVolumes()
    const pendingRouting = pendingSharedTrackRouting()
    const serverState = serverTrackState()
    const dragSnapshot = activeDrag()
    const addedTrackDuringDrag = dragSnapshot?.addedTrackDuringDrag
    const localMix = loadLocalMixMap(roomId())
    if (!serverState) return
    const projected: Track[] = data.tracks.map((t: any, idx: number) => {
      const id = t._id as string
      const prev = oldTrackMap.get(id)
      const serverMuted = (t as any).muted as boolean | undefined
      const serverSoloed = (t as any).soloed as boolean | undefined
      const serverName = typeof (t as any).name === 'string' ? (t as any).name : undefined
      const serverLockedBy = typeof (t as any).lockedBy === 'string' ? (t as any).lockedBy : null
      const serverVolume = serverState.serverVolumes.get(id)
      if (serverVolume === undefined) {
        throw new Error(`Missing mixer volume for track ${id}`)
      }
      const localVolume = typeof localMix[id]?.volume === 'number' ? localMix[id]!.volume : undefined
      const isOwned = ownedSet.has(id)
      const serverRouting = serverState.serverRouting.get(id)
      if (!serverRouting) {
        throw new Error(`Missing mixer routing for track ${id}`)
      }
      const pendingValue = pendingRouting.get(id)
      const routing = isOwned && pendingValue
        ? normalizeTrackRouting(serverState.routingTrackById.get(id), pendingValue, serverState.routingTracks)
        : serverRouting
      return {
        id,
        historyRef: prev?.historyRef ?? id,
        name: serverName ?? prev?.name ?? `Track ${idx + 1}`,
        volume: resolveProjectedTrackVolume({
          canWriteSharedMix: isOwned,
          syncMix: sm,
          serverVolume,
          localVolume,
          pendingSharedVolume: pendingVolumes.get(id),
        }),
        clips: [],
        // Owner view: prefer LOCAL state; Non-owner view: prefer SERVER only when Sync Mix is ON
        muted: isOwned
          ? (prev?.muted ?? localMix[id]?.muted ?? (typeof serverMuted === 'boolean' ? serverMuted : false))
          : (sm
            ? (typeof serverMuted === 'boolean' ? serverMuted : (prev?.muted ?? localMix[id]?.muted ?? false))
            : (prev?.muted ?? localMix[id]?.muted ?? false)),
        soloed: isOwned
          ? (prev?.soloed ?? localMix[id]?.soloed ?? (typeof serverSoloed === 'boolean' ? serverSoloed : false))
          : (sm
            ? (typeof serverSoloed === 'boolean' ? serverSoloed : (prev?.soloed ?? localMix[id]?.soloed ?? false))
            : (prev?.soloed ?? localMix[id]?.soloed ?? false)),
        lockedBy: serverLockedBy ?? prev?.lockedBy ?? null,
        kind: (t as any).kind ?? prev?.kind ?? 'audio',
        channelRole: t.channelRole,
        outputTargetId: routing.outputTargetId,
        sends: routing.sends,
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
        historyRef: prev?.historyRef ?? addedTrackDuringDrag,
        name: prev?.name ?? `Track ${projected.length + 1}`,
        volume: prev?.volume ?? 0.8,
        clips: [],
        muted: prev?.muted ?? false,
        soloed: prev?.soloed ?? false,
        lockedBy: prev?.lockedBy ?? null,
        channelRole: prev?.channelRole ?? 'track',
        sends: prev?.sends ?? [],
        outputTargetId: prev?.outputTargetId,
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
        historyRef: prevClip?.historyRef ?? String(c._id),
        name,
        buffer,
        startSec: c.startSec as number,
        duration: c.duration as number,
        sourceAssetKey: (c as any).sourceAssetKey,
        sourceKind: (c as any).sourceKind,
        sourceDurationSec: (c as any).sourceDurationSec,
        sourceSampleRate: (c as any).sourceSampleRate,
        sourceChannelCount: (c as any).sourceChannelCount,
        leftPadSec: (c as any).leftPadSec ?? prevClip?.leftPadSec ?? 0,
        bufferOffsetSec: (c as any).bufferOffsetSec ?? prevClip?.bufferOffsetSec ?? 0,
        color,
        sampleUrl: (c as any).sampleUrl as string | undefined,
        midi: (c as any).midi,
        midiOffsetBeats: (c as any).midiOffsetBeats ?? prevClip?.midiOffsetBeats ?? 0,
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
            historyRef: localClip.historyRef,
            name: localClip.name,
            buffer: localClip.buffer ?? null,
            startSec: pos.startSec,
            duration: localClip.duration,
            sourceAssetKey: localClip.sourceAssetKey,
            sourceKind: localClip.sourceKind,
            sourceDurationSec: localClip.sourceDurationSec,
            sourceSampleRate: localClip.sourceSampleRate,
            sourceChannelCount: localClip.sourceChannelCount,
            leftPadSec: localClip.leftPadSec ?? 0,
            bufferOffsetSec: (localClip as any).bufferOffsetSec ?? 0,
            color: localClip.color,
            sampleUrl: localClip.sampleUrl,
            midi: (localClip as any).midi,
            midiOffsetBeats: (localClip as any).midiOffsetBeats ?? 0,
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
      if (!available || !canTrackReceiveAudioClip(available) || (available.lockedBy && available.lockedBy !== uid)) {
        setRecordArmTrackId(null)
      }
    }
    if (!selectedTrackId() && projected.length > 0) {
      selectTrackTarget(selectionSetters, projected[0].id)
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
      clearTimeout(timer.timer)
    }
    volumeTimers.clear()
    for (const timer of routingTimers.values()) {
      clearTimeout(timer.timer)
    }
    routingTimers.clear()
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
    if (!hasCustom) return
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
    if (!hasCustom) return
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
    onSpace: () => {
      if (isRecording()) {
        handleTransportPause()
      } else {
        isPlaying() ? handlePause() : requestPlay()
      }
    },
    onDelete: handleKeyboardAction,
    onDuplicate: () => { void duplicateSelectedClips() },
    onAddAudioTrack: () => {
      void (async () => {
        try {
          await createTimelineTrack()
        } catch {}
      })()
    },
    onUndo: () => {
      try {
        const rid = roomId()
        const uid = userId()
        if (!undoMgr || !rid || !uid) return
        if (!undoMgr.canUndo()) return
        const snapshot = undoMgr.snapshot()
        const e = undoMgr.popUndo()
        if (!e) return
        void execUndo(e, {
          convexClient,
          convexApi,
          setTracks,
          getTracks: () => tracks(),
          getHistoryEntries: () => {
            const snapshot = undoMgr?.snapshot()
            return [...(snapshot?.undo ?? []), ...(snapshot?.redo ?? []), e]
          },
          roomId: rid,
          userId: uid,
          persistLocalMix: persistLocalTrackMix,
          audioEngine,
          grantTrackWrite,
          grantClipWrite,
        }).then(() => {
          undoMgr!.pushRedo(e)
        }).catch((error) => {
          console.error('[Timeline] undo failed', error)
          undoMgr?.hydrate(snapshot)
        })
      } catch {}
    },
    onRedo: () => {
      try {
        const rid = roomId()
        const uid = userId()
        if (!undoMgr || !rid || !uid) return
        if (!undoMgr.canRedo()) return
        const snapshot = undoMgr.snapshot()
        const e = undoMgr.popRedo()
        if (!e) return
        void execRedo(e, {
          convexClient,
          convexApi,
          setTracks,
          getTracks: () => tracks(),
          getHistoryEntries: () => {
            const snapshot = undoMgr?.snapshot()
            return [...(snapshot?.undo ?? []), ...(snapshot?.redo ?? []), e]
          },
          roomId: rid,
          userId: uid,
          persistLocalMix: persistLocalTrackMix,
          audioEngine,
          grantTrackWrite,
          grantClipWrite,
        }).then(() => {
          undoMgr!.pushUndoEntry(e)
        }).catch((error) => {
          console.error('[Timeline] redo failed', error)
          undoMgr?.hydrate(snapshot)
        })
      } catch {}
    },
    onAddInstrumentTrack: () => {
      void (async () => {
        try {
          await createTimelineTrack({ kind: 'instrument' })
        } catch {}
      })()
    },
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

  // Before starting playback, try to (re)load any missing buffers in a user-gesture context.
  // Jump to a specific clip (from Samples dropdown): select it, move playhead, and scroll into view
  function jumpToClip(trackId: string, clipId: string, startSec: number) {
    // Ensure selection states are consistent
    selectPrimaryClip(selectionSetters, { trackId, clipId })
    // Move playhead to the start of the clip
    setPlayhead(Math.max(0, startSec), tracks())
    openMidiEditorFor(clipId)
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

  // Live note play (sustain until keyup) for computer keyboard input
  const activeLiveNotes = new Map<number, { oscs: OscillatorNode[]; gain: GainNode; trackId: string }>()
  const startLiveNote = (pitch: number, velocity = 0.9) => {
    try {
      audioEngine.ensureAudio()
      const ctx: AudioContext | undefined = (audioEngine as any).audioCtx
      if (!ctx) return
      if (activeLiveNotes.has(pitch)) return
      // Resolve target track: edited MIDI clip's track, else selectedFXTarget/selectedTrackId
      const id = midiEditorClipId()
      let trackId = selectedFXTarget() || selectedTrackId()
      if (id) {
        for (const t of tracks()) {
          if (t.clips.some(cc => cc.id === id)) { trackId = t.id; break }
        }
      }
      if (!trackId) return
      const synthGain: GainNode | undefined = (audioEngine as any).ensureTrackSynthGainNode?.(trackId)
      if (!synthGain) return
      const osc1 = ctx.createOscillator()
      const osc2 = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = ctx.currentTime
      const synthState = (audioEngine as any)?.trackSynths?.get?.(trackId)
      const wave1 = synthState?.wave1 ?? 'sawtooth'
      const wave2 = synthState?.wave2 ?? wave1
      const targetAmp = Math.max(0, Math.min(1.5, velocity)) / 2
      try { osc1.type = wave1 } catch {}
      try { osc2.type = wave2 } catch {}
      const freq = 440 * Math.pow(2, (pitch - 69) / 12)
      osc1.frequency.setValueAtTime(freq, start)
      osc2.frequency.setValueAtTime(freq, start)
      const EPS = 1e-4
      gain.gain.setValueAtTime(EPS, start)
      // quick exponential attack for preview
      gain.gain.exponentialRampToValueAtTime(Math.max(EPS, targetAmp), start + 0.01)
      osc1.connect(gain)
      osc2.connect(gain)
      gain.connect(synthGain)
      osc1.start(start)
      osc2.start(start)
      activeLiveNotes.set(pitch, { oscs: [osc1, osc2], gain, trackId })
    } catch {}
  }
  const stopLiveNote = (pitch: number) => {
    try {
      const entry = activeLiveNotes.get(pitch)
      if (!entry) return
      activeLiveNotes.delete(pitch)
      const ctx: AudioContext | undefined = (audioEngine as any).audioCtx
      if (!ctx) {
        for (const o of entry.oscs) { try { o.stop() } catch {} }
        try { entry.gain.disconnect() } catch {}
        return
      }
      const now = ctx.currentTime
      try {
        // short release to avoid clicks
        entry.gain.gain.cancelScheduledValues(now)
        const current = entry.gain.gain.value
        entry.gain.gain.setValueAtTime(current, now)
        entry.gain.gain.linearRampToValueAtTime(0, now + 0.05)
        for (const o of entry.oscs) { try { o.stop(now + 0.06) } catch {} }
      } catch {}
      for (const o of entry.oscs) {
        o.onended = () => {
          try { entry.gain.disconnect() } catch {}
        }
      }
    } catch {}
  }
  const stopAllLiveNotes = () => {
    try {
      for (const p of Array.from(activeLiveNotes.keys())) stopLiveNote(p)
    } catch {}
  }

  // Ensure any live notes are stopped when closing the MIDI editor
  createEffect(() => {
    const id = midiEditorClipId()
    if (!id) {
      try { stopAllLiveNotes() } catch {}
    }
  })

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
        onMasterFX={() => { selectMasterTarget(selectionSetters); setBottomFXOpen(true) }}
        bpm={bpm()}
        onChangeBpm={(next) => setBpm(clampBpm(next))}
        metronomeEnabled={metronomeEnabled()}
        onToggleMetronome={() => setMetronomeEnabled((prev) => !prev)}
        gridEnabled={gridEnabled()}
        onToggleGrid={() => setGridEnabled(prev => !prev)}
        gridDenominator={gridDenominator()}
        onChangeGridDenominator={(n: number) => setGridDenominator(n)}
        loopEnabled={loopEnabled()}
        onToggleLoop={() => setLoopEnabled(prev => !prev)}
        isRecording={isRecording()}
        onToggleRecord={handleRecordToggle}
        onJumpToClip={(clipId, trackId, startSec) => jumpToClip(trackId, clipId, startSec)}
        onInsertSample={(payload) => { void handleInsertSample(payload) }}
        currentRoomId={roomId()}
        onOpenProject={(rid) => {
          navigateToRoom(rid)
        }}
        onCreateProject={async () => {
          const rid = crypto.randomUUID()
          navigateToRoom(rid)
        }}
        onDeleteProject={async (rid) => {
          const uid = userId()
          if (!uid) return
          const preflight = await preflightOwnedRoomDelete(rid, uid)
          if (preflight?.status === 'conflict') {
            showProjectDeleteConflict(preflight)
            return
          }

          if (rid === roomId()) {
            const old = rid
            const projectsLocal = myProjects.data
            let other: string | undefined = Array.isArray(projectsLocal)
              ? (projectsLocal.find((p: any) => p?.roomId && p.roomId !== old)?.roomId as string | undefined)
              : undefined
            if (!other) {
              try {
                const freshList: any[] = await convexClient.query((convexApi as any).projects.listMineDetailed, { userId: uid } as any)
                other = freshList?.find?.((p: any) => p?.roomId && p.roomId !== old)?.roomId
              } catch {}
            }

            if (other) {
              navigateToRoom(other)
              const deleted = await deleteOwnedRoom(old, uid)
              if (!deleted) {
                navigateToRoom(old)
              }
            } else {
              const fresh = crypto.randomUUID()
              const deleted = await deleteOwnedRoom(old, uid)
              if (deleted) {
                navigateToRoom(fresh)
              }
            }
          } else {
            await deleteOwnedRoom(rid, uid)
          }
        }}
        onRenameProject={async (rid, name) => {
          const uid = userId()
          if (!uid) return
          await convexClient.mutation((convexApi as any).projects.setName, { roomId: rid, userId: uid, name })
        }}
        onOpenExport={() => setExportOpen(true)}
      />
      <TimelinePanels
        state={{
          bottomFXOpen,
          agentPanelOpen,
          sharedChatOpen,
          exportOpen,
          bottomOffsetPx: () => bottomFXOpen() ? FX_OFFSET_PX : 0,
          selectedFXTarget,
          tracks,
          playheadSec,
          bpm,
          loopEnabled,
          loopStartSec,
          loopEndSec,
        }}
        session={{ roomId, userId }}
        audioEngine={audioEngine}
        ensureClipBuffer={ensureClipBuffer}
        actions={{
          toggleAgentPanel: () => setAgentPanelOpen((value) => !value),
          toggleSharedChat: () => setSharedChatOpen((value) => !value),
          closeAgentPanel: () => setAgentPanelOpen(false),
          closeSharedChat: () => setSharedChatOpen(false),
          closeEffects: () => setBottomFXOpen(false),
          openEffects: () => setBottomFXOpen(true),
          closeExport: () => setExportOpen(false),
          canWriteTrackRouting: canWriteTrack,
          grantClipWrite,
          trackSendsChange: updateTrackSends,
          trackOutputTargetChange: updateTrackOutputTargetId,
          selectClip: jumpToClip,
          applyAgentMixOps,
          effectParamsCommitted: ({ targetId, effect, from, to }) => {
            const rid = roomId()
            if (!rid) return
            pushHistory(buildEffectParamsHistoryEntry({ roomId: rid, effect: effect as any, targetId, tracks: tracks(), from, to }), `fx:${effect}:${targetId}`, 600)
          },
        }}
      />

      <div class="flex-1 flex min-h-0" ref={el => (containerRef = el!)}>
        <div
        class="flex-1 relative overflow-auto timeline-scroll"
        style={{ 'padding-bottom': bottomFXOpen() ? `${FX_OFFSET_PX}px` : '0px' }}
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
              loopEnabled={loopEnabled()}
              loopStartSec={loopStartSec()}
              loopEndSec={loopEndSec()}
              onSetLoopRegion={(s, e) => setLoopRegion(s, e)}
            />
            
            <div class="absolute left-0 right-0" style={{ top: `${RULER_HEIGHT}px`, height: `${(tracks().length + (dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}px` }}>
              <For each={tracks()}>
                {(track, i) => (
                  <TrackLane
                    track={track}
                    index={i()}
                    isDropTarget={dropTargetLane() === i()}
                    selectedClipIds={selectedClipIds()}
                    onClipPointerDown={onClipPointerDown}
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
              <TimelineOverlays
                state={{
                  tracks,
                  durationSec: duration,
                  bpm,
                  gridDenominator,
                  gridEnabled,
                  loopEnabled,
                  loopStartSec,
                  loopEndSec,
                  playheadSec,
                  dropAtNewTrack,
                  isRecording,
                  previewStartSec,
                  previewPoints,
                  recordingTrackId,
                  marqueeRect,
                  midiEditorClipId,
                  midiCard,
                }}
                session={{ userId, roomId }}
                actions={{
                  closeMidiEditor,
                  changeMidiCardBounds: (next) => { setMidiCard(next); schedulePersistMidiCard() },
                  auditionNote,
                  startLiveNote,
                  stopLiveNote,
                }}
              />
            </div>
          </div>
        </div>

        <TrackSidebar
          tracks={tracks()}
          selectedTrackId={selectedTrackId()}
          sidebarWidth={sidebarWidth()}
          isPlaying={isPlaying()}
          bottomOffsetPx={bottomFXOpen() ? FX_OFFSET_PX : 0}
          getTrackLevel={(id) => {
            try { return (audioEngine as any)?.getTrackLevel?.(id) ?? 0 } catch { return 0 }
          }}
          getTrackLevels={(id) => {
            try {
              const stereo = (audioEngine as any)?.getTrackLevelsStereo?.(id)
              if (stereo && Array.isArray(stereo) && stereo.length === 2) return stereo as [number, number]
            } catch {}
            const m = (() => { try { return (audioEngine as any)?.getTrackLevel?.(id) ?? 0 } catch { return 0 } })()
            return [m, m]
          }}
          
          onTrackClick={(id) => {
            selectTrackTarget(selectionSetters, id, { clearClipSelection: true })
          }}
          onAddTrack={async () => {
            await createTimelineTrack()
          }}
          onAddReturnTrack={async () => {
            await createTimelineTrack({ channelRole: 'return' })
          }}
          onAddGroupTrack={async () => {
            await createTimelineTrack({ channelRole: 'group' })
          }}
          onAddInstrumentTrack={async () => {
            await createTimelineTrack({ kind: 'instrument' })
          }}
          onVolumeChange={(trackId, volume) => {
            const rid = roomId()
            const uid = userId()
            const track = tracks().find(tt => tt.id === trackId)
            const canWriteSharedMix = canWriteTrack(trackId)
            const prevVolume = (() => { try { const t = tracks().find(tt => tt.id === trackId); return t?.volume ?? volume } catch { return volume } })()
            setTracks(ts => ts.map(t => t.id !== trackId ? t : ({ ...t, volume })))
            if (rid && !canWriteSharedMix) saveLocalMix(rid, trackId, { volume })
            if (rid && track) {
              pushHistory(buildTrackVolumeHistoryEntry({
                roomId: rid,
                track,
                scope: canWriteSharedMix ? 'shared' : 'local',
                from: prevVolume,
                to: volume,
              }), `track:vol:${trackId}`, 600)
            }
            if (!uid || !canWriteSharedMix) return
            setPendingSharedTrackVolumes((current) => {
              if (current.get(trackId) === volume) return current
              const next = new Map(current)
              next.set(trackId, volume)
              return next
            })
            // Debounce slider writes so rapid adjustments stay responsive without
            // leaving stale local state behind if the server rejects the write.
            scheduleTrackWrite(volumeTimers, trackId, () =>
              convexClient.mutation(convexApi.tracks.setVolume, { trackId: trackId as any, volume, userId: uid }).catch(() => {
                setPendingSharedTrackVolumes((current) => {
                  if (current.get(trackId) !== volume) return current
                  const next = new Map(current)
                  next.delete(trackId)
                  return next
                })
                setTracks(ts => ts.map(t => {
                  if (t.id !== trackId || t.volume !== volume) return t
                  return { ...t, volume: prevVolume }
                }))
              }),
            )
          }}
          onToggleMute={(trackId) => {
            const rid = roomId()
            const track = tracks().find(tt => tt.id === trackId)
            let nextMuted = false
            const prevMuted = (() => { try { const t = tracks().find(tt => tt.id === trackId); return !!t?.muted } catch { return false } })()
            setTracks(ts => ts.map(t => {
              if (t.id !== trackId) return t
              nextMuted = !t.muted
              return { ...t, muted: nextMuted }
            }))
            if (rid) saveLocalMix(rid, trackId, { muted: nextMuted })
            // Keep server in sync for OWNED tracks regardless of Sync Mix; ignore for non-owned
            try {
              const uid = userId()
              if (uid && canWriteTrack(trackId)) {
                void convexClient.mutation(convexApi.tracks.setMix, { trackId: trackId as any, muted: nextMuted, userId: uid } as any)
              }
            } catch {}
            if (rid && track) {
              pushHistory(buildTrackBooleanHistoryEntry({
                type: 'track-mute',
                roomId: rid,
                track,
                scope: canWriteTrack(trackId) ? 'shared' : 'local',
                from: prevMuted,
                to: !prevMuted,
              }))
            }
          }}
          onToggleSolo={(trackId) => {
            const rid = roomId()
            const track = tracks().find(tt => tt.id === trackId)
            let nextSoloed = false
            const prevSolo = (() => { try { const t = tracks().find(tt => tt.id === trackId); return !!t?.soloed } catch { return false } })()
            setTracks(ts => ts.map(t => {
              if (t.id !== trackId) return t
              nextSoloed = !t.soloed
              return { ...t, soloed: nextSoloed }
            }))
            if (rid) saveLocalMix(rid, trackId, { soloed: nextSoloed })
            // Keep server in sync for OWNED tracks regardless of Sync Mix; ignore for non-owned
            try {
              const uid = userId()
              if (uid && canWriteTrack(trackId)) {
                void convexClient.mutation(convexApi.tracks.setMix, { trackId: trackId as any, soloed: nextSoloed, userId: uid } as any)
              }
            } catch {}
            if (rid && track) {
              pushHistory(buildTrackBooleanHistoryEntry({
                type: 'track-solo',
                roomId: rid,
                track,
                scope: canWriteTrack(trackId) ? 'shared' : 'local',
                from: prevSolo,
                to: !prevSolo,
              }))
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


      <Dialog open={confirmOpen()} onOpenChange={setConfirmOpen}>
        <DialogContent class="bg-neutral-900 text-neutral-100 border border-neutral-800">
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
