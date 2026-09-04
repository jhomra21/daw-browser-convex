import { describe, expect, test } from 'bun:test'
import {
  createWsolaMaterializingCompatibilityTransaction,
  createWsolaBoundedSource,
  createWsolaBoundedSourceAsync,
  createWsolaSinglePassStream,
  getWsolaStageFrameCounts,
  stretchAudioWsola,
  stretchAudioWsolaWithStats,
  type WsolaPcmTransactionFactory,
  type WsolaStretchConfig,
  WSOLA_MAX_CHANNEL_COUNT,
  WSOLA_MAX_OVERLAP_FRAMES,
  WSOLA_MAX_PIPELINE_WORKING_MEMORY_BYTES,
  WSOLA_MAX_SEARCH_FRAMES,
  WSOLA_MAX_SOURCE_CHUNK_FRAMES,
  WSOLA_MAX_WINDOW_FRAMES,
} from './audio-stretching'

const sampleRate = 44_100

const createSine = (frequency: number, frameCount: number) => {
  const channel = new Float32Array(frameCount)
  for (let index = 0; index < frameCount; index++) {
    channel[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.5
  }
  return channel
}

const createLoopFixture = (frameCount: number) => {
  const channel = new Float32Array(frameCount)
  for (let index = 0; index < frameCount; index++) {
    const phase = (index % 2048) / 2048
    const envelope = phase < 0.5 ? phase * 2 : (1 - phase) * 2
    channel[index] = (Math.sin(2 * Math.PI * phase) * 0.4 + Math.sin(4 * Math.PI * phase) * 0.2) * envelope
  }
  return channel
}

const estimateFrequency = (channel: Float32Array) => {
  const crossings: number[] = []
  for (let index = 1; index < channel.length; index++) {
    if (channel[index - 1] < 0 && channel[index] >= 0) crossings.push(index)
  }
  if (crossings.length < 2) return 0
  let totalPeriod = 0
  for (let index = 1; index < crossings.length; index++) totalPeriod += crossings[index] - crossings[index - 1]
  return sampleRate / (totalPeriod / (crossings.length - 1))
}

const getPeak = (channel: Float32Array) => {
  let peak = 0
  for (let index = 0; index < channel.length; index++) peak = Math.max(peak, Math.abs(channel[index]))
  return peak
}

const getMaxAbsDifference = (left: Float32Array, right: Float32Array, scale = 1) => {
  let maxDifference = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    maxDifference = Math.max(maxDifference, Math.abs(left[index] - right[index] * scale))
  }
  return maxDifference
}

const getMaxAdjacentDelta = (channel: Float32Array) => {
  let maxDelta = 0
  for (let index = 1; index < channel.length; index++) maxDelta = Math.max(maxDelta, Math.abs(channel[index] - channel[index - 1]))
  return maxDelta
}

const normalizeReferencePeak = (channels: Float32Array[], inputPeak: number) => {
  let outputPeak = 0
  for (const channel of channels) {
    for (let frame = 0; frame < channel.length; frame++) outputPeak = Math.max(outputPeak, Math.abs(channel[frame] ?? 0))
  }
  const maxPeak = inputPeak + 0.0001
  if (outputPeak <= maxPeak || outputPeak <= 0) return channels
  const gain = maxPeak / outputPeak
  return channels.map((channel) => {
    const normalized = new Float32Array(channel.length)
    for (let frame = 0; frame < channel.length; frame++) normalized[frame] = (channel[frame] ?? 0) * gain
    return normalized
  })
}

// This is a test-only copy of the Phase 7A whole-array algorithm. It is kept
// separate from production code so parity tests detect accidental drift.
const renderPhase7AReference = (
  inputChannels: Float32Array[],
  outputFrameCount: number,
  windowFrameCount: number,
  overlapFrameCount: number,
  searchFrameCount: number,
) => {
  const inputFrameCount = inputChannels[0]?.length ?? 0
  const mono = new Float32Array(inputFrameCount)
  const gain = 1 / inputChannels.length
  for (const channel of inputChannels) {
    for (let frame = 0; frame < inputFrameCount; frame++) mono[frame] += (channel[frame] ?? 0) * gain
  }
  const outputChannels = inputChannels.map(() => new Float32Array(outputFrameCount))
  const outputMono = new Float32Array(outputFrameCount)
  const write = (
    input: Float32Array,
    output: Float32Array,
    inputStart: number,
    outputStart: number,
    frameCount: number,
  ) => {
    for (let frame = 0; frame < frameCount; frame++) {
      const outputIndex = outputStart + frame
      if (outputIndex >= output.length) return
      output[outputIndex] = input[inputStart + frame] ?? 0
    }
  }
  const overlapAdd = (
    input: Float32Array,
    output: Float32Array,
    inputStart: number,
    outputStart: number,
    frameCount: number,
  ) => {
    for (let frame = 0; frame < frameCount; frame++) {
      const outputIndex = outputStart + frame
      if (outputIndex >= output.length) return
      const inputSample = input[inputStart + frame] ?? 0
      if (frame < overlapFrameCount) {
        const fadeIn = frame / overlapFrameCount
        output[outputIndex] = output[outputIndex] * (1 - fadeIn) + inputSample * fadeIn
      } else {
        output[outputIndex] = inputSample
      }
    }
  }
  const score = (inputStart: number, outputStart: number) => {
    let correlation = 0
    let inputEnergy = 0
    let outputEnergy = 0
    for (let frame = 0; frame < overlapFrameCount; frame++) {
      const inputSample = mono[inputStart + frame] ?? 0
      const outputSample = outputMono[outputStart + frame] ?? 0
      correlation += inputSample * outputSample
      inputEnergy += inputSample * inputSample
      outputEnergy += outputSample * outputSample
    }
    if (inputEnergy <= 0 || outputEnergy <= 0) return 0
    return correlation / Math.sqrt(inputEnergy * outputEnergy)
  }
  const findBestStart = (expectedStart: number, outputStart: number) => {
    const minStart = Math.max(0, expectedStart - searchFrameCount)
    const maxStart = Math.min(inputFrameCount - overlapFrameCount, expectedStart + searchFrameCount)
    let bestStart = Math.max(0, Math.min(expectedStart, maxStart))
    let bestScore = -Infinity
    for (let inputStart = minStart; inputStart <= maxStart; inputStart++) {
      const currentScore = score(inputStart, outputStart)
      if (currentScore > bestScore) {
        bestScore = currentScore
        bestStart = inputStart
      }
    }
    return bestStart
  }
  for (let channel = 0; channel < inputChannels.length; channel++) {
    write(inputChannels[channel] ?? new Float32Array(), outputChannels[channel] ?? new Float32Array(), 0, 0, Math.min(windowFrameCount, outputFrameCount))
  }
  write(mono, outputMono, 0, 0, Math.min(windowFrameCount, outputFrameCount))
  for (let outputStart = windowFrameCount - overlapFrameCount; outputStart < outputFrameCount; outputStart += windowFrameCount - overlapFrameCount) {
    const bestStart = findBestStart(Math.round(outputStart / (outputFrameCount / inputFrameCount)), outputStart)
    const frameCount = Math.min(windowFrameCount, outputFrameCount - outputStart)
    for (let channel = 0; channel < inputChannels.length; channel++) {
      overlapAdd(inputChannels[channel] ?? new Float32Array(), outputChannels[channel] ?? new Float32Array(), bestStart, outputStart, frameCount)
    }
    overlapAdd(mono, outputMono, bestStart, outputStart, frameCount)
  }
  let inputPeak = 0
  for (const channel of inputChannels) {
    for (let frame = 0; frame < channel.length; frame++) inputPeak = Math.max(inputPeak, Math.abs(channel[frame] ?? 0))
  }
  return normalizeReferencePeak(outputChannels, inputPeak)
}

