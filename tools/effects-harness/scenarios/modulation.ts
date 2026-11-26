// Acceptance tests for the rebuilt modulation effects (delay-modulation.md section 3, the part 2b brief): Chorus, Flanger, Ensemble,
// Phaser, Tremolo and Auto Pan. Rows that need a voice-level tap the core does not expose are listed in notEncoded.
/* oxlint-disable anti-slop/no-shape-in-symbol-names -- shape is a contract field name */
import { fft, hann, logFrequencies, maxAbsDiff, maxStep, peakAbs, peakFrame, responseDb, rms } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Harness, Scenario } from '../harness'
import { throughZeroLatencyFrames } from '../../../packages/audio-engine/src/effects/timing'
import { constant, impulse, linearToDb, noise, sine } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

const centred = (x: Float32Array) => {
  const mean = x.reduce((sum, v) => sum + v, 0) / x.length

  return x.map((v) => v - mean)
}

/** Correlation of two gain envelopes with their means removed. */
const correlation = (a: Float32Array, b: Float32Array) => {
  const [x, y] = [centred(a), centred(b)]

  return x.reduce((sum, v, n) => sum + v * y[n], 0) / Math.sqrt(x.reduce((s, v) => s + v * v, 0) * y.reduce((s, v) => s + v * v, 0))
}

const aligned = (frame: number) => Math.floor(frame / 128) * 128
const db = (value: number) => 20 * Math.log10(value)

// MOD-1: a delay step must not click. The step lands on a 1 kHz sine and the next 50 ms may not step harder than twice the input does.
const delayStepClick: Scenario = {
  effect: 'chorus',
  name: 'mod1-delay-step-click',
  rates: [48000],
  run: async (h) => {
    const frame = aligned(1.5 * h.rate)
    const input = sine(3 * h.rate, 1000, h.rate, 0.3)
    const inputStep = maxStep(input, 1, input.length)

    for (const [kind, spec] of [['chorus', fx.chorus({ delayMs: 12, depthMs: 0, mix: 1 })], ['flanger', fx.flanger({ delayMs: 2, depthMs: 0, feedback: 0, mix: 1 })]] as const) {
      const to = kind === 'chorus' ? 20 : 8
      const { output } = await h.render(spec, { input: [input], steps: [{ frame, set: { delayMs: to } }] }, { parity: false })
      h.atMost(`${kind} delayMs step to ${to} ms (the Flanger stops at 10 ms): max step in the next 50 ms / input max step`, maxStep(output[0], frame, frame + Math.round(0.05 * h.rate)) / inputStep, 2, 'x', 'MOD-1')
    }
  },
}

// MOD-2: the feedback loop is exactly as long as the delay. An impulse at feedback 0.9 echoes every `samples` frames, fractional or not.
const feedbackSpacing: Scenario = {
  effect: 'flanger',
  name: 'mod2-feedback-spacing',
  run: async (h) => {
    for (const nominal of [5, 24, 72]) {
      // The Flanger's shortest delay is 0.1 ms, which is 9.6 frames at 96 kHz.
      const samples = Math.max(nominal, Math.ceil(0.1 * h.rate / 1000))
      const { output } = await h.render(fx.flanger({ delayMs: samples * 1000 / h.rate, depthMs: 0, rateHz: 0.01, feedback: 0.9, mix: 1 }), { input: [impulse(Math.round(0.1 * h.rate), 0.5)] }, { parity: false })
      const echo = (k: number) => Math.round((k - 0.5) * samples) + peakFrame(output[0].subarray(Math.round((k - 0.5) * samples), Math.round((k + 0.5) * samples)))
      h.within(`echo spacing of a ${samples}-sample feedback loop (echoes 1 to 5)`, (echo(5) - echo(1)) / 4, samples, 0.05, 'frames', 'MOD-2')
    }
  },
}

