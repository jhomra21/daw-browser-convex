import type { AudioSourceKind, AudioSourceMetadata } from '~/lib/audio-source'
import { assert, assertDefined, buildClipCreatePayload, buildQueuedAudioClipCreatePayload, normalizeAudioWarp, sanitizeLegacyMidiClipForCreate } from '@daw-browser/shared'
import type { ClipCreateSnapshot, SharedTimelineClipCreatePayload } from '@daw-browser/shared'
import type { ClipBufferWriter } from '~/lib/clip-buffer-cache'
import { uploadClipSampleUrl } from '~/lib/clip-sample-url'
import { primeClipSourceAsset } from '~/lib/clip-source-client'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { enqueueSharedAudioClipCreateOnFailure, enqueueSharedTimelineOperationOnFailure, isPermanentSharedOperationError, SharedOutboxQueuedError } from '~/lib/shared-outbox'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { HistoryEntry } from '~/lib/undo/types'
import type { TrackId } from '@daw-browser/timeline-core/types'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'
import { getDefaultClipColor } from '~/lib/clip-color'
import { buildClipHistorySnapshot } from '~/lib/clip-history-snapshot'

export { buildClipCreateSnapshot, buildClipHistorySnapshot } from '~/lib/clip-history-snapshot'

type BuildLocalClipInput = {
  id: string
  clip: ClipCreateSnapshot
  buffer?: AudioBuffer | null
  color?: string
}

type UploadedAudioClipInput = {
  projectId: string
  userId: string
  trackId: TrackId
  trackRef?: string
  startSec: number
  file: File
  decoded?: AudioBuffer
  durationSec?: number
  source: AudioSourceMetadata
  sourceAssetKey: string
  sourceKind: AudioSourceKind
  createServerClip: (payload: SharedTimelineClipCreatePayload) => Promise<string | null>
  insertLocalClip: (trackId: TrackId, clip: RuntimeClip) => void
  removeLocalClips?: (clipIds: Iterable<string>) => void
  selectClip?: (trackId: TrackId, clipId: string) => void
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  uploadToR2: (projectId: string, assetKey: string, file: File, duration?: number) => Promise<{ assetKey: string; url: string } | null>
  audioBufferCache: ClipBufferWriter
  grantClipWrite?: (clipId: string, scope?: OptimisticGrantScope | null) => void
  grantScope?: OptimisticGrantScope
  color?: string
  pushHistory?: boolean
  canProject?: () => boolean
  onClipCreated?: (clip: RuntimeClip) => void
}

type UploadedAudioClipResult = {
  clipId: string
  clip: ClipCreateSnapshot
}

type LocalAudioClipInput = {
  projectId: string
  trackId: TrackId
  trackRef?: string
  startSec: number
  fileName: string
  decoded?: AudioBuffer
  durationSec?: number
  source: AudioSourceMetadata
  sourceAssetKey: string
  sourceKind: AudioSourceKind
  insertLocalClip: (trackId: TrackId, clip: RuntimeClip) => void
  selectClip?: (trackId: TrackId, clipId: string) => void
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  skipHistory?: boolean
  audioBufferCache: ClipBufferWriter
  color?: string
  canProject?: () => boolean
  onClipCreated?: (clip: RuntimeClip) => void
}

export type BatchClipCreateItem = {
  trackId: TrackId
  clip: ClipCreateSnapshot
  buffer?: AudioBuffer | null
}

const sanitizeNewClipCreateItem = (item: BatchClipCreateItem): BatchClipCreateItem => ({
  ...item,
  clip: {
    ...item.clip,
    midi: item.clip.midi ? sanitizeLegacyMidiClipForCreate(item.clip.midi) : undefined,
  },
})

type BatchClipCreateResult = {
  trackId: TrackId
  clipId: string
  clip: ClipCreateSnapshot
}

