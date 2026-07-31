import { expect, test } from 'bun:test'
import {
  createDefaultChorusParams,
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultDrumRackParams,
  createDefaultEqParams,
  createDefaultGranularParams,
  createDefaultLimiterParams,
  createDefaultReverbParams,
  createDefaultSamplerParams,
  createDefaultSaturatorParams,
  createDefaultSynthParams,
  createDefaultUtilityParams,
  type DrumRackPadSample,
  type SamplerZone,
} from '@daw-browser/shared'
import {
  compilePortableDrumRackConfiguration,
  compilePortableGranularConfiguration,
  compilePreparedPortableSession,
  compilePortableSamplerConfiguration,
  compilePortableSessionInput,
  compilePortableSynthConfiguration,
  type PreparedPortableSessionInput,
  type PortableAssetRegistryInput,
} from './portable-session-compiler'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { Track } from '@daw-browser/timeline-core/types'

const assets: PortableAssetRegistryInput = {
  projectGeneration: 7,
  assets: [{
    projectAssetId: 'kick',
    portableAssetId: 'asset:kick:7',
    projectGeneration: 7,
    handle: { slot: 3, generation: 2 },
    decoded: { sampleRateHz: 48_000, channelCount: 1, frameCount: 48_000 },
  }],
}

const sample: DrumRackPadSample = {
  assetKey: 'kick',
  url: 'memory:kick',
  sourceKind: 'upload',
  source: { durationSec: 1, sampleRate: 48_000, channelCount: 1 },
}

const samplerZone: SamplerZone = {
  id: 'kick-zone',
  sample,
  keyLow: 36,
  keyHigh: 60,
  velocityLow: 1,
  velocityHigh: 127,
  rootNote: 36,
  tuneCents: 12,
  gain: 0.8,
  pan: -0.2,
  roundRobinGroup: 1,
  roundRobinIndex: 2,
  playbackMode: 'forward-loop',
  startSec: 0.1,
  endSec: 0.8,
  loopStartSec: 0.2,
  loopEndSec: 0.6,
  crossfadeSec: 0,
  chokeGroup: 4,
}

test('compiles normalized browser synth controls into the portable synth ABI profile', () => {
  const compiled = compilePortableSynthConfiguration('track-a', 'instrument:a', {
    version: 2,
    oscillators: [
      { enabled: true, wave: 'square', octave: 1, semitone: 2, detuneCents: 3, level: 0.4 },
      { enabled: false, wave: 'triangle', octave: -1, semitone: -2, detuneCents: -3, level: 0.2 },
    ],
    ampEnvelope: { attackSec: 0.01, decaySec: 0.02, sustain: 0.7, releaseSec: 0.03 },
    filter: {
      enabled: true, mode: 'bandpass', frequencyHz: 1000, q: 0.8, keyTracking: 0.4,
      envelopeAmountOctaves: 1, envelope: { attackSec: 0.04, decaySec: 0.05, sustain: 0.6, releaseSec: 0.07 },
    },
    lfo: { enabled: true, wave: 'sawtooth', frequencyHz: 3, pitchCents: 12, filterOctaves: 2, amp: 0.3, pan: 0.4 },
    noise: { enabled: true, level: 0.1 },
    gain: 0.9,
    pan: -0.2,
    polyphony: 64,
    retrigger: true,
  })
  expect(compiled.state.voiceCapacity).toBe(32)
  expect(compiled.values).toMatchObject({
    oscillators: [{ waveform: 1, octave: 1 }, { waveform: 3, octave: -1 }],
    filterMode: 0,
    ampAttackMs: 10,
    filterReleaseMs: 70,
    lfoWaveform: 2,
    outputGain: 0.9,
  })
})

