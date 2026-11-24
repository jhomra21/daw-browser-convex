// Acceptance tests from eq-filters.md section 3: E1/E3 (response vs analog), E2 (precision, NaN, denormals), E4 (click),
// E5 (slopes), A1 (drive), A2 (parity, latency), A3 (resonance level).
import { analogBandDb, audibleAliasDb, biquad, countNonFinite, logFrequencies, maxAbsDiff, peakAbs, peakDb, responseDb, rbjCoefficients, rms, toneFit } from '../dsp'
import { measureAliasingEnergyDb, measureThdPlusNoise } from '../../../packages/audio-engine/src/dsp-characterization'
import { autofilterLfo, eqWith, fx } from '../effects'
import type { EffectSpec } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { coherentFrequency, concat, impulse, linearToDb, noise, seededRandom, sine, sineWithPeakAt, silence } from '../signals'
import { createDefaultEqParams, designEqBand, eqCurveResponseDb } from '../../../packages/shared/src'
import { parityFixtures, parityScenario, robustnessScenarios } from './shared'

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

// 2^18 frames: a Q 18 band at 20 Hz rings for about 0.3 s, and a shorter impulse truncates that ringing into dB of error.
const impulseResponse = async (h: Parameters<Scenario['run']>[0], spec: EffectSpec) => {
  const { output } = await h.render(spec, { input: [impulse(2 ** 18)] }, { parity: false })

  return output[0]
}

const hiQuality = { highQuality: true }

const bandResponseFor = (name: string, extra: { highQuality: boolean }, limit: (rate: number) => number): Scenario => ({
  effect: 'eq',
  name,
  run: async (h) => {
    const frequencies = logFrequencies(20, 0.45 * h.rate, 256)
    let worst = 0
    let worstBand = ''
    const errors: number[] = []

    for (const band of randomBands(h.rate, 20)) {
      const response = responseDb(await impulseResponse(h, eqWith({ type: band.type, frequency: band.frequency, q: band.q, gainDb: band.gainDb }, extra)), h.rate, frequencies)

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

    h.atMost('worst |digital - analog| over 20 random bands, 20 Hz to 0.45 fs (analog > -60 dB)', worst, limit(h.rate), 'dB', worstBand)
    h.info('median band error', errors.toSorted((a, b) => a - b)[errors.length >> 1], 'dB')
  },
})

const bandResponseScenario = bandResponseFor('band-response-vs-analog', { highQuality: false }, (rate) => (rate >= 96000 ? 0.25 : 0.5))

// The 4 dB gate below 96 kHz is for shelves: a shelf's analog response is not band-limited, so its error near Nyquist is reported, not gated tight.
const bandResponseHq = bandResponseFor('band-response-vs-analog-hq', hiQuality, (rate) => (rate >= 96000 ? 0.25 : 4))

const referenceBandsFor = (name: string, extra: { highQuality: boolean }): Scenario => ({
  effect: 'eq',
  name,
  run: async (h) => {
    const at = (spec: EffectSpec, type: string, f0: number, q: number, gainDb: number, probe: number, limit: number, label: string, note: string) =>
      impulseResponse(h, spec).then((ir) => {
        const [measured] = responseDb(ir, h.rate, [probe])
        h.atMost(label, Math.abs(measured - analogBandDb(type, f0, q, gainDb, probe)), limit, 'dB', note)
      })

    await at(eqWith({ type: 'peaking', frequency: 12000, gainDb: 12, q: 1 }, extra), 'peaking', 12000, 1, 12, 20000, 0.5, '12 kHz +12 dB Q1 bell, error at 20 kHz', 'report: +1.15 dB vs analog +5.66 dB')
    await at(eqWith({ type: 'lowpass', frequency: 16000, q: Math.SQRT1_2 }, extra), 'lowpass', 16000, Math.SQRT1_2, 0, 20000, 1, '16 kHz low-pass, error at 20 kHz', 'report: -13.5 dB vs analog -5.4 dB')

    if (h.rate === 44100) await at(eqWith({ type: 'peaking', frequency: 18000, gainDb: 12, q: 1 }, extra), 'peaking', 18000, 1, 12, 21000, 1, '18 kHz +12 dB Q1 bell, error at 21 kHz', 'E3: within 1 dB up to 21 kHz at 44.1 kHz')
  },
})

const referenceBands = referenceBandsFor('cramping-reference-bands', { highQuality: false })
const referenceBandsHq = referenceBandsFor('cramping-reference-bands-hq', hiQuality)

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
      const reference = designEqBand(band.type, band.frequency, h.rate, band.q, band.gainDb).reduce<ArrayLike<number>>((signal, section) => biquad(signal, section), input)
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

    h.atLeast('high-pass 1 kHz: attenuation at 250 Hz', await attenuation(eqWith({ type: 'highpass48', frequency: 1000, q: Math.SQRT1_2 }), 250), 44, 'dB', 'E5: 48 dB/oct cut')
    h.atLeast('low-pass 1 kHz: attenuation at 4 kHz', await attenuation(eqWith({ type: 'lowpass48', frequency: 1000, q: Math.SQRT1_2 }), 4000), 44, 'dB', 'E5: 48 dB/oct cut')
  },
}

