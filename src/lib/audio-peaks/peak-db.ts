import type { PeakAssetRecord } from '~/lib/audio-peaks/types'

const DB_NAME = 'audio-peaks-db'
const DB_VERSION = 1
const META_STORE = 'asset-meta'
const CHUNK_STORE = 'asset-chunks'

let dbPromise: Promise<IDBDatabase | null> | null = null

function canUseIndexedDb() {
  return typeof indexedDB !== 'undefined'
}

async function getDb() {
  if (!canUseIndexedDb()) return null
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
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
      request.onsuccess = () => resolve((request.result as PeakAssetRecord | undefined) ?? null)
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
        const value = request.result
        if (value instanceof ArrayBuffer) {
          resolve(new Uint8Array(value))
          return
        }
        resolve(value ? new Uint8Array(value as ArrayBufferLike) : null)
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