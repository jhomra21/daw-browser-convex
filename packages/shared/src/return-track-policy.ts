type TrackOrderRow = {
  index?: number
  channelRole?: string
  groupId?: string | null
}

const orderedTracks = <Row extends TrackOrderRow>(tracks: readonly Row[]) => (
  [...tracks].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
)

export const isReturnTrack = (track: Pick<TrackOrderRow, 'channelRole'>) => (
  track.channelRole === 'return'
)

export const canonicalTrackCreation = <Row extends TrackOrderRow>(
  tracks: readonly Row[],
  channelRole: string | undefined,
  requestedIndex?: number,
) => {
  const ordered = orderedTracks(tracks)
  const nonReturns = ordered.filter((track) => !isReturnTrack(track))
  const returns = ordered.filter(isReturnTrack)
  const createsReturn = channelRole === 'return'
  const minimum = createsReturn ? nonReturns.length : 0
  const maximum = createsReturn ? ordered.length : nonReturns.length
  const creationIndex = requestedIndex === undefined
    ? maximum
    : Math.max(minimum, Math.min(requestedIndex, maximum))
  const canonicalOrder = [...nonReturns, ...returns]

  return {
    creationIndex,
    existingTracks: canonicalOrder.map((track, index) => ({
      ...track,
      index: index < creationIndex ? index : index + 1,
      groupId: isReturnTrack(track) ? undefined : track.groupId,
    })),
  }
}

export const trackCreationIndex = (
  tracks: readonly TrackOrderRow[],
  channelRole: string | undefined,
  requestedIndex?: number,
) => canonicalTrackCreation(tracks, channelRole, requestedIndex).creationIndex

export const trackCreationCollapsed = (
  channelRole: string | undefined,
  collapsed: boolean | undefined,
) => collapsed ?? channelRole === 'return'

export const hasValidReturnTrackPartition = (
  tracks: readonly TrackOrderRow[],
) => {
  let sawReturn = false
  for (const track of orderedTracks(tracks)) {
    if (isReturnTrack(track)) {
      sawReturn = true
      if (track.groupId !== undefined && track.groupId !== null) return false
    } else if (sawReturn) {
      return false
    }
  }
  return true
}