const slopes12: Scenario = {
  effect: 'eq',
  name: 'cut-slope-12',
  rates: [48000],
  run: async (h) => {
    const frames = h.rate

    const attenuation = async (spec: EffectSpec, frequency: number) => {
      const input = sine(frames, coherentFrequency(frequency, frames / 2, h.rate), h.rate, 0.5)
      const { output } = await h.render(spec, { input: [input] }, { parity: false })

      return linearToDb(rms(input.subarray(h.rate / 2)) / rms(output[0].subarray(h.rate / 2)))
    }

    h.atLeast('12 dB high-pass 1 kHz: attenuation at 250 Hz', await attenuation(eqWith({ type: 'highpass', frequency: 1000, q: Math.SQRT1_2 }), 250), 22, 'dB', '12 dB/oct, two octaves')
  },
}

const modes: Scenario = {
  effect: 'eq',
  name: 'channel-modes-and-globals',
  rates: [48000],
  run: async (h) => {
    const input = sine(h.rate, coherentFrequency(1000, h.rate / 2, h.rate), h.rate, 0.25)

    const gainOf = async (spec: EffectSpec, channels: Float32Array[]) => {
      const { output } = await h.render(spec, { input: channels }, { parity: false })

      return output.map((out, c) => linearToDb(rms(out.subarray(h.rate / 2)) / rms(channels[c].subarray(h.rate / 2))))
    }

    const bell = { type: 'peaking', frequency: 1000, gainDb: 12, q: 1 } as const

    const stereo = await gainOf(eqWith(bell), [input, input])
    h.within('stereo mode: left bell gain at its centre', stereo[0], 12, 0.3, 'dB')
    h.within('stereo mode: right equals left', stereo[1], stereo[0], 0.01, 'dB')
    const lr = await gainOf(eqWith(bell, { channelMode: 'leftRight' }), [input, input])
    h.within('L/R mode: curve A shapes the left channel', lr[0], 12, 0.3, 'dB')
    h.within('L/R mode: curve B (idle) leaves the right channel alone', lr[1], 0, 0.05, 'dB')
    const scaled = await gainOf(eqWith(bell, { scale: 0.5 }), [input, input])
    h.within('Scale 50 % halves the bell gain', scaled[0], 6, 0.3, 'dB')
    const out = await gainOf(eqWith({ ...bell, enabled: false }, { outputDb: -6 }), [input, input])
    h.within('Output -6 dB', out[0], -6, 0.05, 'dB')
    const adaptive = await gainOf(eqWith(bell, { adaptiveQ: true }), [input, input])
    h.within('Adaptive Q leaves the centre gain unchanged', adaptive[0], 12, 0.3, 'dB')
    const ms = await gainOf(eqWith(bell, { channelMode: 'midSide' }), [input, input])
    h.within('M/S mode: curve A shapes the mid of a mono signal', ms[0], 12, 0.3, 'dB')
    const side = await gainOf(eqWith(bell, { channelMode: 'midSide' }), [input, Float32Array.from(input, (v) => -v)])
    h.within('M/S mode: curve A leaves a side-only signal alone', side[0], 0, 0.3, 'dB')
  },
}

const graphMatchesRender: Scenario = {
  effect: 'eq',
  name: 'graph-curve-vs-render',
  run: async (h) => {
    const bands = [
      { type: 'peaking', frequency: 3000, q: 2, gainDb: 9 },
      { type: 'highshelf', frequency: 9000, q: 0.8, gainDb: -6 },
      { type: 'lowpass48', frequency: 14000, q: 0.707, gainDb: 0 },
    ] as const

    for (const highQuality of [false, true]) {
      const defaults = createDefaultEqParams()
      const params = { ...defaults, highQuality, bands: defaults.bands.map((band, index) => (index < bands.length ? { ...band, ...bands[index], enabled: true } : { ...band, enabled: false })) }
      const frequencies = logFrequencies(20, 0.45 * h.rate, 128)
      const drawn = eqCurveResponseDb(params, 0, frequencies, h.rate)
      const spec = eqWith({}, { highQuality, bands: params.bands.map((band) => ({ enabled: band.enabled, type: band.type, frequency: band.frequency, gainDb: band.gainDb, q: band.q })) })
      const rendered = responseDb(await impulseResponse(h, spec), h.rate, frequencies)
      const error = Math.max(...rendered.map((db, i) => (drawn[i] < -60 ? 0 : Math.abs(db - drawn[i]))))
      h.atMost(`drawn graph curve vs wasm render, Hi-Quality ${highQuality ? 'on' : 'off'}`, error, 0.05, 'dB', 'E1')
    }
  },
}

