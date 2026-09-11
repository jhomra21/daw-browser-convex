import { afterEach, describe, expect, test } from 'bun:test'

import type { ExportRenderSettings } from '~/lib/export/export-settings'
import { processNativeOfflinePcmSpool } from '~/lib/export/process-native-offline-pcm-spool'
import { processRenderedExport } from '~/lib/export/process-rendered-export'
import type {
  NativeOfflinePcmSpoolDescriptor,
  NativeOfflinePcmSpoolReplayOptions,
  NativeOfflinePcmSpoolSession,
} from '~/lib/export/native-offline-pcm-spool'

const originalAudioBuffer = globalThis.AudioBuffer

afterEach(() => {
  Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: originalAudioBuffer })
})

class TestAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  private readonly channels: Float32Array<ArrayBuffer>[]

  constructor(options: AudioBufferOptions) {
    this.length = options.length
    this.numberOfChannels = options.numberOfChannels ?? 1
    this.sampleRate = options.sampleRate
    this.duration = this.length / this.sampleRate
    this.channels = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length))
  }

  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    const data = this.channels[channel]
    if (!data) throw new Error('Missing channel')
    return data
  }

  copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset = 0) {
    destination.set(this.getChannelData(channelNumber).subarray(bufferOffset, bufferOffset + destination.length))
  }

  copyToChannel(source: Float32Array, channelNumber: number, bufferOffset = 0) {
    this.getChannelData(channelNumber).set(source, bufferOffset)
  }
}

const SAMPLE_RATE = 44_100
const SOURCE_DURATION_SEC = 0.35
const TOTAL_DURATION_SEC = 0.7

const createProgram = () => {
  const length = Math.round(SAMPLE_RATE * TOTAL_DURATION_SEC)
  const buffer = new TestAudioBuffer({ numberOfChannels: 2, length, sampleRate: SAMPLE_RATE })
  const sourceFrames = Math.ceil(SOURCE_DURATION_SEC * SAMPLE_RATE)
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  for (let frame = 0; frame < sourceFrames; frame += 1) {
    const time = frame / SAMPLE_RATE
    left[frame] = 0.34 * Math.sin(2 * Math.PI * 440 * time)
    right[frame] = 0.21 * Math.sin(2 * Math.PI * 330 * time)
  }
  for (let frame = sourceFrames; frame < sourceFrames + Math.round(0.08 * SAMPLE_RATE); frame += 1) {
    left[frame] = 0.004
    right[frame] = -0.003
  }
  return buffer
}

const cloneBuffer = (source: TestAudioBuffer) => {
  const clone = new TestAudioBuffer({
    numberOfChannels: source.numberOfChannels,
    length: source.length,
    sampleRate: source.sampleRate,
  })
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    clone.getChannelData(channel).set(source.getChannelData(channel))
  }
  return clone
}

const getSamplePeak = (buffer: TestAudioBuffer) => {
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    for (const sample of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample))
  }
  return peak
}

const createFakeSpool = (source: TestAudioBuffer): NativeOfflinePcmSpoolSession => {
  const descriptor: NativeOfflinePcmSpoolDescriptor = {
    sessionId: 'render-test',
    sampleRate: source.sampleRate,
    channelCount: source.numberOfChannels,
    totalFrames: source.length,
    byteLength: source.length * source.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
    samplePeak: getSamplePeak(source),
  }
  return {
    append: async () => { throw new Error('Fake finalized spool is not writable') },
    finalize: async () => descriptor,
    replay: async function* (options: NativeOfflinePcmSpoolReplayOptions = {}) {
      const endFrame = options.endFrame ?? source.length
      const gain = options.gain ?? 1
      const chunkFrames = 997
      for (let startFrame = 0; startFrame < endFrame; startFrame += chunkFrames) {
        options.signal?.throwIfAborted()
        const frameCount = Math.min(chunkFrames, endFrame - startFrame)
        const chunk = new TestAudioBuffer({
          numberOfChannels: source.numberOfChannels,
          length: frameCount,
          sampleRate: source.sampleRate,
        })
        for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
          const input = source.getChannelData(channel)
          const output = chunk.getChannelData(channel)
          for (let frame = 0; frame < frameCount; frame += 1) {
            output[frame] = (input[startFrame + frame] ?? 0) * gain
          }
        }
        yield chunk
      }
    },
    remove: async () => {},
    abort: async () => {},
  }
}

const collectReplay = async (source: AsyncIterable<AudioBuffer>) => {
  const blocks: AudioBuffer[] = []
  for await (const block of source) blocks.push(block)
  const totalFrames = blocks.reduce((sum, block) => sum + block.length, 0)
  const output = new TestAudioBuffer({ numberOfChannels: 2, length: totalFrames, sampleRate: SAMPLE_RATE })
  let offset = 0
  for (const block of blocks) {
    for (let channel = 0; channel < 2; channel += 1) {
      output.getChannelData(channel).set(block.getChannelData(channel), offset)
    }
    offset += block.length
  }
  return output
}

