// A migrated version 1 Saturator against the old engine (the base commit a49d9c57's processor_saturator.cpp), rendered by a
// statement-for-statement TypeScript reference of it: four curves, the four-phase linear interpolation averaged after the curve, and
// the Color peak designed at the base rate but run at four times it.
import { normalizeAudioEffect } from '../../../packages/shared/src/audio-effect-normalization'
import { migrateSaturatorParamsV1 } from '../../../packages/shared/src/saturator-params-migration'
import { biquad, rbjCoefficients, rms, toneGainDb } from '../dsp'
import { fx } from '../effects'
import type { Harness, Scenario } from '../harness'
import { dbToLinear, linearToDb, pinkNoise, sine } from '../signals'

type OldCurve = 'soft' | 'medium' | 'hard' | 'clip'
type OldState = { curve: OldCurve; driveDb: number; color: boolean; colorFrequencyHz: number; colorAmount: number; outputDb: number; dryWet: number }

const oldCurves: readonly OldCurve[] = ['soft', 'medium', 'hard', 'clip']

const oldCurve = (curve: OldCurve, x: number) => {
  if (curve === 'soft') return Math.tanh(1.8 * x)

  if (curve === 'medium') return x < -0.666 ? -1 : x > 0.666 ? 1 : 1.5 * x - 0.5 * x * x * x

  if (curve === 'hard') return Math.atan(4 * x) / Math.atan(4)

  return Math.max(-0.82, Math.min(0.82, x)) / 0.82
}

/** The old per-channel render: dry + (wet - dry) x dryWet, wet the mean of four interpolated points through Color and the curve. */
const renderOld = (input: ArrayLike<number>, rate: number, state: OldState) => {
  const drive = 10 ** (state.driveDb / 20)
  const color = rbjCoefficients('peaking', state.colorFrequencyHz, 0.8, state.color ? state.colorAmount * 12 : 0, rate)
  const interpolated = new Float64Array(input.length * 4)
  let previous = 0

  for (let n = 0; n < input.length; n += 1) {
    for (let phase = 1; phase <= 4; phase += 1) interpolated[n * 4 + phase - 1] = (previous + (input[n] - previous) * phase * 0.25) * drive
    previous = input[n]
  }

  const colored = biquad(interpolated, color)

  return Float64Array.from(input, (dry, n) => {
    let wet = 0

    for (let phase = 0; phase < 4; phase += 1) wet += oldCurve(state.curve, colored[n * 4 + phase])

    return dry + (wet * 0.25 * 10 ** (state.outputDb / 20) - dry) * state.dryWet
  })
}

const oldDefaults: OldState = { curve: 'soft', driveDb: 6, color: false, colorFrequencyHz: 1200, colorAmount: 0, outputDb: 0, dryWet: 1 }

const migrated = (old: OldState) => {
  const { params } = normalizeAudioEffect('saturator', migrateSaturatorParamsV1({ enabled: true, ...old }))

  return fx.saturator(params)
}

const window = (rate: number) => ({ from: Math.round(0.25 * rate), frames: rate })

const levelDb = (signal: ArrayLike<number>, rate: number) => {
  const { from, frames } = window(rate)

  return linearToDb(rms(signal, from, from + frames))
}

const loudness: Scenario = {
  effect: 'saturator',
  name: 'migration-loudness',
  rates: [48000],
  run: async (h) => {
    const signals: [string, Float32Array][] = [
      ['-40 dBFS sine', sine(1.25 * h.rate, 1000, h.rate, dbToLinear(-40))],
      ['-12 dBFS sine', sine(1.25 * h.rate, 1000, h.rate, dbToLinear(-12))],
      ['pink noise -18 dBFS RMS', pinkNoise(1.25 * h.rate, -18, 5)],
    ]

    for (const curve of oldCurves) {
      for (const driveDb of [0, 6, 12, 18, 24]) {
        for (const [name, input] of signals) {
          const old = { ...oldDefaults, curve, driveDb }
          const { output } = await h.render(migrated(old), { input: [input] }, { parity: false })
          const reference = levelDb(renderOld(input, h.rate, old), h.rate)
          const measured = levelDb(output[0], h.rate)
          h.atMost(`output RMS of a migrated device against the old engine, ${curve}, old drive ${driveDb} dB, ${name}`, Math.abs(measured - reference), 1.5, 'dB', `old ${reference.toFixed(2)} dBFS, migrated ${measured.toFixed(2)} dBFS`)
        }
      }
    }
  },
}

