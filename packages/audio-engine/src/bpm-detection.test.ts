import { describe, expect, test } from 'bun:test'
import { detectLoopBpm } from './bpm-detection'

const sampleRate = 44_100

const createPulseLoop = (bpm: number, bars: number) => {
  const beats = bars * 4
  const durationSec = (beats * 60) / bpm
  const channel = new Float32Array(Math.round(durationSec * sampleRate))
  const framesPerBeat = Math.round((60 / bpm) * sampleRate)
  const pulseFrames = Math.round(0.025 * sampleRate)
  for (let beat = 0; beat < beats; beat++) {
    const start = beat * framesPerBeat
    const accent = beat % 4 === 0 ? 0.95 : 0.6
    for (let offset = 0; offset < pulseFrames; offset++) {
      const frame = start + offset
      if (frame >= channel.length) break
      channel[frame] = accent * (1 - offset / pulseFrames)
    }
  }
  return channel
}

const isEquivalentTempo = (actual: number, expected: number) => (
  Math.abs(actual - expected) < 1
  || Math.abs(actual * 2 - expected) < 1
  || Math.abs(actual / 2 - expected) < 1
)

const arraysEqual = (left: Float32Array, right: Float32Array) => {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

describe('detectLoopBpm', () => {
  test('detects loop tempo from deterministic transients', () => {
    const result = detectLoopBpm({
      channels: [createPulseLoop(128, 4)],
      sampleRate,
    })

    expect(result === null).toBe(false)
    if (!result) return
    expect(isEquivalentTempo(result.bpm, 128)).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.35)
    expect(result.alternatives.length).toBeGreaterThan(0)
  })

  test('rejects very short buffers', () => {
    const result = detectLoopBpm({
      channels: [new Float32Array(Math.round(sampleRate * 0.25))],
      sampleRate,
    })

    expect(result).toBe(null)
  })

  test('supports stereo-linked input without mutating channels', () => {
    const left = createPulseLoop(90, 4)
    const right = new Float32Array(left)
    const beforeLeft = new Float32Array(left)
    const beforeRight = new Float32Array(right)
    const result = detectLoopBpm({ channels: [left, right], sampleRate })

    expect(arraysEqual(left, beforeLeft)).toBe(true)
    expect(arraysEqual(right, beforeRight)).toBe(true)
    expect(result === null).toBe(false)
    if (!result) return
    expect(isEquivalentTempo(result.bpm, 90)).toBe(true)
    expect(Math.abs(result.alternatives[0].bpm - result.bpm)).toBeLessThan(1)
  })
})
