import { pushTrackCreateHistory } from '~/lib/tracks'
import { isLocalId } from '~/lib/local-ids'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { buildTrackDeleteMutationInput } from '~/lib/track-mutation-args'
import { canTrackReceiveAudioClip } from '~/lib/track-routing'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Track } from '~/types/timeline'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type HistoryPush = (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void

type RecordingTrackTarget = {
  track: Track
  createdDuringSetup: boolean
}

export async function ensureTrackForRecording(options: {
  projectId: string | undefined
  userId: string | undefined
  tracks: Track[]
  recordArmTrackId: Track['id'] | null
  setRecordArmTrackId: (value: Track['id'] | null) => void
  createTrackForRecording: () => Promise<Track | null>
  emit: (message: string) => void
}): Promise<RecordingTrackTarget | null> {
  const isLocalProject = options.projectId ? isLocalId('project', options.projectId) : false
  if (!options.projectId || (!isLocalProject && !options.userId)) {
    options.emit(isLocalProject ? 'Recording requires an open project.' : 'Recording is only available when signed in to a project.')
    return null
  }

  if (options.recordArmTrackId) {
    const armedTrack = options.tracks.find((track) => track.id === options.recordArmTrackId)
    if (armedTrack && canTrackReceiveAudioClip(armedTrack) && (isLocalProject || !armedTrack.lockedBy || armedTrack.lockedBy === options.userId)) {
      return { track: armedTrack, createdDuringSetup: false }
    }
  }

  const availableTrack = options.tracks.find((track) => canTrackReceiveAudioClip(track) && (isLocalProject || !track.lockedBy || track.lockedBy === options.userId))
  if (availableTrack) {
    options.setRecordArmTrackId(availableTrack.id)
    return { track: availableTrack, createdDuringSetup: false }
  }

  let newTrack: Track | null = null
  try {
    newTrack = await options.createTrackForRecording()
  } catch (error) {
    console.error('[useTrackRecording] failed to create track for recording', error)
    options.emit('Failed to create a new track for recording.')
    return null
  }
  if (!newTrack) return null
  return { track: newTrack, createdDuringSetup: true }
}

function commitAutoCreatedTrack(options: {
  historyPush?: HistoryPush
  projectId: string | undefined
  tracks: Track[]
  track: Track | null | undefined
}): void {
  pushTrackCreateHistory(options.historyPush, options.projectId, options.tracks, options.track)
}

async function discardAutoCreatedTrack(options: {
  trackId: Track['id']
  projectId: string | undefined
  userId: string | undefined
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  removeLocalTrack: (trackId: Track['id']) => void
  clearRecordArmForTrack: (trackId: Track['id']) => void
}): Promise<boolean> {
  options.clearRecordArmForTrack(options.trackId)
  try {
    if (options.projectId && isLocalId('project', options.projectId)) {
      await createLocalTimelineRepository(options.projectId).deleteTrack(options.trackId)
      options.removeLocalTrack(options.trackId)
      return true
    }
    if (!options.userId) return false
    const result = await options.convexClient.mutation(
      options.convexApi.tracks.remove,
      buildTrackDeleteMutationInput({ trackId: options.trackId, userId: options.userId }),
    )
    if (result?.status !== 'deleted') return false
    options.removeLocalTrack(options.trackId)
    return true
  } catch (error) {
    console.error('[useTrackRecording] failed to discard auto-created track', error)
    return false
  }
}

export async function finalizeAutoCreatedTrackFailure(options: {
  track: Track | null
  tracks: Track[]
  projectId: string | undefined
  userId: string | undefined
  historyPush?: HistoryPush
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  removeLocalTrack: (trackId: Track['id']) => void
  clearRecordArmForTrack: (trackId: Track['id']) => void
  emit: (message: string) => void
}): Promise<void> {
  if (!options.track) return
  const currentTrack = options.tracks.find((entry) => entry.id === options.track?.id)
  if (!currentTrack) return
  if (currentTrack.clips.length > 0) {
    commitAutoCreatedTrack({
      historyPush: options.historyPush,
      projectId: options.projectId,
      tracks: options.tracks,
      track: currentTrack,
    })
    return
  }
  const discarded = await discardAutoCreatedTrack({
    trackId: currentTrack.id,
    projectId: options.projectId,
    userId: options.userId,
    convexClient: options.convexClient,
    convexApi: options.convexApi,
    removeLocalTrack: options.removeLocalTrack,
    clearRecordArmForTrack: options.clearRecordArmForTrack,
  })
  if (discarded) return
  commitAutoCreatedTrack({
    historyPush: options.historyPush,
    projectId: options.projectId,
    tracks: options.tracks,
    track: currentTrack,
  })
  options.emit('Recording failed and the temporary track could not be removed automatically.')
}
