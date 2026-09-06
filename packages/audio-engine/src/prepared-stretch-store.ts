import { nativeAudioHostMaximumMappedAssetPageFramesForChannels } from '@daw-browser/desktop-protocol/native-audio-host'
import {
  preparedStretchArtifactCanonicalJson,
  type PreparedStretchArtifact,
} from './prepared-stretch-artifact'

export type PreparedStretchArtifactManifest = {
  artifactId: string
  writeId: string
  descriptor: PreparedStretchArtifact
  pageFrames: number
  frameCount: number
  byteSize: number
  committedAt: number
  lastAccessedAt: number
}

export type PreparedStretchArtifactPage = {
  key: string
  artifactId: string
  writeId: string
  pageIndex: number
  startFrame: number
  frameCount: number
  sampleRate: number
  channelCount: number
  planes: Float32Array[]
  byteSize: number
  published: boolean
}

export type PreparedStretchArtifactFindOptions = {
  tier?: 'persistent' | 'session'
}

export type PreparedStretchArtifactLease = {
  artifactId: string
  writeId: string
  release: () => Promise<void>
}

export type PreparedStretchArtifactLockMode = 'shared' | 'exclusive'

export type PreparedStretchArtifactLockManager = {
  request: <Value>(
    name: string,
    options: {
      ifAvailable?: boolean
      mode?: PreparedStretchArtifactLockMode
    },
    callback: (lock: { name: string } | null) => Promise<Value>,
  ) => Promise<Value>
}

export type PreparedStretchArtifactRepository = {
  readonly persistent?: boolean
  find: (
    artifactId: string,
    options?: PreparedStretchArtifactFindOptions,
  ) => Promise<PreparedStretchArtifactManifest | null>
  acquireLease: (
    manifest: PreparedStretchArtifactManifest,
  ) => Promise<PreparedStretchArtifactLease>
  begin: (descriptor: PreparedStretchArtifact) => Promise<PreparedStretchArtifactWriteTransaction>
  read: (artifactId: string, startFrame?: number, endFrame?: number) => AsyncGenerator<PreparedStretchArtifactPage>
  cleanupSession: (sessionId: string) => Promise<void>
  dispose?: () => Promise<void>
}

export type PreparedStretchArtifactWriteTransaction = {
  append: (planes: Float32Array[], signal?: AbortSignal) => Promise<void>
  commit: () => Promise<PreparedStretchArtifactManifest>
  abort: () => Promise<void>
}

const DB_NAME = 'daw-browser-prepared-stretch-artifacts'
const DB_VERSION = 5
const DEFAULT_PAGE_FRAMES = 16_384
const MAX_SWEEP_BATCH = 64
const LEASE_MS = 30_000
const WRITE_TTL_MS = 60_000
const WRITE_LOCK_PREFIX = 'daw-browser-prepared-stretch-write:'
const ARTIFACT_LOCK_PREFIX = 'daw-browser-prepared-stretch-artifact:'
const SESSION_STORAGE_PREFIX = 'session:'
const PERSISTENT_STORAGE_PREFIX = 'persistent:'

type ArtifactTier = 'persistent' | 'session'
type WriteStatus = 'active' | 'deleting'
type WriteRow = {
  writeId: string
  artifactId: string
  sessionId: string
  tier: ArtifactTier
  descriptor: PreparedStretchArtifact
  acceptedFrames: number
  flushedFrames: number
  byteSize: number
  pageIndex: number
  status: WriteStatus
  createdAt: number
  lastActivityAt: number
  expiresAt: number
}
type LeaseRow = {
  key: string
  artifactId: string
  writeId: string
  leaseId: string
  expiresAt: number
}
type GarbageRow = {
  key: string
  artifactId: string
  writeId: string
  createdAt: number
}
type StoredManifest = Omit<PreparedStretchArtifactManifest, 'artifactId'> & {
  artifactId: string
  logicalArtifactId?: string
  sessionId?: string
  tier?: ArtifactTier
}
type ManifestCandidate = {
  key: string
  row: StoredManifest
  manifest: PreparedStretchArtifactManifest
}
type CursorBatch<Value> = {
  rows: Value[]
  nextKey?: IDBValidKey
  exhausted: boolean
}
type ReclaimGarbageBatchResult = {
  releasedBytes: number
  processed: number
  exhausted: boolean
}
type Writer = {
  db: IDBDatabase
  writeId: string
  artifactId: string
  tier: ArtifactTier
  sessionId: string
  descriptor: PreparedStretchArtifact
  pageFrames: number
  open: boolean
  acceptedFrames: number
  flushedFrames: number
  pageIndex: number
  accumulator?: Float32Array[]
  tail: Promise<void>
  releaseLock: () => Promise<void>
  committed: boolean
  publicationTransaction?: IDBTransaction
  cleanup?: () => Promise<void>
}

const pageFramesFor = (channelCount: number) => Math.max(
  1,
  Math.min(DEFAULT_PAGE_FRAMES, nativeAudioHostMaximumMappedAssetPageFramesForChannels(channelCount)),
)
const bytesOf = (planes: readonly Float32Array[]) => planes.reduce((total, plane) => total + plane.byteLength, 0)
const pageKey = (writeId: string, index: number) => `${writeId}:${index}`
const garbageKey = (artifactId: string, writeId: string) => `${artifactId}:${writeId}`
const writeLockName = (writeId: string) => `${WRITE_LOCK_PREFIX}${writeId}`
const artifactLockName = (key: string) => `${ARTIFACT_LOCK_PREFIX}${key}`
const storageKeyFor = (tier: ArtifactTier, sessionId: string, artifactId: string) => (
  tier === 'session'
    ? `${SESSION_STORAGE_PREFIX}${sessionId}:${artifactId}`
    : `${PERSISTENT_STORAGE_PREFIX}${artifactId}`
)
const validFrame = (value: number) => Number.isSafeInteger(value) && value >= 0
type StorageError = Error | DOMException
const isQuota = (error: StorageError) => (
  error instanceof DOMException && error.name === 'QuotaExceededError'
) || (error instanceof Error && error.name === 'QuotaExceededError')

