import type { Track } from '@daw-browser/timeline-core/types'
import { DEFAULT_AUTOMATION_LANE_HEIGHT, LANE_HEIGHT } from '~/lib/timeline-utils'

export type TimelineTrackLayoutRow = {
  trackId: Track['id']
  topPx: number
  heightPx: number
  clipLaneHeightPx: number
  automationHeightPx: number
  depth: number
  groupId?: Track['id']
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

const buildChildrenByParentTrackId = (
  tracks: readonly Pick<Track, 'id' | 'groupId'>[],
): Map<Track['id'], Track['id'][]> => {
  const childrenByParent = new Map<Track['id'], Track['id'][]>()
  for (const track of tracks) {
    if (!track.groupId) continue
    const children = childrenByParent.get(track.groupId) ?? []
    children.push(track.id)
    childrenByParent.set(track.groupId, children)
  }
  return childrenByParent
}

export const collectTrackDescendantIds = (
  tracks: readonly Pick<Track, 'id' | 'groupId'>[],
  rootTrackId: Track['id'],
): Set<Track['id']> => {
  const childrenByParent = buildChildrenByParentTrackId(tracks)
  const descendants = new Set<Track['id']>()
  const collect = (trackId: Track['id']) => {
    for (const childId of childrenByParent.get(trackId) ?? []) {
      if (descendants.has(childId)) continue
      descendants.add(childId)
      collect(childId)
    }
  }
  collect(rootTrackId)
  return descendants
}

export const buildGroupClipOverview = (
  groupId: Track['id'],
  tracks: readonly Track[],
): Array<{ startSec: number; endSec: number }> => {
  const descendantIds = collectTrackDescendantIds(tracks, groupId)
  const segments = tracks.filter((track) => descendantIds.has(track.id)).flatMap((track) => (
    track.clips.map((clip) => ({
      startSec: clip.startSec,
      endSec: clip.startSec + clip.duration,
    }))
  ))

  segments.sort((left, right) => left.startSec - right.startSec)
  const merged: Array<{ startSec: number; endSec: number }> = []
  for (const segment of segments) {
    const last = merged[merged.length - 1]
    if (last && segment.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, segment.endSec)
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}

export const buildTimelineTrackLayoutRows = (input: {
  tracks: readonly Pick<Track, 'id' | 'groupId' | 'channelRole' | 'collapsed'>[]
  visibleTrackIds?: readonly Track['id'][]
  depthByTrackId?: ReadonlyMap<string, number>
  visibleByTrackId: Record<string, boolean | undefined>
  heightsByLaneOwnerKey: Record<string, number | undefined>
  visibleParameterIdsByTrackId: Record<string, readonly string[] | undefined>
}): TimelineTrackLayoutRow[] => {
  let topPx = 0
  const trackById = new Map(input.tracks.map((track) => [track.id, track]))
  const orderedTracks = input.visibleTrackIds
    ? input.visibleTrackIds.flatMap((trackId) => {
        const track = trackById.get(trackId)
        return track ? [track] : []
      })
    : input.tracks
  return orderedTracks.map((track) => {
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
      depth: input.depthByTrackId?.get(track.id) ?? 0,
      groupId: track.groupId,
    }
    topPx += row.heightPx
    return row
  })
}

export const trackIndexAtY = (
  rows: readonly Pick<TimelineTrackLayoutRow, 'topPx' | 'heightPx'>[],
  y: number,
) => rows.findIndex((row) => y >= row.topPx && y < row.topPx + row.heightPx)

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
