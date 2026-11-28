// The Utility acceptance measurements (saturation-utility.md section 3.3), written against a render callback so the same code runs
// against the rebuilt engine and, with a callback that maps the state onto the old fields, against the base commit (a49d9c57)
// for the "before" values.
import { maxAbsDiff, maxStep, peakAbs, rms, toneFit, toneGainDb } from '../dsp'
import { linearToDb, noise, silence, sine, sineWithPeakAt } from '../signals'
import type { ParamStep } from '../types'

export type Stereo = readonly [Float32Array, Float32Array]

export type UtilityRender = (state: Readonly<Record<string, number | string | boolean>>, input: Stereo, steps?: readonly ParamStep[]) => Promise<Stereo>

const aligned = (frame: number) => Math.floor(frame / 128) * 128

const radiansToDegrees = 180 / Math.PI

/** The largest sample-to-sample change of the output after a 0 to -6 dB gain step on a full-scale 100 Hz sine, stepped at its peak (U1). */
export const gainStepChange = async (render: UtilityRender, rate: number) => {
  const frame = aligned(rate)
  const input = sineWithPeakAt(2 * rate, 100, rate, 1, frame)
  const [output] = await render({}, [input, input], [{ frame, set: { gainDb: -6 } }])

  return maxStep(output, frame, frame + 4096)
}

/** A balance or width step at a peak: the same click measure for the other smoothed controls (U1). */
export const controlStepChange = async (render: UtilityRender, rate: number, state: Readonly<Record<string, number | string | boolean>>, set: Readonly<Record<string, number>>) => {
  const frame = aligned(rate)
  const input = sineWithPeakAt(2 * rate, 100, rate, 1, frame)
  const side = input.map((value) => -value)
  const [output] = await render(state, [input, side], [{ frame, set }])

  return maxStep(output, frame, frame + 4096)
}

/** DC blocker off: the output against the input, peak difference over input peak, in dB (U2). */
export const dcOffNullDb = async (render: UtilityRender, rate: number) => {
  const input: Stereo = [noise(2 * rate, 0.25, 5), noise(2 * rate, 0.25, 6)]
  const output = await render({ dcBlock: false }, input)

  return linearToDb(Math.max(maxAbsDiff(output[0], input[0]), maxAbsDiff(output[1], input[1])) / peakAbs(input[0]))
}

/** DC blocker on: the gain and the phase lead of a 40 Hz tone (U2). */
export const dcToneResponse = async (render: UtilityRender, rate: number) => {
  const input = sine(3 * rate, 40, rate, 0.5)
  const [output] = await render({ dcBlock: true }, [input, input])
  const from = rate
  const to = 3 * rate
  const lead = toneFit(output, 40, rate, from, to).phase - toneFit(input, 40, rate, from, to).phase

  return { gainDb: toneGainDb(input, output, 40, rate, from, to), leadDegrees: Math.atan2(Math.sin(lead), Math.cos(lead)) * radiansToDegrees }
}

/** DC blocker on: the peak of a 0.1 constant between 1 s and 2 s after it starts (U2). */
export const dcDecayPeak = async (render: UtilityRender, rate: number) => {
  const input = new Float32Array(2 * rate).fill(0.1)
  const [output] = await render({ dcBlock: true }, [input, input])

  return peakAbs(output.subarray(rate))
}

const floatMin = 1.1754943508222875e-38

/** DC blocker on: a one second noise burst, then 10 s of silence; the nonzero samples below 1e-20, the subnormal ones and the peak from 5 s on (U2). */
export const silenceTail = async (render: UtilityRender, rate: number) => {
  const input = new Float32Array(11 * rate)
  input.set(noise(rate, 0.5, 13))
  const [output] = await render({ dcBlock: true }, [input, input.slice()])
  let tiny = 0
  let subnormal = 0

  for (let n = 5 * rate; n < output.length; n += 1) {
    const magnitude = Math.abs(output[n])

    if (magnitude > 0 && magnitude < 1e-20) tiny += 1

    if (magnitude > 0 && magnitude < floatMin) subnormal += 1
  }

  return { tiny, subnormal, peak: peakAbs(output.subarray(5 * rate)) }
}

const windowStart = (rate: number) => rate

/** Bass Mono: the level of the side signal (L - R) / 2 of an out-of-phase tone, relative to the tone, in dB (U3). */
export const sideLevelDb = async (render: UtilityRender, rate: number, toneHz: number, bassMonoHz: number, extra: Readonly<Record<string, number | string | boolean>> = {}) => {
  const tone = sine(3 * rate, toneHz, rate, 0.5)
  const [left, right] = await render({ bassMono: true, bassMonoHz, ...extra }, [tone, tone.map((value) => -value)])
  const side = Float32Array.from(left, (value, n) => 0.5 * (value - right[n]))

  return linearToDb(toneFit(side, toneHz, rate, windowStart(rate), 3 * rate).amplitude / 0.5)
}

