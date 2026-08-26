import type { ControlActionV1 } from "@daw-browser/control";
import { collectTrackDeletionAffectedIdsV1 } from "@daw-browser/control-core";
import { readProjectControlSnapshotV2 } from "./controlSnapshot";
import { listProjectTracksWithMixerChannels } from "./mixerChannels";
import { getProjectRole } from "./projectAccess";

type ControlErrorCode = "validation" | "forbidden" | "not-found" | "authorization";

export class ControlDomainError extends Error {
  code: ControlErrorCode;
  actionIndex?: number;
  details?: Record<string, string>;

  constructor(
    code: ControlErrorCode,
    message: string,
    actionIndex?: number,
    details?: Record<string, string>,
  ) {
    super(message);
    this.code = code;
    this.actionIndex = actionIndex;
    this.details = details;
  }
}

const isProjectMetadataAction = (action: ControlActionV1) => (
  action.kind === "project.rename" || action.kind === "project.settings.set"
);

const persistedId = (ref: { source: "persisted"; id: string } | { source: "client"; clientRef: string } | undefined) => (
  ref?.source === "persisted" ? ref.id : undefined
);

const addTrack = (trackIds: Set<string>, ref: { source: "persisted"; id: string } | { source: "client"; clientRef: string } | undefined) => {
  const trackId = persistedId(ref);
  if (trackId) trackIds.add(trackId);
};

const actionTrackIds = (
  action: ControlActionV1,
  snapshot: Awaited<ReturnType<typeof readProjectControlSnapshotV2>>,
) => {
  const trackIds = new Set<string>();
  const tracks = new Map(snapshot.tracks.map((track) => [track.id, track]));
  const clips = new Map(snapshot.clips.map((clip) => [clip.id, clip]));
  const effects = new Map(snapshot.processors.map((effect) => [effect.id, effect]));
  const addEffectTrack = (ref: { source: "persisted"; id: string } | { source: "client"; clientRef: string } | undefined) => {
    const effectId = persistedId(ref);
    const effect = effectId ? effects.get(effectId) : undefined;
    if (effect && "trackId" in effect.target) trackIds.add(effect.target.trackId);
  };
  const addClipTrack = (ref: { source: "persisted"; id: string } | { source: "client"; clientRef: string } | undefined) => {
    const clipId = persistedId(ref);
    const clip = clipId ? clips.get(clipId) : undefined;
    if (clip) trackIds.add(clip.trackId);
  };
  const addTargetTrack = (target: { kind: "master" } | { kind: "track"; track: { source: "persisted"; id: string } | { source: "client"; clientRef: string } }) => {
    if (target.kind === "track") addTrack(trackIds, target.track);
  };

  switch (action.kind) {
    case "track.create":
    case "track.reorder":
      for (const track of snapshot.tracks) trackIds.add(track.id);
      if (action.kind === "track.reorder") {
        for (const update of action.tracks) {
          addTrack(trackIds, update.track);
          if (update.group) addTrack(trackIds, update.group);
        }
      }
      break;
    case "track.rename":
    case "track.mix.set":
    case "track.collapsed.set":
    case "track.color.set":
      addTrack(trackIds, action.track);
      break;
    case "track.color.cascade":
    case "track.ungroup": {
      const root = action.kind === "track.color.cascade" ? persistedId(action.root) : persistedId(action.group);
      if (root) {
        trackIds.add(root);
        for (const track of snapshot.tracks) {
          let parentId = track.groupId;
          while (parentId) {
            if (parentId === root) {
              trackIds.add(track.id);
              break;
            }
            parentId = tracks.get(parentId)?.groupId;
          }
        }
      }
      break;
    }
    case "track.routing.set":
      addTrack(trackIds, action.track);
      if (action.output) addTrack(trackIds, action.output);
      for (const send of action.sends ?? []) addTrack(trackIds, send.target);
      break;
    case "track.group.set":
      addTrack(trackIds, action.track);
      if (action.group) addTrack(trackIds, action.group);
      break;
    case "track.delete": {
      const rootId = persistedId(action.track);
      if (rootId) {
        for (const trackId of collectTrackDeletionAffectedIdsV1(snapshot.tracks, snapshot.sidechains, rootId)) {
          trackIds.add(trackId);
        }
      }
      break;
    }
    case "clip.midi.create":
    case "clip.audio.create":
      addTrack(trackIds, action.track);
      break;
    case "clip.move":
      addClipTrack(action.clip);
      addTrack(trackIds, action.track);
      break;
    case "clip.timing.set":
    case "clip.source.set":
    case "clip.midi.set":
    case "clip.fades.set":
    case "clip.audioWarp.set":
    case "clip.color.set":
    case "clip.rename":
    case "clip.delete":
      addClipTrack(action.clip);
      break;
    case "timeline.range.delete":
      for (const track of action.tracks) addTrack(trackIds, track);
      break;
    case "effect.upsert":
    case "effect.remove":
      addTargetTrack(action.target);
      addEffectTrack(action.effect);
      break;
    case "effect.reorder":
      addTargetTrack(action.target);
      for (const item of action.order) addEffectTrack(item.effect);
      break;
    case "instrument.set":
    case "instrument.remove":
    case "arpeggiator.set":
    case "arpeggiator.remove":
      addTrack(trackIds, action.target.track);
      break;
    case "automation.set":
    case "automation.delete":
      addTargetTrack(action.target);
      addEffectTrack(action.effect);
      break;
    case "sidechain.set":
      addTrack(trackIds, action.source);
      addTrack(trackIds, action.target);
      addEffectTrack(action.effect);
      break;
    case "sidechain.remove":
      addTrack(trackIds, action.target);
      addEffectTrack(action.effect);
      break;
    case "project.rename":
    case "project.settings.set":
    case "master.volume.set":
      break;
  }
  return [...trackIds].flatMap((trackId) => {
    const track = tracks.get(trackId);
    return track ? [track] : [];
  });
};

export async function preflightControlRequestV1(
  ctx: any,
  input: { projectId: string; actorId: string; actions: readonly ControlActionV1[] },
) {
  const role = await getProjectRole(ctx, input.projectId, input.actorId);
  if (!role) {
    throw new ControlDomainError("forbidden", "You do not have access to this project.");
  }
  if (role === "viewer") {
    throw new ControlDomainError("forbidden", "Viewers cannot execute control actions.");
  }
  const snapshot = await readProjectControlSnapshotV2(ctx, input.projectId);
  const tracksWithLocks = await listProjectTracksWithMixerChannels(ctx, input.projectId);
  const lockedByTrackId = new Map(tracksWithLocks.map((track) => [String(track._id), track.lockedBy]));
  for (const [actionIndex, action] of input.actions.entries()) {
    if (isProjectMetadataAction(action) && role !== "owner") {
      throw new ControlDomainError(
        "forbidden",
        "Only project owners can update project metadata.",
        actionIndex,
      );
    }
    for (const track of actionTrackIds(action, snapshot)) {
      const lockedBy = lockedByTrackId.get(track.id);
      if (lockedBy && lockedBy !== input.actorId) {
        throw new ControlDomainError(
          "forbidden",
          "Affected track is locked by another user.",
          actionIndex,
          { trackId: track.id, lockedBy },
        );
      }
    }
  }
  return { role };
}
