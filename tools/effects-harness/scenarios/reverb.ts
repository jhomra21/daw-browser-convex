// Acceptance tests from reverb.md section 3: M1 (per-band T30, independent input filter), M2 (click-free parameter moves),
// M3 (fine structure, Spin pitch), M4 (parity), S1/S2 (echo density, autocorrelation), S3 (Freeze), S4 (width), S5 (early
// reflections), S6 (Chorus), S8 (sample-rate-aware buffers), C4 (level versus size), C5 (DC).
import { normalizeAudioEffect } from '../../../packages/shared/src/audio-effect-normalization'
import { migrateReverbParamsV1 } from '../../../packages/shared/src/reverb-params-migration'
import { autocorrelationPeak, bandpass, correlation, echoDensity, fineStructure, maxAbsDiff, nextPowerOfTwo, peakAbs, maxStep, pitchDeviationCents, rms, schroederRt, schroederT30, spectrum } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Harness, Scenario } from '../harness'
import { concat, constant, impulse, linearToDb, noise, silence, sine } from '../signals'
import { parityFixtures, parityLimit, robustnessScenarios } from './shared'

const bands = [125, 250, 500, 1000, 2000, 4000, 8000]

const impulseResponse = async (h: Harness, state: Parameters<typeof fx.reverb>[0], seconds: number, parity = false) => {
  const input = impulse(Math.round(seconds * h.rate))
  const { output } = await h.render(fx.reverb({ wet: 1, ...state }), { input: [input] }, { parity })

  return output
}

const energy = (output: readonly Float32Array[]) => output[0].reduce((sum, v, n) => sum + v * v + output[1][n] * output[1][n], 0)

const t30Bands = (output: readonly Float32Array[], rate: number) => {
  const mono = output[0].map((v, n) => v + output[1][n])

  return bands.map((band) => schroederT30(bandpass(mono, band, rate), rate))
}

// Magnitude response of a short window in 1/6-octave power bands: the deepest band under the mean level of the octave around it.
const deepestNotchDb = (window: Float32Array, rate: number) => {
  const size = nextPowerOfTwo(window.length * 4)
  const { re, im } = spectrum(window, size)
  const edges: number[] = []

  for (let hz = 200; hz < 8000; hz *= 2 ** (1 / 6)) edges.push(hz)

  const levels = edges.map((low) => {
    const first = Math.floor(low * size / rate)
    const last = Math.max(first + 1, Math.floor(low * 2 ** (1 / 6) * size / rate))
    let power = 0

    for (let bin = first; bin < last; bin += 1) power += re[bin] ** 2 + im[bin] ** 2

    return 10 * Math.log10(power / (last - first) + 1e-30)
  })

  let deepest = 0

  levels.forEach((level, i) => {
    const around = levels.slice(Math.max(0, i - 3), Math.min(levels.length, i + 4))
    deepest = Math.max(deepest, around.reduce((sum, value) => sum + value, 0) / around.length - level)
  })

  return deepest
}

const bandNote = (ratios: readonly number[]) => bands.map((band, i) => `${band}:${ratios[i].toFixed(2)}`).join(' ')

const decayAccuracy: Scenario = {
  effect: 'reverb',
  name: 'm1-t30-per-octave-band',
  rates: [48000],
  run: async (h) => {
    for (const decaySec of [0.3, 1, 2.2, 5, 12]) {
      const ratios = t30Bands(await impulseResponse(h, { decaySec }, decaySec * 1.6 + 1), h.rate).map((t30) => t30 / decaySec)
      h.atMost(`worst octave-band T30 deviation from the decay knob, ${decaySec} s`, Math.max(...ratios.map((ratio) => Math.abs(ratio - 1))) * 100, 10, '%', `T30/decay by band ${bandNote(ratios)}`)
    }

    const plain = t30Bands(await impulseResponse(h, { decaySec: 2.2 }, 8), h.rate)
    const cut = t30Bands(await impulseResponse(h, { decaySec: 2.2, lowCutHz: 1000 }, 8), h.rate)
    h.atMost('8 kHz T30 change from an input low cut at 1 kHz', Math.abs(cut[6] / plain[6] - 1) * 100, 5, '%', 'M1: input filters must not shorten the decay')
  },
}

