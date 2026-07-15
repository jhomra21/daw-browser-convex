import { describe, expect, test } from 'bun:test'

import {
  canonicalTrackCreation,
  hasValidReturnTrackPartition,
  trackCreationCollapsed,
  trackCreationIndex,
} from './return-track-policy'

describe('Return track policy', () => {
  test('uses indexed order to constrain creation to the matching partition', () => {
    const tracks = [
      { index: 2, channelRole: 'return' },
      { index: 0, channelRole: 'track' },
      { index: 1, channelRole: 'group' },
    ]

    expect(trackCreationIndex(tracks, 'track', 99)).toBe(2)
    expect(trackCreationIndex(tracks, 'return', 0)).toBe(2)
    expect(trackCreationIndex(tracks, 'return')).toBe(3)
  })

  test('preserves explicit collapse and derives omitted Return collapse', () => {
    expect(trackCreationCollapsed('return', false)).toBe(false)
    expect(trackCreationCollapsed('return', undefined)).toBe(true)
    expect(trackCreationCollapsed('unknown-role', undefined)).toBe(false)
  })

  test('requires an ungrouped Return suffix without narrowing unknown roles', () => {
    expect(hasValidReturnTrackPartition([
      { index: 0, channelRole: 'legacy-role' },
      { index: 1, channelRole: 'return' },
    ])).toBe(true)
    expect(hasValidReturnTrackPartition([
      { index: 0, channelRole: 'return' },
      { index: 1, channelRole: 'track' },
    ])).toBe(false)
    expect(hasValidReturnTrackPartition([
      { index: 0, channelRole: 'return', groupId: 'group' },
    ])).toBe(false)
  })

  test('repairs interleaved legacy indexes while inserting normal tracks', () => {
    const tracks = [
      { id: 'normal-a', index: 0, channelRole: 'track', groupId: 'group-a' },
      { id: 'return-a', index: 1, channelRole: 'return' },
      { id: 'normal-b', index: 2, channelRole: 'track' },
      { id: 'return-b', index: 3, channelRole: 'return', groupId: 'legacy-group' },
    ]

    const creation = canonicalTrackCreation(tracks, 'track')

    expect(creation.creationIndex).toBe(2)
    expect(creation.existingTracks).toEqual([
      { id: 'normal-a', index: 0, channelRole: 'track', groupId: 'group-a' },
      { id: 'normal-b', index: 1, channelRole: 'track', groupId: undefined },
      { id: 'return-a', index: 3, channelRole: 'return', groupId: undefined },
      { id: 'return-b', index: 4, channelRole: 'return', groupId: undefined },
    ])
  })

  test('inserts Return tracks into the repaired Return partition', () => {
    const tracks = [
      { id: 'return-a', index: 0, channelRole: 'return' },
      { id: 'normal-a', index: 1, channelRole: 'track' },
      { id: 'return-b', index: 2, channelRole: 'return' },
    ]

    const firstCreation = canonicalTrackCreation(tracks, 'return', 0)
    const firstReturn = {
      id: 'return-new',
      index: firstCreation.creationIndex,
      channelRole: 'return',
      collapsed: false,
    }
    const secondCreation = canonicalTrackCreation(
      [...firstCreation.existingTracks, firstReturn],
      'return',
    )

    expect(firstCreation.creationIndex).toBe(1)
    expect(firstCreation.existingTracks.map((track) => [track.id, track.index]))
      .toEqual([['normal-a', 0], ['return-a', 2], ['return-b', 3]])
    expect(secondCreation.creationIndex).toBe(4)
    expect(secondCreation.existingTracks.map((track) => [track.id, track.index]))
      .toEqual([
        ['normal-a', 0],
        ['return-new', 1],
        ['return-a', 2],
        ['return-b', 3],
      ])
  })
})
