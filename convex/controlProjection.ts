import { projectSnapshotSchemaV1 } from "@daw-browser/control";
import {
  effectiveControlClipName,
  effectiveControlMixerBoolean,
  effectiveControlTimingOffset,
  canonicalControlMidiNotes,
} from "./controlEffectiveValues";
import type { MergedTrackDoc } from "./mixerChannels";

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
  });
};
