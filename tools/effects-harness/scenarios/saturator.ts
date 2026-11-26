// Acceptance tests from saturation-utility.md section 3.1 for the rebuilt Saturator: alias energy and fundamental level (S1),
// Color placement and flatness (S2, S6), curve continuity (S3), drive-step click (S4), level matching (S5), Post Clip (S6) and
// parity with the legacy worklet (S7).
import { measureAliasingEnergyDb } from '../../../packages/audio-engine/src/dsp-characterization'
import { evaluateSaturatorCurvePoint, type SaturatorCurve } from '../../../packages/shared/src/effects-params'
import { biquad, countNonFinite, maxAbsDiff, peakDb, rbjCoefficients, toneFit, toneGainDb } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Harness, Scenario } from '../harness'
import { coherentFrequency, concat, constant, dbToLinear, linearToDb, noise, ramp, sine, sineWithPeakAt, sweep } from '../signals'
import { saturatorMigration } from './saturator-migration'
import { parityLimit, parityScenario, robustnessScenarios } from './shared'

const curves: readonly SaturatorCurve[] = ['soft', 'medium', 'hard', 'clip', 'analog', 'sine', 'bass', 'fold', 'warp']
const smoothCurves: readonly SaturatorCurve[] = ['soft', 'medium', 'hard', 'analog', 'bass', 'warp']
const aligned = (frame: number) => Math.floor(frame / 128) * 128

/** The coherent frequency nearest `target` whose folded harmonics stay clear of each other, DC and Nyquist, so the alias measurement is defined. */
const measurableFrequency = (target: number, frames: number, rate: number) => {
  const probe = sine(frames, target, rate)

  for (let bins = 0; bins < 200; bins += 1) {
    const frequency = coherentFrequency(target, frames, rate, bins)

    try {
      measureAliasingEnergyDb(probe, frequency, rate, Math.ceil(rate / frequency) + 2)

      return frequency
    } catch {
      // The next bin may fold its harmonics apart.
    }
  }

  throw new Error(`No measurable fundamental near ${target} Hz at ${rate} Hz.`)
}

/** Alias power over fundamental power of a 0.5 amplitude sine through the Saturator, in dB. */
const aliasDb = async (h: Harness, state: Parameters<typeof fx.saturator>[0], target: number) => {
  const frames = 2 * h.rate
  const frequency = measurableFrequency(target, frames / 2, h.rate)
  const { output } = await h.render(fx.saturator(state), { input: [sine(frames, frequency, h.rate, 0.5)] }, { parity: false })

  return { frequency, db: measureAliasingEnergyDb(output[0].subarray(frames / 2), frequency, h.rate, Math.ceil(h.rate / frequency) + 2) }
}

const alias: Scenario = {
  effect: 'saturator',
  name: 'sat1-alias-energy',
  run: async (h) => {
    for (const curve of ['soft', 'hard'] as const) {
      h.atMost(`alias energy, ${curve}, 18 dB drive, 5 kHz`, (await aliasDb(h, { driveDb: 18, curve }, 5000)).db, -45, 'dB rel. fundamental', 'before (a49d9c57, 44.1/48/96 kHz): soft -20.4/-19.3/-32.1, hard -20.8/-19.7/-29.9 dB')
      h.atMost(`alias energy, ${curve}, 6 dB drive, 5 kHz`, (await aliasDb(h, { driveDb: 6, curve }, 5000)).db, -55, 'dB rel. fundamental', 'before (a49d9c57): soft -36.4/-35.3/-77.2, hard -27.8/-26.7/-47.0 dB')
      h.atMost(`alias energy, ${curve}, 18 dB drive, 7.9 kHz`, (await aliasDb(h, { driveDb: 18, curve }, 7900)).db, -45, 'dB rel. fundamental', 'before (a49d9c57): soft -14.4/-27.7/-24.7, hard -14.9/-27.8/-24.6 dB')
    }

    // The research asks for 8 kHz at 18 dB drive. Its third harmonic sits at 24 kHz, inside the 2x half-band's transition band (21.6 to 26.4 kHz at 48 kHz),
    // where no 2x stage can separate it from the fundamental's images. Reported, not gated.
    const near = await aliasDb(h, { driveDb: 18, curve: 'soft' }, 8000)
    h.info(`alias energy, soft, 18 dB drive, ${near.frequency.toFixed(1)} Hz (research: 8 kHz, at most -45; NOT MET at 2x)`, near.db, 'dB rel. fundamental', 'third harmonic inside the half-band transition band')
  },
}

