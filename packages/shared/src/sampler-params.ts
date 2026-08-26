import { isJsonBoolean, isJsonNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from './json-value'
import type { DrumRackPadSample } from './drum-rack-params'

export const SAMPLER_STATE_VERSION = 1
export const MAX_SAMPLED_INSTRUMENT_VOICES = 32

export type SamplerPlaybackMode = 'one-shot' | 'forward-loop' | 'crossfade-loop'
export type SamplerFilterMode = 'lowpass' | 'highpass' | 'bandpass' | 'notch'
export type SamplerCachePolicy = 'preload' | 'lazy'

export type SamplerEnvelope = {
  attackSec: number
  decaySec: number
  sustain: number
  releaseSec: number
  amount: number
}

export type SamplerLfo = {
  enabled: boolean
  frequencyHz: number
  pitchCents: number
  filterHz: number
  amp: number
  pan: number
}

export type SamplerZone = {
  id: string
  sample: DrumRackPadSample
  keyLow: number
  keyHigh: number
  velocityLow: number
  velocityHigh: number
  rootNote: number
  tuneCents: number
  gain: number
  pan: number
  roundRobinGroup: number
  roundRobinIndex: number
  playbackMode: SamplerPlaybackMode
  startSec: number
  endSec?: number
  loopStartSec?: number
  loopEndSec?: number
  crossfadeSec: number
  chokeGroup: number
}

export type SamplerParams = {
  version: typeof SAMPLER_STATE_VERSION
  zones: readonly SamplerZone[]
  ampEnvelope: SamplerEnvelope
  filterEnvelope: SamplerEnvelope
  filterMode: SamplerFilterMode
  filterFrequencyHz: number
  filterQ: number
  lfo: SamplerLfo
  polyphony: number
  retrigger: boolean
  cachePolicy: SamplerCachePolicy
  maxDecodedBytes: number
}

export type SamplerParamsInput = Partial<Omit<SamplerParams, 'version' | 'zones'>> & {
  version?: JsonValue
  zones?: readonly JsonValue[]
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const finite = (value: JsonValue | undefined, fallback: number) => isJsonNumber(value) && Number.isFinite(value) ? value : fallback
const record = (value: JsonValue): value is JsonObject => isJsonObject(value)

export function createDefaultSamplerParams(): SamplerParams {
  return {
    version: SAMPLER_STATE_VERSION,
    zones: [],
    ampEnvelope: { attackSec: 0.005, decaySec: 0.1, sustain: 1, releaseSec: 0.12, amount: 1 },
    filterEnvelope: { attackSec: 0.005, decaySec: 0.15, sustain: 0, releaseSec: 0.15, amount: 0 },
    filterMode: 'lowpass',
    filterFrequencyHz: 20_000,
    filterQ: 0.7,
    lfo: { enabled: false, frequencyHz: 5, pitchCents: 0, filterHz: 0, amp: 0, pan: 0 },
    polyphony: 32,
    retrigger: true,
    cachePolicy: 'preload',
    maxDecodedBytes: 256 * 1024 * 1024,
  }
}

const normalizeEnvelope = (value: SamplerEnvelope | undefined, fallback: SamplerEnvelope): SamplerEnvelope => {
  if (value === undefined) return fallback
  return {
    attackSec: clamp(finite(value.attackSec, fallback.attackSec), 0, 60),
    decaySec: clamp(finite(value.decaySec, fallback.decaySec), 0, 60),
    sustain: clamp(finite(value.sustain, fallback.sustain), 0, 1),
    releaseSec: clamp(finite(value.releaseSec, fallback.releaseSec), 0, 60),
    amount: clamp(finite(value.amount, fallback.amount), -1, 1),
  }
}

const normalizeZone = (value: JsonValue, index: number): SamplerZone | undefined => {
  if (!record(value) || !record(value.sample) || !isJsonString(value.sample.assetKey) || !isJsonString(value.sample.url)) return undefined
  const source = record(value.sample.source) ? value.sample.source : undefined
  if (!source || !isJsonNumber(source.durationSec) || !isJsonNumber(source.sampleRate) || !isJsonNumber(source.channelCount)) return undefined
  const sourceKind = value.sample.sourceKind
  if (sourceKind !== 'upload' && sourceKind !== 'url' && sourceKind !== 'recording') return undefined
  const startSec = clamp(finite(value.startSec, 0), 0, source.durationSec)
  const endSec = clamp(finite(value.endSec, source.durationSec), startSec, source.durationSec)
  const mode = value.playbackMode === 'forward-loop' || value.playbackMode === 'crossfade-loop' ? value.playbackMode : 'one-shot'
  const loopStartSec = clamp(finite(value.loopStartSec, startSec), startSec, endSec)
  const loopEndSec = clamp(finite(value.loopEndSec, endSec), loopStartSec, endSec)
  const maxCrossfade = Math.max(0, (loopEndSec - loopStartSec) / 2)
  return {
    id: isJsonString(value.id) && value.id ? value.id : `zone-${index}`,
    sample: {
      assetKey: value.sample.assetKey,
      url: value.sample.url,
      name: isJsonString(value.sample.name) ? value.sample.name : undefined,
      sourceKind,
      source: { durationSec: source.durationSec, sampleRate: source.sampleRate, channelCount: source.channelCount },
    },
    keyLow: Math.round(clamp(finite(value.keyLow, 0), 0, 127)),
    keyHigh: Math.round(clamp(finite(value.keyHigh, 127), 0, 127)),
    velocityLow: Math.round(clamp(finite(value.velocityLow, 1), 1, 127)),
    velocityHigh: Math.round(clamp(finite(value.velocityHigh, 127), 1, 127)),
    rootNote: Math.round(clamp(finite(value.rootNote, 60), 0, 127)),
    tuneCents: clamp(finite(value.tuneCents, 0), -4800, 4800),
    gain: clamp(finite(value.gain, 1), 0, 4),
    pan: clamp(finite(value.pan, 0), -1, 1),
    roundRobinGroup: Math.round(clamp(finite(value.roundRobinGroup, 0), 0, 128)),
    roundRobinIndex: Math.round(clamp(finite(value.roundRobinIndex, 0), 0, 128)),
    playbackMode: mode,
    startSec,
    endSec,
    loopStartSec: mode === 'one-shot' ? undefined : loopStartSec,
    loopEndSec: mode === 'one-shot' ? undefined : loopEndSec,
    crossfadeSec: mode === 'crossfade-loop' ? clamp(finite(value.crossfadeSec, 0.01), 0, maxCrossfade) : 0,
    chokeGroup: Math.round(clamp(finite(value.chokeGroup, 0), 0, 128)),
  }
}

export function normalizeSamplerParams(input: SamplerParamsInput): SamplerParams {
  const defaults = createDefaultSamplerParams()
  const zones = (input.zones ?? []).flatMap((zone, index) => {
    const normalized = normalizeZone(zone, index)
    return normalized && normalized.keyLow <= normalized.keyHigh && normalized.velocityLow <= normalized.velocityHigh ? [normalized] : []
  })
  const filterMode = input.filterMode === 'highpass' || input.filterMode === 'bandpass' || input.filterMode === 'notch' ? input.filterMode : 'lowpass'
  return {
    version: SAMPLER_STATE_VERSION,
    zones,
    ampEnvelope: normalizeEnvelope(input.ampEnvelope, defaults.ampEnvelope),
    filterEnvelope: normalizeEnvelope(input.filterEnvelope, defaults.filterEnvelope),
    filterMode,
    filterFrequencyHz: clamp(finite(input.filterFrequencyHz, defaults.filterFrequencyHz), 20, 20_000),
    filterQ: clamp(finite(input.filterQ, defaults.filterQ), 0.05, 30),
    lfo: {
      enabled: isJsonBoolean(input.lfo?.enabled) ? input.lfo.enabled : defaults.lfo.enabled,
      frequencyHz: clamp(finite(input.lfo?.frequencyHz, defaults.lfo.frequencyHz), 0.01, 100),
      pitchCents: clamp(finite(input.lfo?.pitchCents, defaults.lfo.pitchCents), -2400, 2400),
      filterHz: clamp(finite(input.lfo?.filterHz, defaults.lfo.filterHz), -20_000, 20_000),
      amp: clamp(finite(input.lfo?.amp, defaults.lfo.amp), 0, 1),
      pan: clamp(finite(input.lfo?.pan, defaults.lfo.pan), 0, 1),
    },
    polyphony: Math.round(clamp(finite(input.polyphony, defaults.polyphony), 1, MAX_SAMPLED_INSTRUMENT_VOICES)),
    retrigger: isJsonBoolean(input.retrigger) ? input.retrigger : defaults.retrigger,
    cachePolicy: input.cachePolicy === 'lazy' ? 'lazy' : 'preload',
    maxDecodedBytes: Math.round(clamp(finite(input.maxDecodedBytes, defaults.maxDecodedBytes), 1024 * 1024, 2 * 1024 * 1024 * 1024)),
  }
}

export const serializeSamplerParams = (params: SamplerParams): string => JSON.stringify(params)