// The decay design (reverb_kernel.h design()) gives every line a first-order shelf whose gain at the band edge cancels
// (1 - 1/ratio) of the line's per-trip loss. This is the T30 that follows from it, from the shelf's own response at the band
// frequency, averaged over the High lines at Size 0.65 and 48 kHz; the measured T30 is a separate render.
const lineFrames48k = [503, 631, 773, 919, 1069, 1217, 1373, 1531, 1693, 1861, 2039, 2213, 2393, 2579, 2777, 3011]

const predictedShelfT30 = (decaySec: number, shelfHz: number, shelfDb: number, atHz: number, rate: number) => {
  const tangent = Math.tan(Math.PI * shelfHz / rate)
  const omega = 2 * Math.PI * atHz / rate
  const ratio = 10 ** (shelfDb / 20)

  const decayRates = lineFrames48k.map((base) => {
    const frames = base * (0.7 + 0.5 * 0.65) * rate / 48000
    const lossDb = 60 * frames / (rate * decaySec)
    const q = 10 ** (lossDb * (1 - 1 / ratio) / 40)
    const den = 1 + tangent * q
    const [b0, b1, a1] = [q * q * (1 + tangent / q) / den, q * q * (tangent / q - 1) / den, (tangent * q - 1) / den]
    const gainDb = 10 * Math.log10(((b0 + b1 * Math.cos(omega)) ** 2 + (b1 * Math.sin(omega)) ** 2) / ((1 + a1 * Math.cos(omega)) ** 2 + (a1 * Math.sin(omega)) ** 2))

    return 60 / decaySec - gainDb * rate / frames
  })

  return 60 / (decayRates.reduce((sum, value) => sum + value, 0) / decayRates.length)
}

const shelfDecay: Scenario = {
  effect: 'reverb',
  name: 'm1-shelf-t30',
  rates: [48000],
  run: async (h) => {
    for (const shelfDb of [6, -6]) {
      const t30 = t30Bands(await impulseResponse(h, { decaySec: 2.2, highShelfHz: 4000, highShelfDb: shelfDb }, 9), h.rate)
      const predicted = predictedShelfT30(2.2, 4000, shelfDb, 8000, h.rate)
      h.within(`8 kHz T30 / predicted with a ${shelfDb} dB high shelf at 4 kHz`, t30[6] / predicted, 1, 0.15, 'x', `measured ${t30[6].toFixed(2)} s, predicted ${predicted.toFixed(2)} s`)
      h.within(`125 Hz T30 / decay knob with a ${shelfDb} dB high shelf`, t30[0] / 2.2, 1, 0.15, 'x', 'the high shelf leaves the low band alone (the 500 Hz band is skewed by the longer high-band tail in its skirts)')
    }

    const lowShelf = t30Bands(await impulseResponse(h, { decaySec: 2.2, lowShelfHz: 200, lowShelfDb: 6 }, 9), h.rate)
    h.info('125 Hz T30 with a 6 dB low shelf at 200 Hz', lowShelf[0], 's', `flat is about 2.2 s; 1 kHz band ${lowShelf[3].toFixed(2)} s`)
  },
}

const chorusDecay: Scenario = {
  effect: 'reverb',
  name: 's6-chorus-decay',
  rates: [48000],
  run: async (h) => {
    const on = t30Bands(await impulseResponse(h, { decaySec: 2.2, chorus: true, chorusAmountMs: 5, chorusRateHz: 2 }, 8), h.rate)
    const off = t30Bands(await impulseResponse(h, { decaySec: 2.2, chorus: false }, 8), h.rate)
    h.within('8 kHz T30, Chorus on at its extremes / Chorus off', on[6] / off[6], 1, 0.1, 'x', 'S6: the modulated read must not cost loop gain')
    h.within('1 kHz T30, Chorus on at its extremes / Chorus off', on[3] / off[3], 1, 0.1, 'x')
  },
}

const decayAcrossRates: Scenario = {
  effect: 'reverb',
  name: 'd1-decay-across-rates',
  run: async (h) => {
    const t30 = t30Bands(await impulseResponse(h, { decaySec: 2.2 }, 8), h.rate)
    h.within('500 Hz band T30 / decay knob, 2.2 s', t30[2] / 2.2, 1, 0.1, 'x')
    h.info('125 Hz band T30', t30[0], 's')
    h.info('8 kHz band T30', t30[6], 's')
  },
}

