import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import {
  clearWaveformAssetCache,
  ensurePeakAsset,
  getWaveformCacheSizes,
  loadCachedPeakAsset,
  loadPeakChunkData,
  waveformCacheLimits,
} from './asset-store'
import { createPeakAssetRecord, getPeakChunkRecord } from './extract-peaks'
import { loadPeakAssetRecord, loadPeakChunk, storePeakAssetRecord, storePeakChunk } from './peak-db'

const source = (input: {
  readonly identity: string
  readonly durationSec: number
  readonly persistable?: boolean
  readonly started?: () => void
  readonly release?: Promise<void>
}): AudioPcmSourceDescriptor => ({
  identity: input.identity,
  durationSec: input.durationSec,
  frameCount: Math.max(1, Math.round(input.durationSec * 400)),
  sampleRate: 400,
  channelCount: 1,
  persistable: input.persistable,
  readPages: async function* (options = {}) {
    input.started?.()
    if (input.release) await input.release
    options.signal?.throwIfAborted()
    yield {
      startFrame: 0,
      frameCount: 1,
      sampleRate: 400,
      channelCount: 1,
      planes: [new Float32Array([0])],
    }
  },
})

const deferred = () => {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

const generationChunkKeys = async (assetKey: string) => {
  const request = indexedDB.open('audio-peaks-db', 5)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return await new Promise<string[]>((resolve, reject) => {
    const transaction = db.transaction('asset-chunks', 'readonly')
    const requestKeys = transaction.objectStore('asset-chunks').getAllKeys()
    requestKeys.onsuccess = () => resolve(
      requestKeys.result
        .map(String)
        .filter((key) => key.startsWith(`${assetKey}:`)),
    )
    requestKeys.onerror = () => reject(requestKeys.error)
  })
}

describe('waveform asset store', () => {
  beforeEach(() => clearWaveformAssetCache())

  test('serializes source generations and rejects the stale generation', async () => {
    const first = ensurePeakAsset({
      assetKey: 'generation',
      sourceIdentity: { assetKey: 'generation', identity: 'one', durationSec: 1, frameCount: 400, sampleRate: 400, channelCount: 1 },
      source: source({ identity: 'one', durationSec: 1 }),
    })
    const second = ensurePeakAsset({
      assetKey: 'generation',
      sourceIdentity: { assetKey: 'generation', identity: 'two', durationSec: 2, frameCount: 800, sampleRate: 400, channelCount: 1 },
      source: source({ identity: 'two', durationSec: 2 }),
    })
    expect(await first).toBeNull()
    expect((await second)?.durationSec).toBe(2)
  })

  test('aborts blocked superseded reads without aborting same-identity subscribers', async () => {
    const started = deferred()
    const readAborted = deferred()
    let release: () => void = () => {}
    const oldSource: AudioPcmSourceDescriptor = {
      ...source({ identity: 'blocked-old', durationSec: 1 }),
      readPages: async function* (options = {}) {
        options.signal?.addEventListener('abort', readAborted.resolve, { once: true })
        started.resolve()
        await new Promise<void>((resolve) => { release = resolve })
        options.signal?.throwIfAborted()
        yield {
          startFrame: 0,
          frameCount: 1,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array([0])],
        }
      },
    }
    const old = ensurePeakAsset({
      assetKey: 'blocked-superseded',
      source: oldSource,
    })
    const oldSettled = deferred()
    void old.then(() => oldSettled.resolve())
    await started.promise
    const replacement = ensurePeakAsset({
      assetKey: 'blocked-superseded',
      sourceIdentity: { assetKey: 'blocked-superseded', identity: 'new', durationSec: 2, frameCount: 800, sampleRate: 400, channelCount: 1 },
      source: source({ identity: 'new', durationSec: 2 }),
    })
    await readAborted.promise
    await oldSettled.promise
    release()
    expect(await old).toBeNull()
    expect((await replacement)?.sourceIdentity?.identity).toBe('new')
  })

  test('detaches an aborted waiter while retaining a shared generation', async () => {
    const started = deferred()
    const release = deferred()
    const shared = source({
      identity: 'shared',
      durationSec: 1,
      started: started.resolve,
      release: release.promise,
    })
    const controller = new AbortController()
    const first = ensurePeakAsset({ assetKey: 'shared', source: shared, signal: controller.signal })
    await started.promise
    const second = ensurePeakAsset({ assetKey: 'shared', source: shared })
    controller.abort()
    expect(await first).toBeNull()
    release.resolve()
    expect((await second)?.durationSec).toBe(1)
  })

  test('restarts same-identity work after final abort without stale pending cleanup', async () => {
    const firstRelease = deferred()
    const secondRelease = deferred()
    const firstStarted = deferred()
    const secondStarted = deferred()
    let reads = 0
    const shared: AudioPcmSourceDescriptor = {
      identity: 'restartable',
      durationSec: 1,
      frameCount: 400,
      sampleRate: 400,
      channelCount: 1,
      persistable: true,
      readPages: async function* (options = {}) {
        reads += 1
        const read = reads
        if (read === 1) firstStarted.resolve()
        if (read === 2) secondStarted.resolve()
        await (read === 1 ? firstRelease.promise : secondRelease.promise)
        options.signal?.throwIfAborted()
        yield {
          startFrame: 0,
          frameCount: 1,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array([read])],
        }
      },
    }
    const controller = new AbortController()
    const first = ensurePeakAsset({ assetKey: 'restartable', source: shared, signal: controller.signal })
    await firstStarted.promise
    controller.abort()
    expect(await first).toBeNull()

    const replacement = ensurePeakAsset({ assetKey: 'restartable', source: shared })
    await secondStarted.promise
    firstRelease.resolve()
    await Promise.resolve()
    const third = ensurePeakAsset({ assetKey: 'restartable', source: shared })
    expect(reads).toBe(2)

    secondRelease.resolve()
    const [replacementRecord, thirdRecord] = await Promise.all([replacement, third])
    expect(replacementRecord).not.toBeNull()
    expect(thirdRecord?.generationId).toBe(replacementRecord?.generationId)
  })

  test('keeps persisted readers on the old generation until replacement publication', async () => {
    const oldSource = source({ identity: 'old', durationSec: 1, persistable: true })
    const initial = await ensurePeakAsset({ assetKey: 'atomic', source: oldSource })
    if (!initial) throw new Error('Expected initial generation')
    clearWaveformAssetCache()
    const started = deferred()
    const release = deferred()
    const replacement = source({
      identity: 'new',
      durationSec: 2,
      persistable: true,
      started: started.resolve,
      release: release.promise,
    })
    const next = ensurePeakAsset({ assetKey: 'atomic', source: replacement })
    await started.promise
    expect((await loadPeakAssetRecord('atomic'))?.generationId).toBe(initial.generationId)
    release.resolve()
    const published = await next
    expect(published?.generationId).not.toBe(initial.generationId)
    expect((await loadPeakAssetRecord('atomic'))?.generationId).toBe(published?.generationId)
  })

  test('does not publish or retain chunks when replacement starts during metadata write', async () => {
    const assetKey = 'metadata-race'
    const originalPut = IDBObjectStore.prototype.put
    let replacement: ReturnType<typeof ensurePeakAsset> | undefined
    let startedReplacement = false
    IDBObjectStore.prototype.put = function put(value, key) {
      const result = originalPut.call(this, value, key)
      if (!startedReplacement && this.name === 'asset-meta' && key === assetKey) {
        startedReplacement = true
        replacement = ensurePeakAsset({
          assetKey,
          sourceIdentity: {
            assetKey,
            identity: 'new',
            durationSec: 2,
            frameCount: 800,
            sampleRate: 400,
            channelCount: 1,
          },
          source: source({ identity: 'new', durationSec: 2, persistable: true }),
        })
      }
      return result
    }
    try {
      const old = ensurePeakAsset({
        assetKey,
        source: source({ identity: 'old', durationSec: 1, persistable: true }),
      })
      expect(await old).toBeNull()
      const next = replacement
      if (!next) throw new Error('Expected replacement generation')
      const published = await next
      expect(published?.sourceIdentity?.identity).toBe('new')
      expect((await loadPeakAssetRecord(assetKey))?.generationId).toBe(published?.generationId)
      const remaining = await generationChunkKeys(assetKey)
      expect(remaining.every((key) => key.includes(published?.generationId ?? ''))).toBe(true)
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }
  })

  test('keeps committed chunks when superseded during metadata publication', async () => {
    const assetKey = 'committed-superseded'
    const replacementStarted = deferred()
    const replacementRelease = deferred()
    let replacement: ReturnType<typeof ensurePeakAsset> | undefined
    const oldRecord = createPeakAssetRecord({
      durationSec: 1,
      frameCount: 400,
      sampleRate: 400,
      channelCount: 1,
    }, assetKey, {
      assetKey,
      identity: 'old',
      durationSec: 1,
      frameCount: 400,
      sampleRate: 400,
      channelCount: 1,
    })
    await storePeakAssetRecord(oldRecord)
    const missingOldChunk = getPeakChunkRecord(
      assetKey,
      oldRecord.generationId,
      oldRecord.levels[0]!,
      oldRecord.channelCount,
      0,
    )
    expect(await loadPeakChunk(missingOldChunk.chunkKey)).toBeNull()
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function put(value, key) {
      const result = originalPut.call(this, value, key)
      if (!replacement && this.name === 'asset-meta' && key === assetKey) {
        replacement = ensurePeakAsset({
          assetKey,
          sourceIdentity: {
            assetKey,
            identity: 'final',
            durationSec: 3,
            frameCount: 1_200,
            sampleRate: 400,
            channelCount: 1,
          },
          source: {
            ...source({ identity: 'final', durationSec: 3, persistable: true }),
            readPages: async function* (options = {}) {
              replacementStarted.resolve()
              await replacementRelease.promise
              options.signal?.throwIfAborted()
              yield {
                startFrame: 0,
                frameCount: 1,
                sampleRate: 400,
                channelCount: 1,
                planes: [new Float32Array([0])],
              }
            },
          },
        })
      }
      return result
    }
    try {
      const stale = ensurePeakAsset({
        assetKey,
        source: source({ identity: 'new', durationSec: 2, persistable: true }),
      })
      await replacementStarted.promise
      expect(await stale).toBeNull()
      replacementRelease.resolve()
      const published = await replacement
      expect(published?.sourceIdentity?.identity).toBe('final')
      expect((await loadPeakAssetRecord(assetKey))?.generationId).toBe(published?.generationId)
      const remaining = await generationChunkKeys(assetKey)
      expect(remaining.every((key) => key.includes(published?.generationId ?? ''))).toBe(true)
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }
  })

  test('settles pending readers during cache clear before ignored aborts complete', async () => {
    const started = deferred()
    const release = deferred()
    const blocked = ensurePeakAsset({
      assetKey: 'clear-blocked',
      source: {
        ...source({ identity: 'blocked', durationSec: 1 }),
        readPages: async function* (options = {}) {
          started.resolve()
          await release.promise
          options.signal?.throwIfAborted()
          yield {
            startFrame: 0,
            frameCount: 1,
            sampleRate: 400,
            channelCount: 1,
            planes: [new Float32Array([0])],
          }
        },
      },
    })
    await started.promise
    clearWaveformAssetCache()
    expect(await blocked).toBeNull()
    const replacement = ensurePeakAsset({
      assetKey: 'clear-blocked',
      source: source({ identity: 'replacement', durationSec: 2 }),
    })
    expect((await replacement)?.sourceIdentity?.identity).toBe('replacement')
    release.resolve()
    expect(await blocked).toBeNull()
  })

  test('does not return stale metadata from a read crossing cache clear', async () => {
    const assetKey = 'blocked-metadata-read'
    const oldRecord = createPeakAssetRecord({
      durationSec: 1,
      frameCount: 400,
      sampleRate: 400,
      channelCount: 1,
    }, assetKey, {
      assetKey,
      identity: 'old',
      durationSec: 1,
      frameCount: 400,
      sampleRate: 400,
      channelCount: 1,
    })
    const newRecord = createPeakAssetRecord({
      durationSec: 2,
      frameCount: 800,
      sampleRate: 400,
      channelCount: 1,
    }, assetKey, {
      assetKey,
      identity: 'new',
      durationSec: 2,
      frameCount: 800,
      sampleRate: 400,
      channelCount: 1,
    })
    await storePeakAssetRecord(oldRecord)
    const started = deferred()
    const originalGet = IDBObjectStore.prototype.get
    let readBlocked = false
    let blockedSuccess: ((event: Event) => void) | null = null
    const releaseBlockedRead = () => {
      if (blockedSuccess) blockedSuccess(new Event('success'))
    }
    IDBObjectStore.prototype.get = function get(key) {
      const request = originalGet.call(this, key)
      if (!readBlocked && this.name === 'asset-meta' && key === assetKey) {
        readBlocked = true
        Object.defineProperty(request, 'onsuccess', {
          configurable: true,
          get: () => null,
          set: (handler: ((event: Event) => void) | null) => {
            blockedSuccess = handler
          },
        })
        request.addEventListener('success', () => {
          started.resolve()
        })
      }
      return request
    }
    try {
      const stale = loadCachedPeakAsset(assetKey)
      let staleSettled = false
      void stale.then(() => {
        staleSettled = true
      })
      await started.promise
      clearWaveformAssetCache()
      await Promise.resolve()
      expect(staleSettled).toBe(false)
      await storePeakAssetRecord(newRecord)
      const replacement = loadCachedPeakAsset(assetKey)
      expect((await replacement)?.sourceIdentity?.identity).toBe('new')
      releaseBlockedRead()
      expect(await stale).toBeNull()
    } finally {
      IDBObjectStore.prototype.get = originalGet
    }
  })

  test('does not return stale chunk data from a read crossing cache clear', async () => {
    const assetKey = 'blocked-chunk-read'
    const record = createPeakAssetRecord({
      durationSec: 1,
      frameCount: 400,
      sampleRate: 400,
      channelCount: 1,
    }, assetKey, {
      assetKey,
      identity: 'chunk',
      durationSec: 1,
      frameCount: 400,
      sampleRate: 400,
      channelCount: 1,
    })
    const chunk = getPeakChunkRecord(assetKey, record.generationId, record.levels[0]!, record.channelCount, 0)
    const oldData = [new Uint8Array(chunk.intervalCount * 2)]
    const newData = [new Uint8Array(chunk.intervalCount * 2).fill(1)]
    await storePeakChunk(chunk.chunkKey, oldData)
    const started = deferred()
    const originalGet = IDBObjectStore.prototype.get
    let readBlocked = false
    let blockedSuccess: ((event: Event) => void) | null = null
    const releaseBlockedRead = () => {
      if (blockedSuccess) blockedSuccess(new Event('success'))
    }
    IDBObjectStore.prototype.get = function get(key) {
      const request = originalGet.call(this, key)
      if (!readBlocked && this.name === 'asset-chunks' && key === chunk.chunkKey) {
        readBlocked = true
        Object.defineProperty(request, 'onsuccess', {
          configurable: true,
          get: () => null,
          set: (handler: ((event: Event) => void) | null) => {
            blockedSuccess = handler
          },
        })
        request.addEventListener('success', () => {
          started.resolve()
        })
      }
      return request
    }
    try {
      const stale = loadPeakChunkData(chunk.chunkKey)
      let staleSettled = false
      void stale.then(() => {
        staleSettled = true
      })
      await started.promise
      clearWaveformAssetCache()
      await Promise.resolve()
      expect(staleSettled).toBe(false)
      await storePeakChunk(chunk.chunkKey, newData)
      const replacement = loadPeakChunkData(chunk.chunkKey)
      expect((await replacement)?.[0]?.[0]).toBe(1)
      releaseBlockedRead()
      expect(await stale).toBeNull()
    } finally {
      IDBObjectStore.prototype.get = originalGet
    }
  })

  test('keeps a shared generation alive when its creator aborts before a third subscriber joins', async () => {
    const started = deferred()
    const release = deferred()
    let reads = 0
    const shared = source({
      identity: 'three-way',
      durationSec: 1,
      started: () => {
        reads += 1
        started.resolve()
      },
      release: release.promise,
    })
    const creatorController = new AbortController()
    const creator = ensurePeakAsset({ assetKey: 'three-way', source: shared, signal: creatorController.signal })
    await started.promise
    const second = ensurePeakAsset({ assetKey: 'three-way', source: shared })
    creatorController.abort()
    const third = ensurePeakAsset({ assetKey: 'three-way', source: shared })
    release.resolve()
    expect(await creator).toBeNull()
    expect((await second)?.durationSec).toBe(1)
    expect((await third)?.durationSec).toBe(1)
    expect(reads).toBe(1)
  })

  test('does not persist session-only assets and bounds record cache entries', async () => {
    const assetKey = 'session-only'
    const record = await ensurePeakAsset({
      assetKey,
      source: source({ identity: 'session', durationSec: 1 }),
    })
    if (!record) throw new Error('Expected generated record')
    const chunk = getPeakChunkRecord(assetKey, record.generationId, record.levels[0]!, record.channelCount, 0)
    expect(await loadPeakAssetRecord(assetKey)).toBeNull()
    expect(await loadPeakChunk(chunk.chunkKey)).toBeNull()
    for (let index = 0; index < waveformCacheLimits.recordEntries + 4; index += 1) {
      await ensurePeakAsset({
        assetKey: `asset-${index}`,
        source: source({ identity: `asset-${index}`, durationSec: 0.1 }),
      })
    }
    expect(getWaveformCacheSizes().recordEntries).toBe(waveformCacheLimits.recordEntries)
    expect(getWaveformCacheSizes().generationEntries).toBe(0)
  })

  test('reloads persisted metadata after clearing memory caches', async () => {
    const assetKey = 'persisted'
    const persisted = source({ identity: 'persisted', durationSec: 2, persistable: true })
    const initial = await ensurePeakAsset({ assetKey, source: persisted })
    if (!initial) throw new Error('Expected persisted record')
    clearWaveformAssetCache()
    const reopened = await ensurePeakAsset({ assetKey, source: persisted })
    expect(reopened?.sourceIdentity?.identity).toBe('persisted')
    expect(reopened?.levels).toEqual(initial.levels)
  })

  test('removes chunks from an aborted unpublished generation', async () => {
    const started = deferred()
    const release = deferred()
    const abortable: AudioPcmSourceDescriptor = {
      identity: 'aborted-generation',
      durationSec: 4,
      frameCount: 1_600,
      sampleRate: 400,
      channelCount: 1,
      persistable: true,
      readPages: async function* (options = {}) {
        yield {
          startFrame: 0,
          frameCount: 1_024,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array(1_024)],
        }
        started.resolve()
        await release.promise
        options.signal?.throwIfAborted()
        yield {
          startFrame: 1_024,
          frameCount: 576,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array(576)],
        }
      },
    }
    const controller = new AbortController()
    const pending = ensurePeakAsset({
      assetKey: 'aborted-unpublished',
      source: abortable,
      signal: controller.signal,
    })
    await started.promise
    controller.abort()
    release.resolve()
    expect(await pending).toBeNull()
    expect(await generationChunkKeys('aborted-unpublished')).toEqual([])
  })

  test('removes stale and failed unpublished generations without touching published metadata', async () => {
    const firstGate = deferred()
    const firstStarted = deferred()
    const first: AudioPcmSourceDescriptor = {
      identity: 'stale-generation',
      durationSec: 4,
      frameCount: 2_048,
      sampleRate: 400,
      channelCount: 1,
      persistable: true,
      readPages: async function* () {
        yield {
          startFrame: 0,
          frameCount: 1_024,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array(1_024)],
        }
        firstStarted.resolve()
        await firstGate.promise
        yield {
          startFrame: 1_024,
          frameCount: 1_024,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array(1_024)],
        }
      },
    }
    const second = source({ identity: 'replacement-generation', durationSec: 1, persistable: true })
    const firstPending = ensurePeakAsset({ assetKey: 'stale-unpublished', source: first })
    await firstStarted.promise
    const replacement = ensurePeakAsset({ assetKey: 'stale-unpublished', source: second })
    firstGate.resolve()
    expect(await firstPending).toBeNull()
    const published = await replacement
    if (!published) throw new Error('Expected replacement generation')
    expect(published.sourceIdentity?.identity).toBe('replacement-generation')
    const remaining = await generationChunkKeys('stale-unpublished')
    expect(remaining.every((key) => key.includes(published.generationId))).toBe(true)

    const failing: AudioPcmSourceDescriptor = {
      ...source({ identity: 'failed-generation', durationSec: 4, persistable: true }),
      readPages: async function* () {
        yield {
          startFrame: 0,
          frameCount: 1_024,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array(1_024)],
        }
        throw new Error('failed generation')
      },
    }
    clearWaveformAssetCache()
    expect(await ensurePeakAsset({ assetKey: 'failed-unpublished', source: failing })).toBeNull()
    expect(await generationChunkKeys('failed-unpublished')).toEqual([])
  })
})
