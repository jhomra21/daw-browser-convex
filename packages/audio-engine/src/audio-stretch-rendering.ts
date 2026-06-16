import { getAudioClipTimeMap, getMarkerWarpTimelineSegments, type AudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { stretchAudioWsola } from './audio-stretching'
import type { Clip } from '@daw-browser/timeline-core/types'
import type { StretchedAudioRender } from './audio-stretch-cache'

export type AudioStretchRuntimeClip = Pick<Clip<AudioBuffer>, 'id' | 'duration' | 'startSec' | 'leftPadSec' | 'bufferOffsetSec' | 'sourceAssetKey' | 'sourceDurationSec' | 'sourceSampleRate' | 'sourceChannelCount' | 'audioWarp' | 'buffer'>
type CreateBuffer = (channels: number, frames: number, sampleRate: number) => AudioBuffer

const ANALYSIS_MARGIN_SEC = 0.08

export const copyBufferWindow = (buffer: AudioBuffer, startFrame: number, frameCount: number) => {
  const channels: Float32Array[] = []
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
    const channel = new Float32Array(frameCount)
    buffer.copyFromChannel(channel, channelIndex, startFrame)
    channels.push(channel)
  }
  return channels
}

export const writeBuffer = (
  createBuffer: CreateBuffer,
  channels: Float32Array[],
  sampleRate: number,
) => {
  const frameCount = channels[0]?.length ?? 0
  const buffer = createBuffer(channels.length, frameCount, sampleRate)
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    const target = buffer.getChannelData(channelIndex)
    const source = channels[channelIndex]
    for (let frame = 0; frame < source.length; frame++) target[frame] = source[frame]
  }
  return buffer
}

const renderMappedStretch = (
  sourceBuffer: AudioBuffer,
  map: AudioClipTimeMap,
  clip: AudioStretchRuntimeClip,
  projectBpm: number,
  createBuffer: CreateBuffer,
) => {
  const markerSegments = getMarkerWarpTimelineSegments({
    clip,
    map,
    projectBpm,
    timelineEndSec: map.timelineEndSec,
  })
  const stretchedSegments = markerSegments.flatMap((segment) => {
    const sourceStartSec = Math.max(0, Math.min(sourceBuffer.duration, segment.sourceStartSec))
    const sourceEndSec = Math.max(0, Math.min(sourceBuffer.duration, segment.sourceEndSec))
    const sourceDurationSec = sourceEndSec - sourceStartSec
    const targetFrameCount = Math.max(1, Math.round((segment.timelineEndSec - segment.timelineStartSec) * sourceBuffer.sampleRate))
    if (sourceDurationSec <= 1 / sourceBuffer.sampleRate) return []
    const startFrame = Math.max(0, Math.min(sourceBuffer.length - 1, Math.floor(sourceStartSec * sourceBuffer.sampleRate)))
    const endFrame = Math.max(startFrame + 1, Math.min(sourceBuffer.length, Math.ceil(sourceEndSec * sourceBuffer.sampleRate)))
    return [stretchAudioWsola({
      channels: copyBufferWindow(sourceBuffer, startFrame, endFrame - startFrame),
      sampleRate: sourceBuffer.sampleRate,
    }, {
      outputFrameCount: targetFrameCount,
    }).channels]
  })
  const frameCount = stretchedSegments.reduce((total, segment) => total + (segment[0]?.length ?? 0), 0)
  const channels = Array.from({ length: sourceBuffer.numberOfChannels }, (_, channelIndex) => {
    const output = new Float32Array(frameCount)
    let offset = 0
    for (const segment of stretchedSegments) {
      const source = segment[channelIndex]
      if (!source) continue
      output.set(source, offset)
      offset += source.length
    }
    return output
  })
  return {
    buffer: writeBuffer(createBuffer, channels, sourceBuffer.sampleRate),
    timelineStartSec: map.timelineStartSec,
    sourceStartSec: 0,
    timelineDurationSec: frameCount / sourceBuffer.sampleRate,
  }
}

export const renderStretchedAudio = (
  clip: AudioStretchRuntimeClip,
  projectBpm: number,
  createBuffer: CreateBuffer,
): StretchedAudioRender => {
  const sourceBuffer = clip.buffer
  if (!sourceBuffer) throw new Error('Cannot render Stretch warp without an audio buffer.')
  const map = getAudioClipTimeMap({
    clip,
    bufferDurationSec: sourceBuffer.duration,
    projectBpm,
    rangeStartSec: clip.startSec,
    rangeEndSec: clip.startSec + clip.duration,
  })
  if (!map || map.mode !== 'stretch') throw new Error('Cannot render Stretch warp for a non-stretched clip.')
  if ((clip.audioWarp?.markers?.length ?? 0) >= 2) return renderMappedStretch(sourceBuffer, map, clip, projectBpm, createBuffer)

  const marginSec = Math.min(ANALYSIS_MARGIN_SEC, map.sourceStartSec)
  const renderSourceStartSec = Math.max(0, map.sourceStartSec - marginSec)
  const renderSourceEndSec = Math.min(sourceBuffer.duration, map.sourceEndSec + ANALYSIS_MARGIN_SEC)
  const startFrame = Math.floor(renderSourceStartSec * sourceBuffer.sampleRate)
  const sourceFrameCount = Math.max(1, Math.ceil((renderSourceEndSec - renderSourceStartSec) * sourceBuffer.sampleRate))
  const outputFrameCount = Math.max(1, Math.round((sourceFrameCount / map.playbackRate)))
  const stretched = stretchAudioWsola({
    channels: copyBufferWindow(sourceBuffer, startFrame, sourceFrameCount),
    sampleRate: sourceBuffer.sampleRate,
  }, {
    outputFrameCount,
  })
  const marginOutputFrames = Math.round((map.sourceStartSec - renderSourceStartSec) / map.playbackRate * sourceBuffer.sampleRate)
  const timelineFrames = Math.max(1, Math.round(map.timelineDurationSec * sourceBuffer.sampleRate))
  const trimmedChannels = stretched.channels.map((channel) => {
    const trimmed = new Float32Array(timelineFrames)
    trimmed.set(channel.subarray(marginOutputFrames, Math.min(channel.length, marginOutputFrames + timelineFrames)))
    return trimmed
  })
  return {
    buffer: writeBuffer(createBuffer, trimmedChannels, sourceBuffer.sampleRate),
    timelineStartSec: map.timelineStartSec,
    sourceStartSec: 0,
    timelineDurationSec: timelineFrames / sourceBuffer.sampleRate,
  }
}
