import { expect, test } from 'bun:test'
import {
  createDefaultAutoPanParams,
  createDefaultAutoFilterParams,
  createDefaultChorusParams,
  createDefaultEnsembleParams,
  createDefaultFlangerParams,
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultEqParams,
  createDefaultGateParams,
  createDefaultLimiterParams,
  createDefaultLoFiParams,
  createDefaultPhaserParams,
  createDefaultReverbParams,
  createDefaultSaturatorParams,
  createDefaultSpectralParams,
  createDefaultTremoloParams,
  createDefaultUtilityParams,
} from '@daw-browser/shared'
import type { EffectParamsCommitPayload } from '~/lib/undo/types'
import { encodeNativeBuiltInStateCommit, mapNativeBuiltInParameterCommit } from './native-built-in-parameter-mapper'

type StateEnvelope<State> = { version: 1; state: State }
const envelope = <State>(state: State): StateEnvelope<State> => ({ version: 1, state })

test('maps changed nested built-in values and filters unchanged fields', () => {
  const from = envelope(createDefaultAutoFilterParams())
  const to = envelope({
    ...from.state,
    frequencyHz: 2200,
    envelope: { ...from.state.envelope, attackMs: 25 },
    lfo: { ...from.state.lfo, stereoPhase: 0.25 },
  })
  const payload = {
    targetId: 'track-1',
    effect: 'autofilter',
    instanceId: 'fx-1',
    from,
    to,
  } satisfies EffectParamsCommitPayload<'autofilter'>
  expect(mapNativeBuiltInParameterCommit(payload, 120)).toEqual({
    instanceId: 'fx-1',
    values: [
      { parameterId: 'autofilter.frequencyHz', value: 2200 },
      { parameterId: 'autofilter.envelope.attackMs', value: 25 },
      { parameterId: 'autofilter.lfo.stereoPhase', value: 0.25 },
    ],
  })
})

