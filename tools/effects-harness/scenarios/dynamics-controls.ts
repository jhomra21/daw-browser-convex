// Rows for the controls the first dynamics pass left out. Each bar comes from the Live 12 manual's Compressor, Gate and Limiter
// chapters or from the arithmetic of the control (the static curve, a one-pole time constant, a linear blend), never from a render.
import { maxAbsDiff, maxGainStepDb, peakDb, toneGainDb } from '../dsp'
import { declaredLatencyFrames, fx } from '../effects'
import type { EffectSpec } from '../effects'
import type { Harness, Scenario } from '../harness'
import { coherentFrequency, concat, constant, dbToLinear, impulse, linearToDb, noise, silence, sine } from '../signals'
import { parityLimit } from './shared'

const seconds = (h: Harness, value: number) => Math.round(value * h.rate)

/** Gain in dB of `output` against `input` for the tone at `frequency`, over the last second of a 3 s render. */
const settledGain = (h: Harness, input: Float32Array, output: Float32Array, frequency: number) => toneGainDb(input, output, frequency, h.rate, 2 * h.rate, 3 * h.rate)

const gainTrace = (input: Float32Array, output: Float32Array) => Array.from(output, (value, n) => linearToDb(value / input[n]))

/** Milliseconds from `start` until the gain trace has covered `fraction` of the way from `from` to `final`. */
const timeToFraction = (trace: readonly number[], start: number, from: number, final: number, fraction: number, rate: number) => {
  for (let n = start; n < trace.length; n += 1) if ((trace[n] - from) / (final - from) >= fraction) return (n - start) / rate * 1000

  return Infinity
}

const keyedCompressor = (state: Parameters<typeof fx.compressor>[0] = {}) =>
  fx.compressor({ thresholdDb: -30, ratio: 4, kneeDb: 0, attackMs: 10, releaseMs: 120, autoRelease: false, detectorMode: 'peak', ...state })

// Reduction of the static curve above the threshold, in dB: (level - threshold) * (1 - 1 / ratio).
const reduction = (levelDb: number, thresholdDb: number, ratio: number) => (levelDb - thresholdDb) * (1 - 1 / ratio)

const compressorKey: Scenario = {
  effect: 'compressor',
  name: 'c10-external-key',
  run: async (h) => {
    const frames = 3 * h.rate
    const f = coherentFrequency(1000, h.rate, h.rate)
    const quiet = sine(frames, f, h.rate, dbToLinear(-40))
    const keyed = (key: Float32Array) => ({ input: [quiet], key: [key] })
    const loud = [sine(frames, coherentFrequency(440, h.rate, h.rate), h.rate, 0.5)]
    const loudDb = linearToDb(0.5)
    const auto = fx.compressor({ thresholdDb: -24, ratio: 4, kneeDb: 0, autoRelease: false, detectorMode: 'peak', autoMakeup: true })

    // Auto Makeup refills the reduction a 0 dBFS input gets: 24 dB over the threshold at 4:1 is 18 dB.
    const own = await h.render(auto, { input: [quiet] }, { parity: false })
    h.within('Auto Makeup on, no key: gain of a tone 16 dB under the threshold (expected +18)', settledGain(h, quiet, own.output[0], f), reduction(0, -24, 4), 0.2, 'dB')
    const silentKey = await h.render(auto, keyed(silence(frames)))
    h.within('Auto Makeup on, silent external key: gain of the same tone (the key switches Auto Makeup off, expected 0)', settledGain(h, quiet, silentKey.output[0], f), 0, 0.1, 'dB')

    const spec = keyedCompressor()
    const idle = await h.render(spec, { input: [quiet] }, { parity: false })
    h.within('no key: gain of a tone 10 dB under the threshold (expected 0)', settledGain(h, quiet, idle.output[0], f), 0, 0.05, 'dB')
    const compressed = await h.render(spec, keyed(loud[0]))
    h.within('loud key at -6 dBFS, threshold -30, 4:1: gain of a tone under the threshold (expected -18)', settledGain(h, quiet, compressed.output[0], f), -reduction(loudDb, -30, 4), 0.4, 'dB')
    const autoKeyed = await h.render(keyedCompressor({ autoMakeup: true }), keyed(loud[0]), { parity: false })
    h.within('same, Auto Makeup on: the key leaves no makeup in the gain', settledGain(h, quiet, autoKeyed.output[0], f), -reduction(loudDb, -30, 4), 0.4, 'dB')
  },
}

