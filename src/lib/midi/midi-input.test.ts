import { describe, expect, test } from "bun:test"
import { parseMidiInputMessage } from "./midi-input"

const parse = (data: number[]) => parseMidiInputMessage("input-a", data, 42.5)

describe("parseMidiInputMessage", () => {
  test("normalizes note events across all channels", () => {
    expect(parse([0x90, 60, 100])).toEqual({
      sourceId: "input-a", timeStamp: 42.5, channel: 1, kind: "note-on", note: 60, velocity: 100 / 127
    })
    expect(parse([0x8f, 60, 64])).toEqual({
      sourceId: "input-a", timeStamp: 42.5, channel: 16, kind: "note-off", note: 60, velocity: 64 / 127
    })
    expect(parse([0x93, 60, 0])).toEqual({
      sourceId: "input-a", timeStamp: 42.5, channel: 4, kind: "note-off", note: 60, velocity: 0
    })
  })

  test("normalizes control and pressure events", () => {
    expect(parse([0xb2, 74, 127])).toEqual({
      sourceId: "input-a", timeStamp: 42.5, channel: 3, kind: "control-change", controller: 74, value: 1
    })
    expect(parse([0xd4, 96])).toEqual({
      sourceId: "input-a", timeStamp: 42.5, channel: 5, kind: "channel-pressure", pressure: 96 / 127
    })
    expect(parse([0xaf, 64, 48])).toEqual({
      sourceId: "input-a", timeStamp: 42.5, channel: 16, kind: "poly-pressure", note: 64, pressure: 48 / 127
    })
  })

  test("normalizes pitch bend from negative extreme to positive extreme", () => {
    expect(parse([0xe0, 0, 0])).toMatchObject({ kind: "pitch-bend", channel: 1, value: -1 })
    expect(parse([0xe7, 0, 64])).toMatchObject({ kind: "pitch-bend", channel: 8, value: 0 })
    expect(parse([0xef, 127, 127])).toMatchObject({ kind: "pitch-bend", channel: 16, value: 8191 / 8192 })
  })

  test("ignores malformed, truncated, system, realtime, sysex, and program-change messages", () => {
    expect(parse([])).toBeNull()
    expect(parse([0x90, 60])).toBeNull()
    expect(parse([0x90, 128, 1])).toBeNull()
    expect(parse([0xd0, 64, 1])).toBeNull()
    expect(parse([0xc0, 10])).toBeNull()
    expect(parse([0xf0, 1, 2])).toBeNull()
    expect(parse([0xf8])).toBeNull()
    expect(parse([0x70, 0, 0])).toBeNull()
  })
})
