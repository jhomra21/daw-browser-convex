import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { createPreparedStretchArtifact } from './prepared-stretch-artifact'
import {
  createPreparedStretchArtifactRepository,
  createPreparedStretchArtifactSessionRepository,
  type PreparedStretchArtifactManifest,
  type PreparedStretchArtifactLockManager,
} from './prepared-stretch-store'
import { preparedStretchTestLockManager } from './prepared-stretch-test-lock-manager'
import { createAudioStretchReadPlan } from './audio-stretch-read-plan'
import type { AudioPcmSourceDescriptor } from './media-pages'

const source: AudioPcmSourceDescriptor = {
  identity: 'source',
  contentHash: 'a'.repeat(64),
  contentHashVerified: true,
  persistable: true,
  durationSec: 1,
  frameCount: 5,
  sampleRate: 5,
  channelCount: 1,
  readPages: async function* () {},
}

const artifact = createPreparedStretchArtifact({
  source,
  plan: createAudioStretchReadPlan({
    clip: {
      id: 'clip',
      startSec: 0,
      duration: 1,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    },
    source,
    projectBpm: 120,
  }),
  persistable: true,
  windowFrameCount: 4,
  overlapFrameCount: 2,
  searchFrameCount: 1,
})

const deletePreparedStretchDatabase = async () => new Promise<void>((resolve, reject) => {
  const request = indexedDB.deleteDatabase('daw-browser-prepared-stretch-artifacts')
  request.onsuccess = () => resolve()
  request.onerror = () => reject(request.error ?? new Error('Failed to reset prepared Stretch artifact database.'))
  request.onblocked = () => reject(new Error('Prepared Stretch artifact database reset was blocked.'))
})

const countOwnedRows = async (sessionId: string) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('daw-browser-prepared-stretch-artifacts', 5)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to inspect prepared Stretch artifact database.'))
  })
  try {
    return await new Promise<{ writes: number; pages: number }>((resolve, reject) => {
      const transaction = db.transaction(['writes', 'pages'], 'readonly')
      const writesRequest = transaction.objectStore('writes').openCursor()
      const pagesRequest = transaction.objectStore('pages').openCursor()
      const ownedWrites: { sessionId: string; writeId: string }[] = []
      const allPages: { writeId: string }[] = []
      const writeIds = new Set<string>()
      writesRequest.onsuccess = () => {
        const cursor = writesRequest.result
        if (!cursor) return
        const row: { sessionId: string; writeId: string } = cursor.value
        ownedWrites.push(row)
        cursor.continue()
      }
      pagesRequest.onsuccess = () => {
        const cursor = pagesRequest.result
        if (!cursor) return
        const row: { writeId: string } = cursor.value
        allPages.push(row)
        cursor.continue()
      }
      writesRequest.onerror = () => reject(writesRequest.error ?? new Error('Failed to inspect prepared Stretch writes.'))
      pagesRequest.onerror = () => reject(pagesRequest.error ?? new Error('Failed to inspect prepared Stretch pages.'))
      transaction.oncomplete = () => {
        for (const row of ownedWrites) {
          if (row.sessionId === sessionId) writeIds.add(row.writeId)
        }
        resolve({
          writes: writeIds.size,
          pages: allPages.filter((row) => writeIds.has(row.writeId)).length,
        })
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('Failed to inspect prepared Stretch rows.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Prepared Stretch row inspection aborted.'))
    })
  } finally {
    db.close()
  }
}