const renderPhase7ARecursiveReference = (
  inputChannels: Float32Array[],
  outputFrameCount: number,
  windowFrameCount: number,
  overlapFrameCount: number,
  searchFrameCount: number,
) => {
  const inputFrameCount = inputChannels[0]?.length ?? 0
  const stages = getWsolaStageFrameCounts(inputFrameCount, outputFrameCount)
  let channels = inputChannels
  for (let index = 1; index < stages.length; index += 1) {
    const stageOutputFrameCount = stages[index]
    if (stageOutputFrameCount === undefined) throw new Error('Reference stage is missing.')
    const stageInputFrameCount = stages[index - 1]
    if (stageInputFrameCount === undefined) throw new Error('Reference stage input is missing.')
    if (
      stageOutputFrameCount === stageInputFrameCount
      || Math.abs(stageOutputFrameCount / stageInputFrameCount - 1) <= 1 / Math.max(1, stageInputFrameCount)
    ) {
      channels = channels.map((channel) => {
        const output = new Float32Array(stageOutputFrameCount)
        output.set(channel.subarray(0, Math.min(channel.length, stageOutputFrameCount)))
        return output
      })
      continue
    }
    channels = renderPhase7AReference(
      channels,
      stageOutputFrameCount,
      windowFrameCount,
      overlapFrameCount,
      searchFrameCount,
    )
  }
  return channels
}

const renderPhase7AZeroChannelReference = (sampleRate: number) => ({
  sampleRate,
  channels: [],
})

const renderStreamingFixture = (inputChannels: Float32Array[], outputFrameCount: number, chunkFrameCount: number) => {
  const config = {
    outputFrameCount,
    windowFrameCount: 128,
    overlapFrameCount: 64,
    searchFrameCount: 32,
  }
  const stream = createWsolaSinglePassStream({
    ...config,
    inputFrameCount: inputChannels[0]?.length ?? 0,
    channelCount: inputChannels.length,
    sampleRate,
  })
  const outputChannels = inputChannels.map(() => new Float32Array(outputFrameCount))
  let outputOffset = 0
  const write = (channels: Float32Array[]) => {
    const frameCount = channels[0]?.length ?? 0
    for (let channel = 0; channel < outputChannels.length; channel++) {
      outputChannels[channel]?.set(channels[channel] ?? new Float32Array(), outputOffset)
    }
    outputOffset += frameCount
  }
  const inputFrameCount = inputChannels[0]?.length ?? 0
  for (let startFrame = 0; startFrame < inputFrameCount; startFrame += chunkFrameCount) {
    const endFrame = Math.min(inputFrameCount, startFrame + chunkFrameCount)
    stream.push(inputChannels.map((channel) => channel.subarray(startFrame, endFrame)), write)
  }
  const stats = stream.finish(write)
  expect(outputOffset).toBe(outputFrameCount)
  return { channels: outputChannels, stats, config }
}

const createSourceFixture = (
  channels: Float32Array[],
  replay: (signal?: AbortSignal) => Iterable<{ channels: Float32Array[] }> = function* () {
    yield { channels }
  },
  dispose = () => {},
) => ({
  sampleRate,
  channelCount: channels.length,
  frameCount: channels[0]?.length ?? 0,
  replay,
  dispose,
})

const createBoundedForTest = (
  source: Parameters<typeof createWsolaBoundedSource>[0],
  config: WsolaStretchConfig,
) => createWsolaBoundedSource(source, {
  ...config,
  createTransaction: config.createTransaction ?? createWsolaMaterializingCompatibilityTransaction,
})

const createDiscardingTransactionForTest = (
  observed?: { appendFrames: number; maxAppendFrames: number },
): WsolaPcmTransactionFactory => (metadata) => {
  let writtenFrames = 0
  let committed = false
  let disposed = false
  return {
    append: (chunk) => {
      if (committed) throw new Error('Test transaction is no longer writable.')
      const frameCount = chunk.channels[0]?.length ?? 0
      if (chunk.channels.length !== metadata.channelCount
        || chunk.channels.some((channel) => channel.length !== frameCount)
        || frameCount <= 0
        || writtenFrames + frameCount > metadata.frameCount) {
        throw new Error('Test transaction received an invalid chunk.')
      }
      writtenFrames += frameCount
      if (observed) {
        observed.appendFrames += frameCount
        observed.maxAppendFrames = Math.max(observed.maxAppendFrames, frameCount)
      }
    },
    commit: () => {
      if (committed || writtenFrames !== metadata.frameCount) throw new Error('Test transaction cannot commit.')
      committed = true
      return {
        ...metadata,
        replay: function* (signal?: AbortSignal) {
          if (disposed) throw new Error('Test source has been disposed.')
          for (let startFrame = 0; startFrame < metadata.frameCount; startFrame += 16_384) {
            signal?.throwIfAborted()
            const frameCount = Math.min(16_384, metadata.frameCount - startFrame)
            yield {
              channels: Array.from({ length: metadata.channelCount }, () => new Float32Array(frameCount)),
            }
          }
        },
        dispose: () => { disposed = true },
      }
    },
    abort: () => { committed = true },
  }
}