const compressorStereoKey: Scenario = {
  effect: 'compressor',
  name: 'c10-stereo-key',
  run: async (h) => {
    const frames = 3 * h.rate
    const f = coherentFrequency(1000, h.rate, h.rate)
    const quiet = sine(frames, f, h.rate, dbToLinear(-40))
    const spec = keyedCompressor()
    const key = sine(frames, coherentFrequency(440, h.rate, h.rate), h.rate, 0.5)
    const half = key.map((value) => value * 0.5)
    const render = (left: Float32Array, right: Float32Array) => h.render(spec, { input: [quiet], key: [left, right] }, { parity: false })
    const [leftOnly, rightOnly, both, mono] = await Promise.all([render(key, silence(frames)), render(silence(frames), key), render(key, key), render(half, half)])
    const gain = (run: Awaited<ReturnType<typeof render>>) => settledGain(h, quiet, run.output[0], f)

    // The detector listens to the mean of the key's two channels, so a key on one side reads 6 dB lower than the same key on both.
    h.atMost('largest sample difference, key on the left only against the mean on both channels', Math.max(maxAbsDiff(leftOnly.output[0], mono.output[0]), maxAbsDiff(leftOnly.output[1], mono.output[1])), 1e-6, '', 'a left-only key reads as half its level')
    h.within('gain, key on the right only against the left only', gain(rightOnly) - gain(leftOnly), 0, 0.05, 'dB', 'neither channel is ignored')
    h.within('extra reduction of the key on both channels over one channel, 6.02 dB higher at 4:1 (expected 4.52)', gain(leftOnly) - gain(both), reduction(linearToDb(0.5), -30, 4) - reduction(linearToDb(0.25), -30, 4), 0.3, 'dB')
  },
}

/** A DC step from `before` to `after`, settled before it for `settle` seconds; the gain trace in dB and its values around the step. */
const stepGain = async (h: Harness, spec: EffectSpec, before: number, after: number, settle: number, tail: number) => {
  const at = seconds(h, settle)
  const input = concat(constant(at, before), constant(seconds(h, tail), after))
  const { output } = await h.render(spec, { input: [input] }, { parity: false })
  const gain = gainTrace(input, output[0])

  return { gain, at, from: gain[at - 1], final: gain[gain.length - 1], h }
}

type Step = Awaited<ReturnType<typeof stepGain>>

const reach = (step: Step, fraction: number) => timeToFraction(step.gain, step.at, step.from, step.final, fraction, step.h.rate)

/** Time spent between a quarter and three quarters of the way, and the first half of it over the second half. */
const shape = (step: Step) => ({ span: reach(step, 0.75) - reach(step, 0.25), skew: (reach(step, 0.5) - reach(step, 0.25)) / (reach(step, 0.75) - reach(step, 0.5)) })

// A hard 100:1 curve 60 dB under full scale turns a DC level into a fixed gain, so the envelope's path to it is the whole curve.
const envelopeSpec = (envelopeCurve: 'log' | 'linear', attackMs: number, releaseMs: number) =>
  fx.compressor({ thresholdDb: -60, ratio: 100, kneeDb: 0, attackMs, releaseMs, autoRelease: false, detectorMode: 'peak', envelopeCurve })

