// The Lo-Fi acceptance measurements (saturation-utility.md section 3.2), written against a render callback so the same code runs
// against the rebuilt engine and, with a callback that maps the state onto the old fields, against the base commit (a49d9c57)
// for the "before" values.
import { hann, peakAbs, rms, spectrum, toneFit } from '../dsp'
import { linearToDb, noise, silence, sine } from '../signals'

export type LoFiRender = (state: Readonly<Record<string, number | string | boolean>>, input: Float32Array) => Promise<Float32Array>

const size = 131072

const magnitudes = (signal: Float32Array, rate: number) => {
  const tail = signal.subarray(signal.length - size)
  const { re, im } = spectrum(tail, size, hann(size))

  return { bins: Float64Array.from({ length: size / 2 }, (_, k) => Math.hypot(re[k], im[k]) / size), rate }
}

const binHz = (k: number, rate: number) => k * rate / size

/** The strongest tone that is neither the 5 kHz input nor DC, found on a grid finer than 1 Hz. */
export const imageFrequencyHz = async (render: LoFiRender, rate: number, sampleRateHz: number) => {
  const output = await render({ bitDepth: 24, sampleRateHz, noiseDb: -120 }, sine(4 * rate, 5000, rate, 0.5))
  const { bins } = magnitudes(output, rate)
  let best = 0
  let bestHz = 0

  for (let k = Math.ceil(100 * size / rate); k < bins.length; k += 1) {
    const hz = binHz(k, rate)

    if (Math.abs(hz - 5000) < 300 || bins[k] <= best) continue
    best = bins[k]
    bestHz = hz
  }

  return bestHz
}

/** Output level over input level, in dB, of a tone through a 12 kHz rate, and the level of its alias at 12 kHz minus the tone. */
export const preFilterRejection = async (render: LoFiRender, rate: number, preFilter: boolean) => {
  const input = sine(2 * rate, 10000, rate, 0.5)
  const output = await render({ bitDepth: 24, sampleRateHz: 12000, noiseDb: -120, preFilter }, input)
  const from = rate / 2
  const { bins } = magnitudes(output, rate)
  const aliasBin = Math.round(2000 * size / rate)
  let alias = 0

  for (let k = aliasBin - 3; k <= aliasBin + 3; k += 1) alias = Math.max(alias, bins[k])

  return { totalDb: linearToDb(rms(output, from) / rms(input, from)), aliasDb: linearToDb(alias / 0.25) }
}

/** Level of a tone the reduced rate can carry through the pre-filter, in dB. */
export const preFilterPassbandDb = async (render: LoFiRender, rate: number, hz: number) => {
  const input = sine(2 * rate, hz, rate, 0.5)
  const output = await render({ bitDepth: 24, sampleRateHz: 12000, noiseDb: -120, preFilter: true }, input)

  return linearToDb(rms(output, rate / 2) / rms(input, rate / 2))
}

/** RMS of (output - input) over RMS of input, in dB, at 24 bit and full rate with inputs up to `amplitude`. */
export const passThroughErrorDb = async (render: LoFiRender, rate: number, amplitude: number) => {
  const input = sine(rate, 997, rate, amplitude)
  const output = await render({ bitDepth: 24, noiseDb: -120, mix: 1 }, input)
  let error = 0

  for (let n = 0; n < input.length; n += 1) error += (output[n] - input[n]) ** 2

  return linearToDb(Math.sqrt(error / input.length) / rms(input))
}

/** Largest output magnitude of a 24 bit full-rate signal that peaks at `amplitude`. */
export const passThroughPeak = async (render: LoFiRender, rate: number, amplitude: number) => peakAbs(await render({ bitDepth: 24, noiseDb: -120, mix: 1 }, sine(rate, 997, rate, amplitude)))

/** Largest magnitude after 1 s of silence through Floor quantization at `bits` bits. */
export const floorSilencePeak = async (render: LoFiRender, rate: number, bits: number, dcCorrection: boolean) => {
  const output = await render({ bitDepth: bits, noiseDb: -120, quantization: 'floor', dcCorrection }, silence(2 * rate))

  return peakAbs(output.subarray(rate))
}

/** Largest bin over the median bin of the error spectrum (output minus input), in dB: how tonal the quantization error is. */
export const errorSpectrumFlatnessDb = async (render: LoFiRender, rate: number, bits: number, dither: string) => {
  const input = sine(4 * rate, 997, rate, 0.5)
  const output = await render({ bitDepth: bits, noiseDb: -120, dither }, input)
  const error = Float32Array.from(output, (value, n) => value - input[n])
  const { bins } = magnitudes(error, rate)
  const sorted = Float64Array.from(bins).sort()

  return linearToDb(sorted[sorted.length - 1] / sorted[sorted.length >> 1])
}

/** Distinct output levels of a 997 Hz sine at `bits` bits (rounded to 1e-6). */
export const distinctLevels = async (render: LoFiRender, rate: number, bits: number) => {
  const output = await render({ bitDepth: bits, noiseDb: -120 }, sine(rate, 997, rate, 0.9))

  return new Set(Array.from(output.subarray(1000), (value) => Math.round(value * 1e6))).size
}

export const randomInput = (rate: number) => noise(2 * rate, 0.4, 3)

/**
 * Group delay of the optional Pre and Post filters in frames of the host rate, at a tone `hz` with the reduced rate `sampleRateHz`: the
 * phase the filter adds to the held output's fundamental (the filtered render against the unfiltered one, which share the same hold
 * grid), differenced over a band of 2 % of the reduced rate around `hz`.
 */
export const filterGroupDelayFrames = async (render: LoFiRender, rate: number, sampleRateHz: number, hz: number, filter: 'preFilter' | 'postFilter') => {
  const band = 0.02 * sampleRateHz
  const frames = Math.ceil(rate * (0.5 + 200 / sampleRateHz))
  const phaseAdded = async (tone: number) => {
    const input = sine(frames, tone, rate, 0.25)
    const state = { bitDepth: 24, sampleRateHz, noiseDb: -120 }
    const [open, filtered] = await Promise.all([render(state, input), render({ ...state, [filter]: true }, input)])
    const from = frames >> 1

    return toneFit(filtered, tone, rate, from).phase - toneFit(open, tone, rate, from).phase
  }
  const [low, high] = await Promise.all([phaseAdded(hz - band / 2), phaseAdded(hz + band / 2)])

  return -((high - low) / (2 * Math.PI * band)) * rate
}