test('compiles browser sampler controls and exact registered asset metadata into the portable ABI', () => {
  const state = compilePortableSamplerConfiguration('track-a', 'sampler:a', {
    ...createDefaultSamplerParams(),
    zones: [samplerZone],
    ampEnvelope: { attackSec: 0.01, decaySec: 0.02, sustain: 0.6, releaseSec: 0.03, amount: 1 },
    filterEnvelope: { attackSec: 0.01, decaySec: 0.02, sustain: 0.5, releaseSec: 0.03, amount: 0 },
    filterMode: 'highpass',
    filterFrequencyHz: 200,
    filterQ: 0.7,
    polyphony: 128,
    retrigger: true,
  }, assets)
  expect(state.state).toMatchObject({
    kind: 'sampler',
    voiceCapacity: 32,
    ampAttackMs: 10,
    filterEnabled: true,
    filterMode: 'highpass',
    filterResonance: 0.7,
    zones: [{
      assetId: 'asset:kick:7',
      startFrame: 4_800,
      endFrame: 38_400,
      loopStartFrame: 9_600,
      loopEndFrame: 28_800,
      roundRobinGroup: 1,
      chokeGroup: 4,
    }],
  })
})

test('compiles browser drum transpose and 6ms choke state into exact-key portable pads', () => {
  const params = createDefaultDrumRackParams()
  const pad = params.pads[0]
  if (!pad) throw new Error('Expected default drum pad.')
  const state = compilePortableDrumRackConfiguration('track-a', 'drums:a', {
    ...params,
    pads: [{
      ...pad,
      sample,
      note: 36,
      transpose: 12,
      startSec: 0.25,
      endSec: 0.5,
      chokeGroup: 2,
    }],
  }, assets)
  expect(state.state).toMatchObject({
    kind: 'drum-rack',
    ampReleaseMs: 6,
    retrigger: false,
    zones: [{
      assetId: 'asset:kick:7',
      keyLow: 36,
      keyHigh: 36,
      rootNote: 24,
      startFrame: 12_000,
      endFrame: 24_000,
      chokeGroup: 2,
    }],
  })
})

test('compiles fixture-proven granular controls and rejects absent or stale assets', () => {
  const asset = assets.assets[0]
  if (!asset) throw new Error('Expected registered portable asset.')
  const state = compilePortableGranularConfiguration('track-a', 'granular:a', {
    ...createDefaultGranularParams(),
    zone: samplerZone,
    seed: 77,
    maxGrains: 2,
    windowShape: 'gaussian',
    freeze: true,
    grainSizeMs: 5,
    densityHz: 200,
    position: 0.4,
    spray: 0.3,
    pitchSemitones: 12,
    reverseProbability: 0.2,
    stereoSpread: 0.7,
  }, assets)
  expect(state.state).toMatchObject({
    kind: 'granular',
    assetId: 'asset:kick:7',
    seed: 77,
    maxGrains: 2,
    windowShape: 'gaussian',
    freeze: true,
    pitchSemitones: 12,
  })
  expect(() => compilePortableGranularConfiguration(
    'track-a',
    'granular:a',
    { ...createDefaultGranularParams(), zone: samplerZone },
    { ...assets, assets: [{ ...asset, projectGeneration: 6 }] },
  )).toThrow('stale')
  expect(() => compilePortableSamplerConfiguration(
    'track-a',
    'sampler:a',
    { ...createDefaultSamplerParams(), zones: [{ ...samplerZone, sample: { ...sample, assetKey: 'missing' } }] },
    assets,
  )).toThrow('not registered')
  expect(() => compilePortableSamplerConfiguration(
    'track-a',
    'sampler:a',
    { ...createDefaultSamplerParams(), zones: [{ ...samplerZone, sample: { ...sample, source: { ...sample.source, durationSec: 2 } } }] },
    assets,
  )).toThrow('metadata does not match')
  expect(() => compilePortableSamplerConfiguration(
    'track-a',
    'sampler:a',
    { ...createDefaultSamplerParams(), zones: [samplerZone], lfo: { ...createDefaultSamplerParams().lfo, enabled: true } },
    assets,
  )).toThrow('LFO')
})

