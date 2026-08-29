import { expect, test } from "bun:test"
import {
  nativeAudioHostMaximumInMemoryPcmBytes,
  nativeAudioHostMaximumAssetFramesForChannels,
  nativeAudioHostMaximumPayloadBytes,
  nativeOfflineRenderPcmBytes,
  nativeOfflineRenderPlanSchema,
} from "./native-audio-host"

const plan = () => ({
  version: 1 as const,
  sampleRateHz: 48_000,
  channelCount: 2 as const,
  totalFrames: 48_000,
  blockFrames: 1_024,
  graph: new Uint8Array([1]),
  assets: [],
  transport: {
    epoch: 1,
    running: false,
    frame: 0,
  },
  schedule: new Uint8Array([1]),
})

test("accepts offline PCM at the exact native in-memory boundary", () => {
  const totalFrames = nativeAudioHostMaximumInMemoryPcmBytes
    / (2 * Float32Array.BYTES_PER_ELEMENT)
  const result = nativeOfflineRenderPlanSchema.safeParse({
    ...plan(),
    totalFrames,
  })
  expect(result.success).toBe(true)
  expect(nativeOfflineRenderPcmBytes(totalFrames, 2)).toBe(nativeAudioHostMaximumInMemoryPcmBytes)
})

test("rejects offline PCM one frame beyond the native in-memory boundary", () => {
  const result = nativeOfflineRenderPlanSchema.safeParse({
    ...plan(),
    totalFrames: nativeAudioHostMaximumInMemoryPcmBytes
      / (2 * Float32Array.BYTES_PER_ELEMENT) + 1,
  })
  expect(result.success).toBe(false)
})


test("rejects binary control payloads above the native frame limit", () => {
  const result = nativeOfflineRenderPlanSchema.safeParse({
    ...plan(),
    graph: new Uint8Array(nativeAudioHostMaximumPayloadBytes + 1),
  })
  expect(result.success).toBe(false)
})

test("uses payload-safe mono and stereo asset frame capacities", () => {
  expect(nativeAudioHostMaximumAssetFramesForChannels(1)).toBe(262_138)
  expect(nativeAudioHostMaximumAssetFramesForChannels(2)).toBe(131_069)
  expect(nativeAudioHostMaximumAssetFramesForChannels(1) * 4 + 24).toBe(nativeAudioHostMaximumPayloadBytes)
  expect(nativeAudioHostMaximumAssetFramesForChannels(2) * 8 + 24).toBe(nativeAudioHostMaximumPayloadBytes)
})

test("rejects malformed PCM asset dimensions", () => {
  const result = nativeOfflineRenderPlanSchema.safeParse({
    ...plan(),
    assets: [{
      sessionAssetId: 1,
      frameCount: 4,
      sampleRateHz: 48_000,
      channelCount: 2,
      planarPcm: new Uint8Array(4),
    }],
  })
  expect(result.success).toBe(false)
})

test("rejects captured state that is not referenced by an attachment", () => {
  const result = nativeOfflineRenderPlanSchema.safeParse({
    ...plan(),
    capturedVstStates: [{
      instanceId: "00000000-0000-0000-0000-000000000001",
      bytes: new Uint8Array([1]),
      sha256: "0".repeat(64),
    }],
  })
  expect(result.success).toBe(false)
})