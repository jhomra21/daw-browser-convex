import { openLocalProjectDb, type LocalProjectEntityRow } from '~/lib/local-project-db'
import { createLocalClipId, createLocalTrackId } from '~/lib/local-ids'
import { createLocalWriteQueue } from '~/lib/local-write-queue'
import type {
  CreateClipInput,
  CreateTrackInput,
  UpdateTrackInput,
  UpdateClipInput,
  TimelineClipRow,
  TimelineRepository,
  TimelineSnapshot,
  TimelineTrackId,
  TimelineTrackRow,
} from '~/lib/timeline-repository/types'

const TRACK_KIND = 'track'
const CLIP_KIND = 'clip'
const writeQueue = createLocalWriteQueue()
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

const attachLifecycleFlush = () => {
  if (lifecycleFlushAttached || typeof window === 'undefined') return
  lifecycleFlushAttached = true
  const flush = () => {
    void writeQueue.flush()
  }
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
}

export const flushLocalTimelineWrites = () => writeQueue.flush()

export const createLocalTimelineRepository = (projectId: string): TimelineRepository => {
  attachLifecycleFlush()

  const loadSnapshot = async (): Promise<TimelineSnapshot> => {
    await writeQueue.flush()
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
    writeQueue.enqueue(`${projectId}:track:${track.id}`, async () => {
      const latestDb = await openLocalProjectDb(projectId)
      await latestDb.put('entities', toEntityRow(TRACK_KIND, track.id, track, timestamp))
    })
    return track
  }

  const createClip = async (input: CreateClipInput): Promise<TimelineClipRow> => {
    const db = await openLocalProjectDb(projectId)
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
    writeQueue.enqueue(`${projectId}:clip:${clip.id}`, async () => {
      const latestDb = await openLocalProjectDb(projectId)
      await latestDb.put('entities', toEntityRow(CLIP_KIND, clip.id, clip, timestamp))
    })
    return clip
  }

  const updateTrack = async (input: UpdateTrackInput): Promise<TimelineTrackRow | null> => {
    await writeQueue.flush()
    const db = await openLocalProjectDb(projectId)
    const row = await db.get('entities', [TRACK_KIND, input.trackId])
    if (!row || !isTrackRow(row.value)) return null
    const timestamp = now()
    const track: TimelineTrackRow = {
      ...row.value,
      volume: input.volume ?? row.value.volume,
      muted: input.muted ?? row.value.muted,
      soloed: input.soloed ?? row.value.soloed,
      outputTargetId: input.outputTargetId === null ? undefined : input.outputTargetId ?? row.value.outputTargetId,
      sends: input.sends ?? row.value.sends,
      updatedAt: timestamp,
    }
    await db.put('entities', toEntityRow(TRACK_KIND, track.id, track, timestamp))
    return track
  }

  const deleteTrack = async (trackId: TimelineTrackId): Promise<void> => {
    await writeQueue.flush()
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const rows = await tx.store.getAll()
    await Promise.all([
      tx.store.delete([TRACK_KIND, trackId]),
      ...rows
        .filter((row) => row.kind === CLIP_KIND && isClipRow(row.value) && row.value.trackId === trackId)
        .map((row) => tx.store.delete([row.kind, row.id])),
    ])
    await tx.done
  }

  const deleteClip = async (clipId: string): Promise<void> => {
    await writeQueue.flush()
    const db = await openLocalProjectDb(projectId)
    await db.delete('entities', [CLIP_KIND, clipId])
  }

  const updateClip = async (input: UpdateClipInput): Promise<TimelineClipRow | null> => {
    await writeQueue.flush()
    const db = await openLocalProjectDb(projectId)
    const row = await db.get('entities', [CLIP_KIND, input.clipId])
    if (!row || !isClipRow(row.value)) return null
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
      leftPadSec: input.leftPadSec ?? row.value.leftPadSec,
      bufferOffsetSec: input.bufferOffsetSec ?? row.value.bufferOffsetSec,
      midi: input.midi ?? row.value.midi,
      midiOffsetBeats: input.midiOffsetBeats ?? row.value.midiOffsetBeats,
      updatedAt: timestamp,
    }
    await db.put('entities', toEntityRow(CLIP_KIND, clip.id, clip, timestamp))
    return clip
  }

  return {
    loadSnapshot,
    createTrack,
    updateTrack,
    createClip,
    updateClip,
    deleteTrack,
    deleteClip,
  }
}
