// Acceptance tests from saturation-utility.md section 3: saturator (alias, color, curve, drive click, unity), lo-fi (bit rounding,
// rate in Hz), utility (gain click, DC blocker), spectral (threshold normalisation, freeze, identity).
import { measureAliasingEnergyDb } from '../../../packages/audio-engine/src/dsp-characterization'
import { maxAbsDiff, peakAbs, rms, toneGainDb } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { coherentFrequency, dbToLinear, linearToDb, noise, sine, sineWithPeakAt } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

const aligned = (frame: number) => Math.floor(frame / 128) * 128

const saturatorAlias: Scenario = {
  effect: 'saturator',
  name: 'sat1-alias-energy',
  run: async (h) => {
    const frames = 2 * h.rate
    const f = coherentFrequency(5000, frames / 2, h.rate)
    const { output } = await h.render(fx.saturator({ driveDb: 18 }), { input: [sine(frames, f, h.rate, 0.5)] }, { parity: false })
    h.atMost('alias energy, 18 dB drive, 5 kHz', measureAliasingEnergyDb(output[0].subarray(frames / 2), f, h.rate, Math.ceil(h.rate / f) + 2), -45, 'dB rel. fundamental', 'report: about -25 dB')
  },
}

const saturatorUnity: Scenario = {
  effect: 'saturator',
  name: 'sat2-unity-at-low-level',
  rates: [48000],
  run: async (h) => {
    const frames = h.rate
    const input = sine(frames, 1000, h.rate, dbToLinear(-40))
    const { output } = await h.render(fx.saturator({ driveDb: 0 }), { input: [input] })
    h.within('gain at -40 dBFS, drive 0', toneGainDb(input, output[0], 1000, h.rate, h.rate / 4, frames), 0, 0.3, 'dB', 'report: a soft curve compresses even small signals')
  },
}

const saturatorClick: Scenario = {
  effect: 'saturator',
  name: 'sat3-drive-step-click',
  rates: [48000],
  run: async (h) => {
    const frame = aligned(h.rate)
    const { extraRatio } = await h.stepClick(fx.saturator({ driveDb: 0 }), [sineWithPeakAt(2 * h.rate, 1000, h.rate, 0.5, frame)], { frame, set: { driveDb: 18 } }, 2048)
    h.atMost('max extra sample step / steady-state max step, drive 0 to 18 dB', extraRatio, 1.5, 'x')
  },
}

const lofiQuantisation: Scenario = {
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

    const held = await h.render(fx.lofi({ sampleRateRatio: 0.25, bitDepth: 24 }), { input }, { parity: false })
    h.info('distinct output levels at ratio 0.25', levels(held.output[0]), 'levels')
  },
}

const utilityClick: Scenario = {
  effect: 'utility',
  name: 'util1-gain-step-and-dc-blocker',
  run: async (h) => {
    const frame = aligned(h.rate)
    const input = [sineWithPeakAt(2 * h.rate, 1000, h.rate, 0.5, frame)]
    const { stepped } = await h.stepClick(fx.utility({ gainDb: 0 }), input, { frame, set: { gainDb: -12 } }, 2048)
    const reference = await h.render(fx.utility({ gainDb: 0 }), { input }, { parity: false })
    let worst = 0

    for (let n = frame; n < frame + 2048; n += 1) worst = Math.max(worst, Math.abs(stepped.output[0][n] - stepped.output[0][n - 1] - (reference.output[0][n] - reference.output[0][n - 1])))
    h.atMost('largest extra sample step after a 0 to -12 dB gain step, full-scale 0.5 sine', worst, 0.05, 'FS')

    const tone = [sine(2 * h.rate, 40, h.rate, 0.5)]
    const { output } = await h.render(fx.utility({ dcBlock: true }), { input: tone })
    h.within('40 Hz gain with the DC blocker', toneGainDb(tone[0], output[0], 40, h.rate, h.rate, 2 * h.rate), 0, 0.05, 'dB')
  },
}

const spectralScenarios: Scenario[] = [{
  effect: 'spectral',
  name: 'spec1-threshold-and-identity',
  rates: [48000],
  run: async (h) => {
    const input = [sine(2 * h.rate, 1000, h.rate, 0.1)]

    const outputPeak = async (fftSize: 1024 | 2048 | 4096) => {
      const { output } = await h.render(fx.spectral({ fftSize, mode: 'gate', gateThresholdDb: -30, mix: 1 }), { input }, { parity: false })

      return linearToDb(rms(output[0], h.rate, 2 * h.rate))
    }

    const levels = await Promise.all([outputPeak(1024), outputPeak(2048), outputPeak(4096)])
    h.atMost('gate output level spread across fftSize 1024 to 4096, same threshold', Math.max(...levels) - Math.min(...levels), 1, 'dB', `levels ${levels.map((v) => v.toFixed(1)).join(' ')} dB`)

    const noiseInput = [noise(2 * h.rate, 0.25, 9)]
    const { output } = await h.render(fx.spectral({ mode: 'gate', gateThresholdDb: -120, mix: 1 }), { input: noiseInput })
    const latency = 2048
    h.atMost('identity round-trip error, threshold -120 dB, after fftSize latency and one window of warm-up', maxAbsDiff(output[0].subarray(2 * latency), noiseInput[0].subarray(latency, noiseInput[0].length - latency)), 1e-3, 'abs')
    h.info('input peak', peakAbs(noiseInput[0]), '')
  },
}]

const saturatorSpec = fx.saturator()
const lofiSpec = fx.lofi()
const utilitySpec = fx.utility()
const spectralSpec = fx.spectral()

export const saturationUtility: Family = {
  scenarios: [
    saturatorAlias, saturatorUnity, saturatorClick, lofiQuantisation, utilityClick, ...spectralScenarios,
    parityScenario('saturator', saturatorSpec), parityScenario('lofi', lofiSpec), parityScenario('utility', utilitySpec), parityScenario('spectral', spectralSpec),
    ...robustnessScenarios('saturator', saturatorSpec, null),
    ...robustnessScenarios('lofi', lofiSpec, null),
    ...robustnessScenarios('utility', utilitySpec, null),
    ...robustnessScenarios('spectral', spectralSpec, () => 2048),
  ],
  notEncoded: [
    'Bass-mono crossover and phase-L tests: the utility has no bass-mono or per-channel phase control.',
    'Saturator color-peak and Medium-curve continuity tests, lo-fi rate-in-Hz tests, spectral freeze ripple and HPSS neutral-gain tests: the core exposes no control for them yet.',
  ],
}