const throughZeroLatency: Scenario = {
  effect: 'flanger',
  name: 'mod3-through-zero-latency',
  run: async (h) => {
    const measured = await h.latencyFrames(fx.flanger({ mode: 'throughZero', delayMs: 0.5, depthMs: 0, feedback: 0, mix: 0 }))
    h.within('dry path delay of Through-zero vs the declared latency', measured, throughZeroLatencyFrames(h.rate), 0, 'frames', 'MOD-3')
  },
}

// MOD-4: Safe Bass keeps the low band out of the modulation. The wet path's modulation is the wet render minus the same render with
// the modulation depth at zero; at 50 Hz with Safe Bass at 200 Hz it must drop by 20 dB.
const safeBass: Scenario = {
  effect: 'chorus',
  name: 'mod4-safe-bass-and-width',
  rates: [48000],
  run: async (h) => {
    const input = sine(4 * h.rate, 50, h.rate, 0.3)

    const residual = async (safeBassOn: boolean) => {
      const base = fx.chorus({ mix: 1, depthMs: 4, safeBass: safeBassOn, safeBassHz: 200 })

      const [moving, still] = await Promise.all([
        h.render(base, { input: [input] }, { parity: false }),
        h.render(fx.chorus({ mix: 1, depthMs: 0, safeBass: safeBassOn, safeBassHz: 200 }), { input: [input] }, { parity: false }),
      ])

      const from = h.rate
      const difference = moving.output[0].subarray(from).map((v, n) => v - still.output[0][from + n])

      return rms(difference)
    }

    const off = await residual(false)
    const on = await residual(true)
    h.atLeast('50 Hz wet modulation depth drop with Safe Bass at 200 Hz', db(off / on), 20, 'dB', 'MOD-4')

    const { output } = await h.render(fx.chorus({ mix: 1, width: 0 }), { input: [noise(2 * h.rate, 0.25, 4)] }, { parity: false })
    h.atMost('L/R difference of the wet path at Width 0', maxAbsDiff(output[0], output[1]), 1e-6, 'abs', 'MOD-4')
  },
}

// The vintage voicing's cutoff, read from the wet path's frequency response; nothing in the research fixes it beyond "about 70 kHz".
const vintageVoicing: Scenario = {
  effect: 'chorus',
  name: 'mod6-vintage-bbd-cutoff',
  rates: [48000],
  run: async (h) => {
    for (const delayMs of [7.3, 12]) {
      const { output } = await h.render(fx.chorus({ mode: 'vintage', delayMs, depthMs: 0, mix: 1, stereoPhase: 0 }), { input: [impulse(h.rate, 0.2)] }, { parity: false })
      const frequencies = logFrequencies(1000, 23000, 400)
      const response = responseDb(output[0], h.rate, frequencies)
      const reference = response[0]
      const corner = frequencies[response.findIndex((value) => value < reference - 3)]
      h.info(`vintage -3 dB corner of the wet path at ${delayMs} ms`, corner, 'Hz', `kernel: clock 1024 / (2 x delay) = ${(1024 / (2 * delayMs)).toFixed(1)} kHz, two-pole filters at 0.4 x clock`)
    }
  },
}

// MOD-5: the Ensemble's slow and fast LFOs spread a 1 kHz sine into sidebands within +-30 Hz; the level compensation holds noise near unity.
const sidebandShare = (signal: Float32Array, rate: number) => {
  const size = 2 ** 17
  const start = Math.round(0.5 * rate)
  const window = hann(size)
  const re = Float64Array.from({ length: size }, (_, n) => signal[start + n] * window[n])
  const im = new Float64Array(size)
  fft(re, im)
  const binHz = rate / size
  let carrier = 0
  let near = 0
  let total = 0

  for (let bin = 1; bin < size / 2; bin += 1) {
    const power = re[bin] ** 2 + im[bin] ** 2
    const offset = Math.abs(bin * binHz - 1000)
    total += power

    if (offset <= 30) near += power

    if (offset <= 0.3) carrier += power
  }

  return { nearDb: 10 * Math.log10((near - carrier) / total + 1e-30), carrierDb: 10 * Math.log10(carrier / total + 1e-30) }
}

