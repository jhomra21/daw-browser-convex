import { AUDIO_EFFECT_KINDS, isAudioEffectKind, type AudioEffectKind } from './audio-effect-registry'
import { clamp } from './numeric'
import { isJsonBoolean, isJsonNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from './json-value'
import {
  createDefaultSpectralParams,
  normalizeSpectralParamsEnvelope,
  serializeSpectralParams,
  type SpectralParamsEnvelope,
} from './spectral-params'

export type EqBandType =
  | 'lowpass' | 'highpass' | 'bandpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'allpass'
  | 'lowpass48' | 'highpass48'

export type EqBandParams = {
  id: string
  frequency: number
  gainDb: number
  q: number
  enabled: boolean
  type: EqBandType
}

// 'mono' is the pre-EQ-Eight "sum to mono" mode, kept so saved devices sound the same; the chooser offers the other three.
export type EqChannelMode = 'stereo' | 'leftRight' | 'midSide' | 'mono'

// EQ Eight: `bands` holds two curves of EQ_BANDS_PER_CURVE bands. Curve A (indices 0-7) is the only curve in Stereo
// and Mono and the left (mid) curve in L/R (M/S); curve B (indices 8-15) is the right (side) curve.
export type EqParams = {
  bands: EqBandParams[]
  enabled: boolean
  channelMode: EqChannelMode
  adaptiveQ: boolean
  // Multiplies every band gain: 1 is 100 %.
  scale: number
  outputDb: number
  // Runs the bands at twice the sample rate, which costs CPU and 3 frames of latency.
  highQuality: boolean
}

export type EqParamsLite = EqParams

export type EqBandParamsInput = Partial<Omit<EqBandParams, 'type'>> & { type?: JsonValue }

export type EqParamsInput = {
  enabled?: boolean
  bands?: EqBandParamsInput[]
  channelMode?: JsonValue
  adaptiveQ?: boolean
  scale?: number
  outputDb?: number
  highQuality?: boolean
}

export const EQ_FREQUENCY_MIN = 20
export const EQ_FREQUENCY_MAX = 20000
export const EQ_GAIN_DB_MIN = -24
export const EQ_GAIN_DB_MAX = 24
export const EQ_Q_MIN = 0.2
export const EQ_Q_MAX = 18
export const EQ_SCALE_MIN = 0
export const EQ_SCALE_MAX = 2
export const EQ_OUTPUT_DB_MIN = -12
export const EQ_OUTPUT_DB_MAX = 12
export const EQ_BANDS_PER_CURVE = 8
export const EQ_BAND_COUNT = 2 * EQ_BANDS_PER_CURVE

// The core's declared latency with Hi-Quality on: the group delay of its half-band oversampler at low frequencies.
export const EQ_HIGH_QUALITY_LATENCY_FRAMES = 3
const DEFAULT_EQ_FREQUENCIES = [40, 100, 200, 500, 1000, 2500, 6000, 12000]

function readFiniteNumber(value: JsonValue | undefined): number | undefined {
  return isJsonNumber(value) && Number.isFinite(value) ? value : undefined
}

function getDefaultEqBandType(index: number): EqBandType {
  const curveIndex = index % EQ_BANDS_PER_CURVE

  if (curveIndex === 0) return 'lowshelf'

  if (curveIndex === EQ_BANDS_PER_CURVE - 1) return 'highshelf'

  return 'peaking'
}

export function createDefaultEqBand(index: number): EqBandParams {
  return {
    id: `b${index + 1}`,
    frequency: DEFAULT_EQ_FREQUENCIES[index % EQ_BANDS_PER_CURVE] ?? 1000,
    gainDb: 0,
    q: 1,
    enabled: true,
    type: getDefaultEqBandType(index),
  }
}

export function createDefaultEqParams(): EqParams {
  return {
    bands: Array.from({ length: EQ_BAND_COUNT }, (_, index) => createDefaultEqBand(index)),
    enabled: true,
    channelMode: 'stereo',
    adaptiveQ: false,
    scale: 1,
    outputDb: 0,
    highQuality: true,
  }
}

export function normalizeEqChannelMode(value: JsonValue | undefined): EqChannelMode {
  return value === 'mono' || value === 'leftRight' || value === 'midSide' ? value : 'stereo'
}

export function isEqBandType(value: JsonValue | undefined): value is EqBandType {
  return (
    value === 'allpass'
    || value === 'bandpass'
    || value === 'highpass'
    || value === 'highpass48'
    || value === 'highshelf'
    || value === 'lowpass'
    || value === 'lowpass48'
    || value === 'lowshelf'
    || value === 'notch'
    || value === 'peaking'
  )
}

export function normalizeEqParams(input: EqParamsInput): EqParams {
  const defaults = createDefaultEqParams()
  // The EQ has exactly two curves of eight bands, which the engine contract requires. Slots the input leaves out keep
  // their flat default band, except that a missing second curve starts as a copy of the first (as in EQ Eight).
  const given = Array.isArray(input.bands) ? input.bands.slice(0, EQ_BAND_COUNT) : []
  const givenIds = new Set(given.flatMap((band) => isJsonString(band.id) ? [band.id] : []))

  const bandsInput = defaults.bands.map((defaultBand, index) => {
    const mirrored = given.length <= EQ_BANDS_PER_CURVE && index >= EQ_BANDS_PER_CURVE ? given[index - EQ_BANDS_PER_CURVE] : undefined
    const band = given[index] ?? (mirrored === undefined ? undefined : { ...mirrored, id: defaultBand.id })

    return band ?? (givenIds.has(defaultBand.id) ? { ...defaultBand, id: `${defaultBand.id}-default` } : defaultBand)
  })

  return {
    enabled: isJsonBoolean(input.enabled) ? input.enabled : defaults.enabled,
    channelMode: normalizeEqChannelMode(input.channelMode),
    adaptiveQ: isJsonBoolean(input.adaptiveQ) ? input.adaptiveQ : defaults.adaptiveQ,
    scale: clamp(readFiniteNumber(input.scale) ?? defaults.scale, EQ_SCALE_MIN, EQ_SCALE_MAX),
    outputDb: clamp(readFiniteNumber(input.outputDb) ?? defaults.outputDb, EQ_OUTPUT_DB_MIN, EQ_OUTPUT_DB_MAX),
    highQuality: isJsonBoolean(input.highQuality) ? input.highQuality : defaults.highQuality,
    bands: bandsInput.map((band, index) => {
      const defaultBand = defaults.bands[index] ?? createDefaultEqBand(index)
      const frequency = readFiniteNumber(band.frequency)
      const gainDb = readFiniteNumber(band.gainDb)
      const q = readFiniteNumber(band.q)

      return {
        id: isJsonString(band.id) && band.id.length > 0 ? band.id : defaultBand.id,
        frequency: frequency === undefined ? defaultBand.frequency : clamp(frequency, EQ_FREQUENCY_MIN, EQ_FREQUENCY_MAX),
        gainDb: gainDb === undefined ? defaultBand.gainDb : clamp(gainDb, EQ_GAIN_DB_MIN, EQ_GAIN_DB_MAX),
        q: q === undefined ? defaultBand.q : clamp(q, EQ_Q_MIN, EQ_Q_MAX),
        enabled: isJsonBoolean(band.enabled) ? band.enabled : defaultBand.enabled,
        type: isEqBandType(band.type) ? band.type : defaultBand.type,
      }
    }),
  }
}

export function normalizeEqParamsForUpdate(input: EqParamsInput, existing?: EqParamsInput): EqParams {
  const base = existing === undefined ? {} : normalizeEqParams(existing)
  // An update that names only the first curve leaves the stored second curve alone.
  const keepsSecondCurve = existing !== undefined && Array.isArray(input.bands) && input.bands.length <= EQ_BANDS_PER_CURVE
  const merged = { ...base, ...input }

  return normalizeEqParams(keepsSecondCurve && 'bands' in base && Array.isArray(base.bands)
    ? { ...merged, bands: [...(input.bands ?? []), ...base.bands.slice(input.bands?.length ?? 0)] }
    : merged)
}

export function serializeNormalizedEqParams(params: EqParams): string {
  let signature = `${params.enabled ? '1' : '0'}|${params.channelMode}|${params.adaptiveQ ? 1 : 0}|${params.scale}|${params.outputDb}|${params.highQuality ? 1 : 0}`

  for (const band of params.bands) {
    signature += `|${band.id}:${band.enabled ? 1 : 0}:${band.type}:${band.frequency}:${band.gainDb}:${band.q}`
  }

  return signature
}

export function serializeEqParams(params: EqParams): string {
  return serializeNormalizedEqParams(normalizeEqParams(params))
}

export const REVERB_DENSITIES = ['sparse', 'low', 'mid', 'high'] as const

export type ReverbDensity = typeof REVERB_DENSITIES[number]

export const REVERB_SMOOTHS = ['none', 'slow', 'fast'] as const

export type ReverbSmooth = typeof REVERB_SMOOTHS[number]

export type ReverbParams = {
  enabled: boolean
  wet: number
  decaySec: number
  preDelayMs: number
  reflections: number
  reflectionSpin: boolean
  reflectionModAmountMs: number
  reflectionModRateHz: number
  'reflectionShape': number
  diffuse: number
  size: number
  diffusion: number
  density: ReverbDensity
  /** Input Lo and Hi cut, ahead of the pre-delay, early reflections and diffuser. A cut that is off keeps its frequency and passes the input. */
  lowCutHz: number
  highCutHz: number
  lowCutOn: boolean
  highCutOn: boolean
  /** The Diffusion Network shelves move the decay time at the band edges; the Decay knob is the mid-band RT60. */
  lowShelfHz: number
  highShelfHz: number
  lowShelfOn: boolean
  highShelfOn: boolean
  lowShelfDb: number
  highShelfDb: number
  /** The Stereo angle in degrees: 0 is mono, 120 is two independent channels. */
  stereoWidth: number
  smooth: ReverbSmooth
  freeze: boolean
  flat: boolean
  cut: boolean
  chorus: boolean
  chorusAmountMs: number
  chorusRateHz: number
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
export const REVERB_LOW_SHELF_HZ_MIN = 20
export const REVERB_LOW_SHELF_HZ_MAX = 1200
export const REVERB_HIGH_SHELF_HZ_MIN = 1200
export const REVERB_HIGH_SHELF_HZ_MAX = 20000
export const REVERB_SHELF_DB_MIN = -24
export const REVERB_SHELF_DB_MAX = 12
export const REVERB_STEREO_WIDTH_MIN = 0
export const REVERB_STEREO_WIDTH_MAX = 120
export const REVERB_CHORUS_AMOUNT_MS_MIN = 0
export const REVERB_CHORUS_AMOUNT_MS_MAX = 5
export const REVERB_CHORUS_RATE_HZ_MIN = 0.01
export const REVERB_CHORUS_RATE_HZ_MAX = 5

export function createDefaultReverbParams(): ReverbParams {
  return {
    enabled: true,
    wet: 0.25,
    decaySec: 2.2,
    preDelayMs: 20,
    reflections: 0.25,
    reflectionSpin: true,
    reflectionModAmountMs: 17.5,
    reflectionModRateHz: 0.3,
    'reflectionShape': 0.5,
    diffuse: 0.7,
    size: 0.65,
    diffusion: 0.75,
    density: 'high',
    lowCutHz: 20,
    highCutHz: 20000,
    lowCutOn: false,
    highCutOn: false,
    lowShelfHz: 200,
    highShelfHz: 5000,
    lowShelfOn: true,
    highShelfOn: true,
    lowShelfDb: 0,
    highShelfDb: 0,
    stereoWidth: 100,
    smooth: 'fast',
    freeze: false,
    flat: false,
    cut: false,
    chorus: true,
    chorusAmountMs: 0.6,
    chorusRateHz: 0.6,
  }
}

const readReverbNumber = (value: JsonValue | undefined, fallback: number, min: number, max: number) => {
  const number = readFiniteNumber(value)

  return number === undefined ? fallback : clamp(number, min, max)
}

const readReverbBoolean = (value: JsonValue | undefined, fallback: boolean) => isJsonBoolean(value) ? value : fallback

export function normalizeReverbParams(input: ReverbParamsInput): ReverbParams {
  const defaults = createDefaultReverbParams()

  return {
    enabled: readReverbBoolean(input.enabled, defaults.enabled),
    wet: readReverbNumber(input.wet, defaults.wet, REVERB_WET_MIN, REVERB_WET_MAX),
    decaySec: readReverbNumber(input.decaySec, defaults.decaySec, REVERB_DECAY_SEC_MIN, REVERB_DECAY_SEC_MAX),
    preDelayMs: readReverbNumber(input.preDelayMs, defaults.preDelayMs, REVERB_PRE_DELAY_MS_MIN, REVERB_PRE_DELAY_MS_MAX),
    reflections: readReverbNumber(input.reflections, defaults.reflections, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    reflectionSpin: readReverbBoolean(input.reflectionSpin, defaults.reflectionSpin),
    reflectionModAmountMs: readReverbNumber(input.reflectionModAmountMs, defaults.reflectionModAmountMs, REVERB_REFLECTION_MOD_AMOUNT_MS_MIN, REVERB_REFLECTION_MOD_AMOUNT_MS_MAX),
    reflectionModRateHz: readReverbNumber(input.reflectionModRateHz, defaults.reflectionModRateHz, REVERB_REFLECTION_MOD_RATE_HZ_MIN, REVERB_REFLECTION_MOD_RATE_HZ_MAX),
    'reflectionShape': readReverbNumber(input['reflectionShape'], defaults['reflectionShape'], REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    diffuse: readReverbNumber(input.diffuse, defaults.diffuse, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    size: readReverbNumber(input.size, defaults.size, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    diffusion: readReverbNumber(input.diffusion, defaults.diffusion, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX),
    density: REVERB_DENSITIES.find((density) => density === input.density) ?? defaults.density,
    lowCutHz: readReverbNumber(input.lowCutHz, defaults.lowCutHz, REVERB_LOW_CUT_HZ_MIN, REVERB_LOW_CUT_HZ_MAX),
    highCutHz: readReverbNumber(input.highCutHz, defaults.highCutHz, REVERB_HIGH_CUT_HZ_MIN, REVERB_HIGH_CUT_HZ_MAX),
    lowCutOn: readReverbBoolean(input.lowCutOn, defaults.lowCutOn),
    highCutOn: readReverbBoolean(input.highCutOn, defaults.highCutOn),
    lowShelfHz: readReverbNumber(input.lowShelfHz, defaults.lowShelfHz, REVERB_LOW_SHELF_HZ_MIN, REVERB_LOW_SHELF_HZ_MAX),
    highShelfHz: readReverbNumber(input.highShelfHz, defaults.highShelfHz, REVERB_HIGH_SHELF_HZ_MIN, REVERB_HIGH_SHELF_HZ_MAX),
    lowShelfOn: readReverbBoolean(input.lowShelfOn, defaults.lowShelfOn),
    highShelfOn: readReverbBoolean(input.highShelfOn, defaults.highShelfOn),
    lowShelfDb: readReverbNumber(input.lowShelfDb, defaults.lowShelfDb, REVERB_SHELF_DB_MIN, REVERB_SHELF_DB_MAX),
    highShelfDb: readReverbNumber(input.highShelfDb, defaults.highShelfDb, REVERB_SHELF_DB_MIN, REVERB_SHELF_DB_MAX),
    stereoWidth: readReverbNumber(input.stereoWidth, defaults.stereoWidth, REVERB_STEREO_WIDTH_MIN, REVERB_STEREO_WIDTH_MAX),
    smooth: REVERB_SMOOTHS.find((smooth) => smooth === input.smooth) ?? defaults.smooth,
    freeze: readReverbBoolean(input.freeze, defaults.freeze),
    flat: readReverbBoolean(input.flat, defaults.flat),
    cut: readReverbBoolean(input.cut, defaults.cut),
    chorus: readReverbBoolean(input.chorus, defaults.chorus),
    chorusAmountMs: readReverbNumber(input.chorusAmountMs, defaults.chorusAmountMs, REVERB_CHORUS_AMOUNT_MS_MIN, REVERB_CHORUS_AMOUNT_MS_MAX),
    chorusRateHz: readReverbNumber(input.chorusRateHz, defaults.chorusRateHz, REVERB_CHORUS_RATE_HZ_MIN, REVERB_CHORUS_RATE_HZ_MAX),
  }
}

export function normalizeReverbParamsForUpdate(input: ReverbParamsInput, existing?: ReverbParamsInput): ReverbParams {
  const base = existing === undefined ? {} : normalizeReverbParams(existing)

  return normalizeReverbParams({ ...base, ...input })
}

export function serializeReverbParams(params: ReverbParams): string {
  const n = normalizeReverbParams(params)
  const flag = (value: boolean) => value ? 1 : 0

  return [
    flag(n.enabled), n.wet, n.decaySec, n.preDelayMs, n.reflections, flag(n.reflectionSpin), n.reflectionModAmountMs, n.reflectionModRateHz,
    n['reflectionShape'], n.diffuse, n.size, n.diffusion, n.density, n.lowCutHz, n.highCutHz, flag(n.lowCutOn), flag(n.highCutOn), n.lowShelfHz, n.highShelfHz,
    flag(n.lowShelfOn), flag(n.highShelfOn), n.lowShelfDb, n.highShelfDb, n.stereoWidth, n.smooth, flag(n.freeze), flag(n.flat),
    flag(n.cut), flag(n.chorus), n.chorusAmountMs, n.chorusRateHz,
  ].join('|')
}

export type SaturatorCurve = 'soft' | 'medium' | 'hard' | 'clip' | 'analog' | 'sine' | 'bass' | 'fold' | 'warp'

export type SaturatorPostClip = 'off' | 'soft' | 'hard'

// Color is a pre-EQ of two shelves around Frequency (Width sets their Q) ahead of the curve, and its exact inverse after it.
export type SaturatorParams = {
  enabled: boolean
  hiQuality: boolean
  driveDb: number
  curve: SaturatorCurve
  color: boolean
  colorFrequencyHz: number
  colorWidth: number
  colorLowDb: number
  colorHighDb: number
  bassThresholdDb: number
  warpDepth: number
  warpPeriod: number
  postClip: SaturatorPostClip
  outputDb: number
  dryWet: number
}

export type SaturatorParamsLite = SaturatorParams

export type SaturatorParamsInput = Partial<Omit<SaturatorParams, 'curve' | 'postClip'>> & { curve?: JsonValue; postClip?: JsonValue }

export const SATURATOR_DRIVE_DB_MIN = 0
export const SATURATOR_DRIVE_DB_MAX = 36
export const SATURATOR_OUTPUT_DB_MIN = -24
export const SATURATOR_OUTPUT_DB_MAX = 12
export const SATURATOR_DRY_WET_MIN = 0
export const SATURATOR_DRY_WET_MAX = 1
export const SATURATOR_COLOR_FREQUENCY_HZ_MIN = 100
export const SATURATOR_COLOR_FREQUENCY_HZ_MAX = 10000
export const SATURATOR_COLOR_WIDTH_MIN = 0
export const SATURATOR_COLOR_WIDTH_MAX = 1
export const SATURATOR_COLOR_DB_MIN = -12
export const SATURATOR_COLOR_DB_MAX = 12
export const SATURATOR_BASS_THRESHOLD_DB_MIN = -50
export const SATURATOR_BASS_THRESHOLD_DB_MAX = 0
export const SATURATOR_WARP_DEPTH_MIN = 0
export const SATURATOR_WARP_DEPTH_MAX = 1
export const SATURATOR_WARP_PERIOD_MIN = 0.1
export const SATURATOR_WARP_PERIOD_MAX = 1

export function createDefaultSaturatorParams(): SaturatorParams {
  return {
    enabled: true,
    hiQuality: true,
    driveDb: 6,
    curve: 'soft',
    color: false,
    colorFrequencyHz: 1200,
    colorWidth: 0.57,
    colorLowDb: 0,
    colorHighDb: 0,
    bassThresholdDb: -12,
    warpDepth: 0.5,
    warpPeriod: 0.5,
    postClip: 'off',
    outputDb: 0,
    dryWet: 1,
  }
}

const SATURATOR_CURVES: readonly SaturatorCurve[] = ['soft', 'medium', 'hard', 'clip', 'analog', 'sine', 'bass', 'fold', 'warp']

const SATURATOR_POST_CLIPS: readonly SaturatorPostClip[] = ['off', 'soft', 'hard']

export function isSaturatorCurve(value: JsonValue | undefined): value is SaturatorCurve {
  return SATURATOR_CURVES.some((curve) => curve === value)
}

export function isSaturatorPostClip(value: JsonValue | undefined): value is SaturatorPostClip {
  return SATURATOR_POST_CLIPS.some((postClip) => postClip === value)
}

const SATURATOR_HARD_SLOPE = Math.PI / 2
const SATURATOR_MEDIUM_REACH = 1.5
const SATURATOR_ANALOG_THRESHOLD = 0.5

// Linear up to the threshold, then threshold + h tanh((x - threshold) / h), h = 1 - threshold: slope one, asymptote one, no corner.
const saturatorKnee = (magnitude: number, threshold: number) => {
  if (magnitude <= threshold) return magnitude
  const height = Math.max(1 - threshold, 1e-4)

  return threshold + height * Math.tanh((magnitude - threshold) / height)
}

// The shaper the core runs (saturator_kernel.h SaturatorShape::value). Every curve has slope one at the origin and an asymptote
// near one, so Drive 0 passes a quiet signal at unity whichever curve is chosen.
export function evaluateSaturatorCurvePoint(
  curve: SaturatorCurve,
  input: number,
  knobs: Pick<SaturatorParams, 'bassThresholdDb' | 'warpDepth' | 'warpPeriod'> = createDefaultSaturatorParams(),
): number {
  switch (curve) {
    case 'medium': {
      const reach = clamp(input, -SATURATOR_MEDIUM_REACH, SATURATOR_MEDIUM_REACH)

      return reach - reach * reach * reach / 6.75
    }

    case 'hard': return Math.atan(SATURATOR_HARD_SLOPE * input) / SATURATOR_HARD_SLOPE
    case 'clip': return clamp(input, -1, 1)
    case 'analog': return Math.sign(input) * saturatorKnee(Math.abs(input), SATURATOR_ANALOG_THRESHOLD)
    case 'sine': return Math.sin(clamp(input, -Math.PI / 2, Math.PI / 2))
    case 'bass': return Math.sign(input) * saturatorKnee(Math.abs(input), 10 ** (knobs.bassThresholdDb / 20))
    case 'fold': return Math.sin(input)
    case 'warp': return (1 - knobs.warpDepth) * Math.tanh(input) + knobs.warpDepth * knobs.warpPeriod * Math.sin(input / knobs.warpPeriod)
    default: return Math.tanh(input)
  }
}

export function normalizeSaturatorParams(input: SaturatorParamsInput = {}): SaturatorParams {
  const defaults = createDefaultSaturatorParams()

  const read = (value: number | undefined, fallback: number, min: number, max: number) => {
    const finite = readFiniteNumber(value)

    return finite === undefined ? fallback : clamp(finite, min, max)
  }

  return {
    enabled: isJsonBoolean(input.enabled) ? input.enabled : defaults.enabled,
    hiQuality: isJsonBoolean(input.hiQuality) ? input.hiQuality : defaults.hiQuality,
    driveDb: read(input.driveDb, defaults.driveDb, SATURATOR_DRIVE_DB_MIN, SATURATOR_DRIVE_DB_MAX),
    curve: isSaturatorCurve(input.curve) ? input.curve : defaults.curve,
    color: isJsonBoolean(input.color) ? input.color : defaults.color,
    colorFrequencyHz: read(input.colorFrequencyHz, defaults.colorFrequencyHz, SATURATOR_COLOR_FREQUENCY_HZ_MIN, SATURATOR_COLOR_FREQUENCY_HZ_MAX),
    colorWidth: read(input.colorWidth, defaults.colorWidth, SATURATOR_COLOR_WIDTH_MIN, SATURATOR_COLOR_WIDTH_MAX),
    colorLowDb: read(input.colorLowDb, defaults.colorLowDb, SATURATOR_COLOR_DB_MIN, SATURATOR_COLOR_DB_MAX),
    colorHighDb: read(input.colorHighDb, defaults.colorHighDb, SATURATOR_COLOR_DB_MIN, SATURATOR_COLOR_DB_MAX),
    bassThresholdDb: read(input.bassThresholdDb, defaults.bassThresholdDb, SATURATOR_BASS_THRESHOLD_DB_MIN, SATURATOR_BASS_THRESHOLD_DB_MAX),
    warpDepth: read(input.warpDepth, defaults.warpDepth, SATURATOR_WARP_DEPTH_MIN, SATURATOR_WARP_DEPTH_MAX),
    warpPeriod: read(input.warpPeriod, defaults.warpPeriod, SATURATOR_WARP_PERIOD_MIN, SATURATOR_WARP_PERIOD_MAX),
    postClip: isSaturatorPostClip(input.postClip) ? input.postClip : defaults.postClip,
    outputDb: read(input.outputDb, defaults.outputDb, SATURATOR_OUTPUT_DB_MIN, SATURATOR_OUTPUT_DB_MAX),
    dryWet: read(input.dryWet, defaults.dryWet, SATURATOR_DRY_WET_MIN, SATURATOR_DRY_WET_MAX),
  }
}

export function normalizeSaturatorParamsForUpdate(input: SaturatorParamsInput, existing?: SaturatorParamsInput): SaturatorParams {
  const base = existing === undefined ? {} : normalizeSaturatorParams(existing)

  return normalizeSaturatorParams({ ...base, ...input })
}

export function serializeSaturatorParams(params: SaturatorParams): string {
  const n = normalizeSaturatorParams(params)

  return [
    n.enabled ? 1 : 0, n.hiQuality ? 1 : 0, n.driveDb, n.curve, n.color ? 1 : 0, n.colorFrequencyHz, n.colorWidth, n.colorLowDb, n.colorHighDb,
    n.bassThresholdDb, n.warpDepth, n.warpPeriod, n.postClip, n.outputDb, n.dryWet,
  ].join('|')
}

export type DelaySmoothing = 'repitch' | 'fade' | 'jump'

export type DelaySyncDivision = '1/32' | '1/16' | '1/8' | '1/4' | '1/2' | '1/1'

export type DelayFeel = 'straight' | 'dotted' | 'triplet'

// The shape is the portable processor's state: each channel has its own time (free, or a division with a feel and an offset);
// with Link on the right channel follows the left one.
export type DelayParams = {
  enabled: boolean
  link: boolean
  pingPong: boolean
  freeze: boolean
  filterEnabled: boolean
  smoothing: DelaySmoothing
  syncLeft: boolean
  syncRight: boolean
  divisionLeft: DelaySyncDivision
  divisionRight: DelaySyncDivision
  feelLeft: DelayFeel
  feelRight: DelayFeel
  timeLeftMs: number
  timeRightMs: number
  offsetLeftPercent: number
  offsetRightPercent: number
  feedback: number
  dryWet: number
  filterHz: number
  filterWidth: number
}

export type DelayParamsLite = DelayParams

export type DelayParamsInput = Partial<Omit<DelayParams, 'smoothing' | 'divisionLeft' | 'divisionRight' | 'feelLeft' | 'feelRight'>> & {
  smoothing?: JsonValue
  divisionLeft?: JsonValue
  divisionRight?: JsonValue
  feelLeft?: JsonValue
  feelRight?: JsonValue
}

export const DELAY_TIME_MS_MIN = 1
export const DELAY_TIME_MS_MAX = 5000
export const DELAY_MAX_DELAY_TIME_SEC = 5
export const DELAY_OFFSET_PERCENT_MIN = -33
export const DELAY_OFFSET_PERCENT_MAX = 33
export const DELAY_FEEDBACK_MIN = 0
export const DELAY_FEEDBACK_MAX = 1
export const DELAY_DRY_WET_MIN = 0
export const DELAY_DRY_WET_MAX = 1
export const DELAY_FILTER_HZ_MIN = 20
export const DELAY_FILTER_HZ_MAX = 20000
export const DELAY_FILTER_WIDTH_MIN = 0.5
export const DELAY_FILTER_WIDTH_MAX = 9

export function createDefaultDelayParams(): DelayParams {
  return {
    enabled: true,
    link: true,
    pingPong: false,
    freeze: false,
    filterEnabled: false,
    smoothing: 'repitch',
    syncLeft: true,
    syncRight: true,
    divisionLeft: '1/8',
    divisionRight: '1/8',
    feelLeft: 'straight',
    feelRight: 'straight',
    timeLeftMs: 250,
    timeRightMs: 250,
    offsetLeftPercent: 0,
    offsetRightPercent: 0,
    feedback: 0.25,
    dryWet: 0.2,
    filterHz: 1000,
    filterWidth: 5,
  }
}

export function isDelaySmoothing(value: JsonValue | undefined): value is DelaySmoothing {
  return value === 'repitch' || value === 'fade' || value === 'jump'
}

export function isDelaySyncDivision(value: JsonValue | undefined): value is DelaySyncDivision {
  return value === '1/32' || value === '1/16' || value === '1/8' || value === '1/4' || value === '1/2' || value === '1/1'
}

export function isDelayFeel(value: JsonValue | undefined): value is DelayFeel {
  return value === 'straight' || value === 'dotted' || value === 'triplet'
}

export function normalizeDelayParams(input: DelayParamsInput = {}): DelayParams {
  const defaults = createDefaultDelayParams()

  const number = (value: number | undefined, fallback: number, min: number, max: number) => {
    const finite = readFiniteNumber(value)

    return finite === undefined ? fallback : clamp(finite, min, max)
  }

  const flag = (value: boolean | undefined, fallback: boolean) => (isJsonBoolean(value) ? value : fallback)

  return {
    enabled: flag(input.enabled, defaults.enabled),
    link: flag(input.link, defaults.link),
    pingPong: flag(input.pingPong, defaults.pingPong),
    freeze: flag(input.freeze, defaults.freeze),
    filterEnabled: flag(input.filterEnabled, defaults.filterEnabled),
    smoothing: isDelaySmoothing(input.smoothing) ? input.smoothing : defaults.smoothing,
    syncLeft: flag(input.syncLeft, defaults.syncLeft),
    syncRight: flag(input.syncRight, defaults.syncRight),
    divisionLeft: isDelaySyncDivision(input.divisionLeft) ? input.divisionLeft : defaults.divisionLeft,
    divisionRight: isDelaySyncDivision(input.divisionRight) ? input.divisionRight : defaults.divisionRight,
    feelLeft: isDelayFeel(input.feelLeft) ? input.feelLeft : defaults.feelLeft,
    feelRight: isDelayFeel(input.feelRight) ? input.feelRight : defaults.feelRight,
    timeLeftMs: number(input.timeLeftMs, defaults.timeLeftMs, DELAY_TIME_MS_MIN, DELAY_TIME_MS_MAX),
    timeRightMs: number(input.timeRightMs, defaults.timeRightMs, DELAY_TIME_MS_MIN, DELAY_TIME_MS_MAX),
    offsetLeftPercent: number(input.offsetLeftPercent, defaults.offsetLeftPercent, DELAY_OFFSET_PERCENT_MIN, DELAY_OFFSET_PERCENT_MAX),
    offsetRightPercent: number(input.offsetRightPercent, defaults.offsetRightPercent, DELAY_OFFSET_PERCENT_MIN, DELAY_OFFSET_PERCENT_MAX),
    feedback: number(input.feedback, defaults.feedback, DELAY_FEEDBACK_MIN, DELAY_FEEDBACK_MAX),
    dryWet: number(input.dryWet, defaults.dryWet, DELAY_DRY_WET_MIN, DELAY_DRY_WET_MAX),
    filterHz: number(input.filterHz, defaults.filterHz, DELAY_FILTER_HZ_MIN, DELAY_FILTER_HZ_MAX),
    filterWidth: number(input.filterWidth, defaults.filterWidth, DELAY_FILTER_WIDTH_MIN, DELAY_FILTER_WIDTH_MAX),
  }
}

export function normalizeDelayParamsForUpdate(input: DelayParamsInput, existing?: DelayParamsInput): DelayParams {
  const base = existing === undefined ? {} : normalizeDelayParams(existing)

  return normalizeDelayParams({ ...base, ...input })
}

export function serializeDelayParams(params: DelayParams): string {
  const normalized = normalizeDelayParams(params)

  return Object.values(normalized).map((value) => (isJsonBoolean(value) ? (value ? 1 : 0) : value)).join('|')
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

export const COMPRESSOR_LOOKAHEAD_STEPS_MS = [0, 1, 10] as const

export type CompressorLookaheadMs = (typeof COMPRESSOR_LOOKAHEAD_STEPS_MS)[number]

// The nearest step; a value between two steps goes to the longer one.
export const snapCompressorLookaheadMs = (lookaheadMs: number): CompressorLookaheadMs => (
  COMPRESSOR_LOOKAHEAD_STEPS_MS.reduce((best, step) => Math.abs(step - lookaheadMs) <= Math.abs(best - lookaheadMs) ? step : best)
)

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
  lookaheadMs: CompressorLookaheadMs
  // Makes up the gain the curve takes at 0 dB in, so the level stays put as Threshold and Ratio move. Off while a key
  // from another track drives the detector, as in Ableton's Compressor.
  autoMakeup: boolean
  detectorMode: CompressorDetectorMode
  dynamicsMode: CompressorDynamicsMode
  envelopeCurve: CompressorEnvelopeCurve
  sidechain: CompressorSidechainParams
}

export type CompressorParamsLite = CompressorParams

export type CompressorSidechainParamsInput = Partial<Omit<CompressorSidechainParams, 'filterType'>> & { filterType?: JsonValue }

export type CompressorParamsInput = Partial<Omit<CompressorParams, 'lookaheadMs' | 'detectorMode' | 'dynamicsMode' | 'envelopeCurve' | 'sidechain'>> & {
  lookaheadMs?: number
  detectorMode?: JsonValue
  dynamicsMode?: JsonValue
  envelopeCurve?: JsonValue
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

// Neither Live's manual nor Cycling '74's abl.device.compressor~ reference documents a separate ratio range for Expand
// mode, so the ratio keeps its 1 to 100 range and the gain that upward expansion adds stops at this limit. The
// kernel and the worklet carry the same number.
export const COMPRESSOR_EXPAND_MAX_GAIN_DB = 24
export const COMPRESSOR_DRY_WET_MIN = 0
export const COMPRESSOR_DRY_WET_MAX = 1
export const COMPRESSOR_KNEE_DB_MIN = 0
export const COMPRESSOR_KNEE_DB_MAX = 24
const COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MIN = 20
const COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MAX = 20000
const COMPRESSOR_SIDECHAIN_Q_MIN = 0.1
const COMPRESSOR_SIDECHAIN_Q_MAX = 18

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
  autoMakeup: false,
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

export function isCompressorDetectorMode(value: JsonValue | undefined): value is CompressorDetectorMode {
  return value === 'peak' || value === 'rms'
}

export function isCompressorDynamicsMode(value: JsonValue | undefined): value is CompressorDynamicsMode {
  return value === 'compress' || value === 'expand'
}

export function isCompressorEnvelopeCurve(value: JsonValue | undefined): value is CompressorEnvelopeCurve {
  return value === 'log' || value === 'linear'
}

export function isCompressorSidechainFilterType(value: JsonValue | undefined): value is CompressorSidechainFilterType {
  return value === 'lowpass' || value === 'highpass' || value === 'bandpass'
}

function normalizeCompressorSidechainParams(input: CompressorSidechainParamsInput | undefined): CompressorSidechainParams {
  const defaults = DEFAULT_COMPRESSOR_SIDECHAIN_PARAMS
  const frequencyHz = readFiniteNumber(input?.frequencyHz)
  const q = readFiniteNumber(input?.q)

  return {
    enabled: isJsonBoolean(input?.enabled) ? input.enabled : defaults.enabled,
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
    enabled: isJsonBoolean(input.enabled) ? input.enabled : defaults.enabled,
    thresholdDb: thresholdDb === undefined ? defaults.thresholdDb : clamp(thresholdDb, COMPRESSOR_THRESHOLD_DB_MIN, COMPRESSOR_THRESHOLD_DB_MAX),
    ratio: ratio === undefined ? defaults.ratio : clamp(ratio, COMPRESSOR_RATIO_MIN, COMPRESSOR_RATIO_MAX),
    attackMs: attackMs === undefined ? defaults.attackMs : clamp(attackMs, COMPRESSOR_ATTACK_MS_MIN, COMPRESSOR_ATTACK_MS_MAX),
    releaseMs: releaseMs === undefined ? defaults.releaseMs : clamp(releaseMs, COMPRESSOR_RELEASE_MS_MIN, COMPRESSOR_RELEASE_MS_MAX),
    autoRelease: isJsonBoolean(input.autoRelease) ? input.autoRelease : defaults.autoRelease,
    makeupDb: makeupDb === undefined ? defaults.makeupDb : clamp(makeupDb, COMPRESSOR_GAIN_DB_MIN, COMPRESSOR_GAIN_DB_MAX),
    outputDb: outputDb === undefined ? defaults.outputDb : clamp(outputDb, COMPRESSOR_GAIN_DB_MIN, COMPRESSOR_GAIN_DB_MAX),
    dryWet: dryWet === undefined ? defaults.dryWet : clamp(dryWet, COMPRESSOR_DRY_WET_MIN, COMPRESSOR_DRY_WET_MAX),
    kneeDb: kneeDb === undefined ? defaults.kneeDb : clamp(kneeDb, COMPRESSOR_KNEE_DB_MIN, COMPRESSOR_KNEE_DB_MAX),
    lookaheadMs: lookaheadMs === undefined ? defaults.lookaheadMs : snapCompressorLookaheadMs(lookaheadMs),
    autoMakeup: isJsonBoolean(input.autoMakeup) ? input.autoMakeup : defaults.autoMakeup,
    detectorMode: isCompressorDetectorMode(input.detectorMode) ? input.detectorMode : defaults.detectorMode,
    dynamicsMode: isCompressorDynamicsMode(input.dynamicsMode) ? input.dynamicsMode : defaults.dynamicsMode,
    envelopeCurve: isCompressorEnvelopeCurve(input.envelopeCurve) ? input.envelopeCurve : defaults.envelopeCurve,
    sidechain: normalizeCompressorSidechainParams(input.sidechain),
  }
}

export function normalizeCompressorParamsForUpdate(input: CompressorParamsInput, existing?: CompressorParamsInput): CompressorParams {
  const base = existing === undefined ? {} : normalizeCompressorParams(existing)

  return normalizeCompressorParams({ ...base, ...input, sidechain: { ...existing?.sidechain, ...input.sidechain } })
}

export function serializeCompressorParams(params: CompressorParams): string {
  const normalized = normalizeCompressorParams(params)
  const sidechain = normalized.sidechain

  return `${normalized.enabled ? 1 : 0}|${normalized.thresholdDb}|${normalized.ratio}|${normalized.attackMs}|${normalized.releaseMs}|${normalized.autoRelease ? 1 : 0}|${normalized.makeupDb}|${normalized.outputDb}|${normalized.dryWet}|${normalized.kneeDb}|${normalized.lookaheadMs}|${normalized.autoMakeup ? 1 : 0}|${normalized.detectorMode}|${normalized.dynamicsMode}|${normalized.envelopeCurve}|${sidechain.enabled ? 1 : 0}|${sidechain.filterType}|${sidechain.frequencyHz}|${sidechain.q}`
}

export function computeCompressorStaticCurveDb(inputDb: number, params: CompressorParamsInput = {}): number {
  const normalized = normalizeCompressorParams(params)
  const threshold = normalized.thresholdDb
  const knee = normalized.kneeDb
  const expand = normalized.dynamicsMode === 'expand'
  // Compress and Expand share the curve's shape, a quadratic knee that meets the line above the threshold in value and
  // slope; only the slope differs. Expand is upward expansion: above the threshold every dB in adds (ratio - 1) dB.
  const slope = expand ? normalized.ratio - 1 : 1 / normalized.ratio - 1
  const lower = threshold - knee / 2
  let gain = 0

  if (knee <= 0) {
    if (inputDb > threshold) gain = (inputDb - threshold) * slope
  } else if (inputDb >= threshold + knee / 2) {
    gain = (inputDb - threshold) * slope
  } else if (inputDb > lower) {
    gain = (slope * (inputDb - lower) ** 2) / (2 * knee)
  }

  return inputDb + (expand ? Math.min(gain, COMPRESSOR_EXPAND_MAX_GAIN_DB) : gain)
}

export type ProcessorStateEnvelope<TState> = { version: 1; state: TState }

export type UtilityInputMode = 'stereo' | 'mono-sum'

export type UtilityMatrix = 'stereo' | 'mid-side-encode' | 'mid-side-decode'

// Left and Right play that channel on both outputs and disable the width controls; Swap exchanges the channels.
export type UtilityChannelMode = 'both' | 'left' | 'right' | 'swap'

// Stereo scales the side signal by Width; Mid/Side scales mid or side by midSide (-1 mono, 0 as played, 1 side only).
export type UtilityWidthMode = 'stereo' | 'mid-side'

// A gain at or below the minimum is minus infinity: silence.
export const UTILITY_GAIN_DB_MIN = -70
export const UTILITY_GAIN_DB_MAX = 35
export const UTILITY_BASS_MONO_HZ_MIN = 50
export const UTILITY_BASS_MONO_HZ_MAX = 500

export type UtilityParams = {
  enabled: boolean
  gainDb: number
  phaseLeft: boolean
  phaseRight: boolean
  inputMode: UtilityInputMode
  balance: number
  width: number
  matrix: UtilityMatrix
  channelMode: UtilityChannelMode
  dcBlock: boolean
  mute: boolean
  widthMode: UtilityWidthMode
  midSide: number
  bassMono: boolean
  bassMonoHz: number
  bassMonoAudition: boolean
}

export type UtilityParamsInput = Partial<Omit<UtilityParams, 'inputMode' | 'matrix' | 'channelMode' | 'widthMode'>> & {
  inputMode?: JsonValue
  matrix?: JsonValue
  channelMode?: JsonValue
  widthMode?: JsonValue
}

export type UtilityParamsEnvelope = ProcessorStateEnvelope<UtilityParams>

const readObject = (value: JsonValue): JsonObject => isJsonObject(value) ? value : {}

export function createDefaultUtilityParams(): UtilityParams {
  return {
    enabled: true, gainDb: 0, phaseLeft: false, phaseRight: false, inputMode: 'stereo', balance: 0, width: 1, matrix: 'stereo',
    channelMode: 'both', dcBlock: false, mute: false, widthMode: 'stereo', midSide: 0, bassMono: false, bassMonoHz: 120, bassMonoAudition: false,
  }
}

export function normalizeUtilityParams(input: UtilityParamsInput = {}): UtilityParams {
  const defaults = createDefaultUtilityParams()
  const gainDb = readFiniteNumber(input.gainDb)
  const balance = readFiniteNumber(input.balance)
  const width = readFiniteNumber(input.width)
  const midSide = readFiniteNumber(input.midSide)
  const bassMonoHz = readFiniteNumber(input.bassMonoHz)

  return {
    enabled: isJsonBoolean(input.enabled) ? input.enabled : defaults.enabled,
    gainDb: gainDb === undefined ? defaults.gainDb : clamp(gainDb, UTILITY_GAIN_DB_MIN, UTILITY_GAIN_DB_MAX),
    phaseLeft: isJsonBoolean(input.phaseLeft) ? input.phaseLeft : defaults.phaseLeft,
    phaseRight: isJsonBoolean(input.phaseRight) ? input.phaseRight : defaults.phaseRight,
    inputMode: input.inputMode === 'mono-sum' ? 'mono-sum' : 'stereo',
    balance: balance === undefined ? defaults.balance : clamp(balance, -1, 1),
    width: width === undefined ? defaults.width : clamp(width, 0, 2),
    matrix: input.matrix === 'mid-side-encode' || input.matrix === 'mid-side-decode' ? input.matrix : 'stereo',
    channelMode: input.channelMode === 'left' || input.channelMode === 'right' || input.channelMode === 'swap' ? input.channelMode : 'both',
    dcBlock: isJsonBoolean(input.dcBlock) ? input.dcBlock : defaults.dcBlock,
    mute: isJsonBoolean(input.mute) ? input.mute : defaults.mute,
    widthMode: input.widthMode === 'mid-side' ? 'mid-side' : 'stereo',
    midSide: midSide === undefined ? defaults.midSide : clamp(midSide, -1, 1),
    bassMono: isJsonBoolean(input.bassMono) ? input.bassMono : defaults.bassMono,
    bassMonoHz: bassMonoHz === undefined ? defaults.bassMonoHz : clamp(bassMonoHz, UTILITY_BASS_MONO_HZ_MIN, UTILITY_BASS_MONO_HZ_MAX),
    bassMonoAudition: isJsonBoolean(input.bassMonoAudition) ? input.bassMonoAudition : defaults.bassMonoAudition,
  }
}

const serializeUtilityParams = (params: UtilityParams) => JSON.stringify({ version: 1, state: normalizeUtilityParams(params) })

const readBoolean = (value: JsonValue) => value === true || value === false ? value : undefined

export const normalizeUtilityParamsEnvelope = (value: JsonValue): UtilityParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)

  return {
    version: 1,
    state: normalizeUtilityParams({
      enabled: readBoolean(state.enabled),
      gainDb: isJsonNumber(state.gainDb) ? state.gainDb : undefined,
      phaseLeft: readBoolean(state.phaseLeft),
      phaseRight: readBoolean(state.phaseRight),
      inputMode: state.inputMode,
      balance: isJsonNumber(state.balance) ? state.balance : undefined,
      width: isJsonNumber(state.width) ? state.width : undefined,
      matrix: state.matrix,
      channelMode: state.channelMode,
      dcBlock: readBoolean(state.dcBlock),
      mute: readBoolean(state.mute),
      widthMode: state.widthMode,
      midSide: isJsonNumber(state.midSide) ? state.midSide : undefined,
      bassMono: readBoolean(state.bassMono),
      bassMonoHz: isJsonNumber(state.bassMonoHz) ? state.bassMonoHz : undefined,
      bassMonoAudition: readBoolean(state.bassMonoAudition),
    }),
  }
}

export type GateMode = 'gate' | 'expander'

export type GateDetector = 'peak' | 'rms'

export const GATE_LOOKAHEAD_STEPS_MS = [0, 1, 10] as const

export type GateLookaheadMs = (typeof GATE_LOOKAHEAD_STEPS_MS)[number]

// The nearest step; a value between two steps goes to the longer one.
export const snapGateLookaheadMs = (lookaheadMs: number): GateLookaheadMs => (
  GATE_LOOKAHEAD_STEPS_MS.reduce((best, step) => Math.abs(step - lookaheadMs) <= Math.abs(best - lookaheadMs) ? step : best)
)

export const GATE_SIDECHAIN_GAIN_DB_MIN = -70
export const GATE_SIDECHAIN_GAIN_DB_MAX = 24

export type GateSidechainParams = {
  enabled: boolean
  filterType: CompressorSidechainFilterType
  frequencyHz: number
  q: number
  // Scales the key from another track before it is blended with the gate's own input and filtered.
  gainDb: number
  // How much of the key is the other track's: 1 is the other track alone, 0 the gate's own input.
  mix: number
}

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
  lookaheadMs: GateLookaheadMs
  detector: GateDetector
  link: number
  // Passes what the gate would close on and closes on what it would pass.
  flip: boolean
  sidechain: GateSidechainParams
}

export type GateParamsInput = Partial<Omit<GateParams, 'mode' | 'detector' | 'lookaheadMs' | 'sidechain'>> & {
  mode?: JsonValue
  detector?: JsonValue
  lookaheadMs?: number
  sidechain?: Partial<Omit<GateSidechainParams, 'filterType'>> & { filterType?: JsonValue }
}

export type GateParamsEnvelope = ProcessorStateEnvelope<GateParams>

export function createDefaultGateParams(): GateParams {
  return { enabled: true, mode: 'gate', thresholdDb: -40, ratio: 4, attackMs: 1, holdMs: 20, releaseMs: 120, hysteresisDb: 6, rangeDb: -80, lookaheadMs: 0, detector: 'peak', link: 1, flip: false, sidechain: { enabled: false, filterType: 'highpass', frequencyHz: 80, q: 0.707, gainDb: 0, mix: 1 } }
}

export function normalizeGateParams(input: GateParamsInput = {}): GateParams {
  const defaults = createDefaultGateParams()

  const number = (value: JsonValue | undefined, fallback: number, min: number, max: number) => {
    const finite = readFiniteNumber(value)

    return finite === undefined ? fallback : clamp(finite, min, max)
  }

  return {
    enabled: isJsonBoolean(input.enabled) ? input.enabled : defaults.enabled,
    mode: input.mode === 'expander' ? 'expander' : 'gate',
    thresholdDb: number(input.thresholdDb, defaults.thresholdDb, -80, 0),
    ratio: number(input.ratio, defaults.ratio, 1, 20),
    attackMs: number(input.attackMs, defaults.attackMs, 0.1, 100),
    holdMs: number(input.holdMs, defaults.holdMs, 0, 500),
    releaseMs: number(input.releaseMs, defaults.releaseMs, 5, 2000),
    hysteresisDb: number(input.hysteresisDb, defaults.hysteresisDb, 0, 24),
    rangeDb: number(input.rangeDb, defaults.rangeDb, -80, 0),
    lookaheadMs: input.lookaheadMs === undefined || !Number.isFinite(input.lookaheadMs) ? defaults.lookaheadMs : snapGateLookaheadMs(input.lookaheadMs),
    detector: input.detector === 'rms' ? 'rms' : 'peak',
    link: number(input.link, defaults.link, 0, 1),
    flip: isJsonBoolean(input.flip) ? input.flip : defaults.flip,
    sidechain: {
      enabled: isJsonBoolean(input.sidechain?.enabled) ? input.sidechain.enabled : defaults.sidechain.enabled,
      filterType: isCompressorSidechainFilterType(input.sidechain?.filterType) ? input.sidechain.filterType : defaults.sidechain.filterType,
      frequencyHz: number(input.sidechain?.frequencyHz, defaults.sidechain.frequencyHz, 20, 20000),
      q: number(input.sidechain?.q, defaults.sidechain.q, 0.1, 18),
      gainDb: number(input.sidechain?.gainDb, defaults.sidechain.gainDb, GATE_SIDECHAIN_GAIN_DB_MIN, GATE_SIDECHAIN_GAIN_DB_MAX),
      mix: number(input.sidechain?.mix, defaults.sidechain.mix, 0, 1),
    },
  }
}

const serializeGateParams = (params: GateParams) => JSON.stringify({ version: 1, state: normalizeGateParams(params) })

export const normalizeGateParamsEnvelope = (value: JsonValue): GateParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)
  const sidechain = readObject(state.sidechain)

  return {
    version: 1,
    state: normalizeGateParams({
      enabled: state.enabled === true || state.enabled === false ? state.enabled : undefined,
      mode: state.mode,
      thresholdDb: isJsonNumber(state.thresholdDb) ? state.thresholdDb : undefined,
      ratio: isJsonNumber(state.ratio) ? state.ratio : undefined,
      attackMs: isJsonNumber(state.attackMs) ? state.attackMs : undefined,
      holdMs: isJsonNumber(state.holdMs) ? state.holdMs : undefined,
      releaseMs: isJsonNumber(state.releaseMs) ? state.releaseMs : undefined,
      hysteresisDb: isJsonNumber(state.hysteresisDb) ? state.hysteresisDb : undefined,
      rangeDb: isJsonNumber(state.rangeDb) ? state.rangeDb : undefined,
      lookaheadMs: isJsonNumber(state.lookaheadMs) ? state.lookaheadMs : undefined,
      detector: state.detector,
      link: isJsonNumber(state.link) ? state.link : undefined,
      flip: state.flip === true || state.flip === false ? state.flip : undefined,
      sidechain: {
        enabled: sidechain.enabled === true || sidechain.enabled === false ? sidechain.enabled : undefined,
        filterType: sidechain.filterType,
        frequencyHz: isJsonNumber(sidechain.frequencyHz) ? sidechain.frequencyHz : undefined,
        q: isJsonNumber(sidechain.q) ? sidechain.q : undefined,
        gainDb: isJsonNumber(sidechain.gainDb) ? sidechain.gainDb : undefined,
        mix: isJsonNumber(sidechain.mix) ? sidechain.mix : undefined,
      },
    }),
  }
}

export const LIMITER_LOOKAHEAD_STEPS_MS = [1.5, 3, 6] as const

export type LimiterLookaheadMs = (typeof LIMITER_LOOKAHEAD_STEPS_MS)[number]

// The nearest step; a value between two steps goes to the longer one.
export const snapLimiterLookaheadMs = (lookaheadMs: number): LimiterLookaheadMs => (
  LIMITER_LOOKAHEAD_STEPS_MS.reduce((best, step) => Math.abs(step - lookaheadMs) <= Math.abs(best - lookaheadMs) ? step : best)
)

export type LimiterParams = {
  enabled: boolean
  gainDb: number
  ceilingDbtp: number
  releaseMs: number
  autoRelease: boolean
  lookaheadMs: LimiterLookaheadMs
  link: number
}

export type LimiterParamsInput = Partial<Omit<LimiterParams, 'lookaheadMs'>> & { lookaheadMs?: number }

export type LimiterParamsEnvelope = ProcessorStateEnvelope<LimiterParams>

export function createDefaultLimiterParams(): LimiterParams {
  return { enabled: true, gainDb: 0, ceilingDbtp: -1, releaseMs: 100, autoRelease: false, lookaheadMs: 3, link: 1 }
}

export function normalizeLimiterParams(input: LimiterParamsInput = {}): LimiterParams {
  const defaults = createDefaultLimiterParams()
  const gainDb = readFiniteNumber(input.gainDb)
  const ceilingDbtp = readFiniteNumber(input.ceilingDbtp)
  const releaseMs = readFiniteNumber(input.releaseMs)
  const lookaheadMs = readFiniteNumber(input.lookaheadMs)
  const link = readFiniteNumber(input.link)

  return {
    enabled: isJsonBoolean(input.enabled) ? input.enabled : defaults.enabled,
    gainDb: gainDb === undefined ? defaults.gainDb : clamp(gainDb, -12, 24),
    ceilingDbtp: ceilingDbtp === undefined ? defaults.ceilingDbtp : clamp(ceilingDbtp, -12, 0),
    releaseMs: releaseMs === undefined ? defaults.releaseMs : clamp(releaseMs, 20, 1000),
    autoRelease: isJsonBoolean(input.autoRelease) ? input.autoRelease : defaults.autoRelease,
    lookaheadMs: lookaheadMs === undefined ? defaults.lookaheadMs : snapLimiterLookaheadMs(lookaheadMs),
    link: link === undefined ? defaults.link : clamp(link, 0, 1),
  }
}

const serializeLimiterParams = (params: LimiterParams) => JSON.stringify({ version: 1, state: normalizeLimiterParams(params) })

export const normalizeLimiterParamsEnvelope = (value: JsonValue): LimiterParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)

  return {
    version: 1,
    state: normalizeLimiterParams({
      enabled: state.enabled === true || state.enabled === false ? state.enabled : undefined,
      gainDb: isJsonNumber(state.gainDb) ? state.gainDb : undefined,
      ceilingDbtp: isJsonNumber(state.ceilingDbtp) ? state.ceilingDbtp : undefined,
      releaseMs: isJsonNumber(state.releaseMs) ? state.releaseMs : undefined,
      autoRelease: state.autoRelease === true || state.autoRelease === false ? state.autoRelease : undefined,
      lookaheadMs: isJsonNumber(state.lookaheadMs) ? state.lookaheadMs : undefined,
      link: isJsonNumber(state.link) ? state.link : undefined,
    }),
  }
}

