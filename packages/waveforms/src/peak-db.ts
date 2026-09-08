import type { PeakAssetRecord, PeakLevelRecord, WaveformSourceIdentity } from './types'

const DB_NAME = 'audio-peaks-db'
const DB_VERSION = 2
const META_STORE = 'asset-meta'
const CHUNK_STORE = 'asset-chunks'

let dbPromise: Promise<IDBDatabase | null> | null = null

type RecordFields = {
  assetKey?: unknown
  durationSec?: unknown
  sampleRate?: unknown
  channelCount?: unknown
  sourceIdentity?: unknown
  identity?: unknown
  levels?: unknown
  peaksPerSecond?: unknown
  chunkDurationSec?: unknown
  chunkCount?: unknown
}

const isRecord = <Value>(value: Value): value is Value & RecordFields => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isString = <Value>(value: Value): value is Value & string => typeof value === 'string'
const isNumber = <Value>(value: Value): value is Value & number => typeof value === 'number'

const isWaveformSourceIdentity = <Value>(value: Value): value is Value & WaveformSourceIdentity => (
  isRecord(value)
  && isString(value.assetKey)
  && (value.identity === undefined || isString(value.identity))
  && (value.durationSec === undefined || isNumber(value.durationSec))
  && (value.sampleRate === undefined || isNumber(value.sampleRate))
  && (value.channelCount === undefined || isNumber(value.channelCount))
)

const isPeakLevelRecord = <Value>(value: Value): value is Value & PeakLevelRecord => (
  isRecord(value)
  && isNumber(value.peaksPerSecond)
  && isNumber(value.chunkDurationSec)
  && isNumber(value.chunkCount)
)

const isPeakAssetRecord = <Value>(value: Value): value is Value & PeakAssetRecord => (
  isRecord(value)
  && isString(value.assetKey)
  && isNumber(value.durationSec)
  && isNumber(value.sampleRate)
  && isNumber(value.channelCount)
  && (value.sourceIdentity === undefined || isWaveformSourceIdentity(value.sourceIdentity))
  && Array.isArray(value.levels)
  && value.levels.every(isPeakLevelRecord)
)

const parsePeakAssetRecord = <Value>(value: Value): PeakAssetRecord | null => (
  isPeakAssetRecord(value) ? value : null
)

const parsePeakChunkData = <Value>(value: Value): Uint8Array | null => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Uint8Array) return value
  return null
}

function canUseIndexedDb() {
  return 'indexedDB' in globalThis && Boolean(globalThis.indexedDB)
}

async function getDb() {
  if (!canUseIndexedDb()) return null
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = (event) => {
          const db = request.result
          const oldVersion = event.oldVersion
          if (request.transaction && oldVersion < 2) {
            if (db.objectStoreNames.contains(META_STORE)) db.deleteObjectStore(META_STORE)
            if (db.objectStoreNames.contains(CHUNK_STORE)) db.deleteObjectStore(CHUNK_STORE)
          }
          if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE)
          if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return await dbPromise
}

export async function loadPeakAssetRecord(assetKey: string): Promise<PeakAssetRecord | null> {
  const db = await getDb()
  if (!db) return null

  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(META_STORE, 'readonly')
      const request = tx.objectStore(META_STORE).get(assetKey)
      request.onsuccess = () => resolve(parsePeakAssetRecord(request.result))
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function storePeakAssetRecord(record: PeakAssetRecord): Promise<void> {
  const db = await getDb()
  if (!db) return

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(META_STORE, 'readwrite')
      tx.objectStore(META_STORE).put(record, record.assetKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function loadPeakChunk(chunkKey: string): Promise<Uint8Array | null> {
  const db = await getDb()
  if (!db) return null

  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(CHUNK_STORE, 'readonly')
      const request = tx.objectStore(CHUNK_STORE).get(chunkKey)
      request.onsuccess = () => {
        resolve(parsePeakChunkData(request.result))
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function storePeakChunk(chunkKey: string, data: Uint8Array): Promise<void> {
  const db = await getDb()
  if (!db) return

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CHUNK_STORE, 'readwrite')
      tx.objectStore(CHUNK_STORE).put(data.buffer.slice(0), chunkKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}