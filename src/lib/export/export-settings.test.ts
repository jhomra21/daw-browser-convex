import { describe, expect, test } from 'bun:test'
import { getExportRangeBounds, getExportRangeDuration } from '@daw-browser/audio-engine/export-range'
import { createCustomExportRange, deriveSelectedExportTrackIds, isRenderableExportTrack } from './export-settings'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'

const track = (
  id: string,
  clipIds: string[],
  channelRole: RuntimeTrack['channelRole'] = 'track',
): RuntimeTrack => ({
  id,
  name: id,
  volume: 1,
  channelRole,
  clips: clipIds.map((clipId) => ({
    id: clipId,
    name: clipId,
    startSec: 0,
    duration: 1,
    color: '#fff',
  })),
})

describe('createCustomExportRange', () => {
  test('converts start and length to the engine range contract', () => {
    expect(createCustomExportRange(3, 2.5)).toEqual({ mode: 'custom', startSec: 3, endSec: 5.5 })
    expect(createCustomExportRange(-2, 0)).toEqual({ mode: 'custom', startSec: 0, endSec: 0.001 })
  })
})

describe('export range helpers', () => {
  test('normalizes explicit ranges and derives whole-timeline bounds', () => {
    const tracks = [track('a', ['clip-a'])]
    tracks[0].clips[0].startSec = 2
    tracks[0].clips[0].duration = 3
    expect(getExportRangeBounds(tracks, { mode: 'whole' })).toEqual({ startSec: 0, endSec: 5 })
    expect(getExportRangeDuration(tracks, { mode: 'custom', startSec: 4, endSec: 4 })).toBeCloseTo(0.001)
  })
})

describe('deriveSelectedExportTrackIds', () => {
  const tracks = [
    track('a', ['clip-a']),
    track('group', ['clip-group'], 'group'),
    track('b', ['clip-b']),
    track('empty', []),
  ]
  const clipTrackIdById = new Map<string, string>()
  for (const item of tracks) {
    for (const clip of item.clips) clipTrackIdById.set(clip.id, item.id)
  }

  test('uses range selection first and returns timeline order', () => {
    expect(deriveSelectedExportTrackIds({
      tracks,
      clipTrackIdById,
      rangeSelection: {
        startSec: 0,
        endSec: 1,
        trackIds: ['b', 'group', 'a', 'b'],
        primaryTrackId: 'b',
      },
      selectedClipIds: new Set(['clip-a']),
      primaryTrackId: 'empty',
    })).toEqual(['a', 'b'])
  })

  test('falls back to selected clips, then the primary track', () => {
    expect(deriveSelectedExportTrackIds({
      tracks,
      clipTrackIdById,
      rangeSelection: null,
      selectedClipIds: new Set(['clip-b', 'clip-a']),
      primaryTrackId: 'empty',
    })).toEqual(['a', 'b'])
    expect(deriveSelectedExportTrackIds({
      tracks,
      clipTrackIdById,
      rangeSelection: null,
      selectedClipIds: new Set(),
      primaryTrackId: 'b',
    })).toEqual(['b'])
  })

  test('filters groups, returns, missing tracks, and empty tracks', () => {
    expect(deriveSelectedExportTrackIds({
      tracks,
      clipTrackIdById,
      rangeSelection: null,
      selectedClipIds: new Set(),
      primaryTrackId: 'group',
    })).toEqual([])
    expect(isRenderableExportTrack(tracks[0])).toBe(true)
    expect(isRenderableExportTrack(tracks[1])).toBe(false)
    expect(isRenderableExportTrack(tracks[3])).toBe(false)
  })
})
