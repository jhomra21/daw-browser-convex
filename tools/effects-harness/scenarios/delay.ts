// Acceptance tests from delay-modulation.md section 3.1: DEL-1 (time change click), DEL-2 (echo positions and levels), DEL-3 (fractional-delay
// gain), DEL-4 (filter-off transparency, band-pass response), DEL-5 (dotted, triplet and offset sync at the project tempo), DEL-6 (5 s maximum).
import { peakAbs, peakFrame, rmsDb, toneGainDb } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { concat, impulse, linearToDb, silence, sine } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

const aligned = (frame: number) => Math.floor(frame / 128) * 128

// The loop's soft limiter is linear below 0.5, so every signal here stays below it.
const delayStepClick: Scenario = {
  effect: 'delay',
  name: 'del1-time-change-click',
  rates: [48000],
  run: async (h) => {
    const frame = aligned(1.5 * h.rate)
    const { ratio, stepped } = await h.stepClick(fx.delay({ dryWet: 1, feedback: 0 }), [sine(3 * h.rate, 440, h.rate, 0.3)], { frame, set: { timeLeftMs: 251.3 } }, 4096)
    // The research bound is the largest sample step after the change over the steady-state largest step. The metric the other rows use,
    // extraRatio, compares against the unchanged render and so counts the phase shift every delay change causes by design.
    h.atMost('max sample step after the change / steady-state max step, delay 250 to 251.3 ms (Repitch)', ratio, 1.5, 'x', 'DEL-1')
    await h.wav('time-step', stepped.output)
  },
}

const echoPositions: Scenario = {
  effect: 'delay',
  name: 'del2-echo-positions',
  run: async (h) => {
    for (const delayMs of [1, 5, 250]) {
      const spacing = delayMs * h.rate / 1000
      const lead = Math.round(0.1 * h.rate)
      const { output } = await h.render(fx.delay({ timeLeftMs: delayMs, feedback: 0.5, dryWet: 1 }), { input: [impulse(lead + Math.ceil(4 * spacing) + 64, 0.2, lead)] }, { parity: false })

      for (const k of [1, 2, 4]) {
        const expected = lead + k * spacing
        const half = Math.min(20, Math.floor(spacing / 2))
        const from = Math.round(expected) - half
        const found = from + peakFrame(output[0].subarray(from, from + 2 * half))
        h.atMost(`${delayMs} ms: echo ${k} position error`, Math.abs(found - expected), 1, 'frames', `DEL-2: expected ${expected.toFixed(2)}, found ${found}`)
      }

      // A whole-frame delay is a pure copy, so the echo level is exact (the input impulse is 0.2, echo 2 is 0.1).
      if (Number.isInteger(spacing)) h.atMost(`${delayMs} ms: echo 2 level error`, Math.abs(linearToDb(peakAbs(output[0].subarray(lead + 2 * spacing - 4, lead + 2 * spacing + 5)) / 0.1)), 0.1, 'dB', 'DEL-2')
    }
  },
}

const fractionalGain: Scenario = {
  effect: 'delay',
  name: 'del3-fractional-delay-gain',
  run: async (h) => {
    const input = sine(h.rate, 10000, h.rate, 0.3)
    const { output } = await h.render(fx.delay({ timeLeftMs: 10.37, feedback: 0, dryWet: 1 }), { input: [input] }, { parity: false })
    h.atLeast('10 kHz gain at a fractional delay', toneGainDb(input, output[0], 10000, h.rate, Math.round(0.3 * h.rate), Math.round(0.9 * h.rate)), -0.7, 'dB', 'DEL-3')
  },
}

const filterOffTransparency: Scenario = {
  effect: 'delay',
  name: 'del4-filter-off-transparency',
  rates: [48000],
  run: async (h) => {
    const echo = Math.round(50 * h.rate / 1000)
    const input = concat(sine(Math.round(0.02 * h.rate), 18000, h.rate, 0.3), silence(12 * echo))
    const { output } = await h.render(fx.delay({ timeLeftMs: 50, feedback: 0.9, dryWet: 1, filterEnabled: false }), { input: [input] }, { parity: false })
    const level = (k: number) => rmsDb(output[0], k * echo + Math.round(0.005 * h.rate), k * echo + Math.round(0.015 * h.rate))
    h.atMost('18 kHz level error after 10 echoes at feedback 0.9, filter off', Math.abs(level(10) - level(1) - 9 * linearToDb(0.9)), 0.05, 'dB', 'DEL-4')
  },
}