const validateRange = (startFrame: number | undefined, endFrame: number | undefined, frameCount: number) => {
  const start = startFrame ?? 0
  const end = endFrame ?? frameCount
  if (!validFrame(start) || !validFrame(end) || start > end || end > frameCount) {
    throw new Error('Prepared Stretch artifact read range is invalid.')
  }
  return { start, end }
}

const validatePlanes = (planes: Float32Array[], channelCount: number) => {
  const frameCount = planes[0]?.length ?? 0
  if (planes.length !== channelCount
    || frameCount <= 0
    || !Number.isSafeInteger(frameCount)
    || planes.some((plane) => !(plane instanceof Float32Array) || plane.length !== frameCount)) {
    throw new Error('Prepared Stretch artifact PCM page is invalid.')
  }
  return frameCount
}

const transaction = <Value>(
  db: IDBDatabase,
  names: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<Value>,
) => new Promise<Value>((resolve, reject) => {
  let result: { value: Value } | undefined
  let runError: Error | undefined
  let settled = false
  let tx: IDBTransaction
  try {
    tx = db.transaction(names, mode)
  } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)))
    return
  }
  void run(tx).then((value) => { result = { value } }).catch((error) => {
    runError = error instanceof Error ? error : new Error(String(error))
    tx.abort()
  })
  tx.oncomplete = () => {
    if (settled) return
    settled = true
    if (result) resolve(result.value)
    else reject(new Error('Prepared Stretch artifact transaction completed without a result.'))
  }
  tx.onerror = () => {
    if (settled) return
    settled = true
    reject(runError ?? tx.error ?? new Error('Prepared Stretch artifact transaction failed.'))
  }
  tx.onabort = () => {
    if (settled) return
    settled = true
    reject(runError ?? tx.error ?? new Error('Prepared Stretch artifact transaction aborted.'))
  }
})

const request = <Value>(value: IDBRequest<Value>) => new Promise<Value>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result)
  value.onerror = () => reject(value.error ?? new Error('Prepared Stretch artifact request failed.'))
})

const openDb = (): Promise<IDBDatabase> => {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('IndexedDB is required for prepared Stretch artifact storage.'))
  }
  return new Promise((resolve, reject) => {
    const openRequest = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result
      if (!db.objectStoreNames.contains('manifests')) db.createObjectStore('manifests', { keyPath: 'artifactId' })
      if (!db.objectStoreNames.contains('writes')) db.createObjectStore('writes', { keyPath: 'writeId' })
      if (!db.objectStoreNames.contains('pages')) {
        const pages = db.createObjectStore('pages', { keyPath: 'key' })
        pages.createIndex('byWrite', 'writeId')
        pages.createIndex('byWriteStart', ['writeId', 'startFrame'])
      } else {
        const pages = openRequest.transaction?.objectStore('pages')
        if (pages && !pages.indexNames.contains('byWrite')) pages.createIndex('byWrite', 'writeId')
        if (pages && !pages.indexNames.contains('byWriteStart')) pages.createIndex('byWriteStart', ['writeId', 'startFrame'])
      }
      if (!db.objectStoreNames.contains('leases')) {
        const leases = db.createObjectStore('leases', { keyPath: 'key' })
        leases.createIndex('byArtifact', 'artifactId')
        leases.createIndex('byWrite', 'writeId')
      } else {
        const leases = openRequest.transaction?.objectStore('leases')
        if (leases && !leases.indexNames.contains('byArtifact')) leases.createIndex('byArtifact', 'artifactId')
        if (leases && !leases.indexNames.contains('byWrite')) leases.createIndex('byWrite', 'writeId')
      }
      if (!db.objectStoreNames.contains('garbage')) db.createObjectStore('garbage', { keyPath: 'key' })
    }
    openRequest.onsuccess = () => {
      if (settled) {
        openRequest.result.close()
        return
      }
      settled = true
      resolve(openRequest.result)
    }
    openRequest.onerror = () => fail(openRequest.error ?? new Error('Failed to open prepared Stretch artifact database.'))
    openRequest.onblocked = () => fail(new Error('Prepared Stretch artifact database upgrade is blocked by an open connection.'))
  })
}

const deletePages = (tx: IDBTransaction, writeId: string, limit: number): Promise<{ bytes: number; exhausted: boolean }> => new Promise((resolve, reject) => {
  const cursorRequest = tx.objectStore('pages').index('byWrite').openCursor(IDBKeyRange.only(writeId))
  let count = 0
  let bytes = 0
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (!cursor) {
      resolve({ bytes, exhausted: true })
      return
    }
    if (count >= limit) {
      resolve({ bytes, exhausted: false })
      return
    }
    const page: PreparedStretchArtifactPage = cursor.value
    bytes += page.byteSize
    cursor.delete()
    count += 1
    cursor.continue()
  }
  cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Prepared Stretch page cursor failed.'))
})

const queueGarbage = (tx: IDBTransaction, row: Pick<WriteRow, 'artifactId' | 'writeId'>, createdAt: number) => {
  tx.objectStore('garbage').put({
    key: garbageKey(row.artifactId, row.writeId),
    artifactId: row.artifactId,
    writeId: row.writeId,
    createdAt,
  } satisfies GarbageRow)
}