const density: Scenario = {
  effect: 'reverb',
  name: 's1-echo-density-and-fine-structure',
  run: async (h) => {
    const output = await impulseResponse(h, { reflections: 0 }, 3, true)
    const left = output[0]
    const ms = (value: number) => Math.round(value * h.rate / 1000)
    h.atLeast('echo density 30-80 ms', echoDensity(left, ms(30), ms(80), ms(10)), 0.7, '', 'S2')
    h.atLeast('echo density 80-250 ms', echoDensity(left, ms(80), ms(250), ms(20)), 0.9, '', 'S1/S2')
    const { stdDb, peakDb } = fineStructure(left, h.rate)
    h.atMost('fine-structure std, 200 Hz to 8 kHz, 100 ms to 1.4 s', stdDb, 7, 'dB', 'M3; ideal diffuse field about 5.6 dB')
    h.info('fine-structure max peak over band mean', peakDb, 'dB')
    h.atMost('autocorrelation peak, lags 20-100 ms', autocorrelationPeak(left, ms(150), ms(500), ms(20), ms(100)), 0.2, '', 'S2')
    await h.wav('impulse-response', output)
  },
}

// The early reflections are a fixed number of echoes (256 per channel), so the sample-counted echo density of the window
// halves each time the rate doubles. It is judged at the rates the research measured (44.1 and 48 kHz) and reported above.
const earlyReflections: Scenario = {
  effect: 'reverb',
  name: 's5-early-reflection-density',
  rates: [44100, 48000],
  run: async (h) => {
    const output = await impulseResponse(h, { reflections: 1, diffuse: 0, preDelayMs: 0 }, 0.4)
    const ms = (value: number) => Math.round(value * h.rate / 1000)
    h.atLeast('echo density of the early-reflection window, 0-80 ms', echoDensity(output[0], 0, ms(80), ms(10)), 0.3, '', 'S5')
    h.atMost('deepest 1/6-octave notch in the first 80 ms, 200 Hz to 8 kHz', deepestNotchDb(output[0].subarray(0, ms(80)), h.rate), 12, 'dB', 'S5: no comb notch deeper than 12 dB; a notch is a band under the mean of the octave around it')
  },
}

const earlyReflectionsHighRates: Scenario = {
  effect: 'reverb',
  name: 's5-early-reflection-density-high-rates',
  rates: [96000, 192000],
  run: async (h) => {
    const output = await impulseResponse(h, { reflections: 1, diffuse: 0, preDelayMs: 0 }, 0.4)
    const ms = (value: number) => Math.round(value * h.rate / 1000)
    h.info('echo density of the early-reflection window, 0-80 ms', echoDensity(output[0], 0, ms(80), ms(10)), '', 'sample-counted, so it falls with the rate; judged at 44.1 and 48 kHz')
  },
}

const stepClicks: Scenario = {
  effect: 'reverb',
  name: 'm2-parameter-step-click',
  run: async (h) => {
    const frames = 3 * h.rate
    const frame = Math.floor(1.5 * h.rate / 128) * 128
    const input = [sine(frames, 440, h.rate, 0.3)]

    const cases: [string, Parameters<typeof fx.reverb>[0], Record<string, number>][] = [
      ['size 0.65 to 0.70', {}, { size: 0.7 }],
      ['size 0 to 1', { size: 0 }, { size: 1 }],
      ['pre-delay 20 to 123.7 ms', {}, { preDelayMs: 123.7 }],
      ['width 1 to 0', {}, { stereoWidth: 0 }],
    ]

    for (const [name, state, set] of cases) {
      const { extraRatio, stepped } = await h.stepClick(fx.reverb({ wet: 1, reflections: 0.5, ...state }), input, { frame, set }, 2048)
      h.atMost(`max extra sample step / steady-state max step, ${name}`, extraRatio, 1.5, 'x', 'report: 17x size, 5.3x pre-delay, 3.3x width')

      if (name.startsWith('size 0.65')) await h.wav('size-step', stepped.output)
    }
  },
}

