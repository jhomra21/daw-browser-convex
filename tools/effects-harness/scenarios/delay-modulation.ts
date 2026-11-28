// Acceptance tests from delay-modulation.md section 3: DEL-1..4 (delay time click, echo positions, fractional-delay gain,
// filter-off transparency), MOD-1/2 (modulation delay step click, feedback spacing), PH-1 (phaser feedback level), TR-1 (autopan phase).
import { correlation, peakAbs, peakFrame, rmsDb, toneGainDb } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { constant, impulse, linearToDb, noise, sine, concat, silence } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

const aligned = (frame: number) => Math.floor(frame / 128) * 128

const delayStepClick: Scenario = {
  effect: 'delay',
  name: 'del1-time-change-click',
  rates: [48000],
  run: async (h) => {
    const frame = aligned(1.5 * h.rate)
    const { extraRatio, stepped } = await h.stepClick(fx.delay({ dryWet: 1, feedback: 0 }), [sine(3 * h.rate, 440, h.rate, 0.3)], { frame, set: { delayMs: 251.3 } }, 4096)
    h.atMost('max extra sample step / steady-state max step, delay 250 to 251.3 ms', extraRatio, 1.5, 'x', 'DEL-1')
    await h.wav('time-step', stepped.output)
  },
}

const echoPositions: Scenario = {
  effect: 'delay',
  name: 'del2-echo-positions',
  run: async (h) => {
    const delayMs = 100.3
    const { output } = await h.render(fx.delay({ delayMs, feedback: 0.5, dryWet: 1 }), { input: [impulse(Math.round(1.2 * h.rate), 0.5)] }, { parity: false })
    const spacing = delayMs * h.rate / 1000

    for (const k of [1, 2, 4]) {
      const expected = k * spacing
      const from = Math.round(expected) - 20
      const found = from + peakFrame(output[0].subarray(from, from + 40))
      h.atMost(`echo ${k} position error`, Math.abs(found - expected), 1, 'frames', `expected ${expected.toFixed(2)}, found ${found}`)
    }
  },
}

const fractionalGain: Scenario = {
  effect: 'delay',
  name: 'del3-fractional-delay-gain',
  run: async (h) => {
    const delayMs = 10.37
    const frames = h.rate
    const input = sine(frames, 10000, h.rate, 0.3)
    const { output } = await h.render(fx.delay({ delayMs, feedback: 0, dryWet: 1 }), { input: [input] }, { parity: false })
    h.atLeast('10 kHz gain at a fractional delay', toneGainDb(input, output[0], 10000, h.rate, Math.round(0.3 * h.rate), Math.round(0.9 * h.rate)), -0.7, 'dB', 'DEL-3')
  },
}

const filterOffTransparency: Scenario = {
  effect: 'delay',
  name: 'del4-filter-off-transparency',
  rates: [48000],
  run: async (h) => {
    const delayMs = 50
    const echo = Math.round(delayMs * h.rate / 1000)
    const burst = sine(Math.round(0.02 * h.rate), 18000, h.rate, 0.3)
    const input = concat(burst, silence(12 * echo))
    const { output } = await h.render(fx.delay({ delayMs, feedback: 0.7, dryWet: 1, filterEnabled: false }), { input: [input] }, { parity: false })
    const level = (k: number) => rmsDb(output[0], k * echo + Math.round(0.005 * h.rate), k * echo + Math.round(0.015 * h.rate))
    const drift = Math.abs(level(10) - level(1) - 9 * linearToDb(0.7))
    h.atMost('18 kHz level error after 10 echoes, filter off', drift, 0.05, 'dB', 'DEL-4')
  },
}

