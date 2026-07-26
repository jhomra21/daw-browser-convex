import { type Accessor, untrack } from 'solid-js'

import { clearWaveformAssetCache } from '@daw-browser/waveforms/asset-store'
import { audioCoreContractVersion, type AudioAssetRef, type PlanarPcm } from '../../packages/audio-core-contract/src/index'
import { isLocalId, resolveClipSampleUrl } from '@daw-browser/shared'
import { createClipBufferCache, type ClipBuffers, type ClipBufferWriter, type EnsureClipBuffer } from '~/lib/clip-buffer-cache'
import { readLocalOrCloudAssetFile } from '~/lib/cloud-asset-cache'
import {
  resolveSamplePlaybackUrlForRuntime,
} from '~/lib/renderer-api-url'
import { createSampleBufferLoader } from '~/lib/sample-buffer-loader'

import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'

type ClipMediaStatus = NonNullable<Track['clips'][number]['mediaStatus']>
export type CapturedClipMediaReference = {
  projectId?: string
  sampleUrl?: string
  sourceAssetKey?: string
}
export type CapturedClipBufferLoadResult =
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'missing' }
  | { status: 'permission-denied' }

type CapturedClipMediaLoaderDependencies = {
  readAsset: (projectId: string, sourceAssetKey: string) => ReturnType<typeof readLocalOrCloudAssetFile>
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>
  resolveSampleUrl?: (value: string) => string | null
}

