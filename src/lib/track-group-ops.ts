import type { Track, TrackChannelRole, TrackId } from '@daw-browser/timeline-core/types'
import { wouldCreateCycle } from '~/lib/timeline-track-layout'

type TrackForGroupOps = Pick<Track, 'id' | 'groupId' | 'outputTargetId' | 'channelRole' | 'color'>

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
      outputTargetId: track.outputTargetId ?? input.groupTrackId,
    })),
  }
}

export const planUngroupTracks = (input: {
  tracks: readonly TrackForGroupOps[]
  groupId: TrackId
}): UngroupTracksPlan => ({
  childUpdates: input.tracks
    .filter((track) => track.groupId === input.groupId)
    .map((track) => ({
      trackId: track.id,
      groupId: undefined,
      outputTargetId: track.outputTargetId === input.groupId ? undefined : track.outputTargetId,
    })),
})

export const planMoveTrackToGroup = (input: {
  tracks: readonly TrackForGroupOps[]
  trackId: TrackId
  groupId?: TrackId
}): MoveTrackToGroupPlan | null => {
  const track = input.tracks.find((candidate) => candidate.id === input.trackId)
  if (!track || track.channelRole === 'return') return null
  if (!input.groupId) return { trackId: input.trackId, groupId: undefined }

  const group = input.tracks.find((candidate) => candidate.id === input.groupId)
  if (!group || group.channelRole !== 'group') return null
  if (wouldCreateCycle(input.tracks, input.trackId, input.groupId)) return null
  return { trackId: input.trackId, groupId: input.groupId }
}
