import {
  createAudioPcmSourceDescriptor,
  getAudioBufferSessionIdentity,
  inspectAudioSourceMetadata,
  sha256File,
  type AudioPcmSourceDescriptor,
} from '@daw-browser/audio-engine/media-pages'
import { isLocalProjectAssetKey, resolveClipSampleUrl } from '@daw-browser/shared'
import { getLocalAsset, readLocalAssetBytes } from '~/lib/local-assets'
import { resolveSamplePlaybackUrlForRuntime } from '~/lib/renderer-api-url'
import type { AudioStretchRuntimeClip } from '@daw-browser/audio-engine/audio-stretch-rendering'

type RuntimeClip = AudioStretchRuntimeClip

const MAX_DESCRIPTOR_CACHE_ENTRIES = 32
const descriptorCache = new Map<string, AudioPcmSourceDescriptor>()

type PendingSubscriber = {
  resolve: (value: AudioPcmSourceDescriptor) => void
  reject: (reason?: Error) => void
  signal?: AbortSignal
  onAbort: () => void
}

type PendingDescriptorResolution = {
  controller: AbortController
  promise: Promise<AudioPcmSourceDescriptor>
  subscribers: Set<PendingSubscriber>
}

const pendingDescriptorResolutions = new Map<string, PendingDescriptorResolution>()

const canonicalContentHash = (value: string | undefined) => (
  value !== undefined && /^[0-9a-f]{64}$/u.test(value)
)

export type AudioPcmSourceResolver = (
  clip: RuntimeClip,
  signal?: AbortSignal,
) => Promise<AudioPcmSourceDescriptor>

const persistedMetadata = (
  clip: RuntimeClip,
  source?: {
    durationSec?: number
    sampleRate?: number
    channelCount?: number
  },
) => {
  const durationSec = source?.durationSec ?? clip.sourceDurationSec
  const sampleRate = source?.sampleRate ?? clip.sourceSampleRate
  const channelCount = source?.channelCount ?? clip.sourceChannelCount
  if (durationSec === undefined
    || sampleRate === undefined
    || channelCount === undefined) {
    throw new Error(`Clip "${clip.id}" is missing persisted source metadata.`)
  }
  return {
    durationSec,
    frameCount: Math.round(durationSec * sampleRate),
    sampleRate,
    channelCount,
  }
}

const assertEncodedMetadataMatchesPersisted = (
  persisted: ReturnType<typeof persistedMetadata>,
  encoded: Awaited<ReturnType<typeof inspectAudioSourceMetadata>>,
  label: string,
) => {
  if (encoded.sampleRate !== persisted.sampleRate || encoded.channelCount !== persisted.channelCount) {
    throw new Error(`Audio source "${label}" metadata does not match its authoritative asset metadata.`)
  }
  if (encoded.durationSec !== undefined
    && Math.abs(encoded.durationSec - persisted.durationSec) > 0.5 / persisted.sampleRate) {
    throw new Error(`Audio source "${label}" duration does not match its authoritative asset metadata.`)
  }
}

const descriptorFromBuffer = (clip: RuntimeClip) => {
  if (!clip.buffer) return undefined
  if (clip.sourceSampleRate !== undefined && clip.buffer.sampleRate !== clip.sourceSampleRate) {
    throw new Error(`Clip "${clip.id}" buffer sample rate does not match its persisted source metadata.`)
  }
  if (clip.sourceChannelCount !== undefined && clip.buffer.numberOfChannels !== clip.sourceChannelCount) {
    throw new Error(`Clip "${clip.id}" buffer channel count does not match its persisted source metadata.`)
  }
  if (clip.sourceDurationSec !== undefined
    && Math.abs(clip.buffer.duration - clip.sourceDurationSec) > 0.5 / clip.buffer.sampleRate) {
    throw new Error(`Clip "${clip.id}" buffer duration does not match its persisted source metadata.`)
  }
  return createAudioPcmSourceDescriptor({
    identity: getAudioBufferSessionIdentity(clip.buffer),
    durationSec: clip.buffer.duration,
    frameCount: clip.buffer.length,
    sampleRate: clip.buffer.sampleRate,
    channelCount: clip.buffer.numberOfChannels,
    source: clip.buffer,
  })
}