export function buildLocalClip(input: BuildLocalClipInput): RuntimeClip {
  const { id, clip, buffer = null, color } = input
  return {
    id,
    historyRef: clip.historyRef ?? id,
    name: clip.name || 'Clip',
    buffer,
    startSec: clip.startSec,
    duration: clip.duration,
    color: color ?? clip.color ?? getDefaultClipColor(clip),
    sampleUrl: clip.sampleUrl,
    sourceAssetKey: clip.sourceAssetKey,
    sourceKind: clip.sourceKind,
    sourceDurationSec: clip.source?.durationSec,
    sourceSampleRate: clip.source?.sampleRate,
    sourceChannelCount: clip.source?.channelCount,
    midi: clip.midi,
    leftPadSec: clip.timing?.leftPadSec,
    bufferOffsetSec: clip.timing?.bufferOffsetSec,
    audioWarp: normalizeAudioWarp(clip.audioWarp),
    gain: clip.gain,
    fades: clip.fades,
    midiOffsetBeats: clip.timing?.midiOffsetBeats,
  }
}

export async function createUploadedAudioClip(input: UploadedAudioClipInput): Promise<UploadedAudioClipResult> {
  const duration = input.decoded?.duration ?? input.durationSec
  assert(duration !== undefined, 'Audio clip duration is required')
  const clip: ClipCreateSnapshot = {
    startSec: input.startSec,
    duration,
    name: input.file.name,
    sampleUrl: undefined,
    source: input.source,
    sourceAssetKey: input.sourceAssetKey,
    sourceKind: input.sourceKind,
    color: input.color,
  }
  const pendingClipId = `pending:${crypto.randomUUID()}`
  const canProjectPending = input.canProject?.() !== false
  if (canProjectPending) {
    input.insertLocalClip(input.trackId, buildLocalClip({
      id: pendingClipId,
      clip: {
        ...clip,
        name: `${input.file.name || 'Clip'} (uploading)`,
      },
      buffer: input.decoded,
      color: input.color,
    }))
    if (input.decoded) input.audioBufferCache.storeBuffer(pendingClipId, input.decoded)
    input.selectClip?.(input.trackId, pendingClipId)
  }
  const removePendingClip = () => {
    if (!canProjectPending) return
    input.removeLocalClips?.([pendingClipId])
    input.audioBufferCache.removeBuffer(pendingClipId)
  }

  const operationId = crypto.randomUUID()
  const queuedClipPayload = buildQueuedAudioClipCreatePayload({
    projectId: input.projectId,
    trackId: input.trackId,
    clip,
    operationId,
  })

  const upload = await uploadClipSampleUrl({
    projectId: input.projectId,
    assetKey: input.sourceAssetKey,
    file: input.file,
    duration,
    uploadToR2: input.uploadToR2,
  }).catch(async (error) => {
    removePendingClip()
    if (isPermanentSharedOperationError(error)) throw error
    await enqueueSharedAudioClipCreateOnFailure({
      projectId: input.projectId,
      userId: input.userId,
      assetKey: input.sourceAssetKey,
      file: input.file,
      duration,
      clipPayload: queuedClipPayload,
      error,
    })
    throw new SharedOutboxQueuedError('clips.createUploadedAudio', operationId)
  })
  clip.sampleUrl = upload.url
  clip.sourceAssetKey = upload.assetKey

  let clipId: string
  const payload = {
    ...queuedClipPayload,
    sampleUrl: upload.url,
    assetKey: upload.assetKey,
  }
  try {
    const createdClipId = await input.createServerClip(payload)
    clipId = assertDefined(createdClipId, 'Failed to create clip')
  } catch (error) {
    removePendingClip()
    if (isPermanentSharedOperationError(error)) throw error
    await enqueueSharedTimelineOperationOnFailure({
      projectId: input.projectId,
      userId: input.userId,
      operation: { kind: 'clips.create', payload },
      error,
    })
    throw new SharedOutboxQueuedError('clips.create', operationId)
  }
  input.grantClipWrite?.(clipId, input.grantScope)
  removePendingClip()

  if (input.canProject?.() === false) {
    void primeClipSourceAsset({
      sourceAssetKey: upload.assetKey,
      sampleUrl: upload.url,
      buffer: input.decoded,
    })
    return { clipId, clip }
  }

  const localClip = buildLocalClip({
    id: clipId,
    clip,
    buffer: input.decoded,
    color: input.color,
  })
  input.insertLocalClip(input.trackId, localClip)
  if (input.decoded) input.audioBufferCache.storeBuffer(clipId, input.decoded)
  input.onClipCreated?.(localClip)
  void primeClipSourceAsset({
    sourceAssetKey: input.sourceAssetKey,
    sampleUrl: upload.url,
    buffer: input.decoded,
  })

  if (input.pushHistory !== false) {
    pushClipCreateHistory({
      historyPush: input.historyPush,
      projectId: input.projectId,
      trackId: input.trackId,
      trackRef: input.trackRef,
      clipId,
      clip,
    })
  }
  input.selectClip?.(input.trackId, clipId)

  return { clipId, clip }
}

