import {
  createDefaultSpectralParams,
  normalizeSpectralParamsEnvelope,
  serializeSpectralParams,
  type SpectralParamsEnvelope,
} from './spectral-params'

export type EqBandType = 'lowpass' | 'highpass' | 'bandpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'allpass'

export type EqBandParams = {
  id: string
  frequency: number
  gainDb: number
  q: number
  enabled: boolean
  type: EqBandType
}

export type EqChannelMode = 'stereo' | 'mono'

export type EqParams = {
  bands: EqBandParams[]
  enabled: boolean
  channelMode: EqChannelMode
}

export type EqParamsLite = EqParams
export type EqBandParamsInput = Partial<Omit<EqBandParams, 'type'>> & { type?: unknown }
export type EqParamsInput = {
  enabled?: boolean
  bands?: EqBandParamsInput[]
  channelMode?: unknown
}

export const EQ_FREQUENCY_MIN = 20
export const EQ_FREQUENCY_MAX = 20000
export const EQ_GAIN_DB_MIN = -24
export const EQ_GAIN_DB_MAX = 24
export const EQ_Q_MIN = 0.2
export const EQ_Q_MAX = 18
const DEFAULT_EQ_FREQUENCIES = [40, 100, 200, 500, 1000, 2500, 6000, 12000]

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getDefaultEqBandType(index: number): EqBandType {
  if (index === 0) return 'lowshelf'
  if (index === DEFAULT_EQ_FREQUENCIES.length - 1) return 'highshelf'
  return 'peaking'
}

export function createDefaultEqBand(index: number): EqBandParams {
  return {
    id: `b${index + 1}`,
    frequency: DEFAULT_EQ_FREQUENCIES[index] ?? 1000,
    gainDb: 0,
    q: 1,
    enabled: true,
    type: getDefaultEqBandType(index),
  }
}

export function createDefaultEqParams(): EqParams {
  return {
    bands: DEFAULT_EQ_FREQUENCIES.map((_, index) => createDefaultEqBand(index)),
    enabled: true,
    channelMode: 'stereo',
  }
}

export function normalizeEqChannelMode(value: unknown): EqChannelMode {
  return value === 'mono' ? 'mono' : 'stereo'
}

export function isEqBandType(value: unknown): value is EqBandType {
  return (
    value === 'allpass'
    || value === 'bandpass'
    || value === 'highpass'
    || value === 'highshelf'
    || value === 'lowpass'
    || value === 'lowshelf'
    || value === 'notch'
    || value === 'peaking'
  )
}

export function normalizeEqParams(input: EqParamsInput): EqParams {
  const defaults = createDefaultEqParams()
  const bandsInput = Array.isArray(input.bands) && input.bands.length > 0 ? input.bands : defaults.bands
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    channelMode: normalizeEqChannelMode(input.channelMode),
    bands: bandsInput.map((band, index) => {
      const defaultBand = defaults.bands[index] ?? createDefaultEqBand(index)
      const frequency = readFiniteNumber(band.frequency)
      const gainDb = readFiniteNumber(band.gainDb)
      const q = readFiniteNumber(band.q)
      return {
        id: typeof band.id === 'string' && band.id.length > 0 ? band.id : defaultBand.id,
        frequency: frequency === undefined ? defaultBand.frequency : clamp(frequency, EQ_FREQUENCY_MIN, EQ_FREQUENCY_MAX),
        gainDb: gainDb === undefined ? defaultBand.gainDb : clamp(gainDb, EQ_GAIN_DB_MIN, EQ_GAIN_DB_MAX),
        q: q === undefined ? defaultBand.q : clamp(q, EQ_Q_MIN, EQ_Q_MAX),
        enabled: typeof band.enabled === 'boolean' ? band.enabled : defaultBand.enabled,
        type: isEqBandType(band.type) ? band.type : defaultBand.type,
      }
    }),
  }
}

export function normalizeEqParamsForUpdate(input: EqParamsInput, existing?: EqParamsInput): EqParams {
  return normalizeEqParams({ ...(existing === undefined ? {} : normalizeEqParams(existing)), ...input })
}

export function serializeNormalizedEqParams(params: EqParams): string {
  let signature = `${params.enabled ? '1' : '0'}|${params.channelMode}`
  for (const band of params.bands) {
    signature += `|${band.id}:${band.enabled ? 1 : 0}:${band.type}:${band.frequency}:${band.gainDb}:${band.q}`
  }
  return signature
}

export function serializeEqParams(params: EqParams): string {
  return serializeNormalizedEqParams(normalizeEqParams(params))
}

export type ReverbParams = {
  enabled: boolean
  wet: number
  decaySec: number
  preDelayMs: number
  reflections: number
  reflectionSpin: boolean
  reflectionModAmountMs: number
  reflectionModRateHz: number
  reflectionShape: number
  diffuse: number
  size: number
  diffusion: number
  density: number
  lowCutHz: number
  highCutHz: number
  diffusionLowCutHz: number
  diffusionHighCutHz: number
  stereoWidth: number
}

export type ReverbParamsLite = ReverbParams
export type ReverbParamsInput = Partial<ReverbParams>

export const REVERB_WET_MIN = 0
export const REVERB_WET_MAX = 1
export const REVERB_DECAY_SEC_MIN = 0.05
export const REVERB_DECAY_SEC_MAX = 12
export const REVERB_PRE_DELAY_MS_MIN = 0
export const REVERB_PRE_DELAY_MS_MAX = 250
export const REVERB_REFLECTION_MOD_AMOUNT_MS_MIN = 0
export const REVERB_REFLECTION_MOD_AMOUNT_MS_MAX = 25
export const REVERB_REFLECTION_MOD_RATE_HZ_MIN = 0.01
export const REVERB_REFLECTION_MOD_RATE_HZ_MAX = 5
export const REVERB_UNIT_PARAM_MIN = 0
export const REVERB_UNIT_PARAM_MAX = 1
export const REVERB_LOW_CUT_HZ_MIN = 20
export const REVERB_LOW_CUT_HZ_MAX = 1200
export const REVERB_HIGH_CUT_HZ_MIN = 1200
export const REVERB_HIGH_CUT_HZ_MAX = 20000
export const REVERB_DIFFUSION_LOW_CUT_HZ_MIN = 20
export const REVERB_DIFFUSION_LOW_CUT_HZ_MAX = 1200
export const REVERB_DIFFUSION_HIGH_CUT_HZ_MIN = 1200
export const REVERB_DIFFUSION_HIGH_CUT_HZ_MAX = 20000
export const REVERB_STEREO_WIDTH_MIN = 0
export const REVERB_STEREO_WIDTH_MAX = 2

export function createDefaultReverbParams(): ReverbParams {
  return {
    enabled: true,
    wet: 0.25,
    decaySec: 2.2,
    preDelayMs: 20,
    reflections: 0,
    reflectionSpin: true,
    reflectionModAmountMs: 17.5,
    reflectionModRateHz: 0.3,
    reflectionShape: 0.5,
    diffuse: 1,
    size: 0.65,
    diffusion: 0.75,
    density: 0.8,
    lowCutHz: 20,
    highCutHz: 20000,
    diffusionLowCutHz: 20,
    diffusionHighCutHz: 20000,
    stereoWidth: 1,
  }
}

