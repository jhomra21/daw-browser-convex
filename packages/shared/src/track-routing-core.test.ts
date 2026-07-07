import { describe, expect, test } from 'bun:test'
import { normalizeTrackRouting } from './track-routing-core'

describe('normalizeTrackRouting', () => {
  const tracks = [
    { id: 'outer', channelRole: 'group' },
    { id: 'inner', channelRole: 'group', groupId: 'outer' },
    { id: 'child', groupId: 'inner' },
    { id: 'sibling', channelRole: 'group' },
  ]

  test('allows nested groups to route to ancestor groups', () => {
    expect(normalizeTrackRouting({
      track: { id: 'inner', channelRole: 'group', groupId: 'outer' },
      outputTargetId: 'outer',
      tracks,
    }).outputTargetId).toBe('outer')
  })

  test('rejects group routing to siblings, descendants, and normal tracks', () => {
    expect(normalizeTrackRouting({
      track: { id: 'inner', channelRole: 'group', groupId: 'outer' },
      outputTargetId: 'sibling',
      tracks,
    }).outputTargetId).toBeUndefined()
    expect(normalizeTrackRouting({
      track: { id: 'outer', channelRole: 'group' },
      outputTargetId: 'inner',
      tracks,
    }).outputTargetId).toBeUndefined()
    expect(normalizeTrackRouting({
      track: { id: 'inner', channelRole: 'group', groupId: 'outer' },
      outputTargetId: 'child',
      tracks,
    }).outputTargetId).toBeUndefined()
  })
})
