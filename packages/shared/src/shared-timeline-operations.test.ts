import { describe, expect, test } from 'bun:test'
import { parseSharedTimelineOperation } from './shared-timeline-operations'

describe('shared timeline operations', () => {
  test('preserves null group ids for clear-group operations', () => {
    expect(parseSharedTimelineOperation({
      kind: 'tracks.setGroup',
      payload: { trackId: 'track-1', groupId: null },
    })).toEqual({
      kind: 'tracks.setGroup',
      payload: { trackId: 'track-1', groupId: null },
    })
  })

  test('preserves color on track create operations', () => {
    expect(parseSharedTimelineOperation({
      kind: 'tracks.create',
      payload: { index: 2, kind: 'audio', channelRole: 'group', color: '#22c55e', operationId: 'op-1' },
    })).toEqual({
      kind: 'tracks.create',
      payload: { index: 2, kind: 'audio', channelRole: 'group', color: '#22c55e', operationId: 'op-1' },
    })
  })
})
