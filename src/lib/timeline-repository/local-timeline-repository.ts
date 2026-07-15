import { createLocalProjectEntityRow, openLocalProjectDb, type LocalProjectEntityRow } from '~/lib/local-project-db'
import { audioWarpEqual, canonicalTrackCreation, createLocalClipId, createLocalTrackId, hasTrackGroupCycle, hasValidReturnTrackPartition, normalizeAudioWarp } from '@daw-browser/shared'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { flushRegisteredLocalProjectWrites } from '~/lib/local-project-write-flushers'
import { LocalEntityWriteQueue } from '~/lib/local-write-queue'
import { normalizeTrackRouting } from '@daw-browser/shared'
import { normalizeClipFades, clipFadesEqual, transformClipFadesForDuration } from '@daw-browser/timeline-core/clip-fades'
import type {
  CreateClipInput,
  CreateTrackInput,
  UpdateTrackInput,
  UpdateClipInput,
  TimelineClipRow,
  TimelineRepository,
  TimelineSnapshot,
  TimelineClipId,
  MoveClipInput,
  ReorderAndGroupTrackInput,
  RestoreUngroupInput,
  TrackColorBatchUpdate,
  ClipColorBatchUpdate,
  TimelineTrackId,
  TimelineTrackRow,
} from '~/lib/timeline-repository/types'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import { buildTimelineTrackRow } from './track-row-builder'
import { localSidechainRouteRowId } from '~/lib/local-effects'

const TRACK_KIND = 'track'
const CLIP_KIND = 'clip'
const EFFECT_KIND = 'effect'
const AUTOMATION_KIND = 'automation-envelope'
const SIDECHAIN_KIND = 'sidechain-route'
const pendingLocalTimelineFlushers = new Map<string, Set<() => Promise<void>>>()
const pendingRepositoryWritesByProject = new Map<string, Set<Promise<unknown>>>()
const entityWriteQueuesByProject = new Map<string, LocalEntityWriteQueue>()
let lifecycleFlushAttached = false

const now = () => Date.now()

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isTrackRow = (value: unknown): value is TimelineTrackRow => {
  if (!isObject(value)) return false
  return isString(value.id)
    && isString(value.historyRef)
    && isString(value.name)
    && isNumber(value.index)
    && isNumber(value.volume)
    && isBoolean(value.muted)
    && isBoolean(value.soloed)
    && (value.kind === 'audio' || value.kind === 'instrument')
    && (value.channelRole === 'track' || value.channelRole === 'group' || value.channelRole === 'return')
    && Array.isArray(value.sends)
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt)
}

const isClipRow = (value: unknown): value is TimelineClipRow => {
  if (!isObject(value)) return false
  return isString(value.id)
    && isString(value.trackId)
    && isString(value.historyRef)
    && isString(value.name)
    && isNumber(value.startSec)
    && isNumber(value.duration)
    && isString(value.color)
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt)
}

const isAutomationEnvelopeForTrack = (value: unknown, trackId: TimelineTrackId) => (
  isObject(value)
  && isObject(value.target)
  && value.target.kind === 'track'
  && value.target.trackId === trackId
)

const isEffectForTrack = (value: unknown, trackId: TimelineTrackId) => (
  isObject(value) && value.targetId === trackId
)

const isSidechainRoute = (value: unknown): value is ExternalSidechainRoute => (
  isObject(value)
  && isString(value.sourceTrackId)
  && isString(value.targetTrackId)
  && isString(value.effectInstanceId)
)

const requireUngroupable = (
  group: TimelineTrackRow,
  tracks: readonly TimelineTrackRow[],
  clips: readonly TimelineClipRow[],
) => {
  if (clips.some((clip) => clip.trackId === group.id)) {
    throw new Error('Failed to ungroup local timeline because the group track contains clips.')
  }
  const directChildIds = new Set(
    tracks.filter((track) => track.groupId === group.id).map((track) => track.id),
  )
  const hasExternalReference = tracks.some((track) => (
    track.id !== group.id
    && !directChildIds.has(track.id)
    && (
      track.outputTargetId === group.id
      || track.sends.some((send) => send.targetId === group.id)
    )
  ))
  if (hasExternalReference) {
    throw new Error('Failed to ungroup local timeline because another track routes to the group.')
  }
}

const toEntityRow = createLocalProjectEntityRow

const trackValues = (rows: LocalProjectEntityRow[]) => rows.flatMap((row) => isTrackRow(row.value) ? [row.value] : [])
const clipValues = (rows: LocalProjectEntityRow[]) => rows.flatMap((row) => isClipRow(row.value) ? [row.value] : [])

const sendsEqual = (
  left: TimelineTrackRow['sends'],
  right: TimelineTrackRow['sends'],
) => (
  left.length === right.length
  && left.every((send, index) => (
    send.targetId === right[index]?.targetId
    && send.amount === right[index]?.amount
    && (send.tap ?? 'post-fader') === (right[index]?.tap ?? 'post-fader')
  ))
)

