// Measurement primitives. Ported from the research scripts (reverb-measure/lib.cjs, m1.cjs, m2.cjs); tone, THD+N, alias and
// offset measurements come from packages/audio-engine/src/dsp-characterization.ts.
import { linearToDb } from './signals'

export const fft = (re: Float64Array, im: Float64Array) => {
  const n = re.length

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1

    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit

    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)

    for (let i = 0; i < n; i += length) {
      let cr = 1
      let ci = 0

      for (let k = 0; k < length / 2; k += 1) {
        const a = i + k
        const b = a + length / 2
        const vr = re[b] * cr - im[b] * ci
        const vi = re[b] * ci + im[b] * cr
        re[b] = re[a] - vr
        im[b] = im[a] - vi
        re[a] += vr
        im[a] += vi
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
}

export const nextPowerOfTwo = (value: number) => 2 ** Math.ceil(Math.log2(value))

/** Complex spectrum of the signal zero-padded (or truncated) to `size`. */
export const spectrum = (signal: ArrayLike<number>, size: number, window?: Float64Array) => {
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const count = Math.min(size, signal.length)

  for (let n = 0; n < count; n += 1) re[n] = signal[n] * (window?.[n] ?? 1)
  fft(re, im)

  return { re, im }
}

export const hann = (length: number) => Float64Array.from({ length }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / length))

export const peakAbs = (signal: ArrayLike<number>) => {
  let peak = 0

  for (let n = 0; n < signal.length; n += 1) peak = Math.max(peak, Math.abs(signal[n]))

  return peak
}

export const rms = (signal: ArrayLike<number>, from = 0, to = signal.length) => {
  let sum = 0

  for (let n = from; n < to; n += 1) sum += signal[n] * signal[n]

  return Math.sqrt(sum / Math.max(1, to - from))
}

export const rmsDb = (signal: ArrayLike<number>, from = 0, to = signal.length) => linearToDb(rms(signal, from, to))

export const peakDb = (signal: ArrayLike<number>) => linearToDb(peakAbs(signal))

export const maxAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>, from = 0, to = Math.min(a.length, b.length)) => {
  let max = 0

  for (let n = from; n < to; n += 1) max = Math.max(max, Math.abs(a[n] - b[n]))

  return max
}

export const countNonFinite = (signal: ArrayLike<number>) => {
  let count = 0

  for (let n = 0; n < signal.length; n += 1) if (!Number.isFinite(signal[n])) count += 1

  return count
}

/** Single-frequency amplitude and phase over a Hann-windowed segment (works for non-coherent tones). */
export const toneFit = (signal: ArrayLike<number>, frequencyHz: number, rate: number, from = 0, to = signal.length) => {
  let re = 0
  let im = 0
  let weight = 0
  const length = to - from

  for (let n = 0; n < length; n += 1) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / length)
    const angle = 2 * Math.PI * frequencyHz * (from + n) / rate
    re += w * signal[from + n] * Math.cos(angle)
    im -= w * signal[from + n] * Math.sin(angle)
    weight += w
  }

  return { amplitude: 2 * Math.hypot(re, im) / weight, phase: Math.atan2(im, re) }
}

/**
 * Power of the folded harmonics of `fundamentalHz` that land at or below `bandHz`, relative to the fundamental, in dB.
 * A fold above the audible band (an oversampler's transition band at 48 kHz) is inaudible and not counted.
 */
export const audibleAliasDb = (signal: ArrayLike<number>, fundamentalHz: number, rate: number, maximumHarmonic: number, bandHz = 20000) => {
  const fundamental = toneFit(signal, fundamentalHz, rate).amplitude
  let power = 0

  for (let harmonic = 2; harmonic <= maximumHarmonic; harmonic += 1) {
    const frequency = harmonic * fundamentalHz

    if (frequency < rate / 2) continue
    const folded = Math.abs(frequency - rate * Math.round(frequency / rate))

    if (folded <= bandHz) power += toneFit(signal, folded, rate).amplitude ** 2
  }

  return 10 * Math.log10(power / fundamental ** 2 + 1e-30)
}

export const toneGainDb = (input: ArrayLike<number>, output: ArrayLike<number>, frequencyHz: number, rate: number, from: number, to: number) =>
  linearToDb(toneFit(output, frequencyHz, rate, from, to).amplitude / toneFit(input, frequencyHz, rate, from, to).amplitude)

/** First frame of the largest magnitude: the impulse delay of the dry path. */
export const peakFrame = (signal: ArrayLike<number>) => {
  let best = 0

  for (let n = 1; n < signal.length; n += 1) if (Math.abs(signal[n]) > Math.abs(signal[best])) best = n

  return best
}

type BiquadCoefficients = { b0: number; b1: number; b2: number; a1: number; a2: number }

