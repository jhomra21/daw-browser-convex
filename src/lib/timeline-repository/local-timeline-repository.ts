import { openLocalProjectDb, type LocalProjectEntityRow } from '~/lib/local-project-db'
import { createLocalClipId, createLocalTrackId } from '~/lib/local-ids'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { flushRegisteredLocalProjectWrites } from '~/lib/local-project-write-flushers'
import { LocalEntityWriteQueue } from '~/lib/local-write-queue'
import { normalizeTrackRouting } from '~/lib/track-routing-core'
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
  TimelineTrackId,
  TimelineTrackRow,
} from '~/lib/timeline-repository/types'

const TRACK_KIND = 'track'
const CLIP_KIND = 'clip'
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

const toEntityRow = (kind: string, id: string, value: unknown, updatedAt = now()): LocalProjectEntityRow => ({
  kind,
  id,
  value,
  updatedAt,
})

const sendsEqual = (
  left: TimelineTrackRow['sends'],
  right: TimelineTrackRow['sends'],
) => (
  left.length === right.length
  && left.every((send, index) => send.targetId === right[index]?.targetId && send.amount === right[index]?.amount)
)

const trackPersistenceFieldsEqual = (left: TimelineTrackRow, right: TimelineTrackRow) => (
  left.volume === right.volume
  && left.muted === right.muted
  && left.soloed === right.soloed
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
    const rows = await db.getAll('entities')
    const tracks = rows
      .flatMap((row) => row.kind === TRACK_KIND && isTrackRow(row.value) ? [row.value] : [])
      .sort((left, right) => left.index - right.index)
    const clips = rows
      .flatMap((row) => row.kind === CLIP_KIND && isClipRow(row.value) ? [row.value] : [])
      .sort((left, right) => left.startSec - right.startSec)
    return { projectId, tracks, clips }
  }

  const createTrack = async (input: CreateTrackInput): Promise<TimelineTrackRow> => {
    await flushScheduledLocalTimelineWrites(projectId)
    const db = await openLocalProjectDb(projectId)
    const tracks = (await db.getAllFromIndex('entities', 'by-kind', TRACK_KIND))
      .flatMap((row) => isTrackRow(row.value) ? [row.value] : [])
    const timestamp = now()
    const index = input.index ?? tracks.length
    const id = input.id ?? createLocalTrackId()
    const track: TimelineTrackRow = {
      id,
      historyRef: input.historyRef ?? id,
      name: input.name?.trim() || `Track ${index + 1}`,
      index,
      volume: input.volume ?? 0.8,
      muted: input.muted ?? false,
      soloed: input.soloed ?? false,
      kind: input.kind ?? 'audio',
      channelRole: input.channelRole ?? 'track',
      outputTargetId: input.outputTargetId,
      sends: input.sends ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const tx = db.transaction('entities', 'readwrite')
    await Promise.all([
      ...tracks
        .filter((row) => row.id !== track.id && row.index >= index)
        .map((row) => tx.store.put(toEntityRow(TRACK_KIND, row.id, {
          ...row,
          index: row.index + 1,
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
          .then((rows) => rows.flatMap((trackRow) => isTrackRow(trackRow.value) ? [trackRow.value] : []))
        : Promise.resolve([]),
    ])
    if (!row || !isTrackRow(row.value)) return null
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
      muted: input.muted ?? row.value.muted,
      soloed: input.soloed ?? row.value.soloed,
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
    const rows = await tx.store.getAll()
    const trackRow = rows.find((row) => row.kind === TRACK_KIND && row.id === trackId && isTrackRow(row.value))
    const deletedIndex = trackRow && isTrackRow(trackRow.value) ? trackRow.value.index : null
    const timestamp = now()
    const remainingTracks = rows
      .flatMap((row) => row.kind === TRACK_KIND && row.id !== trackId && isTrackRow(row.value) ? [row.value] : [])
    await Promise.all([
      tx.store.delete([TRACK_KIND, trackId]),
      ...rows
        .filter((row) => row.kind === CLIP_KIND && isClipRow(row.value) && row.value.trackId === trackId)
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
          sends: routing.sends,
          outputTargetId: routing.outputTargetId,
          updatedAt: timestamp,
        }
        if (
          track.index === row.index
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
    const tracks = allRows.flatMap((row) => row.kind === TRACK_KIND && isTrackRow(row.value) ? [row.value] : [])
    requireTrackIds(moves.map((move) => move.trackId), tracks)
    const rows = await Promise.all(moves.map((move) => readEntityRow(projectId, CLIP_KIND, move.clipId)))
    const updates = rows.map((row, index) => {
      if (!row || !isClipRow(row.value)) {
        throw new Error('Failed to move local clip because a clip was not found.')
      }
      const move = moves[index]
      return {
        ...row.value,
        trackId: move.trackId,
        startSec: move.startSec,
        updatedAt: timestamp,
      }
    })
    markChanged()
    for (const clip of updates) entityQueue.schedulePut(toEntityRow(CLIP_KIND, clip.id, clip, timestamp))
    await entityQueue.flush()
  }

  const updateClip = async (input: UpdateClipInput): Promise<TimelineClipRow | null> => {
    const [row, tracks] = await Promise.all([
      readEntityRow(projectId, CLIP_KIND, input.clipId),
      input.trackId
        ? readEntityRowsByKind(projectId, TRACK_KIND)
          .then((rows) => rows.flatMap((trackRow) => isTrackRow(trackRow.value) ? [trackRow.value] : []))
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

  return {
    loadSnapshot,
    createTrack: (input) => trackRepositoryWrite(projectId, createTrack(input)),
    updateTrack: (input) => trackRepositoryWrite(projectId, updateTrack(input)),
    createClip: (input) => trackRepositoryWrite(projectId, createClip(input)),
    updateClip: (input) => trackRepositoryWrite(projectId, updateClip(input)),
    moveClips: (moves) => trackRepositoryWrite(projectId, moveClips(moves)),
    deleteTrack: (trackId) => trackRepositoryWrite(projectId, deleteTrack(trackId)),
    deleteClip: (clipId) => trackRepositoryWrite(projectId, deleteClip(clipId)),
    deleteClips: (clipIds) => trackRepositoryWrite(projectId, deleteClips(clipIds)),
  }
}
