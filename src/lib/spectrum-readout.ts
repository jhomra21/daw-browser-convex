import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import { SPECTRUM_FLOOR_DB } from '@daw-browser/audio-engine/spectrum-analyser'

export const SPECTRUM_MIN_HZ = 20
export const SPECTRUM_MAX_HZ = 20000

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// Frame levels run 0..1 across SPECTRUM_FLOOR_DB..0 dBFS.
const levelToDecibels = (level: number) => SPECTRUM_FLOOR_DB + level * -SPECTRUM_FLOOR_DB

// Parabolic fit through the dB values either side of a local maximum: the peak's offset from the centre bin (in
// bins) and its level in dB. The native analyzer's InterpolatedPeak does the same fit.
export const interpolatedPeak = (left: number, centre: number, right: number) => {
  const curvature = left - 2 * centre + right

  if (curvature >= 0) return { offset: 0, decibels: centre }
  const offset = (0.5 * (left - right)) / curvature

  return { offset, decibels: centre - 0.25 * (left - right) * offset }
}

export const noteName = (frequency: number) => {
  const semitones = 69 + 12 * Math.log2(frequency / 440)
  const nearest = Math.round(semitones)
  const cents = Math.round((semitones - nearest) * 100)
  const name = `${NOTE_NAMES[((nearest % 12) + 12) % 12]}${Math.floor(nearest / 12) - 1}`

  return cents === 0 ? name : `${name} ${cents > 0 ? '+' : ''}${cents} ct`
}

export const frequencyAtPosition = (position: number) => SPECTRUM_MIN_HZ * (SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ) ** Math.min(1, Math.max(0, position))

// What sits under the pointer at a log-frequency position 0..1: the nearest peak when one is within two bins,
// read at its interpolated frequency and level, otherwise the curve at the pointer.
export const readoutAt = (frame: SpectrumFrame, position: number) => {
  const bins = frame.data.length
  const binHertz = frame.sampleRate / 2 / bins
  const pointer = frequencyAtPosition(position)
  const exact = pointer / binHertz
  const centre = Math.round(exact)
  const decibels = (bin: number) => levelToDecibels(frame.data[Math.min(bins - 1, Math.max(0, bin))])

  for (const bin of [centre, centre - 1, centre + 1, centre - 2, centre + 2]) {
    if (bin < 1 || bin >= bins - 1) continue
    const middle = decibels(bin)

    if (middle <= SPECTRUM_FLOOR_DB || middle < decibels(bin - 1) || middle < decibels(bin + 1)) continue
    const peak = interpolatedPeak(decibels(bin - 1), middle, decibels(bin + 1))

    return { frequency: (bin + peak.offset) * binHertz, decibels: peak.decibels }
  }

  const lower = Math.min(bins - 1, Math.max(0, Math.floor(exact)))
  const upper = Math.min(bins - 1, lower + 1)
  const mix = Math.min(1, Math.max(0, exact - lower))

  return { frequency: pointer, decibels: decibels(lower) + (decibels(upper) - decibels(lower)) * mix }
}

export const formatReadout = (reading: { frequency: number; decibels: number }) => {
  const frequency = reading.frequency >= 1000 ? `${(reading.frequency / 1000).toFixed(2)} kHz` : `${reading.frequency.toFixed(1)} Hz`

  return `${frequency} · ${noteName(reading.frequency)} · ${reading.decibels.toFixed(1)} dB`
}