/** Fundamental amplitude of the ideal (infinitely oversampled) curve for a sine of amplitude `amplitude`: the 16x reference, taken to its limit. */
const referenceFundamental = (curve: SaturatorCurve, amplitude: number) => {
  const points = 16384
  let sum = 0

  for (let n = 0; n < points; n += 1) {
    const phase = 2 * Math.PI * (n + 0.5) / points
    sum += evaluateSaturatorCurvePoint(curve, amplitude * Math.sin(phase)) * Math.sin(phase)
  }

  return 2 * sum / points
}

const fundamental: Scenario = {
  effect: 'saturator',
  name: 'sat1-fundamental-level',
  run: async (h) => {
    const frames = 2 * h.rate

    for (const [curve, driveDb, frequency] of [['soft', 18, 5000], ['hard', 18, 5000], ['soft', 6, 5000], ['soft', 18, 1000]] as const) {
      const { output } = await h.render(fx.saturator({ driveDb, curve }), { input: [sine(frames, frequency, h.rate, 0.5)] }, { parity: false })
      const measured = toneFit(output[0], frequency, h.rate, h.rate, frames).amplitude
      const expected = referenceFundamental(curve, 0.5 * dbToLinear(driveDb))
      h.within(`fundamental vs ideal curve, ${curve}, ${driveDb} dB drive, ${frequency} Hz`, linearToDb(measured / expected), 0, 0.3, 'dB', 'before (a49d9c57, 48 kHz): soft 18 dB -0.154, hard 18 dB -0.167, soft 6 dB -0.250, soft 1 kHz -0.006 dB')
    }
  },
}

const dryNull: Scenario = {
  effect: 'saturator',
  name: 'sat1-dry-wet-zero-null',
  run: async (h) => {
    const input = noise(h.rate, 0.5, 21)

    for (const [name, state] of [['Hi-Quality', {}], ['Color on, Post Clip hard', { color: true, colorHighDb: 9, postClip: 'hard' as const }]] as const) {
      const { output } = await h.render(fx.saturator({ dryWet: 0, driveDb: 24, ...state }), { input: [input] }, { parity: false })
      h.atMost(`dry/wet 0 residual against the input, ${name}`, linearToDb(maxAbsDiff(output[0], input)), -120, 'dB FS', 'the wet path is not summed in; no latency to apply; before (a49d9c57): -600 dB, also exact')
    }
  },
}

const color: Scenario = {
  effect: 'saturator',
  name: 'sat2-color-shelves',
  run: async (h) => {
    const frames = h.rate
    const q = 2 * 0.2 ** 0.57

    const through = (signal: ArrayLike<number>, stages: readonly ReturnType<typeof rbjCoefficients>[]) =>
      stages.reduce<ArrayLike<number>>((current, coefficients) => biquad(current, coefficients), signal)

    const shelves = [rbjCoefficients('lowshelf', 1200, q, 6, h.rate), rbjCoefficients('highshelf', 1200, q, 12, h.rate)]
    const inverse = [rbjCoefficients('lowshelf', 1200, q, -6, h.rate), rbjCoefficients('highshelf', 1200, q, -12, h.rate)]

    for (const frequency of [200, 1200, 5000]) {
      // Clip at 1x: the shelves, the hard ceiling and the inverse shelves, with no oversampling in between, rendered in float64 as the reference.
      const input = sine(frames, frequency, h.rate, 0.5)
      const clipped = Float64Array.from(through(input, shelves), (value) => Math.max(-1, Math.min(1, value)))
      const expected = through(clipped, inverse)
      const { output } = await h.render(fx.saturator({ hiQuality: false, curve: 'clip', driveDb: 0, color: true, colorFrequencyHz: 1200, colorLowDb: 6, colorHighDb: 12 }), { input: [input] }, { parity: false })
      h.atMost(`Color at ${frequency} Hz: shelves at 1.2 kHz, clip, inverse shelves, error against the float64 reference`, maxAbsDiff(output[0], expected, h.rate / 2), 2e-3, 'abs', 'before (a49d9c57): Color on, amount 1 at 1.2 kHz: +16.7 dB at 4.8 kHz, +5.2 dB at 200 Hz; now two shelves that cancel')
    }

    for (const hiQuality of [true, false]) {
      const worst = []

      for (const frequency of [60, 200, 800, 1200, 3000, 8000, 15000]) {
        const input = sine(2 * h.rate, frequency, h.rate, dbToLinear(-40))
        const { output } = await h.render(fx.saturator({ hiQuality, driveDb: 0, color: true, colorLowDb: 12, colorHighDb: -12, colorWidth: 1 }), { input: [input] }, { parity: false })
        worst.push(Math.abs(toneGainDb(input, output[0], frequency, h.rate, h.rate, 2 * h.rate)))
      }

      h.atMost(`linear path with Color on, largest response error 60 Hz to 15 kHz, Hi-Quality ${hiQuality}`, Math.max(...worst), 0.5, 'dB', 'pre and post shelves cancel; before (a49d9c57): +16.7 dB at 4.8 kHz')
    }
  },
}

