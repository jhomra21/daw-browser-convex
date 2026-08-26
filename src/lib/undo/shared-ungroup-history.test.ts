import { describe, expect, test } from 'bun:test'
import type { Track } from '@daw-browser/timeline-core/types'
import { createDefaultDelayParams, createDefaultEqParams } from '@daw-browser/shared'

import { buildTrackDeleteHistoryEntry, buildTrackUngroupHistoryEntry } from './builders'
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
        name: 'Committed group name',
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
      sidechainRoutes: [],
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
    expect(entry.data.groupTrack).toMatchObject({ name: 'Committed group name', volume: 0.8, soloed: true })
  })

  test('rejects a replay rejection instead of creating history', () => {
    expect(readSharedUngroupResult({ status: 'rejected' })).toBeNull()
  })

  test('strictly parses committed sidechain routes and preserves legacy results without them', () => {
    const result = readSharedUngroupResult({
      status: 'applied',
      group: { index: 0, volume: 1, muted: false, soloed: false, sends: [] },
      children: [],
      effects: [],
      automation: [],
      sidechainRoutes: [{
        sourceTrackId: 'group',
        targetTrackId: 'bass',
        effectInstanceId: 'compressor:bass',
      }],
    })
    expect(result?.sidechainRoutes).toEqual([{
      sourceTrackId: 'group',
      targetTrackId: 'bass',
      effectInstanceId: 'compressor:bass',
    }])
    expect(readSharedUngroupResult({
      status: 'applied',
      group: { index: 0, volume: 1, muted: false, soloed: false, sends: [] },
      children: [],
      effects: [],
      automation: [],
      sidechainRoutes: [{ sourceTrackId: 'group', effectInstanceId: 42 }],
    })).toBeNull()
    expect(readSharedUngroupResult({
      status: 'applied',
      group: { index: 0, volume: 1, muted: false, soloed: false, sends: [] },
      children: [],
      effects: [],
      automation: [],
    })?.sidechainRoutes).toEqual([])
  })

  test('preserves duplicate effect automation by exact instance identity', () => {
    const group = track('group', { channelRole: 'group' })
    const result = readSharedUngroupResult({
      status: 'applied',
      group: { index: 0, volume: 1, muted: false, soloed: false, sends: [] },
      children: [],
      effects: [
        { type: 'delay', instanceId: 'delay-a', index: 0, params: createDefaultDelayParams() },
        { type: 'delay', instanceId: 'delay-b', index: 1, params: createDefaultDelayParams() },
      ],
      automation: [
        { effectInstanceId: 'delay-a', parameterId: 'delay.feedback', enabled: true, points: [], updatedAt: 1 },
        { effectInstanceId: 'delay-b', parameterId: 'delay.feedback', enabled: true, points: [], updatedAt: 2 },
      ],
    })
    if (!result) throw new Error('Expected valid ungroup result')
    const entry = buildCommittedSharedUngroupHistoryEntry({
      projectId: 'project',
      tracks: [group],
      groupTrack: group,
      effects: { audioEffects: [] },
      automation: [
        { id: 'a', projectId: 'project', target: { kind: 'track', trackId: 'group', effectInstanceId: 'delay-a' }, targetKey: 'a', parameterId: 'delay.feedback', enabled: true, points: [], updatedAt: 1 },
        { id: 'b', projectId: 'project', target: { kind: 'track', trackId: 'group', effectInstanceId: 'delay-b' }, targetKey: 'b', parameterId: 'delay.feedback', enabled: true, points: [], updatedAt: 2 },
      ],
      result,
    })
    expect(entry.data.automation?.map((envelope) => envelope.target.effectInstanceId)).toEqual(['delay-a', 'delay-b'])
  })

  test('snapshots sidechain routes by track history references', () => {
    const group = track('group', { historyRef: 'group-ref', channelRole: 'group' })
    const source = track('source', { historyRef: 'source-ref' })
    const route = { sourceTrackId: 'source', targetTrackId: 'group', effectInstanceId: 'compressor:group' }

    expect(buildTrackDeleteHistoryEntry({
      projectId: 'project',
      track: group,
      tracks: [source, group],
      sidechainRoutes: [route],
    }).data.sidechainRoutes).toEqual([{
      sourceTrackRef: 'source-ref',
      targetTrackRef: 'group-ref',
      effectInstanceId: 'compressor:group',
    }])
    expect(buildTrackUngroupHistoryEntry({
      projectId: 'project',
      tracks: [source, group],
      groupTrack: group,
      childTrackIds: [],
      sidechainRoutes: [route],
    }).data.sidechainRoutes).toEqual([{
      sourceTrackRef: 'source-ref',
      targetTrackRef: 'group-ref',
      effectInstanceId: 'compressor:group',
    }])
  })

  test('uses committed sidechain routes for both group endpoints', () => {
    const group = track('group', { historyRef: 'group-ref', channelRole: 'group' })
    const source = track('source', { historyRef: 'source-ref' })
    const target = track('target', { historyRef: 'target-ref' })
    const result = readSharedUngroupResult({
      status: 'applied',
      group: { index: 0, volume: 1, muted: false, soloed: false, sends: [] },
      children: [],
      effects: [],
      automation: [],
      sidechainRoutes: [
        { sourceTrackId: 'group', targetTrackId: 'target', effectInstanceId: 'compressor:target' },
        { sourceTrackId: 'source', targetTrackId: 'group', effectInstanceId: 'compressor:group' },
      ],
    })
    if (!result) throw new Error('Expected valid ungroup result')

    const entry = buildCommittedSharedUngroupHistoryEntry({
      projectId: 'project',
      tracks: [source, group, target],
      groupTrack: group,
      effects: {},
      automation: [],
      result,
    })

    expect(entry.data.sidechainRoutes).toEqual([{
      sourceTrackRef: 'group-ref',
      targetTrackRef: 'target-ref',
      effectInstanceId: 'compressor:target',
    }, {
      sourceTrackRef: 'source-ref',
      targetTrackRef: 'group-ref',
      effectInstanceId: 'compressor:group',
    }])
  })
})
