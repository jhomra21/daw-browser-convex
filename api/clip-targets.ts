import {
  getTrackAcceptedClipKind,
  normalizeTrackChannelRole,
  type RoutingClipKind,
} from '../src/lib/track-routing-core'

type TrackLike = {
  kind?: string
  channelRole?: string
}

type ClipLike = {
  midi?: unknown
}

export function getClipKindFromClip(clip: ClipLike | null | undefined): RoutingClipKind {
  return clip?.midi ? 'midi' : 'audio'
}

export function getClipTargetError(
  track: TrackLike | null | undefined,
  clipKind: RoutingClipKind,
): string | null {
  const channelRole = normalizeTrackChannelRole(track?.channelRole)
  if (channelRole !== 'track') {
    return 'Group and return channels cannot contain clips'
  }

  const acceptedClipKind = getTrackAcceptedClipKind(track)
  if (acceptedClipKind === clipKind) return null
  return clipKind === 'midi'
    ? 'Cannot place MIDI clips on audio tracks'
    : 'Cannot place audio clips on instrument tracks'
}
