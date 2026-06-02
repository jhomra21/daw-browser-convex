import { buildCreatedClipSelection, createProjectedClips, createProjectedLocalClips, pushClipCreateHistory, type BatchClipCreateItem } from "~/lib/clip-create";
import { isLocalId } from "~/lib/local-ids";
import type { OptimisticGrantScope } from "~/lib/optimistic-grant-scope";
import { buildClipsMoveHistoryEntry } from "~/lib/undo/builders";
import { getTrackHistoryRef } from "~/lib/undo/refs";
import type { HistoryEntry } from "~/lib/undo/types";
import type { Clip, Track } from "~/types/timeline";
import { pushTrackCreateHistory } from "./tracks";

type ClipMove = { clipId: string; trackId: Track["id"]; startSec: number };

type SelectionController = {
  selectClipGroup: (selection: { trackId: Track["id"]; clipIds: string[]; primaryClipId: string }) => void;
  selectPrimaryClip: (
    clip: { trackId: Track["id"]; clipId: string },
    options?: { preserveClipIds: boolean },
  ) => void;
};

type DuplicateCommitInput = {
  projectId: string;
  userId?: string;
  items: BatchClipCreateItem[];
  baseTracks: Track[];
  addedTrackId: Track["id"] | null;
  placementTracks: () => Track[];
  insertLocalClip: (trackId: Track["id"], clip: Clip) => void;
  removeLocalClips: (clipIds: Iterable<string>) => void;
  audioBufferCache: Map<string, AudioBuffer>;
  canProject?: () => boolean;
  grantClipWrites?: (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => void;
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void;
  createManyCloudClips: Parameters<typeof createProjectedClips>[0]["createMany"];
  selection: SelectionController;
};

export const commitDuplicatedClipDrag = async (input: DuplicateCommitInput) => {
  const created = isLocalId("project", input.projectId)
    ? await createProjectedLocalClips({
      projectId: input.projectId,
      items: input.items,
      insertLocalClip: input.insertLocalClip,
      removeLocalClips: input.removeLocalClips,
      audioBufferCache: input.audioBufferCache,
      canProject: input.canProject,
    })
    : await createProjectedCloudClips(input);

  const nextSelection = buildCreatedClipSelection(created);
  if (nextSelection) input.selection.selectClipGroup(nextSelection);

  if (input.addedTrackId && created.some((item) => item.trackId === input.addedTrackId)) {
    pushTrackCreateHistory(
      input.historyPush,
      input.projectId,
      input.placementTracks(),
      input.placementTracks().find((entry) => entry.id === input.addedTrackId),
    );
  }

  for (const item of created) {
    pushClipCreateHistory({
      historyPush: input.historyPush,
      projectId: input.projectId,
      trackId: item.trackId,
      trackRef: getTrackHistoryRef(input.baseTracks.find((entry) => entry.id === item.trackId)),
      clipId: item.clipId,
      clip: item.clip,
    });
  }

  return created;
};

const createProjectedCloudClips = async (input: DuplicateCommitInput) => {
  if (!input.userId) {
    throw new Error("Cloud clip duplication requires a user id.");
  }
  return await createProjectedClips({
    projectId: input.projectId,
    items: input.items,
    createMany: input.createManyCloudClips,
    insertLocalClip: input.insertLocalClip,
    audioBufferCache: input.audioBufferCache,
    grantClipWrites: input.grantClipWrites,
    grantScope: { projectId: input.projectId, userId: input.userId },
  });
};

type MoveCommitInput = {
  projectId: string;
  userId: string;
  plannedMoves: ClipMove[];
  previousMoves: ClipMove[];
  previousPositions: Map<string, { trackId: Track["id"]; startSec: number }>;
  selectionAfterCommit: { trackId: Track["id"]; clipId: string; preserveClipIds?: boolean };
  addedTrackId: Track["id"] | null;
  trackSnapshotForHistory: Track[];
  commitClipMoves: (moves: ClipMove[]) => void;
  cleanupUnusedAddedTrack: (trackId?: Track["id"] | null) => void;
  onCommitMoves?: (clipIds: string[]) => void;
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void;
  moveLocalClips: (moves: ClipMove[]) => Promise<void>;
  moveCloudClip: (move: ClipMove) => Promise<boolean>;
  selection: Pick<SelectionController, "selectPrimaryClip">;
};

const pushMoveHistory = (
  input: MoveCommitInput,
  successfulMoves: ClipMove[],
) => {
  if (successfulMoves.length === 0) return;
  input.onCommitMoves?.(successfulMoves.map((move) => move.clipId));
  if (typeof input.historyPush !== "function") return;
  if (input.addedTrackId && successfulMoves.some((move) => move.trackId === input.addedTrackId)) {
    pushTrackCreateHistory(
      input.historyPush,
      input.projectId,
      input.trackSnapshotForHistory,
      input.trackSnapshotForHistory.find((entry) => entry.id === input.addedTrackId),
    );
  }
  input.historyPush(buildClipsMoveHistoryEntry({
    projectId: input.projectId,
    tracks: input.trackSnapshotForHistory,
    moves: successfulMoves.map((move) => ({
      clipId: move.clipId,
      from: input.previousPositions.get(move.clipId) ?? { trackId: move.trackId, startSec: move.startSec },
      to: { trackId: move.trackId, startSec: move.startSec },
    })),
  }));
};

export const commitMovedClipDrag = async (input: MoveCommitInput) => {
  if (isLocalId("project", input.projectId)) {
    await input.moveLocalClips(input.plannedMoves);
    pushMoveHistory(input, input.plannedMoves);
    return;
  }

  const moveApplied = await Promise.all(input.plannedMoves.map(async (move) => {
    try {
      return await input.moveCloudClip(move);
    } catch {
      return false;
    }
  }));
  const successfulMoves = input.plannedMoves.filter((_, index) => moveApplied[index]);
  const failedMoves = input.previousMoves.filter((_, index) => !moveApplied[index]);

  if (failedMoves.length > 0) {
    input.commitClipMoves(failedMoves);
    if (input.addedTrackId && input.plannedMoves.some((move, index) => !moveApplied[index] && move.trackId === input.addedTrackId)) {
      input.cleanupUnusedAddedTrack(input.addedTrackId);
    }
    for (const rollbackAnchor of failedMoves) {
      if (rollbackAnchor.clipId === input.selectionAfterCommit.clipId) {
        input.selection.selectPrimaryClip(
          { trackId: rollbackAnchor.trackId, clipId: rollbackAnchor.clipId },
          input.selectionAfterCommit.preserveClipIds ? { preserveClipIds: true } : undefined,
        );
        break;
      }
    }
  }

  pushMoveHistory(input, successfulMoves);
};
