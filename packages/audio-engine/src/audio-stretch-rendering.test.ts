import { describe, expect, test } from 'bun:test'
import { getAudioClipTimeMap, getMarkerWarpTimelineSegments } from '@daw-browser/timeline-core/audio-clip-time-map'
import { renderStretchedAudio } from './audio-stretch-rendering'
import type { Clip } from '@daw-browser/timeline-core/types'

class TestAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number

  private readonly channels: Float32Array<ArrayBuffer>[]

  constructor(channels: Float32Array<ArrayBuffer>[], sampleRate: number) {
    this.channels = channels
    this.sampleRate = sampleRate
    this.numberOfChannels = channels.length
    this.length = channels[0]?.length ?? 0
    this.duration = this.length / sampleRate
  }

  copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset = 0): void {
    destination.set(this.channels[channelNumber].subarray(bufferOffset, bufferOffset + destination.length))
  }

  copyToChannel(source: Float32Array, channelNumber: number, bufferOffset = 0): void {
    this.channels[channelNumber].set(source, bufferOffset)
  }

  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    return this.channels[channel]
  }
}

const createFloat32Array = (length: number) => new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT))

const createBuffer = (channels: number, frames: number, sampleRate: number): AudioBuffer => (
  new TestAudioBuffer(
    Array.from({ length: channels }, () => createFloat32Array(frames)),
    sampleRate,
  )
)

const createSourceBuffer = (frames: number, sampleRate: number) => {
  const channel = createFloat32Array(frames)
  for (let index = 0; index < frames; index++) {
    channel[index] = Math.sin((2 * Math.PI * index) / 128) * 0.5
  }
  return new TestAudioBuffer([channel], sampleRate)
}

describe('renderStretchedAudio marker warp rendering', () => {
  test('uses canonical marker-warp timeline segments for rendered duration', () => {
    const sampleRate = 1_000
    const sourceBuffer = createSourceBuffer(sampleRate * 4, sampleRate)
    const clip: Clip<AudioBuffer> = {
      id: 'clip-marker-warp',
      name: 'Marker warp',
      color: '#fff',
      startSec: 1,
      duration: 3,
      leftPadSec: 0.25,
      bufferOffsetSec: 0.5,
      audioWarp: {
        enabled: true,
        mode: 'stretch',
        sourceBpm: 120,
        markers: [
          { id: 'a', timelineBeat: 0, sourceBeat: 0 },
          { id: 'b', timelineBeat: 1, sourceBeat: 0.5 },
          { id: 'c', timelineBeat: 3, sourceBeat: 3 },
          { id: 'd', timelineBeat: 5, sourceBeat: 5 },
        ],
      },
      buffer: sourceBuffer,
    }
    const projectBpm = 120
    const map = getAudioClipTimeMap({
      clip,
      bufferDurationSec: sourceBuffer.duration,
      projectBpm,
      rangeStartSec: clip.startSec,
      rangeEndSec: clip.startSec + clip.duration,
    })

    expect(map?.mode).toBe('stretch')
    if (!map) throw new Error('Expected marker warp map')

    const expectedFrameCount = getMarkerWarpTimelineSegments({
      clip,
      map,
      projectBpm,
      timelineEndSec: map.timelineEndSec,
    }).reduce(
      (total, segment) => total + Math.max(1, Math.round((segment.timelineEndSec - segment.timelineStartSec) * sampleRate)),
      0,
    )
    const rendered = renderStretchedAudio(clip, projectBpm, createBuffer)

    expect(rendered.buffer.length).toBe(expectedFrameCount)
    expect(rendered.timelineStartSec).toBe(map.timelineStartSec)
    expect(rendered.timelineDurationSec).toBe(expectedFrameCount / sampleRate)
  })
})