export const createCapturedClipMediaLoader = (dependencies: CapturedClipMediaLoaderDependencies) => {
  const loads = new Map<string, Promise<CapturedClipBufferLoadResult>>()
  const awaitWithSignal = async <Value,>(promise: Promise<Value>, signal: AbortSignal | undefined): Promise<Value> => {
    if (!signal) return await promise
    signal.throwIfAborted()
    return await new Promise<Value>((resolve, reject) => {
      const abort = () => {
        try {
          signal.throwIfAborted()
        } catch (error) {
          reject(error)
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  const loadUrl = async (sampleUrl: string, signal?: AbortSignal): Promise<CapturedClipBufferLoadResult> => {
    const url = dependencies.resolveSampleUrl ? dependencies.resolveSampleUrl(sampleUrl) : sampleUrl
    if (!url) return { status: 'missing' }
    try {
      const response = await awaitWithSignal(dependencies.fetch(url, signal ? { signal } : undefined), signal)
      if (response.status === 401 || response.status === 403) return { status: 'permission-denied' }
      if (!response.ok) return { status: 'missing' }
      const data = await awaitWithSignal(response.arrayBuffer(), signal)
      return { status: 'ready', buffer: await awaitWithSignal(dependencies.decode(data), signal) }
    } catch (error) {
      if (signal?.aborted) throw error
      return { status: 'missing' }
    }
  }
  const load = (reference: CapturedClipMediaReference, signal?: AbortSignal) => {
    const cacheKey = `${reference.projectId ?? ''}\u0000${reference.sourceAssetKey ?? ''}\u0000${reference.sampleUrl ?? ''}`
    const existing = signal ? undefined : loads.get(cacheKey)
    if (existing) return existing
    const result = (async (): Promise<CapturedClipBufferLoadResult> => {
      let assetResult: CapturedClipBufferLoadResult | undefined
      if (reference.projectId && reference.sourceAssetKey && isLocalId('asset', reference.sourceAssetKey)) {
        try {
          const asset = await awaitWithSignal(dependencies.readAsset(reference.projectId, reference.sourceAssetKey), signal)
          if (asset.status === 'ready') {
            try {
              const data = await awaitWithSignal(asset.file.arrayBuffer(), signal)
              return { status: 'ready', buffer: await awaitWithSignal(dependencies.decode(data), signal) }
            } catch (error) {
              if (signal?.aborted) throw error
              assetResult = { status: 'missing' }
            }
          } else assetResult = asset
        } catch (error) {
          if (signal?.aborted) throw error
          assetResult = { status: 'missing' }
        }
      }
      const urlResult = reference.sampleUrl ? await loadUrl(reference.sampleUrl, signal) : undefined
      if (urlResult?.status === 'ready') return urlResult
      if (assetResult?.status === 'permission-denied' || urlResult?.status === 'permission-denied') {
        return { status: 'permission-denied' }
      }
      return { status: 'missing' }
    })()
    if (!signal) loads.set(cacheKey, result)
    return result
  }
  return { load, clear: () => loads.clear() }
}

export type UploadToR2Result = { assetKey: string; url: string } | null

export type UploadToR2 = (
  projectId: string,
  assetKey: string,
  file: File,
  durationSec?: number,
) => Promise<UploadToR2Result>

type ClipBufferOptions = {
  audioEngine: AudioEngine
  projectId: Accessor<string>
  tracks: Accessor<Track[]>
  onBufferChange: () => void
}

type ClipBufferControls = ClipBuffers & {
  uploadToR2: UploadToR2
  clearClipBufferCaches: () => void
  loadCapturedMedia: (reference: CapturedClipMediaReference, signal?: AbortSignal) => Promise<CapturedClipBufferLoadResult>
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

export const createAudioAssetRef = (assetId: string, buffer: AudioBuffer): AudioAssetRef => ({
  version: audioCoreContractVersion,
  assetId,
  frameCount: buffer.length,
  sampleRateHz: buffer.sampleRate,
  channelCount: buffer.numberOfChannels,
})

const createPlanarPcm = (buffer: AudioBuffer): PlanarPcm => ({
  frameCount: buffer.length,
  planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
})

export function useClipBuffers(options: ClipBufferOptions): ClipBufferControls {
  const { audioEngine, tracks } = options
  const clipMediaStatus = new Map<string, ClipMediaStatus>()
  const loadingClipIds = new Set<string>()
  const sampleBufferLoader = createSampleBufferLoader()
  const resolveSampleUrl = resolveSamplePlaybackUrlForRuntime
  const capturedMediaLoader = createCapturedClipMediaLoader({
    readAsset: readLocalOrCloudAssetFile,
    fetch,
    decode: (data) => audioEngine.decodeAudioData(data),
    resolveSampleUrl,
  })
  let cacheGeneration = 0
  const registeredAssetIds = new Set<string>()

  const publishBufferUpdate = () => {
    options.onBufferChange()
  }
  const audioBufferCache = createClipBufferCache({
    mediaStatus: clipMediaStatus,
    onChange: publishBufferUpdate,
  })

  const setMediaStatus = (clipId: string, status: 'missing' | 'permission-denied') => {
    if (clipMediaStatus.get(clipId) === status) return
    clipMediaStatus.set(clipId, status)
    publishBufferUpdate()
  }

  const uploadToR2: UploadToR2 = async (room, assetKey, file, durationSec) => {
    try {
      const fd = new FormData()
      fd.append('projectId', room)
      fd.append('assetKey', assetKey)
      fd.append('file', file, file.name)
      if (typeof durationSec === 'number' && isFinite(durationSec)) {
        fd.append('duration', String(durationSec))
      }
      const res = await fetch('/api/samples', { method: 'POST', body: fd })
      if (!res.ok) return null
      const data = await res.json().catch(() => null)
      return isRecord(data) && typeof data.url === 'string' && typeof data.assetKey === 'string'
        ? { assetKey: data.assetKey, url: data.url }
        : null
    } catch {
      return null
    }
  }

  const loadCapturedMedia = (reference: CapturedClipMediaReference, signal?: AbortSignal) => capturedMediaLoader.load(reference, signal)

  const ensureClipBuffer: EnsureClipBuffer = async (clipId, sampleUrl) => {
    const loadGeneration = cacheGeneration
    const isStaleLoad = () => loadGeneration !== cacheGeneration
    if (audioBufferCache.hasBuffer(clipId)) return

    const findClip = (targetClipId: string) => {
      const snapshot = untrack(() => tracks())
      for (const track of snapshot) {
        for (const clip of track.clips) {
          if (clip.id === targetClipId) return clip
        }
      }
      return undefined
    }

    const matchingClipIdsForCurrentClip = (matches: (clip: Track['clips'][number]) => boolean) => {
      const snapshot = untrack(() => tracks())
      const clipIds: string[] = []
      let currentFound = false
      let currentMatches = false
      for (const track of snapshot) {
        for (const clip of track.clips) {
          if (clip.id === clipId) currentFound = true
          if (!matches(clip)) continue
          clipIds.push(clip.id)
          if (clip.id === clipId) currentMatches = true
        }
      }
      return { clipIds, currentFound, currentMatches }
    }

    const applyMatchingBuffer = (
      buffer: AudioBuffer,
      matches: (clip: Track['clips'][number]) => boolean,
      options?: { storeWhenCurrentMissing?: boolean },
    ) => {
      if (isStaleLoad()) return
      const match = matchingClipIdsForCurrentClip(matches)
      if (match.currentMatches) {
        audioBufferCache.storeSharedBuffer(match.clipIds, buffer)
      } else if (!match.currentFound && options?.storeWhenCurrentMissing) {
        audioBufferCache.storeBuffer(clipId, buffer)
      }
    }

    const registerSourceAsset = (sourceAssetKey: string, buffer: AudioBuffer) => {
      if (isStaleLoad() || registeredAssetIds.has(sourceAssetKey)) return
      const result = audioEngine.registerAsset(
        createAudioAssetRef(sourceAssetKey, buffer),
        createPlanarPcm(buffer),
        loadGeneration,
      )
      if (result.status === 'registered') registeredAssetIds.add(sourceAssetKey)
    }

    if (sampleUrl) {
      const resolvedSampleUrl = resolveSampleUrl(sampleUrl)
      if (!resolvedSampleUrl) return
      try {
        const decoded = await sampleBufferLoader.load(resolvedSampleUrl, (arrayBuffer) => audioEngine.decodeAudioData(arrayBuffer))
        if (!decoded || audioBufferCache.hasBuffer(clipId)) return
        const sourceAssetKey = findClip(clipId)?.sourceAssetKey
        if (sourceAssetKey) registerSourceAsset(sourceAssetKey, decoded)
        applyMatchingBuffer(decoded, (clip) => resolveSampleUrl(resolveClipSampleUrl(clip) ?? '') === resolvedSampleUrl, { storeWhenCurrentMissing: true })
      } catch {}
      return
    }

    if (loadingClipIds.has(clipId)) return
    loadingClipIds.add(clipId)
    try {
      const existing = findClip(clipId)
      const resolvedSampleUrl = existing ? resolveClipSampleUrl(existing) : undefined
      if (resolvedSampleUrl) {
        const url = resolveSampleUrl(resolvedSampleUrl)
        if (!url) return
        const decoded = await sampleBufferLoader.load(url, (arrayBuffer) => audioEngine.decodeAudioData(arrayBuffer))
        if (!decoded || audioBufferCache.hasBuffer(clipId)) return
        const sourceAssetKey = existing?.sourceAssetKey
        if (sourceAssetKey) registerSourceAsset(sourceAssetKey, decoded)
        applyMatchingBuffer(decoded, (clip) => resolveSampleUrl(resolveClipSampleUrl(clip) ?? '') === url)
        return
      }
      const projectId = options.projectId()
      if (projectId && existing?.sourceAssetKey && isLocalId('asset', existing.sourceAssetKey)) {
        const sourceAssetKey = existing.sourceAssetKey
        const captured = await loadCapturedMedia({ projectId, sourceAssetKey })
        if (captured.status === 'ready') {
          const decoded = captured.buffer
          if (audioBufferCache.hasBuffer(clipId)) return
          registerSourceAsset(sourceAssetKey, decoded)
          if (isStaleLoad()) return
          applyMatchingBuffer(decoded, (clip) => clip.sourceAssetKey === sourceAssetKey)
          return
        }
        if (isStaleLoad()) return
        setMediaStatus(clipId, captured.status)
        return
      }
    } catch {
    } finally {
      loadingClipIds.delete(clipId)
    }
  }

  const clearClipBufferCaches = () => {
    for (const assetId of registeredAssetIds) {
      audioEngine.releaseAsset(assetId, cacheGeneration)
    }
    registeredAssetIds.clear()
    audioEngine.retireAssetGeneration(cacheGeneration)
    cacheGeneration += 1
    loadingClipIds.clear()
    capturedMediaLoader.clear()
    audioBufferCache.clear()
    sampleBufferLoader.clear()
    clearWaveformAssetCache()
  }

  const writer: ClipBufferWriter = {
    storeBuffer: audioBufferCache.storeBuffer,
    storeBuffers: audioBufferCache.storeBuffers,
    removeBuffer: audioBufferCache.removeBuffer,
  }

  return {
    writer,
    getBuffer: (clipId) => audioBufferCache.getBuffer(clipId),
    getMediaStatus: (clipId) => clipMediaStatus.get(clipId),
    preload: ensureClipBuffer,
    loadCapturedMedia,
    uploadToR2,
    clearClipBufferCaches,
  }
}
