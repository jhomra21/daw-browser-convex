import { describe, expect, test } from 'bun:test'
import { analyzeCalibrationCapture, createCalibrationStimulus } from './calibration'

const delayed = (delay: number, gain = 1, noise = 0): Float32Array => {
  const stimulus = createCalibrationStimulus(48_000)
  const capture = new Float32Array(delay + stimulus.length + 256)
  for (let index = 0; index < stimulus.length; index += 1) {
    capture[delay + index] = (stimulus[index] ?? 0) * gain + Math.sin(index * 1.71) * noise
  }
  return capture
}

describe('recording calibration analysis', () => {
  test('finds delayed, noisy, and polarity-inverted returns', () => {
    const normal = analyzeCalibrationCapture(delayed(731, 0.8, 0.002), 48_000)
    expect(normal).toMatchObject({ accepted: true, measuredRoundTripFrames: 731, inverted: false })
    const inverted = analyzeCalibrationCapture(delayed(1_207, -0.7, 0.003), 48_000)
    expect(inverted).toMatchObject({ accepted: true, measuredRoundTripFrames: 1_207, inverted: true })
  })

  test('rejects clipped, weak, and ambiguous captures', () => {
    const clipped = delayed(200)
    clipped[0] = 1
    expect(analyzeCalibrationCapture(clipped, 48_000)).toMatchObject({ accepted: false, reason: 'clipped' })
    expect(analyzeCalibrationCapture(new Float32Array(20_000), 48_000)).toMatchObject({ accepted: false, reason: 'weak-signal' })
    const first = delayed(300)
    const stimulus = createCalibrationStimulus(48_000)
    const ambiguous = new Float32Array(first.length + 6_000)
    ambiguous.set(first)
    for (let index = 0; index < stimulus.length; index += 1) ambiguous[5_300 + index] += stimulus[index] ?? 0
    expect(analyzeCalibrationCapture(ambiguous, 48_000)).toMatchObject({ accepted: false, reason: 'ambiguous' })
  })
})
