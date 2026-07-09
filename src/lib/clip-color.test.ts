import { describe, expect, test } from 'bun:test'
import { createClipVisualColors, resolveClipColor, trackColorForClip } from './clip-color'

const tokens = {
  'clip-audio': '#22c55e',
  'clip-midi': '#3b82f6',
  'clip-recording': '#ef4444',
}

describe('clip color helpers', () => {
  test('resolves default clip tokens and preserves custom colors', () => {
    expect(resolveClipColor('clip-audio', tokens)).toBe('#22c55e')
    expect(resolveClipColor('clip-midi', tokens)).toBe('#3b82f6')
    expect(resolveClipColor('clip-recording', tokens)).toBe('#ef4444')
    expect(resolveClipColor('#f2994a', tokens)).toBe('#f2994a')
  })

  test('uses only custom hex track colors for clips', () => {
    expect(trackColorForClip('#f2994a')).toBe('#f2994a')
    expect(trackColorForClip('timeline-surface')).toBeUndefined()
    expect(trackColorForClip('clip-audio')).toBeUndefined()
    expect(trackColorForClip(undefined)).toBeUndefined()
  })

  test('builds clip body colors from the resolved clip color', () => {
    expect(createClipVisualColors('#f2994a', false, false)).toEqual({
      'background-color': 'color-mix(in srgb, #f2994a 20%, transparent)',
      'border-color': 'color-mix(in srgb, #f2994a 60%, transparent)',
    })
    expect(createClipVisualColors('#9b51e0', true, false)).toEqual({
      'background-color': 'color-mix(in srgb, #9b51e0 30%, transparent)',
      'border-color': 'color-mix(in srgb, #9b51e0 85%, transparent)',
    })
  })
})