export type AutoFilterMode = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peak'

export type AutoFilterSlope = 12 | 24

export type AutoFilterWaveform = 'sine' | 'triangle' | 'sawDown' | 'sawUp' | 'square' | 'sampleHold'

export type AutoFilterStereoMode = 'phase' | 'spin'

// The native core's resonance law: Q = MIN * (MAX / MIN) ^ resonance. Resonance 0 is Butterworth, 1 is the top Q.
export const AUTO_FILTER_MIN_Q = Math.SQRT1_2
export const AUTO_FILTER_MAX_Q = 8

// Latency of the Hi-Quality half-band pair at the project rate, in frames; the native kernel reports the same number.
export const AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES = 63

// The Saturator's Hi-Quality wet path trails the input by one 2x half-band pair for the curve and one for Post Clip; the dry path is held
// back by the same frames (SaturatorKernel::latency_frames).
const SATURATOR_HALF_BAND_LATENCY_FRAMES = 3

export const saturatorLatencyFrames = (hiQuality: boolean, postClip: SaturatorPostClip) =>
  hiQuality ? SATURATOR_HALF_BAND_LATENCY_FRAMES * (postClip === 'off' ? 1 : 2) : 0

// One LFO cycle per entry, in the order of the native tempo table (2 bars, 1 bar, then straight/dotted/triplet to 1/32).
export const AUTO_FILTER_LFO_DIVISIONS = ['2 bars', '1 bar', '1/2.', '1/2', '1/4.', '1/4', '1/4T', '1/8.', '1/8', '1/8T', '1/16.', '1/16', '1/16T', '1/32.', '1/32', '1/32T'] as const

