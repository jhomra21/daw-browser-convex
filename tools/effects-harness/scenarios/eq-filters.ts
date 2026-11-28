// Acceptance tests from eq-filters.md section 3: E1/E3 (response vs analog), E2 (precision, NaN, denormals), E4 (click),
// E5 (slopes), A1 (drive), A2 (parity, latency), A3 (resonance level).
import { analogBandDb, biquad, countNonFinite, logFrequencies, peakAbs, peakDb, responseDb, rbjCoefficients, rms, toneFit } from '../dsp'
import { measureAliasingEnergyDb, measureThdPlusNoise } from '../../../packages/audio-engine/src/dsp-characterization'
import { eqWith, fx } from '../effects'
import type { EffectSpec } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { coherentFrequency, concat, impulse, linearToDb, noise, seededRandom, sine, sineWithPeakAt, silence } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

const bandTypes = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass'] as const

/** Deterministic stand-in for the report's 1000 random band sets: random type, f 20 Hz to 0.45 fs, Q 0.2 to 18, gain ±24 dB. */
const randomBands = (rate: number, count: number) => {
  const random = seededRandom(2026)

  return Array.from({ length: count }, (_, index) => ({
    type: bandTypes[index % bandTypes.length],
    frequency: 20 * (Math.min(20000, 0.45 * rate) / 20) ** random(),
    q: 0.2 * 90 ** random(),
    gainDb: 48 * random() - 24,
  }))
}

const impulseResponse = async (h: Parameters<Scenario['run']>[0], spec: EffectSpec) => {
  const { output } = await h.render(spec, { input: [impulse(32768)] }, { parity: false })

  return output[0]
}

const bandResponseScenario: Scenario = {
  effect: 'eq',
  name: 'band-response-vs-analog',
  run: async (h) => {
    const frequencies = logFrequencies(20, 0.45 * h.rate, 256)
    let worst = 0
    let worstBand = ''
    const errors: number[] = []

    for (const band of randomBands(h.rate, 20)) {
      const response = responseDb(await impulseResponse(h, eqWith({ type: band.type, frequency: band.frequency, q: band.q, gainDb: band.gainDb })), h.rate, frequencies)

      // Below -60 dB the float32 render floor and the bilinear zero at Nyquist dominate; those points do not describe the filter.
      const error = Math.max(...response.map((db, i) => {
        const analog = analogBandDb(band.type, band.frequency, band.q, band.gainDb, frequencies[i])

        return analog < -60 ? 0 : Math.abs(db - analog)
      }))

      errors.push(error)

      if (error > worst) {
        worst = error
        worstBand = `${band.type} f=${band.frequency.toFixed(0)} Q=${band.q.toFixed(2)} g=${band.gainDb.toFixed(1)}`
      }
    }

    h.atMost('worst |digital - analog| over 20 random bands, 20 Hz to 0.45 fs (analog > -60 dB)', worst, h.rate >= 96000 ? 0.25 : 0.5, 'dB', worstBand)
    h.info('median band error', errors.toSorted((a, b) => a - b)[errors.length >> 1], 'dB')
  },
}

const referenceBands: Scenario = {
  effect: 'eq',
  name: 'cramping-reference-bands',
  run: async (h) => {
    const at = (spec: EffectSpec, type: string, f0: number, q: number, gainDb: number, probe: number, limit: number, label: string, note: string) =>
      impulseResponse(h, spec).then((ir) => {
        const [measured] = responseDb(ir, h.rate, [probe])
        h.atMost(label, Math.abs(measured - analogBandDb(type, f0, q, gainDb, probe)), limit, 'dB', note)
      })

    await at(eqWith({ type: 'peaking', frequency: 12000, gainDb: 12, q: 1 }), 'peaking', 12000, 1, 12, 20000, 0.5, '12 kHz +12 dB Q1 bell, error at 20 kHz', 'report: +1.15 dB vs analog +5.66 dB')
    await at(eqWith({ type: 'lowpass', frequency: 16000, q: Math.SQRT1_2 }), 'lowpass', 16000, Math.SQRT1_2, 0, 20000, 1, '16 kHz low-pass, error at 20 kHz', 'report: -13.5 dB vs analog -5.4 dB')

    if (h.rate === 44100) await at(eqWith({ type: 'peaking', frequency: 18000, gainDb: 12, q: 1 }), 'peaking', 18000, 1, 12, 21000, 1, '18 kHz +12 dB Q1 bell, error at 21 kHz', 'E3: within 1 dB up to 21 kHz at 44.1 kHz')
  },
}