const trackPersistenceFieldsEqual = (left: TimelineTrackRow, right: TimelineTrackRow) => (
  left.volume === right.volume
  && left.muted === right.muted
  && left.soloed === right.soloed
  && left.groupId === right.groupId
  && left.index === right.index
  && left.collapsed === right.collapsed
  && left.color === right.color
  && left.outputTargetId === right.outputTargetId
  && sendsEqual(left.sends, right.sends)
)

const clipPersistenceFieldsEqual = (left: TimelineClipRow, right: TimelineClipRow) => (
  left.name === right.name
  && left.trackId === right.trackId
  && left.startSec === right.startSec
  && left.duration === right.duration
  && left.sourceAssetId === right.sourceAssetId
  && left.sourceAssetKey === right.sourceAssetKey
  && left.sourceKind === right.sourceKind
  && left.sourceDurationSec === right.sourceDurationSec
  && left.sourceSampleRate === right.sourceSampleRate
  && left.sourceChannelCount === right.sourceChannelCount
  && left.sampleUrl === right.sampleUrl
  && left.leftPadSec === right.leftPadSec
  && left.bufferOffsetSec === right.bufferOffsetSec
  && audioWarpEqual(left.audioWarp, right.audioWarp)
  && left.gain === right.gain
  && clipFadesEqual(left.fades, right.fades, left.duration)
  && left.color === right.color
  && left.midi === right.midi
  && left.midiOffsetBeats === right.midiOffsetBeats
)

const patchOptionalString = (
  current: string | undefined,
  next: string | null | undefined,
) => next === undefined ? current : next ?? undefined

const requireTrackIds = (trackIds: Iterable<TimelineTrackId>, tracks: readonly TimelineTrackRow[]) => {
  const existingTrackIds = new Set(tracks.map((track) => track.id))
  for (const trackId of trackIds) {
    if (!existingTrackIds.has(trackId)) {
      throw new Error('Failed to write local timeline because a target track was not found.')
    }
  }
}

const restoredUngroupGroup = (
  group: TimelineTrackRow,
  tracks: readonly TimelineTrackRow[],
) => ({
  ...group,
  index: Math.max(0, Math.min(Math.round(group.index), tracks.length)),
})

const restoredUngroupTracks = (
  input: RestoreUngroupInput,
  tracks: readonly TimelineTrackRow[],
  group: TimelineTrackRow,
) => {
  const childById = new Map(input.children.map((child) => [child.trackId, child]))
  return [
    ...tracks.map((track) => {
      const child = childById.get(track.id)
      return {
        ...track,
        index: track.index >= group.index ? track.index + 1 : track.index,
        groupId: child ? group.id : track.groupId,
        outputTargetId: child ? (child.outputToGroup ? group.id : child.outputTargetId) : track.outputTargetId,
      }
    }),
    group,
  ]
}

const requireValidRestoreUngroup = (
  input: RestoreUngroupInput,
  tracks: readonly TimelineTrackRow[],
  group: TimelineTrackRow,
) => {
  if (group.channelRole !== 'group') {
    throw new Error('Failed to restore local group because the restored track is not a group.')
  }
  const childIds = new Set(input.children.map((child) => child.trackId))
  if (childIds.size !== input.children.length) {
    throw new Error('Failed to restore local group because a child track was repeated.')
  }
  if (group.groupId && childIds.has(group.groupId)) {
    throw new Error('Failed to restore local group because its parent cannot be one of its children.')
  }

  const projectedTracks = restoredUngroupTracks(input, tracks, group)
  const projectedTrackById = new Map(projectedTracks.map((track) => [track.id, track]))
  if (!hasValidReturnTrackPartition(projectedTracks)) {
    throw new Error('Failed to restore local group because Return tracks must remain ungrouped at the end.')
  }
  if (hasTrackGroupCycle(projectedTracks)) {
    throw new Error('Failed to restore local group because its hierarchy contains a cycle.')
  }

  const groupRouting = normalizeTrackRouting({
    track: group,
    sends: group.sends,
    outputTargetId: group.outputTargetId,
    tracks: projectedTracks,
  })
  if (
    groupRouting.outputTargetId !== group.outputTargetId
    || !sendsEqual(groupRouting.sends, group.sends)
  ) {
    throw new Error('Failed to restore local group because its routing is invalid.')
  }
  for (const child of input.children) {
    const track = projectedTrackById.get(child.trackId)
    if (!track) {
      throw new Error('Failed to restore local group because a child track was not found.')
    }
    const expectedOutputTargetId = child.outputToGroup ? group.id : child.outputTargetId
    const routing = normalizeTrackRouting({
      track,
      sends: track.sends,
      outputTargetId: track.outputTargetId,
      tracks: projectedTracks,
    })
    if (routing.outputTargetId !== expectedOutputTargetId || !sendsEqual(routing.sends, track.sends)) {
      throw new Error('Failed to restore local group because a child routing target is invalid.')
    }
  }
}