const AUTO_FILTER_WAVEFORMS: readonly AutoFilterWaveform[] = ['sine', 'triangle', 'sawDown', 'sawUp', 'square', 'sampleHold']

export type AutoFilterParams = {
  enabled: boolean
  mode: AutoFilterMode
  slope: AutoFilterSlope
  hiQuality: boolean
  frequencyHz: number
  resonance: number
  driveDb: number
  mix: number
  outputDb: number
  clip: boolean
  envelope: { amountOctaves: number; attackMs: number; releaseMs: number; hold: boolean; link: boolean }
  lfo: {
    waveform: AutoFilterWaveform
    sync: boolean
    division: number
    rateHz: number
    depthOctaves: number
    phaseOffset: number
    stereoMode: AutoFilterStereoMode
    stereoPhase: number
  }
}

export type AutoFilterParamsInput = Partial<Omit<AutoFilterParams, 'mode' | 'slope' | 'envelope' | 'lfo'>> & {
  mode?: JsonValue
  slope?: JsonValue
  envelope?: Partial<AutoFilterParams['envelope']>
  lfo?: Partial<Omit<AutoFilterParams['lfo'], 'waveform' | 'stereoMode'>> & { waveform?: JsonValue; stereoMode?: JsonValue }
}

export type AutoFilterParamsEnvelope = ProcessorStateEnvelope<AutoFilterParams>

