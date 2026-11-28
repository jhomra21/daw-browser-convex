// Acceptance tests S2-S5 (f) from instruments-research-2026-11-27/synth.md: alias ratio, envelope stage times, a held-note sustain change,
// voice-steal click and filter peak gain, rendered through the production wasm core. The core's synth does not meet most of them yet.
import { peakGainDb, decayTimeSec, inharmonicRatioDb, releaseTimeSec, sineEnvelope, stepRatio } from '../instrument-dsp'
import { peakFrame } from '../dsp'
import { instruments, synthTarget } from '../instruments'
import type { Family } from './index'
import type { Scenario } from '../harness'
import type { InstrumentNote } from '../render-instrument'
import type { SynthParamsUpdate } from '../../../packages/shared/src/synth-params'

// A pitch and the detune on it that put the oscillator on exactly `frequencyHz` (the synth's note table is 12-TET at A4 = 440 Hz).
const tuned = (frequencyHz: number) => {
  const cents = 1200 * Math.log2(frequencyHz / 440)
  const pitch = Math.round(69 + cents / 100)

  return { pitch, detuneCents: cents - 100 * (pitch - 69) }
}

const bare: SynthParamsUpdate = { filter: { enabled: false }, ampEnvelope: { attackSec: 0, decaySec: 0, sustain: 1, releaseSec: 0.05 } }

const alias: Scenario = {
  effect: 'synth',
  name: 's5-saw-alias-ratio',
  rates: [48000],
  run: async (h) => {
    const size = 65536
    const start = Math.round(0.25 * h.rate)

    // 1000 Hz is nudged: at 48 and 96 kHz every alias of an exact 1000 Hz saw lands on a harmonic and would count as one.
    for (const frequencyHz of [440, 1000.7, 2094, 4186, 7902]) {
      const { pitch, detuneCents } = tuned(frequencyHz)
      const synth = instruments.synth({ ...bare, oscillators: [{ wave: 'sawtooth', level: 1, detuneCents }, { enabled: false }] })
      const output = await h.renderInstrument(synth, { frames: start + size, notes: [{ frame: 0, pitch, velocity: 1 }] })
      const ratio = inharmonicRatioDb(output[0], frequencyHz, h.rate, start, size)
      const name = `saw ${frequencyHz} Hz inharmonic / harmonic energy`

      if (frequencyHz === 4186) h.atMost(name, ratio, -40, 'dB', 'S5')
      else if (frequencyHz === 1000.7) h.atMost(name, ratio, -50, 'dB', 'S5')
      else h.info(name, ratio, 'dB', 'engine before: 440 -35.2, 2094 -28.3, 7902 -26.4 (D4)')
    }
  },
}

// A sine of exactly 100 frames per cycle makes the one-period RMS window an exact envelope (instrument-dsp.ts sineEnvelope).
const envelopes: Scenario = {
  effect: 'synth',
  name: 's2-envelope-stage-times',
  rates: [48000],
  run: async (h) => {
    const period = 100
    const { pitch, detuneCents } = tuned(h.rate / period)
    const offFrame = Math.round(0.6 * h.rate)

    const envelope = async (sustain: number) => {
      const synth = instruments.synth({
        filter: { enabled: false }, oscillators: [{ wave: 'sine', level: 1, detuneCents }, { enabled: false }],
        ampEnvelope: { attackSec: 0, decaySec: 0.1, sustain, releaseSec: 0.1 },
      })

      const output = await h.renderInstrument(synth, { frames: h.rate, notes: [{ frame: 0, pitch, velocity: 1, offFrame }] })

      return { output, envelope: sineEnvelope(output[0], period) }
    }

    // Sustain 1 never decays: its plateau is the note's peak amplitude, whatever the velocity and level gains are.
    const plateau = (await envelope(1)).envelope[Math.round(0.3 * h.rate)]

    for (const sustain of [0, 0.5, 0.9]) {
      const { output, envelope: raw } = await envelope(sustain)
      const normalised = raw.map((value) => value / plateau)
      await h.wav(`sustain-${sustain}`, output)
      h.within(`decay 100 ms to sustain ${sustain}`, 1000 * decayTimeSec(normalised, h.rate, period, 0, sustain), 100, 2, 'ms', 'S2: max(1 ms, 2%)')

      // From sustain 0 the note-off level is 0: there is nothing to release.
      if (sustain > 0) h.within(`release 100 ms from sustain ${sustain}`, 1000 * releaseTimeSec(normalised, h.rate, period, offFrame), 100, 2, 'ms', 'S2: note-off to -60 dB')
    }
  },
}