// A 2 s sweep of one control applied block by block (the way an automation envelope reaches the core and the worklet): no block may
// hold a sample step more than twice what its neighbours hold. `parity` also renders the worklet, which takes the same steps.
const sweepControl = async (h: Harness, state: Parameters<typeof fx.reverb>[0], valueAt: (progress: number) => Record<string, number>, parity: boolean) => {
  const block = 128
  const frames = 4 * h.rate
  const first = Math.round(h.rate / block) * block
  const blocks = Math.round(2 * h.rate / block)
  const steps = Array.from({ length: blocks }, (_, index) => ({ frame: first + index * block, set: valueAt((index + 1) / blocks) }))
  const { output, legacy } = await h.render(fx.reverb({ wet: 1, reflections: 0.5, ...state }), { input: [sine(frames, 440, h.rate, 0.3)], steps }, { parity })
  const largest = Array.from({ length: blocks }, (_, index) => maxStep(output[0], first + index * block, first + (index + 1) * block))

  const worst = Math.max(...largest.map((value, index) => {
    const neighbours = [...largest.slice(Math.max(0, index - 4), index), ...largest.slice(index + 1, index + 5)]

    return value / (neighbours.reduce((sum, neighbour) => sum + neighbour, 0) / neighbours.length)
  }))

  return { worst, output, legacy }
}

const sizeSweep: Scenario = {
  effect: 'reverb',
  name: 'm2-size-sweep',
  rates: [48000],
  run: async (h) => {
    const { worst } = await sweepControl(h, { size: 0 }, (progress) => ({ size: progress }), false)
    h.atMost('largest sample step of a block / mean of its neighbours, size 0 to 1 over 2 s', worst, 2, 'x', 'M2')
  },
}

// Decay and Size automation: the envelope's values reach the core as parameter targets and the worklet as AudioParam values,
// and both must render the same tail without a click.
const automationSweep: Scenario = {
  effect: 'reverb',
  name: 'm2-decay-size-automation',
  rates: [48000],
  run: async (h) => {
    const sweeps: [string, Parameters<typeof fx.reverb>[0], (progress: number) => Record<string, number>][] = [
      ['decay 0.5 to 8 s', { decaySec: 0.5 }, (progress) => ({ decaySec: 0.5 * 16 ** progress })],
      ['size 0 to 1', { size: 0 }, (progress) => ({ size: progress })],
      ['decay 8 to 0.5 s with size 1 to 0', { decaySec: 8, size: 1 }, (progress) => ({ decaySec: 8 / 16 ** progress, size: 1 - progress })],
    ]

    for (const [name, state, valueAt] of sweeps) {
      const { worst, output, legacy } = await sweepControl(h, state, valueAt, true)

      if (legacy === null) throw new Error('the reverb worklet must render for parity')
      h.atMost(`largest sample step of a block / mean of its neighbours, ${name} over 2 s`, worst, 2, 'x', 'M2')
      h.atMost(`parity of the core and the worklet, ${name} automated block by block`, Math.max(maxAbsDiff(output[0], legacy[0]), maxAbsDiff(output[1], legacy[1])), parityLimit, 'abs')
    }

    const input = [sine(3 * h.rate, 440, h.rate, 0.3)]
    const frame = Math.floor(1.5 * h.rate / 128) * 128

    for (const [name, set] of [['decay 2.2 to 8 s', { decaySec: 8 }], ['size 0.65 to 0', { size: 0 }]] as const) {
      const { extraRatio } = await h.stepClick(fx.reverb({ wet: 1, reflections: 0.5 }), input, { frame, set }, 2048)
      h.atMost(`max extra sample step / steady-state max step, ${name}`, extraRatio, 1.5, 'x', 'M2')
    }
  },
}

const width: Scenario = {
  effect: 'reverb',
  name: 's4-stereo-width',
  rates: [48000],
  run: async (h) => {
    const widths = [0, 30, 60, 100, 120]
    const results = await Promise.all(widths.map((stereoWidth) => impulseResponse(h, { stereoWidth }, 6)))
    const reference = energy(results[3])
    const from = Math.round(0.1 * h.rate)
    const correlations = results.map((output) => correlation(output[0], output[1], from))

    widths.forEach((stereoWidth, i) => h.atMost(`tail energy vs the default 100 degrees, ${stereoWidth} degrees`, Math.abs(linearToDb(Math.sqrt(energy(results[i]) / reference))), 1, 'dB'))
    h.atLeast('lowest L/R correlation over 0 to 120 degrees', Math.min(...correlations), -0.1, '', `at ${widths.join(' ')} degrees: ${correlations.map((c) => c.toFixed(2)).join(' ')}`)
    h.flag('correlation falls monotonically with the angle', correlations.every((c, i) => i === 0 || c <= correlations[i - 1] + 1e-3), 'non-increasing')
  },
}

