import {
  type Accessor,
  type Component,
  type JSX,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import type { Clip, Track } from "~/types/timeline";
import { getAudioEngine, resetAudioEngine } from "~/lib/audio-engine-singleton";
import {
  timelineDurationSec,
  PPS,
  RULER_HEIGHT,
  LANE_HEIGHT,
  FX_OFFSET_PX,
} from "~/lib/timeline-utils";
import { useTimelineKeyboard } from "~/hooks/useTimelineKeyboard";
import { useTimelineClipImport } from "~/hooks/useTimelineClipImport";
import { useTimelineClipActions } from "~/hooks/useTimelineClipActions";
import TransportControls from "./timeline/TransportControls";
import TimelineRuler from "./timeline/TimelineRuler";
import TrackLane from "./timeline/TrackLane";
import TrackSidebar from "./timeline/TrackSidebar";
import { Button } from "./ui/button";
import { convexClient, convexApi } from "~/lib/convex";
import { useTimelineData } from "~/hooks/useTimelineData";
import { usePlayheadControls } from "~/hooks/usePlayheadControls";
import { useClipDrag } from "~/hooks/useClipDrag";
import { useClipResize } from "~/hooks/useClipResize";
import { useTimelineSelection } from "~/hooks/useTimelineSelection";
import { useClipBuffers } from "~/hooks/useClipBuffers";
import { normalizeCommandTrackIndices } from "~/lib/agent-command-targets";
import { getAudioSourceMetadata } from "~/lib/audio-source";
import { useTimelineResolvedModel } from "~/hooks/useTimelineResolvedModel";
import { useTimelineActions } from "~/hooks/useTimelineActions";
import { useTimelineSidebarResize } from "~/hooks/useTimelineSidebarResize";
import type { UploadToR2 } from "~/hooks/useClipBuffers";
import { useTrackRecording } from "~/hooks/useTrackRecording";
import { buildEffectParamsHistoryEntry } from "~/lib/undo/builders";
import type { EffectParamsCommitPayload } from "~/lib/undo/types";
import TimelineOverlays from "./timeline/timeline-overlays";
import TimelinePanels from "./timeline/timeline-panels";
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
import { useCloudSyncTick } from "~/hooks/useCloudSyncTick";
import { isLocalId } from "~/lib/local-ids";
import {
  createLocalAsset,
  setLocalProjectAssetDirectory,
} from "~/lib/local-assets";
import { runProjectBackup } from "~/lib/cloud-backup";
import { exportDawProjectArchive, importDawProjectArchive } from "~/lib/project-archive";
import { buildClipRemoveManyMutationInput } from "~/lib/clip-mutation-args";
import {
  createLocalTimelineRepository,
  flushLocalTimelineWrites,
} from "~/lib/timeline-repository/local-timeline-repository";

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
  const [localSaveFailure, setLocalSaveFailure] = createSignal<string | null>(
    null,
  );

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

  useCloudSyncTick({
    projectId,
    enabled: () => Boolean(userId() && isLocalId("project", projectId())),
    sync: () => backUpNow(),
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
  } = useTimelinePreferences({ projectId });
  const [localTimelineSnapshot, setLocalTimelineSnapshot] = createSignal<
    Awaited<ReturnType<ReturnType<typeof createLocalTimelineRepository>["loadSnapshot"]>> | null
  >(null);

  createEffect(() => {
    const rid = projectId();
    if (!isLocalId("project", rid)) {
      setLocalTimelineSnapshot(null);
      return;
    }
    let cancelled = false;
    void createLocalTimelineRepository(rid).loadSnapshot().then((snapshot) => {
      if (!cancelled && projectId() === rid) setLocalTimelineSnapshot(snapshot);
    }).catch(() => {
      if (!cancelled && projectId() === rid) setLocalTimelineSnapshot(null);
    });
    onCleanup(() => {
      cancelled = true;
    });
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
  });
  let ensureClipBuffer: (
    clipId: string,
    sampleUrl?: string,
  ) => Promise<void> = async () => {};
  let uploadToR2: UploadToR2 = async () => null;
  let clearClipBufferCaches = () => {};
  let audioBufferCache = new Map<string, AudioBuffer>();
  const clipBuffers = useClipBuffers({
    audioEngine,
    projectId,
    tracks: () => resolvedTracks(),
    onBufferChange: () => setBufferVersion((current) => current + 1),
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
    localSnapshot: localTimelineSnapshot,
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
  audioBufferCache = clipBuffers.audioBufferCache;
  ensureClipBuffer = clipBuffers.ensureClipBuffer;
  uploadToR2 = clipBuffers.uploadToR2;
  clearClipBufferCaches = clipBuffers.clearClipBufferCaches;
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

  const removeMissingMediaClip = async (
    trackId: Track["id"],
    clipId: string,
  ) => {
    const rid = projectId();
    if (!rid) return;
    if (isLocalId("project", rid)) {
      await createLocalTimelineRepository(rid).deleteClip(clipId);
      projection.removeLocalClips([clipId]);
    } else {
      const uid = userId();
      if (!uid) return;
      const result = await convexClient.mutation(
        convexApi.clips.removeMany,
        buildClipRemoveManyMutationInput({ clipIds: [clipId], userId: uid }),
      );
      if (
        !Array.isArray(result?.removedClipIds) ||
        result.removedClipIds.length === 0
      ) return;
      projection.removeLocalClips([clipId]);
    }
    if (selection.selectedClip()?.clipId === clipId) {
      selection.setSelectedClip(null);
    }
    selection.setSelectedClipIds((current) => {
      const next = new Set(current);
      next.delete(clipId);
      return next;
    });
    selection.selectTrackTarget(trackId, {
      clearClipSelection: false,
      clearPrimaryClip: false,
    });
  };

  const pickReplacementAudioFile = async (): Promise<File | null> => {
    const openFilePicker = window.showOpenFilePicker;
    if (openFilePicker) {
      try {
        const [handle] = await openFilePicker({
          multiple: false,
          types: [{ description: "Audio", accept: { "audio/*": [] } }],
        });
        return await handle.getFile();
      } catch {
        return null;
      }
    }

    return await new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "audio/*";
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
  };

  const replaceMissingMediaClip = async (
    trackId: Track["id"],
    clipId: string,
  ) => {
    const rid = projectId();
    if (!rid || !isLocalId("project", rid)) return;
    const track = renderTracks().find((entry) => entry.id === trackId);
    const clip = track?.clips.find((entry) => entry.id === clipId);
    if (!clip) return;
    const file = await pickReplacementAudioFile();
    if (!file) return;
    const decoded = await audioEngine.decodeAudioData(await file.arrayBuffer());
    const source = getAudioSourceMetadata(decoded);
    const asset = await createLocalAsset({
      projectId: rid,
      file,
      metadata: {
        durationSec: source.durationSec,
        sampleRate: source.sampleRate,
        originalFileName: file.name,
        originalLastModified: file.lastModified,
      },
    });
    const sourceKind: Clip["sourceKind"] = "upload";
    const updated = {
      ...clip,
      name: file.name || clip.name,
      buffer: decoded,
      mediaStatus: undefined,
      duration: decoded.duration,
      sourceAssetKey: asset.id,
      sourceKind,
      sourceDurationSec: source.durationSec,
      sourceSampleRate: source.sampleRate,
      sourceChannelCount: source.channelCount,
      sampleUrl: undefined,
    };
    await createLocalTimelineRepository(rid).updateClip({
      clipId,
      name: updated.name,
      duration: updated.duration,
      sourceAssetId: asset.id,
      sourceAssetKey: asset.id,
      sourceKind,
      sourceDurationSec: source.durationSec,
      sourceSampleRate: source.sampleRate,
      sourceChannelCount: source.channelCount,
    });
    audioBufferCache.set(clipId, decoded);
    projection.removeLocalClips([clipId]);
    projection.insertLocalClip(trackId, updated);
  };

  const handleLocalMidiSaved = (clipId: string, midi: Clip["midi"]) => {
    const match = trackLookup().clipEntryById.get(clipId);
    if (!match) return;
    projection.replaceLocalClip(match.trackId, {
      ...match.clip,
      midi,
    });
  };

  const chooseProjectStorageFolder = async () => {
    const rid = projectId();
    const openDirectoryPicker = window.showDirectoryPicker;
    if (!rid || !isLocalId("project", rid) || !openDirectoryPicker) {
      window.alert("Folder storage is not supported in this browser.");
      return;
    }

    try {
      const handle = await openDirectoryPicker();
      await setLocalProjectAssetDirectory(rid, handle);
      setLocalSaveFailure(null);
      window.alert("Project storage folder is ready.");
    } catch {
      window.alert("Project storage folder was not changed.");
    }
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
    ensureClipBuffer,
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

  let openMidiEditorFor = (_clipId: string) => {};
  let stopRecordingSession: () => Promise<void> = async () => {};
  let toggleRecordingSession: () => Promise<unknown> = async () => {};

  const {
    createTimelineTrack,
    handleTransportPause,
    handleTransportStop,
    handleRecordToggle,
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
    insertLocalClip: projection.insertLocalClip,
    selection,
    playheadSec,
    projectId,
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
    onLocalSaveFailed: setLocalSaveFailure,
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
    audioBufferCache,
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
    audioBufferCache,
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
    projectId,
    selection,
  });
  openMidiEditorFor = nextOpenMidiEditorFor;

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
        setLocalSaveFailure(message);
      }
    },
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantClipWrite,
  });

  const {
    recordArmTrackId,
    toggleRecording: nextToggleRecordingSession,
    toggleRecordArm: handleToggleRecordArm,
    reconcileRecordArm,
    stopRecording: nextStopRecordingSession,
    previewPoints,
    previewStartSec,
    recordingTrackId,
  } = recordingControls;
  toggleRecordingSession = nextToggleRecordingSession;
  stopRecordingSession = nextStopRecordingSession;

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

  const onArchiveInput: JSX.EventHandler<HTMLInputElement, Event> = async (e) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (file) {
      try {
        const nextProjectId = await importDawProjectArchive(file);
        navigateToRoom(nextProjectId);
      } catch (error) {
        setLocalSaveFailure(error instanceof Error ? error.message : "Archive import failed.");
      }
    }
    input.value = "";
  };

  const backUpNow = async () => {
    if (!projectId() || !isLocalId("project", projectId())) return;
    const result = await runProjectBackup(projectId());
    if (!result.ok) {
      setLocalSaveFailure(result.conflict
        ? "Cloud backup conflict detected. Use Back up now again after reviewing the cloud project, or restore from backup in a fresh profile."
        : result.error ?? "Cloud backup failed.");
    }
  };

  const exportArchive = async () => {
    if (!isLocalId("project", projectId())) return;
    try {
      const blob = await exportDawProjectArchive(projectId());
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${projectId()}.dawproject`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setLocalSaveFailure(error instanceof Error ? error.message : "Archive export failed.");
    }
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
    clearClipBufferCaches();
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
      <input
        ref={(el) => {
          fileInputRef = el;
        }}
        type="file"
        accept="audio/*"
        class="hidden"
        onChange={onFileInput}
      />
      <input
        ref={(el) => {
          archiveInputRef = el;
        }}
        type="file"
        accept=".dawproject,application/vnd.dawproject,application/zip"
        class="hidden"
        onChange={onArchiveInput}
      />

      <TransportControls
        isPlaying={isPlaying()}
        playheadSec={playheadSec()}
        onPlay={() => requestPlay()}
        onPause={handleTransportPause}
        onStop={handleTransportStop}
        onAddAudio={() => handleAddAudio()}
        tracksMenu={{
          syncMix: syncMix(),
          onToggleSyncMix: toggleSyncMix,
          onAddTrack: addAudioTrack,
          onAddReturnTrack: addReturnTrack,
          onAddGroupTrack: addGroupTrack,
          onAddInstrumentTrack: addInstrumentTrack,
        }}
        onShare={handleShare}
        onMasterFX={() => {
          selection.setSelectedFXTarget("master");
          setBottomFXOpen(true);
        }}
        bpm={bpm()}
        onChangeBpm={(next) => setBpm(clampBpm(next))}
        metronomeEnabled={metronomeEnabled()}
        onToggleMetronome={() => setMetronomeEnabled((prev) => !prev)}
        gridEnabled={gridEnabled()}
        onToggleGrid={() => setGridEnabled((prev) => !prev)}
        gridDenominator={gridDenominator()}
        onChangeGridDenominator={(n: number) => setGridDenominator(n)}
        loopEnabled={loopEnabled()}
        onToggleLoop={() => setLoopEnabled((prev) => !prev)}
        isRecording={isRecording()}
        onToggleRecord={handleRecordToggle}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onJumpToClip={(clipId, trackId, startSec) =>
          jumpToClip(trackId, clipId, startSec)
        }
        onInsertSample={(payload) => {
          void handleInsertSample(payload);
        }}
        currentProjectId={projectId()}
        currentUserId={userId()}
        projects={projects()}
        onOpenProject={(rid) => {
          navigateToRoom(rid);
        }}
        onCreateProject={createProject}
        onDeleteProject={deleteProject}
        onRenameProject={renameProject}
        onOpenExport={() => setExportOpen(true)}
        onChooseProjectFolder={chooseProjectStorageFolder}
        onBackUpNow={backUpNow}
        onExportArchive={exportArchive}
        onImportArchive={() => archiveInputRef?.click()}
      />
      <Show when={localSaveFailure()}>
        {(message) => (
          <div class="border-b border-amber-900/60 bg-amber-950/50 px-4 py-3 text-sm text-amber-100">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div class="font-semibold">Local save needs attention</div>
                <div class="mt-1 text-amber-100/80">
                  {message()} Retry the last action after freeing browser storage,
                  restoring folder permission, or exporting a backup copy.
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void exportArchive()}
                >
                  Export backup
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setLocalSaveFailure(null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>
      <TimelinePanels
        chat={{
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
        }}
        effectsPanel={{
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
        }}
        exportDialog={{
          isOpen: exportOpen(),
          tracks: renderTracks(),
          bpm: bpm(),
          loopEnabled: loopEnabled(),
          loopStartSec: loopStartSec(),
          loopEndSec: loopEndSec(),
          projectId: projectId(),
          userId: userId(),
          ensureClipBuffer,
          onClose: () => setExportOpen(false),
        }}
      />

      <div
        class="flex-1 flex min-h-0"
        ref={(el) => {
          containerRef = el;
        }}
      >
        <div
          class="flex-1 relative overflow-auto timeline-scroll"
          style={{
            "padding-bottom": bottomFXOpen() ? `${FX_OFFSET_PX}px` : "0px",
          }}
          ref={(el) => {
            scrollRef = el;
            setScrollElement(el);
          }}
        >
          <div
            class="relative flex select-none"
            style={{
              width: `${duration() * PPS + sidebarWidth()}px`,
              height: `${RULER_HEIGHT + (renderTracks().length + (dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}px`,
            }}
          >
            <div
              class="relative shrink-0"
              style={{
                width: `${duration() * PPS}px`,
                height: `${RULER_HEIGHT + (renderTracks().length + (dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}px`,
              }}
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

              <div
                class="absolute left-0 right-0"
                style={{
                  top: `${RULER_HEIGHT}px`,
                  height: `${(renderTracks().length + (dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}px`,
                }}
              >
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
                      onRetryMedia={(clipId) => {
                        void ensureClipBuffer(clipId);
                      }}
                      onReplaceMedia={(trackId, clipId) => {
                        void replaceMissingMediaClip(trackId, clipId);
                      }}
                      onRemoveMissingMedia={(trackId, clipId) => {
                        void removeMissingMediaClip(trackId, clipId);
                      }}
                      bpm={bpm()}
                      onClipDblClick={(_, clipId) => {
                        const match = trackLookup().clipEntryById.get(clipId);
                        if (
                          match &&
                          match.trackId === track.id &&
                          match.clip.midi
                        ) {
                          openMidiEditorFor(clipId);
                        }
                      }}
                    />
                  )}
                </For>
                <TimelineOverlays
                  timeline={{
                    tracks: renderTracks(),
                    trackLookup: trackLookup(),
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
                    projectId: projectId(),
                    close: closeMidiEditor,
                    changeBounds: changeMidiCardBounds,
                    auditionNote,
                    startLiveNote,
                    stopLiveNote,
                    onLocalMidiSaved: handleLocalMidiSaved,
                  }}
                />
              </div>
            </div>

            <div
              class="sticky right-0 z-40 flex shrink-0"
              style={{ width: `${sidebarWidth()}px` }}
            >
              <TrackSidebar
                sidebar={{
                  tracks: renderTracks(),
                  selectedTrackId: selection.selectedTrackId(),
                  sidebarWidth: sidebarWidth(),
                  isPlaying: isPlaying(),
                  bottomOffsetPx: bottomFXOpen() ? FX_OFFSET_PX : 0,
                  recordArmTrackId: recordArmTrackId(),
                  currentUserId: userId(),
                  subscribeTrackLevels: (listener) =>
                    audioEngine.subscribeTrackStereoLevels(listener),
                  onTrackClick: (id) => {
                    selection.selectTrackTarget(id, {
                      clearClipSelection: true,
                    });
                  },
                  canWriteTrackRouting: canWriteTrack,
                  onTrackSendsChange: (trackId, sends) => {
                    localMix.persist(trackId, { sends });
                    updateTrackSends(trackId, sends);
                  },
                  onTrackOutputTargetChange: (trackId, outputTargetId) => {
                    localMix.persist(trackId, {
                      outputTargetId: outputTargetId ?? null,
                    });
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
            </div>
          </div>
        </div>
      </div>

      <Dialog open={confirmOpen()} onOpenChange={setConfirmOpen}>
        <DialogContent class="bg-neutral-900 text-neutral-100 border border-neutral-800">
          <DialogHeader>
            <DialogTitle>Delete this track?</DialogTitle>
            <DialogDescription>
              {pendingDeleteTrackClipCount() > 0
                ? `This track contains ${pendingDeleteTrackClipCount()} audio clip${pendingDeleteTrackClipCount() === 1 ? "" : "s"}. Deleting the track will remove them. This action cannot be undone.`
                : "This track has no audio clips. Deleting it cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmOpen(false);
                setPendingDeleteTrackId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const id = pendingDeleteTrackId();
                if (id) performDeleteTrack(id);
                setPendingDeleteTrackId(null);
                setConfirmOpen(false);
              }}
            >
              Delete Track
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cloud-only mode: no browser capability notice needed */}
    </div>
  );
};

export default Timeline;
