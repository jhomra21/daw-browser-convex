import { buildClipMoveMutationInput, buildClipRemoveManyMutationInput } from "~/lib/clip-mutation-args";
import { persistClipTiming } from "~/lib/clip-mutations";
import { isLocalId } from "~/lib/local-ids";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { buildTrackDeleteMutationInput, buildTrackMixMutationInput, buildTrackVolumeMutationInput } from "~/lib/track-mutation-args";
import { buildTrackRoutingMutationInput } from "~/lib/track-routing-state";
import type { LocalMixPatch } from "~/lib/timeline-storage";
import type { Track, TrackRouting } from "~/types/timeline";
import type { Deps } from "./exec";

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
  for (const move of moves) {
    const result = await deps.convexClient.mutation(
      deps.convexApi.clips.move,
      buildClipMoveMutationInput({
        clipId: move.clipId,
        userId: deps.userId,
        startSec: move.startSec,
        toTrackId: move.trackId,
      }),
    );
    if (result?.status !== "applied") throw new Error(message);
  }
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