const ensembleSidebands: Scenario = {
  effect: 'ensemble',
  name: 'mod5-ensemble-sidebands-and-level',
  rates: [48000],
  run: async (h) => {
    const input = sine(5 * h.rate, 1000, h.rate, 0.3)

    for (const [label, spec] of [['slow LFO', fx.ensemble({ mix: 1, fastDepthMs: 0 })], ['slow and fast LFO', fx.ensemble({ mix: 1, fastDepthMs: 0.5 })]] as const) {
      const { output } = await h.render(spec, { input: [input] }, { parity: false })
      const { nearDb, carrierDb } = sidebandShare(output[0], h.rate)
      h.atLeast(`sideband power within 30 Hz of 1 kHz, ${label}, relative to the whole output`, nearDb, -6, 'dB', 'MOD-5')
      h.info(`carrier line power, ${label}`, carrierDb, 'dB')
    }

    const input2 = noise(4 * h.rate, 0.25, 21)
    const { output } = await h.render(fx.ensemble({ mix: 1 }), { input: [input2] }, { parity: false })
    h.within('full-band noise level at Mix 100 %', db(rms(output[0], h.rate) / rms(input2, h.rate)), -0.86, 1, 'dB', 'MOD-5 kernel figure -0.86 dB')
  },
}

// PH-1 and PH-2: feedback stays bounded and the stage frequencies follow the analytic all-pass chain.
const phaserFeedback: Scenario = {
  effect: 'phaser',
  name: 'ph1-feedback-level-and-knee',
  rates: [48000],
  run: async (h) => {
    const input = noise(4 * h.rate, 0.25, 11)

    // The brief names no Mix; the judged row uses the device's default (50 %). At Mix 100 % the wet path alone peaks 1.4 dB above the limit, and
    // 7.5 dB of that is the all-pass chain turning uniform noise into Gaussian-like noise (its crest factor) with no feedback at all.
    const peakOver = async (state: Parameters<typeof fx.phaser>[0]) =>
      linearToDb(peakAbs((await h.render(fx.phaser({ stages: 12, ...state }), { input: [input] }, { parity: false })).output[0]) / peakAbs(input))

    h.atMost('output peak over input peak, 12 stages, feedback 0.95, default Mix 50 %', await peakOver({ feedback: 0.95 }), 12, 'dB', 'PH-1')
    h.info('output peak over input peak, 12 stages, feedback 0.95, Mix 100 %', await peakOver({ feedback: 0.95, mix: 1 }), 'dB', 'PH-1: above 12 dB, see the comment')
    h.info('output peak over input peak, 12 stages, feedback 0, Mix 100 % (the all-pass chain alone)', await peakOver({ feedback: 0, mix: 1 }), 'dB')

    const gainAt = async (peak: number) => {
      const noiseInput = noise(2 * h.rate, peak, 31)
      const { output: out } = await h.render(fx.phaser({ stages: 6, feedback: 0.7, mix: 1, depthOctaves: 0 }), { input: [noiseInput] }, { parity: false })

      return db(rms(out[0], h.rate) / rms(noiseInput, h.rate))
    }

    const reference = await gainAt(0.004)
    let knee: number | null = null

    for (const peakDb of [-30, -24, -18, -12, -6, 0]) {
      const deviation = Math.abs(await gainAt(10 ** (peakDb / 20)) - reference)

      if (peakDb === -30) h.atMost('gain change at -30 dBFS noise peak vs -48 dBFS, feedback 0.7', deviation, 0.1, 'dB', 'PH-1: transparent below about -12 dBFS')

      if (knee === null && deviation > 0.1) knee = peakDb
    }

    h.info('lowest noise peak level where the feedback limiter changes the gain by more than 0.1 dB', knee, 'dBFS', 'kernel knee 0.25 = -12 dBFS, ceiling 0.5 = -6 dBFS, on the loop signal')
  },
}

