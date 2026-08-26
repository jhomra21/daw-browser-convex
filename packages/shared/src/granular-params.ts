import type { SamplerZone } from './sampler-params'
import { isJsonBoolean, isJsonNumber, isJsonObject, isJsonString, type JsonValue } from './json-value'

export const GRANULAR_STATE_VERSION = 1
export const GRANULAR_MAX_GRAINS = 128
export type GranularWindowKind = 'hann' | 'tukey' | 'gaussian'

export type GranularParams = {
  version: typeof GRANULAR_STATE_VERSION
  zone?: SamplerZone
  grainSizeMs: number
  densityHz: number
  position: number
  spray: number
  pitchSemitones: number
  reverseProbability: number
  'windowShape': GranularWindowKind
  stereoSpread: number
  freeze: boolean
  seed: number
  maxGrains: number
  maxDecodedBytes: number
}

export type GranularParamsInput = JsonValue

const finite = (value: JsonValue | undefined, fallback: number) => isJsonNumber(value) && Number.isFinite(value) ? value : fallback
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value))

export function createDefaultGranularParams(): GranularParams {
  return {
    version: GRANULAR_STATE_VERSION,
    grainSizeMs: 80,
    densityHz: 12,
    position: 0.5,
    spray: 0.1,
    pitchSemitones: 0,
    reverseProbability: 0,
    'windowShape': 'hann',
    stereoSpread: 0.5,
    freeze: false,
    seed: 1,
    maxGrains: 64,
    maxDecodedBytes: 64 * 1024 * 1024,
  }
}

const isZone = (value: JsonValue | undefined): value is SamplerZone => {
  if (!isJsonObject(value) || !isJsonObject(value.sample)) return false
  const sample = value.sample
  return isJsonString(sample.assetKey)
    && isJsonString(sample.url)
}

export function normalizeGranularParams(input: GranularParamsInput): GranularParams {
  const defaults = createDefaultGranularParams()
  const value = isJsonObject(input) ? input : {}
  return {
    version: GRANULAR_STATE_VERSION,
    zone: isZone(value.zone) ? value.zone : undefined,
    grainSizeMs: clamp(finite(value.grainSizeMs, defaults.grainSizeMs), 5, 1000),
    densityHz: clamp(finite(value.densityHz, defaults.densityHz), 0.25, 200),
    position: clamp(finite(value.position, defaults.position), 0, 1),
    spray: clamp(finite(value.spray, defaults.spray), 0, 1),
    pitchSemitones: clamp(finite(value.pitchSemitones, defaults.pitchSemitones), -48, 48),
    reverseProbability: clamp(finite(value.reverseProbability, defaults.reverseProbability), 0, 1),
    'windowShape': value['windowShape'] === 'tukey' || value['windowShape'] === 'gaussian' ? value['windowShape'] : 'hann',
    stereoSpread: clamp(finite(value.stereoSpread, defaults.stereoSpread), 0, 1),
    freeze: isJsonBoolean(value.freeze) && value.freeze,
    seed: Math.round(clamp(finite(value.seed, defaults.seed), 1, 0x7fffffff)),
    maxGrains: Math.round(clamp(finite(value.maxGrains, defaults.maxGrains), 1, GRANULAR_MAX_GRAINS)),
    maxDecodedBytes: Math.round(clamp(finite(value.maxDecodedBytes, defaults.maxDecodedBytes), 1024 * 1024, 256 * 1024 * 1024)),
  }
}

export const serializeGranularParams = (params: GranularParams) => JSON.stringify(params)
