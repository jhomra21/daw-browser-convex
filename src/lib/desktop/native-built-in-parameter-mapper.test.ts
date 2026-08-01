import { expect, test } from 'bun:test'
import {
  createDefaultAutoFilterParams,
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultEqParams,
  createDefaultLoFiParams,
  createDefaultReverbParams,
  createDefaultSpectralParams,
  createDefaultUtilityParams,
} from '@daw-browser/shared'
import type { EffectParamsCommitPayload } from '~/lib/undo/types'
import { mapNativeBuiltInParameterCommit } from './native-built-in-parameter-mapper'

const envelope = <State>(state: State): { version: 1; state: State } => ({ version: 1, state })

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
  expect(mapNativeBuiltInParameterCommit(unsupported, 120)).toBeUndefined()
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
  expect(mapNativeBuiltInParameterCommit(reverbPayload, 120)).toBeUndefined()
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
