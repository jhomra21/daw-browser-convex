import { expect, test } from 'bun:test'

import type { DecodeAudioPageSource } from '@daw-browser/audio-engine/media-pages'
import { SILENCE_BYTE } from '@daw-browser/waveforms/extract-peaks'
import type { WaveformPeakChannelSlice } from '@daw-browser/waveforms/types'
import {
  createArrangementWaveformPcmScheduler,
  decodeArrangementWaveformPcmEnvelope,
  type ArrangementWaveformPcmRequest,
} from './arrangement-waveform-pcm'

const slice = (value: number, columns = 2): WaveformPeakChannelSlice => ({
  columns,
  channels: [new Uint8Array(columns * 2).fill(value)],
})

const deferred = <Value>() => {
  let settle: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    settle = resolve
  })
  return {
    promise,
    resolve: (value: Value) => settle?.(value),
  }
}

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const request = (
  assetKey: string,
  overrides: Partial<ArrangementWaveformPcmRequest> = {},
): ArrangementWaveformPcmRequest => ({
  assetKey,
  source: async () => new Blob(),
  sourceStartSec: 0,
  sourceEndSec: 1,
  columns: 2,
  sampleRate: 48_000,
  channelCount: 1,
  ...overrides,
})

test('bounds concurrent decoding and prioritizes queued visible work', async () => {
  const first = deferred<WaveformPeakChannelSlice | null>()
  const high = deferred<WaveformPeakChannelSlice | null>()
  const low = deferred<WaveformPeakChannelSlice | null>()
  const starts: string[] = []
  let active = 0
  let maxActive = 0

  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 1,
    decode: async (input) => {
      starts.push(input.assetKey)
      active += 1
      maxActive = Math.max(maxActive, active)
      const gate = input.assetKey === 'first' ? first : input.assetKey === 'high' ? high : low
      const value = await gate.promise
      active -= 1
      return value
    },
  })

  const firstResult = scheduler.request(request('first'))
  const lowResult = scheduler.request(request('low', { priority: 10 }))
  const highResult = scheduler.request(request('high', { priority: 1 }))

  expect(starts).toEqual(['first'])
  first.resolve(slice(1))
  await firstResult
  await flushMicrotasks()
  expect(starts).toEqual(['first', 'high'])

  high.resolve(slice(2))
  await highResult
  await flushMicrotasks()
  expect(starts).toEqual(['first', 'high', 'low'])

  low.resolve(slice(3))
  await lowResult
  expect(maxActive).toBe(1)
})

test('enforces the exact two-decode concurrency bound', async () => {
  const gates = [deferred<WaveformPeakChannelSlice | null>(), deferred<WaveformPeakChannelSlice | null>(), deferred<WaveformPeakChannelSlice | null>()]
  let active = 0
  let maxActive = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 2,
    decode: async (input) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const gate = gates[Number(input.assetKey)]
      if (!gate) throw new Error('missing test gate')
      const value = await gate.promise
      active -= 1
      return value
    },
  })

  const results = [
    scheduler.request(request('0')),
    scheduler.request(request('1')),
    scheduler.request(request('2')),
  ]
  expect(maxActive).toBe(2)
  const firstGate = gates[0]
  const secondGate = gates[1]
  const thirdGate = gates[2]
  if (!firstGate || !secondGate || !thirdGate) throw new Error('missing test gate')
  firstGate.resolve(slice(0))
  secondGate.resolve(slice(1))
  await flushMicrotasks()
  expect(maxActive).toBe(2)
  thirdGate.resolve(slice(2))
  await Promise.all(results)
})

