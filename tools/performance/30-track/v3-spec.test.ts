import { expect, test } from 'bun:test'
import { planThirtyTrackV3 } from './v3-spec'

test('v3 plans exactly 24 distinct audio tracks and six active instrument tracks', () => {
  const fixture = planThirtyTrackV3()
  expect(fixture.version).toBe('30-track-v3')
  expect(fixture.audio).toHaveLength(24)
  expect(fixture.instruments).toHaveLength(6)
  expect(new Set([...fixture.audio.map((track) => track.trackIndex), ...fixture.instruments.map((track) => track.index)]).size).toBe(30)
  expect(fixture.audio.some((source) => source.durationSec >= 600)).toBe(true)
  expect(new Set(fixture.audio.map((source) => source.sampleRate))).toEqual(new Set([44_100, 48_000, 96_000]))
  expect(new Set(fixture.audio.map((source) => source.channelCount))).toEqual(new Set([1, 2]))
  for (const instrument of fixture.instruments) {
    expect(instrument.notes.length).toBeGreaterThan(0)
    expect(instrument.notes.every((note) => note.beat < 16 && note.length > 0)).toBe(true)
  }
})
