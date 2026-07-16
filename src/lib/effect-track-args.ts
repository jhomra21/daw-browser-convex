import { toCloudTrackId } from '~/lib/cloud-id-args'
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
