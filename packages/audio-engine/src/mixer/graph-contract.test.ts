import { describe, expect, test } from 'bun:test'
import {
  createEqBandParameterId,
  createDefaultAutoPanParams,
  createDefaultAutoFilterParams,
  createDefaultChorusParams,
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultEnsembleParams,
  createDefaultEqParams,
  createDefaultFlangerParams,
  createDefaultGateParams,
  createDefaultLimiterParams,
  createDefaultLoFiParams,
  createDefaultPhaserParams,
  createDefaultReverbParams,
  createDefaultSaturatorParams,
  createDefaultSpectralParams,
  createDefaultSynthParams,
  createDefaultTremoloParams,
  createDefaultUtilityParams,
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

  test('projects resolved solo topology and master gain without duplicating solo resolution', () => {
    const graph = resolveMixerGraph({
      masterVolume: 0.6,
      channels: createMixerChannels([
        { id: 'solo', kind: 'audio', name: 'Solo', clips: [], volume: 1, soloed: true },
        { id: 'other', kind: 'audio', name: 'Other', clips: [], volume: 1 },
      ]),
    })

    const snapshot = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 })
    const solo = snapshot.nodes.find((node) => node.id === 'solo')
    const other = snapshot.nodes.find((node) => node.id === 'other')

    expect(snapshot.edges.find((edge) => edge.fromNodeId === 'solo' && edge.kind === 'output')?.gain).toBe(1)
    expect(snapshot.edges.find((edge) => edge.fromNodeId === 'other' && edge.kind === 'output')?.gain).toBe(0)
    expect(solo?.mixer?.soloed).toBe(false)
    expect(other?.mixer?.soloed).toBe(false)
    expect(snapshot.nodes.find((node) => node.id === MASTER_ROUTE_TARGET)?.mixer?.gain).toBe(0.6)
  })

  test('uses shared delay automation IDs in the portable processor target list', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([{ id: 'delay-track', kind: 'audio', name: 'Delay', clips: [], volume: 1 }]),
      trackFx: {
        'delay-track': {
          instances: [{
            id: 'delay-1',
            kind: 'delay',
            params: createDefaultDelayParams(),
          }],
        },
      },
    })

    const node = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 })
      .nodes.find((entry) => entry.id === 'delay-track')

    expect(node?.processorOrder[0]?.parameterTargets).toEqual([
      { id: 'delay.timeMs', target: 5 },
      { id: 'delay.feedback', target: 6 },
      { id: 'delay.dryWet', target: 7 },
      { id: 'delay.filterHz', target: 8 },
      { id: 'delay.filterWidth', target: 9 },
      { id: 'delay.timeRightMs', target: 200 },
      { id: 'delay.offsetLeftPercent', target: 201 },
      { id: 'delay.offsetRightPercent', target: 202 },
    ])
  })

  test('projects the complete synth state through the portable session compiler', () => {
    const synthParams = createDefaultSynthParams()

    const graph = resolveMixerGraph({
      channels: createMixerChannels([
        { id: 'synth', kind: 'instrument', name: 'Synth', clips: [], volume: 1 },
      ]),
      trackFx: {
        synth: {
          instances: [],
          instrument: {
            kind: 'synth',
            instanceId: 'synth:1',
            params: {
              ...synthParams,
              ampEnvelope: { ...synthParams.ampEnvelope, releaseSec: 60 },
            },
          },
        },
      },
    })

    const node = createPortableGraphSnapshot({
      graph,
      revision: 1,
      sampleRate: 48_000,
      includeInstruments: true,
    }).nodes.find((entry) => entry.id === 'synth')

    expect(node?.kind).toBe('instrument')
    const instrument = node?.instrument
    expect(instrument?.kind).toBe('synth')

    if (!instrument || instrument.kind !== 'synth') throw new Error('Synth state was not projected.')
    expect(instrument.ampReleaseMs).toBe(60_000)
    expect(instrument.oscillators).toHaveLength(2)
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

  test('routes a sidechain to a Gate with or without its detector filter and rejects processors that are no detector', () => {
    const channels = createMixerChannels([
      { id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 },
      { id: 'target', kind: 'audio', name: 'Target', clips: [], volume: 1 },
    ])

    const route = { sourceTrackId: 'source', targetTrackId: 'target', effectInstanceId: 'target-effect' }
    const gate = createDefaultGateParams()


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

    for (const filter of [false, true]) {
      const gateGraph = resolveMixerGraph({
        channels,
        trackFx: {
          target: {
            instances: [{
              id: 'target-effect',
              kind: 'gate',
              params: { version: 1, state: { ...gate, sidechain: { ...gate.sidechain, enabled: filter } } },
            }],
          },
        },
      })

      expect(createPortableGraphSnapshot({
        graph: gateGraph,
        revision: 1,
        sampleRate: 48_000,
        sidechainRoutes: [route],
      }).edges).toContainEqual(expect.objectContaining({
        sidechain: true,
        targetProcessorId: 'target-effect',
      }))
    }
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

  test('compensates sends stored without a tap like post-fader sends', () => {
    // Two sends that name no tap reach one return: the delayed source arrives through a limiter's lookahead, the other has no
    // latency. The core accepts a graph only when each edge carries the convergence latency minus its own arrival.
    const graph = resolveMixerGraph({
      channels: createMixerChannels([
        { id: 'slow', kind: 'audio', name: 'Slow', clips: [], volume: 1, sends: [{ targetId: 'space', amount: 0.5 }] },
        { id: 'fast', kind: 'audio', name: 'Fast', clips: [], volume: 1, sends: [{ targetId: 'space', amount: 0.5 }] },
        { id: 'space', kind: 'audio', name: 'Space', clips: [], volume: 1, channelRole: 'return' },
      ]),
      trackFx: { slow: { instances: [{ id: 'limiter', kind: 'limiter', params: { version: 1, state: createDefaultLimiterParams() } }] } },
    })

    const snapshot = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 })
    const lookahead = snapshot.nodes.find((node) => node.id === 'slow')?.latencyFrames ?? 0
    expect(lookahead).toBeGreaterThan(0)
    expect(snapshot.edges.filter((edge) => edge.toNodeId === 'space').map((edge) => [edge.fromNodeId, edge.tap, edge.pdcDelayFrames]))
      .toEqual([['slow', 'post-fader', 0], ['fast', 'post-fader', lookahead]])
  })

  test('projects portable Saturator and EQ Eight state without legacy fallback', () => {
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
      ['saturator', 2, 60],
      ['eq', 3, 408],
    ])
    // Curve A keeps its targets 45-68; curve B (bands 9-16) sits at 144-167, then Scale and Output.
    expect(snapshot.nodes[0]?.processorOrder[1]?.parameterTargets).toEqual([
      ...createDefaultEqParams().bands.flatMap((band, index) => {
        const base = index < 8 ? 45 + index * 3 : 144 + (index - 8) * 3

        return [
          { id: createEqBandParameterId(band.id, 'frequencyHz'), target: base },
          { id: createEqBandParameterId(band.id, 'gainDb'), target: base + 1 },
          { id: createEqBandParameterId(band.id, 'q'), target: base + 2 },
        ]
      }),
      { id: 'eq.scale', target: 168 },
      { id: 'eq.outputDb', target: 169 },
    ])
    expect(snapshot.nodes[0]?.processorOrder[1]?.latencyFrames).toBe(3)
    expect(snapshot.nodes[0]?.processorOrder[1]?.stateVersion).toBe(2)
    expect(snapshot.nodes[0]?.processorOrder[0]?.parameterTargets).toEqual([
      { id: 'saturator.driveDb', target: 69 },
      { id: 'saturator.colorFrequencyHz', target: 70 },
      { id: 'saturator.outputDb', target: 72 },
      { id: 'saturator.dryWet', target: 73 },
      { id: 'saturator.colorHighDb', target: 203 },
      { id: 'saturator.colorLowDb', target: 204 },
      { id: 'saturator.colorWidth', target: 205 },
      { id: 'saturator.bassThresholdDb', target: 206 },
      { id: 'saturator.warpDepth', target: 207 },
      { id: 'saturator.warpPeriod', target: 208 },
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
      ['chorus', 4, 52, 0, 768, [
        { id: 'chorus.delayMs', target: 74 }, { id: 'chorus.depthMs', target: 75 },
        { id: 'chorus.rateHz', target: 76 }, { id: 'chorus.feedback', target: 77 },
        { id: 'chorus.stereoPhase', target: 78 }, { id: 'chorus.mix', target: 79 },
        { id: 'chorus.safeBassHz', target: 177 }, { id: 'chorus.width', target: 178 }, { id: 'chorus.outputDb', target: 179 },
      ]],
      ['flanger', 5, 52, 0, 1_080, [
        { id: 'flanger.delayMs', target: 80 }, { id: 'flanger.depthMs', target: 81 },
        { id: 'flanger.rateHz', target: 82 }, { id: 'flanger.feedback', target: 83 },
        { id: 'flanger.stereoPhase', target: 84 }, { id: 'flanger.mix', target: 85 },
        { id: 'flanger.safeBassHz', target: 180 }, { id: 'flanger.width', target: 181 }, { id: 'flanger.outputDb', target: 182 },
      ]],
      ['phaser', 6, 56, 0, 48, [
        { id: 'phaser.centerHz', target: 86 }, { id: 'phaser.depthOctaves', target: 87 },
        { id: 'phaser.rateHz', target: 88 }, { id: 'phaser.feedback', target: 89 },
        { id: 'phaser.stereoPhase', target: 90 }, { id: 'phaser.mix', target: 91 },
        { id: 'phaser.spreadOctaves', target: 183 }, { id: 'phaser.blend', target: 184 },
        { id: 'phaser.safeBassHz', target: 185 }, { id: 'phaser.outputDb', target: 186 },
      ]],
      ['tremolo', 7, 40, 0, 0, [
        { id: 'tremolo.rateHz', target: 92 }, { id: 'tremolo.depth', target: 93 },
        { id: 'tremolo.shape', target: 94 }, { id: 'tremolo.phase', target: 95 },
        { id: 'tremolo.stereoPhase', target: 187 },
      ]],
      ['autopan', 8, 40, 0, 0, [
        { id: 'autopan.rateHz', target: 96 }, { id: 'autopan.depth', target: 97 },
        { id: 'autopan.shape', target: 98 }, { id: 'autopan.phase', target: 99 },
        { id: 'autopan.stereoPhase', target: 188 },
      ]],
      ['ensemble', 9, 56, 0, 1_152, [
        { id: 'ensemble.delayMs', target: 100 }, { id: 'ensemble.depthMs', target: 101 },
        { id: 'ensemble.rateHz', target: 102 }, { id: 'ensemble.spread', target: 103 },
        { id: 'ensemble.mix', target: 104 },
        { id: 'ensemble.fastDepthMs', target: 189 }, { id: 'ensemble.fastRateHz', target: 190 },
        { id: 'ensemble.safeBassHz', target: 191 }, { id: 'ensemble.width', target: 192 }, { id: 'ensemble.outputDb', target: 193 },
      ]],
    ])
  })

  test('declares the Through-zero Flanger dry-path delay as latency, bypassed or not, and no other mode', () => {
    const projected = (mode: 'flanger' | 'throughZero', enabled: boolean) => createPortableGraphSnapshot({
      graph: resolveMixerGraph({
        channels: createMixerChannels([{ id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 }]),
        trackFx: { source: { instances: [{ id: 'flanger', kind: 'flanger', params: { version: 1, state: { ...createDefaultFlangerParams(), mode, enabled } } }] } },
      }),
      revision: 1,
      sampleRate: 48_000,
    }).nodes[0]?.processorOrder.map((processor) => processor.latencyFrames)

    // ChorusKernel::kThroughZeroDryMs = 5 ms: 240 frames at 48 kHz, declared even while the device is off so the core's own check agrees.
    expect(projected('throughZero', true)).toEqual([240])
    expect(projected('throughZero', false)).toEqual([240])
    expect(projected('flanger', true)).toEqual([0])
  })

  test('projects normalized dynamics processor envelopes without changing persisted forms', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([{ id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 }]),
      trackFx: {
        source: {
          instances: [
            { id: 'utility', kind: 'utility', params: { version: 1, state: createDefaultUtilityParams() } },
            { id: 'gate', kind: 'gate', params: { version: 1, state: createDefaultGateParams() } },
            { id: 'compressor', kind: 'compressor', params: createDefaultCompressorParams() },
            { id: 'limiter', kind: 'limiter', params: { version: 1, state: createDefaultLimiterParams() } },
          ],
        },
      },
    })

    const processors = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 }).nodes[0]?.processorOrder
    expect(processors?.map((processor) => [processor.kind, processor.kindId, processor.state.byteLength, processor.latencyFrames, processor.parameterTargets])).toEqual([
      ['utility', 1, 40, 0, [
        { id: 'utility.gainDb', target: 1 },
        { id: 'utility.pan', target: 2 },
        { id: 'utility.balance', target: 3 },
        { id: 'utility.width', target: 4 },
      ]],
      ['gate', 10, 76, 0, [
        { id: 'gate.thresholdDb', target: 105 },
        { id: 'gate.ratio', target: 106 },
        { id: 'gate.attackMs', target: 107 },
        { id: 'gate.holdMs', target: 108 },
        { id: 'gate.releaseMs', target: 109 },
        { id: 'gate.hysteresisDb', target: 110 },
        { id: 'gate.rangeDb', target: 111 },
        { id: 'gate.link', target: 113 },
        { id: 'gate.sidechain.frequencyHz', target: 114 },
        { id: 'gate.sidechain.q', target: 115 },
        { id: 'gate.sidechain.gainDb', target: 171 },
        { id: 'gate.sidechain.mix', target: 172 },
      ]],
      ['compressor', 11, 76, 0, [
        { id: 'compressor.thresholdDb', target: 116 },
        { id: 'compressor.ratio', target: 117 },
        { id: 'compressor.attackMs', target: 118 },
        { id: 'compressor.releaseMs', target: 119 },
        { id: 'compressor.makeupDb', target: 120 },
        { id: 'compressor.outputDb', target: 121 },
        { id: 'compressor.dryWet', target: 122 },
        { id: 'compressor.kneeDb', target: 123 },
        { id: 'compressor.sidechain.frequencyHz', target: 125 },
        { id: 'compressor.sidechain.q', target: 126 },
      ]],
      ['limiter', 12, 28, 144, [
        { id: 'limiter.ceiling', target: 127 },
        { id: 'limiter.release', target: 128 },
        { id: 'limiter.link', target: 130 },
        { id: 'limiter.gainDb', target: 170 },
      ]],
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
            { id: 'delay', kind: 'delay', params: { ...createDefaultDelayParams(), divisionLeft: '1/4', feedback: 0.5 } },
            { id: 'reverb', kind: 'reverb', params: { ...createDefaultReverbParams(), decaySec: 2 } },
          ],
        },
      },
    })

    const processors = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000, bpm: 120 }).nodes[0]?.processorOrder
    expect(processors?.map((processor) => [processor.kind, processor.kindId, processor.state.byteLength, processor.latencyFrames, processor.parameterTargets])).toEqual([
      ['delay', 13, 80, 0, [
        { id: 'delay.timeMs', target: 5 },
        { id: 'delay.feedback', target: 6 },
        { id: 'delay.dryWet', target: 7 },
        { id: 'delay.filterHz', target: 8 },
        { id: 'delay.filterWidth', target: 9 },
        { id: 'delay.timeRightMs', target: 200 },
        { id: 'delay.offsetLeftPercent', target: 201 },
        { id: 'delay.offsetRightPercent', target: 202 },
      ]],
      ['reverb', 14, 124, 0, [
        { id: 'reverb.wet', target: 10 },
        { id: 'reverb.preDelayMs', target: 11 },
        { id: 'reverb.lowCutHz', target: 12 },
        { id: 'reverb.highCutHz', target: 13 },
        { id: 'reverb.stereoWidth', target: 14 },
        { id: 'reverb.decaySec', target: 132 },
        { id: 'reverb.reflections', target: 133 },
        { id: 'reverb.reflectionModAmountMs', target: 134 },
        { id: 'reverb.reflectionModRateHz', target: 135 },
        { id: 'reverb.reflectionShape', target: 136 },
        { id: 'reverb.diffuse', target: 137 },
        { id: 'reverb.size', target: 138 },
        { id: 'reverb.diffusion', target: 139 },
        { id: 'reverb.lowShelfHz', target: 141 },
        { id: 'reverb.highShelfHz', target: 142 },
        { id: 'reverb.chorusAmountMs', target: 173 },
        { id: 'reverb.chorusRateHz', target: 174 },
        { id: 'reverb.lowShelfDb', target: 175 },
        { id: 'reverb.highShelfDb', target: 176 },
      ]],
    ])
    expect(processors?.[0]?.tailFrames).toBe(24_000 * 14)
    expect(processors?.[1]?.tailFrames).toBe(Math.ceil(48_000 * 2.17))
  })

  test('projects exact AutoFilter and LoFi target arrays', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([{ id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 }]),
      trackFx: {
        source: {
          instances: [
            { id: 'autofilter', kind: 'autofilter', params: { version: 1, state: createDefaultAutoFilterParams() } },
            { id: 'lofi', kind: 'lofi', params: { version: 1, state: createDefaultLoFiParams() } },
          ],
        },
      },
    })

    const processors = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 })
      .nodes[0]?.processorOrder

    expect(processors?.map((processor) => processor.parameterTargets)).toEqual([
      [
        { id: 'autofilter.frequencyHz', target: 30 },
        { id: 'autofilter.resonance', target: 31 },
        { id: 'autofilter.driveDb', target: 32 },
        { id: 'autofilter.mix', target: 33 },
        { id: 'autofilter.envelope.amountOctaves', target: 34 },
        { id: 'autofilter.envelope.attackMs', target: 35 },
        { id: 'autofilter.envelope.releaseMs', target: 36 },
        { id: 'autofilter.lfo.rateHz', target: 37 },
        { id: 'autofilter.lfo.depthOctaves', target: 38 },
        { id: 'autofilter.lfo.phaseOffset', target: 39 },
        { id: 'autofilter.lfo.stereoPhase', target: 40 },
        { id: 'autofilter.outputDb', target: 143 },
      ],
      [
        { id: 'lofi.sampleRateHz', target: 209 },
        { id: 'lofi.jitter', target: 42 },
        { id: 'lofi.noiseDb', target: 43 },
        { id: 'lofi.mix', target: 44 },
        { id: 'lofi.bitDepth', target: 131 },
      ],
    ])
  })

  test('projects a full seventeen-processor master chain', () => {
    const graph = resolveMixerGraph({
      masterVolume: 1,
      channels: createMixerChannels([{ id: 'source', kind: 'audio', name: 'Source', clips: [], volume: 1 }]),
      masterFxInstances: [
          { id: 'utility-1', kind: 'utility', params: { version: 1, state: createDefaultUtilityParams() } },
          { id: 'saturator-1', kind: 'saturator', params: createDefaultSaturatorParams() },
          { id: 'eq-1', kind: 'eq', params: createDefaultEqParams() },
          { id: 'chorus-1', kind: 'chorus', params: { version: 1, state: createDefaultChorusParams() } },
          { id: 'flanger-1', kind: 'flanger', params: { version: 1, state: createDefaultFlangerParams() } },
          { id: 'phaser-1', kind: 'phaser', params: { version: 1, state: createDefaultPhaserParams() } },
          { id: 'tremolo-1', kind: 'tremolo', params: { version: 1, state: createDefaultTremoloParams() } },
          { id: 'autopan-1', kind: 'autopan', params: { version: 1, state: createDefaultAutoPanParams() } },
          { id: 'ensemble-1', kind: 'ensemble', params: { version: 1, state: createDefaultEnsembleParams() } },
          { id: 'gate-1', kind: 'gate', params: { version: 1, state: createDefaultGateParams() } },
          { id: 'compressor-1', kind: 'compressor', params: createDefaultCompressorParams() },
          { id: 'limiter-1', kind: 'limiter', params: { version: 1, state: createDefaultLimiterParams() } },
          { id: 'lofi-1', kind: 'lofi', params: { version: 1, state: createDefaultLoFiParams() } },
          { id: 'delay-1', kind: 'delay', params: createDefaultDelayParams() },
          { id: 'reverb-1', kind: 'reverb', params: createDefaultReverbParams() },
          { id: 'autofilter-1', kind: 'autofilter', params: { version: 1, state: createDefaultAutoFilterParams() } },
          { id: 'spectral-1', kind: 'spectral', params: { version: 1, state: createDefaultSpectralParams() } },
      ],
    })

    const master = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 })
      .nodes.find((node) => node.id === MASTER_ROUTE_TARGET)

    expect(master?.processorOrder).toHaveLength(17)
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
    expect(processor?.parameterTargets).toEqual([
      { id: 'spectral.freeze', target: 15 },
      { id: 'spectral.gateThresholdDb', target: 16 },
      { id: 'spectral.gateAttackMs', target: 17 },
      { id: 'spectral.gateReleaseMs', target: 18 },
      { id: 'spectral.morph', target: 19 },
      { id: 'spectral.binShift', target: 20 },
      { id: 'spectral.blur', target: 21 },
      { id: 'spectral.harmonicPercussiveBalance', target: 22 },
      { id: 'spectral.noiseReduction', target: 23 },
      { id: 'spectral.profileLearn', target: 24 },
      { id: 'spectral.mix', target: 25 },
    ])
  })

})