export function normalizeReverbParams(input: ReverbParamsInput): ReverbParams {
  const defaults = createDefaultReverbParams()
  const wet = readFiniteNumber(input.wet)
  const decaySec = readFiniteNumber(input.decaySec)
  const preDelayMs = readFiniteNumber(input.preDelayMs)
  const reflections = readFiniteNumber(input.reflections)
  const reflectionModAmountMs = readFiniteNumber(input.reflectionModAmountMs)
  const reflectionModRateHz = readFiniteNumber(input.reflectionModRateHz)
  const reflectionShape = readFiniteNumber(input.reflectionShape)
  const diffuse = readFiniteNumber(input.diffuse)
  const size = readFiniteNumber(input.size)
  const diffusion = readFiniteNumber(input.diffusion)
  const density = readFiniteNumber(input.density)
  const lowCutInput = readFiniteNumber(input.lowCutHz)
  const highCutInput = readFiniteNumber(input.highCutHz)
  const diffusionLowCutInput = readFiniteNumber(input.diffusionLowCutHz)
  const diffusionHighCutInput = readFiniteNumber(input.diffusionHighCutHz)
  const stereoWidth = readFiniteNumber(input.stereoWidth)
  const lowCutHz = lowCutInput === undefined ? defaults.lowCutHz : clamp(lowCutInput, REVERB_LOW_CUT_HZ_MIN, REVERB_LOW_CUT_HZ_MAX)
  const highCutHz = highCutInput === undefined ? defaults.highCutHz : clamp(highCutInput, REVERB_HIGH_CUT_HZ_MIN, REVERB_HIGH_CUT_HZ_MAX)
  const diffusionLowCutHz = diffusionLowCutInput === undefined ? defaults.diffusionLowCutHz : clamp(diffusionLowCutInput, REVERB_DIFFUSION_LOW_CUT_HZ_MIN, REVERB_DIFFUSION_LOW_CUT_HZ_MAX)
  const diffusionHighCutHz = diffusionHighCutInput === undefined ? defaults.diffusionHighCutHz : clamp(diffusionHighCutInput, REVERB_DIFFUSION_HIGH_CUT_HZ_MIN, REVERB_DIFFUSION_HIGH_CUT_HZ_MAX)
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    wet: wet === undefined ? defaults.wet : clamp(wet, REVERB_WET_MIN, REVERB_WET_MAX),
    decaySec: decaySec === undefined ? defaults.decaySec : clamp(decaySec, REVERB_DECAY_SEC_MIN, REVERB_DECAY_SEC_MAX),
    preDelayMs: preDelayMs === undefined ? defaults.preDelayMs : clamp(preDelayMs, REVERB_PRE_DELAY_MS_MIN, REVERB_PRE_DELAY_MS_MAX),
    reflections: reflections === undefined ? defaults.reflections : clamp(reflections, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    reflectionSpin: typeof input.reflectionSpin === 'boolean' ? input.reflectionSpin : defaults.reflectionSpin,
    reflectionModAmountMs: reflectionModAmountMs === undefined ? defaults.reflectionModAmountMs : clamp(reflectionModAmountMs, REVERB_REFLECTION_MOD_AMOUNT_MS_MIN, REVERB_REFLECTION_MOD_AMOUNT_MS_MAX),
    reflectionModRateHz: reflectionModRateHz === undefined ? defaults.reflectionModRateHz : clamp(reflectionModRateHz, REVERB_REFLECTION_MOD_RATE_HZ_MIN, REVERB_REFLECTION_MOD_RATE_HZ_MAX),
    reflectionShape: reflectionShape === undefined ? defaults.reflectionShape : clamp(reflectionShape, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    diffuse: diffuse === undefined ? defaults.diffuse : clamp(diffuse, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    size: size === undefined ? defaults.size : clamp(size, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    diffusion: diffusion === undefined ? defaults.diffusion : clamp(diffusion, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    density: density === undefined ? defaults.density : clamp(density, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    lowCutHz,
    highCutHz,
    diffusionLowCutHz,
    diffusionHighCutHz,
    stereoWidth: stereoWidth === undefined ? defaults.stereoWidth : clamp(stereoWidth, REVERB_STEREO_WIDTH_MIN, REVERB_STEREO_WIDTH_MAX),
  }
}

export function normalizeReverbParamsForUpdate(input: ReverbParamsInput, existing?: ReverbParamsInput): ReverbParams {
  return normalizeReverbParams({ ...(existing === undefined ? {} : normalizeReverbParams(existing)), ...input })
}

export function serializeReverbParams(params: ReverbParams): string {
  const normalized = normalizeReverbParams(params)
  return `${normalized.enabled ? 1 : 0}|${normalized.wet}|${normalized.decaySec}|${normalized.preDelayMs}|${normalized.reflections}|${normalized.reflectionSpin ? 1 : 0}|${normalized.reflectionModAmountMs}|${normalized.reflectionModRateHz}|${normalized.reflectionShape}|${normalized.diffuse}|${normalized.size}|${normalized.diffusion}|${normalized.density}|${normalized.lowCutHz}|${normalized.highCutHz}|${normalized.diffusionLowCutHz}|${normalized.diffusionHighCutHz}|${normalized.stereoWidth}`
}

export type SaturatorCurve = 'soft' | 'medium' | 'hard' | 'clip'

export type SaturatorParams = {
  enabled: boolean
  driveDb: number
  curve: SaturatorCurve
  color: boolean
  colorFrequencyHz: number
  colorAmount: number
  outputDb: number
  dryWet: number
}

export type SaturatorParamsLite = SaturatorParams
export type SaturatorParamsInput = Partial<Omit<SaturatorParams, 'curve'>> & { curve?: unknown }

export const SATURATOR_DRIVE_DB_MIN = 0
export const SATURATOR_DRIVE_DB_MAX = 36
export const SATURATOR_OUTPUT_DB_MIN = -24
export const SATURATOR_OUTPUT_DB_MAX = 12
export const SATURATOR_DRY_WET_MIN = 0
export const SATURATOR_DRY_WET_MAX = 1
export const SATURATOR_COLOR_FREQUENCY_HZ_MIN = 100
export const SATURATOR_COLOR_FREQUENCY_HZ_MAX = 10000
export const SATURATOR_COLOR_AMOUNT_MIN = 0
export const SATURATOR_COLOR_AMOUNT_MAX = 1

export function createDefaultSaturatorParams(): SaturatorParams {
  return {
    enabled: true,
    driveDb: 6,
    curve: 'soft',
    color: false,
    colorFrequencyHz: 1200,
    colorAmount: 0,
    outputDb: 0,
    dryWet: 1,
  }
}

export function isSaturatorCurve(value: unknown): value is SaturatorCurve {
  return value === 'soft' || value === 'medium' || value === 'hard' || value === 'clip'
}

export function evaluateSaturatorCurvePoint(curve: SaturatorCurve, input: number): number {
  if (curve === 'soft') return Math.tanh(1.8 * input)
  if (curve === 'medium') return input < -0.666 ? -1 : input > 0.666 ? 1 : 1.5 * input - 0.5 * input * input * input
  if (curve === 'hard') return Math.atan(4 * input) / Math.atan(4)
  return clamp(input, -0.82, 0.82) / 0.82
}

export function normalizeSaturatorParams(input: SaturatorParamsInput = {}): SaturatorParams {
  const defaults = createDefaultSaturatorParams()
  const driveDb = readFiniteNumber(input.driveDb)
  const colorFrequencyHz = readFiniteNumber(input.colorFrequencyHz)
  const colorAmount = readFiniteNumber(input.colorAmount)
  const outputDb = readFiniteNumber(input.outputDb)
  const dryWet = readFiniteNumber(input.dryWet)
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    driveDb: driveDb === undefined ? defaults.driveDb : clamp(driveDb, SATURATOR_DRIVE_DB_MIN, SATURATOR_DRIVE_DB_MAX),
    curve: isSaturatorCurve(input.curve) ? input.curve : defaults.curve,
    color: typeof input.color === 'boolean' ? input.color : defaults.color,
    colorFrequencyHz: colorFrequencyHz === undefined ? defaults.colorFrequencyHz : clamp(colorFrequencyHz, SATURATOR_COLOR_FREQUENCY_HZ_MIN, SATURATOR_COLOR_FREQUENCY_HZ_MAX),
    colorAmount: colorAmount === undefined ? defaults.colorAmount : clamp(colorAmount, SATURATOR_COLOR_AMOUNT_MIN, SATURATOR_COLOR_AMOUNT_MAX),
    outputDb: outputDb === undefined ? defaults.outputDb : clamp(outputDb, SATURATOR_OUTPUT_DB_MIN, SATURATOR_OUTPUT_DB_MAX),
    dryWet: dryWet === undefined ? defaults.dryWet : clamp(dryWet, SATURATOR_DRY_WET_MIN, SATURATOR_DRY_WET_MAX),
  }
}

export function normalizeSaturatorParamsForUpdate(input: SaturatorParamsInput, existing?: SaturatorParamsInput): SaturatorParams {
  return normalizeSaturatorParams({ ...(existing === undefined ? {} : normalizeSaturatorParams(existing)), ...input })
}

export function serializeSaturatorParams(params: SaturatorParams): string {
  const normalized = normalizeSaturatorParams(params)
  return `${normalized.enabled ? 1 : 0}|${normalized.driveDb}|${normalized.curve}|${normalized.color ? 1 : 0}|${normalized.colorFrequencyHz}|${normalized.colorAmount}|${normalized.outputDb}|${normalized.dryWet}`
}

export type DelayMode = 'sync' | 'time'
export type DelaySyncDivision = '1/16' | '1/8' | '1/4' | '1/2' | '1/1'

export type DelayParams = {
  enabled: boolean
  mode: DelayMode
  timeMs: number
  syncDivision: DelaySyncDivision
  feedback: number
  dryWet: number
  pingPong: boolean
  filterEnabled: boolean
  lowCutHz: number
  highCutHz: number
}

export type DelayParamsLite = DelayParams
export type DelayParamsInput = Partial<Omit<DelayParams, 'mode' | 'syncDivision'>> & { mode?: unknown; syncDivision?: unknown }

export const DELAY_TIME_MS_MIN = 1
export const DELAY_TIME_MS_MAX = 2000
export const DELAY_MAX_DELAY_TIME_SEC = 3
export const DELAY_FEEDBACK_MIN = 0
export const DELAY_FEEDBACK_MAX = 0.95
export const DELAY_DRY_WET_MIN = 0
export const DELAY_DRY_WET_MAX = 1
export const DELAY_LOW_CUT_HZ_MIN = 20
export const DELAY_LOW_CUT_HZ_MAX = 2000
export const DELAY_HIGH_CUT_HZ_MIN = 1000
export const DELAY_HIGH_CUT_HZ_MAX = 20000

export function createDefaultDelayParams(): DelayParams {
  return {
    enabled: true,
    mode: 'sync',
    timeMs: 250,
    syncDivision: '1/8',
    feedback: 0.25,
    dryWet: 0.2,
    pingPong: false,
    filterEnabled: false,
    lowCutHz: 120,
    highCutHz: 8000,
  }
}

export function isDelayMode(value: unknown): value is DelayMode {
  return value === 'sync' || value === 'time'
}

export function isDelaySyncDivision(value: unknown): value is DelaySyncDivision {
  return value === '1/16' || value === '1/8' || value === '1/4' || value === '1/2' || value === '1/1'
}

export function normalizeDelayParams(input: DelayParamsInput = {}): DelayParams {
  const defaults = createDefaultDelayParams()
  const timeMs = readFiniteNumber(input.timeMs)
  const feedback = readFiniteNumber(input.feedback)
  const dryWet = readFiniteNumber(input.dryWet)
  const lowCutInput = readFiniteNumber(input.lowCutHz)
  const highCutInput = readFiniteNumber(input.highCutHz)
  const lowCutHz = lowCutInput === undefined ? defaults.lowCutHz : clamp(lowCutInput, DELAY_LOW_CUT_HZ_MIN, DELAY_LOW_CUT_HZ_MAX)
  const highCutHz = highCutInput === undefined ? defaults.highCutHz : clamp(highCutInput, Math.max(DELAY_HIGH_CUT_HZ_MIN, lowCutHz + 1), DELAY_HIGH_CUT_HZ_MAX)
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    mode: isDelayMode(input.mode) ? input.mode : defaults.mode,
    timeMs: timeMs === undefined ? defaults.timeMs : clamp(timeMs, DELAY_TIME_MS_MIN, DELAY_TIME_MS_MAX),
    syncDivision: isDelaySyncDivision(input.syncDivision) ? input.syncDivision : defaults.syncDivision,
    feedback: feedback === undefined ? defaults.feedback : clamp(feedback, DELAY_FEEDBACK_MIN, DELAY_FEEDBACK_MAX),
    dryWet: dryWet === undefined ? defaults.dryWet : clamp(dryWet, DELAY_DRY_WET_MIN, DELAY_DRY_WET_MAX),
    pingPong: typeof input.pingPong === 'boolean' ? input.pingPong : defaults.pingPong,
    filterEnabled: typeof input.filterEnabled === 'boolean' ? input.filterEnabled : defaults.filterEnabled,
    lowCutHz,
    highCutHz,
  }
}

export function normalizeDelayParamsForUpdate(input: DelayParamsInput, existing?: DelayParamsInput): DelayParams {
  return normalizeDelayParams({ ...(existing === undefined ? {} : normalizeDelayParams(existing)), ...input })
}

export function serializeDelayParams(params: DelayParams): string {
  const normalized = normalizeDelayParams(params)
  return `${normalized.enabled ? 1 : 0}|${normalized.mode}|${normalized.timeMs}|${normalized.syncDivision}|${normalized.feedback}|${normalized.dryWet}|${normalized.pingPong ? 1 : 0}|${normalized.filterEnabled ? 1 : 0}|${normalized.lowCutHz}|${normalized.highCutHz}`
}


export type CompressorDetectorMode = 'peak' | 'rms'
export type CompressorDynamicsMode = 'compress' | 'expand'
export type CompressorEnvelopeCurve = 'log' | 'linear'
export type CompressorSidechainFilterType = 'lowpass' | 'highpass' | 'bandpass'

export type CompressorSidechainParams = {
  enabled: boolean
  filterType: CompressorSidechainFilterType
  frequencyHz: number
  q: number
}

export type CompressorParams = {
  enabled: boolean
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  autoRelease: boolean
  makeupDb: number
  outputDb: number
  dryWet: number
  kneeDb: number
  lookaheadMs: number
  detectorMode: CompressorDetectorMode
  dynamicsMode: CompressorDynamicsMode
  envelopeCurve: CompressorEnvelopeCurve
  sidechain: CompressorSidechainParams
}

export type CompressorParamsLite = CompressorParams
export type CompressorSidechainParamsInput = Partial<Omit<CompressorSidechainParams, 'filterType'>> & { filterType?: unknown }
export type CompressorParamsInput = Partial<Omit<CompressorParams, 'detectorMode' | 'dynamicsMode' | 'envelopeCurve' | 'sidechain'>> & {
  detectorMode?: unknown
  dynamicsMode?: unknown
  envelopeCurve?: unknown
  sidechain?: CompressorSidechainParamsInput
}

export const COMPRESSOR_THRESHOLD_DB_MIN = -60
export const COMPRESSOR_THRESHOLD_DB_MAX = 0
export const COMPRESSOR_RATIO_MIN = 1
export const COMPRESSOR_RATIO_MAX = 100
export const COMPRESSOR_ATTACK_MS_MIN = 0.1
export const COMPRESSOR_ATTACK_MS_MAX = 100
export const COMPRESSOR_RELEASE_MS_MIN = 5
export const COMPRESSOR_RELEASE_MS_MAX = 1000
export const COMPRESSOR_GAIN_DB_MIN = -36
export const COMPRESSOR_GAIN_DB_MAX = 36
export const COMPRESSOR_DRY_WET_MIN = 0
export const COMPRESSOR_DRY_WET_MAX = 1
export const COMPRESSOR_KNEE_DB_MIN = 0
export const COMPRESSOR_KNEE_DB_MAX = 24
export const COMPRESSOR_LOOKAHEAD_MS_MIN = 0
export const COMPRESSOR_LOOKAHEAD_MS_MAX = 10
export const COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MIN = 20
export const COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MAX = 20000
export const COMPRESSOR_SIDECHAIN_Q_MIN = 0.1
export const COMPRESSOR_SIDECHAIN_Q_MAX = 18

const DEFAULT_COMPRESSOR_SIDECHAIN_PARAMS: CompressorSidechainParams = {
  enabled: false,
  filterType: 'highpass',
  frequencyHz: 120,
  q: 0.707,
}

const DEFAULT_COMPRESSOR_PARAMS: CompressorParams = {
  enabled: true,
  thresholdDb: -24,
  ratio: 4,
  attackMs: 10,
  releaseMs: 120,
  autoRelease: true,
  makeupDb: 0,
  outputDb: 0,
  dryWet: 1,
  kneeDb: 6,
  lookaheadMs: 0,
  detectorMode: 'rms',
  dynamicsMode: 'compress',
  envelopeCurve: 'log',
  sidechain: DEFAULT_COMPRESSOR_SIDECHAIN_PARAMS,
}

export function createDefaultCompressorParams(): CompressorParams {
  return {
    ...DEFAULT_COMPRESSOR_PARAMS,
    sidechain: { ...DEFAULT_COMPRESSOR_SIDECHAIN_PARAMS },
  }
}

export function isCompressorDetectorMode(value: unknown): value is CompressorDetectorMode {
  return value === 'peak' || value === 'rms'
}

export function isCompressorDynamicsMode(value: unknown): value is CompressorDynamicsMode {
  return value === 'compress' || value === 'expand'
}

export function isCompressorEnvelopeCurve(value: unknown): value is CompressorEnvelopeCurve {
  return value === 'log' || value === 'linear'
}

export function isCompressorSidechainFilterType(value: unknown): value is CompressorSidechainFilterType {
  return value === 'lowpass' || value === 'highpass' || value === 'bandpass'
}

function normalizeCompressorSidechainParams(input: CompressorSidechainParamsInput | undefined): CompressorSidechainParams {
  const defaults = DEFAULT_COMPRESSOR_SIDECHAIN_PARAMS
  const frequencyHz = readFiniteNumber(input?.frequencyHz)
  const q = readFiniteNumber(input?.q)
  return {
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : defaults.enabled,
    filterType: isCompressorSidechainFilterType(input?.filterType) ? input.filterType : defaults.filterType,
    frequencyHz: frequencyHz === undefined ? defaults.frequencyHz : clamp(frequencyHz, COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MIN, COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MAX),
    q: q === undefined ? defaults.q : clamp(q, COMPRESSOR_SIDECHAIN_Q_MIN, COMPRESSOR_SIDECHAIN_Q_MAX),
  }
}

export function normalizeCompressorParams(input: CompressorParamsInput = {}): CompressorParams {
  const defaults = DEFAULT_COMPRESSOR_PARAMS
  const thresholdDb = readFiniteNumber(input.thresholdDb)
  const ratio = readFiniteNumber(input.ratio)
  const attackMs = readFiniteNumber(input.attackMs)
  const releaseMs = readFiniteNumber(input.releaseMs)
  const makeupDb = readFiniteNumber(input.makeupDb)
  const outputDb = readFiniteNumber(input.outputDb)
  const dryWet = readFiniteNumber(input.dryWet)
  const kneeDb = readFiniteNumber(input.kneeDb)
  const lookaheadMs = readFiniteNumber(input.lookaheadMs)
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    thresholdDb: thresholdDb === undefined ? defaults.thresholdDb : clamp(thresholdDb, COMPRESSOR_THRESHOLD_DB_MIN, COMPRESSOR_THRESHOLD_DB_MAX),
    ratio: ratio === undefined ? defaults.ratio : clamp(ratio, COMPRESSOR_RATIO_MIN, COMPRESSOR_RATIO_MAX),
    attackMs: attackMs === undefined ? defaults.attackMs : clamp(attackMs, COMPRESSOR_ATTACK_MS_MIN, COMPRESSOR_ATTACK_MS_MAX),
    releaseMs: releaseMs === undefined ? defaults.releaseMs : clamp(releaseMs, COMPRESSOR_RELEASE_MS_MIN, COMPRESSOR_RELEASE_MS_MAX),
    autoRelease: typeof input.autoRelease === 'boolean' ? input.autoRelease : defaults.autoRelease,
    makeupDb: makeupDb === undefined ? defaults.makeupDb : clamp(makeupDb, COMPRESSOR_GAIN_DB_MIN, COMPRESSOR_GAIN_DB_MAX),
    outputDb: outputDb === undefined ? defaults.outputDb : clamp(outputDb, COMPRESSOR_GAIN_DB_MIN, COMPRESSOR_GAIN_DB_MAX),
    dryWet: dryWet === undefined ? defaults.dryWet : clamp(dryWet, COMPRESSOR_DRY_WET_MIN, COMPRESSOR_DRY_WET_MAX),
    kneeDb: kneeDb === undefined ? defaults.kneeDb : clamp(kneeDb, COMPRESSOR_KNEE_DB_MIN, COMPRESSOR_KNEE_DB_MAX),
    lookaheadMs: lookaheadMs === undefined ? defaults.lookaheadMs : clamp(lookaheadMs, COMPRESSOR_LOOKAHEAD_MS_MIN, COMPRESSOR_LOOKAHEAD_MS_MAX),
    detectorMode: isCompressorDetectorMode(input.detectorMode) ? input.detectorMode : defaults.detectorMode,
    dynamicsMode: isCompressorDynamicsMode(input.dynamicsMode) ? input.dynamicsMode : defaults.dynamicsMode,
    envelopeCurve: isCompressorEnvelopeCurve(input.envelopeCurve) ? input.envelopeCurve : defaults.envelopeCurve,
    sidechain: normalizeCompressorSidechainParams(input.sidechain),
  }
}

export function normalizeCompressorParamsForUpdate(input: CompressorParamsInput, existing?: CompressorParamsInput): CompressorParams {
  return normalizeCompressorParams({ ...(existing === undefined ? {} : normalizeCompressorParams(existing)), ...input, sidechain: { ...(existing?.sidechain ?? {}), ...(input.sidechain ?? {}) } })
}

export function serializeCompressorParams(params: CompressorParams): string {
  const normalized = normalizeCompressorParams(params)
  const sidechain = normalized.sidechain
  return `${normalized.enabled ? 1 : 0}|${normalized.thresholdDb}|${normalized.ratio}|${normalized.attackMs}|${normalized.releaseMs}|${normalized.autoRelease ? 1 : 0}|${normalized.makeupDb}|${normalized.outputDb}|${normalized.dryWet}|${normalized.kneeDb}|${normalized.lookaheadMs}|${normalized.detectorMode}|${normalized.dynamicsMode}|${normalized.envelopeCurve}|${sidechain.enabled ? 1 : 0}|${sidechain.filterType}|${sidechain.frequencyHz}|${sidechain.q}`
}

export function computeCompressorStaticCurveDb(inputDb: number, params: CompressorParamsInput = {}): number {
  const normalized = normalizeCompressorParams(params)
  const threshold = normalized.thresholdDb
  const ratio = normalized.ratio
  const knee = normalized.kneeDb
  if (normalized.dynamicsMode === 'expand') {
    if (inputDb >= threshold) return inputDb
    const expanded = threshold + (inputDb - threshold) * ratio
    if (knee <= 0 || inputDb <= threshold - knee / 2) return expanded
    const distance = threshold - inputDb
    return inputDb - (2 * (ratio - 1) * distance * distance) / knee
  }
  const compressed = threshold + (inputDb - threshold) / ratio
  if (knee <= 0) return inputDb <= threshold ? inputDb : compressed
  const lower = threshold - knee / 2
  const upper = threshold + knee / 2
  if (inputDb <= lower) return inputDb
  if (inputDb >= upper) return compressed
  const x = inputDb - lower
  return inputDb + ((1 / ratio - 1) * x * x) / (2 * knee)
}

export type ProcessorStateEnvelope<TState> = { version: 1; state: TState }
export type UtilityPolarity = 'normal' | 'invert'
export type UtilityInputMode = 'stereo' | 'mono-sum'
export type UtilityMatrix = 'stereo' | 'mid-side-encode' | 'mid-side-decode'
export type UtilityParams = {
  enabled: boolean
  gainDb: number
  polarity: UtilityPolarity
  inputMode: UtilityInputMode
  pan: number
  balance: number
  width: number
  matrix: UtilityMatrix
  swap: boolean
  dcBlock: boolean
}
export type UtilityParamsInput = Partial<Omit<UtilityParams, 'polarity' | 'inputMode' | 'matrix'>> & {
  polarity?: unknown
  inputMode?: unknown
  matrix?: unknown
}
export type UtilityParamsEnvelope = ProcessorStateEnvelope<UtilityParams>

const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const readObject = (value: unknown): Record<string, unknown> => isObjectRecord(value) ? value : {}

export function createDefaultUtilityParams(): UtilityParams {
  return { enabled: true, gainDb: 0, polarity: 'normal', inputMode: 'stereo', pan: 0, balance: 0, width: 1, matrix: 'stereo', swap: false, dcBlock: true }
}

export function normalizeUtilityParams(input: UtilityParamsInput = {}): UtilityParams {
  const defaults = createDefaultUtilityParams()
  const gainDb = readFiniteNumber(input.gainDb)
  const pan = readFiniteNumber(input.pan)
  const balance = readFiniteNumber(input.balance)
  const width = readFiniteNumber(input.width)
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    gainDb: gainDb === undefined ? defaults.gainDb : clamp(gainDb, -60, 24),
    polarity: input.polarity === 'invert' ? 'invert' : 'normal',
    inputMode: input.inputMode === 'mono-sum' ? 'mono-sum' : 'stereo',
    pan: pan === undefined ? defaults.pan : clamp(pan, -1, 1),
    balance: balance === undefined ? defaults.balance : clamp(balance, -1, 1),
    width: width === undefined ? defaults.width : clamp(width, 0, 2),
    matrix: input.matrix === 'mid-side-encode' || input.matrix === 'mid-side-decode' ? input.matrix : 'stereo',
    swap: typeof input.swap === 'boolean' ? input.swap : defaults.swap,
    dcBlock: typeof input.dcBlock === 'boolean' ? input.dcBlock : defaults.dcBlock,
  }
}

export const normalizeUtilityParamsForUpdate = (input: UtilityParamsInput, existing?: UtilityParamsInput) => normalizeUtilityParams({ ...(existing ? normalizeUtilityParams(existing) : {}), ...input })
export const serializeUtilityParams = (params: UtilityParams) => JSON.stringify({ version: 1, state: normalizeUtilityParams(params) })
export const normalizeUtilityParamsEnvelope = (value: unknown): UtilityParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)
  return {
    version: 1,
    state: normalizeUtilityParams({
      enabled: state.enabled === true || state.enabled === false ? state.enabled : undefined,
      gainDb: typeof state.gainDb === 'number' ? state.gainDb : undefined,
      polarity: state.polarity,
      inputMode: state.inputMode,
      pan: typeof state.pan === 'number' ? state.pan : undefined,
      balance: typeof state.balance === 'number' ? state.balance : undefined,
      width: typeof state.width === 'number' ? state.width : undefined,
      matrix: state.matrix,
      swap: state.swap === true || state.swap === false ? state.swap : undefined,
      dcBlock: state.dcBlock === true || state.dcBlock === false ? state.dcBlock : undefined,
    }),
  }
}