export function createDefaultAutoFilterParams(): AutoFilterParams {
  return {
    enabled: true,
    mode: 'lowpass',
    slope: 12,
    hiQuality: true,
    frequencyHz: 1000,
    resonance: 0.15,
    driveDb: 0,
    mix: 1,
    outputDb: 0,
    clip: false,
    envelope: { amountOctaves: 0, attackMs: 10, releaseMs: 100, hold: false, link: false },
    lfo: { waveform: 'sine', sync: false, division: 5, rateHz: 1, depthOctaves: 0, phaseOffset: 0, stereoMode: 'phase', stereoPhase: 0 },
  }
}

export function normalizeAutoFilterParams(input: AutoFilterParamsInput = {}): AutoFilterParams {
  const defaults = createDefaultAutoFilterParams()

  const number = (value: JsonValue | undefined, fallback: number, min: number, max: number) => {
    const finite = readFiniteNumber(value)

    return finite === undefined ? fallback : clamp(finite, min, max)
  }

  const flag = (value: boolean | undefined, fallback: boolean) => isJsonBoolean(value) ? value : fallback

  const mode = input.mode
  const waveform = AUTO_FILTER_WAVEFORMS.find((candidate) => candidate === input.lfo?.waveform)

  return {
    enabled: flag(input.enabled, defaults.enabled),
    mode: mode === 'highpass' || mode === 'bandpass' || mode === 'notch' || mode === 'peak' ? mode : 'lowpass',
    slope: input.slope === 24 ? 24 : 12,
    hiQuality: flag(input.hiQuality, defaults.hiQuality),
    frequencyHz: number(input.frequencyHz, defaults.frequencyHz, 20, 20000),
    resonance: number(input.resonance, defaults.resonance, 0, 1),
    driveDb: number(input.driveDb, defaults.driveDb, 0, 24),
    mix: number(input.mix, defaults.mix, 0, 1),
    outputDb: number(input.outputDb, defaults.outputDb, -24, 24),
    clip: flag(input.clip, defaults.clip),
    envelope: {
      amountOctaves: number(input.envelope?.amountOctaves, defaults.envelope.amountOctaves, -6, 6),
      attackMs: number(input.envelope?.attackMs, defaults.envelope.attackMs, 0.5, 500),
      releaseMs: number(input.envelope?.releaseMs, defaults.envelope.releaseMs, 5, 2000),
      hold: flag(input.envelope?.hold, defaults.envelope.hold),
      link: flag(input.envelope?.link, defaults.envelope.link),
    },
    lfo: {
      waveform: waveform ?? defaults.lfo.waveform,
      sync: flag(input.lfo?.sync, defaults.lfo.sync),
      division: Math.round(number(input.lfo?.division, defaults.lfo.division, 0, AUTO_FILTER_LFO_DIVISIONS.length - 1)),
      rateHz: number(input.lfo?.rateHz, defaults.lfo.rateHz, 0.01, 20),
      depthOctaves: number(input.lfo?.depthOctaves, defaults.lfo.depthOctaves, 0, 6),
      phaseOffset: number(input.lfo?.phaseOffset, defaults.lfo.phaseOffset, 0, 1),
      stereoMode: input.lfo?.stereoMode === 'spin' ? 'spin' : 'phase',
      stereoPhase: number(input.lfo?.stereoPhase, defaults.lfo.stereoPhase, -0.5, 0.5),
    },
  }
}

