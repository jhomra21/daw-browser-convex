import { isLocalId } from '~/lib/local-ids'
import { publishDurableSharedTimelineOperation } from '~/lib/shared-outbox'
import type { UpdateTrackInput } from '~/lib/timeline-repository/types'
import type { TrackRouting } from '~/types/timeline'

type TrackWriteContext = {
  projectId: string
  userId: string
  writeLocalTrack: (input: UpdateTrackInput) => Promise<unknown>
}

type TrackMixWriteResult = { status?: 'access-denied' | 'applied' | 'noop' | 'not-found' }

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readTrackMixWriteResult = (value: unknown): TrackMixWriteResult => {
  if (!isRecord(value)) return { status: 'applied' }
  const status = value.status
  if (status === 'access-denied' || status === 'applied' || status === 'noop' || status === 'not-found') {
    return { status }
  }
  return { status: 'applied' }
}

export const createTimelineTrackWriteAdapter = (context: TrackWriteContext) => {
  const updateLocalOrCloudTrack = async (
    localInput: UpdateTrackInput,
    writeCloud: (userId: string) => Promise<unknown>,
  ) => {
    if (isLocalId('project', context.projectId)) {
      return await context.writeLocalTrack(localInput)
    }
    if (!context.userId) return
    return await writeCloud(context.userId)
  }

  return {
    setRouting: async (trackId: string, routing: TrackRouting) => await updateLocalOrCloudTrack(
      {
        trackId,
        outputTargetId: routing.outputTargetId ?? null,
        sends: routing.sends ?? [],
      },
      async (userId) => await publishDurableSharedTimelineOperation({
        projectId: context.projectId,
        userId,
        operation: {
          kind: 'tracks.setRouting',
          payload: {
            trackId,
            routing: {
              sends: routing.sends ?? [],
              outputTargetId: routing.outputTargetId,
            },
          },
        },
        queuedResult: { status: 'applied' },
      }),
    ),
    setVolume: async (trackId: string, volume: number) => await updateLocalOrCloudTrack(
      { trackId, volume },
      async (userId) => await publishDurableSharedTimelineOperation({
        projectId: context.projectId,
        userId,
        operation: { kind: 'tracks.setVolume', payload: { trackId, volume } },
        queuedResult: { status: 'applied' },
      }),
    ),
    setMix: async (trackId: string, patch: { muted?: boolean; soloed?: boolean }): Promise<TrackMixWriteResult | undefined> => {
      if (patch.muted === undefined && patch.soloed === undefined) return undefined
      if (isLocalId('project', context.projectId)) {
        await context.writeLocalTrack({ trackId, muted: patch.muted, soloed: patch.soloed })
        return { status: 'applied' }
      }
      if (!context.userId) return undefined
      const userId = context.userId
      const result = await publishDurableSharedTimelineOperation({
        projectId: context.projectId,
        userId,
        operation: {
          kind: 'tracks.setMix',
          payload: {
            trackId,
            muted: patch.muted,
            soloed: patch.soloed,
          },
        },
        queuedResult: { status: 'applied' },
      })
      return readTrackMixWriteResult(result)
    },
  }
}