const countGarbageForWrite = async (writeId: string) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('daw-browser-prepared-stretch-artifacts', 5)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to inspect prepared Stretch artifact database.'))
  })
  try {
    return await new Promise<{ garbage: number; pages: number }>((resolve, reject) => {
      const transaction = db.transaction(['garbage', 'pages'], 'readonly')
      const garbageRequest = transaction.objectStore('garbage').openCursor()
      const pagesRequest = transaction.objectStore('pages').openCursor()
      let garbage = 0
      let pages = 0
      garbageRequest.onsuccess = () => {
        const cursor = garbageRequest.result
        if (!cursor) return
        const row: { writeId: string } = cursor.value
        if (row.writeId === writeId) garbage += 1
        cursor.continue()
      }
      pagesRequest.onsuccess = () => {
        const cursor = pagesRequest.result
        if (!cursor) return
        const row: { writeId: string } = cursor.value
        if (row.writeId === writeId) pages += 1
        cursor.continue()
      }
      garbageRequest.onerror = () => reject(garbageRequest.error ?? new Error('Failed to inspect prepared Stretch garbage.'))
      pagesRequest.onerror = () => reject(pagesRequest.error ?? new Error('Failed to inspect prepared Stretch pages.'))
      transaction.oncomplete = () => resolve({ garbage, pages })
      transaction.onerror = () => reject(transaction.error ?? new Error('Failed to inspect prepared Stretch rows.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Prepared Stretch row inspection aborted.'))
    })
  } finally {
    db.close()
  }
}

const createDelayedWriteReleaseLockManager = (throwOnRelease = false) => {
  let releaseResolve: () => void = () => undefined
  let releaseStartedResolve: () => void = () => undefined
  const releaseGate = new Promise<void>((resolve) => { releaseResolve = resolve })
  const releaseStarted = new Promise<void>((resolve) => { releaseStartedResolve = resolve })
  let started = false
  const lockManager: PreparedStretchArtifactLockManager = {
    request: async <Value>(
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: { name: string } | null) => Promise<Value>,
    ) => {
      const result = await preparedStretchTestLockManager.request(name, options, callback)
      if (options.ifAvailable !== true && name.startsWith('daw-browser-prepared-stretch-write:')) {
        if (!started) {
          started = true
          releaseStartedResolve()
        }
        await releaseGate
        if (throwOnRelease) throw new Error('Prepared Stretch test lock release failed.')
      }
      return result
    },
  }
  return {
    lockManager,
    releaseStarted,
    release: releaseResolve,
  }
}

test('stores exact and partial artifact page reads and publishes atomically', async () => {
  const repository = createPreparedStretchArtifactRepository({ sessionId: crypto.randomUUID(), lockManager: preparedStretchTestLockManager })
  const write = await repository.begin(artifact)
  expect(await repository.find(artifact.artifactId)).toBeNull()
  await write.append([Float32Array.of(0, 1, 2)])
  await write.append([Float32Array.of(3, 4)])
  const manifest = await write.commit()
  expect(manifest.frameCount).toBe(5)
  const pages = []
  for await (const page of repository.read(artifact.artifactId, 1, 4)) pages.push(page)
  expect(pages.flatMap((page) => [...(page.planes[0] ?? [])])).toEqual([1, 2, 3])
  await repository.dispose?.()
})

test('aborted artifact writes remain invisible', async () => {
  const repository = createPreparedStretchArtifactRepository({ lockManager: preparedStretchTestLockManager })
  const write = await repository.begin({ ...artifact, artifactId: `${artifact.artifactId}-abort` })
  await write.append([Float32Array.of(1, 2)])
  await write.abort()
  expect(await repository.find(`${artifact.artifactId}-abort`)).toBeNull()
  await repository.dispose?.()
})

