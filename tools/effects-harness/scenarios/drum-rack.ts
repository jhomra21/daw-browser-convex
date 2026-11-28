// Acceptance tests SMP-2 and SMP-4 (f) from instruments-research-2026-11-27/sampler-drum-rack.md for the Drum Rack, rendered through the
// production wasm core: a long pad sample under a short note and the voice-steal click.
import { levelBelowPeakDb, stepRatio } from '../instrument-dsp'
import { instruments, sampleAsset } from '../instruments'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { sine } from '../signals'

const rates = [48000] as const

const shortNote: Scenario = {
  effect: 'drum-rack',
  name: 'smp4-pad-short-note',
  rates,
  run: async (h) => {
    const rack = instruments.drumRack(sampleAsset('sine2s', h.rate, sine(2 * h.rate, 440, h.rate, 0.5)))
    const output = await h.renderInstrument(rack, { frames: Math.round(1.2 * h.rate), notes: [{ frame: 0, pitch: 36, velocity: 1, offFrame: Math.round(0.1 * h.rate) }] })
    await h.wav('short-note', output)
    h.atLeast('2 s pad sample, 0.1 s note: level 0.3 to 1.1 s re peak', levelBelowPeakDb(output[0], Math.round(0.3 * h.rate), Math.round(1.1 * h.rate)), -30, 'dB', 'SMP-4: Trigger plays to the end')
  },
}

// 32 hits of a 100 Hz sine fill the 32 voices, the 33rd steals one; the steal is tried at eight phases of the victim.
const steal: Scenario = {
  effect: 'drum-rack',
  name: 'smp2-voice-steal-click',
  rates,
  run: async (h) => {
    const rack = instruments.drumRack(sampleAsset('sine100', h.rate, sine(2 * h.rate, 100, h.rate, 0.5)))
    const window = Math.round(0.01 * h.rate)
    const hits = Array.from({ length: 32 }, (_, index) => ({ frame: index * 96, pitch: 36 + index % 16, velocity: 0.8 }))
    const first = Math.round(0.5 * h.rate)
    let worst = { ratio: 0, frame: first }

    for (let trial = 0; trial < 8; trial += 1) {
      const frame = first + trial * (h.rate / 100 / 8)
      const output = await h.renderInstrument(rack, { frames: frame + window, notes: [...hits, { frame, pitch: 36, velocity: 0.8 }] })
      const ratio = stepRatio(output[0], frame, window, 5 * window)

      if (ratio > worst.ratio) {
        worst = { ratio, frame }
        await h.wav('steal', output)
      }
    }

    h.atMost('33rd hit into 32 voices: worst largest step in 10 ms / largest step in the 50 ms before, 8 phases', worst.ratio, 2, '', `SMP-2, worst at frame ${worst.frame}`)
  },
}

export const drumRack: Family = {
  scenarios: [shortNote, steal],
  notEncoded: [
    'SMP-4 Gate mode (absent); DRM-1 pad controls (detune, AHD, reverse, solo); DRM-2 one voice per pad on a 16th-note pattern; SMP-3 resampler on pads.',
  ],
}