test('maps every continuous target for every live built-in family', () => {
  const utilityFrom = createDefaultUtilityParams()
  const autoFilterFrom = createDefaultAutoFilterParams()
  const loFiFrom = createDefaultLoFiParams()
  const delayFrom = { ...createDefaultDelayParams(), mode: 'time' as const }
  const reverbFrom = createDefaultReverbParams()
  const saturatorFrom = createDefaultSaturatorParams()
  const chorusFrom = createDefaultChorusParams()
  const flangerFrom = createDefaultFlangerParams()
  const phaserFrom = createDefaultPhaserParams()
  const tremoloFrom = createDefaultTremoloParams()
  const autoPanFrom = createDefaultAutoPanParams()
  const ensembleFrom = createDefaultEnsembleParams()
  const gateFrom = createDefaultGateParams()
  const compressorFrom = createDefaultCompressorParams()
  const limiterFrom = createDefaultLimiterParams()
  const spectralFrom = createDefaultSpectralParams()
  const cases = [
    {
      name: 'utility',
      payload: {
        targetId: 'track-1', effect: 'utility', instanceId: 'utility-1',
        from: envelope(utilityFrom),
        to: envelope({ ...utilityFrom, gainDb: 3, pan: -0.25, balance: 0.2, width: 1.5 }),
      } satisfies EffectParamsCommitPayload<'utility'>,
      expected: [
        ['utility.gainDb', 3], ['utility.pan', -0.25], ['utility.balance', 0.2], ['utility.width', 1.5],
      ],
    },
    {
      name: 'autofilter',
      payload: {
        targetId: 'track-1', effect: 'autofilter', instanceId: 'autofilter-1',
        from: envelope(autoFilterFrom),
        to: envelope({
          ...autoFilterFrom,
          frequencyHz: 2_000, resonance: 0.4, driveDb: 6, mix: 0.7,
          envelope: { ...autoFilterFrom.envelope, amountOctaves: 2, attackMs: 20, releaseMs: 150 },
          lfo: { ...autoFilterFrom.lfo, rateHz: 3, depthOctaves: 1.5, phaseOffset: 0.25, stereoPhase: -0.25 },
        }),
      } satisfies EffectParamsCommitPayload<'autofilter'>,
      expected: [
        ['autofilter.frequencyHz', 2_000], ['autofilter.resonance', 0.4], ['autofilter.driveDb', 6], ['autofilter.mix', 0.7],
        ['autofilter.envelope.amountOctaves', 2], ['autofilter.envelope.attackMs', 20], ['autofilter.envelope.releaseMs', 150],
        ['autofilter.lfo.rateHz', 3], ['autofilter.lfo.depthOctaves', 1.5], ['autofilter.lfo.phaseOffset', 0.25], ['autofilter.lfo.stereoPhase', -0.25],
      ],
    },
    {
      name: 'lofi',
      payload: {
        targetId: 'track-1', effect: 'lofi', instanceId: 'lofi-1',
        from: envelope(loFiFrom),
        to: envelope({ ...loFiFrom, bitDepth: 16, sampleRateRatio: 0.5, jitter: 0.2, noiseDb: -48, mix: 0.6 }),
      } satisfies EffectParamsCommitPayload<'lofi'>,
      expected: [['lofi.bitDepth', 16], ['lofi.sampleRateRatio', 0.5], ['lofi.jitter', 0.2], ['lofi.noiseDb', -48], ['lofi.mix', 0.6]],
    },
    {
      name: 'delay',
      payload: {
        targetId: 'track-1', effect: 'delay', instanceId: 'delay-1',
        from: delayFrom,
        to: { ...delayFrom, timeMs: 240, feedback: 0.7, dryWet: 0.6, lowCutHz: 200, highCutHz: 12_000 },
      } satisfies EffectParamsCommitPayload<'delay'>,
      expected: [['delay.timeMs', 240], ['delay.feedback', 0.7], ['delay.dryWet', 0.6], ['delay.lowCutHz', 200], ['delay.highCutHz', 12_000]],
    },
    {
      name: 'reverb',
      payload: {
        targetId: 'track-1', effect: 'reverb', instanceId: 'reverb-1',
        from: reverbFrom,
        to: {
          ...reverbFrom, wet: 0.4, preDelayMs: 30, lowCutHz: 80, highCutHz: 16_000, stereoWidth: 1.5,
          decaySec: 3, reflections: 0.7, reflectionModAmountMs: 8, reflectionModRateHz: 1,
          ["reflectionShape"]: 0.6, diffuse: 0.8, size: 0.5, diffusion: 0.9, density: 0.6,
          diffusionLowCutHz: 120, diffusionHighCutHz: 18_000,
        },
      } satisfies EffectParamsCommitPayload<'reverb'>,
      expected: [
        ['reverb.wet', 0.4], ['reverb.preDelayMs', 30], ['reverb.lowCutHz', 80], ['reverb.highCutHz', 16_000], ['reverb.stereoWidth', 1.5],
        ['reverb.decaySec', 3], ['reverb.reflections', 0.7], ['reverb.reflectionModAmountMs', 8], ['reverb.reflectionModRateHz', 1],
        ['reverb.reflectionShape', 0.6], ['reverb.diffuse', 0.8], ['reverb.size', 0.5], ['reverb.diffusion', 0.9], ['reverb.density', 0.6],
        ['reverb.diffusionLowCutHz', 120], ['reverb.diffusionHighCutHz', 18_000],
      ],
    },
    {
      name: 'saturator',
      payload: {
        targetId: 'track-1', effect: 'saturator', instanceId: 'saturator-1',
        from: saturatorFrom,
        to: { ...saturatorFrom, driveDb: 24, colorFrequencyHz: 4_000, colorAmount: 0.7, outputDb: 2, dryWet: 0.5 },
      } satisfies EffectParamsCommitPayload<'saturator'>,
      expected: [['saturator.driveDb', 24], ['saturator.colorFrequencyHz', 4_000], ['saturator.colorAmount', 0.7], ['saturator.outputDb', 2], ['saturator.dryWet', 0.5]],
    },
    {
      name: 'chorus',
      payload: {
        targetId: 'track-1', effect: 'chorus', instanceId: 'chorus-1',
        from: envelope(chorusFrom),
        to: envelope({ ...chorusFrom, delayMs: 20, depthMs: 6, rateHz: 2, feedback: 0.2, stereoPhase: -0.25, mix: 0.6 }),
      } satisfies EffectParamsCommitPayload<'chorus'>,
      expected: [['chorus.delayMs', 20], ['chorus.depthMs', 6], ['chorus.rateHz', 2], ['chorus.feedback', 0.2], ['chorus.stereoPhase', -0.25], ['chorus.mix', 0.6]],
    },
    {
      name: 'flanger',
      payload: {
        targetId: 'track-1', effect: 'flanger', instanceId: 'flanger-1',
        from: envelope(flangerFrom),
        to: envelope({ ...flangerFrom, delayMs: 3, depthMs: 2, rateHz: 4, feedback: -0.2, stereoPhase: 0.25, mix: 0.7 }),
      } satisfies EffectParamsCommitPayload<'flanger'>,
      expected: [['flanger.delayMs', 3], ['flanger.depthMs', 2], ['flanger.rateHz', 4], ['flanger.feedback', -0.2], ['flanger.stereoPhase', 0.25], ['flanger.mix', 0.7]],
    },
    {
      name: 'phaser',
      payload: {
        targetId: 'track-1', effect: 'phaser', instanceId: 'phaser-1',
        from: envelope(phaserFrom),
        to: envelope({ ...phaserFrom, centerHz: 2_000, depthOctaves: 2, rateHz: 1, feedback: 0.2, stereoPhase: -0.25, mix: 0.7 }),
      } satisfies EffectParamsCommitPayload<'phaser'>,
      expected: [['phaser.centerHz', 2_000], ['phaser.depthOctaves', 2], ['phaser.rateHz', 1], ['phaser.feedback', 0.2], ['phaser.stereoPhase', -0.25], ['phaser.mix', 0.7]],
    },
    {
      name: 'tremolo',
      payload: {
        targetId: 'track-1', effect: 'tremolo', instanceId: 'tremolo-1',
        from: envelope(tremoloFrom),
        to: envelope({ ...tremoloFrom, rateHz: 8, depth: 0.8, ["shape"]: 0.25, phase: 0.5 }),
      } satisfies EffectParamsCommitPayload<'tremolo'>,
      expected: [['tremolo.rateHz', 8], ['tremolo.depth', 0.8], ['tremolo.shape', 0.25], ['tremolo.phase', 0.5]],
    },
    {
      name: 'autopan',
      payload: {
        targetId: 'track-1', effect: 'autopan', instanceId: 'autopan-1',
        from: envelope(autoPanFrom),
        to: envelope({ ...autoPanFrom, rateHz: 5, depth: 0.75, ["shape"]: 0.2, phase: 0.4 }),
      } satisfies EffectParamsCommitPayload<'autopan'>,
      expected: [['autopan.rateHz', 5], ['autopan.depth', 0.75], ['autopan.shape', 0.2], ['autopan.phase', 0.4]],
    },
    {
      name: 'ensemble',
      payload: {
        targetId: 'track-1', effect: 'ensemble', instanceId: 'ensemble-1',
        from: envelope(ensembleFrom),
        to: envelope({ ...ensembleFrom, delayMs: 24, depthMs: 8, rateHz: 1.2, spread: 0.7, mix: 0.6 }),
      } satisfies EffectParamsCommitPayload<'ensemble'>,
      expected: [['ensemble.delayMs', 24], ['ensemble.depthMs', 8], ['ensemble.rateHz', 1.2], ['ensemble.spread', 0.7], ['ensemble.mix', 0.6]],
    },
    {
      name: 'gate',
      payload: {
        targetId: 'track-1', effect: 'gate', instanceId: 'gate-1',
        from: envelope(gateFrom),
        to: envelope({
          ...gateFrom, thresholdDb: -18, ratio: gateFrom.ratio + 1, attackMs: 5, holdMs: gateFrom.holdMs + 10, releaseMs: 80, hysteresisDb: gateFrom.hysteresisDb + 1, rangeDb: -36,
          lookaheadMs: 1.5, link: 0.6, sidechain: { ...gateFrom.sidechain, frequencyHz: 160, q: 1.2 },
        }),
      } satisfies EffectParamsCommitPayload<'gate'>,
      expected: [
        ['gate.thresholdDb', -18], ['gate.ratio', gateFrom.ratio + 1], ['gate.attackMs', 5], ['gate.holdMs', gateFrom.holdMs + 10], ['gate.releaseMs', 80],
        ['gate.hysteresisDb', gateFrom.hysteresisDb + 1], ['gate.rangeDb', -36], ['gate.lookaheadMs', 1.5], ['gate.link', 0.6],
        ['gate.sidechain.frequencyHz', 160], ['gate.sidechain.q', 1.2],
      ],
    },
    {
      name: 'compressor',
      payload: {
        targetId: 'track-1', effect: 'compressor', instanceId: 'compressor-1',
        from: compressorFrom,
        to: {
          ...compressorFrom, thresholdDb: -12, ratio: 6, attackMs: 5, releaseMs: 100, makeupDb: 3, outputDb: -2, dryWet: 0.7,
          kneeDb: 10, lookaheadMs: 5, sidechain: { ...compressorFrom.sidechain, frequencyHz: 180, q: 1.1 },
        },
      } satisfies EffectParamsCommitPayload<'compressor'>,
      expected: [
        ['compressor.thresholdDb', -12], ['compressor.ratio', 6], ['compressor.attackMs', 5], ['compressor.releaseMs', 100],
        ['compressor.makeupDb', 3], ['compressor.outputDb', -2], ['compressor.dryWet', 0.7], ['compressor.kneeDb', 10],
        ['compressor.lookaheadMs', 5], ['compressor.sidechain.frequencyHz', 180], ['compressor.sidechain.q', 1.1],
      ],
    },
    {
      name: 'limiter',
      payload: {
        targetId: 'track-1', effect: 'limiter', instanceId: 'limiter-1',
        from: envelope(limiterFrom),
        to: envelope({ ...limiterFrom, ceilingDbtp: -3, releaseMs: 120, lookaheadMs: 3, link: 0.5 }),
      } satisfies EffectParamsCommitPayload<'limiter'>,
      expected: [['limiter.ceiling', -3], ['limiter.release', 120], ['limiter.lookaheadMs', 3], ['limiter.link', 0.5]],
    },
    {
      name: 'spectral',
      payload: {
        targetId: 'track-1', effect: 'spectral', instanceId: 'spectral-1',
        from: envelope(spectralFrom),
        to: envelope({
          ...spectralFrom, freeze: 0.5, gateThresholdDb: -48, gateAttackMs: 5, gateReleaseMs: 40, morph: 0.4,
          binShift: 2, blur: 0.3, harmonicPercussiveBalance: 0.6, noiseReduction: 0.4, profileLearn: 0.8, mix: 0.7,
        }),
      } satisfies EffectParamsCommitPayload<'spectral'>,
      expected: [
        ['spectral.freeze', 0.5], ['spectral.gateThresholdDb', -48], ['spectral.gateAttackMs', 5], ['spectral.gateReleaseMs', 40],
        ['spectral.morph', 0.4], ['spectral.binShift', 2], ['spectral.blur', 0.3], ['spectral.harmonicPercussiveBalance', 0.6],
        ['spectral.noiseReduction', 0.4], ['spectral.profileLearn', 0.8], ['spectral.mix', 0.7],
      ],
    },
  ] as const

  for (const entry of cases) {
    const result = mapNativeBuiltInParameterCommit(entry.payload, 120)
    expect(result?.instanceId).toBe(entry.payload.instanceId)
    expect(JSON.stringify(result?.values.map((value) => [value.parameterId, value.value])))
      .toBe(JSON.stringify(entry.expected))
  }
})

