import { buildClipCreatePayload, buildLocalClip, type ClipCreateSnapshot } from "~/lib/clip-create";
import { buildClipMoveManyMutationInput, buildClipRemoveManyMutationInput } from "~/lib/clip-mutation-args";
import { persistClipTiming } from "~/lib/clip-mutations";
import { buildTrackEffectMutationInput } from "~/lib/effect-track-args";
import { setLocalEffect } from "~/lib/local-effects";
import { isLocalId } from "~/lib/local-ids";
import { publishSharedTimelineOperationOrQueue } from "~/lib/shared-outbox";
import { buildSharedClipCreateOperation, buildSharedTrackCreateOperation, type SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { buildTrackCreateMutationInput, buildTrackDeleteMutationInput, buildTrackMixMutationInput, buildTrackVolumeMutationInput } from "~/lib/track-mutation-args";
import { buildTrackRoutingMutationInput } from "~/lib/track-routing-state";
import type { LocalMixPatch } from "~/lib/timeline-storage";
import type { Track, TrackRouting } from "~/types/timeline";
import type { Deps } from "./exec";
import type { HistoryEntry } from "./types";

type ClipMove = { clipId: string; trackId: Track["id"]; startSec: number };

type ClipTimingPatch = {
  startSec: number;
  duration: number;
  leftPadSec?: number;
  bufferOffsetSec?: number;
  midiOffsetBeats?: number;
};

export const isLocalHistoryProject = (deps: Pick<Deps, "projectId">) => (
  isLocalId("project", deps.projectId)
);

const toHistoryCreateClipInput = (trackId: Track["id"], clip: Track["clips"][number]) => ({
  id: clip.id,
  historyRef: clip.historyRef,
  trackId,
  name: clip.name,
  startSec: clip.startSec,
  duration: clip.duration,
  color: clip.color,
  sourceAssetKey: clip.sourceAssetKey,
  sourceKind: clip.sourceKind,
  sourceDurationSec: clip.sourceDurationSec,
  sourceSampleRate: clip.sourceSampleRate,
  sourceChannelCount: clip.sourceChannelCount,
  leftPadSec: clip.leftPadSec,
  bufferOffsetSec: clip.bufferOffsetSec,
  sampleUrl: clip.sampleUrl,
  midi: clip.midi,
  midiOffsetBeats: clip.midiOffsetBeats,
});

export const syncHistoryTrackCreateEntryId = (
  entries: HistoryEntry[],
  trackRef: string | undefined,
  trackId: Track["id"],
) => {
  if (!trackRef) return;
  for (const entry of entries) {
    if (entry.type === "track-create" && entry.data.trackRef === trackRef) {
      entry.data.currentTrackId = trackId;
    }
  }
};

export const syncHistoryClipCreateEntryIds = (
  entries: HistoryEntry[],
  clipIdsByRef: ReadonlyMap<string, string>,
) => {
  if (clipIdsByRef.size === 0) return;
  for (const entry of entries) {
    if (entry.type !== "clip-create") continue;
    const clipId = clipIdsByRef.get(entry.data.clip.clipRef);
    if (clipId) {
      entry.data.clip.currentId = clipId;
    }
  }
};

export const createHistoryTrack = async (
  deps: Deps,
  track: {
    trackRef?: string;
    index: number;
    name?: string;
    volume?: number;
    muted?: boolean;
    soloed?: boolean;
    kind?: Track["kind"];
    channelRole?: Track["channelRole"];
    sends?: TrackRouting["sends"];
  },
) => {
  if (isLocalHistoryProject(deps)) {
    const row = await createLocalTimelineRepository(deps.projectId).createTrack({
      id: track.trackRef,
      historyRef: track.trackRef,
      name: track.name,
      index: track.index,
      volume: track.volume,
      muted: track.muted,
      soloed: track.soloed,
      kind: track.kind,
      channelRole: track.channelRole,
      sends: track.sends,
    });
    return row.id;
  }
  const payload = buildTrackCreateMutationInput({
    projectId: deps.projectId,
    index: track.index,
    kind: track.kind,
    channelRole: track.channelRole,
  });
  const operation = buildSharedTrackCreateOperation({
    index: payload.index,
    kind: payload.kind,
    channelRole: payload.channelRole,
  });
  const result = await publishSharedTimelineOperationOrQueue({ projectId: deps.projectId, userId: deps.userId, operation });
  if (typeof result !== "string") throw new Error("Failed to create history track");
  return result;
};

export const createHistoryClip = async (
  deps: Deps,
  trackId: Track["id"],
  clip: ClipCreateSnapshot & { clipRef?: string; currentId?: string },
) => {
  if (isLocalHistoryProject(deps)) {
    const clipRef = clip.clipRef ?? clip.currentId;
    if (!clipRef) throw new Error("Missing clip reference for local history clip creation");
    return (await createLocalTimelineRepository(deps.projectId).createClip(
      toHistoryCreateClipInput(trackId, buildLocalClip({ id: clipRef, clip })),
    )).id;
  }
  const operation = buildSharedClipCreateOperation(buildClipCreatePayload({ projectId: deps.projectId, trackId, clip }));
  const result = await publishSharedTimelineOperationOrQueue({ projectId: deps.projectId, userId: deps.userId, operation });
  return typeof result === "string" ? result : null;
};

type TrackDeleteEffects = NonNullable<Extract<HistoryEntry, { type: "track-delete" }>["data"]["effects"]>;
type EffectParamsEntry = Extract<HistoryEntry, { type: "effect-params" }>;
type HistoryDirection = "undo" | "redo";

function pickDirectionalValue<T>(direction: HistoryDirection, from: T, to: T) {
  return direction === "undo" ? from : to;
}

const publishHistoryOperation = async (deps: Deps, operation: SharedTimelineOperation) => {
  await publishSharedTimelineOperationOrQueue({ projectId: deps.projectId, userId: deps.userId, operation });
};

export const persistHistoryTrackEffects = async (
  deps: Deps,
  trackId: Track["id"],
  effects: TrackDeleteEffects | undefined,
) => {
  if (!effects) return;
  if (isLocalHistoryProject(deps)) {
    await Promise.all([
      effects.eq ? setLocalEffect(deps.projectId, trackId, "eq", effects.eq) : null,
      effects.reverb ? setLocalEffect(deps.projectId, trackId, "reverb", effects.reverb) : null,
      effects.synth ? setLocalEffect(deps.projectId, trackId, "synth", effects.synth) : null,
      effects.arp ? setLocalEffect(deps.projectId, trackId, "arp", effects.arp) : null,
    ]);
    return;
  }
  await Promise.all([
    effects.eq ? publishHistoryOperation(deps, { kind: "effects.setEqParams", payload: { trackId, params: effects.eq } }) : null,
    effects.reverb ? publishHistoryOperation(deps, { kind: "effects.setReverbParams", payload: { trackId, params: effects.reverb } }) : null,
    effects.synth ? publishHistoryOperation(deps, { kind: "effects.setSynthParams", payload: { trackId, params: effects.synth } }) : null,
    effects.arp ? publishHistoryOperation(deps, { kind: "effects.setArpeggiatorParams", payload: { trackId, params: effects.arp } }) : null,
  ]);
};

export const persistHistoryEffectParams = async (
  deps: Deps,
  entry: EffectParamsEntry,
  targetId: Track["id"] | "master",
  direction: HistoryDirection,
) => {
  if (isLocalHistoryProject(deps)) {
    const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
    await setLocalEffect(deps.projectId, targetId, entry.data.effect, params);
    return;
  }
  switch (entry.data.effect) {
    case "master-eq": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setMasterEqParams", payload: { params } });
      return;
    }
    case "master-reverb": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setMasterReverbParams", payload: { params } });
      return;
    }
    case "eq": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setEqParams", payload: { trackId: targetId, params } });
      return;
    }
    case "reverb": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setReverbParams", payload: { trackId: targetId, params } });
      return;
    }
    case "synth": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setSynthParams", payload: { trackId: targetId, params } });
      return;
    }
    case "arp": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setArpeggiatorParams", payload: { trackId: targetId, params } });
      return;
    }
  }
};

