import { describe, expect, test } from 'bun:test'
import { createGranularPrng, createGranularSchedule, granularWindow, granularWindowEnergy } from './granular-core'

describe('granular core', () => {
  test('windows are finite, bounded, and have useful energy', () => {
    const windowKinds: readonly ['hann', 'tukey', 'gaussian'] = ['hann', 'tukey', 'gaussian']
    for (const windowKind of windowKinds) {
      for (let index = 0; index <= 100; index += 1) {
        const value = granularWindow(windowKind, index / 100)
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
      expect(granularWindowEnergy(windowKind)).toBeGreaterThan(0.1)
      expect(granularWindowEnergy(windowKind)).toBeLessThanOrEqual(1)
    }
  })

  test('seed and density produce deterministic bounded schedules', () => {
    expect(createGranularSchedule({ durationSec: 2, densityHz: 10, seed: 42 })).toEqual(
      createGranularSchedule({ durationSec: 2, densityHz: 10, seed: 42 }),
    )
    expect(createGranularSchedule({ durationSec: 2, densityHz: 10, seed: 42 })).toHaveLength(20)
    expect(createGranularSchedule({ durationSec: 2, densityHz: 10, seed: 42 })).not.toEqual(
      createGranularSchedule({ durationSec: 2, densityHz: 10, seed: 43 }),
    )
  })

  test('PRNG decisions cover deterministic reverse and stereo choices', () => {
    const first = createGranularPrng(7)
    const second = createGranularPrng(7)
    const decisions = Array.from({ length: 32 }, () => ({
      reverse: first() < 0.5,
      pan: first() * 2 - 1,
    }))
    expect(decisions).toEqual(Array.from({ length: 32 }, () => ({
      reverse: second() < 0.5,
      pan: second() * 2 - 1,
    })))
    expect(decisions.some((decision) => decision.reverse)).toBe(true)
    expect(decisions.some((decision) => !decision.reverse)).toBe(true)
    expect(decisions.every((decision) => decision.pan >= -1 && decision.pan <= 1)).toBe(true)
  })
})
