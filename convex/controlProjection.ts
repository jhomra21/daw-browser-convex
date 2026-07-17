import { projectSnapshotSchemaV1 } from "@daw-browser/control";
import {
  effectiveControlClipName,
  effectiveControlMixerBoolean,
  effectiveControlTimingOffset,
  canonicalControlMidiNotes,
} from "./controlEffectiveValues";
import type { MergedTrackDoc } from "./mixerChannels";
import {
  getAutomationParameterDescriptor,
  normalizeAutomationPoints,
  normalizeTrackInstrumentParams,
} from "@daw-browser/shared";

type ControlProjectSnapshotInput = {
  project: {
    projectId: string;
    name: string;
    revision: number;
    tempoBpm: number;
    timeSignatureNumerator: number;
    timeSignatureDenominator: number;
    loopEnabled: boolean;
    loopStartSec: number;
    loopEndSec: number;
    updatedAt: number;
  };
  tracks: MergedTrackDoc[];
  clips: Array<{
    _id: unknown;
    trackId: unknown;
    name?: string;
    startSec: number;
    duration: number;
    gain?: number;
    leftPadSec?: number;
    bufferOffsetSec?: number;
    midiOffsetBeats?: number;
    fades?: {
      fadeInStartSec?: number;
      fadeInSec: number;
      fadeOutSec: number;
      fadeOutEndSec?: number;
      fadeInCurve: number;
      fadeOutCurve: number;
      fadeInCurvePosition?: number;
      fadeOutCurvePosition?: number;
    };
    midi?: {
      wave: string;
      gain?: number;
      notes: Array<{
        beat: number;
        length: number;
        pitch: number;
        velocity?: number;
      }>;
    };
  }>;
  masterVolume: number;
  effects: Array<{
    _id: unknown;
    targetType: string;
    trackId?: unknown;
    index: number;
    type: string;
    instanceId?: string;
    params: unknown;
  }>;
  automationEnvelopes: Array<{
    _id: unknown;
    targetKind: "track" | "master";
    trackId?: unknown;
    effectInstanceId?: string;
    parameterId: string;
    enabled: boolean;
    points: Array<{ id: string; timeSec: number; value: number; interpolation: "linear" | "hold" }>;
  }>;
  sidechainRoutes: Array<{
    sourceTrackId: unknown;
    targetTrackId: unknown;
    effectInstanceId: string;
  }>;
};

