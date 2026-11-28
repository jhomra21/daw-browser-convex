import { describe, expect, test } from 'bun:test'
import { migrateAudioEffectParams, AUDIO_EFFECT_PARAMS_VERSION } from './audio-effect-param-versions'
import { normalizeAudioEffect } from './audio-effect-normalization'
import {
  createDefaultEqParams,
  EQ_BAND_COUNT,
  EQ_BANDS_PER_CURVE,
  EQ_HIGH_QUALITY_LATENCY_FRAMES,
  normalizeEqParams,
  normalizeEqParamsForUpdate,
  supportsGain,
  type EqBandParams,
} from './effects-params'
import type { JsonValue } from './json-value'
import { getAutomationParameterDescriptor } from './automation-parameters'
import { designEqBand, eqChainResponseDb } from './eq-design'

const migrateV1 = (params: JsonValue) => normalizeAudioEffect('eq', migrateAudioEffectParams('eq', params, 1)).params

const v1Bands: EqBandParams[] = [
  { id: 'b1', type: 'highpass', frequency: 80, gainDb: 0, q: 4, enabled: true },
  { id: 'b2', type: 'lowshelf', frequency: 200, gainDb: 3, q: 0.7, enabled: true },
  { id: 'b3', type: 'peaking', frequency: 1000, gainDb: -6, q: 2, enabled: false },
  { id: 'b4', type: 'bandpass', frequency: 1500, gainDb: 0, q: 1, enabled: true },
  { id: 'b5', type: 'notch', frequency: 3000, gainDb: 0, q: 5, enabled: true },
  { id: 'b6', type: 'allpass', frequency: 4000, gainDb: 0, q: 1, enabled: true },
  { id: 'b7', type: 'highshelf', frequency: 8000, gainDb: 2, q: 1, enabled: true },
  { id: 'b8', type: 'lowpass', frequency: 16000, gainDb: 0, q: 1.2, enabled: true },
]

const v1Params = { enabled: true, channelMode: 'stereo', bands: v1Bands }