const compressorEnvelope: Scenario = {
  effect: 'compressor',
  name: 'c11-envelope-times',
  run: async (h) => {
    // First-order curve: 63.2 % of the way after one time constant, and each quarter of the way takes longer than the last by ln ratios.
    const firstOrderSkew = Math.log(0.75 / 0.5) / Math.log(2)
    const attackLog = await stepGain(h, envelopeSpec('log', 50, 120), 1e-4, 0.5, 0.5, 1)
    h.within('log attack 50 ms: time to 63.2 % of the gain reduction', reach(attackLog, 1 - Math.exp(-1)), 50, 2.5, 'ms')
    h.within('log attack: time from 25 to 50 % over 50 to 75 % (first-order: 0.585)', shape(attackLog).skew, firstOrderSkew, 0.06)
    const releaseLog = await stepGain(h, envelopeSpec('log', 10, 400), 0.5, 0.05, 3, 3)
    // The detector lets go of the old peak over the first 15 ms or so, which moves the path by about that much.
    h.within('log release 400 ms: time to 63.2 % of the way back', reach(releaseLog, 1 - Math.exp(-1)), 400, 20, 'ms')
    h.within('log release: time from 25 to 50 % over 50 to 75 % (first-order: 0.585)', shape(releaseLog).skew, firstOrderSkew, 0.1)

    // Linear: the gain moves at a constant dB per ms, so a quarter of the way takes as long as the next, and a slower setting scales the whole path.
    const attackSlow = await stepGain(h, envelopeSpec('linear', 100, 120), 1e-4, 0.5, 0.5, 1)
    const attackFast = await stepGain(h, envelopeSpec('linear', 50, 120), 1e-4, 0.5, 0.5, 1)
    h.within('linear attack: time from 25 to 50 % over 50 to 75 % (constant slope: 1)', shape(attackFast).skew, 1, 0.06)
    h.within('linear attack: 100 ms setting over 50 ms setting, time from 25 to 75 %', shape(attackSlow).span / shape(attackFast).span, 2, 0.1, 'x')
    const releaseSlow = await stepGain(h, envelopeSpec('linear', 10, 400), 0.5, 0.05, 3, 3)
    const releaseFast = await stepGain(h, envelopeSpec('linear', 10, 200), 0.5, 0.05, 3, 3)
    h.within('linear release: time from 25 to 50 % over 50 to 75 % (constant slope: 1)', shape(releaseFast).skew, 1, 0.15)
    h.within('linear release: 400 ms setting over 200 ms setting, time from 25 to 75 %', shape(releaseSlow).span / shape(releaseFast).span, 2, 0.15, 'x')
  },
}

const compressorOutputDryWet: Scenario = {
  effect: 'compressor',
  name: 'c12-output-dry-wet',
  run: async (h) => {
    const frames = 3 * h.rate
    const f = coherentFrequency(1000, h.rate, h.rate)
    const input = sine(frames, f, h.rate, 0.5)
    const gain = async (state: Parameters<typeof fx.compressor>[0]) => {
      const { output } = await h.render(keyedCompressor({ thresholdDb: -24, ...state }), { input: [input] })

      return { output, gain: settledGain(h, input, output[0], f) }
    }

    const compressed = -reduction(linearToDb(0.5), -24, 4)
    h.within('Output 0 dB: gain of a -6 dBFS tone over a -24 dB threshold at 4:1 (expected -13.49)', (await gain({})).gain, compressed, 0.2, 'dB')
    h.within('Output +6 dB: gain', (await gain({ outputDb: 6 })).gain, compressed + 6, 0.1, 'dB')
    h.within('Output -12 dB: gain', (await gain({ outputDb: -12 })).gain, compressed - 12, 0.1, 'dB')
    // Dry/Wet blends the unprocessed and processed signals by amplitude.
    const dry = await gain({ dryWet: 0, outputDb: 6, makeupDb: 6 })
    h.atMost('Dry/Wet 0 %: largest sample difference from the input, with Output and Makeup +6 dB', Math.max(maxAbsDiff(dry.output[0], input), maxAbsDiff(dry.output[1], input)), 1e-6, '', 'only the dry signal reaches the output')
    h.within('Dry/Wet 50 %: gain (half dry, half the -13.49 dB wet)', (await gain({ dryWet: 0.5 })).gain, linearToDb(0.5 + 0.5 * dbToLinear(compressed)), 0.15, 'dB')

    // A half cycle of delay between the paths would cancel part of the blend: the dry path must wait for the lookahead like the wet.
    const low = coherentFrequency(500, h.rate, h.rate)
    const lowTone = sine(frames, low, h.rate, 0.5)
    const { output } = await h.render(keyedCompressor({ thresholdDb: -24, dryWet: 0.5, lookaheadMs: 1 }), { input: [lowTone] })
    h.within('Dry/Wet 50 %, lookahead 1 ms, 500 Hz (half a cycle): gain', settledGain(h, lowTone, output[0], low), linearToDb(0.5 + 0.5 * dbToLinear(compressed)), 0.15, 'dB', 'the dry path is delayed with the wet')
  },
}