const modulationStep: Scenario = {
  effect: 'flanger',
  name: 'mod1-delay-step-click',
  rates: [48000],
  run: async (h) => {
    const frame = aligned(1.5 * h.rate)
    const input = [sine(3 * h.rate, 440, h.rate, 0.3)]

    for (const [kind, spec] of [['flanger', fx.flanger({ depthMs: 0, mix: 1, feedback: 0 })], ['chorus', fx.chorus({ depthMs: 0, mix: 1 })]] as const) {
      const { extraRatio } = await h.stepClick(spec, input, { frame, set: { delayMs: kind === 'flanger' ? 5 : 20 } }, 4096)
      h.atMost(`${kind} delayMs step: max extra sample step / steady-state max step`, extraRatio, 2, 'x', 'MOD-1')
    }
  },
}

const feedbackSpacing: Scenario = {
  effect: 'flanger',
  name: 'mod2-feedback-spacing',
  run: async (h) => {
    const delayMs = 1.5
    const { output } = await h.render(fx.flanger({ delayMs, depthMs: 0, rateHz: 0.01, feedback: 0.5, mix: 1 }), { input: [impulse(Math.round(0.1 * h.rate), 0.5)] }, { parity: false })
    const expected = delayMs * h.rate / 1000
    const first = peakFrame(output[0])
    const from = first + Math.round(expected / 2)
    const second = from + peakFrame(output[0].subarray(from, from + Math.round(2 * expected)))
    h.within('spacing of the first two feedback echoes', second - first, expected, 1, 'frames', 'MOD-2')
  },
}

const phaserFeedback: Scenario = {
  effect: 'phaser',
  name: 'ph1-feedback-level',
  rates: [48000],
  run: async (h) => {
    const input = noise(4 * h.rate, 0.25, 11)
    const { output } = await h.render(fx.phaser({ feedback: 0.95, mix: 1 }), { input: [input] })
    h.atMost('output peak over input peak, feedback 0.95', linearToDb(peakAbs(output[0]) / peakAbs(input)), 12, 'dB', 'PH-1')
  },
}

const autopanPhase: Scenario = {
  effect: 'autopan',
  name: 'tr1-autopan-channel-envelopes',
  rates: [48000],
  run: async (h) => {
    const { output } = await h.render(fx.autopan({ rateHz: 1, depth: 1 }), { input: [constant(4 * h.rate, 0.5)] })
    const centre = (channel: Float32Array) => channel.subarray(h.rate, 4 * h.rate)
    const mean = (x: Float32Array) => x.reduce((sum, v) => sum + v, 0) / x.length
    const left = centre(output[0])
    const right = centre(output[1])
    const [ml, mr] = [mean(left), mean(right)]
    h.atMost('L/R gain-envelope correlation of the autopan', correlation(left.map((v) => v - ml), right.map((v) => v - mr)), -0.99, '', 'TR-1')
  },
}

const delaySpec = fx.delay({ delayMs: 250, feedback: 0.4, dryWet: 0.5 })

export const delayModulation: Family = {
  scenarios: [
    delayStepClick, echoPositions, fractionalGain, filterOffTransparency, modulationStep, feedbackSpacing, phaserFeedback, autopanPhase,
    parityScenario('delay', delaySpec),
    parityScenario('chorus', fx.chorus()),
    parityScenario('flanger', fx.flanger()),
    parityScenario('phaser', fx.phaser()),
    parityScenario('tremolo', fx.tremolo()),
    parityScenario('autopan', fx.autopan()),
    parityScenario('ensemble', fx.ensemble()),
    ...robustnessScenarios('delay', delaySpec, null),
    ...robustnessScenarios('chorus', fx.chorus(), null),
    ...robustnessScenarios('flanger', fx.flanger(), null),
    ...robustnessScenarios('phaser', fx.phaser(), null),
    ...robustnessScenarios('ensemble', fx.ensemble(), null),
  ],
  notEncoded: [
    'DEL-5 (dotted 1/8 at 120 BPM = 375 ms) and any tempo-sync test: the core delay has no sync control, only delayMs.',
    'TR-1 stereoPhase 0.5 on the tremolo: the amplitude-modulation state has no stereoPhase; the autopan envelopes are measured instead.',
    'Ensemble sideband and per-voice tests, chorus stereo-width tests: need a voice-level tap the core does not expose.',
  ],
}
