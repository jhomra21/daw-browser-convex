import { isJsonBoolean, isJsonNumber, isJsonObject, type JsonObject, type JsonValue } from './json-value'

export const SYNTH_STATE_VERSION = 2
export const SYNTH_PARAMETER_LIMITS = {
  envelopeSeconds: { min: 0, max: 60 },
  sustain: { min: 0, max: 1 },
  oscillatorOctave: { min: -3, max: 3 },
  oscillatorSemitone: { min: -12, max: 12 },
  oscillatorDetuneCents: { min: -100, max: 100 },
  oscillatorLevel: { min: 0, max: 1 },
  filterFrequencyHz: { min: 20, max: 20_000 },
  filterQ: { min: 0.0001, max: 30 },
  filterKeyTracking: { min: 0, max: 1 },
  filterEnvelopeAmountOctaves: { min: -6, max: 6 },
  lfoFrequencyHz: { min: 0.01, max: 100 },
  lfoPitchCents: { min: -1200, max: 1200 },
  lfoFilterOctaves: { min: -6, max: 6 },
  lfoAmp: { min: 0, max: 1 },
  lfoPan: { min: 0, max: 1 },
  noiseLevel: { min: 0, max: 1 },
  gain: { min: 0, max: 1.5 },
  pan: { min: -1, max: 1 },
  polyphony: { min: 1, max: 128 },
}

export type SynthWave = 'sine' | 'square' | 'sawtooth' | 'triangle'
export type SynthFilterMode = 'lowpass' | 'highpass' | 'bandpass' | 'notch'

export type SynthOscillatorParams = {
  enabled: boolean
  wave: SynthWave
  octave: number
  semitone: number
  detuneCents: number
  level: number
}

export type SynthEnvelopeParams = {
  attackSec: number
  decaySec: number
  sustain: number
  releaseSec: number
}

export type SynthFilterParams = {
  enabled: boolean
  mode: SynthFilterMode
  frequencyHz: number
  q: number
  keyTracking: number
  envelopeAmountOctaves: number
  envelope: SynthEnvelopeParams
}

export type SynthLfoParams = {
  enabled: boolean
  wave: SynthWave
  frequencyHz: number
  pitchCents: number
  filterOctaves: number
  amp: number
  pan: number
}

export type SynthNoiseParams = {
  enabled: boolean
  level: number
}

export type SynthParams = {
  version: typeof SYNTH_STATE_VERSION
  oscillators: [SynthOscillatorParams, SynthOscillatorParams]
  ampEnvelope: SynthEnvelopeParams
  filter: SynthFilterParams
  lfo: SynthLfoParams
  noise: SynthNoiseParams
  gain: number
  pan: number
  polyphony: number
  retrigger: boolean
}

export type SynthParamsInput = JsonValue

export type SynthParamsUpdate = {
  oscillators?: readonly [
    Partial<SynthOscillatorParams>?,
    Partial<SynthOscillatorParams>?,
  ]
  ampEnvelope?: Partial<SynthEnvelopeParams>
  filter?: Partial<Omit<SynthFilterParams, 'envelope'>> & { envelope?: Partial<SynthEnvelopeParams> }
  lfo?: Partial<SynthLfoParams>
  noise?: Partial<SynthNoiseParams>
  gain?: number
  pan?: number
  polyphony?: number
  retrigger?: boolean
}

type LegacySynthParams = {
  wave1?: SynthWave
  wave2?: SynthWave
  gain?: number
  attackMs?: number
  releaseMs?: number
}

const finiteNumber = (value: JsonValue | undefined) => (
  isJsonNumber(value) && Number.isFinite(value) ? value : undefined
)

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const integer = (value: JsonValue | undefined, fallback: number, min: number, max: number) => {
  const number = finiteNumber(value)
  return number === undefined ? fallback : clamp(Math.round(number), min, max)
}
const number = (value: JsonValue | undefined, fallback: number, min: number, max: number) => {
  const input = finiteNumber(value)
  return input === undefined ? fallback : clamp(input, min, max)
}

const isFiniteNumber = (value: JsonValue | undefined): value is number => (
  isJsonNumber(value) && Number.isFinite(value)
)

export const isSynthWave = (value: JsonValue): value is SynthWave => (
  value === 'sine' || value === 'square' || value === 'sawtooth' || value === 'triangle'
)

export const isSynthFilterMode = (value: JsonValue): value is SynthFilterMode => (
  value === 'lowpass' || value === 'highpass' || value === 'bandpass' || value === 'notch'
)

