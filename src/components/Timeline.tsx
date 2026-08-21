import {
  type Accessor,
  type Component,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import type {
  Clip,
  ExternalSidechainRoute,
  Track,
} from "@daw-browser/timeline-core/types";
import type { ExternalProcessor } from "@daw-browser/external-plugins";
import { clipFadesEqual, type ClipFades } from "@daw-browser/timeline-core/clip-fades";
import { getAudioEngine } from "~/lib/audio-engine-singleton";
import { TIMELINE_HEADER_HEIGHT, timelineDurationSec } from "~/lib/timeline-utils";
import { useTimelineViewport } from "~/hooks/useTimelineViewport";
import { useTimelineKeyboard } from "~/hooks/useTimelineKeyboard";
import { useNavigate } from "@tanstack/solid-router";
import { useTimelineClipImport } from "~/hooks/useTimelineClipImport";
import { useTimelineClipActions } from "~/hooks/useTimelineClipActions";
import { convexClient, convexApi } from "~/lib/convex";
import { useTimelineData } from "~/hooks/useTimelineData";
import { usePlayheadControls } from "~/hooks/usePlayheadControls";
import type { TimelinePlaybackRebuildIntent } from "~/hooks/useTimelinePlayback";
import { useClipDrag } from "~/hooks/useClipDrag";
import { useClipResize } from "~/hooks/useClipResize";
import { useTimelineSelection } from "~/hooks/useTimelineSelection";
import { useClipBuffers } from "~/hooks/useClipBuffers";
import {
  collectTrackDescendantIds,
  isLocalId,
  automationTargetKey,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
import { useTimelineResolvedModel } from "~/hooks/useTimelineResolvedModel";
import { useTimelineActions } from "~/hooks/useTimelineActions";
import { useTimelineSidebarResize } from "~/hooks/useTimelineSidebarResize";
import { useTrackRecording } from "~/hooks/useTrackRecording";
import { useMidiTrackRecording } from "~/hooks/useMidiTrackRecording";
import { runTimelineMutationAfterRecordingSettlement } from "~/lib/midi/recording-mutation-guard";
import { buildClipFadesHistoryEntry, buildEffectParamsHistoryEntry } from "~/lib/undo/builders";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import { encodeNativeBuiltInStateCommit, mapNativeBuiltInParameterCommit } from "~/lib/desktop/native-built-in-parameter-mapper";
import type { EffectsPanelAudioEffects, EffectsPanelExportSnapshot } from "~/components/timeline/create-effects-panel-controller";
import { useTimelinePreferences } from "~/hooks/useTimelinePreferences";
import { useTimelineMidiOverlay } from "~/hooks/useTimelineMidiOverlay";
import { useTimelineMixerController } from "~/hooks/useTimelineMixerController";
import { useProjectedTimelineModel } from "~/hooks/useProjectedTimelineModel";
import { useTimelineDragDrop } from "~/hooks/useTimelineDragDrop";
import {
  useTimelineHistory,
  type TimelineHistoryActions,
} from "~/hooks/useTimelineHistory";
import { useTimelineIdentity } from "~/hooks/useTimelineIdentity";
import { useTimelineLocalMix } from "~/hooks/useTimelineLocalMix";
import { useTimelineMasterVolume } from "~/hooks/useTimelineMasterVolume";
import { useTimelineProjectMix } from "~/hooks/useTimelineProjectMix";
import { authClient } from "~/lib/auth-client";
import { queryClient } from "~/lib/query-client";
import { useDesktopApplicationMenu } from "~/hooks/useDesktopApplicationMenu";
import { useTimelineProjectionState } from "~/hooks/useTimelineProjectionState";
import { useTimelineSelectionState } from "~/hooks/useTimelineSelectionState";
import { useTimelinePersistenceController } from "~/hooks/useTimelinePersistenceController";
import { useTimelineAudioLifecycle } from "~/hooks/useTimelineAudioLifecycle";
import { useTimelineAudioWarp } from "~/hooks/useTimelineAudioWarp";
import { useTimelineBottomPanelState } from "~/hooks/useTimelineBottomPanelState";
import { useTimelineLeftBrowserResize } from "~/hooks/useTimelineLeftBrowserResize";
import { useTimelineLeftBrowserState } from "~/hooks/useTimelineLeftBrowserState";
import { useTimelineBrowserController } from "~/hooks/useTimelineBrowserController";
import { useTimelineAutomationController } from "~/hooks/useTimelineAutomationController";
import { BrowserDragOverlay } from "./timeline/browser/browser-drag-overlay";
import {
  browserDropTargetTrackId as getBrowserDropTargetTrackId,
  type BrowserDragPayload,
  type BrowserDropTarget,
} from "./timeline/browser/browser-drag-types";
import type { TimelineDeviceInsertActions } from "./timeline/timeline-device-insert-actions";
import type { AudioEffectChainPreset } from "~/lib/audio-effect-chain-presets";
import type { InstrumentPreset } from "~/lib/instrument-presets";
import {
  isTimelineSampleDetailClip,
  useTimelineSampleDetailController,
} from "~/hooks/useTimelineSampleDetailController";
import { useLocalProjectActions } from "~/hooks/useLocalProjectActions";
import { useProjectSamples } from "~/hooks/useProjectSamples";
import { removeAutoCreatedCloudTrack } from "~/lib/timeline-audio-import";
import {
  canUseVst3CatalogAction,
  classifyNativeVst3PlaybackFault,
  hasVst3TrustAcknowledgement,
  saveVst3TrustAcknowledgement,
  vst3TrustDisclosure,
} from "~/lib/external-plugin-ui";
import { listLocalExternalProcessors } from "~/lib/external-plugins";
import { compileNativeExternalAttachmentPlan } from "~/lib/desktop/native-external-attachment-plan";
import TimelineChrome from "./timeline/timeline-chrome";
import AppMessageDialog, {
  type AppMessageDialogState,
} from "./timeline/app-message-dialog";
import CloudBackupDialog from "./timeline/cloud-backup-dialog";
import DeleteTrackDialog from "./timeline/delete-track-dialog";
import TimelineWorkspace from "./timeline/timeline-workspace";
import { Dashboard } from "~/components/dashboard/dashboard";
import type {
  DashboardTimelineModel,
  DashboardView,
} from "~/components/dashboard/types";
import {
  buildTimelineTrackLayout,
  buildTrackTree,
  computeDepthMap,
  flattenVisibleTracks,
} from "~/lib/timeline-track-layout";
import { useAppPreferences } from "~/context/app-preferences";
import { deriveSelectedExportTrackIds } from "~/lib/export/export-settings";
import { createTimelineClipWriteAdapter } from "~/lib/timeline-clip-write-adapter";
import { applyCreatedTrackInsertion } from "~/lib/timeline-track-creation-rollback";
import { createAttachedHostController, registerAttachedHostController } from "~/lib/desktop/attached-host-controller";
import { createNativeVstParameterQueue } from "~/lib/desktop/native-vst-parameter-queue";
import { createVstParameterFeedbackController } from "~/lib/desktop/vst-parameter-feedback-controller";
import { createExportQueue } from "~/lib/export/export-queue";
import { createTimelineExportService } from "~/lib/export/timeline-export-service";
import { createExportRenderStateSnapshot, type ExportAutomationPatch } from "~/lib/export/run-export-job";
import { createDesktopNativeOfflineRenderer } from "~/lib/export/desktop-native-offline-renderer";
import { compileLivePlaybackSnapshot, type LivePlaybackCompileContext, type LivePlaybackTransport } from "~/lib/live-playback-snapshot";
import { withInstrumentOverride } from "~/lib/export/export-effect-rows";
import { createTimelineExtensionHost } from "~/lib/extensions";

type TimelineProps = {
  bootstrapIfEmpty: boolean;
  dashboardEnabled: boolean;
  dashboardView: Accessor<DashboardView | null>;
  setDashboardParam: (view: DashboardView | null) => void;
};

const Timeline: Component<TimelineProps> = (props) => {
  // Electron audio is native-only; browser Web Audio is never a desktop fallback.
  const requiresNativeAudio = import.meta.env.VITE_DESKTOP === 'true';
  const navigate = useNavigate();
  const exportQueue = createExportQueue();
  onCleanup(exportQueue.dispose);
  const nativeOfflineBridge = requiresNativeAudio
    ? window.dawDesktop?.audioHost?.offlineRender
    : undefined;
  const nativeOfflineRenderer = nativeOfflineBridge
    ? createDesktopNativeOfflineRenderer(nativeOfflineBridge)
    : undefined;
  const nativeVstParameterQueue = window.dawDesktop
    ? createNativeVstParameterQueue(async (bytes) => {
        const queue = window.dawDesktop?.audioHost?.session.queueVstParameterEvents;
        if (!queue) return { ok: false, error: "Native VST parameter delivery is unavailable." };
        return queue(bytes);
      })
    : undefined;
  onCleanup(() => nativeVstParameterQueue?.dispose());
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [appMessage, setAppMessage] =
    createSignal<AppMessageDialogState | null>(null);
  const vst3TrustStorage = (() => {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  })();
  const [vst3TrustAcknowledged, setVst3TrustAcknowledged] = createSignal(
    hasVst3TrustAcknowledgement(vst3TrustStorage),
  );
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<
    Track["id"] | null
  >(null);
  const [activeMidiRecordingTargetId, setActiveMidiRecordingTargetId] =
    createSignal<string | null>(null);
  const [provisionalMidiClipId, setProvisionalMidiClipId] =
    createSignal<string | null>(null);
  type RecordingStopOwner = {
    stop: () => Promise<void>;
    activeTrackId: () => string | null;
  };
  const recordingStopRef: RecordingStopOwner = { stop: async () => {}, activeTrackId: () => null };
  const [masterCollapsed, setMasterCollapsed] = createSignal(true);
  // Transport tempo & metronome
  const [metronomeEnabled, setMetronomeEnabled] = createSignal(false);
  const [exportOpen, setExportOpen] = createSignal(false);
  type ExternalProcessorEditorRequest = {
    instanceId: string;
    projectId: string | undefined;
    projectGeneration: number;
    requestToken: number;
    ready: boolean;
  };
  const [pendingExternalProcessorEditorRequest, setPendingExternalProcessorEditorRequest] =
    createSignal<ExternalProcessorEditorRequest>();
  let externalProcessorEditorRequestToken = 0;
  // Audio engine
  const audioEngine = getAudioEngine();
  const appPreferences = useAppPreferences();
  // Collaboration: projectId from ?projectId=; ownership tied to Better Auth userId
  const notify = (title: string, message: string) => {
    setAppMessage({ title, message });
  };

  const {
    projectId,
    mountedProjectGeneration,
    setProjectId,
    userId,
    projects,
    currentProjectRole,
    fullView,
    navigateToRoom,
    setProjectTransitionSettlement,
    createProject,
    renameProject,
    deleteProject,
  } = useTimelineData({
    notify,
    bootstrapIfEmpty: untrack(() => props.bootstrapIfEmpty),
  });
  const localProject = useLocalProjectActions({
    projectId,
    userId,
    navigateToRoom,
  });
  const bottomPanel = useTimelineBottomPanelState({ projectId });
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
    pixelsPerSecond,
    previewPixelsPerSecond,
    commitPixelsPerSecond,
  } = useTimelinePreferences({
    projectId,
    onLocalSaveFailed: localProject.setLocalSaveFailure,
    cloudTimelineSettings: () => fullView.data?.project,
    onCloudTimelineSettingsChange: (targetProjectId, settings) => {
      void convexClient.mutation(convexApi.projects.setTimelineSettings, {
        projectId: targetProjectId,
        ...settings,
      }).catch(() => {
        notify("Project settings update failed", "This project setting could not be saved.")
      })
    },
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
  const [renderTracks, setRenderTracks] = createSignal<Track[]>([]);
  const [bufferVersion, setBufferVersion] = createSignal(0);
  const selection = useTimelineSelectionState({
    projectId,
    tracks: renderTracks,
    effectsPanel: {
      isOpen: bottomPanel.open,
      setOpen: bottomPanel.setOpen,
    },
  });
  const clipBuffers = useClipBuffers({
    audioEngine,
    projectId,
    tracks: renderTracks,
    onBufferChange: () => setBufferVersion((current) => current + 1),
  });
  const currentLocalProjectMode = createMemo(
    () => projects().find((project) => project.projectId === projectId())?.mode,
  );
  const canCreateTrack = createMemo(() => {
    if (isLocalId("project", projectId())) return true;
    const role = currentProjectRole();
    return role === "owner" || role === "editor";
  });
  const {
    mediaRecovery,
    reconcileMountedLocalTimeline,
  } = useTimelinePersistenceController({
    projectId,
    mountedProjectGeneration,
    remoteTimelineAvailable: () => Boolean(fullView.data),
    localProjectMode: currentLocalProjectMode,
    userId,
    renderTracks,
    audioEngine,
    audioBufferCache: clipBuffers.writer,
    localProject,
    projection,
    selection,
  });
  const sidechainRoutes = createMemo<ExternalSidechainRoute[]>(() => {
    const id = projectId();
    if (id && isLocalId("project", id))
      return mediaRecovery.localTimelineSnapshot()?.sidechainRoutes ?? [];
    return (fullView.data?.sidechainRoutes ?? []).map((route) => ({
      sourceTrackId: String(route.sourceTrackId),
      targetTrackId: String(route.targetTrackId),
      effectInstanceId: route.effectInstanceId,
    }));
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
  const [effectsExportSnapshot, setEffectsExportSnapshot] =
    createSignal<EffectsPanelExportSnapshot>();
  let getAutomationPatches: () => ExportAutomationPatch[] = () => [];
  let nativePlaybackRevision = 1;
  const compilePlaybackSnapshot = async (
    transport: LivePlaybackTransport,
    context?: LivePlaybackCompileContext,
  ) => {
    const effects = effectsExportSnapshot();
    await effects?.flushPending();
    const effectsProjection = effects?.snapshotEffectsProjection();
    const projectedEffects = context?.instrumentOverride
      ? withInstrumentOverride(effectsProjection ?? { replaceAudioEffectTargets: [], upsertDeviceRows: [] }, context.instrumentOverride.targetId, context.instrumentOverride.instrument)
      : effectsProjection;
    const renderState = await createExportRenderStateSnapshot({
      projectId: projectId(),
      userId: userId(),
      masterVolume: masterVolume.volume(),
      externalPluginPolicy: "native-playback",
      cloudRows: fullView.data
        ? {
            effects: fullView.data.effects,
            automationEnvelopes: fullView.data.automationEnvelopes,
          }
        : undefined,
      effectsProjection: projectedEffects,
      automationPatches: getAutomationPatches(),
    });
    const hydratedRenderState = effects?.hydrateInstrumentBuffers?.(renderState) ?? renderState;
    const result = compileLivePlaybackSnapshot({
      revision: nativePlaybackRevision,
      bpm: bpm(),
      timeSignature: {
        numerator: fullView.data?.project.timeSignatureNumerator ?? 4,
        denominator: fullView.data?.project.timeSignatureDenominator ?? 4,
      },
      transport,
      tracks: renderTracks(),
      renderState: hydratedRenderState,
      sidechainRoutes: effects?.snapshotSidechainRoutes() ?? sidechainRoutes(),
    });
    if (!result.supported || !isLocalId("project", projectId())) return result;
    const processors = (await listLocalExternalProcessors(projectId()))
      .filter((processor) => !processor.bypassed && processor.health.state !== "degraded");
    if (processors.length === 0) return result;
    const attachmentPlan = compileNativeExternalAttachmentPlan({
      target: "native",
      graph: result.snapshot.mixer.graph,
      processors,
      workerTransport: {
        slotCount: 2,
        maximumFrames: 8_192,
        maximumEventsPerBlock: 128,
      },
    });
    if (!attachmentPlan.supported) {
      return {
        supported: true as const,
        snapshot: {
          ...result.snapshot,
          requiresNativePlayback: true,
        },
      };
    }
    return {
      supported: true as const,
      snapshot: {
        ...result.snapshot,
        nativeExternalAttachmentPlan: attachmentPlan.plan,
        requiresNativePlayback: true,
      },
    };
  };
  const exportService = createTimelineExportService({
    queue: exportQueue,
    nativeRendererRequired: requiresNativeAudio,
    nativeOfflineRenderer,
    getNativeOfflineExternalAttachments: async ({ projectId: capturedProjectId, localProject, tracks, renderState, bpm, timeSignature, sidechainRoutes }) => {
      if (!capturedProjectId || !localProject) return undefined
      const processors = (await listLocalExternalProcessors(capturedProjectId))
        .filter((processor) => !processor.bypassed)
      if (processors.length === 0) return undefined
      const playback = compileLivePlaybackSnapshot({
        revision: 1,
        bpm,
        timeSignature,
        transport: {
          state: "stopped",
          playheadSec: 0,
          loopEnabled: false,
          loopStartSec: 0,
          loopEndSec: 0,
        },
        tracks,
        renderState,
        sidechainRoutes,
      })
      if (!playback.supported) throw new Error(playback.reasons.join(" "))
      const attachmentPlan = compileNativeExternalAttachmentPlan({
        target: "native",
        graph: playback.snapshot.mixer.graph,
        processors,
        workerTransport: {
          slotCount: 2,
          maximumFrames: 8_192,
          maximumEventsPerBlock: 128,
        },
      })
      if (!attachmentPlan.supported) throw new Error(attachmentPlan.reasons.join(" "))
      const capturedVstStates = await Promise.all(attachmentPlan.plan.attachments
        .filter((attachment) => !attachment.bypassed)
        .map(async (attachment) => {
          const result = await window.dawDesktop?.audioHost?.session.captureVstState(attachment.instanceId)
          return result?.ok ? {
            instanceId: attachment.instanceId,
            bytes: result.bytes,
            sha256: result.sha256,
          } : undefined
        }))
      return {
        plan: attachmentPlan.plan,
        capturedVstStates: capturedVstStates.filter((state): state is NonNullable<typeof state> => state !== undefined),
      }
    },
    getTracks: renderTracks,
    getBpm: bpm,
    getTimeSignature: () => ({
      numerator: fullView.data?.project.timeSignatureNumerator ?? 4,
      denominator: fullView.data?.project.timeSignatureDenominator ?? 4,
    }),
    getMasterVolume: () => masterVolume.volume(),
    getProjectId: projectId,
    getUserId: userId,
    getCloudRenderRows: () => {
      const data = fullView.data;
      return data
        ? {
            effects: data.effects,
            automationEnvelopes: data.automationEnvelopes,
          }
        : undefined;
    },
    getAutomationPatches: () => getAutomationPatches(),
    getEffectsExportSnapshot: effectsExportSnapshot,
    getSidechainRoutes: sidechainRoutes,
    loadCapturedClipBuffer: clipBuffers.loadCapturedMedia,
  });
  const [replayEffectInstanceParams, setReplayEffectInstanceParams] =
    createSignal<EffectsPanelAudioEffects["replayInstanceParams"]>();
  let historyActions: TimelineHistoryActions | undefined = undefined;
  const { pushHistory, handleUndo, handleRedo } = useTimelineHistory({
    projectId,
    userId,
    getTracks: renderTracks,
    convexClient,
    convexApi,
    audioEngine,
    replayInstanceEffectParams: (payload) =>
      replayEffectInstanceParams()?.(payload) ?? false,
    ensureClipBuffer: clipBuffers.preload,
    grantTrackWrite,
    grantClipWrite,
    persistLocalMix: (_projectId, trackId, patch) =>
      localMix.persist(trackId, patch),
    getActions: () => {
      const actions = historyActions;
      if (!actions)
        throw new Error("Timeline history actions are not initialized.");
      return actions;
    },
  });

  // Playback & playhead controls
  const {
    isPlaying,
    isStructuralRebuildInProgress,
    isPreparingPlayback,
    isNativePlaybackPrepared,
    isPortableBrowserPlaybackPrepared,
    liveProcessorControl,
    reenableProcessorAutomation,
    queueLiveProcessorParameters,
    queueNativeBuiltInStatePatch,
    usesLegacyAudioEngine,
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
    restartTimelineSchedule,
    portableRecording,
    nativeRecording,
    nativeLiveMidi,
    subscribeTrackLevels,
    subscribeMasterLevels,
    subscribeSpectrum,
  } = usePlayheadControls({
    audioEngine,
    requiresNativeAudio,
    tracks: renderTracks,
    ensureClipBuffer: clipBuffers.preload,
    loopEnabled,
    loopStartSec,
    loopEndSec,
    pixelsPerSecond,
    preflightPlayback: async () => {
      const currentProjectId = projectId();
      if (!isLocalId("project", currentProjectId)) return true;
      const liveProcessor = (await listLocalExternalProcessors(currentProjectId))
        .find((processor) => !processor.bypassed && processor.health.state !== "degraded");
      if (!liveProcessor) return true;
      if (requiresNativeAudio || appPreferences.audio.preferences().nativePlaybackEnabled) return true;
      notify(
        "Native plug-in playback is disabled",
        liveProcessor.health.reason ?? "Enable native playback to use the external plug-in.",
      );
      return false;
    },
    nativePlayback: {
      enabled: () => requiresNativeAudio || appPreferences.audio.preferences().nativePlaybackEnabled,
      projectId,
      projectGeneration: mountedProjectGeneration,
      compileSnapshot: compilePlaybackSnapshot,
      reportFault: (message) => {
        if (classifyNativeVst3PlaybackFault(message) === "launch-authorization-required") {
          setAppMessage({
            title: "Plug-in authorization required",
            message: "This project uses VST3 plug-ins that must be verified again before playback. Rescan your configured plug-in folders, then press Play again.",
            action: {
              label: "Rescan plug-ins",
              busyLabel: "Rescanning…",
              enabled: () => canUseVst3CatalogAction("scan", vst3TrustAcknowledged()),
              onAction: async () => {
                const bridge = window.dawDesktop?.pluginCatalog;
                if (!bridge) {
                  throw new Error("Plug-in rescanning requires the desktop app.");
                }
                if (!canUseVst3CatalogAction("scan", vst3TrustAcknowledged())) {
                  throw new Error("Acknowledge the VST3 plug-in disclosure before rescanning.");
                }
                const result = await bridge.scan();
                if ("catalog" in result) {
                  window.dispatchEvent(new Event("daw-plugin-catalog-changed"));
                  setAppMessage(null);
                  return;
                }
                if (!result.ok) throw new Error(result.error);
              },
            },
            cancelLabel: "Cancel",
            trustAcknowledgement: {
              acknowledged: vst3TrustAcknowledged,
              onChange: (acknowledged) => {
                setVst3TrustAcknowledged(acknowledged);
                if (acknowledged) saveVst3TrustAcknowledgement(vst3TrustStorage);
              },
              disclosure: vst3TrustDisclosure,
            },
          });
          return;
        }
        notify("Native playback stopped", message);
      },
    },
    portableBrowserPlayback: requiresNativeAudio ? undefined : {
      projectGeneration: mountedProjectGeneration,
      compileSnapshot: compilePlaybackSnapshot,
      reportFault: (message) => notify("Portable browser playback stopped", message),
    },
  });
  const captureStructuralPlaybackIntent = (): TimelinePlaybackRebuildIntent => ({
    resumePlayback: isPlaying(),
    playheadSec: playheadSec(),
    owner: isNativePlaybackPrepared()
      ? "native"
      : isPortableBrowserPlaybackPrepared()
        ? "portable-browser"
        : undefined,
    projectId: projectId(),
    projectGeneration: mountedProjectGeneration(),
  });

  const rebuildPlaybackBackend = (
    tracks: Track[],
    intent?: TimelinePlaybackRebuildIntent,
    instrumentOverride?: { targetId: Track["id"]; instrument: TrackInstrumentParams },
  ) => {
    nativePlaybackRevision += 1;
    const rebuild = restartTimelineSchedule(tracks, {
      rebuildBackend: true,
      ...(intent ?? captureStructuralPlaybackIntent()),
      instrumentOverride: instrumentOverride ? instrumentOverride : undefined,
    });
    return rebuild;
  };

  function rescheduleChangedClips(clipIds: string[]) {
    if (clipIds.length === 0) return;
    if (isNativePlaybackPrepared() || isPortableBrowserPlaybackPrepared()) {
      void rebuildPlaybackBackend(renderTracks()).catch((cause: unknown) => {
        console.error("[Timeline] failed to rebuild prepared playback after clip edit", cause);
      });
      return;
    }
    if (!isPlaying()) return;
    const enabled = loopEnabled();
    const end = loopEndSec();
    const lenOk = enabled && end > loopStartSec() + 1e-3;
    playbackRescheduleChangedClips(
      renderTracks(),
      playheadSec(),
      clipIds,
      lenOk ? { endLimitSec: end } : undefined,
    );
    audioEngine.cancelAutomationSchedules();
    audioEngine.scheduleAutomationFromPlayhead(playheadSec(), {
      horizonSec: lenOk ? end - playheadSec() : undefined,
      tracks: renderTracks(),
    });
  }

  function rescheduleTimeline() {
    if (isNativePlaybackPrepared() || isPortableBrowserPlaybackPrepared()) {
      void rebuildPlaybackBackend(renderTracks()).catch((cause: unknown) => {
        console.error("[Timeline] failed to rebuild prepared playback after structural edit", cause);
      });
      return;
    }
    if (isPlaying()) restartTimelineSchedule(renderTracks()).catch((cause: unknown) => {
      console.error("[Timeline] failed to reschedule legacy playback", cause);
    });
  }

  const automation = useTimelineAutomationController({
    projectId,
    userId,
    remoteRows: () => fullView.data?.automationEnvelopes,
    remoteEffects: () =>
      fullView.data?.effects.flatMap((effect) => {
        if (effect.targetType !== "track" && effect.targetType !== "master")
          return [];
        return [
          {
            targetType: effect.targetType,
            trackId: effect.trackId,
            type: effect.type,
            instanceId: effect.instanceId,
            index: effect.index,
            params: effect.params,
          },
        ];
      }),
    audioEngine,
    reenableProcessorAutomation,
    isPlaying,
    playheadSec,
    selectedTrackId: selection.selectedTrackId,
    pushHistory,
  });
  const vstParameterFeedback = createVstParameterFeedbackController({
    projectId,
    mountedProjectGeneration,
    overrideTarget: automation.overrideTarget,
    nativeVstParameterQueue: nativeVstParameterQueue
      ? { enqueue: nativeVstParameterQueue.enqueue }
      : undefined,
    isNativePlaybackPrepared,
    reportFault: (message) => notify("Native VST feedback failed", message),
  });
  onCleanup(() => vstParameterFeedback?.dispose());
  getAutomationPatches = () => automation.snapshotExportPatches();
  const {
    pendingSharedTrackVolumes,
    pendingSharedTrackRouting,
    pendingSharedTrackMix,
    cancelTrackVolumeWrite,
    cancelTrackRoutingWrite,
    cancelTrackMixWrite,
    applyTrackVolume,
    applyTrackMixState,
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
    tracks: renderTracks,
    localMix,
    optimisticTrackIds,
    canWriteTrack,
    pushHistory,
    onLocalSaveFailed: localProject.setLocalSaveFailure,
    serverTrackState,
  });

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
  createEffect(() => {
    setRenderTracks(resolvedRenderTracks());
  });
  historyActions = {
    insertLocalTrack: (track, index) => projection.insertLocalTrack(track, index),
    removeLocalTrack: (trackId) => projection.removeLocalTrack(trackId),
    insertLocalClip: (trackId, clip) => projection.insertLocalClip(trackId, clip),
    replaceLocalClip: (trackId, clip) => projection.replaceLocalClip(trackId, clip),
    removeLocalClips: (clipIds) => projection.removeLocalClips(clipIds),
    commitClipMoves: (moves) => projection.commitClipMoves(moves),
    commitClipTiming: (clipId, patch) => projection.commitClipTiming(clipId, patch),
    commitClipAudioWarp: (clipId, audioWarp) =>
      projection.commitClipAudioWarp(clipId, audioWarp),
    commitClipFades: (clipId, fades) => projection.commitClipFades(clipId, fades),
    rescheduleChangedClips,
    rescheduleTimeline,
    refreshLocalTimeline: async () => {
      await mediaRecovery.reloadLocalTimeline();
      await Promise.resolve();
    },
    cancelTrackVolumeWrite,
    cancelTrackRoutingWrite,
    cancelTrackMixWrite,
    applyTrackVolume,
    applyTrackMixState,
    applyTrackRouting: (trackId, routing) =>
      applyTrackRouting(trackId, {
        sends: routing.sends ?? [],
        outputTargetId: routing.outputTargetId,
      }),
    applyTrackPatch: (trackId, patch) => {
      const currentTracks = renderTracks();
      const track = currentTracks.find((entry) => entry.id === trackId);
      const index = currentTracks.findIndex((entry) => entry.id === trackId);
      if (!track || index < 0) return;
      projection.updateLocalTrack(track, index, patch);
    },
    applyAutomationEnvelope: automation.applyEnvelope,
  };
  const pendingDeleteTrackClipCount = createMemo(() => {
    const trackId = pendingDeleteTrackId();
    if (!trackId) return 0;
    return trackLookup().trackById.get(trackId)?.clips.length ?? 0;
  });

  const audioWarpController = useTimelineAudioWarp({
    projectId,
    userId,
    bpm,
    tracks: renderTracks,
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

  const handleLocalMidiSaved = (clipId: string, midi: Clip["midi"]) => {
    const match = trackLookup().clipEntryById.get(clipId);
    if (!match) return;
    projection.replaceLocalClip(match.trackId, {
      ...match.clip,
      midi,
    });
  };

  const pushEffectParamsHistory = (
    payload: EffectParamsCommitPayload,
    committedProjectId?: string,
  ) => {
    const rid = committedProjectId ?? projectId();
    if (!rid) return;
    if (rid !== projectId()) return;
    pushHistory(
      buildEffectParamsHistoryEntry({
        projectId: rid,
        tracks: renderTracks(),
        payload,
      }),
      `fx:${payload.effect}:${payload.targetId}:${payload.instanceId ?? ""}`,
      600,
    );
  };

  const handleNativeBuiltInStatePatchResult = async (
    payload: EffectParamsCommitPayload,
  ): Promise<boolean> => {
    const result = await queueNativeBuiltInStatePatch({ payload, bpm: bpm() });
    return result.handled;
  };

  const handleNativeBuiltInPreview = async (
    payload: EffectParamsCommitPayload<"eq" | "master-eq">,
  ) => {
    const mapped = mapNativeBuiltInParameterCommit(payload, bpm());
    if (mapped) {
      const result = await queueLiveProcessorParameters(mapped);
      if (result.accepted) return;
    }
    if (!isNativePlaybackPrepared()) return;
    await handleNativeBuiltInStatePatchResult(payload);
  };

  const handleNativeBuiltInFlush = async (
    payload: EffectParamsCommitPayload<"eq" | "master-eq">,
  ) => {
    const mapped = mapNativeBuiltInParameterCommit(payload, bpm());
    if (!mapped || (!isNativePlaybackPrepared() && !isPortableBrowserPlaybackPrepared())) return;
    const result = await liveProcessorControl()?.flush(mapped);
    if (!result?.accepted) throw new Error("The final effect value was not applied to active playback.");
  };

  async function handleEffectParamsCommitted<Effect extends EffectType>(
    payload: EffectParamsCommitPayload<Effect>,
    committedProjectId?: string,
  ) {
    pushEffectParamsHistory(payload, committedProjectId);
    if (payload.effect === "instrument") return;
    const mapped = mapNativeBuiltInParameterCommit(payload, bpm());
    if (mapped && (isNativePlaybackPrepared() || isPortableBrowserPlaybackPrepared())) {
      const control = liveProcessorControl();
      const result = await control?.flush(mapped);
      if (result?.accepted) return;
    }
    if (usesLegacyAudioEngine()) return;
    if (isNativePlaybackPrepared() && encodeNativeBuiltInStateCommit(payload, bpm())) {
      if (await handleNativeBuiltInStatePatchResult(payload)) return;
    }
    if (isPlaying() || isNativePlaybackPrepared() || isPortableBrowserPlaybackPrepared()) {
      try {
        await rebuildPlaybackBackend(renderTracks());
      } catch (error: unknown) {
        notify(
          "Built-in effect update failed",
          error instanceof Error
            ? error.message
            : "The active playback graph could not be rebuilt for the built-in effect change.",
        );
      }
    }
  }

  // DOM refs
  let scrollRef: HTMLDivElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let archiveInputRef: HTMLInputElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let returnSectionRef: HTMLDivElement | undefined;
  let masterTimelineRef: HTMLDivElement | undefined;
  let timelineSurfaceRef: HTMLDivElement | undefined;
  let rootRef: HTMLDivElement | undefined;
  let effectsChainElement: HTMLElement | undefined;
  const duration = () => timelineDurationSec(renderTracks());

  const leftBrowser = useTimelineLeftBrowserState({
    projectId,
    rightSidebarWidthPx: sidebarWidth,
    getContainerElement: () => containerRef,
  });
  const timelineExtensionHost = createTimelineExtensionHost({
    browser: {
      toggle: leftBrowser.toggleOpen,
    },
  });
  onCleanup(() => {
    void timelineExtensionHost.dispose();
  });
  const leftBrowserResize = useTimelineLeftBrowserResize({
    widthPx: leftBrowser.widthPx,
    previewWidthPx: leftBrowser.previewWidthPx,
    commitWidthPx: leftBrowser.commitWidthPx,
    getContainerElement: () => containerRef,
    rightSidebarWidthPx: sidebarWidth,
  });
  const [deviceInsertActions, setDeviceInsertActions] =
    createSignal<TimelineDeviceInsertActions>();

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
    requiresNativeAudio,
    tracks: renderTracks,
    projectId,
    bpm,
    isPlaying,
    playheadSec,
    selection,
    activeRecordingTargetId: activeMidiRecordingTargetId,
    nativeLiveMidi,
    canOpenMidiEditorFor: (clipId) => clipId !== provisionalMidiClipId(),
  });
  const removeCreatedCloudTrack = (track: Track | undefined) =>
    removeAutoCreatedCloudTrack({
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
    groupSelectedTracks,
    ungroupTrack,
    moveTrackToGroup,
    reorderTracks,
    toggleTrackCollapsed,
    setTracksCollapsed,
    setTrackColor,
    resetTrackColor,
    assignTrackColorToClips,
    resetClipColors,
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
      removeLocalTrack: projection.removeLocalTrack,
      replaceLocalClip: projection.replaceLocalClip,
      updateLocalTrack: projection.updateLocalTrack,
      removeCloudTrack: removeCreatedCloudTrack,
      grantTrackWrite,
      pushHistory,
    },
    defaultColors: {
      track: appPreferences.timeline.defaultTrackCreateColor,
      group: appPreferences.timeline.defaultGroupCreateColor,
    },
    automationEnvelopes: automation.envelopes,
    sidechainRoutes,
    applyAutomationEnvelope: automation.applyEnvelope,
    navigation: {
      trackLookup,
      selection,
      setPlayhead,
      openMidiEditorFor,
      ensureClipBuffer: clipBuffers.preload,
      getScrollElement: () => scrollRef,
      pixelsPerSecond,
    },
  });

  const trackLayoutModel = createMemo(() => {
    const lanes = automation.workspace().lanes;
    const tracks = renderTracks();
    const tree = buildTrackTree(tracks);
    const collapsedById = new Map(
      tracks.map((track) => [track.id, track.collapsed === true]),
    );
    const visibleTrackIds = flattenVisibleTracks(tree, collapsedById);
    return buildTimelineTrackLayout({
      tracks,
      visibleTrackIds,
      depthByTrackId: computeDepthMap(tree),
      visibleByTrackId: lanes.visibleByTrackId,
      heightsByLaneOwnerKey: lanes.heightsByLaneOwnerKey,
      visibleParameterIdsByTrackId: lanes.visibleTargetKeysByTrackId,
    });
  });
  const trackLayout = createMemo(() => trackLayoutModel().scrollingRows);

  const selectAllClipsInGroup = (groupId: Track["id"]) => {
    const descendantIds = collectTrackDescendantIds(renderTracks(), groupId);
    const clips = renderTracks()
      .filter((track) => descendantIds.has(track.id))
      .flatMap((track) =>
        track.clips.map((clip) => ({ trackId: track.id, clipId: clip.id })),
      );
    const first = clips[0];
    if (!first) return;
    selection.selectClipGroup({
      trackId: first.trackId,
      clipIds: clips.map((clip) => clip.clipId),
      primaryClipId: first.clipId,
    });
  };

  const {
    handleDrop: onDrop,
    handleFiles,
    handleAddAudio,
    handleInsertSample,
    importFiles,
  } = useTimelineClipImport({
    audioEngine,
    tracks: renderTracks,
    trackLayout,
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
    pixelsPerSecond,
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
        autoApply: (audioWarp) =>
          audioWarpController.changeAudioWarp(clip, audioWarp),
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
    trackLayout,
    rootElement: () => rootRef,
    scrollElement: () => scrollRef,
    onDrop,
  });

  let extendRangeSelectionToPointer: (
    event: PointerEvent,
    options: {
      element: HTMLDivElement | undefined;
      trackId?: Track["id"];
    },
  ) => boolean = () => false;

  const clipDrag = useClipDrag({
    placementTracks: () => placementTracks(),
    trackLayout,
    resolvedTracks: () => resolvedTracks(),
    defaultTrackCreateColor: appPreferences.timeline.defaultTrackCreateColor,
    insertLocalTrack: projection.insertLocalTrack,
    insertLocalClip: projection.insertLocalClip,
    removeLocalClips: projection.removeLocalClips,
    removeLocalTrack: projection.removeLocalTrack,
    replaceDraftClipMoves: projection.replaceDraftClipMoves,
    clearDraftClipMoves: projection.clearDraftClipMoves,
    setPreviewClipsByTrack: projection.setPreviewClipsByTrackId,
    commitClipMoves: projection.commitClipMoves,
    canWriteClip,
    canEditClip: (clipId) => clipId !== provisionalMidiClipId(),
    selection,
    projectId,
    userId,
    convexClient,
    convexApi,
    getScrollElement: () => scrollRef,
    bpm,
    gridEnabled,
    gridDenominator,
    pixelsPerSecond,
    audioBufferCache: clipBuffers,
    onCommitMoves: (ids) => {
      rescheduleChangedClips(ids);
    },
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantWrite: grantTrackWrite,
    grantClipWrites,
    onRangeSelectionPointerDown: (trackId, event) =>
      extendRangeSelectionToPointer(event, { element: scrollRef, trackId }),
  });
  const onClipPointerDown = clipDrag.onClipPointerDown;

  const clipResize = useClipResize({
    tracks: renderTracks,
    setDraftClipTiming: projection.setDraftClipTiming,
    commitClipTiming: projection.commitClipTiming,
    canWriteClip,
    canEditClip: (clipId) => clipId !== provisionalMidiClipId(),
    selection,
    convexClient,
    convexApi,
    userId,
    getScrollElement: () => scrollRef,
    bpm,
    gridEnabled,
    gridDenominator,
    pixelsPerSecond,
    rescheduleChangedClips,
    projectId,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
  });
  const onClipResizeStart = clipResize.onClipResizeStart;
  const timelineViewport = useTimelineViewport({
    persistenceScope: projectId,
    pixelsPerSecond,
    previewPixelsPerSecond,
    commitPixelsPerSecond,
    durationSec: duration,
    rightSidebarWidth: sidebarWidth,
    canZoom: () => !clipDrag.isDragging() && !clipResize.isResizing(),
  });

  const commitClipFades = async (
    clipId: string,
    fades: ClipFades,
    baseline: ClipFades,
  ) => {
    const clip = trackLookup().clipById.get(clipId);
    const rid = projectId();
    if (!clip || clip.midi || !rid || !canWriteClip(clipId)) {
      return;
    }
    if (clipFadesEqual(clip.fades, fades, clip.duration)) {
      return;
    }
    projection.commitClipFades(clipId, fades);
    const rollback = () => {
      const currentClip = trackLookup().clipById.get(clipId);
      if (!currentClip || !clipFadesEqual(currentClip.fades, fades, currentClip.duration)) return;
      projection.commitClipFades(clipId, baseline);
      rescheduleChangedClips([clipId]);
    };
    try {
      const applied = await createTimelineClipWriteAdapter({
        projectId: rid,
        userId: userId(),
      }).setFades(clipId, fades);
      if (!applied) {
        rollback();
        return;
      }
      pushHistory(buildClipFadesHistoryEntry({ projectId: rid, clip, from: baseline, to: fades }));
      rescheduleChangedClips([clipId]);
    } catch {
      rollback();
    }
  };

  const {
    onClipPointerUp,
    deleteSelectedClips,
    duplicateSelectedClips,
    duplicateTimelineSelection,
    deleteTimelineSelection,
    copyTimelineSelection,
    pasteTimelineSelection,
    performDeleteTrack,
    requestDeleteTrack,
  } = useTimelineClipActions({
    tracks: renderTracks,
    insertLocalClip: projection.insertLocalClip,
    removeLocalClips: projection.removeLocalClips,
    commitClipTiming: projection.commitClipTiming,
    commitClipAudioWarp: projection.commitClipAudioWarp,
    removeLocalTrack: projection.removeLocalTrack,
    canWriteClip,
    canEditClip: (clipId) => clipId !== provisionalMidiClipId(),
    selection,
    setPendingDeleteTrackId,
    setConfirmOpen,
    projectId,
    userId,
    convexClient,
    convexApi,
    audioBufferCache: clipBuffers,
    bpm,
    playheadSec,
    gridEnabled,
    gridDenominator,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    automationEnvelopes: automation.envelopes,
    sidechainRoutes,
    applyAutomationEnvelope: automation.applyEnvelope,
    grantClipWrites,
    settleActiveRecording: async (trackIds) => {
      const activeMidiTrackId = activeMidiRecordingTargetId();
      const activeAudioTrackId = recordingStopRef.activeTrackId();
      if (
        (activeMidiTrackId && trackIds.has(activeMidiTrackId))
        || (activeAudioTrackId && trackIds.has(activeAudioTrackId))
      ) await recordingStopRef.stop();
    },
    notify,
  });

  const timelineSelection = useTimelineSelection({
    tracks: renderTracks,
    trackLayout,
    displayTrackIds: () => trackLayoutModel().displayTrackIds,
    selection,
    bpm,
    gridDenominator,
    pixelsPerSecond,
    startScrub,
    moveScrub,
    stopScrub,
  });
  const marqueeRect = timelineSelection.marqueeRect;
  const marqueeSurface = timelineSelection.marqueeSurface;
  extendRangeSelectionToPointer =
    timelineSelection.extendRangeSelectionToPointer;
  const handleReturnPointerDown: JSX.EventHandler<
    HTMLDivElement,
    PointerEvent
  > = (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    bottomPanel.setMode("effects");
    bottomPanel.setOpen(true);
    timelineSelection.onLanePointerDown(event, {
      kind: "return",
      element: returnSectionRef,
      rows: trackLayoutModel().returnRows,
      rulerOffsetPx: 0,
    });
  };

  const recordingControls = useTrackRecording({
    audioEngine,
    requiresNativeAudio,
    tracks: renderTracks,
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
    requestTransportStop: handleStop,
    portableRecording: {
      enabled: () => !requiresNativeAudio && appPreferences.recording.preferences().portableEnabled,
      controller: portableRecording,
    },
    nativeRecording: {
      enabled: () => requiresNativeAudio || appPreferences.audio.preferences().nativePlaybackEnabled,
      controller: nativeRecording,
    },
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
    audioPreferences: appPreferences.audio.preferences,
    recordingPreferences: appPreferences.recording.preferences,
  });

  const {
    isRecording: isAudioRecording,
    recordArmTrackId,
    toggleRecording: toggleAudioRecording,
    toggleRecordArm: handleToggleRecordArm,
    reconcileRecordArm,
    stopRecording: stopAudioRecording,
    recordingTrackId: audioRecordingTrackId,
    previewPoints,
    previewStartSec,
  } = recordingControls;

  const midiRecording = useMidiTrackRecording({
    audioEngine,
    tracks: renderTracks,
    projectId,
    userId,
    playheadSec,
    bpm,
    loopEnabled,
    recordArmTrackId,
    setTrackLock: projection.setTrackLock,
    clearTrackLock: projection.clearTrackLock,
    insertLocalClip: projection.insertLocalClip,
    removeLocalClips: projection.removeLocalClips,
    selection,
    requestTransportPlay: requestPlay,
    pauseTransport: handlePause,
    notify: (message) => localProject.setLocalSaveFailure(message),
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    setActiveRecordingTarget: setActiveMidiRecordingTargetId,
    setProvisionalClipId: setProvisionalMidiClipId,
  });
  recordingStopRef.stop = async () => {
    if (isAudioRecording()) await stopAudioRecording();
    if (midiRecording.isRecording()) await midiRecording.stopRecording();
  };
  recordingStopRef.activeTrackId = audioRecordingTrackId;
  setProjectTransitionSettlement(async () => {
    if (untrack(isAudioRecording)) await stopAudioRecording();
    if (untrack(midiRecording.isRecording)) await midiRecording.stopRecording();
    if (untrack(provisionalMidiClipId)) throw new Error("MIDI recording remains protected until it can be finalized.");
  });
  onCleanup(() => setProjectTransitionSettlement(undefined));
  const isRecording = createMemo(() => isAudioRecording() || midiRecording.isRecording());
  const recordingTrackId = createMemo(() => recordingControls.recordingTrackId() ?? midiRecording.recordingTrackId());
  const stopRecording = async () => {
    if (isAudioRecording()) await stopAudioRecording();
    if (midiRecording.isRecording()) await midiRecording.stopRecording();
  };
  const deleteTimelineSelectionSafely = async () => {
    await runTimelineMutationAfterRecordingSettlement({
      isRecording,
      stopRecording,
      provisionalClipId: provisionalMidiClipId,
      mutate: deleteTimelineSelection,
    });
  };
  const toggleLoopSafely = () => {
    if (midiRecording.isRecording()) {
      localProject.setLocalSaveFailure("Stop MIDI recording before enabling loop.");
      return;
    }
    setLoopEnabled((prev) => !prev);
    if (isNativePlaybackPrepared() || isPortableBrowserPlaybackPrepared()) {
      void rebuildPlaybackBackend(renderTracks()).catch((cause: unknown) => {
        console.error("[Timeline] failed to reconcile loop playback", cause);
        audioEngine.onTransportPause();
        audioEngine.stopAllSources();
        setLoopEnabled(false);
      });
    } else if (isPlaying()) {
      void restartTimelineSchedule(renderTracks()).catch((cause: unknown) => {
        console.error("[Timeline] failed to reschedule loop playback", cause);
      });
    }
  };
  const openProject = async (nextProjectId: string) => {
    if (nextProjectId === projectId()) return;
    if (isRecording()) await stopRecording();
    await navigateToRoom(nextProjectId);
  };
  const toggleRecording = async () => {
    if (isRecording()) {
      await stopRecording();
      return { ok: true, trackId: recordingTrackId() ?? undefined };
    }
    const armed = renderTracks().find((track) => track.id === recordArmTrackId());
    if (armed?.kind === "instrument") {
      const ok = await midiRecording.startRecording();
      return { ok, trackId: ok ? armed.id : undefined };
    }
    return await toggleAudioRecording();
  };

  const handleTransportPause = async () => {
    if (isRecording()) await stopRecording();
    return handlePause();
  };

  const handleTransportStop = async () => {
    if (isRecording()) await stopRecording();
    return handleStop();
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
        if (isPlaying()) {
          handlePause();
        } else {
          requestPlay();
        }
      }
    },
    onDelete: () => {
      void deleteTimelineSelectionSafely();
    },
    onDuplicate: () => {
      void duplicateTimelineSelection();
    },
    onCopy: copyTimelineSelection,
    onPaste: pasteTimelineSelection,
    onAddAudioTrack: () => {
      void addAudioTrack().catch(() => {});
    },
    onAddReturnTrack: () => {
      void addReturnTrack().catch(() => {});
    },
    onAddGroupTrack: () => {
      void addGroupTrack().catch(() => {});
    },
    onGroupSelectedTracks: () => {
      const rangeTrackIds = selection.rangeSelection()?.trackIds ?? [];
      const selectedTrackId = selection.selectedTrackId();
      const trackIds =
        rangeTrackIds.length > 0
          ? rangeTrackIds
          : selectedTrackId
            ? [selectedTrackId]
            : [];
      if (trackIds.length > 0) void groupSelectedTracks(trackIds);
    },
    onUngroupSelectedTrack: () => {
      const trackId = selection.selectedTrackId();
      const track = renderTracks().find(
        (candidate) => candidate.id === trackId,
      );
      if (track?.channelRole === "group") void ungroupTrack(track.id);
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
    executeExtensionShortcut: timelineExtensionHost.shortcuts.execute,
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
    if (event.button !== 0) return;
    if (
      event.target instanceof Element &&
      event.target.closest('[data-timeline-ruler="1"]')
    )
      return;
    bottomPanel.setMode("effects");
    timelineSelection.onLanePointerDown(event, {
      kind: "scrolling",
      element: scrollRef,
      rows: trackLayoutModel().scrollingRows,
      rulerOffsetPx: TIMELINE_HEADER_HEIGHT,
    });
  };
  const handleMasterPointerDown: JSX.EventHandler<
    HTMLDivElement,
    PointerEvent
  > = (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    bottomPanel.setMode("effects");
    selection.selectMasterTarget();
    startScrub(event.clientX);
  };
  const addFourBarMidiClipToTrack = (trackId: Track["id"]) => {
    const actions = deviceInsertActions();
    if (!actions?.canAddMidiClipToTarget(trackId)) return;
    const secondsPerBeat = 60 / Math.max(1e-6, bpm());
    void actions.addMidiClipToTarget(trackId, {
      durationSec: secondsPerBeat * 16,
    });
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
    else
      selection.selectTrackTarget(targetId, {
        clearClipSelection: !options?.preserveClipSelection,
      });
    bottomPanel.setMode("effects");
    bottomPanel.setOpen(true);
  };
  const audioEffectChainFromInstrumentPreset = (
    preset: InstrumentPreset,
  ): AudioEffectChainPreset | undefined => {
    if (!preset.audioEffects || preset.audioEffects.length === 0)
      return undefined;
    return {
      id: `instrument-preset:${preset.id}:audio-effects`,
      name: preset.name,
      effects: preset.audioEffects,
    };
  };
  const applyInstrumentPresetToTarget = async (
    actions: TimelineDeviceInsertActions,
    targetId: Track["id"],
    preset: InstrumentPreset,
  ) => {
    const audioEffectChain = audioEffectChainFromInstrumentPreset(preset);
    if (!actions.canSetInstrumentForTarget(targetId)) return false;
    if (
      audioEffectChain &&
      !actions.canAddAudioEffectChainToTarget(targetId, audioEffectChain)
    )
      return false;
    if (!actions.setInstrumentForTarget(targetId, preset.instrument))
      return false;
    for (const effect of preset.midiEffects ?? []) {
      if (
        effect.kind === "arpeggiator" &&
        !actions.setArpeggiatorForTarget(targetId, effect.params)
      )
        return false;
    }
    if (
      audioEffectChain &&
      !(await actions.addAudioEffectChainToTarget(targetId, audioEffectChain))
    )
      return false;
    return true;
  };
  const handleBrowserDeviceDrop = async (
    payload: BrowserDragPayload,
    target: BrowserDropTarget,
  ) => {
    const actions = deviceInsertActions();
    if (!actions) return;
    const insertionProjectId = projectId();
    if (payload.kind === "audio-effect" && target.kind === "effect-chain") {
      if (
        !(await actions.addAudioEffectToTarget(
          target.targetId,
          payload.effect,
          target.index,
        ))
      )
        return;
      openEffectsForTarget(target.targetId);
      return;
    }
    if (payload.kind === "audio-effect" && target.kind === "track") {
      if (
        !(await actions.addAudioEffectToTarget(target.trackId, payload.effect))
      )
        return;
      openEffectsForTarget(target.trackId);
      return;
    }
    if (payload.kind === "audio-effect" && target.kind === "new-track") {
      const track = await createTimelineTrack();
      if (!track) return;
      const applied = await applyCreatedTrackInsertion({
        projectId: insertionProjectId,
        track,
        apply: () => actions.addAudioEffectToTarget(track.id, payload.effect),
        removeLocalTrack: projection.removeLocalTrack,
        removeCloudTrack: removeCreatedCloudTrack,
      });
      if (!applied) return;
      openEffectsForTarget(track.id);
      return;
    }
    if (
      payload.kind === "audio-effect-chain" &&
      target.kind === "effect-chain"
    ) {
      if (
        !(await actions.addAudioEffectChainToTarget(
          target.targetId,
          payload.chain,
          target.index,
        ))
      )
        return;
      openEffectsForTarget(target.targetId);
      return;
    }
    if (payload.kind === "audio-effect-chain" && target.kind === "track") {
      if (
        !(await actions.addAudioEffectChainToTarget(
          target.trackId,
          payload.chain,
        ))
      )
        return;
      openEffectsForTarget(target.trackId);
      return;
    }
    if (payload.kind === "audio-effect-chain" && target.kind === "new-track") {
      const track = await createTimelineTrack();
      if (!track) return;
      const applied = await applyCreatedTrackInsertion({
        projectId: insertionProjectId,
        track,
        apply: () => actions.addAudioEffectChainToTarget(track.id, payload.chain),
        removeLocalTrack: projection.removeLocalTrack,
        removeCloudTrack: removeCreatedCloudTrack,
      });
      if (!applied) return;
      openEffectsForTarget(track.id);
      return;
    }
    if (payload.kind === "midi-effect" && target.kind === "track") {
      if (!(await actions.addArpeggiatorToTarget(target.trackId))) return;
      openEffectsForTarget(target.trackId);
      return;
    }
    if (payload.kind === "midi-effect" && target.kind === "new-track") {
      const track = await createTimelineTrack({ kind: "instrument" });
      if (!track) return;
      const applied = await applyCreatedTrackInsertion({
        projectId: insertionProjectId,
        track,
        apply: () => actions.addArpeggiatorToTarget(track.id),
        removeLocalTrack: projection.removeLocalTrack,
        removeCloudTrack: removeCreatedCloudTrack,
      });
      if (!applied) return;
      openEffectsForTarget(track.id);
      return;
    }
    if (payload.kind === "midi-instrument" && target.kind === "track") {
      if (
        !actions.switchInstrumentForTarget(target.trackId, payload.instrument)
      )
        return;
      if (!(await actions.addMidiClipToTarget(target.trackId))) return;
      openEffectsForTarget(target.trackId, { preserveClipSelection: true });
      return;
    }
    if (payload.kind === "midi-instrument" && target.kind === "new-track") {
      const track = await createTimelineTrack({ kind: "instrument" });
      if (!track) return;
      const applied = await applyCreatedTrackInsertion({
        projectId: insertionProjectId,
        track,
        apply: async () => {
          if (!actions.switchInstrumentForTarget(track.id, payload.instrument))
            return false;
          return actions.addMidiClipToTarget(track.id);
        },
        removeLocalTrack: projection.removeLocalTrack,
        removeCloudTrack: removeCreatedCloudTrack,
      });
      if (!applied) return;
      openEffectsForTarget(track.id, { preserveClipSelection: true });
    }
    if (payload.kind === "instrument-preset" && target.kind === "track") {
      if (
        !(await applyInstrumentPresetToTarget(
          actions,
          target.trackId,
          payload.preset,
        ))
      )
        return;
      openEffectsForTarget(target.trackId);
      return;
    }
    if (payload.kind === "instrument-preset" && target.kind === "new-track") {
      const track = await createTimelineTrack({ kind: "instrument" });
      if (!track) return;
      const applied = await applyCreatedTrackInsertion({
        projectId: insertionProjectId,
        track,
        apply: () => applyInstrumentPresetToTarget(actions, track.id, payload.preset),
        removeLocalTrack: projection.removeLocalTrack,
        removeCloudTrack: removeCreatedCloudTrack,
      });
      if (!applied) return;
      openEffectsForTarget(track.id);
    }
  };
  const timelineBrowser = useTimelineBrowserController({
    projectId,
    userId,
    leftBrowser,
    onResizePointerDown: leftBrowserResize.onPointerDown,
    deviceInsertActions,
    canCreateTrack,
    tracks: renderTracks,
    trackLayout,
    returnTrackLayout: () => trackLayoutModel().returnRows,
    returnSectionElement: () => returnSectionRef,
    masterTimelineElement: () => masterTimelineRef,
    timelineSurfaceElement: () => timelineSurfaceRef,
    scrollElement: () => scrollRef,
    effectsChainElement: () => effectsChainElement,
    currentEffectsTargetId: () => selection.selectedFXTarget(),
    enableNativePlayback: () => appPreferences.audio.setNativePlaybackEnabled(true),
    handleInsertSample,
    onDeviceDrop: handleBrowserDeviceDrop,
    captureStructuralPlaybackIntent,
    onExternalPluginInsertionResult: (title, message) => notify(title, message),
    onExternalPluginInserted: async (processor, playbackIntent) => {
      openEffectsForTarget(processor.targetId);
      const intent = playbackIntent ?? captureStructuralPlaybackIntent();
      const request: ExternalProcessorEditorRequest = {
        instanceId: processor.instanceId,
        projectId: intent.projectId ?? projectId(),
        projectGeneration: intent.projectGeneration ?? mountedProjectGeneration(),
        requestToken: ++externalProcessorEditorRequestToken,
        ready: false,
      };
      setPendingExternalProcessorEditorRequest(request);
      const nativePlaybackEnabled =
        appPreferences.audio.preferences().nativePlaybackEnabled;
      console.info("[native-vst3] external plugin inserted", {
        instanceId: processor.instanceId,
        targetId: processor.targetId,
        isPlaying: intent.resumePlayback,
        nativePlaybackEnabled,
      });
      try {
        await rebuildPlaybackBackend(renderTracks(), intent);
        console.info("[native-vst3] rebuild succeeded", {
          instanceId: processor.instanceId,
          targetId: processor.targetId,
          isPlaying: intent.resumePlayback,
          nativePlaybackEnabled,
        });
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "The active native playback graph could not be rebuilt.";
        console.error("[native-vst3] active rebuild failed", { error: message });
        notify(
          "Native playback rebuild failed",
          message,
        );
        if (pendingExternalProcessorEditorRequest()?.requestToken === request.requestToken) {
          setPendingExternalProcessorEditorRequest();
        }
        return;
      }
      const currentRequest = pendingExternalProcessorEditorRequest();
      if (
        currentRequest?.requestToken === request.requestToken
        && currentRequest.projectId === projectId()
        && currentRequest.projectGeneration === mountedProjectGeneration()
      ) {
        setPendingExternalProcessorEditorRequest({ ...currentRequest, ready: true });
      }
    },
  });
  createEffect(() => {
    const request = pendingExternalProcessorEditorRequest();
    if (
      request
      && (request.projectId !== projectId() || request.projectGeneration !== mountedProjectGeneration())
    ) {
      setPendingExternalProcessorEditorRequest();
    }
  });
  const browserDropTargetLane = createMemo(() => {
    const target = timelineBrowser().devices.dragSession()?.target;
    if (target?.kind !== "track") return null;
    return target.laneIndex;
  });
  const browserDropTargetTrackId = createMemo(() => {
    return getBrowserDropTargetTrackId(
      timelineBrowser().devices.dragSession()?.target,
    );
  });
  const browserDropAtNewTrack = createMemo(
    () => timelineBrowser().devices.dragSession()?.target.kind === "new-track",
  );
  useTimelineAudioLifecycle({
    audioEngine,
    tracks: renderTracks,
    bpm,
    metronomeEnabled,
    projectId,
    clearClipBufferCaches: clipBuffers.clearClipBufferCaches,
  });

  if (window.dawDesktop) {
    const unregisterHostController = registerAttachedHostController(createAttachedHostController({
      projectId,
      mountedProjectGeneration,
      isPlaying,
      playheadSec,
      tracks: renderTracks,
      audioEngine,
      requestPlay,
      pause: handleTransportPause,
      stop: handleTransportStop,
      finishRecording: async () => {
        if (isRecording()) await stopRecording();
      },
      exportQueue,
      exportService,
      importFiles,
      enqueueNativeVstParameter: nativeVstParameterQueue
        ? (event) => nativeVstParameterQueue.enqueue(event).then((result) => result === "delivered")
        : undefined,
      reconcileMountedLocalTimeline,
      setPlayhead: (seconds) => setPlayhead(seconds, renderTracks()),
    }));
    onCleanup(unregisterHostController);
  }

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
      onOpenProject: openProject,
      onCreateProject: createProject,
      onDeleteProject: deleteProject,
      onRenameProject: renameProject,
      onOpenExport: () => setExportOpen(true),
      onOpenDashboard: props.setDashboardParam,
      onSignIn: () => navigate({ to: "/Login" }),
      onLogout: async () => {
        try {
          await authClient.signOut();
        } finally {
          queryClient.setQueryData(["session"], null);
          navigate({ to: "/Login" });
        }
      },
      onAbout: () => navigate({ to: "/about" }),
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
    zoom: {
      onIn: timelineViewport.zoomIn,
      onOut: timelineViewport.zoomOut,
      onFit: timelineViewport.zoomToFit,
    },
    gridDenominator: gridDenominator(),
    onChangeGridDenominator: setGridDenominator,
    loopEnabled: loopEnabled(),
    onToggleLoop: toggleLoopSafely,
    isRecording: isRecording(),
    onToggleRecord: toggleRecording,
    onUndo: handleUndo,
    onRedo: handleRedo,
    automationOverrideCount: automation.overrideCount(),
    onReEnableAutomation: automation.reEnable,
    onDeleteSelection: () => {
      void deleteTimelineSelectionSafely();
    },
    onDuplicateSelection: () => {
      void duplicateTimelineSelection();
    },
    onJumpToClip: (clipId: string, trackId: string, startSec: number) =>
      jumpToClip(trackId, clipId, startSec),
    onInsertSample: (payload: Parameters<typeof handleInsertSample>[0]) => {
      void handleInsertSample(payload);
    },
  });

  useDesktopApplicationMenu(transportProps, timelineExtensionHost.menu);

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
    toggleLoop: toggleLoopSafely,
  }));

  const selectedExportTrackIds = createMemo(() =>
    deriveSelectedExportTrackIds({
      tracks: renderTracks(),
      clipTrackIdById: trackLookup().clipTrackIdById,
      rangeSelection: selection.rangeSelection(),
      selectedClipIds: selection.selectedClipIds(),
      primaryTrackId: selection.selectedTrackId() || undefined,
    }),
  );

  const panelsProps = () => ({
    exportQueue,
    exportService,
    chat: {
      bottomOffsetPx: bottomPanel.chatBottomOffsetPx(),
      sharedChatOpen: bottomPanel.sharedChatOpen(),
      projectId: projectId(),
      userId: userId(),
      toggleSharedChat: bottomPanel.toggleSharedChat,
      closeSharedChat: bottomPanel.closeSharedChat,
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
      sidechainRoutes: sidechainRoutes(),
      playheadSec: playheadSec(),
      projectId: projectId(),
      userId: userId(),
      audioEngine,
      spectrumProvider: subscribeSpectrum,
      canWriteTrackRouting: canWriteTrack,
      grantClipWrite,
      onSelectClip: jumpToClip,
      insertLocalClip: projection.insertLocalClip,
      onClose: () => bottomPanel.setOpen(false),
      onOpen: () => {
        bottomPanel.setMode("effects");
        bottomPanel.setOpen(true);
      },
      onEffectParamsCommitted: handleEffectParamsCommitted,
      onStructuralPlaybackChange: (targetId: Track["id"], instrument: TrackInstrumentParams) => {
        if (!isPlaying() && !isNativePlaybackPrepared() && !isPortableBrowserPlaybackPrepared()
          && !isStructuralRebuildInProgress()
          && !isPreparingPlayback()) return;
        const tracks = renderTracks();
        const rebuild = rebuildPlaybackBackend(tracks, undefined, { targetId, instrument });
        void rebuild.catch((cause: unknown) => {
          notify(
            "Native playback rebuild failed",
            cause instanceof Error
              ? cause.message
              : "The active playback graph could not be rebuilt for the instrument insertion.",
          );
        });
      },
      usesLegacyAudioEngine,
      projectGeneration: mountedProjectGeneration,
      onEffectParamsPreview: (payload: EffectParamsCommitPayload<"eq" | "master-eq">) => {
        void handleNativeBuiltInPreview(payload);
      },
      onEffectParamsFlush: handleNativeBuiltInFlush,
      onPreviewNote: auditionNote,
      enqueueNativeVstParameter: nativeVstParameterQueue?.enqueue,
      onEffectInstanceParamsReplayChange: (
        replay: EffectsPanelAudioEffects["replayInstanceParams"] | undefined,
      ) => setReplayEffectInstanceParams(() => replay),
      onLocalSaveFailed: localProject.setLocalSaveFailure,
      onDeviceInsertActionsChange: setDeviceInsertActions,
      onExportSnapshotChange: setEffectsExportSnapshot,
      autoOpenExternalProcessorId: (() => {
        const request = pendingExternalProcessorEditorRequest();
        return request?.ready
          && request.projectId === projectId()
          && request.projectGeneration === mountedProjectGeneration()
          ? request.instanceId
          : undefined;
      })(),
      onExternalProcessorAutoOpenHandled: (instanceId: string) => {
        const request = pendingExternalProcessorEditorRequest();
        if (request?.ready && request.instanceId === instanceId) {
          setPendingExternalProcessorEditorRequest();
        }
      },
      captureStructuralPlaybackIntent,
      onExternalProcessorUpdated: (
        processor: ExternalProcessor,
        previous: ExternalProcessor,
        playbackIntent: TimelinePlaybackRebuildIntent | undefined,
      ) => {
        if (processor.bypassed === previous.bypassed) return;
        const intent = playbackIntent ?? captureStructuralPlaybackIntent();
        if (!intent.resumePlayback && !isNativePlaybackPrepared() && !isPortableBrowserPlaybackPrepared()) return;
        void rebuildPlaybackBackend(renderTracks(), intent).catch((cause: unknown) => {
          notify(
            "Native playback rebuild failed",
            cause instanceof Error ? cause.message : "The active native playback graph could not be rebuilt.",
          );
        });
      },
      onMixedReorderCommitted: (playbackIntent: TimelinePlaybackRebuildIntent | undefined) => {
        const intent = playbackIntent ?? captureStructuralPlaybackIntent();
        if (!intent.resumePlayback && !isNativePlaybackPrepared() && !isPortableBrowserPlaybackPrepared()) return;
        void rebuildPlaybackBackend(renderTracks(), intent).catch((cause: unknown) => {
          notify(
            "Native playback rebuild failed",
            cause instanceof Error ? cause.message : "The active native playback graph could not be rebuilt.",
          );
        });
      },
      automationEnvelopes: automation.envelopes(),
      onSelectAutomationParameter: (
        targetKey: Track["id"] | "master",
        parameterId: string,
        effectInstanceId?: string,
      ) => {
        automation.effectsPanel.selectParameter(targetKey, {
          parameterId,
          effectInstanceId,
        });
      },
      onManualAutomationOverride: (
        targetKey: Track["id"] | "master",
        parameterId: string,
        effectInstanceId?: string,
      ) => {
        automation.overrideTarget(
          targetKey === "master"
            ? automationTargetKey(
                { kind: "master", effectInstanceId },
                parameterId,
              )
            : automationTargetKey(
                { kind: "track", trackId: targetKey, effectInstanceId },
                parameterId,
              ),
        );
      },
      onEffectChainElementChange: (element: HTMLElement | undefined) => {
        effectsChainElement = element;
      },
      evaluatedValuesByTargetKey: automation.evaluatedValuesByTargetKey(),
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
      getTracks: renderTracks,
      selectedTrackIds: selectedExportTrackIds(),
      bpm: bpm(),
      masterVolume: masterVolume.volume(),
      loopEnabled: loopEnabled(),
      loopStartSec: loopStartSec(),
      loopEndSec: loopEndSec(),
      projectId: projectId(),
      userId: userId(),
      sidechainRoutes: sidechainRoutes(),
      ensureClipBuffer: clipBuffers.preload,
      onClose: () => setExportOpen(false),
    },
  });

  return (
    <div
      ref={(el) => {
        rootRef = el;
      }}
      class="h-full w-full flex flex-col bg-background text-foreground"
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
        onOpenChange={(open) => {
          if (!open) localProject.setCloudBackupDialog(null);
        }}
        onOverwriteCloud={localProject.overwriteCloudBackup}
        onRestoreCloud={localProject.confirmRestoreCloudBackup}
        onDuplicateCloud={localProject.duplicateCloudBackup}
      />

      <AppMessageDialog
        state={appMessage()}
        onOpenChange={(open) => {
          if (!open) setAppMessage(null);
        }}
      />

      <TimelineWorkspace
        containerRef={(el) => {
          containerRef = el;
        }}
        returnSectionRef={(el) => {
          returnSectionRef = el;
        }}
        masterTimelineRef={(el) => {
          masterTimelineRef = el;
        }}
        timelineSurfaceRef={(el) => {
          timelineSurfaceRef = el;
        }}
        scrollRef={(el) => {
          scrollRef = el;
          setScrollElement(el);
          timelineViewport.bind(el);
        }}
        bottomPanelOffsetPx={bottomPanel.bottomPanelOffsetPx()}
        leftBrowser={timelineBrowser()}
        durationSec={duration()}
        pixelsPerSecond={pixelsPerSecond()}
        viewport={{
          visibleRange: timelineViewport.visibleRange(),
          width: timelineViewport.usableWidth(),
          previewVisibleRange: timelineViewport.previewVisibleRange,
          commitVisibleRange: timelineViewport.commitVisibleRange,
          onWheel: timelineViewport.onWheel,
        }}
        sidebarWidth={sidebarWidth()}
        tracks={renderTracks()}
        dropAtNewTrack={dropAtNewTrack() || browserDropAtNewTrack()}
        dropTargetLane={browserDropTargetLane() ?? dropTargetLane()}
        browserDropTargetTrackId={browserDropTargetTrackId()}
        bpm={bpm()}
        gridDenominator={gridDenominator()}
        gridEnabled={gridEnabled()}
        loopEnabled={loopEnabled()}
        loopStartSec={loopStartSec()}
        loopEndSec={loopEndSec()}
        playheadSec={playheadSec()}
        onSetLoopRegion={(s, e) => setLoopRegion(s, e)}
        onLanePointerDown={handleLanePointerDown}
        onReturnPointerDown={handleReturnPointerDown}
        onMasterPointerDown={handleMasterPointerDown}
        onRulerPointerDown={onRulerPointerDown}
        selection={selection}
        onClipPointerDown={onClipPointerDown}
        onClipPointerUp={onClipPointerUp}
        onClipResizeStart={onClipResizeStart}
        canEditClipFades={canWriteClip}
        onCommitClipFades={commitClipFades}
        onAddMidiClipToTrack={addFourBarMidiClipToTrack}
        onDeleteTrack={requestDeleteTrack}
        clipContextMenu={{
          selectClip: (trackId, clipId) =>
            selection.selectPrimaryClip({ trackId, clipId }),
          duplicateSelectedClips: () => {
            void duplicateSelectedClips();
          },
          deleteSelectedClips: () => {
            void deleteSelectedClips();
          },
        }}
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
          )
            return;
          selection.selectPrimaryClip({ trackId: match.trackId, clipId });
          bottomPanel.setMode("sample-detail");
          bottomPanel.setOpen(true);
        }}
        marqueeRect={marqueeRect()}
        marqueeSurface={marqueeSurface()}
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
          canWrite: canWriteClip(midiEditorClipId() ?? ''),
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
            collapsed: masterCollapsed(),
            onClick: () => {
              bottomPanel.setMode("effects");
              bottomPanel.setOpen(true);
              selection.selectMasterTarget();
            },
            onToggleCollapsed: () =>
              setMasterCollapsed((collapsed) => !collapsed),
            onVolumePreview: (volume) => {
              automation.overrideTarget(
                automationTargetKey({ kind: "master" }, "volume"),
              );
              masterVolume.previewVolume(volume);
            },
            onVolumeChange: (volume) => {
              automation.overrideTarget(
                automationTargetKey({ kind: "master" }, "volume"),
              );
              masterVolume.commitVolume(volume);
            },
          },
          subscribeTrackLevels: (listener) =>
            subscribeTrackLevels(listener),
          subscribeMasterLevels: (listener) =>
            subscribeMasterLevels(listener),
          onTrackClick: (id) => {
            bottomPanel.setMode("effects");
            bottomPanel.setOpen(true);
            selection.selectTrackTarget(id, { clearClipSelection: true });
          },
          canWriteTrackRouting: canWriteTrack,
          onTrackSendsChange: updateTrackSends,
          onTrackOutputTargetChange: updateTrackOutputTargetId,
          onVolumePreview: (trackId, volume, muted) => {
            automation.overrideTarget(
              automationTargetKey({ kind: "track", trackId }, "volume"),
            );
            audioEngine.previewTrackVolume(trackId, volume, muted);
          },
          onVolumeChange: (trackId, volume) => {
            automation.overrideTarget(
              automationTargetKey({ kind: "track", trackId }, "volume"),
            );
            setTrackVolume(trackId, volume);
          },
          onToggleMute: handleToggleTrackMute,
          onToggleSolo: handleToggleTrackSolo,
          onSidebarPointerDown,
          onToggleRecordArm: handleToggleRecordArm,
          onDeleteTrack: requestDeleteTrack,
          onToggleTrackCollapsed: toggleTrackCollapsed,
          onSetTracksCollapsed: setTracksCollapsed,
          onGroupTracks: groupSelectedTracks,
          onUngroupTrack: ungroupTrack,
          onMoveTrackToGroup: moveTrackToGroup,
          onReorderTracks: reorderTracks,
          onSetTrackColor: setTrackColor,
          onResetTrackColor: resetTrackColor,
          onAssignTrackColorToClips: assignTrackColorToClips,
          onResetClipColors: resetClipColors,
          onSelectAllClipsInGroup: selectAllClipsInGroup,
        }}
        automation={automation.workspace()}
        trackLayout={trackLayoutModel()}
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
