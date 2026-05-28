import { convexApi, convexClient } from '~/lib/convex'
import { isLocalId } from '~/lib/local-ids'
import type { UpdateTrackInput } from '~/lib/timeline-repository/types'
import { buildTrackMixMutationInput, buildTrackVolumeMutationInput } from '~/lib/track-mutation-args'
import { buildTrackRoutingMutationInput } from '~/lib/track-routing-state'
import type { TrackRouting } from '~/types/timeline'

type TrackWriteContext = {
  projectId: string
  userId: string
  writeLocalTrack: (input: UpdateTrackInput) => Promise<unknown>
}

type TrackMixWriteResult = { status?: 'access-denied' | 'applied' | 'noop' | 'not-found' }

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
      async (userId) => await convexClient.mutation(
        convexApi.tracks.setRouting,
        buildTrackRoutingMutationInput({
          trackId,
          userId,
          routing: {
            sends: routing.sends ?? [],
            outputTargetId: routing.outputTargetId,
          },
        }),
      ),
    ),
    setVolume: async (trackId: string, volume: number) => await updateLocalOrCloudTrack(
      { trackId, volume },
      async (userId) => await convexClient.mutation(
        convexApi.tracks.setVolume,
        buildTrackVolumeMutationInput({ trackId, volume, userId }),
      ),
    ),
    setMix: async (trackId: string, patch: { muted?: boolean; soloed?: boolean }): Promise<TrackMixWriteResult | undefined> => {
      if (patch.muted === undefined && patch.soloed === undefined) return undefined
      if (isLocalId('project', context.projectId)) {
        await context.writeLocalTrack({ trackId, muted: patch.muted, soloed: patch.soloed })
        return { status: 'applied' }
      }
      if (!context.userId) return undefined
      return await convexClient.mutation(convexApi.tracks.setMix, buildTrackMixMutationInput({
        trackId,
        userId: context.userId,
        muted: patch.muted,
        soloed: patch.soloed,
      }))
    },
  }
}
