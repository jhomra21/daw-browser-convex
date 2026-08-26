import { isJsonBoolean, isJsonNumber, isJsonObject, type JsonObject, type JsonValue } from './json-value'

export const SPECTRAL_FFT_SIZES = [512, 1024, 2048, 4096] as const
export const SPECTRAL_OVERLAPS = [2, 4] as const
export const SPECTRAL_MODES = ['freeze', 'gate', 'morph', 'shift-blur', 'hpss', 'noise-reduce'] as const

export type SpectralFftSize = typeof SPECTRAL_FFT_SIZES[number]
export type SpectralOverlap = typeof SPECTRAL_OVERLAPS[number]
export type SpectralMode = typeof SPECTRAL_MODES[number]

export type SpectralParams = {
  enabled: boolean
  fftSize: SpectralFftSize
  overlap: SpectralOverlap
  mode: SpectralMode
  freeze: number
  gateThresholdDb: number
  gateAttackMs: number
  gateReleaseMs: number
  morph: number
  binShift: number
  blur: number
  harmonicPercussiveBalance: number
  noiseReduction: number
  profileLearn: number
  mix: number
}

export type SpectralParamsEnvelope = { version: 1; state: SpectralParams }

export const SPECTRAL_RESOURCE_BOUNDS = {
  maxFftSize: 4096,
  maxSpectrumBins: 2049,
  maxOverlap: 4,
  maxHpssKernelBins: 31,
  maxHpssHistoryFrames: 31,
} as const

export const createDefaultSpectralParams = (): SpectralParams => ({
  enabled: true,
  fftSize: 2048,
  overlap: 4,
  mode: 'freeze',
  freeze: 0,
  gateThresholdDb: -60,
  gateAttackMs: 10,
  gateReleaseMs: 100,
  morph: 0,
  binShift: 0,
  blur: 0,
  harmonicPercussiveBalance: 0,
  noiseReduction: 0,
  profileLearn: 0,
  mix: 1,
})

const objectValue = (value: JsonValue | undefined): JsonObject =>
  isJsonObject(value) ? value : {}

const numberValue = (value: JsonValue | undefined, fallback: number, min: number, max: number) =>
  isJsonNumber(value) && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

const isSpectralFftSize = (value: JsonValue | undefined): value is SpectralFftSize =>
  value === 512 || value === 1024 || value === 2048 || value === 4096

const isSpectralOverlap = (value: JsonValue | undefined): value is SpectralOverlap => value === 2 || value === 4

const isSpectralMode = (value: JsonValue | undefined): value is SpectralMode =>
  value === 'freeze'
  || value === 'gate'
  || value === 'morph'
  || value === 'shift-blur'
  || value === 'hpss'
  || value === 'noise-reduce'

export const normalizeSpectralParamsEnvelope = (value: JsonValue): SpectralParamsEnvelope => {
  const envelope = objectValue(value)
  const state = objectValue(envelope.version === 1 ? envelope.state : value)
  const defaults = createDefaultSpectralParams()
  return {
    version: 1,
    state: {
      enabled: isJsonBoolean(state.enabled) ? state.enabled : defaults.enabled,
      fftSize: isSpectralFftSize(state.fftSize) ? state.fftSize : defaults.fftSize,
      overlap: isSpectralOverlap(state.overlap) ? state.overlap : defaults.overlap,
      mode: isSpectralMode(state.mode) ? state.mode : defaults.mode,
      freeze: numberValue(state.freeze, defaults.freeze, 0, 1),
      gateThresholdDb: numberValue(state.gateThresholdDb, defaults.gateThresholdDb, -120, 0),
      gateAttackMs: numberValue(state.gateAttackMs, defaults.gateAttackMs, 0.1, 1000),
      gateReleaseMs: numberValue(state.gateReleaseMs, defaults.gateReleaseMs, 1, 5000),
      morph: numberValue(state.morph, defaults.morph, 0, 1),
      binShift: numberValue(state.binShift, defaults.binShift, -2048, 2048),
      blur: numberValue(state.blur, defaults.blur, 0, 1),
      harmonicPercussiveBalance: numberValue(state.harmonicPercussiveBalance, defaults.harmonicPercussiveBalance, -1, 1),
      noiseReduction: numberValue(state.noiseReduction, defaults.noiseReduction, 0, 1),
      profileLearn: numberValue(state.profileLearn, defaults.profileLearn, 0, 1),
      mix: numberValue(state.mix, defaults.mix, 0, 1),
    },
  }
}

export const serializeSpectralParams = (params: SpectralParamsEnvelope) =>
  JSON.stringify(normalizeSpectralParamsEnvelope(params))

export const getSpectralLatencyFrames = (
  fftSize: SpectralFftSize,
  _overlap: SpectralOverlap,
  centered = false,
) => centered ? fftSize / 2 : fftSize
