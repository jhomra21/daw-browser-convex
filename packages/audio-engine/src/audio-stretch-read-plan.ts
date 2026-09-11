import { getAudioClipTimeMap, getMarkerWarpTimelineSegments, type AudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import type { Clip } from '@daw-browser/timeline-core/types'
import type { AudioPcmSourceDescriptor } from './media-pages'
import { WSOLA_MAX_CHANNEL_COUNT } from './audio-stretching'

export type AudioStretchReadPlanSegment = {
  sourceStartFrame: number
  sourceEndFrame: number
  targetFrameCount: number
  trimStartFrame: number
  trimEndFrame: number
  timelineStartSec: number
  timelineEndSec: number
}

export type AudioStretchReadPlan = {
  map: AudioClipTimeMap
  segments: readonly AudioStretchReadPlanSegment[]
  frameCount: number
}

export const DEFAULT_STRETCH_MATERIALIZATION_MAX_BYTES = 256 * 1024 * 1024

export type AudioStretchMaterializationPolicy = {
  readonly maximumBytes: number
  readonly maximumChannels: number
}

type RuntimeClip = Pick<Clip<AudioBuffer>, 'id' | 'duration' | 'startSec' | 'leftPadSec' | 'bufferOffsetSec' | 'sourceAssetKey' | 'sourceDurationSec' | 'sourceSampleRate' | 'sourceChannelCount' | 'audioWarp' | 'buffer'>

const ANALYSIS_MARGIN_SEC = 0.08

const validateSource = (source: AudioPcmSourceDescriptor) => {
  if (!source.identity || !Number.isFinite(source.durationSec) || source.durationSec < 0
    || !Number.isSafeInteger(source.frameCount) || source.frameCount < 0
    || !Number.isFinite(source.sampleRate) || source.sampleRate <= 0
    || !Number.isSafeInteger(source.channelCount) || source.channelCount <= 0) {
    throw new Error('Audio stretch source metadata is invalid.')
  }
}

const segment = (
  source: AudioPcmSourceDescriptor,
  sourceStartSec: number,
  sourceEndSec: number,
  timelineStartSec: number,
  timelineEndSec: number,
  targetFrameCount: number,
  trimStartFrame = 0,
  trimEndFrame = targetFrameCount,
): AudioStretchReadPlanSegment | null => {
  const sourceStartFrame = Math.max(0, Math.min(source.frameCount, Math.floor(sourceStartSec * source.sampleRate)))
  const sourceEndFrame = Math.max(sourceStartFrame, Math.min(source.frameCount, Math.ceil(sourceEndSec * source.sampleRate)))
  if (sourceEndFrame - sourceStartFrame <= 0) return null
  return {
    sourceStartFrame,
    sourceEndFrame,
    targetFrameCount: Math.max(1, targetFrameCount),
    trimStartFrame: Math.max(0, trimStartFrame),
    trimEndFrame: Math.max(trimStartFrame, trimEndFrame),
    timelineStartSec,
    timelineEndSec,
  }
}

export const createAudioStretchReadPlan = (input: {
  clip: RuntimeClip
  source: AudioPcmSourceDescriptor
  projectBpm: number
}): AudioStretchReadPlan => {
  validateSource(input.source)
  const map = getAudioClipTimeMap({
    clip: input.clip,
    bufferDurationSec: input.source.durationSec,
    projectBpm: input.projectBpm,
    rangeStartSec: input.clip.startSec,
    rangeEndSec: input.clip.startSec + input.clip.duration,
  })
  if (!map || map.mode !== 'stretch') throw new Error('Cannot create a Stretch read plan for this clip.')
  const markerCount = input.clip.audioWarp?.markers?.length ?? 0
  if (markerCount > 1_000) throw new Error('Stretch warp marker count exceeds the supported limit of 1000.')

  const segments = (input.clip.audioWarp?.markers?.length ?? 0) >= 2
    ? getMarkerWarpTimelineSegments({
      clip: input.clip,
      map,
      projectBpm: input.projectBpm,
      timelineEndSec: map.timelineEndSec,
    }).flatMap((item) => {
      const targetFrameCount = Math.max(1, Math.round((item.timelineEndSec - item.timelineStartSec) * input.source.sampleRate))
      const planned = segment(
        input.source,
        item.sourceStartSec,
        item.sourceEndSec,
        item.timelineStartSec,
        item.timelineEndSec,
        targetFrameCount,
      )
      return planned ? [planned] : []
    })
    : (() => {
      const marginSec = Math.min(ANALYSIS_MARGIN_SEC, map.sourceStartSec)
      const sourceStartSec = Math.max(0, map.sourceStartSec - marginSec)
      const sourceEndSec = Math.min(input.source.durationSec, map.sourceEndSec + ANALYSIS_MARGIN_SEC)
      const sourceStartFrame = Math.floor(sourceStartSec * input.source.sampleRate)
      const sourceEndFrame = Math.min(input.source.frameCount, Math.ceil(sourceEndSec * input.source.sampleRate))
      const sourceFrameCount = Math.max(1, sourceEndFrame - sourceStartFrame)
      const targetFrameCount = Math.max(1, Math.round(sourceFrameCount / map.playbackRate))
      const trimStartFrame = Math.round((map.sourceStartSec - sourceStartSec) / map.playbackRate * input.source.sampleRate)
      const timelineFrameCount = Math.max(1, Math.round(map.timelineDurationSec * input.source.sampleRate))
      const planned = segment(
        input.source,
        sourceStartSec,
        sourceEndFrame / input.source.sampleRate,
        map.timelineStartSec,
        map.timelineEndSec,
        targetFrameCount,
        trimStartFrame,
        trimStartFrame + timelineFrameCount,
      )
      return planned ? [planned] : []
    })()

  const plannedFrameCount = segments.reduce((total, item) => {
    const count = Math.max(0, Math.min(item.targetFrameCount, item.trimEndFrame) - item.trimStartFrame)
    if (!Number.isSafeInteger(count) || total > Number.MAX_SAFE_INTEGER - count) {
      throw new Error('Stretch output frame count exceeds the safe arithmetic range.')
    }
    return total + count
  }, 0)
  const frameCount = plannedFrameCount
  if (!Number.isSafeInteger(frameCount)) throw new Error('Stretch output frame count exceeds the safe arithmetic range.')
  return {
    map,
    segments,
    frameCount,
  }
}

export const validateAudioStretchMaterialization = (
  plan: AudioStretchReadPlan,
  source: Pick<AudioPcmSourceDescriptor, 'channelCount'>,
  policy: AudioStretchMaterializationPolicy,
) => {
  if (!Number.isSafeInteger(policy.maximumBytes) || policy.maximumBytes <= 0) {
    throw new Error('Stretch materialization maximumBytes must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(policy.maximumChannels)
    || policy.maximumChannels <= 0
    || policy.maximumChannels > WSOLA_MAX_CHANNEL_COUNT) {
    throw new Error('Stretch materialization maximumChannels is invalid.')
  }
  if (source.channelCount > policy.maximumChannels) {
    throw new Error(`Stretch output channel count exceeds the supported limit of ${policy.maximumChannels}.`)
  }
  validateAudioStretchMaterializationBytes(plan.frameCount, source.channelCount, policy)
}

export const validateAudioStretchMaterializationBytes = (
  frameCount: number,
  channelCount: number,
  policy: AudioStretchMaterializationPolicy,
) => {
  if (!Number.isSafeInteger(policy.maximumBytes) || policy.maximumBytes <= 0) {
    throw new Error('Stretch materialization maximumBytes must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new Error('Stretch output frame count exceeds the safe arithmetic range.')
  }
  if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || channelCount > policy.maximumChannels) {
    throw new Error(`Stretch output channel count exceeds the supported limit of ${policy.maximumChannels}.`)
  }
  const bytesPerChannel = frameCount * Float32Array.BYTES_PER_ELEMENT
  const bytes = channelCount * bytesPerChannel
  if (!Number.isSafeInteger(bytes) || bytes > policy.maximumBytes) {
    throw new Error('Stretch materialized output exceeds its caller-provided memory limit.')
  }
}