const bandPassResponse: Scenario = {
  effect: 'delay',
  name: 'del4-band-pass-response',
  rates: [48000],
  run: async (h) => {
    const input = (hz: number) => sine(h.rate, hz, h.rate, 0.3)

    const gain = async (hz: number) => {
      const { output } = await h.render(fx.delay({ timeLeftMs: 20, feedback: 0, dryWet: 1, filterEnabled: true, filterHz: 1000, filterWidth: 2 }), { input: [input(hz)] }, { parity: false })

      return toneGainDb(input(hz), output[0], hz, h.rate, Math.round(0.5 * h.rate), Math.round(0.9 * h.rate))
    }

    h.within('gain at the filter frequency (1 kHz)', await gain(1000), 0, 0.2, 'dB', 'DEL-4')
    h.atMost('gain two octaves above the filter frequency (4 kHz), width 2', await gain(4000), -6, 'dB', 'DEL-4')
    h.atMost('gain two octaves below the filter frequency (250 Hz), width 2', await gain(250), -6, 'dB', 'DEL-4')
  },
}

// The echo positions of a synced delay at 120 bpm: a beat is 500 ms.
const syncedEcho = (name: string, metric: string, state: Parameters<typeof fx.delay>[0], expectedMs: number): Scenario => ({
  effect: 'delay',
  name,
  run: async (h) => {
    const lead = Math.round(0.1 * h.rate)
    const { output } = await h.render(fx.delay({ syncLeft: true, syncRight: true, feedback: 0, dryWet: 1, ...state }), { input: [impulse(lead + Math.ceil(expectedMs * h.rate / 1000) + 64, 0.3, lead)], tempoBpm: 120 }, { parity: false })
    const expected = lead + expectedMs * h.rate / 1000
    const from = Math.round(expected) - 20
    h.atMost(metric, Math.abs(from + peakFrame(output[0].subarray(from, from + 40)) - expected), 1, 'frames', `DEL-5: expected ${expected.toFixed(2)}`)
  },
})

const maximumTime: Scenario = {
  effect: 'delay',
  name: 'del6-maximum-time',
  run: async (h) => {
    const lead = Math.round(0.1 * h.rate)
    const { output } = await h.render(fx.delay({ timeLeftMs: 5000, feedback: 0, dryWet: 1 }), { input: [impulse(lead + 5 * h.rate + 64, 0.3, lead)] }, { parity: false })
    const expected = lead + 5 * h.rate
    const from = expected - 20
    h.atMost('echo position error at the 5 s maximum', Math.abs(from + peakFrame(output[0].subarray(from, from + 40)) - expected), 1, 'frames', `DEL-6: expected ${expected}`)
  },
}

const delaySpec = fx.delay({ timeLeftMs: 250, feedback: 0.4, dryWet: 0.5 })

export const delay: Family = {
  scenarios: [
    delayStepClick, echoPositions, fractionalGain, filterOffTransparency, bandPassResponse,
    syncedEcho('del5-dotted-eighth', 'dotted 1/8 echo position error at 120 bpm (375 ms)', { divisionLeft: '1/8', feelLeft: 'dotted' }, 375),
    syncedEcho('del5-triplet-quarter', 'triplet 1/4 echo position error at 120 bpm (333.33 ms)', { divisionLeft: '1/4', feelLeft: 'triplet' }, 1000 / 3),
    syncedEcho('del5-thirty-second', '1/32 echo position error at 120 bpm (62.5 ms)', { divisionLeft: '1/32' }, 62.5),
    syncedEcho('del5-offset', '1/8 with +10% offset echo position error at 120 bpm (275 ms)', { divisionLeft: '1/8', offsetLeftPercent: 10 }, 275),
    maximumTime,
    parityScenario('delay', delaySpec),
    parityScenario('delay', fx.delay({ timeLeftMs: 180, feedback: 0.5, dryWet: 0.5, filterEnabled: true, filterHz: 2000, filterWidth: 3 })),
    parityScenario('delay', fx.delay({ timeLeftMs: 300, timeRightMs: 130, link: false, pingPong: true, feedback: 0.5, dryWet: 0.5 })),
    ...robustnessScenarios('delay', delaySpec, null),
  ],
  notEncoded: [
    'Freeze and the Fade and Jump time-change modes: the harness steps only continuous parameters, so they are covered by the native delay test.',
  ],
}
