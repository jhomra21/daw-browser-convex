import type { Track } from '@daw-browser/timeline-core/types'
import { DEFAULT_AUTOMATION_LANE_HEIGHT, LANE_HEIGHT } from '~/lib/timeline-utils'

export type TimelineTrackLayoutRow = {
  trackId: Track['id']
  topPx: number
  heightPx: number
  clipLaneHeightPx: number
  automationHeightPx: number
}

export const buildTimelineTrackLayoutRows = (input: {
  tracks: readonly Pick<Track, 'id'>[]
  visibleByTrackId: Record<string, boolean | undefined>
  heightsByLaneOwnerKey: Record<string, number | undefined>
  visibleParameterIdsByTrackId: Record<string, readonly string[] | undefined>
}): TimelineTrackLayoutRow[] => {
  let topPx = 0
  return input.tracks.map((track) => {
    const automationHeightPx = input.visibleByTrackId[track.id] === true
      ? (input.heightsByLaneOwnerKey[track.id] ?? DEFAULT_AUTOMATION_LANE_HEIGHT)
        * (input.visibleParameterIdsByTrackId[track.id]?.length || 1)
      : 0
    const row = {
      trackId: track.id,
      topPx,
      heightPx: LANE_HEIGHT + automationHeightPx,
      clipLaneHeightPx: LANE_HEIGHT,
      automationHeightPx,
    }
    topPx += row.heightPx
    return row
  })
}

export const trackIndexAtY = (
  rows: readonly TimelineTrackLayoutRow[],
  y: number,
) => rows.findIndex((row) => y >= row.topPx && y < row.topPx + row.heightPx)

export const trackIdsInYRange = (
  rows: readonly TimelineTrackLayoutRow[],
  startY: number,
  endY: number,
) => {
  const top = Math.min(startY, endY)
  const bottom = Math.max(startY, endY)

  return rows
    .filter((row) => row.topPx < bottom && row.topPx + row.heightPx > top)
    .map((row) => row.trackId)
}