export type GateMode = 'gate' | 'expander'
export type GateDetector = 'peak' | 'rms'
export type GateParams = {
  enabled: boolean
  mode: GateMode
  thresholdDb: number
  ratio: number
  attackMs: number
  holdMs: number
  releaseMs: number
  hysteresisDb: number
  rangeDb: number
  lookaheadMs: number
  detector: GateDetector
  link: number
  sidechain: { enabled: boolean; filterType: 'highpass'; frequencyHz: number; q: number }
}
export type GateParamsInput = Partial<Omit<GateParams, 'mode' | 'detector' | 'sidechain'>> & {
  mode?: unknown
  detector?: unknown
  sidechain?: Partial<GateParams['sidechain']>
}
export type GateParamsEnvelope = ProcessorStateEnvelope<GateParams>

export function createDefaultGateParams(): GateParams {
  return { enabled: true, mode: 'gate', thresholdDb: -40, ratio: 4, attackMs: 1, holdMs: 20, releaseMs: 120, hysteresisDb: 6, rangeDb: -80, lookaheadMs: 0, detector: 'peak', link: 1, sidechain: { enabled: false, filterType: 'highpass', frequencyHz: 80, q: 0.707 } }
}

export function normalizeGateParams(input: GateParamsInput = {}): GateParams {
  const defaults = createDefaultGateParams()
  const number = (value: unknown, fallback: number, min: number, max: number) => {
    const finite = readFiniteNumber(value)
    return finite === undefined ? fallback : clamp(finite, min, max)
  }
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    mode: input.mode === 'expander' ? 'expander' : 'gate',
    thresholdDb: number(input.thresholdDb, defaults.thresholdDb, -80, 0),
    ratio: number(input.ratio, defaults.ratio, 1, 20),
    attackMs: number(input.attackMs, defaults.attackMs, 0.1, 100),
    holdMs: number(input.holdMs, defaults.holdMs, 0, 500),
    releaseMs: number(input.releaseMs, defaults.releaseMs, 5, 2000),
    hysteresisDb: number(input.hysteresisDb, defaults.hysteresisDb, 0, 24),
    rangeDb: number(input.rangeDb, defaults.rangeDb, -80, 0),
    lookaheadMs: number(input.lookaheadMs, defaults.lookaheadMs, 0, 2),
    detector: input.detector === 'rms' ? 'rms' : 'peak',
    link: number(input.link, defaults.link, 0, 1),
    sidechain: {
      enabled: typeof input.sidechain?.enabled === 'boolean' ? input.sidechain.enabled : defaults.sidechain.enabled,
      filterType: 'highpass',
      frequencyHz: number(input.sidechain?.frequencyHz, defaults.sidechain.frequencyHz, 20, 20000),
      q: number(input.sidechain?.q, defaults.sidechain.q, 0.1, 18),
    },
  }
}