export async function createLocalAudioClip(input: LocalAudioClipInput): Promise<UploadedAudioClipResult> {
  const duration = input.decoded?.duration ?? input.durationSec
  assert(duration !== undefined, 'Audio clip duration is required')
  const clip: ClipCreateSnapshot = {
    startSec: input.startSec,
    duration,
    name: input.fileName,
    source: input.source,
    sourceAssetKey: input.sourceAssetKey,
    sourceKind: input.sourceKind,
    color: input.color,
  }
  const row = await createLocalTimelineRepository(input.projectId).createClip({
    trackId: input.trackId,
    name: input.fileName,
    startSec: input.startSec,
    duration,
    color: input.color ?? clip.color ?? getDefaultClipColor(clip),
    sourceAssetId: input.sourceAssetKey,
    sourceAssetKey: input.sourceAssetKey,
    sourceKind: input.sourceKind,
    sourceDurationSec: input.source.durationSec,
    sourceSampleRate: input.source.sampleRate,
    sourceChannelCount: input.source.channelCount,
  })

  const localClip = buildLocalClip({
    id: row.id,
    clip: { ...clip, historyRef: row.historyRef },
    buffer: input.decoded,
    color: row.color,
  })
  if (input.canProject?.() === false) {
    return { clipId: row.id, clip }
  }
  input.insertLocalClip(input.trackId, localClip)
  if (input.decoded) input.audioBufferCache.storeBuffer(row.id, input.decoded)
  input.onClipCreated?.(localClip)
  input.selectClip?.(input.trackId, row.id)
  if (!input.skipHistory) {
    pushClipCreateHistory({
      historyPush: input.historyPush,
      projectId: input.projectId,
      trackId: input.trackId,
      trackRef: input.trackRef,
      clipId: row.id,
      clip,
    })
  }

  return { clipId: row.id, clip }
}

async function createManyClips(input: {
  projectId: string
  items: readonly BatchClipCreateItem[]
  createMany: (items: ReturnType<typeof buildClipCreatePayload>[], operationId: string) => Promise<Array<string | null>>
  audioBufferCache?: ClipBufferWriter
  grantClipWrites?: (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => void
  grantScope?: OptimisticGrantScope
}) {
  if (input.items.length === 0) {
    return []
  }

  const operationId = crypto.randomUUID()
  const items = input.items.map(sanitizeNewClipCreateItem)
  const payloadItems = items.map((item) => buildClipCreatePayload({
    projectId: input.projectId,
    trackId: item.trackId,
    clip: item.clip,
  }))
  const clipIds = await input.createMany(payloadItems, operationId)
  assert(clipIds.length === input.items.length, 'Failed to create clips')

  const created: BatchClipCreateResult[] = []
  const bufferEntries: Array<readonly [string, AudioBuffer]> = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const clipId = clipIds[index]
    const resolvedClipId = assertDefined(clipId, 'Failed to create clips')
    if (item.buffer) bufferEntries.push([resolvedClipId, item.buffer])
    created.push({
      trackId: item.trackId,
      clipId: resolvedClipId,
      clip: item.clip,
    })
  }

  input.audioBufferCache?.storeBuffers(bufferEntries)
  input.grantClipWrites?.(created.map((item) => item.clipId), input.grantScope)
  return created
}