const reclaimGarbageBatch = async (
  db: IDBDatabase,
  limit: number,
  lockManager: PreparedStretchArtifactLockManager,
  ownedWriteIds: ReadonlySet<string> = new Set(),
): Promise<ReclaimGarbageBatchResult> => {
  const rows = await transaction<GarbageRow[]>(db, ['garbage'], 'readonly', async (tx) => {
    const result: GarbageRow[] = []
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = tx.objectStore('garbage').openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor || result.length >= limit) {
          resolve()
          return
        }
        result.push(cursor.value)
        cursor.continue()
      }
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Prepared Stretch garbage lookup failed.'))
    })
    return result
  })
  let released = 0
  let processed = 0
  let incomplete = false
  for (const row of rows) {
    const reclaim = () => transaction(db, ['garbage', 'pages', 'writes'], 'readwrite', async (tx) => {
      const current = await request<GarbageRow | undefined>(tx.objectStore('garbage').get(row.key))
      if (!current || current.writeId !== row.writeId) {
        return { releasedBytes: 0, complete: true, processed: false }
      }
      const deleted = await deletePages(tx, current.writeId, limit)
      if (deleted.exhausted) {
        tx.objectStore('garbage').delete(current.key)
        tx.objectStore('writes').delete(current.writeId)
      }
      return {
        releasedBytes: deleted.bytes,
        complete: deleted.exhausted,
        processed: true,
      }
    })
    const result = ownedWriteIds.has(row.writeId)
      ? await reclaim()
      : await lockManager.request(
        writeLockName(row.writeId),
        { ifAvailable: true, mode: 'exclusive' },
        async (lock) => lock ? reclaim() : { releasedBytes: 0, complete: false, processed: false },
      )
    released += result.releasedBytes
    if (result.processed) processed += 1
    if (result.processed && !result.complete) incomplete = true
  }
  const remaining = await scanBatch<GarbageRow>(db, 'garbage', 1)
  return {
    releasedBytes: released,
    processed,
    exhausted: remaining.rows.length === 0 && remaining.exhausted && !incomplete,
  }
}

const sweepLeases = async (
  db: IDBDatabase,
  now: number,
  lockManager: PreparedStretchArtifactLockManager,
) => {
  const expired = await transaction<LeaseRow[]>(db, ['leases'], 'readonly', async (tx) => {
    const rows: LeaseRow[] = []
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = tx.objectStore('leases').openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor || rows.length >= MAX_SWEEP_BATCH) {
          resolve()
          return
        }
        const lease: LeaseRow = cursor.value
        if (lease.expiresAt <= now) rows.push(lease)
        cursor.continue()
      }
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Prepared Stretch lease sweep failed.'))
    })
    return rows
  })
  for (const lease of expired) {
    await lockManager.request(
      writeLockName(lease.writeId),
      { ifAvailable: true, mode: 'exclusive' },
      async (lock) => {
        if (!lock) return
        await transaction(db, ['leases'], 'readwrite', async (tx) => {
          const current = await request<LeaseRow | undefined>(tx.objectStore('leases').get(lease.key))
          if (current && current.writeId === lease.writeId && current.expiresAt <= now) {
            tx.objectStore('leases').delete(lease.key)
          }
          return undefined
        })
      },
    )
  }
}

const hasActiveLease = async (tx: IDBTransaction, writeId: string, now: number) => {
  const index = tx.objectStore('leases').index('byWrite')
  return new Promise<boolean>((resolve, reject) => {
    const cursorRequest = index.openCursor(IDBKeyRange.only(writeId))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve(false)
        return
      }
      const lease: LeaseRow = cursor.value
      if (lease.expiresAt <= now) {
        cursor.delete()
        cursor.continue()
        return
      }
      resolve(true)
    }
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Prepared Stretch lease lookup failed.'))
  })
}

const scanBatch = <Value>(
  db: IDBDatabase,
  storeName: string,
  limit: number,
  after?: IDBValidKey,
  filter?: (value: Value) => boolean,
): Promise<CursorBatch<Value>> => transaction(db, [storeName], 'readonly', async (tx) => new Promise((resolve, reject) => {
  const store = tx.objectStore(storeName)
  const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)
  const cursorRequest = store.openCursor(range)
  const rows: Value[] = []
  let lastKey: IDBValidKey | undefined
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (!cursor) {
      resolve({ rows, exhausted: true })
      return
    }
    if (rows.length >= limit) {
      resolve({ rows, nextKey: lastKey, exhausted: false })
      return
    }
    const value: Value = cursor.value
    if (!filter || filter(value)) rows.push(value)
    lastKey = cursor.key
    cursor.continue()
  }
  cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error(`Prepared Stretch ${storeName} scan failed.`))
}))

const claimWrite = async (
  db: IDBDatabase,
  row: WriteRow,
  now: number,
  lockManager: PreparedStretchArtifactLockManager,
  predicate: (current: WriteRow) => boolean,
) => lockManager.request(writeLockName(row.writeId), { ifAvailable: true, mode: 'exclusive' }, async (lock) => {
  if (!lock) return false
  return transaction(db, ['writes', 'garbage'], 'readwrite', async (tx) => {
    const current = await request<WriteRow | undefined>(tx.objectStore('writes').get(row.writeId))
    if (!current || !predicate(current)) return false
    tx.objectStore('writes').put({ ...current, status: 'deleting', lastActivityAt: now })
    queueGarbage(tx, current, now)
    return true
  })
})

const sweepExpiredWrites = async (
  db: IDBDatabase,
  now: number,
  lockManager: PreparedStretchArtifactLockManager,
) => {
  let after: IDBValidKey | undefined
  let exhausted = false
  while (!exhausted) {
    const batch = await scanBatch<WriteRow>(
      db,
      'writes',
      MAX_SWEEP_BATCH,
      after,
      (row) => row.status !== 'active' || row.expiresAt <= now,
    )
    exhausted = batch.exhausted
    after = batch.nextKey
    for (const row of batch.rows) {
      await claimWrite(db, row, now, lockManager, (current) => (
        current.status !== 'active' || current.expiresAt <= now
      ))
    }
  }
}

const claimManifest = async (
  db: IDBDatabase,
  candidate: ManifestCandidate,
  now: number,
  lockManager: PreparedStretchArtifactLockManager,
  predicate: (current: StoredManifest) => boolean,
) => lockManager.request(artifactLockName(candidate.key), { ifAvailable: true, mode: 'exclusive' }, async (artifactLock) => {
  if (!artifactLock) return false
  return lockManager.request(writeLockName(candidate.manifest.writeId), { ifAvailable: true, mode: 'exclusive' }, async (lock) => {
    if (!lock) return false
    return transaction(db, ['manifests', 'leases', 'garbage'], 'readwrite', async (tx) => {
      const manifests = tx.objectStore('manifests')
      const current = await request<StoredManifest | undefined>(manifests.get(candidate.key))
      if (!current || current.writeId !== candidate.manifest.writeId || !predicate(current)) return false
      if (await hasActiveLease(tx, current.writeId, now)) return false
      manifests.delete(candidate.key)
      queueGarbage(tx, current, now)
      return true
    })
  })
})