const expectReportClose = (
  actual: Awaited<ReturnType<typeof processNativeOfflinePcmSpool>>['analysis'],
  expected: ReturnType<typeof processRenderedExport>['analysis'],
) => {
  expect(actual.integratedLufs).toBeCloseTo(expected.integratedLufs ?? 0, 8)
  expect(actual.momentaryMaxLufs).toBeCloseTo(expected.momentaryMaxLufs ?? 0, 8)
  expect(actual.truePeakDbtp).toBeCloseTo(expected.truePeakDbtp ?? 0, 8)
  expect(actual.samplePeakDbfs).toBeCloseTo(expected.samplePeakDbfs ?? 0, 8)
  expect(actual.gainDb).toBeCloseTo(expected.gainDb, 8)
  expect(actual.limited).toBe(expected.limited)
  expect(actual.ceilingConstrained).toBe(expected.ceilingConstrained)
}

const renderSettings = (
  patch: Partial<ExportRenderSettings> = {},
): ExportRenderSettings => ({
  sampleRate: SAMPLE_RATE,
  numberOfChannels: 2,
  normalization: { mode: 'none' },
  tail: { mode: 'none' },
  ...patch,
})

describe('native offline PCM spool processing', () => {
  test('matches whole-buffer automatic tail and analysis without normalization', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const program = createProgram()
    const render = renderSettings({
      tail: { mode: 'automatic', thresholdDbfs: -40, holdSec: 0.05, maximumSec: 0.35 },
    })
    const expected = processRenderedExport({
      rendered: cloneBuffer(program),
      sourceDurationSec: SOURCE_DURATION_SEC,
      render,
      signal: new AbortController().signal,
    })
    const actual = await processNativeOfflinePcmSpool({
      spool: createFakeSpool(program),
      sourceDurationSec: SOURCE_DURATION_SEC,
      render,
      signal: new AbortController().signal,
    })

    expect(actual.endFrame).toBe(expected.buffer.length)
    expectReportClose(actual.analysis, expected.analysis)
    const replay = await collectReplay(actual.replay())
    expect(replay.length).toBe(expected.buffer.length)
    expect(Array.from(replay.getChannelData(0))).toEqual(Array.from(expected.buffer.getChannelData(0)))
  })

  test('matches whole-buffer sample-peak normalization', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const program = createProgram()
    const render = renderSettings({
      normalization: { mode: 'sample-peak', targetDbfs: -6 },
    })
    const expected = processRenderedExport({
      rendered: cloneBuffer(program),
      sourceDurationSec: SOURCE_DURATION_SEC,
      render,
      signal: new AbortController().signal,
    })
    const actual = await processNativeOfflinePcmSpool({
      spool: createFakeSpool(program),
      sourceDurationSec: SOURCE_DURATION_SEC,
      render,
      signal: new AbortController().signal,
    })

    expectReportClose(actual.analysis, expected.analysis)
    const replay = await collectReplay(actual.replay())
    expect(replay.getChannelData(0)[1]).toBeCloseTo(expected.buffer.getChannelData(0)[1] ?? 0, 7)
  })

  test('matches whole-buffer loudness normalization when limiting is off', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const program = createProgram()
    const render = renderSettings({
      normalization: {
        mode: 'loudness',
        targetLufs: -18,
        truePeakCeilingDbtp: -1,
        limiting: 'off',
      },
    })
    const expected = processRenderedExport({
      rendered: cloneBuffer(program),
      sourceDurationSec: SOURCE_DURATION_SEC,
      render,
      signal: new AbortController().signal,
    })
    const actual = await processNativeOfflinePcmSpool({
      spool: createFakeSpool(program),
      sourceDurationSec: SOURCE_DURATION_SEC,
      render,
      signal: new AbortController().signal,
    })

    expectReportClose(actual.analysis, expected.analysis)
    expect(actual.analysis.integratedLufs).toBeCloseTo(-18, 1)
  })

  test('matches whole-buffer loudness normalization with linked true-peak limiting', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const program = createProgram()
    program.getChannelData(0)[7_500] = 1
    const render = renderSettings({
      normalization: {
        mode: 'loudness',
        targetLufs: -5,
        truePeakCeilingDbtp: -6,
        limiting: 'true-peak',
      },
    })
    const expected = processRenderedExport({
      rendered: cloneBuffer(program),
      sourceDurationSec: SOURCE_DURATION_SEC,
      render,
      signal: new AbortController().signal,
    })
    const actual = await processNativeOfflinePcmSpool({
      spool: createFakeSpool(program),
      sourceDurationSec: SOURCE_DURATION_SEC,
      render,
      signal: new AbortController().signal,
    })

    expectReportClose(actual.analysis, expected.analysis)
    expect(actual.analysis.limited).toBe(true)
    const replay = await collectReplay(actual.replay())
    expect(replay.getChannelData(0)[7_500]).toBeCloseTo(expected.buffer.getChannelData(0)[7_500] ?? 0, 7)
    expect(replay.getChannelData(1)[7_500]).toBeCloseTo(expected.buffer.getChannelData(1)[7_500] ?? 0, 7)
  })
})
