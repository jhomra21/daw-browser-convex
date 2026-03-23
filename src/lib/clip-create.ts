import { getPersistableAudioSourceMetadata, type AudioSourceKind, type AudioSourceMetadata } from '~/lib/audio-source'
import { uploadClipSampleUrl } from '~/lib/clip-sample-url'
import { primeClipSourceAsset } from '~/lib/clip-source-client'
import { getClipHistoryRef } from '~/lib/undo/refs'
import type { HistoryClipSnapshot, HistoryEntry } from '~/lib/undo/types'
import type { Clip } from '~/types/timeline'

export type ClipTimingSnapshot = {
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
}

export type ClipCreateSnapshot = {
  historyRef?: string
  startSec: number
  duration: number
  name?: string
  sampleUrl?: string
  source?: AudioSourceMetadata
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  midi?: Clip['midi']
  timing?: ClipTimingSnapshot
}

type BuildClipCreatePayloadInput = {
  roomId: string
  userId: string
  trackId: string
  clip: ClipCreateSnapshot
}

type BuildLocalClipInput = {
  id: string
  clip: ClipCreateSnapshot
  buffer?: AudioBuffer | null
  color?: string
}

type UploadedAudioClipInput = {
  roomId: string
  userId: string
  trackId: string
  trackRef?: string
  startSec: number
  file: File
  decoded: AudioBuffer
  source: AudioSourceMetadata
  sourceAssetKey: string
  sourceKind: AudioSourceKind
  createServerClip: (payload: ReturnType<typeof buildClipCreatePayload>) => Promise<string>
  insertLocalClip: (trackId: string, clip: Clip) => void
  selectClip?: (trackId: string, clipId: string) => void
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  uploadToR2: (roomId: string, assetKey: string, file: File, duration?: number) => Promise<string | null>
  audioBufferCache: Map<string, AudioBuffer>
  grantClipWrite?: (clipId: string) => void
  color?: string
}

export type BatchClipCreateItem = {
  trackId: string
  clip: ClipCreateSnapshot
  buffer?: AudioBuffer | null
}

type BatchClipCreateResult = {
  trackId: string
  clipId: string
  clip: ClipCreateSnapshot
}

function getDefaultClipColor(clip: ClipCreateSnapshot) {
  if (clip.sourceKind === 'recording') return 'clip-recording'
  return 'clip-audio'
}

function buildClipSnapshotFields(clip: Clip) {
  return {
    startSec: clip.startSec,
    duration: clip.duration,
    name: clip.name,
    sampleUrl: clip.sampleUrl,
    source: getPersistableAudioSourceMetadata({
      sourceDurationSec: clip.sourceDurationSec,
      sourceSampleRate: clip.sourceSampleRate,
      sourceChannelCount: clip.sourceChannelCount,
    }),
    sourceAssetKey: clip.sourceAssetKey,
    sourceKind: clip.sourceKind,
    midi: clip.midi,
    timing: {
      leftPadSec: clip.leftPadSec,
      bufferOffsetSec: clip.bufferOffsetSec,
      midiOffsetBeats: clip.midiOffsetBeats,
    },
  }
}

export function buildClipCreatePayload(input: BuildClipCreatePayloadInput) {
  const { roomId, userId, trackId, clip } = input
  if (!clip.midi) {
    if (
      !clip.sampleUrl
      || !clip.sourceAssetKey
      || !clip.sourceKind
      || !clip.source
      || clip.source.durationSec === undefined
      || clip.source.sampleRate === undefined
      || clip.source.channelCount === undefined
    ) {
      throw new Error('Audio clips require complete source metadata')
    }
  }
  return {
    roomId,
    trackId: trackId as any,
    startSec: clip.startSec,
    duration: clip.duration,
    userId,
    name: clip.name,
    sampleUrl: clip.sampleUrl,
    assetKey: clip.sourceAssetKey,
    sourceKind: clip.sourceKind,
    durationSec: clip.source?.durationSec,
    sampleRate: clip.source?.sampleRate,
    channelCount: clip.source?.channelCount,
    clipKind: clip.midi ? 'midi' : 'audio',
    ...(clip.midi ? { midi: clip.midi } : {}),
    leftPadSec: clip.timing?.leftPadSec,
    bufferOffsetSec: clip.timing?.bufferOffsetSec,
    midiOffsetBeats: clip.timing?.midiOffsetBeats,
  }
}