export const createDefaultSynthParams = (): SynthParams => ({
  version: SYNTH_STATE_VERSION,
  oscillators: [
    { enabled: true, wave: 'sawtooth', octave: 0, semitone: 0, detuneCents: -7, level: 0.7 },
    { enabled: true, wave: 'sawtooth', octave: 0, semitone: 0, detuneCents: 7, level: 0.45 },
  ],
  ampEnvelope: { attackSec: 0.005, decaySec: 0.1, sustain: 0.8, releaseSec: 0.12 },
  filter: {
    enabled: true,
    mode: 'lowpass',
    frequencyHz: 12000,
    q: 0.7,
    keyTracking: 0,
    envelopeAmountOctaves: 0,
    envelope: { attackSec: 0.005, decaySec: 0.15, sustain: 0, releaseSec: 0.15 },
  },
  lfo: { enabled: false, wave: 'sine', frequencyHz: 5, pitchCents: 0, filterOctaves: 0, amp: 0, pan: 0 },
  noise: { enabled: false, level: 0.25 },
  gain: 0.8,
  pan: 0,
  polyphony: 1,
  retrigger: true,
})

const normalizeEnvelope = (input: JsonValue | undefined, defaults: SynthEnvelopeParams): SynthEnvelopeParams => {
  const value = isJsonObject(input) ? input : {}
  return {
    attackSec: number(value.attackSec, defaults.attackSec, SYNTH_PARAMETER_LIMITS.envelopeSeconds.min, SYNTH_PARAMETER_LIMITS.envelopeSeconds.max),
    decaySec: number(value.decaySec, defaults.decaySec, SYNTH_PARAMETER_LIMITS.envelopeSeconds.min, SYNTH_PARAMETER_LIMITS.envelopeSeconds.max),
    sustain: number(value.sustain, defaults.sustain, SYNTH_PARAMETER_LIMITS.sustain.min, SYNTH_PARAMETER_LIMITS.sustain.max),
    releaseSec: number(value.releaseSec, defaults.releaseSec, SYNTH_PARAMETER_LIMITS.envelopeSeconds.min, SYNTH_PARAMETER_LIMITS.envelopeSeconds.max),
  }
}

const normalizeOscillator = (input: JsonValue | undefined, defaults: SynthOscillatorParams): SynthOscillatorParams => {
  const value = isJsonObject(input) ? input : {}
  return {
    enabled: isJsonBoolean(value.enabled) ? value.enabled : defaults.enabled,
    wave: isSynthWave(value.wave) ? value.wave : defaults.wave,
    octave: integer(value.octave, defaults.octave, SYNTH_PARAMETER_LIMITS.oscillatorOctave.min, SYNTH_PARAMETER_LIMITS.oscillatorOctave.max),
    semitone: integer(value.semitone, defaults.semitone, SYNTH_PARAMETER_LIMITS.oscillatorSemitone.min, SYNTH_PARAMETER_LIMITS.oscillatorSemitone.max),
    detuneCents: number(value.detuneCents, defaults.detuneCents, SYNTH_PARAMETER_LIMITS.oscillatorDetuneCents.min, SYNTH_PARAMETER_LIMITS.oscillatorDetuneCents.max),
    level: number(value.level, defaults.level, SYNTH_PARAMETER_LIMITS.oscillatorLevel.min, SYNTH_PARAMETER_LIMITS.oscillatorLevel.max),
  }
}

