import { expect, test } from "bun:test"
import { planThirtyTrackMixedRateSources, sampleThirtyTrackMixedRatePage } from "./spec"
import { streamThirtyTrackMixedRateWav } from "./mixed-rate-media"

test("WAV stream has correct header, bounded chunks and deterministic page joins", async () => {
  const source = planThirtyTrackMixedRateSources()[1]!
  const stream = streamThirtyTrackMixedRateWav(source)
  const header = await stream.next()
  expect(header.value?.byteLength).toBe(44)
  const view = new DataView(header.value!.buffer)
  expect(view.getUint32(24, true)).toBe(source.sampleRate)
  expect(view.getUint16(22, true)).toBe(source.channelCount)
  expect(view.getUint32(40, true)).toBe(source.uncompressedBytes)
  let bytes = 0
  let pages = 0
  for await (const chunk of stream) {
    expect(chunk.byteLength).toBeLessThanOrEqual(16_384 * source.channelCount * 4)
    bytes += chunk.byteLength
    pages++
  }
  expect(bytes).toBe(source.uncompressedBytes)
  expect(pages).toBeGreaterThan(1)
  const adjacent = sampleThirtyTrackMixedRatePage(source, 16_383, 2)
  expect(adjacent[0]![1]).toBe(sampleThirtyTrackMixedRatePage(source, 16_384, 1)[0]![0])
})

test("all planned sources fit classic WAV lengths", () => {
  for (const source of planThirtyTrackMixedRateSources()) {
    expect(source.uncompressedBytes + 36).toBeLessThanOrEqual(0xffffffff)
  }
})
