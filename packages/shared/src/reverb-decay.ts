// The Reverb's response curves, from the filter designs in native/audio-core/src/reverb_kernel.h at 48 kHz. The Reverb panel
// draws them and the version 1 migration (reverb-cut-migration.ts) fits shelves against them, so the numbers shown are the
// ones the kernel's filters make. Keep these designs in step with the kernel and the legacy worklet.
import type { ReverbDensity, ReverbParams } from './effects-params'

const SAMPLE_RATE = 48000

// The kernel's loop lines at Size 1 (kLineFrames48k), sixteen frame lengths; a density keeps an even spread of them.
const LINE_FRAMES_48K = [503, 631, 773, 919, 1069, 1217, 1373, 1531, 1693, 1861, 2039, 2213, 2393, 2579, 2777, 3011]
const LINE_COUNT: Record<ReverbDensity, number> = { sparse: 8, low: 12, mid: 16, high: 16 }

export type ReverbShelf = { hz: number; db: number }

export const reverbLineFrames = (density: ReverbDensity) => {
  const slots = new Set(Array.from({ length: LINE_COUNT[density] }, (_, line) => Math.floor(line * LINE_FRAMES_48K.length / LINE_COUNT[density])))

  return LINE_FRAMES_48K.filter((_, slot) => slots.has(slot))
}

const polynomialMagnitudeSquared = (coefficients: readonly number[], omega: number) => {
  const real = coefficients.reduce((sum, value, order) => sum + value * Math.cos(order * omega), 0)
  const imaginary = coefficients.reduce((sum, value, order) => sum + value * Math.sin(order * omega), 0)

  return real * real + imaginary * imaginary
}

// |H|^2 at omega radians per sample of the filter (b0 + b1 z^-1 + ...) / (1 + a1 z^-1 + ...), the denominator given with its leading 1.
export const filterMagnitudeSquared = (numerator: readonly number[], denominator: readonly number[], omega: number) =>
  polynomialMagnitudeSquared(numerator, omega) / polynomialMagnitudeSquared(denominator, omega)

// The kernel's first-order shelf for a line that loses lossDb per trip, in dB at omega.
export const reverbShelfGainDb = (high: boolean, shelf: ReverbShelf, lossDb: number, omega: number) => {
  const tangent = Math.tan(Math.PI * shelf.hz / SAMPLE_RATE)
  const q = 10 ** (lossDb * (1 - 10 ** (-shelf.db / 20)) / 40)

  if (high) {
    const den = 1 + tangent * q

    return 10 * Math.log10(filterMagnitudeSquared([q * q * (1 + tangent / q) / den, q * q * (tangent / q - 1) / den], [1, (tangent * q - 1) / den], omega))
  }

  const den = 1 + tangent / q

  return 10 * Math.log10(filterMagnitudeSquared([(1 + tangent * q) / den, (tangent * q - 1) / den], [1, (tangent / q - 1) / den], omega))
}

// Mean T60 of a network whose lines decay at the given rates in dB per second.
export const reverbMeanT60 = (rates: readonly number[]) => 60 / (rates.reduce((sum, rate) => sum + rate, 0) / rates.length)

type ReverbDecayParams = Pick<ReverbParams, 'decaySec' | 'size' | 'density' | 'lowShelfHz' | 'highShelfHz' | 'lowShelfOn' | 'highShelfOn' | 'lowShelfDb' | 'highShelfDb'>

// The T60 in seconds at hz: the Decay knob is the mid-band RT60 and the shelves move it at the band edges, line by line.
export const reverbDecaySec = (params: ReverbDecayParams, hz: number) => {
  const omega = 2 * Math.PI * hz / SAMPLE_RATE
  const scale = 0.7 + 0.5 * params.size
  const base = 60 / params.decaySec
  const low = { hz: params.lowShelfHz, db: params.lowShelfDb }
  const high = { hz: params.highShelfHz, db: params.highShelfDb }

  return reverbMeanT60(reverbLineFrames(params.density).map((lines) => {
    const frames = lines * scale
    const lossDb = base * frames / SAMPLE_RATE
    const gainDb = (params.lowShelfOn ? reverbShelfGainDb(false, low, lossDb, omega) : 0) + (params.highShelfOn ? reverbShelfGainDb(true, high, lossDb, omega) : 0)

    return base - gainDb * SAMPLE_RATE / frames
  }))
}

// The input Lo or Hi Cut as the kernel designs it: a second-order Butterworth, in dB at hz. An open cut (20 Hz or 20 kHz) is flat.
export const reverbInputCutDb = (highpass: boolean, cutHz: number, hz: number) => {
  const omega = 2 * Math.PI * Math.min(cutHz, 0.45 * SAMPLE_RATE) / SAMPLE_RATE
  const cosine = Math.cos(omega)
  const alpha = Math.sin(omega) / (2 * Math.SQRT1_2)
  const edge = (highpass ? 1 + cosine : 1 - cosine) / 2

  const a0 = 1 + alpha

  return 10 * Math.log10(filterMagnitudeSquared(
    [edge / a0, (highpass ? -(1 + cosine) : 1 - cosine) / a0, edge / a0],
    [1, -2 * cosine / a0, (1 - alpha) / a0],
    2 * Math.PI * hz / SAMPLE_RATE,
  ))
}
