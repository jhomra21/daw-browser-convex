import { buildClipMoveManyMutationInput, buildClipRemoveManyMutationInput } from '~/lib/clip-mutation-args'
import { convexApi, convexClient } from '~/lib/convex'
import { isLocalId } from '~/lib/local-ids'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { MoveClipInput } from '~/lib/timeline-repository/types'

type ClipWriteContext = {
  projectId: string
  userId: string | undefined
}

export const createTimelineClipWriteAdapter = (context: ClipWriteContext) => ({
  deleteClips: async (clipIds: string[]) => {
    if (clipIds.length === 0) return new Set<string>()
    if (isLocalId('project', context.projectId)) {
      await createLocalTimelineRepository(context.projectId).deleteClips(clipIds)
      return new Set(clipIds)
    }
    if (!context.userId) return new Set<string>()
    const result = await convexClient.mutation(
      convexApi.clips.removeMany,
      buildClipRemoveManyMutationInput({ clipIds, userId: context.userId }),
    )
    return new Set(
      Array.isArray(result?.removedClipIds)
        ? result.removedClipIds.map((clipId: unknown) => String(clipId))
        : [],
    )
  },
  moveClips: async (moves: MoveClipInput[]) => {
    if (moves.length === 0) return false
    if (isLocalId('project', context.projectId)) {
      await createLocalTimelineRepository(context.projectId).moveClips(moves)
      return true
    }
    if (!context.userId) return false
    const result = await convexClient.mutation(
      convexApi.clips.moveMany,
      buildClipMoveManyMutationInput({
        moves: moves.map((move) => ({
          clipId: move.clipId,
          startSec: move.startSec,
          toTrackId: move.trackId,
        })),
        userId: context.userId,
      }),
    )
    return result?.status === 'applied'
  },
})
