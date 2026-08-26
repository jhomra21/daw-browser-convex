import { expect, test } from "bun:test"
import { createAudioAssetRef, createCapturedClipMediaLoader } from "./useClipBuffers"
import { createSampleBufferLoader } from "~/lib/sample-buffer-loader"

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 0
  readonly length = 0
  readonly numberOfChannels = 1
  readonly sampleRate: number
  constructor(sampleRate = 44_100) {
    this.sampleRate = sampleRate
  }
  copyFromChannel(destination: Float32Array, _channelNumber: number, _bufferOffset?: number) {
    destination.fill(0)
  }
  copyToChannel(_source: Float32Array, _channelNumber: number, _bufferOffset?: number) {}
  getChannelData(_channel: number) {
    return new Float32Array()
  }
}

const reference = { projectId: "project:1", sourceAssetKey: "asset:1", sampleUrl: "https://samples.example/one.wav" }
const file = new File(["audio"], "one.wav", { type: "audio/wav" })

test("captured media loader prefers ready captured assets and deduplicates immutable references", async () => {
  let reads = 0
  let fetches = 0
  const buffer = new TestAudioBuffer()
  const loader = createCapturedClipMediaLoader({
    readAsset: async () => {
      reads += 1
      return { status: "ready", file, source: "local" }
    },
    fetch: async () => {
      fetches += 1
      return new Response("audio")
    },
    decode: async () => buffer,
  })
  const [first, second] = await Promise.all([loader.load(reference), loader.load(reference)])
  expect(first).toEqual({ status: "ready", buffer })
  expect(second).toEqual({ status: "ready", buffer })
  expect(reads).toBe(1)
  expect(fetches).toBe(0)
})

test("captured media loader reads retained local bytes for cloud-shaped asset IDs", async () => {
  let reads = 0
  let fetches = 0
  const buffer = new TestAudioBuffer()
  const loader = createCapturedClipMediaLoader({
    readAsset: async (projectId, sourceAssetKey) => {
      reads += 1
      expect(projectId).toBe("project:restored")
      expect(sourceAssetKey).toBe("jd7abc123cloudasset")
      return { status: "ready", file, source: "local" }
    },
    fetch: async () => {
      fetches += 1
      return new Response("audio")
    },
    decode: async () => buffer,
  })

  expect(await loader.load({
    projectId: "project:restored",
    sourceAssetKey: "jd7abc123cloudasset",
    sampleUrl: "https://samples.example/fallback.wav",
  })).toEqual({ status: "ready", buffer })
  expect(reads).toBe(1)
  expect(fetches).toBe(0)
})

test("captured media loader falls back to URL and preserves permission failures", async () => {
  const buffer = new TestAudioBuffer()
  const missingAsset = createCapturedClipMediaLoader({
    readAsset: async () => ({ status: "missing" }),
    fetch: async () => new Response("audio"),
    decode: async () => buffer,
  })
  expect(await missingAsset.load(reference)).toEqual({ status: "ready", buffer })

  const deniedUrl = createCapturedClipMediaLoader({
    readAsset: async () => ({ status: "missing" }),
    fetch: async () => new Response(null, { status: 403 }),
    decode: async () => buffer,
  })
  expect(await deniedUrl.load(reference)).toEqual({ status: "permission-denied" })

  const deniedAsset = createCapturedClipMediaLoader({
    readAsset: async () => ({ status: "permission-denied" }),
    fetch: async () => new Response(null, { status: 404 }),
    decode: async () => buffer,
  })
  expect(await deniedAsset.load(reference)).toEqual({ status: "permission-denied" })

  const missing = createCapturedClipMediaLoader({
    readAsset: async () => ({ status: "missing" }),
    fetch: async () => new Response(null, { status: 404 }),
    decode: async () => buffer,
  })
  expect(await missing.load(reference)).toEqual({ status: "missing" })
})

