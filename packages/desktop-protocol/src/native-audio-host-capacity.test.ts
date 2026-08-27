import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'

import {
  nativeAudioHostAssetInstallHeaderBytes,
  nativeAudioHostMaximumAssetFrames,
  nativeAudioHostMaximumPayloadBytes,
  nativeAudioHostProtocolVersion,
  nativeOfflineRenderPlanSchema,
} from './native-audio-host'

const nativeHeader = readFileSync(
  new URL('../../../native/audio-host-macos/include/daw/audio_host_macos.h', import.meta.url),
  'utf8',
)

test('keeps the widened PCM asset envelope bounded and stereo-safe', () => {
  const maximumStereoBytes = nativeAudioHostMaximumAssetFrames
    * 2
    * Float32Array.BYTES_PER_ELEMENT
    + nativeAudioHostAssetInstallHeaderBytes

  expect(nativeAudioHostProtocolVersion).toBe(16)
  expect(nativeAudioHostMaximumAssetFrames).toBe(1_048_576)
  expect(maximumStereoBytes).toBeLessThanOrEqual(nativeAudioHostMaximumPayloadBytes)
})

test('keeps TypeScript and native host wire bounds aligned', () => {
  expect(nativeHeader).toContain('kControlProtocolVersion = 16;')
  expect(nativeHeader).toContain('kMaximumControlPayloadBytes = 16 * 1024 * 1024;')
  expect(nativeHeader).toContain("kMaximumAssetFrames = 1'048'576;")
})

test('accepts a practical twenty-second stereo PCM asset', () => {
  const sampleRateHz = 44_100
  const frameCount = sampleRateHz * 20
  const planarPcm = new Uint8Array(frameCount * 2 * Float32Array.BYTES_PER_ELEMENT)

  expect(frameCount).toBeGreaterThan(262_144)
  expect(() => nativeOfflineRenderPlanSchema.parse({
    version: 1,
    sampleRateHz,
    channelCount: 2,
    totalFrames: frameCount,
    blockFrames: 512,
    graph: new Uint8Array([1]),
    assets: [{
      sessionAssetId: 1,
      frameCount,
      sampleRateHz,
      channelCount: 2,
      planarPcm,
    }],
    transport: {
      epoch: 1,
      running: true,
      frame: 0,
    },
    schedule: new Uint8Array([1]),
  })).not.toThrow()
})
