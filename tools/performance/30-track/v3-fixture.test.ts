import { describe, expect, test } from "bun:test"
import { planThirtyTrackV3 } from "./v3-spec"
import { assertThirtyTrackV3ArchiveBudget, assertThirtyTrackV3Fixture, assertThirtyTrackV3Midi, assertThirtyTrackV3WavSamples, decodeThirtyTrackV3BrowserResult } from "./v3-fixture"

test("detects a changed source sample after a page boundary", async () => {
  const source = planThirtyTrackV3().audio[1]!
  const { streamThirtyTrackMixedRateWav } = await import("./mixed-rate-media")
  const chunks: Uint8Array[] = []
  for await (const chunk of streamThirtyTrackMixedRateWav(source)) chunks.push(chunk)
  const file = new File(chunks.map((chunk) => Uint8Array.from(chunk).buffer), "source.wav")
  await expect(assertThirtyTrackV3WavSamples(source, file)).resolves.toBeUndefined()
  const damaged = new Uint8Array(await file.arrayBuffer())
  damaged[44 + 16_385 * source.channelCount * 4] ^= 0xff
  await expect(assertThirtyTrackV3WavSamples(source, new File([damaged], "broken.wav"))).rejects.toThrow()
})

test("rejects wrong notes even when six MIDI clips have the correct count", () => {
  const instrument = planThirtyTrackV3().instruments[0]!
  expect(() => assertThirtyTrackV3Midi(instrument, instrument.notes)).not.toThrow()
  expect(() => assertThirtyTrackV3Midi(instrument, instrument.notes.map((note, index) =>
    index === 0 ? { ...note, pitch: note.pitch + 1 } : note))).toThrow()
})

test("decodes the browser driver's nested JSON result", () => {
  expect(decodeThirtyTrackV3BrowserResult(JSON.stringify(JSON.stringify({
    version: "30-track-v3", tracks: 30, clips: 30, assets: 24, bytes: 123,
  })))).toEqual({ version: "30-track-v3", tracks: 30, clips: 30, assets: 24, bytes: 123 })
})

describe("archive budget", () => {
  test("rejects an archive larger than the streaming upload cap", () => {
    expect(() => assertThirtyTrackV3ArchiveBudget(1024 * 1024 * 1024 + 1)).toThrow()
    expect(() => assertThirtyTrackV3ArchiveBudget(1024 * 1024 * 1024)).not.toThrow()
  })
})

test("v3 rejects missing assets and inactive MIDI tracks", () => {
  const plan = planThirtyTrackV3()
  const tracks = [
    ...plan.audio.map((source) => ({ index: source.trackIndex, kind: "audio", asset: source.trackIndex, notes: 0 })),
    ...plan.instruments.map((instrument) => ({ index: instrument.index, kind: "instrument", asset: null, notes: instrument.notes.length })),
  ]
  expect(() => assertThirtyTrackV3Fixture(plan, tracks, plan.audio.length)).not.toThrow()
  expect(() => assertThirtyTrackV3Fixture(plan, tracks, 23)).toThrow()
  expect(() => assertThirtyTrackV3Fixture(plan, tracks.map((track) => track.index === 25 ? { ...track, notes: 0 } : track), 24)).toThrow()
})