test('reports only unsupported browser fields or rejected asset state in portable sessions', () => {
  const compilation = compilePortableSessionInput({
    mixer: {
      channels: [],
      master: {
        volume: 1,
        instances: [],
        inputLayout: 'stereo',
        outputLayout: 'stereo',
      },
    },
    fx: {
      masterFxInstances: [],
      trackFx: {
        sampler: {
          instances: [],
          instrument: {
            kind: 'sampler',
            instanceId: 'sampler:a',
            params: { ...createDefaultSamplerParams(), zones: [{ ...samplerZone, playbackMode: 'crossfade-loop', crossfadeSec: 0.1 }] },
          },
        },
      },
    },
    automationEnvelopes: [],
    assetRegistry: assets,
  })
  expect(compilation.samplers).toEqual([])
  expect(compilation.portableAssets).toEqual([...assets.assets])
  expect(compilation.unsupportedInstruments).toEqual([
    'sampler: kick-zone: crossfade-loop playback is not supported by the portable ABI.',
  ])
})

const portableSessionInput = (): PreparedPortableSessionInput => {
  const utility: AudioEffectRuntimeInstance = {
    id: 'return-utility',
    kind: 'utility',
    params: { version: 1, state: createDefaultUtilityParams() },
  }
  const compressor: AudioEffectRuntimeInstance = {
    id: 'return-compressor',
    kind: 'compressor',
    params: createDefaultCompressorParams(),
  }
  const mixer = resolveMixerGraph({
    channels: createMixerChannels([
      { id: 'synth', kind: 'instrument', name: 'Synth', clips: [], volume: 0.8, outputTargetId: 'group', sends: [{ targetId: 'return', amount: 0.2, tap: 'pre-fx' }] },
      { id: 'sampler', kind: 'instrument', name: 'Sampler', clips: [], volume: 0.8, outputTargetId: 'group' },
      { id: 'drums', kind: 'instrument', name: 'Drums', clips: [], volume: 0.8, outputTargetId: 'group' },
      { id: 'granular', kind: 'instrument', name: 'Granular', clips: [], volume: 0.8, outputTargetId: 'group' },
      { id: 'group', channelRole: 'group', name: 'Group', clips: [], volume: 1 },
      { id: 'return', channelRole: 'return', name: 'Return', clips: [], volume: 1 },
    ]),
    trackFx: { return: { instances: [utility, compressor] } },
  })
  const drumDefaults = createDefaultDrumRackParams()
  const firstPad = drumDefaults.pads[0]
  if (!firstPad) throw new Error('Expected default drum pad.')
  return {
    tracks: [],
    mixer,
    fx: {
      masterFxInstances: [],
      trackFx: {
        synth: { instances: [], instrument: { kind: 'synth', instanceId: 'synth:1', params: createDefaultSynthParams() } },
        sampler: { instances: [], instrument: { kind: 'sampler', instanceId: 'sampler:1', params: { ...createDefaultSamplerParams(), zones: [samplerZone] } } },
        drums: { instances: [], instrument: { kind: 'drum-rack', instanceId: 'drums:1', params: { ...drumDefaults, pads: [{ ...firstPad, sample, note: 36 }] } } },
        granular: { instances: [], instrument: { kind: 'granular', instanceId: 'granular:1', params: { ...createDefaultGranularParams(), zone: samplerZone } } },
        return: { instances: [utility, compressor] },
      },
    },
    automationEnvelopes: [],
    assetRegistry: assets,
    sourceRangeEndSec: 1,
    sourceFirstSequence: 1,
    revision: 9,
    sampleRateHz: 48_000,
    bpm: 120,
    sidechainRoutes: [{ sourceTrackId: 'synth', targetTrackId: 'return', effectInstanceId: 'return-compressor' }],
    schedule: {
      revision: 9,
      transportEpoch: 4,
      sampleRateHz: 48_000,
      bpm: 120,
      timeOrigin: { timelineSec: 0, frame: 0 },
      events: [
        { frame: 0, sequence: 1, type: 'note-on', target: { kind: 'instrument', trackId: 'synth' }, noteId: 1, pitch: 60, velocity: 0.8 },
        { frame: 0, sequence: 2, type: 'note-on', target: { kind: 'instrument', trackId: 'sampler' }, noteId: 2, pitch: 48, velocity: 0.8 },
        { frame: 0, sequence: 3, type: 'note-on', target: { kind: 'instrument', trackId: 'drums' }, noteId: 3, pitch: 36, velocity: 0.8 },
        { frame: 0, sequence: 4, type: 'note-on', target: { kind: 'instrument', trackId: 'granular' }, noteId: 4, pitch: 60, velocity: 0.8 },
        { frame: 1, sequence: 5, type: 'parameter-set', target: { kind: 'parameter', scope: 'track', trackId: 'synth', parameterId: 'mixer.gain' }, value: 0.7 },
        { frame: 1, sequence: 6, type: 'parameter-ramp', target: { kind: 'parameter', scope: 'track', trackId: 'return', effectInstanceId: 'return-utility', parameterId: 'utility.gainDb' }, startFrame: 1, endFrame: 48_000, startValue: 0, endValue: -3, interpolation: 'linear' },
        { frame: 48_000, sequence: 7, type: 'note-off', target: { kind: 'instrument', trackId: 'synth' }, noteId: 1, pitch: 60 },
      ],
    },
  }
}