const evictForQuota = async (
  db: IDBDatabase,
  requiredBytes: number,
  now: number,
  lockManager: PreparedStretchArtifactLockManager,
) => {
  let released = 0
  await sweepExpiredWrites(db, now, lockManager)
  await sweepLeases(db, now, lockManager)
  let after: IDBValidKey | undefined
  let exhausted = false
  while (!exhausted && released < requiredBytes) {
    const batch = await scanBatch<StoredManifest>(db, 'manifests', MAX_SWEEP_BATCH, after)
    exhausted = batch.exhausted
    after = batch.nextKey
    for (const row of batch.rows) {
      if (released >= requiredBytes) break
      const logicalArtifactId = row.logicalArtifactId ?? row.artifactId
      const candidate: ManifestCandidate = {
        key: row.artifactId,
        row,
        manifest: { ...row, artifactId: logicalArtifactId },
      }
      const claimed = await claimManifest(db, candidate, now, lockManager, () => true)
      if (!claimed) continue
      while (released < requiredBytes) {
        const batch = await reclaimGarbageBatch(db, MAX_SWEEP_BATCH, lockManager)
        released += batch.releasedBytes
        if (batch.exhausted || batch.processed === 0) break
      }
    }
  }
  return released
}

const defaultLockManager = (): PreparedStretchArtifactLockManager => {
  const locks = globalThis.navigator?.locks
  if (!locks) throw new Error('Web Locks are required for prepared Stretch artifact storage.')
  return { request: (name, options, callback) => locks.request(name, options, callback) }
}

const holdLock = async (
  lockManager: PreparedStretchArtifactLockManager,
  name: string,
  mode: PreparedStretchArtifactLockMode = 'exclusive',
) => {
  let readyResolve: () => void = () => undefined
  let readyReject: (error: Error) => void = () => undefined
  let releaseResolve: () => void = () => undefined
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const released = new Promise<void>((resolve) => { releaseResolve = resolve })
  let releasedAlready = false
  const held = lockManager.request(name, { mode }, async (lock) => {
    if (!lock) throw new Error('Prepared Stretch artifact ownership was not acquired.')
    readyResolve()
    await released
    return undefined
  }).catch((error) => {
    readyReject(error instanceof Error ? error : new Error(String(error)))
    throw error
  })
  await ready
  return async () => {
    if (releasedAlready) return
    releasedAlready = true
    releaseResolve()
    await held
  }
}

const tryHoldExclusiveLock = async (
  lockManager: PreparedStretchArtifactLockManager,
  name: string,
) => {
  let readyResolve: () => void = () => undefined
  let readyReject: (error: Error) => void = () => undefined
  let releaseResolve: () => void = () => undefined
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const released = new Promise<void>((resolve) => { releaseResolve = resolve })
  let acquired = false
  let releasedAlready = false
  const held = lockManager.request(name, { ifAvailable: true, mode: 'exclusive' }, async (lock) => {
    if (!lock) {
      readyResolve()
      return undefined
    }
    acquired = true
    readyResolve()
    await released
    return undefined
  }).catch((error) => {
    readyReject(error instanceof Error ? error : new Error(String(error)))
    throw error
  })
  await ready
  await Promise.resolve()
  if (!acquired) {
    await held
    return undefined
  }
  return async () => {
    if (releasedAlready) return
    releasedAlready = true
    releaseResolve()
    await held
  }
}

const withHeldExclusiveWriteLocks = async <Value>(
  lockManager: PreparedStretchArtifactLockManager,
  writeIds: readonly string[],
  run: () => Promise<Value>,
) => {
  const releases: (() => Promise<void>)[] = []
  try {
    for (const writeId of writeIds) {
      const release = await tryHoldExclusiveLock(lockManager, writeLockName(writeId))
      if (!release) throw new Error('Prepared Stretch artifact generation is pinned by an active lease.')
      releases.push(release)
    }
    return await run()
  } finally {
    for (const release of releases.toReversed()) await release().catch(() => {})
  }
}

const manifestFromStored = (row: StoredManifest): PreparedStretchArtifactManifest => ({
  artifactId: row.logicalArtifactId ?? row.artifactId,
  writeId: row.writeId,
  descriptor: row.descriptor,
  pageFrames: row.pageFrames,
  frameCount: row.frameCount,
  byteSize: row.byteSize,
  committedAt: row.committedAt,
  lastAccessedAt: row.lastAccessedAt,
})

const storedManifest = (
  manifest: PreparedStretchArtifactManifest,
  key: string,
  tier: ArtifactTier,
  sessionId: string,
): StoredManifest => ({
  ...manifest,
  artifactId: key,
  logicalArtifactId: manifest.artifactId,
  tier,
  sessionId: tier === 'session' ? sessionId : undefined,
})

const sameManifestGeneration = (
  left: PreparedStretchArtifactManifest,
  right: PreparedStretchArtifactManifest,
) => left.artifactId === right.artifactId
  && left.writeId === right.writeId
  && preparedStretchArtifactCanonicalJson(left.descriptor) === preparedStretchArtifactCanonicalJson(right.descriptor)
  && left.pageFrames === right.pageFrames
  && left.frameCount === right.frameCount
  && left.byteSize === right.byteSize
  && left.committedAt === right.committedAt

const queueWriter = <Value>(writer: Writer, run: () => Promise<Value>) => {
  const next = writer.tail.then(run)
  writer.tail = next.then(() => undefined, () => undefined)
  return next
}

