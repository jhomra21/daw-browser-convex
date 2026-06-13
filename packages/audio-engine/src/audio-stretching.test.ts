import { describe, expect, test } from 'bun:test'
import { stretchAudioWsola } from './audio-stretching'

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

})
