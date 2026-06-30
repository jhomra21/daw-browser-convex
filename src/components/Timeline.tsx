import {
  type Accessor,
  type Component,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  untrack,
} from "solid-js";
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import { getAudioEngine } from "~/lib/audio-engine-singleton";
import {
  clampAutomationLaneHeight,
  DEFAULT_AUTOMATION_LANE_HEIGHT,
  timelineDurationSec,
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
import { isLocalId, normalizeCommandTrackIndices } from "@daw-browser/shared";
import { automationTargetKey, type AutomationEnvelope } from "@daw-browser/shared";
import { useTimelineResolvedModel } from "~/hooks/useTimelineResolvedModel";
import { useTimelineActions } from "~/hooks/useTimelineActions";
import { useTimelineSidebarResize } from "~/hooks/useTimelineSidebarResize";
import { useTrackRecording } from "~/hooks/useTrackRecording";
import { buildAutomationEnvelopeHistoryEntry, buildEffectParamsHistoryEntry } from "~/lib/undo/builders";
import type { EffectParamsCommitPayload } from "~/lib/undo/types";
import { useTimelinePreferences } from "~/hooks/useTimelinePreferences";
import { useTimelineMidiOverlay } from "~/hooks/useTimelineMidiOverlay";
import { useTimelineMixerController } from "~/hooks/useTimelineMixerController";
import { useProjectedTimelineModel } from "~/hooks/useProjectedTimelineModel";
import { useTimelineDragDrop } from "~/hooks/useTimelineDragDrop";
import { useTimelineHistory } from "~/hooks/useTimelineHistory";
import { useTimelineIdentity } from "~/hooks/useTimelineIdentity";
import { useTimelineLocalMix } from "~/hooks/useTimelineLocalMix";
import { useTimelineMasterVolume } from "~/hooks/useTimelineMasterVolume";
import { useTimelineProjectMix } from "~/hooks/useTimelineProjectMix";
import { useTimelineProjectionState } from "~/hooks/useTimelineProjectionState";
import { useTimelineSelectionState } from "~/hooks/useTimelineSelectionState";
import { useTimelinePersistenceController } from "~/hooks/useTimelinePersistenceController";
import { useTimelineAudioLifecycle } from "~/hooks/useTimelineAudioLifecycle";
import { useTimelineAudioWarp } from "~/hooks/useTimelineAudioWarp";
import { useTimelineBottomPanelState } from "~/hooks/useTimelineBottomPanelState";
import { useTimelineLeftBrowserResize } from "~/hooks/useTimelineLeftBrowserResize";
import { useTimelineLeftBrowserState } from "~/hooks/useTimelineLeftBrowserState";
import { useTimelineBrowserController } from "~/hooks/useTimelineBrowserController";
import { BrowserDragOverlay } from "./timeline/browser/browser-drag-overlay";
import type { BrowserDragPayload, BrowserDropTarget } from "./timeline/browser/browser-drag-types";
import type { TimelineDeviceInsertActions } from "./timeline/timeline-device-insert-actions";
import { isTimelineSampleDetailClip, useTimelineSampleDetailController } from "~/hooks/useTimelineSampleDetailController";
import { useLocalProjectActions } from "~/hooks/useLocalProjectActions";
import { useProjectSamples } from "~/hooks/useProjectSamples";
import { removeAutoCreatedCloudTrack } from "~/lib/timeline-audio-import";
import TimelineChrome from "./timeline/timeline-chrome";
import AppMessageDialog, { type AppMessageDialogState } from "./timeline/app-message-dialog";
import CloudBackupDialog from "./timeline/cloud-backup-dialog";
import DeleteTrackDialog from "./timeline/delete-track-dialog";
import TimelineWorkspace from "./timeline/timeline-workspace";
import { createPersistedAutomationState } from "./timeline/create-persisted-automation-state";
import { loadLocalAutomationEnvelopes, setLocalAutomationEnvelope, deleteLocalAutomationEnvelope } from "~/lib/local-automation";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import { useProjectPersistedState } from "~/hooks/useProjectPersistedState";
import { Dashboard } from "~/components/dashboard/dashboard";
import type { DashboardTimelineModel, DashboardView } from "~/components/dashboard/types";

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

const replaceAutomationEnvelope = (
  envelopes: AutomationEnvelope[],
  targetKey: string,
  envelope: AutomationEnvelope | undefined,
) => {
  const existingIndex = envelopes.findIndex((entry) => entry.targetKey === targetKey);
  if (!envelope) {
    return existingIndex === -1 ? envelopes : envelopes.filter((entry) => entry.targetKey !== targetKey);
  }
  if (existingIndex !== -1 && envelopes[existingIndex] === envelope) return envelopes;
  const next = existingIndex === -1 ? [...envelopes, envelope] : [...envelopes];
  next[existingIndex === -1 ? next.length - 1 : existingIndex] = envelope;
  return next;
};

const Timeline: Component<TimelineProps> = (props) => {
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [appMessage, setAppMessage] = createSignal<AppMessageDialogState | null>(null);
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<
    Track["id"] | null
  >(null);
  // Transport tempo & metronome
  const [metronomeEnabled, setMetronomeEnabled] = createSignal(false);
  const [exportOpen, setExportOpen] = createSignal(false);
  const [automationEnvelopes, setAutomationEnvelopes] = createSignal<AutomationEnvelope[]>([]);

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
  const bottomPanel = useTimelineBottomPanelState({ projectId });
  const visibleAutomationTracks = useProjectPersistedState<Record<string, boolean>>({
    projectId,
    createInitial: () => ({}),
    load: (rid) => {
      const raw = localStorage.getItem(`timeline:${rid}:automation-visible-tracks`);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        const next: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "boolean") next[key] = value;
        }
        return next;
      } catch {
        return {};
      }
    },
    save: (rid, value) => localStorage.setItem(`timeline:${rid}:automation-visible-tracks`, JSON.stringify(value)),
  });
  const automationLaneHeights = useProjectPersistedState<Record<string, number>>({
    projectId,
    createInitial: () => ({}),
    load: (rid) => {
      const raw = localStorage.getItem(`timeline:${rid}:automation-lane-heights`);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        const next: Record<string, number> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "number" && Number.isFinite(value)) next[key] = clampAutomationLaneHeight(value);
        }
        return next;
      } catch {
        return {};
      }
    },
    save: (rid, value) => localStorage.setItem(`timeline:${rid}:automation-lane-heights`, JSON.stringify(value)),
  });
  const selectedAutomationParameters = useProjectPersistedState<Record<string, string>>({
    projectId,
    createInitial: () => ({}),
    load: (rid) => {
      const raw = localStorage.getItem(`timeline:${rid}:automation-parameters`);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") next[key] = value;
        }
        return next;
      } catch {
        return {};
      }
    },
    save: (rid, value) => localStorage.setItem(`timeline:${rid}:automation-parameters`, JSON.stringify(value)),
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
      isOpen: bottomPanel.open,
      setOpen: bottomPanel.setOpen,
    },
  });
  const clipBuffers = useClipBuffers({
    audioEngine,
    projectId,
    tracks: () => resolvedTracks(),
    onBufferChange: () => setBufferVersion((current) => current + 1),
  });
  const currentLocalProjectMode = createMemo(() => projects().find((project) => project.projectId === projectId())?.mode);
  const canCreateTrack = createMemo(() => {
    if (isLocalId("project", projectId())) return true;
    const role = currentProjectRole();
    return role === "owner" || role === "editor";
  });
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
  const projectMix = useTimelineProjectMix({
    projectId,
    onLocalSaveFailed: localProject.setLocalSaveFailure,
  });
  const masterVolume = useTimelineMasterVolume({
    projectId,
    userId,
    currentProjectRole,
    fullViewData: () => fullView.data,
    audioEngine,
    projectMix,
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
      applyAutomationEnvelope: (envelope, targetKey) =>
        applyAutomationEnvelopeState(envelope, targetKey),
    }),
  });
  const automationTargetKeyAccessor = createMemo(() => {
    const trackId = selection.selectedTrackId();
    if (!trackId) return undefined;
    const parameterId = selectedAutomationParameters.value()[trackId] ?? "volume";
    return automationTargetKey({ kind: "track", trackId }, parameterId);
  });
  const applyAutomationEnvelopeState = (envelope: AutomationEnvelope | undefined, targetKey: string) => {
    setAutomationEnvelopes((current) => {
      const rows = replaceAutomationEnvelope(current, targetKey, envelope);
      audioEngine.cancelAutomationSchedules(new Set([targetKey]), current);
      audioEngine.setAutomationEnvelopes(rows);
      if (isPlaying()) audioEngine.scheduleAutomationFromPlayhead(playheadSec(), { targetKeys: new Set([targetKey]) });
      return rows;
    });
  };
  const applyAutomationRowsToEngine = (
    next: AutomationEnvelope[],
    previous: AutomationEnvelope[],
    changedTargetKeys: ReadonlySet<string>,
  ) => {
    audioEngine.cancelAutomationSchedules(changedTargetKeys.size === 0 ? undefined : changedTargetKeys, previous);
    audioEngine.setAutomationEnvelopes(next);
    if (isPlaying()) {
      audioEngine.scheduleAutomationFromPlayhead(playheadSec(), {
        targetKeys: changedTargetKeys.size === 0 ? undefined : changedTargetKeys,
      });
    }
  };
  const persistedAutomation = createPersistedAutomationState({
    targetKey: automationTargetKeyAccessor,
    envelopes: automationEnvelopes,
    applyToEngine: applyAutomationRowsToEngine,
    persistEnvelope: async (envelope) => {
      const rid = projectId();
      if (!rid) return;
      if (isLocalId("project", rid)) {
        await setLocalAutomationEnvelope(rid, envelope);
        setAutomationEnvelopes((current) => replaceAutomationEnvelope(current, envelope.targetKey, envelope));
        return;
      }
      const uid = userId();
      if (!uid) throw new Error("Cannot persist shared automation without a user id.");
      await publishDurableSharedTimelineOperation({
        projectId: rid,
        userId: uid,
        operation: {
          kind: "automation.setEnvelope",
          payload: {
            targetKind: envelope.target.kind,
            trackId: envelope.target.kind === "track" ? envelope.target.trackId : undefined,
            parameterId: envelope.parameterId,
            enabled: envelope.enabled,
            points: envelope.points,
            updatedAt: envelope.updatedAt,
          },
        },
      });
      setAutomationEnvelopes((current) => replaceAutomationEnvelope(current, envelope.targetKey, envelope));
    },
    deleteEnvelope: async (targetKey) => {
      const rid = projectId();
      if (!rid) return;
      const envelope = automationEnvelopes().find((entry) => entry.targetKey === targetKey);
      if (isLocalId("project", rid)) {
        await deleteLocalAutomationEnvelope(rid, targetKey);
        setAutomationEnvelopes((current) => replaceAutomationEnvelope(current, targetKey, undefined));
        return;
      }
      if (!envelope) return;
      const uid = userId();
      if (!uid) throw new Error("Cannot persist shared automation without a user id.");
      await publishDurableSharedTimelineOperation({
        projectId: rid,
        userId: uid,
        operation: {
          kind: "automation.deleteEnvelope",
          payload: {
            targetKind: envelope.target.kind,
            trackId: envelope.target.kind === "track" ? envelope.target.trackId : undefined,
            parameterId: envelope.parameterId,
          },
        },
      });
      setAutomationEnvelopes((current) => replaceAutomationEnvelope(current, targetKey, undefined));
    },
    onEnvelopeCommitted: (previous, next) => {
      const rid = projectId();
      if (!rid) return;
      pushHistory(buildAutomationEnvelopeHistoryEntry({
        projectId: rid,
        before: previous ?? null,
        after: next ?? null,
      }), `automation:${next?.targetKey ?? previous?.targetKey ?? "unknown"}`, 0);
    },
  });

  createEffect(() => {
    const rid = projectId();
    if (!rid) {
      setAutomationEnvelopes([]);
      audioEngine.setAutomationEnvelopes([]);
      return;
    }
    if (isLocalId("project", rid)) {
      void loadLocalAutomationEnvelopes(rid).then((rows) => {
        if (projectId() !== rid) return;
        setAutomationEnvelopes(rows);
        untrack(persistedAutomation.syncRemote);
      }).catch(() => {
        if (projectId() !== rid) return;
        setAutomationEnvelopes([]);
        untrack(persistedAutomation.syncRemote);
      });
      return;
    }
    const rows = fullView.data?.automationEnvelopes ?? [];
    const next: AutomationEnvelope[] = [];
    for (const row of rows) {
      if (row.targetKind === "master") {
        next.push({
          id: row._id,
          projectId: row.projectId,
          target: { kind: "master" },
          targetKey: row.targetKey,
          parameterId: row.parameterId,
          enabled: row.enabled,
          points: row.points,
          updatedAt: row.updatedAt,
        });
        continue;
      }
      if (!row.trackId) continue;
      next.push({
        id: row._id,
        projectId: row.projectId,
        target: { kind: "track", trackId: row.trackId },
        targetKey: row.targetKey,
        parameterId: row.parameterId,
        enabled: row.enabled,
        points: row.points,
        updatedAt: row.updatedAt,
      });
    }
    setAutomationEnvelopes(next);
    untrack(persistedAutomation.syncRemote);
  });
  const automationEnvelopesByTargetKey = createMemo(() => (
    new Map(persistedAutomation.envelopes().map((envelope) => [envelope.targetKey, envelope]))
  ));
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
  const sampleDetail = useTimelineSampleDetailController({
    projectId,
    userId,
    mode: bottomPanel.mode,
    setMode: bottomPanel.setMode,
    setOpen: bottomPanel.setOpen,
    trackLookup,
    selection,
    canWriteClip,
    projection,
    audioWarpController,
    rescheduleChangedClips,
    pushHistory,
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
  let effectsChainElement: HTMLElement | undefined;

  const leftBrowser = useTimelineLeftBrowserState({
    projectId,
    rightSidebarWidthPx: sidebarWidth,
    getContainerElement: () => containerRef,
  });
  const leftBrowserResize = useTimelineLeftBrowserResize({
    widthPx: leftBrowser.widthPx,
    previewWidthPx: leftBrowser.previewWidthPx,
    commitWidthPx: leftBrowser.commitWidthPx,
    getContainerElement: () => containerRef,
    rightSidebarWidthPx: sidebarWidth,
  });
  const [deviceInsertActions, setDeviceInsertActions] = createSignal<TimelineDeviceInsertActions>();

  createEffect(() => {
    sidebarWidth();
    leftBrowser.clampWidthToLayout();
  });

  const {
    midiEditorClipId,
    midiCard,
    closeMidiEditor,
    openMidiEditorFor,
    changeMidiCardBounds,
    auditionNote,
    midiKeyboard,
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
    onToggleBrowser: leftBrowser.toggleOpen,
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
    bottomPanel.setMode("effects");
    onLanePointerDown(event, scrollRef);
  };

  const onRulerPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    startScrub(event.clientX);
  };

  const onFileInput: JSX.EventHandler<HTMLInputElement, Event> = async (e) => {
    const input = e.currentTarget;
    await handleFiles(input.files);
    input.value = "";
  };

  const duration = () => timelineDurationSec(renderTracks());
  const dashboardSamplesEnabled = () => props.dashboardView() === "samples";
  const dashboardSamples = useProjectSamples({
    projectId,
    userId,
    enabled: dashboardSamplesEnabled,
    includeFilePath: () => true,
  });
  const openEffectsForTarget = (
    targetId: Track["id"] | "master",
    options?: { preserveClipSelection?: boolean },
  ) => {
    if (targetId === "master") selection.selectMasterTarget();
    else selection.selectTrackTarget(targetId, { clearClipSelection: !options?.preserveClipSelection });
    bottomPanel.setMode("effects");
    bottomPanel.setOpen(true);
  };
  const handleBrowserDeviceDrop = async (
    payload: BrowserDragPayload,
    target: BrowserDropTarget,
  ) => {
    const actions = deviceInsertActions();
    if (!actions) return;
    if (payload.kind === "audio-effect" && target.kind === "effect-chain") {
      if (!await actions.addAudioEffectToTarget(target.targetId, payload.effect, target.index)) return;
      openEffectsForTarget(target.targetId);
      return;
    }
    if (payload.kind === "audio-effect" && target.kind === "track") {
      if (!await actions.addAudioEffectToTarget(target.trackId, payload.effect)) return;
      openEffectsForTarget(target.trackId);
      return;
    }
    if (payload.kind === "audio-effect" && target.kind === "new-track") {
      const track = await createTimelineTrack();
      if (!track) return;
      if (!await actions.addAudioEffectToTarget(track.id, payload.effect)) return;
      openEffectsForTarget(track.id);
      return;
    }
    if (payload.kind === "midi-effect" && target.kind === "track") {
      if (!await actions.addArpeggiatorToTarget(target.trackId)) return;
      openEffectsForTarget(target.trackId);
      return;
    }
    if (payload.kind === "midi-effect" && target.kind === "new-track") {
      const track = await createTimelineTrack({ kind: "instrument" });
      if (!track) return;
      if (!await actions.addArpeggiatorToTarget(track.id)) return;
      openEffectsForTarget(track.id);
      return;
    }
    if (payload.kind === "midi-instrument" && target.kind === "track") {
      if (!actions.switchInstrumentForTarget(target.trackId, payload.instrument)) return;
      if (!await actions.addMidiClipToTarget(target.trackId)) return;
      openEffectsForTarget(target.trackId, { preserveClipSelection: true });
      if (payload.instrument === "synth") actions.openSynthForTarget(target.trackId);
      return;
    }
    if (payload.kind === "midi-instrument" && target.kind === "new-track") {
      const track = await createTimelineTrack({ kind: "instrument" });
      if (!track) return;
      if (!actions.switchInstrumentForTarget(track.id, payload.instrument)) return;
      if (!await actions.addMidiClipToTarget(track.id)) return;
      openEffectsForTarget(track.id, { preserveClipSelection: true });
      if (payload.instrument === "synth") actions.openSynthForTarget(track.id);
    }
  };
  const timelineBrowser = useTimelineBrowserController({
    projectId,
    userId,
    leftBrowser,
    onResizePointerDown: leftBrowserResize.onPointerDown,
    deviceInsertActions,
    canCreateTrack,
    tracks: () => renderTracks(),
    scrollElement: () => scrollRef,
    effectsChainElement: () => effectsChainElement,
    currentEffectsTargetId: () => selection.selectedFXTarget(),
    handleInsertSample,
    onDeviceDrop: handleBrowserDeviceDrop,
  });
  const browserDropTargetLane = createMemo(() => {
    const target = timelineBrowser().devices.dragSession()?.target;
    if (target?.kind !== "track") return null;
    return target.laneIndex;
  });
  const browserDropAtNewTrack = createMemo(() => timelineBrowser().devices.dragSession()?.target.kind === "new-track");
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
    browser: {
      open: leftBrowser.open(),
      onOpen: () => leftBrowser.setOpen(true),
      onToggle: leftBrowser.toggleOpen,
      onSelectTab: leftBrowser.setActiveTab,
    },
    midiKeyboard,
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
    onDeleteSelection: handleKeyboardAction,
    onDuplicateSelection: () => {
      void duplicateSelectedClips();
    },
    onJumpToClip: (clipId: string, trackId: string, startSec: number) => jumpToClip(trackId, clipId, startSec),
    onInsertSample: (payload: Parameters<typeof handleInsertSample>[0]) => {
      void handleInsertSample(payload);
    },
  });

  const dashboardTimelineModel = createMemo<DashboardTimelineModel>(() => ({
    projectMenu: transportProps().projectMenu,
    samples: dashboardSamples.samples,
    refreshSamples: dashboardSamples.refreshSamples,
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
  }));

  const panelsProps = () => ({
    chat: {
      bottomOffsetPx: bottomPanel.chatBottomOffsetPx(),
      agentPanelOpen: bottomPanel.agentPanelOpen(),
      sharedChatOpen: bottomPanel.sharedChatOpen(),
      projectId: projectId(),
      userId: userId(),
      bpm: bpm(),
      toggleAgentPanel: bottomPanel.toggleAgentPanel,
      toggleSharedChat: bottomPanel.toggleSharedChat,
      closeAgentPanel: bottomPanel.closeAgentPanel,
      closeSharedChat: bottomPanel.closeSharedChat,
      applyAgentMixOps,
    },
    effectsPanel: {
      isOpen: bottomPanel.open() && bottomPanel.mode() === "effects",
      showOpenButton: bottomPanel.mode() === "effects",
      shell: {
        heightPx: bottomPanel.heightPx(),
        onHeightPreview: bottomPanel.previewHeightPx,
        onHeightCommit: bottomPanel.commitHeightPx,
      },
      clipTab: {
        canOpen: Boolean(sampleDetail.selectedClip()),
        onOpen: () => {
          if (!sampleDetail.selectedClip()) return;
          bottomPanel.setMode("sample-detail");
          bottomPanel.setOpen(true);
        },
      },
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
      onClose: () => bottomPanel.setOpen(false),
      onOpen: () => {
        bottomPanel.setMode("effects");
        bottomPanel.setOpen(true);
      },
      onEffectParamsCommitted: pushEffectParamsHistory,
      onLocalSaveFailed: localProject.setLocalSaveFailure,
      onDeviceInsertActionsChange: setDeviceInsertActions,
      automationEnvelopes: persistedAutomation.envelopes(),
      onEffectChainElementChange: (element: HTMLElement | undefined) => {
        effectsChainElement = element;
      },
    },
    sampleDetailPanel: {
      isOpen: bottomPanel.open() && bottomPanel.mode() === "sample-detail",
      selectedClip: sampleDetail.selectedClip(),
      projectBpm: bpm(),
      audioEngine,
      bpmDetection: audioWarpController.bpmDetection,
      ensureClipBuffer: clipBuffers.preload,
      canWriteClip,
      onChange: sampleDetail.changeWarp,
      onGainChange: sampleDetail.changeGain,
      onMarkerDragStateChange: sampleDetail.setMarkerDragging,
      shell: {
        heightPx: bottomPanel.heightPx(),
        onHeightPreview: bottomPanel.previewHeightPx,
        onHeightCommit: bottomPanel.commitHeightPx,
      },
      onClose: sampleDetail.close,
      onHide: () => {
        bottomPanel.setMode("effects");
        bottomPanel.setOpen(false);
      },
    },
    exportDialog: {
      isOpen: exportOpen(),
      tracks: renderTracks(),
      getTracks: () => renderTracks(),
      selectedTrackId: selection.selectedTrackId() || undefined,
      bpm: bpm(),
      masterVolume: masterVolume.volume(),
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
          model={dashboardTimelineModel()}
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
        bottomPanelOffsetPx={bottomPanel.bottomPanelOffsetPx()}
        leftBrowser={timelineBrowser()}
        durationSec={duration()}
        sidebarWidth={sidebarWidth()}
        tracks={renderTracks()}
        dropAtNewTrack={dropAtNewTrack() || browserDropAtNewTrack()}
        dropTargetLane={browserDropTargetLane() ?? dropTargetLane()}
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
          if (!match || !isTimelineSampleDetailClip(match.clip)) return;
          const selectedClip = selection.selectedClip();
          if (
            selectedClip?.clipId === clipId &&
            selectedClip.trackId === match.trackId &&
            bottomPanel.open() &&
            bottomPanel.mode() === "sample-detail"
          ) return;
          selection.selectPrimaryClip({ trackId: match.trackId, clipId });
          bottomPanel.setMode("sample-detail");
          bottomPanel.setOpen(true);
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
          keyboard: {
            isActive: midiKeyboard.isActive,
          },
          onLocalMidiSaved: handleLocalMidiSaved,
        }}
        sidebar={{
          currentUserId: userId(),
          master: {
            selected: selection.selectedFXTarget() === "master",
            ready: masterVolume.ready(),
            canEditVolume: masterVolume.canEdit(),
            volume: masterVolume.volume(),
            onClick: () => {
              bottomPanel.setMode("effects");
              bottomPanel.setOpen(true);
              selection.selectMasterTarget();
            },
            onVolumePreview: masterVolume.previewVolume,
            onVolumeChange: (volume) => {
              masterVolume.commitVolume(volume);
            },
          },
          subscribeTrackLevels: (listener) =>
            audioEngine.subscribeTrackStereoLevels(listener),
          onTrackClick: (id) => {
            bottomPanel.setMode("effects");
            bottomPanel.setOpen(true);
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
        automation={{
          projectId: projectId(),
          visibleByTrackId: visibleAutomationTracks.value(),
          onToggleTrackVisibility: (trackId) => {
            visibleAutomationTracks.setValue((current) => ({ ...current, [trackId]: !current[trackId] }));
          },
          laneHeightsByTrackId: automationLaneHeights.value(),
          onResizeTrackLane: (trackId, height) => {
            const nextHeight = clampAutomationLaneHeight(height || DEFAULT_AUTOMATION_LANE_HEIGHT);
            automationLaneHeights.setValue((current) => (
              current[trackId] === nextHeight ? current : { ...current, [trackId]: nextHeight }
            ));
          },
          selectedParametersByTargetKey: selectedAutomationParameters.value(),
          onSelectParameter: (targetKey, parameterId) => {
            selectedAutomationParameters.setValue((current) => (
              current[targetKey] === parameterId ? current : { ...current, [targetKey]: parameterId }
            ));
          },
          envelopesByTargetKey: automationEnvelopesByTargetKey(),
          onPreviewEnvelope: persistedAutomation.previewEnvelope,
          onCommitEnvelope: (envelope, targetKey) => {
            void persistedAutomation.commitEnvelope(envelope, targetKey);
          },
          onCancelPreview: persistedAutomation.cancelPreview,
        }}
      />

      <BrowserDragOverlay session={timelineBrowser().devices.dragSession} />

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
