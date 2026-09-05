import {
  renderStretchedAudioFromSource,
  renderStretchedAudioToArtifact,
  writeBuffer,
  type AudioStretchRuntimeClip,
} from './audio-stretch-rendering'
import { createAudioPcmSourceDescriptor, getAudioBufferSessionIdentity, type AudioPcmSourceDescriptor } from './media-pages'
import {
  createAudioStretchReadPlan,
  DEFAULT_STRETCH_MATERIALIZATION_MAX_BYTES,
  type AudioStretchMaterializationPolicy,
} from './audio-stretch-read-plan'
import { evictStoredRenders, getStoredRenderByteSize, readStoredRender, selectStoredRenderEvictionKeys, touchStoredRender, writeStoredRender } from './audio-stretch-store'
import {
  createPreparedStretchArtifact,
  type PreparedStretchArtifactBinding,
} from './prepared-stretch-artifact'
import {
  createPreparedStretchArtifactRepository,
  type PreparedStretchArtifactManifest,
  type PreparedStretchArtifactRepository,
} from './prepared-stretch-store'

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

type SharedRenderOperation = {
  controller: AbortController
  promise: Promise<StretchedAudioRender>
  waiterCount: number
  keepAlive: boolean
  completed: boolean
}

type SharedSourceOperation = {
  controller: AbortController
  promise: Promise<AudioPcmSourceDescriptor>
  waiterCount: number
  keepAlive: boolean
  completed: boolean
}

type SharedArtifactOperation = {
  controller: AbortController
  promise: Promise<{ manifest: PreparedStretchArtifactManifest }>
  waiterCount: number
  completed: boolean
}

type AudioStretchCacheOptions = {
  createBuffer: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  resolveSource?: (clip: RuntimeClip, signal?: AbortSignal) => Promise<AudioPcmSourceDescriptor>
  materializationPolicy?: AudioStretchMaterializationPolicy
  maxEntries?: number
  maxActive?: number
  persist?: boolean
  persistMaxBytes?: number
  artifactRepository?: PreparedStretchArtifactRepository
}

type AudioBufferIdentity = Pick<AudioBuffer, 'duration' | 'sampleRate' | 'numberOfChannels' | 'length' | 'getChannelData'>

const QUALITY_WARNING_MIN = 0.75
const QUALITY_WARNING_MAX = 1.33
const DEFAULT_PERSIST_MAX_BYTES = 256 * 1024 * 1024

const toError = <Value>(error: Value) => error instanceof Error ? error : new Error(String(error))

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

