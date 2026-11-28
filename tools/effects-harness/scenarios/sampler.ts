// Acceptance tests SMP-1 to SMP-4 (f) from instruments-research-2026-11-27/sampler-drum-rack.md for the Sampler, rendered through the
// production wasm core: loop wrap and crossfade, velocity zones, interpolation and one-shot length. The core's sampler does not meet most yet.
import { levelBelowPeakDb, worstSpurDb } from '../instrument-dsp'
import { maxStep, peakAbs, toneFit } from '../dsp'
import { instruments, sampleAsset, zone } from '../instruments'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { constant, linearToDb, ramp, sine, tones } from '../signals'

const rates = [48000] as const

// A crossfade loop of 0.1 to 0.5 s with a 50 ms fade on a source made of three unrelated partials, as the report's harness asks.
const crossfadeWrap: Scenario = {
  effect: 'sampler',
  name: 'smp1-crossfade-loop-wrap',
  rates,
  run: async (h) => {
    const asset = sampleAsset('partials', h.rate, tones(h.rate, h.rate, [[220, 0.4], [733, 0.3], [1850, 0.2]]))
    const notes = [{ frame: 0, pitch: 60, velocity: 1 }]
    const frames = Math.round(2.2 * h.rate)
    const looped = instruments.sampler(asset, [zone(asset, { playbackMode: 'crossfade-loop', loopStartSec: 0.1, loopEndSec: 0.5, crossfadeSec: 0.05 })])
    const played = instruments.sampler(asset, [zone(asset)])
    const [loop, straight] = await Promise.all([h.renderInstrument(looped, { frames, notes }), h.renderInstrument(played, { frames, notes })])
    await h.wav('loop', loop)
    // The straight render is the same sample through the same gain, pan and filter path: its largest step is "the source's".
    h.atMost('largest step over 2 s of looping (wraps at 0.5, 0.9, 1.3...) / the source\'s largest step', maxStep(loop[0], Math.round(0.02 * h.rate), frames) / maxStep(straight[0], Math.round(0.02 * h.rate), h.rate - 1), 1.5, '', 'SMP-1')
  },
}

const loopEnd: Scenario = {
  effect: 'sampler',
  name: 'smp1-loop-end-before-sample-end',
  rates,
  run: async (h) => {
    const asset = sampleAsset('ramp', h.rate, ramp(h.rate, 0, 0.9))
    const looped = instruments.sampler(asset, [zone(asset, { playbackMode: 'forward-loop', loopStartSec: 0.2, loopEndSec: 0.5 })])
    const output = await h.renderInstrument(looped, { frames: Math.round(1.6 * h.rate), notes: [{ frame: 0, pitch: 60, velocity: 1 }] })
    await h.wav('loop', output)
    let wrap = Infinity

    // The ramp rises 2e-5 per frame; the wrap drops 0.27 times the voice's gain.
    for (let n = 1; n < output[0].length && wrap === Infinity; n += 1) if (output[0][n] - output[0][n - 1] < -0.05) wrap = n

    h.within('first wrap frame minus the loop end (0.5 s) in frames', wrap - 0.5 * h.rate, 0, 1, 'frames', 'SMP-1: wraps at the loop end within 1 frame')
  },
}

// A float velocity of k/254 reaches 1/127 steps and the halves between them; zones [1, 63] and [64, 127] must cover all of them.
const velocitySweep: Scenario = {
  effect: 'sampler',
  name: 'smp1-velocity-zones',
  rates,
  run: async (h) => {
    const slot = 960
    const asset = sampleAsset('click', h.rate, constant(480, 0.5))

    const sampler = instruments.sampler(asset, [
      zone(asset, { id: 'low', velocityLow: 1, velocityHigh: 63 }), zone(asset, { id: 'high', velocityLow: 64, velocityHigh: 127 }),
    ], { ampEnvelope: { attackSec: 0, decaySec: 0, sustain: 1, releaseSec: 0, amount: 1 } })

    const steps = Array.from({ length: 253 }, (_, index) => index + 2)
    const notes = steps.map((step, index) => ({ frame: index * slot, pitch: 60, velocity: step / 254 }))
    const output = await h.renderInstrument(sampler, { frames: (steps.length + 1) * slot, notes })
    const silent = steps.filter((step, index) => peakAbs(output[0].subarray(index * slot, (index + 1) * slot)) < 1e-4)
    h.atMost('silent velocity steps of 253 (1/127 and 1/254 steps)', silent.length, 0, 'steps', silent.length === 0 ? undefined : `velocity ${silent.slice(0, 6).map((step) => step / 2).join(', ')}...`)
  },
}

const interpolation: Scenario = {
  effect: 'sampler',
  name: 'smp3-interpolation',
  rates,
  run: async (h) => {
    const size = 32768
    const from = Math.round(0.2 * h.rate)
    const asset = sampleAsset('sine10k', h.rate, sine(2 * h.rate, 10000, h.rate, 0.5))
    const sampler = instruments.sampler(asset, [zone(asset)])
    const frames = from + size

    const [root, shifted] = await Promise.all([60, 61].map((pitch) => h.renderInstrument(sampler, { frames, notes: [{ frame: 0, pitch, velocity: 1 }] })))
    await h.wav('plus-one-semitone', shifted)
    const shiftedHz = 10000 * 2 ** (1 / 12)
    const level = linearToDb(toneFit(shifted[0], shiftedHz, h.rate, from, frames).amplitude / toneFit(root[0], 10000, h.rate, from, frames).amplitude)
    h.within('10 kHz sine at +1 semitone: level against the unshifted render', level, 0, 0.3, 'dB', 'SMP-3 (Best)')
    h.atMost('10 kHz sine at +1 semitone: worst spur', worstSpurDb(shifted[0], shiftedHz, h.rate, from, size), -60, 'dB', 'SMP-3 (Good)')
  },
}

const oneShot: Scenario = {
  effect: 'sampler',
  name: 'smp4-one-shot-short-note',
  rates,
  run: async (h) => {
    const asset = sampleAsset('sine2s', h.rate, sine(2 * h.rate, 440, h.rate, 0.5))
    const sampler = instruments.sampler(asset, [zone(asset)])
    const output = await h.renderInstrument(sampler, { frames: Math.round(1.2 * h.rate), notes: [{ frame: 0, pitch: 60, velocity: 1, offFrame: Math.round(0.1 * h.rate) }] })
    await h.wav('short-note', output)
    h.atLeast('one-shot zone, 0.1 s note: level 0.3 to 1.1 s re peak', levelBelowPeakDb(output[0], Math.round(0.3 * h.rate), Math.round(1.1 * h.rate)), -30, 'dB', 'SMP-4: Trigger plays to the end')
  },
}

export const sampler: Family = {
  scenarios: [crossfadeWrap, loopEnd, velocitySweep, interpolation, oneShot],
  notEncoded: [
    'SMP-2 steal click (covered by the drum-rack family) and the one-shot end step; SMP-3 sweep over 1 to 18 kHz at 25 ratios and the 44.1 and 96 to 48 kHz alias cases; SMP-4 Gate mode (absent); SMP-5 to SMP-10.',
  ],
}
