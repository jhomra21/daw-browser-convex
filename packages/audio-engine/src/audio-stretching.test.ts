import { describe, expect, test } from 'bun:test'
import { createWsolaSinglePassStream, stretchAudioWsola } from './audio-stretching'

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

describe('stretchAudioWsola', () => {
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
})