const sourceTrack = (clipId = 'clip-a'): Track => ({
  id: 'audio',
  kind: 'audio',
  name: 'Audio',
  volume: 1,
  clips: [{
    id: clipId,
    name: clipId,
    color: '#fff',
    startSec: 2,
    duration: 1,
    sourceAssetKey: 'kick',
    bufferOffsetSec: 0,
    gain: 0.5,
    fades: { fadeInSec: 0, fadeOutSec: 0, fadeInCurve: 0, fadeOutCurve: 0 },
  }],
})

const sourceSessionInput = (tracks: readonly Track[] = [sourceTrack()]): PreparedPortableSessionInput => {
  const base = portableSessionInput()
  return {
    ...base,
    tracks,
    mixer: resolveMixerGraph({
      channels: createMixerChannels([
        ...base.mixer.channels.map((entry) => ({
          id: entry.channel.id,
          name: entry.channel.name,
          volume: entry.channel.volume,
          clips: [],
          kind: entry.channel.kind,
          channelRole: entry.channel.role === 'master' ? undefined : entry.channel.role,
          outputTargetId: entry.channel.outputTargetId,
          sends: entry.channel.sends,
          muted: entry.channel.muted,
          soloed: entry.channel.soloed,
        })),
        { id: 'audio', kind: 'audio', name: 'Audio', volume: 1, clips: [] },
      ]),
      trackFx: base.fx.trackFx,
    }),
    schedule: { ...base.schedule, events: [] },
    sourceRangeEndSec: 10,
    sourceFirstSequence: 1,
  }
}

test('canonicalizes source identity and ordering independently of mixer state', () => {
  const baseline = compilePreparedPortableSession(sourceSessionInput([
    sourceTrack('clip-b'),
    { ...sourceTrack('clip-a'), clips: [{ ...sourceTrack('clip-a').clips[0]!, startSec: 1 }] },
  ]))
  const changedMixer = sourceSessionInput([
    sourceTrack('clip-b'),
    { ...sourceTrack('clip-a'), clips: [{ ...sourceTrack('clip-a').clips[0]!, startSec: 1 }] },
  ])
  changedMixer.mixer = resolveMixerGraph({
    channels: changedMixer.mixer.channels.map((entry) => ({
      ...entry.channel,
      volume: entry.channel.id === 'audio' ? 0.2 : 0.9,
      muted: entry.channel.id === 'audio',
      soloed: true,
      outputTargetId: entry.channel.id === 'audio' ? 'group' : undefined,
      sends: entry.channel.id === 'audio' ? [{ targetId: 'return', amount: 0.5 }] : [],
    })),
    trackFx: changedMixer.fx.trackFx,
  })
  const mixed = compilePreparedPortableSession(changedMixer)
  expect(baseline.supported).toBe(true)
  expect(mixed.supported).toBe(true)
  if (!baseline.supported || !mixed.supported) throw new Error('Expected source sessions to be supported.')
  expect(mixed.sources).toEqual(baseline.sources)
  expect(mixed.sources.map((source) => source.sourceIdentity)).toEqual([
    'source:5:audio:6:clip-a',
    'source:5:audio:6:clip-b',
  ])
  expect(mixed.sources.map((source) => source.sequence)).toEqual([1, 2])
})

