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

export type AudioEffectKind = 'eq' | 'saturator' | 'delay' | 'reverb'
export type MasterAudioEffectKind = 'master-eq' | 'master-saturator' | 'master-delay' | 'master-reverb'

type EqAudioEffectContract = {
  kind: 'eq'
  masterKind: 'master-eq'
  createDefaultParams: () => EqParams
  normalizeParams: (params: EqParamsInput) => EqParams
  serializeParams: (params: EqParams) => string
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

type AudioEffectContractByKind = {
  eq: EqAudioEffectContract
  saturator: SaturatorAudioEffectContract
  delay: DelayAudioEffectContract
  reverb: ReverbAudioEffectContract
}

export type AudioEffectContract = AudioEffectContractByKind[AudioEffectKind]

export const AUDIO_EFFECT_CONTRACTS = {
  eq: {
    kind: 'eq',
    masterKind: 'master-eq',
    createDefaultParams: createDefaultEqParams,
    normalizeParams: normalizeEqParams,
    serializeParams: serializeEqParams,
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
} satisfies AudioEffectContractByKind

export const AUDIO_EFFECT_ORDER: AudioEffectKind[] = ['eq', 'saturator', 'delay', 'reverb']

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

