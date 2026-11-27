import { expect, test } from 'bun:test'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import { createSpectrumMaxHold } from '~/lib/spectrum-render'
import { formatReadout, interpolatedPeak, noteName, readoutAt } from '~/lib/spectrum-readout'

const frame = (levels: number[]): SpectrumFrame => ({ data: Float32Array.from(levels), sampleRate: 48000 })

// A parabola with its vertex at bin 10.3 and a -20 dB top, sampled at the three bins around it.
const parabola = (bin: number) => -20 - 6 * (bin - 10.3) ** 2

test('the parabolic peak recovers the vertex of a parabola exactly', () => {
  const peak = interpolatedPeak(parabola(9), parabola(10), parabola(11))
  expect(peak.offset).toBeCloseTo(0.3, 9)
  expect(peak.decibels).toBeCloseTo(-20, 9)
})

test('the parabolic peak leaves a flat or dipping neighbourhood on its centre bin', () => {
  expect(interpolatedPeak(-10, -10, -10)).toEqual({ offset: 0, decibels: -10 })
  expect(interpolatedPeak(-10, -12, -10)).toEqual({ offset: 0, decibels: -12 })
})

test('note names follow equal temperament around A4 with the cents off the nearest note', () => {
  expect(noteName(440)).toBe('A4')
  expect(noteName(261.6256)).toBe('C4')
  expect(noteName(55)).toBe('A1')
  expect(noteName(450)).toBe('A4 +39 ct')
})

test('the readout snaps to the interpolated peak next to the pointer and reads the curve elsewhere', () => {
  // 1 bin = 23.4375 Hz: a peak between bins 20 and 21 at -30 dB, the rest at the -90 dB floor.
  const bins = 1024
  const levels = Array.from({ length: bins }, () => 0)
  const centre = 20.4

  for (let bin = 18; bin <= 23; bin++) levels[bin] = (-30 - 6 * (bin - centre) ** 2 + 90) / 90

  const peak = readoutAt(frame(levels), Math.log((centre * 23.4375) / 20) / Math.log(1000))
  expect(peak.frequency).toBeCloseTo(centre * 23.4375, 1)
  expect(peak.decibels).toBeCloseTo(-30, 1)
  expect(readoutAt(frame(levels), 0.9).decibels).toBe(-90)
})

test('the readout is formatted as frequency, note and level', () => {
  expect(formatReadout({ frequency: 440, decibels: -12.34 })).toBe('440.0 Hz · A4 · -12.3 dB')
  expect(formatReadout({ frequency: 1760, decibels: -3 })).toBe('1.76 kHz · A6 · -3.0 dB')
})

test('Max keeps the highest level per bin until it is reset or the bin count changes', () => {
  const hold = createSpectrumMaxHold()
  expect(hold.held()).toBeNull()
  hold.push(frame([0.2, 0.9, 0.1]))
  hold.push(frame([0.5, 0.3, 0.1]))
  expect([...(hold.held()?.data ?? [])]).toEqual([0.5, 0.9, 0.1].map(Math.fround))
  hold.push(frame([0.1, 0.1]))
  expect([...(hold.held()?.data ?? [])]).toEqual([0.1, 0.1].map(Math.fround))
  hold.reset()
  expect(hold.held()).toBeNull()
})
