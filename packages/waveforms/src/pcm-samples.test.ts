import { describe, expect, test } from 'bun:test'
import { createPcmSampleWindowCollector } from './pcm-samples'

const page = (startFrame: number, left: number[], right: number[] = []) => ({
  startFrame,
  frameCount: left.length,
  sampleRate: 48_000,
  channelCount: right.length > 0 ? 2 : 1,
  planes: right.length > 0
    ? [new Float32Array(left), new Float32Array(right)]
    : [new Float32Array(left)],
})

describe('createPcmSampleWindowCollector', () => {
  test('clips exact stereo frame windows and leaves uncovered frames silent', () => {
    const collector = createPcmSampleWindowCollector({
      startFrame: 2,
      endFrame: 6,
      sampleRate: 48_000,
      channelCount: 2,
      sourceStartSec: 2 / 48_000,
      sourceEndSec: 6 / 48_000,
    })
    collector.append(page(0, [0, 1, 2, 3], [10, 11, 12, 13]))
    collector.append(page(4, [4, 5, 6], [14, 15, 16]))
    const result = collector.finish()
    expect(Array.from(result.channels[0] ?? [])).toEqual([2, 3, 4, 5])
    expect(Array.from(result.channels[1] ?? [])).toEqual([12, 13, 14, 15])
  })

  test('rejects overlapping pages and malformed metadata', () => {
    const collector = createPcmSampleWindowCollector({
      startFrame: 0,
      endFrame: 6,
      sampleRate: 48_000,
      channelCount: 1,
      sourceStartSec: 0,
      sourceEndSec: 6 / 48_000,
    })
    collector.append(page(0, [0, 1, 2]))
    expect(() => collector.append(page(2, [3, 4]))).toThrow('PCM waveform pages overlap or are out of order.')
    expect(() => collector.append({ ...page(6, [1]), channelCount: 2 })).toThrow('PCM waveform page metadata is inconsistent.')
  })
})
