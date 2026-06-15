import {
  type Accessor,
  type Component,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { AudioWarp, Clip, Track } from "@daw-browser/timeline-core/types";
import { getAudioEngine } from "~/lib/audio-engine-singleton";
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
import { normalizeCommandTrackIndices } from "@daw-browser/shared";
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
import { useTimelinePersistenceController } from "~/hooks/useTimelinePersistenceController";
import { useTimelineAudioLifecycle } from "~/hooks/useTimelineAudioLifecycle";
import { useTimelineAudioWarp } from "~/hooks/useTimelineAudioWarp";
import { useLocalProjectActions } from "~/hooks/useLocalProjectActions";
import { useProjectSamples } from "~/hooks/useProjectSamples";
import { removeAutoCreatedCloudTrack } from "~/lib/timeline-audio-import";
import { createTimelineClipWriteAdapter } from "~/lib/timeline-clip-write-adapter";
import { getClipHistoryRef } from "~/lib/undo/refs";
import TimelineChrome from "./timeline/timeline-chrome";
import AppMessageDialog, { type AppMessageDialogState } from "./timeline/app-message-dialog";
import CloudBackupDialog from "./timeline/cloud-backup-dialog";
import DeleteTrackDialog from "./timeline/delete-track-dialog";
import TimelineWorkspace from "./timeline/timeline-workspace";
import { Dashboard } from "~/components/dashboard/dashboard";
import type { DashboardView } from "~/components/dashboard/types";

type AgentMixOp = {
  type: "setMute" | "setSolo";
  indices: number[];
  value: boolean;
  exclusive?: boolean;
  issuedAt: number;
};

type TimelineProps = {
  bootstrapIfEmpty: boolean;
  dashboardEnabled: boolean;
  dashboardView: Accessor<DashboardView | null>;
  setDashboardParam: (view: DashboardView | null) => void;
};

type BottomPanelMode = "effects" | "sample-detail";

const isValidAudioClip = (clip: Clip<AudioBuffer> | undefined) => {
  if (!clip || clip.midi) return false;
  return Boolean(
    clip.sampleUrl ||
      clip.sourceAssetKey ||
      clip.sourceKind ||
      clip.buffer,
  );
};

const Timeline: Component<TimelineProps> = (props) => {
  const [bottomFXOpen, setBottomFXOpen] = createSignal(true);
  const [bottomPanelMode, setBottomPanelMode] = createSignal<BottomPanelMode>("effects");
  const [agentPanelOpen, setAgentPanelOpen] = createSignal(false);
  const [sharedChatOpen, setSharedChatOpen] = createSignal(false);
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [appMessage, setAppMessage] = createSignal<AppMessageDialogState | null>(null);
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<
    Track["id"] | null
  >(null);
  // Transport tempo & metronome
  const [metronomeEnabled, setMetronomeEnabled] = createSignal(false);
  const [exportOpen, setExportOpen] = createSignal(false);

  // Audio engine
  const audioEngine = getAudioEngine();
  // Collaboration: projectId from ?projectId=; ownership tied to Better Auth userId
  const notify = (title: string, message: string) => {
    setAppMessage({ title, message });
  };

  const {
    projectId,
    setProjectId,
    userId,
    projects,
    currentProjectRole,
    fullView,
    navigateToRoom,
    createProject,
    renameProject,
    deleteProject,
  } = useTimelineData({
    notify,
    bootstrapIfEmpty: props.bootstrapIfEmpty,
  });
  const localProject = useLocalProjectActions({
    projectId,
    userId,
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
  const clipBuffers = useClipBuffers({
    audioEngine,
    projectId,
    tracks: () => resolvedTracks(),
    onBufferChange: () => setBufferVersion((current) => current + 1),
  });
  const currentLocalProjectMode = createMemo(() => projects().find((project) => project.projectId === projectId())?.mode);
  const { mediaRecovery } = useTimelinePersistenceController({
    projectId,
    remoteTimelineAvailable: () => Boolean(fullView.data),
    localProjectMode: currentLocalProjectMode,
    userId,
    renderTracks: () => renderTracks(),
    audioEngine,
    audioBufferCache: clipBuffers.writer,
    localProject,
    projection,
    selection,
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
    localSnapshot: mediaRecovery.localTimelineSnapshot,
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
  const { pushHistory, handleUndo, handleRedo } = useTimelineHistory({
    projectId,
    userId,
    getTracks: () => resolvedTracks(),
    convexClient,
    convexApi,
    audioEngine,
    ensureClipBuffer: clipBuffers.preload,
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
      commitClipAudioWarp: (clipId, audioWarp) =>
        projection.commitClipAudioWarp(clipId, audioWarp),
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
    onLocalSaveFailed: localProject.setLocalSaveFailure,
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
    buffers: clipBuffers,
    bufferVersion,
  });
  renderTracks = resolvedRenderTracks;
  const pendingDeleteTrackClipCount = createMemo(() => {
    const trackId = pendingDeleteTrackId();
    if (!trackId) return 0;
    return trackLookup().trackById.get(trackId)?.clips.length ?? 0;
  });

  const audioWarpController = useTimelineAudioWarp({
    projectId,
    userId,
    bpm,
    tracks: () => renderTracks(),
    selectedClip: selection.selectedClip,
    canWriteClip,
    projection,
    pushHistory,
    rescheduleChangedClips,
  });
  const selectedSampleDetailClip = createMemo(() => {
    const selected = selection.selectedClip();
    if (!selected) return undefined;
    const match = trackLookup().clipEntryById.get(selected.clipId);
    if (!match || match.trackId !== selected.trackId) return undefined;
    return isValidAudioClip(match.clip) ? match.clip : undefined;
  });

  createEffect(() => {
    if (bottomPanelMode() !== "sample-detail") return;
    if (selectedSampleDetailClip()) return;
    setBottomPanelMode("effects");
    setBottomFXOpen(true);
  });

  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || bottomPanelMode() !== "sample-detail") return;
      if (document.body.hasAttribute("data-warp-marker-dragging")) return;
      event.preventDefault();
      setBottomPanelMode("effects");
      setBottomFXOpen(true);
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown, { capture: true }));
  });

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

  const pushEffectParamsHistory = (payload: EffectParamsCommitPayload, committedProjectId?: string) => {
    const rid = committedProjectId ?? projectId();
    if (!rid) return;
    if (rid !== projectId()) return;
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
    rescheduleChangedClips: playbackRescheduleChangedClips,
  } = usePlayheadControls({
    audioEngine,
    tracks: () => renderTracks(),
    ensureClipBuffer: clipBuffers.preload,
    loopEnabled,
    loopStartSec,
    loopEndSec,
  });

  function rescheduleChangedClips(clipIds: string[]) {
    if (clipIds.length === 0 || !isPlaying()) return;
    try {
      const enabled = loopEnabled();
      const end = loopEndSec();
      const lenOk = enabled && end > loopStartSec() + 1e-3;
      playbackRescheduleChangedClips(
        renderTracks(),
        playheadSec(),
        clipIds,
        lenOk ? { endLimitSec: end } : undefined,
      );
    } catch {}
  }

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

  const removeCreatedCloudTrack = (track: Track | undefined) => removeAutoCreatedCloudTrack({
    convexClient,
    convexApi,
    userId: userId(),
    track,
    removeLocalTrack: projection.removeLocalTrack,
  });

  const {
    createTimelineTrack,
    handleShare,
    jumpToClip,
  } = useTimelineActions({
    tracks: renderTracks,
    room: {
      projectId,
      setProjectId,
      userId,
    },
    creation: {
      selection,
      insertLocalTrack: projection.insertLocalTrack,
      removeCloudTrack: removeCreatedCloudTrack,
      grantTrackWrite,
      pushHistory,
    },
    navigation: {
      trackLookup,
      selection,
      setPlayhead,
      openMidiEditorFor,
      ensureClipBuffer: clipBuffers.preload,
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
    removeLocalTrack: projection.removeLocalTrack,
    insertLocalClip: projection.insertLocalClip,
    removeLocalClips: projection.removeLocalClips,
    selection,
    playheadSec,
    projectId,
    userId,
    clipBuffers,
    getScrollElement: () => scrollRef,
    getFileInput: () => fileInputRef,
    bpm,
    gridEnabled,
    gridDenominator,
    createTimelineTrack,
    removeCreatedCloudTrack,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantClipWrite,
    onLocalSaveFailed: localProject.setLocalSaveFailure,
    notify,
    onDecodedClipCreated: (clip) => {
      void audioWarpController.bpmDetection.analyzeClip({
        clip,
        canWrite: canWriteClip(clip.id),
        autoApply: (audioWarp) => audioWarpController.changeAudioWarp(clip, audioWarp),
      });
    },
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
    audioBufferCache: clipBuffers,
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
    audioBufferCache: clipBuffers,
    bpm,
    gridEnabled,
    gridDenominator,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantClipWrites,
    notify,
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
    removeLocalClips: projection.removeLocalClips,
    selection,
    playheadSec,
    uploadToR2: clipBuffers.uploadToR2,
    audioBufferCache: clipBuffers.writer,
    projectId,
    userId,
    convexClient,
    convexApi,
    requestTransportPlay: requestPlay,
    createTrackForRecording: async () =>
      await createTimelineTrack({}, { pushHistory: false, select: false }),
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
    isRecording,
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
    enabled: () => props.dashboardView() === null,
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
    onOpenExport: () => setExportOpen(true),
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
    setBottomPanelMode("effects");
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
  const dashboardSamples = useProjectSamples({
    projectId,
    userId,
    enabled: () => props.dashboardView() === "samples",
    includeFilePath: () => true,
  });

  useTimelineAudioLifecycle({
    audioEngine,
    tracks: () => renderTracks(),
    bpm,
    metronomeEnabled,
    projectId,
    clearClipBufferCaches: clipBuffers.clearClipBufferCaches,
  });

  createEffect(() => {
    const nextTracks = resolvedTracks();
    reconcileRecordArm(nextTracks);
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
    projectMenu: {
      currentProjectId: projectId(),
      currentUserId: userId(),
      canManageSharing: currentProjectRole() === "owner",
      projects: projects(),
      onOpenProject: navigateToRoom,
      onCreateProject: createProject,
      onDeleteProject: deleteProject,
      onRenameProject: renameProject,
      onOpenExport: () => setExportOpen(true),
      onOpenDashboard: props.setDashboardParam,
      onShare: handleShare,
      onChooseProjectFolder: localProject.chooseProjectStorageFolder,
      onBackUpNow: localProject.backUpNow,
      onDisableBackup: localProject.disableBackup,
      onRestoreCloudBackup: localProject.restoreCloudBackup,
      onDuplicateCloudBackup: localProject.duplicateCloudBackup,
      onDownloadForOffline: localProject.downloadForOffline,
      cloudBackupStatus: localProject.cloudBackupStatus(),
      sharedOutboxStatus: localProject.sharedOutboxStatus(),
      onRetrySharedChanges: localProject.retrySharedChanges,
      onExportArchive: localProject.exportArchive,
      onImportArchive: () => archiveInputRef?.click(),
    },
    onMasterFX: () => {
      selection.setSelectedFXTarget("master");
      setBottomPanelMode("effects");
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
    onToggleRecord: toggleRecording,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onJumpToClip: (clipId: string, trackId: string, startSec: number) => jumpToClip(trackId, clipId, startSec),
    onInsertSample: (payload: Parameters<typeof handleInsertSample>[0]) => {
      void handleInsertSample(payload);
    },
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
      isOpen: bottomFXOpen() && bottomPanelMode() === "effects",
      showOpenButton: bottomPanelMode() === "effects",
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
      onOpen: () => {
        setBottomPanelMode("effects");
        setBottomFXOpen(true);
      },
      onEffectParamsCommitted: pushEffectParamsHistory,
      onLocalSaveFailed: localProject.setLocalSaveFailure,
    },
    sampleDetailPanel: {
      isOpen: bottomFXOpen() && bottomPanelMode() === "sample-detail",
      selectedClip: selectedSampleDetailClip(),
      preferenceScopeId: projectId(),
      projectBpm: bpm(),
      audioEngine,
      bpmDetection: audioWarpController.bpmDetection,
      ensureClipBuffer: clipBuffers.preload,
      canWriteClip,
      onChange: (clip: Clip, audioWarp: AudioWarp) => {
        return audioWarpController.changeAudioWarp(clip, audioWarp);
      },
      onGainChange: async (clip: Clip, gain: number) => {
        const project = projectId();
        if (!project || !canWriteClip(clip.id)) return false;
        const normalizedGain = Math.min(2, Math.max(0, gain));
        if (normalizedGain === (clip.gain ?? 1)) return true;
        const applied = await createTimelineClipWriteAdapter({ projectId: project, userId: userId() }).setGain(clip.id, normalizedGain);
        if (!applied) return false;
        projection.commitClipGain(clip.id, normalizedGain);
        rescheduleChangedClips([clip.id]);
        pushHistory({
          type: "clip-timing",
          projectId: project,
          data: {
            clipRef: getClipHistoryRef(clip),
            from: { startSec: clip.startSec, duration: clip.duration, leftPadSec: clip.leftPadSec, bufferOffsetSec: clip.bufferOffsetSec, midiOffsetBeats: clip.midiOffsetBeats, gain: clip.gain ?? 1 },
            to: { startSec: clip.startSec, duration: clip.duration, leftPadSec: clip.leftPadSec, bufferOffsetSec: clip.bufferOffsetSec, midiOffsetBeats: clip.midiOffsetBeats, gain: normalizedGain },
          },
        });
        return true;
      },
      onClose: () => {
        setBottomPanelMode("effects");
        setBottomFXOpen(true);
      },
    },
    exportDialog: {
      isOpen: exportOpen(),
      tracks: renderTracks(),
      getTracks: () => renderTracks(),
      selectedTrackId: selection.selectedTrackId() || undefined,
      bpm: bpm(),
      loopEnabled: loopEnabled(),
      loopStartSec: loopStartSec(),
      loopEndSec: loopEndSec(),
      projectId: projectId(),
      userId: userId(),
      ensureClipBuffer: clipBuffers.preload,
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

      {props.dashboardEnabled ? (
        <Dashboard
          view={props.dashboardView()}
          setView={props.setDashboardParam}
          model={{
            projectMenu: transportProps().projectMenu,
            samples: dashboardSamples.samples,
            bpm,
            setBpm: (value) => setBpm(clampBpm(value)),
            metronomeEnabled,
            toggleMetronome: () => setMetronomeEnabled((prev) => !prev),
            gridEnabled,
            toggleGrid: () => setGridEnabled((prev) => !prev),
            gridDenominator,
            setGridDenominator,
            loopEnabled,
            toggleLoop: () => setLoopEnabled((prev) => !prev),
          }}
        />
      ) : null}

      <CloudBackupDialog
        state={localProject.cloudBackupDialog()}
        busy={localProject.cloudBackupBusy()}
        onOpenChange={(open) => { if (!open) localProject.setCloudBackupDialog(null); }}
        onOverwriteCloud={localProject.overwriteCloudBackup}
        onRestoreCloud={localProject.confirmRestoreCloudBackup}
        onDuplicateCloud={localProject.duplicateCloudBackup}
      />

      <AppMessageDialog
        state={appMessage()}
        onOpenChange={(open) => { if (!open) setAppMessage(null); }}
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
        ensureClipBuffer={clipBuffers.preload}
        replaceMissingMediaClip={mediaRecovery.replaceMissingMediaClip}
        removeMissingMediaClip={mediaRecovery.removeMissingMediaClip}
        trackLookup={trackLookup()}
        openMidiEditorFor={openMidiEditorFor}
        openSampleDetailFor={(clipId) => {
          const match = trackLookup().clipEntryById.get(clipId);
          if (!match || !isValidAudioClip(match.clip)) return;
          selection.selectPrimaryClip({ trackId: match.trackId, clipId });
          setBottomPanelMode("sample-detail");
          setBottomFXOpen(true);
        }}
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
            setBottomPanelMode("effects");
            selection.selectTrackTarget(id, { clearClipSelection: true });
          },
          canWriteTrackRouting: canWriteTrack,
          onTrackSendsChange: updateTrackSends,
          onTrackOutputTargetChange: updateTrackOutputTargetId,
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