export const normalizeGateParamsForUpdate = (input: GateParamsInput, existing?: GateParamsInput) => normalizeGateParams({ ...(existing ? normalizeGateParams(existing) : {}), ...input, sidechain: { ...(existing?.sidechain ?? {}), ...(input.sidechain ?? {}) } })
export const serializeGateParams = (params: GateParams) => JSON.stringify({ version: 1, state: normalizeGateParams(params) })
export const normalizeGateParamsEnvelope = (value: unknown): GateParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)
  const sidechain = readObject(state.sidechain)
  return {
    version: 1,
    state: normalizeGateParams({
      enabled: state.enabled === true || state.enabled === false ? state.enabled : undefined,
      mode: state.mode,
      thresholdDb: typeof state.thresholdDb === 'number' ? state.thresholdDb : undefined,
      ratio: typeof state.ratio === 'number' ? state.ratio : undefined,
      attackMs: typeof state.attackMs === 'number' ? state.attackMs : undefined,
      holdMs: typeof state.holdMs === 'number' ? state.holdMs : undefined,
      releaseMs: typeof state.releaseMs === 'number' ? state.releaseMs : undefined,
      hysteresisDb: typeof state.hysteresisDb === 'number' ? state.hysteresisDb : undefined,
      rangeDb: typeof state.rangeDb === 'number' ? state.rangeDb : undefined,
      lookaheadMs: typeof state.lookaheadMs === 'number' ? state.lookaheadMs : undefined,
      detector: state.detector,
      link: typeof state.link === 'number' ? state.link : undefined,
      sidechain: {
        enabled: sidechain.enabled === true || sidechain.enabled === false ? sidechain.enabled : undefined,
        frequencyHz: typeof sidechain.frequencyHz === 'number' ? sidechain.frequencyHz : undefined,
        q: typeof sidechain.q === 'number' ? sidechain.q : undefined,
      },
    }),
  }
}

