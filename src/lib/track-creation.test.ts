import { describe, expect, test } from 'bun:test'
import { trackCreationIndex } from './track-creation'
import type { Track } from '@daw-browser/timeline-core/types'

describe('trackCreationIndex', () => {
  const tracks: Array<Pick<Track, 'channelRole'>> = [
    { channelRole: 'track' },
    { channelRole: 'return' },
    { channelRole: 'return' },
  ]

  test('keeps normal tracks before returns and returns in their partition', () => {
    expect(trackCreationIndex(tracks, 'track')).toBe(1)
    expect(trackCreationIndex(tracks, 'return')).toBe(3)
    expect(trackCreationIndex(tracks, 'track', 99)).toBe(1)
    expect(trackCreationIndex(tracks, 'return', 0)).toBe(1)
  })

  test('defaults each partition and clamps explicit indices within it', () => {
    expect(trackCreationIndex([], 'track')).toBe(0)
    expect(trackCreationIndex([], 'return')).toBe(0)
    expect(trackCreationIndex(tracks, 'track', -1)).toBe(0)
    expect(trackCreationIndex(tracks, 'return', 99)).toBe(3)
  })
})
