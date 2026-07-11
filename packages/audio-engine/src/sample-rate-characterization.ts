export type SampleRateConversionStatus = 'pass' | 'fail' | 'unsupported'

export type SampleRateConversionMetrics = {
  outputSampleRate: number
  outputLength: number
  expectedOutputLength: number
  gainErrorDb: number
  passbandRippleDb: number
  aliasLevelDb: number | null
  impulsePeak: number
  preRingingPeak: number
  postRingingPeak: number
  phaseDelayFrames: number
  stereoCorrelation: number
  isolationDb: number
  elapsedMs: number | null
  inputBytes: number
  outputBytes: number
}

export type SampleRateConversionResult = {
  sourceSampleRate: number
  targetSampleRate: number
  status: SampleRateConversionStatus
  metrics?: SampleRateConversionMetrics
  message?: string
}

export type SampleRateConversionCandidate = {
  name: 'libsamplerate' | 'SoXR' | 'r8brain'
  status: 'not-evaluated'
  reason: string
}

const dbFromRatio = (value: number) => value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY

export const createSrcImpulseFixture = (length: number, peakFrame: number): Float32Array => {
  const samples = new Float32Array(length)
  if (peakFrame >= 0 && peakFrame < length) samples[peakFrame] = 1
  return samples
}

export const createSrcToneFixture = (length: number, frequencyHz: number, sampleRate: number): Float32Array => {
  const samples = new Float32Array(length)
  for (let frame = 0; frame < length; frame += 1) {
    samples[frame] = Math.sin(2 * Math.PI * frequencyHz * frame / sampleRate)
  }
  return samples
}

export const createSrcStereoIsolationFixture = (
  length: number,
  sampleRate: number,
): readonly [Float32Array, Float32Array] => {
  const left = createSrcToneFixture(length, 1_000, sampleRate)
  return [left, new Float32Array(length)]
}

export const measureToneAmplitude = (
  samples: Float32Array,
  frequencyHz: number,
  sampleRate: number,
  startFrame = 0,
): number => {
  let sine = 0
  let cosine = 0
  const length = samples.length - startFrame
  if (length <= 0) return 0
  for (let frame = startFrame; frame < samples.length; frame += 1) {
    const phase = 2 * Math.PI * frequencyHz * frame / sampleRate
    sine += samples[frame] * Math.sin(phase)
    cosine += samples[frame] * Math.cos(phase)
  }
  return 2 * Math.hypot(sine, cosine) / length
}

export const measureSrcImpulse = (samples: Float32Array, expectedPeakFrame: number) => {
  let peak = 0
  let peakFrame = 0
  for (let frame = 0; frame < samples.length; frame += 1) {
    const magnitude = Math.abs(samples[frame])
    if (magnitude > peak) {
      peak = magnitude
      peakFrame = frame
    }
  }
  let preRingingPeak = 0
  let postRingingPeak = 0
  for (let frame = 0; frame < peakFrame; frame += 1) preRingingPeak = Math.max(preRingingPeak, Math.abs(samples[frame]))
  for (let frame = peakFrame + 1; frame < samples.length; frame += 1) postRingingPeak = Math.max(postRingingPeak, Math.abs(samples[frame]))
  return { peak, preRingingPeak, postRingingPeak, phaseDelayFrames: peakFrame - expectedPeakFrame }
}

export const measureStereoCorrelation = (left: Float32Array, right: Float32Array): number => {
  let dot = 0
  let leftEnergy = 0
  let rightEnergy = 0
  const length = Math.min(left.length, right.length)
  for (let frame = 0; frame < length; frame += 1) {
    dot += left[frame] * right[frame]
    leftEnergy += left[frame] * left[frame]
    rightEnergy += right[frame] * right[frame]
  }
  return leftEnergy > 0 && rightEnergy > 0 ? dot / Math.sqrt(leftEnergy * rightEnergy) : 0
}

export const measureIsolationDb = (source: Float32Array, isolated: Float32Array): number => {
  let sourcePeak = 0
  let isolatedPeak = 0
  for (const sample of source) sourcePeak = Math.max(sourcePeak, Math.abs(sample))
  for (const sample of isolated) isolatedPeak = Math.max(isolatedPeak, Math.abs(sample))
  return dbFromRatio(isolatedPeak / sourcePeak)
}

export const isSampleRateConversionResult = (value: unknown): value is SampleRateConversionResult => {
  if (typeof value !== 'object' || value === null) return false
  const sourceSampleRate = Reflect.get(value, 'sourceSampleRate')
  const targetSampleRate = Reflect.get(value, 'targetSampleRate')
  const status = Reflect.get(value, 'status')
  const metrics = Reflect.get(value, 'metrics')
  return typeof sourceSampleRate === 'number'
    && typeof targetSampleRate === 'number'
    && (status === 'pass' || status === 'fail' || status === 'unsupported')
    && (metrics === undefined || (
      typeof metrics === 'object'
      && metrics !== null
      && typeof Reflect.get(metrics, 'outputSampleRate') === 'number'
      && typeof Reflect.get(metrics, 'outputLength') === 'number'
      && typeof Reflect.get(metrics, 'passbandRippleDb') === 'number'
      && (typeof Reflect.get(metrics, 'aliasLevelDb') === 'number' || Reflect.get(metrics, 'aliasLevelDb') === null)
      && (typeof Reflect.get(metrics, 'elapsedMs') === 'number' || Reflect.get(metrics, 'elapsedMs') === null)
    ))
}

export const sampleRateConversionCandidates: readonly SampleRateConversionCandidate[] = [
  {
    name: 'libsamplerate',
    status: 'not-evaluated',
    reason: 'Dependency, browser integration, license, and maintenance evidence are unavailable in this repository.',
  },
  {
    name: 'SoXR',
    status: 'not-evaluated',
    reason: 'Dependency, browser integration, license, and maintenance evidence are unavailable in this repository.',
  },
  {
    name: 'r8brain',
    status: 'not-evaluated',
    reason: 'Dependency, browser integration, license, and maintenance evidence are unavailable in this repository.',
  },
]