export type LimiterParams = {
  enabled: boolean
  ceilingDbtp: number
  releaseMs: number
  lookaheadMs: number
  link: number
  detectorOversampling: 4
}
export type LimiterParamsInput = Partial<Omit<LimiterParams, 'detectorOversampling'>> & {
  detectorOversampling?: unknown
}
export type LimiterParamsEnvelope = ProcessorStateEnvelope<LimiterParams>

export function createDefaultLimiterParams(): LimiterParams {
  return { enabled: true, ceilingDbtp: -1, releaseMs: 100, lookaheadMs: 5, link: 1, detectorOversampling: 4 }
}

export function normalizeLimiterParams(input: LimiterParamsInput = {}): LimiterParams {
  const defaults = createDefaultLimiterParams()
  const ceilingDbtp = readFiniteNumber(input.ceilingDbtp)
  const releaseMs = readFiniteNumber(input.releaseMs)
  const lookaheadMs = readFiniteNumber(input.lookaheadMs)
  const link = readFiniteNumber(input.link)
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    ceilingDbtp: ceilingDbtp === undefined ? defaults.ceilingDbtp : clamp(ceilingDbtp, -12, 0),
    releaseMs: releaseMs === undefined ? defaults.releaseMs : clamp(releaseMs, 20, 1000),
    lookaheadMs: lookaheadMs === undefined ? defaults.lookaheadMs : clamp(lookaheadMs, 1, 5),
    link: link === undefined ? defaults.link : clamp(link, 0, 1),
    detectorOversampling: 4,
  }
}

export const serializeLimiterParams = (params: LimiterParams) => JSON.stringify({ version: 1, state: normalizeLimiterParams(params) })
export const normalizeLimiterParamsEnvelope = (value: unknown): LimiterParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)
  return {
    version: 1,
    state: normalizeLimiterParams({
      enabled: state.enabled === true || state.enabled === false ? state.enabled : undefined,
      ceilingDbtp: typeof state.ceilingDbtp === 'number' ? state.ceilingDbtp : undefined,
      releaseMs: typeof state.releaseMs === 'number' ? state.releaseMs : undefined,
      lookaheadMs: typeof state.lookaheadMs === 'number' ? state.lookaheadMs : undefined,
      link: typeof state.link === 'number' ? state.link : undefined,
      detectorOversampling: state.detectorOversampling,
    }),
  }
}

export type AutoFilterMode = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peak'
export type AutoFilterWaveform = 'sine' | 'triangle'
export type AutoFilterParams = {
  enabled: boolean
  mode: AutoFilterMode
  frequencyHz: number
  resonance: number
  driveDb: number
  mix: number
  envelope: { amountOctaves: number; attackMs: number; releaseMs: number }
  lfo: { waveform: AutoFilterWaveform; rateHz: number; depthOctaves: number; phaseOffset: number; stereoPhase: number }
  quality: '2x'
}
export type AutoFilterParamsInput = Partial<Omit<AutoFilterParams, 'mode' | 'envelope' | 'lfo' | 'quality'>> & {
  mode?: unknown
  envelope?: Partial<AutoFilterParams['envelope']>
  lfo?: Partial<Omit<AutoFilterParams['lfo'], 'waveform'>> & { waveform?: unknown }
  quality?: unknown
}
export type AutoFilterParamsEnvelope = ProcessorStateEnvelope<AutoFilterParams>

export function createDefaultAutoFilterParams(): AutoFilterParams {
  return {
    enabled: true,
    mode: 'lowpass',
    frequencyHz: 1000,
    resonance: 0.25,
    driveDb: 0,
    mix: 1,
    envelope: { amountOctaves: 0, attackMs: 10, releaseMs: 100 },
    lfo: { waveform: 'sine', rateHz: 1, depthOctaves: 0, phaseOffset: 0, stereoPhase: 0 },
    quality: '2x',
  }
}

export function normalizeAutoFilterParams(input: AutoFilterParamsInput = {}): AutoFilterParams {
  const defaults = createDefaultAutoFilterParams()
  const number = (value: unknown, fallback: number, min: number, max: number) => {
    const finite = readFiniteNumber(value)
    return finite === undefined ? fallback : clamp(finite, min, max)
  }
  const mode = input.mode
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    mode: mode === 'highpass' || mode === 'bandpass' || mode === 'notch' || mode === 'peak' ? mode : 'lowpass',
    frequencyHz: number(input.frequencyHz, defaults.frequencyHz, 20, 20000),
    resonance: number(input.resonance, defaults.resonance, 0, 1),
    driveDb: number(input.driveDb, defaults.driveDb, 0, 24),
    mix: number(input.mix, defaults.mix, 0, 1),
    envelope: {
      amountOctaves: number(input.envelope?.amountOctaves, defaults.envelope.amountOctaves, -6, 6),
      attackMs: number(input.envelope?.attackMs, defaults.envelope.attackMs, 0.5, 500),
      releaseMs: number(input.envelope?.releaseMs, defaults.envelope.releaseMs, 5, 2000),
    },
    lfo: {
      waveform: input.lfo?.waveform === 'triangle' ? 'triangle' : 'sine',
      rateHz: number(input.lfo?.rateHz, defaults.lfo.rateHz, 0.01, 20),
      depthOctaves: number(input.lfo?.depthOctaves, defaults.lfo.depthOctaves, 0, 6),
      phaseOffset: number(input.lfo?.phaseOffset, defaults.lfo.phaseOffset, 0, 1),
      stereoPhase: number(input.lfo?.stereoPhase, defaults.lfo.stereoPhase, -0.5, 0.5),
    },
    quality: '2x',
  }
}