/** Bass Mono: the level of an in-phase tone (a mono sum of the split must equal the input), in dB (U3). */
export const monoLevelDb = async (render: UtilityRender, rate: number, toneHz: number, bassMonoHz: number, extra: Readonly<Record<string, number | string | boolean>> = {}) => {
  const tone = sine(3 * rate, toneHz, rate, 0.5)
  const [left] = await render({ bassMono: true, bassMonoHz, ...extra }, [tone, tone])

  return toneGainDb(tone, left, toneHz, rate, windowStart(rate), 3 * rate)
}

/** The high-pass half of a Linkwitz-Riley split at the cutoff, in dB. */
export const lr4HighPassDb = (toneHz: number, cutoffHz: number) => {
  const x4 = (toneHz / cutoffHz) ** 4

  return linearToDb(x4 / (1 + x4))
}

/** The low-pass half of a Linkwitz-Riley split at the cutoff, in dB. */
export const lr4LowPassDb = (toneHz: number, cutoffHz: number) => linearToDb(1 / (1 + (toneHz / cutoffHz) ** 4))

/** The level of both channels of an equal-tone stereo input after the state, in dB relative to the input (U4). */
export const channelLevelsDb = async (render: UtilityRender, rate: number, state: Readonly<Record<string, number | string | boolean>>) => {
  const tone = sine(2 * rate, 1000, rate, 0.5)
  const [left, right] = await render(state, [tone, tone])

  return [toneGainDb(tone, left, 1000, rate, rate / 2, 2 * rate), toneGainDb(tone, right, 1000, rate, rate / 2, 2 * rate)] as const
}

/** The largest gain, over both channels, any of a sweep of states gives an equal-tone stereo input (U4: nothing may get louder). */
export const loudestOfSweepDb = async (render: UtilityRender, rate: number, key: string, values: readonly number[]) => {
  let loudest = -Infinity

  for (const value of values) loudest = Math.max(loudest, ...(await channelLevelsDb(render, rate, { [key]: value })))

  return loudest
}

/** A left-only tone: the level of the right output relative to the input and the peak of the left output (U4). */
export const leftOnlyMoved = async (render: UtilityRender, rate: number, state: Readonly<Record<string, number | string | boolean>>) => {
  const tone = sine(2 * rate, 1000, rate, 0.5)
  const [left, right] = await render(state, [tone, silence(2 * rate)])

  return { rightDb: toneGainDb(tone, right, 1000, rate, rate / 2, 2 * rate), leftPeak: peakAbs(left.subarray(rate / 2)) }
}

/** The peak of the output of noise at a state, after 0.5 s, for the minimum-gain and mute rows (U5). */
export const silencedPeak = async (render: UtilityRender, rate: number, state: Readonly<Record<string, number | string | boolean>>, steps: readonly ParamStep[] = []) => {
  const input: Stereo = [noise(2 * rate, 0.25, 21), noise(2 * rate, 0.25, 22)]
  const [left, right] = await render(state, input, steps)

  return Math.max(peakAbs(left.subarray(rate)), peakAbs(right.subarray(rate)))
}

/** The gain of a quiet 1 kHz tone at a gain setting, in dB (U5). */
export const toneGainAt = async (render: UtilityRender, rate: number, gainDb: number) => {
  const tone = sine(2 * rate, 1000, rate, 0.01)
  const [left] = await render({ gainDb }, [tone, tone])

  return toneGainDb(tone, left, 1000, rate, rate / 2, 2 * rate)
}

/** Phase L: the largest deviation of the left output from the inverted input and of the right output from the input (U5). */
export const phaseLeftError = async (render: UtilityRender, rate: number) => {
  const input: Stereo = [noise(rate, 0.25, 31), noise(rate, 0.25, 32)]
  const [left, right] = await render({ phaseLeft: true }, input)

  return { left: maxAbsDiff(left, input[0].map((value) => 0 - value)), right: maxAbsDiff(right, input[1]) }
}

/** The ratio of the mid and side signals of an output to those of its stereo input (U6). */
export const midSideRatios = async (render: UtilityRender, rate: number, state: Readonly<Record<string, number | string | boolean>>) => {
  const left = noise(rate, 0.25, 41)
  const right = Float32Array.from(noise(rate, 0.25, 42), (value, n) => 0.5 * value + 0.5 * left[n])
  const [outLeft, outRight] = await render(state, [left, right])
  const mid = (a: Float32Array, b: Float32Array) => Float32Array.from(a, (value, n) => (value + b[n]) * Math.SQRT1_2)
  const side = (a: Float32Array, b: Float32Array) => Float32Array.from(a, (value, n) => (value - b[n]) * Math.SQRT1_2)
  const from = rate / 2

  return {
    mid: rms(mid(outLeft, outRight), from) / rms(mid(left, right), from),
    side: rms(side(outLeft, outRight), from) / rms(side(left, right), from),
  }
}