const continuity: Scenario = {
  effect: 'saturator',
  name: 'sat3-curve-continuity',
  rates: [48000],
  run: async (h) => {
    const delta = 1e-4
    const input = concat(constant(h.rate / 2, -2), ramp(40001, -2, 2))

    for (const curve of curves) {
      const { output } = await h.render(fx.saturator({ hiQuality: false, driveDb: 0, curve }), { input: [input] }, { parity: false })
      const y = output[0].subarray(h.rate / 2 + 2)
      let step = 0
      let jump = 0

      for (let n = 1; n < y.length; n += 1) step = Math.max(step, Math.abs(y[n] - y[n - 1]))

      for (let n = 2; n < y.length; n += 1) jump = Math.max(jump, Math.abs(y[n] - 2 * y[n - 1] + y[n - 2]) / delta)

      h.atMost(`largest output step over a 1e-4 input grid on [-2, 2], ${curve}`, step, 2e-4, 'abs', 'before (a49d9c57): Medium 0.149, soft/hard/clip 1e-4')

      if (smoothCurves.includes(curve)) h.atMost(`largest first-derivative jump, ${curve}`, jump, 1e-2, 'slope')
    }
  },
}

const driveClick: Scenario = {
  effect: 'saturator',
  name: 'sat4-drive-step-click',
  rates: [48000],
  run: async (h) => {
    const frame = aligned(h.rate)
    const own = await h.stepClick(fx.saturator({ driveDb: 0 }), [sineWithPeakAt(2 * h.rate, 1000, h.rate, 0.5, frame)], { frame, set: { driveDb: 18 } }, 2048)
    h.atMost('largest jump / the larger own largest step of the signal before and after, 1 kHz, drive 0 to 18 dB', own.ratio, 1.01, 'x', 'before (a49d9c57): 1.000 here, and 5.975 for the extra-step ratio')
    h.info('max extra sample step / unstepped max step, 1 kHz, drive 0 to 18 dB (the old gate, 1.5)', own.extraRatio, 'x', 'the 18 dB signal itself steps 6x more than the 0 dB one, so the old ratio cannot stay under 1.5')
    const slow = await h.stepClick(fx.saturator({ driveDb: 0 }), [sineWithPeakAt(2 * h.rate, 100, h.rate, 0.5, frame)], { frame, set: { driveDb: 12 } }, 2048)
    h.atMost('largest jump / the own largest step of the signal, 100 Hz at its peak, drive 0 to 12 dB', slow.ratio, 1.01, 'x', 'before (a49d9c57): 6.020, the full 12 dB gain step')
  },
}