describe('stretchAudioWsola', () => {
  test('keeps async multi-pass output identical to synchronous bounded output', async () => {
    const input = createLoopFixture(sampleRate * 2)
    const outputFrameCount = Math.round(input.length * 0.1)
    const sync = createBoundedForTest(createSourceFixture([input], function* (signal) {
      for (let start = 0; start < input.length; start += 997) {
        signal?.throwIfAborted()
        const end = Math.min(input.length, start + 997)
        yield { channels: [input.subarray(start, end)] }
      }
    }), { outputFrameCount })
    const asyncResult = await createWsolaBoundedSourceAsync({
      ...createSourceFixture([input]),
      replayAsync: async function* (signal) {
        for (let start = 0; start < input.length; start += 997) {
          signal?.throwIfAborted()
          const end = Math.min(input.length, start + 997)
          yield { channels: [input.subarray(start, end)] }
        }
      },
    }, {
      outputFrameCount,
      createTransaction: createWsolaMaterializingCompatibilityTransaction,
    })
    const syncChunks = [...sync.source.replay()]
    const asyncChunks = [...asyncResult.source.replay()]
    const syncChannel = syncChunks.reduce((result, chunk) => {
      const next = new Float32Array(result.length + chunk.channels[0].length)
      next.set(result)
      next.set(chunk.channels[0], result.length)
      return next
    }, new Float32Array())
    const asyncChannel = asyncChunks.reduce((result, chunk) => {
      const next = new Float32Array(result.length + chunk.channels[0].length)
      next.set(result)
      next.set(chunk.channels[0], result.length)
      return next
    }, new Float32Array())
    expect(asyncChannel).toEqual(syncChannel)
    sync.source.dispose()
    asyncResult.source.dispose()
  })

  test('preserves legacy zero-channel output at the wrapper boundary', () => {
    const expected = renderPhase7AZeroChannelReference(sampleRate)
    // A zero-channel input has no frame count, so a stretch ratio is not applicable.
    for (const outputFrameCount of [0, 1, 4096]) {
      expect(stretchAudioWsola({ channels: [], sampleRate }, { outputFrameCount })).toEqual(expected)
    }
  })

  test('produces deterministic finite output with exact requested duration', () => {
    const input = createSine(440, sampleRate)
    const config = { outputFrameCount: Math.round(input.length * 1.5) }
    const first = stretchAudioWsola({ channels: [input], sampleRate }, config)
    const second = stretchAudioWsola({ channels: [input], sampleRate }, config)

    expect(first.sampleRate).toBe(sampleRate)
    expect(first.channels.length).toBe(1)
    expect(first.channels[0].length).toBe(config.outputFrameCount)
    expect(second.channels[0].length).toBe(config.outputFrameCount)
    expect(first.channels[0].every(Number.isFinite)).toBe(true)
    expect(getMaxAbsDifference(first.channels[0], second.channels[0])).toBe(0)
  })

  test('keeps linked stereo channels sample-aligned and bounded', () => {
    const left = createLoopFixture(sampleRate * 2)
    const right = new Float32Array(left.length)
    for (let index = 0; index < left.length; index++) right[index] = left[index] * 0.5

    const output = stretchAudioWsola({
      channels: [left, right],
      sampleRate,
    }, {
      outputFrameCount: Math.round(left.length * 0.75),
    })

    expect(output.channels.length).toBe(2)
    expect(output.channels[0].length).toBe(output.channels[1].length)
    expect(getPeak(output.channels[0])).toBeLessThanOrEqual(getPeak(left) + 0.0002)
    expect(getMaxAbsDifference(output.channels[0], output.channels[1], 2)).toBeLessThan(0.00001)
  })

  test('retains approximate sine fundamental pitch while stretching', () => {
    const input = createSine(440, sampleRate * 2)
    const output = stretchAudioWsola({ channels: [input], sampleRate }, {
      outputFrameCount: input.length * 2,
    })

    const frequency = estimateFrequency(output.channels[0])
    expect(frequency).toBeGreaterThan(430)
    expect(frequency).toBeLessThan(450)
  })

  test('keeps loop-like fixture continuity within bounded adjacent deltas', () => {
    const input = createLoopFixture(sampleRate * 3)
    const output = stretchAudioWsola({ channels: [input], sampleRate }, {
      outputFrameCount: Math.round(input.length * 1.25),
    })

    expect(getMaxAdjacentDelta(output.channels[0])).toBeLessThan(Math.max(0.25, getMaxAdjacentDelta(input) * 3))
  })

  test('supports user-selectable warp ratios outside the single-pass WSOLA range', () => {
    const input = createLoopFixture(sampleRate)
    const output = stretchAudioWsola({ channels: [input], sampleRate }, {
      outputFrameCount: Math.round(input.length * 0.25),
    })

    expect(output.channels[0].length).toBe(Math.round(input.length * 0.25))
    expect(output.channels[0].every(Number.isFinite)).toBe(true)
    expect(getPeak(output.channels[0])).toBeLessThanOrEqual(getPeak(input) + 0.0003)
  })

  test('compresses tiny buffers with progress-guaranteed staging', () => {
    const input = new Float32Array([0.25, -0.5, 0.75])
    const output = stretchAudioWsola({ channels: [input], sampleRate }, {
      outputFrameCount: 1,
    })

    expect(output.channels[0].length).toBe(1)
    expect(output.channels[0].every(Number.isFinite)).toBe(true)
  })

  test('matches the legacy reference deterministically for non-finite input samples', () => {
    for (const sample of [NaN, Infinity, -Infinity]) {
      const input = Float32Array.of(0.25, sample, -0.5, 0.75)
      const expected = renderPhase7AReference([input], 8, 4, 2, 0)
      const actual = stretchAudioWsola({ channels: [input], sampleRate }, {
        outputFrameCount: 8,
        windowFrameCount: 4,
        overlapFrameCount: 2,
        searchFrameCount: 0,
      })
      expect(actual.channels[0]?.every((sample, frame) => Object.is(sample, expected[0]?.[frame]))).toBe(true)
    }
  })

  test('preserves legacy NaN normalization when compression excludes the NaN frame', () => {
    const input = Float32Array.from({ length: 16 }, (_, frame) => frame === 15 ? NaN : Math.sin(frame * 0.31))
    const expected = renderPhase7AReference([input], 8, 4, 2, 0)
    const actual = stretchAudioWsola({ channels: [input], sampleRate }, {
      outputFrameCount: 8,
      windowFrameCount: 4,
      overlapFrameCount: 2,
      searchFrameCount: 0,
    })

    expect(actual.channels[0]?.every((sample, frame) => Object.is(sample, expected[0]?.[frame]))).toBe(true)
  })

  test('preserves legacy Infinity normalization parity during compression', () => {
    for (const nonFinite of [Infinity, -Infinity]) {
      const input = Float32Array.from({ length: 16 }, (_, frame) => frame === 15 ? nonFinite : Math.sin(frame * 0.31))
      const expected = renderPhase7AReference([input], 8, 4, 2, 0)
      const actual = stretchAudioWsola({ channels: [input], sampleRate }, {
        outputFrameCount: 8,
        windowFrameCount: 4,
        overlapFrameCount: 2,
        searchFrameCount: 0,
      })
      expect(actual.channels[0]?.every((sample, frame) => Object.is(sample, expected[0]?.[frame]))).toBe(true)
    }
  })

  test('matches legacy normalization placement across generated non-finite stage cases', () => {
    let seed = 0x6d2b79f5
    const nextRandom = () => {
      seed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed)
      return ((seed ^ (seed >>> 14)) >>> 0) / 4_294_967_296
    }
    const assertExact = (actual: Float32Array[], expected: Float32Array[]) => {
      expect(actual.length).toBe(expected.length)
      for (let channel = 0; channel < expected.length; channel += 1) {
        const actualChannel = actual[channel]
        const expectedChannel = expected[channel]
        if (!actualChannel || !expectedChannel) throw new Error('Generated parity channel is missing.')
        expect(actualChannel.length).toBe(expectedChannel.length)
        for (let frame = 0; frame < expectedChannel.length; frame += 1) {
          expect(Object.is(actualChannel[frame], expectedChannel[frame])).toBe(true)
        }
      }
    }

    for (const inputFrameCount of [7, 16, 65]) {
      const outputFrameCounts = [
        inputFrameCount,
        inputFrameCount + 1,
        Math.max(1, Math.floor(inputFrameCount * 0.5)),
        Math.max(1, Math.floor(inputFrameCount * 0.25)),
        inputFrameCount * 2,
        inputFrameCount * 4,
      ]
      for (const outputFrameCount of outputFrameCounts) {
        for (const nonFinite of [NaN, Infinity, -Infinity]) {
          const channels = Array.from({ length: 2 }, (_, channelIndex) => {
            const channel = Float32Array.from({ length: inputFrameCount }, () => nextRandom() * 1.8 - 0.9)
            const frame = channelIndex === 0 ? inputFrameCount - 1 : 0
            channel[frame] = nonFinite
            return channel
          })
          const expected = renderPhase7ARecursiveReference(channels, outputFrameCount, 4, 2, 0)
          const actual = stretchAudioWsola({ channels, sampleRate }, {
            outputFrameCount,
            windowFrameCount: 4,
            overlapFrameCount: 2,
            searchFrameCount: 0,
            sourceChunkFrameCount: 3,
          })
          const actualWithStats = stretchAudioWsolaWithStats({ channels, sampleRate }, {
            outputFrameCount,
            windowFrameCount: 4,
            overlapFrameCount: 2,
            searchFrameCount: 0,
            sourceChunkFrameCount: 3,
          })
          assertExact(actual.channels, expected)
          assertExact(actualWithStats.result.channels, expected)
        }
      }
    }
  })

  test('preserves Phase 7A numerical output without a hash-only assertion', () => {
    const fixtures = [
      createSine(440, 4096),
      createLoopFixture(4096),
      Float32Array.from({ length: 4096 }, (_, frame) => Math.sin(frame * 17.31) * 0.8),
    ]
    for (const left of fixtures) {
      const right = Float32Array.from(left, (sample) => sample * 0.5)
      const outputFrameCount = Math.round(left.length * 1.5)
      const expected = renderPhase7AReference([left, right], outputFrameCount, 2048, 1024, 512)
      const actual = stretchAudioWsola({ channels: [left, right], sampleRate }, { outputFrameCount })
      expect(actual.channels.map((channel) => channel.length)).toEqual([outputFrameCount, outputFrameCount])
      expect(getMaxAbsDifference(actual.channels[0] ?? new Float32Array(), expected[0] ?? new Float32Array())).toBe(0)
      expect(getMaxAbsDifference(actual.channels[1] ?? new Float32Array(), expected[1] ?? new Float32Array())).toBe(0)
    }
  })

  test('produces identical output regardless of supplied source chunk boundaries', () => {
    const left = createLoopFixture(32_769)
    const right = new Float32Array(left.length)
    for (let frame = 0; frame < left.length; frame++) right[frame] = left[frame] * 0.5
    const inputChannels = [left, right]
    const outputFrameCount = Math.round(left.length * 1.5)
    const reference = stretchAudioWsola({ channels: inputChannels, sampleRate }, {
      outputFrameCount,
      windowFrameCount: 128,
      overlapFrameCount: 64,
      searchFrameCount: 32,
    })

    for (const chunkFrameCount of [
      1,
      17,
      511,
      512,
      513,
      1023,
      1024,
      1025,
      2047,
      2048,
      2049,
      16383,
      16384,
      16385,
    ]) {
      const streamed = renderStreamingFixture(inputChannels, outputFrameCount, chunkFrameCount)
      expect(getMaxAbsDifference(streamed.channels[0], reference.channels[0])).toBe(0)
      expect(getMaxAbsDifference(streamed.channels[1], reference.channels[1])).toBe(0)
    }
  })

  test('supports required single-pass fixtures at both ratio endpoints', () => {
    const fixtures = [
      Float32Array.from({ length: 1024 }, (_, frame) => frame === 511 ? 1 : 0),
      new Float32Array(1024),
      Float32Array.from({ length: 1024 }, (_, frame) => ((frame * 1_103_515_245 + 12_345) >>> 0) / 2_147_483_648 - 1),
      Float32Array.from({ length: 1024 }, (_, frame) => frame % 64 === 0 ? 0.9 : Math.sin(frame * 0.71) * 0.08),
    ]
    for (const ratio of [0.5, 0.75, 1.25, 1.5, 2]) {
      for (const input of fixtures) {
        const output = stretchAudioWsola({ channels: [input], sampleRate }, {
          outputFrameCount: Math.round(input.length * ratio),
        })
        expect(output.channels[0]?.length).toBe(Math.round(input.length * ratio))
        expect(output.channels[0]?.every(Number.isFinite)).toBe(true)
      }
    }
  })

  test('preserves rounded fractional targets and reports exact peaks', () => {
    const left = Float32Array.from({ length: 1003 }, (_, frame) => frame === 37 ? 0.75 : Math.sin(frame * 0.17) * 0.2)
    const right = Float32Array.from(left, (sample) => sample * -0.25)
    const outputFrameCount = Math.round(left.length * 1.237)
    const rendered = renderStreamingFixture([left, right], outputFrameCount, 17)
    expect(rendered.channels[0]?.length).toBe(outputFrameCount)
    expect(rendered.channels[1]?.length).toBe(outputFrameCount)
    expect(rendered.stats.inputPeak).toBe(getPeak(left))
    expect(rendered.stats.inputPeak).toBe(getPeak(right) * 4)
    expect(rendered.stats.outputPeak).toBe(
      Math.max(getPeak(rendered.channels[0] ?? new Float32Array()), getPeak(rendered.channels[1] ?? new Float32Array())),
    )
    expect(rendered.channels[0]?.every(Number.isFinite)).toBe(true)
    expect(rendered.channels[1]?.every(Number.isFinite)).toBe(true)
  })

  test('copies effectively 1x output exactly', () => {
    const input = Float32Array.from({ length: 4096 }, (_, frame) => Math.sin(frame * 0.13))
    const output = stretchAudioWsola({ channels: [input], sampleRate }, {
      outputFrameCount: input.length + 1,
    })
    expect(getMaxAbsDifference(output.channels[0] ?? new Float32Array(), input)).toBe(0)
    expect(output.channels[0]?.[input.length]).toBe(0)
  })

  test('handles short inputs and rejects invalid stream metadata', () => {
    for (const input of [
      new Float32Array([0.25]),
      new Float32Array([0.25, -0.5]),
      new Float32Array([0.25, -0.5, 0.75]),
    ]) {
      const output = stretchAudioWsola({ channels: [input], sampleRate }, {
        outputFrameCount: Math.max(1, Math.round(input.length * 0.5)),
      })
      expect(output.channels[0]?.every(Number.isFinite)).toBe(true)
    }
    expect(() => createWsolaSinglePassStream({
      inputFrameCount: 100,
      outputFrameCount: 49,
      channelCount: 1,
      sampleRate,
    })).toThrow()
    expect(() => createWsolaSinglePassStream({
      inputFrameCount: 100,
      outputFrameCount: 100,
      channelCount: 0,
      sampleRate,
    })).toThrow()
    expect(() => createWsolaSinglePassStream({
      inputFrameCount: 100,
      outputFrameCount: 100,
      channelCount: 1,
      sampleRate: 0,
    })).toThrow()
  })

  test('rejects non-finite and unsafe orchestration metadata before allocation or replay', () => {
    const replayed = { count: 0 }
    const source = createSourceFixture([new Float32Array([0.25])], function* () {
      replayed.count += 1
      yield { channels: [new Float32Array([0.25])] }
    })
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createBoundedForTest(source, { outputFrameCount: value })).toThrow(
        'WSOLA output frame count',
      )
      expect(replayed.count).toBe(0)
    }
    for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => createWsolaSinglePassStream({
        inputFrameCount: 100,
        outputFrameCount: 100,
        channelCount: 1,
        sampleRate,
        searchFrameCount: value,
      })).toThrow()
    }
    expect(() => createWsolaSinglePassStream({
      inputFrameCount: 100,
      outputFrameCount: Number.MAX_SAFE_INTEGER,
      channelCount: 1,
      sampleRate,
    })).toThrow('single supported stretch-ratio pass')
    expect(() => createBoundedForTest({
      sampleRate: Infinity,
      channelCount: 1,
      frameCount: 1,
      replay: source.replay,
      dispose: () => {},
    }, { outputFrameCount: 1 })).toThrow('sample rate')
    expect(() => createBoundedForTest({
      sampleRate,
      channelCount: 1,
      frameCount: NaN,
      replay: source.replay,
      dispose: () => {},
    }, { outputFrameCount: 1 })).toThrow('source frame count')
    expect(() => {
      const bounded = createBoundedForTest({
        sampleRate,
        channelCount: 1,
        frameCount: 1,
        replay: function* () { yield { channels: [new Float32Array()] } },
        dispose: () => {},
      }, { outputFrameCount: 2 })
      try {
        return [...bounded.source.replay()]
      } finally {
        bounded.source.dispose()
      }
    }).toThrow('positive safe frame count')
  })

  test('does not replay a source for zero output and disposes it once', () => {
    let replayCount = 0
    let disposeCount = 0
    const source = createSourceFixture(
      [new Float32Array([0.25, -0.5])],
      () => {
        replayCount += 1
        throw new Error('zero-output source must not be replayed')
      },
      () => { disposeCount += 1 },
    )
    const bounded = createBoundedForTest(source, { outputFrameCount: 0 })
    expect([...bounded.source.replay()]).toEqual([])
    bounded.source.dispose()
    bounded.source.dispose()
    expect(replayCount).toBe(0)
    expect(disposeCount).toBe(1)
  })

  test('rejects positive output for zero-channel bounded sources before transaction or replay', () => {
    let factoryCount = 0
    let replayCount = 0
    let appendCount = 0
    let commitCount = 0
    const source = {
      sampleRate,
      channelCount: 0,
      frameCount: 0,
      replay: function* () {
        replayCount += 1
        yield { channels: [] }
      },
      dispose: () => {},
    }

    expect(() => createWsolaBoundedSource(source, {
      outputFrameCount: 1,
      createTransaction: () => {
        factoryCount += 1
        return {
          append: () => { appendCount += 1 },
          commit: () => {
            commitCount += 1
            throw new Error('zero-channel source must not commit')
          },
          abort: () => {},
        }
      },
    })).toThrow('zero channels')

    expect(factoryCount).toBe(0)
    expect(replayCount).toBe(0)
    expect(appendCount).toBe(0)
    expect(commitCount).toBe(0)
  })

  test('cancels zero-input synthesis before a second chunk and cleans up', () => {
    const logicalOutputFrameCount = 1_000_003
    const controller = new AbortController()
    const reason = new Error('zero-input synthesis cancelled')
    let appendCount = 0
    let transactionAbortCount = 0
    let sourceDisposeCount = 0
    const source = {
      sampleRate,
      channelCount: 1,
      frameCount: 0,
      replay: () => {
        throw new Error('zero-input synthesis must not replay')
      },
      dispose: () => { sourceDisposeCount += 1 },
    }

    let caught: unknown
    try {
      createWsolaBoundedSource(source, {
        outputFrameCount: logicalOutputFrameCount,
        sourceChunkFrameCount: 1,
        signal: controller.signal,
        createTransaction: (metadata) => ({
          append: (chunk) => {
            appendCount += 1
            expect(chunk.channels.length).toBe(metadata.channelCount)
            controller.abort(reason)
          },
          commit: () => { throw new Error('cancelled synthesis must not commit') },
          abort: () => { transactionAbortCount += 1 },
        }),
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(reason)
    expect(appendCount).toBe(1)
    expect(transactionAbortCount).toBe(1)
    expect(sourceDisposeCount).toBe(1)
  })

  test('finish is idempotent and emits no duplicate frames', () => {
    const input = createLoopFixture(4096)
    const stream = createWsolaSinglePassStream({
      inputFrameCount: input.length,
      outputFrameCount: 6144,
      channelCount: 1,
      sampleRate,
      windowFrameCount: 128,
      overlapFrameCount: 64,
      searchFrameCount: 32,
    })
    let outputFrameCount = 0
    const write = (channels: Float32Array[]) => {
      outputFrameCount += channels[0]?.length ?? 0
    }
    stream.push([input], write)
    const first = { ...stream.finish(write) }
    const second = stream.finish(write)
    expect(second).toEqual(first)
    expect(outputFrameCount).toBe(6144)
  })

  test('finish rejects reentrancy without duplicating output or accepting input', () => {
    const input = createLoopFixture(4096)
    const outputFrameCount = 6144
    const stream = createWsolaSinglePassStream({
      inputFrameCount: input.length,
      outputFrameCount,
      channelCount: 1,
      sampleRate,
      windowFrameCount: 128,
      overlapFrameCount: 64,
      searchFrameCount: 32,
    })
    let emittedFrameCount = 0
    let reentrantFinishError: Error | undefined
    let finishFromOutput = false
    const write = (channels: Float32Array[]) => {
      emittedFrameCount += channels[0]?.length ?? 0
      if (!finishFromOutput || reentrantFinishError) return
      try {
        stream.finish(write)
      } catch (error) {
        if (error instanceof Error) reentrantFinishError = error
        else throw error
      }
    }

    stream.push([input.subarray(0, input.length - 1)], write)
    finishFromOutput = true
    stream.push([input.subarray(input.length - 1)], write)
    const first = stream.finish(write)
    const second = stream.finish(write)

    expect(reentrantFinishError?.message).toBe('WSOLA stream output emission is already in progress.')
    expect(emittedFrameCount).toBe(outputFrameCount)
    expect(second).toBe(first)
    expect(() => stream.push([new Float32Array(1)], write)).toThrow(
      'WSOLA stream cannot accept audio after finish.',
    )
  })

  test('keeps state allocation bounded for a one-hour logical source', () => {
    const logicalFrameCount = 48_000 * 60 * 60
    const stream = createWsolaSinglePassStream({
      inputFrameCount: logicalFrameCount,
      outputFrameCount: logicalFrameCount * 2,
      channelCount: 2,
      sampleRate: 48_000,
    })

    expect(stream.memoryBounds()).toEqual({
      inputRingFrameCapacity: 3072,
      overlapFrameCapacity: 1024,
    })
  })

  test('retains ring history safely after many source-ring overwrites', () => {
    const input = createLoopFixture(65_536)
    const outputFrameCount = Math.round(input.length * 1.5)
    const reference = renderPhase7AReference([input], outputFrameCount, 128, 64, 32)
    const streamed = renderStreamingFixture(input.length === 0 ? [] : [input], outputFrameCount, 16384)
    expect(getMaxAbsDifference(streamed.channels[0] ?? new Float32Array(), reference[0] ?? new Float32Array())).toBe(0)
  })

  test('uses the legacy recursive frame targets without whole-array intermediates', () => {
    expect(getWsolaStageFrameCounts(4096, 1024)).toEqual([4096, 2048, 1024])
    expect(getWsolaStageFrameCounts(4096, 8192)).toEqual([4096, 8192])
    expect(getWsolaStageFrameCounts(4096, 16384)).toEqual([4096, 8192, 16384])
    expect(getWsolaStageFrameCounts(1003, Math.round(1003 * 0.37))).toEqual([1003, 502, 371])
  })

  test('reports bounded multi-pass peaks and gains', () => {
    const input = createLoopFixture(4096)
    const bounded = stretchAudioWsolaWithStats({ channels: [input], sampleRate }, {
      outputFrameCount: 16_384,
      sourceChunkFrameCount: 17,
    })

    expect(bounded.stats.stageFrameCounts).toEqual([4096, 8192, 16384])
    expect(bounded.stats.stageInputPeaks).toHaveLength(2)
    expect(bounded.stats.stageRawOutputPeaks).toHaveLength(2)
    expect(bounded.stats.stageGains).toHaveLength(2)
    expect(bounded.stats.maxSourceChunkFrames).toBeLessThanOrEqual(17)
    expect(bounded.stats.maxOutputChunkFrames).toBeLessThanOrEqual(2048)
    expect(bounded.result.channels[0]?.length).toBe(16_384)
  })

  test('proves the finite convex overlap normalization guard remains inactive', () => {
    const left = Float32Array.from({ length: 4096 }, (_, frame) => (
      frame % 257 === 0 ? 0.9375 : Math.sin(frame * 0.173) * 0.71
    ))
    const right = Float32Array.from(left, (sample) => -sample * 0.375)
    const outputFrameCount = 16_384
    const bounded = stretchAudioWsolaWithStats({ channels: [left, right], sampleRate }, {
      outputFrameCount,
      windowFrameCount: 128,
      overlapFrameCount: 64,
      searchFrameCount: 32,
      sourceChunkFrameCount: 17,
    })
    expect(bounded.stats.stageInputPeaks).toHaveLength(2)
    expect(bounded.stats.stageRawOutputPeaks).toHaveLength(2)
    expect(bounded.stats.stageGains).toHaveLength(2)
    for (let stage = 0; stage < bounded.stats.stageGains.length; stage += 1) {
      const inputPeak = bounded.stats.stageInputPeaks[stage]
      const rawOutputPeak = bounded.stats.stageRawOutputPeaks[stage]
      const gain = bounded.stats.stageGains[stage]
      if (inputPeak === undefined || rawOutputPeak === undefined || gain === undefined) {
        throw new Error('WSOLA normalization statistics are incomplete.')
      }
      const expectedGain = rawOutputPeak <= inputPeak + 0.0001 || rawOutputPeak <= 0
        ? 1
        : (inputPeak + 0.0001) / rawOutputPeak
      expect(gain).toBe(expectedGain)
      expect(rawOutputPeak).toBeLessThanOrEqual(inputPeak + 0.0001)
    }
    const inputPeak = bounded.stats.stageInputPeaks[0] ?? 0
    expect(getPeak(bounded.result.channels[0] ?? new Float32Array())).toBeLessThanOrEqual(inputPeak + 0.0001)

    // The 3837cd3 reference uses the same non-negative crossfade. Its
    // normalization branch is therefore also provably inactive for this
    // finite fixture; parity covers the actual output rather than faking a
    // gain activation.
    const expected = renderPhase7ARecursiveReference([left, right], outputFrameCount, 128, 64, 32)
    expect(getMaxAbsDifference(bounded.result.channels[0] ?? new Float32Array(), expected[0] ?? new Float32Array())).toBe(0)
    expect(getMaxAbsDifference(bounded.result.channels[1] ?? new Float32Array(), expected[1] ?? new Float32Array())).toBe(0)
  })

  test('accounts for Float32 rounding without activating peak normalization', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
    const bounded = stretchAudioWsolaWithStats({ channels: [input], sampleRate }, {
      outputFrameCount: 12,
      windowFrameCount: 4,
      overlapFrameCount: 2,
      searchFrameCount: 0,
      sourceChunkFrameCount: 3,
    })
    const output = bounded.result.channels[0] ?? new Float32Array()
    const exactCrossfade = 0.4 * 0.5 + 0.3 * 0.5
    const float32Crossfade = Math.fround(Math.fround(0.4) * (1 - 0.5) + Math.fround(0.3) * 0.5)
    expect(output[3]).toBe(float32Crossfade)
    expect(output[3]).not.toBe(exactCrossfade)
    expect(bounded.stats.stageGains[0]).toBe(1)
    expect(bounded.stats.stageRawOutputPeaks[0]).toBeLessThanOrEqual(
      (bounded.stats.stageInputPeaks[0] ?? 0) + 0.0001,
    )
  })

  test('replays a bounded source and disposes it idempotently', () => {
    const input = createLoopFixture(4096)
    let disposed = 0
    const source = {
      sampleRate,
      channelCount: 1,
      frameCount: input.length,
      replay: function* () {
        for (let start = 0; start < input.length; start += 31) {
          const end = Math.min(input.length, start + 31)
          yield { channels: [input.subarray(start, end)] }
        }
      },
      dispose: () => { disposed += 1 },
    }
    const bounded = createBoundedForTest(source, {
      outputFrameCount: 1024,
      sourceChunkFrameCount: 31,
    })
    let frames = 0
    for (const chunk of bounded.source.replay()) frames += chunk.channels[0]?.length ?? 0
    bounded.source.dispose()
    bounded.source.dispose()

    expect(frames).toBe(1024)
    expect(disposed).toBe(1)
  })

  test('requires explicit transactional storage without retaining logical-duration output', () => {
    const logicalOutputFrameCount = 48_000 * 60 * 60
    const observed = { appendFrames: 0, maxAppendFrames: 0 }
    const bounded = createWsolaBoundedSource(createSourceFixture([new Float32Array()]), {
      outputFrameCount: logicalOutputFrameCount,
      createTransaction: createDiscardingTransactionForTest(observed),
    })

    expect(observed.appendFrames).toBe(logicalOutputFrameCount)
    expect(observed.maxAppendFrames).toBeLessThanOrEqual(16_384)
    expect(bounded.stats.pipelineWorkingMemoryBytes).toBe(1 * 16_384 * Float32Array.BYTES_PER_ELEMENT)
    bounded.source.dispose()
  })

  test('rejects an oversized producer chunk before creating subarray views', () => {
    let appended = 0
    let disposed = 0
    const source = createSourceFixture(
      [Float32Array.of(0.25, -0.5, 0.75, -1)],
      function* () {
        yield { channels: [Float32Array.of(0.25, -0.5, 0.75)] }
      },
      () => { disposed += 1 },
    )
    expect(() => createWsolaBoundedSource(source, {
      outputFrameCount: 2,
      sourceChunkFrameCount: 2,
      createTransaction: () => ({
        append: () => { appended += 1 },
        commit: () => { throw new Error('oversized source must not commit') },
        abort: () => {},
      }),
    })).toThrow('larger than the configured source chunk frame limit')
    expect(appended).toBe(0)
    expect(disposed).toBe(1)
  })

  test('disposes an owned source once while preserving a pre-abort reason', () => {
    const cause = { code: 'pre-abort' }
    const reason = new Error('pre-aborted WSOLA', { cause })
    const controller = new AbortController()
    controller.abort(reason)
    let disposed = 0
    const source = {
      sampleRate,
      channelCount: 1,
      frameCount: 4096,
      replay: () => {
        throw new Error('The pre-aborted source must not be replayed.')
      },
      dispose: () => { disposed += 1 },
    }

    let caught: unknown
    try {
      createBoundedForTest(source, { outputFrameCount: 1024, signal: controller.signal })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(reason)
    expect(reason.cause).toBe(cause)
    expect(disposed).toBe(1)
  })

  test('cancels before source consumption and between multi-pass replays', () => {
    const input = createLoopFixture(4096)
    const controller = new AbortController()
    controller.abort()
    try {
      stretchAudioWsola({ channels: [input], sampleRate }, {
        outputFrameCount: 1024,
        signal: controller.signal,
      })
      throw new Error('Expected cancellation.')
    } catch (error) {
      expect(error).toMatchObject({ name: 'AbortError' })
    }

    const secondController = new AbortController()
    let consumed = 0
    const source = {
      sampleRate,
      channelCount: 1,
      frameCount: input.length,
      replay: function* (signal?: AbortSignal) {
        for (let start = 0; start < input.length; start += 64) {
          signal?.throwIfAborted()
          consumed += 1
          if (consumed === 3) secondController.abort()
          const end = Math.min(input.length, start + 64)
          yield { channels: [input.subarray(start, end)] }
        }
      },
      dispose: () => {},
    }
    try {
      createBoundedForTest(source, {
        outputFrameCount: 1024,
        signal: secondController.signal,
      })
      throw new Error('Expected cancellation.')
    } catch (error) {
      expect(error).toMatchObject({ name: 'AbortError' })
    }
    expect(consumed).toBe(3)
  })

  test('checks abort immediately after source replay completion and cleans up', () => {
    const reason = new Error('source completed after final yield')
    const controller = new AbortController()
    let transactionAbortCount = 0
    let sourceDisposeCount = 0
    const source = createSourceFixture(
      [Float32Array.of(0.25, -0.5, 0.75, -1)],
      function* () {
        yield { channels: [Float32Array.of(0.25, -0.5, 0.75, -1)] }
        controller.abort(reason)
      },
      () => { sourceDisposeCount += 1 },
    )

    let caught: unknown
    try {
      createWsolaBoundedSource(source, {
        outputFrameCount: 8,
        windowFrameCount: 4,
        overlapFrameCount: 2,
        searchFrameCount: 0,
        signal: controller.signal,
        createTransaction: (metadata) => {
          const transaction = createDiscardingTransactionForTest()(metadata)
          return {
            ...transaction,
            abort: () => {
              transactionAbortCount += 1
              transaction.abort()
            },
          }
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(reason)
    expect(transactionAbortCount).toBe(1)
    expect(sourceDisposeCount).toBe(1)
  })

  test('disposes a committed source when abort occurs during commit', () => {
    const reason = new Error('transaction commit cancelled')
    const controller = new AbortController()
    let transactionAbortCount = 0
    let committedSourceDisposeCount = 0
    const source = createSourceFixture([Float32Array.of(0.25, -0.5, 0.75, -1)])

    let caught: unknown
    try {
      createWsolaBoundedSource(source, {
        outputFrameCount: 8,
        windowFrameCount: 4,
        overlapFrameCount: 2,
        searchFrameCount: 0,
        signal: controller.signal,
        createTransaction: (metadata) => ({
          append: () => {},
          commit: () => {
            controller.abort(reason)
            return {
              ...metadata,
              replay: function* () {},
              dispose: () => { committedSourceDisposeCount += 1 },
            }
          },
          abort: () => { transactionAbortCount += 1 },
        }),
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(reason)
    expect(transactionAbortCount).toBe(1)
    expect(committedSourceDisposeCount).toBe(1)
  })

  test('replays input exactly once and retains the transaction output', () => {
    const input = createLoopFixture(4096)
    let replayCount = 0
    const source = createSourceFixture([input], function* () {
      replayCount += 1
      if (replayCount > 1) throw new Error('The source must not be replayed.')
      yield { channels: [input] }
    })
    const bounded = createBoundedForTest(source, {
      outputFrameCount: 8192,
      windowFrameCount: 128,
      overlapFrameCount: 64,
      searchFrameCount: 32,
    })
    const first = [...bounded.source.replay()]
    const second = [...bounded.source.replay()]
    bounded.source.dispose()
    expect(replayCount).toBe(1)
    expect(first.reduce((count, chunk) => count + (chunk.channels[0]?.length ?? 0), 0)).toBe(8192)
    expect(second.reduce((count, chunk) => count + (chunk.channels[0]?.length ?? 0), 0)).toBe(8192)
  })

  test('provides atomic transaction commit and idempotent abort', () => {
    const transaction = createWsolaMaterializingCompatibilityTransaction({ sampleRate, channelCount: 1, frameCount: 3 })
    transaction.append({ channels: [Float32Array.of(1, 2)] })
    expect(() => transaction.commit()).toThrow('wrong frame count')
    transaction.abort()
    transaction.abort()
    expect(() => transaction.append({ channels: [Float32Array.of(3)] })).toThrow('no longer writable')

    const committed = createWsolaMaterializingCompatibilityTransaction({ sampleRate, channelCount: 1, frameCount: 3 })
    committed.append({ channels: [Float32Array.of(1, 2, 3)] })
    const source = committed.commit()
    expect([...source.replay()][0]?.channels[0]).toEqual(Float32Array.of(1, 2, 3))
    expect(() => committed.commit()).toThrow('failure or abort')
    source.dispose()
  })

  test('passes exact and effectively one-x stages through the transaction', () => {
    for (const outputFrameCount of [4096, 4097]) {
      let replayCount = 0
      const input = createLoopFixture(4096)
      const source = createSourceFixture([input], function* () {
        replayCount += 1
        yield { channels: [input] }
      })
      const bounded = createBoundedForTest(source, { outputFrameCount })
      const output = [...bounded.source.replay()].flatMap((chunk) => [...(chunk.channels[0] ?? [])])
      bounded.source.dispose()
      expect(replayCount).toBe(1)
      expect(output.length).toBe(outputFrameCount)
      expect(output.slice(0, input.length)).toEqual([...input])
      if (outputFrameCount > input.length) expect(output[input.length]).toBe(0)
    }
  })

  test('rejects configured limits before source replay', () => {
    const replayed = { count: 0 }
    const source = createSourceFixture([Float32Array.of(0.25)], function* () {
      replayed.count += 1
      yield { channels: [Float32Array.of(0.25)] }
    })
    const cases: Array<[string, Omit<WsolaStretchConfig, 'outputFrameCount'>]> = [
      ['window', { windowFrameCount: WSOLA_MAX_WINDOW_FRAMES + 1 }],
      ['overlap', { overlapFrameCount: WSOLA_MAX_OVERLAP_FRAMES + 1 }],
      ['search', { searchFrameCount: WSOLA_MAX_SEARCH_FRAMES + 1 }],
      ['chunk', { sourceChunkFrameCount: WSOLA_MAX_SOURCE_CHUNK_FRAMES + 1 }],
    ]
    for (const [name, change] of cases) {
      expect(() => createBoundedForTest(source, { outputFrameCount: 2, ...change })).toThrow(name)
      expect(replayed.count).toBe(0)
    }
    const tooManyChannels = { ...source, channelCount: WSOLA_MAX_CHANNEL_COUNT + 1 }
    expect(() => createBoundedForTest(tooManyChannels, { outputFrameCount: 2 })).toThrow('channel')
    expect(replayed.count).toBe(0)
  })

  test('rejects overlap work before replay and reports bounded pipeline memory', () => {
    const replayed = { count: 0 }
    const source = {
      ...createSourceFixture([new Float32Array(100_000)], function* () {
        replayed.count += 1
        yield { channels: [new Float32Array(100_000)] }
      }),
      frameCount: 100_000,
    }
    expect(() => createBoundedForTest(source, {
      outputFrameCount: 50_000,
      windowFrameCount: WSOLA_MAX_WINDOW_FRAMES,
      overlapFrameCount: WSOLA_MAX_OVERLAP_FRAMES,
      searchFrameCount: WSOLA_MAX_SEARCH_FRAMES,
    })).toThrow('overlap scoring')
    expect(replayed.count).toBe(0)

    const bounded = createBoundedForTest(createSourceFixture([createLoopFixture(4096)]), {
      outputFrameCount: 8192,
    })
    expect(bounded.stats.pipelineWorkingMemoryBytes).toBeLessThanOrEqual(WSOLA_MAX_PIPELINE_WORKING_MEMORY_BYTES)
    bounded.source.dispose()
  })

  test('rejects oversized compatibility output before replay', () => {
    const input = { channels: [Float32Array.of(0.25)], sampleRate }
    expect(() => stretchAudioWsola(input, {
      outputFrameCount: 67_108_865,
      sourceChunkFrameCount: 1,
    })).toThrow('256 MiB')
  })

  test('aborts failed append and preserves the primary failure', () => {
    let commitCount = 0
    let abortCount = 0
    const input = createSourceFixture([Float32Array.of(0.25, -0.5, 0.75, -1)])
    const bounded = () => createBoundedForTest(input, {
      outputFrameCount: 8,
      windowFrameCount: 4,
      overlapFrameCount: 2,
      searchFrameCount: 0,
      createTransaction: () => ({
        append: () => { throw new Error('append failed') },
        commit: () => {
          commitCount += 1
          throw new Error('commit must not run')
        },
        abort: () => {
          abortCount += 1
          throw new Error('abort failed')
        },
      }),
    })
    expect(bounded).toThrow(AggregateError)
    expect(commitCount).toBe(0)
    expect(abortCount).toBe(1)
  })

  test('fails closed for source counts, stage PCM, and committed metadata', () => {
    const underflow = createSourceFixture([Float32Array.of(1, 2, 3, 4)], function* () {
      yield { channels: [Float32Array.of(1, 2, 3)] }
    })
    expect(() => createBoundedForTest(underflow, { outputFrameCount: 8 })).toThrow('wrong frame count')

    const overflow = createSourceFixture([Float32Array.of(1, 2, 3, 4)], function* () {
      yield { channels: [Float32Array.of(1, 2, 3, 4, 5)] }
    })
    expect(() => createBoundedForTest(overflow, { outputFrameCount: 8 })).toThrow('more source frames')

    const nonFinite = createSourceFixture([Float32Array.of(1, NaN, 3, 4)])
    expect(() => createBoundedForTest(nonFinite, { outputFrameCount: 8 })).toThrow('finite PCM')

    let commitCount = 0
    let abortCount = 0
    const invalidMetadata = createSourceFixture([Float32Array.of(1, 2, 3, 4)])
    expect(() => createBoundedForTest(invalidMetadata, {
      outputFrameCount: 8,
      createTransaction: (metadata) => ({
        append: () => {},
        commit: () => {
          commitCount += 1
          return { ...metadata, frameCount: metadata.frameCount - 1, replay: function* () {}, dispose: () => {} }
        },
        abort: () => { abortCount += 1 },
      }),
    })).toThrow('metadata')
    expect(commitCount).toBe(1)
    expect(abortCount).toBe(1)
  })

  test('admits huge logical duration while keeping stream memory bounded', () => {
    const logicalFrameCount = 48_000 * 60 * 60
    const stream = createWsolaSinglePassStream({
      inputFrameCount: logicalFrameCount,
      outputFrameCount: logicalFrameCount * 2,
      channelCount: 2,
      sampleRate: 48_000,
    })
    expect(stream.memoryBounds()).toEqual({ inputRingFrameCapacity: 3072, overlapFrameCapacity: 1024 })
  })

  test('cancels deterministically inside overlap scoring', () => {
    const controller = new AbortController()
    const input = Float32Array.from({ length: 16_384 }, (_, index) => Math.sin(index * 0.013))
    const stream = createWsolaSinglePassStream({
      inputFrameCount: input.length,
      outputFrameCount: input.length * 2,
      channelCount: 1,
      sampleRate,
      windowFrameCount: 2048,
      overlapFrameCount: 1024,
      searchFrameCount: 512,
      signal: controller.signal,
    })
    const write = () => {}
    stream.push([input.subarray(0, 4096)], write)
    controller.abort(new Error('score cancelled'))
    expect(() => stream.push([input.subarray(4096)], write)).toThrow('score cancelled')
  })

  test('keeps multi-pass stereo relationships invariant across awkward producer chunks', () => {
    const left = createLoopFixture(4096)
    const right = Float32Array.from(left, (sample) => sample * -0.25)
    const outputFrameCount = 16_384
    const reference = stretchAudioWsola({ channels: [left, right], sampleRate }, {
      outputFrameCount,
      windowFrameCount: 128,
      overlapFrameCount: 64,
      searchFrameCount: 32,
      sourceChunkFrameCount: 1,
    })

    for (const sourceChunkFrameCount of [17, 257, 1025, 16_385]) {
      const actual = stretchAudioWsola({ channels: [left, right], sampleRate }, {
        outputFrameCount,
        windowFrameCount: 128,
        overlapFrameCount: 64,
        searchFrameCount: 32,
        sourceChunkFrameCount,
      })
      expect(getMaxAbsDifference(actual.channels[0] ?? new Float32Array(), reference.channels[0] ?? new Float32Array())).toBe(0)
      expect(getMaxAbsDifference(actual.channels[1] ?? new Float32Array(), reference.channels[1] ?? new Float32Array())).toBe(0)
      expect(getMaxAbsDifference(actual.channels[0] ?? new Float32Array(), actual.channels[1] ?? new Float32Array(), -4)).toBe(0)
    }
  })
})
