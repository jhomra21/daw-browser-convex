import { expect, test } from "bun:test"
import { assertArchiveSnapshot, countMidiNotes, parseBrowserProjectId } from "./v3-import-acceptance"

test("decodes browser JSON project ID before public host command", () => {
  expect(parseBrowserProjectId(JSON.stringify(JSON.stringify("project:12345678-1234-1234-1234-123456789abc"))))
    .toBe("project:12345678-1234-1234-1234-123456789abc")
})

test("counts MIDI notes in actual snapshot clip shape", () => {
  expect(countMidiNotes([
    { midi: { notes: [{ beat: 0 }, { beat: 1 }] } },
    { midi: { notes: [{ beat: 0 }] } },
    {},
  ])).toBe(3)
})

test("rejects an unparsed v3 snapshot at the API boundary", () => {
  expect(() => assertArchiveSnapshot(null)).toThrow()
})