const sizeLoudness: Scenario = {
  effect: 'reverb',
  name: 'c4-size-loudness',
  rates: [48000],
  run: async (h) => {
    const reference = energy(await impulseResponse(h, { size: 0.65 }, 6))

    for (const size of [0, 1]) h.atMost(`tail energy vs size 0.65, size ${size}`, Math.abs(linearToDb(Math.sqrt(energy(await impulseResponse(h, { size }, 6)) / reference))), 1, 'dB', 'report: +1.9 dB at size 0')
  },
}

// The reflections are a cascade of delay stages, no longer separate taps, so the spread is the time from the first echo to the
// last one above 0.1 % of the peak. At every rate it has to span the same milliseconds, starting at the pre-delay.
const predelayClamp: Scenario = {
  effect: 'reverb',
  name: 's8-predelay-tap-spread',
  rates: [44100, 48000, 96000, 192000],
  run: async (h) => {
    const output = await impulseResponse(h, { reflections: 1, preDelayMs: 250, diffuse: 0 }, 0.6)
    const floor = 1e-3 * peakAbs(output[0])
    const echoes = Array.from(output[0]).flatMap((value, n) => Math.abs(value) > floor ? [n / h.rate * 1000] : [])
    h.within('first early reflection at 250 ms pre-delay', echoes[0], 250, 1, 'ms')
    h.atLeast('early-reflection spread at 250 ms pre-delay', echoes[echoes.length - 1] - echoes[0], 20, 'ms', 'report: 0 ms at 96 kHz, 34 ms at 48 kHz')
  },
}

const spinPitch: Scenario = {
  effect: 'reverb',
  name: 'm3-spin-pitch-deviation',
  rates: [48000],
  run: async (h) => {
    const f = 1000

    const deviation = async (state: Parameters<typeof fx.reverb>[0]) => {
      const { output } = await h.render(fx.reverb({ wet: 1, reflections: 1, reflectionSpin: true, reflectionModAmountMs: 17.5, reflectionModRateHz: 0.3, ...state }), { input: [sine(5 * h.rate, f, h.rate, 0.3)] }, { parity: false })

      return pitchDeviationCents(output[0], f, h.rate, 2 * h.rate, 5 * h.rate)
    }

    // Spin moves only the early reflections. The tail's own Chorus is separate and bends the pitch of a held tone by design,
    // so Spin is isolated with Chorus off and the default Chorus is reported next to it.
    h.atMost('wet 1 kHz pitch deviation with Spin on, Chorus off', await deviation({ chorus: false }), 3, 'cents', 'report: about 28 cents peak')
    h.info('wet 1 kHz pitch deviation with Spin on, default Chorus', await deviation({}), 'cents', 'the Chorus modulation of the tail lines, not Spin')
    h.info('wet 1 kHz pitch deviation with Spin off, default Chorus', await deviation({ reflectionSpin: false }), 'cents')
  },
}

const freezeDrift: Scenario = {
  effect: 'reverb',
  name: 's3-freeze',
  rates: [48000],
  run: async (h) => {
    const seconds = 30
    const burst = concat(noise(Math.round(0.5 * h.rate), 0.25, 9), silence(seconds * h.rate - Math.round(0.5 * h.rate)))
    const level = (output: readonly Float32Array[], from: number, to: number) => linearToDb(rms(output[0], Math.round(from * h.rate), Math.round(to * h.rate)))

    for (const [name, state] of [['Flat', { flat: true }], ['shelves on, 6 dB cut at 5 kHz', { highShelfDb: -6 }]] as const) {
      const { output } = await h.render(fx.reverb({ wet: 1, reflections: 0, freeze: true, ...state }), { input: [burst] }, { parity: false })
      const drift = level(output, 25, 30) - level(output, 3, 8)

      if (name === 'Flat') h.atMost('level drift of a frozen tail between 3-8 s and 25-30 s, Flat', Math.abs(drift), 0.5, 'dB', 'S3')
      else h.info(`level drift of a frozen tail between 3-8 s and 25-30 s, ${name}`, drift, 'dB', 'the shelves keep acting unless Flat is on')
    }

    const held = await impulseResponse(h, { reflections: 0, freeze: true }, 3)
    const cut = await impulseResponse(h, { reflections: 0, freeze: true, cut: true }, 3)
    const after = (output: readonly Float32Array[]) => peakAbs(output[0].subarray(Math.round(0.3 * h.rate)))
    h.atMost('Freeze with Cut: impulse level after 300 ms (diffuser spread and DC blocker settled) vs the same impulse frozen without Cut', linearToDb(after(cut) / after(held)), -80, 'dB', 'S3')
    h.atLeast('Freeze without Cut keeps ringing 3 s after the impulse', linearToDb(rms(held[0], 2 * h.rate, 3 * h.rate) / peakAbs(held[0])), -40, 'dB')
  },
}

