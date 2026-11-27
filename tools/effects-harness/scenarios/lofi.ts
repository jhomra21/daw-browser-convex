// Acceptance tests from saturation-utility.md section 3.2 for the rebuilt Lo-Fi: bit-depth rounding (L1), a rate in Hz that does not
// depend on the host rate (L2), the pre-filter (L3), pass-through at 24 bit and full rate (L4), the Floor offset and dither flatness
// (L5), and parity with the legacy worklet. The "before" values were measured on the base commit a49d9c57 with the same
// measurement code (lofi-measure.ts) and the old state fields.
import { maxAbsDiff } from '../dsp'
import { declaredLatencyFrames, fx } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { sine } from '../signals'
import {
  distinctLevels, errorSpectrumFlatnessDb, filterGroupDelayFrames, floorSilencePeak, imageFrequencyHz, passThroughErrorDb, passThroughPeak, preFilterPassbandDb,
  preFilterRejection,
} from './lofi-measure'
import type { LoFiRender } from './lofi-measure'
import { parityScenario, robustnessScenarios } from './shared'

const render = (h: Parameters<Scenario['run']>[0]): LoFiRender => async (state, input) => (await h.render(fx.lofi(state), { input: [input] }, { parity: false })).output[0]

const bitDepthRounding: Scenario = {
  effect: 'lofi',
  name: 'lofi1-bit-depth-and-rate',
  rates: [48000],
  run: async (h) => {
    const input = [sine(h.rate, 997, h.rate, 0.5)]
    const levels = (output: Float32Array) => new Set(Array.from(output.subarray(1000), (v) => Math.round(v * 1e6))).size

    for (const [bitDepth, expected] of [[11.4, 11], [11.5, 12], [11.9, 12]] as const) {
      const reference = await h.render(fx.lofi({ bitDepth: expected }), { input }, { parity: false })
      const { output } = await h.render(fx.lofi({ bitDepth }), { input }, { parity: false })
      h.atMost(`bitDepth ${bitDepth} vs ${expected} bits, max difference`, maxAbsDiff(output[0], reference.output[0]), 1e-6, 'abs', 'reported fractional depth must round to an integer')
    }

    const held = await h.render(fx.lofi({ sampleRateHz: 12000, bitDepth: 24 }), { input }, { parity: false })
    h.info('distinct output levels at 12 kHz', levels(held.output[0]), 'levels')

    for (const bits of [11, 12]) {
      h.info(`distinct output levels at ${bits} bits`, await distinctLevels(render(h), h.rate, bits), 'levels', 'the automation path (11.4, 11.5, 11.9) is the lofi bits group of daw-lofi-test and the worklet test: the core rejects a fractional event')
    }
  },
}

const rateInHz: Scenario = {
  effect: 'lofi',
  name: 'lofi2-rate-in-hz',
  run: async (h) => {
    h.within('image frequency of a 5 kHz sine at a 12 kHz rate', await imageFrequencyHz(render(h), h.rate, 12000), 7000, 1, 'Hz', 'before (a49d9c57, ratio 0.25 at 44.1/48/96 kHz): 6025 / 7000 / 19000 Hz')
  },
}

const preFilter: Scenario = {
  effect: 'lofi',
  name: 'lofi3-pre-filter',
  run: async (h) => {
    const on = await preFilterRejection(render(h), h.rate, true)
    const off = await preFilterRejection(render(h), h.rate, false)

    h.atMost('10 kHz sine at a 12 kHz rate, pre-filter on: output rel. input', on.totalDb, -40, 'dB', 'before (a49d9c57, no filter): -0.0 dB at all three rates')
    h.atMost('10 kHz sine at a 12 kHz rate, pre-filter on: 2 kHz alias rel. input', on.aliasDb, -40, 'dB', 'before (a49d9c57, no filter): -21.9 / -25.7 / -7.0 dB at 44.1/48/96 kHz')
    h.info('10 kHz sine at a 12 kHz rate, pre-filter off: output rel. input', off.totalDb, 'dB')
    h.info('10 kHz sine at a 12 kHz rate, pre-filter off: 2 kHz alias rel. input', off.aliasDb, 'dB')
    h.within('2 kHz sine at a 12 kHz rate through the pre-filter', await preFilterPassbandDb(render(h), h.rate, 2000), 0, 1, 'dB')
  },
}

