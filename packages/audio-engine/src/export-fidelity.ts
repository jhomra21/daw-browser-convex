import { analyzeLoudness, type LoudnessAnalysis } from './loudness-analyzer'

export type WavEncodingSettings =
  | { codec: 'pcm-s16'; dither: 'none' | 'tpdf' }
  | { codec: 'pcm-s24'; dither: 'none' | 'tpdf' }
  | { codec: 'pcm-f32'; dither: 'none' }

export type ExportNormalization =
  | { mode: 'none' }
  | { mode: 'sample-peak'; targetDbfs: number }
  | {
      mode: 'loudness'
      targetLufs: number
      truePeakCeilingDbtp: number
      limiting: 'off' | 'true-peak'
    }

export type ExportTailPolicy =
  | { mode: 'none' }
  | { mode: 'fixed'; durationSec: number }
  | { mode: 'automatic'; thresholdDbfs: number; holdSec: number; maximumSec: number }

type MutableAudioBuffer = {
  numberOfChannels: number
  length: number
  sampleRate: number
  getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
}

export type ExportAnalysisReport = {
  integratedLufs: number | null
  momentaryMaxLufs: number | null
  shortTermMaxLufs: number | null
  loudnessRangeLu: number | null
  truePeakDbtp: number | null
  samplePeakDbfs: number | null
  gainDb: number
  limited: boolean
  ceilingConstrained: boolean
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
const linearFromDb = (value: number) => 10 ** (value / 20)
const dbFromLinear = (value: number) => value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY

export const normalizeWavEncodingSettings = (value: unknown): WavEncodingSettings => {
  if (!value || typeof value !== 'object') return { codec: 'pcm-s16', dither: 'none' }
  const codec = Reflect.get(value, 'codec')
  const dither = Reflect.get(value, 'dither')
  if (codec === 'pcm-f32') return { codec, dither: 'none' }
  if (codec === 'pcm-s24') return { codec, dither: dither === 'tpdf' ? 'tpdf' : 'none' }
  return { codec: 'pcm-s16', dither: dither === 'tpdf' ? 'tpdf' : 'none' }
}

export const normalizeExportNormalization = (value: unknown): ExportNormalization => {
  if (!value || typeof value !== 'object') return { mode: 'none' }
  const mode = Reflect.get(value, 'mode')
  if (mode === 'sample-peak') {
    const target = Reflect.get(value, 'targetDbfs')
    return { mode, targetDbfs: clamp(typeof target === 'number' ? target : 0, -120, 0) }
  }
  if (mode === 'loudness') {
    const target = Reflect.get(value, 'targetLufs')
    const ceiling = Reflect.get(value, 'truePeakCeilingDbtp')
    return {
      mode,
      targetLufs: clamp(typeof target === 'number' ? target : -14, -36, -5),
      truePeakCeilingDbtp: clamp(typeof ceiling === 'number' ? ceiling : -1, -12, 0),
      limiting: Reflect.get(value, 'limiting') === 'true-peak' ? 'true-peak' : 'off',
    }
  }
  return { mode: 'none' }
}

export const normalizeExportTailPolicy = (value: unknown): ExportTailPolicy => {
  if (!value || typeof value !== 'object') return { mode: 'none' }
  const mode = Reflect.get(value, 'mode')
  if (mode === 'fixed') {
    const duration = Reflect.get(value, 'durationSec')
    return { mode, durationSec: clamp(typeof duration === 'number' ? duration : 0, 0, 60) }
  }
  if (mode === 'automatic') {
    const threshold = Reflect.get(value, 'thresholdDbfs')
    const hold = Reflect.get(value, 'holdSec')
    const maximum = Reflect.get(value, 'maximumSec')
    return {
      mode,
      thresholdDbfs: clamp(typeof threshold === 'number' ? threshold : -60, -120, -20),
      holdSec: clamp(typeof hold === 'number' ? hold : 1, 0.1, 10),
      maximumSec: clamp(typeof maximum === 'number' ? maximum : 10, 0.1, 120),
    }
  }
  return { mode: 'none' }
}

export const getExportTailMaximumSec = (policy: ExportTailPolicy): number => (
  policy.mode === 'none' ? 0 : policy.mode === 'fixed' ? policy.durationSec : policy.maximumSec
)

export const findAutomaticTailEndFrame = (
  buffer: MutableAudioBuffer,
  sourceEndFrame: number,
  policy: Extract<ExportTailPolicy, { mode: 'automatic' }>,
  signal?: AbortSignal,
): number => {
  const threshold = linearFromDb(policy.thresholdDbfs)
  const holdFrames = Math.max(1, Math.ceil(policy.holdSec * buffer.sampleRate))
  let quietFrames = 0
  for (let frame = Math.max(0, sourceEndFrame); frame < buffer.length; frame += 1) {
    signal?.throwIfAborted()
    let peak = 0
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      peak = Math.max(peak, Math.abs(buffer.getChannelData(channel)[frame]))
    }
    quietFrames = peak <= threshold ? quietFrames + 1 : 0
    if (quietFrames >= holdFrames) return frame + 1
  }
  return buffer.length
}