// The version 1 state every reference below was measured with, wet 1 (the base commit's defaults except for Wet).
const oldState = {
  enabled: true, wet: 1, decaySec: 2.2, preDelayMs: 20, reflections: 0, reflectionSpin: true, reflectionModAmountMs: 17.5, reflectionModRateHz: 0.3,
  'reflectionShape': 0.5, diffuse: 1, size: 0.65, diffusion: 0.75, density: 0.8, lowCutHz: 20, highCutHz: 20000, diffusionLowCutHz: 20, diffusionHighCutHz: 20000, stereoWidth: 1,
}

const migrated = (old: Partial<typeof oldState>) => normalizeAudioEffect('reverb', migrateReverbParamsV1({ ...oldState, ...old })).params

// Total wet energy of the old engine (impulse, wet 1, 6 s, both channels) and of its first 300 ms, measured on the base commit's
// worklet: git show 61600d21:public/audio-worklets/daw-reverb-processor-v1.js, rendered at 48 kHz with the research script
// acceptance-reports/effects-research-2026-11-23/reverb-measure/lib.cjs pointed at that copy.
const oldLoudness: [string, Partial<typeof oldState>, number, number][] = [
  ['old defaults', {}, 0.4715, 0.4135],
  ['size 0', { size: 0 }, 0.6428, 0.5773],
  ['size 1', { size: 1 }, 0.4077, 0.3536],
  ['decay 0.5 s', { decaySec: 0.5 }, 0.0850, 0.0850],
  ['decay 8 s', { decaySec: 8 }, 1.2102, 0.6898],
  ['width 0', { stereoWidth: 0 }, 0.2604, 0.2271],
  ['width 2', { stereoWidth: 2 }, 1.1051, 0.9727],
  ['reflections 1, shape 0.2', { reflections: 1, 'reflectionShape': 0.2 }, 1.2173, 1.1875],
]

const energyBetween = (output: readonly Float32Array[], from: number, to: number) => {
  let sum = 0

  for (let n = from; n < to; n += 1) sum += output[0][n] ** 2 + output[1][n] ** 2

  return sum
}

const loudnessDb = (output: readonly Float32Array[], from: number, to: number, reference: number) => 10 * Math.log10(energyBetween(output, from, to) / reference)

const migratedLoudness: Scenario = {
  effect: 'reverb',
  name: 'migration-loudness',
  rates: [48000],
  run: async (h) => {
    const early = Math.round(0.3 * h.rate)

    for (const [name, old, total, first] of oldLoudness) {
      const output = await impulseResponse(h, migrated(old), 6)
      h.atMost(`total wet energy of a migrated project against the old engine, ${name}`, Math.abs(loudnessDb(output, 0, output[0].length, total)), 1.5, 'dB', `old ${total} (impulse, wet 1, 6 s)`)
      h.atMost(`first 300 ms of a migrated project against the old engine, ${name}`, Math.abs(loudnessDb(output, 0, early, first)), 2, 'dB', `old ${first}`)
    }

    const output = await impulseResponse(h, {}, 6)
    h.atMost('total wet energy of a new device (High, Chorus, Reflect) against the old defaults', Math.abs(loudnessDb(output, 0, output[0].length, 0.4715)), 1.5, 'dB', 'old 0.4715')
    h.atMost('first 300 ms of a new device against the old defaults', Math.abs(loudnessDb(output, 0, early, 0.4135)), 2, 'dB', 'old 0.4135')
  },
}

// T20 (-5 to -25 dB) of the left channel's octave bands (Q 1.4 band pass) of the old engine at Decay 2.2 s, measured on the same
// worklet copy as above (research reverb.md D2 reports these to two digits; the old worklet gives them to three).
const oldCutBands: [string, Partial<typeof oldState>, number[]][] = [
  ['High Cut 8 kHz', { highCutHz: 8000 }, [2.086, 2.123, 1.809, 1.064]],
  ['High Cut 4 kHz', { highCutHz: 4000 }, [2.071, 2.044, 1.460, 0.790]],
  ['Low Cut 300 Hz', { lowCutHz: 300 }, [1.513, 1.528, 1.750, 1.545]],
  ['Low Cut 1 kHz', { lowCutHz: 1000 }, [1.069, 1.052, 1.141, 1.198]],
]