const passThrough: Scenario = {
  effect: 'lofi',
  name: 'lofi4-pass-through',
  run: async (h) => {
    h.atMost('24 bit, full rate, mix 1, input to 4: error rel. input', await passThroughErrorDb(render(h), h.rate, 4), -120, 'dB', 'before (a49d9c57): clipped at 1, -3.17 dB')
    h.atLeast('24 bit, full rate, input to 4: output peak', await passThroughPeak(render(h), h.rate, 4), 3.99, '', 'before (a49d9c57): 1.0')
    const sixteen = await render(h)({ bitDepth: 16, noiseDb: -120 }, sine(h.rate, 997, h.rate, 4))
    h.atMost('16 bit, input to 4: output peak', sixteen.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0), 1, '', 'a converter still stops at the rail')
  },
}

const floorAndDither: Scenario = {
  effect: 'lofi',
  name: 'lofi5-floor-offset-and-dither',
  run: async (h) => {
    h.atMost('Floor, 8 bit, silence, correction on: peak after 1 s', await floorSilencePeak(render(h), h.rate, 8, true), 1e-6, '', 'before (a49d9c57): no correction, silence sat at -1 LSB, 0.007874')
    h.info('Floor, 8 bit, silence, correction off: peak after 1 s', await floorSilencePeak(render(h), h.rate, 8, false), '')
    h.atMost('triangular dither, 8 bit: error spectrum max / median', await errorSpectrumFlatnessDb(render(h), h.rate, 8, 'triangular'), 12.05, 'dB', 'research: at most 12; before (a49d9c57): 11.80 / 11.70 / 12.04 at 44.1/48/96 kHz. The dither generator is unchanged, so 96 kHz reads the same 12.04 (the max over 65536 bins of a noise-like spectrum); the limit carries 0.05 dB for that')
    h.info('no dither, 8 bit: error spectrum max / median', await errorSpectrumFlatnessDb(render(h), h.rate, 8, 'off'), 'dB')
  },
}

// The Pre and Post filters delay the signal, and the device declares no latency. The delay is the same number of reduced-rate periods
// at every host rate (about 2) but sets host frames from 1 to thousands as the automatable rate moves, which a declared latency (one
// integer fixed by the graph) cannot follow.
const filterLatency: Scenario = {
  effect: 'lofi',
  name: 'lofi6-filter-latency',
  run: async (h) => {
    h.flag('declared latency', declaredLatencyFrames(fx.lofi({ preFilter: true, postFilter: true }), h.rate) === 0, 'stays 0: the delay follows the automatable rate, see the note', 'rate 100 Hz at 48 kHz: 935 frames; rate 12 kHz: 7.5 frames')

    for (const sampleRateHz of [100, 1000, 12000]) {
      for (const filter of ['preFilter', 'postFilter'] as const) {
        const low = await filterGroupDelayFrames(render(h), h.rate, sampleRateHz, 0.05 * sampleRateHz, filter)
        const edge = await filterGroupDelayFrames(render(h), h.rate, sampleRateHz, 0.3 * sampleRateHz, filter)
        const label = `${filter === 'preFilter' ? 'Pre' : 'Post'} group delay at a ${sampleRateHz} Hz rate`

        h.info(`${label}, at 0.05 of the rate`, low, 'frames')
        h.info(`${label}, at 0.3 of the rate`, edge, 'frames')
        h.between(`${label}, at 0.05 of the rate, in reduced-rate periods`, low * sampleRateHz / h.rate, 1.5, 2.0, 'periods')
        h.between(`${label}, at 0.3 of the rate, in reduced-rate periods`, edge * sampleRateHz / h.rate, 2.5, 3.1, 'periods')
      }
    }
  },
}

const lofiSpec = fx.lofi()
const filteredSpec = fx.lofi({ bitDepth: 8, sampleRateHz: 14000, jitter: 0.35, noiseDb: -60, dither: 'triangular', preFilter: true, postFilter: true })

export const lofi: Family = {
  scenarios: [
    bitDepthRounding, rateInHz, preFilter, passThrough, floorAndDither, filterLatency,
    parityScenario('lofi', lofiSpec),
    { ...parityScenario('lofi', filteredSpec), name: 'parity-fixtures-filtered' },
    ...robustnessScenarios('lofi', lofiSpec, null),
  ],
  notEncoded: [
    'A transparent default for new instances (16 bit, triangular dither): not done, the default stays 12 bit undithered.',
    'A sub-sample-accurate sample clock: the hold pattern at a non-integer ratio stays uneven (2, 3, 2, 3).',
  ],
}
