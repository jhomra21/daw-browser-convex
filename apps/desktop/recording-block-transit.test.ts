import { expect, test } from "bun:test"
import { createRecordingBlockTransit } from "./recording-block-transit"

test("samples matching block sequences without retaining audio", () => {
  expect(createRecordingBlockTransit(0)).toBe(true)
  expect(createRecordingBlockTransit(255)).toBe(false)
  expect(createRecordingBlockTransit(256)).toBe(true)
  expect(createRecordingBlockTransit(-1)).toBe(false)
})