export const biquad = (x: ArrayLike<number>, c: BiquadCoefficients) => {
  const y = new Float64Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0

  for (let n = 0; n < x.length; n += 1) {
    const v = c.b0 * x[n] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1
    x1 = x[n]
    y2 = y1
    y1 = v
    y[n] = v
  }

  return y
}

/** RBJ low-pass, Q 0.707 (float64). */
export const lowpass = (x: ArrayLike<number>, frequencyHz: number, rate: number, q = Math.SQRT1_2) => {
  const w = 2 * Math.PI * frequencyHz / rate
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha

  return biquad(x, { b0: (1 - Math.cos(w)) / 2 / a0, b1: (1 - Math.cos(w)) / a0, b2: (1 - Math.cos(w)) / 2 / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - alpha) / a0 })
}

/** RBJ band-pass (constant skirt, Q 1.4 as in the research scripts). */
export const bandpass = (x: ArrayLike<number>, frequencyHz: number, rate: number, q = 1.4) => {
  const w = 2 * Math.PI * frequencyHz / rate
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha

  return biquad(x, { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - alpha) / a0 })
}

/** Reverberation time from the Schroeder backward integral: line fit between `hiDb` and `loDb`, extrapolated to 60 dB. */
export const schroederRt = (x: ArrayLike<number>, rate: number, hiDb = -5, loDb = -25) => {
  const n = x.length
  const decay = new Float64Array(n)
  let sum = 0

  for (let i = n - 1; i >= 0; i -= 1) {
    sum += x[i] * x[i]
    decay[i] = sum
  }

  let count = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0

  for (let i = 0; i < n; i += 1) {
    const db = 10 * Math.log10(decay[i] / decay[0])

    if (db > hiDb || db < loDb) continue
    const t = i / rate
    count += 1
    sx += t
    sy += db
    sxx += t * t
    sxy += t * db
  }

  return -60 / ((count * sxy - sx * sy) / (count * sxx - sx * sx))
}

export const schroederT30 = (x: ArrayLike<number>, rate: number) => schroederRt(x, rate, -5, -35)

/** Normalised echo density (Abel and Huang) over [first, last) in windows of `window` frames, computed on the second difference. */
export const echoDensity = (x: ArrayLike<number>, first: number, last: number, window: number) => {
  const y = new Float64Array(x.length)

  for (let i = 2; i < x.length; i += 1) y[i] = x[i] - 2 * x[i - 1] + x[i - 2]
  const floor = 1e-4 * peakAbs(y)
  let total = 0
  let windows = 0

  for (let start = first; start + window <= last; start += window >> 2) {
    let mean = 0

    for (let i = start; i < start + window; i += 1) mean += y[i]
    mean /= window
    let variance = 0

    for (let i = start; i < start + window; i += 1) variance += (y[i] - mean) ** 2
    const deviation = Math.max(Math.sqrt(variance / window), floor)
    let outside = 0

    for (let i = start; i < start + window; i += 1) if (Math.abs(y[i] - mean) > deviation) outside += 1
    total += outside / window / 0.3173
    windows += 1
  }

  return total / windows
}

/** Std (dB) and max peak of the impulse-response magnitude about its 1/3-octave mean, 200 Hz to 8 kHz, window 100 ms onward. */
export const fineStructure = (ir: ArrayLike<number>, rate: number) => {
  const size = nextPowerOfTwo(1.3 * rate)
  const start = Math.round(0.1 * rate)
  const { re, im } = spectrum(Array.from({ length: size }, (_, n) => ir[start + n] ?? 0), size, hann(size))
  const magnitude = Float64Array.from({ length: size / 2 }, (_, i) => Math.hypot(re[i], im[i]))
  let squares = 0
  let count = 0
  let peak = -Infinity

  for (let f = 200; f < 8000; f *= 1.26) {
    const lo = Math.floor(f * size / rate)
    const hi = Math.floor(f * 1.26 * size / rate)
    const db = Array.from({ length: hi - lo }, (_, i) => 20 * Math.log10(magnitude[lo + i] + 1e-12))
    const mean = db.reduce((a, b) => a + b, 0) / db.length

    for (const d of db) {
      squares += (d - mean) ** 2
      count += 1
      peak = Math.max(peak, d - mean)
    }
  }

  return { stdDb: Math.sqrt(squares / count), peakDb: peak }
}

/** Largest normalised autocorrelation magnitude of the tail for lags in [minLag, maxLag] frames. */
export const autocorrelationPeak = (x: ArrayLike<number>, from: number, to: number, minLag: number, maxLag: number) => {
  let energy = 0

  for (let i = from; i < to; i += 1) energy += x[i] * x[i]
  let worst = 0

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0

    for (let i = from; i < to; i += 1) sum += x[i] * x[i + lag]
    worst = Math.max(worst, Math.abs(sum / energy))
  }

  return worst
}

