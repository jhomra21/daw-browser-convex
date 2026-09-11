import { describe, expect, test } from 'bun:test'

import { analyzeLoudness } from './loudness-analyzer'
import { createStreamingLoudnessAnalyzer } from './streaming-loudness-analyzer'
import { createStreamingTruePeakScanner } from './streaming-true-peak-scanner'
import { scanTruePeak } from './true-peak-scanner'

type TestBuffer = {
  numberOfChannels: number
  length: number
  sampleRate: number
  getChannelData: (channel: number) => Float32Array
}

const createBuffer = (channels: Float32Array[], sampleRate: number): TestBuffer => ({
  numberOfChannels: channels.length,
  length: channels[0]?.length ?? 0,
  sampleRate,
  getChannelData(channel) {
    const data = channels[channel]
    if (!data) throw new Error('Missing channel')
    return data
  },
})

const sliceBuffer = (buffer: TestBuffer, startFrame: number, endFrame: number): TestBuffer => {
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel).subarray(startFrame, endFrame),
  )
  return createBuffer(channels, buffer.sampleRate)
}

const createProgram = () => {
  const sampleRate = 8_000
  const length = Math.round(sampleRate * 4.25)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let frame = 0; frame < length; frame += 1) {
    const time = frame / sampleRate
    left[frame] = 0.22 * Math.sin(2 * Math.PI * 440 * time)
      + 0.04 * Math.sin(2 * Math.PI * 997 * time)
    right[frame] = 0.13 * Math.sin(2 * Math.PI * 221 * time)
      - 0.03 * Math.sin(2 * Math.PI * 743 * time)
  }
  left[3_199] = 0.92
  left[3_200] = -0.87
  right[23_999] = -0.81
  right[24_000] = 0.79
  return createBuffer([left, right], sampleRate)
}

const expectNullableClose = (actual: number | null, expected: number | null) => {
  if (expected === null) expect(actual).toBeNull()
  else expect(actual).toBeCloseTo(expected, 10)
}

describe('streaming true peak scanner', () => {
  test('matches whole-buffer scanning across FIR future-window chunk boundaries', () => {
    const program = createProgram()
    const expected = scanTruePeak(program)
    const scanner = createStreamingTruePeakScanner(program.numberOfChannels)
    const boundaries = [0, 3_191, 3_203, 7_777, 24_005, program.length]
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index]
      const end = boundaries[index + 1]
      if (start === undefined || end === undefined) throw new Error('Missing test boundary')
      scanner.append(sliceBuffer(program, start, end))
    }
    const actual = scanner.finish()
    expect(actual.peak).toBeCloseTo(expected.peak, 12)
    expect(actual.peakDbtp).toBeCloseTo(expected.peakDbtp, 12)
  })
})

describe('streaming BS.1770 analyzer', () => {
  test('matches whole-buffer analysis across arbitrary chunk boundaries', () => {
    const program = createProgram()
    const expected = analyzeLoudness(program)
    const analyzer = createStreamingLoudnessAnalyzer({
      sampleRate: program.sampleRate,
      channelCount: program.numberOfChannels,
    })
    const boundaries = [0, 1, 317, 3_201, 7_999, 8_001, 23_997, 24_003, program.length]
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index]
      const end = boundaries[index + 1]
      if (start === undefined || end === undefined) throw new Error('Missing test boundary')
      analyzer.append(sliceBuffer(program, start, end))
    }
    const actual = analyzer.finish()

    expect(actual.reference).toBe(expected.reference)
    expectNullableClose(actual.integratedLufs, expected.integratedLufs)
    expectNullableClose(actual.loudnessRangeLu, expected.loudnessRangeLu)
    expectNullableClose(actual.momentaryMaxLufs, expected.momentaryMaxLufs)
    expectNullableClose(actual.shortTermMaxLufs, expected.shortTermMaxLufs)
    expectNullableClose(actual.truePeakDbtp, expected.truePeakDbtp)
    expect(actual.truePeak).toBeCloseTo(expected.truePeak, 12)
    expect(actual.momentaryLufs).toHaveLength(expected.momentaryLufs.length)
    expect(actual.shortTermLufs).toHaveLength(expected.shortTermLufs.length)
    for (let index = 0; index < expected.momentaryLufs.length; index += 1) {
      expect(actual.momentaryLufs[index]).toBeCloseTo(expected.momentaryLufs[index] ?? 0, 10)
    }
    for (let index = 0; index < expected.shortTermLufs.length; index += 1) {
      expect(actual.shortTermLufs[index]).toBeCloseTo(expected.shortTermLufs[index] ?? 0, 10)
    }
  })

  test('fails on chunk metadata changes and rejects append after finish', () => {
    const analyzer = createStreamingLoudnessAnalyzer({ sampleRate: 8_000, channelCount: 1 })
    const first = createBuffer([new Float32Array([0.1, 0.2])], 8_000)
    analyzer.append(first)
    expect(() => analyzer.append(createBuffer([new Float32Array([0.3])], 48_000)))
      .toThrow('metadata is invalid')
    analyzer.finish()
    expect(() => analyzer.append(first)).toThrow('already finalized')
  })

  test('finishes silence without duration-sized state', () => {
    const analyzer = createStreamingLoudnessAnalyzer({ sampleRate: 8_000, channelCount: 2 })
    for (let block = 0; block < 32; block += 1) {
      analyzer.append(createBuffer([
        new Float32Array(257),
        new Float32Array(257),
      ], 8_000))
    }
    const result = analyzer.finish()
    expect(result.integratedLufs).toBeNull()
    expect(result.truePeak).toBe(0)
    expect(result.truePeakDbtp).toBeNull()
  })
})
