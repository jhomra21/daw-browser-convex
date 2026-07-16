import { describe, expect, test } from 'bun:test'
import {
  createSynthEnvelopePath,
  createSynthFilterResponsePath,
  createSynthWavePath,
} from './synth-visualizations'

describe('synth visualizations', () => {
  test('draws distinct mathematical waveform paths', () => {
    const sine = createSynthWavePath('sine', 120, 40)
    const square = createSynthWavePath('square', 120, 40)

    expect(sine).toStartWith('M4.00,20.00')
    expect(square).toStartWith('M4.00,4.00')
    expect(sine).not.toBe(square)
  })

  test('includes attack, decay, sustain, and release envelope stages', () => {
    expect(createSynthEnvelopePath(
      { attackSec: 0.1, decaySec: 0.2, sustain: 0.4, releaseSec: 0.3 },
      220,
      52,
    )).toBe('M6.00,46.00 L24.91,6.00 L62.73,30.00 L157.27,30.00 L214.00,46.00')
  })

  test('changes the static filter response with filter mode and cutoff', () => {
    const lowpass = createSynthFilterResponsePath('lowpass', 1000, 0.7, 240, 60)
    const highpass = createSynthFilterResponsePath('highpass', 1000, 0.7, 240, 60)
    const openLowpass = createSynthFilterResponsePath('lowpass', 12_000, 0.7, 240, 60)

    expect(lowpass).not.toBe(highpass)
    expect(lowpass).not.toBe(openLowpass)
  })

  test('draws low-pass and high-pass responses in opposite directions', () => {
    const lowpass = createSynthFilterResponsePath('lowpass', 1000, 0.7, 240, 60)
    const highpass = createSynthFilterResponsePath('highpass', 1000, 0.7, 240, 60)
    const yCoordinates = (path: string) => path.match(/,(\d+\.\d+)/g)?.map((match) => Number(match.slice(1))) ?? []
    const lowpassY = yCoordinates(lowpass)
    const highpassY = yCoordinates(highpass)

    expect(lowpassY[0]).toBeLessThan(lowpassY.at(-1) ?? 0)
    expect(highpassY[0]).toBeGreaterThan(highpassY.at(-1) ?? 0)
  })
})