test('rejects duplicate source identities, missing source targets, and missing assets', () => {
  const duplicate = compilePreparedPortableSession(sourceSessionInput([
    sourceTrack('clip-a'),
    sourceTrack('clip-a'),
  ]))
  expect(duplicate).toMatchObject({ supported: false })
  if (duplicate.supported) throw new Error('Expected duplicate source identity rejection.')
  expect(duplicate.reasons).toContain('source:5:audio:6:clip-a: duplicate portable source identity.')

  const missingTarget = compilePreparedPortableSession({
    ...sourceSessionInput(),
    tracks: [{ ...sourceTrack(), id: 'missing' }],
  })
  expect(missingTarget).toMatchObject({ supported: false })
  if (missingTarget.supported) throw new Error('Expected missing graph target rejection.')
  expect(missingTarget.reasons).toContain('source:7:missing:6:clip-a: portable source target "missing" is absent from the graph snapshot.')

  const missingAsset = compilePreparedPortableSession({
    ...sourceSessionInput(),
    tracks: [{ ...sourceTrack(), clips: [{ ...sourceTrack().clips[0]!, sourceAssetKey: 'missing' }] }],
  })
  expect(missingAsset).toMatchObject({ supported: false })
  if (missingAsset.supported) throw new Error('Expected missing source asset rejection.')
  expect(missingAsset.reasons).toContain('clip-a: source asset is not registered.')
})

test('projects nonzero playhead windows and adjacent windows without losing source coverage', () => {
  const whole = compilePreparedPortableSession({
    ...sourceSessionInput(),
    sourceRangeEndSec: 3,
  })
  const first = compilePreparedPortableSession({
    ...sourceSessionInput(),
    schedule: {
      ...sourceSessionInput().schedule,
      timeOrigin: { timelineSec: 0, frame: 0 },
    },
    sourceRangeEndSec: 2.5,
  })
  const second = compilePreparedPortableSession({
    ...sourceSessionInput(),
    schedule: {
      ...sourceSessionInput().schedule,
      timeOrigin: { timelineSec: 2.5, frame: 120_000 },
    },
    sourceRangeEndSec: 3,
  })
  expect(whole.supported).toBe(true)
  expect(first.supported).toBe(true)
  expect(second.supported).toBe(true)
  if (!whole.supported || !first.supported || !second.supported) throw new Error('Expected source windows to be supported.')
  expect(second.sources[0]).toMatchObject({
    startFrame: 120_000,
    sourceOffsetFrame: 24_000,
  })
  const wholeSource = whole.sources[0]
  const firstSource = first.sources[0]
  const secondSource = second.sources[0]
  if (!wholeSource || !firstSource || !secondSource) throw new Error('Expected projected source windows.')
  expect({
    identity: [firstSource.sourceIdentity, secondSource.sourceIdentity],
    startFrame: firstSource.startFrame,
    stopFrame: secondSource.stopFrame,
    sourceOffsetFrame: firstSource.sourceOffsetFrame,
    sourceFrameCount: firstSource.sourceFrameCount + secondSource.sourceFrameCount,
  }).toEqual({
    identity: [wholeSource.sourceIdentity, wholeSource.sourceIdentity],
    startFrame: wholeSource.startFrame,
    stopFrame: wholeSource.stopFrame,
    sourceOffsetFrame: wholeSource.sourceOffsetFrame,
    sourceFrameCount: wholeSource.sourceFrameCount,
  })
})