const createMetadataCacheIdentity = (clip: CacheKeyClip, source: AudioPcmSourceDescriptor) => [
  'source',
  source.identity,
  source.durationSec,
  source.frameCount,
  source.sampleRate,
  source.channelCount,
  clip.sourceAssetKey ?? '',
].join(':')

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
  const sourceEntryKeys = new Map<string, string>()
  const resolvedSources = new Map<string, SharedSourceOperation>()
  const pendingSourceKeys = new Set<string>()
  const sourceRequestKey = (clip: RuntimeClip) => [
    clip.id,
    clip.sourceAssetKey ?? '',
    clip.sourceDurationSec ?? '',
    clip.sourceSampleRate ?? '',
    clip.sourceChannelCount ?? '',
    clip.sourceKind ?? '',
    clip.sampleUrl ?? '',
  ].join(':')
  const bufferlessClipKey = (clip: RuntimeClip, bpm: number) => [
    sourceRequestKey(clip),
    bpm,
    clip.startSec,
    clip.duration,
    clip.leftPadSec ?? 0,
    clip.bufferOffsetSec ?? 0,
    JSON.stringify(clip.audioWarp ?? null),
  ].join('|')
  const sourceResolverKey = (clip: RuntimeClip) => sourceRequestKey(clip)
  const maxEntries = Math.max(1, options.maxEntries ?? 16)
  const maxActive = options.maxActive ?? 2
  if (!Number.isSafeInteger(maxActive) || maxActive <= 0) {
    throw new Error('Stretch maxActive must be a positive safe integer.')
  }
  const persistMaxBytes = Math.max(0, options.persistMaxBytes ?? DEFAULT_PERSIST_MAX_BYTES)
  const listeners = new Set<AudioStretchRenderStateListener>()
  const persist = options.persist === true
  const artifactRepository = options.artifactRepository ?? createPreparedStretchArtifactRepository()
  const ownsArtifactRepository = options.artifactRepository === undefined
  let sourceResolver = options.resolveSource
  let lifecycleGeneration = 0
  const renderOperations = new Map<string, SharedRenderOperation>()
  const artifactOperations = new Map<string, SharedArtifactOperation>()
  const repositoryIdentities = new WeakMap<object, string>()
  const repositoryIdentity = (repository: PreparedStretchArtifactRepository) => {
    const existing = repositoryIdentities.get(repository)
    if (existing) return existing
    const identity = crypto.randomUUID()
    repositoryIdentities.set(repository, identity)
    return identity
  }
  let activeRenderCount = 0
  const queuedRenders: Array<{
    run: () => void
    reject: (error: Error) => void
    signal?: AbortSignal
    settled: boolean
  }> = []

  const runWithRenderSlot = <Value,>(
    run: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> => new Promise<Value>((resolve, reject) => {
    const cancellation = new DOMException('Stretch render was cancelled.', 'AbortError')
    let started = false
    let settled = false
    const resolveOnce = (value: Value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      resolve(value)
    }
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      reject(error)
    }
    const queued = {
      run: () => {
        if (queued.settled) return
        queued.settled = true
        started = true
        activeRenderCount += 1
        void Promise.resolve().then(() => {
          signal?.throwIfAborted()
          return run()
        }).then(resolveOnce, rejectOnce).finally(() => {
          activeRenderCount -= 1
          signal?.removeEventListener('abort', cancel)
          let next = queuedRenders.shift()
          while (next) {
            if (next.settled) {
              next = queuedRenders.shift()
              continue
            }
            if (next.signal?.aborted) {
              next.settled = true
              next.reject(cancellation)
              next = queuedRenders.shift()
              continue
            }
            break
          }
          next?.run()
        })
      },
      reject: (error: Error) => {
        if (started) {
          rejectOnce(error)
          return
        }
        if (queued.settled) return
        queued.settled = true
        rejectOnce(error)
      },
      signal,
      settled: false,
    }
    const cancel = () => queued.reject(cancellation)
    if (signal?.aborted) {
      queued.reject(cancellation)
      return
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (activeRenderCount < maxActive) queued.run()
    else queuedRenders.push(queued)
  })

  const notify = () => {
    for (const listener of listeners) listener()
  }
  const cancelQueuedRenders = () => {
    const error = new DOMException('Stretch render was cancelled.', 'AbortError')
    for (const queued of queuedRenders) queued.reject(error)
    queuedRenders.length = 0
  }

  const abortSourceResolutions = () => {
    for (const { controller } of resolvedSources.values()) controller.abort()
    resolvedSources.clear()
  }
  const abortArtifactOperations = () => {
    for (const { controller } of artifactOperations.values()) controller.abort()
    artifactOperations.clear()
  }

  const touch = (key: string, entry: StretchCacheEntry) => {
    entries.delete(key)
    entries.set(key, entry)
  }

  const prune = () => {
    const completedEntries = () => [...entries].filter(([, entry]) => entry.status !== 'rendering')
    while (completedEntries().length > maxEntries) {
      const oldest = completedEntries()[0]
      if (!oldest) return
      const [oldestKey] = oldest
      entries.delete(oldestKey)
      for (const [clipKey, entryKey] of sourceEntryKeys) {
        if (entryKey === oldestKey) sourceEntryKeys.delete(clipKey)
      }
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

  const persistRender = async (key: string, render: StretchedAudioRender, persistable: boolean) => {
    if (!persist || !persistable) return
    const channels = Array.from(
      { length: render.buffer.numberOfChannels },
      (_, channel) => new Float32Array(render.buffer.getChannelData(channel)),
    )
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

  const resolveSource = (clip: RuntimeClip, signal?: AbortSignal, keepAlive = false) => {
    if (!sourceResolver) throw new Error('Cannot render Stretch warp without a source resolver.')
    signal?.throwIfAborted()
    const resolver = sourceResolver
    const sourceKey = sourceResolverKey(clip)
    let existing = resolvedSources.get(sourceKey)
    if (existing?.controller.signal.aborted && !existing.completed) {
      if (resolvedSources.get(sourceKey) === existing) resolvedSources.delete(sourceKey)
      existing = undefined
    }
    if (existing) {
      if (keepAlive) existing.keepAlive = true
      return awaitSource(existing, signal)
    }
    const controller = new AbortController()
    const pending = runWithRenderSlot(
      () => resolver(clip, controller.signal),
      controller.signal,
    )
    const entry: SharedSourceOperation = {
      controller,
      promise: pending,
      waiterCount: 0,
      keepAlive,
      completed: false,
    }
    resolvedSources.set(sourceKey, entry)
    void pending.then(
      () => {
        entry.completed = true
        if (resolvedSources.get(sourceKey) === entry) resolvedSources.delete(sourceKey)
      },
      () => {
        entry.completed = true
        if (resolvedSources.get(sourceKey) === entry) resolvedSources.delete(sourceKey)
      },
    )
    void pending.catch(() => {
      if (resolvedSources.get(sourceKey) === entry) resolvedSources.delete(sourceKey)
    })
    return awaitSource(entry, signal)
  }

  const awaitSource = (
    operation: SharedSourceOperation,
    signal?: AbortSignal,
  ): Promise<AudioPcmSourceDescriptor> => {
    const cancellation = new DOMException('Stretch source resolution was cancelled.', 'AbortError')
    operation.waiterCount += 1
    return new Promise((resolve, reject) => {
      let settled = false
      const release = () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        operation.waiterCount -= 1
        if (operation.waiterCount === 0 && !operation.keepAlive && !operation.completed) operation.controller.abort()
      }
      const finish = (callback: () => void) => {
        release()
        callback()
      }
      const abort = () => finish(() => reject(cancellation))
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      operation.promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    })
  }

  const awaitPromise = <Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> => {
    if (!signal) return promise
    const cancellation = new DOMException('Stretch render was cancelled.', 'AbortError')
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        callback()
      }
      const abort = () => finish(() => reject(cancellation))
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    })
  }

  const awaitRender = (
    operation: SharedRenderOperation,
    signal?: AbortSignal,
  ): Promise<StretchedAudioRender> => {
    const cancellation = new DOMException('Stretch render was cancelled.', 'AbortError')
    operation.waiterCount += 1
    return new Promise((resolve, reject) => {
      let settled = false
      const release = () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        operation.waiterCount -= 1
        if (operation.waiterCount === 0 && !operation.keepAlive && !operation.completed) operation.controller.abort()
      }
      const finish = (callback: () => void) => {
        release()
        callback()
      }
      const abort = () => finish(() => reject(cancellation))
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      operation.promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    })
  }

  const render = async (
    clip: RuntimeClip,
    projectBpm: number,
    signal?: AbortSignal,
    resolvedSource?: AudioPcmSourceDescriptor,
  ): Promise<{ render: StretchedAudioRender; persistable: boolean }> => {
    const source = clip.buffer
      ? createAudioPcmSourceDescriptor({
        identity: getAudioBufferSessionIdentity(clip.buffer),
        persistable: false,
        durationSec: clip.buffer.duration,
        frameCount: clip.buffer.length,
        sampleRate: clip.buffer.sampleRate,
        channelCount: clip.buffer.numberOfChannels,
        source: clip.buffer,
      })
      : resolvedSource ?? await resolveSource(clip, signal)
    return {
      render: await renderStretchedAudioFromSource({
        clip,
        source,
        projectBpm,
        createBuffer: options.createBuffer,
        materializationPolicy: options.materializationPolicy ?? {
          maximumBytes: DEFAULT_STRETCH_MATERIALIZATION_MAX_BYTES,
          maximumChannels: 32,
        },
        signal,
      }),
      persistable: source.persistable === true,
    }
  }

  const startRender = (
    key: string,
    clip: RuntimeClip,
    projectBpm: number,
    keepAlive = false,
    waitForPersist = false,
    resolvedSource?: AudioPcmSourceDescriptor,
  ): SharedRenderOperation => {
    const existing = renderOperations.get(key)
    if (existing) {
      if (keepAlive) existing.keepAlive = true
      return existing
    }
    const controller = new AbortController()
    const generation = lifecycleGeneration
    const operation = runWithRenderSlot(() => hydrate(key).then(async (stored) => {
      if (stored) return { render: stored.render, persisted: true, persistable: true }
      const result = await render(clip, projectBpm, controller.signal, resolvedSource)
      return { ...result, persisted: false }
    }), controller.signal)
    const ready = operation.then(
      async (result) => {
        if (generation !== lifecycleGeneration) throw new DOMException('Stretch render was invalidated.', 'AbortError')
        entries.set(key, { status: 'ready', render: result.render })
        const persisted = result.persisted ? Promise.resolve() : persistRender(key, result.render, result.persistable).catch(() => {})
        if (waitForPersist) await persisted
        else void persisted
        prune()
        notify()
        return result.render
      },
      (error) => {
        const renderedError = toError(error)
        if (generation !== lifecycleGeneration) throw renderedError
        if (renderedError.name === 'AbortError') {
          entries.delete(key)
          notify()
          throw renderedError
        }
        entries.set(key, { status: 'failed', error: renderedError })
        prune()
        notify()
        throw renderedError
      },
    )
    const shared: SharedRenderOperation = {
      controller,
      promise: ready,
      waiterCount: 0,
      keepAlive,
      completed: false,
    }
    renderOperations.set(key, shared)
    void ready.then(
      () => { shared.completed = true },
      () => { shared.completed = true },
    )
    entries.set(key, { status: 'rendering', promise: ready })
    notify()
    prune()
    void ready.finally(() => {
      if (renderOperations.get(key) === shared) renderOperations.delete(key)
    }).catch(() => {})
    return shared
  }

  const getKeyAndSource = async (
    clip: RuntimeClip,
    projectBpm: number,
    signal?: AbortSignal,
    resolvedSource?: AudioPcmSourceDescriptor,
    keepAlive = false,
  ): Promise<{
    key: string
    source?: AudioPcmSourceDescriptor
  }> => {
    if (clip.buffer) return { key: createCacheKey(clip, clip.buffer, projectBpm) }
    if (!resolvedSource && !sourceResolver) throw new Error('Cannot identify Stretch source without a source resolver.')
    const source = resolvedSource ?? await resolveSource(clip, signal, keepAlive)
    const key = [
      createMetadataCacheIdentity(clip, source),
      projectBpm,
      clip.startSec,
      clip.duration,
      clip.leftPadSec ?? 0,
      clip.bufferOffsetSec ?? 0,
      clip.audioWarp?.enabled === true ? 1 : 0,
      clip.audioWarp?.sourceBpm ?? projectBpm,
      clip.audioWarp?.enabled === true ? clip.audioWarp.sourceBeatOffset ?? 0 : 0,
      JSON.stringify(clip.audioWarp?.enabled === true ? clip.audioWarp.markers ?? [] : []),
      clip.audioWarp?.mode ?? 'repitch',
    ].join('|')
    return { key, source }
  }

  const ensure = (clip: RuntimeClip, projectBpm: number) => {
    if (clip.audioWarp?.enabled !== true || clip.audioWarp.mode !== 'stretch') return
    if (!clip.buffer && !sourceResolver) return
    const generation = lifecycleGeneration
    const clipKey = bufferlessClipKey(clip, projectBpm)
    const existingEntryKey = sourceEntryKeys.get(clipKey)
    const existingEntry = existingEntryKey ? entries.get(existingEntryKey) : undefined
    if (existingEntryKey !== undefined && existingEntry?.status === 'rendering') {
      const operation = renderOperations.get(existingEntryKey)
      if (operation) operation.keepAlive = true
      touch(existingEntryKey, existingEntry)
      return
    }
    if (existingEntryKey !== undefined && existingEntry?.status === 'ready') {
      touch(existingEntryKey, existingEntry)
      return
    }
    void getKeyAndSource(clip, projectBpm, undefined, undefined, true).then((resolved) => {
      if (generation !== lifecycleGeneration) return
      const { key, source } = resolved
      sourceEntryKeys.set(clipKey, key)
      if (pendingSourceKeys.has(key)) return
      const cached = entries.get(key)
      if (cached?.status === 'rendering' || cached?.status === 'ready') {
        if (cached.status === 'rendering') {
          const operation = renderOperations.get(key)
          if (operation) operation.keepAlive = true
        }
        touch(key, cached)
        return
      }
      if (cached?.status === 'failed') return
      pendingSourceKeys.add(key)
      const operation = startRender(key, clip, projectBpm, true, false, source)
      void operation.promise.finally(() => pendingSourceKeys.delete(key)).catch(() => {})
    }).catch(() => {})
  }

  const getReady = (clip: RuntimeClip, projectBpm: number) => {
    const sourceBuffer = clip.buffer
    if (!sourceBuffer) {
      const clipKey = bufferlessClipKey(clip, projectBpm)
      const entryKey = sourceEntryKeys.get(clipKey)
      const entry = entryKey ? entries.get(entryKey) : undefined
      return entry?.status === 'ready' ? entry.render : null
    }
    const key = createCacheKey(clip, sourceBuffer, projectBpm)
    const cached = entries.get(key)
    if (cached) touch(key, cached)
    return cached?.status === 'ready' ? cached.render : null
  }

  const renderNow = async (
    clip: RuntimeClip,
    projectBpm: number,
    signal?: AbortSignal,
    resolvedSource?: AudioPcmSourceDescriptor,
  ) => {
    const generation = lifecycleGeneration
    const resolved = await getKeyAndSource(clip, projectBpm, signal, resolvedSource)
    if (generation !== lifecycleGeneration) throw new DOMException('Stretch render was invalidated.', 'AbortError')
    const { key, source } = resolved
    if (!clip.buffer) sourceEntryKeys.set(bufferlessClipKey(clip, projectBpm), key)
    const cached = entries.get(key)
    if (cached?.status === 'ready') {
      touch(key, cached)
      return awaitPromise(Promise.resolve(cached.render), signal)
    }
    if (cached?.status === 'rendering') {
      touch(key, cached)
      const operation = renderOperations.get(key)
      return operation
        ? awaitRender(operation, signal)
        : awaitPromise(cached.promise, signal)
    }
    const operation = startRender(key, clip, projectBpm, false, true, source)
    return awaitRender(operation, signal).catch((error) => { throw toError(error) })
  }

  const renderArtifactNow = async (
    clip: RuntimeClip,
    projectBpm: number,
    signal?: AbortSignal,
    resolvedSource?: AudioPcmSourceDescriptor,
  ) => {
    const source = clip.buffer
      ? createAudioPcmSourceDescriptor({
        identity: getAudioBufferSessionIdentity(clip.buffer),
        persistable: false,
        durationSec: clip.buffer.duration,
        frameCount: clip.buffer.length,
        sampleRate: clip.buffer.sampleRate,
        channelCount: clip.buffer.numberOfChannels,
        source: clip.buffer,
      })
      : resolvedSource ?? await resolveSource(clip, signal)
    const plan = createAudioStretchReadPlan({ clip, source, projectBpm })
    const repository = artifactRepository
    const descriptor = createPreparedStretchArtifact({
      source,
      plan,
      persistable: source.persistable,
      windowFrameCount: 2_048,
      overlapFrameCount: 1_024,
      searchFrameCount: 512,
    })
    const operationKey = `${repositoryIdentity(repository)}:${descriptor.artifactId}`
    let operation = artifactOperations.get(operationKey)
    if (!operation) {
      const controller = new AbortController()
      const pending = renderStretchedAudioToArtifact({
        clip,
        source,
        projectBpm,
        repository,
        signal: controller.signal,
      }).then((result) => ({ manifest: result.manifest }))
      const created: SharedArtifactOperation = {
        controller,
        promise: pending,
        waiterCount: 0,
        completed: false,
      }
      operation = created
      artifactOperations.set(operationKey, created)
      void pending.then(
        () => { created.completed = true },
        () => { created.completed = true },
      )
      void pending.finally(() => {
        if (artifactOperations.get(operationKey) === operation) artifactOperations.delete(operationKey)
      }).catch(() => {})
    }
    const shared = operation
    const cancellation = new DOMException('Stretch artifact render was cancelled.', 'AbortError')
    shared.waiterCount += 1
    return new Promise<{ binding: PreparedStretchArtifactBinding; manifest: PreparedStretchArtifactManifest }>((resolve, reject) => {
      let settled = false
      const release = () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        shared.waiterCount -= 1
        if (shared.waiterCount === 0 && !shared.completed) shared.controller.abort()
      }
      const finish = (callback: () => void) => {
        release()
        callback()
      }
      const abort = () => finish(() => reject(cancellation))
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      shared.promise.then(
        (value) => finish(() => resolve({
          binding: {
            clipId: clip.id,
            artifactId: descriptor.artifactId,
            timelineStartSec: plan.map.timelineStartSec,
            timelineDurationSec: plan.frameCount / source.sampleRate,
            sourceStartSec: 0,
          },
          manifest: value.manifest,
        })),
        (error) => finish(() => reject(error)),
      )
    })
  }

  const getState = (clip: RuntimeClip, projectBpm: number): AudioStretchRenderState => {
    const sourceBuffer = clip.buffer
    if (clip.audioWarp?.enabled !== true || clip.audioWarp.mode !== 'stretch') return { status: 'idle' }
    if (!sourceBuffer) {
      const entryKey = sourceEntryKeys.get(bufferlessClipKey(clip, projectBpm))
      const entry = entryKey ? entries.get(entryKey) : undefined
      if (!entry) return { status: 'idle' }
      if (entry.status === 'failed') return { status: 'failed', error: entry.error }
      return { status: entry.status }
    }
    const key = createCacheKey(clip, sourceBuffer, projectBpm)
    const cached = entries.get(key)
    if (cached) touch(key, cached)
    if (!cached) return { status: 'idle' }
    if (cached.status === 'failed') return { status: 'failed', error: cached.error }
    return { status: cached.status }
  }

  return {
    setSourceResolver: (next: AudioStretchCacheOptions['resolveSource']) => {
      sourceResolver = next
      lifecycleGeneration += 1
      for (const { controller } of renderOperations.values()) controller.abort()
      abortArtifactOperations()
      renderOperations.clear()
      cancelQueuedRenders()
      abortSourceResolutions()
      entries.clear()
      sourceEntryKeys.clear()
      pendingSourceKeys.clear()
      resolvedSources.clear()
      notify()
    },
    invalidate: () => {
      lifecycleGeneration += 1
      for (const { controller } of renderOperations.values()) controller.abort()
      abortArtifactOperations()
      renderOperations.clear()
      cancelQueuedRenders()
      abortSourceResolutions()
      entries.clear()
      sourceEntryKeys.clear()
      pendingSourceKeys.clear()
      resolvedSources.clear()
      notify()
    },
    dispose: () => {
      lifecycleGeneration += 1
      for (const { controller } of renderOperations.values()) controller.abort()
      abortArtifactOperations()
      renderOperations.clear()
      cancelQueuedRenders()
      abortSourceResolutions()
      entries.clear()
      sourceEntryKeys.clear()
      pendingSourceKeys.clear()
      resolvedSources.clear()
      listeners.clear()
      if (ownsArtifactRepository) void artifactRepository.dispose?.().catch(() => {})
    },
    ensure,
    getReady,
    renderNow,
    renderArtifactNow,
    getState,
    subscribe: (listener: AudioStretchRenderStateListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