export const correlation = (a: ArrayLike<number>, b: ArrayLike<number>, from = 0, to = Math.min(a.length, b.length)) => {
  let ab = 0
  let aa = 0
  let bb = 0

  for (let i = from; i < to; i += 1) {
    ab += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }

  return ab / Math.sqrt(aa * bb)
}

/**
 * Click metric around a parameter step at `start`: the largest sample-to-sample step of the stepped render over `window`
 * frames, relative to the unstepped reference render's largest step (steady state), plus the largest extra step the
 * parameter change added on top of the reference.
 */
export const clickMetric = (stepped: ArrayLike<number>, reference: ArrayLike<number>, start: number, window: number) => {
  let steppedStep = 0
  let referenceStep = 0
  let extra = 0

  for (let i = start; i < start + window; i += 1) {
    const a = stepped[i] - stepped[i - 1]
    const b = reference[i] - reference[i - 1]
    steppedStep = Math.max(steppedStep, Math.abs(a))
    referenceStep = Math.max(referenceStep, Math.abs(b))
    extra = Math.max(extra, Math.abs(a - b))
  }

  return { steppedStep, referenceStep, extra, ratio: steppedStep / referenceStep, extraRatio: extra / referenceStep }
}

/** Largest sample-to-sample step over a range. */
export const maxStep = (x: ArrayLike<number>, from: number, to: number) => {
  let step = 0

  for (let i = Math.max(1, from); i < to; i += 1) step = Math.max(step, Math.abs(x[i] - x[i - 1]))

  return step
}

const bessel0 = (x: number) => {
  let sum = 1
  let term = 1

  for (let k = 1; k < 40; k += 1) {
    term *= (x / (2 * k)) ** 2
    sum += term
  }

  return sum
}

/** Kaiser-windowed sinc low-pass FIR at `cutoff` (fraction of the sample rate). */
export const kaiserSinc = (taps: number, cutoff: number, beta: number) => {
  const mid = (taps - 1) / 2

  return Float64Array.from({ length: taps }, (_, n) => {
    const x = n - mid
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const w = bessel0(beta * Math.sqrt(Math.max(0, 1 - (x / mid) ** 2))) / bessel0(beta)

    return sinc * w
  })
}

const trueFactor = 8
const trueHalfWidth = 32
const trueBeta = 9

const interpolationKernel = (tau: number) => {
  const sinc = tau === 0 ? 1 : Math.sin(Math.PI * tau) / (Math.PI * tau)

  return sinc * bessel0(trueBeta * Math.sqrt(Math.max(0, 1 - (tau / trueHalfWidth) ** 2))) / bessel0(trueBeta)
}

const interpolationKernels = Array.from({ length: trueFactor }, (_, phase) =>
  Float64Array.from({ length: 2 * trueHalfWidth }, (_, i) => interpolationKernel(phase / trueFactor + trueHalfWidth - 1 - i)))

/**
 * True peak (dBTP, relative to full scale) by 8x oversampling with a 64-tap Kaiser interpolator, ITU-R BS.1770 Annex 2 style
 * (that recommendation specifies 4x with a 48-tap filter; the longer filter keeps the reading flat to 0.45 fs).
 * Only neighbourhoods of samples above 40 % of the sample peak are interpolated.
 */
export const truePeakDb = (x: ArrayLike<number>) => {
  const samplePeak = peakAbs(x)

  if (samplePeak === 0) return -Infinity
  let best = samplePeak

  for (let n = 0; n < x.length; n += 1) {
    if (Math.abs(x[n]) < 0.4 * samplePeak) continue

    for (let phase = 1; phase < trueFactor; phase += 1) {
      const kernel = interpolationKernels[phase]
      let sum = 0

      for (let i = 0; i < kernel.length; i += 1) {
        const index = n - trueHalfWidth + 1 + i

        if (index >= 0 && index < x.length) sum += x[index] * kernel[i]
      }

      best = Math.max(best, Math.abs(sum))
    }
  }

  return linearToDb(best)
}