const serializeAutoFilterParams = (params: AutoFilterParams) => JSON.stringify({ version: 1, state: normalizeAutoFilterParams(params) })

export const normalizeAutoFilterParamsEnvelope = (value: JsonValue): AutoFilterParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)
  const env = readObject(state.envelope)
  const lfo = readObject(state.lfo)
  const bool = (candidate: JsonValue | undefined) => candidate === true || candidate === false ? candidate : undefined
  const num = (candidate: JsonValue | undefined) => isJsonNumber(candidate) ? candidate : undefined

  return {
    version: 1,
    state: normalizeAutoFilterParams({
      enabled: bool(state.enabled),
      mode: state.mode,
      slope: state.slope,
      hiQuality: bool(state.hiQuality),
      frequencyHz: num(state.frequencyHz),
      resonance: num(state.resonance),
      driveDb: num(state.driveDb),
      mix: num(state.mix),
      outputDb: num(state.outputDb),
      clip: bool(state.clip),
      envelope: {
        amountOctaves: num(env.amountOctaves),
        attackMs: num(env.attackMs),
        releaseMs: num(env.releaseMs),
        hold: bool(env.hold),
        link: bool(env.link),
      },
      lfo: {
        waveform: lfo.waveform,
        sync: bool(lfo.sync),
        division: num(lfo.division),
        rateHz: num(lfo.rateHz),
        depthOctaves: num(lfo.depthOctaves),
        phaseOffset: num(lfo.phaseOffset),
        stereoMode: lfo.stereoMode,
        stereoPhase: num(lfo.stereoPhase),
      },
    }),
  }
}

