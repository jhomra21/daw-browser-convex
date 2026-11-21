import {
  type Accessor,
  type Component,
  type JSX,
  createComputed,
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
import { replaceEqualDeep } from "@tanstack/solid-query";
import { useTimelineClipImport } from "~/hooks/useTimelineClipImport";
import { useTimelineClipActions } from "~/hooks/useTimelineClipActions";
import { convexClient, convexApi } from "~/lib/convex";
import { useTimelineData } from "~/hooks/useTimelineData";
import {
  createProjectFromDashboard as createDashboardProject,
  openProjectFromDashboard as openDashboardProject,
} from "~/hooks/useTimelineProjectRoute";
import { usePlayheadControls } from "~/hooks/usePlayheadControls";
import type { TimelineEditIntent } from "~/hooks/timeline-playback-types";
import type { NativeInstrumentRetryIdentity } from "~/lib/sampler-buffer-sync";
import { useClipDrag } from "~/hooks/useClipDrag";
import { useClipResize } from "~/hooks/useClipResize";
import { useTimelineSelection } from "~/hooks/useTimelineSelection";
import { useClipBuffers } from "~/hooks/useClipBuffers";
import {
  collectTrackDescendantIds,
  isAudioEffectKind,
  isLocalId,
  normalizeTrackInstrumentParams,
  automationTargetKey,
  createAutomationTarget,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
import { createAudioEffectParameterPayload } from "~/lib/audio-effect-parameter-payload";
import { useTimelineResolvedModel } from "~/hooks/useTimelineResolvedModel";
import { useTimelineActions } from "~/hooks/useTimelineActions";
import { useTimelineSidebarResize } from "~/hooks/useTimelineSidebarResize";
import { useTrackRecording } from "~/hooks/useTrackRecording";
import { createRecordingTransportPolicy } from "~/hooks/recording-dispatch";
import { createRecordingTargetLock } from "~/lib/track-recording-target";
import { useMidiTrackRecording } from "~/hooks/useMidiTrackRecording";
import { buildClipFadesHistoryEntry, buildClipMidiNotesHistoryEntry } from "~/lib/undo/builders";
import type { MidiEditorNote } from "~/lib/midi-editor-grid";
import createTimelineEffectCommit from "~/components/timeline/create-timeline-effect-commit";
import { createProcessorEditRegistry } from "~/components/timeline/create-processor-edit-registry";
import { createPlaybackSnapshotCompiler } from "~/components/timeline/create-playback-snapshot-compiler";
import { createNativeOfflineExternalAttachments } from "~/components/timeline/native-offline-external-attachments";
import { pickNativePlaybackInputs } from "~/components/timeline/native-playback-inputs";
import {
  createApplyPortableProcessor,
  createInstrumentPlaybackChange,
  createMixedReorderCommitted,
  createSyncPlaybackBackend,
} from "~/components/timeline/timeline-playback-wiring";
import { desktopAcceptanceObserver } from "~/lib/desktop/acceptance-observer";
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
import { useTimelineFollow } from "~/hooks/useTimelineFollow";
import { BrowserDragOverlay } from "./timeline/browser/browser-drag-overlay";
import {
  browserDropTargetTrackId as getBrowserDropTargetTrackId,
  type BrowserDragPayload,
  type BrowserDropTarget,
} from "~/lib/timeline-browser/browser-drag-types";
import type { TimelineDeviceInsertActions } from "~/lib/timeline-device-insert-actions";
import type { AudioEffectChainPreset } from "~/lib/audio-effect-chain-presets";
import type { InstrumentPreset } from "~/lib/instrument-presets";
import { useTimelineSampleDetailController } from "~/hooks/useTimelineSampleDetailController";
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
import {
  createCapturedEditorStatePersister,
  createExternalProcessorEditorRequests,
} from "~/components/timeline/external-processor-editor-requests";
import {
  type CapturedLocalExternalProcessorState,
  createLocalExternalProcessorCache,
  listLocalExternalProcessors,
  persistLocalExternalProcessorState,
} from "~/lib/external-plugins";
import { localVstStateOwnerId } from "~/lib/external-plugin-artifacts";
import TimelineChrome from "./timeline/timeline-chrome";
import AppMessageDialog, {
  type AppMessageDialogState,
} from "./timeline/app-message-dialog";
import CloudBackupDialog from "./timeline/cloud-backup-dialog";
import DeleteTrackDialog from "./timeline/delete-track-dialog";
import TimelineWorkspace from "./timeline/timeline-workspace";
import { Dashboard } from "~/components/dashboard/dashboard";
import type { DashboardTimelineModel } from "~/components/dashboard/types";
import type { DashboardView } from "~/lib/dashboard-view";
import {
  buildTimelineTrackLayout,
  buildTrackTree,
  computeDepthMap,
  flattenVisibleTracks,
  reuseTimelineTrackLayout,
  type TimelineTrackLayout,
} from "~/lib/timeline-track-layout";
import { useAppPreferences } from "~/context/app-preferences";
import { deriveSelectedExportTrackIds } from "~/lib/export/export-settings";
import { createTimelineClipWriteAdapter } from "~/lib/timeline-clip-write-adapter";
import { applyCreatedTrackInsertion } from "~/lib/timeline-track-creation-rollback";
import { createAttachedHostController, registerAttachedHostController } from "~/lib/desktop/attached-host-controller";
import { createNativeVstParameterQueue } from "~/lib/desktop/native-vst-parameter-queue";
import { createNativeVstStateCapture } from "~/lib/desktop/native-vst-state-capture";
import { createVstParameterFeedbackController } from "~/lib/desktop/vst-parameter-feedback-controller";
import { createExportQueue } from "~/lib/export/export-queue";
import { createImportJobQueue } from "~/lib/desktop/import-job-queue";
import { createTimelineExportService } from "~/lib/export/timeline-export-service";
import { resolveDesiredPlaybackFx, type ExportAutomationPatch } from "~/lib/desired-playback-state";
import { createDesktopNativeOfflinePcmRenderer } from "~/lib/export/desktop-native-offline-pcm-renderer";
import { compileDesiredNativeProcessorState } from "~/lib/live-playback-snapshot";
import { createTimelineExtensionHost } from "~/lib/extensions";
import { createSampledInstrumentSession } from "~/lib/sampled-instrument-session";
import { createAudioPcmSourceResolver } from "~/lib/audio-pcm-source-resolver";
import { isEventFromDomDescendant } from "~/lib/pointer-event-target";
import { desktopBridge, isDesktopRenderer } from "~/lib/runtime";

type TimelineProps = {
  bootstrapIfEmpty: boolean;
  dashboardEnabled: boolean;
  dashboardView: Accessor<DashboardView | null>;
  setDashboardParam: (view: DashboardView | null) => void;
};

const Timeline: Component<TimelineProps> = (props) => {
  // Electron audio is native-only; browser Web Audio is never a desktop fallback.
  const requiresNativeAudio = isDesktopRenderer();
  const acceptance = desktopAcceptanceObserver(desktopBridge());
  const navigate = useNavigate();
  const exportQueue = createExportQueue();
  const importQueue = createImportJobQueue();
  onCleanup(exportQueue.dispose);

  const nativeOfflineBridge = requiresNativeAudio
    ? desktopBridge()?.audioHost?.offlineRender
    : undefined;

  const nativeOfflinePcmRenderer = nativeOfflineBridge
    ? createDesktopNativeOfflinePcmRenderer(nativeOfflineBridge)
    : undefined;

  const nativeVstParameterQueue = desktopBridge()
    ? createNativeVstParameterQueue(async (bytes) => {
        const queue = desktopBridge()?.audioHost?.session.queueVstParameterEvents;

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

  let vst3ScanPromise: Promise<void> | undefined;

  const scanVst3Catalog = async () => {
    if (vst3ScanPromise) return vst3ScanPromise;

    const scan = async () => {
      const bridge = desktopBridge()?.pluginCatalog;

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
    };

    const promise = scan();
    vst3ScanPromise = promise;

    try {
      await promise;
    } finally {
      vst3ScanPromise = undefined;
    }
  };

  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<
    Track["id"] | null
  >(null);

  const [activeMidiRecordingTargetId, setActiveMidiRecordingTargetId] =
    createSignal<string | null>(null);

  const [provisionalMidiClipId, setProvisionalMidiClipId] =
    createSignal<string | null>(null);

  // Bound once during setup after the recording hook, before effects run.
  let recordingKeepLatencyNodeIds: () => ReadonlySet<string> = () => new Set();
  let isTakeInProgress: () => boolean = () => false;
  const [masterCollapsed, setMasterCollapsed] = createSignal(true);
  // Transport tempo & metronome
  const [metronomeEnabled, setMetronomeEnabled] = createSignal(false);
  const [exportOpen, setExportOpen] = createSignal(false);
  const [followPaused, setFollowPaused] = createSignal(false);
  // Audio engine
  const audioEngine = getAudioEngine();
  const appPreferences = useAppPreferences();

  // Collaboration: projectId from ?projectId=; ownership tied to Better Auth userId
  const notify = (title: string, message: string) => {
    setAppMessage({ title, message });
  };

  let timelineViewportStartSec = () => 0;
  let setTimelineVisibleStart = (_startSec: number) => {};

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

  const resolveAudioSource = createAudioPcmSourceResolver({ projectId });

  const sampledInstrumentSession = createSampledInstrumentSession({
    projectId,
    nativeAudio: () => requiresNativeAudio,
    nativeMemoryPolicy: desktopBridge()?.audioHost?.instrumentBudgetPolicy,
  });

  onCleanup(sampledInstrumentSession.dispose);

  const localProject = useLocalProjectActions({
    projectId,
    userId,
    navigateToRoom,
    notify,
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
  const recordingTargetLock = createRecordingTargetLock(renderTracks);
  onCleanup(recordingTargetLock.release);
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
    resolveAudioSource,
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
    ensureMountedLocalMedia,
  } = useTimelinePersistenceController({
    projectId,
    mountedProjectGeneration,
    remoteTimelineAvailable: () => Boolean(fullView.data),
    localProjectMode: currentLocalProjectMode,
    userId,
    renderTracks,
    audioEngine,
    audioBufferCache: clipBuffers.writer,
    preloadClipBuffer: clipBuffers.preload,
    getClipBuffer: clipBuffers.getBuffer,
    localProject,
    projection,
    selection,
    notify,
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
  let getPlaybackAutomationPatches: () => ExportAutomationPatch[] = () => [];
  const processorEdits = createProcessorEditRegistry(bpm);

  const desiredFx = createMemo(() => {
    const data = fullView.data;

    return resolveDesiredPlaybackFx(
      { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
      effectsExportSnapshot()?.snapshotEffectsProjection(),
      data ? { effects: data.effects, automationEnvelopes: data.automationEnvelopes } : undefined,
    );
  });

  // Capture identity at the effective-projection boundary, before any compile or
  // dispatch reads the desired order. Own writes already hold their identity. A
  // new mounted project or generation clears membership before its projection
  // is adopted.
  let observedScope: string | undefined;
  createComputed(() => {
    const scope = `${projectId()}:${mountedProjectGeneration()}`;
    const fx = desiredFx();
    untrack(() => {
      if (scope !== observedScope) {
        processorEdits.reset();
        observedScope = scope;
      }

      processorEdits.observe(fx);
    });
  });

  const nativePlaybackInputs = createMemo(() => pickNativePlaybackInputs({
    timeSignature: {
      numerator: fullView.data?.project.timeSignatureNumerator ?? 4,
      denominator: fullView.data?.project.timeSignatureDenominator ?? 4,
    },
    automationEnvelopes: fullView.data?.automationEnvelopes,
    masterVolume: masterVolume.volume(),
    automation: getPlaybackAutomationPatches(),
    sidechains: effectsExportSnapshot()?.snapshotSidechainRoutes() ?? sidechainRoutes(),
    processorStructure: processorEdits.structure(),
  }), undefined, { equals: (previous, next) => replaceEqualDeep(previous, next) === previous });

  let nativePlaybackRevision = 1;
  const localExternalProcessors = createLocalExternalProcessorCache();
  onCleanup(localExternalProcessors.dispose);

  const compilePlaybackSnapshot = createPlaybackSnapshotCompiler({
    projectId,
    userId,
    fullView,
    renderTracks,
    bpm,
    sidechainRoutes,
    masterVolume,
    effectsExportSnapshot,
    processorEdits,
    localExternalProcessors,
    playbackRevision: () => nativePlaybackRevision,
  });

  const exportService = createTimelineExportService({
    queue: exportQueue,
    nativeRendererRequired: requiresNativeAudio,
    nativeOfflinePcmRenderer,
    getNativeOfflineExternalAttachments: createNativeOfflineExternalAttachments(userId),
    getTracks: renderTracks,
    getProjectGeneration: mountedProjectGeneration,
    createBuffer: (channels, frames, sampleRate) => (
      audioEngine.getAudioContext?.()?.createBuffer(channels, frames, sampleRate)
      ?? new AudioBuffer({ numberOfChannels: channels, length: frames, sampleRate })
    ),
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
    resolveAudioSource,
    sampledInstrumentSession,
  });

  const [replayEffectInstanceParams, setReplayEffectInstanceParams] =
    createSignal<EffectsPanelAudioEffects["replayInstanceParams"]>();

  let historyActions: TimelineHistoryActions | undefined = undefined;

  const { pushHistory, handleUndo, handleRedo, canUndo, canRedo } = useTimelineHistory({
    acceptance,
    projectId,
    userId,
    getTracks: renderTracks,
    convexClient,
    convexApi,
    replayInstanceEffectParams: (payload) =>
      replayEffectInstanceParams()?.(payload) ?? false,
    releaseInstanceEffectEdit: processorEdits.release,
    reserveInstanceEffectEdit: ({ targetId, effect, instanceId, params }) => {
      if (effect === "instrument") {
        const instrument = normalizeTrackInstrumentParams(params);

        return instrument && processorEdits.reserve({ targetId, effect, from: instrument, to: instrument });
      }

      const kind = effect.replace(/^master-/, "");

      return instanceId && isAudioEffectKind(kind)
        ? processorEdits.reserve(createAudioEffectParameterPayload({ targetId, instanceId, kind }, params, params))
        : undefined;
    },
    ensureClipBuffer: clipBuffers.preload,
    grantTrackWrite,
    grantClipWrite,
    notify,
    recordingTargetLock,
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
    isPlayPending,
    isStructuralRebuildInProgress,
    preparedInstrument,
    isPreparingPlayback,
    isNativePlaybackPrepared,
    schedulerDiagnostics,
    isPortableBrowserPlaybackPrepared,
    deliverProcessor,
    joinPublication,
    liveProcessorControl,
    reenableProcessorAutomation,
    usesLegacyAudioEngine,
    playheadSec,
    handlePause,
    handleStop,
    reserveStop,
    updateNativeLoop,
    setPlayhead,
    requestPlay,
    startScrub,
    moveScrub,
    stopScrub,
    setScrollElement,
    rescheduleChangedClips: playbackRescheduleChangedClips,
    restartTimelineSchedule,
    awaitPlaybackPreparation,
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
    bpm,
    resolveAudioSource,
    loopEnabled,
    loopStartSec,
    loopEndSec,
    pixelsPerSecond,
    visibleStartSec: () => timelineViewportStartSec(),
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
      acceptance,
      enabled: () => requiresNativeAudio || appPreferences.audio.preferences().nativePlaybackEnabled,
      projectId,
      projectGeneration: mountedProjectGeneration,
      outputDeviceId: () => appPreferences.audio.preferences().nativeOutputDeviceId,
      isRecording: () => isTakeInProgress(),
      keepLatencyNodeIds: (): ReadonlySet<string> => {
        const ids = new Set(recordingKeepLatencyNodeIds())
        const midiTarget = activeMidiRecordingTargetId()

        if (midiTarget) ids.add(midiTarget)

        return ids
      },
      compileSnapshot: (transport, context) => compilePlaybackSnapshot(transport, context, getPlaybackAutomationPatches),
      getProcessorTarget: processorEdits.target,
      getDesiredProcessorState: (snapshot, sampleRate) => compileDesiredNativeProcessorState(
        snapshot, sampleRate, processorEdits.sequence(), effectsExportSnapshot()?.snapshotEffectsProjection(),
        fullView.data ? { effects: fullView.data.effects, automationEnvelopes: fullView.data.automationEnvelopes } : undefined,
      ),
      // Read every reactive input used around the async compiler boundary.
      // Local adoption replaces the snapshot even for automation/effect-only commits.
      playbackInputs: nativePlaybackInputs,
      captureNativeVstStates: async ({ projectId: capturedProjectId, instanceIds }) => {
        const bridge = desktopBridge()?.audioHost?.session

        if (!bridge || instanceIds.length === 0) return

        if (!isLocalId("project", capturedProjectId)) return
        const processors = await listLocalExternalProcessors(capturedProjectId)

        for (const instanceId of instanceIds) {
          const processor = processors.find((candidate) => candidate.instanceId === instanceId)

          if (!processor?.manifest.supportsState) continue
          const capture = await bridge.captureVstState(instanceId)

          if (!capture.ok) throw new Error(`Native VST3 state capture failed for "${instanceId}": ${capture.error}`)
          await persistLocalExternalProcessorState(
            capturedProjectId,
            instanceId,
            capture,
            localVstStateOwnerId(capturedProjectId, userId()),
          )
        }
      },
      instrumentBudget: sampledInstrumentSession.aggregateBudget,
      onInstrumentPreparation: sampledInstrumentSession.setNativePreparation,
      reportFault: (fault) => {
        switch (fault.kind) {
          case "delivery-refused":
            notify("Effect change not applied to playback",
              `Native audio refused updates to ${fault.targets} device${fault.targets === 1 ? "" : "s"}. Your project keeps the change.`);

            return;
          case "delivery-unconfirmed":
            notify("Playback may not match your latest change",
              `Native audio did not confirm updates to ${fault.targets} device${fault.targets === 1 ? "" : "s"}.`);

            return;
          case "latency-unsupported":
            notify("Keep Latency unavailable", fault.message);

            return;
          case "session-stopped":
            break;
        }

        const { message } = fault;

        if (classifyNativeVst3PlaybackFault(message) === "launch-authorization-required") {
          setAppMessage({
            title: "Plug-in authorization required",
            message: "This project uses VST3 plug-ins that must be verified again before playback. Rescan your configured plug-in folders, then press Play again.",
            action: {
              label: "Rescan plug-ins",
              busyLabel: "Rescanning…",
              enabled: () => canUseVst3CatalogAction("scan", vst3TrustAcknowledged()),
              onAction: scanVst3Catalog,
            },
            cancelLabel: "Cancel",
            trustAcknowledgement: {
              acknowledged: vst3TrustAcknowledged,
              onChange: (acknowledged) => {
                setVst3TrustAcknowledged(acknowledged);

                if (!acknowledged) return;
                saveVst3TrustAcknowledgement(vst3TrustStorage);
                void scanVst3Catalog().catch((error) => {
                  setAppMessage((current) => current
                    ? {
                        ...current,
                        message: error instanceof Error
                          ? error.message
                          : "The plug-in catalog could not be updated.",
                      }
                    : current);
                });
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
      compileSnapshot: (transport, context) => compilePlaybackSnapshot(transport, context, getAutomationPatches),
      reportFault: (message) => notify("Portable browser playback stopped", message),
    },
  });

  createEffect(() => {
    loopEnabled();
    loopStartSec();
    loopEndSec();

    if (isNativePlaybackPrepared()) {
      void updateNativeLoop().catch((cause: unknown) => {
        console.error("[Timeline] failed to reconcile native loop settings", cause);
      });
    }
  });

  const captureStructuralPlaybackIntent = (): TimelineEditIntent => ({
    projectId: projectId(),
    projectGeneration: mountedProjectGeneration(),
  });

  // Nothing is prepared to adopt the edit, so the session it starts takes the transport as it is now.
  const rebuildPlaybackBackend = (
    tracks: Track[],
    intent: TimelineEditIntent,
    instrumentOverride?: { targetId: Track["id"]; instrument: TrackInstrumentParams },
  ) => {
    nativePlaybackRevision += 1;

    return restartTimelineSchedule(tracks, {
      ...intent,
      rebuildBackend: true,
      resumePlayback: isPlaying(),
      playheadSec: playheadSec(),
      instrumentOverride,
    });
  };

  const syncPlaybackBackend = createSyncPlaybackBackend({
    isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared, rebuildPlaybackBackend, restartTimelineSchedule,
    captureStructuralPlaybackIntent,
  });

  function rescheduleChangedClips(clipIds: string[]) {
    if (clipIds.length === 0) return;
    setFollowPaused(true);

    // A prepared session, native or browser, adopts a clip edit through the hook's follow.
    if (isNativePlaybackPrepared() || isPortableBrowserPlaybackPrepared()) return;

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
    setFollowPaused(true);

    // A prepared session, native or browser, adopts a structural edit through the hook's follow.
    if (isNativePlaybackPrepared() || isPortableBrowserPlaybackPrepared()) return;

    if (isPlaying()) restartTimelineSchedule(renderTracks()).catch((cause: unknown) => {
      console.error("[Timeline] failed to reschedule legacy playback", cause);
    });
  }

  const automation = useTimelineAutomationController({
    acceptance,
    projectId,
    userId,
    tracks: renderTracks,
    masterVolume: masterVolume.volume,
    masterReady: masterVolume.ready,
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
    onPersistenceError: (failedProjectId, error) => {
      localProject.setLocalSaveFailure(failedProjectId, error.message);
    },
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
  getPlaybackAutomationPatches = () => automation.snapshotPlaybackPatches();

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
    recordingTargetLock,
    notify,
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

  // Cloud clips update from the subscription. An overlay here would wait for the next server snapshot to clear.
  const handleLocalMidiSaved = (clipId: string, midi: Clip["midi"]) => {
    if (!isLocalId("project", projectId())) return;
    const match = trackLookup().clipEntryById.get(clipId);

    if (!match) return;
    projection.replaceLocalClip(match.trackId, {
      ...match.clip,
      midi,
    });
  };

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
    commitClipMidi: (clipId, midi) => handleLocalMidiSaved(clipId, midi),
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
    open: bottomPanel.open,
    setOpen: bottomPanel.setOpen,
    trackLookup,
    selection,
    canWriteClip,
    projection,
    audioWarpController,
    rescheduleChangedClips,
    pushHistory,
  });

  const handleMidiNotesEdited = (clipId: string, from: MidiEditorNote[], to: MidiEditorNote[]) => {
    const rid = projectId();
    const clip = trackLookup().clipById.get(clipId);

    if (!rid || !clip) return;
    const entry = buildClipMidiNotesHistoryEntry({ projectId: rid, clip, from, to });

    if (entry) pushHistory(entry);
  };

  const effectCommit = createTimelineEffectCommit({ projectId, tracks: renderTracks, pushHistory });

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
  const duration = createMemo(() => timelineDurationSec(renderTracks()));

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
    dockedMidiClipId: () =>
      bottomPanel.open() && bottomPanel.mode() === "clip-detail"
        ? (sampleDetail.selectedMidiClip()?.id ?? null)
        : null,
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
    recordingTargetLock,
    notify,
    automationEnvelopes: automation.envelopes,
    sidechainRoutes,
    applyAutomationEnvelope: automation.applyEnvelope,
    navigation: {
      trackLookup,
      selection,
      isPlaying,
      setPlayhead,
      openClipDetailFor: sampleDetail.openClipDetail,
      ensureClipBuffer: clipBuffers.preload,
      getScrollElement: () => scrollRef,
      visibleStartSec: () => timelineViewportStartSec(),
      setVisibleStartSec: (startSec) => setTimelineVisibleStart(startSec),
      pixelsPerSecond,
    },
  });

  const trackLayoutModel = createMemo((previous: TimelineTrackLayout | undefined) => {
    const lanes = automation.workspace().lanes;
    const tracks = renderTracks();
    const tree = buildTrackTree(tracks);

    const collapsedById = new Map(
      tracks.map((track) => [track.id, track.collapsed === true]),
    );

    const visibleTrackIds = flattenVisibleTracks(tree, collapsedById);

    const layout = buildTimelineTrackLayout({
      tracks,
      visibleTrackIds,
      depthByTrackId: computeDepthMap(tree),
      visibleByTrackId: lanes.visibleByTrackId,
      heightsByLaneOwnerKey: lanes.heightsByLaneOwnerKey,
      visibleParameterIdsByTrackId: lanes.visibleTargetKeysByTrackId,
    });

    return previous ? reuseTimelineTrackLayout(previous, layout) : layout;
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
    mountedProjectGeneration,
    userId,
    clipBuffers,
    getScrollElement: () => scrollRef,
    getFileInput: () => fileInputRef,
    bpm,
    gridEnabled,
    gridDenominator,
    pixelsPerSecond,
    visibleStartSec: () => timelineViewportStartSec(),
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
    notify,
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
    visibleStartSec: () => timelineViewportStartSec(),
    audioBufferCache: clipBuffers,
    onCommitMoves: (ids) => {
      rescheduleChangedClips(ids);
    },
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantWrite: grantTrackWrite,
    grantClipWrites,
    notify,
    onRangeSelectionPointerDown: (trackId, event) =>
      extendRangeSelectionToPointer(event, { element: scrollRef, trackId }),
  });

  const clipResize = useClipResize({
    tracks: resolvedTracks,
    draftClipTiming: (clipId) => projection.draftClipEditsById().get(clipId),
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
    visibleStartSec: () => timelineViewportStartSec(),
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
    canZoom: () => !clipDrag.isDragging() && !clipResize.isResizing(),
    onManualNavigation: () => setFollowPaused(true),
  });

  timelineViewportStartSec = () => timelineViewport.visibleRange().startSec;
  setTimelineVisibleStart = (startSec) => timelineViewport.setVisibleStart(startSec);

  const timelineFollow = useTimelineFollow({
    preferences: {
      follow: appPreferences.timeline.follow,
      setFollow: appPreferences.timeline.setFollow,
    },
    viewport: timelineViewport,
    playback: { isPlaying, playheadSec },
    gestureActive: () => clipDrag.isDragging() || clipResize.isResizing(),
    followPaused,
    setFollowPaused,
    scrollElement: () => scrollRef,
    pixelsPerSecond,
  });

  const toggleFollow = timelineFollow.toggle;

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
        notify("Fade save failed", "Clip fade could not be saved.");

        return;
      }

      pushHistory(buildClipFadesHistoryEntry({ projectId: rid, clip, from: baseline, to: fades }));
      rescheduleChangedClips([clipId]);
    } catch {
      rollback();
      notify("Fade save failed", "Clip fade could not be saved.");
    }
  };

  const {
    onClipPointerUp: selectClipOnPointerUp,
    deleteSelectedClips,
    duplicateSelectedClips,
    duplicateTimelineSelection,
    deleteTimelineSelection,
    copyTimelineSelection,
    pasteTimelineSelection,
    performDeleteTrack,
    requestDeleteTrack,
    hasWritableSelectedClips,
    hasWritableClips,
    selectAllTimelineClips,
    hasTimelineClipboard,
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
    recordingTargetLock,
    notify,
  });

  // Like Ableton's Detail View, a plain click on a clip shows it in an open bottom panel. A press with a modifier, a
  // drag, or a resize does not count. Pointer capture sends a drag's release to the clip, so the release must land
  // at the press position to count as a click.
  let plainClipPress: { trackId: string; clipId: string; x: number; y: number } | undefined;

  const onClipPointerDown = (trackId: string, clipId: string, event: PointerEvent) => {
    plainClipPress = event.shiftKey || event.ctrlKey || event.metaKey
      ? undefined
      : { trackId, clipId, x: event.clientX, y: event.clientY };
    clipDrag.onClipPointerDown(trackId, clipId, event);
  };

  const onClipPointerUp = (trackId: string, clipId: string, event: PointerEvent) => {
    const press = plainClipPress;
    plainClipPress = undefined;
    selectClipOnPointerUp(trackId, clipId, event);

    if (!press || press.trackId !== trackId || press.clipId !== clipId) return;

    if (event.clientX !== press.x || event.clientY !== press.y) return;
    setFollowPaused(false);

    if (bottomPanel.open()) sampleDetail.openClipDetail(clipId);
  };

  const timelineSelection = useTimelineSelection({
    tracks: renderTracks,
    trackLayout,
    displayTrackIds: () => trackLayoutModel().displayTrackIds,
    selection,
    bpm,
    gridDenominator,
    pixelsPerSecond,
    visibleStartSec: () => timelineViewport.visibleRange().startSec,
    isPlaying,
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
    if (!isEventFromDomDescendant(event)) return;

    if (event.button !== 0) return;
    setFollowPaused(false);
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
    targetLock: recordingTargetLock,
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
    notify: (message) => notify("Recording", message),
    onLocalSaveFailed: localProject.setLocalSaveFailure,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    grantClipWrite,
    audioPreferences: appPreferences.audio.preferences,
    recordingPreferences: appPreferences.recording.preferences,
  });

  recordingKeepLatencyNodeIds = recordingControls.keepLatencyNodeIds;

  const {
    isRecording: isAudioRecording,
    isStarting: audioRecordingStarting,
    recordArmTrackId,
    toggleRecordArm: handleToggleRecordArm,
    reconcileRecordArm,
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
    createTrackForRecording: async () =>
      await createTimelineTrack({ kind: "instrument" }, { pushHistory: false, select: false }),
    insertLocalClip: projection.insertLocalClip,
    removeLocalClips: projection.removeLocalClips,
    removeLocalTrack: projection.removeLocalTrack,
    clearRecordArmForTrack: recordingControls.clearRecordArmForTrack,
    convexClient,
    convexApi,
    selection,
    requestTransportPlay: requestPlay,
    pauseTransport: handlePause,
    notify: (message) => notify("MIDI recording", message),
    onLocalSaveFailed: localProject.setLocalSaveFailure,
    historyPush: (entry, key, win) => pushHistory(entry, key, win),
    setActiveRecordingTarget: setActiveMidiRecordingTargetId,
    setProvisionalClipId: setProvisionalMidiClipId,
    targetLock: recordingTargetLock,
  });

  const recordingTransport = createRecordingTransportPolicy({
    audio: recordingControls,
    midi: midiRecording,
    playback: { isPlaying, play: requestPlay, pause: handlePause, reserveStop },
    armedTrack: () => renderTracks().find((track) => track.id === recordArmTrackId()),
    notify,
    project: {
      id: projectId,
      provisionalClipId: provisionalMidiClipId,
      cancelImports: () => importQueue.cancelAll(),
      navigate: navigateToRoom,
    },
  });

  setProjectTransitionSettlement(() => recordingTransport.leaveProject());
  onCleanup(() => setProjectTransitionSettlement(undefined));
  const isRecording = createMemo(() => isAudioRecording() || midiRecording.isRecording());
  isTakeInProgress = isRecording;
  const recordingTrackId = createMemo(() => recordingControls.recordingTrackId() ?? midiRecording.recordingTrackId());
  const stopRecording = recordingTransport.stopRecording;

  // A take keeps running through a delete; the lock refuses a delete of its own track.
  const deleteTimelineSelectionSafely = async () => {
    if (provisionalMidiClipId() !== null && !isRecording()) return;
    await deleteTimelineSelection();
  };

  const toggleLoopSafely = () => {
    if (midiRecording.isRecording() || midiRecording.hasPendingCleanup()) {
      notify("Loop unavailable", "Stop MIDI recording before enabling loop.");

      return;
    }

    setLoopEnabled((prev) => !prev);

    // A prepared browser or native session adopts the toggle through the loop in its desired schedule.
    if (!isPortableBrowserPlaybackPrepared() && isPlaying() && !isNativePlaybackPrepared()) {
      void restartTimelineSchedule(renderTracks()).catch((cause: unknown) => {
        console.error("[Timeline] failed to reschedule loop playback", cause);
      });
    }
  };

  const openProject = recordingTransport.leaveProject;
  const dashboardProjectRequest = { current: 0 };

  const openProjectFromDashboard = (nextProjectId: string) => openDashboardProject({
    nextProjectId,
    open: () => openProject(nextProjectId),
    mountedProjectId: projectId,
    closeDashboard: () => props.setDashboardParam(null),
    latestRequest: dashboardProjectRequest,
  });

  const createProjectFromDashboard = () => createDashboardProject({
    create: createProject,
    closeDashboard: () => props.setDashboardParam(null),
    latestRequest: dashboardProjectRequest,
  });

  const toggleRecording = recordingTransport.record;
  const handleTransportPause = recordingTransport.pause;
  const handleTransportStop = recordingTransport.stop;

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
    onSpace: recordingTransport.space,
    onDelete: () => {
      // Recording settlement already reported any failure before rejecting.
      deleteTimelineSelectionSafely().catch(() => undefined);
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
    onToggleFollow: toggleFollow,
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
    if (!isEventFromDomDescendant(event)) return;

    if (event.button !== 0) return;

    if (
      event.target instanceof Element &&
      event.target.closest('[data-timeline-ruler="1"]')
    )
      return;
    setFollowPaused(false);
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
    if (!isEventFromDomDescendant(event)) return;

    if (event.button !== 0) return;
    setFollowPaused(false);
    event.stopPropagation();
    bottomPanel.setMode("effects");
    selection.selectMasterTarget();
    startScrub(event.clientX);
  };

  const addFourBarMidiClipToTrack = (trackId: Track["id"], startSec: number) => {
    const actions = deviceInsertActions();

    if (!actions?.canAddMidiClipToTarget(trackId)) return;
    const secondsPerBeat = 60 / Math.max(1e-6, bpm());
    void actions.addMidiClipToTarget(trackId, {
      durationSec: secondsPerBeat * 16,
      startSec,
    });
  };

  const onRulerPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    // Resolve the locate against the viewport the user clicked before Follow
    // can recenter it around the previous playback position.
    startScrub(event.clientX);
    setFollowPaused(false);
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

  const persistVstState = (
    ownerProjectId: string,
    instanceId: string,
    state: CapturedLocalExternalProcessorState,
  ) => persistLocalExternalProcessorState(ownerProjectId, instanceId, state, localVstStateOwnerId(ownerProjectId, userId()));

  const externalEditorRequests = createExternalProcessorEditorRequests({
    projectId,
    mountedProjectGeneration,
    openEffectsForTarget,
    captureStructuralPlaybackIntent,
    syncPlaybackBackend,
    renderTracks,
    nativePlaybackEnabled: () => appPreferences.audio.preferences().nativePlaybackEnabled,
    captureVstState: async (instanceId) => desktopBridge()?.audioHost?.session.captureVstState(instanceId),
    persistState: persistVstState,
  });

  const timelineBrowser = useTimelineBrowserController({
    acceptance,
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
    onExternalPluginInserted: externalEditorRequests.inserted,
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

  const captureNativeVstStates = async (capture?: { projectId: string; instanceIds: readonly string[] }) => {
    const bridge = desktopBridge()?.audioHost?.session

    if (!bridge || (capture === undefined && !isNativePlaybackPrepared())) return
    const capturedProjectId = capture?.projectId ?? projectId()

    if (!isLocalId("project", capturedProjectId)) return

    const processors = (await listLocalExternalProcessors(capturedProjectId))
      .filter((processor) => !processor.bypassed && processor.manifest.supportsState)

    const selected = capture === undefined
      ? processors
      : processors.filter((processor) => capture.instanceIds.includes(processor.instanceId))

    for (const processor of selected) {
      const capture = await bridge.captureVstState(processor.instanceId)

      if (!capture.ok) {
        throw new Error(`Native VST3 state capture failed for "${processor.instanceId}": ${capture.error}`)
      }

      await persistLocalExternalProcessorState(
        capturedProjectId,
        processor.instanceId,
        capture,
        localVstStateOwnerId(capturedProjectId, userId()),
      )
    }
  }

  // Only a live playback session can hold a parameter change the plug-in's saved state has not seen.
  const requestNativeVstStateCapture = createNativeVstStateCapture({
    capture: async (instanceId) => {
      if (isNativePlaybackPrepared()) await captureNativeVstStates({ projectId: projectId(), instanceIds: [instanceId] })
    },
    report: (_instanceId, error) => notify("Plug-in state not saved", error.message),
  })

  const nativeBridge = desktopBridge();

  if (nativeBridge) {
    const unsubscribeCapturedEditorState = nativeBridge.audioHost?.onVstEditorCapturedState(
      createCapturedEditorStatePersister(persistVstState),
    );

    if (unsubscribeCapturedEditorState) onCleanup(unsubscribeCapturedEditorState);

    // The playback worker owns a plug-in's state while a session is prepared, and an editor closing is a
    // persistence point (the editor session never reads such an instance).
    const unsubscribeEditorState = nativeBridge.audioHost?.onVstEditorState((payload) => {
      if (!payload.open && payload.projectId === projectId()) requestNativeVstStateCapture(payload.instanceId);
    });

    if (unsubscribeEditorState) onCleanup(unsubscribeEditorState);

    const unregisterHostController = registerAttachedHostController(createAttachedHostController({
      acceptance,
      projectId,
      mountedProjectGeneration,
      isPlaying,
      playheadSec,
      tracks: renderTracks,
      audioEngine,
      schedulerDiagnostics,
      requestPlay,
      pause: handleTransportPause,
      stop: handleTransportStop,
      finishRecording: async () => {
        if (isRecording()) await stopRecording();
      },
      refuseRecordingTargetChange: recordingTargetLock.refuseTransition,
      captureNativeVstStates,
      requestNativeVstStateCapture,
      exportQueue,
      importQueue,
      exportService,
      importFiles,
      enqueueNativeVstParameter: nativeVstParameterQueue?.enqueue,
      // Without a prepared session nothing sounds, and the saved value replays when one is prepared.
      reportUndeliveredNativeVstParameters: () => {
        if (isNativePlaybackPrepared()) notify("Plug-in parameter not applied", "The host refused a plug-in parameter change. It is saved and applies the next time playback is prepared.");
      },
      hasReflectableOverlays: projection.hasReflectableOverlays,
      reconcileMountedLocalTimeline,
      ensureMountedLocalMedia,
      isMountedLocalMediaReady: mediaRecovery.mountedLocalMediaReady,
      setPlayhead: (seconds) => setPlayhead(seconds, renderTracks()),
    }));

    onCleanup(unregisterHostController);
  }

  createEffect(() => {
    const nextTracks = resolvedTracks();
    reconcileRecordArm(nextTracks);
  });

  // Mirrors the actions: selected clips must be writable, and delete reaches the track only when no clips are selected.
  const canDuplicateSelection = createMemo(() =>
    selection.rangeSelection() !== null || hasWritableSelectedClips(),
  );

  const canSelectAllClips = createMemo(() => hasWritableClips());

  const canDeleteSelection = createMemo(() => {
    if (provisionalMidiClipId() !== null && !isRecording()) return false;

    if (selection.rangeSelection() !== null) return true;

    if (selection.selectedClipIds().size > 0) return hasWritableSelectedClips();

    return selection.selectedTrackId() !== "";
  });

  const transportProps = () => ({
    isPlaying: isPlaying(),
    isPlayPending: isPlayPending(),
    playheadSec: playheadSec(),
    onPlay: recordingTransport.play,
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
      onOpenProject: openProjectFromDashboard,
      onCreateProject: createProjectFromDashboard,
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
      saveFailed: localProject.localSaveFailure() !== null,
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
    followEnabled: appPreferences.timeline.follow(),
    onToggleFollow: toggleFollow,
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
    isRecordingPending: audioRecordingStarting() || midiRecording.isStarting(),
    onToggleRecord: toggleRecording,
    onUndo: handleUndo,
    onRedo: handleRedo,
    canUndo: canUndo(),
    canRedo: canRedo(),
    canDuplicateSelection: canDuplicateSelection(),
    canDeleteSelection: canDeleteSelection(),
    // Copy uses the same predicate as duplicate: a range or a writable selected clip.
    canCopySelection: canDuplicateSelection(),
    canPasteSelection: hasTimelineClipboard(),
    canSelectAllClips: canSelectAllClips(),
    automationOverrideCount: automation.overrideCount(),
    onReEnableAutomation: automation.reEnable,
    onDeleteSelection: () => {
      // Recording settlement already reported any failure before rejecting.
      deleteTimelineSelectionSafely().catch(() => undefined);
    },
    onDuplicateSelection: () => {
      void duplicateTimelineSelection();
    },
    onCopySelection: () => {
      copyTimelineSelection();
    },
    onPasteSelection: () => {
      pasteTimelineSelection();
    },
    onSelectAllClips: selectAllTimelineClips,
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

  const onStructuralPlaybackChange = createInstrumentPlaybackChange({
    mountedProjectGeneration, awaitPlaybackPreparation, preparedInstrument, isStructuralRebuildInProgress,
    isPreparingPlayback, isPlaying, isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared,
    syncPlaybackBackend, renderTracks, captureStructuralPlaybackIntent,
  });

  const applyPortableProcessor = createApplyPortableProcessor({
    liveProcessorControl, isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared, syncPlaybackBackend, renderTracks,
  });

  const onMixedReorderCommitted = createMixedReorderCommitted({
    isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared, isPlaying, syncPlaybackBackend, renderTracks,
    captureStructuralPlaybackIntent,
  });

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
      acceptance,
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
          bottomPanel.setMode("clip-detail");
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
      samplerBufferSync: sampledInstrumentSession.samplerBufferSync,
      drumRackBufferSync: sampledInstrumentSession.drumRackBufferSync,
      retryNativeInstrumentPreparation: async (identity: NativeInstrumentRetryIdentity) => {
        if (projectId() !== identity.projectId) return;
        await restartTimelineSchedule(renderTracks(), {
          rebuildBackend: true,
          resumePlayback: isPlaying(),
          playheadSec: playheadSec(),
          owner: "native",
          projectId: identity.projectId,
          projectGeneration: mountedProjectGeneration(),
        });
      },
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
      onEffectParamsCommitted: effectCommit.committed,
      onStructuralPlaybackChange,
      usesLegacyAudioEngine,
      projectGeneration: mountedProjectGeneration,
      allocateProcessorEdit: processorEdits.allocate,
      deliverProcessor,
      joinPublication,
      applyPortableProcessor,
      onPreviewNote: auditionNote,
      enqueueNativeVstParameter: nativeVstParameterQueue?.enqueue,
      requestNativeVstStateCapture,
      onEffectInstanceParamsReplayChange: (
        replay: EffectsPanelAudioEffects["replayInstanceParams"] | undefined,
      ) => setReplayEffectInstanceParams(() => replay),
      onLocalSaveFailed: localProject.setLocalSaveFailure,
      onEffectError: notify,
      onDeviceInsertActionsChange: setDeviceInsertActions,
      onExportSnapshotChange: setEffectsExportSnapshot,
      autoOpenExternalProcessorId: externalEditorRequests.autoOpenInstanceId(),
      onExternalProcessorAutoOpenHandled: externalEditorRequests.autoOpenHandled,
      captureStructuralPlaybackIntent,
      onExternalProcessorUpdated: (
        processor: ExternalProcessor,
        previous: ExternalProcessor,
        playbackIntent: TimelineEditIntent | undefined,
      ) => {
        if (processor.bypassed === previous.bypassed) return;

        // A prepared browser session adopts the bypass through the hook's follow.
        if (isPortableBrowserPlaybackPrepared() && !isNativePlaybackPrepared()) return;
        const intent = playbackIntent ?? captureStructuralPlaybackIntent();

        if (!isPlaying() && !isNativePlaybackPrepared()) return;
        void syncPlaybackBackend(renderTracks(), intent).catch((cause: unknown) => {
          console.error("[Timeline] failed to apply an external processor update to native playback", cause);
        });
      },
      onMixedReorderCommitted,
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
                createAutomationTarget({ kind: "master" }, effectInstanceId),
                parameterId,
              )
            : automationTargetKey(
                createAutomationTarget({ kind: "track", trackId: targetKey }, effectInstanceId),
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
      isOpen: bottomPanel.open() && bottomPanel.mode() === "clip-detail",
      selectedClip: sampleDetail.selectedAudioClip(),
      projectBpm: bpm(),
      audioEngine,
      bpmDetection: audioWarpController.bpmDetection,
      ensureClipBuffer: clipBuffers.preload,
      resolveAudioSource,
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
    midiClipPanel: {
      isOpen: bottomPanel.open() && bottomPanel.mode() === "clip-detail",
      clip: sampleDetail.selectedMidiClip(),
      bpm: bpm(),
      gridDenominator: gridDenominator(),
      trackId: selection.selectedClip()?.trackId,
      effectInstancesByOwnerKey: automation.workspace().lanes.effectInstancesByOwnerKey,
      userId: userId(),
      projectId: projectId(),
      canWriteClip: (clipId: string) =>
        clipId !== provisionalMidiClipId() && canWriteClip(clipId),
      onAuditionNote: auditionNote,
      midiKeyboard: { isActive: midiKeyboard.isActive },
      onLocalMidiSaved: handleLocalMidiSaved,
      onNotesEdited: handleMidiNotesEdited,
      onNoteDragStateChange: sampleDetail.setMarkerDragging,
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
        onExportArchive={isLocalId("project", projectId()) ? localProject.exportArchive : undefined}
        onDismissLocalSaveFailure={() => localProject.setLocalSaveFailure(projectId(), null)}
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
          ...timelineViewport.viewport(),
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
        resolveAudioSource={resolveAudioSource}
        replaceMissingMediaClip={mediaRecovery.replaceMissingMediaClip}
        removeMissingMediaClip={mediaRecovery.removeMissingMediaClip}
        trackLookup={trackLookup()}
        openClipDetailFor={sampleDetail.openClipDetail}
        marqueeRect={marqueeRect()}
        marqueeSurface={marqueeSurface()}
        recording={{
          // Preview samples must not invalidate sidebar consumers of record-arm state.
          get isRecording() { return isRecording(); },
          get previewStartSec() { return previewStartSec(); },
          get previewPoints() { return previewPoints(); },
          get recordingTrackId() { return recordingTrackId(); },
          get recordArmTrackId() { return recordArmTrackId(); },
          recordingTargetLock,
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
            audioEngine.mixer.previewTrackVolume(trackId, volume, muted);
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
