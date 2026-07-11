import { describe, expect, test } from 'bun:test'
import { parseSharedTimelineOperation, readSharedTimelineOperationTargets, type SharedTimelineOperation } from './shared-timeline-operations'

describe('shared timeline operations', () => {
  test('roundtrips exact external sidechain routes', () => {
    const operation: SharedTimelineOperation = {
      kind: 'sidechains.setRoute',
      payload: {
        projectId: 'project-1',
        sourceTrackId: 'source',
        targetTrackId: 'target',
        effectInstanceId: 'compressor-2',
      },
    }
    expect(parseSharedTimelineOperation(operation)).toEqual(operation)
    expect(readSharedTimelineOperationTargets(operation)).toEqual({
      trackIds: new Set(['source', 'target']),
      clipIds: new Set(),
    })
    expect(parseSharedTimelineOperation({
      kind: 'sidechains.setRoute',
      payload: { projectId: 'project-1', sourceTrackId: 'source', targetTrackId: 'target', effectInstanceId: '' },
    })).toBeNull()
    expect(parseSharedTimelineOperation({
      kind: 'sidechains.removeRoute',
      payload: { projectId: 'project-1', targetTrackId: 'target', effectInstanceId: 'compressor-2' },
    })).toEqual({
      kind: 'sidechains.removeRoute',
      payload: { projectId: 'project-1', targetTrackId: 'target', effectInstanceId: 'compressor-2' },
    })
    expect(readSharedTimelineOperationTargets({
      kind: 'sidechains.removeRoute',
      payload: { projectId: 'project-1', targetTrackId: 'target', effectInstanceId: 'compressor-2' },
    })).toEqual({ trackIds: new Set(['target']), clipIds: new Set() })
  })

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

  test('accepts only valid clip colors', () => {
    expect(parseSharedTimelineOperation({
      kind: 'clips.setColor',
      payload: { clipId: 'clip-1', color: '#22c55e' },
    })).toEqual({
      kind: 'clips.setColor',
      payload: { clipId: 'clip-1', color: '#22c55e' },
    })
    expect(parseSharedTimelineOperation({
      kind: 'clips.setColor',
      payload: { clipId: 'clip-1', color: 'clip-midi' },
    })).toEqual({
      kind: 'clips.setColor',
      payload: { clipId: 'clip-1', color: 'clip-midi' },
    })
    expect(parseSharedTimelineOperation({
      kind: 'clips.setColor',
      payload: { clipId: 'clip-1', color: 'timeline-surface' },
    })).toBeNull()
  })

  test('rejects invalid clip colors in batch color operations', () => {
    expect(parseSharedTimelineOperation({
      kind: 'tracks.applyColorBatch',
      payload: {
        trackUpdates: [],
        clipUpdates: [{ clipId: 'clip-1', color: '#22c55e' }],
      },
    })).toEqual({
      kind: 'tracks.applyColorBatch',
      payload: {
        trackUpdates: [],
        clipUpdates: [{ clipId: 'clip-1', color: '#22c55e' }],
      },
    })
    expect(parseSharedTimelineOperation({
      kind: 'tracks.applyColorBatch',
      payload: {
        trackUpdates: [],
        clipUpdates: [{ clipId: 'clip-1', color: 'timeline-surface' }],
      },
    })).toBeNull()
  })

  test('rejects malformed effect metadata when restoring a dissolved group', () => {
    const payload: Extract<SharedTimelineOperation, { kind: 'tracks.restoreUngroup' }>['payload'] = {
      group: { index: 1, volume: 0.8, sends: [] },
      children: [{ trackId: 'track-1', outputToGroup: true }],
      effects: [{
        type: 'arpeggiator',
        params: { enabled: true, pattern: 'up', rate: '1/4', octaves: 1, gate: 0.8, hold: false },
      }],
      automation: [],
    }
    expect(parseSharedTimelineOperation({
      kind: 'tracks.restoreUngroup',
      payload,
    })).toEqual({ kind: 'tracks.restoreUngroup', payload })
    expect(parseSharedTimelineOperation({
      kind: 'tracks.restoreUngroup',
      payload: {
        ...payload,
        effects: [{
          type: 'arpeggiator',
          index: '0',
          params: { enabled: true, pattern: 'up', rate: '1/4', octaves: 1, gate: 0.8, hold: false },
        }],
      },
    })).toBeNull()
    expect(parseSharedTimelineOperation({
      kind: 'tracks.restoreUngroup',
      payload: {
        ...payload,
        effects: [{ type: 'arpeggiator', params: {} }],
      },
    })).toBeNull()
  })

  test('preserves ungroup operation identities for durable retries', () => {
    const operation = parseSharedTimelineOperation({
      kind: 'tracks.ungroup',
      payload: { groupId: 'group-1', operationId: 'operation-1' },
    })
    expect(operation).toEqual({
      kind: 'tracks.ungroup',
      payload: { groupId: 'group-1', operationId: 'operation-1' },
    })
    if (!operation) throw new Error('Expected tracks.ungroup operation to parse')
    expect(readSharedTimelineOperationTargets(operation).trackIds.size).toBe(0)
  })
})