export const MODULATION_WAVEFORMS = ['sine', 'triangle', 'sawDown', 'sawUp', 'square', 'sampleHold', 'wander'] as const

export type ModulationWaveform = (typeof MODULATION_WAVEFORMS)[number]

export type PhaserStages = 4 | 6 | 8 | 12

export const CHORUS_MODES = ['chorus', 'vibrato', 'vintage'] as const

export const FLANGER_MODES = ['flanger', 'throughZero'] as const

export type ChorusMode = (typeof CHORUS_MODES)[number]

export type FlangerMode = (typeof FLANGER_MODES)[number]

type DelayModulationParams<Mode extends string> = {
  enabled: boolean
  mode: Mode
  waveform: ModulationWaveform
  safeBass: boolean
  delayMs: number
  depthMs: number
  rateHz: number
  feedback: number
  stereoPhase: number
  mix: number
  safeBassHz: number
  width: number
  outputDb: number
}

export type ChorusParams = DelayModulationParams<ChorusMode>

export type FlangerParams = DelayModulationParams<FlangerMode>

export type PhaserParams = {
  enabled: boolean
  stages: PhaserStages
  waveform: ModulationWaveform
  safeBass: boolean
  centerHz: number
  depthOctaves: number
  rateHz: number
  feedback: number
  stereoPhase: number
  mix: number
  spreadOctaves: number
  blend: number
  safeBassHz: number
  outputDb: number
}

