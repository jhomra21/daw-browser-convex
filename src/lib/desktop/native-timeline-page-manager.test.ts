import { expect, test } from "bun:test"
import {
  createNativeTimelinePageManager,
  nativeTimelineMaximumUploadedPages,
} from "./native-timeline-page-manager"
import {
  nativeAudioHostFrameHeaderBytes,
  nativeAudioHostMaximumPayloadBytes,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeHostMappedAssetPage } from "@daw-browser/audio-engine/native-host-wire"

class EagerAudioBuffer implements AudioBuffer {
  readonly duration = 5 / 48_000
  readonly length = 5
  readonly numberOfChannels = 1
  readonly sampleRate = 48_000
  private readonly channel: Float32Array<ArrayBuffer>

  constructor() {
    this.channel = new Float32Array(new ArrayBuffer(this.length * Float32Array.BYTES_PER_ELEMENT))
    this.channel.set([0.1, 0.2, 0.3, 0.4, 0.5])
  }

  copyFromChannel(destination: Float32Array, _channelNumber: number, bufferOffset = 0) {
    destination.set(this.channel.subarray(bufferOffset, bufferOffset + destination.length))
  }

  copyToChannel(source: Float32Array, _channelNumber: number, bufferOffset = 0) {
    this.channel.set(source, bufferOffset)
  }

  getChannelData(_channelNumber: number) {
    return this.channel
  }
}

class LongEagerAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels = 1
  readonly sampleRate = 48_000
  private readonly channel: Float32Array<ArrayBuffer>

  constructor(length: number) {
    this.length = length
    this.duration = length / this.sampleRate
    this.channel = new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT))
  }

  copyFromChannel(destination: Float32Array, _channelNumber: number, bufferOffset = 0) {
    destination.set(this.channel.subarray(bufferOffset, bufferOffset + destination.length))
  }

  copyToChannel(source: Float32Array, _channelNumber: number, bufferOffset = 0) {
    this.channel.set(source, bufferOffset)
  }

  getChannelData(_channelNumber: number) {
    return this.channel
  }
}

class WideEagerAudioBuffer implements AudioBuffer {
  readonly duration = 4_096 / 48_000
  readonly length = 4_096
  readonly numberOfChannels = 64
  readonly sampleRate = 48_000
  private readonly channels: Float32Array<ArrayBuffer>[]

  constructor() {
    this.channels = Array.from(
      { length: this.numberOfChannels },
      () => new Float32Array(new ArrayBuffer(this.length * Float32Array.BYTES_PER_ELEMENT)),
    )
  }

  copyFromChannel(destination: Float32Array, channel: number, bufferOffset = 0) {
    const source = this.channels[channel]
    if (!source) throw new Error(`Missing channel ${channel}.`)
    destination.set(source.subarray(bufferOffset, bufferOffset + destination.length))
  }

  copyToChannel(source: Float32Array, channel: number, bufferOffset = 0) {
    const destination = this.channels[channel]
    if (!destination) throw new Error(`Missing channel ${channel}.`)
    destination.set(source, bufferOffset)
  }

  getChannelData(channel: number) {
    const source = this.channels[channel]
    if (!source) throw new Error(`Missing channel ${channel}.`)
    return source
  }
}

const dataUrl = "data:audio/wav;base64," + btoa(String.fromCharCode(
  0x52, 0x49, 0x46, 0x46, 0x2e, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x80, 0xbb, 0x00, 0x00, 0x00, 0x77, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x0a, 0x00, 0x00, 0x00, 0xe8, 0x03, 0xd0, 0x07,
  0xb8, 0x0b, 0xa0, 0x0f, 0x88, 0x13
))

test("hydrates only the requested bounded source range", async () => {
  const pages: Array<{ startFrame: number; frameCount: number; bytes: number }> = []
  const prepared: Array<{ startFrame: number; frameCount: number }> = []
  const manager = createNativeTimelinePageManager({
    pageFrames: 2,
    sources: [{
      sourceAssetKey: "asset-a",
      sessionAssetId: 7,
      frameCount: 5,
      sampleRateHz: 48_000,
      channelCount: 1,
      sourceKind: "url",
      sampleUrl: dataUrl,
    }],
    writePage: async (page) => {
      pages.push({
        startFrame: page.startFrame,
        frameCount: page.frameCount,
        bytes: page.planarPcm.byteLength,
      })
    },
    prepareRange: async (sessionAssetId, startFrame, frameCount) => {
      expect(sessionAssetId).toBe(7)
      prepared.push({ startFrame, frameCount })
    },
  })

  await manager.ensureRanges([{ sourceAssetKey: "asset-a", startFrame: 1, endFrame: 4 }])

  expect(pages).toEqual([
    { startFrame: 0, frameCount: 2, bytes: 8 },
    { startFrame: 2, frameCount: 2, bytes: 8 },
  ])
  expect(prepared).toEqual([{ startFrame: 1, frameCount: 3 }])
  manager.dispose()
})

