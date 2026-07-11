import type { SamplerZone } from './sampler-params'

export const GRANULAR_STATE_VERSION = 1
export const GRANULAR_MAX_GRAINS = 128
export type GranularWindowShape = 'hann' | 'tukey' | 'gaussian'

export type GranularParams = {
  version: typeof GRANULAR_STATE_VERSION
  zone?: SamplerZone
  grainSizeMs: number
  densityHz: number
  position: number
  spray: number
  pitchSemitones: number
  reverseProbability: number
  windowShape: GranularWindowShape
  stereoSpread: number
  freeze: boolean
  seed: number
  maxGrains: number
  maxDecodedBytes: number
}

export type GranularParamsInput = Partial<GranularParams> & { version?: unknown; zone?: unknown }

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
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
    windowShape: 'hann',
    stereoSpread: 0.5,
    freeze: false,
    seed: 1,
    maxGrains: 64,
    maxDecodedBytes: 64 * 1024 * 1024,
  }
}

const isZone = (value: unknown): value is SamplerZone => {
  if (typeof value !== 'object' || value === null || !('sample' in value)) return false
  const sample = value.sample
  return typeof sample === 'object' && sample !== null
    && 'assetKey' in sample && typeof sample.assetKey === 'string'
    && 'url' in sample && typeof sample.url === 'string'
}

export function normalizeGranularParams(input: GranularParamsInput): GranularParams {
  const defaults = createDefaultGranularParams()
  return {
    version: GRANULAR_STATE_VERSION,
    zone: isZone(input.zone) ? input.zone : undefined,
    grainSizeMs: clamp(finite(input.grainSizeMs, defaults.grainSizeMs), 5, 1000),
    densityHz: clamp(finite(input.densityHz, defaults.densityHz), 0.25, 200),
    position: clamp(finite(input.position, defaults.position), 0, 1),
    spray: clamp(finite(input.spray, defaults.spray), 0, 1),
    pitchSemitones: clamp(finite(input.pitchSemitones, defaults.pitchSemitones), -48, 48),
    reverseProbability: clamp(finite(input.reverseProbability, defaults.reverseProbability), 0, 1),
    windowShape: input.windowShape === 'tukey' || input.windowShape === 'gaussian' ? input.windowShape : 'hann',
    stereoSpread: clamp(finite(input.stereoSpread, defaults.stereoSpread), 0, 1),
    freeze: input.freeze === true,
    seed: Math.round(clamp(finite(input.seed, defaults.seed), 1, 0x7fffffff)),
    maxGrains: Math.round(clamp(finite(input.maxGrains, defaults.maxGrains), 1, GRANULAR_MAX_GRAINS)),
    maxDecodedBytes: Math.round(clamp(finite(input.maxDecodedBytes, defaults.maxDecodedBytes), 1024 * 1024, 256 * 1024 * 1024)),
  }
}

export const serializeGranularParams = (params: GranularParams) => JSON.stringify(params)
