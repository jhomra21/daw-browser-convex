import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import { audioStretchCacheTestInternals, createAudioStretchCache } from './audio-stretch-cache'
import type { AudioPcmSourceDescriptor } from './media-pages'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'
import { createPreparedStretchArtifactSessionRepository } from './prepared-stretch-store'
import { preparedStretchTestLockManager } from './prepared-stretch-test-lock-manager'

const createTestBuffer = (values: number[]) => ({
  duration: values.length / 10,
  sampleRate: 10,
  numberOfChannels: 1,
  length: values.length,
  getChannelData: () => new Float32Array(values),
})

class RenderAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number

  constructor(
    private readonly channels: Float32Array<ArrayBuffer>[],
    sampleRate: number,
  ) {
    this.sampleRate = sampleRate
    this.numberOfChannels = channels.length
    this.length = channels[0]?.length ?? 0
    this.duration = this.length / sampleRate
  }

  copyFromChannel(destination: Float32Array, channel: number, offset = 0) {
    destination.set(this.channels[channel]?.subarray(offset, offset + destination.length) ?? [])
  }

  copyToChannel(source: Float32Array, channel: number, offset = 0) {
    this.channels[channel]?.set(source, offset)
  }

  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    return this.channels[channel] ?? new Float32Array()
  }
}

const createRenderBuffer = (channels: number, frames: number, sampleRate: number): AudioBuffer =>
  new RenderAudioBuffer(
    Array.from({ length: channels }, () => new Float32Array(frames)),
    sampleRate,
  )

describe('audio stretch cache eviction helpers', () => {
  test('accounts stored render bytes from channel buffers', () => {
    expect(audioStretchCacheTestInternals.getStoredRenderByteSize({
      channels: [
        new Float32Array(10),
        new Float32Array(5),
      ],
    })).toBe(60)
  })

  test('selects least-recently-used renders until under budget', () => {
    const keys = audioStretchCacheTestInternals.selectStoredRenderEvictionKeys([
      { key: 'newest', updatedAt: 30, byteSize: 30 },
      { key: 'oldest', updatedAt: 10, byteSize: 50 },
      { key: 'middle', updatedAt: 20, byteSize: 40 },
    ], 70)

    expect(keys.join(',')).toBe('oldest')
  })

  test('evicts the newest render too when one render exceeds the budget', () => {
    const keys = audioStretchCacheTestInternals.selectStoredRenderEvictionKeys([
      { key: 'older', updatedAt: 10, byteSize: 10 },
      { key: 'oversized', updatedAt: 20, byteSize: 100 },
    ], 50)

    expect(keys.join(',')).toBe('older,oversized')
  })
})

describe('audio stretch cache key identity', () => {
  test('uses stable source asset metadata and fingerprint instead of clip id for persisted keys', () => {
    const buffer = createTestBuffer([0, 0.5, 1])
    const left = audioStretchCacheTestInternals.createCacheKey({
      id: 'clip-a',
      sourceAssetKey: 'asset-key',
      sourceDurationSec: 12,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
      startSec: 0,
      duration: 4,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    }, buffer, 120)
    const right = audioStretchCacheTestInternals.createCacheKey({
      id: 'clip-b',
      sourceAssetKey: 'asset-key',
      sourceDurationSec: 12,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
      startSec: 0,
      duration: 4,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    }, buffer, 120)

    expect(left).toBe(right)
    expect(left.startsWith('asset:asset-key')).toBe(true)
  })

  test('separates asset-backed buffers with changed content', () => {
    const leftBuffer = createTestBuffer([0, 0.5, 1])
    const rightBuffer = createTestBuffer([0, 0.25, 1])

    expect(audioStretchCacheTestInternals.createSourceCacheIdentity({
      id: 'clip',
      sourceAssetKey: 'asset-key',
      sourceDurationSec: 12,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
      startSec: 0,
      duration: 1,
    }, leftBuffer)).not.toBe(audioStretchCacheTestInternals.createSourceCacheIdentity({
      id: 'clip',
      sourceAssetKey: 'asset-key',
      sourceDurationSec: 12,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
      startSec: 0,
      duration: 1,
    }, rightBuffer))
  })

  test('falls back to buffer fingerprint for transient source buffers', () => {
    const leftBuffer = createTestBuffer([0, 0.5, 1])
    const rightBuffer = createTestBuffer([0, 0.25, 1])

    expect(audioStretchCacheTestInternals.createSourceCacheIdentity({
      id: 'clip',
      startSec: 0,
      duration: 1,
    }, leftBuffer)).not.toBe(audioStretchCacheTestInternals.createSourceCacheIdentity({
      id: 'clip',
      startSec: 0,
      duration: 1,
    }, rightBuffer))
  })
})