test("resolves persisted upload identity through the local project asset", async () => {
  let readProject = ""
  let readAsset = ""
  let writes = 0
  const manager = createNativeTimelinePageManager({
    projectId: "project-a",
    sources: [{
      sourceAssetKey: "asset-a",
      sessionAssetId: 7,
      frameCount: 5,
      sampleRateHz: 48_000,
      channelCount: 1,
      sourceKind: "upload",
    }],
    readLocalAsset: async (projectId, assetId) => {
      readProject = projectId
      readAsset = assetId
      return { status: "ready", file: new File([Uint8Array.from(atob(dataUrl.split(",")[1] ?? ""), (char) => char.charCodeAt(0))], "asset.wav") }
    },
    writePage: async () => { writes += 1 },
  })

  await manager.ensureRanges([{ sourceAssetKey: "asset-a", startFrame: 0, endFrame: 5 }])

  expect(readProject).toBe("project-a")
  expect(readAsset).toBe("asset-a")
  expect(writes).toBe(1)
  manager.dispose()
})

test("keeps page identity integer-aligned across overlapping ranges", async () => {
  const pages: number[] = []
  const manager = createNativeTimelinePageManager({
    pageFrames: 2,
    sources: [{
      sourceAssetKey: "asset-a",
      sessionAssetId: 7,
      frameCount: 5,
      sampleRateHz: 48_000,
      channelCount: 1,
      sourceKind: "url",
      sampleUrl: dataUrl,
    }],
    writePage: async (page) => { pages.push(page.startFrame) },
  })

  await Promise.all([
    manager.ensureRanges([{ sourceAssetKey: "asset-a", startFrame: 1, endFrame: 3 }]),
    manager.ensureRanges([{ sourceAssetKey: "asset-a", startFrame: 2, endFrame: 5 }]),
  ])

  expect(pages.toSorted((left, right) => left - right)).toEqual([0, 2, 4])
  manager.dispose()
})

test("cancels a range request before decoding begins", async () => {
  let writes = 0
  const manager = createNativeTimelinePageManager({
    pageFrames: 5,
    sources: [{
      sourceAssetKey: "asset-a",
      sessionAssetId: 7,
      frameCount: 5,
      sampleRateHz: 48_000,
      channelCount: 1,
      sourceKind: "url",
      sampleUrl: dataUrl,
    }],
    writePage: async () => {
      await Promise.resolve()
      writes += 1
    },
  })
  const controller = new AbortController()
  const range = [{ sourceAssetKey: "asset-a", startFrame: 1, endFrame: 4 }]
  controller.abort()
  try {
    await manager.ensureRanges(range, controller.signal)
    throw new Error("Expected the canceled range request to reject.")
  } catch (error) {
    expect(error).toBeInstanceOf(DOMException)
  }
  await manager.ensureRanges(range)
  expect(writes).toBe(1)
  manager.dispose()
})

test("deduplicates concurrent range hydration and supports invalidation", async () => {
  let writes = 0
  const manager = createNativeTimelinePageManager({
    pageFrames: 5,
    sources: [{
      sourceAssetKey: "asset-a",
      sessionAssetId: 7,
      frameCount: 5,
      sampleRateHz: 48_000,
      channelCount: 1,
      sourceKind: "url",
      sampleUrl: dataUrl,
    }],
    writePage: async () => {
      writes += 1
      await Promise.resolve()
    },
  })
  const range = [{ sourceAssetKey: "asset-a", startFrame: 0, endFrame: 5 }]
  await Promise.all([manager.ensureRanges(range), manager.ensureRanges(range)])
  const firstWriteCount = writes
  expect(firstWriteCount).toBe(1)
  manager.invalidateRanges(range)
  await manager.ensureRanges(range)
  expect(writes).toBe(firstWriteCount + 1)
  manager.dispose()
})

test("copies bounded pages from an eager buffer without a source URL", async () => {
  const pages: NativeHostMappedAssetPage[] = []
  const manager = createNativeTimelinePageManager({
    pageFrames: 2,
    sources: [{
      sourceAssetKey: "asset-a",
      sessionAssetId: 7,
      frameCount: 5,
      sampleRateHz: 48_000,
      channelCount: 1,
      buffer: new EagerAudioBuffer(),
    }],
    writePage: async (page) => { pages.push(page) },
  })

  await manager.ensureRanges([{ sourceAssetKey: "asset-a", startFrame: 1, endFrame: 5 }])

  expect(pages.map((page) => page.startFrame)).toEqual([0, 2, 4])
  const eagerPageSamples = [...new Float32Array(
    pages[1]!.planarPcm.buffer,
    pages[1]!.planarPcm.byteOffset,
    pages[1]!.planarPcm.byteLength / Float32Array.BYTES_PER_ELEMENT,
  )]
  expect(eagerPageSamples[0]).toBeCloseTo(0.3, 5)
  expect(eagerPageSamples[1]).toBeCloseTo(0.4, 5)
  manager.dispose()
})