test('promotes a queued shared job when a later subscriber has higher priority', async () => {
  const blocker = deferred<WaveformPeakChannelSlice | null>()
  const promoted = deferred<WaveformPeakChannelSlice | null>()
  const distant = deferred<WaveformPeakChannelSlice | null>()
  const starts: string[] = []
  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 1,
    decode: async (input) => {
      starts.push(input.assetKey)
      if (input.assetKey === 'blocker') return await blocker.promise
      if (input.assetKey === 'promoted') return await promoted.promise
      return await distant.promise
    },
  })

  const blockerResult = scheduler.request(request('blocker'))
  const promotedResult = scheduler.request(request('promoted', { priority: 20 }))
  const distantResult = scheduler.request(request('distant', { priority: 10 }))
  const sharedResult = scheduler.request(request('promoted', { priority: 1 }))
  blocker.resolve(slice(1))
  await blockerResult
  await flushMicrotasks()
  expect(starts).toEqual(['blocker', 'promoted'])
  promoted.resolve(slice(2))
  await Promise.all([promotedResult, sharedResult])
  await flushMicrotasks()
  distant.resolve(slice(3))
  await distantResult
})

test('keeps FIFO order for equal priorities and never restarts active work', async () => {
  const first = deferred<WaveformPeakChannelSlice | null>()
  const second = deferred<WaveformPeakChannelSlice | null>()
  const third = deferred<WaveformPeakChannelSlice | null>()
  const starts: string[] = []
  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 1,
    decode: async (input) => {
      starts.push(input.assetKey)
      if (input.assetKey === 'first') return await first.promise
      if (input.assetKey === 'second') return await second.promise
      return await third.promise
    },
  })

  const firstResult = scheduler.request(request('first', { priority: 5 }))
  const secondResult = scheduler.request(request('second', { priority: 5 }))
  const thirdResult = scheduler.request(request('third', { priority: 5 }))
  const promotedFirst = scheduler.request(request('first', { priority: -10 }))
  expect(starts).toEqual(['first'])
  first.resolve(slice(1))
  await Promise.all([firstResult, promotedFirst])
  await flushMicrotasks()
  expect(starts).toEqual(['first', 'second'])
  second.resolve(slice(2))
  await secondResult
  await flushMicrotasks()
  expect(starts).toEqual(['first', 'second', 'third'])
  third.resolve(slice(3))
  await thirdResult
})

test('deduplicates matching in-flight windows without letting one subscriber cancel another', async () => {
  const gate = deferred<WaveformPeakChannelSlice | null>()
  const firstAbort = new AbortController()
  const secondAbort = new AbortController()
  let decodeCount = 0
  let decodeSignal: AbortSignal | undefined

  const scheduler = createArrangementWaveformPcmScheduler({
    decode: async (_input, signal) => {
      decodeCount += 1
      decodeSignal = signal
      return await gate.promise
    },
  })

  const firstResult = scheduler.request(request('shared', { signal: firstAbort.signal }))
  const secondResult = scheduler.request(request('shared', { signal: secondAbort.signal }))
  expect(decodeCount).toBe(1)

  firstAbort.abort()
  expect(await firstResult).toBeNull()
  expect(decodeSignal?.aborted).toBe(false)

  const expected = slice(7)
  gate.resolve(expected)
  expect(await secondResult).toBe(expected)
  expect(decodeCount).toBe(1)
})

test('aborts an active decode when its final subscriber leaves', async () => {
  const firstAbort = new AbortController()
  const secondAbort = new AbortController()
  let internalAborted = false

  const scheduler = createArrangementWaveformPcmScheduler({
    decode: async (_input, signal) => await new Promise<WaveformPeakChannelSlice | null>((resolve) => {
      signal.addEventListener('abort', () => {
        internalAborted = true
        resolve(null)
      }, { once: true })
    }),
  })

  const firstResult = scheduler.request(request('shared-active', { signal: firstAbort.signal }))
  const secondResult = scheduler.request(request('shared-active', { signal: secondAbort.signal }))
  firstAbort.abort()
  secondAbort.abort()

  expect(await firstResult).toBeNull()
  expect(await secondResult).toBeNull()
  await flushMicrotasks()
  expect(internalAborted).toBe(true)
})

