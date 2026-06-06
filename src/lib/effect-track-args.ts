import { toCloudTrackId } from '~/lib/cloud-id-args'
import { convexApi } from '~/lib/convex'
import type { TrackId } from '@daw-browser/timeline-core/types'

export function buildTrackEffectQueryArgs(input: {
  projectId: string
  trackId: TrackId
}) {
  return {
    projectId: input.projectId,
    trackId: toCloudTrackId(input.trackId),
  }
}

export function buildTrackEffectMutationInput<TParams>(input: {
  projectId: string
  trackId: TrackId
  params: TParams
}) {
  return {
    projectId: input.projectId,
    trackId: toCloudTrackId(input.trackId),
    params: input.params,
  }
}