const normalizeV2SynthParams = (input: JsonObject): SynthParams => {
  const defaults = createDefaultSynthParams()
  const oscillators = Array.isArray(input.oscillators) ? input.oscillators : []
  const filterInput = isJsonObject(input.filter) ? input.filter : {}
  const lfoInput = isJsonObject(input.lfo) ? input.lfo : {}
  const noiseInput = isJsonObject(input.noise) ? input.noise : {}
  return {
    version: SYNTH_STATE_VERSION,
    oscillators: [
      normalizeOscillator(oscillators[0], defaults.oscillators[0]),
      normalizeOscillator(oscillators[1], defaults.oscillators[1]),
    ],
    ampEnvelope: normalizeEnvelope(input.ampEnvelope, defaults.ampEnvelope),
    filter: {
      enabled: isJsonBoolean(filterInput.enabled) ? filterInput.enabled : defaults.filter.enabled,
      mode: isSynthFilterMode(filterInput.mode) ? filterInput.mode : defaults.filter.mode,
      frequencyHz: number(filterInput.frequencyHz, defaults.filter.frequencyHz, SYNTH_PARAMETER_LIMITS.filterFrequencyHz.min, SYNTH_PARAMETER_LIMITS.filterFrequencyHz.max),
      q: number(filterInput.q, defaults.filter.q, SYNTH_PARAMETER_LIMITS.filterQ.min, SYNTH_PARAMETER_LIMITS.filterQ.max),
      keyTracking: number(filterInput.keyTracking, defaults.filter.keyTracking, SYNTH_PARAMETER_LIMITS.filterKeyTracking.min, SYNTH_PARAMETER_LIMITS.filterKeyTracking.max),
      envelopeAmountOctaves: number(filterInput.envelopeAmountOctaves, defaults.filter.envelopeAmountOctaves, SYNTH_PARAMETER_LIMITS.filterEnvelopeAmountOctaves.min, SYNTH_PARAMETER_LIMITS.filterEnvelopeAmountOctaves.max),
      envelope: normalizeEnvelope(filterInput.envelope, defaults.filter.envelope),
    },
    lfo: {
      enabled: isJsonBoolean(lfoInput.enabled) ? lfoInput.enabled : defaults.lfo.enabled,
      wave: isSynthWave(lfoInput.wave) ? lfoInput.wave : defaults.lfo.wave,
      frequencyHz: number(lfoInput.frequencyHz, defaults.lfo.frequencyHz, SYNTH_PARAMETER_LIMITS.lfoFrequencyHz.min, SYNTH_PARAMETER_LIMITS.lfoFrequencyHz.max),
      pitchCents: number(lfoInput.pitchCents, defaults.lfo.pitchCents, SYNTH_PARAMETER_LIMITS.lfoPitchCents.min, SYNTH_PARAMETER_LIMITS.lfoPitchCents.max),
      filterOctaves: number(lfoInput.filterOctaves, defaults.lfo.filterOctaves, SYNTH_PARAMETER_LIMITS.lfoFilterOctaves.min, SYNTH_PARAMETER_LIMITS.lfoFilterOctaves.max),
      amp: number(lfoInput.amp, defaults.lfo.amp, SYNTH_PARAMETER_LIMITS.lfoAmp.min, SYNTH_PARAMETER_LIMITS.lfoAmp.max),
      pan: number(lfoInput.pan, defaults.lfo.pan, SYNTH_PARAMETER_LIMITS.lfoPan.min, SYNTH_PARAMETER_LIMITS.lfoPan.max),
    },
    noise: {
      enabled: isJsonBoolean(noiseInput.enabled) ? noiseInput.enabled : defaults.noise.enabled,
      level: number(noiseInput.level, defaults.noise.level, SYNTH_PARAMETER_LIMITS.noiseLevel.min, SYNTH_PARAMETER_LIMITS.noiseLevel.max),
    },
    gain: number(input.gain, defaults.gain, SYNTH_PARAMETER_LIMITS.gain.min, SYNTH_PARAMETER_LIMITS.gain.max),
    pan: number(input.pan, defaults.pan, SYNTH_PARAMETER_LIMITS.pan.min, SYNTH_PARAMETER_LIMITS.pan.max),
    polyphony: integer(input.polyphony, defaults.polyphony, SYNTH_PARAMETER_LIMITS.polyphony.min, SYNTH_PARAMETER_LIMITS.polyphony.max),
    retrigger: isJsonBoolean(input.retrigger) ? input.retrigger : defaults.retrigger,
  }
}

const isLegacySynthParams = (value: JsonObject) => (
  'wave1' in value || 'wave2' in value || 'attackMs' in value || 'releaseMs' in value
)

const isCompleteSynthEnvelope = (value: JsonValue | undefined): boolean => (
  isJsonObject(value)
  && isFiniteNumber(value.attackSec)
  && isFiniteNumber(value.decaySec)
  && isFiniteNumber(value.sustain)
  && isFiniteNumber(value.releaseSec)
)

const isCompleteSynthOscillator = (value: JsonValue | undefined): boolean => (
  isJsonObject(value)
  && (value.enabled === undefined || isJsonBoolean(value.enabled))
  && isSynthWave(value.wave)
  && isFiniteNumber(value.octave)
  && isFiniteNumber(value.semitone)
  && isFiniteNumber(value.detuneCents)
  && isFiniteNumber(value.level)
)

const isCompleteSynthNoise = (value: JsonValue | undefined): boolean => (
  isJsonObject(value)
  && isJsonBoolean(value.enabled)
  && isFiniteNumber(value.level)
)