const getSamplePeak = (buffer: MutableAudioBuffer) => {
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)
    for (let frame = 0; frame < samples.length; frame += 1) peak = Math.max(peak, Math.abs(samples[frame]))
  }
  return peak
}

const applyGain = (buffer: MutableAudioBuffer, gain: number, signal?: AbortSignal) => {
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)
    for (let frame = 0; frame < samples.length; frame += 1) {
      if ((frame & 16383) === 0) signal?.throwIfAborted()
      samples[frame] *= gain
    }
  }
}

const LIMITER_OVERSAMPLING = 8
const LIMITER_TAPS_PER_PHASE = 24
const LIMITER_LOOKAHEAD_SEC = 0.005
const LIMITER_RELEASE_SEC = 0.08

const limiterSinc = (value: number) => value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value)
const limiterCoefficients = Array.from({ length: LIMITER_OVERSAMPLING }, (_, phase) => {
  const coefficients = new Float64Array(LIMITER_TAPS_PER_PHASE)
  const center = LIMITER_TAPS_PER_PHASE / 2 - 1
  let sum = 0
  for (let tap = 0; tap < coefficients.length; tap += 1) {
    const distance = tap - center - phase / LIMITER_OVERSAMPLING
    const window = 0.42
      - 0.5 * Math.cos(2 * Math.PI * tap / (LIMITER_TAPS_PER_PHASE - 1))
      + 0.08 * Math.cos(4 * Math.PI * tap / (LIMITER_TAPS_PER_PHASE - 1))
    coefficients[tap] = limiterSinc(distance) * window
    sum += coefficients[tap]
  }
  for (let tap = 0; tap < coefficients.length; tap += 1) coefficients[tap] /= sum
  return coefficients
})

const predictLinkedTruePeak = (buffer: MutableAudioBuffer, frame: number) => {
  const center = LIMITER_TAPS_PER_PHASE / 2 - 1
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)
    for (const coefficients of limiterCoefficients) {
      let value = 0
      for (let tap = 0; tap < coefficients.length; tap += 1) {
        const sourceFrame = frame + tap - center
        if (sourceFrame >= 0 && sourceFrame < samples.length) value += samples[sourceFrame] * coefficients[tap]
      }
      peak = Math.max(peak, Math.abs(value))
    }
  }
  return peak
}

export const limitTruePeakInPlace = (buffer: MutableAudioBuffer, ceilingDbtp: number, signal?: AbortSignal) => {
  const ceiling = linearFromDb(ceilingDbtp) * 0.99
  const lookaheadFrames = Math.max(1, Math.ceil(buffer.sampleRate * LIMITER_LOOKAHEAD_SEC))
  const peakDequeFrames = new Int32Array(buffer.length)
  const peakDequeValues = new Float64Array(buffer.length)
  let dequeStart = 0
  let dequeEnd = 0
  let predictionFrame = 0
  const releaseCoefficient = Math.exp(-1 / (Math.max(1, buffer.sampleRate * LIMITER_RELEASE_SEC)))
  let envelope = 1
  let limited = false
  for (let frame = 0; frame < buffer.length; frame += 1) {
    if ((frame & 4095) === 0) signal?.throwIfAborted()
    const predictionEnd = Math.min(buffer.length, frame + lookaheadFrames + 1)
    while (predictionFrame < predictionEnd) {
      const predicted = predictLinkedTruePeak(buffer, predictionFrame)
      while (dequeEnd > dequeStart && peakDequeValues[dequeEnd - 1] <= predicted) dequeEnd -= 1
      peakDequeFrames[dequeEnd] = predictionFrame
      peakDequeValues[dequeEnd] = predicted
      dequeEnd += 1
      predictionFrame += 1
    }
    while (dequeEnd > dequeStart && peakDequeFrames[dequeStart] < frame) dequeStart += 1
    const predictedPeak = dequeEnd > dequeStart ? peakDequeValues[dequeStart] : 0
    const requiredGain = predictedPeak > ceiling ? ceiling / predictedPeak : 1
    envelope = requiredGain < envelope
      ? requiredGain
      : 1 - (1 - envelope) * releaseCoefficient
    if (envelope < 1) limited = true
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel)
      samples[frame] *= envelope
    }
  }
  return limited
}

