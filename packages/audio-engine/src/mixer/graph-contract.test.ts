import { describe, expect, test } from 'bun:test'
import {
  createDefaultAutoPanParams,
  createDefaultChorusParams,
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultEnsembleParams,
  createDefaultEqParams,
  createDefaultFlangerParams,
  createDefaultGateParams,
  createDefaultLimiterParams,
  createDefaultPhaserParams,
  createDefaultReverbParams,
  createDefaultSaturatorParams,
  createDefaultSpectralParams,
  createDefaultTremoloParams,
} from '@daw-browser/shared'
import { createMixerRoutingPlan, createPortableGraphSnapshot } from './graph-contract'
import { resolveMixerGraph } from './resolve-routing'
import { createMixerChannels } from './channels'
import { MASTER_ROUTE_TARGET, mixerRouteKey, resolveMixerTiming } from './resolve-timing'

describe('mixer routing plan', () => {
  test('preserves resolved channel order, gains, targets, sends, and master volume', () => {
    const graph = resolveMixerGraph({
      masterVolume: 0.8,
      channels: createMixerChannels([
        { id: 'audio', kind: 'audio', name: 'Audio', clips: [], volume: 0.5, muted: false, soloed: false, outputTargetId: 'group', sends: [{ targetId: 'return', amount: 0.25 }] },
        { id: 'group', channelRole: 'group', name: 'Group', clips: [], volume: 0.75, muted: false, soloed: false },
        { id: 'return', channelRole: 'return', name: 'Return', clips: [], volume: 1, muted: false, soloed: false },
      ]),
    })

    expect(createMixerRoutingPlan(graph)).toEqual({
      channels: [
        {
          channelId: 'audio',
          gain: 0.5,
          outputGain: 1,
          outputTargetId: 'group',
          sends: [{ targetId: 'return', amount: 0.25, tap: 'post-fader' }],
        },
        { channelId: 'group', gain: 0.75, outputGain: 1, outputTargetId: undefined, sends: [] },
        { channelId: 'return', gain: 1, outputGain: 1, outputTargetId: undefined, sends: [] },
      ],
      masterVolume: 0.8,
    })
  })

  test('projects normalized project topology and PDC declarations without becoming a routing authority', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([
        { id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1, outputTargetId: 'group', sends: [{ targetId: 'return', amount: 0.5, tap: 'pre-fx' }] },
        { id: 'group', channelRole: 'group', name: 'Group', clips: [], volume: 1 },
        { id: 'return', channelRole: 'return', name: 'Return', clips: [], volume: 1 },
      ]),
      trackFx: {
        return: {
          instances: [{
            id: 'compressor-1',
            kind: 'compressor',
            params: createDefaultCompressorParams(),
          }],
        },
      },
    })
    const snapshot = createPortableGraphSnapshot({
      graph,
      revision: 4,
      sampleRate: 48_000,
      sidechainRoutes: [{ sourceTrackId: 'source', targetTrackId: 'return', effectInstanceId: 'compressor-1' }],
    })

    expect(snapshot.revision).toBe(4)
    expect(snapshot.masterNodeId).toBe(MASTER_ROUTE_TARGET)
    expect(snapshot.nodes.map((node) => [node.id, node.kind])).toEqual([
      ['source', 'source'],
      ['group', 'group'],
      ['return', 'return'],
      [MASTER_ROUTE_TARGET, 'master'],
    ])
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      id: mixerRouteKey('source', 'return', 'send', 'pre-fx'),
      fromNodeId: 'source',
      toNodeId: 'return',
      tap: 'pre-fx',
      pdcDelayFrames: 0,
    }))
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      fromNodeId: 'source',
      toNodeId: 'return',
      sidechain: true,
      targetProcessorId: 'compressor-1',
    }))
  })

  test('strictly rejects sidechain targets without an executable legacy detector path', () => {
    const channels = createMixerChannels([
      { id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 },
      { id: 'target', kind: 'audio', name: 'Target', clips: [], volume: 1 },
    ])
    const route = { sourceTrackId: 'source', targetTrackId: 'target', effectInstanceId: 'target-effect' }
    const gate = createDefaultGateParams()
    const gateGraph = resolveMixerGraph({
      channels,
      trackFx: {
        target: {
          instances: [{ id: 'target-effect', kind: 'gate', params: { version: 1, state: gate } }],
        },
      },
    })
    expect(() => createPortableGraphSnapshot({
      graph: gateGraph,
      revision: 1,
      sampleRate: 48_000,
      sidechainRoutes: [route],
    })).toThrow('Portable Gate sidechain target "target-effect" requires its detector filter to be enabled for legacy parity.')

    const limiterGraph = resolveMixerGraph({
      channels,
      trackFx: {
        target: {
          instances: [{
            id: 'target-effect',
            kind: 'limiter',
            params: { version: 1, state: createDefaultLimiterParams() },
          }],
        },
      },
    })
    expect(() => createPortableGraphSnapshot({
      graph: limiterGraph,
      revision: 1,
      sampleRate: 48_000,
      sidechainRoutes: [route],
    })).toThrow('Portable sidechain target "target-effect" is not a supported detector processor.')

    const filteredGateGraph = resolveMixerGraph({
      channels,
      trackFx: {
        target: {
          instances: [{
            id: 'target-effect',
            kind: 'gate',
            params: { version: 1, state: { ...gate, sidechain: { ...gate.sidechain, enabled: true } } },
          }],
        },
      },
    })
    expect(createPortableGraphSnapshot({
      graph: filteredGateGraph,
      revision: 1,
      sampleRate: 48_000,
      sidechainRoutes: [route],
    }).edges).toContainEqual(expect.objectContaining({
      sidechain: true,
      targetProcessorId: 'target-effect',
    }))
  })

  test('matches the routing timing authority across deterministic acyclic projections', () => {
    let state = 0x9e3779b9
    const next = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state
    }
    for (let iteration = 1; iteration <= 10_000; iteration += 1) {
      const channelCount = 2 + next() % 5
      const channels = createMixerChannels(Array.from({ length: channelCount }, (_, index) => ({
        id: `channel-${index}`,
        kind: 'audio',
        name: `Channel ${index}`,
        clips: [],
        volume: 1,
        outputTargetId: index > 0 && next() % 2 === 0 ? `channel-${next() % index}` : undefined,
        sends: index > 0 && next() % 3 === 0
          ? [{ targetId: `channel-${next() % index}`, amount: 0.5, tap: next() % 2 === 0 ? 'pre-fx' : 'post-fader' }]
          : [],
      })))
      const graph = resolveMixerGraph({ channels })
      const snapshot = createPortableGraphSnapshot({ graph, revision: iteration, sampleRate: 48_000 })
      const timing = resolveMixerTiming(graph, 48_000)
      for (const edge of snapshot.edges) {
        expect(edge.pdcDelayFrames).toBe(timing.routeDelayFrames.get(edge.id) ?? 0)
      }
    }
  })

  test('projects portable Saturator and fixed eight-band EQ state without legacy fallback', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([
        {
          id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1,
        },
      ]),
      trackFx: {
        source: {
          instances: [
            { id: 'saturator', kind: 'saturator', params: { ...createDefaultSaturatorParams(), driveDb: 12 } },
            { id: 'eq', kind: 'eq', params: { ...createDefaultEqParams(), channelMode: 'mono' } },
          ],
        },
      },
    })
    const snapshot = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 })
    expect(snapshot.nodes[0]?.processorOrder.map((processor) => [processor.kind, processor.kindId, processor.state.byteLength])).toEqual([
      ['saturator', 2, 32],
      ['eq', 3, 200],
    ])
  })

  test('projects fixture-proven modulation state with exact zero latency and bounded tails', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([
        {
          id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1,
        },
      ]),
      trackFx: {
        source: {
          instances: [
            { id: 'chorus', kind: 'chorus', params: { version: 1, state: createDefaultChorusParams() } },
            { id: 'flanger', kind: 'flanger', params: { version: 1, state: createDefaultFlangerParams() } },
            { id: 'phaser', kind: 'phaser', params: { version: 1, state: createDefaultPhaserParams() } },
            { id: 'tremolo', kind: 'tremolo', params: { version: 1, state: createDefaultTremoloParams() } },
            { id: 'autopan', kind: 'autopan', params: { version: 1, state: createDefaultAutoPanParams() } },
            { id: 'ensemble', kind: 'ensemble', params: { version: 1, state: createDefaultEnsembleParams() } },
          ],
        },
      },
    })
    const processors = createPortableGraphSnapshot({
      graph,
      revision: 1,
      sampleRate: 48_000,
    }).nodes[0]?.processorOrder
    expect(processors?.map((processor) => [
      processor.kind,
      processor.kindId,
      processor.state.byteLength,
      processor.latencyFrames,
      processor.tailFrames,
      processor.parameterTargets,
    ])).toEqual([
      ['chorus', 4, 28, 0, 768, []],
      ['flanger', 5, 28, 0, 1_080, []],
      ['phaser', 6, 32, 0, 48, []],
      ['tremolo', 7, 24, 0, 0, []],
      ['autopan', 8, 24, 0, 0, []],
      ['ensemble', 9, 28, 0, 1_152, []],
    ])
  })

  test('projects normalized dynamics processor envelopes without changing persisted forms', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([{ id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 }]),
      trackFx: {
        source: {
          instances: [
            { id: 'gate', kind: 'gate', params: { version: 1, state: createDefaultGateParams() } },
            { id: 'compressor', kind: 'compressor', params: createDefaultCompressorParams() },
            { id: 'limiter', kind: 'limiter', params: { version: 1, state: createDefaultLimiterParams() } },
          ],
        },
      },
    })
    const processors = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 }).nodes[0]?.processorOrder
    expect(processors?.map((processor) => [processor.kind, processor.kindId, processor.state.byteLength, processor.latencyFrames])).toEqual([
      ['gate', 10, 60, 96],
      ['compressor', 11, 72, 480],
      ['limiter', 12, 24, 240],
    ])
  })

  test('normalizes disabled Compressor gain stages to a true delayed bypass', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([{ id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 }]),
      trackFx: {
        source: {
          instances: [{
            id: 'compressor',
            kind: 'compressor',
            params: { ...createDefaultCompressorParams(), enabled: false, makeupDb: 12, outputDb: 6 },
          }],
        },
      },
    })
    const processor = createPortableGraphSnapshot({
      graph,
      revision: 1,
      sampleRate: 48_000,
    }).nodes[0]?.processorOrder[0]
    if (!processor) throw new Error('Expected portable Compressor state.')
    const state = new DataView(processor.state.buffer, processor.state.byteOffset, processor.state.byteLength)
    expect(processor.bypassed).toBe(true)
    expect(state.getUint32(0, true)).toBe(0)
    expect(state.getFloat32(24, true)).toBe(0)
    expect(state.getFloat32(28, true)).toBe(0)
  })

  test('projects normalized Delay and portable Reverb profiles with declared tails', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([{ id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 }]),
      trackFx: {
        source: {
          instances: [
            { id: 'delay', kind: 'delay', params: { ...createDefaultDelayParams(), mode: 'sync', syncDivision: '1/4', feedback: 0.5 } },
            { id: 'reverb', kind: 'reverb', params: { ...createDefaultReverbParams(), decaySec: 2 } },
          ],
        },
      },
    })
    const processors = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000, bpm: 120 }).nodes[0]?.processorOrder
    expect(processors?.map((processor) => [processor.kind, processor.kindId, processor.state.byteLength, processor.latencyFrames])).toEqual([
      ['delay', 13, 32, 0],
      ['reverb', 14, 72, 0],
    ])
    expect(processors?.[0]?.tailFrames).toBe(24_000 * 14)
    expect(processors?.[1]?.tailFrames).toBe(48_000 * 2.02)
  })

  test('projects spectral state with bounded FFT timing and all generic controls', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([{ id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 }]),
      trackFx: {
        source: {
          instances: [{ id: 'spectral', kind: 'spectral', params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 512, mode: 'morph' } } }],
        },
      },
    })
    const processor = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 }).nodes[0]?.processorOrder[0]
    expect(processor).toMatchObject({ kind: 'spectral', kindId: 15, latencyFrames: 512, tailFrames: 0 })
    expect(processor?.state.byteLength).toBe(60)
    expect(processor?.parameterTargets).toHaveLength(11)
  })
})
