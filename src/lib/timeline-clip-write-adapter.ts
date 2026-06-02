import { isLocalId } from '~/lib/local-ids'
import { publishSharedTimelineOperationOrQueue } from '~/lib/shared-outbox'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { MoveClipInput } from '~/lib/timeline-repository/types'

type ClipWriteContext = {
  projectId: string
  userId: string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

export const createTimelineClipWriteAdapter = (context: ClipWriteContext) => ({
  deleteClips: async (clipIds: string[]) => {
    if (clipIds.length === 0) return new Set<string>()
    if (isLocalId('project', context.projectId)) {
      await createLocalTimelineRepository(context.projectId).deleteClips(clipIds)
      return new Set(clipIds)
    }
    if (!context.userId) return new Set<string>()
    const userId = context.userId
    const result = await publishSharedTimelineOperationOrQueue({
      projectId: context.projectId,
      userId,
      operation: { kind: 'clips.removeMany', payload: { clipIds } },
      queuedResult: { removedClipIds: clipIds },
    })
    return new Set(
      isRecord(result) && Array.isArray(result.removedClipIds)
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
    const userId = context.userId
    const result = await publishSharedTimelineOperationOrQueue({
      projectId: context.projectId,
      userId,
      operation: { kind: 'clips.moveMany', payload: { moves } },
      queuedResult: { status: 'applied' },
    })
    return isRecord(result) && result.status === 'applied'
  },
})
