import { sha256 } from '@noble/hashes/sha2.js'
import type { AudioStretchReadPlan, AudioStretchReadPlanSegment } from './audio-stretch-read-plan'

export const PREPARED_STRETCH_ARTIFACT_VERSION = 'v1'
export const PREPARED_STRETCH_RENDERER_VERSION = 'audio-stretch-renderer:v1'
export const PREPARED_STRETCH_ALGORITHM_VERSION = 'wsola:v1'

export type PreparedStretchArtifactSegment = Pick<
  AudioStretchReadPlanSegment,
  'sourceStartFrame' | 'sourceEndFrame' | 'targetFrameCount' | 'trimStartFrame' | 'trimEndFrame'
>

export type PreparedStretchArtifactDescriptor = {
  rendererVersion: string
  algorithmVersion: string
  wsola: {
    windowFrameCount: number
    overlapFrameCount: number
    searchFrameCount: number
  }
  source: {
    contentIdentity: string
    frameCount: number
    sampleRate: number
    channelCount: number
  }
  segments: readonly PreparedStretchArtifactSegment[]
  output: {
    sampleRate: number
    channelCount: number
    frameCount: number
  }
  persistable: boolean
}

export type PreparedStretchArtifact = PreparedStretchArtifactDescriptor & {
  artifactId: string
}

export type PreparedStretchArtifactBinding = {
  clipId: string
  artifactId: string
  timelineStartSec: number
  timelineDurationSec: number
  sourceStartSec: number
}

const hex = (bytes: Uint8Array) => Array.from(
  bytes,
  (byte) => byte.toString(16).padStart(2, '0'),
).join('')
const isCanonicalContentHash = (value: string | undefined) => value !== undefined && /^[0-9a-f]{64}$/u.test(value)

const digest = (descriptor: PreparedStretchArtifactDescriptor) => hex(
  sha256(new TextEncoder().encode(JSON.stringify({
    rendererVersion: descriptor.rendererVersion,
    algorithmVersion: descriptor.algorithmVersion,
    wsola: descriptor.wsola,
    source: descriptor.source,
    segments: descriptor.segments,
    output: descriptor.output,
  }))),
)

const validateDescriptor = (descriptor: PreparedStretchArtifactDescriptor) => {
  if (!descriptor.source.contentIdentity
    || !Number.isSafeInteger(descriptor.source.frameCount)
    || descriptor.source.frameCount < 0
    || !Number.isFinite(descriptor.source.sampleRate)
    || descriptor.source.sampleRate <= 0
    || !Number.isSafeInteger(descriptor.source.channelCount)
    || descriptor.source.channelCount <= 0
    || !Number.isSafeInteger(descriptor.output.frameCount)
    || descriptor.output.frameCount < 0
    || !Number.isFinite(descriptor.output.sampleRate)
    || descriptor.output.sampleRate <= 0
    || descriptor.output.channelCount !== descriptor.source.channelCount
    || !Number.isSafeInteger(descriptor.wsola.windowFrameCount)
    || !Number.isSafeInteger(descriptor.wsola.overlapFrameCount)
    || !Number.isSafeInteger(descriptor.wsola.searchFrameCount)) {
    throw new Error('Prepared Stretch artifact metadata is invalid.')
  }
  for (const segment of descriptor.segments) {
    if (!Number.isSafeInteger(segment.sourceStartFrame)
      || !Number.isSafeInteger(segment.sourceEndFrame)
      || segment.sourceStartFrame < 0
      || segment.sourceEndFrame <= segment.sourceStartFrame
      || !Number.isSafeInteger(segment.targetFrameCount)
      || segment.targetFrameCount <= 0
      || !Number.isSafeInteger(segment.trimStartFrame)
      || !Number.isSafeInteger(segment.trimEndFrame)
      || segment.trimStartFrame < 0
      || segment.trimEndFrame < segment.trimStartFrame
      || segment.trimEndFrame > segment.targetFrameCount) {
      throw new Error('Prepared Stretch artifact segment metadata is invalid.')
    }
  }
}

export const createPreparedStretchArtifact = (input: {
  contentIdentity?: string
  source: {
    identity: string
    contentHash?: string
    contentHashVerified?: boolean
    persistable?: boolean
    frameCount: number
    sampleRate: number
    channelCount: number
  }
  plan: AudioStretchReadPlan
  persistable?: boolean
  outputSampleRate?: number
  windowFrameCount: number
  overlapFrameCount: number
  searchFrameCount: number
}): PreparedStretchArtifact => {
  const trustedContentHash = input.source.contentHashVerified === true
    && isCanonicalContentHash(input.source.contentHash)
    ? input.source.contentHash
    : undefined
  const contentIdentity = input.source.contentHashVerified === true
    ? input.contentIdentity ?? trustedContentHash ?? input.source.identity
    : input.source.identity
  const descriptor: PreparedStretchArtifactDescriptor = {
    rendererVersion: PREPARED_STRETCH_RENDERER_VERSION,
    algorithmVersion: PREPARED_STRETCH_ALGORITHM_VERSION,
    wsola: {
      windowFrameCount: input.windowFrameCount,
      overlapFrameCount: input.overlapFrameCount,
      searchFrameCount: input.searchFrameCount,
    },
    source: {
      contentIdentity,
      frameCount: input.source.frameCount,
      sampleRate: input.source.sampleRate,
      channelCount: input.source.channelCount,
    },
    segments: input.plan.segments.map((segment) => ({
      sourceStartFrame: segment.sourceStartFrame,
      sourceEndFrame: segment.sourceEndFrame,
      targetFrameCount: segment.targetFrameCount,
      trimStartFrame: segment.trimStartFrame,
      trimEndFrame: segment.trimEndFrame,
    })),
    output: {
      sampleRate: input.outputSampleRate ?? input.source.sampleRate,
      channelCount: input.source.channelCount,
      frameCount: input.plan.frameCount,
    },
    persistable: input.persistable === true
      && input.source.persistable === true
      && input.source.contentHashVerified === true
      && isCanonicalContentHash(trustedContentHash),
  }
  validateDescriptor(descriptor)
  return Object.freeze({
    ...descriptor,
    artifactId: `stretch:${PREPARED_STRETCH_ARTIFACT_VERSION}:${digest(descriptor)}`,
  })
}

export const createPreparedStretchArtifactBinding = (input: {
  clipId: string
  artifact: PreparedStretchArtifact
  timelineStartSec: number
  timelineDurationSec: number
  sourceStartSec?: number
}): PreparedStretchArtifactBinding => ({
  clipId: input.clipId,
  artifactId: input.artifact.artifactId,
  timelineStartSec: input.timelineStartSec,
  timelineDurationSec: input.timelineDurationSec,
  sourceStartSec: input.sourceStartSec ?? 0,
})

export const preparedStretchArtifactCanonicalJson = (artifact: PreparedStretchArtifactDescriptor) => JSON.stringify({
  rendererVersion: artifact.rendererVersion,
  algorithmVersion: artifact.algorithmVersion,
  wsola: artifact.wsola,
  source: artifact.source,
  segments: artifact.segments,
  output: artifact.output,
})