const requireValidReorderAndGroupUpdates = (
  updates: readonly ReorderAndGroupTrackInput[],
  tracks: readonly TimelineTrackRow[],
) => {
  const trackById = new Map(tracks.map((track) => [track.id, track]))
  const updatedTrackIds = new Set(updates.map((update) => update.trackId))
  if (updates.length !== tracks.length || updatedTrackIds.size !== tracks.length) {
    throw new Error('Failed to reorder local timeline because updates must cover every track exactly once.')
  }
  const indexes = new Set(updates.map((update) => update.index))
  for (let index = 0; index < tracks.length; index += 1) {
    if (!indexes.has(index)) {
      throw new Error('Failed to reorder local timeline because track indexes are not contiguous.')
    }
  }
  const parentByTrackId = new Map<TimelineTrackId, TimelineTrackId>()
  for (const update of updates) {
    if (!update.groupId) continue
    const parent = trackById.get(update.groupId)
    if (parent?.channelRole !== 'group') {
      throw new Error('Failed to reorder local timeline because a parent track is not a group.')
    }
    parentByTrackId.set(update.trackId, update.groupId)
  }
  for (const update of updates) {
    let cursor = parentByTrackId.get(update.trackId)
    while (cursor) {
      if (cursor === update.trackId) {
        throw new Error('Failed to reorder local timeline because track groups cannot contain cycles.')
      }
      cursor = parentByTrackId.get(cursor)
    }
  }
}

const getEntityWriteQueue = (projectId: string) => {
  const existing = entityWriteQueuesByProject.get(projectId)
  if (existing) return existing
  const queue = new LocalEntityWriteQueue(projectId)
  entityWriteQueuesByProject.set(projectId, queue)
  return queue
}

const flushEntityWriteQueues = async (projectId?: string) => {
  const queue = projectId ? entityWriteQueuesByProject.get(projectId) : undefined
  const queues = projectId ? (queue ? [queue] : []) : Array.from(entityWriteQueuesByProject.values())
  await Promise.all(queues.map((queue) => queue.flush()))
}

const readEntityRow = async (
  projectId: string,
  kind: string,
  id: string,
): Promise<LocalProjectEntityRow | undefined> => {
  const queue = getEntityWriteQueue(projectId)
  const pending = queue.getPending(kind, id)
  if (pending !== undefined) return pending ?? undefined
  const db = await openLocalProjectDb(projectId)
  return db.get('entities', [kind, id])
}

const readEntityRowsByKind = async (projectId: string, kind: string): Promise<LocalProjectEntityRow[]> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAllFromIndex('entities', 'by-kind', kind)
  return getEntityWriteQueue(projectId).applyPendingRows(kind, rows)
}

const attachLifecycleFlush = () => {
  if (lifecycleFlushAttached || typeof window === 'undefined') return
  lifecycleFlushAttached = true
  const flush = () => {
    void Promise.all([
      flushLocalTimelineWrites(),
      flushRegisteredLocalProjectWrites(),
    ])
  }
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
}

export const registerPendingLocalTimelineFlusher = (projectId: string, flush: () => Promise<void>): (() => void) => {
  const projectFlushers = pendingLocalTimelineFlushers.get(projectId) ?? new Set<() => Promise<void>>()
  projectFlushers.add(flush)
  pendingLocalTimelineFlushers.set(projectId, projectFlushers)
  return () => {
    projectFlushers.delete(flush)
    if (projectFlushers.size === 0) pendingLocalTimelineFlushers.delete(projectId)
  }
}

export const flushLocalTimelineWrites = async (projectId?: string) => {
  await flushScheduledLocalTimelineWrites(projectId)
  for (;;) {
    const writes = projectId
      ? Array.from(pendingRepositoryWritesByProject.get(projectId) ?? [])
      : Array.from(pendingRepositoryWritesByProject.values()).flatMap((projectWrites) => Array.from(projectWrites))
    if (writes.length === 0) break
    await Promise.all(writes)
    await flushScheduledLocalTimelineWrites(projectId)
  }
}

const flushScheduledLocalTimelineWrites = async (projectId?: string) => {
  const flushers = projectId
    ? Array.from(pendingLocalTimelineFlushers.get(projectId) ?? [])
    : Array.from(pendingLocalTimelineFlushers.values()).flatMap((projectFlushers) => Array.from(projectFlushers))
  await Promise.all(flushers.map((flush) => flush()))
  await flushEntityWriteQueues(projectId)
}

const trackRepositoryWrite = <T>(projectId: string, write: Promise<T>): Promise<T> => {
  const tracked = write.finally(() => {
    const writes = pendingRepositoryWritesByProject.get(projectId)
    writes?.delete(tracked)
    if (writes?.size === 0) pendingRepositoryWritesByProject.delete(projectId)
  })
  const writes = pendingRepositoryWritesByProject.get(projectId) ?? new Set<Promise<unknown>>()
  writes.add(tracked)
  pendingRepositoryWritesByProject.set(projectId, writes)
  return tracked
}

