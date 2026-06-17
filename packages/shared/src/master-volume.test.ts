import { describe, expect, test } from 'bun:test'
import { normalizeMasterVolume } from './master-volume'
import { parseSharedTimelineOperation } from './shared-timeline-operations'

describe('master volume', () => {
  test('normalizes master volume values', () => {
    expect(normalizeMasterVolume(-1)).toBe(0)
    expect(normalizeMasterVolume(1.5)).toBe(1)
    expect(normalizeMasterVolume(0.334)).toBe(0.33)
    expect(normalizeMasterVolume(Number.NaN)).toBe(1)
  })

  test('parses shared master volume operations with normalized payloads', () => {
    expect(parseSharedTimelineOperation({
      kind: 'mixer.setMasterVolume',
      payload: { volume: 0.456 },
    })).toEqual({
      kind: 'mixer.setMasterVolume',
      payload: { volume: 0.46 },
    })
  })
})
