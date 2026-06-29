import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js";
import { isLocalId, type ArpeggiatorParams, type AudioEffectKind, type TrackInstrumentParams } from "@daw-browser/shared";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import { createEffectsPanelAudioDevice } from "~/components/timeline/create-effects-panel-audio-effects-state";
import { readInstrumentParamsFromEffectRow } from "~/lib/effect-row-instrument-params";
import { createEffectsPanelInstrumentDevice } from "~/components/timeline/create-effects-panel-state";
import type { TimelineDeviceInsertActions } from "~/components/timeline/timeline-device-insert-actions";
import { useEffectsPanelAudioSync } from "~/hooks/useEffectsPanelAudioSync";
import { useEffectsPanelTarget } from "~/hooks/useEffectsPanelTarget";
import { convexApi, useConvexQuery } from "~/lib/convex";
import type { OptimisticGrantWrite } from "~/lib/optimistic-grant-scope";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";

type EffectsPanelControllerOptions = {
  isOpen: Accessor<boolean>;
  selectedFXTarget: Accessor<Track["id"] | "master">;
  tracks: Accessor<Track[]>;
  audioEngine: Accessor<AudioEngine>;
  projectId: Accessor<string | undefined>;
  userId: Accessor<string | undefined>;
  isPlaying: Accessor<boolean>;
  playheadSec: Accessor<number | undefined>;
  canWriteTrackRouting?: (trackId: Track["id"]) => boolean;
  grantClipWrite?: OptimisticGrantWrite;
  onClose: () => void;
  onSelectClip?: (trackId: Track["id"], clipId: string, startSec: number) => void;
  insertLocalClip?: (trackId: Track["id"], clip: Clip) => void;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void;
  onLocalSaveFailed?: (message: string) => void;
  onDeviceInsertActionsChange?: (actions: TimelineDeviceInsertActions) => void;
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
  a.addAudioEffectToTarget === b.addAudioEffectToTarget &&
  a.canAddAudioEffectToTarget === b.canAddAudioEffectToTarget &&
  a.addEq === b.addEq &&
  a.addCompressor === b.addCompressor &&
  a.addSaturator === b.addSaturator &&
  a.addDelay === b.addDelay &&
  a.addReverb === b.addReverb &&
  a.openSynthForTarget === b.openSynthForTarget &&
  a.switchInstrumentForTarget === b.switchInstrumentForTarget &&
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

  const instrument = createEffectsPanelInstrumentDevice(
    {
      audioEngine: options.audioEngine,
      projectId: options.projectId,
      userId: options.userId,
      playheadSec: options.playheadSec,
      roomEffects: () => roomEffectsQuery.data,
      grantClipWrite: options.grantClipWrite,
      onSelectClip: options.onSelectClip,
      insertLocalClip: options.insertLocalClip,
      onEffectParamsCommitted: options.onEffectParamsCommitted,
      onLocalSaveFailed: options.onLocalSaveFailed,
    },
    currentTargetId,
    currentTrack,
    resolveTrackByTargetId,
  );
  const canWriteCurrentTargetEffects = createMemo(() => currentTargetId() === "master" || canWriteCurrentTrackRouting());
  const isCurrentTargetReadOnly = createMemo(() => currentTargetId() !== "master" && !canWriteCurrentTrackRouting());
  const canWriteEffectsTarget = (targetId: Track["id"] | "master") => {
    if (targetId === "master") return true;
    return options.canWriteTrackRouting ? options.canWriteTrackRouting(targetId) : true;
  };
  const audioEffects = createEffectsPanelAudioDevice(
    {
      audioEngine: options.audioEngine,
      projectId: options.projectId,
      userId: options.userId,
      roomEffects: () => roomEffectsQuery.data,
      canWriteCurrentTargetEffects,
      onEffectParamsCommitted: options.onEffectParamsCommitted,
      onLocalSaveFailed: options.onLocalSaveFailed,
    },
    currentTargetId,
    resolveTrackByTargetId,
  );

  const { spectrum } = useEffectsPanelAudioSync({
    isOpen: options.isOpen,
    projectId: options.projectId,
    currentTargetId,
    tracks: options.tracks,
    audioEngine: options.audioEngine,
    roomEffects: () => roomEffectsQuery.data,
    isPlaying: options.isPlaying,
    playheadSec: options.playheadSec,
    localDraftEffects: {
      eq: audioEffects.eq.readDraftForTarget,
      compressor: audioEffects.compressor.readDraftForTarget,
      saturator: audioEffects.saturator.readDraftForTarget,
      delay: audioEffects.delay.readDraftForTarget,
      reverb: audioEffects.reverb.readDraftForTarget,
      instrument: instrument.readDraftInstrumentForTarget,
      arp: instrument.arp.readDraftForTarget,
    },
  });

  createEffect(() => {
    const effects = roomEffectsQuery.data;
    if (effects === undefined) return;
    const activeTarget = currentTargetId();
    const instrumentByTrackId = new Map<string, TrackInstrumentParams>();
    const arpByTrackId = new Map<string, ArpeggiatorParams>();
    for (const row of effects) {
      if (row?.targetType !== "track" || !row.trackId) continue;
      if (row.type === "synth" || row.type === "instrument") {
        const instrumentParams = readInstrumentParamsFromEffectRow(row);
        if (instrumentParams) instrumentByTrackId.set(row.trackId, instrumentParams);
      }
      if (row.type === "arpeggiator" && row.params) {
        arpByTrackId.set(row.trackId, row.params);
      }
    }
    for (const track of options.tracks()) {
      if (track.id === activeTarget) continue;
      const instrumentParams = track.kind === "instrument" ? instrumentByTrackId.get(track.id) : undefined;
      const arpParams = track.kind === "instrument" ? arpByTrackId.get(track.id) : undefined;
      instrument.syncRemoteInstrumentForTarget(track.id, instrumentParams);
      instrument.arp.syncRemoteForTarget(track.id, arpParams);
    }
  });

  const flushPending = async () => {
    await Promise.all([
      audioEffects.flushPending(),
      instrument.flushPending(),
    ]);
  };

  createEffect(() => {
    if (!isCurrentTargetReadOnly()) return;
    instrument.synth.close();
  });

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

  const addMidiClipToTarget = async (targetId: Track["id"]) => {
    if (!canAddMidiClipToTarget(targetId)) return false;
    return await instrument.addMidiClipToTarget(targetId);
  };

  const canAddAudioEffectToTarget = (targetId: Track["id"] | "master", effect: AudioEffectKind) => (
    canWriteEffectsTarget(targetId) && audioEffects.canAddByKindToTarget(targetId, effect)
  );

  const addAudioEffectToTarget = async (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => {
    if (!canAddAudioEffectToTarget(targetId, effect)) return false;
    return await audioEffects.addByKindToTarget(targetId, effect, index);
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
      addAudioEffectToTarget,
      canAddAudioEffectToTarget,
      addEq: audioEffects.eq.add,
      addCompressor: audioEffects.compressor.add,
      addSaturator: audioEffects.saturator.add,
      addDelay: audioEffects.delay.add,
      addReverb: audioEffects.reverb.add,
      openSynthForTarget: instrument.synth.openForTarget,
      switchInstrumentForTarget: instrument.switchInstrumentForTarget,
      canWrite: canWriteCurrentTargetEffects(),
      canAddMidiClip: isInstrumentTrack(),
      canAddArpeggiator: isInstrumentTrack() && !instrument.arp.params(),
      canAddEq: !audioEffects.eq.params(),
      canAddCompressor: !audioEffects.compressor.params(),
      canAddSaturator: !audioEffects.saturator.params(),
      canAddDelay: !audioEffects.delay.params(),
      canAddReverb: !audioEffects.reverb.params(),
    };
    if (deviceInsertActionsEqual(previousDeviceInsertActions, nextActions)) return;
    previousDeviceInsertActions = nextActions;
    options.onDeviceInsertActionsChange?.(nextActions);
  });

  onCleanup(() => {
    void flushPending();
  });

  return {
    target,
    devices: {
      instrument,
      audioEffects,
    },
    spectrum,
    canWriteCurrentTargetEffects,
    isCurrentTargetReadOnly,
    close,
  };
}

export type EffectsPanelController = ReturnType<typeof createEffectsPanelController>;
export type EffectsPanelInstrumentDevice = EffectsPanelController["devices"]["instrument"];
export type EffectsPanelAudioEffects = EffectsPanelController["devices"]["audioEffects"];
