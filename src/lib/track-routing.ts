import {
  canTrackReceiveAudioClipKind,
  isClipKindCompatibleWithTrack,
  normalizeTrackChannelRole,
  normalizeTrackRouting as normalizeTrackRoutingCore,
} from '~/lib/track-routing-core'
import type { Clip, Track, TrackChannelRole, TrackRouting } from '~/types/timeline'

type ClipKind = 'audio' | 'midi'

export function getTrackChannelRole(track: Pick<Track, 'channelRole'> | null | undefined): TrackChannelRole {
  return normalizeTrackChannelRole(track?.channelRole)
}

const getClipKind = (clip: Pick<Clip, 'midi'> | { midi?: unknown } | null | undefined): ClipKind =>
  clip?.midi ? 'midi' : 'audio'

export function isClipCompatibleWithTrack(
  track: Pick<Track, 'channelRole' | 'kind'> | null | undefined,
  clip: Pick<Clip, 'midi'> | { midi?: unknown } | null | undefined,
) {
  return isClipKindCompatibleWithTrack(track, getClipKind(clip))
}

export function canTrackReceiveAudioClip(track: Pick<Track, 'channelRole' | 'kind'> | null | undefined) {
  return canTrackReceiveAudioClipKind(track)
}

export function normalizeTrackRouting(
  track: Pick<Track, 'id' | 'channelRole'> | null | undefined,
  routing: TrackRouting,
  tracks: Array<Pick<Track, 'id' | 'channelRole'>>,
) {
  return normalizeTrackRoutingCore({
    track,
    sends: routing.sends,
    outputTargetId: routing.outputTargetId,
    tracks,
  })
}