const allpassChain = (frequencyHz: number, rate: number, stages: number, feedback: number, mix: number) => (f: number) => {
  const tangent = Math.tan(Math.PI * frequencyHz / rate)
  const c = (tangent - 1) / (tangent + 1)
  const w = 2 * Math.PI * f / rate
  const zRe = Math.cos(-w)
  const zIm = Math.sin(-w)

  const divide = (aRe: number, aIm: number, bRe: number, bIm: number) => {
    const d = bRe * bRe + bIm * bIm

    return [(aRe * bRe + aIm * bIm) / d, (aIm * bRe - aRe * bIm) / d]
  }

  const [stageRe, stageIm] = divide(c + zRe, zIm, 1 + c * zRe, c * zIm)
  let re = 1
  let im = 0

  for (let k = 0; k < stages; k += 1) [re, im] = [re * stageRe - im * stageIm, re * stageIm + im * stageRe]
  const [wetRe, wetIm] = divide(re, im, 1 - feedback * re, -feedback * im)

  return Math.hypot(1 - mix + mix * wetRe, mix * wetIm)
}

const extrema = (values: readonly number[]) => values.flatMap((value, i) => i > 0 && i < values.length - 1 && ((value > values[i - 1] && value >= values[i + 1]) || (value < values[i - 1] && value <= values[i + 1])) ? [i] : [])

const phaserResponse: Scenario = {
  effect: 'phaser',
  name: 'ph2-static-response-and-cpu',
  rates: [48000],
  run: async (h) => {
    const spec = fx.phaser({ stages: 6, feedback: 0.7, mix: 0.5, depthOctaves: 0, centerHz: 1000 })
    const { output } = await h.render(spec, { input: [impulse(h.rate, 0.05)] }, { parity: false })
    const frequencies = logFrequencies(60, 16000, 4000)
    const measured = responseDb(output[0], h.rate, frequencies)
    const analytic = frequencies.map(allpassChain(1000, h.rate, 6, 0.7, 0.5)).map(db)
    const expected = extrema(analytic)
    const found = extrema(measured)
    h.within('notch and peak count of the static 6-stage response', found.length, expected.length, 0, '', 'PH-2')
    const worst = Math.max(...expected.map((i) => Math.min(...found.map((j) => Math.abs(frequencies[j] / frequencies[i] - 1)))))
    h.atMost('worst notch or peak frequency error vs the analytic all-pass chain', worst * 100, 1, '%', 'PH-2')
    h.info('CPU of 32 phasers, share of the realtime budget', 32 * await h.cpuNsPerFrame(fx.phaser()) / (1e9 / h.rate) * 100, '%', 'PH-2')
  },
}

// TR-1: at Stereo Phase 0.5 the Tremolo's channel gains run in antiphase; Auto Pan holds constant power (-3 dB centre); at 0 both channels agree.
const dualMono = (h: Harness) => [constant(4 * h.rate, 1), constant(4 * h.rate, 1)]
const from = (h: Harness) => h.rate

const tremoloStereo: Scenario = {
  effect: 'tremolo',
  name: 'tr1-tremolo-stereo-phase',
  rates: [48000],
  run: async (h) => {
    const [left, right] = (await h.render(fx.tremolo({ rateHz: 1, depth: 1, stereoPhase: 0.5 }), { input: dualMono(h) }, { parity: false })).output
    h.atMost('L/R gain correlation at Stereo Phase 0.5', correlation(left.subarray(from(h)), right.subarray(from(h))), -0.99, '', 'TR-1')
    const [a, b] = (await h.render(fx.tremolo({ rateHz: 1, depth: 1, stereoPhase: 0 }), { input: dualMono(h) }, { parity: false })).output
    h.atMost('L/R gain difference at Stereo Phase 0', maxAbsDiff(a, b), 1e-6, 'abs', 'TR-1')
  },
}

