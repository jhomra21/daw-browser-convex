import type { Id } from '../../convex/_generated/dataModel'
import type { TrackId } from '@daw-browser/timeline-core/types'

export const toCloudClipId = (clipId: string): Id<'clips'> => {
  // SAFETY: Convex IDs are branded strings at compile time and validated by the destination mutation.
  return clipId as Id<'clips'>
}
export const toCloudTrackId = (trackId: TrackId): Id<'tracks'> => {
  // SAFETY: Convex IDs are branded strings at compile time and validated by the destination mutation.
  return trackId as Id<'tracks'>
}
export const toCloudTrackIdOptional = (trackId: TrackId | undefined): Id<'tracks'> | undefined => (
  trackId === undefined ? undefined : toCloudTrackId(trackId)
)
