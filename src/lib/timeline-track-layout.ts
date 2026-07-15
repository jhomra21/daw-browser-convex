import { collectTrackDescendantIds } from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import { clientYToTimelineTrackY, COLLAPSED_LANE_HEIGHT, DEFAULT_AUTOMATION_LANE_HEIGHT, LANE_HEIGHT } from '~/lib/timeline-utils'

export type TimelineTrackLayoutRow = {
  trackId: Track['id']
  topPx: number
  heightPx: number
  clipLaneHeightPx: number
  automationHeightPx: number
  depth: number
  groupId?: Track['id']
}

export type TimelineTrackLayout = {
  scrollingRows: TimelineTrackLayoutRow[]
  returnRows: TimelineTrackLayoutRow[]
  displayTrackIds: Track['id'][]
  scrollingHeightPx: number
  returnHeightPx: number
}

type TrackTreeNode = {
  trackId: Track['id']
  children: TrackTreeNode[]
}

export const buildTrackTree = (
  tracks: readonly Pick<Track, 'id' | 'groupId' | 'channelRole'>[],
): TrackTreeNode[] => {
  const nodes = new Map<string, TrackTreeNode>()
  for (const track of tracks) {
    nodes.set(track.id, { trackId: track.id, children: [] })
  }

  const roots: TrackTreeNode[] = []
  for (const track of tracks) {
    const node = nodes.get(track.id)
    if (!node) continue
    const parent = track.groupId ? nodes.get(track.groupId) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

export const flattenVisibleTracks = (
  tree: readonly TrackTreeNode[],
  collapsedById: Map<string, boolean> | Record<string, boolean | undefined>,
): string[] => {
  const result: string[] = []
  const isCollapsed = collapsedById instanceof Map
    ? (trackId: string) => collapsedById.get(trackId) === true
    : (trackId: string) => collapsedById[trackId] === true
  const walk = (nodes: readonly TrackTreeNode[]) => {
    for (const node of nodes) {
      result.push(node.trackId)
      if (!isCollapsed(node.trackId)) walk(node.children)
    }
  }
  walk(tree)
  return result
}

export const computeDepthMap = (tree: readonly TrackTreeNode[]): Map<string, number> => {
  const depths = new Map<string, number>()
  const walk = (nodes: readonly TrackTreeNode[], depth: number) => {
    for (const node of nodes) {
      depths.set(node.trackId, depth)
      walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return depths
}

export const wouldCreateCycle = (
  tracks: readonly Pick<Track, 'id' | 'groupId'>[],
  trackId: string,
  proposedGroupId: string,
): boolean => {
  const parentOf = new Map<string, string>()
  for (const track of tracks) {
    if (track.groupId) parentOf.set(track.id, track.groupId)
  }

  let current: string | undefined = proposedGroupId
  while (current) {
    if (current === trackId) return true
    current = parentOf.get(current)
  }
  return false
}

export type GroupClipOverviewSegment = { startSec: number; endSec: number; color: string }

export const buildGroupClipOverview = (
  groupId: Track['id'],
  tracks: readonly Track[],
): GroupClipOverviewSegment[] => {
  const descendantIds = collectTrackDescendantIds(tracks, groupId)
  const segments = tracks.filter((track) => descendantIds.has(track.id)).flatMap((track) => (
    track.clips.map((clip) => ({
      startSec: clip.startSec,
      endSec: clip.startSec + clip.duration,
      color: clip.color,
    }))
  ))

  segments.sort((left, right) => left.startSec - right.startSec)
  const merged: GroupClipOverviewSegment[] = []
  for (const segment of segments) {
    const last = merged[merged.length - 1]
    if (last && last.color === segment.color && segment.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, segment.endSec)
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}

type TrackLayoutRowOptions = {
  depthByTrackId?: ReadonlyMap<string, number>
  visibleByTrackId: Record<string, boolean | undefined>
  heightsByLaneOwnerKey: Record<string, number | undefined>
  visibleParameterIdsByTrackId: Record<string, readonly string[] | undefined>
}

const buildRowsForOrderedTracks = (
  tracks: readonly Pick<Track, 'id' | 'groupId' | 'channelRole' | 'collapsed'>[],
  options: TrackLayoutRowOptions,
): TimelineTrackLayoutRow[] => {
  let topPx = 0
  return tracks.map((track) => {
    const clipLaneHeightPx = trackClipLaneHeight(track)
    const automationHeightPx = track.collapsed === true
      ? 0
      : options.visibleByTrackId[track.id] === true
      ? (options.heightsByLaneOwnerKey[track.id] ?? DEFAULT_AUTOMATION_LANE_HEIGHT)
        * (options.visibleParameterIdsByTrackId[track.id]?.length || 1)
      : 0
    const row = {
      trackId: track.id,
      topPx,
      heightPx: clipLaneHeightPx + automationHeightPx,
      clipLaneHeightPx,
      automationHeightPx,
      depth: options.depthByTrackId?.get(track.id) ?? 0,
      groupId: track.groupId,
    }
    topPx += row.heightPx
    return row
  })
}

export const buildTimelineTrackLayoutRows = (input: {
  tracks: readonly Pick<Track, 'id' | 'groupId' | 'channelRole' | 'collapsed'>[]
  visibleTrackIds?: readonly Track['id'][]
} & TrackLayoutRowOptions): TimelineTrackLayoutRow[] => {
  const trackById = new Map(input.tracks.map((track) => [track.id, track]))
  const orderedTracks = input.visibleTrackIds
    ? input.visibleTrackIds.flatMap((trackId) => {
        const track = trackById.get(trackId)
        return track ? [track] : []
      })
    : input.tracks
  return buildRowsForOrderedTracks(orderedTracks, input)
}

const layoutHeight = (rows: readonly TimelineTrackLayoutRow[]) => {
  const last = rows.at(-1)
  return last ? last.topPx + last.heightPx : 0
}

export const buildTimelineTrackLayout = (input: {
  tracks: readonly Pick<Track, 'id' | 'groupId' | 'channelRole' | 'collapsed'>[]
  visibleTrackIds: readonly Track['id'][]
  depthByTrackId?: ReadonlyMap<string, number>
  visibleByTrackId: Record<string, boolean | undefined>
  heightsByLaneOwnerKey: Record<string, number | undefined>
  visibleParameterIdsByTrackId: Record<string, readonly string[] | undefined>
}): TimelineTrackLayout => {
  const trackById = new Map(input.tracks.map((track) => [track.id, track]))
  const scrollingTracks: Pick<Track, 'id' | 'groupId' | 'channelRole' | 'collapsed'>[] = []
  const returnTracks: Pick<Track, 'id' | 'groupId' | 'channelRole' | 'collapsed'>[] = []
  for (const trackId of input.visibleTrackIds) {
    const track = trackById.get(trackId)
    if (!track) continue
    if (track.channelRole === 'return') returnTracks.push(track)
    else scrollingTracks.push(track)
  }
  const shared: TrackLayoutRowOptions = {
    depthByTrackId: input.depthByTrackId,
    visibleByTrackId: input.visibleByTrackId,
    heightsByLaneOwnerKey: input.heightsByLaneOwnerKey,
    visibleParameterIdsByTrackId: input.visibleParameterIdsByTrackId,
  }
  const scrollingRows = buildRowsForOrderedTracks(scrollingTracks, shared)
  const returnRows = buildRowsForOrderedTracks(returnTracks, shared)
  return {
    scrollingRows,
    returnRows,
    displayTrackIds: [...scrollingTracks, ...returnTracks].map((track) => track.id),
    scrollingHeightPx: layoutHeight(scrollingRows),
    returnHeightPx: layoutHeight(returnRows),
  }
}

const trackClipLaneHeight = (
  track: Pick<Track, 'collapsed'>,
) => track.collapsed === true ? COLLAPSED_LANE_HEIGHT : LANE_HEIGHT

export const trackIndexAtY = (
  rows: readonly Pick<TimelineTrackLayoutRow, 'topPx' | 'heightPx'>[],
  y: number,
) => {
  return trackLayoutRowIndexAtY(rows, y)
}

export const trackLayoutRowIndexAtY = (
  rows: readonly Pick<TimelineTrackLayoutRow, 'topPx' | 'heightPx'>[],
  y: number,
): number => {
  let low = 0
  let high = rows.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const row = rows[mid]
    if (!row) return -1
    if (y < row.topPx) {
      high = mid - 1
    } else if (y >= row.topPx + row.heightPx) {
      low = mid + 1
    } else {
      return mid
    }
  }
  return -1
}

export const trackLayoutDropIndexAtY = (
  rows: readonly Pick<TimelineTrackLayoutRow, 'topPx' | 'heightPx'>[],
  y: number,
): number => {
  if (rows.length === 0) return y >= 0 ? 0 : -1
  const rowIndex = trackLayoutRowIndexAtY(rows, y)
  if (rowIndex >= 0) return rowIndex
  const lastRow = rows[rows.length - 1]
  return lastRow && y >= lastRow.topPx + lastRow.heightPx ? rows.length : -1
}

export const trackLayoutDropIndexAtClientY = (
  rows: readonly Pick<TimelineTrackLayoutRow, 'topPx' | 'heightPx'>[],
  clientY: number,
  scrollElement: HTMLDivElement,
): number => {
  return trackLayoutDropIndexAtY(rows, clientYToTimelineTrackY(clientY, scrollElement))
}

export const trackLayoutRowAtY = <Row extends Pick<TimelineTrackLayoutRow, 'topPx' | 'heightPx'>>(
  rows: readonly Row[],
  y: number,
): Row | undefined => {
  const index = trackLayoutRowIndexAtY(rows, y)
  return index >= 0 ? rows[index] : undefined
}

export const trackIdsInYRange = (
  rows: readonly Pick<TimelineTrackLayoutRow, 'trackId' | 'topPx' | 'heightPx'>[],
  startY: number,
  endY: number,
) => {
  const top = Math.min(startY, endY)
  const bottom = Math.max(startY, endY)

  return rows
    .filter((row) => row.topPx < bottom && row.topPx + row.heightPx > top)
    .map((row) => row.trackId)
}
