import { describe, expect, test } from 'bun:test'
import {
  cpuLoadFromNativeSample,
  cpuLoadPercent,
  cpuLoadValueText,
  holdPeak,
  PEAK_HOLD_MS,
} from './audio-cpu-load'

describe('cpuLoadFromNativeSample', () => {
  test('averages callback time over buffer time and reads the peak in millionths', () => {
    expect(cpuLoadFromNativeSample({ callbackNanoseconds: 7_000_000, bufferNanoseconds: 20_000_000, peakLoadPerMillion: 500_000 }))
      .toEqual({ average: 0.35, current: 0.5 })
  })

  test('an interval without callbacks reads as idle', () => {
    expect(cpuLoadFromNativeSample({ callbackNanoseconds: 0, bufferNanoseconds: 0, peakLoadPerMillion: 0 }))
      .toEqual({ average: 0, current: 0 })
  })

  test('keeps values over 100%', () => {
    expect(cpuLoadFromNativeSample({ callbackNanoseconds: 30_000_000, bufferNanoseconds: 20_000_000, peakLoadPerMillion: 2_500_000 }))
      .toEqual({ average: 1.5, current: 2.5 })
  })
})

describe('holdPeak', () => {
  test('a higher reading replaces the held peak at once', () => {
    expect(holdPeak({ value: 0.4, atMs: 0 }, 0.9, 100)).toEqual({ value: 0.9, atMs: 100 })
  })

  test('a lower reading keeps the peak for the hold time, then falls to the reading', () => {
    const held = { value: 0.9, atMs: 0 }
    expect(holdPeak(held, 0.2, PEAK_HOLD_MS - 1)).toEqual(held)
    expect(holdPeak(held, 0.2, PEAK_HOLD_MS)).toEqual({ value: 0.2, atMs: PEAK_HOLD_MS })
  })

  test('an equal reading refreshes the hold', () => {
    expect(holdPeak({ value: 0.5, atMs: 0 }, 0.5, 900)).toEqual({ value: 0.5, atMs: 900 })
  })
})

describe('display', () => {
  test('rounds to a whole percent and clamps at 999', () => {
    expect(cpuLoadPercent(0.234)).toBe(23)
    expect(cpuLoadPercent(1.5)).toBe(150)
    expect(cpuLoadPercent(25)).toBe(999)
    expect(cpuLoadPercent(Number.NaN)).toBe(0)
    expect(cpuLoadPercent(-1)).toBe(0)
  })

  test('describes both readings for assistive technology', () => {
    expect(cpuLoadValueText({ average: 0.23, current: 0.41 })).toBe('average 23%, current 41%')
  })
})
