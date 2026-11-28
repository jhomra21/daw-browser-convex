// Instrument measurements: pure functions over rendered mono signals (the shared primitives live in dsp.ts).
import { hann, maxStep, spectrum } from './dsp'
import { linearToDb } from './signals'

/** Four-term Blackman-Harris: a main lobe of +-4 bins and sidelobes below -92 dB, so a floor under -80 dB is the signal's own. */
const blackmanHarris = (length: number) => Float64Array.from({ length }, (_, n) =>
  0.35875 - 0.48829 * Math.cos(2 * Math.PI * n / length) + 0.14128 * Math.cos(4 * Math.PI * n / length) - 0.01168 * Math.cos(6 * Math.PI * n / length))

const lobeBins = 4

const powerBins = (signal: Float32Array, from: number, size: number) => {
  const { re, im } = spectrum(signal.subarray(from, from + size), size, blackmanHarris(size))

  return Float64Array.from({ length: size / 2 }, (_, bin) => re[bin] ** 2 + im[bin] ** 2)
}

/**
 * Energy off the harmonic series relative to the energy on it, in dB (synth.md D4): a Blackman-Harris spectrum of `size` frames,
 * every bin within the main lobe of a harmonic of `fundamentalHz` counts as harmonic, DC and its lobe are ignored.
 */
export const inharmonicRatioDb = (signal: Float32Array, fundamentalHz: number, rate: number, from: number, size: number) => {
  const power = powerBins(signal, from, size)
  const binHz = rate / size
  const harmonic = new Uint8Array(power.length)

  for (let order = 1; order * fundamentalHz < rate / 2; order += 1) {
    const centre = Math.round(order * fundamentalHz / binHz)

    for (let bin = Math.max(0, centre - lobeBins); bin <= Math.min(power.length - 1, centre + lobeBins); bin += 1) harmonic[bin] = 1
  }

  let on = 0
  let off = 0

  for (let bin = lobeBins + 1; bin < power.length; bin += 1) {
    if (harmonic[bin] === 1) on += power[bin]
    else off += power[bin]
  }

  return 10 * Math.log10(off / on + 1e-30)
}

/** Frequency of the strongest spectral peak, refined by a parabola through the log power of its two neighbours. */
export const peakFrequencyHz = (signal: Float32Array, rate: number, from: number, size: number) => {
  const power = powerBins(signal, from, size)
  let peak = 1

  for (let bin = 2; bin < power.length - 1; bin += 1) if (power[bin] > power[peak]) peak = bin
  const [left, middle, right] = [peak - 1, peak, peak + 1].map((bin) => Math.log(power[bin] + 1e-30))

  return (peak + 0.5 * (left - right) / (left - 2 * middle + right)) * rate / size
}

/** Strongest spectral line outside the main lobe of the tone at `toneHz`, relative to the tone's own peak, in dB. */
export const worstSpurDb = (signal: Float32Array, toneHz: number, rate: number, from: number, size: number) => {
  const power = powerBins(signal, from, size)
  const toneBin = Math.round(toneHz * size / rate)
  let tone = 0
  let spur = 0

  for (let bin = lobeBins + 1; bin < power.length; bin += 1) {
    if (Math.abs(bin - toneBin) <= lobeBins) tone = Math.max(tone, power[bin])
    else spur = Math.max(spur, power[bin])
  }

  return 10 * Math.log10(spur / tone + 1e-30)
}

/**
 * Amplitude envelope of a sine of exactly `period` frames (an even number): sqrt(2) times the RMS over the centred window of one period,
 * which is exactly constant for a steady sine. The window smooths a ramp's corners by under half a period.
 */
export const sineEnvelope = (signal: ArrayLike<number>, period: number) => {
  const cumulative = new Float64Array(signal.length + 1)

  for (let n = 0; n < signal.length; n += 1) cumulative[n + 1] = cumulative[n] + signal[n] ** 2

  return Float64Array.from({ length: signal.length }, (_, n) => {
    const low = Math.max(0, n - period / 2)
    const high = Math.min(signal.length, n + period / 2)

    return Math.sqrt(2 * (cumulative[high] - cumulative[low]) / (high - low))
  })
}

/**
 * Seconds from a note-on at `onFrame` until a peak-normalised envelope is within 1% of the decay's span of `sustain`
 * (synth.md S2: Decay is the time to travel from the peak to the Sustain level).
 */
export const decayTimeSec = (envelope: Float64Array, rate: number, period: number, onFrame: number, sustain: number) => {
  const target = sustain + 0.01 * (1 - sustain)

  // The one-period window holds only the note from half a period in.
  for (let n = onFrame + period / 2; n < envelope.length; n += 1) if (envelope[n] <= target) return (n - onFrame) / rate

  return Infinity
}

/** Seconds from a note-off at `offFrame` until the envelope is 60 dB below the level it left. */
export const releaseTimeSec = (envelope: Float64Array, rate: number, period: number, offFrame: number) => {
  const target = envelope[offFrame - period / 2] * 1e-3

  for (let n = offFrame; n < envelope.length; n += 1) if (envelope[n] <= target) return (n - offFrame) / rate

  return Infinity
}

/**
 * Peak of the power gain from `reference` to `signal` between `fromHz` and `toHz`, in dB: Hann-windowed Welch averages of
 * `size`-frame segments at half overlap, the ratio smoothed over three bins. Both are the same noise through a filter and without it.
 */
export const peakGainDb = (signal: Float32Array, reference: Float32Array, rate: number, size: number, fromHz: number, toHz: number) => {
  const window = hann(size)

  const average = (x: Float32Array) => {
    const power = new Float64Array(size / 2)
    let segments = 0

    for (let from = 0; from + size <= x.length; from += size / 2) {
      const { re, im } = spectrum(x.subarray(from, from + size), size, window)

      for (let bin = 0; bin < size / 2; bin += 1) power[bin] += re[bin] ** 2 + im[bin] ** 2
      segments += 1
    }

    return power.map((value) => value / segments)
  }

  const [filtered, flat] = [average(signal), average(reference)]
  let peak = 0

  for (let bin = Math.max(1, Math.floor(fromHz * size / rate)); bin <= Math.min(size / 2 - 2, Math.ceil(toHz * size / rate)); bin += 1) {
    const ratio = (filtered[bin - 1] + filtered[bin] + filtered[bin + 1]) / (flat[bin - 1] + flat[bin] + flat[bin + 1])
    peak = Math.max(peak, ratio)
  }

  return 10 * Math.log10(peak)
}

/**
 * Click metric: the largest sample-to-sample step in the `window` frames from an event, relative to the largest step in the
 * `reference` frames before it (the steady state the event interrupts).
 */
export const stepRatio = (signal: ArrayLike<number>, eventFrame: number, window: number, reference: number) =>
  maxStep(signal, eventFrame, eventFrame + window) / maxStep(signal, eventFrame - reference, eventFrame)

/** Level of `signal` in dB relative to the peak of the same signal: how much of a sound is left in a stretch. */
export const levelBelowPeakDb = (signal: ArrayLike<number>, from: number, to: number) => {
  let peak = 0
  let sum = 0

  for (let n = 0; n < signal.length; n += 1) peak = Math.max(peak, Math.abs(signal[n]))

  for (let n = from; n < to; n += 1) sum += signal[n] ** 2

  return linearToDb(Math.sqrt(sum / (to - from)) / peak)
}