test("detaches one canceled caller from shared page hydration", async () => {
  let releaseWrite: (() => void) | undefined
  const writeStarted = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  let writes = 0
  const manager = createNativeTimelinePageManager({
    pageFrames: 5,
    sources: [{
      sourceAssetKey: "asset-a",
      sessionAssetId: 7,
      frameCount: 5,
      sampleRateHz: 48_000,
      channelCount: 1,
      sourceKind: "url",
      sampleUrl: dataUrl,
    }],
    writePage: async () => {
      writes += 1
      await writeStarted
    },
  })
  const firstController = new AbortController()
  const secondController = new AbortController()
  const range = [{ sourceAssetKey: "asset-a", startFrame: 0, endFrame: 5 }]
  const first = manager.ensureRanges(range, firstController.signal)
  await Promise.resolve()
  const second = manager.ensureRanges(range, secondController.signal)
  firstController.abort()
  releaseWrite?.()

  await expect(first).rejects.toBeDefined()
  await expect(second).resolves.toBeUndefined()
  expect(writes).toBe(1)
  manager.dispose()
})

test("hydrates at most two pages concurrently and uses both slots", async () => {
  let active = 0
  let maximumActive = 0
  let releasePages: (() => void) | undefined
  const pagesStarted = new Promise<void>((resolve) => {
    releasePages = resolve
  })
  let started = 0
  const manager = createNativeTimelinePageManager({
    pageFrames: 5,
    sources: [0, 1].map((index) => ({
      sourceAssetKey: `asset-${index}`,
      sessionAssetId: index + 1,
      frameCount: 5,
      sampleRateHz: 48_000,
      channelCount: 1,
      buffer: new EagerAudioBuffer(),
    })),
    writePage: async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      started += 1
      if (started === 2) releasePages?.()
      await pagesStarted
      active -= 1
    },
  })

  const hydration = manager.ensureRanges([0, 1].map((index) => ({
    sourceAssetKey: `asset-${index}`,
    startFrame: 0,
    endFrame: 5,
  })))
  await pagesStarted
  expect(maximumActive).toBe(2)
  releasePages?.()
  await hydration
  expect(active).toBe(0)
  manager.dispose()
})

test("bounds uploaded-page bookkeeping independently of source duration", async () => {
  let writes = 0
  const frameCount = nativeTimelineMaximumUploadedPages + 1
  const manager = createNativeTimelinePageManager({
    pageFrames: 1,
    sources: [{
      sourceAssetKey: "asset-a",
      sessionAssetId: 7,
      frameCount,
      sampleRateHz: 48_000,
      channelCount: 1,
      buffer: new LongEagerAudioBuffer(frameCount),
    }],
    writePage: async () => { writes += 1 },
  })
  const ranges = Array.from({ length: frameCount }, (_, startFrame) => ({
    sourceAssetKey: "asset-a",
    startFrame,
    endFrame: startFrame + 1,
  }))

  await manager.ensureRanges(ranges)
  expect(writes).toBe(frameCount)
  await manager.ensureRanges([{ sourceAssetKey: "asset-a", startFrame: 0, endFrame: 1 }])
  expect(writes).toBe(frameCount + 1)
  manager.dispose()
})

test("keeps wide-channel mapped pages within the protocol payload limit", async () => {
  const pages: NativeHostMappedAssetPage[] = []
  const manager = createNativeTimelinePageManager({
    sources: [{
      sourceAssetKey: "wide",
      sessionAssetId: 8,
      frameCount: 4_096,
      sampleRateHz: 48_000,
      channelCount: 64,
      buffer: new WideEagerAudioBuffer(),
    }],
    writePage: async (page) => { pages.push(page) },
  })

  await manager.ensureRanges([{ sourceAssetKey: "wide", startFrame: 0, endFrame: 4_096 }])

  expect(pages.map((page) => page.frameCount)).toEqual([4_095, 1])
  expect(pages.every((page) => (
    page.planarPcm.byteLength + nativeAudioHostFrameHeaderBytes <= nativeAudioHostMaximumPayloadBytes
  ))).toBe(true)
  manager.dispose()
})