test('rejects invalid ranges and append shapes before storage changes', async () => {
  const repository = createPreparedStretchArtifactSessionRepository({ lockManager: preparedStretchTestLockManager })
  const validationArtifact = { ...artifact, artifactId: `${artifact.artifactId}-validation` }
  const validWrite = await repository.begin(validationArtifact)
  await validWrite.append([Float32Array.of(0, 1, 2, 3, 4)])
  await validWrite.commit()
  for (const range of [
    [Number.NaN, 1],
    [0.5, 1],
    [0, Number.POSITIVE_INFINITY],
    [-1, 1],
    [4, 3],
    [0, 6],
  ]) {
    await expect(repository.read(validationArtifact.artifactId, range[0], range[1]).next())
      .rejects.toThrow('read range is invalid')
  }
  const write = await repository.begin({ ...artifact, artifactId: `${artifact.artifactId}-append-validation` })
  await expect(write.append([new Float32Array(0)])).rejects.toThrow('PCM page is invalid')
  await expect(write.append([new Float32Array(6)])).rejects.toThrow('exceeds the declared frame count')
  await write.append([Float32Array.of(0, 1, 2, 3, 4)])
  await write.commit()
  const pages = []
  for await (const page of repository.read(`${artifact.artifactId}-append-validation`, 4, 5)) pages.push(page)
  expect(pages[0]?.frameCount).toBe(1)
  await repository.dispose?.()
})

test('binds committed pages to the winning write generation', async () => {
  const artifactId = `${artifact.artifactId}-generation`
  const leftRepository = createPreparedStretchArtifactRepository({ sessionId: 'left-generation', lockManager: preparedStretchTestLockManager })
  const rightRepository = createPreparedStretchArtifactRepository({ sessionId: 'right-generation', lockManager: preparedStretchTestLockManager })
  const left = await leftRepository.begin({ ...artifact, artifactId })
  const right = await rightRepository.begin({ ...artifact, artifactId })
  await left.append([Float32Array.of(1, 1)])
  await right.append([Float32Array.of(2, 2, 2, 2, 2)])
  const winningManifest = await right.commit()
  expect((await leftRepository.find(artifactId))?.writeId).toBe(winningManifest.writeId)
  await left.append([Float32Array.of(1, 1, 1)])
  const losingCommit = await left.commit()

  expect(losingCommit.writeId).toBe(winningManifest.writeId)
  const pages = []
  for await (const page of leftRepository.read(artifactId)) pages.push(page)
  expect(pages.flatMap((page) => [...(page.planes[0] ?? [])])).toEqual([2, 2, 2, 2, 2])

  await leftRepository.cleanupSession('left-generation')
  const afterLoserCleanup = []
  for await (const page of rightRepository.read(artifactId)) afterLoserCleanup.push(page)
  expect(afterLoserCleanup.flatMap((page) => [...(page.planes[0] ?? [])])).toEqual([2, 2, 2, 2, 2])
  await leftRepository.dispose?.()
  await rightRepository.dispose?.()
})

test('keeps a live foreign writer past its expiry and reclaims an abandoned writer', async () => {
  let timestamp = 1_000
  const liveRepository = createPreparedStretchArtifactRepository({
    sessionId: 'live-writer',
    now: () => timestamp,
    lockManager: preparedStretchTestLockManager,
  })
  const observerRepository = createPreparedStretchArtifactRepository({
    sessionId: 'observer',
    now: () => timestamp,
    lockManager: preparedStretchTestLockManager,
  })
  const liveArtifact = { ...artifact, artifactId: `${artifact.artifactId}-live` }
  const liveWrite = await liveRepository.begin(liveArtifact)
  await liveWrite.append([Float32Array.of(1, 2)])
  timestamp += 120_001
  await observerRepository.find(`${artifact.artifactId}-missing`)
  await liveWrite.append([Float32Array.of(3, 4, 5)])
  await liveWrite.commit()
  expect(await observerRepository.find(liveArtifact.artifactId)).not.toBeNull()

  const abandonedArtifact = { ...artifact, artifactId: `${artifact.artifactId}-abandoned` }
  const abandonedWrite = await liveRepository.begin(abandonedArtifact)
  await abandonedWrite.append([Float32Array.of(1, 2)])
  await liveRepository.cleanupSession('live-writer')
  await observerRepository.cleanupSession('live-writer')
  let resumed = true
  try {
    await abandonedWrite.append([Float32Array.of(3, 4, 5)])
  } catch {
    resumed = false
  }
  expect(resumed).toBe(false)
  expect(await observerRepository.find(abandonedArtifact.artifactId)).toBeNull()
  await liveRepository.dispose?.()
  await observerRepository.dispose?.()
})

