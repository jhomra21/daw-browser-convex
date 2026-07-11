type TruePeakBuffer = {
  numberOfChannels: number
  length: number
  getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
}

const OVERSAMPLING = 8
const TAPS_PER_PHASE = 24

const sinc = (value: number) => value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value)

const createPolyphaseCoefficients = (): readonly Float64Array[] => Array.from(
  { length: OVERSAMPLING },
  (_, phase) => {
    const coefficients = new Float64Array(TAPS_PER_PHASE)
    const fractionalOffset = phase / OVERSAMPLING
    const center = TAPS_PER_PHASE / 2 - 1
    let sum = 0
    for (let tap = 0; tap < TAPS_PER_PHASE; tap += 1) {
      const distance = tap - center - fractionalOffset
      const window = 0.42
        - 0.5 * Math.cos(2 * Math.PI * tap / (TAPS_PER_PHASE - 1))
        + 0.08 * Math.cos(4 * Math.PI * tap / (TAPS_PER_PHASE - 1))
      const coefficient = sinc(distance) * window
      coefficients[tap] = coefficient
      sum += coefficient
    }
    for (let tap = 0; tap < coefficients.length; tap += 1) coefficients[tap] /= sum
    return coefficients
  },
)

const POLYPHASE_COEFFICIENTS = createPolyphaseCoefficients()

type TruePeakScanResult = {
  peak: number
  peakDbtp: number
}

export function scanTruePeak(
  buffer: TruePeakBuffer,
  signal?: AbortSignal,
): TruePeakScanResult {
  let peak = 0
  const center = TAPS_PER_PHASE / 2 - 1
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex)
    for (let frame = 0; frame < buffer.length; frame += 1) {
      if ((frame & 4095) === 0) signal?.throwIfAborted()
      for (const coefficients of POLYPHASE_COEFFICIENTS) {
        let sample = 0
        for (let tap = 0; tap < coefficients.length; tap += 1) {
          const sourceFrame = frame + tap - center
          if (sourceFrame >= 0 && sourceFrame < channel.length) {
            sample += channel[sourceFrame] * coefficients[tap]
          }
        }
        if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample))
      }
    }
  }
  signal?.throwIfAborted()
  return {
    peak,
    peakDbtp: peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak),
  }
}