test('rejects every structural change atomically across live built-in families', () => {
  const utility = createDefaultUtilityParams()
  const autoFilter = createDefaultAutoFilterParams()
  const loFi = createDefaultLoFiParams()
  const delay = createDefaultDelayParams()
  const reverb = createDefaultReverbParams()
  const saturator = createDefaultSaturatorParams()
  const chorus = createDefaultChorusParams()
  const flanger = createDefaultFlangerParams()
  const phaser = createDefaultPhaserParams()
  const tremolo = createDefaultTremoloParams()
  const autoPan = createDefaultAutoPanParams()
  const ensemble = createDefaultEnsembleParams()
  const gate = createDefaultGateParams()
  const compressor = createDefaultCompressorParams()
  const limiter = createDefaultLimiterParams()
  const spectral = createDefaultSpectralParams()
  const structuralCases = [
    {
      targetId: 'track-1', effect: 'utility', instanceId: 'utility-1',
      from: envelope(utility), to: envelope({ ...utility, enabled: !utility.enabled, gainDb: utility.gainDb + 1 }),
    } satisfies EffectParamsCommitPayload<'utility'>,
    {
      targetId: 'track-1', effect: 'autofilter', instanceId: 'autofilter-1',
      from: envelope(autoFilter), to: envelope({ ...autoFilter, mode: autoFilter.mode === 'lowpass' ? 'highpass' : 'lowpass', frequencyHz: autoFilter.frequencyHz + 100 }),
    } satisfies EffectParamsCommitPayload<'autofilter'>,
    {
      targetId: 'track-1', effect: 'lofi', instanceId: 'lofi-1',
      from: envelope(loFi), to: envelope({ ...loFi, quantization: loFi.quantization === 'round' ? 'truncate' : 'round', bitDepth: loFi.bitDepth - 1 }),
    } satisfies EffectParamsCommitPayload<'lofi'>,
    {
      targetId: 'track-1', effect: 'delay', instanceId: 'delay-1',
      from: delay, to: { ...delay, pingPong: !delay.pingPong, feedback: delay.feedback - 0.1 },
    } satisfies EffectParamsCommitPayload<'delay'>,
    {
      targetId: 'track-1', effect: 'reverb', instanceId: 'reverb-1',
      from: reverb, to: { ...reverb, reflectionSpin: !reverb.reflectionSpin, wet: reverb.wet - 0.1 },
    } satisfies EffectParamsCommitPayload<'reverb'>,
    {
      targetId: 'track-1', effect: 'saturator', instanceId: 'saturator-1',
      from: saturator, to: { ...saturator, curve: saturator.curve === 'soft' ? 'hard' : 'soft', driveDb: saturator.driveDb + 1 },
    } satisfies EffectParamsCommitPayload<'saturator'>,
    {
      targetId: 'track-1', effect: 'chorus', instanceId: 'chorus-1',
      from: envelope(chorus), to: envelope({ ...chorus, enabled: !chorus.enabled, delayMs: chorus.delayMs + 1 }),
    } satisfies EffectParamsCommitPayload<'chorus'>,
    {
      targetId: 'track-1', effect: 'flanger', instanceId: 'flanger-1',
      from: envelope(flanger), to: envelope({ ...flanger, enabled: !flanger.enabled, delayMs: flanger.delayMs + 1 }),
    } satisfies EffectParamsCommitPayload<'flanger'>,
    {
      targetId: 'track-1', effect: 'phaser', instanceId: 'phaser-1',
      from: envelope(phaser), to: envelope({ ...phaser, stages: phaser.stages === 6 ? 8 : 6, centerHz: phaser.centerHz + 100 }),
    } satisfies EffectParamsCommitPayload<'phaser'>,
    {
      targetId: 'track-1', effect: 'tremolo', instanceId: 'tremolo-1',
      from: envelope(tremolo), to: envelope({ ...tremolo, waveform: tremolo.waveform === 'sine' ? 'triangle' : 'sine', rateHz: tremolo.rateHz + 1 }),
    } satisfies EffectParamsCommitPayload<'tremolo'>,
    {
      targetId: 'track-1', effect: 'autopan', instanceId: 'autopan-1',
      from: envelope(autoPan), to: envelope({ ...autoPan, waveform: autoPan.waveform === 'sine' ? 'triangle' : 'sine', rateHz: autoPan.rateHz + 1 }),
    } satisfies EffectParamsCommitPayload<'autopan'>,
    {
      targetId: 'track-1', effect: 'ensemble', instanceId: 'ensemble-1',
      from: envelope(ensemble), to: envelope({ ...ensemble, enabled: !ensemble.enabled, delayMs: ensemble.delayMs + 1 }),
    } satisfies EffectParamsCommitPayload<'ensemble'>,
    {
      targetId: 'track-1', effect: 'gate', instanceId: 'gate-1',
      from: envelope(gate), to: envelope({ ...gate, mode: gate.mode === 'gate' ? 'expander' : 'gate', thresholdDb: gate.thresholdDb + 1 }),
    } satisfies EffectParamsCommitPayload<'gate'>,
    {
      targetId: 'track-1', effect: 'compressor', instanceId: 'compressor-1',
      from: compressor, to: { ...compressor, autoRelease: !compressor.autoRelease, thresholdDb: compressor.thresholdDb + 1 },
    } satisfies EffectParamsCommitPayload<'compressor'>,
    {
      targetId: 'track-1', effect: 'limiter', instanceId: 'limiter-1',
      from: envelope(limiter), to: envelope({ ...limiter, enabled: !limiter.enabled, ceilingDbtp: limiter.ceilingDbtp + 1 }),
    } satisfies EffectParamsCommitPayload<'limiter'>,
    {
      targetId: 'track-1', effect: 'spectral', instanceId: 'spectral-1',
      from: envelope(spectral), to: envelope({ ...spectral, fftSize: spectral.fftSize === 512 ? 1024 : 512, freeze: spectral.freeze + 0.1 }),
    } satisfies EffectParamsCommitPayload<'spectral'>,
  ]
  for (const payload of structuralCases) expect(mapNativeBuiltInParameterCommit(payload, 120)).toBeUndefined()
})