test('reclaims more than one batch of empty abandoned writes', async () => {
  const sessionId = `empty-abandoned-${crypto.randomUUID()}`
  const repository = createPreparedStretchArtifactRepository({
    sessionId,
    lockManager: preparedStretchTestLockManager,
  })
  const writes = []
  for (let index = 0; index < 65; index += 1) {
    writes.push(await repository.begin({
      ...artifact,
      artifactId: `${artifact.artifactId}-empty-abandoned-${index}-${crypto.randomUUID()}`,
    }))
  }
  await repository.cleanupSession(sessionId)
  expect(await countOwnedRows(sessionId)).toEqual({ writes: 0, pages: 0 })
  for (const write of writes) await write.abort()
  await repository.dispose?.()
})

test.serial('unpublishes before bounded quota cleanup and reclaims remaining garbage later', async () => {
  const pageFrames = 16_384
  for (const pageCount of [63, 64, 65]) {
    await deletePreparedStretchDatabase()
    const repository = createPreparedStretchArtifactRepository({
      sessionId: `quota-generation-${pageCount}-${crypto.randomUUID()}`,
      lockManager: preparedStretchTestLockManager,
    })
    const source: AudioPcmSourceDescriptor = {
      identity: `quota-source-${pageCount}`,
      contentHash: pageCount.toString(16).padStart(64, '0'),
      contentHashVerified: true,
      persistable: true,
      durationSec: pageCount,
      frameCount: pageCount * pageFrames,
      sampleRate: pageFrames,
      channelCount: 1,
      readPages: async function* () {},
    }
    const oldArtifact = createPreparedStretchArtifact({
      source,
      plan: createAudioStretchReadPlan({
        clip: {
          id: `quota-${pageCount}`,
          startSec: 0,
          duration: pageCount,
          audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
        },
        source,
        projectBpm: 120,
      }),
      persistable: true,
      windowFrameCount: 4,
      overlapFrameCount: 2,
      searchFrameCount: 1,
    })
    const oldWrite = await repository.begin(oldArtifact)
    for (let index = 0; index < pageCount; index += 1) await oldWrite.append([new Float32Array(pageFrames)])
    const oldManifest = await oldWrite.commit()
    const originalPut = IDBObjectStore.prototype.put
    let failures = 1
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'pages' && failures > 0) {
        failures -= 1
        throw new DOMException('Quota exceeded.', 'QuotaExceededError')
      }
      return originalPut.call(this, value, key)
    }
    try {
      const replacementSource: AudioPcmSourceDescriptor = {
        ...source,
        identity: `${source.identity}-replacement`,
        contentHash: 'f'.repeat(64),
        durationSec: 1,
        frameCount: pageFrames,
      }
      const replacement = createPreparedStretchArtifact({
        source: replacementSource,
        plan: createAudioStretchReadPlan({
          clip: {
            id: `quota-${pageCount}-replacement`,
            startSec: 0,
            duration: 1,
            audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
          },
          source: replacementSource,
          projectBpm: 120,
        }),
        persistable: true,
        windowFrameCount: 4,
        overlapFrameCount: 2,
        searchFrameCount: 1,
      })
      const replacementWrite = await repository.begin(replacement)
      await replacementWrite.append([new Float32Array(pageFrames)])
      expect(await repository.find(oldArtifact.artifactId)).toBeNull()
      expect(await countGarbageForWrite(oldManifest.writeId)).toEqual({
        garbage: pageCount === 65 ? 1 : 0,
        pages: pageCount === 65 ? 1 : 0,
      })
      await repository.cleanupSession(`quota-cleanup-${crypto.randomUUID()}`)
      expect(await countGarbageForWrite(oldManifest.writeId)).toEqual({ garbage: 0, pages: 0 })
      const replacementManifest = await replacementWrite.commit()
      expect(replacementManifest.writeId).not.toBe(oldManifest.writeId)
      expect((await repository.find(replacement.artifactId))?.writeId).toBe(replacementManifest.writeId)
      const pages = []
      for await (const page of repository.read(replacement.artifactId)) pages.push(page)
      expect(pages).toHaveLength(1)
      expect(pages[0]?.writeId).toBe(replacementManifest.writeId)
      expect(pages[0]?.frameCount).toBe(pageFrames)
    } finally {
      IDBObjectStore.prototype.put = originalPut
      await repository.dispose?.()
      await deletePreparedStretchDatabase()
    }
  }
})