describe('EQ params v2', () => {
  test('the current version is 2', () => {
    expect(AUDIO_EFFECT_PARAMS_VERSION.eq).toBe(2)
  })

  test('v1 -> v2 keeps every band and adds a second curve and the new device controls, off by default', () => {
    const migrated = migrateV1(v1Params)

    expect(migrated.bands.length).toBe(EQ_BAND_COUNT)
    expect(migrated.bands.slice(0, EQ_BANDS_PER_CURVE)).toEqual(v1Params.bands)
    expect(migrated.bands.slice(EQ_BANDS_PER_CURVE).map((band) => ({ ...band, id: '' })))
      .toEqual(v1Params.bands.map((band) => ({ ...band, id: '' })))
    expect(new Set(migrated.bands.map((band) => band.id)).size).toBe(EQ_BAND_COUNT)
    expect(migrated.channelMode).toBe('stereo')
    expect(migrated.adaptiveQ).toBe(false)
    expect(migrated.scale).toBe(1)
    expect(migrated.outputDb).toBe(0)
    expect(migrated.highQuality).toBe(false)
  })

  test('a v1 mono device stays mono (the sum-to-mono mode is kept so it sounds the same)', () => {
    const migrated = migrateV1({ ...v1Params, channelMode: 'mono' })

    expect(migrated.channelMode).toBe('mono')
  })

  test('new devices default to Hi-Quality on, Stereo, Scale 100 %, Output 0 dB, Adaptive Q off', () => {
    const defaults = createDefaultEqParams()

    expect(defaults).toMatchObject({ channelMode: 'stereo', highQuality: true, scale: 1, outputDb: 0, adaptiveQ: false })
    expect(defaults.bands.length).toBe(EQ_BAND_COUNT)
  })

  test('normalization clamps the new controls and accepts the new band types and modes', () => {
    const params = normalizeEqParams({
      channelMode: 'midSide',
      scale: 9,
      outputDb: -40,
      adaptiveQ: true,
      bands: [{ type: 'highpass48' }, { type: 'lowpass48' }],
    })

    expect(params).toMatchObject({ channelMode: 'midSide', scale: 2, outputDb: -12, adaptiveQ: true })
    expect(params.bands[0]?.type).toBe('highpass48')
    expect(params.bands[1]?.type).toBe('lowpass48')
    expect(normalizeEqParams({ channelMode: 'nope' }).channelMode).toBe('stereo')
  })

  test('an update that carries only the first curve keeps the stored second curve', () => {
    const base = normalizeEqParams({ channelMode: 'leftRight', bands: [...v1Params.bands.map((band) => ({ ...band })), ...v1Params.bands.map((band, index) => ({ ...band, id: `b${index + 9}`, frequency: band.frequency * 1.1 }))] })
    const updated = normalizeEqParamsForUpdate({ bands: v1Params.bands.map((band) => ({ ...band, gainDb: 1 })) }, base)

    expect(updated.bands.slice(EQ_BANDS_PER_CURVE)).toEqual(base.bands.slice(EQ_BANDS_PER_CURVE))
    expect(updated.bands[1]?.gainDb).toBe(1)
  })

  test('cuts, notch and band-pass have no gain; scale only matters for gain types', () => {
    expect(supportsGain('highpass48')).toBe(false)
    expect(supportsGain('lowpass48')).toBe(false)
    expect(supportsGain('peaking')).toBe(true)
  })

  test('the second curve and the global controls are automatable', () => {
    expect(getAutomationParameterDescriptor('eq.b9.frequencyHz')).toMatchObject({ owner: 'eq', min: 20, max: 20000 })
    expect(getAutomationParameterDescriptor('eq.b16.q')).toMatchObject({ owner: 'eq' })
    expect(getAutomationParameterDescriptor('eq.scale')).toMatchObject({ owner: 'eq', min: 0, max: 2, defaultValue: 1 })
    expect(getAutomationParameterDescriptor('eq.outputDb')).toMatchObject({ owner: 'eq', min: -12, max: 12, defaultValue: 0, unit: 'db' })
  })

  test('Hi-Quality latency matches the core constant', () => {
    expect(EQ_HIGH_QUALITY_LATENCY_FRAMES).toBe(3)
  })
})

describe('EQ band design (TypeScript twin of the core)', () => {
  const rate = 48000

  test('a 48 dB cut is 8th order Butterworth: -3 dB at the corner, at least 44 dB down two octaves out', () => {
    const cut = designEqBand('highpass48', 1000, rate, Math.SQRT1_2, 0)

    expect(cut.length).toBe(4)
    const [corner, octaves2] = eqChainResponseDb([cut], [1000, 250], rate)
    expect(corner).toBeCloseTo(-3.01, 1)
    expect(octaves2).toBeLessThan(-44)
  })

  test('a matched bell follows the analog bell near Nyquist (12 kHz, +12 dB, Q 1 at 20 kHz designed at 2x)', () => {
    const bell = designEqBand('peaking', 12000, 2 * rate, 1, 12)
    const [measured] = eqChainResponseDb([bell], [20000], 2 * rate)
    // Analog prototype: (s^2 + sA/Q + 1) / (s^2 + s/(AQ) + 1), A = 10^(12/40), s = j f/f0.
    const a = 10 ** (12 / 40)
    const s = { re: 0, im: 20000 / 12000 }
    const mul = (x: { re: number; im: number }, y: { re: number; im: number }) => ({ re: x.re * y.re - x.im * y.im, im: x.re * y.im + x.im * y.re })
    const s2 = mul(s, s)
    const num = { re: s2.re + 1, im: s2.im + s.im * a }
    const den = { re: s2.re + 1, im: s2.im + s.im / a }
    const analog = 20 * Math.log10(Math.hypot(num.re, num.im) / Math.hypot(den.re, den.im))

    expect(Math.abs((measured ?? 0) - analog)).toBeLessThan(0.5)
  })
})