describe('audio stretch source resolution cancellation', () => {
  const clip = {
    id: 'clip',
    startSec: 0,
    duration: 0.2,
    sourceAssetKey: 'asset',
    sourceDurationSec: 0.2,
    sourceSampleRate: 10,
    sourceChannelCount: 1,
    audioWarp: { enabled: true as const, mode: 'stretch' as const, sourceBpm: 120 },
  }

  const source: AudioPcmSourceDescriptor = {
    identity: 'source',
    durationSec: 0.2,
    frameCount: 2,
    sampleRate: 10,
    channelCount: 1,
    readPages: async function* () {
      yield {
        startFrame: 0,
        frameCount: 2,
        sampleRate: 10,
        channelCount: 1,
        planes: [new Float32Array([0, 1])],
      }
    },
  }

  test('keeps one shared resolver alive when the first waiter aborts', async () => {
    let resolveSource: ((source: AudioPcmSourceDescriptor) => void) | undefined
    let resolverCalls = 0
    let resolverSignal: AbortSignal | undefined
    const cache = createAudioStretchCache({
      createBuffer: createRenderBuffer,
      resolveSource: async (_clip, signal) => {
        resolverCalls += 1
        resolverSignal = signal
        return new Promise((resolve) => { resolveSource = resolve })
      },
    })
    const firstController = new AbortController()
    const first = cache.renderNow(clip, 120, firstController.signal)
    const second = cache.renderNow(clip, 120)
    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    resolveSource?.(source)
    await second
    expect(resolverCalls).toBe(1)
    expect(resolverSignal?.aborted).toBe(false)
    cache.dispose()
  })

  test('keeps the shared render alive when the second waiter aborts', async () => {
    let resolveSource: ((source: AudioPcmSourceDescriptor) => void) | undefined
    let resolverSignal: AbortSignal | undefined
    const cache = createAudioStretchCache({
      createBuffer: createRenderBuffer,
      resolveSource: async (_clip, signal) => {
        resolverSignal = signal
        return new Promise((resolve) => { resolveSource = resolve })
      },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = cache.renderNow(clip, 120, firstController.signal)
    const second = cache.renderNow(clip, 120, secondController.signal)
    secondController.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    resolveSource?.(source)
    await first
    expect(resolverSignal?.aborted).toBe(false)
    cache.dispose()
  })

  test('does not wire a caller signal into the shared render controller', async () => {
    const cache = createAudioStretchCache({
      createBuffer: createRenderBuffer,
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = cache.renderNow(clip, 120, firstController.signal, source)
    const second = cache.renderNow(clip, 120, secondController.signal, source)
    secondController.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await first
    cache.dispose()
  })

  test('aborts a shared resolver and rejects all waiters when disposed', async () => {
    let resolverSignal: AbortSignal | undefined
    const cache = createAudioStretchCache({
      createBuffer: createRenderBuffer,
      resolveSource: async (_clip, signal) => {
        resolverSignal = signal
        return new Promise(() => {})
      },
    })
    const first = cache.renderNow(clip, 120)
    const second = cache.renderNow(clip, 120)
    const firstResult = first.then(() => false, (error) => error instanceof DOMException && error.name === 'AbortError')
    const secondResult = second.then(() => false, (error) => error instanceof DOMException && error.name === 'AbortError')
    await Promise.resolve()
    cache.dispose()
    expect(resolverSignal?.aborted).toBe(true)
    expect(await firstResult).toBe(true)
    expect(await secondResult).toBe(true)
  })

  test('keeps an ensure render alive without an external waiter', async () => {
    let resolverSignal: AbortSignal | undefined
    const cache = createAudioStretchCache({
      createBuffer: createRenderBuffer,
      resolveSource: async (_clip, signal) => {
        resolverSignal = signal
        return source
      },
    })
    const ready = new Promise<void>((resolve) => {
      cache.subscribe(() => {
        if (cache.getReady(clip, 120)) resolve()
      })
    })
    cache.ensure(clip, 120)
    await ready
    expect(resolverSignal?.aborted).toBe(false)
    cache.dispose()
  })
})

test('shares artifact preparation data but creates a binding for each requesting clip', async () => {
  let beginCalls = 0
  const createRepository = () => {
    const baseRepository = createPreparedStretchArtifactSessionRepository({ lockManager: preparedStretchTestLockManager })
    return {
      ...baseRepository,
      begin: async (descriptor: Parameters<typeof baseRepository.begin>[0]) => {
        beginCalls += 1
        return baseRepository.begin(descriptor)
      },
    }
  }
  const source: AudioPcmSourceDescriptor = {
    identity: 'verified-source',
    contentHash: 'a'.repeat(64),
    contentHashVerified: true,
    persistable: true,
    durationSec: 1,
    frameCount: 100,
    sampleRate: 100,
    channelCount: 1,
    readPages: async function* () {
      yield {
        startFrame: 0,
        frameCount: 100,
        sampleRate: 100,
        channelCount: 1,
        planes: [new Float32Array(100)],
      }
    },
  }
  const cache = createAudioStretchCache({
    createBuffer: createRenderBuffer,
    artifactRepository: createRepository(),
    resolveSource: async () => source,
  })
  const baseClip: AudioStretchRuntimeClip = {
    id: 'base',
    startSec: 0,
    duration: 1,
    sourceAssetKey: 'asset',
    sourceDurationSec: 1,
    sourceSampleRate: 100,
    sourceChannelCount: 1,
    audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
  }
  const left = {
    ...baseClip,
    id: 'left',
    startSec: 0,
  }
  const right = {
    ...baseClip,
    id: 'right',
    startSec: 2,
  }

  const [leftResult, rightResult] = await Promise.all([
    cache.renderArtifactNow(left, 120),
    cache.renderArtifactNow(right, 120),
  ])

  expect(beginCalls).toBe(1)
  expect(leftResult.binding.clipId).toBe('left')
  expect(rightResult.binding.clipId).toBe('right')
  expect(leftResult.binding.artifactId).toBe(rightResult.binding.artifactId)
  expect(leftResult.binding.timelineStartSec).not.toBe(rightResult.binding.timelineStartSec)
  cache.dispose()

  const otherCache = createAudioStretchCache({
    createBuffer: createRenderBuffer,
    artifactRepository: createRepository(),
    resolveSource: async () => source,
  })
  const otherResult = await otherCache.renderArtifactNow(left, 120)
  expect(otherResult.binding.artifactId).toBe(leftResult.binding.artifactId)
  expect(beginCalls).toBe(2)
  otherCache.dispose()
})