/** Complex analog prototype response (RBJ cookbook s-domain forms) of an EQ band at `frequencyHz`, in dB. */
export const analogBandDb = (type: string, f0: number, q: number, gainDb: number, frequencyHz: number) => {
  const w = frequencyHz / f0
  const a = 10 ** (gainDb / 40)
  const sa = Math.sqrt(a)
  const poly = (c2: number, c1: number, c0: number): [number, number] => [c0 - c2 * w * w, c1 * w]
    const abs = (x: [number, number]) => Math.hypot(x[0], x[1])
  const denominator = poly(1, 1 / q, 1)
  const gain = (numerator: [number, number], den: [number, number], scale = 1) => 20 * Math.log10(scale * abs(numerator) / abs(den))

  switch (type) {
    case 'lowpass': return gain([1, 0], denominator)
    case 'highpass': return gain(poly(-1, 0, 0), denominator)
    case 'bandpass': return gain(poly(0, 1 / q, 0), denominator)
    case 'notch': return gain(poly(1, 0, 1), denominator)
    case 'allpass': return 0
    case 'peaking': return gain(poly(1, a / q, 1), poly(1, 1 / (a * q), 1))
    case 'lowshelf': return gain(poly(1, sa / q, a), poly(a, sa / q, 1), a)
    case 'highshelf': return gain(poly(a, sa / q, 1), poly(1, sa / q, a), a)
    default: throw new Error(`Unknown band type ${type}`)
  }
}

/** Magnitude response (dB) of an impulse response at the given frequencies, by FFT. */
export const responseDb = (impulseResponse: ArrayLike<number>, rate: number, frequencies: readonly number[]) => {
  const size = nextPowerOfTwo(Math.max(impulseResponse.length, 4096))
  const { re, im } = spectrum(impulseResponse, size)

  return frequencies.map((f) => {
    const position = f * size / rate
    const lo = Math.floor(position)
    const t = position - lo
    const db = (i: number) => 20 * Math.log10(Math.hypot(re[i], im[i]) + 1e-30)

    return db(lo) * (1 - t) + db(lo + 1) * t
  })
}

export const logFrequencies = (from: number, to: number, count: number) =>
  Array.from({ length: count }, (_, i) => from * (to / from) ** (i / (count - 1)))

/** RBJ cookbook coefficients in float64, mirroring rbj_coefficients in native/audio-core/src/processor_eq.cpp. */
export const rbjCoefficients = (type: string, frequencyHz: number, q: number, gainDb: number, rate: number): BiquadCoefficients => {
  const w = 2 * Math.PI * Math.min(frequencyHz, rate * 0.49) / rate
  const cosine = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  const a = 10 ** (gainDb / 40)
  const beta = 2 * Math.sqrt(a) * alpha

  const [b0, b1, b2, a0, a1, a2] = ((): number[] => {
    switch (type) {
      case 'lowpass': return [(1 - cosine) / 2, 1 - cosine, (1 - cosine) / 2, 1 + alpha, -2 * cosine, 1 - alpha]
      case 'highpass': return [(1 + cosine) / 2, -(1 + cosine), (1 + cosine) / 2, 1 + alpha, -2 * cosine, 1 - alpha]
      case 'lowshelf': return [
        a * (a + 1 - (a - 1) * cosine + beta), 2 * a * (a - 1 - (a + 1) * cosine), a * (a + 1 - (a - 1) * cosine - beta),
        a + 1 + (a - 1) * cosine + beta, -2 * (a - 1 + (a + 1) * cosine), a + 1 + (a - 1) * cosine - beta]
      case 'highshelf': return [
        a * (a + 1 + (a - 1) * cosine + beta), -2 * a * (a - 1 + (a + 1) * cosine), a * (a + 1 + (a - 1) * cosine - beta),
        a + 1 - (a - 1) * cosine + beta, 2 * (a - 1 - (a + 1) * cosine), a + 1 - (a - 1) * cosine - beta]
      default: return [1 + alpha * a, -2 * cosine, 1 - alpha * a, 1 + alpha / a, -2 * cosine, 1 - alpha / a]
    }
  })()

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Largest instantaneous-frequency deviation (cents) of a tone at `f0` over [from, to), by I/Q demodulation and a 20 ms average. */
export const pitchDeviationCents = (x: ArrayLike<number>, f0: number, rate: number, from: number, to: number) => {
  const length = to - from
  const cumI = new Float64Array(length + 1)
  const cumQ = new Float64Array(length + 1)

  for (let n = 0; n < length; n += 1) {
    const angle = 2 * Math.PI * f0 * (from + n) / rate
    cumI[n + 1] = cumI[n] + x[from + n] * Math.cos(angle)
    cumQ[n + 1] = cumQ[n] - x[from + n] * Math.sin(angle)
  }

  const window = Math.round(0.02 * rate)
  const hop = Math.round(0.01 * rate)
  let previous = 0
  let unwrapped = 0
  let worst = 0
  let first = true

  for (let n = window; n + window <= length; n += hop) {
    const phase = Math.atan2(cumQ[n + window] - cumQ[n], cumI[n + window] - cumI[n])
    const delta = phase - previous
    previous = phase

    if (first) {
      first = false
      continue
    }

    unwrapped = delta - 2 * Math.PI * Math.round(delta / (2 * Math.PI))
    worst = Math.max(worst, Math.abs(1200 * Math.log2(1 + unwrapped / (2 * Math.PI * (hop / rate)) / f0)))
  }

  return worst
}