export const serializeAutoFilterParams = (params: AutoFilterParams) => JSON.stringify({ version: 1, state: normalizeAutoFilterParams(params) })
export const normalizeAutoFilterParamsEnvelope = (value: unknown): AutoFilterParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)
  const env = readObject(state.envelope)
  const lfo = readObject(state.lfo)
  return {
    version: 1,
    state: normalizeAutoFilterParams({
      enabled: state.enabled === true || state.enabled === false ? state.enabled : undefined,
      mode: state.mode,
      frequencyHz: typeof state.frequencyHz === 'number' ? state.frequencyHz : undefined,
      resonance: typeof state.resonance === 'number' ? state.resonance : undefined,
      driveDb: typeof state.driveDb === 'number' ? state.driveDb : undefined,
      mix: typeof state.mix === 'number' ? state.mix : undefined,
      envelope: {
        amountOctaves: typeof env.amountOctaves === 'number' ? env.amountOctaves : undefined,
        attackMs: typeof env.attackMs === 'number' ? env.attackMs : undefined,
        releaseMs: typeof env.releaseMs === 'number' ? env.releaseMs : undefined,
      },
      lfo: {
        waveform: lfo.waveform,
        rateHz: typeof lfo.rateHz === 'number' ? lfo.rateHz : undefined,
        depthOctaves: typeof lfo.depthOctaves === 'number' ? lfo.depthOctaves : undefined,
        phaseOffset: typeof lfo.phaseOffset === 'number' ? lfo.phaseOffset : undefined,
        stereoPhase: typeof lfo.stereoPhase === 'number' ? lfo.stereoPhase : undefined,
      },
      quality: state.quality,
    }),
  }
}

export type ModulationWaveform = 'sine' | 'triangle'
export type PhaserStages = 4 | 6 | 8 | 12
export type ChorusParams = { enabled: boolean; delayMs: number; depthMs: number; rateHz: number; feedback: number; stereoPhase: number; mix: number }
export type FlangerParams = ChorusParams
export type PhaserParams = { enabled: boolean; stages: PhaserStages; centerHz: number; depthOctaves: number; rateHz: number; feedback: number; stereoPhase: number; mix: number }
export type TremoloParams = { enabled: boolean; waveform: ModulationWaveform; rateHz: number; depth: number; shape: number; phase: number }
export type AutoPanParams = TremoloParams
export type EnsembleParams = { enabled: boolean; voices: 3; delayMs: number; depthMs: number; rateHz: number; spread: number; mix: number }
export type ChorusParamsEnvelope = ProcessorStateEnvelope<ChorusParams>
export type FlangerParamsEnvelope = ProcessorStateEnvelope<FlangerParams>
export type PhaserParamsEnvelope = ProcessorStateEnvelope<PhaserParams>
export type TremoloParamsEnvelope = ProcessorStateEnvelope<TremoloParams>
export type AutoPanParamsEnvelope = ProcessorStateEnvelope<AutoPanParams>
export type EnsembleParamsEnvelope = ProcessorStateEnvelope<EnsembleParams>

const normalizeNumber = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
const normalizeModulationEnvelope = <T>(value: unknown, normalize: (state: Record<string, unknown>) => T): ProcessorStateEnvelope<T> => {
  const envelope = readObject(value)
  return { version: 1, state: normalize(readObject(envelope.version === 1 ? envelope.state : value)) }
}
export const createDefaultChorusParams = (): ChorusParams => ({ enabled: true, delayMs: 12, depthMs: 4, rateHz: 0.8, feedback: 0, stereoPhase: 0.25, mix: 0.35 })
export const createDefaultFlangerParams = (): FlangerParams => ({ enabled: true, delayMs: 1.5, depthMs: 1, rateHz: 0.2, feedback: 0.35, stereoPhase: 0.5, mix: 0.5 })
export const createDefaultPhaserParams = (): PhaserParams => ({ enabled: true, stages: 6, centerHz: 1000, depthOctaves: 3, rateHz: 0.3, feedback: 0.3, stereoPhase: 0.5, mix: 0.5 })
export const createDefaultTremoloParams = (): TremoloParams => ({ enabled: true, waveform: 'sine', rateHz: 4, depth: 0.5, shape: 0.5, phase: 0 })
export const createDefaultAutoPanParams = (): AutoPanParams => ({ enabled: true, waveform: 'sine', rateHz: 1, depth: 1, shape: 0.5, phase: 0 })
export const createDefaultEnsembleParams = (): EnsembleParams => ({ enabled: true, voices: 3, delayMs: 18, depthMs: 6, rateHz: 0.6, spread: 1, mix: 0.5 })
export const normalizeChorusParamsEnvelope = (value: unknown): ChorusParamsEnvelope => normalizeModulationEnvelope(value, (state) => {
  const defaults = createDefaultChorusParams()
  return { enabled: typeof state.enabled === 'boolean' ? state.enabled : true, delayMs: normalizeNumber(state.delayMs, defaults.delayMs, 5, 30), depthMs: normalizeNumber(state.depthMs, defaults.depthMs, 0, 10), rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.01, 20), feedback: normalizeNumber(state.feedback, defaults.feedback, 0, 0.5), stereoPhase: normalizeNumber(state.stereoPhase, defaults.stereoPhase, -0.5, 0.5), mix: normalizeNumber(state.mix, defaults.mix, 0, 1) }
})
export const normalizeFlangerParamsEnvelope = (value: unknown): FlangerParamsEnvelope => normalizeModulationEnvelope(value, (state) => {
  const defaults = createDefaultFlangerParams()
  return { enabled: typeof state.enabled === 'boolean' ? state.enabled : true, delayMs: normalizeNumber(state.delayMs, defaults.delayMs, 0.1, 10), depthMs: normalizeNumber(state.depthMs, defaults.depthMs, 0, 5), rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.01, 20), feedback: normalizeNumber(state.feedback, defaults.feedback, -0.95, 0.95), stereoPhase: normalizeNumber(state.stereoPhase, defaults.stereoPhase, -0.5, 0.5), mix: normalizeNumber(state.mix, defaults.mix, 0, 1) }
})
export const normalizePhaserParamsEnvelope = (value: unknown): PhaserParamsEnvelope => normalizeModulationEnvelope(value, (state) => {
  const defaults = createDefaultPhaserParams()
  return { enabled: typeof state.enabled === 'boolean' ? state.enabled : true, stages: state.stages === 4 || state.stages === 6 || state.stages === 8 || state.stages === 12 ? state.stages : defaults.stages, centerHz: normalizeNumber(state.centerHz, defaults.centerHz, 100, 8000), depthOctaves: normalizeNumber(state.depthOctaves, defaults.depthOctaves, 0, 5), rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.01, 20), feedback: normalizeNumber(state.feedback, defaults.feedback, -0.95, 0.95), stereoPhase: normalizeNumber(state.stereoPhase, defaults.stereoPhase, -0.5, 0.5), mix: normalizeNumber(state.mix, defaults.mix, 0, 1) }
})
const normalizeAmplitudeModulation = (value: unknown, defaults: TremoloParams): TremoloParamsEnvelope => normalizeModulationEnvelope(value, (state) => ({ enabled: typeof state.enabled === 'boolean' ? state.enabled : true, waveform: state.waveform === 'triangle' ? 'triangle' : 'sine', rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.01, 20), depth: normalizeNumber(state.depth, defaults.depth, 0, 1), shape: normalizeNumber(state.shape, defaults.shape, 0, 1), phase: normalizeNumber(state.phase, defaults.phase, 0, 1) }))
export const normalizeTremoloParamsEnvelope = (value: unknown): TremoloParamsEnvelope => normalizeAmplitudeModulation(value, createDefaultTremoloParams())
export const normalizeAutoPanParamsEnvelope = (value: unknown): AutoPanParamsEnvelope => normalizeAmplitudeModulation(value, createDefaultAutoPanParams())
export const normalizeEnsembleParamsEnvelope = (value: unknown): EnsembleParamsEnvelope => normalizeModulationEnvelope(value, (state) => {
  const defaults = createDefaultEnsembleParams()
  return { enabled: typeof state.enabled === 'boolean' ? state.enabled : true, voices: 3, delayMs: normalizeNumber(state.delayMs, defaults.delayMs, 10, 30), depthMs: normalizeNumber(state.depthMs, defaults.depthMs, 1, 12), rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.05, 5), spread: normalizeNumber(state.spread, defaults.spread, 0, 1), mix: normalizeNumber(state.mix, defaults.mix, 0, 1) }
})

export type LoFiQuantization = 'round' | 'floor' | 'truncate'
export type LoFiDither = 'off' | 'rectangular' | 'triangular'
export type LoFiParams = {
  enabled: boolean
  bitDepth: number
  sampleRateRatio: number
  jitter: number
  noiseDb: number
  quantization: LoFiQuantization
  dither: LoFiDither
  mix: number
  seed: number
}
export type LoFiParamsEnvelope = ProcessorStateEnvelope<LoFiParams>

