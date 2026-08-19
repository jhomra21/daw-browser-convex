import { describe, expect, test } from 'bun:test'
import {
  formatMixerVolumeDb,
  mixerSliderPositionToVolume,
  mixerVolumeToSliderPosition,
  normalizeMasterVolume,
  normalizeMixerVolume,
} from './master-volume'
import { parseSharedTimelineOperation } from './shared-timeline-operations'

describe('master volume', () => {
  test('normalizes master volume values', () => {
    expect(normalizeMasterVolume(-1)).toBe(0)
    expect(normalizeMasterVolume(1.5)).toBe(1.5)
    expect(normalizeMasterVolume(2.5)).toBe(2)
    expect(normalizeMasterVolume(0.334)).toBe(0.33)
    expect(normalizeMasterVolume(Number.NaN)).toBe(1)
  })

  test('maps mixer volume through the dB-shaped slider range', () => {
    expect(mixerVolumeToSliderPosition(0)).toBe(0)
    expect(mixerVolumeToSliderPosition(1)).toBeCloseTo(60 / 66, 8)
    expect(mixerVolumeToSliderPosition(2)).toBe(1)
    expect(mixerSliderPositionToVolume(0)).toBe(0)
    expect(mixerSliderPositionToVolume(1)).toBe(2)
    expect(mixerSliderPositionToVolume(mixerVolumeToSliderPosition(1))).toBe(1)
    expect(normalizeMixerVolume(Number.NaN)).toBe(1)
  })

  test('formats mixer volume in compact dB notation', () => {
    expect(formatMixerVolumeDb(0)).toBe('-inf')
    expect(formatMixerVolumeDb(0.8)).toBe('-1.9')
    expect(formatMixerVolumeDb(1)).toBe('0.0')
    expect(formatMixerVolumeDb(2)).toBe('+6.0')
    expect(formatMixerVolumeDb(Number.NaN)).toBe('-inf')
  })

  test('parses shared master volume operations with normalized payloads', () => {
    expect(parseSharedTimelineOperation({
      kind: 'mixer.setMasterVolume',
      payload: { volume: 0.456 },
    })).toEqual({
      kind: 'mixer.setMasterVolume',
      payload: { volume: 0.46 },
    })
    expect(parseSharedTimelineOperation({
      kind: 'mixer.setMasterVolume',
      payload: { volume: 3 },
    })).toEqual({
      kind: 'mixer.setMasterVolume',
      payload: { volume: 2 },
    })
    expect(parseSharedTimelineOperation({
      kind: 'tracks.setVolume',
      payload: { trackId: 'track-1', volume: 3 },
    })).toEqual({
      kind: 'tracks.setVolume',
      payload: { trackId: 'track-1', volume: 2 },
    })
  })
})
