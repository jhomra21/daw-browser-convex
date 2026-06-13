import { getAudioClipTimeMap } from './audio-scheduling'
import { stretchAudioWsola } from './audio-stretching'
import type { Clip } from '@daw-browser/timeline-core/types'

export type AudioStretchRenderStatus = 'idle' | 'rendering' | 'ready' | 'failed'

export type StretchedAudioRender = {
  buffer: AudioBuffer
  timelineStartSec: number
  sourceStartSec: number
  timelineDurationSec: number
}

export type AudioStretchRenderState = {
  status: AudioStretchRenderStatus
  error?: Error
}

type AudioStretchRenderStateListener = () => void

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

type RuntimeClip = Pick<Clip<AudioBuffer>, 'id' | 'duration' | 'startSec' | 'leftPadSec' | 'bufferOffsetSec' | 'sourceDurationSec' | 'audioWarp' | 'buffer'>

type StretchCacheEntry =
  | { status: 'rendering'; promise: Promise<StretchedAudioRender> }
  | { status: 'ready'; render: StretchedAudioRender }
  | { status: 'failed'; error: Error }

type AudioStretchCacheOptions = {
  createBuffer: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  maxEntries?: number
  persist?: boolean
  persistMaxBytes?: number
}

const ANALYSIS_MARGIN_SEC = 0.08
const QUALITY_WARNING_MIN = 0.75
const QUALITY_WARNING_MAX = 1.33
const DEFAULT_PERSIST_MAX_BYTES = 256 * 1024 * 1024
const DB_NAME = 'daw-browser-audio-stretch-cache'
const DB_VERSION = 1
const STORE_NAME = 'renders'

const toError = (error: unknown) => error instanceof Error ? error : new Error(String(error))

const hashNumber = (hash: number, value: number) => {
  const scaled = Math.round(value * 1_000_000)
  return Math.imul(hash ^ scaled, 16_777_619) >>> 0
}

const createBufferFingerprint = (buffer: AudioBuffer) => {
  let hash = hashNumber(2_166_136_261, buffer.duration)
  hash = hashNumber(hash, buffer.sampleRate)
  hash = hashNumber(hash, buffer.numberOfChannels)
  hash = hashNumber(hash, buffer.length)
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
    const channel = buffer.getChannelData(channelIndex)
    const step = Math.max(1, Math.floor(channel.length / 64))
    for (let frame = 0; frame < channel.length; frame += step) hash = hashNumber(hash, channel[frame] ?? 0)
    if (channel.length > 0) hash = hashNumber(hash, channel[channel.length - 1] ?? 0)
  }
  return hash.toString(36)
}

const createCacheKey = (clip: RuntimeClip, buffer: AudioBuffer, bpm: number) => [
  clip.id,
  createBufferFingerprint(buffer),
  buffer.sampleRate,
  buffer.numberOfChannels,
  buffer.length,
  bpm,
  clip.startSec,
  clip.duration,
  clip.leftPadSec ?? 0,
  clip.bufferOffsetSec ?? 0,
  clip.audioWarp?.enabled === true ? 1 : 0,
  clip.audioWarp?.sourceBpm ?? bpm,
  clip.audioWarp?.mode ?? 'repitch',
].join('|')

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