const deriveCloudSampleUrl = (
  clip: RuntimeClip,
  projectId: string | undefined,
) => {
  if (!clip.sourceAssetKey) return undefined
  if (!projectId) {
    throw new Error(`Clip "${clip.id}" requires a project ID to resolve cloud audio asset "${clip.sourceAssetKey}".`)
  }
  return `/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(clip.sourceAssetKey)}`
}

const descriptorCacheKey = (clip: RuntimeClip, projectId: string | undefined) => [
  projectId ?? '',
  clip.sourceAssetKey ?? '',
  clip.sampleUrl ?? '',
  clip.sourceDurationSec ?? '',
  clip.sourceSampleRate ?? '',
  clip.sourceChannelCount ?? '',
  clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch' ? 'verified' : 'session',
].join('|')

const rememberDescriptor = (key: string, descriptor: AudioPcmSourceDescriptor) => {
  descriptorCache.delete(key)
  descriptorCache.set(key, descriptor)
  while (descriptorCache.size > MAX_DESCRIPTOR_CACHE_ENTRIES) {
    const oldest = descriptorCache.keys().next().value
    if (oldest === undefined) break
    descriptorCache.delete(oldest)
  }
}

export const createAudioPcmSourceResolver = (input: {
  projectId?: () => string | undefined
  readLocalAsset?: typeof readLocalAssetBytes
  resolveUrl?: (value: string) => string | null
} = {}): AudioPcmSourceResolver => {
  const readLocalAsset = input.readLocalAsset ?? readLocalAssetBytes
  const resolveUrl = input.resolveUrl ?? resolveSamplePlaybackUrlForRuntime
  const abortReason = (signal?: AbortSignal) => (
    signal?.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted.', 'AbortError')
  )
  const resolveDescriptor = async (clip: RuntimeClip, projectId: string | undefined, signal?: AbortSignal) => {
    const localId = clip.sourceAssetKey && isLocalProjectAssetKey(clip.sourceAssetKey)
      ? clip.sourceAssetKey
      : undefined
    if (localId) {
      if (!projectId) {
        throw new Error(`Clip "${clip.id}" requires a project ID to resolve local audio asset "${localId}".`)
      }
      const row = await getLocalAsset(projectId, localId)
      const result = await readLocalAsset(projectId, localId)
      signal?.throwIfAborted()
      if (result.status === 'missing') throw new Error(`Local audio asset "${localId}" is missing.`)
      if (result.status === 'permission-denied') throw new Error(`Permission to read local audio asset "${localId}" was denied.`)
      if (!row) throw new Error(`Local audio asset "${localId}" has no metadata row.`)
      if (row.durationSec === undefined
        || row.sampleRate === undefined
        || row.channelCount === undefined) {
        throw new Error(`Local audio asset "${localId}" is missing authoritative audio metadata.`)
      }
      const metadata = persistedMetadata(clip, row)
      const encoded = await inspectAudioSourceMetadata(result.file, { signal })
      assertEncodedMetadataMatchesPersisted(metadata, encoded, localId)
      const claimedHash = row.contentHash
      const requiresVerifiedIdentity = clip.audioWarp?.enabled === true
        && clip.audioWarp.mode === 'stretch'
      const actualHash = requiresVerifiedIdentity && canonicalContentHash(claimedHash)
        ? await sha256File(result.file, signal)
        : undefined
      const verified = actualHash !== undefined && actualHash === claimedHash
      return createAudioPcmSourceDescriptor({
        identity: verified
          ? `${clip.sourceAssetKey}:${actualHash}`
          : `${clip.sourceAssetKey}:session`,
        contentHash: verified ? actualHash : undefined,
        contentHashVerified: verified,
        persistable: verified,
        ...metadata,
        source: result.file,
      })
    }
    const metadata = persistedMetadata(clip)
    const sampleUrl = resolveClipSampleUrl(clip) ?? deriveCloudSampleUrl(clip, projectId)
    if (!sampleUrl) throw new Error(`Clip "${clip.id}" has no resolvable audio source.`)
    const url = resolveUrl(sampleUrl)
    if (!url) throw new Error(`Clip "${clip.id}" has an invalid audio source URL.`)
    const encoded = await inspectAudioSourceMetadata(url, { signal })
    assertEncodedMetadataMatchesPersisted(metadata, encoded, url)
    return createAudioPcmSourceDescriptor({
      identity: clip.sourceAssetKey
        ? `asset:${projectId ?? 'project:unknown'}:${clip.sourceAssetKey}`
        : `remote:${url}`,
      persistable: false,
      ...metadata,
      source: url,
    })
  }

  const removeSubscriber = (entry: PendingDescriptorResolution, subscriber: PendingSubscriber) => {
    subscriber.signal?.removeEventListener('abort', subscriber.onAbort)
    entry.subscribers.delete(subscriber)
  }

  const settlePending = (
    entry: PendingDescriptorResolution,
    result: AudioPcmSourceDescriptor | undefined,
    error?: Error,
  ) => {
    for (const subscriber of Array.from(entry.subscribers)) {
      removeSubscriber(entry, subscriber)
      if (error !== undefined) subscriber.reject(error)
      else if (subscriber.signal?.aborted) subscriber.reject(abortReason(subscriber.signal))
      else if (result) subscriber.resolve(result)
    }
  }

  const subscribePending = (
    key: string,
    entry: PendingDescriptorResolution,
    signal?: AbortSignal,
  ) => new Promise<AudioPcmSourceDescriptor>((resolve, reject) => {
    const subscriber: PendingSubscriber = {
      resolve,
      reject,
      signal,
      onAbort: () => {
        if (!entry.subscribers.has(subscriber)) return
        removeSubscriber(entry, subscriber)
        reject(abortReason(signal))
        if (entry.subscribers.size === 0) {
          entry.controller.abort(abortReason(signal))
          if (pendingDescriptorResolutions.get(key) === entry) {
            pendingDescriptorResolutions.delete(key)
          }
        }
      },
    }
    entry.subscribers.add(subscriber)
    signal?.addEventListener('abort', subscriber.onAbort, { once: true })
    if (signal?.aborted) subscriber.onAbort()
  })

  return async (clip, signal) => {
    signal?.throwIfAborted()
    const eager = descriptorFromBuffer(clip)
    if (eager) return eager
    const projectId = input.projectId?.()
    const cacheKey = descriptorCacheKey(clip, projectId)
    const cached = descriptorCache.get(cacheKey)
    if (cached) return cached
    const pending = pendingDescriptorResolutions.get(cacheKey)
    if (pending) return subscribePending(cacheKey, pending, signal)

    const controller = new AbortController()
    const entry = {
      controller,
      promise: resolveDescriptor(clip, projectId, controller.signal),
      subscribers: new Set<PendingSubscriber>(),
    }
    pendingDescriptorResolutions.set(cacheKey, entry)
    void entry.promise.then((resolved) => {
      if (pendingDescriptorResolutions.get(cacheKey) === entry && !controller.signal.aborted) {
        rememberDescriptor(cacheKey, resolved)
      }
      settlePending(entry, resolved)
    }).catch((error) => {
      settlePending(
        entry,
        undefined,
        error instanceof Error ? error : new Error(String(error)),
      )
    }).finally(() => {
      if (pendingDescriptorResolutions.get(cacheKey) === entry) {
        pendingDescriptorResolutions.delete(cacheKey)
      }
    })
    return subscribePending(cacheKey, entry, signal)
  }
}

export function clearAudioPcmSourceResolverCache() {
  descriptorCache.clear()
  for (const entry of pendingDescriptorResolutions.values()) {
    entry.controller.abort()
    settleClearedPending(entry)
  }
  pendingDescriptorResolutions.clear()
}

const settleClearedPending = (entry: PendingDescriptorResolution) => {
  for (const subscriber of Array.from(entry.subscribers)) {
    subscriber.signal?.removeEventListener('abort', subscriber.onAbort)
    entry.subscribers.delete(subscriber)
    subscriber.reject(new DOMException('The operation was aborted.', 'AbortError'))
  }
}

export const audioPcmSourceResolverCacheLimits = {
  descriptorEntries: MAX_DESCRIPTOR_CACHE_ENTRIES,
}