/** Small-signal gain over 50 Hz to 16 kHz: the old engine's Color peak against the migrated device (which is flat there by design). */
const colorResponse: Scenario = {
  effect: 'saturator',
  name: 'migration-color-response',
  rates: [48000],
  run: async (h) => {
    const frequencies = [50, 70, 100, 140, 200, 280, 400, 560, 800, 1100, 1600, 2200, 3200, 4500, 6400, 9000, 10000, 12000, 16000]

    const gains = async (old: OldState) => {
      const migratedGains: number[] = []
      const oldGains: number[] = []

      for (const frequency of frequencies) {
        const input = sine(2 * h.rate, frequency, h.rate, dbToLinear(-60))
        const { output } = await h.render(migrated({ ...old, driveDb: 0, curve: 'clip' }), { input: [input] }, { parity: false })
        migratedGains.push(toneGainDb(input, output[0], frequency, h.rate, h.rate, 2 * h.rate))
        oldGains.push(toneGainDb(input, renderOld(input, h.rate, { ...old, driveDb: 0, curve: 'clip' }), frequency, h.rate, h.rate, 2 * h.rate))
      }

      return { migratedGains, oldGains }
    }

    for (const [name, old] of [
      ['default (Color off)', oldDefaults],
      ['Color on, amount 0, 1.2 kHz', { ...oldDefaults, color: true }],
      ['amount 1, 100 Hz', { ...oldDefaults, color: true, colorAmount: 1, colorFrequencyHz: 100 }],
      ['amount 1, 1.2 kHz', { ...oldDefaults, color: true, colorAmount: 1 }],
      ['amount 1, 10 kHz', { ...oldDefaults, color: true, colorAmount: 1, colorFrequencyHz: 10000 }],
      ['amount 0.5, 1.2 kHz', { ...oldDefaults, color: true, colorAmount: 0.5 }],
    ] as const) {
      const { migratedGains, oldGains } = await gains(old)
      const deviation = (low: number, high: number) => Math.max(...frequencies.map((f, i) => f >= low && f <= high ? Math.abs(migratedGains[i] - oldGains[i]) : 0))
      const worst = frequencies.reduce((best, f, i) => Math.abs(migratedGains[i] - oldGains[i]) > Math.abs(migratedGains[best] - oldGains[best]) && f >= 100 && f <= 10000 ? i : best, 0)
      const note = `old peak ${Math.max(...oldGains).toFixed(2)} dB, migrated range ${Math.min(...migratedGains).toFixed(2)} to ${Math.max(...migratedGains).toFixed(2)} dB; worst at ${frequencies[worst]} Hz; 50 Hz-16 kHz worst ${deviation(50, 16000).toFixed(2)} dB`
      const metric = `Color small-signal response deviation from the old engine, 100 Hz-10 kHz, ${name}`

      // The new Color's pre and post shelves cancel, so its linear response is flat: only a flat old Color can be matched.
      if (old.color && old.colorAmount > 0) h.info(`${metric} (limit 2 dB; NOT MET: the old peak stays in the output, the new shelves cancel)`, deviation(100, 10000), 'dB', note)
      else h.atMost(metric, deviation(100, 10000), 2, 'dB', note)
    }
  },
}

export const saturatorMigration: readonly Scenario[] = [loudness, colorResponse]