test.serial('does not evict a leased generation on quota retry', async () => {
  let timestamp = 1_000
  const repository = createPreparedStretchArtifactRepository({
    sessionId: 'leased-quota',
    now: () => timestamp,
    lockManager: preparedStretchTestLockManager,
  })
  const leasedArtifact = { ...artifact, artifactId: `${artifact.artifactId}-leased-quota` }
  const oldWrite = await repository.begin(leasedArtifact)
  await oldWrite.append([Float32Array.of(1, 2, 3, 4, 5)])
  const oldManifest = await oldWrite.commit()
  const reader = repository.read(leasedArtifact.artifactId)
  await reader.next()
  timestamp += 120_001

  const originalPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === 'pages') throw new DOMException('Quota exceeded.', 'QuotaExceededError')
    return originalPut.call(this, value, key)
  }
  try {
    const replacementWrite = await repository.begin({ ...leasedArtifact })
    await replacementWrite.append([Float32Array.of(6, 7, 8, 9, 10)])
    await expect(replacementWrite.commit()).rejects.toThrow('Quota exceeded')
    expect((await repository.find(leasedArtifact.artifactId))?.writeId).toBe(oldManifest.writeId)
  } finally {
    IDBObjectStore.prototype.put = originalPut
    await reader.return?.(undefined)
  }
  await repository.dispose?.()
})

test('packs every source append into fixed pages and preserves the tail range', async () => {
  const repository = createPreparedStretchArtifactRepository({
    sessionId: `packing-${crypto.randomUUID()}`,
    lockManager: preparedStretchTestLockManager,
  })
  const packingArtifact = {
    ...artifact,
    artifactId: `${artifact.artifactId}-packing-${crypto.randomUUID()}`,
    output: { ...artifact.output, frameCount: 16_386 },
  }
  const write = await repository.begin(packingArtifact)
  await write.append([Float32Array.from({ length: 2 }, (_, index) => index)])
  await write.append([Float32Array.from({ length: 16_384 }, (_, index) => index + 2)])
  await write.commit()

  const pages = []
  for await (const page of repository.read(packingArtifact.artifactId)) pages.push(page)
  expect(pages.map((page) => [page.startFrame, page.frameCount])).toEqual([[0, 16_384], [16_384, 2]])
  const tail = []
  for await (const page of repository.read(packingArtifact.artifactId, 16_385, 16_386)) {
    tail.push(...(page.planes[0] ?? []))
  }
  expect(tail).toEqual([16_385])
  const boundary = []
  for await (const page of repository.read(packingArtifact.artifactId, 16_383, 16_386)) {
    boundary.push(...(page.planes[0] ?? []))
  }
  expect(boundary).toEqual([16_383, 16_384, 16_385])
  const variedArtifact = {
    ...packingArtifact,
    artifactId: `${packingArtifact.artifactId}-varied`,
  }
  const variedWrite = await repository.begin(variedArtifact)
  for (const chunk of [1, 3, 7, 16_373, 1, 1]) {
    await variedWrite.append([Float32Array.from({ length: chunk }, (_, index) => index)])
  }
  await variedWrite.commit()
  const variedPages = []
  for await (const page of repository.read(variedArtifact.artifactId)) variedPages.push(page)
  expect(variedPages.map((page) => page.frameCount)).toEqual([16_384, 2])
  await repository.dispose?.()
})