const compressorLookaheadTransient: Scenario = {
  effect: 'compressor',
  name: 'c13-lookahead-transient',
  run: async (h) => {
    const at = seconds(h, 0.5)
    const input = impulse(seconds(h, 1), 1, at)
    // The detector holds the click for 5 ms and lets go with a 5 ms constant, so after 10 ms of lookahead it still reads -8.7 dBFS, 21 dB over the threshold.
    const spec = (lookaheadMs: number) => fx.compressor({ thresholdDb: -30, ratio: 10, kneeDb: 0, attackMs: 0.1, releaseMs: 120, autoRelease: false, detectorMode: 'peak', lookaheadMs })
    const caught = await h.render(spec(10), { input: [input] })
    const latency = declaredLatencyFrames(spec(10), h.rate)
    h.atMost('lookahead 10 ms: output at the click\'s first sample, 0 dBFS in', linearToDb(Math.abs(caught.output[0][at + latency])), -15, 'dBFS', 'the gain is down before the click arrives')
    h.atMost('lookahead 10 ms: largest output sample', peakDb(caught.output[0]), -15, 'dBFS')
    const missed = await h.render(spec(0), { input: [input] }, { parity: false })
    h.atLeast('lookahead 0: output at the click\'s first sample', linearToDb(Math.abs(missed.output[0][at])), -8, 'dBFS', 'attack cannot start before the click')
  },
}

const stereoInput = (h: Harness) => [
  sine(2 * h.rate, coherentFrequency(1000, h.rate, h.rate), h.rate, 0.5),
  noise(2 * h.rate, 0.1, 41),
]

// The same state through the worklet and the core with different material on each channel (and on each key channel): a shared
// signal path would hide a channel that the core handles differently.
const stereoParity = (effect: string, name: string, spec: EffectSpec, keyed: boolean): Scenario => ({
  effect,
  name,
  run: async (h) => {
    const key = keyed ? [noise(2 * h.rate, 0.3, 42), sine(2 * h.rate, coherentFrequency(440, h.rate, h.rate), h.rate, 0.1)] : undefined
    const { output, legacy } = await h.render(spec, { input: stereoInput(h), key })

    if (legacy === null) throw new Error(`${effect} has a legacy worklet`)
    h.atMost(`parity, ${name}`, Math.max(maxAbsDiff(output[0], legacy[0]), maxAbsDiff(output[1], legacy[1])), parityLimit, 'abs')
  },
})

const gateKeyed = (state: Parameters<typeof fx.gate>[0] = {}) =>
  fx.gate({ thresholdDb: -40, hysteresisDb: 0, holdMs: 0, attackMs: 1, releaseMs: 5, rangeDb: -60, ...state })

const gateHold: Scenario = {
  effect: 'gate',
  name: 'g6-hold',
  run: async (h) => {
    const frames = seconds(h, 1.5)
    const keyEnds = seconds(h, 0.5)
    const input = constant(frames, 0.003)
    const key = concat(constant(keyEnds, 0.316), silence(frames - keyEnds))

    for (const holdMs of [0, 30, 100]) {
      const spec = gateKeyed({ holdMs, sidechain: { enabled: false, filterType: 'highpass', frequencyHz: 80, q: 0.707, gainDb: 0, mix: 1 } })
      const { output } = await h.render(spec, { input: [input], key: [key] }, { parity: false })
      const closing = gainTrace(input, output[0]).findIndex((gain, n) => n >= keyEnds && gain <= -1)
      // The detector's 4 ms window and the start of the release add a few ms to the Hold.
      h.between(`time the gate stays open after the key ends, hold ${holdMs} ms`, (closing - keyEnds) / h.rate * 1000, holdMs, holdMs + 8, 'ms', 'Hold keeps the gate open once the level has dropped')
    }
  },
}

