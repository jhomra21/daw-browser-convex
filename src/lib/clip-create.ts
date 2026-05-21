import type { FunctionArgs } from 'convex/server'
import { getPersistableAudioSourceMetadata, type AudioSourceKind, type AudioSourceMetadata } from '~/lib/audio-source'
import { uploadClipSampleUrl } from '~/lib/clip-sample-url'
import { primeClipSourceAsset } from '~/lib/clip-source-client'
import { convexApi } from '~/lib/convex'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { getClipHistoryRef } from '~/lib/undo/refs'
import type { HistoryClipSnapshot, HistoryEntry } from '~/lib/undo/types'
import type { Id } from '../../convex/_generated/dataModel'
import type { Clip, TrackId } from '~/types/timeline'

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
  projectId: string
  userId: string
  trackId: TrackId
  clip: ClipCreateSnapshot
}

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
  decoded: AudioBuffer
  source: AudioSourceMetadata
  sourceAssetKey: string
  sourceKind: AudioSourceKind
  createServerClip: (payload: ReturnType<typeof buildClipCreatePayload>) => Promise<string>
  insertLocalClip: (trackId: TrackId, clip: Clip) => void
  selectClip?: (trackId: TrackId, clipId: string) => void
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  uploadToR2: (projectId: string, assetKey: string, file: File, duration?: number) => Promise<string | null>
  audioBufferCache: Map<string, AudioBuffer>
  grantClipWrite?: (clipId: string, scope?: OptimisticGrantScope | null) => void
  grantScope?: OptimisticGrantScope
  color?: string
  pushHistory?: boolean
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
  decoded: AudioBuffer
  source: AudioSourceMetadata
  sourceAssetKey: string
  sourceKind: AudioSourceKind
  insertLocalClip: (trackId: TrackId, clip: Clip) => void
  selectClip?: (trackId: TrackId, clipId: string) => void
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  audioBufferCache: Map<string, AudioBuffer>
  color?: string
}

export type BatchClipCreateItem = {
  trackId: TrackId
  clip: ClipCreateSnapshot
  buffer?: AudioBuffer | null
}

type BatchClipCreateResult = {
  trackId: TrackId
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

export function buildClipCreatePayload(
  input: BuildClipCreatePayloadInput,
): FunctionArgs<typeof convexApi.clips.create> {
  const { projectId, userId, trackId, clip } = input
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
    projectId,
    trackId: trackId as Id<'tracks'>,
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

export async function createUploadedAudioClip(input: UploadedAudioClipInput): Promise<UploadedAudioClipResult> {
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
    projectId: input.projectId,
    assetKey: input.sourceAssetKey,
    file: input.file,
    duration: input.decoded.duration,
    uploadToR2: input.uploadToR2,
  })
  clip.sampleUrl = sampleUrl

  let clipId: string
  try {
    clipId = await input.createServerClip(buildClipCreatePayload({
      projectId: input.projectId,
      userId: input.userId,
      trackId: input.trackId,
      clip,
    }))
  } catch {
    throw new Error('clip-create-failed')
  }
  input.grantClipWrite?.(clipId, input.grantScope)

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
  const clip: ClipCreateSnapshot = {
    startSec: input.startSec,
    duration: input.decoded.duration,
    name: input.fileName,
    source: input.source,
    sourceAssetKey: input.sourceAssetKey,
    sourceKind: input.sourceKind,
  }
  const row = await createLocalTimelineRepository(input.projectId).createClip({
    trackId: input.trackId,
    name: input.fileName,
    startSec: input.startSec,
    duration: input.decoded.duration,
    color: input.color ?? getDefaultClipColor(clip),
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
  input.insertLocalClip(input.trackId, localClip)
  input.audioBufferCache.set(row.id, input.decoded)
  input.selectClip?.(input.trackId, row.id)
  pushClipCreateHistory({
    historyPush: input.historyPush,
    projectId: input.projectId,
    trackId: input.trackId,
    trackRef: input.trackRef,
    clipId: row.id,
    clip,
  })

  return { clipId: row.id, clip }
}

export async function createManyClips(input: {
  projectId: string
  userId: string
  items: readonly BatchClipCreateItem[]
  createMany: (items: ReturnType<typeof buildClipCreatePayload>[]) => Promise<string[]>
  audioBufferCache?: Map<string, AudioBuffer>
  grantClipWrites?: (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => void
  grantScope?: OptimisticGrantScope
}) {
  if (input.items.length === 0) {
    return []
  }

  const clipIds = await input.createMany(input.items.map((item) => buildClipCreatePayload({
    projectId: input.projectId,
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

  input.grantClipWrites?.(created.map((item) => item.clipId), input.grantScope)
  return created
}

export async function createProjectedClips(input: {
  projectId: string
  userId: string
  items: readonly BatchClipCreateItem[]
  createMany: (items: ReturnType<typeof buildClipCreatePayload>[]) => Promise<string[]>
  insertLocalClip: (trackId: TrackId, clip: Clip) => void
  audioBufferCache?: Map<string, AudioBuffer>
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
      buffer: pending?.buffer,
    }))
  }
  return created
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
  if (!input.projectId || typeof input.historyPush !== 'function') return

  input.historyPush(buildClipCreateHistoryEntry({
    projectId: input.projectId,
    trackId: input.trackId,
    trackRef: input.trackRef,
    clipId: input.clipId,
    clip: input.clip,
  }))
}
