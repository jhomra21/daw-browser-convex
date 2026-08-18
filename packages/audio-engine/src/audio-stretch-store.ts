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
  if (!('indexedDB' in globalThis) || !globalThis.indexedDB) return Promise.resolve<IDBDatabase | null>(null)
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
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

type StoredRenderFields = {
  key?: unknown
  channels?: unknown
  sampleRate?: unknown
  timelineStartSec?: unknown
  sourceStartSec?: unknown
  timelineDurationSec?: unknown
  updatedAt?: unknown
  byteSize?: unknown
}

const isStoredRenderFields = <Value>(value: Value): value is Value & StoredRenderFields => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isString = <Value>(value: Value): value is Value & string => typeof value === 'string'
const isNumber = <Value>(value: Value): value is Value & number => typeof value === 'number'

const normalizeStoredRender = <Value>(value: Value): StoredStretchedAudioRender | null => {
  if (!isStoredRenderFields(value) || !Array.isArray(value.channels)) return null
  const channels: Float32Array[] = []
  for (const channel of value.channels) {
    if (!(channel instanceof Float32Array)) return null
    channels.push(channel)
  }
  if (
    !isString(value.key)
    || !isNumber(value.sampleRate)
    || !isNumber(value.timelineStartSec)
    || !isNumber(value.sourceStartSec)
    || !isNumber(value.timelineDurationSec)
  ) return null
  const updatedAt = isNumber(value.updatedAt) ? value.updatedAt : 0
  const fallback = getStoredRenderByteSize({ channels })
  const byteSize = isNumber(value.byteSize) ? value.byteSize : fallback
  return {
    key: value.key,
    sampleRate: value.sampleRate,
    channels,
    timelineStartSec: value.timelineStartSec,
    sourceStartSec: value.sourceStartSec,
    timelineDurationSec: value.timelineDurationSec,
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
