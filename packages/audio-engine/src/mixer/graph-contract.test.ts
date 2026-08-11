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
      { id: 'delay.lowCutHz', target: 8 },
      { id: 'delay.highCutHz', target: 9 },
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
    expect(snapshot.nodes[0]?.processorOrder[1]?.parameterTargets).toEqual(
      createDefaultEqParams().bands.flatMap((band, index) => [
        { id: createEqBandParameterId(band.id, 'frequencyHz'), target: 45 + index * 3 },
        { id: createEqBandParameterId(band.id, 'gainDb'), target: 46 + index * 3 },
        { id: createEqBandParameterId(band.id, 'q'), target: 47 + index * 3 },
      ]),
    )
    expect(snapshot.nodes[0]?.processorOrder[0]?.parameterTargets).toEqual([
      { id: 'saturator.driveDb', target: 69 },
      { id: 'saturator.colorFrequencyHz', target: 70 },
      { id: 'saturator.colorAmount', target: 71 },
      { id: 'saturator.outputDb', target: 72 },
      { id: 'saturator.dryWet', target: 73 },
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
      ['chorus', 4, 28, 0, 768, [
        { id: 'chorus.delayMs', target: 74 }, { id: 'chorus.depthMs', target: 75 },
        { id: 'chorus.rateHz', target: 76 }, { id: 'chorus.feedback', target: 77 },
        { id: 'chorus.stereoPhase', target: 78 }, { id: 'chorus.mix', target: 79 },
      ]],
      ['flanger', 5, 28, 0, 1_080, [
        { id: 'flanger.delayMs', target: 80 }, { id: 'flanger.depthMs', target: 81 },
        { id: 'flanger.rateHz', target: 82 }, { id: 'flanger.feedback', target: 83 },
        { id: 'flanger.stereoPhase', target: 84 }, { id: 'flanger.mix', target: 85 },
      ]],
      ['phaser', 6, 32, 0, 48, [
        { id: 'phaser.centerHz', target: 86 }, { id: 'phaser.depthOctaves', target: 87 },
        { id: 'phaser.rateHz', target: 88 }, { id: 'phaser.feedback', target: 89 },
        { id: 'phaser.stereoPhase', target: 90 }, { id: 'phaser.mix', target: 91 },
      ]],
      ['tremolo', 7, 24, 0, 0, [
        { id: 'tremolo.rateHz', target: 92 }, { id: 'tremolo.depth', target: 93 },
        { id: 'tremolo.shape', target: 94 }, { id: 'tremolo.phase', target: 95 },
      ]],
      ['autopan', 8, 24, 0, 0, [
        { id: 'autopan.rateHz', target: 96 }, { id: 'autopan.depth', target: 97 },
        { id: 'autopan.shape', target: 98 }, { id: 'autopan.phase', target: 99 },
      ]],
      ['ensemble', 9, 28, 0, 1_152, [
        { id: 'ensemble.delayMs', target: 100 }, { id: 'ensemble.depthMs', target: 101 },
        { id: 'ensemble.rateHz', target: 102 }, { id: 'ensemble.spread', target: 103 },
        { id: 'ensemble.mix', target: 104 },
      ]],
    ])
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
      ['gate', 10, 60, 96, [
        { id: 'gate.thresholdDb', target: 105 },
        { id: 'gate.ratio', target: 106 },
        { id: 'gate.attackMs', target: 107 },
        { id: 'gate.holdMs', target: 108 },
        { id: 'gate.releaseMs', target: 109 },
        { id: 'gate.hysteresisDb', target: 110 },
        { id: 'gate.rangeDb', target: 111 },
        { id: 'gate.lookaheadMs', target: 112 },
        { id: 'gate.link', target: 113 },
        { id: 'gate.sidechain.frequencyHz', target: 114 },
        { id: 'gate.sidechain.q', target: 115 },
      ]],
      ['compressor', 11, 72, 480, [
        { id: 'compressor.thresholdDb', target: 116 },
        { id: 'compressor.ratio', target: 117 },
        { id: 'compressor.attackMs', target: 118 },
        { id: 'compressor.releaseMs', target: 119 },
        { id: 'compressor.makeupDb', target: 120 },
        { id: 'compressor.outputDb', target: 121 },
        { id: 'compressor.dryWet', target: 122 },
        { id: 'compressor.kneeDb', target: 123 },
        { id: 'compressor.lookaheadMs', target: 124 },
        { id: 'compressor.sidechain.frequencyHz', target: 125 },
        { id: 'compressor.sidechain.q', target: 126 },
      ]],
      ['limiter', 12, 24, 240, [
        { id: 'limiter.ceiling', target: 127 },
        { id: 'limiter.release', target: 128 },
        { id: 'limiter.lookaheadMs', target: 129 },
        { id: 'limiter.link', target: 130 },
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
            { id: 'delay', kind: 'delay', params: { ...createDefaultDelayParams(), mode: 'sync', syncDivision: '1/4', feedback: 0.5 } },
            { id: 'reverb', kind: 'reverb', params: { ...createDefaultReverbParams(), decaySec: 2 } },
          ],
        },
      },
    })
    const processors = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000, bpm: 120 }).nodes[0]?.processorOrder
    expect(processors?.map((processor) => [processor.kind, processor.kindId, processor.state.byteLength, processor.latencyFrames, processor.parameterTargets])).toEqual([
      ['delay', 13, 32, 0, [
        { id: 'delay.timeMs', target: 5 },
        { id: 'delay.feedback', target: 6 },
        { id: 'delay.dryWet', target: 7 },
        { id: 'delay.lowCutHz', target: 8 },
        { id: 'delay.highCutHz', target: 9 },
      ]],
      ['reverb', 14, 72, 0, [
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
        { id: 'reverb.density', target: 140 },
        { id: 'reverb.diffusionLowCutHz', target: 141 },
        { id: 'reverb.diffusionHighCutHz', target: 142 },
      ]],
    ])
    expect(processors?.[0]?.tailFrames).toBe(24_000 * 14)
    expect(processors?.[1]?.tailFrames).toBe(48_000 * 2.02)
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
      ],
      [
        { id: 'lofi.sampleRateRatio', target: 41 },
        { id: 'lofi.jitter', target: 42 },
        { id: 'lofi.noiseDb', target: 43 },
        { id: 'lofi.mix', target: 44 },
        { id: 'lofi.bitDepth', target: 131 },
      ],
    ])
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