test('removes abandoned queued work before it can consume a decode slot', async () => {
  const blocker = deferred<WaveformPeakChannelSlice | null>()
  const queuedAbort = new AbortController()
  const starts: string[] = []

  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 1,
    decode: async (input) => {
      starts.push(input.assetKey)
      if (input.assetKey === 'blocker') return await blocker.promise
      return slice(5)
    },
  })

  const blockerResult = scheduler.request(request('blocker'))
  const queuedResult = scheduler.request(request('queued', { signal: queuedAbort.signal }))
  queuedAbort.abort()
  expect(await queuedResult).toBeNull()

  blocker.resolve(slice(1))
  await blockerResult
  await flushMicrotasks()
  expect(starts).toEqual(['blocker'])
})

test('deduplicates equivalent frame windows but keeps distinct identities separate', async () => {
  const gate = deferred<WaveformPeakChannelSlice | null>()
  let decodeCount = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    decode: async () => {
      decodeCount += 1
      return await gate.promise
    },
  })

  const first = scheduler.request(request('frames', {
    sourceStartSec: 0.01,
    sourceEndSec: 0.21,
    sampleRate: 10,
  }))
  const equivalent = scheduler.request(request('frames', {
    sourceStartSec: 0.09,
    sourceEndSec: 0.201,
    sampleRate: 10,
  }))
  const differentColumns = scheduler.request(request('frames', {
    sourceStartSec: 0.01,
    sourceEndSec: 0.21,
    sampleRate: 10,
    columns: 3,
  }))
  expect(decodeCount).toBe(2)
  const expected = slice(7)
  gate.resolve(expected)
  expect(await first).toBe(expected)
  expect(await equivalent).toBe(expected)
  expect(await differentColumns).toBe(expected)
})

test('calls each deduplicated source once when the shared job becomes active', async () => {
  let sourceCalls = 0
  let decodeCalls = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    decode: async (input) => {
      decodeCalls += 1
      await input.source()
      return slice(8)
    },
  })
  const source = async () => {
    sourceCalls += 1
    return new Blob()
  }

  const first = scheduler.request(request('source-once', { source }))
  const second = scheduler.request(request('source-once', { source }))
  await Promise.all([first, second])
  expect(decodeCalls).toBe(1)
  expect(sourceCalls).toBe(1)
})

test('keeps sample rate, channel count, and asset in the scheduling identity', async () => {
  let decodeCount = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 4,
    decode: async (_input) => {
      decodeCount += 1
      return slice(decodeCount)
    },
  })

  const results = await Promise.all([
    scheduler.request(request('same')),
    scheduler.request(request('same', { sampleRate: 44_100 })),
    scheduler.request(request('same', { channelCount: 2 })),
    scheduler.request(request('same', { columns: 3 })),
    scheduler.request(request('other')),
  ])
  expect(decodeCount).toBe(5)
  expect(results.map((result) => result?.channels[0]?.[0])).toEqual([1, 2, 3, 4, 5])
})

test('caches completed envelopes and evicts least-recently-used windows by byte budget', async () => {
  const calls = new Map<string, number>()
  const scheduler = createArrangementWaveformPcmScheduler({
    maxCacheBytes: 4,
    decode: async (input) => {
      calls.set(input.assetKey, (calls.get(input.assetKey) ?? 0) + 1)
      return slice(input.assetKey === 'a' ? 1 : 2)
    },
  })

  const firstA = await scheduler.request(request('a'))
  const cachedA = await scheduler.request(request('a'))
  expect(firstA).toBe(cachedA)
  expect(calls.get('a')).toBe(1)

  await scheduler.request(request('b'))
  expect(calls.get('b')).toBe(1)

  await scheduler.request(request('a'))
  expect(calls.get('a')).toBe(2)
})

test('promotes cache hits, does not cache oversized entries, and disables caching at zero', async () => {
  const calls = new Map<string, number>()
  const scheduler = createArrangementWaveformPcmScheduler({
    maxCacheBytes: 8,
    decode: async (input) => {
      calls.set(input.assetKey, (calls.get(input.assetKey) ?? 0) + 1)
      return slice(input.assetKey === 'large' ? 2 : 1, input.assetKey === 'large' ? 5 : 2)
    },
  })

  await scheduler.request(request('a'))
  await scheduler.request(request('b'))
  await scheduler.request(request('a'))
  await scheduler.request(request('c'))
  await scheduler.request(request('b'))
  expect(calls).toEqual(new Map([['a', 1], ['b', 2], ['c', 1]]))

  await scheduler.request(request('large'))
  await scheduler.request(request('large'))
  expect(calls.get('large')).toBe(2)

  const uncached = createArrangementWaveformPcmScheduler({
    maxCacheBytes: 0,
    decode: async () => {
      calls.set('zero', (calls.get('zero') ?? 0) + 1)
      return { columns: 0, channels: [] }
    },
  })
  await uncached.request(request('zero'))
  await uncached.request(request('zero'))
  expect(calls.get('zero')).toBe(2)
})

