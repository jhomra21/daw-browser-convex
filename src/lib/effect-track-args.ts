import { toCloudTrackId } from '~/lib/cloud-id-args'
import { convexApi } from '~/lib/convex'
import type { TrackId } from '~/types/timeline'

export function buildTrackEffectQueryArgs(input: {
  projectId: string
  userId: string
  trackId: TrackId
}) {
  return {
    projectId: input.projectId,
    userId: input.userId,
    trackId: toCloudTrackId(input.trackId),
  }
}

export function buildTrackEffectMutationInput<TParams>(input: {
  projectId: string
  userId: string
  trackId: TrackId
  params: TParams
}) {
  return {
    ...input,
    trackId: toCloudTrackId(input.trackId),
  }
}