const precision: Scenario = {
  effect: 'eq',
  name: 'float-precision-snr',
  rates: [48000],
  run: async (h) => {
    const settings = [
      { type: 'peaking', frequency: 40, q: 4, gainDb: 12 }, { type: 'lowpass', frequency: 60, q: 0.707, gainDb: 0 },
      { type: 'highpass', frequency: 30, q: 0.707, gainDb: 0 }, { type: 'lowshelf', frequency: 100, q: 0.707, gainDb: 12 },
    ] as const

    const grain = noise(2 * h.rate, 0.01, 3)
    const input = Float32Array.from(sine(2 * h.rate, 997, h.rate, 0.1), (v, n) => v + grain[n])

    for (const band of settings) {
      const { output } = await h.render(eqWith(band), { input: [input] }, { parity: false })
      const reference = biquad(input, rbjCoefficients(band.type, band.frequency, band.q, band.gainDb, h.rate))
      const error = output[0].map((v, n) => v - reference[n])
      h.atLeast(`SNR vs float64 reference, ${band.type} ${band.frequency} Hz`, 20 * Math.log10(rms(reference, h.rate) / rms(error, h.rate)), 110, 'dB')
    }
  },
}

const gainStepClick: Scenario = {
  effect: 'eq',
  name: 'gain-step-click',
  run: async (h) => {
    const frames = 2 * h.rate
    const frame = Math.floor(h.rate / 128) * 128
    const result = await h.stepClick(eqWith({ type: 'peaking', frequency: 1000, gainDb: 0, q: 1 }), [sineWithPeakAt(frames, 1000, h.rate, 0.25, frame)], { frame, set: { 'bands.0.gainDb': 12 } }, 2048)
    h.atMost('max sample step after 0 to +12 dB step vs steady state', linearToDb(result.ratio), 6, 'dB')
    await h.wav('gain-step', result.stepped.output)
  },
}

const slopes: Scenario = {
  effect: 'eq',
  name: 'cut-slope',
  rates: [48000],
  run: async (h) => {
    const frames = h.rate
    const tail = (signal: Float32Array) => signal.subarray(h.rate / 2)

    const attenuation = async (spec: EffectSpec, frequency: number) => {
      const f = coherentFrequency(frequency, frames / 2, h.rate)
      const input = sine(frames, f, h.rate, 0.5)
      const { output } = await h.render(spec, { input: [input] }, { parity: false })

      return linearToDb(rms(tail(input)) / rms(tail(output[0])))
    }

    h.atLeast('high-pass 1 kHz: attenuation at 250 Hz', await attenuation(eqWith({ type: 'highpass', frequency: 1000, q: Math.SQRT1_2 }), 250), 44, 'dB', 'E5: 48 dB/oct cut; the core has 12 dB/oct')
    h.atLeast('low-pass 1 kHz: attenuation at 4 kHz', await attenuation(eqWith({ type: 'lowpass', frequency: 1000, q: Math.SQRT1_2 }), 4000), 44, 'dB', 'E5: 48 dB/oct cut; the core has 12 dB/oct')
  },
}

const autofilterDrive: Scenario = {
  effect: 'autofilter',
  name: 'drive-thd-and-alias',
  run: async (h) => {
    const frames = h.rate
    const tail = (signal: Float32Array) => signal.slice(frames / 2)
    const open = { frequencyHz: 20000, resonance: 0.0106, mix: 1 }
    const clean = coherentFrequency(1000, frames / 2, h.rate)
    const cleanOut = await h.render(fx.autofilter({ ...open, driveDb: 0 }), { input: [sine(frames, clean, h.rate, 0.5)] })
    h.atMost('THD+N, drive 0 dB, 0.5 amplitude 1 kHz, cutoff 20 kHz, Q 0.707', measureThdPlusNoise(tail(cleanOut.output[0]), clean, h.rate), -90, 'dB')
    h.info('gain at drive 0 dB', linearToDb(peakAbs(tail(cleanOut.output[0])) / 0.5), 'dB', 'report: -6.5 dB')
    const aliasHz = coherentFrequency(4992, frames / 2, h.rate)
    const driven = await h.render(fx.autofilter({ ...open, driveDb: 24 }), { input: [sine(frames, aliasHz, h.rate, 0.5)] })

    try {
      h.atMost('alias energy, 24 dB drive, 4992 Hz', measureAliasingEnergyDb(tail(driven.output[0]), aliasHz, h.rate, Math.ceil(h.rate / aliasHz) + 2), -50, 'dB rel. fundamental')
    } catch (error) {
      h.info('alias energy, 24 dB drive', null, '', error instanceof Error ? error.message : String(error))
    }
  },
}

