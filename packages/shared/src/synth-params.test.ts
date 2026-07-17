import { describe, expect, test } from 'bun:test'
import {
  SYNTH_STATE_VERSION,
  createDefaultSynthParams,
  mergeSynthParams,
  normalizeSynthParams,
  parseStrictSynthParams,
  serializeSynthParams,
} from './synth-params'

describe('synth parameter contract', () => {
  test('creates independent nested defaults', () => {
    const first = createDefaultSynthParams()
    const second = createDefaultSynthParams()
    first.oscillators[0].level = 0
    first.filter.envelope.attackSec = 1
    expect(second.oscillators[0].level).toBe(0.7)
    expect(second.filter.envelope.attackSec).toBe(0.005)
  })

  test('normalizes unknown values and clamps every numeric domain', () => {
    expect(normalizeSynthParams({
      version: 999,
      oscillators: [{ wave: 'invalid', octave: 9.5, semitone: -15.5, detuneCents: Infinity, level: -1 }],
      ampEnvelope: { attackSec: NaN, decaySec: 100, sustain: -1, releaseSec: Infinity },
      filter: { frequencyHz: 99999, q: -4, keyTracking: 2, envelopeAmountOctaves: -9, envelope: { attackSec: -1 } },
      lfo: { wave: 'invalid', frequencyHz: 0, pitchCents: 1300, filterOctaves: -7, amp: 2, pan: -1 },
      gain: 2,
      pan: -2,
      polyphony: 9.5,
      retrigger: 'yes',
    })).toEqual({
      version: SYNTH_STATE_VERSION,
      oscillators: [
        { enabled: true, wave: 'sawtooth', octave: 3, semitone: -12, detuneCents: -7, level: 0 },
        { enabled: true, wave: 'sawtooth', octave: 0, semitone: 0, detuneCents: 7, level: 0.45 },
      ],
      ampEnvelope: { attackSec: 0.005, decaySec: 60, sustain: 0, releaseSec: 0.12 },
      filter: {
        enabled: true, mode: 'lowpass', frequencyHz: 20000, q: 0.0001, keyTracking: 1, envelopeAmountOctaves: -6,
        envelope: { attackSec: 0, decaySec: 0.15, sustain: 0, releaseSec: 0.15 },
      },
      lfo: { enabled: false, wave: 'sine', frequencyHz: 0.01, pitchCents: 1200, filterOctaves: -6, amp: 1, pan: 0 },
      noise: { enabled: false, level: 0.25 },
      gain: 1.5, pan: -1, polyphony: 10, retrigger: true,
    })
  })

  test('migrates legacy state with equal oscillator levels and serializes v2', () => {
    const params = normalizeSynthParams({
      wave1: 'sine',
      wave2: 'square',
      gain: 0.7,
      attackMs: 20,
      releaseMs: 80,
    })
    expect(params).toMatchObject({
      version: SYNTH_STATE_VERSION,
      oscillators: [{ wave: 'sine', detuneCents: 0, level: 0.5 }, { wave: 'square', detuneCents: 0, level: 0.5 }],
      ampEnvelope: { attackSec: 0.02, decaySec: 0, sustain: 1, releaseSec: 0.08 },
      gain: 0.7,
    })
    expect(normalizeSynthParams(JSON.parse(serializeSynthParams(params)))).toEqual(params)
  })

  test('merges deep updates without dropping sibling state', () => {
    const current = createDefaultSynthParams()
    const next = mergeSynthParams(current, {
      oscillators: [{ level: 0.2 }],
      filter: { envelope: { releaseSec: 2 } },
      lfo: { frequencyHz: 7 },
      noise: { enabled: true, level: 2 },
    })
    expect(next.oscillators[0].level).toBe(0.2)
    expect(next.oscillators[1]).toEqual(current.oscillators[1])
    expect(next.filter.envelope).toEqual({ ...current.filter.envelope, releaseSec: 2 })
    expect(next.lfo).toEqual({ ...current.lfo, frequencyHz: 7 })
    expect(next.noise).toEqual({ enabled: true, level: 1 })
  })

  test('defaults missing v2 oscillator enabled state and persists disabled oscillators', () => {
    const defaults = createDefaultSynthParams()
    const oldV2State = {
      ...defaults,
      oscillators: [
        {
          wave: defaults.oscillators[0].wave,
          octave: defaults.oscillators[0].octave,
          semitone: defaults.oscillators[0].semitone,
          detuneCents: defaults.oscillators[0].detuneCents,
          level: defaults.oscillators[0].level,
        },
        {
          wave: defaults.oscillators[1].wave,
          octave: defaults.oscillators[1].octave,
          semitone: defaults.oscillators[1].semitone,
          detuneCents: defaults.oscillators[1].detuneCents,
          level: defaults.oscillators[1].level,
        },
      ],
    }
    const normalized = parseStrictSynthParams(oldV2State)
    const next = mergeSynthParams(defaults, { oscillators: [{ enabled: false }] })

    expect(normalized?.oscillators.map((oscillator) => oscillator.enabled)).toEqual([true, true])
    expect(next.oscillators[0].enabled).toBe(false)
    expect(next.oscillators[0].level).toBe(defaults.oscillators[0].level)
    expect(JSON.parse(serializeSynthParams(next)).oscillators[0].enabled).toBe(false)
  })

  test('strictly parses old v2 noise omissions and persists complete noise state', () => {
    const defaults = createDefaultSynthParams()
    const { noise: _noise, ...oldV2 } = defaults
    const parsed = parseStrictSynthParams(oldV2)
    const enabled = mergeSynthParams(defaults, { noise: { enabled: true, level: 0.6 } })

    expect(parsed?.noise).toEqual(defaults.noise)
    expect(parseStrictSynthParams({ ...defaults, noise: { enabled: true } })).toBeUndefined()
    expect(JSON.parse(serializeSynthParams(enabled)).noise).toEqual({ enabled: true, level: 0.6 })
  })
})
