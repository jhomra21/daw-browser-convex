import { type Accessor, type Component, type JSX, For, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '~/components/ui/dialog'
import type { Track } from '~/types/timeline'
import { getAudioEngine, resetAudioEngine } from '~/lib/audio-engine-singleton'
import { timelineDurationSec, PPS, RULER_HEIGHT, LANE_HEIGHT, FX_OFFSET_PX } from '~/lib/timeline-utils'
import { saveLocalMix } from '~/lib/timeline-storage'
import { useTimelineKeyboard } from '~/hooks/useTimelineKeyboard'
import { useTimelineClipImport } from '~/hooks/useTimelineClipImport'
import { useTimelineClipActions } from '~/hooks/useTimelineClipActions'
import TransportControls from './timeline/TransportControls'
import TimelineRuler from './timeline/TimelineRuler'
import TrackLane from './timeline/TrackLane'
import TrackSidebar from './timeline/TrackSidebar'
import { Button } from './ui/button'
import { convexClient, convexApi } from '~/lib/convex'
import { useTimelineData } from '~/hooks/useTimelineData'
import { usePlayheadControls } from '~/hooks/usePlayheadControls'
import { useClipDrag } from '~/hooks/useClipDrag'
import { useClipResize } from '~/hooks/useClipResize'
import { useTimelineSelection } from '~/hooks/useTimelineSelection'
import { useClipBuffers } from '~/hooks/useClipBuffers'
import { normalizeCommandTrackIndices } from '~/lib/agent-command-targets'
import { useTimelineResolvedModel } from '~/hooks/useTimelineResolvedModel'
import { useTimelineActions } from '~/hooks/useTimelineActions'
import { useTimelineSidebarResize } from '~/hooks/useTimelineSidebarResize'
import type { UploadToR2 } from '~/hooks/useClipBuffers'
import { useTrackRecording } from '~/hooks/useTrackRecording'
import { buildEffectParamsHistoryEntry } from '~/lib/undo/builders'
import type { EffectParamsCommitPayload } from '~/lib/undo/types'
import TimelineOverlays from './timeline/timeline-overlays'
import TimelinePanels from './timeline/timeline-panels'
import { useTimelinePreferences } from '~/hooks/useTimelinePreferences'
import { useTimelineMidiOverlay } from '~/hooks/useTimelineMidiOverlay'
import { useTimelineMixerController } from '~/hooks/useTimelineMixerController'
import { useProjectedTimelineModel } from '~/hooks/useProjectedTimelineModel'
import { useTimelineDragDrop } from '~/hooks/useTimelineDragDrop'
import { useTimelineHistory } from '~/hooks/useTimelineHistory'
import { useTimelineIdentity } from '~/hooks/useTimelineIdentity'
import { useTimelineLocalMix } from '~/hooks/useTimelineLocalMix'
import { useTimelineProjectionState } from '~/hooks/useTimelineProjectionState'
import { useTimelineSelectionState } from '~/hooks/useTimelineSelectionState'

type AgentMixOp = { type: 'setMute' | 'setSolo'; indices: number[]; value: boolean; exclusive?: boolean; issuedAt: number }

const Timeline: Component = () => {
  const [bottomFXOpen, setBottomFXOpen] = createSignal(true)
  const [agentPanelOpen, setAgentPanelOpen] = createSignal(false)
  const [sharedChatOpen, setSharedChatOpen] = createSignal(false)
  const [confirmOpen, setConfirmOpen] = createSignal(false)
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<Track['id'] | null>(null)
  // Transport tempo & metronome
  const [metronomeEnabled, setMetronomeEnabled] = createSignal(false)
  const [isRecording, setIsRecording] = createSignal(false)
  const [exportOpen, setExportOpen] = createSignal(false)

  // Audio engine
  const audioEngine = getAudioEngine()
  // Collaboration: roomId from ?roomId=; ownership tied to Better Auth userId
  const { roomId, setRoomId, userId, projects, fullView, navigateToRoom, createProject, renameProject, deleteProject } = useTimelineData()
  const {
    sidebarWidth,
    setSidebarWidth,
    syncMix,
    toggleSyncMix,
    bpm,
    setBpm,
    clampBpm,
    gridEnabled,
    setGridEnabled,
    gridDenominator,
    setGridDenominator,
    loopEnabled,
    setLoopEnabled,
    loopStartSec,
    loopEndSec,
    setLoopRegion,
  } = useTimelinePreferences({ roomId })
  const identity = useTimelineIdentity({
    roomId,
    serverData: () => fullView.data,
  })
  const projection = useTimelineProjectionState({
    roomId,
    serverData: () => fullView.data,
    rememberTrackProjection: identity.rememberTrackProjection,
    rememberClipHistoryRef: identity.rememberClipHistoryRef,
  })
  let renderTracks: Accessor<Track[]> = () => []
  const selection = useTimelineSelectionState({
    roomId,
    tracks: () => renderTracks(),
    effectsPanel: {
      isOpen: bottomFXOpen,
      setOpen: setBottomFXOpen,
    },
  })
  const {
    writableTrackIds,
    optimisticTrackIds,
    canWriteTrack,
    canWriteClip,
    grantTrackWrite,
    grantClipWrite,
    grantClipWrites,
    serverTrackState,
  } = useProjectedTimelineModel({
    roomId,
    userId,
    fullViewData: () => fullView.data,
    pendingTrackEntriesById: projection.pendingTrackEntriesById,
    pendingClipCreatesById: projection.pendingClipCreatesById,
    removedTrackIds: projection.removedTrackIds,
    removedClipIds: projection.removedClipIds,
  })
  const localMix = useTimelineLocalMix({
    roomId,
    writableTrackIds,
  })
  let ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void> = async () => {}
  let uploadToR2: UploadToR2 = async () => null
  let clearClipBufferCaches = () => {}
  let audioBufferCache = new Map<string, AudioBuffer>()
  const clipBuffers = useClipBuffers({
    audioEngine,
    tracks: () => resolvedTracks(),
    onBufferChange: () => setBufferVersion((current) => current + 1),
  })
  const {
    pushHistory,
    handleUndo,
    handleRedo,
  } = useTimelineHistory({
    roomId,
    userId,
    getTracks: () => resolvedTracks(),
    convexClient,
    convexApi,
    audioEngine,
    ensureClipBuffer: (clipId, sampleUrl) => clipBuffers.ensureClipBuffer(clipId, sampleUrl),
    grantTrackWrite,
    grantClipWrite,
    persistLocalMix: saveLocalMix,
    getActions: () => ({
      insertLocalTrack: (track, index) => projection.insertLocalTrack(track, index),
      removeLocalTrack: (trackId) => projection.removeLocalTrack(trackId),
      insertLocalClip: (trackId, clip) => projection.insertLocalClip(trackId, clip),
      removeLocalClips: (clipIds) => projection.removeLocalClips(clipIds),
      commitClipMoves: (moves) => projection.commitClipMoves(moves),
      commitClipTiming: (clipId, patch) => projection.commitClipTiming(clipId, patch),
      rescheduleChangedClips,
      cancelTrackVolumeWrite: (trackId) => cancelTrackVolumeWrite(trackId),
      cancelTrackRoutingWrite: (trackId) => cancelTrackRoutingWrite(trackId),
      cancelTrackMixWrite: (trackId) => cancelTrackMixWrite(trackId),
      applyTrackVolume: (trackId, volume, scope) => applyTrackVolume(trackId, volume, scope),
      applyTrackMixState: (trackId, patch, scope) => applyTrackMixState(trackId, patch, scope),
      applyTrackRouting: (trackId, routing) => applyTrackRouting(trackId, { sends: routing.sends ?? [], outputTargetId: routing.outputTargetId }),
    }),
  })
  const {
    pendingSharedTrackVolumes,
    pendingSharedTrackRouting,
    pendingSharedTrackMix,
    cancelTrackVolumeWrite,
    cancelTrackRoutingWrite,
    cancelTrackMixWrite,
    applyTrackVolume,
    applyTrackMixState,
    applyConfirmedTrackMixState,
    applyTrackRouting,
    setTrackVolume,
    handleToggleTrackMute,
    handleToggleTrackSolo,
    updateTrackSends,
    updateTrackOutputTargetId,
  } = useTimelineMixerController({
    roomId,
    userId,
    syncMix,
    tracks: () => renderTracks(),
    localMix,
    optimisticTrackIds,
    canWriteTrack,
    pushHistory,
    serverTrackState,
  })

  const [bufferVersion, setBufferVersion] = createSignal(0)
  const {
    resolvedTracks,
    placementTracks,
    renderTracks: resolvedRenderTracks,
    trackLookup,
  } = useTimelineResolvedModel({
    fullViewData: () => fullView.data,
    syncMix,
    writableTrackIds,
    serverTrackState,
    localMixByTrackId: localMix.byTrackId,
    pendingSharedTrackVolumes,
    pendingSharedTrackRouting,
    pendingSharedTrackMix,
    projection: {
      pendingTrackEntriesById: projection.pendingTrackEntriesById,
      removedTrackIds: projection.removedTrackIds,
      pendingTrackLocksById: projection.pendingTrackLocksById,
      pendingClipCreatesById: projection.pendingClipCreatesById,
      removedClipIds: projection.removedClipIds,
      committedClipEditsById: projection.committedClipEditsById,
      draftClipEditsById: projection.draftClipEditsById,
      previewClipsByTrackId: projection.previewClipsByTrackId,
    },
    identity: {
      trackHistoryRefsById: identity.trackHistoryRefsById,
      trackNamesByHistoryRef: identity.trackNamesByHistoryRef,
      clipHistoryRefsById: identity.clipHistoryRefsById,
      rememberTrackProjection: identity.rememberTrackProjection,
      rememberClipHistoryRef: identity.rememberClipHistoryRef,
    },
    audioBufferCache: clipBuffers.audioBufferCache,
    bufferVersion,
  })
  renderTracks = resolvedRenderTracks
  audioBufferCache = clipBuffers.audioBufferCache
  ensureClipBuffer = clipBuffers.ensureClipBuffer
  uploadToR2 = clipBuffers.uploadToR2
  clearClipBufferCaches = clipBuffers.clearClipBufferCaches
  const pendingDeleteTrackClipCount = createMemo(() => {
    const trackId = pendingDeleteTrackId()
    if (!trackId) return 0
    return trackLookup().trackById.get(trackId)?.clips.length ?? 0
  })

  function rescheduleChangedClips(clipIds: string[]) {
    if (clipIds.length === 0 || !isPlaying()) return
    try {
      const enabled = loopEnabled()
      const end = loopEndSec()
      const lenOk = enabled && end > loopStartSec() + 1e-3
      audioEngine.rescheduleClipsAtPlayhead(renderTracks(), playheadSec(), clipIds, lenOk ? { endLimitSec: end } : undefined)
    } catch {}
  }

  const applyAgentMixOps = (ops: AgentMixOp[]) => {
    try {
      if (!roomId() || !Array.isArray(ops) || ops.length === 0) return
      const currentTracks = renderTracks()
      const ownedSet = writableTrackIds()
      for (const op of ops) {
        const targets: Track[] = []
        for (const index of new Set(normalizeCommandTrackIndices(Array.isArray(op.indices) ? op.indices : undefined))) {
          if (index < 0 || index >= currentTracks.length) continue
          const track = currentTracks[index]
          if (!track || !ownedSet.has(track.id)) continue
          targets.push(track)
        }
        if (op.type === 'setSolo' && op.exclusive && op.value && targets.length === 1) {
          for (const track of currentTracks) {
            if (!ownedSet.has(track.id)) continue
            applyConfirmedTrackMixState(track.id, { soloed: track.id === targets[0].id }, op.issuedAt)
          }
          continue
        }
        for (const track of targets) {
          applyConfirmedTrackMixState(track.id, op.type === 'setSolo' ? { soloed: op.value } : { muted: op.value }, op.issuedAt)
        }
      }
    } catch {}
  }

  const pushEffectParamsHistory = (payload: EffectParamsCommitPayload) => {
    const rid = roomId()
    if (!rid) return
    pushHistory(
      buildEffectParamsHistoryEntry({
        roomId: rid,
        tracks: renderTracks(),
        payload,
      }),
      `fx:${payload.effect}:${payload.targetId}`,
      600,
    )
  }

  // Playback & playhead controls
  const {
    isPlaying,
    playheadSec,
    handlePause,
    handleStop,
    setPlayhead,
    requestPlay,
    startScrub,
    moveScrub,
    stopScrub,
    setScrollElement,
  } = usePlayheadControls({
    audioEngine,
    tracks: () => renderTracks(),
    ensureClipBuffer,
    loopEnabled,
    loopStartSec,
    loopEndSec,
  })

  // DOM refs
  let scrollRef: HTMLDivElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let containerRef: HTMLDivElement | undefined
  let rootRef: HTMLDivElement | undefined

  let openMidiEditorFor = (_clipId: string) => {}
  let stopRecordingSession: () => Promise<void> = async () => {}
  let toggleRecordingSession: () => Promise<unknown> = async () => {}

  const {
    createTimelineTrack,
    handleTransportPause,
    handleTransportStop,
    handleRecordToggle,
    handleShare,
    jumpToClip,
  } = useTimelineActions({
    room: {
      roomId,
      setRoomId,
      userId,
    },
    creation: {
      renderTracks,
      selection,
      insertLocalTrack: projection.insertLocalTrack,
      grantTrackWrite,
      pushHistory,
      convexClient,
      convexApi,
    },
    transport: {
      isRecording,
      handlePause,
      handleStop,
      stopRecording: () => stopRecordingSession(),
      toggleRecording: () => toggleRecordingSession(),
    },
    navigation: {
      renderTracks,
      trackLookup,
      selection,
      setPlayhead,
      openMidiEditorFor: (clipId) => openMidiEditorFor(clipId),
      ensureClipBuffer,
      getScrollElement: () => scrollRef,
    },
  })

  const {
    handleDrop: onDrop,
    handleFiles,
    handleAddAudio,
    handleInsertSample,
  } = useTimelineClipImport({
    audioEngine,
    tracks: () => renderTracks(),
    insertLocalTrack: projection.insertLocalTrack,
    insertLocalClip: projection.insertLocalClip,
    selection,
    playheadSec,
    roomId,
    userId,
    convexClient,
    convexApi,
    audioBufferCache,
    uploadToR2,
    getScrollElement: () => scrollRef,
    getFileInput: () => fileInputRef,
    bpm,
    gridEnabled,
    gridDenominator,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantWrite: grantTrackWrite,
    grantClipWrite,
  })

  const {
    dropTargetLane,
    dropAtNewTrack,
    handleRootDragOver,
    handleRootDrop,
    handleRootDragLeave,
  } = useTimelineDragDrop({
    tracks: () => renderTracks(),
    rootElement: () => rootRef,
    scrollElement: () => scrollRef,
    onDrop,
  })

  const {
    onClipPointerDown,
  } = useClipDrag({
    placementTracks: () => placementTracks(),
    resolvedTracks: () => resolvedTracks(),
    insertLocalTrack: projection.insertLocalTrack,
    insertLocalClip: projection.insertLocalClip,
    removeLocalTrack: projection.removeLocalTrack,
    replaceDraftClipMoves: projection.replaceDraftClipMoves,
    clearDraftClipMoves: projection.clearDraftClipMoves,
    setPreviewClipsByTrack: projection.setPreviewClipsByTrackId,
    commitClipMoves: projection.commitClipMoves,
    canWriteClip,
    selection,
    roomId,
    userId,
    convexClient,
    convexApi,
    getScrollElement: () => scrollRef,
    bpm,
    gridEnabled,
    gridDenominator,
    audioBufferCache,
    onCommitMoves: (ids) => {
      rescheduleChangedClips(ids)
    },
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantWrite: grantTrackWrite,
    grantClipWrites,
  })

  const {
    onClipResizeStart,
  } = useClipResize({
    tracks: () => renderTracks(),
    setDraftClipTiming: projection.setDraftClipTiming,
    commitClipTiming: projection.commitClipTiming,
    canWriteClip,
    selection,
    convexClient,
    convexApi,
    userId,
    getScrollElement: () => scrollRef,
    bpm,
    gridEnabled,
    gridDenominator,
    rescheduleChangedClips,
    roomId,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
  })

  const {
    onClipPointerUp,
    duplicateSelectedClips,
    performDeleteTrack,
    handleKeyboardAction,
  } = useTimelineClipActions({
    tracks: () => renderTracks(),
    insertLocalClip: projection.insertLocalClip,
    removeLocalClips: projection.removeLocalClips,
    removeLocalTrack: projection.removeLocalTrack,
    canWriteClip,
    selection,
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
    onLanePointerDown,
  } = useTimelineSelection({
    tracks: () => renderTracks(),
    selection,
    startScrub,
    moveScrub,
    stopScrub,
  })

  const {
    midiEditorClipId,
    midiCard,
    closeMidiEditor,
    openMidiEditorFor: nextOpenMidiEditorFor,
    changeMidiCardBounds,
    auditionNote,
    startLiveNote,
    stopLiveNote,
  } = useTimelineMidiOverlay({
    audioEngine,
    tracks: () => renderTracks(),
    roomId,
    selection,
  })
  openMidiEditorFor = nextOpenMidiEditorFor

  const recordingControls = useTrackRecording({
    audioEngine,
    tracks: () => renderTracks(),
    setTrackLock: projection.setTrackLock,
    clearTrackLock: projection.clearTrackLock,
    removeLocalTrack: projection.removeLocalTrack,
    insertLocalClip: projection.insertLocalClip,
    selection,
    playheadSec,
    uploadToR2,
    audioBufferCache,
    roomId,
    userId,
    convexClient,
    convexApi,
    requestTransportPlay: requestPlay,
    createTrackForRecording: async () => await createTimelineTrack({}, { pushHistory: false, select: false }),
    setIsRecording,
    notify: (message) => {
      console.warn('[Timeline][recording]', message)
    },
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantClipWrite,
  })

  const {
    recordArmTrackId,
    toggleRecording: nextToggleRecordingSession,
    toggleRecordArm: handleToggleRecordArm,
    reconcileRecordArm,
    stopRecording: nextStopRecordingSession,
    previewPoints,
    previewStartSec,
    recordingTrackId,
  } = recordingControls
  toggleRecordingSession = nextToggleRecordingSession
  stopRecordingSession = nextStopRecordingSession

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
      handleUndo()
    },
    onRedo: () => {
      handleRedo()
    },
    onAddInstrumentTrack: () => {
      void (async () => {
        try {
          await createTimelineTrack({ kind: 'instrument' })
        } catch {}
      })()
    },
  })

  const { onSidebarPointerDown } = useTimelineSidebarResize({
    sidebarWidth,
    setSidebarWidth,
    getContainerElement: () => containerRef,
  })

  const handleLanePointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (event.target instanceof Element && event.target.closest('[data-timeline-ruler="1"]')) return
    if (midiEditorClipId()) { event.preventDefault(); event.stopPropagation(); return }
    onLanePointerDown(event, scrollRef)
  }

  const onRulerPointerDown = (event: PointerEvent) => {
    event.preventDefault()
    if (midiEditorClipId()) { event.stopPropagation(); return }
    startScrub(event.clientX)
  }

  const onFileInput: JSX.EventHandler<HTMLInputElement, Event> = async (e) => {
    const input = e.currentTarget
    await handleFiles(input.files)
    input.value = ''
  }

  const duration = () => timelineDurationSec(renderTracks())

  createEffect(() => {
    audioEngine.updateTrackGains(renderTracks())
  })

  createEffect(() => {
    audioEngine.setBpm(bpm())
  })

  createEffect(() => {
    audioEngine.setMetronomeEnabled(metronomeEnabled())
  })

  createEffect(() => {
    const nextTracks = resolvedTracks()
    reconcileRecordArm(nextTracks)
  })

  onCleanup(() => {
    audioEngine.close()
    resetAudioEngine()
    clearClipBufferCaches()
  })

  return (
    <div ref={(el) => { rootRef = el }} class="h-full w-full flex flex-col bg-neutral-950 text-neutral-200" onDragOver={handleRootDragOver} onDrop={handleRootDrop} onDragLeave={handleRootDragLeave}>
      <input ref={(el) => { fileInputRef = el }} type="file" accept="audio/*" class="hidden" onChange={onFileInput} />
      
      <TransportControls
        isPlaying={isPlaying()}
        playheadSec={playheadSec()}
        onPlay={() => requestPlay()}
        onPause={handleTransportPause}
        onStop={handleTransportStop}
        onAddAudio={() => handleAddAudio()}
        onShare={handleShare}
        onMasterFX={() => { selection.setSelectedFXTarget('master'); setBottomFXOpen(true) }}
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
        currentUserId={userId()}
        projects={projects()}
        onOpenProject={(rid) => {
          navigateToRoom(rid)
        }}
        onCreateProject={createProject}
        onDeleteProject={deleteProject}
        onRenameProject={renameProject}
        onOpenExport={() => setExportOpen(true)}
      />
      <TimelinePanels
        chat={{
          bottomOffsetPx: bottomFXOpen() ? FX_OFFSET_PX : 0,
          agentPanelOpen: agentPanelOpen(),
          sharedChatOpen: sharedChatOpen(),
          roomId: roomId(),
          userId: userId(),
          bpm: bpm(),
          toggleAgentPanel: () => setAgentPanelOpen((value) => !value),
          toggleSharedChat: () => setSharedChatOpen((value) => !value),
          closeAgentPanel: () => setAgentPanelOpen(false),
          closeSharedChat: () => setSharedChatOpen(false),
          applyAgentMixOps,
        }}
        effectsPanel={{
          isOpen: bottomFXOpen(),
          selectedFXTarget: selection.selectedFXTarget(),
          tracks: renderTracks(),
          playheadSec: playheadSec(),
          roomId: roomId(),
          userId: userId(),
          audioEngine,
          canWriteTrackRouting: canWriteTrack,
          grantClipWrite,
          onSelectClip: jumpToClip,
          onClose: () => setBottomFXOpen(false),
          onOpen: () => setBottomFXOpen(true),
          onEffectParamsCommitted: pushEffectParamsHistory,
        }}
        exportDialog={{
          isOpen: exportOpen(),
          tracks: renderTracks(),
          bpm: bpm(),
          loopEnabled: loopEnabled(),
          loopStartSec: loopStartSec(),
          loopEndSec: loopEndSec(),
          roomId: roomId(),
          userId: userId(),
          ensureClipBuffer,
          onClose: () => setExportOpen(false),
        }}
      />

      <div class="flex-1 flex min-h-0" ref={(el) => { containerRef = el }}>
        <div
        class="flex-1 relative overflow-auto timeline-scroll"
        style={{ 'padding-bottom': bottomFXOpen() ? `${FX_OFFSET_PX}px` : '0px' }}
        ref={(el) => {
          scrollRef = el
          setScrollElement(el)
        }}
      >
          <div 
            class="relative select-none" 
            style={{ width: `${duration() * PPS}px`, height: `${RULER_HEIGHT + (renderTracks().length + (dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}px` }}
            onPointerDown={handleLanePointerDown}
          >
            <TimelineRuler
              durationSec={duration()}
              bpm={bpm()}
              denom={gridDenominator()}
              gridEnabled={gridEnabled()}
              onPointerDown={onRulerPointerDown}
              loopEnabled={loopEnabled()}
              loopStartSec={loopStartSec()}
              loopEndSec={loopEndSec()}
              onSetLoopRegion={(s, e) => setLoopRegion(s, e)}
            />
            
            <div class="absolute left-0 right-0" style={{ top: `${RULER_HEIGHT}px`, height: `${(renderTracks().length + (dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}px` }}>
              <For each={renderTracks()}>
                {(track, i) => (
                  <TrackLane
                    track={track}
                    index={i()}
                    isDropTarget={dropTargetLane() === i()}
                    selectedClipIds={selection.selectedClipIds()}
                    onClipPointerDown={onClipPointerDown}
                    onClipPointerUp={onClipPointerUp}
                    onClipResizeStart={onClipResizeStart}
                    bpm={bpm()}
                    onClipDblClick={(_, clipId) => {
                      const match = trackLookup().clipEntryById.get(clipId)
                      if (match && match.trackId === track.id && match.clip.midi) {
                        openMidiEditorFor(clipId)
                      }
                    }}
                  />
                )}
              </For>
              <TimelineOverlays
                timeline={{
                  tracks: renderTracks(),
                  durationSec: duration(),
                  bpm: bpm(),
                  gridDenominator: gridDenominator(),
                  gridEnabled: gridEnabled(),
                  loopEnabled: loopEnabled(),
                  loopStartSec: loopStartSec(),
                  loopEndSec: loopEndSec(),
                  playheadSec: playheadSec(),
                  dropAtNewTrack: dropAtNewTrack(),
                  marqueeRect: marqueeRect(),
                }}
                recording={{
                  isRecording: isRecording(),
                  previewStartSec: previewStartSec(),
                  previewPoints: previewPoints(),
                  recordingTrackId: recordingTrackId(),
                }}
                midi={{
                  clipId: midiEditorClipId(),
                  card: midiCard(),
                  userId: userId(),
                  roomId: roomId(),
                  close: closeMidiEditor,
                  changeBounds: changeMidiCardBounds,
                  auditionNote,
                  startLiveNote,
                  stopLiveNote,
                }}
              />
            </div>
          </div>
        </div>

        <TrackSidebar
          sidebar={{
            tracks: renderTracks(),
            selectedTrackId: selection.selectedTrackId(),
            sidebarWidth: sidebarWidth(),
            isPlaying: isPlaying(),
            bottomOffsetPx: bottomFXOpen() ? FX_OFFSET_PX : 0,
            syncMix: syncMix(),
            recordArmTrackId: recordArmTrackId(),
            currentUserId: userId(),
            getTrackLevel: (id) => {
              try { return audioEngine.getTrackLevel(id) } catch { return 0 }
            },
            getTrackLevels: (id) => {
              try { return audioEngine.getTrackLevelsStereo(id) } catch { return [0, 0] }
            },
            onTrackClick: (id) => {
              selection.selectTrackTarget(id, { clearClipSelection: true })
            },
            onAddTrack: async () => {
              await createTimelineTrack()
            },
            onAddReturnTrack: async () => {
              await createTimelineTrack({ channelRole: 'return' })
            },
            onAddGroupTrack: async () => {
              await createTimelineTrack({ channelRole: 'group' })
            },
            onAddInstrumentTrack: async () => {
              await createTimelineTrack({ kind: 'instrument' })
            },
            canWriteTrackRouting: canWriteTrack,
            onTrackSendsChange: (trackId, sends) => {
              localMix.persist(trackId, { sends })
              updateTrackSends(trackId, sends)
            },
            onTrackOutputTargetChange: (trackId, outputTargetId) => {
              localMix.persist(trackId, { outputTargetId: outputTargetId ?? null })
              updateTrackOutputTargetId(trackId, outputTargetId)
            },
            onVolumeChange: setTrackVolume,
            onToggleMute: handleToggleTrackMute,
            onToggleSolo: handleToggleTrackSolo,
            onToggleSyncMix: toggleSyncMix,
            onSidebarPointerDown,
            onToggleRecordArm: handleToggleRecordArm,
          }}
        />
      </div>


      <Dialog open={confirmOpen()} onOpenChange={setConfirmOpen}>
        <DialogContent class="bg-neutral-900 text-neutral-100 border border-neutral-800">
          <DialogHeader>
            <DialogTitle>Delete this track?</DialogTitle>
            <DialogDescription>
              {pendingDeleteTrackClipCount() > 0
                ? `This track contains ${pendingDeleteTrackClipCount()} audio clip${pendingDeleteTrackClipCount() === 1 ? '' : 's'}. Deleting the track will remove them. This action cannot be undone.`
                : 'This track has no audio clips. Deleting it cannot be undone.'}
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
