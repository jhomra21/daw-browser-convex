import {
  isClipKindCompatibleWithTrack as isClipKindCompatibleWithTrackCore,
  normalizeTrackChannelRole,
  normalizeTrackRouting as normalizeTrackRoutingCore,
} from "../src/lib/track-routing-core";

type TrackLike = {
  _id: string
  channelRole?: string
  kind?: string
}

type SendLike<TTrackId extends string> = {
  targetId: TTrackId
  amount: number
}

const sanitizeTrackRouting = <TTrackId extends string>(
  sourceTrack: { _id: TTrackId; channelRole?: string } | null | undefined,
  routing: {
    sends?: Array<SendLike<TTrackId>>
    outputTargetId?: TTrackId
  },
  tracks: TrackLike[],
) => {
  return normalizeTrackRoutingCore({
    track: sourceTrack ? { id: sourceTrack._id, channelRole: sourceTrack.channelRole } : null,
    sends: routing.sends,
    outputTargetId: routing.outputTargetId,
    tracks: tracks.map((track) => ({ id: track._id, channelRole: track.channelRole })),
  })
}

export {
  isClipKindCompatibleWithTrackCore as isClipKindCompatibleWithTrack,
  normalizeTrackChannelRole as sanitizeChannelRole,
  sanitizeTrackRouting,
}
