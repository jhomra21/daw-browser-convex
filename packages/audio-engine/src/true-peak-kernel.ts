export const truePeakOversampling = 8
export const truePeakTapsPerPhase = 24
export const truePeakCenterTap = truePeakTapsPerPhase / 2 - 1
export const truePeakFutureFrames = truePeakTapsPerPhase - 1 - truePeakCenterTap

const sinc = (value: number) => value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value)

export const truePeakPolyphaseCoefficients: readonly Float64Array[] = Array.from(
  { length: truePeakOversampling },
  (_, phase) => {
    const coefficients = new Float64Array(truePeakTapsPerPhase)
    const fractionalOffset = phase / truePeakOversampling
    let sum = 0
    for (let tap = 0; tap < truePeakTapsPerPhase; tap += 1) {
      const distance = tap - truePeakCenterTap - fractionalOffset
      const window = 0.42
        - 0.5 * Math.cos(2 * Math.PI * tap / (truePeakTapsPerPhase - 1))
        + 0.08 * Math.cos(4 * Math.PI * tap / (truePeakTapsPerPhase - 1))
      const coefficient = sinc(distance) * window
      coefficients[tap] = coefficient
      sum += coefficient
    }
    for (let tap = 0; tap < coefficients.length; tap += 1) coefficients[tap] /= sum
    return coefficients
  },
)

export const predictLinkedTruePeakAtFrame = (input: {
  channelCount: number
  frame: number
  sampleAt: (channel: number, frame: number) => number
}) => {
  let peak = 0
  for (let channel = 0; channel < input.channelCount; channel += 1) {
    for (const coefficients of truePeakPolyphaseCoefficients) {
      let value = 0
      for (let tap = 0; tap < coefficients.length; tap += 1) {
        value += input.sampleAt(
          channel,
          input.frame + tap - truePeakCenterTap,
        ) * coefficients[tap]
      }
      if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value))
    }
  }
  return peak
}