test('encodes a complete built-in state for same-core patching', () => {
  const from = envelope(createDefaultUtilityParams())
  const to = envelope({ ...from.state, polarity: 'invert', dcBlock: true } satisfies typeof from.state)
  const payload = {
    targetId: 'track-1',
    effect: 'utility',
    instanceId: 'fx-1',
    from,
    to,
  } satisfies EffectParamsCommitPayload<'utility'>
  const result = encodeNativeBuiltInStateCommit(payload, 120)
  expect(result?.instanceId).toBe('fx-1')
  expect(result?.state.byteLength).toBe(40)
  expect(new DataView(result?.state.buffer ?? new ArrayBuffer()).getUint32(8, true)).toBe(1)
  expect(new DataView(result?.state.buffer ?? new ArrayBuffer()).getUint32(36, true)).toBe(1)
})

test('maps booleans and master effects', () => {
  const utility = createDefaultUtilityParams()
  const payload = {
    targetId: 'master',
    effect: 'master-utility',
    instanceId: 'master-fx',
    from: envelope(structuredClone(utility)),
    to: envelope({ ...structuredClone(utility), width: 0.5 }),
  } satisfies EffectParamsCommitPayload<'master-utility'>
  expect(mapNativeBuiltInParameterCommit(payload, 120)).toEqual({
    instanceId: 'master-fx',
    values: [{ parameterId: 'utility.width', value: 0.5 }],
  })

  const spectral = createDefaultSpectralParams()
  const spectralPayload = {
    targetId: 'master',
    effect: 'master-spectral',
    instanceId: 'master-spectral',
    from: envelope(spectral),
    to: envelope({ ...spectral, freeze: 1 }),
  } satisfies EffectParamsCommitPayload<'master-spectral'>
  expect(mapNativeBuiltInParameterCommit(spectralPayload, 120)?.values).toEqual([
    { parameterId: 'spectral.freeze', value: 1 },
  ])
})

