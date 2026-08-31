import { expect, test } from 'bun:test'

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
