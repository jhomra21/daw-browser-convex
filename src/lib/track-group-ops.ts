import type { Track, TrackChannelRole, TrackId } from '@daw-browser/timeline-core/types'
import { getDefaultClipColor, trackColorForClip } from '~/lib/clip-color'
import { collectTrackDescendantIds } from '@daw-browser/shared'
import { wouldCreateCycle } from '~/lib/timeline-track-layout'

type TrackForGroupOps = Pick<Track, 'id' | 'groupId' | 'outputTargetId' | 'channelRole' | 'color' | 'clips' | 'sends'>

type PlannedTrackGroupChildUpdate = {
  trackId: TrackId
  groupId: TrackId
  outputTargetId?: TrackId
}

type GroupTracksPlan = {
  groupTrack: {
    name: string
    channelRole: TrackChannelRole
    index: number
    color?: string
  }
  childUpdates: PlannedTrackGroupChildUpdate[]
}

type UngroupTracksPlan = {
  childUpdates: Array<{
    trackId: TrackId
    groupId?: TrackId
    outputTargetId?: TrackId
  }>
}

type MoveTrackToGroupPlan = {
  trackId: TrackId
  groupId?: TrackId
  outputTargetId?: TrackId
}

type TrackForReorder = Pick<Track, 'id' | 'groupId' | 'channelRole' | 'outputTargetId' | 'collapsed'> & {
  index: number
}

export type TrackDropZone = 'above' | 'below' | 'inside'

export type TrackDropTarget = {
  trackId: TrackId
  zone: TrackDropZone
}

type TrackReorderPatch = {
  trackId: TrackId
  index: number
  groupId: TrackId | undefined
  outputTargetId: TrackId | undefined
}

type TrackReorderPlan = {
  patches: TrackReorderPatch[]
  expandGroupIds: TrackId[]
}

type SetTrackColorPlan = {
  trackUpdates: Array<{ trackId: TrackId; from: string | undefined; to: string | undefined }>
  clipUpdates: ClipColorUpdate[]
}

type AssignTrackColorToClipsPlan = {
  clipUpdates: ClipColorUpdate[]
}

type ResetClipColorsPlan = {
  clipUpdates: ClipColorUpdate[]
}

export type ClipColorUpdate = { clipId: string; trackId: TrackId; from: string; to: string }

const resolveTrackColorTargets = (tracks: readonly Track[], track: Track): Track[] => {
  const targetTrackIds = track.channelRole === 'group'
    ? new Set([track.id, ...collectTrackDescendantIds(tracks, track.id)])
    : new Set([track.id])
  return tracks.filter((candidate) => targetTrackIds.has(candidate.id))
}

const outputTargetForGroupChange = (
  track: Pick<Track, 'groupId' | 'outputTargetId'>,
  groupId: TrackId | undefined,
) => {
  if (groupId) return !track.outputTargetId || track.outputTargetId === track.groupId ? groupId : track.outputTargetId
  return track.outputTargetId === track.groupId ? undefined : track.outputTargetId
}

export const planGroupTracks = (input: {
  tracks: readonly TrackForGroupOps[]
  selectedTrackIds: readonly TrackId[]
  groupTrackId: TrackId
  groupName?: string
  color?: string
}): GroupTracksPlan | null => {
  const selected = new Set(input.selectedTrackIds)
  const selectedTracks = input.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => selected.has(track.id))
  if (selectedTracks.length === 0) return null
  if (selectedTracks.some(({ track }) => track.channelRole === 'return')) return null

  const index = Math.min(...selectedTracks.map((entry) => entry.index))
  return {
    groupTrack: {
      name: input.groupName?.trim() || 'Group',
      channelRole: 'group',
      index,
      color: input.color,
    },
    childUpdates: selectedTracks.map(({ track }) => ({
      trackId: track.id,
      groupId: input.groupTrackId,
      outputTargetId: outputTargetForGroupChange(track, input.groupTrackId),
    })),
  }
}