test("captured media loading does not fetch unavailable default sample URLs", async () => {
  let fetches = 0
  const loader = createCapturedClipMediaLoader({
    readAsset: async () => ({ status: "missing" }),
    fetch: async () => {
      fetches += 1
      return new Response("audio")
    },
    decode: async () => new TestAudioBuffer(),
    resolveSampleUrl: () => null,
  })
  expect(await loader.load({
    sampleUrl: "/api/default-sample?key=default%2FKick.wav",
  })).toEqual({ status: "missing" })
  expect(fetches).toBe(0)
})

test("sample buffer loader resolves default sample URLs before fetching", async () => {
  let fetches = 0
  const loader = createSampleBufferLoader({
    fetchImpl: async () => {
      fetches += 1
      return new Response("audio")
    },
    resolveUrl: () => null,
  })
  expect(await loader.load("/api/default-sample?key=default%2FKick.wav", async () => new TestAudioBuffer())).toBeNull()
  expect(fetches).toBe(0)
})

test("sample buffer loader keeps persisted decode rates separate", async () => {
  let decodes = 0
  const loader = createSampleBufferLoader({
    fetchImpl: async () => new Response("audio"),
    resolveUrl: (url) => url,
  })
  const decode = async (_data: ArrayBuffer, targetSampleRate?: number) => {
    decodes += 1
    return new TestAudioBuffer(targetSampleRate)
  }

  const at44k = await loader.load("https://samples.example/one.wav", decode, { targetSampleRate: 44_100 })
  const at48k = await loader.load("https://samples.example/one.wav", decode, { targetSampleRate: 48_000 })
  const cached44k = await loader.load("https://samples.example/one.wav", decode, { targetSampleRate: 44_100 })

  expect(at44k?.sampleRate).toBe(44_100)
  expect(at48k?.sampleRate).toBe(48_000)
  expect(cached44k).toBe(at44k)
  expect(decodes).toBe(2)
})

test("sample buffer loader can release decoded buffers while retaining in-flight deduplication", async () => {
  let fetches = 0
  let decodes = 0
  const fetchGate = Promise.withResolvers<void>()
  const loader = createSampleBufferLoader({
    cacheDecodedBuffers: false,
    fetchImpl: async () => {
      fetches += 1
      await fetchGate.promise
      return new Response("audio")
    },
    resolveUrl: (url) => url,
  })
  const decode = async () => {
    decodes += 1
    return new TestAudioBuffer()
  }

  const first = loader.load("https://samples.example/transient.wav", decode)
  const concurrent = loader.load("https://samples.example/transient.wav", decode)
  fetchGate.resolve()
  await Promise.all([first, concurrent])
  expect(fetches).toBe(1)
  expect(decodes).toBe(1)

  await loader.load("https://samples.example/transient.wav", decode)
  expect(fetches).toBe(2)
  expect(decodes).toBe(2)
})

test("captured media loading settles when its export signal aborts", async () => {
  const controller = new AbortController()
  const loader = createCapturedClipMediaLoader({
    readAsset: async () => ({ status: "missing" }),
    fetch: async () => await new Promise<Response>(() => undefined),
    decode: async () => new TestAudioBuffer(),
  })
  const loading = loader.load(reference, controller.signal)
  controller.abort()
  await expect(loading).rejects.toBeDefined()
})

test("signal-bound sample loading settles when its fetch ignores abort", async () => {
  const controller = new AbortController()
  const loader = createSampleBufferLoader({
    fetchImpl: async () => await new Promise<Response>(() => undefined),
  })
  const loading = loader.load("https://samples.example/stalled.wav", async () => new TestAudioBuffer(), controller.signal)
  controller.abort()
  await expect(loading).rejects.toBeDefined()
})

test("decoded captured media maps to a portable identity without a URL or AudioBuffer", () => {
  const asset = createAudioAssetRef("asset:1", new TestAudioBuffer())
  expect(asset).toEqual({
    version: 1,
    assetId: "asset:1",
    frameCount: 0,
    sampleRateHz: 44_100,
    channelCount: 1,
  })
  expect("url" in asset).toBe(false)
  expect("buffer" in asset).toBe(false)
})
