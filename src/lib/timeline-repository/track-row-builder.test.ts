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
})