export const planUngroupTracks = (input: {
  tracks: readonly TrackForGroupOps[]
  groupId: TrackId
}): UngroupTracksPlan | null => {
  const group = input.tracks.find((track) => track.id === input.groupId)
  if (!group || group.channelRole !== 'group') return null
  if (group.clips.length > 0) return null
  const directChildIds = new Set(
    input.tracks.filter((track) => track.groupId === input.groupId).map((track) => track.id),
  )
  const hasExternalReference = input.tracks.some((track) => (
    track.id !== input.groupId
    && !directChildIds.has(track.id)
    && (
      track.outputTargetId === input.groupId
      || (track.sends ?? []).some((send) => send.targetId === input.groupId)
    )
  ))
  if (hasExternalReference) return null
  return {
    childUpdates: input.tracks
      .filter((track) => track.groupId === input.groupId)
      .map((track) => ({
        trackId: track.id,
        groupId: group.groupId,
        outputTargetId: track.outputTargetId === input.groupId ? group.groupId : track.outputTargetId,
      })),
  }
}

export const planMoveTrackToGroup = (input: {
  tracks: readonly TrackForGroupOps[]
  trackId: TrackId
  groupId?: TrackId
}): MoveTrackToGroupPlan | null => {
  const track = input.tracks.find((candidate) => candidate.id === input.trackId)
  if (!track || track.channelRole === 'return') return null
  if (!input.groupId) return { trackId: input.trackId, groupId: undefined, outputTargetId: outputTargetForGroupChange(track, undefined) }

  const group = input.tracks.find((candidate) => candidate.id === input.groupId)
  if (!group || group.channelRole !== 'group') return null
  if (wouldCreateCycle(input.tracks, input.trackId, input.groupId)) return null
  return { trackId: input.trackId, groupId: input.groupId, outputTargetId: outputTargetForGroupChange(track, input.groupId) }
}

export const resolveTrackDropZone = (input: {
  localY: number
  rowHeightPx: number
  targetIsGroup: boolean
}): TrackDropZone => {
  const edgeBand = Math.min(12, input.rowHeightPx * 0.25)
  if (input.localY <= edgeBand) return 'above'
  if (input.localY >= input.rowHeightPx - edgeBand) return 'below'
  return input.targetIsGroup
    ? 'inside'
    : input.localY < input.rowHeightPx / 2
      ? 'above'
      : 'below'
}

export const normalizeDragMoveSet = (
  tracks: readonly Pick<Track, 'id' | 'groupId'>[],
  selectedIds: ReadonlySet<TrackId>,
): TrackId[] => {
  const parentOf = new Map<TrackId, TrackId>()
  for (const track of tracks) {
    if (track.groupId) parentOf.set(track.id, track.groupId)
  }

  return tracks
    .filter((track) => selectedIds.has(track.id))
    .filter((track) => {
      let cursor = parentOf.get(track.id)
      while (cursor) {
        if (selectedIds.has(cursor)) return false
        cursor = parentOf.get(cursor)
      }
      return true
    })
    .map((track) => track.id)
}

