import { copyBufferWindow, renderStretchedAudio, writeBuffer, type AudioStretchRuntimeClip } from './audio-stretch-rendering'
import { evictStoredRenders, getStoredRenderByteSize, readStoredRender, selectStoredRenderEvictionKeys, touchStoredRender, writeStoredRender } from './audio-stretch-store'

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

type RuntimeClip = AudioStretchRuntimeClip
type CacheKeyClip = Omit<RuntimeClip, 'buffer'>

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

type AudioBufferIdentity = Pick<AudioBuffer, 'duration' | 'sampleRate' | 'numberOfChannels' | 'length' | 'getChannelData'>

const QUALITY_WARNING_MIN = 0.75
const QUALITY_WARNING_MAX = 1.33
const DEFAULT_PERSIST_MAX_BYTES = 256 * 1024 * 1024

const toError = (error: unknown) => error instanceof Error ? error : new Error(String(error))

const hashNumber = (hash: number, value: number) => {
  const scaled = Math.round(value * 1_000_000)
  return Math.imul(hash ^ scaled, 16_777_619) >>> 0
}

const createBufferFingerprint = (buffer: AudioBufferIdentity) => {
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

const createSourceCacheIdentity = (clip: CacheKeyClip, buffer: AudioBufferIdentity) => {
  if (clip.sourceAssetKey) {
    return [
      'asset',
      clip.sourceAssetKey,
      createBufferFingerprint(buffer),
      clip.sourceDurationSec ?? buffer.duration,
      clip.sourceSampleRate ?? buffer.sampleRate,
      clip.sourceChannelCount ?? buffer.numberOfChannels,
    ].join(':')
  }
  return [
    'buffer',
    createBufferFingerprint(buffer),
    buffer.sampleRate,
    buffer.numberOfChannels,
    buffer.length,
  ].join(':')
}

const createCacheKey = (clip: CacheKeyClip, buffer: AudioBufferIdentity, bpm: number) => [
  createSourceCacheIdentity(clip, buffer),
  bpm,
  clip.startSec,
  clip.duration,
  clip.leftPadSec ?? 0,
  clip.bufferOffsetSec ?? 0,
  clip.audioWarp?.enabled === true ? 1 : 0,
  clip.audioWarp?.sourceBpm ?? bpm,
  clip.audioWarp?.enabled === true ? clip.audioWarp.sourceBeatOffset ?? 0 : 0,
  JSON.stringify(clip.audioWarp?.enabled === true ? clip.audioWarp.markers ?? [] : []),
  clip.audioWarp?.mode ?? 'repitch',
].join('|')

export function isStretchQualityWarning(playbackRate: number) {
  return playbackRate < QUALITY_WARNING_MIN || playbackRate > QUALITY_WARNING_MAX
}

export const audioStretchCacheTestInternals = {
  createBufferFingerprint,
  createCacheKey,
  createSourceCacheIdentity,
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
      render: {
        buffer,
        timelineStartSec: stored.timelineStartSec,
        sourceStartSec: stored.sourceStartSec,
        timelineDurationSec: stored.timelineDurationSec,
      },
      persisted: true,
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
    return renderStretchedAudio(clip, projectBpm, options.createBuffer)
  }

  const startRender = (key: string, clip: RuntimeClip, projectBpm: number, waitForPersist = false) => {
    const operation = hydrate(key).then(async (stored) => {
      if (stored) return stored
      return { render: await render(clip, projectBpm), persisted: false }
    })
    const ready = operation.then(
      async (result) => {
        entries.set(key, { status: 'ready', render: result.render })
        const persisted = result.persisted ? Promise.resolve() : persistRender(key, result.render).catch(() => {})
        if (waitForPersist) await persisted
        else void persisted
        prune()
        notify()
        return result.render
      },
      (error) => {
        const renderedError = toError(error)
        entries.set(key, { status: 'failed', error: renderedError })
        prune()
        notify()
        throw renderedError
      },
    )
    entries.set(key, { status: 'rendering', promise: ready })
    notify()
    prune()
    return ready
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
    if (cached?.status === 'failed') return
    void startRender(key, clip, projectBpm)
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
    try {
      return await startRender(key, clip, projectBpm, true)
    } catch (error) {
      throw toError(error)
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