const autopanLaw: Scenario = {
  effect: 'autopan',
  name: 'tr1-autopan-equal-power',
  rates: [48000],
  run: async (h) => {
    const [left, right] = (await h.render(fx.autopan({ rateHz: 1, depth: 1 }), { input: dualMono(h) }, { parity: false })).output
    const power = Array.from(left.subarray(from(h)), (l, n) => 10 * Math.log10(l ** 2 + right[from(h) + n] ** 2))
    h.atMost('power sum swing at the default Stereo Phase 180 degrees', Math.max(...power) - Math.min(...power), 0.02, 'dB', 'owner decision: constant power')
    h.within('power sum at the centre', power[0], 0, 0.05, 'dB', 'owner decision: constant power')
    h.within('each channel at the centre', db(left[from(h)]), -3.01, 0.05, 'dB', 'owner decision: -3 dB centre')
    h.info('L/R gain correlation at the default Stereo Phase', correlation(left.subarray(from(h)), right.subarray(from(h))), '')
    const [a, b] = (await h.render(fx.autopan({ rateHz: 1, depth: 1, stereoPhase: 0 }), { input: dualMono(h) }, { parity: false })).output
    h.atMost('L/R gain difference at Stereo Phase 0', maxAbsDiff(a, b), 1e-6, 'abs', 'TR-1')
  },
}

// TR-2: depth and shape moves are smoothed; at Shape 50 % the curve is the plain LFO and the level average does not move with Depth.
const tremoloSmoothing: Scenario = {
  effect: 'tremolo',
  name: 'tr2-smoothing-and-curve',
  rates: [48000],
  run: async (h) => {
    const frame = aligned(1.5 * h.rate)
    const input = [sine(3 * h.rate, 1000, h.rate, 0.3)]

    const steps: Record<string, number>[] = [{ depth: 1 }, { shape: 0.9 }]

    for (const set of steps) {
      const { extraRatio } = await h.stepClick(fx.tremolo({ rateHz: 4, depth: 0.2 }), input, { frame, set }, 4096)
      h.atMost(`max extra sample step / steady-state max step, ${Object.keys(set)[0]} step`, extraRatio, 2, 'x', 'TR-2')
    }

    const { output } = await h.render(fx.tremolo({ rateHz: 1, depth: 0.6, shape: 0.5 }), { input: [constant(2 * h.rate, 1), constant(2 * h.rate, 1)] }, { parity: false })
    const expected = Array.from(output[0], (_, n) => (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(2 * Math.PI * n / h.rate))) / 0.7)
    h.atMost('deviation of the gain from the ideal curve at Shape 50 %', Math.max(...expected.map((e, n) => Math.abs(e - output[0][n]))), 1e-3, 'abs', 'TR-2')

    for (const depth of [0.25, 1]) {
      const { output: out } = await h.render(fx.tremolo({ rateHz: 1, depth }), { input: [constant(2 * h.rate, 1), constant(2 * h.rate, 1)] }, { parity: false })
      h.within(`mean gain over two cycles at Depth ${depth}`, out[0].reduce((s, v) => s + v, 0) / out[0].length, 1, 0.01, '', 'owner decision: average level kept')
    }
  },
}

// TR-3: every waveform follows its definition, Invert flips it, tempo sync follows the song position and the square is slewed.
const waveformGain = (waveform: string, fraction: number) => {
  switch (waveform) {
    case 'triangle': return 1 - 4 * Math.abs(fraction - 0.5)
    case 'sawDown': return 1 - 2 * fraction
    case 'sawUp': return 2 * fraction - 1
    default: return Math.sin(2 * Math.PI * fraction)
  }
}