const sustainChange: Scenario = {
  effect: 'synth',
  name: 's2-held-note-sustain-change',
  rates: [48000],
  run: async (h) => {
    const period = 100
    const { pitch, detuneCents } = tuned(h.rate / period)
    const changeFrame = Math.round(0.4 * h.rate / 128) * 128

    const render = (sustain: number, live: boolean) => h.renderInstrument(instruments.synth({
      filter: { enabled: false }, oscillators: [{ wave: 'sine', level: 1, detuneCents }, { enabled: false }],
      ampEnvelope: { attackSec: 0, decaySec: 0.01, sustain, releaseSec: 0.1 },
    }), {
      frames: h.rate, notes: [{ frame: 0, pitch, velocity: 1 }],
      parameters: live ? [{ frame: changeFrame, target: synthTarget('synth.ampSustain'), value: 0.3 }] : [],
    })

    const plateau = sineEnvelope((await render(1, false))[0], period)[Math.round(0.3 * h.rate)]
    const level = sineEnvelope((await render(0.8, true))[0], period)[changeFrame + Math.round(0.02 * h.rate)] / plateau
    h.between('level 20 ms after sustain 0.8 -> 0.3 on a held note', level, 0.297, 0.303, '', 'S2: 0.3 ± 1%')
  },
}

// The oldest voice is the victim: the steal is placed on its crest, the worst case for a hard cut.
const steal: Scenario = {
  effect: 'synth',
  name: 's3-voice-steal-click',
  rates: [48000],
  run: async (h) => {
    const window = Math.round(0.01 * h.rate)
    const held: InstrumentNote[] = Array.from({ length: 16 }, (_, index) => ({ frame: index * 128, pitch: 24 + index, velocity: 1 }))
    const render = (notes: readonly InstrumentNote[]) => h.renderInstrument(instruments.synth({ ...bare, oscillators: [{ wave: 'sine', level: 1 }, { enabled: false }] }), { frames: Math.round(0.8 * h.rate), notes })
    const searchFrom = Math.round(0.5 * h.rate)
    const victim = (await render(held.slice(0, 1)))[0]
    const stealFrame = searchFrom + peakFrame(victim.subarray(searchFrom, searchFrom + 1500))
    const stolen = await render([...held, { frame: stealFrame, pitch: 72, velocity: 1 }])
    await h.wav('steal', stolen)
    h.atMost('17th note into 16 voices: largest step in 10 ms / largest step in the 50 ms before', stepRatio(stolen[0], stealFrame, window, 5 * window), 1.5, '', 'S3, on the victim\'s crest')
  },
}

const filterPeak: Scenario = {
  effect: 'synth',
  name: 's4-filter-peak-gain',
  rates: [48000],
  run: async (h) => {
    const frames = 4 * h.rate
    const noiseVoice: SynthParamsUpdate = { oscillators: [{ enabled: false }, { enabled: false }], noise: { enabled: true, level: 1 } }
    const notes = [{ frame: 0, pitch: 60, velocity: 1 }]
    const flat = (await h.renderInstrument(instruments.synth({ ...bare, ...noiseVoice }), { frames, notes }))[0]

    // The native filter has a linear Q, so the response peaks at about Q (RBJ): 0 dB for 0.7, 14.0 dB for 5, 20.0 dB for 10 (D5).
    for (const [q, peakDb] of [[0.7, 0], [5, 14], [10, 20]]) {
      const synth = instruments.synth({ ...bare, ...noiseVoice, filter: { enabled: true, mode: 'lowpass', frequencyHz: 1000, q } })
      const filtered = (await h.renderInstrument(synth, { frames, notes }))[0]
      h.within(`low-pass peak gain, 1 kHz, stored q ${q}`, peakGainDb(filtered, flat, h.rate, 4096, 300, 3000), peakDb, 0.5, 'dB', 'S4: native linear Q is the reference')
    }
  },
}

export const synth: Family = {
  scenarios: [alias, envelopes, sustainChange, steal, filterPeak],
  notEncoded: [
    'S4 magnitude response at fc 50 and 8000 Hz, fast cutoff modulation, cutoff-step zipper and NaN fuzz; S5 harmonic amplitudes against 1/n; S6-S12 (voice modes, modulation, pitch bend, velocity, safety).',
  ],
}