const gateExpanderRatio: Scenario = {
  effect: 'gate',
  name: 'g7-expander-ratio',
  run: async (h) => {
    const frames = 3 * h.rate
    const f = coherentFrequency(1000, h.rate, h.rate)
    const threshold = -20

    // Below the threshold the output follows thr + ratio * (level - thr): every dB under it costs (ratio - 1) dB of gain, down to the Floor.
    for (const ratio of [1, 2, 4]) {
      for (const level of [-14, -26, -32, -50]) {
        const input = sine(frames, f, h.rate, dbToLinear(level))
        const { output } = await h.render(gateKeyed({ mode: 'expander', thresholdDb: threshold, ratio }), { input: [input] }, { parity: false })
        const expected = level >= threshold ? 0 : Math.max((level - threshold) * (ratio - 1), -60)
        h.within(`expander gain, ${level} dBFS tone, threshold ${threshold}, ratio ${ratio}:1 (expected ${expected})`, settledGain(h, input, output[0], f), expected, 0.3, 'dB')
      }
    }
  },
}

const gateLink: Scenario = {
  effect: 'gate',
  name: 'g8-link',
  run: async (h) => {
    const frames = 3 * h.rate
    const f = coherentFrequency(1000, h.rate, h.rate)
    const input = [sine(frames, f, h.rate, dbToLinear(-10)), sine(frames, f, h.rate, dbToLinear(-60))]

    // At Link 0 each channel reads its own level; at 100 % both read the louder. The quiet right channel sits 20 dB under the threshold,
    // so a 1 % pull toward the left (-50 dBFS) cannot open it and a 50 % pull (-16 dBFS) does.
    for (const [link, leftOpen, rightOpen] of [[0, true, false], [0.01, true, false], [0.5, true, true], [1, true, true]] as const) {
      const { output } = await h.render(gateKeyed({ link }), { input }, { parity: false })
      const left = settledGain(h, input[0], output[0], f)
      const right = settledGain(h, input[1], output[1], f)
      const label = `Link ${link * 100} %`

      if (leftOpen) h.within(`${label}: gain of the loud left channel`, left, 0, 0.3, 'dB')

      if (rightOpen) h.within(`${label}: gain of the quiet right channel`, right, 0, 0.5, 'dB')
      else h.atMost(`${label}: gain of the quiet right channel (floor -60)`, right, -55, 'dB')
    }
  },
}

const gateLookaheadOpens: Scenario = {
  effect: 'gate',
  name: 'g9-lookahead-opens',
  run: async (h) => {
    const at = h.rate
    const input = concat(constant(at, 0.001), constant(at, 0.316))

    // Attack is the time the gain takes to cover the whole 60 dB range, and the lookahead lets it start that long before the transient.
    for (const lookaheadMs of [0, 1, 10] as const) {
      const spec = gateKeyed({ attackMs: 5, lookaheadMs })
      const { output } = await h.render(spec, { input: [input] }, { parity: false })
      const latency = declaredLatencyFrames(spec, h.rate)
      const expected = Math.min(0, -60 + 60 * lookaheadMs / 5)
      h.within(`gain at the first sample of the transient, attack 5 ms, lookahead ${lookaheadMs} ms (expected ${expected})`, linearToDb(output[0][at + latency] / input[at]), expected, 2, 'dB')
    }
  },
}

const gateRmsTiming: Scenario = {
  effect: 'gate',
  name: 'g10-rms-timing',
  run: async (h) => {
    const threshold = 0.01
    const loud = threshold * Math.SQRT2
    const quiet = 0.001
    const edge = seconds(h, 0.5)
    const input = concat(constant(edge, quiet), constant(edge, loud), constant(edge, quiet))
    const frameMs = 1000 / h.rate

    const timeTo = (gain: readonly number[], from: number, open: boolean) =>
      (gain.findIndex((value, n) => n >= from && (open ? value >= -1 : value <= -1)) - from) * frameMs

    for (const detector of ['peak', 'rms'] as const) {
      const spec = gateKeyed({ detector, attackMs: 0.1, releaseMs: 5 })
      const { output } = await h.render(spec, { input: [input] }, { parity: false })
      const gain = gainTrace(input, output[0])
      const opens = timeTo(gain, edge, true)

      // A mean square with a 10 ms constant rises as A^2 (1 - e^(-t/10 ms)): it crosses a threshold 3 dB under A after 10 ms * ln 2.
      // The shortest Attack (0.1 ms) and Release (5 ms) still need 0.1 ms to move the gain by the 1 dB the trace is read at.
      if (detector === 'peak') h.atMost('peak detector: time to open on a step 3 dB over the threshold', opens, 0.5, 'ms')
      else {
        h.within('RMS detector: time to open on a step 3 dB over the threshold (10 ms * ln 2)', opens, 10 * Math.LN2 + 0.1, 0.3 + frameMs, 'ms')
        const closes = timeTo(gain, 2 * edge, false)
        h.within('RMS detector: time to close when the level falls from 3 dB over to 20 dB under', closes, 10 * Math.log((loud ** 2 - quiet ** 2) / (threshold ** 2 - quiet ** 2)) + 0.1, 0.3 + frameMs, 'ms')
      }
    }
  },
}

