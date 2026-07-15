import type { Track } from '@daw-browser/timeline-core/types'

type TrackOrderEntry = Pick<Track, 'channelRole'>

export const trackCreationIndex = (
  tracks: readonly TrackOrderEntry[],
  channelRole: Track['channelRole'],
  requestedIndex?: number,
) => {
  const isReturn = channelRole === 'return'
  const firstReturn = tracks.findIndex((track) => track.channelRole === 'return')
  const start = isReturn ? (firstReturn < 0 ? tracks.length : firstReturn) : 0
  const end = isReturn ? tracks.length : (firstReturn < 0 ? tracks.length : firstReturn)
  const defaultIndex = end
  if (requestedIndex === undefined) return defaultIndex
  return Math.max(start, Math.min(requestedIndex, end))
}