test('atomically assembles a deterministic fixture-proven portable live session', () => {
  const input = portableSessionInput()
  const prepared = compilePreparedPortableSession(input)
  const repeated = compilePreparedPortableSession(input)
  expect(prepared.supported).toBe(true)
  expect(repeated.supported).toBe(true)
  if (!prepared.supported || !repeated.supported) throw new Error('Expected portable session support.')
  expect(prepared.graph.nodes.map((node) => [node.id, node.kind])).toEqual([
    ['synth', 'instrument'],
    ['sampler', 'instrument'],
    ['drums', 'instrument'],
    ['granular', 'instrument'],
    ['group', 'group'],
    ['return', 'return'],
    ['$master', 'master'],
  ])
  expect(prepared.graph.edges).toContainEqual(expect.objectContaining({
    fromNodeId: 'synth',
    toNodeId: 'return',
    tap: 'pre-fx',
    sidechain: false,
    pdcDelayFrames: 0,
  }))
  expect(prepared.graph.edges).toContainEqual(expect.objectContaining({
    fromNodeId: 'synth',
    toNodeId: 'return',
    sidechain: true,
    targetProcessorId: 'return-compressor',
    pdcDelayFrames: 0,
  }))
  expect(prepared.instruments.map((instrument) => instrument.state.kind)).toEqual(['synth', 'sampler', 'drum-rack', 'granular'])
  expect(prepared.schedule.events).toHaveLength(7)
  expect(JSON.stringify(prepared)).toBe(JSON.stringify(repeated))
})

