import { expect, test } from "bun:test"
import type { NativeOfflineRenderPlan } from "@daw-browser/audio-engine/native-host-wire"
import { nativeAudioHostMaximumInMemoryPcmBytes } from "@daw-browser/desktop-protocol/native-audio-host"

import { createDesktopNativeOfflineRenderer } from "~/lib/export/desktop-native-offline-renderer"

let audioBufferConstructed = 0

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 0
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number

  constructor(options: AudioBufferOptions) {
    audioBufferConstructed += 1
    this.length = options.length
    this.numberOfChannels = options.numberOfChannels ?? 1
    this.sampleRate = options.sampleRate
  }

  copyFromChannel(_destination: Float32Array, _channelNumber: number, _bufferOffset?: number) {}
  copyToChannel(_source: Float32Array, _channelNumber: number, _bufferOffset?: number) {}
  getChannelData(_channelNumber: number) {
    return new Float32Array()
  }
}

const plan = (totalFrames: number): NativeOfflineRenderPlan => ({
  version: 1,
  sampleRateHz: 48_000,
  channelCount: 2,
  totalFrames,
  blockFrames: 1_024,
  graph: new Uint8Array([1]),
  assets: [],
  transport: { epoch: 1, running: false, frame: 0 },
  schedule: new Uint8Array([1]),
})

const withAudioBuffer = async (callback: () => Promise<void>) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioBuffer")
  Object.defineProperty(globalThis, "AudioBuffer", {
    configurable: true,
    value: TestAudioBuffer,
  })
  audioBufferConstructed = 0
  try {
    await callback()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "AudioBuffer", descriptor)
    else Reflect.deleteProperty(globalThis, "AudioBuffer")
  }
}

test("native renderer reaches the bridge at the exact in-memory PCM boundary", async () => {
  await withAudioBuffer(async () => {
    let started = false
    const renderer = createDesktopNativeOfflineRenderer({
      start: async () => {
        started = true
        return { ok: false as const, error: "test stop" }
      },
      cancel: async () => ({ accepted: true }),
    })
    const totalFrames = nativeAudioHostMaximumInMemoryPcmBytes
      / (2 * Float32Array.BYTES_PER_ELEMENT)

    await expect(renderer(plan(totalFrames), new AbortController().signal, () => undefined))
      .rejects.toThrow("test stop")
    expect(started).toBe(true)
    expect(audioBufferConstructed).toBe(1)
  })
})

test("native renderer rejects one frame beyond the in-memory PCM boundary before allocation or IPC", async () => {
  await withAudioBuffer(async () => {
    let started = false
    const renderer = createDesktopNativeOfflineRenderer({
      start: async () => {
        started = true
        return { ok: true as const }
      },
      cancel: async () => ({ accepted: true }),
    })
    const totalFrames = nativeAudioHostMaximumInMemoryPcmBytes
      / (2 * Float32Array.BYTES_PER_ELEMENT) + 1

    await expect(renderer(plan(totalFrames), new AbortController().signal, () => undefined))
      .rejects.toThrow("512 MiB in-memory PCM")
    expect(started).toBe(false)
    expect(audioBufferConstructed).toBe(0)
  })
})
