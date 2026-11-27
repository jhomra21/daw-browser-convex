// Acceptance tests from saturation-utility.md section 3 for the spectral effect (threshold normalisation, freeze, identity). The Lo-Fi
// rows live in lofi.ts and the Utility rows in utility.ts.
import { maxAbsDiff, peakAbs, rms } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { linearToDb, noise, sine } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

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

const spectralSpec = fx.spectral()

export const saturationUtility: Family = {
  scenarios: [
    ...spectralScenarios,
    parityScenario('spectral', spectralSpec),
    ...robustnessScenarios('spectral', spectralSpec, () => 2048),
  ],
  notEncoded: [
    'Spectral freeze ripple and HPSS neutral-gain tests: the core exposes no control for them yet.',
  ],
}
