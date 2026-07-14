import { describe, expect, test } from 'bun:test'
import { parseSharedTimelineOperation, readSharedTimelineOperationTargets, type SharedTimelineOperation } from './shared-timeline-operations'

describe('shared timeline operations', () => {
  test('roundtrips synth parameters only with a durable instance identity', () => {
    const operation = {
      kind: 'effects.setSynthParams',
      payload: {
        trackId: 'track-1',
        instanceId: 'instrument:synth-1',
        params: { wave1: 'sine', wave2: 'square' },
      },
    }
    expect(parseSharedTimelineOperation(operation)).toEqual({
      kind: 'effects.setSynthParams',
      payload: {
        trackId: 'track-1',
        instanceId: 'instrument:synth-1',
        params: { wave1: 'sine', wave2: 'square' },
      },
    })
    expect(parseSharedTimelineOperation({
      kind: 'effects.setSynthParams',
      payload: { trackId: 'track-1', params: operation.payload.params },
    })).toBeNull()
  })

  test('roundtrips canonical utility and gate envelopes with required instance ids', () => {
    const utility = {
      kind: 'effects.setUtilityParams',
      payload: { trackId: 'track-1', instanceId: 'utility-1', params: { version: 1, state: { gainDb: 3 } } },
    }
    expect(parseSharedTimelineOperation(utility)).toEqual({
      kind: 'effects.setUtilityParams',
      payload: {
        trackId: 'track-1',
        instanceId: 'utility-1',
        params: {
          version: 1,
          state: {
            enabled: true, gainDb: 3, polarity: 'normal', inputMode: 'stereo', pan: 0,
            balance: 0, width: 1, matrix: 'stereo', swap: false, dcBlock: true,
          },
        },
      },
    })
    expect(parseSharedTimelineOperation({
      kind: 'effects.setGateParams',
      payload: { trackId: 'track-1', instanceId: '', params: { version: 1, state: {} } },
    })).toBeNull()
  })

  test('roundtrips normalized modulation envelopes with exact instance identities', () => {
    const first = parseSharedTimelineOperation({
      kind: 'effects.setModulationParams',
      payload: {
        trackId: 'track-1',
        effect: 'autofilter',
        instanceId: 'autofilter-a',
        params: { version: 1, state: { cutoffHz: 740, envelope: { amount: 0.4 }, lfo: { rateHz: 2 } } },
      },
    })
    const second = parseSharedTimelineOperation({
      kind: 'effects.setModulationParams',
      payload: {
        trackId: 'track-1',
        effect: 'autofilter',
        instanceId: 'autofilter-b',
        params: { version: 1, state: { cutoffHz: 2400 } },
      },
    })
    expect(first?.kind === 'effects.setModulationParams' ? first.payload.instanceId : undefined).toBe('autofilter-a')
    expect(second?.kind === 'effects.setModulationParams' ? second.payload.instanceId : undefined).toBe('autofilter-b')
    expect(first).not.toEqual(second)
    if (!first) throw new Error('Expected autofilter operation to parse')
    expect(readSharedTimelineOperationTargets(first)).toEqual({
      trackIds: new Set(['track-1']),
      clipIds: new Set(),
    })
    expect(parseSharedTimelineOperation({
      kind: 'effects.setMasterModulationParams',
      payload: {
        effect: 'ensemble',
        instanceId: 'ensemble-1',
        params: { version: 1, state: { voices: 6, spread: 0.8 } },
      },
    })).toMatchObject({
      kind: 'effects.setMasterModulationParams',
      payload: { effect: 'ensemble', instanceId: 'ensemble-1', params: { version: 1 } },
    })
  })

  test('rejects malformed or ambiguous modulation persistence operations', () => {
    expect(parseSharedTimelineOperation({
      kind: 'effects.setModulationParams',
      payload: { trackId: 'track-1', effect: 'chorus', instanceId: '', params: { version: 1, state: {} } },
    })).toBeNull()
    expect(parseSharedTimelineOperation({
      kind: 'effects.setModulationParams',
      payload: { trackId: 'track-1', effect: 'chorus', instanceId: 'fx-1', params: { state: {} } },
    })).toBeNull()
    expect(parseSharedTimelineOperation({
      kind: 'effects.setModulationParams',
      payload: { trackId: 'track-1', effect: 'unknown', instanceId: 'fx-1', params: { version: 1, state: {} } },
    })).toBeNull()
    expect(parseSharedTimelineOperation({
      kind: 'effects.setModulationParams',
      payload: { trackId: 'track-1', instanceId: 'fx-1', params: { version: 1, state: {} } },
    })).toBeNull()
  })

  test('roundtrips spectral instances while keeping topology parameters state-only', () => {
    const operation = {
      kind: 'effects.setSpectralParams',
      payload: {
        trackId: 'track-1',
        instanceId: 'spectral-1',
        params: {
          version: 1,
          state: {
            fftSize: 4096,
            overlap: 2,
            mode: 'shift-blur',
            mix: 0.4,
          },
        },
      },
    }
    expect(parseSharedTimelineOperation(operation)).toEqual({
      kind: 'effects.setSpectralParams',
      payload: {
        trackId: 'track-1',
        instanceId: 'spectral-1',
        params: {
          version: 1,
          state: {
            enabled: true,
            fftSize: 4096,
            overlap: 2,
            mode: 'shift-blur',
            freeze: 0,
            gateThresholdDb: -60,
            gateAttackMs: 10,
            gateReleaseMs: 100,
            morph: 0,
            binShift: 0,
            blur: 0,
            harmonicPercussiveBalance: 0,
            noiseReduction: 0,
            profileLearn: 0,
            mix: 0.4,
          },
        },
      },
    })
    expect(parseSharedTimelineOperation({
      kind: 'effects.setMasterSpectralParams',
      payload: { instanceId: '', params: { version: 1, state: {} } },
    })).toBeNull()
  })

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

  test('parses restored sidechain endpoints and rejects malformed routes', () => {
    const payload: Extract<SharedTimelineOperation, { kind: 'tracks.restoreUngroup' }>['payload'] = {
      group: { index: 1, volume: 0.8, sends: [] },
      children: [{ trackId: 'track-1', outputToGroup: true }],
      effects: [],
      automation: [],
      sidechainRoutes: [{
        sourceTrackId: 'track-1',
        effectInstanceId: 'compressor-restored-group',
      }],
    }
    expect(parseSharedTimelineOperation({
      kind: 'tracks.restoreUngroup',
      payload,
    })).toEqual({ kind: 'tracks.restoreUngroup', payload })
    expect(parseSharedTimelineOperation({
      kind: 'tracks.restoreUngroup',
      payload: {
        ...payload,
        sidechainRoutes: [{
          sourceTrackId: 'track-1',
          effectInstanceId: 42,
        }],
      },
    })).toBeNull()
    expect(parseSharedTimelineOperation({
      kind: 'tracks.restoreUngroup',
      payload: {
        ...payload,
        sidechainRoutes: [{
          effectInstanceId: 'self-route',
        }],
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