export const removeHistoryClipIdsOrThrow = async (deps: Deps, clipIds: string[], message: string) => {
  if (clipIds.length === 0) return;
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).deleteClips(clipIds);
    return;
  }
  const result = await deps.convexClient.mutation(
    deps.convexApi.clips.removeMany,
    buildClipRemoveManyMutationInput({ clipIds }),
  );
  const removedIds = new Set(
    Array.isArray(result?.removedClipIds)
      ? result.removedClipIds.map((clipId: unknown) => String(clipId))
      : [],
  );
  if (clipIds.some((clipId) => !removedIds.has(String(clipId)))) {
    throw new Error(message);
  }
};

export const removeHistoryTrackOrThrow = async (deps: Deps, trackId: Track["id"], message: string) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).deleteTrack(trackId);
    return;
  }
  const result = await deps.convexClient.mutation(
    deps.convexApi.tracks.remove,
    buildTrackDeleteMutationInput({ trackId }),
  );
  if (result?.status !== "deleted") {
    throw new Error(message);
  }
};

export const persistHistoryClipTimingOrThrow = async (
  deps: Deps,
  clipId: string,
  timing: ClipTimingPatch,
  message: string,
) => {
  if (isLocalHistoryProject(deps)) {
    const applied = await createLocalTimelineRepository(deps.projectId).updateClip({
      clipId,
      startSec: timing.startSec,
      duration: timing.duration,
      leftPadSec: timing.leftPadSec,
      bufferOffsetSec: timing.bufferOffsetSec,
      midiOffsetBeats: timing.midiOffsetBeats,
    });
    if (!applied) throw new Error(message);
    return;
  }
  const applied = await persistClipTiming(deps.convexClient, deps.convexApi, {
    clipId,
    startSec: timing.startSec,
    duration: timing.duration,
    leftPadSec: timing.leftPadSec ?? 0,
    bufferOffsetSec: timing.bufferOffsetSec ?? 0,
    midiOffsetBeats: timing.midiOffsetBeats ?? 0,
  });
  if (!applied) throw new Error(message);
};

