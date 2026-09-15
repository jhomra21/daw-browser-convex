import { describe, expect, test } from 'bun:test'
import { createArrangementWaveformScheduler, type ArrangementWaveformRequest } from './arrangement-waveform'
import type { WaveformSourceData } from './types'

const data: WaveformSourceData = {
  kind: 'intervals',
  encoding: 'float32',
  channels: [new Float32Array(256)],
  firstFrame: 0,
  sampleRate: 48_000,
  sourceFrameCount: 48_000_000,
  framesPerInterval: 128,
  intervalCount: 128,
}

const request = (assetKey: string, signal?: AbortSignal): ArrangementWaveformRequest => ({
  assetKey,
  sourceIdentity: assetKey,
  source: async (sourceSignal) => {
    sourceSignal.throwIfAborted()
    return null
  },
  sourceStartFrame: 0,
  sourceEndFrame: 16_384,
  framesPerInterval: 128,
  signal,
})

describe('arrangement waveform scheduler', () => {
  test('clears queued and active subscribers without poisoning replacement work', async () => {
    let resolve: (value: WaveformSourceData | null) => void = () => {}
    let calls = 0
    const scheduler = createArrangementWaveformScheduler({
      decode: async () => {
        calls += 1
        if (calls > 1) return data
        return await new Promise<WaveformSourceData | null>((nextResolve) => { resolve = nextResolve })
      },
    })
    const pending = scheduler.request(request('clear'))
    scheduler.clear()
    expect(await pending).toBeNull()
    resolve(data)
    expect((await scheduler.request(request('replacement')))?.kind).toBe('intervals')
  })

  test('releases cleared capacity while an old decoder ignores abort', async () => {
    let releaseOld: (value: WaveformSourceData | null) => void = () => {}
    let calls = 0
    const replacementData: WaveformSourceData = {
      ...data,
      channels: [new Float32Array(256).fill(7)],
    }
    const oldData: WaveformSourceData = {
      ...data,
      channels: [new Float32Array(256).fill(3)],
    }
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 1,
      decode: async () => {
        calls += 1
        if (calls === 1) {
          return await new Promise<WaveformSourceData | null>((resolve) => {
            releaseOld = resolve
          })
        }
        return replacementData
      },
    })
    const old = scheduler.request(request('epoch'))
    await Promise.resolve()
    scheduler.clear()
    expect(scheduler.getDiagnostics().active).toBe(0)
    const replacement = scheduler.request(request('epoch'))
    const replacementResult = await replacement
    expect(replacementResult?.kind).toBe('intervals')
    expect(Array.from(replacementResult?.channels[0] ?? [])).toEqual(
      Array.from(replacementData.channels[0] ?? []),
    )
    releaseOld(oldData)
    expect(await old).toBeNull()
    expect(scheduler.getDiagnostics().active).toBe(0)
    const cachedResult = await scheduler.request(request('epoch'))
    expect(cachedResult?.kind).toBe('intervals')
    expect(Array.from(cachedResult?.channels[0] ?? [])).toEqual(
      Array.from(replacementData.channels[0] ?? []),
    )
  })

  test('forwards complete source identity metadata through scheduled decoding', async () => {
    let received: ArrangementWaveformRequest['sourceIdentityMetadata']
    const scheduler = createArrangementWaveformScheduler({
      decode: async (input) => {
        received = input.sourceIdentityMetadata
        return data
      },
    })
    const metadata = {
      assetKey: 'metadata-asset',
      identity: 'metadata-source',
      durationSec: 1,
      frameCount: 48_000,
      sampleRate: 48_000,
      channelCount: 2,
    }
    await scheduler.request({
      ...request('metadata-asset'),
      sourceIdentity: 'metadata-source',
      sourceIdentityMetadata: metadata,
    })
    expect(received).toEqual(metadata)
  })

  test('evicts queued overscan work for a higher-priority visible request', async () => {
    const gates: Array<{ resolve: (value: WaveformSourceData | null) => void }> = []
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      decode: async () => await new Promise<WaveformSourceData | null>((resolve) => { gates.push({ resolve }) }),
    })
    const first = scheduler.request(request('active'))
    const queued = scheduler.request({ ...request('overscan'), priority: 10 })
    const visible = scheduler.request({ ...request('visible'), priority: 0 })
    expect(await queued).toBeNull()
    gates[0]?.resolve(data)
    await first
    await Promise.resolve()
    gates[1]?.resolve(data)
    expect(await visible).not.toBeNull()
    expect(scheduler.getDiagnostics().cancellationCount).toBeGreaterThan(0)
  })

  test('upgrades a deduplicated queued job before scheduling', async () => {
    const starts: string[] = []
    const gates: Array<{ resolve: (value: WaveformSourceData | null) => void }> = []
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      decode: async (input) => {
        starts.push(input.assetKey)
        return await new Promise<WaveformSourceData | null>((resolve) => { gates.push({ resolve }) })
      },
    })
    const active = scheduler.request(request('active'))
    const overscan = scheduler.request({ ...request('shared'), priority: 10 })
    const other = scheduler.request({ ...request('other'), priority: 5 })
    const visible = scheduler.request({ ...request('shared'), priority: 0 })
    gates[0]?.resolve(data)
    await active
    await Promise.resolve()
    expect(starts).toEqual(['active', 'shared'])
    gates[1]?.resolve(data)
    await visible
    await Promise.resolve()
    gates[2]?.resolve(data)
    await Promise.all([overscan, other])
  })

  test('aligns coarse tiers to global frame zero and keeps tail tiles contiguous', async () => {
    const starts: Array<[number, number]> = []
    const scheduler = createArrangementWaveformScheduler({
      decode: async (input) => {
        starts.push([input.tileStartFrame, input.tileEndFrame])
        return {
          ...data,
          firstFrame: input.tileStartFrame,
          framesPerInterval: 32_768,
          channels: [new Float32Array(256)],
          intervalCount: 128,
        }
      },
    })
    const result = await scheduler.request({
      ...request('coarse'),
      sourceStartFrame: 16_000,
      sourceEndFrame: 5_000_000,
      framesPerInterval: 32_768,
    })
    expect(result?.firstFrame).toBe(0)
    expect(result?.kind).toBe('intervals')
    expect(result && result.kind === 'intervals' ? result.intervalCount : 0).toBe(256)
    expect(starts).toEqual([[0, 4_194_304], [4_194_304, 8_388_608]])
  })

  test('uses bounded concurrent coarse tiles and assembles them once in order', async () => {
    let active = 0
    let peakActive = 0
    const starts: number[] = []
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 2,
      decode: async (input) => {
        active += 1
        peakActive = Math.max(peakActive, active)
        starts.push(input.tileStartFrame)
        await Promise.resolve()
        active -= 1
        return {
          ...data,
          firstFrame: input.tileStartFrame,
          framesPerInterval: 32_768,
          channels: [new Float32Array(256).fill(input.tileStartFrame)],
          intervalCount: 128,
        }
      },
    })
    const result = await scheduler.request({
      ...request('coarse-concurrent'),
      sourceStartFrame: 0,
      sourceEndFrame: 12_000_000,
      framesPerInterval: 32_768,
    })
    expect(peakActive).toBe(2)
    expect(starts).toEqual([0, 4_194_304, 8_388_608])
    expect(result?.kind).toBe('intervals')
    if (!result || result.kind !== 'intervals' || result.encoding !== 'float32') {
      throw new Error('Expected assembled float intervals')
    }
    expect(result.intervalCount).toBe(384)
    expect(Array.from(result.channels[0]?.slice(0, 2) ?? [])).toEqual([0, 0])
    expect(Array.from(result.channels[0]?.slice(256, 258) ?? [])).toEqual([4_194_304, 4_194_304])
    expect(Array.from(result.channels[0]?.slice(512, 514) ?? [])).toEqual([8_388_608, 8_388_608])
  })

  test('bounds active work, queue depth, cache entries, and cache bytes', async () => {
    let calls = 0
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 2,
      maxQueued: 1,
      maxCacheEntries: 1,
      maxCacheBytes: 8,
      decode: async (input) => {
        calls += 1
        return {
          ...data,
          firstFrame: input.tileStartFrame,
          channels: [new Float32Array(256)],
        }
      },
    })
    const first = scheduler.request(request('cache-a'))
    const second = scheduler.request(request('cache-b'))
    const third = scheduler.request(request('cache-c'))
    expect(scheduler.getDiagnostics().peakActive).toBeLessThanOrEqual(2)
    expect(scheduler.getDiagnostics().peakQueued).toBeLessThanOrEqual(1)
    await Promise.all([first, second, third])
    expect(scheduler.getDiagnostics().cacheBytes).toBeLessThanOrEqual(8)
    expect(scheduler.getDiagnostics().cacheMisses).toBeGreaterThan(0)
    expect(calls).toBeLessThanOrEqual(3)
  })

  test('rejects malformed or noncontiguous tile assembly', async () => {
    const scheduler = createArrangementWaveformScheduler({
      decode: async (input) => ({
        ...data,
        firstFrame: input.tileStartFrame + (input.tileStartFrame > 0 ? 1 : 0),
        framesPerInterval: 128,
        intervalCount: 128,
      }),
    })
    expect(await scheduler.request({
      ...request('noncontiguous'),
      sourceStartFrame: 0,
      sourceEndFrame: 32_768,
    })).toBeNull()
  })

  test('cancels the active decode when its final subscriber aborts', async () => {
    let decodeSignal: AbortSignal | undefined
    const scheduler = createArrangementWaveformScheduler({
      decode: async (_input, signal) => {
        decodeSignal = signal
        return await new Promise<WaveformSourceData | null>(() => {})
      },
    })
    const controller = new AbortController()
    const pending = scheduler.request({ ...request('active-cancel'), signal: controller.signal })
    controller.abort()
    expect(await pending).toBeNull()
    expect(decodeSignal?.aborted).toBe(true)
  })

  test('waits for admission instead of returning null when capacity is saturated', async () => {
    const gates: Array<{ resolve: (value: WaveformSourceData | null) => void }> = []
    const starts: number[] = []
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 1,
      maxQueued: 0,
      decode: async (input) => {
        starts.push(input.tileStartFrame)
        return await new Promise<WaveformSourceData | null>((resolve) => {
          gates.push({
            resolve: (value) => resolve(value ? { ...value, firstFrame: input.tileStartFrame } : null),
          })
        })
      },
    })
    const blocker = scheduler.request(request('capacity-blocker'))
    await Promise.resolve()
    const heavy = scheduler.request({
      ...request('capacity-waiter'),
      sourceEndFrame: 30_000,
    })
    await Promise.resolve()
    expect(starts).toEqual([0])
    gates[0]?.resolve(data)
    await blocker
    for (let tile = 1; tile < 3; tile += 1) {
      while (gates.length <= tile) await Promise.resolve()
      gates[tile]?.resolve(data)
    }
    expect(starts.length).toBeGreaterThan(1)
    expect(await heavy).not.toBeNull()
  })

  test('bounds coalesced admission state while saturated requests recover', async () => {
    const gates: Array<{ resolve: (value: WaveformSourceData | null) => void }> = []
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 1,
      maxQueued: 0,
      decode: async () => await new Promise<WaveformSourceData | null>((resolve) => { gates.push({ resolve }) }),
    })
    const blocker = scheduler.request(request('admission-blocker'))
    await Promise.resolve()
    const waiters = Array.from({ length: 100 }, (_, index) => scheduler.request({
      ...request(`admission-${index}`),
      priority: index === 99 ? -1 : 10,
    }))
    await Promise.resolve()
    const diagnostics = scheduler.getDiagnostics()
    expect(diagnostics.active + diagnostics.queued + diagnostics.admission).toBeLessThanOrEqual(3)
    expect(diagnostics.peakAdmission).toBeLessThanOrEqual(2)
    gates[0]?.resolve(data)
    await blocker
    for (let index = 1; index <= 100; index += 1) {
      while (gates.length <= index) await Promise.resolve()
      gates[index]?.resolve(data)
    }
    expect((await Promise.all(waiters)).every((value) => value !== null)).toBe(true)
  })

  test('admits urgent coalesced callers before earlier low-priority callers', async () => {
    const gates: Array<{ resolve: (value: WaveformSourceData | null) => void }> = []
    const starts: string[] = []
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 1,
      maxQueued: 0,
      decode: async (input) => {
        starts.push(input.assetKey)
        return await new Promise<WaveformSourceData | null>((resolve) => { gates.push({ resolve }) })
      },
    })
    const blocker = scheduler.request(request('priority-blocker'))
    await Promise.resolve()
    const lowPriority = Array.from({ length: 8 }, (_, index) => scheduler.request({
      ...request(`priority-low-${index}`),
      priority: 10,
    }))
    await Promise.resolve()
    const urgent = scheduler.request({ ...request('priority-urgent'), priority: -1 })
    await Promise.resolve()
    expect(starts).toEqual(['priority-blocker'])

    gates[0]?.resolve(data)
    await blocker
    while (starts.length < 2) await Promise.resolve()
    expect(starts[1]).toBe('priority-urgent')
    gates[1]?.resolve(data)
    expect(await urgent).not.toBeNull()

    for (let index = 2; index < 2 + lowPriority.length; index += 1) {
      while (gates.length <= index) await Promise.resolve()
      gates[index]?.resolve(data)
    }
    expect((await Promise.all(lowPriority)).every((value) => value !== null)).toBe(true)
  })

  test('removes cancelled admission waiters before capacity returns', async () => {
    const gates: Array<{ resolve: (value: WaveformSourceData | null) => void }> = []
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 1,
      maxQueued: 0,
      decode: async () => await new Promise<WaveformSourceData | null>((resolve) => { gates.push({ resolve }) }),
    })
    const blocker = scheduler.request(request('admission-cancel-blocker'))
    await Promise.resolve()
    const controller = new AbortController()
    const waiter = scheduler.request({ ...request('admission-cancelled'), signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect(await waiter).toBeNull()
    expect(scheduler.getDiagnostics().admission).toBe(0)
    gates[0]?.resolve(data)
    await blocker
  })

  test('clears represented and coalesced admission callers before capacity returns', async () => {
    let releaseBlocker: (value: WaveformSourceData | null) => void = () => {}
    let calls = 0
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 1,
      maxQueued: 0,
      decode: async () => {
        calls += 1
        if (calls === 1) {
          return await new Promise<WaveformSourceData | null>((resolve) => {
            releaseBlocker = resolve
          })
        }
        return data
      },
    })
    const blocker = scheduler.request(request('clear-admission-blocker'))
    await Promise.resolve()
    const waiters = Array.from({ length: 8 }, (_, index) => scheduler.request(
      request(`clear-admission-${index}`),
    ))
    await Promise.resolve()
    expect(scheduler.getDiagnostics().admission).toBeGreaterThan(0)

    scheduler.clear()
    expect(scheduler.getDiagnostics().admission).toBe(0)
    expect((await Promise.all(waiters)).every((value) => value === null)).toBe(true)

    const replacement = scheduler.request(request('clear-admission-replacement'))
    releaseBlocker(data)
    expect(await blocker).toBeNull()
    expect(await replacement).not.toBeNull()
  })
})