test('rejects missing instances and mixed or unsupported changes', () => {
  const utility = createDefaultUtilityParams()
  const missingInstance = {
    targetId: 'track-1',
    effect: 'utility',
    from: envelope(utility),
    to: envelope({ ...utility, pan: 0.2 }),
  } satisfies EffectParamsCommitPayload<'utility'>
  expect(mapNativeBuiltInParameterCommit(missingInstance, 120)).toBeUndefined()

  const mixed = {
    ...missingInstance,
    instanceId: 'fx-1',
    to: envelope({ ...utility, pan: 0.2, polarity: 'invert' }),
  } satisfies EffectParamsCommitPayload<'utility'>
  expect(mapNativeBuiltInParameterCommit(mixed, 120)).toBeUndefined()

  const compressor = createDefaultCompressorParams()
  const unsupported = {
    targetId: 'track-1',
    effect: 'compressor',
    instanceId: 'fx-2',
    from: compressor,
    to: { ...compressor, thresholdDb: -12 },
  } satisfies EffectParamsCommitPayload<'compressor'>
  expect(mapNativeBuiltInParameterCommit(unsupported, 120)?.values).toEqual([
    { parameterId: 'compressor.thresholdDb', value: -12 },
  ])
})

test('resolves sync delay time using BPM and maps other supported delay fields', () => {
  const from = createDefaultDelayParams()
  const to: typeof from = { ...from, mode: 'sync', syncDivision: '1/4', feedback: 0.75 }
  const payload = {
    targetId: 'track-1',
    effect: 'delay',
    instanceId: 'delay-1',
    from,
    to,
  } satisfies EffectParamsCommitPayload<'delay'>
  expect(mapNativeBuiltInParameterCommit(payload, 100)).toEqual({
    instanceId: 'delay-1',
    values: [
      { parameterId: 'delay.timeMs', value: 600 },
      { parameterId: 'delay.feedback', value: 0.75 },
    ],
  })
})