export type TremoloParams = {
  enabled: boolean
  waveform: ModulationWaveform
  sync: boolean
  division: number
  invert: boolean
  rateHz: number
  depth: number
  'shape': number
  phase: number
  stereoPhase: number
}

export type AutoPanParams = TremoloParams

export type EnsembleParams = {
  enabled: boolean
  voices: 3
  waveform: ModulationWaveform
  safeBass: boolean
  delayMs: number
  depthMs: number
  rateHz: number
  spread: number
  mix: number
  fastDepthMs: number
  fastRateHz: number
  safeBassHz: number
  width: number
  outputDb: number
}

export type ChorusParamsEnvelope = ProcessorStateEnvelope<ChorusParams>

export type FlangerParamsEnvelope = ProcessorStateEnvelope<FlangerParams>

export type PhaserParamsEnvelope = ProcessorStateEnvelope<PhaserParams>

export type TremoloParamsEnvelope = ProcessorStateEnvelope<TremoloParams>

export type AutoPanParamsEnvelope = ProcessorStateEnvelope<AutoPanParams>

export type EnsembleParamsEnvelope = ProcessorStateEnvelope<EnsembleParams>

const normalizeNumber = (value: JsonValue, fallback: number, min: number, max: number) => isJsonNumber(value) && Number.isFinite(value) ? clamp(value, min, max) : fallback

const normalizeModulationEnvelope = <T>(value: JsonValue, normalize: (state: JsonObject) => T): ProcessorStateEnvelope<T> => {
  const envelope = readObject(value)

  return { version: 1, state: normalize(readObject(envelope.version === 1 ? envelope.state : value)) }
}

const normalizeWaveform = (value: JsonValue, fallback: ModulationWaveform): ModulationWaveform => MODULATION_WAVEFORMS.find((waveform) => waveform === value) ?? fallback

const normalizeChoice = <const Choices extends readonly string[]>(choices: Choices, value: JsonValue, fallback: Choices[number]): Choices[number] => choices.find((choice) => choice === value) ?? fallback

export const createDefaultChorusParams = (): ChorusParams => ({ enabled: true, mode: 'chorus', waveform: 'sine', safeBass: false, delayMs: 12, depthMs: 4, rateHz: 0.8, feedback: 0, stereoPhase: 0.25, mix: 0.35, safeBassHz: 100, width: 1, outputDb: 0 })
export const createDefaultFlangerParams = (): FlangerParams => ({ enabled: true, mode: 'flanger', waveform: 'sine', safeBass: false, delayMs: 1.5, depthMs: 1, rateHz: 0.2, feedback: 0.35, stereoPhase: 0.5, mix: 0.5, safeBassHz: 100, width: 1, outputDb: 0 })
export const createDefaultPhaserParams = (): PhaserParams => ({ enabled: true, stages: 6, waveform: 'sine', safeBass: false, centerHz: 1000, depthOctaves: 3, rateHz: 0.3, feedback: 0.3, stereoPhase: 0.5, mix: 0.5, spreadOctaves: 0, blend: 0, safeBassHz: 100, outputDb: 0 })
export const createDefaultTremoloParams = (): TremoloParams => ({ enabled: true, waveform: 'sine', sync: false, division: 5, invert: false, rateHz: 4, depth: 0.5, 'shape': 0.5, phase: 0, stereoPhase: 0 })
export const createDefaultAutoPanParams = (): AutoPanParams => ({ enabled: true, waveform: 'sine', sync: false, division: 5, invert: false, rateHz: 1, depth: 1, 'shape': 0.5, phase: 0, stereoPhase: 0.5 })
export const createDefaultEnsembleParams = (): EnsembleParams => ({ enabled: true, voices: 3, waveform: 'sine', safeBass: false, delayMs: 18, depthMs: 6, rateHz: 0.6, spread: 1, mix: 0.5, fastDepthMs: 0, fastRateHz: 6, safeBassHz: 100, width: 1, outputDb: 0 })

export const normalizeChorusParamsEnvelope = (value: JsonValue): ChorusParamsEnvelope => normalizeModulationEnvelope(value, (state) => {
  const defaults = createDefaultChorusParams()

  return { enabled: isJsonBoolean(state.enabled) ? state.enabled : true, mode: normalizeChoice(CHORUS_MODES, state.mode, defaults.mode), waveform: normalizeWaveform(state.waveform, defaults.waveform), safeBass: isJsonBoolean(state.safeBass) ? state.safeBass : defaults.safeBass, delayMs: normalizeNumber(state.delayMs, defaults.delayMs, 5, 30), depthMs: normalizeNumber(state.depthMs, defaults.depthMs, 0, 10), rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.01, 20), feedback: normalizeNumber(state.feedback, defaults.feedback, 0, 0.5), stereoPhase: normalizeNumber(state.stereoPhase, defaults.stereoPhase, -0.5, 0.5), mix: normalizeNumber(state.mix, defaults.mix, 0, 1), safeBassHz: normalizeNumber(state.safeBassHz, defaults.safeBassHz, 20, 1000), width: normalizeNumber(state.width, defaults.width, 0, 2), outputDb: normalizeNumber(state.outputDb, defaults.outputDb, -24, 12) }
})

export const normalizeFlangerParamsEnvelope = (value: JsonValue): FlangerParamsEnvelope => normalizeModulationEnvelope(value, (state) => {
  const defaults = createDefaultFlangerParams()

  return { enabled: isJsonBoolean(state.enabled) ? state.enabled : true, mode: normalizeChoice(FLANGER_MODES, state.mode, defaults.mode), waveform: normalizeWaveform(state.waveform, defaults.waveform), safeBass: isJsonBoolean(state.safeBass) ? state.safeBass : defaults.safeBass, delayMs: normalizeNumber(state.delayMs, defaults.delayMs, 0.1, 10), depthMs: normalizeNumber(state.depthMs, defaults.depthMs, 0, 5), rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.01, 20), feedback: normalizeNumber(state.feedback, defaults.feedback, -0.95, 0.95), stereoPhase: normalizeNumber(state.stereoPhase, defaults.stereoPhase, -0.5, 0.5), mix: normalizeNumber(state.mix, defaults.mix, 0, 1), safeBassHz: normalizeNumber(state.safeBassHz, defaults.safeBassHz, 20, 1000), width: normalizeNumber(state.width, defaults.width, 0, 2), outputDb: normalizeNumber(state.outputDb, defaults.outputDb, -24, 12) }
})

export const normalizePhaserParamsEnvelope = (value: JsonValue): PhaserParamsEnvelope => normalizeModulationEnvelope(value, (state) => {
  const defaults = createDefaultPhaserParams()

  return { enabled: isJsonBoolean(state.enabled) ? state.enabled : true, stages: state.stages === 4 || state.stages === 6 || state.stages === 8 || state.stages === 12 ? state.stages : defaults.stages, waveform: normalizeWaveform(state.waveform, defaults.waveform), safeBass: isJsonBoolean(state.safeBass) ? state.safeBass : defaults.safeBass, centerHz: normalizeNumber(state.centerHz, defaults.centerHz, 100, 8000), depthOctaves: normalizeNumber(state.depthOctaves, defaults.depthOctaves, 0, 5), rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.01, 20), feedback: normalizeNumber(state.feedback, defaults.feedback, -0.95, 0.95), stereoPhase: normalizeNumber(state.stereoPhase, defaults.stereoPhase, -0.5, 0.5), mix: normalizeNumber(state.mix, defaults.mix, 0, 1), spreadOctaves: normalizeNumber(state.spreadOctaves, defaults.spreadOctaves, 0, 4), blend: normalizeNumber(state.blend, defaults.blend, 0, 1), safeBassHz: normalizeNumber(state.safeBassHz, defaults.safeBassHz, 20, 1000), outputDb: normalizeNumber(state.outputDb, defaults.outputDb, -24, 12) }
})

const normalizeAmplitudeModulation = (value: JsonValue, defaults: TremoloParams): TremoloParamsEnvelope => normalizeModulationEnvelope(value, (state) => ({ enabled: isJsonBoolean(state.enabled) ? state.enabled : true, waveform: normalizeWaveform(state.waveform, defaults.waveform), sync: isJsonBoolean(state.sync) ? state.sync : defaults.sync, division: Math.round(normalizeNumber(state.division, defaults.division, 0, AUTO_FILTER_LFO_DIVISIONS.length - 1)), invert: isJsonBoolean(state.invert) ? state.invert : defaults.invert, rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.01, 20), depth: normalizeNumber(state.depth, defaults.depth, 0, 1), 'shape': normalizeNumber(state['shape'], defaults['shape'], 0, 1), phase: normalizeNumber(state.phase, defaults.phase, 0, 1), stereoPhase: normalizeNumber(state.stereoPhase, defaults.stereoPhase, -0.5, 0.5) }))
export const normalizeTremoloParamsEnvelope = (value: JsonValue): TremoloParamsEnvelope => normalizeAmplitudeModulation(value, createDefaultTremoloParams())
export const normalizeAutoPanParamsEnvelope = (value: JsonValue): AutoPanParamsEnvelope => normalizeAmplitudeModulation(value, createDefaultAutoPanParams())

export const normalizeEnsembleParamsEnvelope = (value: JsonValue): EnsembleParamsEnvelope => normalizeModulationEnvelope(value, (state) => {
  const defaults = createDefaultEnsembleParams()

  return { enabled: isJsonBoolean(state.enabled) ? state.enabled : true, voices: 3, waveform: normalizeWaveform(state.waveform, defaults.waveform), safeBass: isJsonBoolean(state.safeBass) ? state.safeBass : defaults.safeBass, delayMs: normalizeNumber(state.delayMs, defaults.delayMs, 10, 30), depthMs: normalizeNumber(state.depthMs, defaults.depthMs, 1, 12), rateHz: normalizeNumber(state.rateHz, defaults.rateHz, 0.05, 5), spread: normalizeNumber(state.spread, defaults.spread, 0, 1), mix: normalizeNumber(state.mix, defaults.mix, 0, 1), fastDepthMs: normalizeNumber(state.fastDepthMs, defaults.fastDepthMs, 0, 4), fastRateHz: normalizeNumber(state.fastRateHz, defaults.fastRateHz, 0.5, 12), safeBassHz: normalizeNumber(state.safeBassHz, defaults.safeBassHz, 20, 1000), width: normalizeNumber(state.width, defaults.width, 0, 2), outputDb: normalizeNumber(state.outputDb, defaults.outputDb, -24, 12) }
})

