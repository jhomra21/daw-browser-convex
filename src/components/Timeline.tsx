import {
  type Accessor,
  type Component,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { Clip, Track } from "~/types/timeline";
import { getAudioEngine, resetAudioEngine } from "~/lib/audio-engine-singleton";
import {
  timelineDurationSec,
  FX_OFFSET_PX,
} from "~/lib/timeline-utils";
import { useTimelineKeyboard } from "~/hooks/useTimelineKeyboard";
import { useTimelineClipImport } from "~/hooks/useTimelineClipImport";
import { useTimelineClipActions } from "~/hooks/useTimelineClipActions";
import { convexClient, convexApi } from "~/lib/convex";
import { useTimelineData } from "~/hooks/useTimelineData";
import { usePlayheadControls } from "~/hooks/usePlayheadControls";
import { useClipDrag } from "~/hooks/useClipDrag";
import { useClipResize } from "~/hooks/useClipResize";
import { useTimelineSelection } from "~/hooks/useTimelineSelection";
import { useClipBuffers } from "~/hooks/useClipBuffers";
import { normalizeCommandTrackIndices } from "~/lib/agent-command-targets";
import { useTimelineResolvedModel } from "~/hooks/useTimelineResolvedModel";
import { useTimelineActions } from "~/hooks/useTimelineActions";
import { useTimelineSidebarResize } from "~/hooks/useTimelineSidebarResize";
import { useTrackRecording } from "~/hooks/useTrackRecording";
import { buildEffectParamsHistoryEntry } from "~/lib/undo/builders";
import type { EffectParamsCommitPayload } from "~/lib/undo/types";
import { useTimelinePreferences } from "~/hooks/useTimelinePreferences";
import { useTimelineMidiOverlay } from "~/hooks/useTimelineMidiOverlay";
import { useTimelineMixerController } from "~/hooks/useTimelineMixerController";
import { useProjectedTimelineModel } from "~/hooks/useProjectedTimelineModel";
import { useTimelineDragDrop } from "~/hooks/useTimelineDragDrop";
import { useTimelineHistory } from "~/hooks/useTimelineHistory";
import { useTimelineIdentity } from "~/hooks/useTimelineIdentity";
import { useTimelineLocalMix } from "~/hooks/useTimelineLocalMix";
import { useTimelineProjectionState } from "~/hooks/useTimelineProjectionState";
import { useTimelineSelectionState } from "~/hooks/useTimelineSelectionState";
import { flushLocalTimelineWrites } from "~/lib/timeline-repository/local-timeline-repository";
import { useTimelinePersistenceController } from "~/hooks/useTimelinePersistenceController";
import { useLocalProjectActions } from "~/hooks/useLocalProjectActions";
import TimelineChrome from "./timeline/timeline-chrome";
import DeleteTrackDialog from "./timeline/delete-track-dialog";
import TimelineWorkspace from "./timeline/timeline-workspace";

type AgentMixOp = {
  type: "setMute" | "setSolo";
  indices: number[];
  value: boolean;
  exclusive?: boolean;
  issuedAt: number;
};

const Timeline: Component = () => {
  const [bottomFXOpen, setBottomFXOpen] = createSignal(true);
  const [agentPanelOpen, setAgentPanelOpen] = createSignal(false);
  const [sharedChatOpen, setSharedChatOpen] = createSignal(false);
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<
    Track["id"] | null
  >(null);
  // Transport tempo & metronome
  const [metronomeEnabled, setMetronomeEnabled] = createSignal(false);
  const [isRecording, setIsRecording] = createSignal(false);
  const [exportOpen, setExportOpen] = createSignal(false);

  // Audio engine
  const audioEngine = getAudioEngine();
  // Collaboration: projectId from ?projectId=; ownership tied to Better Auth userId
  const {
    projectId,
    setProjectId,
    userId,
    projects,
    fullView,
    navigateToRoom,
    createProject,
    renameProject,
    deleteProject,
  } = useTimelineData();
  const localProject = useLocalProjectActions({
    projectId,
    navigateToRoom,
  });

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
  } = useTimelinePreferences({
    projectId,
    onLocalSaveFailed: localProject.setLocalSaveFailure,
  });
  const identity = useTimelineIdentity({
    projectId,
    serverData: () => fullView.data,
  });
  const projection = useTimelineProjectionState({
    projectId,
    serverData: () => fullView.data,
    rememberTrackProjection: identity.rememberTrackProjection,
    rememberClipHistoryRef: identity.rememberClipHistoryRef,
  });
  let renderTracks: Accessor<Track[]> = () => [];
  const selection = useTimelineSelectionState({
    projectId,
    tracks: () => renderTracks(),
    effectsPanel: {
      isOpen: bottomFXOpen,
      setOpen: setBottomFXOpen,
    },
  });
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
    projectId,
    userId,
    fullViewData: () => fullView.data,
    pendingTrackEntriesById: projection.pendingTrackEntriesById,
    pendingClipCreatesById: projection.pendingClipCreatesById,
    removedTrackIds: projection.removedTrackIds,
    removedClipIds: projection.removedClipIds,
  });
  const localMix = useTimelineLocalMix({
    projectId,
    writableTrackIds,
    onLocalSaveFailed: localProject.setLocalSaveFailure,
  });
  const clipBuffers = useClipBuffers({
    audioEngine,
    projectId,
    tracks: () => resolvedTracks(),
    onBufferChange: () => setBufferVersion((current) => current + 1),
  });
  const currentLocalProjectMode = createMemo(() => projects().find((project) => project.projectId === projectId())?.mode);
  const { mediaRecovery } = useTimelinePersistenceController({
    projectId,
    localProjectMode: currentLocalProjectMode,
    userId,
    renderTracks: () => renderTracks(),
    audioEngine,
    audioBufferCache: clipBuffers.audioBufferCache,
    clipMediaStatus: clipBuffers.clipMediaStatus,
    localProject,
    projection,
    selection,
  });
  const { pushHistory, handleUndo, handleRedo } = useTimelineHistory({
    projectId,
    userId,
    getTracks: () => resolvedTracks(),
    convexClient,
    convexApi,
    audioEngine,
    ensureClipBuffer: (clipId, sampleUrl) =>
      clipBuffers.ensureClipBuffer(clipId, sampleUrl),
    grantTrackWrite,
    grantClipWrite,
    persistLocalMix: (_projectId, trackId, patch) =>
      localMix.persist(trackId, patch),
    getActions: () => ({
      insertLocalTrack: (track, index) =>
        projection.insertLocalTrack(track, index),
      removeLocalTrack: (trackId) => projection.removeLocalTrack(trackId),
      insertLocalClip: (trackId, clip) =>
        projection.insertLocalClip(trackId, clip),
      removeLocalClips: (clipIds) => projection.removeLocalClips(clipIds),
      commitClipMoves: (moves) => projection.commitClipMoves(moves),
      commitClipTiming: (clipId, patch) =>
        projection.commitClipTiming(clipId, patch),
      rescheduleChangedClips,
      cancelTrackVolumeWrite: (trackId) => cancelTrackVolumeWrite(trackId),
      cancelTrackRoutingWrite: (trackId) => cancelTrackRoutingWrite(trackId),
      cancelTrackMixWrite: (trackId) => cancelTrackMixWrite(trackId),
      applyTrackVolume: (trackId, volume, scope) =>
        applyTrackVolume(trackId, volume, scope),
      applyTrackMixState: (trackId, patch, scope) =>
        applyTrackMixState(trackId, patch, scope),
      applyTrackRouting: (trackId, routing) =>
        applyTrackRouting(trackId, {
          sends: routing.sends ?? [],
          outputTargetId: routing.outputTargetId,
        }),
    }),
  });
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
    projectId,
    userId,
    syncMix,
    tracks: () => renderTracks(),
    localMix,
    optimisticTrackIds,
    canWriteTrack,
    pushHistory,
    serverTrackState,
  });

  const [bufferVersion, setBufferVersion] = createSignal(0);
  const {
    resolvedTracks,
    placementTracks,
    renderTracks: resolvedRenderTracks,
    trackLookup,
  } = useTimelineResolvedModel({
    projectId,
    fullViewData: () => fullView.data,
    localSnapshot: mediaRecovery.localTimelineSnapshot,
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
    clipMediaStatus: clipBuffers.clipMediaStatus,
    bufferVersion,
  });
  renderTracks = resolvedRenderTracks;
  const pendingDeleteTrackClipCount = createMemo(() => {
    const trackId = pendingDeleteTrackId();
    if (!trackId) return 0;
    return trackLookup().trackById.get(trackId)?.clips.length ?? 0;
  });

  function rescheduleChangedClips(clipIds: string[]) {
    if (clipIds.length === 0 || !isPlaying()) return;
    try {
      const enabled = loopEnabled();
      const end = loopEndSec();
      const lenOk = enabled && end > loopStartSec() + 1e-3;
      audioEngine.rescheduleClipsAtPlayhead(
        renderTracks(),
        playheadSec(),
        clipIds,
        lenOk ? { endLimitSec: end } : undefined,
      );
    } catch {}
  }

  const applyAgentMixOps = (ops: AgentMixOp[]) => {
    try {
      if (!projectId() || !Array.isArray(ops) || ops.length === 0) return;
      const currentTracks = renderTracks();
      const ownedSet = writableTrackIds();
      for (const op of ops) {
        const targets: Track[] = [];
        for (const index of new Set(
          normalizeCommandTrackIndices(
            Array.isArray(op.indices) ? op.indices : undefined,
          ),
        )) {
          if (index < 0 || index >= currentTracks.length) continue;
          const track = currentTracks[index];
          if (!track || !ownedSet.has(track.id)) continue;
          targets.push(track);
        }
        if (
          op.type === "setSolo" &&
          op.exclusive &&
          op.value &&
          targets.length === 1
        ) {
          for (const track of currentTracks) {
            if (!ownedSet.has(track.id)) continue;
            applyConfirmedTrackMixState(
              track.id,
              { soloed: track.id === targets[0].id },
              op.issuedAt,
            );
          }
          continue;
        }
        for (const track of targets) {
          applyConfirmedTrackMixState(
            track.id,
            op.type === "setSolo" ? { soloed: op.value } : { muted: op.value },
            op.issuedAt,
          );
        }
      }

    } catch {}
  };

  const handleLocalMidiSaved = (clipId: string, midi: Clip["midi"]) => {
    const match = trackLookup().clipEntryById.get(clipId);
    if (!match) return;
    projection.replaceLocalClip(match.trackId, {
      ...match.clip,
      midi,
    });
  };

  const pushEffectParamsHistory = (payload: EffectParamsCommitPayload) => {
    const rid = projectId();
    if (!rid) return;
    pushHistory(
      buildEffectParamsHistoryEntry({
        projectId: rid,
        tracks: renderTracks(),
        payload,
      }),
      `fx:${payload.effect}:${payload.targetId}`,
      600,
    );
  };

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
    ensureClipBuffer: clipBuffers.ensureClipBuffer,
    loopEnabled,
    loopStartSec,
    loopEndSec,
  });

  // DOM refs
  let scrollRef: HTMLDivElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let archiveInputRef: HTMLInputElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let rootRef: HTMLDivElement | undefined;

  const {
    midiEditorClipId,
    midiCard,
    closeMidiEditor,
    openMidiEditorFor,
    changeMidiCardBounds,
    auditionNote,
    startLiveNote,
    stopLiveNote,
  } = useTimelineMidiOverlay({
    audioEngine,
    tracks: () => renderTracks(),
    projectId,
    selection,
  });

  const {
    createTimelineTrack,
    handleShare,
    jumpToClip,
  } = useTimelineActions({
    room: {
      projectId,
      setProjectId,
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
    navigation: {
      renderTracks,
      trackLookup,
      selection,
      setPlayhead,
      openMidiEditorFor,
      ensureClipBuffer: clipBuffers.ensureClipBuffer,
      getScrollElement: () => scrollRef,
    },
  });

  const {
    handleDrop: onDrop,
    handleFiles,
    handleAddAudio,
    handleInsertSample,
  } = useTimelineClipImport({
    audioEngine,
    tracks: () => renderTracks(),
    insertLocalTrack: projection.insertLocalTrack,
    removeLocalTrack: projection.removeLocalTrack,
    insertLocalClip: projection.insertLocalClip,
    selection,
    playheadSec,
    projectId,
    userId,
    convexClient,
    convexApi,
    audioBufferCache: clipBuffers.audioBufferCache,
    uploadToR2: clipBuffers.uploadToR2,
    getScrollElement: () => scrollRef,
    getFileInput: () => fileInputRef,
    bpm,
    gridEnabled,
    gridDenominator,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantWrite: grantTrackWrite,
    grantClipWrite,
    onLocalSaveFailed: localProject.setLocalSaveFailure,
  });

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
  });

  const { onClipPointerDown } = useClipDrag({
    placementTracks: () => placementTracks(),
    resolvedTracks: () => resolvedTracks(),
    insertLocalTrack: projection.insertLocalTrack,
    insertLocalClip: projection.insertLocalClip,
    removeLocalClips: projection.removeLocalClips,
    removeLocalTrack: projection.removeLocalTrack,
    replaceDraftClipMoves: projection.replaceDraftClipMoves,
    clearDraftClipMoves: projection.clearDraftClipMoves,
    setPreviewClipsByTrack: projection.setPreviewClipsByTrackId,
    commitClipMoves: projection.commitClipMoves,
    canWriteClip,
    selection,
    projectId,
    userId,
    convexClient,
    convexApi,
    getScrollElement: () => scrollRef,
    bpm,
    gridEnabled,
    gridDenominator,
    audioBufferCache: clipBuffers.audioBufferCache,
    onCommitMoves: (ids) => {
      rescheduleChangedClips(ids);
    },
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantWrite: grantTrackWrite,
    grantClipWrites,
  });

  const { onClipResizeStart } = useClipResize({
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
    projectId,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
  });

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
    projectId,
    userId,
    convexClient,
    convexApi,
    audioBufferCache: clipBuffers.audioBufferCache,
    bpm,
    gridEnabled,
    gridDenominator,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantClipWrites,
  });

  const { marqueeRect, onLanePointerDown } = useTimelineSelection({
    tracks: () => renderTracks(),
    selection,
    startScrub,
    moveScrub,
    stopScrub,
  });

  const recordingControls = useTrackRecording({
    audioEngine,
    tracks: () => renderTracks(),
    setTrackLock: projection.setTrackLock,
    clearTrackLock: projection.clearTrackLock,
    removeLocalTrack: projection.removeLocalTrack,
    insertLocalClip: projection.insertLocalClip,
    selection,
    playheadSec,
    uploadToR2: clipBuffers.uploadToR2,
    audioBufferCache: clipBuffers.audioBufferCache,
    projectId,
    userId,
    convexClient,
    convexApi,
    requestTransportPlay: requestPlay,
    createTrackForRecording: async () =>
      await createTimelineTrack({}, { pushHistory: false, select: false }),
    setIsRecording,
    notify: (message) => {
      console.warn("[Timeline][recording]", message);
      if (message.includes("local") || message.includes("storage")) {
        localProject.setLocalSaveFailure(message);
      }
    },
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantClipWrite,
  });

  const {
    recordArmTrackId,
    toggleRecording,
    toggleRecordArm: handleToggleRecordArm,
    reconcileRecordArm,
    stopRecording,
    previewPoints,
    previewStartSec,
    recordingTrackId,
  } = recordingControls;

  const handleTransportPause = () => {
    if (isRecording()) void stopRecording();
    handlePause();
  };

  const handleTransportStop = () => {
    if (isRecording()) void stopRecording();
    handleStop();
  };

  const handleRecordToggle = async () => {
    await toggleRecording();
  };

  const addAudioTrack = async () => {
    await createTimelineTrack();
  };
  const addReturnTrack = async () => {
    await createTimelineTrack({ channelRole: "return" });
  };
  const addGroupTrack = async () => {
    await createTimelineTrack({ channelRole: "group" });
  };
  const addInstrumentTrack = async () => {
    await createTimelineTrack({ kind: "instrument" });
  };

  useTimelineKeyboard({
    onSpace: () => {
      if (isRecording()) {
        handleTransportPause();
      } else {
        isPlaying() ? handlePause() : requestPlay();
      }
    },
    onDelete: handleKeyboardAction,
    onDuplicate: () => {
      void duplicateSelectedClips();
    },
    onAddAudioTrack: () => {
      void addAudioTrack().catch(() => {});
    },
    onAddReturnTrack: () => {
      void addReturnTrack().catch(() => {});
    },
    onAddGroupTrack: () => {
      void addGroupTrack().catch(() => {});
    },
    onUndo: () => {
      handleUndo();
    },
    onRedo: () => {
      handleRedo();
    },
    onAddInstrumentTrack: () => {
      void addInstrumentTrack().catch(() => {});
    },
  });

  const { onSidebarPointerDown } = useTimelineSidebarResize({
    sidebarWidth,
    setSidebarWidth,
    getContainerElement: () => containerRef,
  });

  const handleLanePointerDown: JSX.EventHandler<
    HTMLDivElement,
    PointerEvent
  > = (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest('[data-timeline-ruler="1"]')
    )
      return;
    if (midiEditorClipId()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onLanePointerDown(event, scrollRef);
  };

  const onRulerPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    if (midiEditorClipId()) {
      event.stopPropagation();
      return;
    }
    startScrub(event.clientX);
  };

  const onFileInput: JSX.EventHandler<HTMLInputElement, Event> = async (e) => {
    const input = e.currentTarget;
    await handleFiles(input.files);
    input.value = "";
  };

  const duration = () => timelineDurationSec(renderTracks());

  createEffect(() => {
    audioEngine.updateTrackGains(renderTracks());
  });

  createEffect(() => {
    audioEngine.setBpm(bpm());
  });

  createEffect(() => {
    audioEngine.setMetronomeEnabled(metronomeEnabled());
  });

  createEffect(() => {
    projectId();
    onCleanup(() => {
      void flushLocalTimelineWrites();
    });
  });

  createEffect(() => {
    const nextTracks = resolvedTracks();
    reconcileRecordArm(nextTracks);
  });

  onCleanup(() => {
    audioEngine.close();
    resetAudioEngine();
    clipBuffers.clearClipBufferCaches();
  });

  const transportProps = () => ({
    isPlaying: isPlaying(),
    playheadSec: playheadSec(),
    onPlay: () => requestPlay(),
    onPause: handleTransportPause,
    onStop: handleTransportStop,
    onAddAudio: () => handleAddAudio(),
    tracksMenu: {
      syncMix: syncMix(),
      onToggleSyncMix: toggleSyncMix,
      onAddTrack: addAudioTrack,
      onAddReturnTrack: addReturnTrack,
      onAddGroupTrack: addGroupTrack,
      onAddInstrumentTrack: addInstrumentTrack,
    },
    onShare: handleShare,
    onMasterFX: () => {
      selection.setSelectedFXTarget("master");
      setBottomFXOpen(true);
    },
    bpm: bpm(),
    onChangeBpm: (next: number) => setBpm(clampBpm(next)),
    metronomeEnabled: metronomeEnabled(),
    onToggleMetronome: () => setMetronomeEnabled((prev) => !prev),
    gridEnabled: gridEnabled(),
    onToggleGrid: () => setGridEnabled((prev) => !prev),
    gridDenominator: gridDenominator(),
    onChangeGridDenominator: setGridDenominator,
    loopEnabled: loopEnabled(),
    onToggleLoop: () => setLoopEnabled((prev) => !prev),
    isRecording: isRecording(),
    onToggleRecord: handleRecordToggle,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onJumpToClip: (clipId: string, trackId: string, startSec: number) => jumpToClip(trackId, clipId, startSec),
    onInsertSample: (payload: Parameters<typeof handleInsertSample>[0]) => {
      void handleInsertSample(payload);
    },
    currentProjectId: projectId(),
    currentUserId: userId(),
    projects: projects(),
    onOpenProject: navigateToRoom,
    onCreateProject: createProject,
    onDeleteProject: deleteProject,
    onRenameProject: renameProject,
    onOpenExport: () => setExportOpen(true),
    onChooseProjectFolder: localProject.chooseProjectStorageFolder,
    onBackUpNow: localProject.backUpNow,
    onExportArchive: localProject.exportArchive,
    onImportArchive: () => archiveInputRef?.click(),
  });

  const panelsProps = () => ({
    chat: {
      bottomOffsetPx: bottomFXOpen() ? FX_OFFSET_PX : 0,
      agentPanelOpen: agentPanelOpen(),
      sharedChatOpen: sharedChatOpen(),
      projectId: projectId(),
      userId: userId(),
      bpm: bpm(),
      toggleAgentPanel: () => setAgentPanelOpen((value) => !value),
      toggleSharedChat: () => setSharedChatOpen((value) => !value),
      closeAgentPanel: () => setAgentPanelOpen(false),
      closeSharedChat: () => setSharedChatOpen(false),
      applyAgentMixOps,
    },
    effectsPanel: {
      isOpen: bottomFXOpen(),
      selectedFXTarget: selection.selectedFXTarget(),
      tracks: renderTracks(),
      playheadSec: playheadSec(),
      projectId: projectId(),
      userId: userId(),
      audioEngine,
      canWriteTrackRouting: canWriteTrack,
      grantClipWrite,
      onSelectClip: jumpToClip,
      insertLocalClip: projection.insertLocalClip,
      onClose: () => setBottomFXOpen(false),
      onOpen: () => setBottomFXOpen(true),
      onEffectParamsCommitted: pushEffectParamsHistory,
      onLocalSaveFailed: localProject.setLocalSaveFailure,
    },
    exportDialog: {
      isOpen: exportOpen(),
      tracks: renderTracks(),
      bpm: bpm(),
      loopEnabled: loopEnabled(),
      loopStartSec: loopStartSec(),
      loopEndSec: loopEndSec(),
      projectId: projectId(),
      userId: userId(),
      ensureClipBuffer: clipBuffers.ensureClipBuffer,
      onClose: () => setExportOpen(false),
    },
  });

  return (
    <div
      ref={(el) => {
        rootRef = el;
      }}
      class="h-full w-full flex flex-col bg-neutral-950 text-neutral-200"
      onDragOver={handleRootDragOver}
      onDrop={handleRootDrop}
      onDragLeave={handleRootDragLeave}
    >
      <TimelineChrome
        fileInputRef={(el) => {
          fileInputRef = el;
        }}
        archiveInputRef={(el) => {
          archiveInputRef = el;
        }}
        onFileInput={onFileInput}
        onArchiveInput={localProject.onArchiveInput}
        transport={transportProps()}
        localSaveFailure={localProject.localSaveFailure()}
        onExportArchive={localProject.exportArchive}
        onDismissLocalSaveFailure={() => localProject.setLocalSaveFailure(null)}
        panels={panelsProps()}
      />

      <TimelineWorkspace
        containerRef={(el) => { containerRef = el; }}
        scrollRef={(el) => {
          scrollRef = el;
          setScrollElement(el);
        }}
        bottomFXOpen={bottomFXOpen()}
        durationSec={duration()}
        sidebarWidth={sidebarWidth()}
        tracks={renderTracks()}
        dropAtNewTrack={dropAtNewTrack()}
        dropTargetLane={dropTargetLane()}
        bpm={bpm()}
        gridDenominator={gridDenominator()}
        gridEnabled={gridEnabled()}
        loopEnabled={loopEnabled()}
        loopStartSec={loopStartSec()}
        loopEndSec={loopEndSec()}
        playheadSec={playheadSec()}
        onSetLoopRegion={(s, e) => setLoopRegion(s, e)}
        onLanePointerDown={handleLanePointerDown}
        onRulerPointerDown={onRulerPointerDown}
        selection={selection}
        onClipPointerDown={onClipPointerDown}
        onClipPointerUp={onClipPointerUp}
        onClipResizeStart={onClipResizeStart}
        ensureClipBuffer={clipBuffers.ensureClipBuffer}
        replaceMissingMediaClip={mediaRecovery.replaceMissingMediaClip}
        removeMissingMediaClip={mediaRecovery.removeMissingMediaClip}
        trackLookup={trackLookup()}
        openMidiEditorFor={openMidiEditorFor}
        marqueeRect={marqueeRect()}
        recording={{
          isRecording: isRecording(),
          previewStartSec: previewStartSec(),
          previewPoints: previewPoints(),
          recordingTrackId: recordingTrackId(),
          recordArmTrackId: recordArmTrackId(),
        }}
        midi={{
          clipId: midiEditorClipId(),
          card: midiCard(),
          userId: userId(),
          projectId: projectId(),
          close: closeMidiEditor,
          changeBounds: changeMidiCardBounds,
          auditionNote,
          startLiveNote,
          stopLiveNote,
          onLocalMidiSaved: handleLocalMidiSaved,
        }}
        sidebar={{
          isPlaying: isPlaying(),
          currentUserId: userId(),
          subscribeTrackLevels: (listener) =>
            audioEngine.subscribeTrackStereoLevels(listener),
          onTrackClick: (id) => {
            selection.selectTrackTarget(id, { clearClipSelection: true });
          },
          canWriteTrackRouting: canWriteTrack,
          onTrackSendsChange: (trackId, sends) => {
            localMix.persist(trackId, { sends });
            updateTrackSends(trackId, sends);
          },
          onTrackOutputTargetChange: (trackId, outputTargetId) => {
            localMix.persist(trackId, { outputTargetId: outputTargetId ?? null });
            updateTrackOutputTargetId(trackId, outputTargetId);
          },
          onVolumePreview: (trackId, volume, muted) => {
            audioEngine.previewTrackVolume(trackId, volume, muted);
          },
          onVolumeChange: setTrackVolume,
          onToggleMute: handleToggleTrackMute,
          onToggleSolo: handleToggleTrackSolo,
          onSidebarPointerDown,
          onToggleRecordArm: handleToggleRecordArm,
        }}
      />

      <DeleteTrackDialog
        open={confirmOpen()}
        clipCount={pendingDeleteTrackClipCount()}
        pendingTrackId={pendingDeleteTrackId()}
        onOpenChange={setConfirmOpen}
        onCancel={() => {
          setConfirmOpen(false);
          setPendingDeleteTrackId(null);
        }}
        onConfirm={(trackId) => {
          performDeleteTrack(trackId);
          setPendingDeleteTrackId(null);
          setConfirmOpen(false);
        }}
      />

      {/* Cloud-only mode: no browser capability notice needed */}
    </div>
  );
};

export default Timeline;