test('does not cache null results or decoder failures and permits retry', async () => {
  let calls = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    decode: async () => {
      calls += 1
      if (calls === 1) return null
      if (calls === 2) throw new Error('decode failed')
      return slice(9)
    },
  })

  expect(await scheduler.request(request('retry'))).toBeNull()
  expect(await scheduler.request(request('retry'))).toBeNull()
  expect(await scheduler.request(request('retry'))).toEqual(slice(9))
  expect(await scheduler.request(request('retry'))).toEqual(slice(9))
  expect(calls).toBe(3)
})

test('does not let a failed job block the next queued job', async () => {
  const starts: string[] = []
  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 1,
    decode: async (input) => {
      starts.push(input.assetKey)
      if (input.assetKey === 'failed') throw new Error('failed')
      return slice(6)
    },
  })
  const failed = scheduler.request(request('failed'))
  const next = scheduler.request(request('next'))
  expect(await failed).toBeNull()
  expect(await next).toEqual(slice(6))
  expect(starts).toEqual(['failed', 'next'])
})

test('treats unspecified priority as normal priority ahead of explicitly distant work', async () => {
  const blocker = deferred<WaveformPeakChannelSlice | null>()
  const normal = deferred<WaveformPeakChannelSlice | null>()
  const distant = deferred<WaveformPeakChannelSlice | null>()
  const starts: string[] = []

  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 1,
    decode: async (input) => {
      starts.push(input.assetKey)
      if (input.assetKey === 'blocker') return await blocker.promise
      if (input.assetKey === 'normal') return await normal.promise
      return await distant.promise
    },
  })

  const blockerResult = scheduler.request(request('blocker'))
  const distantResult = scheduler.request(request('distant', { priority: 50 }))
  const normalResult = scheduler.request(request('normal'))
  blocker.resolve(slice(1))
  await blockerResult
  await flushMicrotasks()
  expect(starts).toEqual(['blocker', 'normal'])

  normal.resolve(slice(2))
  await normalResult
  await flushMicrotasks()
  distant.resolve(slice(3))
  await distantResult
})

test('rejects malformed windows without invoking the decoder', async () => {
  let decodeCount = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    decode: async () => {
      decodeCount += 1
      return slice(1)
    },
  })

  expect(await scheduler.request(request('bad-start', { sourceStartSec: -1 }))).toBeNull()
  expect(await scheduler.request(request('bad-end', { sourceEndSec: Number.NaN }))).toBeNull()
  expect(await scheduler.request(request('bad-columns', { columns: 0 }))).toBeNull()
  expect(await scheduler.request(request('bad-rate', { sampleRate: 0 }))).toBeNull()
  expect(await scheduler.request(request('', {}))).toBeNull()
  expect(decodeCount).toBe(0)
})

test('resolves a queued source only when its work becomes active', async () => {
  const blocker = deferred<WaveformPeakChannelSlice | null>()
  let sourceCalls = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 1,
    decode: async (input) => {
      if (input.assetKey === 'blocker') return await blocker.promise
      await input.source()
      return slice(4)
    },
  })
  const blockerResult = scheduler.request(request('blocker'))
  const queued = scheduler.request(request('queued', {
    source: async () => {
      sourceCalls += 1
      return new Blob()
    },
  }))
  expect(sourceCalls).toBe(0)
  blocker.resolve(slice(1))
  await Promise.all([blockerResult, queued])
  expect(sourceCalls).toBe(1)
})