export const compareControlSnapshotText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export const projectControlSnapshotV1 = (input: ControlProjectSnapshotInput) => {
  const tracks = [...input.tracks]
    .sort((left, right) => left.index - right.index || compareControlSnapshotText(String(left._id), String(right._id)))
    .map((track) => ({
      id: String(track._id),
      name: track.name,
      index: track.index,
      kind: track.kind === "instrument" ? "instrument" : "audio",
      channelRole: track.channelRole === "group" || track.channelRole === "return" ? track.channelRole : "track",
      groupId: track.groupId ? String(track.groupId) : undefined,
      volume: track.volume,
      muted: effectiveControlMixerBoolean(track.muted),
      soloed: effectiveControlMixerBoolean(track.soloed),
      outputTargetId: track.outputTargetId ? String(track.outputTargetId) : undefined,
      sends: track.sends
        .map((send) => ({
          targetTrackId: String(send.targetId),
          amount: send.amount,
          tap: send.tap,
        }))
        .sort((left, right) => compareControlSnapshotText(left.targetTrackId, right.targetTrackId)),
    }));
  const clips = [...input.clips]
    .sort((left, right) => left.startSec - right.startSec || compareControlSnapshotText(String(left._id), String(right._id)))
    .map((clip) => ({
      id: String(clip._id),
      trackId: String(clip.trackId),
      name: effectiveControlClipName(clip.name),
      startSec: clip.startSec,
      duration: clip.duration,
      gain: clip.gain,
      leftPadSec: effectiveControlTimingOffset(clip.leftPadSec),
      bufferOffsetSec: effectiveControlTimingOffset(clip.bufferOffsetSec),
      midiOffsetBeats: effectiveControlTimingOffset(clip.midiOffsetBeats),
      fades: clip.fades,
      midi: clip.midi
        ? {
          ...clip.midi,
          notes: canonicalControlMidiNotes(clip.midi.notes),
        }
        : undefined,
    }));
  const processors = input.effects.flatMap((effect) => {
    const target = effect.targetType === "master"
      ? { master: true }
      : effect.targetType === "track" && effect.trackId
        ? { trackId: String(effect.trackId) }
        : undefined;
    if (!target) return [];
    const instrument = effect.type === "instrument"
      ? normalizeTrackInstrumentParams(effect.params)
      : effect.type === "synth"
        ? normalizeTrackInstrumentParams({
            kind: "synth",
            instanceId: effect.instanceId,
            params: effect.params,
          })
        : undefined;
    const processor = instrument
      ? { kind: "instrument", params: instrument }
      : effect.type === "arpeggiator"
        ? { kind: "arpeggiator", params: effect.params }
        : { kind: effect.type, params: effect.params };
    return [{ id: String(effect._id), target, instanceId: effect.instanceId, index: effect.index, processor }];
  }).sort((left, right) => (
    compareControlSnapshotText(
      "master" in left.target ? "master" : `track:${left.target.trackId}`,
      "master" in right.target ? "master" : `track:${right.target.trackId}`,
    )
    || left.index - right.index
    || compareControlSnapshotText(left.processor.kind, right.processor.kind)
    || compareControlSnapshotText(left.instanceId ?? "", right.instanceId ?? "")
    || compareControlSnapshotText(String(left.id), String(right.id))
  ));
  const automation = input.automationEnvelopes.flatMap((envelope) => {
    const descriptor = getAutomationParameterDescriptor(envelope.parameterId);
    const target = envelope.targetKind === "master"
      ? { master: true }
      : envelope.trackId
        ? { trackId: String(envelope.trackId) }
        : undefined;
    if (!target || !descriptor) return [];
    return [{
      id: String(envelope._id),
      target,
      effectInstanceId: envelope.effectInstanceId,
      parameterId: envelope.parameterId,
      enabled: envelope.enabled,
      points: normalizeAutomationPoints(envelope.points, descriptor),
    }];
  }).sort((left, right) => (
    compareControlSnapshotText(
      "master" in left.target ? "master" : `track:${left.target.trackId}`,
      "master" in right.target ? "master" : `track:${right.target.trackId}`,
    )
    || compareControlSnapshotText(left.parameterId, right.parameterId)
    || compareControlSnapshotText(left.effectInstanceId ?? "", right.effectInstanceId ?? "")
    || compareControlSnapshotText(left.id, right.id)
  )).map(({ id: _id, ...envelope }) => envelope);
  const sidechains = [...input.sidechainRoutes]
    .map((route) => ({
      sourceTrackId: String(route.sourceTrackId),
      targetTrackId: String(route.targetTrackId),
      effectInstanceId: route.effectInstanceId,
    }))
    .sort((left, right) => (
      compareControlSnapshotText(left.targetTrackId, right.targetTrackId)
      || compareControlSnapshotText(left.effectInstanceId, right.effectInstanceId)
      || compareControlSnapshotText(left.sourceTrackId, right.sourceTrackId)
    ));

  return projectSnapshotSchemaV1.parse({
    version: "v1",
    project: {
      id: input.project.projectId,
      name: input.project.name,
      revision: input.project.revision,
      tempoBpm: input.project.tempoBpm,
      timeSignature: {
        numerator: input.project.timeSignatureNumerator,
        denominator: input.project.timeSignatureDenominator,
      },
      loop: {
        enabled: input.project.loopEnabled,
        startSec: input.project.loopStartSec,
        endSec: input.project.loopEndSec,
      },
      masterVolume: input.masterVolume,
      updatedAt: input.project.updatedAt,
    },
    tracks,
    clips,
    processors,
    automation,
    sidechains,
  });
};
