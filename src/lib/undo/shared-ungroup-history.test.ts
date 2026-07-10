import { describe, expect, test } from 'bun:test'
import type { Track } from '@daw-browser/timeline-core/types'
import { createDefaultEqParams } from '@daw-browser/shared'

import { buildCommittedSharedUngroupHistoryEntry, readSharedUngroupResult } from './shared-ungroup-history'

const track = (id: string, patch: Partial<Track> = {}): Track => ({
  id,
  name: id,
  volume: 1,
  clips: [],
  ...patch,
})

describe('durable shared ungroup history', () => {
  test('builds history from the transaction-owned result after replay', () => {
    const group = track('group', { historyRef: 'group-ref', channelRole: 'group', color: '#123456' })
    const child = track('child', { historyRef: 'child-ref', groupId: 'group', outputTargetId: 'group' })
    const result = readSharedUngroupResult({
      status: 'applied',
      group: {
        historyRef: 'group-ref',
        index: 0,
        volume: 0.8,
        muted: false,
        soloed: true,
        sends: [],
      },
      children: [{ trackId: 'child', nextOutputTargetId: 'parent' }],
      effects: [{ type: 'eq', instanceId: 'eq-1', index: 2, params: createDefaultEqParams() }],
      automation: [{
        parameterId: 'volume',
        enabled: true,
        points: [{ id: 'point', timeSec: 0, value: 0.5, interpolation: 'linear' }],
        updatedAt: 2,
      }],
    })
    if (!result) throw new Error('Expected valid ungroup result')
    const entry = buildCommittedSharedUngroupHistoryEntry({
      projectId: 'project',
      tracks: [group, child],
      groupTrack: group,
      effects: { audioEffects: [{ effect: 'eq', instanceId: 'eq-1', index: 0, params: createDefaultEqParams() }] },
      automation: [{
        id: 'envelope',
        projectId: 'project',
        target: { kind: 'track', trackId: 'group' },
        targetKey: 'track:group:volume',
        parameterId: 'volume',
        enabled: false,
        points: [],
        updatedAt: 1,
      }],
      result,
    })

    expect(entry.data.childSnapshots).toEqual([{
      trackRef: 'child-ref',
      previousGroupRef: 'group-ref',
      previousOutputTargetRef: 'group-ref',
      nextOutputTargetRef: undefined,
    }])
    expect(entry.data.effects?.audioEffects?.[0]?.index).toBe(2)
    expect(entry.data.automation?.[0]).toMatchObject({ id: 'envelope', enabled: true, updatedAt: 2 })
    expect(entry.data.groupTrack).toMatchObject({ volume: 0.8, soloed: true })
  })

  test('rejects a replay rejection instead of creating history', () => {
    expect(readSharedUngroupResult({ status: 'rejected' })).toBeNull()
  })
})