export const planTrackReorder = (input: {
  tracks: readonly TrackForReorder[]
  moveRootIds: readonly TrackId[]
  target: TrackDropTarget
}): TrackReorderPlan | null => {
  if (input.moveRootIds.length === 0) return null
  const moveRoots = new Set(input.moveRootIds)
  const trackById = new Map(input.tracks.map((track) => [track.id, track]))
  if (moveRoots.size !== input.moveRootIds.length || [...moveRoots].some((trackId) => !trackById.has(trackId))) return null
  const targetTrack = trackById.get(input.target.trackId)
  if (!targetTrack) return null
  const moveReturns = new Set([...moveRoots].map((trackId) => trackById.get(trackId)?.channelRole === 'return'))
  if (moveReturns.size !== 1) return null
  const movingReturns = moveReturns.has(true)
  if (movingReturns !== (targetTrack.channelRole === 'return')) return null
  if (movingReturns && input.target.zone === 'inside') return null
  if (input.target.zone === 'inside' && targetTrack.channelRole !== 'group') return null

  const movedSubtree = new Set<TrackId>()
  for (const rootId of moveRoots) {
    movedSubtree.add(rootId)
    for (const descendantId of collectTrackDescendantIds(input.tracks, rootId)) {
      movedSubtree.add(descendantId)
    }
  }
  if (movedSubtree.has(input.target.trackId)) return null

  const newParentGroupId = input.target.zone === 'inside' ? targetTrack.id : targetTrack.groupId
  if (newParentGroupId) {
    for (const rootId of moveRoots) {
      if (wouldCreateCycle(input.tracks, rootId, newParentGroupId)) return null
    }
  }

  const displayOrder = [...input.tracks].sort((left, right) => left.index - right.index).map((track) => track.id)
  const rest = displayOrder.filter((id) => !movedSubtree.has(id))
  const targetIndex = rest.indexOf(input.target.trackId)
  if (targetIndex === -1) return null

  const insertAt = (() => {
    if (input.target.zone === 'above') return targetIndex
    if (input.target.zone === 'inside') return targetIndex + 1
    const targetDescendants = collectTrackDescendantIds(input.tracks, input.target.trackId)
    let lastIndex = targetIndex
    for (let index = targetIndex + 1; index < rest.length; index++) {
      const candidateId = rest[index]
      if (!candidateId || !targetDescendants.has(candidateId)) break
      lastIndex = index
    }
    return lastIndex + 1
  })()

  const movedInOrder = displayOrder.filter((id) => movedSubtree.has(id))
  const reordered = [
    ...rest.slice(0, insertAt),
    ...movedInOrder,
    ...rest.slice(insertAt),
  ]
  const finalOrder = [
    ...reordered.filter((trackId) => trackById.get(trackId)?.channelRole !== 'return'),
    ...reordered.filter((trackId) => trackById.get(trackId)?.channelRole === 'return'),
  ]

  const patches: TrackReorderPatch[] = []
  for (const [index, trackId] of finalOrder.entries()) {
    const track = trackById.get(trackId)
    if (!track) continue
    const groupId = moveRoots.has(trackId) ? newParentGroupId : track.groupId
    const outputTargetId = moveRoots.has(trackId)
      ? outputTargetForGroupChange(track, groupId)
      : track.outputTargetId
    if (track.index !== index || track.groupId !== groupId || track.outputTargetId !== outputTargetId) {
      patches.push({ trackId, index, groupId, outputTargetId })
    }
  }

  const expandGroupIds = input.target.zone === 'inside' && targetTrack.collapsed ? [targetTrack.id] : []
  return patches.length > 0 || expandGroupIds.length > 0 ? { patches, expandGroupIds } : null
}

export const planSetTrackColor = (
  tracks: readonly Track[],
  trackId: TrackId,
  color: string | undefined,
  options?: { cascadeClipColors?: boolean },
): SetTrackColorPlan | null => {
  const track = tracks.find((candidate) => candidate.id === trackId)
  if (!track) return null
  const targets = resolveTrackColorTargets(tracks, track)
  const clipColor = trackColorForClip(color)
  const trackUpdates = targets
    .filter((track) => track.color !== color)
    .map((track) => ({ trackId: track.id, from: track.color, to: color }))
  const clipUpdates = track.channelRole === 'group' && clipColor && options?.cascadeClipColors !== false
    ? targets.flatMap((track) => (
        track.clips
          .filter((clip) => clip.color !== clipColor)
          .map((clip) => ({ clipId: clip.id, trackId: track.id, from: clip.color, to: clipColor }))
      ))
    : []
  return trackUpdates.length > 0 || clipUpdates.length > 0 ? { trackUpdates, clipUpdates } : null
}

export const planAssignTrackColorToClips = (
  tracks: readonly Track[],
  trackId: TrackId,
): AssignTrackColorToClipsPlan | null => {
  const track = tracks.find((candidate) => candidate.id === trackId)
  if (!track?.color) return null
  const clipUpdates = resolveTrackColorTargets(tracks, track)
    .flatMap((target) => {
      const color = trackColorForClip(target.color)
      if (!color) return []
      return target.clips
        .filter((clip) => clip.color !== color)
        .map((clip) => ({ clipId: clip.id, trackId: target.id, from: clip.color, to: color }))
    })
  return clipUpdates.length > 0 ? { clipUpdates } : null
}

export const planResetClipColors = (
  tracks: readonly Track[],
  trackId: TrackId,
): ResetClipColorsPlan | null => {
  const track = tracks.find((candidate) => candidate.id === trackId)
  if (!track) return null
  const clipUpdates = resolveTrackColorTargets(tracks, track)
    .flatMap((track) => (
      track.clips
        .map((clip) => ({ clip, color: getDefaultClipColor(clip) }))
        .filter(({ clip, color }) => clip.color !== color)
        .map(({ clip, color }) => ({ clipId: clip.id, trackId: track.id, from: clip.color, to: color }))
    ))
  return clipUpdates.length > 0 ? { clipUpdates } : null
}
