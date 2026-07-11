const CALIBRATION_SEQUENCE_FRAMES = 4095
const CALIBRATION_PEAK = 0.2

export type RecordingCalibrationAnalysis =
  | {
      accepted: true
      measuredRoundTripFrames: number
      confidence: number
      peakCorrelation: number
      snrDb: number
      inverted: boolean
    }
  | {
      accepted: false
      reason: 'clipped' | 'weak-signal' | 'ambiguous'
      confidence: number
      peakCorrelation: number
      snrDb: number
    }

const createCalibrationSequence = (): Float32Array => {
  const sequence = new Float32Array(CALIBRATION_SEQUENCE_FRAMES)
  let register = 0xfff
  for (let index = 0; index < sequence.length; index += 1) {
    sequence[index] = (register & 1) === 1 ? CALIBRATION_PEAK : -CALIBRATION_PEAK
    const feedback = ((register >> 0) ^ (register >> 1) ^ (register >> 2) ^ (register >> 8)) & 1
    register = (register >> 1) | (feedback << 11)
  }
  return sequence
}

export const createCalibrationStimulus = (sampleRate: number): Float32Array => {
  const guardFrames = Math.ceil(sampleRate * 0.05)
  const fadeFrames = Math.max(1, Math.ceil(sampleRate * 0.005))
  const sequence = createCalibrationSequence()
  const stimulus = new Float32Array(guardFrames + sequence.length + guardFrames)
  for (let index = 0; index < sequence.length; index += 1) {
    const fadeIn = Math.min(1, index / fadeFrames)
    const fadeOut = Math.min(1, (sequence.length - 1 - index) / fadeFrames)
    stimulus[guardFrames + index] = sequence[index] * Math.min(fadeIn, fadeOut)
  }
  return stimulus
}

const removeDc = (samples: Float32Array): Float32Array => {
  let mean = 0
  for (const sample of samples) mean += sample
  mean /= Math.max(1, samples.length)
  const centered = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) centered[index] = (samples[index] ?? 0) - mean
  return centered
}

export const analyzeCalibrationCapture = (
  captured: Float32Array,
  sampleRate: number,
  maximumRoundTripFrames = Math.ceil(sampleRate * 0.75),
): RecordingCalibrationAnalysis => {
  if (captured.some((sample) => Math.abs(sample) >= 0.999)) {
    return { accepted: false, reason: 'clipped', confidence: 0, peakCorrelation: 0, snrDb: 0 }
  }
  const reference = removeDc(createCalibrationStimulus(sampleRate))
  const input = removeDc(captured)
  const searchEnd = Math.min(maximumRoundTripFrames, input.length - reference.length)
  let bestLag = 0
  let bestSigned = 0
  let bestMagnitude = 0
  const correlations = new Float32Array(Math.max(0, searchEnd + 1))
  const correlate = (lag: number, sampleStep: number) => {
    let dot = 0
    let inputEnergy = 0
    let referenceEnergy = 0
    for (let index = 0; index < reference.length; index += sampleStep) {
      const referenceSample = reference[index] ?? 0
      const sample = input[lag + index] ?? 0
      dot += referenceSample * sample
      referenceEnergy += referenceSample * referenceSample
      inputEnergy += sample * sample
    }
    const correlation = inputEnergy > 0 ? dot / Math.sqrt(referenceEnergy * inputEnergy) : 0
    correlations[lag] = correlation
    const magnitude = Math.abs(correlation)
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude
      bestSigned = correlation
      bestLag = lag
    }
  }
  const coarseStep = 8
  for (let lag = 0; lag <= searchEnd; lag += 1) correlate(lag, coarseStep)
  const fineStart = Math.max(0, bestLag - coarseStep + 1)
  const fineEnd = Math.min(searchEnd, bestLag + coarseStep - 1)
  for (let lag = fineStart; lag <= fineEnd; lag += 1) {
    correlate(lag, 1)
  }
  const exclusionFrames = Math.ceil(sampleRate * 0.002)
  let secondMagnitude = 0
  let noiseSquareSum = 0
  let noiseCount = 0
  for (let lag = 0; lag < correlations.length; lag += 1) {
    const magnitude = Math.abs(correlations[lag] ?? 0)
    if (Math.abs(lag - bestLag) > exclusionFrames) secondMagnitude = Math.max(secondMagnitude, magnitude)
    if (Math.abs(lag - bestLag) > exclusionFrames * 2) {
      noiseSquareSum += magnitude * magnitude
      noiseCount += 1
    }
  }
  const noiseRms = Math.sqrt(noiseSquareSum / Math.max(1, noiseCount))
  const snrDb = 20 * Math.log10(Math.max(bestMagnitude, 1e-9) / Math.max(noiseRms, 1e-9))
  const separation = bestMagnitude > 0 ? Math.max(0, 1 - secondMagnitude / bestMagnitude) : 0
  const confidence = Math.min(1, Math.max(0, bestMagnitude * 0.65 + separation * 0.25 + Math.min(1, snrDb / 30) * 0.1))
  if (bestMagnitude < 0.35 || snrDb < 8) {
    return { accepted: false, reason: 'weak-signal', confidence, peakCorrelation: bestMagnitude, snrDb }
  }
  if (secondMagnitude > bestMagnitude * 0.82) {
    return { accepted: false, reason: 'ambiguous', confidence, peakCorrelation: bestMagnitude, snrDb }
  }
  return {
    accepted: true,
    measuredRoundTripFrames: bestLag,
    confidence,
    peakCorrelation: bestMagnitude,
    snrDb,
    inverted: bestSigned < 0,
  }
}