export const createDefaultLoFiParams = (): LoFiParams => ({
  enabled: true,
  bitDepth: 12,
  sampleRateRatio: 1,
  jitter: 0,
  noiseDb: -80,
  quantization: 'round',
  dither: 'off',
  mix: 1,
  seed: 1,
})

export const normalizeLoFiParamsEnvelope = (value: unknown): LoFiParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)
  const defaults = createDefaultLoFiParams()
  const seed = normalizeNumber(state.seed, defaults.seed, 1, 0xffffffff)
  return {
    version: 1,
    state: {
      enabled: typeof state.enabled === 'boolean' ? state.enabled : defaults.enabled,
      bitDepth: Math.round(normalizeNumber(state.bitDepth, defaults.bitDepth, 2, 24)),
      sampleRateRatio: normalizeNumber(state.sampleRateRatio, defaults.sampleRateRatio, 0.01, 1),
      jitter: normalizeNumber(state.jitter, defaults.jitter, 0, 1),
      noiseDb: normalizeNumber(state.noiseDb, defaults.noiseDb, -120, -24),
      quantization: state.quantization === 'floor' || state.quantization === 'truncate' ? state.quantization : 'round',
      dither: state.dither === 'rectangular' || state.dither === 'triangular' ? state.dither : 'off',
      mix: normalizeNumber(state.mix, defaults.mix, 0, 1),
      seed: Math.max(1, Math.round(seed)) >>> 0,
    },
  }
}

export type AudioEffectKind = 'utility' | 'eq' | 'autofilter' | 'gate' | 'compressor' | 'saturator' | 'lofi' | 'limiter' | 'chorus' | 'flanger' | 'phaser' | 'tremolo' | 'autopan' | 'ensemble' | 'delay' | 'reverb' | 'spectral'
export type PlannedAudioEffectKind = AudioEffectKind
export type MasterAudioEffectKind = `master-${AudioEffectKind}`
export type AudioEffectInstance = {
  id: string
  kind: AudioEffectKind
}
export type AudioEffectOrderItem = AudioEffectKind | AudioEffectInstance

type EqAudioEffectContract = {
  kind: 'eq'
  masterKind: 'master-eq'
  createDefaultParams: () => EqParams
  normalizeParams: (params: EqParamsInput) => EqParams
  serializeParams: (params: EqParams) => string
}

type CompressorAudioEffectContract = {
  kind: 'compressor'
  masterKind: 'master-compressor'
  createDefaultParams: () => CompressorParams
  normalizeParams: (params: CompressorParamsInput) => CompressorParams
  serializeParams: (params: CompressorParams) => string
}

type SaturatorAudioEffectContract = {
  kind: 'saturator'
  masterKind: 'master-saturator'
  createDefaultParams: () => SaturatorParams
  normalizeParams: (params: SaturatorParamsInput) => SaturatorParams
  serializeParams: (params: SaturatorParams) => string
}

type DelayAudioEffectContract = {
  kind: 'delay'
  masterKind: 'master-delay'
  createDefaultParams: () => DelayParams
  normalizeParams: (params: DelayParamsInput) => DelayParams
  serializeParams: (params: DelayParams) => string
}

type ReverbAudioEffectContract = {
  kind: 'reverb'
  masterKind: 'master-reverb'
  createDefaultParams: () => ReverbParams
  normalizeParams: (params: ReverbParamsInput) => ReverbParams
  serializeParams: (params: ReverbParams) => string
}

type SpectralAudioEffectContract = {
  kind: 'spectral'
  masterKind: 'master-spectral'
  createDefaultParams: () => SpectralParamsEnvelope
  normalizeParams: (params: unknown) => SpectralParamsEnvelope
  serializeParams: (params: SpectralParamsEnvelope) => string
}

type UtilityAudioEffectContract = {
  kind: 'utility'
  masterKind: 'master-utility'
  createDefaultParams: () => UtilityParamsEnvelope
  normalizeParams: (params: unknown) => UtilityParamsEnvelope
  serializeParams: (params: UtilityParamsEnvelope) => string
}
type AutoFilterAudioEffectContract = {
  kind: 'autofilter'
  masterKind: 'master-autofilter'
  createDefaultParams: () => AutoFilterParamsEnvelope
  normalizeParams: (params: unknown) => AutoFilterParamsEnvelope
  serializeParams: (params: AutoFilterParamsEnvelope) => string
}

type GateAudioEffectContract = {
  kind: 'gate'
  masterKind: 'master-gate'
  createDefaultParams: () => GateParamsEnvelope
  normalizeParams: (params: unknown) => GateParamsEnvelope
  serializeParams: (params: GateParamsEnvelope) => string
}

type LimiterAudioEffectContract = {
  kind: 'limiter'
  masterKind: 'master-limiter'
  createDefaultParams: () => LimiterParamsEnvelope
  normalizeParams: (params: unknown) => LimiterParamsEnvelope
  serializeParams: (params: LimiterParamsEnvelope) => string
}
type LoFiAudioEffectContract = {
  kind: 'lofi'
  masterKind: 'master-lofi'
  createDefaultParams: () => LoFiParamsEnvelope
  normalizeParams: (params: unknown) => LoFiParamsEnvelope
  serializeParams: (params: LoFiParamsEnvelope) => string
}
type ChorusAudioEffectContract = {
  kind: 'chorus'
  masterKind: 'master-chorus'
  createDefaultParams: () => ChorusParamsEnvelope
  normalizeParams: (params: unknown) => ChorusParamsEnvelope
  serializeParams: (params: ChorusParamsEnvelope) => string
}
type FlangerAudioEffectContract = {
  kind: 'flanger'
  masterKind: 'master-flanger'
  createDefaultParams: () => FlangerParamsEnvelope
  normalizeParams: (params: unknown) => FlangerParamsEnvelope
  serializeParams: (params: FlangerParamsEnvelope) => string
}
type PhaserAudioEffectContract = {
  kind: 'phaser'
  masterKind: 'master-phaser'
  createDefaultParams: () => PhaserParamsEnvelope
  normalizeParams: (params: unknown) => PhaserParamsEnvelope
  serializeParams: (params: PhaserParamsEnvelope) => string
}
type TremoloAudioEffectContract = {
  kind: 'tremolo'
  masterKind: 'master-tremolo'
  createDefaultParams: () => TremoloParamsEnvelope
  normalizeParams: (params: unknown) => TremoloParamsEnvelope
  serializeParams: (params: TremoloParamsEnvelope) => string
}
type AutoPanAudioEffectContract = {
  kind: 'autopan'
  masterKind: 'master-autopan'
  createDefaultParams: () => AutoPanParamsEnvelope
  normalizeParams: (params: unknown) => AutoPanParamsEnvelope
  serializeParams: (params: AutoPanParamsEnvelope) => string
}
type EnsembleAudioEffectContract = {
  kind: 'ensemble'
  masterKind: 'master-ensemble'
  createDefaultParams: () => EnsembleParamsEnvelope
  normalizeParams: (params: unknown) => EnsembleParamsEnvelope
  serializeParams: (params: EnsembleParamsEnvelope) => string
}
type AudioEffectContractByKind = {
  utility: UtilityAudioEffectContract
  eq: EqAudioEffectContract
  autofilter: AutoFilterAudioEffectContract
  gate: GateAudioEffectContract
  limiter: LimiterAudioEffectContract
  lofi: LoFiAudioEffectContract
  compressor: CompressorAudioEffectContract
  saturator: SaturatorAudioEffectContract
  delay: DelayAudioEffectContract
  reverb: ReverbAudioEffectContract
  spectral: SpectralAudioEffectContract
  chorus: ChorusAudioEffectContract
  flanger: FlangerAudioEffectContract
  phaser: PhaserAudioEffectContract
  tremolo: TremoloAudioEffectContract
  autopan: AutoPanAudioEffectContract
  ensemble: EnsembleAudioEffectContract
}

export type AudioEffectContract = AudioEffectContractByKind[AudioEffectKind]

