import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js";
import { isLocalId, normalizeSynthParams, type ArpeggiatorParams } from "@daw-browser/shared";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import { createEffectsPanelAudioEffectsState } from "~/components/timeline/create-effects-panel-audio-effects-state";
import { createEffectsPanelState } from "~/components/timeline/create-effects-panel-state";
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
  a.addArpeggiator === b.addArpeggiator &&
  a.addEq === b.addEq &&
  a.addReverb === b.addReverb &&
  a.canWrite === b.canWrite &&
  a.canAddMidiClip === b.canAddMidiClip &&
  a.canAddArpeggiator === b.canAddArpeggiator &&
  a.canAddEq === b.canAddEq &&
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

  const instrument = createEffectsPanelState(
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
  const audioEffects = createEffectsPanelAudioEffectsState(
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
      reverb: audioEffects.reverb.readDraftForTarget,
      synth: instrument.synth.readDraftForTarget,
      arp: instrument.arp.readDraftForTarget,
    },
  });

  createEffect(() => {
    const effects = roomEffectsQuery.data;
    if (effects === undefined) return;
    const activeTarget = currentTargetId();
    const synthByTrackId = new Map<string, ReturnType<typeof normalizeSynthParams>>();
    const arpByTrackId = new Map<string, ArpeggiatorParams>();
    for (const row of effects) {
      if (row?.targetType !== "track" || !row.trackId) continue;
      if (row.type === "synth" && row.params) {
        synthByTrackId.set(row.trackId, normalizeSynthParams(row.params));
      }
      if (row.type === "arpeggiator" && row.params) {
        arpByTrackId.set(row.trackId, row.params);
      }
    }
    for (const track of options.tracks()) {
      if (track.id === activeTarget) continue;
      const synthParams = track.kind === "instrument" ? synthByTrackId.get(track.id) : undefined;
      const arpParams = track.kind === "instrument" ? arpByTrackId.get(track.id) : undefined;
      instrument.synth.syncRemoteForTarget(track.id, synthParams);
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

  let previousDeviceInsertActions: TimelineDeviceInsertActions | undefined;
  createEffect(() => {
    const nextActions = {
      addMidiClip: instrument.addMidiClip,
      addArpeggiator: instrument.arp.add,
      addEq: audioEffects.eq.add,
      addReverb: audioEffects.reverb.add,
      canWrite: canWriteCurrentTargetEffects(),
      canAddMidiClip: isInstrumentTrack(),
      canAddArpeggiator: isInstrumentTrack() && !instrument.arp.params(),
      canAddEq: !audioEffects.eq.params(),
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
    instrument,
    audioEffects,
    spectrum,
    canWriteCurrentTargetEffects,
    isCurrentTargetReadOnly,
    close,
  };
}
