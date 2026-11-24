import { describe, expect, it } from 'bun:test'
import { AUDIO_EFFECT_PARAMS_VERSION, migrateAudioEffectParams } from './audio-effect-param-versions'
import { AUTO_FILTER_MAX_Q, AUTO_FILTER_MIN_Q, normalizeAutoFilterParamsEnvelope } from './effects-params'
import { isJsonObject, type JsonValue } from './json-value'

// The shape every stored Auto Filter had before params version 2.
const storedV1 = (state: Record<string, JsonValue> = {}): JsonValue => ({
  version: 1,
  state: {
    enabled: true, mode: 'lowpass', quality: '2x', frequencyHz: 1000, resonance: 0.25, driveDb: 0, mix: 1,
    envelope: { amountOctaves: 0, attackMs: 10, releaseMs: 100 },
    lfo: { waveform: 'sine', rateHz: 1, depthOctaves: 0, phaseOffset: 0, stereoPhase: 0 },
    ...state,
  },
})

const migrated = (state: Record<string, JsonValue> = {}) => normalizeAutoFilterParamsEnvelope(migrateAudioEffectParams('autofilter', storedV1(state), 1)).state

const qOf = (resonance: number) => AUTO_FILTER_MIN_Q * (AUTO_FILTER_MAX_Q / AUTO_FILTER_MIN_Q) ** resonance

describe('Auto Filter params version 2', () => {
  it('is the current version', () => {
    expect(AUDIO_EFFECT_PARAMS_VERSION.autofilter).toBe(2)
  })

  it('keeps the old resonance peak height: the new knob gives the same Q as the old law', () => {
    for (const old of [0.05, 0.25, 0.3, 0.38]) {
      expect(qOf(migrated({ resonance: old }).resonance)).toBeCloseTo(0.5 + 19.5 * old, 6)
    }
  })

  it('clamps a resonance beyond the new top Q to the top and below Butterworth to zero', () => {
    expect(migrated({ resonance: 1 }).resonance).toBe(1)
    expect(qOf(migrated({ resonance: 1 }).resonance)).toBe(AUTO_FILTER_MAX_Q)
    expect(migrated({ resonance: 0 }).resonance).toBe(0)
  })

  it('turns Hi-Quality off, keeps 12 dB and adds no new processing', () => {
    const state = migrated()

    expect(state.hiQuality).toBe(false)
    expect(state.slope).toBe(12)
    expect(state.clip).toBe(false)
    expect(state.outputDb).toBe(0)
    expect(state.envelope.hold).toBe(false)
    expect(state.envelope.link).toBe(false)
    expect(state.lfo.sync).toBe(false)
    expect(state.lfo.stereoMode).toBe('phase')
  })

  it('carries over the knobs whose meaning did not change', () => {
    const state = migrated({
      mode: 'bandpass', frequencyHz: 432, mix: 0.4,
      envelope: { amountOctaves: 0, attackMs: 22, releaseMs: 333 },
      lfo: { waveform: 'triangle', rateHz: 3.5, depthOctaves: 1.5, phaseOffset: 0.25, stereoPhase: -0.1 },
    })

    expect(state.mode).toBe('bandpass')
    expect(state.frequencyHz).toBe(432)
    expect(state.mix).toBe(0.4)
    expect(state.envelope.attackMs).toBe(22)
    expect(state.envelope.releaseMs).toBe(333)
    expect(state.lfo).toMatchObject({ waveform: 'triangle', rateHz: 3.5, depthOctaves: 1.5, phaseOffset: 0.25, stereoPhase: -0.1 })
  })

  it('rescales the envelope amount to the new dB law at a -12 dBFS reference', () => {
    // old excursion at -12 dBFS: amount * 10^(-12/20); new: amount' * (60 - 12) / 60
    const old = migrated({ envelope: { amountOctaves: 3, attackMs: 10, releaseMs: 100 } }).envelope.amountOctaves

    expect(old * (48 / 60)).toBeCloseTo(3 * 10 ** (-12 / 20), 4)
    expect(migrated({ envelope: { amountOctaves: -6, attackMs: 10, releaseMs: 100 } }).envelope.amountOctaves).toBeGreaterThanOrEqual(-6)
  })

  it('compensates the loudness the old drive added at a -12 dBFS reference with the new output slider', () => {
    const added = (driveDb: number) => 20 * Math.log10(Math.tanh(0.25 * 10 ** (driveDb / 20)) / 0.25)

    expect(migrated({ driveDb: 0 }).outputDb).toBe(0)
    expect(migrated({ driveDb: 6 }).outputDb).toBeCloseTo(added(6), 6)
    expect(migrated({ driveDb: 24 }).outputDb).toBeCloseTo(added(24), 6)
    expect(added(24)).toBeLessThan(12.1)
    expect(migrated({ driveDb: 6 }).driveDb).toBe(6)
  })
  it('compensates the old band-pass gain of Q at the cutoff', () => {
    const state = migrated({ mode: 'bandpass', resonance: 0.25 })

    expect(state.outputDb).toBeCloseTo(20 * Math.log10(0.5 + 19.5 * 0.25), 4)
    expect(migrated({ mode: 'lowpass', resonance: 0.25 }).outputDb).toBe(0)
  })

  it('migrates a bare state and an enveloped one alike, and leaves version 2 params alone', () => {
    const bare = storedV1()
    const state = isJsonObject(bare) ? bare.state : null

    expect(normalizeAutoFilterParamsEnvelope(migrateAudioEffectParams('autofilter', state, 1)).state).toEqual(migrated())
    const current = { version: 1, state: migrated() }

    expect(migrateAudioEffectParams('autofilter', current, 2)).toBe(current)
  })
})