const isCompleteSynthParams = (value: JsonObject): boolean => (
  value.version === SYNTH_STATE_VERSION
  && Array.isArray(value.oscillators)
  && value.oscillators.length === 2
  && isCompleteSynthOscillator(value.oscillators[0])
  && isCompleteSynthOscillator(value.oscillators[1])
  && isCompleteSynthEnvelope(value.ampEnvelope)
  && isJsonObject(value.filter)
  && isJsonBoolean(value.filter.enabled)
  && isSynthFilterMode(value.filter.mode)
  && isFiniteNumber(value.filter.frequencyHz)
  && isFiniteNumber(value.filter.q)
  && isFiniteNumber(value.filter.keyTracking)
  && isFiniteNumber(value.filter.envelopeAmountOctaves)
  && isCompleteSynthEnvelope(value.filter.envelope)
  && isJsonObject(value.lfo)
  && isJsonBoolean(value.lfo.enabled)
  && isSynthWave(value.lfo.wave)
  && isFiniteNumber(value.lfo.frequencyHz)
  && isFiniteNumber(value.lfo.pitchCents)
  && isFiniteNumber(value.lfo.filterOctaves)
  && isFiniteNumber(value.lfo.amp)
  && isFiniteNumber(value.lfo.pan)
  && (value.noise === undefined || isCompleteSynthNoise(value.noise))
  && isFiniteNumber(value.gain)
  && isFiniteNumber(value.pan)
  && isFiniteNumber(value.polyphony)
  && isJsonBoolean(value.retrigger)
)

const isCompleteLegacySynthParams = (value: JsonObject): boolean => (
  isSynthWave(value.wave1)
  && isSynthWave(value.wave2)
  && (value.gain === undefined || isFiniteNumber(value.gain))
  && (value.attackMs === undefined || isFiniteNumber(value.attackMs))
  && (value.releaseMs === undefined || isFiniteNumber(value.releaseMs))
)

export const parseStrictSynthParams = (input: JsonValue): SynthParams | undefined => {
  return isJsonObject(input) && (isCompleteSynthParams(input) || isCompleteLegacySynthParams(input))
    ? normalizeSynthParams(input)
    : undefined
}

export const migrateLegacySynthParams = (legacy: LegacySynthParams): SynthParams => {
  const defaults = createDefaultSynthParams()
  return normalizeV2SynthParams({
    ...defaults,
    oscillators: [
      { ...defaults.oscillators[0], wave: legacy.wave1 ?? defaults.oscillators[0].wave, detuneCents: 0, level: 0.5 },
      { ...defaults.oscillators[1], wave: legacy.wave2 ?? defaults.oscillators[1].wave, detuneCents: 0, level: 0.5 },
    ],
    gain: legacy.gain ?? defaults.gain,
    ampEnvelope: {
      ...defaults.ampEnvelope,
      attackSec: isJsonNumber(legacy.attackMs) ? legacy.attackMs / 1000 : defaults.ampEnvelope.attackSec,
      decaySec: 0,
      sustain: 1,
      releaseSec: isJsonNumber(legacy.releaseMs) ? legacy.releaseMs / 1000 : defaults.ampEnvelope.releaseSec,
    },
  })
}

export const normalizeSynthParams = (input: SynthParamsInput): SynthParams => {
  if (!isJsonObject(input)) return createDefaultSynthParams()
  if (isLegacySynthParams(input)) {
    return migrateLegacySynthParams({
      wave1: isSynthWave(input.wave1) ? input.wave1 : undefined,
      wave2: isSynthWave(input.wave2) ? input.wave2 : undefined,
      gain: finiteNumber(input.gain),
      attackMs: finiteNumber(input.attackMs),
      releaseMs: finiteNumber(input.releaseMs),
    })
  }
  return normalizeV2SynthParams(input)
}

export const mergeSynthParams = (current: SynthParams, update: SynthParamsUpdate): SynthParams => {
  const base = normalizeSynthParams(current)
  return normalizeV2SynthParams({
    ...base,
    oscillators: [
      { ...base.oscillators[0], ...update.oscillators?.[0] },
      { ...base.oscillators[1], ...update.oscillators?.[1] },
    ],
    ampEnvelope: { ...base.ampEnvelope, ...update.ampEnvelope },
    filter: {
      ...base.filter,
      ...update.filter,
      envelope: { ...base.filter.envelope, ...update.filter?.envelope },
    },
    lfo: { ...base.lfo, ...update.lfo },
    noise: { ...base.noise, ...update.noise },
    gain: update.gain ?? base.gain,
    pan: update.pan ?? base.pan,
    polyphony: update.polyphony ?? base.polyphony,
    retrigger: update.retrigger ?? base.retrigger,
  })
}

export const serializeSynthParams = (params: SynthParams): string => JSON.stringify(normalizeSynthParams(params))