test('does not invoke an abandoned queued source', async () => {
  const blocker = deferred<WaveformPeakChannelSlice | null>()
  const abort = new AbortController()
  let sourceCalls = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 1,
    decode: async (input) => {
      if (input.assetKey === 'blocker') return await blocker.promise
      return slice(4)
    },
  })
  const blockerResult = scheduler.request(request('blocker'))
  const queuedResult = scheduler.request(request('queued-source', {
    signal: abort.signal,
    source: async () => {
      sourceCalls += 1
      return new Blob()
    },
  }))
  abort.abort()
  blocker.resolve(slice(1))
  await Promise.all([blockerResult, queuedResult])
  expect(sourceCalls).toBe(0)
})

test('returns null for pre-aborted and immediately aborted subscriptions', async () => {
  const preAborted = new AbortController()
  preAborted.abort()
  let decodeCount = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    decode: async () => {
      decodeCount += 1
      return slice(1)
    },
  })

  expect(await scheduler.request(request('pre-aborted', { signal: preAborted.signal }))).toBeNull()
  const immediate = new AbortController()
  const immediateResult = scheduler.request(request('immediate', { signal: immediate.signal }))
  immediate.abort()
  expect(await immediateResult).toBeNull()
  await flushMicrotasks()
  expect(decodeCount).toBe(1)
})

test('clear aborts active work, settles once, empties state, and allows reuse', async () => {
  const gate = deferred<WaveformPeakChannelSlice | null>()
  const abort = new AbortController()
  let decodeCount = 0
  let decoderSignal: AbortSignal | undefined
  const scheduler = createArrangementWaveformPcmScheduler({
    decode: async (_input, signal) => {
      decodeCount += 1
      decoderSignal = signal
      return await gate.promise
    },
  })
  const active = scheduler.request(request('clear-active', { signal: abort.signal }))
  scheduler.clear()
  scheduler.clear()
  expect(await active).toBeNull()
  expect(decoderSignal?.aborted).toBe(true)
  gate.resolve(slice(2))
  await flushMicrotasks()
  expect(await scheduler.request(request('clear-active'))).toEqual(slice(2))
  expect(decodeCount).toBe(2)
})

test('clear removes queued work without invoking its decoder', async () => {
  const blocker = deferred<WaveformPeakChannelSlice | null>()
  const queuedAbort = new AbortController()
  const starts: string[] = []
  const scheduler = createArrangementWaveformPcmScheduler({
    maxConcurrent: 1,
    decode: async (input) => {
      starts.push(input.assetKey)
      if (input.assetKey === 'blocker') return await blocker.promise
      return slice(3)
    },
  })
  const blockerResult = scheduler.request(request('blocker'))
  const queuedResult = scheduler.request(request('cleared-queue', { signal: queuedAbort.signal }))
  scheduler.clear()
  expect(await blockerResult).toBeNull()
  expect(await queuedResult).toBeNull()
  blocker.resolve(slice(1))
  await flushMicrotasks()
  expect(starts).toEqual(['blocker'])
})

test('clear removes cached envelopes and resets the cache byte budget', async () => {
  let decodeCount = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    maxCacheBytes: 8,
    decode: async () => {
      decodeCount += 1
      return {
        columns: 2,
        channels: [new Uint8Array(4), new Uint8Array(4)],
      }
    },
  })
  await scheduler.request(request('cleared-cache'))
  await scheduler.request(request('cleared-cache'))
  expect(decodeCount).toBe(1)
  scheduler.clear()
  await scheduler.request(request('cleared-cache'))
  expect(decodeCount).toBe(2)
})

test('aborting after decode resolves but before settlement prevents cache insertion', async () => {
  const gate = deferred<WaveformPeakChannelSlice | null>()
  const abort = new AbortController()
  let decodeCount = 0
  const scheduler = createArrangementWaveformPcmScheduler({
    decode: async () => {
      decodeCount += 1
      return await gate.promise
    },
  })
  const result = scheduler.request(request('settlement-race', { signal: abort.signal }))
  const value = slice(5)
  gate.resolve(value)
  abort.abort()
  expect(await result).toBeNull()
  expect(await scheduler.request(request('settlement-race'))).toBe(value)
  expect(decodeCount).toBe(2)
})

