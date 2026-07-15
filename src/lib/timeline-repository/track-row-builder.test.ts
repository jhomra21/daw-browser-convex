import { describe, expect, test } from 'bun:test'

import { buildTimelineTrackRow } from './track-row-builder'

describe('buildTimelineTrackRow', () => {
  test('names return tracks distinctly while preserving supplied names', () => {
    expect(buildTimelineTrackRow({
      id: 'return',
      index: 2,
      channelRole: 'return',
      timestamp: 1,
    })).toMatchObject({
      name: 'Return 3',
      channelRole: 'return',
    })
    expect(buildTimelineTrackRow({
      id: 'named-return',
      index: 3,
      channelRole: 'return',
      name: 'Reverb',
      timestamp: 1,
    })).toMatchObject({
      name: 'Reverb',
      channelRole: 'return',
    })
  })

  test('defaults returns to collapsed without changing normal track defaults', () => {
    expect(buildTimelineTrackRow({
      id: 'return',
      index: 0,
      channelRole: 'return',
      timestamp: 1,
    }).collapsed).toBe(true)
    expect(buildTimelineTrackRow({
      id: 'expanded-return',
      index: 1,
      channelRole: 'return',
      collapsed: false,
      timestamp: 1,
    }).collapsed).toBe(false)
    expect(buildTimelineTrackRow({
      id: 'normal',
      index: 2,
      channelRole: 'track',
      timestamp: 1,
    }).collapsed).toBeUndefined()
  })
})