export const createLocalTimelineRepository = (projectId: string): TimelineRepository => {
  attachLifecycleFlush()
  const markChanged = () => notifyLocalProjectChanged(projectId)
  const entityQueue = getEntityWriteQueue(projectId)

  const loadSnapshot = async (): Promise<TimelineSnapshot> => {
    await flushLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const [trackRows, clipRows, sidechainRows] = await Promise.all([
      db.getAllFromIndex('entities', 'by-kind', TRACK_KIND),
      db.getAllFromIndex('entities', 'by-kind', CLIP_KIND),
      db.getAllFromIndex('entities', 'by-kind', SIDECHAIN_KIND),
    ])
    const tracks = trackValues(trackRows).sort((left, right) => left.index - right.index)
    const clips = clipValues(clipRows).sort((left, right) => left.startSec - right.startSec)
    const sidechainRoutes = sidechainRows.flatMap((row) => isSidechainRoute(row.value) ? [row.value] : [])
    return { projectId, tracks, clips, sidechainRoutes }
  }

  const createTrack = async (input: CreateTrackInput): Promise<TimelineTrackRow> => {
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const tracks = trackValues(await db.getAllFromIndex('entities', 'by-kind', TRACK_KIND))
      .sort((left, right) => left.index - right.index)
    const timestamp = now()
    const channelRole = input.channelRole ?? 'track'
    const creation = canonicalTrackCreation(tracks, channelRole, input.index)
    const id = input.id ?? createLocalTrackId()
    const track = buildTimelineTrackRow({
      id,
      historyRef: input.historyRef,
      name: input.name,
      index: creation.creationIndex,
      volume: input.volume,
      muted: input.muted,
      soloed: input.soloed,
      kind: input.kind,
      channelRole,
      groupId: channelRole === 'return' ? undefined : input.groupId,
      collapsed: input.collapsed,
      color: input.color,
      outputTargetId: input.outputTargetId,
      sends: input.sends,
      timestamp,
    })
    const trackById = new Map(tracks.map((row) => [row.id, row]))
    const tx = db.transaction('entities', 'readwrite')
    await Promise.all([
      ...creation.existingTracks
        .filter((row) => {
          const previous = trackById.get(row.id)
          return previous?.index !== row.index || previous.groupId !== row.groupId
        })
        .map((row) => tx.store.put(toEntityRow(TRACK_KIND, row.id, {
          ...row,
          updatedAt: timestamp,
        }, timestamp))),
      tx.store.put(toEntityRow(TRACK_KIND, track.id, track, timestamp)),
    ])
    await tx.done
    markChanged()
    return track
  }

  const createClip = async (input: CreateClipInput): Promise<TimelineClipRow> => {
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const trackRow = await db.get('entities', [TRACK_KIND, input.trackId])
    if (!trackRow || !isTrackRow(trackRow.value)) {
      throw new Error('Failed to create local clip because the target track was not found.')
    }
    const timestamp = now()
    const id = input.id ?? createLocalClipId()
    const clip: TimelineClipRow = {
      id,
      trackId: input.trackId,
      historyRef: input.historyRef ?? id,
      name: input.name?.trim() || 'Clip',
      startSec: input.startSec,
      duration: input.duration,
      color: input.color ?? 'clip-midi',
      sourceAssetId: input.sourceAssetId,
      sourceAssetKey: input.sourceAssetKey,
      sourceKind: input.sourceKind,
      sourceDurationSec: input.sourceDurationSec,
      sourceSampleRate: input.sourceSampleRate,
      sourceChannelCount: input.sourceChannelCount,
      leftPadSec: input.leftPadSec,
      bufferOffsetSec: input.bufferOffsetSec,
      audioWarp: normalizeAudioWarp(input.audioWarp),
      gain: input.gain,
      fades: input.fades ? normalizeClipFades(input.fades, input.duration) : undefined,
      sampleUrl: input.sampleUrl,
      midi: input.midi,
      midiOffsetBeats: input.midiOffsetBeats,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await db.put('entities', toEntityRow(CLIP_KIND, clip.id, clip, timestamp))
    markChanged()
    return clip
  }

  const updateTrack = async (input: UpdateTrackInput): Promise<TimelineTrackRow | null> => {
    const [row, trackRows] = await Promise.all([
      readEntityRow(projectId, TRACK_KIND, input.trackId),
      input.sends !== undefined || input.outputTargetId !== undefined
        ? readEntityRowsByKind(projectId, TRACK_KIND)
          .then(trackValues)
        : Promise.resolve([]),
    ])
    if (!row || !isTrackRow(row.value)) return null
    if (row.value.channelRole === 'return' && input.groupId !== undefined && input.groupId !== null) {
      throw new Error('Return tracks cannot belong to a group.')
    }
    const timestamp = now()
    const routing = input.sends !== undefined || input.outputTargetId !== undefined
      ? normalizeTrackRouting({
        track: row.value,
        sends: input.sends ?? row.value.sends,
        outputTargetId: input.outputTargetId === null ? undefined : input.outputTargetId ?? row.value.outputTargetId,
        tracks: trackRows,
      })
      : null
    const track: TimelineTrackRow = {
      ...row.value,
      volume: input.volume ?? row.value.volume,
      index: input.index ?? row.value.index,
      muted: input.muted ?? row.value.muted,
      soloed: input.soloed ?? row.value.soloed,
      groupId: patchOptionalString(row.value.groupId, input.groupId),
      collapsed: input.collapsed ?? row.value.collapsed,
      color: patchOptionalString(row.value.color, input.color),
      outputTargetId: routing ? routing.outputTargetId : row.value.outputTargetId,
      sends: routing ? routing.sends : row.value.sends,
      updatedAt: timestamp,
    }
    if (trackPersistenceFieldsEqual(row.value, track)) return row.value
    markChanged()
    entityQueue.schedulePut(toEntityRow(TRACK_KIND, track.id, track, timestamp))
    await entityQueue.flush()
    return track
  }

  const deleteTrack = async (trackId: TimelineTrackId): Promise<void> => {
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const [trackRows, clipRows, effectRows, automationRows, sidechainRows] = await Promise.all([
      tx.store.index('by-kind').getAll(TRACK_KIND),
      tx.store.index('by-kind').getAll(CLIP_KIND),
      tx.store.index('by-kind').getAll(EFFECT_KIND),
      tx.store.index('by-kind').getAll(AUTOMATION_KIND),
      tx.store.index('by-kind').getAll(SIDECHAIN_KIND),
    ])
    const trackRow = trackRows.find((row) => row.id === trackId && isTrackRow(row.value))
    const deletedIndex = trackRow && isTrackRow(trackRow.value) ? trackRow.value.index : null
    const timestamp = now()
    const remainingTracks = trackValues(trackRows).filter((row) => row.id !== trackId)
    await Promise.all([
      tx.store.delete([TRACK_KIND, trackId]),
      ...clipRows
        .filter((row) => isClipRow(row.value) && row.value.trackId === trackId)
        .map((row) => tx.store.delete([row.kind, row.id])),
      ...effectRows
        .filter((row) => isEffectForTrack(row.value, trackId))
        .map((row) => tx.store.delete([row.kind, row.id])),
      ...automationRows
        .filter((row) => isAutomationEnvelopeForTrack(row.value, trackId))
        .map((row) => tx.store.delete([row.kind, row.id])),
      ...sidechainRows
        .filter((row) => isSidechainRoute(row.value) && (row.value.sourceTrackId === trackId || row.value.targetTrackId === trackId))
        .map((row) => tx.store.delete([row.kind, row.id])),
      ...remainingTracks.map((row) => {
        const routing = normalizeTrackRouting({
          track: row,
          sends: row.sends,
          outputTargetId: row.outputTargetId,
          tracks: remainingTracks,
        })
        const track: TimelineTrackRow = {
          ...row,
          index: deletedIndex !== null && row.index > deletedIndex ? row.index - 1 : row.index,
          groupId: row.groupId === trackId ? undefined : row.groupId,
          sends: routing.sends,
          outputTargetId: routing.outputTargetId,
          updatedAt: timestamp,
        }
        if (
          track.index === row.index
          && track.groupId === row.groupId
          && track.outputTargetId === row.outputTargetId
          && sendsEqual(track.sends, row.sends)
        ) {
          return Promise.resolve()
        }
        return tx.store.put(toEntityRow(TRACK_KIND, track.id, track, timestamp))
      }),
    ])
    await tx.done
    markChanged()
  }

  const deleteClip = async (clipId: string): Promise<void> => {
    await deleteClips([clipId])
  }

  const deleteClips = async (clipIds: TimelineClipId[]): Promise<void> => {
    if (clipIds.length === 0) return
    for (const clipId of clipIds) entityQueue.scheduleDelete(CLIP_KIND, clipId)
    markChanged()
    await entityQueue.flush()
  }

  const moveClips = async (moves: MoveClipInput[]): Promise<void> => {
    if (moves.length === 0) return
    const timestamp = now()
    const db = await openLocalProjectDb(projectId)
    const allRows = getEntityWriteQueue(projectId).applyPendingRows(
      TRACK_KIND,
      await db.getAllFromIndex('entities', 'by-kind', TRACK_KIND),
    )
    const tracks = trackValues(allRows)
    requireTrackIds(moves.map((move) => move.trackId), tracks)
    const rows = await Promise.all(moves.map((move) => readEntityRow(projectId, CLIP_KIND, move.clipId)))
    const updates = rows.flatMap((row, index) => {
      if (!row || !isClipRow(row.value)) {
        throw new Error('Failed to move local clip because a clip was not found.')
      }
      const move = moves[index]
      if (row.value.trackId === move.trackId && row.value.startSec === move.startSec) return []
      return [{
        ...row.value,
        trackId: move.trackId,
        startSec: move.startSec,
        updatedAt: timestamp,
      }]
    })
    if (updates.length === 0) return
    markChanged()
    for (const clip of updates) entityQueue.schedulePut(toEntityRow(CLIP_KIND, clip.id, clip, timestamp))
    await entityQueue.flush()
  }

  const updateClip = async (input: UpdateClipInput): Promise<TimelineClipRow | null> => {
    const [row, tracks] = await Promise.all([
      readEntityRow(projectId, CLIP_KIND, input.clipId),
      input.trackId
        ? readEntityRowsByKind(projectId, TRACK_KIND)
          .then(trackValues)
        : Promise.resolve([]),
    ])
    if (!row || !isClipRow(row.value)) return null
    if (input.trackId) requireTrackIds([input.trackId], tracks)
    const timestamp = now()
    const clip: TimelineClipRow = {
      ...row.value,
      name: input.name ?? row.value.name,
      trackId: input.trackId ?? row.value.trackId,
      startSec: input.startSec ?? row.value.startSec,
      duration: input.duration ?? row.value.duration,
      sourceAssetId: input.sourceAssetId ?? row.value.sourceAssetId,
      sourceAssetKey: input.sourceAssetKey ?? row.value.sourceAssetKey,
      sourceKind: input.sourceKind ?? row.value.sourceKind,
      sourceDurationSec: input.sourceDurationSec ?? row.value.sourceDurationSec,
      sourceSampleRate: input.sourceSampleRate ?? row.value.sourceSampleRate,
      sourceChannelCount: input.sourceChannelCount ?? row.value.sourceChannelCount,
      sampleUrl: patchOptionalString(row.value.sampleUrl, input.sampleUrl),
      leftPadSec: input.leftPadSec ?? row.value.leftPadSec,
      bufferOffsetSec: input.bufferOffsetSec ?? row.value.bufferOffsetSec,
      audioWarp: input.audioWarp === undefined ? row.value.audioWarp : normalizeAudioWarp(input.audioWarp),
      gain: input.gain ?? row.value.gain,
      fades: input.fades
        ? normalizeClipFades(input.fades, input.duration ?? row.value.duration)
        : input.duration === undefined
          ? row.value.fades
          : row.value.fades
            ? transformClipFadesForDuration(row.value.fades, row.value.duration, input.duration)
            : undefined,
      color: input.color ?? row.value.color,
      midi: input.midi ?? row.value.midi,
      midiOffsetBeats: input.midiOffsetBeats ?? row.value.midiOffsetBeats,
      updatedAt: timestamp,
    }
    if (clipPersistenceFieldsEqual(row.value, clip)) return row.value
    markChanged()
    entityQueue.schedulePut(toEntityRow(CLIP_KIND, clip.id, clip, timestamp))
    await entityQueue.flush()
    return clip
  }

  const reorderAndGroup = async (updates: ReorderAndGroupTrackInput[]): Promise<void> => {
    if (updates.length === 0) return
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const rows = await tx.store.index('by-kind').getAll(TRACK_KIND)
    const tracks = trackValues(rows)
      .sort((left, right) => left.index - right.index)
    const trackById = new Map(tracks.map((track) => [track.id, track]))
    const updateById = new Map(updates.map((update) => [update.trackId, update]))
    requireTrackIds(updates.map((update) => update.trackId), tracks)
    requireTrackIds(updates.flatMap((update) => update.groupId ? [update.groupId] : []), tracks)
    requireTrackIds(updates.flatMap((update) => update.outputTargetId ? [update.outputTargetId] : []), tracks)
    requireValidReorderAndGroupUpdates(updates, tracks)
    const timestamp = now()
    const patchedTracks = tracks.map((track) => {
      const update = updateById.get(track.id)
      return update
        ? {
            ...track,
            index: update.index,
            groupId: patchOptionalString(track.groupId, update.groupId),
            outputTargetId: patchOptionalString(track.outputTargetId, update.outputTargetId),
            updatedAt: timestamp,
          }
        : track
    })
    const nextTracks = patchedTracks.map((track) => {
      const routing = normalizeTrackRouting({
        track,
        sends: track.sends,
        outputTargetId: track.outputTargetId,
        tracks: patchedTracks,
      })
      return routing.outputTargetId === track.outputTargetId && sendsEqual(routing.sends, track.sends)
        ? track
        : { ...track, outputTargetId: routing.outputTargetId, sends: routing.sends }
    })
    if (!hasValidReturnTrackPartition(nextTracks)) {
      throw new Error('Failed to reorder local timeline because Return tracks must remain ungrouped at the end.')
    }
    const changedTracks = nextTracks.flatMap((track) => {
      const previous = trackById.get(track.id)
      if (!previous || trackPersistenceFieldsEqual(previous, track)) return []
      return [track]
    })
    if (changedTracks.length === 0) {
      await tx.done
      return
    }
    await Promise.all(changedTracks.map((track) => tx.store.put(toEntityRow(TRACK_KIND, track.id, track, timestamp))))
    await tx.done
    markChanged()
  }

  const ungroupTrack = async (groupId: TimelineTrackId): Promise<void> => {
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const [trackRows, clipRows, effectRows, automationRows, sidechainRows] = await Promise.all([
      tx.store.index('by-kind').getAll(TRACK_KIND),
      tx.store.index('by-kind').getAll(CLIP_KIND),
      tx.store.index('by-kind').getAll(EFFECT_KIND),
      tx.store.index('by-kind').getAll(AUTOMATION_KIND),
      tx.store.index('by-kind').getAll(SIDECHAIN_KIND),
    ])
    const tracks = trackValues(trackRows)
    const group = tracks.find((track) => track.id === groupId)
    if (!group || group.channelRole !== 'group') {
      await tx.done
      throw new Error('Failed to ungroup local timeline because the group track was not found.')
    }
    requireUngroupable(group, tracks, clipValues(clipRows))
    const timestamp = now()
    const changedTracks = tracks.flatMap((track) => {
      if (track.id === groupId) return []
      const isDirectChild = track.groupId === groupId
      const index = track.index > group.index ? track.index - 1 : track.index
      const nextGroupId = isDirectChild ? group.groupId : track.groupId
      const outputTargetId = isDirectChild && track.outputTargetId === groupId
        ? group.groupId
        : track.outputTargetId
      return index === track.index && nextGroupId === track.groupId && outputTargetId === track.outputTargetId
        ? []
        : [{ ...track, index, groupId: nextGroupId, outputTargetId, updatedAt: timestamp }]
    })
    await Promise.all([
      tx.store.delete([TRACK_KIND, groupId]),
      ...effectRows
        .filter((row) => isEffectForTrack(row.value, groupId))
        .map((row) => tx.store.delete([row.kind, row.id])),
      ...automationRows
        .filter((row) => isAutomationEnvelopeForTrack(row.value, groupId))
        .map((row) => tx.store.delete([row.kind, row.id])),
      ...sidechainRows
        .filter((row) => isSidechainRoute(row.value) && (row.value.sourceTrackId === groupId || row.value.targetTrackId === groupId))
        .map((row) => tx.store.delete([row.kind, row.id])),
      ...changedTracks.map((track) => tx.store.put(toEntityRow(TRACK_KIND, track.id, track, timestamp))),
    ])
    await tx.done
    markChanged()
  }

  const restoreUngroup = async (input: RestoreUngroupInput): Promise<void> => {
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const [trackRows, effectRows] = await Promise.all([
      tx.store.index('by-kind').getAll(TRACK_KIND),
      tx.store.index('by-kind').getAll(EFFECT_KIND),
    ])
    const tracks = trackValues(trackRows)
    if (tracks.some((track) => track.id === input.group.id)) {
      await tx.done
      throw new Error('Failed to restore local group because its track id is already in use.')
    }
    requireTrackIds(input.children.map((child) => child.trackId), tracks)
    requireTrackIds(input.children.flatMap((child) => !child.outputToGroup && child.outputTargetId ? [child.outputTargetId] : []), tracks)
    if (input.group.groupId) requireTrackIds([input.group.groupId], tracks)
    requireTrackIds(input.group.sends.map((send) => send.targetId), tracks)
    if (input.group.outputTargetId) requireTrackIds([input.group.outputTargetId], tracks)
    const restoredGroup = restoredUngroupGroup(input.group, tracks)
    requireValidRestoreUngroup(input, tracks, restoredGroup)
    const sidechainRoutes = input.sidechainRoutes.map((route) => ({
      sourceTrackId: route.sourceTrackId ?? input.group.id,
      targetTrackId: route.targetTrackId ?? input.group.id,
      effectInstanceId: route.effectInstanceId,
    }))
    requireTrackIds(sidechainRoutes.flatMap((route) => (
      [route.sourceTrackId, route.targetTrackId].filter((trackId) => trackId !== input.group.id)
    )), tracks)
    const sidechainTargetKeys = new Set<string>()
    for (const route of sidechainRoutes) {
      if (route.sourceTrackId === route.targetTrackId) {
        await tx.done
        throw new Error('An effect cannot sidechain from its own track.')
      }
      const targetKey = `${route.targetTrackId}:${route.effectInstanceId}`
      if (sidechainTargetKeys.has(targetKey)) {
        await tx.done
        throw new Error('A sidechain target effect cannot have multiple restored routes.')
      }
      sidechainTargetKeys.add(targetKey)
      const matchingEffects = route.targetTrackId === input.group.id
        ? input.effects.filter((effect) => (
            (effect.effect === 'compressor' || effect.effect === 'gate' || effect.effect === 'spectral')
            && effect.instanceId === route.effectInstanceId
          ))
        : effectRows.filter((row) => (
            isObject(row.value)
            && row.value.targetId === route.targetTrackId
            && (row.value.effect === 'compressor' || row.value.effect === 'gate' || row.value.effect === 'spectral')
            && row.value.instanceId === route.effectInstanceId
          ))
      if (matchingEffects.length !== 1) {
        await tx.done
        throw new Error('Sidechain target must identify exactly one compressor, gate, or spectral instance.')
      }
    }
    const timestamp = now()
    const persistedGroup = { ...restoredGroup, createdAt: timestamp, updatedAt: timestamp }
    const existingTrackById = new Map(tracks.map((track) => [track.id, track]))
    const changedTracks = restoredUngroupTracks(input, tracks, restoredGroup)
      .flatMap((track) => {
        if (track.id === restoredGroup.id) return []
        const previous = existingTrackById.get(track.id)
        return previous
          && track.index === previous.index
          && track.groupId === previous.groupId
          && track.outputTargetId === previous.outputTargetId
          ? []
          : [{ ...track, updatedAt: timestamp }]
      })
    await Promise.all([
      tx.store.put(toEntityRow(TRACK_KIND, persistedGroup.id, persistedGroup, timestamp)),
      ...changedTracks.map((track) => tx.store.put(toEntityRow(TRACK_KIND, track.id, track, timestamp))),
      ...input.effects.map((effect) => tx.store.put(toEntityRow(EFFECT_KIND, effect.id, effect, timestamp))),
      ...input.automation.map((envelope) => tx.store.put(toEntityRow(AUTOMATION_KIND, envelope.targetKey, envelope, timestamp))),
      ...sidechainRoutes.map((route) => tx.store.put(toEntityRow(
        SIDECHAIN_KIND,
        localSidechainRouteRowId(route.targetTrackId, route.effectInstanceId),
        route,
        timestamp,
      ))),
    ])
    await tx.done
    markChanged()
  }

  const applyColorBatch = async (updates: {
    tracks: TrackColorBatchUpdate[]
    clips: ClipColorBatchUpdate[]
  }): Promise<void> => {
    if (updates.tracks.length === 0 && updates.clips.length === 0) return
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const [trackRows, clipRows] = await Promise.all([
      tx.store.index('by-kind').getAll(TRACK_KIND),
      tx.store.index('by-kind').getAll(CLIP_KIND),
    ])
    const trackById = new Map(trackValues(trackRows).map((track) => [track.id, track]))
    const clipById = new Map(clipValues(clipRows).map((clip) => [clip.id, clip]))
    requireTrackIds(updates.tracks.map((update) => update.trackId), Array.from(trackById.values()))
    for (const update of updates.clips) {
      if (!clipById.has(update.clipId)) {
        await tx.done
        throw new Error('Failed to update local clip colors because a clip was not found.')
      }
    }
    const timestamp = now()
    const trackChanges = updates.tracks.flatMap((update) => {
      const track = trackById.get(update.trackId)
      if (!track) return []
      const color = patchOptionalString(track.color, update.color)
      return track.color === color ? [] : [{ ...track, color, updatedAt: timestamp }]
    })
    const clipChanges = updates.clips.flatMap((update) => {
      const clip = clipById.get(update.clipId)
      if (!clip || clip.color === update.color) return []
      return [{ ...clip, color: update.color, updatedAt: timestamp }]
    })
    await Promise.all([
      ...trackChanges.map((track) => tx.store.put(toEntityRow(TRACK_KIND, track.id, track, timestamp))),
      ...clipChanges.map((clip) => tx.store.put(toEntityRow(CLIP_KIND, clip.id, clip, timestamp))),
    ])
    await tx.done
    if (trackChanges.length > 0 || clipChanges.length > 0) markChanged()
  }

  const setSidechainRoute = async (route: ExternalSidechainRoute): Promise<void> => {
    if (route.sourceTrackId === route.targetTrackId) throw new Error('A compressor cannot sidechain from its own track.')
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const [trackRows, effectRows] = await Promise.all([
      tx.store.index('by-kind').getAll(TRACK_KIND),
      tx.store.index('by-kind').getAll(EFFECT_KIND),
    ])
    const tracks = trackValues(trackRows)
    requireTrackIds([route.sourceTrackId, route.targetTrackId], tracks)
    const matchingEffects = effectRows.filter((row) => (
      isObject(row.value)
      && row.value.targetId === route.targetTrackId
      && (row.value.effect === 'compressor' || row.value.effect === 'gate' || row.value.effect === 'spectral')
      && row.value.instanceId === route.effectInstanceId
    ))
    if (matchingEffects.length !== 1) {
      await tx.done
      throw new Error('Sidechain target must identify exactly one compressor, gate, or spectral instance.')
    }
    await tx.store.put(toEntityRow(SIDECHAIN_KIND, localSidechainRouteRowId(route.targetTrackId, route.effectInstanceId), route, now()))
    await tx.done
    markChanged()
  }

  const removeSidechainRoute = async (targetTrackId: string, effectInstanceId: string): Promise<void> => {
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const row = await db.get('entities', [SIDECHAIN_KIND, localSidechainRouteRowId(targetTrackId, effectInstanceId)])
    if (!isSidechainRoute(row?.value) || row.value.targetTrackId !== targetTrackId) return
    await db.delete('entities', [SIDECHAIN_KIND, localSidechainRouteRowId(targetTrackId, effectInstanceId)])
    markChanged()
  }

  return {
    loadSnapshot,
    createTrack: (input) => trackRepositoryWrite(projectId, createTrack(input)),
    updateTrack: (input) => trackRepositoryWrite(projectId, updateTrack(input)),
    createClip: (input) => trackRepositoryWrite(projectId, createClip(input)),
    updateClip: (input) => trackRepositoryWrite(projectId, updateClip(input)),
    moveClips: (moves) => trackRepositoryWrite(projectId, moveClips(moves)),
    reorderAndGroup: (updates) => trackRepositoryWrite(projectId, reorderAndGroup(updates)),
    ungroupTrack: (groupId) => trackRepositoryWrite(projectId, ungroupTrack(groupId)),
    restoreUngroup: (input) => trackRepositoryWrite(projectId, restoreUngroup(input)),
    applyColorBatch: (updates) => trackRepositoryWrite(projectId, applyColorBatch(updates)),
    deleteTrack: (trackId) => trackRepositoryWrite(projectId, deleteTrack(trackId)),
    deleteClip: (clipId) => trackRepositoryWrite(projectId, deleteClip(clipId)),
    deleteClips: (clipIds) => trackRepositoryWrite(projectId, deleteClips(clipIds)),
    setSidechainRoute: (route) => trackRepositoryWrite(projectId, setSidechainRoute(route)),
    removeSidechainRoute: (targetTrackId, effectInstanceId) => trackRepositoryWrite(projectId, removeSidechainRoute(targetTrackId, effectInstanceId)),
  }
}