const writeAscii = (bytes: Uint8Array, offset: number, value: string) => {
  bytes.set(new TextEncoder().encode(value), offset)
}

const wave = () => {
  const frames = 5
  const bytes = new Uint8Array(44 + frames * 2)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, bytes.byteLength - 8, true)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 48_000, true)
  view.setUint32(28, 96_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, frames * 2, true)
  for (let frame = 0; frame < frames; frame += 1) {
    view.setInt16(44 + frame * 2, (frame + 1) * 1000, true)
  }
  return bytes
}

class WholeFileReadForbidden extends File {
  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('whole-file-array-buffer-read'))
  }
}

test('decodes a bounded file window into a signed peak envelope without whole-file File.arrayBuffer()', async () => {
  const file = new WholeFileReadForbidden([wave()], 'arrangement-pcm.wav', { type: 'audio/wav' })
  const result = await decodeArrangementWaveformPcmEnvelope({
    assetKey: 'fixture',
    source: async () => file,
    sourceStartSec: 0,
    sourceEndSec: 5 / 48_000,
    columns: 5,
    sampleRate: 48_000,
    channelCount: 1,
  }, new AbortController().signal)

  expect(result?.columns).toBe(5)
  expect(result?.channels).toHaveLength(1)
  expect(result?.channels[0]).toHaveLength(10)
  expect(result?.channels[0]?.some((value) => value !== SILENCE_BYTE)).toBe(true)
})

test('direct decoding rechecks abort after source resolution and preserves decoder errors', async () => {
  const sourceGate = deferred<DecodeAudioPageSource | null>()
  const abort = new AbortController()
  const sourcePromise = decodeArrangementWaveformPcmEnvelope({
    assetKey: 'abort-after-source',
    source: () => sourceGate.promise,
    sourceStartSec: 0,
    sourceEndSec: 1,
    columns: 2,
    sampleRate: 48_000,
    channelCount: 1,
  }, abort.signal)
  abort.abort()
  sourceGate.resolve(new Blob())
  await expect(sourcePromise).rejects.toMatchObject({ name: 'AbortError' })

  const badSource = decodeArrangementWaveformPcmEnvelope({
    assetKey: 'bad-source',
    source: async () => new Blob(['not audio']),
    sourceStartSec: 0,
    sourceEndSec: 1,
    columns: 2,
    sampleRate: 48_000,
    channelCount: 1,
  }, new AbortController().signal)
  await expect(badSource).rejects.toThrow()
})

test('direct decoding rejects inconsistent decoded metadata', async () => {
  const result = decodeArrangementWaveformPcmEnvelope({
    assetKey: 'metadata-mismatch',
    source: async () => new File([wave()], 'metadata.wav', { type: 'audio/wav' }),
    sourceStartSec: 0,
    sourceEndSec: 1 / 48_000,
    columns: 1,
    sampleRate: 44_100,
    channelCount: 1,
  }, new AbortController().signal)
  await expect(result).rejects.toThrow('metadata changed')
})

test('direct decoding rejects invalid bounds before resolving a source', async () => {
  let sourceCalls = 0
  const source = async () => {
    sourceCalls += 1
    return new Blob()
  }
  const base = {
    assetKey: 'invalid-direct',
    source,
    sourceStartSec: 0,
    sourceEndSec: 1,
    columns: 2,
    sampleRate: 48_000,
    channelCount: 1,
  }
  const invalidRequests = [
    { ...base, sourceStartSec: -1 },
    { ...base, sourceEndSec: 0 },
    { ...base, columns: 0 },
    { ...base, sampleRate: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, channelCount: 0 },
    { ...base, sourceEndSec: Number.MAX_VALUE },
  ]

  for (const invalid of invalidRequests) {
    expect(await decodeArrangementWaveformPcmEnvelope(
      invalid,
      new AbortController().signal,
    )).toBeNull()
  }
  expect(sourceCalls).toBe(0)
})