export function buildLocalClip(input: BuildLocalClipInput): Clip {
  const { id, clip, buffer = null, color } = input
  return {
    id,
    historyRef: clip.historyRef ?? id,
    name: clip.name || 'Clip',
    buffer,
    startSec: clip.startSec,
    duration: clip.duration,
    color: color ?? getDefaultClipColor(clip),
    sampleUrl: clip.sampleUrl,
    sourceAssetKey: clip.sourceAssetKey,
    sourceKind: clip.sourceKind,
    sourceDurationSec: clip.source?.durationSec,
    sourceSampleRate: clip.source?.sampleRate,
    sourceChannelCount: clip.source?.channelCount,
    midi: clip.midi,
    leftPadSec: clip.timing?.leftPadSec,
    bufferOffsetSec: clip.timing?.bufferOffsetSec,
    midiOffsetBeats: clip.timing?.midiOffsetBeats,
  }
}

export async function createUploadedAudioClip(input: UploadedAudioClipInput) {
  const clip: ClipCreateSnapshot = {
    startSec: input.startSec,
    duration: input.decoded.duration,
    name: input.file.name,
    sampleUrl: undefined,
    source: input.source,
    sourceAssetKey: input.sourceAssetKey,
    sourceKind: input.sourceKind,
  }

  const sampleUrl = await uploadClipSampleUrl({
    roomId: input.roomId,
    assetKey: input.sourceAssetKey,
    file: input.file,
    duration: input.decoded.duration,
    uploadToR2: input.uploadToR2,
  })
  clip.sampleUrl = sampleUrl

  let clipId: string
  try {
    clipId = await input.createServerClip(buildClipCreatePayload({
      roomId: input.roomId,
      userId: input.userId,
      trackId: input.trackId,
      clip,
    }))
  } catch {
    throw new Error('clip-create-failed')
  }
  input.grantClipWrite?.(clipId)

  input.insertLocalClip(input.trackId, buildLocalClip({
    id: clipId,
    clip,
    buffer: input.decoded,
    color: input.color,
  }))
  input.audioBufferCache.set(clipId, input.decoded)
  void primeClipSourceAsset({
    sourceAssetKey: input.sourceAssetKey,
    sampleUrl,
    buffer: input.decoded,
  })

  pushClipCreateHistory({
    historyPush: input.historyPush,
    roomId: input.roomId,
    trackId: input.trackId,
    trackRef: input.trackRef,
    clipId,
    clip,
  })
  input.selectClip?.(input.trackId, clipId)

  return clipId
}

export async function createManyClips(input: {
  roomId: string
  userId: string
  items: readonly BatchClipCreateItem[]
  createMany: (items: ReturnType<typeof buildClipCreatePayload>[]) => Promise<string[]>
  audioBufferCache?: Map<string, AudioBuffer>
  grantClipWrites?: (clipIds: Iterable<string>) => void
}) {
  if (input.items.length === 0) {
    return []
  }

  const clipIds = await input.createMany(input.items.map((item) => buildClipCreatePayload({
    roomId: input.roomId,
    userId: input.userId,
    trackId: item.trackId,
    clip: item.clip,
  })))
  if (clipIds.length !== input.items.length) {
    throw new Error('Failed to create clips')
  }

  const created: BatchClipCreateResult[] = []
  for (let index = 0; index < input.items.length; index++) {
    const item = input.items[index]
    const clipId = clipIds[index]
    if (!clipId) {
      throw new Error('Failed to create clips')
    }
    if (item.buffer && input.audioBufferCache) {
      input.audioBufferCache.set(clipId, item.buffer)
    }
    created.push({
      trackId: item.trackId,
      clipId,
      clip: item.clip,
    })
  }

  input.grantClipWrites?.(created.map((item) => item.clipId))
  return created
}

export function buildClipCreateSnapshot(
  clip: Clip,
  options?: { preserveHistoryRef?: boolean },
): ClipCreateSnapshot {
  return {
    ...buildClipSnapshotFields(clip),
    historyRef: options?.preserveHistoryRef === false ? undefined : getClipHistoryRef(clip),
  }
}

export function buildClipHistorySnapshot(clip: Clip): HistoryClipSnapshot {
  return {
    clipRef: getClipHistoryRef(clip),
    ...buildClipSnapshotFields(clip),
  }
}

export function buildClipCreateHistoryEntry(input: {
  roomId: string
  trackId: string
  trackRef?: string
  clipId: string
  clip: ClipCreateSnapshot
}): Extract<HistoryEntry, { type: 'clip-create' }> {
  const localClip = buildLocalClip({ id: input.clipId, clip: input.clip })
  return {
    type: 'clip-create',
    roomId: input.roomId,
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
  roomId?: string
  trackId: string
  trackRef?: string
  clipId: string
  clip: ClipCreateSnapshot
}) {
  if (!input.roomId || typeof input.historyPush !== 'function') return

  input.historyPush(buildClipCreateHistoryEntry({
    roomId: input.roomId,
    trackId: input.trackId,
    trackRef: input.trackRef,
    clipId: input.clipId,
    clip: input.clip,
  }))
}
