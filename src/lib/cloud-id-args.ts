import type { Id } from '../../convex/_generated/dataModel'
import type { TrackId } from '~/types/timeline'

export const toCloudClipId = (clipId: string): Id<'clips'> => clipId as Id<'clips'>
export const toCloudTrackId = (trackId: TrackId): Id<'tracks'> => trackId as Id<'tracks'>
export const toCloudTrackIdOptional = (trackId: TrackId | undefined): Id<'tracks'> | undefined => (
  trackId === undefined ? undefined : toCloudTrackId(trackId)
)