const hqLatency: Scenario = {
  effect: 'eq',
  name: 'hq-latency-and-cpu',
  run: async (h) => {
    const spec = eqWith({ type: 'peaking', frequency: 1000, gainDb: 6, q: 2 }, hiQuality)
    h.within('Hi-Quality impulse peak delay vs declared latency (3)', await h.latencyFrames(spec), 3, 1, 'frames')
    h.info('CPU, Hi-Quality on', await h.cpuNsPerFrame(spec), 'ns/frame')
    h.info('CPU, Hi-Quality off', await h.cpuNsPerFrame(eqWith({ type: 'peaking', frequency: 1000, gainDb: 6, q: 2 })), 'ns/frame')
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
      h.atMost('alias energy up to 20 kHz, 24 dB drive, 4992 Hz', audibleAliasDb(tail(driven.output[0]), aliasHz, h.rate, Math.ceil(h.rate / aliasHz) + 2), -50, 'dB rel. fundamental')
      h.info('alias energy up to Nyquist, 24 dB drive, 4992 Hz', measureAliasingEnergyDb(tail(driven.output[0]), aliasHz, h.rate, Math.ceil(h.rate / aliasHz) + 2), 'dB rel. fundamental', 'at 48 kHz the 5th harmonic sits in the half-band transition and folds to 23 kHz')
    } catch (error) {
      h.info('alias energy, 24 dB drive', null, '', error instanceof Error ? error.message : String(error))
    }

    const plain = await h.render(fx.autofilter({ ...open, driveDb: 24, hiQuality: false }), { input: [sine(frames, aliasHz, h.rate, 0.5)] }, { parity: false })

    h.info('alias energy, 24 dB drive, Hi-Quality off', measureAliasingEnergyDb(tail(plain.output[0]), aliasHz, h.rate, Math.ceil(h.rate / aliasHz) + 2), 'dB rel. fundamental', 'A1: the saved reduction is what Hi-Quality buys')
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

    const attenuation = async (slope: 12 | 24) => {
      const { output } = await h.render(fx.autofilter({ frequencyHz: 1000, resonance: 0, slope }), { input: [input] })

      return -linearToDb(toneFit(output[0], f, h.rate, h.rate).amplitude / 0.1)
    }

    h.info('attenuation at 4 kHz of a 1 kHz low-pass, 12 dB slope', await attenuation(12), 'dB', 'two octaves of 12 dB/oct')
    h.atLeast('attenuation at 4 kHz of a 1 kHz low-pass, 24 dB slope', await attenuation(24), 44, 'dB', 'A5: 24 dB/oct slope')
  },
}

const hiQualityLatency: Scenario = {
  effect: 'autofilter',
  name: 'latency-hi-quality',
  run: async (h) => {
    const open = { frequencyHz: 20000, resonance: 0 }

    for (const hiQuality of [true, false]) {
      h.within(`impulse peak delay, Hi-Quality ${hiQuality ? 'on' : 'off'}`, await h.latencyFrames(fx.autofilter({ ...open, hiQuality })), hiQuality ? 63 : 0, 2, 'frames', 'A2: 63 frames of half-band pair, none when off')
      h.info(`CPU relative to empty graph, Hi-Quality ${hiQuality ? 'on' : 'off'}`, await h.cpuNsPerFrame(fx.autofilter({ hiQuality })), 'ns/frame')
    }
  },
}

const windowedDb = (signal: Float32Array, window: number) => Array.from({ length: Math.floor(signal.length / window) }, (_, index) => linearToDb(rms(signal.subarray(index * window, (index + 1) * window), 1) + 1e-9))

const lfoWaveforms: Scenario = {
  effect: 'autofilter',
  name: 'lfo-shapes',
  rates: [48000],
  run: async (h) => {
    const input = sine(4 * h.rate, coherentFrequency(2000, h.rate, h.rate), h.rate, 0.1)

    for (const waveform of ['sine', 'triangle', 'sawDown', 'sawUp', 'square', 'sampleHold'] as const) {
      const { output } = await h.render(fx.autofilter({ frequencyHz: 500, resonance: 0, hiQuality: false, lfo: { ...autofilterLfo, waveform, rateHz: 2, depthOctaves: 2 } }), { input: [input] }, { parity: false })
      const levels = windowedDb(output[0].subarray(h.rate), Math.round(h.rate / 100))

      h.atLeast(`2 kHz level swing through a 2-octave ${waveform} sweep of a 500 Hz low-pass`, Math.max(...levels) - Math.min(...levels), 6, 'dB', 'A5: every shape moves the cutoff')
    }
  },
}

