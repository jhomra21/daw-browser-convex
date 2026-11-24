import { describe, expect, it } from 'bun:test'
import { AUTO_FILTER_MAX_Q, AUTO_FILTER_MIN_Q } from '@daw-browser/shared'
import {
  autoFilterFrequencyX,
  autoFilterLfoRateLabel,
  autoFilterResonanceY,
  autoFilterResponseDb,
  autoFilterResponsePath,
  autoFilterXFrequency,
  autoFilterYResonance,
} from './auto-filter-view'

const settings = { mode: 'lowpass', slope: 12, frequencyHz: 1000, resonance: 0.5 } as const
const q = (resonance: number) => AUTO_FILTER_MIN_Q * (AUTO_FILTER_MAX_Q / AUTO_FILTER_MIN_Q) ** resonance

describe('Auto Filter graph', () => {
  it('reads the low-pass peak at the cutoff as the filter Q, doubled in dB at 24 dB', () => {
    expect(autoFilterResponseDb(settings, 1000)).toBeCloseTo(20 * Math.log10(q(0.5)), 6)
    expect(autoFilterResponseDb({ ...settings, slope: 24 }, 1000)).toBeCloseTo(40 * Math.log10(Math.sqrt(q(0.5))), 6)
  })

  it('has unity band-pass gain at the cutoff at every resonance and slope', () => {
    for (const resonance of [0, 0.5, 1]) {
      for (const slope of [12, 24] as const) {
        expect(autoFilterResponseDb({ ...settings, mode: 'bandpass', slope, resonance }, 1000)).toBeCloseTo(0, 6)
      }
    }
  })

  it('falls 12 dB per octave above a Butterworth low-pass cutoff and twice that at 24 dB', () => {
    const flat = { ...settings, resonance: 0 }

    expect(autoFilterResponseDb(flat, 8000) - autoFilterResponseDb(flat, 4000)).toBeCloseTo(-12, 0)
    expect(autoFilterResponseDb({ ...flat, slope: 24 }, 8000) - autoFilterResponseDb({ ...flat, slope: 24 }, 4000)).toBeCloseTo(-24, 0)
  })

  it('cuts deep at a notch centre and passes high-pass and peak shapes at the extremes', () => {
    expect(autoFilterResponseDb({ ...settings, mode: 'notch' }, 1000)).toBeLessThan(-60)
    expect(autoFilterResponseDb({ ...settings, mode: 'highpass' }, 20_000)).toBeCloseTo(0, 1)
    expect(autoFilterResponseDb({ ...settings, mode: 'peak', resonance: 0 }, 20)).toBeCloseTo(0, 1)
  })

  it('maps frequency and resonance to the graph and back', () => {
    for (const hz of [20, 100, 1000, 20_000]) expect(autoFilterXFrequency(autoFilterFrequencyX(hz))).toBeCloseTo(hz, 6)

    for (const resonance of [0, 0.3, 1]) expect(autoFilterYResonance(autoFilterResonanceY(resonance))).toBeCloseTo(resonance, 9)
    expect(autoFilterYResonance(-100)).toBe(1)
    expect(autoFilterYResonance(1000)).toBe(0)
    expect(autoFilterXFrequency(-5)).toBe(20)
    expect(autoFilterXFrequency(1000)).toBeCloseTo(20_000, 6)
  })

  it('draws a finite path that stays inside the graph', () => {
    const path = autoFilterResponsePath({ ...settings, resonance: 1 })
    const numbers = path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []

    expect(path.startsWith('M')).toBe(true)
    expect(numbers.length).toBeGreaterThan(100)
    expect(numbers.every((value) => Number.isFinite(value) && value >= 0 && value <= 180)).toBe(true)
  })

  it('labels the LFO rate in Hz or as the tempo division', () => {
    expect(autoFilterLfoRateLabel({ sync: false, rateHz: 0.25, division: 5 })).toBe('0.25 Hz')
    expect(autoFilterLfoRateLabel({ sync: true, rateHz: 0.25, division: 5 })).toBe('1/4')
    expect(autoFilterLfoRateLabel({ sync: true, rateHz: 0.25, division: 0 })).toBe('2 bars')
  })
})