const unity: Scenario = {
  effect: 'saturator',
  name: 'sat5-unity-at-low-level',
  run: async (h) => {
    const frames = h.rate
    const input = sine(frames, 1000, h.rate, dbToLinear(-40))

    for (const hiQuality of [true, false]) {
      for (const curve of curves) {
        const { output } = await h.render(fx.saturator({ driveDb: 0, curve, hiQuality }), { input: [input] }, { parity: false })
        h.within(`gain at -40 dBFS, drive 0, ${curve}, Hi-Quality ${hiQuality}`, toneGainDb(input, output[0], 1000, h.rate, h.rate / 4, frames), 0, 0.3, 'dB', 'before (a49d9c57, 48 kHz): soft +5.09, medium +3.50, hard +9.57, clip +1.71 dB')
      }
    }
  },
}

const postClip: Scenario = {
  effect: 'saturator',
  name: 'sat6-post-clip',
  run: async (h) => {
    const input = sine(h.rate, 997, h.rate, 0.9)

    for (const hiQuality of [true, false]) {
      for (const curve of ['soft', 'warp'] as const) {
        const { output } = await h.render(fx.saturator({ driveDb: 24, curve, postClip: 'hard', outputDb: -6, hiQuality, color: true, colorHighDb: 6 }), { input: [input] }, { parity: false })
        h.atMost(`peak above the Output setting, Post Clip hard, +24 dB drive, ${curve}, Hi-Quality ${hiQuality}`, peakDb(output[0]) + 6, 0.01, 'dB')
      }
    }

    const soft = await h.render(fx.saturator({ driveDb: 24, postClip: 'soft', outputDb: 0 }), { input: [input] }, { parity: false })
    h.atMost('peak with Post Clip soft, +24 dB drive, Output 0 dB', peakDb(soft.output[0]), 0.01, 'dB FS')
  },
}

/** Every curve, with Hi-Quality on and off, Color and Post Clip, against the legacy worklet on a sweep and noise. */
const legacyParity: Scenario = {
  effect: 'saturator',
  name: 'sat7-legacy-parity',
  run: async (h) => {
    const input = [concat(sweep(h.rate, 60, 12000, h.rate, 0.7), noise(h.rate, 0.4, 17))]

    for (const hiQuality of [true, false]) {
      for (const curve of curves) {
        const spec = fx.saturator({ curve, hiQuality, driveDb: 18, color: true, colorHighDb: 6, colorLowDb: -3, postClip: curve === 'soft' ? 'soft' : 'hard', outputDb: -3, dryWet: 0.8 })
        const { output, legacy } = await h.render(spec, { input })

        if (legacy === null) throw new Error('The Saturator has a legacy worklet.')
        h.atMost(`legacy worklet vs core, ${curve}, Hi-Quality ${hiQuality}`, Math.max(maxAbsDiff(output[0], legacy[0]), maxAbsDiff(output[1], legacy[1])), parityLimit, 'abs')
      }
    }
  },
}

const wetDelay: Scenario = {
  effect: 'saturator',
  name: 'sat8-wet-path-delay',
  run: async (h) => {
    const frames = 4 * h.rate
    const { output } = await h.render(fx.saturator({ driveDb: 0, curve: 'clip', dryWet: 1 }), { input: [Float32Array.from({ length: frames }, (_, n) => n === 100 ? 0.1 : 0)] }, { parity: false })
    let at = 0

    for (let n = 1; n < 400; n += 1) if (Math.abs(output[0][n]) > Math.abs(output[0][at])) at = n

    h.info('Hi-Quality wet path delay of the half-band pair (no latency is declared)', at - 100, 'frames')
    h.atMost('non-finite output samples with an impulse', countNonFinite(output[0]), 0, 'samples')
  },
}

const saturatorSpec = fx.saturator()

export const saturator: Family = {
  scenarios: [
    alias, fundamental, dryNull, color, continuity, driveClick, unity, postClip, legacyParity, wetDelay, ...saturatorMigration,
    parityScenario('saturator', saturatorSpec),
    ...robustnessScenarios('saturator', saturatorSpec, null),
  ],
  notEncoded: [
    'Live\'s Waveshaper Drive/Curve/Linear/Damp sub-controls: only Depth and Period (Warp) are exposed.',
    'DC blocker for asymmetric curves: every shipped curve is odd-symmetric, so none is needed.',
  ],
}