test('namespaces session artifacts and cleanup by session ownership', async () => {
  const artifactId = `${artifact.artifactId}-session-${crypto.randomUUID()}`
  const left = createPreparedStretchArtifactRepository({
    sessionId: 'session-left',
    lockManager: preparedStretchTestLockManager,
  })
  const right = createPreparedStretchArtifactRepository({
    sessionId: 'session-right',
    lockManager: preparedStretchTestLockManager,
  })
  const sessionArtifact = { ...artifact, artifactId, persistable: false }
  const write = await left.begin(sessionArtifact)
  await write.append([Float32Array.of(1, 2, 3, 4, 5)])
  await write.commit()
  expect(await left.find(artifactId)).not.toBeNull()
  expect(await right.find(artifactId)).toBeNull()
  await left.cleanupSession('session-left')
  expect(await left.find(artifactId)).toBeNull()
  expect(await right.find(artifactId)).toBeNull()
  await left.dispose?.()
  await right.dispose?.()
})

test('disposal invalidates a writer before commit or append can publish', async () => {
  const repository = createPreparedStretchArtifactRepository({
    sessionId: `dispose-${crypto.randomUUID()}`,
    lockManager: preparedStretchTestLockManager,
  })
  const disposableArtifact = { ...artifact, artifactId: `${artifact.artifactId}-dispose-${crypto.randomUUID()}` }
  const write = await repository.begin(disposableArtifact)
  await write.append([Float32Array.of(1, 2)])
  const disposing = repository.dispose?.() ?? Promise.resolve()
  await expect(write.append([Float32Array.of(3, 4, 5)])).rejects.toThrow('no longer writable')
  await expect(write.commit()).rejects.toThrow('no longer writable')
  await disposing
  expect(await repository.find(disposableArtifact.artifactId).catch(() => null)).toBeNull()
})

test('disposal waits for commit cleanup and shares its completion promise', async () => {
  const delayed = createDelayedWriteReleaseLockManager()
  const sessionId = `dispose-delayed-${crypto.randomUUID()}`
  const repository = createPreparedStretchArtifactRepository({
    sessionId,
    lockManager: delayed.lockManager,
  })
  const observer = createPreparedStretchArtifactRepository({
    sessionId: `dispose-delayed-observer-${crypto.randomUUID()}`,
    lockManager: preparedStretchTestLockManager,
  })
  const disposableArtifact = { ...artifact, artifactId: `${artifact.artifactId}-dispose-delayed-${crypto.randomUUID()}` }
  const write = await repository.begin(disposableArtifact)
  await write.append([Float32Array.of(1, 2, 3, 4, 5)])
  const commit = write.commit()
  await delayed.releaseStarted
  let disposalSettled = false
  const disposal = repository.dispose?.() ?? Promise.resolve()
  disposal.then(() => { disposalSettled = true }, () => { disposalSettled = true })
  expect(repository.dispose?.()).toBe(disposal)
  await Promise.resolve()
  expect(disposalSettled).toBe(false)
  delayed.release()
  await expect(commit).resolves.toMatchObject({ artifactId: disposableArtifact.artifactId })
  await disposal
  expect(await observer.find(disposableArtifact.artifactId)).not.toBeNull()
  await observer.dispose?.()
})

test('continues cleanup when lock release throws after durable publication', async () => {
  const delayed = createDelayedWriteReleaseLockManager(true)
  const sessionId = `dispose-release-error-${crypto.randomUUID()}`
  const repository = createPreparedStretchArtifactRepository({
    sessionId,
    lockManager: delayed.lockManager,
  })
  const observer = createPreparedStretchArtifactRepository({
    sessionId: `dispose-release-error-observer-${crypto.randomUUID()}`,
    lockManager: preparedStretchTestLockManager,
  })
  const disposableArtifact = { ...artifact, artifactId: `${artifact.artifactId}-dispose-release-error-${crypto.randomUUID()}` }
  const write = await repository.begin(disposableArtifact)
  await write.append([Float32Array.of(1, 2, 3, 4, 5)])
  const commit = write.commit()
  await delayed.releaseStarted
  delayed.release()
  await expect(commit).rejects.toThrow('lock release failed')
  await repository.dispose?.()
  expect(await observer.find(disposableArtifact.artifactId)).not.toBeNull()
  expect(await countOwnedRows(sessionId)).toEqual({ writes: 0, pages: 0 })
  await observer.dispose?.()
})

