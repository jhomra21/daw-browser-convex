import type { Doc } from "./_generated/dataModel";
import { projectSnapshotSchemaV1 } from "@daw-browser/control";
import type { MergedTrackDoc } from "./mixerChannels";

type ControlProjectSnapshotInput = {
  project: Doc<"projects">;
  tracks: MergedTrackDoc[];
  clips: Doc<"clips">[];
  effects: Doc<"effects">[];
  automationEnvelopes: Doc<"automationEnvelopes">[];
  sidechainRoutes: Doc<"sidechainRoutes">[];
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
      muted: track.muted ?? false,
      soloed: track.soloed ?? false,
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
      name: clip.name?.trim() || "Clip",
      startSec: clip.startSec,
      duration: clip.duration,
      gain: clip.gain,
    }));
  const effects = [...input.effects]
    .filter((effect) => effect.targetType === "master" || effect.trackId !== undefined)
    .sort((left, right) => (
      compareControlSnapshotText(left.targetType, right.targetType)
      || compareControlSnapshotText(String(left.trackId ?? ""), String(right.trackId ?? ""))
      || left.index - right.index
      || compareControlSnapshotText(String(left._id), String(right._id))
    ))
    .map((effect) => ({
      target: effect.targetType === "master"
        ? { master: true }
        : { trackId: String(effect.trackId) },
      instanceId: effect.instanceId ?? String(effect._id),
      kind: effect.type,
      index: effect.index,
      params: effect.params,
    }));
  const automation = [...input.automationEnvelopes]
    .filter((envelope) => envelope.targetKind === "master" || envelope.trackId !== undefined)
    .sort((left, right) => compareControlSnapshotText(left.targetKey, right.targetKey) || compareControlSnapshotText(String(left._id), String(right._id)))
    .map((envelope) => ({
      id: String(envelope._id),
      target: envelope.targetKind === "master"
        ? { master: true }
        : { trackId: String(envelope.trackId) },
      effectInstanceId: envelope.effectInstanceId,
      parameterId: envelope.parameterId,
      enabled: envelope.enabled,
      points: [...envelope.points].sort((left, right) => left.timeSec - right.timeSec || compareControlSnapshotText(left.id, right.id)),
    }));
  const sidechains = [...input.sidechainRoutes]
    .sort((left, right) => (
      compareControlSnapshotText(String(left.targetTrackId), String(right.targetTrackId))
      || compareControlSnapshotText(left.effectInstanceId, right.effectInstanceId)
      || compareControlSnapshotText(String(left.sourceTrackId), String(right.sourceTrackId))
    ))
    .map((route) => ({
      sourceTrackId: String(route.sourceTrackId),
      targetTrackId: String(route.targetTrackId),
      effectInstanceId: route.effectInstanceId,
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
      updatedAt: input.project.updatedAt,
    },
    tracks,
    clips,
    effects,
    automation,
    sidechains,
  });
};