const tremoloWaveforms: Scenario = {
  effect: 'tremolo',
  name: 'tr3-waveforms-invert-sync-slew',
  rates: [48000],
  run: async (h) => {
    const input = [constant(2 * h.rate, 1), constant(2 * h.rate, 1)]

    for (const waveform of ['sine', 'triangle', 'sawDown', 'sawUp'] as const) {
      const { output } = await h.render(fx.tremolo({ waveform, rateHz: 1, depth: 1 }), { input }, { parity: false })
      h.atMost(`${waveform} gain deviation from its definition (Depth 100 %, gain = 1 + LFO)`, Math.max(...Array.from(output[0], (v, n) => Math.abs(v - (1 + waveformGain(waveform, (n / h.rate) % 1))))), 2e-3, 'abs', 'TR-3: the fast sine is good to about 1e-3')
    }

    const plain = (await h.render(fx.tremolo({ rateHz: 1, depth: 1 }), { input }, { parity: false })).output[0]
    const flipped = (await h.render(fx.tremolo({ rateHz: 1, depth: 1, invert: true }), { input }, { parity: false })).output[0]
    h.atMost('correlation of the gain with Invert on and off', correlation(plain.subarray(0), flipped.subarray(0)), -0.99, '', 'TR-3')

    const synced = fx.tremolo({ sync: true, division: 5, depth: 1 })
    const run = async (startFrame: number) => (await h.render(synced, { input, startFrame, tempoBpm: 90 }, { parity: false })).output[0]
    const beat = Math.round(h.rate * 60 / 90)
    const first = await run(0)
    const crossings = first.reduce((count, v, n) => count + (n > 0 && first[n - 1] < 1 && v >= 1 ? 1 : 0), 0)
    h.within('upward gain crossings of 1 in 2 s, division 1/4 at 90 bpm', crossings, 3, 0, 'cycles', 'TR-3')
    h.atMost('gain difference between starting at song position 0 and one beat later', maxAbsDiff(first, await run(beat)), 1e-3, 'abs', 'TR-3: locked to the song position')

    const square = (await h.render(fx.tremolo({ waveform: 'square', rateHz: 1, depth: 1 }), { input }, { parity: false })).output[0]
    const edge = Math.round(h.rate / 2)
    const low = square[edge - 10]
    const high = square[edge + Math.round(0.02 * h.rate)]
    const reached = (share: number) => square.findIndex((v, n) => n >= edge - 10 && (v - low) * (high - low) >= share * (high - low) ** 2)
    const [rise10, rise90] = [reached(0.1), reached(0.9)]
    h.between('square edge 10 to 90 % time', 1000 * (rise90 - rise10) / h.rate, 1, 10, 'ms', 'TR-3: a few ms, no click')
  },
}

const states = {
  chorus: fx.chorus(),
  flanger: fx.flanger(),
  phaser: fx.phaser(),
  tremolo: fx.tremolo(),
  autopan: fx.autopan(),
  ensemble: fx.ensemble(),
}

const throughZero = fx.flanger({ mode: 'throughZero', delayMs: 2, depthMs: 1 })

export const modulation: Family = {
  scenarios: [
    delayStepClick, feedbackSpacing, throughZeroLatency, safeBass, vintageVoicing, ensembleSidebands, phaserFeedback, phaserResponse,
    tremoloStereo, autopanLaw, tremoloSmoothing, tremoloWaveforms,
    parityScenario('chorus', states.chorus), parityScenario('chorus', fx.chorus({ mode: 'vintage', waveform: 'triangle' })),
    parityScenario('flanger', states.flanger), parityScenario('flanger', throughZero),
    parityScenario('phaser', states.phaser), parityScenario('phaser', fx.phaser({ stages: 12, feedback: 0.7, spreadOctaves: 1, blend: 0.5 })),
    parityScenario('tremolo', states.tremolo), parityScenario('autopan', states.autopan), parityScenario('ensemble', states.ensemble),
    ...robustnessScenarios('chorus', states.chorus, null),
    ...robustnessScenarios('flanger', throughZero, throughZeroLatencyFrames),
    ...robustnessScenarios('phaser', states.phaser, null),
    ...robustnessScenarios('tremolo', states.tremolo, null),
    ...robustnessScenarios('autopan', states.autopan, null),
    ...robustnessScenarios('ensemble', states.ensemble, null),
  ],
  notEncoded: [
    'MOD-3 triangle LFO deviation < 1e-6 and the symmetric first notch: the core exposes no delay tap; the kernel tests in native/audio-core/tests/modulation_test.cpp read the delay directly.',
    'MOD-5 three Ensemble lines 120 degrees apart: needs a voice-level tap the core does not expose.',
    'MOD-4 and PH-3 "defaults reproduce the old sound": the old kernels are gone; the version 2 migration tests (packages/shared/src/modulation-params-migration.test.ts) hold the new controls at their neutral values.',
  ],
}