test('rejects a publication intercepted before transaction completion', async () => {
  await deletePreparedStretchDatabase()
  const sessionId = `dispose-publication-${crypto.randomUUID()}`
  const repository = createPreparedStretchArtifactRepository({
    sessionId,
    lockManager: preparedStretchTestLockManager,
  })
  const observer = createPreparedStretchArtifactRepository({
    sessionId: `dispose-observer-${crypto.randomUUID()}`,
    lockManager: preparedStretchTestLockManager,
  })
  const disposableArtifact = { ...artifact, artifactId: `${artifact.artifactId}-dispose-publication-${crypto.randomUUID()}` }
  const write = await repository.begin(disposableArtifact)
  await write.append([Float32Array.of(1, 2, 3, 4, 5)])

  const originalPut = IDBObjectStore.prototype.put
  let intercepted = false
  let disposing: Promise<void> | undefined
  let barrierResolve: () => void = () => undefined
  const manifestPutBarrier = new Promise<void>((resolve) => { barrierResolve = resolve })
  IDBObjectStore.prototype.put = function (value, key) {
    const request = originalPut.call(this, value, key)
    if (this.name === 'manifests' && !intercepted) {
      intercepted = true
      queueMicrotask(() => {
        disposing = repository.dispose?.() ?? Promise.resolve()
        barrierResolve()
      })
    }
    return request
  }
  try {
    const commit = write.commit()
    await manifestPutBarrier
    await expect(commit).rejects.toThrow()
    await disposing
    expect(await observer.find(disposableArtifact.artifactId)).toBeNull()
    expect(await countOwnedRows(sessionId)).toEqual({ writes: 0, pages: 0 })
  } finally {
    IDBObjectStore.prototype.put = originalPut
    await disposing?.catch(() => {})
    await repository.dispose?.()
    await observer.dispose?.()
    await deletePreparedStretchDatabase()
  }
})

test('aborts pending publication without removing a concurrent same-artifact winner', async () => {
  await deletePreparedStretchDatabase()
  const artifactId = `${artifact.artifactId}-dispose-publication-${crypto.randomUUID()}`
  const winner = createPreparedStretchArtifactRepository({
    sessionId: `winner-${crypto.randomUUID()}`,
    lockManager: preparedStretchTestLockManager,
  })
  const loserSessionId = `loser-${crypto.randomUUID()}`
  const loser = createPreparedStretchArtifactRepository({
    sessionId: loserSessionId,
    lockManager: preparedStretchTestLockManager,
  })
  const observer = createPreparedStretchArtifactRepository({
    sessionId: `observer-${crypto.randomUUID()}`,
    lockManager: preparedStretchTestLockManager,
  })
  const winnerWrite = await winner.begin({ ...artifact, artifactId })
  await winnerWrite.append([Float32Array.of(1, 2, 3, 4, 5)])
  const loserWrite = await loser.begin({ ...artifact, artifactId })
  await loserWrite.append([Float32Array.of(6, 7, 8, 9, 10)])

  const originalPut = IDBObjectStore.prototype.put
  let intercepted = false
  let winnerCommit: Promise<PreparedStretchArtifactManifest> | undefined
  let disposing: Promise<void> | undefined
  let barrierResolve: () => void = () => undefined
  const manifestPutBarrier = new Promise<void>((resolve) => { barrierResolve = resolve })
  IDBObjectStore.prototype.put = function (value, key) {
    const request = originalPut.call(this, value, key)
    if (this.name === 'manifests' && !intercepted) {
      intercepted = true
      queueMicrotask(() => {
        winnerCommit = winnerWrite.commit()
        disposing = loser.dispose?.() ?? Promise.resolve()
        barrierResolve()
      })
    }
    return request
  }
  try {
    const loserCommit = loserWrite.commit()
    await manifestPutBarrier
    await expect(loserCommit).rejects.toThrow()
    await disposing
    if (!winnerCommit) throw new Error('Expected the concurrent winner commit.')
    const winnerManifest = await winnerCommit
    expect((await observer.find(artifactId))?.writeId).toBe(winnerManifest.writeId)
    expect(await countOwnedRows(loserSessionId)).toEqual({ writes: 0, pages: 0 })
  } finally {
    IDBObjectStore.prototype.put = originalPut
    await disposing?.catch(() => {})
    await loser.dispose?.()
    await observer.dispose?.()
    await winner.dispose?.()
    await deletePreparedStretchDatabase()
  }
})