test('maps LoFi and Reverb targets while rejecting state-only fields', () => {
  const loFi = createDefaultLoFiParams()
  const loFiPayload = {
    targetId: 'track-1',
    effect: 'lofi',
    instanceId: 'lofi-1',
    from: envelope(loFi),
    to: envelope({ ...loFi, jitter: 0.2, mix: 0.4 }),
  } satisfies EffectParamsCommitPayload<'lofi'>
  expect(mapNativeBuiltInParameterCommit(loFiPayload, 120)?.values).toEqual([
    { parameterId: 'lofi.jitter', value: 0.2 },
    { parameterId: 'lofi.mix', value: 0.4 },
  ])

  const reverb = createDefaultReverbParams()
  const reverbPayload = {
    targetId: 'track-1',
    effect: 'reverb',
    instanceId: 'reverb-1',
    from: reverb,
    to: { ...reverb, decaySec: reverb.decaySec + 1, wet: 0.3 },
  } satisfies EffectParamsCommitPayload<'reverb'>
  expect(mapNativeBuiltInParameterCommit(reverbPayload, 120)?.values).toEqual([
    { parameterId: 'reverb.wet', value: 0.3 },
    { parameterId: 'reverb.decaySec', value: 3.2 },
  ])
})

test('maps track and master EQ continuous band controls with stable band IDs', () => {
  const from = createDefaultEqParams()
  const to = {
    ...structuredClone(from),
    bands: from.bands.map((band, index) => index === 2
      ? { ...band, frequency: 1800, gainDb: 4, q: 1.5 }
      : structuredClone(band)),
  }
  const trackPayload = {
    targetId: 'track-1',
    effect: 'eq',
    instanceId: 'eq-1',
    from: structuredClone(from),
    to,
  } satisfies EffectParamsCommitPayload<'eq'>
  expect(mapNativeBuiltInParameterCommit(trackPayload, 120)).toEqual({
    instanceId: 'eq-1',
    values: [
      { parameterId: 'eq.b3.frequencyHz', value: 1800 },
      { parameterId: 'eq.b3.gainDb', value: 4 },
      { parameterId: 'eq.b3.q', value: 1.5 },
    ],
  })

  const masterPayload = {
    targetId: 'master',
    effect: 'master-eq',
    instanceId: 'master-eq-1',
    from: structuredClone(from),
    to: { ...structuredClone(from), bands: from.bands.map((band, index) => index === 7 ? { ...band, gainDb: -3 } : structuredClone(band)) },
  } satisfies EffectParamsCommitPayload<'master-eq'>
  expect(mapNativeBuiltInParameterCommit(masterPayload, 120)).toEqual({
    instanceId: 'master-eq-1',
    values: [{ parameterId: 'eq.b8.gainDb', value: -3 }],
  })
})