const tempoSync: Scenario = {
  effect: 'autofilter',
  name: 'lfo-tempo-sync',
  rates: [48000],
  run: async (h) => {
    const input = sine(2 * h.rate, coherentFrequency(2000, h.rate, h.rate), h.rate, 0.1)
    const lfo = { ...autofilterLfo, depthOctaves: 2 }
    const free = await h.render(fx.autofilter({ frequencyHz: 500, hiQuality: false, lfo: { ...lfo, rateHz: 2 } }), { input: [input] }, { parity: false })
    const synced = await h.render(fx.autofilter({ frequencyHz: 500, hiQuality: false, lfo: { ...lfo, sync: true, division: 5 } }), { input: [input] }, { parity: false })

    h.atMost('1/4 note at the core default 120 bpm against a 2 Hz free LFO', Math.max(...free.output[0].map((value, index) => Math.abs(value - synced.output[0][index]))), 1e-3, 'abs', 'A5: tempo sync')
  },
}

const envelopeLaw: Scenario = {
  effect: 'autofilter',
  name: 'envelope-law',
  rates: [48000],
  run: async (h) => {
    const f = coherentFrequency(2000, h.rate, h.rate)

    const gainAt = async (amplitude: number, amountOctaves: number) => {
      const { output } = await h.render(fx.autofilter({ frequencyHz: 500, resonance: 0, hiQuality: false, envelope: { amountOctaves, attackMs: 10, releaseMs: 100, hold: false, link: false } }), { input: [sine(2 * h.rate, f, h.rate, amplitude)] }, { parity: false })

      return linearToDb(toneFit(output[0], f, h.rate, h.rate).amplitude / amplitude)
    }

    h.atLeast('gain at 2 kHz, loud (-6 dBFS) minus quiet (-36 dBFS) input, envelope +2 oct', await gainAt(0.5, 2) - await gainAt(0.016, 2), 6, 'dB', 'A4: the envelope follows level in dB')
    h.within('gain change at 2 kHz with envelope amount 0 between those inputs', await gainAt(0.5, 0) - await gainAt(0.016, 0), 0, 0.1, 'dB', 'the amount scales the whole effect')
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

// The Web Audio fallback worklet keeps its own filter (tanh drive, six frames of delay, no limiter), so the core is no longer
// expected to match it; the rows show how far the two sit apart for settings the fallback can express.
const legacyFallbackComparison: Scenario = {
  effect: 'autofilter',
  name: 'legacy-fallback-difference',
  run: async (h) => {
    const spec = fx.autofilter({ frequencyHz: 800, resonance: 0.3, hiQuality: false, driveDb: 0, envelope: { amountOctaves: 1, attackMs: 10, releaseMs: 100, hold: false, link: false } })

    for (const [name, input] of parityFixtures(h.rate)) {
      const { output, legacy } = await h.render(spec, { input: [input] })

      if (legacy === null) h.info(`legacy fallback difference, ${name}`, null, '', 'not measured: legacy implementation is a Web Audio node chain')
      else h.info(`legacy fallback difference, ${name}`, Math.max(maxAbsDiff(output[0], legacy[0]), maxAbsDiff(output[1], legacy[1])), 'abs', 'by design: the fallback keeps its own filter')
    }
  },
}

export const eqFilters: Family = {
  scenarios: [
    bandResponseScenario, bandResponseHq, referenceBands, referenceBandsHq, slopes12, modes, graphMatchesRender, hqLatency, precision, gainStepClick, slopes, nanInputGuard,
    autofilterDrive, resonanceLevel, lowpassSlope, sweepClick, hiQualityLatency, lfoWaveforms, tempoSync, envelopeLaw,
    parityScenario('eq', eqWith({ type: 'peaking', frequency: 1000, gainDb: 6, q: 2 })),
    ...robustnessScenarios('eq', eqWith({ type: 'peaking', frequency: 1000, gainDb: 6, q: 2 }), () => 0),
    legacyFallbackComparison,
    ...robustnessScenarios('autofilter', fx.autofilter(), null),
  ],
  notEncoded: [
    'E1(f): "1000 random band sets" is run as 20 deterministic bands per rate; the Web Audio EQ (BiquadFilterNode) cannot be rendered because bun has no OfflineAudioContext.',
    'E3(f) 500 bands and E5 M/S mode: need controls the EQ does not have yet. A7 type/slope switch click: the harness patches continuous targets only, so the crossfade is measured by the daw-autofilter-switch native test instead. Auto Filter alias at 24 dB drive and 48 kHz stays above the -50 dB target (the shared half-band transition band).',
  ],
}