const limiterLink: Scenario = {
  effect: 'limiter',
  name: 'l6-link',
  run: async (h) => {
    const frames = 3 * h.rate
    const f = coherentFrequency(1000, h.rate, h.rate)
    const input = [sine(frames, f, h.rate, 2), sine(frames, f, h.rate, dbToLinear(-30))]
    const gains = async (link: number) => {
      const { output } = await h.render(fx.limiter({ ceilingDbtp: -1, link }), { input })

      return { left: settledGain(h, input[0], output[0], f), right: settledGain(h, input[1], output[1], f) }
    }

    const independent = await gains(0)
    h.within('Link 0 %: gain of the loud left channel, +6 dBFS into a -1 dBTP ceiling (expected -7.05)', independent.left, -7.05, 0.15, 'dB')
    h.within('Link 0 %: gain of the quiet right channel', independent.right, 0, 0.05, 'dB')
    const linked = await gains(1)
    h.within('Link 100 %: gain difference between the channels', linked.right - linked.left, 0, 0.1, 'dB')
    const half = await gains(0.5)
    h.between('Link 50 %: gain reduction of the quiet channel as a share of the loud one', half.right / independent.left, 0.2, 0.8, '', 'between independent and linked')
  },
}

const limiterAutomation: Scenario = {
  effect: 'limiter',
  name: 'l7-ceiling-gain-steps',
  run: async (h) => {
    const frames = 2 * h.rate
    const frame = Math.floor(h.rate / 128) * 128
    const input = sine(frames, 1000, h.rate, 0.5)
    const spec = fx.limiter({ ceilingDbtp: -1 })
    const latency = await h.latencyFrames(spec)

    for (const [name, set, ceiling] of [['Ceiling -1 to -12 dBTP', { ceilingDbtp: -12 }, -12], ['Gain 0 to +12 dB on a -6 dBFS tone', { gainDb: 12 }, -1]] as const) {
      const { output } = await h.render(spec, { input: [input], steps: [{ frame, set }] }, { parity: false })
      h.atMost(`max gain change per sample around the step, ${name}`, maxGainStepDb(input, output[0], latency, frame - 300, frame + latency + 4800), 0.3, 'dB', 'same bar as the l1 click')
      // The step must have taken effect, or the row would only be measuring a steady gain.
      h.atMost(`output peak after the step, ${name}`, peakDb(output[0].slice(frames - h.rate / 2)), ceiling, 'dBFS')
    }
  },
}

export const dynamicsControls: Scenario[] = [
  compressorKey, compressorStereoKey, compressorEnvelope, compressorOutputDryWet, compressorLookaheadTransient,
  gateHold, gateExpanderRatio, gateLink, gateLookaheadOpens, gateRmsTiming,
  limiterLink, limiterAutomation,
  stereoParity('limiter', 'parity-stereo-link', fx.limiter({ ceilingDbtp: -6, link: 0.5 }), false),
  stereoParity('compressor', 'parity-stereo-key', fx.compressor({ thresholdDb: -30, ratio: 3, kneeDb: 6, autoMakeup: true, makeupDb: 2, lookaheadMs: 1, sidechain: { enabled: true, filterType: 'bandpass', frequencyHz: 800, q: 2 } }), true),
  stereoParity('gate', 'parity-stereo-link-key', fx.gate({ thresholdDb: -30, link: 0.5, mode: 'expander', detector: 'rms', lookaheadMs: 1, sidechain: { enabled: true, filterType: 'bandpass', frequencyHz: 800, q: 2, gainDb: 6, mix: 0.5 } }), true),
]
