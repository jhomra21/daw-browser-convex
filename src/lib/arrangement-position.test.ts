import { describe, expect, test } from 'bun:test'
import {
  arrangementPositionFields,
  parsePositionDraft,
  timeAfterFieldChange,
} from './arrangement-position'

// 120 bpm: one beat is 0.5s, one sixteenth 0.125s, one bar 2s.
describe('arrangementPositionFields', () => {
  test('reads 1-based bars, beats and sixteenths like the ruler', () => {
    expect(arrangementPositionFields(0, 120)).toEqual({ bar: 1, beat: 1, sixteenth: 1 })
    expect(arrangementPositionFields(2 + 0.5 + 0.125, 120)).toEqual({ bar: 2, beat: 2, sixteenth: 2 })
    expect(arrangementPositionFields(1.875, 120)).toEqual({ bar: 1, beat: 4, sixteenth: 4 })
  })

  test('treats a bad time or tempo as the project start', () => {
    expect(arrangementPositionFields(Number.NaN, 120)).toEqual({ bar: 1, beat: 1, sixteenth: 1 })
    expect(arrangementPositionFields(5, 0)).toEqual({ bar: 1, beat: 1, sixteenth: 1 })
  })
})

describe('timeAfterFieldChange', () => {
  test('replaces one field and keeps the others', () => {
    expect(timeAfterFieldChange(2.625, 120, 'bar', 3)).toBeCloseTo(4.625)
    expect(timeAfterFieldChange(2.625, 120, 'beat', 4)).toBeCloseTo(3.625)
    expect(timeAfterFieldChange(2.625, 120, 'sixteenth', 4)).toBeCloseTo(2.875)
  })

  test('clamps beats and sixteenths to 1-4 and bars to at least 1', () => {
    expect(timeAfterFieldChange(0, 120, 'beat', 9)).toBeCloseTo(1.5)
    expect(timeAfterFieldChange(0, 120, 'sixteenth', 0)).toBe(0)
    expect(timeAfterFieldChange(5, 120, 'bar', -4)).toBeCloseTo(5 % 2)
    expect(timeAfterFieldChange(0, 120, 'bar', 1.6)).toBeCloseTo(2)
  })

  test('scales with tempo', () => {
    expect(timeAfterFieldChange(0, 60, 'bar', 2)).toBeCloseTo(4)
  })
})

describe('parsePositionDraft', () => {
  test('accepts whole numbers only', () => {
    expect(parsePositionDraft(' 12 ')).toBe(12)
    expect(parsePositionDraft('')).toBeNull()
    expect(parsePositionDraft('a')).toBeNull()
    expect(parsePositionDraft('2.5')).toBeNull()
  })
})
