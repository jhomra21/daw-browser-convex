import {
  isClipKindCompatibleWithTrack as isClipKindCompatibleWithTrackCore,
  normalizeTrackChannelRole,
  normalizeTrackRouting as normalizeTrackRoutingCore,
} from "@daw-browser/shared";

type TrackLike<TTrackId extends string> = {
  _id: TTrackId
  channelRole?: string
  kind?: string
  groupId?: TTrackId
}

type SendLike<TTrackId extends string> = {
  targetId: TTrackId
  amount: number
}

const sanitizeTrackRouting = <TTrackId extends string>(
  sourceTrack: { _id: TTrackId; channelRole?: string; groupId?: TTrackId } | null | undefined,
  routing: {
    sends?: Array<SendLike<TTrackId>>
    outputTargetId?: TTrackId
  },
  tracks: Array<TrackLike<TTrackId>>,
) => {
  return normalizeTrackRoutingCore({
    track: sourceTrack ? { id: sourceTrack._id, channelRole: sourceTrack.channelRole, groupId: sourceTrack.groupId } : null,
    sends: routing.sends,
    outputTargetId: routing.outputTargetId,
    tracks: tracks.map((track) => ({ id: track._id, channelRole: track.channelRole, groupId: track.groupId })),
  })
}

export {
  isClipKindCompatibleWithTrackCore as isClipKindCompatibleWithTrack,
  normalizeTrackChannelRole as sanitizeChannelRole,
  sanitizeTrackRouting,
}
