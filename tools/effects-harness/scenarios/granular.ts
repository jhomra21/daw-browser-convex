// Acceptance tests G1 to G4 (f) from instruments-research-2026-11-27/granular.md, rendered through the production wasm core:
// level across grain size and density, the note-off cut, key follow and the Gaussian window edge.
import { peakFrequencyHz, stepRatio } from '../instrument-dsp'
import { maxStep, rmsDb } from '../dsp'
import { instruments, sampleAsset } from '../instruments'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { constant, noise, sine } from '../signals'

const rates = [48000] as const

const levelSpread: Scenario = {
  effect: 'granular',
  name: 'g1-level-across-grain-size-and-density',
  rates,
  run: async (h) => {
    const asset = sampleAsset('noise', h.rate, noise(4 * h.rate, 0.5, 5))
    const levels: number[] = []

    for (const grainSizeMs of [20, 100, 1000]) {
      for (const densityHz of [2, 20, 200]) {
        const granular = instruments.granular(asset, { grainSizeMs, densityHz })
        const output = await h.renderInstrument(granular, { frames: 3 * h.rate, notes: [{ frame: 0, pitch: 60, velocity: 1 }] })
        const level = rmsDb(output[0], h.rate, 3 * h.rate)
        levels.push(level)
        h.info(`RMS, grain ${grainSizeMs} ms, density ${densityHz} Hz`, level, 'dBFS')

        if (grainSizeMs === 20 && densityHz === 2) await h.wav('quietest', output)
      }
    }

    h.atMost('RMS spread across the 9 settings', Math.max(...levels) - Math.min(...levels), 3, 'dB', 'G1; report: 31 dB swing (D1), default 64-grain cap')
  },
}

// The source is a 220 Hz sine with spray 0, so every grain is coherent and the steady steps are small; the off lands at 8 phases.
const noteOff: Scenario = {
  effect: 'granular',
  name: 'g2-note-off-cut',
  rates,
  run: async (h) => {
    const granular = instruments.granular(sampleAsset('sine220', h.rate, sine(4 * h.rate, 220, h.rate, 0.5)), { grainSizeMs: 100, densityHz: 20, spray: 0 })
    const window = Math.round(0.005 * h.rate)
    const first = 2 * h.rate
    let worst = { ratio: 0, step: 0 }

    for (let trial = 0; trial < 8; trial += 1) {
      const frame = first + trial * Math.round(h.rate / 220 / 8)
      const output = await h.renderInstrument(granular, { frames: frame + window, notes: [{ frame: 0, pitch: 60, velocity: 1, offFrame: frame }] })
      const ratio = stepRatio(output[0], frame, window, 10 * window)

      if (ratio > worst.ratio) {
        worst = { ratio, step: maxStep(output[0], frame, frame + window) }
        await h.wav('note-off', output)
      }
    }

    h.info('largest step in the 5 ms after the last note-off', worst.step, '', 'engine before: 1.10 against 0.033 elsewhere (D6)')
    h.atMost('largest step after the last note-off / largest step in the 50 ms before, worst of 8 phases', worst.ratio, 2, '', 'G2')
  },
}

const keyFollow: Scenario = {
  effect: 'granular',
  name: 'g3-key-follow',
  rates,
  run: async (h) => {
    const granular = instruments.granular(sampleAsset('sine1k', h.rate, sine(4 * h.rate, 1000, h.rate, 0.5)), { grainSizeMs: 100, densityHz: 20, spray: 0 })
    const size = 65536
    const from = Math.round(0.5 * h.rate)

    const peak = async (pitch: number) =>
      peakFrequencyHz((await h.renderInstrument(granular, { frames: from + size, notes: [{ frame: 0, pitch, velocity: 1 }] }))[0], h.rate, from, size)

    const root = await peak(60)

    for (const pitch of [48, 72]) h.within(`note ${pitch} against note 60 as pitch error`, 1200 * Math.log2(await peak(pitch) / root) - 100 * (pitch - 60), 0, 5, 'cents', 'G3: key follow 100%')
  },
}

// A DC source makes the grain window the whole signal: a window that does not reach zero shows as a step at the grain edge.
const windowEdge: Scenario = {
  effect: 'granular',
  name: 'g4-window-edge',
  rates,
  run: async (h) => {
    const asset = sampleAsset('dc', h.rate, constant(2 * h.rate, 0.5))

    const edgeStep = async (grainWindow: 'hann' | 'gaussian') => {
      const granular = instruments.granular(asset, { 'windowShape': grainWindow, grainSizeMs: 100, densityHz: 2, spray: 0, stereoSpread: 0 })
      const output = await h.renderInstrument(granular, { frames: 2 * h.rate, notes: [{ frame: 0, pitch: 60, velocity: 1 }] })

      return maxStep(output[0], h.rate / 4, 2 * h.rate)
    }

    const [hann, gaussian] = await Promise.all([edgeStep('hann'), edgeStep('gaussian')])
    h.info('Hann grains on a DC source: largest step', hann, '')
    h.atMost('Gaussian grains on a DC source: largest step / Hann\'s', gaussian / hann, 2, '', 'G4; engine before: edge value 0.0211 (D2)')
  },
}

export const granular: Family = {
  scenarios: [levelSpread, noteOff, keyFollow, windowEdge],
  notEncoded: [
    'G4 window values for Tukey and sidelobe levels; G5 backend parity; G6 interpolation spurs and the 15 kHz alias at +12 st; G7 to G10 (jitter, density change, scan, edge folding, stereo, window table, CPU).',
  ],
}