export const persistHistoryClipMovesOrThrow = async (
  deps: Deps,
  moves: ClipMove[],
  message: string,
) => {
  if (moves.length === 0) return;
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).moveClips(moves);
    return;
  }
  const result = await deps.convexClient.mutation(
    deps.convexApi.clips.moveMany,
    buildClipMoveManyMutationInput({
      moves: moves.map((move) => ({
        clipId: move.clipId,
        startSec: move.startSec,
        toTrackId: move.trackId,
      })),
    }),
  );
  if (result?.status !== "applied") throw new Error(message);
};

export const persistHistoryTrackRouting = async (deps: Deps, trackId: Track["id"], routing: TrackRouting) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({
      trackId,
      outputTargetId: routing.outputTargetId ?? null,
      sends: routing.sends ?? [],
    });
    return;
  }
  await deps.convexClient.mutation(
    deps.convexApi.tracks.setRouting,
    buildTrackRoutingMutationInput({
      trackId,
      routing: { sends: routing.sends ?? [], outputTargetId: routing.outputTargetId },
    }),
  );
};

export const persistHistoryTrackMixState = async (
  deps: Pick<Deps, "convexClient" | "convexApi" | "userId">,
  trackId: Track["id"],
  mix: { muted?: boolean; soloed?: boolean },
) => {
  if (typeof mix.muted !== "boolean" && typeof mix.soloed !== "boolean") return;
  await deps.convexClient.mutation(deps.convexApi.tracks.setMix, buildTrackMixMutationInput({
    trackId,
    muted: mix.muted,
    soloed: mix.soloed,
  }));
};

export const persistHistoryTrackVolume = async (
  deps: Deps,
  trackId: Track["id"],
  volume: number,
  scope?: "local" | "shared",
) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({ trackId, volume });
  } else if (scope === "local") {
    deps.persistLocalMix(deps.projectId, trackId, { volume } satisfies LocalMixPatch);
  } else {
    await deps.convexClient.mutation(
      deps.convexApi.tracks.setVolume,
      buildTrackVolumeMutationInput({ trackId, volume }),
    );
  }
};

export const persistHistoryTrackMix = async (
  deps: Deps,
  trackId: Track["id"],
  patch: { muted?: boolean; soloed?: boolean },
  scope?: "local" | "shared",
) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({ trackId, ...patch });
  } else if (scope !== "local") {
    await persistHistoryTrackMixState(deps, trackId, patch);
  } else {
    deps.persistLocalMix(deps.projectId, trackId, patch);
  }
};
