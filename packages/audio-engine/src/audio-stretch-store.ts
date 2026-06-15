type StoredStretchedAudioRender = {
  key: string
  sampleRate: number
  channels: Float32Array[]
  timelineStartSec: number
  sourceStartSec: number
  timelineDurationSec: number
  updatedAt: number
  byteSize: number
}

const DB_NAME = 'daw-browser-audio-stretch-cache'
const DB_VERSION = 1
const STORE_NAME = 'renders'

const openStretchCacheDb = () => {
  if (typeof indexedDB === 'undefined') return Promise.resolve<IDBDatabase | null>(null)
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open stretch cache database.'))
  })
}

export const getStoredRenderByteSize = (row: Pick<StoredStretchedAudioRender, 'channels'>) => (
  row.channels.reduce((total, channel) => total + channel.byteLength, 0)
)

const normalizeStoredRender = (value: unknown): StoredStretchedAudioRender | null => {
  if (!value || typeof value !== 'object' || !('key' in value)) return null
  const row = value
  if (!('channels' in row) || !Array.isArray(row.channels)) return null
  const channels: Float32Array[] = []
  for (const channel of row.channels) {
    if (!(channel instanceof Float32Array)) return null
    channels.push(channel)
  }
  if (
    typeof row.key !== 'string'
    || !('sampleRate' in row)
    || typeof row.sampleRate !== 'number'
    || !('timelineStartSec' in row)
    || typeof row.timelineStartSec !== 'number'
    || !('sourceStartSec' in row)
    || typeof row.sourceStartSec !== 'number'
    || !('timelineDurationSec' in row)
    || typeof row.timelineDurationSec !== 'number'
  ) return null
  const updatedAt = 'updatedAt' in row && typeof row.updatedAt === 'number' ? row.updatedAt : 0
  const fallback = getStoredRenderByteSize({ channels })
  const byteSize = 'byteSize' in row && typeof row.byteSize === 'number' ? row.byteSize : fallback
  return {
    key: row.key,
    sampleRate: row.sampleRate,
    channels,
    timelineStartSec: row.timelineStartSec,
    sourceStartSec: row.sourceStartSec,
    timelineDurationSec: row.timelineDurationSec,
    updatedAt,
    byteSize,
  }
}

export const selectStoredRenderEvictionKeys = (
  rows: Pick<StoredStretchedAudioRender, 'key' | 'updatedAt' | 'byteSize'>[],
  maxBytes: number,
) => {
  let totalBytes = rows.reduce((total, row) => total + Math.max(0, row.byteSize), 0)
  if (totalBytes <= maxBytes) return []
  const keys: string[] = []
  const oldestFirst = [...rows].sort((left, right) => left.updatedAt - right.updatedAt)
  for (const row of oldestFirst) {
    if (totalBytes <= maxBytes) break
    keys.push(row.key)
    totalBytes -= Math.max(0, row.byteSize)
  }
  return keys
}

export const readStoredRender = async (key: string): Promise<StoredStretchedAudioRender | null> => {
  const db = await openStretchCacheDb()
  if (!db) return null
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(key)
    request.onsuccess = () => {
      resolve(normalizeStoredRender(request.result))
    }
    request.onerror = () => reject(request.error ?? new Error('Failed to read stored Stretch render.'))
    tx.oncomplete = () => db.close()
    tx.onabort = () => db.close()
  })
}

export const writeStoredRender = async (row: StoredStretchedAudioRender) => {
  const db = await openStretchCacheDb()
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(row)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error ?? new Error('Failed to persist Stretch render.'))
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error ?? new Error('Failed to persist Stretch render.'))
    }
  })
}

export const touchStoredRender = async (row: StoredStretchedAudioRender) => {
  await writeStoredRender({ ...row, updatedAt: Date.now() })
}

const readStoredRenderRows = async () => {
  const db = await openStretchCacheDb()
  if (!db) return []
  return new Promise<StoredStretchedAudioRender[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).getAll()
    request.onsuccess = () => {
      const result: unknown = request.result
      if (!Array.isArray(result)) {
        resolve([])
        return
      }
      const rows: StoredStretchedAudioRender[] = []
      for (const value of result) {
        const row = normalizeStoredRender(value)
        if (row) rows.push(row)
      }
      resolve(rows)
    }
    request.onerror = () => reject(request.error ?? new Error('Failed to list stored Stretch renders.'))
    tx.oncomplete = () => db.close()
    tx.onabort = () => db.close()
  })
}

const deleteStoredRenders = async (keys: string[]) => {
  if (keys.length === 0) return
  const db = await openStretchCacheDb()
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const key of keys) store.delete(key)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error ?? new Error('Failed to evict stored Stretch renders.'))
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error ?? new Error('Failed to evict stored Stretch renders.'))
    }
  })
}

export const evictStoredRenders = async (maxBytes: number) => {
  const rows = await readStoredRenderRows()
  await deleteStoredRenders(selectStoredRenderEvictionKeys(rows, maxBytes))
}
