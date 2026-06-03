import { type Accessor, untrack } from 'solid-js'

import { clearWaveformAssetCache } from '~/lib/audio-peaks/asset-store'
import { resolveClipSampleUrl } from '~/lib/audio-source-rules'
import { createClipBufferCache, type ClipBuffers, type ClipBufferWriter, type EnsureClipBuffer } from '~/lib/clip-buffer-cache'
import { readLocalOrCloudAssetFile } from '~/lib/cloud-asset-cache'
import { isLocalId } from '~/lib/local-ids'
import { createSampleBufferLoader } from '~/lib/sample-buffer-loader'

import type { AudioEngine } from '~/lib/audio-engine'
import type { Track } from '~/types/timeline'

type ClipMediaStatus = NonNullable<Track['clips'][number]['mediaStatus']>

export type UploadToR2Result = string | null

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
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

export function useClipBuffers(options: ClipBufferOptions): ClipBufferControls {
  const { audioEngine, tracks } = options
  const clipMediaStatus = new Map<string, ClipMediaStatus>()
  const loadingClipIds = new Set<string>()
  const sampleBufferLoader = createSampleBufferLoader()
  let cacheGeneration = 0

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
      return isRecord(data) && typeof data.url === 'string' ? data.url : null
    } catch {
      return null
    }
  }

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

    const matchingClipIds = (matches: (clip: Track['clips'][number]) => boolean) => {
      const snapshot = untrack(() => tracks())
      const clipIds: string[] = []
      for (const track of snapshot) {
        for (const clip of track.clips) {
          if (matches(clip)) clipIds.push(clip.id)
        }
      }
      return clipIds
    }

    const applyBuffer = (buffer: AudioBuffer, sharedClipIds?: string[]) => {
      if (isStaleLoad()) return
      if (!sharedClipIds || sharedClipIds.length === 0) {
        audioBufferCache.storeBuffer(clipId, buffer)
        return
      }
      audioBufferCache.storeSharedBuffer(sharedClipIds.includes(clipId) ? sharedClipIds : [clipId, ...sharedClipIds], buffer)
    }

    if (sampleUrl) {
      try {
        const decoded = await sampleBufferLoader.load(sampleUrl, (arrayBuffer) => audioEngine.decodeAudioData(arrayBuffer))
        if (!decoded || audioBufferCache.hasBuffer(clipId)) return
        applyBuffer(decoded, matchingClipIds((clip) => resolveClipSampleUrl(clip) === sampleUrl))
      } catch {}
      return
    }

    if (loadingClipIds.has(clipId)) return
    loadingClipIds.add(clipId)
    try {
      const existing = findClip(clipId)
      const resolvedSampleUrl = existing ? resolveClipSampleUrl(existing) : undefined
      if (resolvedSampleUrl) {
        const decoded = await sampleBufferLoader.load(resolvedSampleUrl, (arrayBuffer) => audioEngine.decodeAudioData(arrayBuffer))
        if (!decoded || audioBufferCache.hasBuffer(clipId)) return
        applyBuffer(decoded, matchingClipIds((clip) => resolveClipSampleUrl(clip) === resolvedSampleUrl))
        return
      }
      const projectId = options.projectId()
      if (projectId && existing?.sourceAssetKey && isLocalId('asset', existing.sourceAssetKey)) {
        const sourceAssetKey = existing.sourceAssetKey
        const bytes = await readLocalOrCloudAssetFile(projectId, existing.sourceAssetKey)
        if (bytes.status === 'ready') {
          const decoded = await audioEngine.decodeAudioData(await bytes.file.arrayBuffer())
          if (audioBufferCache.hasBuffer(clipId)) return
          applyBuffer(decoded, matchingClipIds((clip) => clip.sourceAssetKey === sourceAssetKey))
          return
        }
        if (isStaleLoad()) return
        setMediaStatus(clipId, bytes.status)
        return
      }
    } catch {
    } finally {
      loadingClipIds.delete(clipId)
    }
  }

  const clearClipBufferCaches = () => {
    cacheGeneration += 1
    loadingClipIds.clear()
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
    uploadToR2,
    clearClipBufferCaches,
  }
}