export const AUDIO_EFFECT_CONTRACTS = {
  utility: {
    kind: 'utility',
    masterKind: 'master-utility',
    createDefaultParams: () => ({ version: 1, state: createDefaultUtilityParams() }),
    normalizeParams: normalizeUtilityParamsEnvelope,
    serializeParams: (params: UtilityParamsEnvelope) => serializeUtilityParams(params.state),
  },
  eq: {
    kind: 'eq',
    masterKind: 'master-eq',
    createDefaultParams: createDefaultEqParams,
    normalizeParams: normalizeEqParams,
    serializeParams: serializeEqParams,
  },
  autofilter: {
    kind: 'autofilter',
    masterKind: 'master-autofilter',
    createDefaultParams: () => ({ version: 1, state: createDefaultAutoFilterParams() }),
    normalizeParams: normalizeAutoFilterParamsEnvelope,
    serializeParams: (params: AutoFilterParamsEnvelope) => serializeAutoFilterParams(params.state),
  },
  gate: {
    kind: 'gate',
    masterKind: 'master-gate',
    createDefaultParams: () => ({ version: 1, state: createDefaultGateParams() }),
    normalizeParams: normalizeGateParamsEnvelope,
    serializeParams: (params: GateParamsEnvelope) => serializeGateParams(params.state),
  },
  limiter: {
    kind: 'limiter',
    masterKind: 'master-limiter',
    createDefaultParams: () => ({ version: 1, state: createDefaultLimiterParams() }),
    normalizeParams: normalizeLimiterParamsEnvelope,
    serializeParams: (params: LimiterParamsEnvelope) => serializeLimiterParams(params.state),
  },
  lofi: {
    kind: 'lofi',
    masterKind: 'master-lofi',
    createDefaultParams: () => ({ version: 1, state: createDefaultLoFiParams() }),
    normalizeParams: normalizeLoFiParamsEnvelope,
    serializeParams: (params: LoFiParamsEnvelope) => JSON.stringify(normalizeLoFiParamsEnvelope(params)),
  },
  compressor: {
    kind: 'compressor',
    masterKind: 'master-compressor',
    createDefaultParams: createDefaultCompressorParams,
    normalizeParams: normalizeCompressorParams,
    serializeParams: serializeCompressorParams,
  },
  saturator: {
    kind: 'saturator',
    masterKind: 'master-saturator',
    createDefaultParams: createDefaultSaturatorParams,
    normalizeParams: normalizeSaturatorParams,
    serializeParams: serializeSaturatorParams,
  },
  delay: {
    kind: 'delay',
    masterKind: 'master-delay',
    createDefaultParams: createDefaultDelayParams,
    normalizeParams: normalizeDelayParams,
    serializeParams: serializeDelayParams,
  },
  reverb: {
    kind: 'reverb',
    masterKind: 'master-reverb',
    createDefaultParams: createDefaultReverbParams,
    normalizeParams: normalizeReverbParams,
    serializeParams: serializeReverbParams,
  },
  chorus: { kind: 'chorus', masterKind: 'master-chorus', createDefaultParams: () => ({ version: 1, state: createDefaultChorusParams() }), normalizeParams: normalizeChorusParamsEnvelope, serializeParams: (params: ChorusParamsEnvelope) => JSON.stringify(normalizeChorusParamsEnvelope(params)) },
  flanger: { kind: 'flanger', masterKind: 'master-flanger', createDefaultParams: () => ({ version: 1, state: createDefaultFlangerParams() }), normalizeParams: normalizeFlangerParamsEnvelope, serializeParams: (params: FlangerParamsEnvelope) => JSON.stringify(normalizeFlangerParamsEnvelope(params)) },
  phaser: { kind: 'phaser', masterKind: 'master-phaser', createDefaultParams: () => ({ version: 1, state: createDefaultPhaserParams() }), normalizeParams: normalizePhaserParamsEnvelope, serializeParams: (params: PhaserParamsEnvelope) => JSON.stringify(normalizePhaserParamsEnvelope(params)) },
  tremolo: { kind: 'tremolo', masterKind: 'master-tremolo', createDefaultParams: () => ({ version: 1, state: createDefaultTremoloParams() }), normalizeParams: normalizeTremoloParamsEnvelope, serializeParams: (params: TremoloParamsEnvelope) => JSON.stringify(normalizeTremoloParamsEnvelope(params)) },
  autopan: { kind: 'autopan', masterKind: 'master-autopan', createDefaultParams: () => ({ version: 1, state: createDefaultAutoPanParams() }), normalizeParams: normalizeAutoPanParamsEnvelope, serializeParams: (params: AutoPanParamsEnvelope) => JSON.stringify(normalizeAutoPanParamsEnvelope(params)) },
  ensemble: { kind: 'ensemble', masterKind: 'master-ensemble', createDefaultParams: () => ({ version: 1, state: createDefaultEnsembleParams() }), normalizeParams: normalizeEnsembleParamsEnvelope, serializeParams: (params: EnsembleParamsEnvelope) => JSON.stringify(normalizeEnsembleParamsEnvelope(params)) },
  spectral: {
    kind: 'spectral',
    masterKind: 'master-spectral',
    createDefaultParams: () => ({ version: 1, state: createDefaultSpectralParams() }),
    normalizeParams: normalizeSpectralParamsEnvelope,
    serializeParams: serializeSpectralParams,
  },
} satisfies AudioEffectContractByKind

const AUDIO_EFFECT_CATALOG_ORDER: PlannedAudioEffectKind[] = ['utility', 'eq', 'autofilter', 'gate', 'compressor', 'saturator', 'limiter', 'lofi', 'chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble', 'delay', 'reverb', 'spectral']
export const AUDIO_EFFECT_ORDER: AudioEffectKind[] = AUDIO_EFFECT_CATALOG_ORDER

export function isAudioEffectKind(value: unknown): value is AudioEffectKind {
  return AUDIO_EFFECT_ORDER.some((kind) => value === kind)
}

export function normalizeAudioEffectOrder(order: readonly unknown[], enabled: readonly AudioEffectKind[]): AudioEffectKind[] {
  const enabledSet = new Set(enabled)
  const seen = new Set<AudioEffectKind>()
  const normalized: AudioEffectKind[] = []
  for (const value of order) {
    if (!isAudioEffectKind(value) || !enabledSet.has(value) || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  for (const kind of AUDIO_EFFECT_ORDER) {
    if (!enabledSet.has(kind) || seen.has(kind)) continue
    seen.add(kind)
    normalized.push(kind)
  }
  return normalized
}

export function areAudioEffectOrdersEqual(left: readonly AudioEffectKind[] | undefined, right: readonly AudioEffectKind[]): boolean {
  return !!left && left.length === right.length && left.every((kind, index) => kind === right[index])
}

export function isAudioEffectInstance(value: unknown): value is AudioEffectInstance {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'id' in value
    && 'kind' in value
    && typeof value.id === 'string'
    && isAudioEffectKind(value.kind)
  )
}

export function audioEffectOrderItemKind(item: AudioEffectOrderItem): AudioEffectKind {
  return typeof item === 'string' ? item : item.kind
}

export function audioEffectOrderItemId(item: AudioEffectOrderItem): string {
  return typeof item === 'string' ? item : item.id
}

export function normalizeAudioEffectInstanceOrder(
  order: readonly AudioEffectOrderItem[],
  enabled: readonly AudioEffectInstance[],
): AudioEffectInstance[] {
  const enabledById = new Map(enabled.map((entry) => [entry.id, entry]))
  const legacyQueues = new Map<AudioEffectKind, AudioEffectInstance[]>()
  for (const entry of enabled) {
    const queue = legacyQueues.get(entry.kind)
    if (queue) queue.push(entry)
    else legacyQueues.set(entry.kind, [entry])
  }
  const seen = new Set<string>()
  const normalized: AudioEffectInstance[] = []
  for (const item of order) {
    const entry = typeof item === 'string'
      ? legacyQueues.get(item)?.find((candidate) => !seen.has(candidate.id))
      : enabledById.get(item.id)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    normalized.push(entry)
  }
  for (const entry of enabled) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    normalized.push(entry)
  }
  return normalized
}

export function areAudioEffectInstanceOrdersEqual(
  left: readonly AudioEffectInstance[] | undefined,
  right: readonly AudioEffectInstance[],
): boolean {
  return !!left && left.length === right.length && left.every((entry, index) => (
    entry.id === right[index].id && entry.kind === right[index].kind
  ))
}

export type SynthWave = 'sine' | 'square' | 'sawtooth' | 'triangle'

export type SynthParams = {
  wave1: SynthWave
  wave2: SynthWave
  gain: number
  attackMs: number
  releaseMs: number
}

export type SynthParamsInput = Partial<SynthParams>

export function createDefaultSynthParams(): SynthParams {
  return {
    wave1: 'sawtooth',
    wave2: 'sawtooth',
    gain: 0.8,
    attackMs: 5,
    releaseMs: 30,
  }
}

export function normalizeSynthParams(input: SynthParamsInput): SynthParams {
  const wave1 = input.wave1 ?? 'sawtooth'
  const wave2 = input.wave2 ?? wave1

  return {
    wave1,
    wave2,
    gain: typeof input.gain === 'number' ? clamp(input.gain, 0, 1.5) : 0.8,
    attackMs: typeof input.attackMs === 'number' ? clamp(input.attackMs, 0, 200) : 5,
    releaseMs: typeof input.releaseMs === 'number' ? clamp(input.releaseMs, 0, 200) : 30,
  }
}

export function serializeSynthParams(params: SynthParams): string {
  return JSON.stringify(params)
}

export type ArpeggiatorPattern = 'up' | 'down' | 'updown' | 'random'
export type ArpeggiatorRate = '1/4' | '1/8' | '1/16' | '1/32'

export type ArpeggiatorParams = {
  enabled: boolean
  pattern: ArpeggiatorPattern
  rate: ArpeggiatorRate
  octaves: number
  gate: number
  hold: boolean
}

export type ArpParams = ArpeggiatorParams

export function createDefaultArpeggiatorParams(): ArpeggiatorParams {
  return {
    enabled: true,
    pattern: 'up',
    rate: '1/16',
    octaves: 1,
    gate: 0.8,
    hold: true,
  }
}

export function supportsGain(type: EqBandType): boolean {
  return type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
}