const getStoredRenderByteSize = (row: Pick<StoredStretchedAudioRender, 'channels'>) => (
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

const selectStoredRenderEvictionKeys = (
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

const readStoredRender = async (key: string): Promise<StoredStretchedAudioRender | null> => {
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

const touchStoredRender = async (row: StoredStretchedAudioRender) => {
  await writeStoredRender({ ...row, updatedAt: Date.now() })
}

const writeStoredRender = async (row: StoredStretchedAudioRender) => {
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

const evictStoredRenders = async (maxBytes: number) => {
  const rows = await readStoredRenderRows()
  await deleteStoredRenders(selectStoredRenderEvictionKeys(rows, maxBytes))
}

const copyBufferWindow = (buffer: AudioBuffer, startFrame: number, frameCount: number) => {
  const channels: Float32Array[] = []
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
    const channel = new Float32Array(frameCount)
    buffer.copyFromChannel(channel, channelIndex, startFrame)
    channels.push(channel)
  }
  return channels
}

const writeBuffer = (
  createBuffer: AudioStretchCacheOptions['createBuffer'],
  channels: Float32Array[],
  sampleRate: number,
) => {
  const frameCount = channels[0]?.length ?? 0
  const buffer = createBuffer(channels.length, frameCount, sampleRate)
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    const target = buffer.getChannelData(channelIndex)
    const source = channels[channelIndex]
    for (let frame = 0; frame < source.length; frame++) target[frame] = source[frame]
  }
  return buffer
}

export function isStretchQualityWarning(playbackRate: number) {
  return playbackRate < QUALITY_WARNING_MIN || playbackRate > QUALITY_WARNING_MAX
}

export const audioStretchCacheTestInternals = {
  getStoredRenderByteSize,
  selectStoredRenderEvictionKeys,
}

export function createAudioStretchCache(options: AudioStretchCacheOptions) {
  const entries = new Map<string, StretchCacheEntry>()
  const maxEntries = Math.max(1, options.maxEntries ?? 16)
  const persistMaxBytes = Math.max(0, options.persistMaxBytes ?? DEFAULT_PERSIST_MAX_BYTES)
  const listeners = new Set<AudioStretchRenderStateListener>()
  const persist = options.persist === true

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const touch = (key: string, entry: StretchCacheEntry) => {
    entries.delete(key)
    entries.set(key, entry)
  }

  const prune = () => {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done) return
      entries.delete(oldest.value)
    }
  }

  const hydrate = async (key: string) => {
    if (!persist) return null
    const stored = await readStoredRender(key)
    if (!stored) return null
    void touchStoredRender(stored).catch(() => {})
    const buffer = writeBuffer(options.createBuffer, stored.channels, stored.sampleRate)
    return {
      buffer,
      timelineStartSec: stored.timelineStartSec,
      sourceStartSec: stored.sourceStartSec,
      timelineDurationSec: stored.timelineDurationSec,
    }
  }

  const persistRender = async (key: string, render: StretchedAudioRender) => {
    if (!persist) return
    const channels = copyBufferWindow(render.buffer, 0, render.buffer.length)
    const row = {
      key,
      channels,
      sampleRate: render.buffer.sampleRate,
      timelineStartSec: render.timelineStartSec,
      sourceStartSec: render.sourceStartSec,
      timelineDurationSec: render.timelineDurationSec,
      updatedAt: Date.now(),
      byteSize: getStoredRenderByteSize({ channels }),
    }
    try {
      await writeStoredRender(row)
    } catch {
      await evictStoredRenders(persistMaxBytes).catch(() => {})
      await writeStoredRender(row).catch(() => {})
      return
    }
    void evictStoredRenders(persistMaxBytes).catch(() => {})
  }

  const render = async (clip: RuntimeClip, projectBpm: number): Promise<StretchedAudioRender> => {
    const sourceBuffer = clip.buffer
    if (!sourceBuffer) throw new Error('Cannot render Stretch warp without an audio buffer.')
    const map = getAudioClipTimeMap({
      clip,
      bufferDurationSec: sourceBuffer.duration,
      projectBpm,
      rangeStartSec: clip.startSec,
      rangeEndSec: clip.startSec + clip.duration,
    })
    if (!map || map.mode !== 'stretch') throw new Error('Cannot render Stretch warp for a non-stretched clip.')

    const marginSec = Math.min(ANALYSIS_MARGIN_SEC, map.sourceStartSec)
    const renderSourceStartSec = Math.max(0, map.sourceStartSec - marginSec)
    const renderSourceEndSec = Math.min(sourceBuffer.duration, map.sourceEndSec + ANALYSIS_MARGIN_SEC)
    const startFrame = Math.floor(renderSourceStartSec * sourceBuffer.sampleRate)
    const sourceFrameCount = Math.max(1, Math.ceil((renderSourceEndSec - renderSourceStartSec) * sourceBuffer.sampleRate))
    const outputFrameCount = Math.max(1, Math.round((sourceFrameCount / map.playbackRate)))
    const stretched = stretchAudioWsola({
      channels: copyBufferWindow(sourceBuffer, startFrame, sourceFrameCount),
      sampleRate: sourceBuffer.sampleRate,
    }, {
      outputFrameCount,
    })
    const marginOutputFrames = Math.round((map.sourceStartSec - renderSourceStartSec) / map.playbackRate * sourceBuffer.sampleRate)
    const timelineFrames = Math.max(1, Math.round(map.timelineDurationSec * sourceBuffer.sampleRate))
    const trimmedChannels = stretched.channels.map((channel) => {
      const trimmed = new Float32Array(timelineFrames)
      trimmed.set(channel.subarray(marginOutputFrames, Math.min(channel.length, marginOutputFrames + timelineFrames)))
      return trimmed
    })
    return {
      buffer: writeBuffer(options.createBuffer, trimmedChannels, sourceBuffer.sampleRate),
      timelineStartSec: map.timelineStartSec,
      sourceStartSec: 0,
      timelineDurationSec: timelineFrames / sourceBuffer.sampleRate,
    }
  }

  const ensure = (clip: RuntimeClip, projectBpm: number) => {
    const sourceBuffer = clip.buffer
    if (!sourceBuffer || clip.audioWarp?.enabled !== true || clip.audioWarp.mode !== 'stretch') return
    const key = createCacheKey(clip, sourceBuffer, projectBpm)
    const cached = entries.get(key)
    if (cached?.status === 'rendering' || cached?.status === 'ready') {
      touch(key, cached)
      return
    }
    const promise = hydrate(key).then((stored) => stored ?? render(clip, projectBpm))
    entries.set(key, { status: 'rendering', promise })
    notify()
    prune()
    promise.then(
      (result) => {
        entries.set(key, { status: 'ready', render: result })
        void persistRender(key, result).catch(() => {})
        prune()
        notify()
      },
      (error) => {
        entries.set(key, { status: 'failed', error: toError(error) })
        prune()
        notify()
      },
    )
  }

  const getReady = (clip: RuntimeClip, projectBpm: number) => {
    const sourceBuffer = clip.buffer
    if (!sourceBuffer) return null
    const key = createCacheKey(clip, sourceBuffer, projectBpm)
    const cached = entries.get(key)
    if (cached) touch(key, cached)
    return cached?.status === 'ready' ? cached.render : null
  }

  const renderNow = async (clip: RuntimeClip, projectBpm: number) => {
    const sourceBuffer = clip.buffer
    if (!sourceBuffer) throw new Error('Cannot render Stretch warp without an audio buffer.')
    const key = createCacheKey(clip, sourceBuffer, projectBpm)
    const cached = entries.get(key)
    if (cached?.status === 'ready') {
      touch(key, cached)
      return cached.render
    }
    if (cached?.status === 'rendering') {
      touch(key, cached)
      return cached.promise
    }
    const promise = hydrate(key).then((stored) => stored ?? render(clip, projectBpm))
    entries.set(key, { status: 'rendering', promise })
    notify()
    prune()
    try {
      const result = await promise
      entries.set(key, { status: 'ready', render: result })
      await persistRender(key, result).catch(() => {})
      prune()
      notify()
      return result
    } catch (error) {
      const renderedError = toError(error)
      entries.set(key, { status: 'failed', error: renderedError })
      prune()
      notify()
      throw renderedError
    }
  }

  const getState = (clip: RuntimeClip, projectBpm: number): AudioStretchRenderState => {
    const sourceBuffer = clip.buffer
    if (!sourceBuffer || clip.audioWarp?.enabled !== true || clip.audioWarp.mode !== 'stretch') return { status: 'idle' }
    const key = createCacheKey(clip, sourceBuffer, projectBpm)
    const cached = entries.get(key)
    if (cached) touch(key, cached)
    if (!cached) return { status: 'idle' }
    if (cached.status === 'failed') return { status: 'failed', error: cached.error }
    return { status: cached.status }
  }

  return {
    ensure,
    getReady,
    renderNow,
    getState,
    subscribe: (listener: AudioStretchRenderStateListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
