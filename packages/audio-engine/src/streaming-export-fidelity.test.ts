import { describe, expect, test } from 'bun:test'

import {
  findAutomaticTailEndFrame,
  type ExportTailPolicy,
} from './export-fidelity'
import { analyzeLoudness } from './loudness-analyzer'
import {
  analyzeExportAudioChunks,
  createStreamingExportAnalysisReport,
  findAutomaticTailEndFrameInChunks,
} from './streaming-export-fidelity'

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

const sliceBuffer = (buffer: TestBuffer, startFrame: number, endFrame: number): TestBuffer => createBuffer(
  Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel).subarray(startFrame, endFrame),
  ),
  buffer.sampleRate,
)

const createProgram = () => {
  const sampleRate = 8_000
  const length = sampleRate * 5
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let frame = 0; frame < sampleRate * 3; frame += 1) {
    const time = frame / sampleRate
    left[frame] = 0.2 * Math.sin(2 * Math.PI * 330 * time)
    right[frame] = 0.15 * Math.sin(2 * Math.PI * 550 * time)
  }
  for (let frame = sampleRate * 3; frame < sampleRate * 3.3; frame += 1) {
    left[frame] = 0.01
    right[frame] = -0.008
  }
  return createBuffer([left, right], sampleRate)
}

const splitChunks = (buffer: TestBuffer) => {
  const boundaries = [0, 113, 2_919, 8_003, 17_777, 24_101, buffer.length]
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]
    if (end === undefined) throw new Error('Missing split boundary')
    return sliceBuffer(buffer, start, end)
  })
}

const samplePeak = (buffer: TestBuffer) => {
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  }
  return peak
}

describe('streaming export analysis', () => {
  test('matches whole-buffer loudness, true peak, and sample peak', async () => {
    const program = createProgram()
    const expectedLoudness = analyzeLoudness(program)
    const actual = await analyzeExportAudioChunks(splitChunks(program), {
      sampleRate: program.sampleRate,
      channelCount: program.numberOfChannels,
    })

    expect(actual.samplePeak).toBeCloseTo(samplePeak(program), 12)
    expect(actual.loudness.integratedLufs).toBeCloseTo(expectedLoudness.integratedLufs ?? 0, 10)
    expect(actual.loudness.loudnessRangeLu).toBeCloseTo(expectedLoudness.loudnessRangeLu ?? 0, 10)
    expect(actual.loudness.momentaryMaxLufs).toBeCloseTo(expectedLoudness.momentaryMaxLufs ?? 0, 10)
    expect(actual.loudness.shortTermMaxLufs).toBeCloseTo(expectedLoudness.shortTermMaxLufs ?? 0, 10)
    expect(actual.loudness.truePeak).toBeCloseTo(expectedLoudness.truePeak, 12)
    expect(actual.loudness.truePeakDbtp).toBeCloseTo(expectedLoudness.truePeakDbtp ?? 0, 10)

    const report = createStreamingExportAnalysisReport({
      analysis: actual,
      gainDb: -1.5,
      limited: false,
      ceilingConstrained: false,
    })
    expect(report.gainDb).toBe(-1.5)
    expect(report.samplePeakDbfs).not.toBeNull()
    expect(report.integratedLufs).toBe(actual.loudness.integratedLufs)
  })

  test('matches whole-buffer automatic tail detection across chunk boundaries', async () => {
    const program = createProgram()
    const policy: Extract<ExportTailPolicy, { mode: 'automatic' }> = {
      mode: 'automatic',
      thresholdDbfs: -40,
      holdSec: 0.2,
      maximumSec: 2,
    }
    const sourceEndFrame = program.sampleRate * 3
    const expected = findAutomaticTailEndFrame(program, sourceEndFrame, policy)
    const actual = await findAutomaticTailEndFrameInChunks(splitChunks(program), {
      sampleRate: program.sampleRate,
      channelCount: program.numberOfChannels,
      sourceEndFrame,
      policy,
    })
    expect(actual).toBe(expected)
  })

  test('supports async chunk sources and cancellation', async () => {
    const program = createProgram()
    async function* chunks() {
      for (const value of splitChunks(program)) yield value
    }
    const analysis = await analyzeExportAudioChunks(chunks(), {
      sampleRate: program.sampleRate,
      channelCount: program.numberOfChannels,
    })
    expect(analysis.loudness.integratedLufs).not.toBeNull()

    const controller = new AbortController()
    controller.abort()
    await expect(analyzeExportAudioChunks(chunks(), {
      sampleRate: program.sampleRate,
      channelCount: program.numberOfChannels,
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