export type LoFiQuantization = 'round' | 'floor' | 'truncate'

export type LoFiDither = 'off' | 'rectangular' | 'triangular'

// The rate is in Hz so a setting sounds the same at every host rate; the top of the range is the highest host rate the engine runs,
// where nothing is dropped. preFilter band-limits the input to the reduced rate before it is held, postFilter smooths the held steps,
// and dcCorrection centres the Floor quantizer (its error averages minus half an LSB).
export const LOFI_SAMPLE_RATE_HZ_MIN = 100
export const LOFI_SAMPLE_RATE_HZ_MAX = 96000

export type LoFiParams = {
  enabled: boolean
  bitDepth: number
  sampleRateHz: number
  jitter: number
  noiseDb: number
  quantization: LoFiQuantization
  dither: LoFiDither
  mix: number
  seed: number
  preFilter: boolean
  postFilter: boolean
  dcCorrection: boolean
}

export type LoFiParamsEnvelope = ProcessorStateEnvelope<LoFiParams>

// A new Lo-Fi is transparent (16 bit with triangular dither, no added noise): the user dials the damage in. Stored instances keep their values.
export const createDefaultLoFiParams = (): LoFiParams => ({
  enabled: true,
  bitDepth: 16,
  sampleRateHz: LOFI_SAMPLE_RATE_HZ_MAX,
  jitter: 0,
  noiseDb: -120,
  quantization: 'round',
  dither: 'triangular',
  mix: 1,
  seed: 1,
  preFilter: false,
  postFilter: false,
  dcCorrection: false,
})

export const normalizeLoFiParamsEnvelope = (value: JsonValue): LoFiParamsEnvelope => {
  const envelope = readObject(value)
  const state = readObject(envelope.version === 1 ? envelope.state : value)
  const defaults = createDefaultLoFiParams()
  const seed = normalizeNumber(state.seed, defaults.seed, 1, 0xffffffff)

  return {
    version: 1,
    state: {
      enabled: isJsonBoolean(state.enabled) ? state.enabled : defaults.enabled,
      bitDepth: Math.round(normalizeNumber(state.bitDepth, defaults.bitDepth, 2, 24)),
      sampleRateHz: normalizeNumber(state.sampleRateHz, defaults.sampleRateHz, LOFI_SAMPLE_RATE_HZ_MIN, LOFI_SAMPLE_RATE_HZ_MAX),
      jitter: normalizeNumber(state.jitter, defaults.jitter, 0, 1),
      noiseDb: normalizeNumber(state.noiseDb, defaults.noiseDb, -120, -24),
      quantization: state.quantization === 'floor' || state.quantization === 'truncate' ? state.quantization : 'round',
      dither: state.dither === 'off' || state.dither === 'rectangular' || state.dither === 'triangular' ? state.dither : defaults.dither,
      mix: normalizeNumber(state.mix, defaults.mix, 0, 1),
      seed: Math.max(1, Math.round(seed)) >>> 0,
      preFilter: isJsonBoolean(state.preFilter) ? state.preFilter : defaults.preFilter,
      postFilter: isJsonBoolean(state.postFilter) ? state.postFilter : defaults.postFilter,
      dcCorrection: isJsonBoolean(state.dcCorrection) ? state.dcCorrection : defaults.dcCorrection,
    },
  }
}

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
  normalizeParams: (params: JsonValue) => SpectralParamsEnvelope
  serializeParams: (params: SpectralParamsEnvelope) => string
}

type UtilityAudioEffectContract = {
  kind: 'utility'
  masterKind: 'master-utility'
  createDefaultParams: () => UtilityParamsEnvelope
  normalizeParams: (params: JsonValue) => UtilityParamsEnvelope
  serializeParams: (params: UtilityParamsEnvelope) => string
}

type AutoFilterAudioEffectContract = {
  kind: 'autofilter'
  masterKind: 'master-autofilter'
  createDefaultParams: () => AutoFilterParamsEnvelope
  normalizeParams: (params: JsonValue) => AutoFilterParamsEnvelope
  serializeParams: (params: AutoFilterParamsEnvelope) => string
}

type GateAudioEffectContract = {
  kind: 'gate'
  masterKind: 'master-gate'
  createDefaultParams: () => GateParamsEnvelope
  normalizeParams: (params: JsonValue) => GateParamsEnvelope
  serializeParams: (params: GateParamsEnvelope) => string
}

type LimiterAudioEffectContract = {
  kind: 'limiter'
  masterKind: 'master-limiter'
  createDefaultParams: () => LimiterParamsEnvelope
  normalizeParams: (params: JsonValue) => LimiterParamsEnvelope
  serializeParams: (params: LimiterParamsEnvelope) => string
}

type LoFiAudioEffectContract = {
  kind: 'lofi'
  masterKind: 'master-lofi'
  createDefaultParams: () => LoFiParamsEnvelope
  normalizeParams: (params: JsonValue) => LoFiParamsEnvelope
  serializeParams: (params: LoFiParamsEnvelope) => string
}

type ChorusAudioEffectContract = {
  kind: 'chorus'
  masterKind: 'master-chorus'
  createDefaultParams: () => ChorusParamsEnvelope
  normalizeParams: (params: JsonValue) => ChorusParamsEnvelope
  serializeParams: (params: ChorusParamsEnvelope) => string
}

type FlangerAudioEffectContract = {
  kind: 'flanger'
  masterKind: 'master-flanger'
  createDefaultParams: () => FlangerParamsEnvelope
  normalizeParams: (params: JsonValue) => FlangerParamsEnvelope
  serializeParams: (params: FlangerParamsEnvelope) => string
}

type PhaserAudioEffectContract = {
  kind: 'phaser'
  masterKind: 'master-phaser'
  createDefaultParams: () => PhaserParamsEnvelope
  normalizeParams: (params: JsonValue) => PhaserParamsEnvelope
  serializeParams: (params: PhaserParamsEnvelope) => string
}

type TremoloAudioEffectContract = {
  kind: 'tremolo'
  masterKind: 'master-tremolo'
  createDefaultParams: () => TremoloParamsEnvelope
  normalizeParams: (params: JsonValue) => TremoloParamsEnvelope
  serializeParams: (params: TremoloParamsEnvelope) => string
}

type AutoPanAudioEffectContract = {
  kind: 'autopan'
  masterKind: 'master-autopan'
  createDefaultParams: () => AutoPanParamsEnvelope
  normalizeParams: (params: JsonValue) => AutoPanParamsEnvelope
  serializeParams: (params: AutoPanParamsEnvelope) => string
}

type EnsembleAudioEffectContract = {
  kind: 'ensemble'
  masterKind: 'master-ensemble'
  createDefaultParams: () => EnsembleParamsEnvelope
  normalizeParams: (params: JsonValue) => EnsembleParamsEnvelope
  serializeParams: (params: EnsembleParamsEnvelope) => string
}

export type SpectrumView = 'spectrum' | 'spectrogram' | 'both'

export type SpectrumParams = { enabled: boolean; view: SpectrumView }

export type SpectrumParamsEnvelope = ProcessorStateEnvelope<SpectrumParams>

export const createDefaultSpectrumParams = (): SpectrumParams => ({ enabled: true, view: 'both' })

export const normalizeSpectrumParamsEnvelope = (value: JsonValue): SpectrumParamsEnvelope => normalizeModulationEnvelope(value, (state) => ({
  enabled: isJsonBoolean(state.enabled) ? state.enabled : true,
  view: state.view === 'spectrum' || state.view === 'spectrogram' ? state.view : 'both',
}))

export const mergeSpectrumParamsEnvelope = (update: JsonValue, existing?: JsonValue): SpectrumParamsEnvelope => normalizeSpectrumParamsEnvelope({
  version: 1,
  state: { ...normalizeSpectrumParamsEnvelope(existing ?? null).state, ...readObject(readObject(update).state) },
})

type SpectrumAudioEffectContract = {
  kind: 'spectrum'
  masterKind: 'master-spectrum'
  createDefaultParams: () => SpectrumParamsEnvelope
  normalizeParams: (params: JsonValue) => SpectrumParamsEnvelope
  serializeParams: (params: SpectrumParamsEnvelope) => string
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
  spectrum: SpectrumAudioEffectContract
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
  spectrum: { kind: 'spectrum', masterKind: 'master-spectrum', createDefaultParams: () => ({ version: 1, state: createDefaultSpectrumParams() }), normalizeParams: normalizeSpectrumParamsEnvelope, serializeParams: (params: SpectrumParamsEnvelope) => JSON.stringify(normalizeSpectrumParamsEnvelope(params)) },
} satisfies AudioEffectContractByKind

export const normalizeArpeggiatorParams = (params: {
  enabled: boolean
  pattern: 'up' | 'down' | 'updown' | 'random'
  rate: '1/4' | '1/8' | '1/16' | '1/32'
  octaves: number
  gate: number
  hold: boolean
}) => ({
  enabled: params.enabled,
  pattern: params.pattern,
  rate: params.rate,
  octaves: clamp(Math.round(params.octaves) || 1, 1, 4),
  gate: clamp(Math.round(params.gate * 100) / 100 || 0.8, 0.1, 1),
  hold: params.hold,
})

export function normalizeAudioEffectOrder(order: readonly JsonValue[], enabled: readonly AudioEffectKind[]): AudioEffectKind[] {
  const enabledSet = new Set(enabled)
  const seen = new Set<AudioEffectKind>()
  const normalized: AudioEffectKind[] = []

  for (const value of order) {
    if (!isAudioEffectKind(value) || !enabledSet.has(value) || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }

  for (const kind of AUDIO_EFFECT_KINDS) {
    if (!enabledSet.has(kind) || seen.has(kind)) continue
    seen.add(kind)
    normalized.push(kind)
  }

  return normalized
}

export function areAudioEffectOrdersEqual(left: readonly AudioEffectKind[] | undefined, right: readonly AudioEffectKind[]): boolean {
  return !!left && left.length === right.length && left.every((kind, index) => kind === right[index])
}

export function isAudioEffectInstance(value: JsonValue): value is AudioEffectInstance {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'id' in value
    && 'kind' in value
    && isJsonString(value.id)
    && isAudioEffectKind(value.kind)
  )
}

export function audioEffectOrderItemKind(item: AudioEffectOrderItem): AudioEffectKind {
  return isJsonString(item) ? item : item.kind
}

export function audioEffectOrderItemId(item: AudioEffectOrderItem): string {
  return isJsonString(item) ? item : item.id
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
    const entry = isJsonString(item)
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

// Bands whose gain is a control: bell and shelves. Cuts, notch, band-pass and all-pass have none, and Scale ignores them.
export function supportsGain(type: EqBandType): boolean {
  return type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
}

