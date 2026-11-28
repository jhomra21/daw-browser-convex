// Acceptance tests from reverb.md section 3: M1 (per-band T30, independent input filter), M2 (click-free parameter moves),
// M3 (fine structure, Spin pitch), M4 (parity), S1/S2 (echo density, autocorrelation), S4 (width), S5 (early reflections),
// S8 (sample-rate-aware buffers), C4 (level versus size).
import { autocorrelationPeak, bandpass, correlation, echoDensity, fineStructure, peakFrame, pitchDeviationCents, schroederT30 } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Harness, Scenario } from '../harness'
import { impulse, linearToDb, sine } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

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

const earlyReflections: Scenario = {
  effect: 'reverb',
  name: 's5-early-reflection-density',
  run: async (h) => {
    const output = await impulseResponse(h, { reflections: 1, diffuse: 0, preDelayMs: 0 }, 0.4)
    const ms = (value: number) => Math.round(value * h.rate / 1000)
    h.atLeast('echo density of the early-reflection window, 0-80 ms', echoDensity(output[0], 0, ms(80), ms(10)), 0.3, '', 'S5')
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

const width: Scenario = {
  effect: 'reverb',
  name: 's4-stereo-width',
  rates: [48000],
  run: async (h) => {
    const widths = [0, 0.5, 1, 1.5, 2]
    const results = await Promise.all(widths.map((stereoWidth) => impulseResponse(h, { stereoWidth }, 6)))
    const reference = energy(results[2])
    const from = Math.round(0.1 * h.rate)
    const correlations = results.map((output) => correlation(output[0], output[1], from))

    widths.forEach((stereoWidth, i) => h.atMost(`tail energy vs width 1, width ${stereoWidth}`, Math.abs(linearToDb(Math.sqrt(energy(results[i]) / reference))), 1, 'dB'))
    h.atLeast('lowest L/R correlation over the width range', Math.min(...correlations), -0.1, '', `by width ${correlations.map((c) => c.toFixed(2)).join(' ')}`)
    h.flag('correlation falls monotonically with width', correlations.every((c, i) => i === 0 || c <= correlations[i - 1] + 1e-3), 'non-increasing')
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

const predelayClamp: Scenario = {
  effect: 'reverb',
  name: 's8-predelay-tap-spread',
  run: async (h) => {
    const output = await impulseResponse(h, { reflections: 1, preDelayMs: 250, diffuse: 0 }, 0.6)
    const taps = [...new Set(Array.from(output[0]).flatMap((v, n) => Math.abs(v) > 1e-4 ? [Math.round(n / h.rate * 10000) / 10] : []))].slice(0, 12)
    h.atLeast('early-reflection tap spread at 250 ms pre-delay', taps.length > 0 ? taps[taps.length - 1] - taps[0] : 0, 20, 'ms', 'report: 0 ms at 96 kHz, 34 ms at 48 kHz')
  },
}

const spinPitch: Scenario = {
  effect: 'reverb',
  name: 'm3-spin-pitch-deviation',
  rates: [48000],
  run: async (h) => {
    const f = 1000
    const { output } = await h.render(fx.reverb({ wet: 1, reflections: 1, reflectionSpin: true, reflectionModAmountMs: 17.5, reflectionModRateHz: 0.3 }), { input: [sine(5 * h.rate, f, h.rate, 0.3)] }, { parity: false })
    h.atMost('wet 1 kHz pitch deviation with Spin on', pitchDeviationCents(output[0], f, h.rate, 2 * h.rate, 5 * h.rate), 3, 'cents', 'report: about 28 cents peak')
    h.info('latency of the impulse peak', peakFrame(output[0].subarray(0, 100)), 'frames')
  },
}

const spec = fx.reverb({ wet: 0.5, reflections: 0.5 })

export const reverb: Family = {
  scenarios: [
    decayAccuracy, decayAcrossRates, density, earlyReflections, stepClicks, width, sizeLoudness, predelayClamp, spinPitch,
    parityScenario('reverb', spec),
    ...robustnessScenarios('reverb', spec, null),
  ],
  notEncoded: [
    'M1 6 dB high shelf at 4 kHz, S1 Density chooser, S3 Freeze/Flat/Cut, S6 chorus-on T30, C5 DC blocker: need parameters the reverb does not have yet.',
    'S7 (25 % CPU drop) is read from the relative CPU row of the latency-and-cpu scenario before and after.',
  ],
}
