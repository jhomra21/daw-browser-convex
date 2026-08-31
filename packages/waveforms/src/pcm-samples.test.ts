import { describe, expect, test } from 'bun:test'

import { createPcmSampleWindowCollector } from './pcm-samples'

const page = (startFrame: number, planes: number[][]) => ({
  startFrame,
  frameCount: planes[0]?.length ?? 0,
  planes: planes.map((values) => new Float32Array(values)),
})

describe('createPcmSampleWindowCollector', () => {
  test('clips adjacent pages into the requested stereo frame window', () => {
    const collector = createPcmSampleWindowCollector({
      startFrame: 2,
      endFrame: 6,
      sampleRate: 48_000,
      channelCount: 2,
      sourceStartSec: 2 / 48_000,
      sourceEndSec: 6 / 48_000,
    })

    collector.append(page(0, [
      [0, 1, 2, 3],
      [10, 11, 12, 13],
    ]))
    collector.append(page(4, [
      [4, 5, 6],
      [14, 15, 16],
    ]))

    const result = collector.finish()
    expect(result.firstFrame).toBe(2)
    expect(Array.from(result.channels[0] ?? [])).toEqual([2, 3, 4, 5])
    expect(Array.from(result.channels[1] ?? [])).toEqual([12, 13, 14, 15])
  })

  test('leaves uncovered frames silent without allocating outside the visible window', () => {
    const collector = createPcmSampleWindowCollector({
      startFrame: 10,
      endFrame: 14,
      sampleRate: 48_000,
      channelCount: 1,
      sourceStartSec: 10 / 48_000,
      sourceEndSec: 14 / 48_000,
    })

    collector.append(page(11, [[0.25, -0.5]]))
    const result = collector.finish()
    expect(result.channels[0]?.length).toBe(4)
    expect(Array.from(result.channels[0] ?? [])).toEqual([0, 0.25, -0.5, 0])
  })

  test('rejects malformed page metadata', () => {
    const collector = createPcmSampleWindowCollector({
      startFrame: 0,
      endFrame: 2,
      sampleRate: 48_000,
      channelCount: 2,
      sourceStartSec: 0,
      sourceEndSec: 2 / 48_000,
    })

    expect(() => collector.append({
      startFrame: 0,
      frameCount: 2,
      planes: [new Float32Array(2)],
    })).toThrow('PCM waveform page metadata is inconsistent.')
  })

  test('rejects overlapping or out-of-order pages instead of overwriting samples', () => {
    const collector = createPcmSampleWindowCollector({
      startFrame: 0,
      endFrame: 6,
      sampleRate: 48_000,
      channelCount: 1,
      sourceStartSec: 0,
      sourceEndSec: 6 / 48_000,
    })

    collector.append(page(0, [[0, 1, 2]]))
    expect(() => collector.append(page(2, [[3, 4]]))).toThrow('PCM waveform pages overlap or are out of order.')
    expect(() => collector.append(page(-1, [[3]]))).toThrow('PCM waveform page metadata is inconsistent.')
  })

  test('rejects unsafe sample-rate metadata before allocating a window', () => {
    expect(() => createPcmSampleWindowCollector({
      startFrame: 0,
      endFrame: 2,
      sampleRate: Number.MAX_SAFE_INTEGER + 1,
      channelCount: 1,
      sourceStartSec: 0,
      sourceEndSec: 1,
    })).toThrow('PCM waveform sample window bounds are invalid.')
  })
})