test.serial('fails closed without cross-realm Web Locks before creating artifact rows', async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const navigatorObject = globalThis.navigator
  const locksDescriptor = Object.getOwnPropertyDescriptor(navigatorObject, 'locks')
  Object.defineProperty(navigatorObject, 'locks', { value: undefined, configurable: true })
  try {
    const repository = createPreparedStretchArtifactRepository({
      sessionId: `no-locks-${crypto.randomUUID()}`,
    })
    await expect(repository.begin({ ...artifact, artifactId: `${artifact.artifactId}-no-locks-${crypto.randomUUID()}` }))
      .rejects.toThrow('Web Locks are required')
  } finally {
    if (locksDescriptor) Object.defineProperty(navigatorObject, 'locks', locksDescriptor)
    else Object.defineProperty(navigatorObject, 'locks', { value: undefined, configurable: true })
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  }
})

test.serial('continues eviction past the first 64 locked candidates', async () => {
  const blocked = new Set<string>()
  const lockManager: PreparedStretchArtifactLockManager = {
    request: <Value>(
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: { name: string } | null) => Promise<Value>,
    ) => {
      if (options.ifAvailable === true && blocked.has(name)) return callback(null)
      return preparedStretchTestLockManager.request(name, options, callback)
    },
  }
  const repository = createPreparedStretchArtifactRepository({
    sessionId: `eviction-${crypto.randomUUID()}`,
    lockManager,
  })
  const pageFrames = 16_384
  const artifacts = []
  for (let index = 0; index < 65; index += 1) {
    const candidate = {
      ...artifact,
      artifactId: `000-evict-${index.toString().padStart(3, '0')}-${crypto.randomUUID()}`,
      output: { ...artifact.output, frameCount: pageFrames },
    }
    const write = await repository.begin(candidate)
    await write.append([new Float32Array(pageFrames)])
    const manifest = await write.commit()
    artifacts.push({ candidate, manifest })
    if (index < 64) blocked.add(`daw-browser-prepared-stretch-write:${manifest.writeId}`)
  }

  const originalPut = IDBObjectStore.prototype.put
  let failures = 1
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === 'pages' && failures > 0) {
      failures -= 1
      throw new DOMException('Quota exceeded.', 'QuotaExceededError')
    }
    return originalPut.call(this, value, key)
  }
  try {
    const last = artifacts[64]
    if (!last) throw new Error('Expected the final eviction candidate.')
    const replacement = await repository.begin(last.candidate)
    await replacement.append([new Float32Array(pageFrames)])
    const replacementManifest = await replacement.commit()
    expect(replacementManifest.writeId).not.toBe(last.manifest.writeId)
    expect((await repository.find(last.candidate.artifactId))?.writeId).toBe(replacementManifest.writeId)
  } finally {
    IDBObjectStore.prototype.put = originalPut
    await repository.dispose?.()
  }
})