const toReport = (analysis: LoudnessAnalysis, samplePeak: number, gainDb: number, limited: boolean, ceilingConstrained: boolean): ExportAnalysisReport => ({
  integratedLufs: analysis.integratedLufs,
  momentaryMaxLufs: analysis.momentaryMaxLufs,
  shortTermMaxLufs: analysis.shortTermMaxLufs,
  loudnessRangeLu: analysis.loudnessRangeLu,
  truePeakDbtp: analysis.truePeakDbtp,
  samplePeakDbfs: samplePeak === 0 ? null : dbFromLinear(samplePeak),
  gainDb,
  limited,
  ceilingConstrained,
})

export const applyExportNormalization = (
  buffer: MutableAudioBuffer,
  settings: ExportNormalization,
  signal?: AbortSignal,
): ExportAnalysisReport => {
  signal?.throwIfAborted()
  let gainDb = 0
  if (settings.mode === 'sample-peak') {
    const peak = getSamplePeak(buffer)
    if (peak > 0) gainDb = settings.targetDbfs - dbFromLinear(peak)
  }
  if (gainDb !== 0) applyGain(buffer, linearFromDb(gainDb), signal)
  let limited = false
  let after: LoudnessAnalysis
  if (settings.mode === 'loudness') {
    after = analyzeLoudness(buffer, signal)
    for (let pass = 0; pass < 4 && after.integratedLufs !== null; pass += 1) {
      const correctionDb = settings.targetLufs - after.integratedLufs
      if (Math.abs(correctionDb) <= 0.2) break
      applyGain(buffer, linearFromDb(correctionDb), signal)
      gainDb += correctionDb
      if (settings.limiting === 'true-peak') {
        limited = limitTruePeakInPlace(buffer, settings.truePeakCeilingDbtp, signal) || limited
      }
      after = analyzeLoudness(buffer, signal)
    }
  } else {
    after = analyzeLoudness(buffer, signal)
  }
  const ceilingConstrained = settings.mode === 'loudness'
    && after.integratedLufs !== null
    && Math.abs(after.integratedLufs - settings.targetLufs) > 0.2
    && settings.limiting === 'true-peak'
  if (settings.mode === 'loudness') {
    if (after.integratedLufs === null) {
      throw new Error(`Loudness normalization achieved no measurable LUFS, outside the 0.20 LU tolerance for ${settings.targetLufs.toFixed(2)} LUFS.`)
    }
    if (settings.limiting === 'true-peak' && after.truePeakDbtp !== null && after.truePeakDbtp > settings.truePeakCeilingDbtp + 0.1) {
      throw new Error(`Loudness normalization achieved ${after.truePeakDbtp.toFixed(2)} dBTP, above the ${settings.truePeakCeilingDbtp.toFixed(2)} dBTP ceiling (+0.10 dB tolerance).`)
    }
  }
  return toReport(after, getSamplePeak(buffer), gainDb, limited, ceilingConstrained)
}

const createSeededRandom = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

export const createWavQuantizer = (
  settings: WavEncodingSettings,
  seed: number,
) => {
  if (settings.codec === 'pcm-f32') return (_sample: number) => _sample
  const levels = settings.codec === 'pcm-s16' ? 32768 : 8388608
  const random = createSeededRandom(seed)
  return (sample: number) => {
    const dither = settings.dither === 'tpdf' ? (random() - random()) / levels : 0
    return clamp(Math.round((sample + dither) * levels) / levels, -1, 1 - 1 / levels)
  }
}

export const quantizeWavInPlace = (
  buffer: MutableAudioBuffer,
  settings: WavEncodingSettings,
  seed: number,
  signal?: AbortSignal,
): void => {
  if (settings.codec === 'pcm-f32') return
  const quantize = createWavQuantizer(settings, seed)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)
    for (let frame = 0; frame < samples.length; frame += 1) {
      if ((frame & 16383) === 0) signal?.throwIfAborted()
      samples[frame] = quantize(samples[frame])
    }
  }
}
