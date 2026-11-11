import { createSignal, type Accessor } from 'solid-js'
import { pushTrackCreateHistory } from '~/lib/tracks'
import { isLocalId } from '@daw-browser/shared'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { buildTrackDeleteMutationInput } from '~/lib/track-mutation-args'
import { canTrackReceiveAudioClip } from '@daw-browser/timeline-core/track-routing'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Track } from '@daw-browser/timeline-core/types'
import type { convexApi, convexClient } from '~/lib/convex'

type ConvexClientType = typeof convexClient

type ConvexApiType = typeof convexApi

type HistoryPush = (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void

type RecordingTrackTarget = {
  track: Track
  createdDuringSetup: boolean
}

export const RECORDING_TARGET_LOCKED_BADGE = 'Recording target locked'
export const RECORDING_TARGET_LOCKED_REASON = 'Finish recording to delete this track or change its routing.'

export type RecordingTargetLockState = 'starting' | 'recording' | 'finishing' | 'released'

type ClosureTrack = {
  id: string
  groupId?: string | null
  outputTargetId?: string | null
  sends?: readonly { targetId: string }[]
}

type RoutingPatch = {
  trackId: string
  groupId?: string | null
  outputTargetId?: string | null
  sends?: readonly { targetId: string }[]
}

// What a take is bound to: the target, its group and output chain, and the destinations of its sends.
// A missing track is part of the key, so a delete changes it like a reroute does.
const targetClosureKey = (tracks: readonly ClosureTrack[], targetId: string) => {
  const trackById = new Map(tracks.map((track) => [track.id, track]))
  const visited = new Set<string>()
  const entries: string[] = []
  const pending = [targetId]
  for (const id of pending) {
    if (visited.has(id)) continue
    visited.add(id)
    const track = trackById.get(id)
    if (!track) {
      entries.push(`${id}:missing`)
      continue
    }
    const sends = id === targetId
      ? (track.sends ?? []).map((send) => `${send.targetId}${trackById.has(send.targetId) ? '' : ':missing'}`).sort().join(',')
      : ''
    entries.push(`${id}|${track.groupId ?? ''}|${track.outputTargetId ?? ''}|${sends}`)
    if (track.groupId) pending.push(track.groupId)
    if (track.outputTargetId) pending.push(track.outputTargetId)
  }
  return entries.join('\n')
}

export const applyRoutingPatches = (tracks: readonly ClosureTrack[], patches: readonly RoutingPatch[]): ClosureTrack[] => {
  const patchByTrackId = new Map(patches.map((patch) => [patch.trackId, patch]))
  return tracks.map((track) => {
    const patch = patchByTrackId.get(track.id)
    if (!patch) return track
    return {
      ...track,
      groupId: Object.hasOwn(patch, 'groupId') ? patch.groupId : track.groupId,
      outputTargetId: Object.hasOwn(patch, 'outputTargetId') ? patch.outputTargetId : track.outputTargetId,
      sends: Object.hasOwn(patch, 'sends') ? patch.sends : track.sends,
    }
  })
}

const trackStructureHistory = new Set<HistoryEntry['type']>([
  'track-create', 'track-delete', 'track-routing', 'track-group', 'track-ungroup', 'track-reorder',
])

const touchesTrackStructure = (entry: HistoryEntry): boolean => entry.type === 'section-edit'
  ? entry.data.entries.some(touchesTrackStructure)
  : trackStructureHistory.has(entry.type)

// One lock per timeline. A take holds it from the moment its target is chosen until its clip is saved or discarded.
// Every refusal is synchronous and a refused edit never stops the take.
export const createRecordingTargetLock = (tracks: Accessor<readonly ClosureTrack[]>) => {
  const [state, setState] = createSignal<RecordingTargetLockState>('released')
  const [targetId, setTargetId] = createSignal<string | null>(null)
  const refuseTransition = (before: readonly ClosureTrack[], after: readonly ClosureTrack[]) => {
    const target = targetId()
    if (target === null || targetClosureKey(before, target) === targetClosureKey(after, target)) return undefined
    return RECORDING_TARGET_LOCKED_REASON
  }
  const refuseChange = (patches: readonly RoutingPatch[], removedTrackIds: Iterable<string> = []) => {
    const removed = new Set(removedTrackIds)
    return refuseTransition(tracks(), applyRoutingPatches(tracks(), patches).filter((track) => !removed.has(track.id)))
  }
  return {
    state,
    targetId,
    start: (trackId: string) => {
      if (state() !== 'released') return false
      setTargetId(trackId)
      setState('starting')
      return true
    },
    recording: () => {
      if (state() === 'starting') setState('recording')
    },
    finishing: () => {
      if (state() === 'recording') setState('finishing')
    },
    release: () => {
      setTargetId(null)
      setState('released')
    },
    refuseTransition,
    refuseChange,
    refuseDelete: (trackIds: Iterable<string>) => refuseChange([], trackIds),
    refuseHistory: (entry: HistoryEntry) => targetId() !== null && touchesTrackStructure(entry)
      ? RECORDING_TARGET_LOCKED_REASON
      : undefined,
  }
}

export type RecordingTargetLock = ReturnType<typeof createRecordingTargetLock>

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
      buildTrackDeleteMutationInput({ trackId: options.trackId }),
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
