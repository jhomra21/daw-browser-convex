import type { Scenario } from '../harness'
import { instruments, sampleAsset, zone } from '../instruments'
import { sine } from '../signals'

const rms = (samples: Float32Array, start: number, end: number) => {
  let sum = 0

  for (let frame = start; frame < end; frame += 1) sum += (samples[frame] ?? 0) ** 2

  return Math.sqrt(sum / (end - start))
}

export const stoppedLiveInstruments: Scenario = {
  effect: 'instruments',
  name: 'stopped-live-notes',
  rates: [48000],
  async run(h) {
    const rate = h.rate
    const asset = sampleAsset('stopped-live-sine', rate, sine(rate * 2, 220, rate, 0.5))
    const frames = rate
    const noteOff = Math.round(rate * 0.3)

    const cases = [
      { name: 'synth', instrument: instruments.synth(), pitch: 60 },
      { name: 'sampler', instrument: instruments.sampler(asset, [zone(asset)]), pitch: 60 },
      { name: 'drum-rack', instrument: instruments.drumRack(asset), pitch: 36 },
      { name: 'granular', instrument: instruments.granular(asset, { grainSizeMs: 100, densityHz: 20, spray: 0 }), pitch: 60 },
    ]

    for (const { name, instrument, pitch } of cases) {
      const output = await h.renderInstrument(instrument, {
        frames,
        notes: [{ frame: 0, pitch, velocity: 1, offFrame: noteOff }],
        transportRunning: false,
      })

      const signal = Math.max(rms(output[0], 0, noteOff), rms(output[1], 0, noteOff))
      const earlyRelease = Math.max(rms(output[0], noteOff, noteOff + rate * 0.1), rms(output[1], noteOff, noteOff + rate * 0.1))
      const lateRelease = Math.max(rms(output[0], rate * 0.8, frames), rms(output[1], rate * 0.8, frames))

      h.atLeast(`${name} stopped transport signal RMS`, signal, 0.001, 'RMS')
      h.atLeast(`${name} stopped transport release RMS`, earlyRelease, 0.000001, 'RMS')
      h.flag(`${name} stopped transport release decays`, lateRelease < earlyRelease, 'late release RMS < early release RMS')
      h.info(`${name} stale prior-epoch note-off rejected`, 1, 'bool', 'renderInstrument asserts host rejection without a fault.')
    }
  },
}