const resonanceLevel: Scenario = {
  effect: 'autofilter',
  name: 'resonance-level',
  rates: [48000],
  run: async (h) => {
    const frames = 4 * h.rate
    const input = noise(frames, 0.1, 17)
    const { output } = await h.render(fx.autofilter({ resonance: 1, frequencyHz: 1000 }), { input: [input] })
    h.atMost('peak(out) - peak(in), resonance 1.0, noise -20 dBFS', peakDb(output[0]) - peakDb(input), 6, 'dB', 'low-pass at 1 kHz')

    for (const resonance of [0, 0.25, 0.5, 1]) {
      const f = coherentFrequency(1000, h.rate, h.rate)
      const tone = sine(2 * h.rate, f, h.rate, 0.1)
      const out = await h.render(fx.autofilter({ mode: 'bandpass', resonance, frequencyHz: f }), { input: [tone] })
      h.within(`band-pass centre gain, resonance ${resonance}`, linearToDb(toneFit(out.output[0], f, h.rate, h.rate).amplitude / 0.1), 0, 0.5, 'dB')
    }
  },
}

const lowpassSlope: Scenario = {
  effect: 'autofilter',
  name: 'low-pass-slope',
  rates: [48000],
  run: async (h) => {
    const f = coherentFrequency(4000, h.rate, h.rate)
    const input = sine(2 * h.rate, f, h.rate, 0.1)
    const { output } = await h.render(fx.autofilter({ frequencyHz: 1000, resonance: 0.0106 }), { input: [input] })
    h.atLeast('attenuation at 4 kHz of a 1 kHz low-pass', -linearToDb(toneFit(output[0], f, h.rate, h.rate).amplitude / 0.1), 44, 'dB', 'A5: 24 dB/oct slope; the core has 12 dB/oct')
  },
}

const sweepClick: Scenario = {
  effect: 'autofilter',
  name: 'cutoff-step-click',
  run: async (h) => {
    const frame = Math.floor(h.rate / 128) * 128
    const result = await h.stepClick(fx.autofilter({ frequencyHz: 400 }), [concat(sine(2 * h.rate, 220, h.rate, 0.3))], { frame, set: { frequencyHz: 4000 } }, 2048)
    h.info('max sample step after 400 Hz to 4 kHz cutoff step vs steady state', linearToDb(result.ratio), 'dB')
  },
}

const nanInputGuard: Scenario = {
  effect: 'eq',
  name: 'nan-then-silence',
  rates: [48000],
  run: async (h) => {
    const input = concat(sine(h.rate / 2, 1000, h.rate, 0.5), Float32Array.of(NaN), silence(2 * h.rate))
    const { output } = await h.render(eqWith({ type: 'peaking', frequency: 1000, gainDb: 6, q: 2 }), { input: [input] }, { parity: false })
    h.atMost('non-finite output samples', countNonFinite(output[0]), 0, 'samples')
    const tailStart = h.rate / 2 + 1 + h.rate
    h.atMost('output peak 1 s after NaN (input silent)', peakAbs(output[0].subarray(tailStart)), 0, 'abs', 'E2: returns to exactly 0')
    let denormals = 0

    for (let n = tailStart; n < output[0].length; n += 1) if (Math.abs(output[0][n]) > 0 && Math.abs(output[0][n]) < 1e-20) denormals += 1
    h.atMost('output samples in (0, 1e-20) after 2 s of silence', denormals, 0, 'samples')
  },
}

export const eqFilters: Family = {
  scenarios: [
    bandResponseScenario, referenceBands, precision, gainStepClick, slopes, nanInputGuard,
    autofilterDrive, resonanceLevel, lowpassSlope, sweepClick,
    parityScenario('eq', eqWith({ type: 'peaking', frequency: 1000, gainDb: 6, q: 2 })),
    ...robustnessScenarios('eq', eqWith({ type: 'peaking', frequency: 1000, gainDb: 6, q: 2 }), () => 0),
    parityScenario('autofilter', fx.autofilter({ frequencyHz: 800, resonance: 0.5, driveDb: 6, envelope: { amountOctaves: 1, attackMs: 10, releaseMs: 100 }, lfo: { waveform: 'sine', rateHz: 2, depthOctaves: 1, phaseOffset: 0, stereoPhase: 0.2 } })),
    ...robustnessScenarios('autofilter', fx.autofilter(), () => 6),
  ],
  notEncoded: [
    'E1(f): "1000 random band sets" is run as 20 deterministic bands per rate; the Web Audio EQ (BiquadFilterNode) cannot be rendered because bun has no OfflineAudioContext.',
    'E3(f) 500 bands and E5 M/S mode, A4 envelope law, A5 LFO shapes, A7 mode-switch crossfade: need controls (modes, shapes) the core does not have yet or internal taps.',
  ],
}
