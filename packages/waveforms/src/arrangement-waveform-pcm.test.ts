import { describe, expect, test } from 'bun:test'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import { encodePeakByte } from './extract-peaks'
import {
  ARRANGEMENT_PCM_TILE_FRAMES,
  createArrangementWaveformPcmScheduler,
  decodeArrangementWaveformPcm,
  type ArrangementWaveformPcmRequest,
} from './arrangement-waveform-pcm'

const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => {}
  const promise = new Promise<Value>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

const source = (identity: string, frameCount = 32_768): AudioPcmSourceDescriptor => ({
  identity,
  durationSec: frameCount / 48_000,
  frameCount,
  sampleRate: 48_000,
  channelCount: 2,
  readPages: async function* ({ startFrame = 0, endFrame = frameCount, signal } = {}) {
    signal?.throwIfAborted()
    yield {
      startFrame,
      frameCount: endFrame - startFrame,
      sampleRate: 48_000,
      channelCount: 2,
      planes: [
        new Float32Array(endFrame - startFrame).fill(0.25),
        new Float32Array(endFrame - startFrame).fill(-0.5),
      ],
    }
  },
})

const request = (
  assetKey: string,
  overrides: Partial<ArrangementWaveformPcmRequest> = {},
): ArrangementWaveformPcmRequest => ({
  assetKey,
      sourceIdentity: assetKey,
  source: async () => source(assetKey),
  sourceStartSec: 0,
  sourceEndSec: 1 / 48_000,
  columns: 2,
  sampleRate: 48_000,
  channelCount: 2,
  ...overrides,
})

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('arrangement waveform PCM scheduler', () => {
  test('clips an in-tile request without stretching its containing tile', async () => {
    const scheduler = createArrangementWaveformPcmScheduler({
      decode: async (input) => ({
        mode: 'pcm-line',
        firstFrame: input.tileStartFrame,
        sampleRate: input.sampleRate,
        sourceStartSec: input.tileStartFrame / input.sampleRate,
        sourceEndSec: input.tileEndFrame / input.sampleRate,
        channels: [Float32Array.from(
          { length: input.tileEndFrame - input.tileStartFrame },
          (_, index) => (input.tileStartFrame + index) / input.sampleRate,
        )],
      }),
    })
    const result = await scheduler.request(request('in-tile', {
      mode: 'pcm-line',
      sourceStartSec: 100 / 48_000,
      sourceEndSec: 104 / 48_000,
    }))
    expect(result?.mode).toBe('pcm-line')
    expect(Array.from(result?.channels[0] ?? [])).toHaveLength(4)
    for (const [index, value] of (result?.channels[0] ?? []).entries()) {
      expect(value).toBeCloseTo((100 + index) / 48_000, 6)
    }
    expect(result?.sourceStartSec).toBe(100 / 48_000)
    expect(result?.sourceEndSec).toBe(104 / 48_000)
  })

  test('assembles a request that crosses an aligned tile boundary', async () => {
    const scheduler = createArrangementWaveformPcmScheduler({
      decode: async (input) => ({
        mode: 'pcm-line',
        firstFrame: input.tileStartFrame,
        sampleRate: input.sampleRate,
        sourceStartSec: input.tileStartFrame / input.sampleRate,
        sourceEndSec: input.tileEndFrame / input.sampleRate,
        channels: [Float32Array.from(
          { length: input.tileEndFrame - input.tileStartFrame },
          (_, index) => (input.tileStartFrame + index) / input.sampleRate,
        )],
      }),
    })
    const startFrame = ARRANGEMENT_PCM_TILE_FRAMES - 2
    const result = await scheduler.request(request('cross-tile', {
      mode: 'pcm-line',
      sourceStartSec: startFrame / 48_000,
      sourceEndSec: (startFrame + 4) / 48_000,
    }))
    expect(result?.mode).toBe('pcm-line')
    expect(Array.from(result?.channels[0] ?? [])).toHaveLength(4)
    for (const [index, value] of (result?.channels[0] ?? []).entries()) {
      expect(value).toBeCloseTo((startFrame + index) / 48_000, 6)
    }
  })

  test('assembles an envelope across multiple tiles at requested source alignment', async () => {
    const scheduler = createArrangementWaveformPcmScheduler({
      decode: async (input) => ({
        mode: 'pcm-envelope',
        columns: input.tileEndFrame - input.tileStartFrame,
        channels: [Uint8Array.from(
          { length: (input.tileEndFrame - input.tileStartFrame) * 2 },
          (_, index) => index % 2 === 0 ? encodePeakByte(0) : encodePeakByte(
            (input.tileStartFrame + Math.floor(index / 2)) / 100_000,
          ),
        )],
      }),
    })
    const startFrame = ARRANGEMENT_PCM_TILE_FRAMES - 2
    const result = await scheduler.request(request('multi-tile-envelope', {
      source: async () => source('multi-tile-envelope', ARRANGEMENT_PCM_TILE_FRAMES * 3),
      sourceStartSec: startFrame / 48_000,
      sourceEndSec: (startFrame + ARRANGEMENT_PCM_TILE_FRAMES * 2 + 4) / 48_000,
      columns: 4,
    }))
    expect(result?.mode).toBe('pcm-envelope')
    if (!result || result.mode !== 'pcm-envelope') throw new Error('Expected PCM envelope')
    expect(result?.columns).toBe(4)
    expect(result?.sourceStartSec).toBe(startFrame / 48_000)
    expect(result?.sourceEndSec).toBe((startFrame + ARRANGEMENT_PCM_TILE_FRAMES * 2 + 4) / 48_000)
  })

  test('decodes one aligned source tile through the descriptor page API', async () => {
    const result = await decodeArrangementWaveformPcm({
      ...request('decoded'),
      mode: 'pcm-line',
      tileStartFrame: 0,
      tileEndFrame: ARRANGEMENT_PCM_TILE_FRAMES,
    }, new AbortController().signal)
    expect(result?.mode).toBe('pcm-line')
    expect(result?.channels[0]?.length).toBe(ARRANGEMENT_PCM_TILE_FRAMES)
    expect(result?.channels[1]?.[0]).toBe(-0.5)
  })

  test('honors exact-range envelope columns and preserves impulse alignment', async () => {
    const exact = await decodeArrangementWaveformPcm({
      ...request('exact-columns'),
      sourceStartSec: 100 / 48_000,
      sourceEndSec: 104 / 48_000,
      columns: 2,
      exactRange: true,
      tileStartFrame: 100,
      tileEndFrame: 104,
      source: async () => ({
        identity: 'exact-columns',
        durationSec: 104 / 48_000,
        frameCount: 104,
        sampleRate: 48_000,
        channelCount: 1,
        readPages: async function* ({ startFrame = 0, endFrame = 104 } = {}) {
          yield {
            startFrame,
            frameCount: endFrame - startFrame,
            sampleRate: 48_000,
            channelCount: 1,
            planes: [Float32Array.from(
              { length: endFrame - startFrame },
              (_, index) => startFrame + index === 102 ? 1 : 0,
            )],
          }
        },
      }),
      channelCount: 1,
    }, new AbortController().signal)
    expect(exact?.mode).toBe('pcm-envelope')
    if (!exact || exact.mode !== 'pcm-envelope') throw new Error('Expected exact PCM envelope')
    expect(exact.columns).toBe(2)
    expect(exact.channels[0]).toHaveLength(4)
    expect(exact.channels[0]?.[0]).toBe(128)
    expect(exact.channels[0]?.[3]).toBe(255)

    const canvasColumns = 960
    const scheduler = createArrangementWaveformPcmScheduler()
    const overview = await scheduler.request(request('canvas-columns', {
      sourceStartSec: 0,
      sourceEndSec: 1,
      columns: canvasColumns,
      exactRange: true,
      channelCount: 1,
      source: async () => ({
        identity: 'canvas-columns',
        durationSec: 1,
        frameCount: 48_000,
        sampleRate: 48_000,
        channelCount: 1,
        readPages: async function* ({ startFrame = 0, endFrame = 48_000 } = {}) {
          yield {
            startFrame,
            frameCount: endFrame - startFrame,
            sampleRate: 48_000,
            channelCount: 1,
            planes: [Float32Array.from(
              { length: endFrame - startFrame },
              (_, index) => startFrame + index === 24_000 ? 1 : 0,
            )],
          }
        },
      }),
    }))
    expect(overview?.mode).toBe('pcm-envelope')
    if (!overview || overview.mode !== 'pcm-envelope') throw new Error('Expected canvas PCM envelope')
    expect(overview.columns).toBe(canvasColumns)
    const impulseColumn = Math.floor(24_000 * canvasColumns / 48_000)
    expect(overview.channels[0]?.[impulseColumn * 2 + 1]).toBe(255)
  })

  test('uses aligned tiles, dedupes equivalent requests, and preserves stereo envelopes', async () => {
    let calls = 0
    const scheduler = createArrangementWaveformPcmScheduler({
      decode: async (input) => {
        calls += 1
        expect(input.tileStartFrame).toBe(0)
        expect(input.tileEndFrame).toBe(ARRANGEMENT_PCM_TILE_FRAMES)
        return {
          mode: 'pcm-envelope',
          columns: input.columns,
          channels: [new Uint8Array(input.columns * 2).fill(encodePeakByte(0.25)), new Uint8Array(input.columns * 2).fill(encodePeakByte(-0.5))],
        }
      },
    })
    const first = scheduler.request(request('same'))
    const second = scheduler.request(request('same', { sourceStartSec: 1 / 48_000, sourceEndSec: 2 / 48_000 }))
    expect(await first).not.toBeNull()
    expect(await second).not.toBeNull()
    expect(calls).toBe(1)
    expect(scheduler.getDiagnostics().dedupeCount).toBe(1)
  })

  test('limits active work to two and queues by priority then FIFO', async () => {
    const gates = [deferred<null>(), deferred<null>(), deferred<null>()]
    let active = 0
    let peakActive = 0
    const starts: string[] = []
    const scheduler = createArrangementWaveformPcmScheduler({
      decode: async (input) => {
        starts.push(input.assetKey)
        active += 1
        peakActive = Math.max(peakActive, active)
        await gates[Number(input.assetKey)]!.promise
        active -= 1
        return null
      },
    })
    const first = scheduler.request(request('0'))
    const second = scheduler.request(request('1'))
    const third = scheduler.request(request('2', { priority: -1 }))
    expect(starts).toEqual(['0', '1'])
    gates[0]!.resolve(null)
    await first
    await flush()
    expect(starts).toEqual(['0', '1', '2'])
    gates[1]!.resolve(null)
    gates[2]!.resolve(null)
    await Promise.all([first, second, third])
    expect(peakActive).toBe(2)
  })

  test('cancels abandoned queued work and aborts the final active subscriber', async () => {
    const blocker = deferred<null>()
    const controller = new AbortController()
    let queuedCalls = 0
    let aborted = false
    const scheduler = createArrangementWaveformPcmScheduler({
      maxConcurrent: 1,
      decode: async (input, signal) => {
        if (input.assetKey === 'blocker') {
          signal.addEventListener('abort', () => { aborted = true })
          await blocker.promise
          return null
        }
        queuedCalls += 1
        return null
      },
    })
    const active = scheduler.request(request('blocker'))
    const queued = scheduler.request(request('queued', { signal: controller.signal }))
    controller.abort()
    expect(await queued).toBeNull()
    blocker.resolve(null)
    await active
    await flush()
    expect(queuedCalls).toBe(0)
    expect(aborted).toBe(false)

    const activeController = new AbortController()
    const pending = scheduler.request(request('pending', { signal: activeController.signal }))
    activeController.abort()
    expect(await pending).toBeNull()
  })

  test('bounds cache by bytes and retries null and failures', async () => {
    let calls = 0
    const scheduler = createArrangementWaveformPcmScheduler({
      maxCacheBytes: 8,
      maxCacheEntryBytes: 8,
      decode: async () => {
        calls += 1
        if (calls === 1) return null
        if (calls === 2) throw new Error('failed')
        return { mode: 'pcm-envelope', columns: 2, channels: [new Uint8Array(4), new Uint8Array(4)] }
      },
    })
    expect(await scheduler.request(request('retry'))).toBeNull()
    expect(await scheduler.request(request('retry'))).toBeNull()
    expect(await scheduler.request(request('retry'))).not.toBeNull()
    expect(await scheduler.request(request('retry'))).not.toBeNull()
    expect(calls).toBe(3)
    expect(scheduler.getDiagnostics().cacheBytes).toBe(8)
  })

  test('bounds queued work and evicts the least recently used entry', async () => {
    const blocker = deferred<null>()
    const starts: string[] = []
    const scheduler = createArrangementWaveformPcmScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxCacheBytes: 8,
      maxCacheEntryBytes: 8,
      decode: async (input) => {
        starts.push(input.assetKey)
        if (input.assetKey === 'blocker') await blocker.promise
        return { mode: 'pcm-envelope', columns: 2, channels: [new Uint8Array(4), new Uint8Array(4)] }
      },
    })
    const active = scheduler.request(request('blocker'))
    const queued = scheduler.request(request('queued'))
    expect(await scheduler.request(request('rejected'))).toBeNull()
    blocker.resolve(null)
    await Promise.all([active, queued])
    expect(scheduler.getDiagnostics().peakQueued).toBe(1)

    await scheduler.request(request('cache-a'))
    await scheduler.request(request('cache-b'))
    await scheduler.request(request('cache-a'))
    expect(starts.filter((assetKey) => assetKey === 'cache-a')).toHaveLength(2)
  })

  test('evicts queued overscan work so visible work survives saturation', async () => {
    const blocker = deferred<null>()
    const starts: string[] = []
    const scheduler = createArrangementWaveformPcmScheduler({
      maxConcurrent: 1,
      maxQueued: 64,
      decode: async (input) => {
        starts.push(input.assetKey)
        if (input.assetKey === 'blocker') await blocker.promise
        return null
      },
    })
    const active = scheduler.request(request('blocker'))
    const queued = Array.from({ length: 64 }, (_, index) => scheduler.request(request(
      `overscan-${index}`,
      { priority: 10 },
    )))
    const visible = scheduler.request(request('visible', { priority: 0 }))
    expect(scheduler.getDiagnostics().queued).toBe(64)
    expect(scheduler.getDiagnostics().evictionCount).toBe(1)
    blocker.resolve(null)
    await active
    await visible
    expect(starts[1]).toBe('visible')
    await Promise.all(queued)
  })

  test('does not cache oversized results', async () => {
    let calls = 0
    const scheduler = createArrangementWaveformPcmScheduler({
      maxCacheEntryBytes: 4,
      decode: async () => {
        calls += 1
        return { mode: 'pcm-envelope', columns: 2, channels: [new Uint8Array(8)] }
      },
    })
    await scheduler.request(request('oversized'))
    await scheduler.request(request('oversized'))
    expect(calls).toBe(2)
  })

  test('aborts source resolution when its final subscriber cancels', async () => {
    const resolution = deferred<AudioPcmSourceDescriptor>()
    const controller = new AbortController()
    let resolverSignal: AbortSignal | undefined
    const scheduler = createArrangementWaveformPcmScheduler()
    const pending = scheduler.request(request('resolving', {
      signal: controller.signal,
      source: async (signal) => {
        resolverSignal = signal
        return await resolution.promise
      },
    }))
    controller.abort()
    expect(await pending).toBeNull()
    expect(resolverSignal?.aborted).toBe(true)
    resolution.resolve(source('resolving'))
  })

  test('does not publish a stale source identity', async () => {
    const scheduler = createArrangementWaveformPcmScheduler()
    const result = await scheduler.request(request('expected', {
      source: async () => source('different'),
    }))
    expect(result).toBeNull()
    expect(scheduler.getDiagnostics().staleCount).toBe(1)
  })
})
