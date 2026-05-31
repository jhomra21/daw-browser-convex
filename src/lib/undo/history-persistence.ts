import { buildClipCreatePayload, buildLocalClip, type ClipCreateSnapshot } from "~/lib/clip-create";
import { buildClipMoveManyMutationInput, buildClipRemoveManyMutationInput } from "~/lib/clip-mutation-args";
import { persistClipTiming } from "~/lib/clip-mutations";
import { buildTrackEffectMutationInput } from "~/lib/effect-track-args";
import { setLocalEffect } from "~/lib/local-effects";
import { isLocalId } from "~/lib/local-ids";
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
  return await deps.convexClient.mutation(
    deps.convexApi.tracks.create,
    buildTrackCreateMutationInput({
      projectId: deps.projectId,
      userId: deps.userId,
      index: track.index,
      kind: track.kind,
      channelRole: track.channelRole,
    }),
  );
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
  return await deps.convexClient.mutation(
    deps.convexApi.clips.create,
    buildClipCreatePayload({ projectId: deps.projectId, userId: deps.userId, trackId, clip }),
  );
};

type TrackDeleteEffects = NonNullable<Extract<HistoryEntry, { type: "track-delete" }>["data"]["effects"]>;
type EffectParamsEntry = Extract<HistoryEntry, { type: "effect-params" }>;
type HistoryDirection = "undo" | "redo";

function pickDirectionalValue<T>(direction: HistoryDirection, from: T, to: T) {
  return direction === "undo" ? from : to;
}

export const persistHistoryTrackEffects = async (
  deps: Deps,
  trackId: Track["id"],
  effects: TrackDeleteEffects | undefined,
) => {
  if (!effects) return;
  if (isLocalHistoryProject(deps)) {
    if (effects.eq) await setLocalEffect(deps.projectId, trackId, "eq", effects.eq);
    if (effects.reverb) await setLocalEffect(deps.projectId, trackId, "reverb", effects.reverb);
    if (effects.synth) await setLocalEffect(deps.projectId, trackId, "synth", effects.synth);
    if (effects.arp) await setLocalEffect(deps.projectId, trackId, "arp", effects.arp);
    return;
  }
  if (effects.eq) await deps.convexClient.mutation(deps.convexApi.effects.setEqParams, buildTrackEffectMutationInput({ projectId: deps.projectId, trackId, userId: deps.userId, params: effects.eq }));
  if (effects.reverb) await deps.convexClient.mutation(deps.convexApi.effects.setReverbParams, buildTrackEffectMutationInput({ projectId: deps.projectId, trackId, userId: deps.userId, params: effects.reverb }));
  if (effects.synth) await deps.convexClient.mutation(deps.convexApi.effects.setSynthParams, buildTrackEffectMutationInput({ projectId: deps.projectId, trackId, userId: deps.userId, params: effects.synth }));
  if (effects.arp) await deps.convexClient.mutation(deps.convexApi.effects.setArpeggiatorParams, buildTrackEffectMutationInput({ projectId: deps.projectId, trackId, userId: deps.userId, params: effects.arp }));
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
      await deps.convexClient.mutation(deps.convexApi.effects.setMasterEqParams, { projectId: deps.projectId, userId: deps.userId, params });
      return;
    }
    case "master-reverb": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await deps.convexClient.mutation(deps.convexApi.effects.setMasterReverbParams, { projectId: deps.projectId, userId: deps.userId, params });
      return;
    }
    case "eq": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await deps.convexClient.mutation(deps.convexApi.effects.setEqParams, buildTrackEffectMutationInput({ projectId: deps.projectId, trackId: targetId, userId: deps.userId, params }));
      return;
    }
    case "reverb": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await deps.convexClient.mutation(deps.convexApi.effects.setReverbParams, buildTrackEffectMutationInput({ projectId: deps.projectId, trackId: targetId, userId: deps.userId, params }));
      return;
    }
    case "synth": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await deps.convexClient.mutation(deps.convexApi.effects.setSynthParams, buildTrackEffectMutationInput({ projectId: deps.projectId, trackId: targetId, userId: deps.userId, params }));
      return;
    }
    case "arp": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await deps.convexClient.mutation(deps.convexApi.effects.setArpeggiatorParams, buildTrackEffectMutationInput({ projectId: deps.projectId, trackId: targetId, userId: deps.userId, params }));
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
    buildClipRemoveManyMutationInput({ clipIds, userId: deps.userId }),
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
    buildTrackDeleteMutationInput({ trackId, userId: deps.userId }),
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
  const applied = await persistClipTiming(deps.convexClient, deps.convexApi, deps.userId, {
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
      userId: deps.userId,
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
      userId: deps.userId,
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
    userId: deps.userId,
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
      buildTrackVolumeMutationInput({ trackId, volume, userId: deps.userId }),
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