test('rejects unsupported EQ structural and mode changes atomically', () => {
  const from = createDefaultEqParams()
  const cases = [
    { ...structuredClone(from), enabled: false, bands: from.bands.map((band, index) => index === 0 ? { ...band, frequency: band.frequency + 100 } : structuredClone(band)) },
    { ...structuredClone(from), enabled: false },
    { ...structuredClone(from), channelMode: 'mono' as const },
    { ...structuredClone(from), bands: from.bands.map((band, index) => index === 0 ? { ...band, enabled: !band.enabled } : structuredClone(band)) },
    { ...structuredClone(from), bands: from.bands.map((band, index) => index === 0 ? { ...band, type: 'peaking' as const } : structuredClone(band)) },
    { ...structuredClone(from), bands: [...structuredClone(from.bands)].reverse() },
    { ...structuredClone(from), bands: from.bands.slice(0, 7).map((band) => structuredClone(band)) },
  ]
  for (const to of cases) {
    const payload = {
      targetId: 'track-1',
      effect: 'eq',
      instanceId: 'eq-1',
      from: structuredClone(from),
      to,
    } satisfies EffectParamsCommitPayload<'eq'>
    expect(mapNativeBuiltInParameterCommit(payload, 120)).toBeUndefined()
  }
})

test('maps all default EQ bands to stable frequency, gain, and Q targets', () => {
  const from = createDefaultEqParams()
  const to = {
    ...structuredClone(from),
    bands: from.bands.map((band, index) => ({
      ...band,
      frequency: band.frequency + index + 1,
      gainDb: band.gainDb + index + 1,
      q: band.q + (index + 1) / 10,
    })),
  }
  const payload = {
    targetId: 'track-1',
    effect: 'eq',
    instanceId: 'eq-all-bands',
    from: structuredClone(from),
    to,
  } satisfies EffectParamsCommitPayload<'eq'>
  expect(mapNativeBuiltInParameterCommit(payload, 120)?.values).toEqual(
    from.bands.flatMap((band, index) => {
      const nextBand = to.bands[index]
      if (!nextBand) throw new Error(`Missing mapped EQ band ${index}.`)
      return [
        { parameterId: `eq.${band.id}.frequencyHz`, value: nextBand.frequency },
        { parameterId: `eq.${band.id}.gainDb`, value: nextBand.gainDb },
        { parameterId: `eq.${band.id}.q`, value: nextBand.q },
      ]
    }),
  )

  const masterTo = {
    ...structuredClone(from),
    bands: from.bands.map((band, index) => index === 0
      ? { ...band, gainDb: band.gainDb + 2 }
      : structuredClone(band)),
  }
  const masterPayload = {
    targetId: 'master',
    effect: 'master-eq',
    instanceId: 'master-eq-all-bands',
    from: structuredClone(from),
    to: masterTo,
  } satisfies EffectParamsCommitPayload<'master-eq'>
  const firstBand = masterTo.bands[0]
  if (!firstBand) throw new Error('Missing master EQ band.')
  expect(mapNativeBuiltInParameterCommit(masterPayload, 120)?.values).toEqual(
    [{ parameterId: `eq.${firstBand.id}.gainDb`, value: firstBand.gainDb }],
  )
})