export async function createProjectedClips(input: {
  projectId: string
  items: readonly BatchClipCreateItem[]
  createMany: (items: ReturnType<typeof buildClipCreatePayload>[], operationId: string) => Promise<Array<string | null>>
  insertLocalClip: (trackId: TrackId, clip: RuntimeClip) => void
  audioBufferCache: ClipBufferWriter
  grantClipWrites?: (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => void
  grantScope?: OptimisticGrantScope
}) {
  const created = await createManyClips(input)
  for (let index = 0; index < created.length; index++) {
    const item = created[index]
    const pending = input.items[index]
    input.insertLocalClip(item.trackId, buildLocalClip({
      id: item.clipId,
      clip: item.clip,
      buffer: pending.buffer,
    }))
  }
  return created
}

export async function createProjectedLocalClips(input: {
  projectId: string
  items: readonly BatchClipCreateItem[]
  insertLocalClip: (trackId: TrackId, clip: RuntimeClip) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  audioBufferCache: ClipBufferWriter
  canProject?: () => boolean
}) {
  const repository = createLocalTimelineRepository(input.projectId)
  const items = input.items.map(sanitizeNewClipCreateItem)
  const created: BatchClipCreateResult[] = []
  const bufferEntries: Array<readonly [string, AudioBuffer]> = []
  const cleanupCreatedClips = async (clipIds: string[]) => {
    await Promise.all(clipIds.map((clipId) => repository.deleteClip(clipId).catch(() => null)))
    for (const clipId of clipIds) input.audioBufferCache.removeBuffer(clipId)
    input.removeLocalClips(clipIds)
  }
  try {
    for (const item of items) {
      if (input.canProject && !input.canProject()) {
        await cleanupCreatedClips(created.map((entry) => entry.clipId))
        return []
      }
      const row = await repository.createClip({
        trackId: item.trackId,
        name: item.clip.name,
        startSec: item.clip.startSec,
        duration: item.clip.duration,
        color: item.clip.color ?? getDefaultClipColor(item.clip),
        sourceAssetKey: item.clip.sourceAssetKey,
        sourceKind: item.clip.sourceKind,
        sourceDurationSec: item.clip.source?.durationSec,
        sourceSampleRate: item.clip.source?.sampleRate,
        sourceChannelCount: item.clip.source?.channelCount,
        leftPadSec: item.clip.timing?.leftPadSec,
        bufferOffsetSec: item.clip.timing?.bufferOffsetSec,
        audioWarp: normalizeAudioWarp(item.clip.audioWarp),
        gain: item.clip.gain,
        sampleUrl: item.clip.sampleUrl,
        midi: item.clip.midi,
        midiOffsetBeats: item.clip.timing?.midiOffsetBeats,
      })
      if (input.canProject && !input.canProject()) {
        await cleanupCreatedClips([...created.map((entry) => entry.clipId), row.id])
        return []
      }
      input.insertLocalClip(item.trackId, buildLocalClip({
        id: row.id,
        clip: { ...item.clip, historyRef: row.historyRef },
        buffer: item.buffer,
        color: row.color,
      }))
      if (item.buffer) bufferEntries.push([row.id, item.buffer])
      created.push({
        trackId: item.trackId,
        clipId: row.id,
        clip: { ...item.clip, historyRef: row.historyRef },
      })
    }
    input.audioBufferCache.storeBuffers(bufferEntries)
    return created
  } catch (error) {
    const createdClipIds = created.map((item) => item.clipId)
    await cleanupCreatedClips(createdClipIds)
    throw error
  }
}

export function buildCreatedClipSelection(created: readonly BatchClipCreateResult[]) {
  const primary = created[created.length - 1]
  if (!primary) return null
  return {
    trackId: primary.trackId,
    clipIds: created.map((item) => item.clipId),
    primaryClipId: primary.clipId,
  }
}

function buildClipCreateHistoryEntry(input: {
  projectId: string
  trackId: TrackId
  trackRef?: string
  clipId: string
  clip: ClipCreateSnapshot
}): Extract<HistoryEntry, { type: 'clip-create' }> {
  const localClip = buildLocalClip({ id: input.clipId, clip: input.clip })
  return {
    type: 'clip-create',
    projectId: input.projectId,
    data: {
      trackRef: input.trackRef ?? input.trackId,
      clip: {
        currentId: input.clipId,
        ...buildClipHistorySnapshot(localClip),
      },
    },
  }
}

export function pushClipCreateHistory(input: {
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  projectId?: string
  trackId: TrackId
  trackRef?: string
  clipId: string
  clip: ClipCreateSnapshot
}) {
  if (!input.projectId || !input.historyPush) return

  input.historyPush(buildClipCreateHistoryEntry({
    projectId: input.projectId,
    trackId: input.trackId,
    trackRef: input.trackRef,
    clipId: input.clipId,
    clip: input.clip,
  }))
}
