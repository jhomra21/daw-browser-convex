import type { DeliveryRegistration, LiveProcessorEditIdentity, ProcessorDelivery, PublicationJoin } from "~/lib/live-processor-control";
import { createEffect, createMemo, onCleanup, untrack, type Accessor } from "solid-js";
import { isLocalId, type ArpeggiatorParams, type AudioEffectKind, type TrackInstrumentParams } from "@daw-browser/shared";
import type { AudioEngine, EngineDisposition, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { Clip, ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
import { createEffectsPanelAudioDevice } from "~/components/timeline/create-effects-panel-audio-effects-state";
import { readInstrumentParamsFromEffectRow } from "~/lib/effect-row-instrument-params";
import { createEffectsPanelInstrumentDevice } from "~/components/timeline/create-effects-panel-state";
import type { AddMidiClipOptions, TimelineDeviceInsertActions } from "~/components/timeline/timeline-device-insert-actions";
import { createLocalEffectsView } from "~/components/timeline/create-local-effects-view";
import { createPendingWorkOwner, useEffectsPanelAudioSync } from "~/hooks/useEffectsPanelAudioSync";
import { useEffectsPanelTarget } from "~/hooks/useEffectsPanelTarget";
import type { createSamplerBufferSync, NativeInstrumentRetryIdentity } from "~/lib/sampler-buffer-sync";
import type { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import { convexApi, useConvexQuery } from "~/lib/convex";
import type { OptimisticGrantWrite } from "~/lib/optimistic-grant-scope";
import type { EffectParamsByEffect, EffectParamsCommitOptions, EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import type { AudioEffectChainPreset } from "~/lib/audio-effect-chain-presets";
import { withInstrumentOverride, type ExportEffectsProjection } from "~/lib/export/export-effect-rows";
import type { ExportRenderStateSnapshot } from "~/lib/export/run-export-job";
import type { NativeBuiltInParameterPayload } from "~/lib/desktop/native-built-in-parameter-mapper";
import { SampledInstrumentSyncSupersededError } from "~/lib/sampled-instrument-sync-error";

export type EffectsPanelExportSnapshot = {
  flushPending: () => Promise<void>
  awaitInstrumentReadiness: (override?: { targetId: string; instrument: TrackInstrumentParams }) => Promise<void | {
    projection: ExportEffectsProjection
    hydrateInstrumentBuffers: (renderState: ExportRenderStateSnapshot) => ExportRenderStateSnapshot
    release: () => void
  }>
  snapshotEffectsProjection: () => ExportEffectsProjection
  hydrateInstrumentBuffers?: (renderState: ExportRenderStateSnapshot) => ExportRenderStateSnapshot
  snapshotSidechainRoutes: () => ExternalSidechainRoute[]
}

export const hydrateInstrumentBuffers = (
  renderState: ExportRenderStateSnapshot,
  snapshotInstrumentBuffers: EffectsPanelInstrumentDevice["snapshotInstrumentBuffers"],
): ExportRenderStateSnapshot => {
  const trackFx = renderState.fx.trackFx;
  if (!trackFx) return renderState;
  const hydratedTrackFx = Object.fromEntries(Object.entries(trackFx).map(([trackId, entry]) => {
    const activeInstrument = entry.instrument;
    if (!activeInstrument) return [trackId, entry];
    const {
      samplerBuffers: _samplerBuffers,
      drumRackBuffers: _drumRackBuffers,
      granularBuffer: _granularBuffer,
      unavailableSampleAssetKeys: _unavailableSampleAssetKeys,
      ...entryWithoutBuffers
    } = entry;
    const runtimeBuffers = snapshotInstrumentBuffers(trackId, activeInstrument);
    return [trackId, runtimeBuffers ? { ...entryWithoutBuffers, ...runtimeBuffers } : entryWithoutBuffers];
  }));
  return {
    ...renderState,
    fx: {
      ...renderState.fx,
      trackFx: hydratedTrackFx,
    },
  };
};

type EffectsPanelControllerOptions = {
  isOpen: Accessor<boolean>;
  selectedFXTarget: Accessor<Track["id"] | "master">;
  tracks: Accessor<Track[]>;
  sidechainRoutes: Accessor<ExternalSidechainRoute[]>;
  audioEngine: Accessor<AudioEngine>;
  projectId: Accessor<string | undefined>;
  userId: Accessor<string | undefined>;
  playheadSec: Accessor<number | undefined>;
  canWriteTrackRouting?: (trackId: Track["id"]) => boolean;
  grantClipWrite?: OptimisticGrantWrite;
  onClose: () => void;
  onSelectClip?: (trackId: Track["id"], clipId: string, startSec: number) => void;
  insertLocalClip?: (trackId: Track["id"], clip: Clip) => void;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string, options?: EffectParamsCommitOptions) => void;
  onStructuralPlaybackChange?: (targetId: Track["id"], next: TrackInstrumentParams | undefined, edit?: LiveProcessorEditIdentity) => Promise<void>;
  usesLegacyAudioEngine?: Accessor<boolean>;
  projectGeneration?: Accessor<number>;
  allocateProcessorEdit?: (payload: NativeBuiltInParameterPayload) => LiveProcessorEditIdentity | undefined;
  deliverProcessor?: (edit: LiveProcessorEditIdentity, gesture?: ProcessorDelivery["gesture"]) => DeliveryRegistration;
  applyPortableProcessor?: (edit: LiveProcessorEditIdentity) => Promise<EngineDisposition | undefined>;
  joinPublication?: (join: PublicationJoin) => DeliveryRegistration;
  retryNativeInstrumentPreparation?: (identity: NativeInstrumentRetryIdentity) => Promise<void>;
  onEffectInstanceParamsReplayChange?: (replay: EffectsPanelAudioEffects["replayInstanceParams"] | undefined) => void;
  onLocalSaveFailed?: (projectId: string, message: string) => void;
  onEffectError?: (title: string, message: string) => void;
  onDeviceInsertActionsChange?: (actions: TimelineDeviceInsertActions) => void;
  onExportSnapshotChange?: (snapshot: EffectsPanelExportSnapshot | undefined) => void;
  spectrumProvider?: Accessor<((targetId: string, listener: (frame: SpectrumFrame | null) => void) => () => void) | undefined>;
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>;
  drumRackBufferSync: ReturnType<typeof createDrumRackBufferSync>;
};

const deviceInsertActionsEqual = (
  a: TimelineDeviceInsertActions | undefined,
  b: TimelineDeviceInsertActions,
) => (
  a?.addMidiClip === b.addMidiClip &&
  a.addMidiClipToTarget === b.addMidiClipToTarget &&
  a.canAddMidiClipToTarget === b.canAddMidiClipToTarget &&
  a.addArpeggiator === b.addArpeggiator &&
  a.addArpeggiatorToTarget === b.addArpeggiatorToTarget &&
  a.canAddArpeggiatorToTarget === b.canAddArpeggiatorToTarget &&
  a.setArpeggiatorForTarget === b.setArpeggiatorForTarget &&
  a.addAudioEffectToTarget === b.addAudioEffectToTarget &&
  a.canAddAudioEffectToTarget === b.canAddAudioEffectToTarget &&
  a.addAudioEffectChainToTarget === b.addAudioEffectChainToTarget &&
  a.canAddAudioEffectChainToTarget === b.canAddAudioEffectChainToTarget &&
  a.addEq === b.addEq &&
  a.addCompressor === b.addCompressor &&
  a.addSaturator === b.addSaturator &&
  a.addDelay === b.addDelay &&
  a.addReverb === b.addReverb &&
  a.switchInstrumentForTarget === b.switchInstrumentForTarget &&
  a.setInstrumentForTarget === b.setInstrumentForTarget &&
  a.canSetInstrumentForTarget === b.canSetInstrumentForTarget &&
  a.canWrite === b.canWrite &&
  a.canAddMidiClip === b.canAddMidiClip &&
  a.canAddArpeggiator === b.canAddArpeggiator &&
  a.canAddEq === b.canAddEq &&
  a.canAddCompressor === b.canAddCompressor &&
  a.canAddSaturator === b.canAddSaturator &&
  a.canAddDelay === b.canAddDelay &&
  a.canAddReverb === b.canAddReverb
);

export function createEffectsPanelController(options: EffectsPanelControllerOptions) {
  const samplerBufferSync = options.samplerBufferSync;
  const drumRackBufferSync = options.drumRackBufferSync;
  const target = useEffectsPanelTarget({
    selectedFXTarget: options.selectedFXTarget,
    tracks: options.tracks,
    canWriteTrackRouting: options.canWriteTrackRouting,
  });
  const {
    currentTargetId,
    currentTrack,
    isInstrumentTrack,
    canWriteCurrentTrackRouting,
    resolveTrackByTargetId,
  } = target;

  const roomEffectsQuery = useConvexQuery(
    convexApi.effects.listByRoom,
    () => {
      const projectId = options.projectId();
      if (projectId && isLocalId("project", projectId)) return null;
      return projectId && options.userId() ? { projectId } : null;
    },
    () => ["effects", "room", options.projectId(), options.userId()],
  );
  // One local reader serves the instrument device, audio device and all-target audio sync.
  const localEffectsView = createLocalEffectsView({ projectId: options.projectId, onError: options.onEffectError });

  const canWriteCurrentTargetEffects = createMemo(() => currentTargetId() === "master" || canWriteCurrentTrackRouting());
  const pendingWorkOwner = createPendingWorkOwner();
  const instrument = createEffectsPanelInstrumentDevice(
    {
      audioEngine: options.audioEngine,
      projectId: options.projectId,
      userId: options.userId,
      playheadSec: options.playheadSec,
      roomEffects: () => roomEffectsQuery.data,
      localEffectsView,
      grantClipWrite: options.grantClipWrite,
      onSelectClip: options.onSelectClip,
      insertLocalClip: options.insertLocalClip,
      onEffectParamsCommitted: options.onEffectParamsCommitted,
      onStructuralPlaybackChange: options.onStructuralPlaybackChange,
      usesLegacyAudioEngine: options.usesLegacyAudioEngine,
      canWrite: canWriteCurrentTargetEffects,
      allocateProcessorEdit: options.allocateProcessorEdit,
      deliverProcessor: options.deliverProcessor,
      joinPublication: options.joinPublication,
      applyPortableProcessor: options.applyPortableProcessor,
      retryNativeInstrumentPreparation: options.retryNativeInstrumentPreparation,
      projectGeneration: options.projectGeneration,
      onLocalSaveFailed: options.onLocalSaveFailed,
      onEffectError: options.onEffectError,
      samplerBufferSync,
      drumRackBufferSync,
      trackSampledInstrumentWork: (work) => pendingWorkOwner.track(options.projectId(), work),
    },
    currentTargetId,
    currentTrack,
    resolveTrackByTargetId,
  );
  const isCurrentTargetReadOnly = createMemo(() => currentTargetId() !== "master" && !canWriteCurrentTrackRouting());
  const canWriteEffectsTarget = (targetId: Track["id"] | "master") => {
    if (targetId === "master") return true;
    return options.canWriteTrackRouting ? options.canWriteTrackRouting(targetId) : true;
  };
  const audioEffects = createEffectsPanelAudioDevice(
    {
      audioEngine: options.audioEngine,
      tracks: options.tracks,
      projectId: options.projectId,
      userId: options.userId,
      roomEffects: () => roomEffectsQuery.data,
      localEffectsView,
      sidechainRoutes: options.sidechainRoutes,
      canWriteCurrentTargetEffects,
      usesLegacyAudioEngine: options.usesLegacyAudioEngine,
      projectGeneration: options.projectGeneration,
      allocateProcessorEdit: options.allocateProcessorEdit,
      deliverProcessor: options.deliverProcessor,
      applyPortableProcessor: options.applyPortableProcessor,
      onEffectParamsCommitted: options.onEffectParamsCommitted,
      onLocalSaveFailed: options.onLocalSaveFailed,
      onEffectError: options.onEffectError,
    },
    currentTargetId,
    resolveTrackByTargetId,
  );

  const { flushPending: flushSampledInstrumentWork, spectrum } = useEffectsPanelAudioSync({
    pendingWorkOwner,
    syncInstrumentForTarget: instrument.syncRemoteInstrumentForTarget,
    syncArpeggiatorForTarget: instrument.arp.syncRemoteForTarget,
    isOpen: options.isOpen,
    projectId: options.projectId,
    currentTargetId,
    tracks: options.tracks,
    sidechainRoutes: options.sidechainRoutes,
    audioEngine: options.audioEngine,
    usesLegacyAudioEngine: options.usesLegacyAudioEngine,
    roomEffects: () => roomEffectsQuery.data,
    roomEffectsStatus: () => roomEffectsQuery.status,
    roomEffectsError: () => roomEffectsQuery.error,
    localEffectsView,
    samplerBufferSync,
    drumRackBufferSync,
    spectrumProvider: options.spectrumProvider,
  });

  let observedCloudTrackIds = new Set<string>();
  createEffect(() => {
    const effects = roomEffectsQuery.data;
    if (effects === undefined) return;
    const instrumentByTrackId = new Map<string, { params: TrackInstrumentParams; through: number }>();
    const arpByTrackId = new Map<string, { params: ArpeggiatorParams; through: number }>();
    for (const row of effects) {
      if (row?.targetType !== "track" || !row.trackId) continue;
      if (row.type === "instrument" || (row.type === "synth" && !instrumentByTrackId.has(row.trackId))) {
        const instrumentParams = readInstrumentParamsFromEffectRow(row);
        if (instrumentParams) instrumentByTrackId.set(row.trackId, { params: instrumentParams, through: row.revision ?? 0 });
      }
      if (row.type === "arpeggiator" && row.params) {
        arpByTrackId.set(row.trackId, { params: row.params, through: row.revision ?? 0 });
      }
    }
    const tracks = options.tracks();
    const currentTrackIds = new Set(tracks.map(track => track.id));
    untrack(() => {
      for (const trackId of observedCloudTrackIds) if (!currentTrackIds.has(trackId)) {
        instrument.syncRemoteInstrumentForTarget(trackId, undefined);
        instrument.arp.syncRemoteForTarget(trackId, undefined);
      }
    });
    observedCloudTrackIds = currentTrackIds;
    for (const track of tracks) {
      const instrumentParams = track.kind === "instrument" ? instrumentByTrackId.get(track.id) : undefined;
      const arpParams = track.kind === "instrument" ? arpByTrackId.get(track.id) : undefined;
      // Cloud query rows remain the remote owners' source of truth.
      untrack(() => {
        instrument.syncRemoteInstrumentForTarget(track.id, instrumentParams?.params, instrumentParams?.through);
        instrument.arp.syncRemoteForTarget(track.id, arpParams?.params, arpParams?.through);
      });
    }
  });

  const flushPending = async () => {
    await Promise.all([
      audioEffects.flushPending(),
      instrument.flushPending(),
      flushSampledInstrumentWork(),
    ]);
  };
  const exportSnapshot: EffectsPanelExportSnapshot = {
    flushPending,
    // Compilation cannot drain the gesture owner: its announce awaits this preparation.
    awaitInstrumentReadiness: async (override) => {
      await flushSampledInstrumentWork();
      const readProjection = () => {
        const projection = exportSnapshot.snapshotEffectsProjection();
        return override ? withInstrumentOverride(projection, override.targetId, override.instrument) : projection;
      };
      // Select the last row per target before comparing only loader inputs, not knob values.
      const instrumentRows = (projection: ExportEffectsProjection) => new Map(projection.upsertDeviceRows
        .filter(row => row.effect === "instrument").map(row => [row.targetId, row]));
      const hydrationKey = (projection: ExportEffectsProjection) => JSON.stringify(
        [...instrumentRows(projection).values()].flatMap(row => {
          const params = row.params;
          const inputs = params.kind === "drum-rack" ? drumRackBufferSync.hydrationInputs(params)
            : params.kind === "sampler" || params.kind === "granular" ? samplerBufferSync.hydrationInputs(params)
              : undefined;
          return inputs ? [[row.targetId, inputs]] : [];
        }),
      );
      // A queued draft can precede its FIFO apply. Load only, through the same
      // region caches and pending-work owner, and pin until the compile finishes.
      while (true) {
        const projectId = options.projectId();
        const projection = readProjection();
        const key = hydrationKey(projection);
        const buffers = new Map<string, ReturnType<EffectsPanelInstrumentDevice["snapshotInstrumentBuffers"]>>();
        const pins: { release: () => void }[] = [];
        const release = () => { for (const pin of pins.splice(0)) pin.release(); };
        try {
          for (const row of instrumentRows(projection).values()) {
            const params = row.params;
            if (params.kind !== "sampler" && params.kind !== "granular" && params.kind !== "drum-rack") continue;
            const work = params.kind === "drum-rack"
              ? drumRackBufferSync.loadBuffers(row.targetId, params)
              : samplerBufferSync.loadBuffers(row.targetId, params);
            pendingWorkOwner.track(projectId, work.then(() => undefined));
            const loaded = await work;
            pins.push(loaded);
            const { release: _release, ...runtimeBuffers } = loaded;
            buffers.set(row.targetId, runtimeBuffers);
          }
          await pendingWorkOwner.flushPending(projectId);
          const fresh = readProjection();
          if (projectId !== options.projectId() || hydrationKey(fresh) !== key) {
            release();
            continue;
          }
          return {
            projection: fresh,
            hydrateInstrumentBuffers: (renderState) => hydrateInstrumentBuffers(renderState, (trackId) => buffers.get(trackId)),
            release,
          };
        } catch (cause) {
          release();
          if (cause instanceof SampledInstrumentSyncSupersededError
            || projectId !== options.projectId() || hydrationKey(readProjection()) !== key) continue;
          throw cause;
        }
      }
    },
    snapshotEffectsProjection: () => {
      const projection = audioEffects.snapshotExportProjection();
      const clearInstrumentTargets: string[] = [];
      for (const track of options.tracks()) {
        if (track.kind !== "instrument") continue;
        clearInstrumentTargets.push(track.id);
        const instrumentParams = instrument.readInstrumentForTarget(track.id);
        if (instrumentParams) projection.upsertDeviceRows.push({ targetId: track.id, effect: "instrument", params: instrumentParams });
        const arpParams = instrument.arp.readForTarget(track.id);
        if (arpParams) projection.upsertDeviceRows.push({ targetId: track.id, effect: "arp", params: arpParams });
      }
      return { ...projection, clearInstrumentTargets };
    },
    hydrateInstrumentBuffers: (renderState) => {
      return hydrateInstrumentBuffers(renderState, instrument.snapshotInstrumentBuffers);
    },
    snapshotSidechainRoutes: audioEffects.snapshotSidechainRoutes,
  };

  const close = () => {
    void flushPending();
    options.onClose();
  };

  const canAddArpeggiatorToTarget = (targetId: Track["id"]) => {
    const track = resolveTrackByTargetId(targetId);
    if (!track || track.kind !== "instrument") return false;
    if (options.canWriteTrackRouting && !options.canWriteTrackRouting(track.id)) return false;
    return !instrument.arp.readForTarget(track.id);
  };

  const addArpeggiatorToTarget = async (targetId: Track["id"]) => {
    if (!canAddArpeggiatorToTarget(targetId)) return false;
    return await instrument.arp.addToTarget(targetId);
  };

  const canAddMidiClipToTarget = (targetId: Track["id"]) => {
    const track = resolveTrackByTargetId(targetId);
    if (!track || track.kind !== "instrument") return false;
    if (options.canWriteTrackRouting && !options.canWriteTrackRouting(track.id)) return false;
    return true;
  };

  const addMidiClipToTarget = async (targetId: Track["id"], insertOptions?: AddMidiClipOptions) => {
    if (!canAddMidiClipToTarget(targetId)) return false;
    return await instrument.addMidiClipToTarget(targetId, insertOptions);
  };

  const canSetInstrumentForTarget = (targetId: Track["id"]) => {
    const track = resolveTrackByTargetId(targetId);
    if (!track || track.kind !== "instrument") return false;
    if (options.canWriteTrackRouting && !options.canWriteTrackRouting(track.id)) return false;
    return true;
  };

  const setInstrumentForTarget: TimelineDeviceInsertActions["setInstrumentForTarget"] = (targetId, nextInstrument) => {
    if (!canSetInstrumentForTarget(targetId)) return false;
    return instrument.setInstrumentForTarget(targetId, nextInstrument);
  };

  const setArpeggiatorForTarget: TimelineDeviceInsertActions["setArpeggiatorForTarget"] = (targetId, params) => {
    if (!canSetInstrumentForTarget(targetId)) return false;
    return instrument.arp.setForTarget(targetId, params);
  };

  const canAddAudioEffectToTarget = (targetId: Track["id"] | "master", effect: AudioEffectKind) => (
    canWriteEffectsTarget(targetId) && audioEffects.canAddByKindToTarget(targetId, effect)
  );

  const addAudioEffectToTarget = async (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => {
    if (!canWriteEffectsTarget(targetId)) return false;
    return await audioEffects.addByKindToTarget(targetId, effect, index);
  };

  const canAddAudioEffectChainToTarget = (targetId: Track["id"] | "master", chain: AudioEffectChainPreset) => (
    chain.effects.length > 0 &&
    canWriteEffectsTarget(targetId) &&
    chain.effects.every((effect) => audioEffects.canAddByKindToTarget(targetId, effect.kind))
  );

  const addAudioEffectChainToTarget = async (targetId: Track["id"] | "master", chain: AudioEffectChainPreset, index?: number) => {
    if (!canWriteEffectsTarget(targetId) || chain.effects.length === 0) return false;
    return await audioEffects.addChainToTarget(targetId, chain.effects, index);
  };

  let previousDeviceInsertActions: TimelineDeviceInsertActions | undefined;
  createEffect(() => {
    const nextActions = {
      addMidiClip: instrument.addMidiClip,
      addMidiClipToTarget,
      canAddMidiClipToTarget,
      addArpeggiator: instrument.arp.add,
      addArpeggiatorToTarget,
      canAddArpeggiatorToTarget,
      setArpeggiatorForTarget,
      addAudioEffectToTarget,
      canAddAudioEffectToTarget,
      addAudioEffectChainToTarget,
      canAddAudioEffectChainToTarget,
      addEq: audioEffects.eq.add,
      addCompressor: audioEffects.compressor.add,
      addSaturator: audioEffects.saturator.add,
      addDelay: audioEffects.delay.add,
      addReverb: audioEffects.reverb.add,
      switchInstrumentForTarget: instrument.switchInstrumentForTarget,
      setInstrumentForTarget,
      canSetInstrumentForTarget,
      canWrite: canWriteCurrentTargetEffects(),
      canAddMidiClip: isInstrumentTrack(),
      canAddArpeggiator: isInstrumentTrack() && !instrument.arp.params(),
      canAddEq: true,
      canAddCompressor: true,
      canAddSaturator: true,
      canAddDelay: true,
      canAddReverb: true,
    };
    if (deviceInsertActionsEqual(previousDeviceInsertActions, nextActions)) return;
    previousDeviceInsertActions = nextActions;
    options.onDeviceInsertActionsChange?.(nextActions);
  });

  onCleanup(() => {
    options.onEffectInstanceParamsReplayChange?.(undefined);
    options.onExportSnapshotChange?.(undefined);
    void flushPending();
  });
  options.onExportSnapshotChange?.(exportSnapshot);

  createEffect(() => {
    const replay = <Effect extends EffectType>(payload: {
      targetId: string;
      effect: Effect;
      instanceId: string;
      params: EffectParamsByEffect[Effect];
    }) => audioEffects.replayInstanceParams(payload);
    options.onEffectInstanceParamsReplayChange?.(replay);
  });

  return {
    target,
    devices: {
      instrument,
      audioEffects,
    },
    spectrum,
    canWriteEffectsTarget,
    canWriteCurrentTargetEffects,
    isCurrentTargetReadOnly,
    close,
  };
}

export type EffectsPanelController = ReturnType<typeof createEffectsPanelController>;
export type EffectsPanelInstrumentDevice = EffectsPanelController["devices"]["instrument"];
export type EffectsPanelAudioEffects = EffectsPanelController["devices"]["audioEffects"];