const createPersistentRepository = (input: {
  sessionId?: string
  now?: () => number
  lockManager?: PreparedStretchArtifactLockManager
  forceSession?: boolean
}): PreparedStretchArtifactRepository => {
  const sessionId = input.sessionId ?? `session:${crypto.randomUUID()}`
  const now = input.now ?? Date.now
  const suppliedLockManager = input.lockManager
  const getLockManager = () => suppliedLockManager ?? defaultLockManager()
  const writers = new Map<string, Writer>()
  let closed = false

  const ensureRepositoryOpen = () => {
    if (closed) throw new Error('Prepared Stretch artifact repository is disposed.')
  }
  const lookup = async (artifactId: string, tier: ArtifactTier): Promise<ManifestCandidate | null> => {
    const db = await openDb()
    try {
      const keys = tier === 'session'
        ? [storageKeyFor(tier, sessionId, artifactId)]
        : [storageKeyFor(tier, sessionId, artifactId), artifactId]
      return await transaction<ManifestCandidate | null>(db, ['manifests'], 'readonly', async (tx) => {
        for (const key of keys) {
          const row = await request<StoredManifest | undefined>(tx.objectStore('manifests').get(key))
          if (!row) continue
          const logicalArtifactId = row.logicalArtifactId ?? row.artifactId
          if (logicalArtifactId !== artifactId) continue
          return { key, row, manifest: manifestFromStored(row) }
        }
        return null
      })
    } finally {
      db.close()
    }
  }

  const touchCandidate = async (candidate: ManifestCandidate) => {
    const lockManager = getLockManager()
    const db = await openDb()
    try {
      return await lockManager.request(artifactLockName(candidate.key), { mode: 'exclusive' }, async (lock) => {
        if (!lock) return null
        return transaction<PreparedStretchArtifactManifest | null>(db, ['manifests'], 'readwrite', async (tx) => {
          const store = tx.objectStore('manifests')
          const current = await request<StoredManifest | undefined>(store.get(candidate.key))
          if (!current || current.writeId !== candidate.manifest.writeId) return null
          const touched = { ...current, lastAccessedAt: now() }
          store.put(touched)
          return manifestFromStored(touched)
        })
      })
    } finally {
      db.close()
    }
  }

  const findInTier = async (artifactId: string, tier: ArtifactTier) => {
    const db = await openDb()
    try {
      await sweepExpiredWrites(db, now(), getLockManager())
      await sweepLeases(db, now(), getLockManager())
    } finally {
      db.close()
    }
    const candidate = await lookup(artifactId, tier)
    return candidate ? touchCandidate(candidate) : null
  }

  const find = async (artifactId: string, options: PreparedStretchArtifactFindOptions = {}) => {
    ensureRepositoryOpen()
    if (options.tier !== 'persistent') {
      const session = await findInTier(artifactId, 'session')
      if (session) return session
    }
    if (options.tier !== 'session') return findInTier(artifactId, 'persistent')
    return null
  }

  const acquireLease = async (manifest: PreparedStretchArtifactManifest): Promise<PreparedStretchArtifactLease> => {
    ensureRepositoryOpen()
    const candidate = await (async () => {
      const tiers: readonly ArtifactTier[] = input.forceSession === true
        ? ['session']
        : ['session', 'persistent']
      for (const tier of tiers) {
        const found = await lookup(manifest.artifactId, tier)
        if (found && sameManifestGeneration(found.manifest, manifest)) return found
      }
      return null
    })()
    if (!candidate || !sameManifestGeneration(candidate.manifest, manifest)) {
      throw new Error(`Prepared Stretch artifact "${manifest.artifactId}" generation is stale or missing.`)
    }
    const lockManager = getLockManager()
    const leaseId = crypto.randomUUID()
    const leaseKey = `${manifest.writeId}:${leaseId}`
    const releaseLock = await holdLock(lockManager, writeLockName(manifest.writeId), 'shared')
    try {
      const db = await openDb()
      try {
        await transaction(db, ['manifests', 'leases'], 'readwrite', async (tx) => {
          const row = await request<StoredManifest | undefined>(
            tx.objectStore('manifests').get(candidate.key),
          )
          const current = row ? manifestFromStored(row) : undefined
          if (!current || !sameManifestGeneration(current, manifest)) {
            throw new Error(`Prepared Stretch artifact "${manifest.artifactId}" generation is stale or missing.`)
          }
          tx.objectStore('manifests').put({ ...row, lastAccessedAt: now() })
          tx.objectStore('leases').put({
            key: leaseKey,
            artifactId: current.artifactId,
            writeId: current.writeId,
            leaseId,
            expiresAt: now() + LEASE_MS,
          } satisfies LeaseRow)
          return undefined
        })
      } finally {
        db.close()
      }
    } catch (error) {
      await releaseLock().catch(() => {})
      throw error
    }
    let releasePromise: Promise<void> | undefined
    let leaseDeleted = false
    let lockReleased = false
    const releaseLockOnce = async () => {
      if (lockReleased) return
      lockReleased = true
      await releaseLock().catch(() => {})
    }
    const release = () => {
      if (leaseDeleted) return releaseLockOnce()
      if (releasePromise) return releasePromise
      releasePromise = (async () => {
        let db: IDBDatabase | undefined
        try {
          db = await openDb()
          await transaction(db, ['leases'], 'readwrite', async (tx) => {
            tx.objectStore('leases').delete(leaseKey)
            return undefined
          })
          leaseDeleted = true
        } catch {
          // The finite recovery deadline keeps a failed deletion reclaimable.
        } finally {
          db?.close()
          await releaseLockOnce()
        }
      })()
      const current = releasePromise
      void current.finally(() => {
        if (releasePromise === current) releasePromise = undefined
      })
      return current
    }
    return {
      artifactId: manifest.artifactId,
      writeId: manifest.writeId,
      release,
    }
  }

  const begin = async (descriptor: PreparedStretchArtifact) => {
    ensureRepositoryOpen()
    const lockManager = getLockManager()
    const tier: ArtifactTier = input.forceSession === true || descriptor.persistable !== true ? 'session' : 'persistent'
    const db = await openDb()
    const writeId = crypto.randomUUID()
    const releaseLock = await holdLock(lockManager, writeLockName(writeId))
    const pageFrames = pageFramesFor(descriptor.output.channelCount)
    const timestamp = now()
    const writer: Writer = {
      db,
      writeId,
      artifactId: descriptor.artifactId,
      tier,
      sessionId,
      descriptor,
      pageFrames,
      open: true,
      acceptedFrames: 0,
      flushedFrames: 0,
      pageIndex: 0,
      tail: Promise.resolve(),
      releaseLock,
      committed: false,
    }
    try {
      if (closed) throw new Error('Prepared Stretch artifact repository is disposed.')
      await transaction(db, ['writes'], 'readwrite', async (tx) => {
        tx.objectStore('writes').put({
          writeId,
          artifactId: descriptor.artifactId,
          sessionId,
          tier,
          descriptor,
          acceptedFrames: 0,
          flushedFrames: 0,
          byteSize: 0,
          pageIndex: 0,
          status: 'active',
          createdAt: timestamp,
          lastActivityAt: timestamp,
          expiresAt: timestamp + WRITE_TTL_MS,
        } satisfies WriteRow)
        return undefined
      })
      writers.set(writeId, writer)
    } catch (error) {
      await releaseLock().catch(() => {})
      db.close()
      throw error
    }

    const active = () => {
      if (closed || !writer.open) throw new Error('Prepared Stretch artifact transaction is no longer writable.')
    }
    let cleanupPromise: Promise<void> | undefined
    const cleanup = () => {
      if (cleanupPromise) return cleanupPromise
      cleanupPromise = (async () => {
        writer.open = false
        writer.accumulator = undefined
        await writer.tail.catch(() => {})
        if (!writer.committed) {
          await transaction(db, ['writes', 'garbage'], 'readwrite', async (tx) => {
            const current = await request<WriteRow | undefined>(tx.objectStore('writes').get(writeId))
            if (current) {
              tx.objectStore('writes').put({ ...current, status: 'deleting', lastActivityAt: now() })
              queueGarbage(tx, current, now())
            }
            return undefined
          }).catch(() => {})
          let progress: ReclaimGarbageBatchResult
          do {
            progress = await reclaimGarbageBatch(db, MAX_SWEEP_BATCH, lockManager, new Set([writeId])).catch(() => ({
              releasedBytes: 0,
              processed: 0,
              exhausted: true,
            }))
          } while (!progress.exhausted && progress.processed > 0)
        }
        writers.delete(writeId)
        await writer.releaseLock().catch(() => {})
        db.close()
      })()
      return cleanupPromise
    }
    writer.cleanup = cleanup
    const flush = async (planes: Float32Array[]) => {
      active()
      const frameCount = validatePlanes(planes, descriptor.output.channelCount)
      if (frameCount !== pageFrames && writer.flushedFrames + frameCount !== descriptor.output.frameCount) {
        throw new Error('Prepared Stretch artifact page is not a full page.')
      }
      const page: PreparedStretchArtifactPage = {
        key: pageKey(writeId, writer.pageIndex),
        artifactId: descriptor.artifactId,
        writeId,
        pageIndex: writer.pageIndex,
        startFrame: writer.flushedFrames,
        frameCount,
        sampleRate: descriptor.output.sampleRate,
        channelCount: descriptor.output.channelCount,
        planes: planes.map((plane) => new Float32Array(plane)),
        byteSize: bytesOf(planes),
        published: true,
      }
      const attempt = async () => transaction(db, ['writes', 'pages'], 'readwrite', async (tx) => {
        active()
        const writesStore = tx.objectStore('writes')
        const current = await request<WriteRow | undefined>(writesStore.get(writeId))
        if (!current || current.status !== 'active'
          || current.flushedFrames !== page.startFrame
          || current.flushedFrames + page.frameCount > current.acceptedFrames) {
          throw new Error('Prepared Stretch artifact write is no longer active or contiguous.')
        }
        writesStore.put({
          ...current,
          flushedFrames: current.flushedFrames + page.frameCount,
          byteSize: current.byteSize + page.byteSize,
          pageIndex: current.pageIndex + 1,
          lastActivityAt: now(),
          expiresAt: now() + WRITE_TTL_MS,
        })
        tx.objectStore('pages').put(page)
        return undefined
      })
      try {
        await attempt()
      } catch (error) {
        const storageError: StorageError = error instanceof Error || error instanceof DOMException
          ? error
          : new Error(String(error))
        if (!isQuota(storageError)) throw error
        await evictForQuota(db, page.byteSize, now(), lockManager)
        await attempt()
      }
      writer.flushedFrames += frameCount
      writer.pageIndex += 1
    }
    const appendImpl = async (planes: Float32Array[], signal?: AbortSignal) => {
      active()
      signal?.throwIfAborted()
      const inputFrameCount = validatePlanes(planes, descriptor.output.channelCount)
      if (writer.acceptedFrames + inputFrameCount > descriptor.output.frameCount) {
        throw new Error('Prepared Stretch artifact append exceeds the declared frame count.')
      }
      await transaction(db, ['writes'], 'readwrite', async (tx) => {
        active()
        const writesStore = tx.objectStore('writes')
        const current = await request<WriteRow | undefined>(writesStore.get(writeId))
        if (!current || current.status !== 'active' || current.acceptedFrames !== writer.acceptedFrames) {
          throw new Error('Prepared Stretch artifact write is no longer active.')
        }
        writesStore.put({
          ...current,
          acceptedFrames: current.acceptedFrames + inputFrameCount,
          lastActivityAt: now(),
          expiresAt: now() + WRITE_TTL_MS,
        })
        return undefined
      })
      writer.acceptedFrames += inputFrameCount
      let offset = 0
      while (offset < inputFrameCount) {
        signal?.throwIfAborted()
        const accumulated = writer.accumulator?.[0]?.length ?? 0
        const room = writer.pageFrames - accumulated
        const count = Math.min(room, inputFrameCount - offset)
        if (writer.accumulator) {
          writer.accumulator = writer.accumulator.map((plane, index) => {
            const merged = new Float32Array(plane.length + count)
            merged.set(plane)
            merged.set(planes[index]?.subarray(offset, offset + count) ?? new Float32Array(), plane.length)
            return merged
          })
        } else if (count === writer.pageFrames) {
          await flush(planes.map((plane) => plane.slice(offset, offset + count)))
        } else {
          writer.accumulator = planes.map((plane) => plane.slice(offset, offset + count))
        }
        offset += count
        if (writer.accumulator?.[0]?.length === writer.pageFrames) {
          const full = writer.accumulator
          writer.accumulator = undefined
          await flush(full)
        }
      }
    }
    const append = (planes: Float32Array[], signal?: AbortSignal) => {
      try {
        active()
        const inputFrameCount = validatePlanes(planes, descriptor.output.channelCount)
        if (writer.acceptedFrames + inputFrameCount > descriptor.output.frameCount) {
          throw new Error('Prepared Stretch artifact append exceeds the declared frame count.')
        }
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return queueWriter(writer, () => appendImpl(planes, signal)).catch(async (error) => {
        await cleanup()
        throw error
      })
    }
    const abort = async () => {
      if (!writer.open && !writers.has(writeId)) return
      writer.open = false
      await queueWriter(writer, async () => { writer.accumulator = undefined; return undefined }).catch(() => {})
      await cleanup()
    }
    const commit = async () => {
      active()
      try {
        return await queueWriter(writer, async () => {
          active()
          if (writer.accumulator) {
            const tail = writer.accumulator
            writer.accumulator = undefined
            await flush(tail)
          }
          active()
          if (writer.acceptedFrames !== descriptor.output.frameCount
            || writer.flushedFrames !== descriptor.output.frameCount) {
            throw new Error('Prepared Stretch artifact commit metadata or coverage is invalid.')
          }
          const key = storageKeyFor(tier, sessionId, descriptor.artifactId)
          const manifest = await lockManager.request(artifactLockName(key), { mode: 'exclusive' }, async (lock) => {
            if (!lock) throw new Error('Prepared Stretch artifact publication ownership was not acquired.')
            const existingWriteIds = await transaction<string[]>(db, ['manifests'], 'readonly', async (tx) => {
              const writeIds = new Set<string>()
              const existingKeys = tier === 'persistent' ? [key, descriptor.artifactId] : [key]
              for (const existingKey of existingKeys) {
                const existing = await request<StoredManifest | undefined>(tx.objectStore('manifests').get(existingKey))
                if (existing) writeIds.add(existing.writeId)
              }
              return [...writeIds]
            })
            return withHeldExclusiveWriteLocks(lockManager, existingWriteIds, async () => {
              try {
                return await transaction<PreparedStretchArtifactManifest>(db, ['manifests', 'writes', 'leases', 'garbage'], 'readwrite', async (tx) => {
                  writer.publicationTransaction = tx
                  active()
                  const writesStore = tx.objectStore('writes')
                  const current = await request<WriteRow | undefined>(writesStore.get(writeId))
                  if (!current || current.status !== 'active'
                    || current.acceptedFrames !== descriptor.output.frameCount
                    || current.flushedFrames !== descriptor.output.frameCount
                    || preparedStretchArtifactCanonicalJson(current.descriptor) !== preparedStretchArtifactCanonicalJson(descriptor)) {
                    throw new Error('Prepared Stretch artifact commit metadata or coverage is invalid.')
                  }
                  const manifests = tx.objectStore('manifests')
                  const existingKeys = tier === 'persistent' ? [key, descriptor.artifactId] : [key]
                  for (const existingKey of existingKeys) {
                    const existing = await request<StoredManifest | undefined>(manifests.get(existingKey))
                    if (!existing) continue
                    const existingManifest = manifestFromStored(existing)
                    if (preparedStretchArtifactCanonicalJson(existingManifest.descriptor) !== preparedStretchArtifactCanonicalJson(descriptor)) {
                      throw new Error('Prepared Stretch artifact identity collides with different metadata.')
                    }
                    if (await hasActiveLease(tx, existing.writeId, now())) {
                      throw new Error('Prepared Stretch artifact generation is pinned by an active lease.')
                    }
                    active()
                    writesStore.put({ ...current, status: 'deleting', lastActivityAt: now() })
                    queueGarbage(tx, current, now())
                    return existingManifest
                  }
                  const published: PreparedStretchArtifactManifest = {
                    artifactId: descriptor.artifactId,
                    writeId,
                    descriptor,
                    pageFrames,
                    frameCount: descriptor.output.frameCount,
                    byteSize: current.byteSize,
                    committedAt: now(),
                    lastAccessedAt: now(),
                  }
                  active()
                  manifests.put(storedManifest(published, key, tier, sessionId))
                  writesStore.delete(writeId)
                  return published
                })
              } finally {
                writer.publicationTransaction = undefined
              }
            })
          })
          writer.committed = true
          writer.open = false
          await reclaimGarbageBatch(db, MAX_SWEEP_BATCH, lockManager, new Set([writeId])).catch(() => {})
          await writer.releaseLock()
          db.close()
          writers.delete(writeId)
          return manifest
        })
      } catch (error) {
        await cleanup()
        throw error
      }
    }
    return { append, commit, abort }
  }

  const read = async function* (artifactId: string, startFrame?: number, endFrame?: number) {
    ensureRepositoryOpen()
    const lockManager = getLockManager()
    const tierCandidates: ArtifactTier[] = input.forceSession === true ? ['session'] : ['session', 'persistent']
    let candidate: ManifestCandidate | null = null
    for (const tier of tierCandidates) {
      candidate = await lookup(artifactId, tier)
      if (candidate) break
    }
    if (!candidate) return
    const release = await holdLock(lockManager, writeLockName(candidate.manifest.writeId), 'shared')
    let db: IDBDatabase | undefined
    const leaseId = crypto.randomUUID()
    const leaseKey = `${candidate.manifest.writeId}:${leaseId}`
    let manifest: PreparedStretchArtifactManifest | null = null
    try {
      db = await openDb()
      manifest = await transaction<PreparedStretchArtifactManifest | null>(db, ['manifests', 'leases'], 'readwrite', async (tx) => {
        const row = await request<StoredManifest | undefined>(tx.objectStore('manifests').get(candidate?.key ?? ''))
        if (!row || row.writeId !== candidate?.manifest.writeId) return null
        const result = manifestFromStored(row)
        validateRange(startFrame, endFrame, result.frameCount)
        tx.objectStore('manifests').put({ ...row, lastAccessedAt: now() })
        tx.objectStore('leases').put({
          key: leaseKey,
          artifactId: result.artifactId,
          writeId: result.writeId,
          leaseId,
          expiresAt: now() + LEASE_MS,
        } satisfies LeaseRow)
        return result
      })
      if (!manifest) return
      const range = validateRange(startFrame, endFrame, manifest.frameCount)
      let expected = range.start
      while (expected < range.end) {
        const alignedStart = Math.floor(expected / manifest.pageFrames) * manifest.pageFrames
        const page = await transaction<PreparedStretchArtifactPage | undefined>(db, ['pages'], 'readonly', async (tx) => {
          const cursorRequest = tx.objectStore('pages').index('byWriteStart').openCursor(
            IDBKeyRange.bound([manifest?.writeId ?? '', alignedStart], [manifest?.writeId ?? '', range.end - 1]),
          )
          return new Promise<PreparedStretchArtifactPage | undefined>((resolve, reject) => {
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result
              if (!cursor) {
                resolve(undefined)
                return
              }
              const value: PreparedStretchArtifactPage = cursor.value
              if (value.writeId !== manifest?.writeId || value.startFrame + value.frameCount <= expected) {
                cursor.continue()
                return
              }
              resolve(value)
            }
            cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Prepared Stretch page read failed.'))
          })
        })
        if (!page || !page.published || page.writeId !== manifest.writeId || page.startFrame > expected) {
          throw new Error('Prepared Stretch artifact pages do not cover the requested range.')
        }
        const pageEnd = page.startFrame + page.frameCount
        const localStart = Math.max(range.start, page.startFrame) - page.startFrame
        const localEnd = Math.min(range.end, pageEnd) - page.startFrame
        yield {
          ...page,
          startFrame: Math.max(range.start, page.startFrame),
          frameCount: localEnd - localStart,
          planes: page.planes.map((plane) => plane.slice(localStart, localEnd)),
        }
        expected = Math.min(range.end, pageEnd)
      }
      if (expected !== range.end) throw new Error('Prepared Stretch artifact pages do not cover the requested range.')
    } finally {
      if (db) {
        await transaction(db, ['leases'], 'readwrite', async (tx) => {
          tx.objectStore('leases').delete(leaseKey)
          return undefined
        }).catch(() => {})
        db.close()
      }
      await release().catch(() => {})
    }
  }

  const cleanupSession = async (targetSessionId: string, closeRepository = false) => {
    if (targetSessionId === sessionId && closeRepository) closed = true
    const lockManager = getLockManager()
    if (targetSessionId === sessionId) {
      for (const writer of writers.values()) writer.open = false
      for (const writer of writers.values()) {
        try {
          writer.publicationTransaction?.abort()
        } catch {
          // The transaction may have completed between tracking and disposal.
        }
      }
      await Promise.all([...writers.values()].map((writer) => writer.tail.catch(() => {})))
      await Promise.all([...writers.values()].map((writer) => writer.cleanup?.().catch(() => {})))
    }
    const db = await openDb()
    try {
      let after: IDBValidKey | undefined
      let exhausted = false
      while (!exhausted) {
        const batch: CursorBatch<WriteRow> = await scanBatch<WriteRow>(db, 'writes', MAX_SWEEP_BATCH, after, (row) => row.sessionId === targetSessionId)
        exhausted = batch.exhausted
        after = batch.nextKey
        for (const row of batch.rows) {
          await claimWrite(db, row, now(), lockManager, (current) => current.sessionId === targetSessionId)
        }
      }
      after = undefined
      exhausted = false
      while (!exhausted) {
        const batch: CursorBatch<StoredManifest> = await scanBatch<StoredManifest>(db, 'manifests', MAX_SWEEP_BATCH, after, (row) => (
          row.tier === 'session' && row.sessionId === targetSessionId
        ))
        exhausted = batch.exhausted
        after = batch.nextKey
        for (const row of batch.rows) {
          const candidate: ManifestCandidate = {
            key: row.artifactId,
            row,
            manifest: manifestFromStored(row),
          }
          await claimManifest(db, candidate, now(), lockManager, (current) => (
            current.tier === 'session' && current.sessionId === targetSessionId
          ))
        }
      }
      let progress: ReclaimGarbageBatchResult
      do {
        progress = await reclaimGarbageBatch(db, MAX_SWEEP_BATCH, lockManager)
      } while (!progress.exhausted && progress.processed > 0)
    } finally {
      db.close()
    }
    if (targetSessionId === sessionId) writers.clear()
  }

  let disposePromise: Promise<void> | undefined
  const dispose = () => {
    if (disposePromise) return disposePromise
    disposePromise = cleanupSession(sessionId, true)
    return disposePromise
  }

  return {
    persistent: input.forceSession !== true,
    find,
    acquireLease,
    begin,
    read,
    cleanupSession,
    dispose,
  }
}

export const createPreparedStretchArtifactRepository = (input: {
  sessionId?: string
  now?: () => number
  lockManager?: PreparedStretchArtifactLockManager
} = {}): PreparedStretchArtifactRepository => createPersistentRepository(input)

export const createPreparedStretchArtifactSessionRepository = (input: {
  sessionId?: string
  now?: () => number
  lockManager?: PreparedStretchArtifactLockManager
} = {}): PreparedStretchArtifactRepository => createPersistentRepository({ ...input, forceSession: true })