test('rejects unsupported graph features and unresolved schedule targets without returning a partial payload', () => {
  const effectInput = portableSessionInput()
  const trackFx = effectInput.fx.trackFx
  if (!trackFx) throw new Error('Expected track FX.')
  const returnFx = trackFx.return
  if (!returnFx) throw new Error('Expected return FX.')
  const saturator: AudioEffectRuntimeInstance = {
    id: 'portable-saturator',
    kind: 'saturator',
    params: { ...createDefaultSaturatorParams(), driveDb: 12 },
  }
  const eq: AudioEffectRuntimeInstance = {
    id: 'portable-eq',
    kind: 'eq',
    params: { ...createDefaultEqParams(), channelMode: 'mono' },
  }
  const chorus: AudioEffectRuntimeInstance = {
    id: 'portable-chorus',
    kind: 'chorus',
    params: { version: 1, state: createDefaultChorusParams() },
  }
  const portableEffectsInput: PreparedPortableSessionInput = {
    ...effectInput,
    mixer: resolveMixerGraph({
      channels: effectInput.mixer.channels.map((entry) => entry.channel),
      trackFx: {
        return: { instances: [...returnFx.instances] },
        group: { instances: [saturator, eq, chorus] },
      },
    }),
    fx: {
      ...effectInput.fx,
      trackFx: {
        ...trackFx,
        group: { instances: [saturator, eq, chorus] },
      },
    },
  }
  const portableEffects = compilePreparedPortableSession(portableEffectsInput)
  expect(portableEffects.supported).toBe(true)
  if (!portableEffects.supported) throw new Error(portableEffects.reasons.join('\n'))
  const group = portableEffects.graph.nodes.find((node) => node.id === 'group')
  expect(group?.processorOrder.map((processor) => [
    processor.kind,
    processor.latencyFrames,
    processor.tailFrames,
    processor.parameterTargets,
  ])).toEqual([
    ['saturator', 0, 0, []],
    ['eq', 0, 0, []],
    ['chorus', 0, 768, []],
  ])

  const closingEvent = portableEffectsInput.schedule.events[6]
  if (!closingEvent) throw new Error('Expected portable session closing event.')
  const automatedEffect = compilePreparedPortableSession({
    ...portableEffectsInput,
    schedule: {
      ...portableEffectsInput.schedule,
      events: [
        ...portableEffectsInput.schedule.events.slice(0, 6),
        {
          frame: 2,
          sequence: 7,
          type: 'parameter-set',
          target: {
            kind: 'parameter',
            scope: 'track',
            trackId: 'group',
            effectInstanceId: 'portable-saturator',
            parameterId: 'saturator.driveDb',
          },
          value: 18,
        },
        {
          frame: 3,
          sequence: 8,
          type: 'parameter-set',
          target: {
            kind: 'parameter',
            scope: 'track',
            trackId: 'group',
            effectInstanceId: 'portable-eq',
            parameterId: 'eq.band-1.gainDb',
          },
          value: 6,
        },
        {
          frame: 4,
          sequence: 9,
          type: 'parameter-set',
          target: {
            kind: 'parameter',
            scope: 'track',
            trackId: 'group',
            effectInstanceId: 'portable-chorus',
            parameterId: 'chorus.rateHz',
          },
          value: 2,
        },
        { ...closingEvent, sequence: 10 },
      ],
    },
  })
  expect(automatedEffect).toMatchObject({ supported: false })
  if (automatedEffect.supported) throw new Error('Expected unsupported portable effect automation.')
  expect(automatedEffect.reasons).toContain('portable-saturator: scheduled parameter "saturator.driveDb" is not portable.')
  expect(automatedEffect.reasons).toContain('portable-eq: scheduled parameter "eq.band-1.gainDb" is not portable.')
  expect(automatedEffect.reasons).toContain('portable-chorus: scheduled parameter "chorus.rateHz" is not portable.')

  const unsupportedEffect = compilePreparedPortableSession({
    ...effectInput,
    sidechainRoutes: [],
    mixer: resolveMixerGraph({
      channels: effectInput.mixer.channels.map((entry) => entry.channel),
      trackFx: {
        return: {
          instances: [
            {
              id: 'unsupported',
              kind: 'limiter',
              params: { version: 1, state: createDefaultLimiterParams() },
            },
            {
              id: 'unsupported-delay',
              kind: 'delay',
              params: createDefaultDelayParams(),
            },
            {
              id: 'unsupported-reverb',
              kind: 'reverb',
              params: createDefaultReverbParams(),
            },
          ],
        },
      },
    }),
    fx: {
      ...effectInput.fx,
      trackFx: {
        ...trackFx,
        return: {
          ...returnFx,
          instances: [
            {
              id: 'unsupported',
              kind: 'limiter',
              params: { version: 1, state: createDefaultLimiterParams() },
            },
            {
              id: 'unsupported-delay',
              kind: 'delay',
              params: createDefaultDelayParams(),
            },
            {
              id: 'unsupported-reverb',
              kind: 'reverb',
              params: createDefaultReverbParams(),
            },
          ],
        },
      },
    },
  })
  expect(unsupportedEffect).toMatchObject({ supported: false })
  if (unsupportedEffect.supported) throw new Error('Expected unsupported portable session.')
  expect(unsupportedEffect.reasons).toContain('unsupported: processor "limiter" is not fixture-proven for portable sessions.')
  expect(unsupportedEffect.reasons).toContain('unsupported-delay: processor "delay" is not fixture-proven for portable sessions.')
  expect(unsupportedEffect.reasons).toContain('unsupported-reverb: processor "reverb" is not fixture-proven for portable sessions.')

  const targetInput = portableSessionInput()
  const unresolvedTarget = compilePreparedPortableSession({
    ...targetInput,
    schedule: {
      ...targetInput.schedule,
      events: [{
        frame: 0,
        sequence: 1,
        type: 'note-on',
        target: { kind: 'instrument', trackId: 'missing' },
        noteId: 1,
        pitch: 60,
        velocity: 0.8,
      }],
    },
  })
  expect(unresolvedTarget).toMatchObject({ supported: false })
  if (unresolvedTarget.supported) throw new Error('Expected unresolved portable session.')
  expect(unresolvedTarget.reasons).toEqual(['missing: scheduled note targets no portable instrument.'])
})
