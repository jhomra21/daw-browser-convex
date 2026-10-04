import type { planThirtyTrackV3 } from "./v3-spec"
import { sampleThirtyTrackMixedRatePage } from "./spec"
import { z } from "zod"

type Plan = ReturnType<typeof planThirtyTrackV3>
type Track = { index: number; kind: string; asset: number | null; notes: number }
type Instrument = Plan["instruments"][number]
type Source = Plan["audio"][number]
export const assertThirtyTrackV3WavSamples = async (source: Source, file: File) => {
  const totalFrames = source.sampleRate * source.durationSec
  const frameIndices = [0, 239, 16_385, Math.floor(totalFrames / 2), totalFrames - 1]
  for (const frame of frameIndices) {
    const expected = sampleThirtyTrackMixedRatePage(source, frame, 1)
    const offset = 44 + frame * source.channelCount * 4
    const view = new DataView(await file.slice(offset, offset + source.channelCount * 4).arrayBuffer())
    for (let channel = 0; channel < source.channelCount; channel++) {
      if (view.getFloat32(channel * 4, true) !== expected[channel]![0]) {
        throw new Error(`V3 source ${source.trackIndex} sample mismatch at frame ${frame}.`)
      }
    }
  }
}
export const assertThirtyTrackV3Midi = (instrument: Instrument, notes: readonly {
  beat: number; length: number; pitch: number; velocity: number
}[]) => {
  if (notes.length !== instrument.notes.length || notes.some((note, index) => {
    const expected = instrument.notes[index]
    return !expected || note.beat !== expected.beat || note.length !== expected.length
      || note.pitch !== expected.pitch || note.velocity !== expected.velocity
  })) throw new Error(`V3 instrument ${instrument.index} MIDI notes changed.`)
}
const resultSchema = z.union([
  z.object({
    version: z.literal("30-track-v3"),
    tracks: z.literal(30),
    clips: z.literal(30),
    assets: z.literal(24),
    bytes: z.number().int().positive().max(1024 * 1024 * 1024),
  }),
  z.object({ error: z.string() }),
])

export const decodeThirtyTrackV3BrowserResult = (output: string) => {
  const encoded = z.union([z.string(), z.null()]).or(resultSchema).parse(JSON.parse(output))
  if (encoded === null) throw new Error("Timed out waiting for the V3 fixture generator.")
  const stringResult = z.string().safeParse(encoded)
  return resultSchema.parse(stringResult.success ? JSON.parse(stringResult.data) : encoded)
}

export const assertThirtyTrackV3ArchiveBudget = (bytes: number): void => {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1024 * 1024 * 1024) {
    throw new Error("V3 archive exceeds the 1 GiB streaming upload limit.")
  }
}

export const assertThirtyTrackV3Fixture = (plan: Plan, tracks: readonly Track[], assetCount: number): void => {
  if (assetCount !== 24 || tracks.length !== 30) throw new Error("V3 must contain 24 assets and 30 tracks.")
  const byIndex = new Map(tracks.map((track) => [track.index, track]))
  if (byIndex.size !== 30) throw new Error("V3 track indices are not unique.")
  for (const source of plan.audio) {
    const track = byIndex.get(source.trackIndex)
    if (track?.kind !== "audio" || track.asset !== source.trackIndex || track.notes !== 0) {
      throw new Error(`V3 audio track ${source.trackIndex} does not match its source.`)
    }
  }
  for (const instrument of plan.instruments) {
    const track = byIndex.get(instrument.index)
    if (track?.kind !== "instrument" || track.asset !== null || track.notes !== instrument.notes.length) {
      throw new Error(`V3 instrument track ${instrument.index} has no active MIDI clip.`)
    }
  }
}
