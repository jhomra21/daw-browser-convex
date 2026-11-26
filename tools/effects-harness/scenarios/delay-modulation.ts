// Acceptance tests from delay-modulation.md section 3: MOD-1/2 (modulation delay step click, feedback spacing), PH-1 (phaser feedback level), TR-1 (autopan phase).
import { correlation, peakAbs, peakFrame } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { constant, gaussianNoise, impulse, linearToDb, noise, sine } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

const aligned = (frame: number) => Math.floor(frame / 128) * 128

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
    // Gaussian noise at the rms of the uniform noise it replaces (sigma 0.144 = uniform amplitude 0.25). Uniform noise has a low crest factor, and
    // the all-pass chain turns it into Gaussian-like noise: its peak rises by about 7.5 dB with no added level, so the old uniform row measured
    // the crest factor as much as the loop. The 12-stage judged row is in the modulation family.
    const uniform = noise(4 * h.rate, 0.25, 11)
    const gaussian = gaussianNoise(4 * h.rate, 0.144, 11)
    const peakOver = async (input: Float32Array) => linearToDb(peakAbs((await h.render(fx.phaser({ feedback: 0.95, mix: 1 }), { input: [input] })).output[0]) / peakAbs(input))
    h.atMost('output peak over input peak, Gaussian noise, feedback 0.95', await peakOver(gaussian), 12, 'dB', 'PH-1')
    h.info('output peak over input peak, uniform noise, feedback 0.95', await peakOver(uniform), 'dB', 'PH-1: the former judged row')
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
    // Auto Pan now follows Live: two LFOs a half cycle apart (the default Stereo Phase) drive equal-power gains, sine against cosine of a
    // quarter-cycle angle, whose envelopes correlate at about -0.92, not -1. The linear antiphase check (-0.99) moved to the Tremolo
    // row of the modulation family; the equal-power law has its own row there.
    h.atMost('L/R gain-envelope correlation of the autopan', correlation(left.map((v) => v - ml), right.map((v) => v - mr)), -0.9, '', 'TR-1')
  },
}

export const delayModulation: Family = {
  scenarios: [
    modulationStep, feedbackSpacing, phaserFeedback, autopanPhase,
    parityScenario('chorus', fx.chorus()),
    parityScenario('flanger', fx.flanger()),
    parityScenario('phaser', fx.phaser()),
    parityScenario('tremolo', fx.tremolo()),
    parityScenario('autopan', fx.autopan()),
    parityScenario('ensemble', fx.ensemble()),
    ...robustnessScenarios('chorus', fx.chorus(), null),
    ...robustnessScenarios('flanger', fx.flanger(), null),
    ...robustnessScenarios('phaser', fx.phaser(), null),
    ...robustnessScenarios('ensemble', fx.ensemble(), null),
  ],
  notEncoded: [
    'TR-1 on the tremolo (Stereo Phase 0.5 antiphase) and the Auto Pan equal-power law: judged in the modulation family.',
    'Ensemble sideband and per-voice tests, chorus stereo-width tests: need a voice-level tap the core does not expose.',
  ],
}