const migratedCuts: Scenario = {
  effect: 'reverb',
  name: 'migration-in-loop-cuts',
  rates: [48000],
  run: async (h) => {
    for (const [name, old, reference] of oldCutBands) {
      const output = await impulseResponse(h, migrated(old), 12)

      ;[125, 500, 2000, 8000].forEach((band, i) => {
        const decay = schroederRt(bandpass(output[0], band, h.rate), h.rate)
        h.within(`${band} Hz band T20 of a migrated ${name} against the old engine`, decay / reference[i], 1, 0.2, 'x', `old ${reference[i]} s, migrated ${decay.toFixed(3)} s`)
      })
    }
  },
}

const dcBlock: Scenario = {
  effect: 'reverb',
  name: 'c5-dc-blocker',
  rates: [48000],
  run: async (h) => {
    const { output } = await h.render(fx.reverb({ wet: 1 }), { input: [concat(silence(h.rate), constant(5 * h.rate, 0.5))] }, { parity: false })
    const mean = (from: number, to: number) => output[0].subarray(from * h.rate, to * h.rate).reduce((sum, value) => sum + value, 0) / ((to - from) * h.rate)
    h.atMost('mean output level 4 s into a constant 0.5 input', linearToDb(Math.abs(mean(5, 6)) / 0.5), -60, 'dB', 'C5')
  },
}

// Fixed parameter sets, each rendered through the core and the legacy worklet on tone, noise and clicks.
const paritySets: [string, Parameters<typeof fx.reverb>[0]][] = [
  ['defaults', { wet: 0.5 }],
  ['freeze flat', { wet: 1, freeze: true, flat: true, density: 'mid' }],
  ['freeze with shelves', { wet: 1, freeze: true, density: 'low', highShelfDb: -6, lowShelfDb: 4, highShelfHz: 3000 }],
  ['chorus extremes', { wet: 0.7, chorusAmountMs: 3, chorusRateHz: 2, density: 'sparse', smooth: 'slow' }],
  ['spin and shape', { wet: 0.6, reflections: 1, reflectionModAmountMs: 25, reflectionModRateHz: 2, 'reflectionShape': 0.2, preDelayMs: 120, smooth: 'none' }],
  ['cuts, small room, narrow', { wet: 0.8, lowCutHz: 300, highCutHz: 4000, size: 0.2, stereoWidth: 30, diffusion: 0.2, decaySec: 0.4, chorus: false }],
]

const parity: Scenario = {
  effect: 'reverb',
  name: 'parity-fixtures',
  run: async (h) => {
    const fixtures = new Map(parityFixtures(h.rate))

    for (const [setName, state] of paritySets) {
      for (const fixture of ['sine 1 kHz', 'noise', 'clicks']) {
        const input = fixtures.get(fixture)

        if (input === undefined) throw new Error(`missing parity fixture ${fixture}`)
        const { output, legacy } = await h.render(fx.reverb(state), { input: [input] })

        if (legacy === null) throw new Error('the reverb worklet must render for parity')
        h.atMost(`parity ${setName}, ${fixture}`, Math.max(maxAbsDiff(output[0], legacy[0]), maxAbsDiff(output[1], legacy[1])), parityLimit, 'abs')
        h.flag(`parity ${setName}, ${fixture}: the render carries signal`, peakAbs(output[0]) > 0.01 && maxAbsDiff(output[0], input) > 1e-3, 'not silent, not dry')
      }
    }
  },
}

const spec = fx.reverb({ wet: 0.5, reflections: 0.5 })

export const reverb: Family = {
  scenarios: [
    decayAccuracy, shelfDecay, chorusDecay, decayAcrossRates, density, earlyReflections, earlyReflectionsHighRates, stepClicks, sizeSweep, automationSweep,
    width, sizeLoudness, migratedLoudness, migratedCuts, predelayClamp, spinPitch, freezeDrift, dcBlock, parity,
    ...robustnessScenarios('reverb', spec, null),
  ],
  notEncoded: [
    'S1 Density: the chooser is judged through the High rows above (the research acceptance numbers are High); Sparse, Low and Mid are covered by the native tests and the CPU table.',
    'S7 (25 % CPU drop) is read from the relative CPU row of the latency-and-cpu scenario before and after.',
  ],
}
