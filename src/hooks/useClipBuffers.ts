import { type Accessor, untrack } from 'solid-js'

import { clearWaveformAssetCache } from '~/lib/audio-peaks/asset-store'
import { readLocalAssetBytes } from '~/lib/local-assets'
import { isLocalId } from '~/lib/local-ids'
import { createSampleBufferLoader } from '~/lib/sample-buffer-loader'

import type { AudioEngine } from '~/lib/audio-engine'
import type { Track } from '~/types/timeline'

const audioBufferCache = new Map<string, AudioBuffer>()
const clipMediaStatus = new Map<string, 'missing' | 'permission-denied'>()
const loadingClipIds = new Set<string>()
const sampleBufferLoader = createSampleBufferLoader()

export type UploadToR2Result = string | null

export type UploadToR2 = (
  projectId: string,
  assetKey: string,
  file: File,
  durationSec?: number,
) => Promise<UploadToR2Result>

type EnsureClipBuffer = (clipId: string, sampleUrl?: string) => Promise<void>

type ClipBufferOptions = {
  audioEngine: AudioEngine
  projectId?: Accessor<string>
  tracks: Accessor<Track[]>
  onBufferChange?: () => void
}

type ClipBufferControls = {
  audioBufferCache: Map<string, AudioBuffer>
  clipMediaStatus: Map<string, 'missing' | 'permission-denied'>
  ensureClipBuffer: EnsureClipBuffer
  uploadToR2: UploadToR2
  clearClipBufferCaches: () => void
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

export function useClipBuffers(options: ClipBufferOptions): ClipBufferControls {
  const { audioEngine, tracks } = options

  const publishBufferUpdate = () => {
    options.onBufferChange?.()
  }

  const cacheBuffer = (clipId: string, buffer: AudioBuffer) => {
    if (audioBufferCache.get(clipId) === buffer) return false
    audioBufferCache.set(clipId, buffer)
    clipMediaStatus.delete(clipId)
    return true
  }

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
    if (audioBufferCache.has(clipId)) return

    const applyBuffer = async (buffer: AudioBuffer) => {
      let didChange = false
      if (sampleUrl) {
        const snapshot = untrack(() => tracks())
        const matchingClipIds: string[] = []
        for (const track of snapshot) {
          for (const clip of track.clips) {
            if (clip.sampleUrl !== sampleUrl) continue
            matchingClipIds.push(clip.id)
            didChange = cacheBuffer(clip.id, buffer) || didChange
          }
        }
        if (matchingClipIds.length === 0) {
          didChange = cacheBuffer(clipId, buffer) || didChange
        }
        if (didChange) publishBufferUpdate()
        return
      }

      didChange = cacheBuffer(clipId, buffer)
      if (didChange) publishBufferUpdate()
    }

    if (sampleUrl) {
      try {
        const decoded = await sampleBufferLoader.load(sampleUrl, (arrayBuffer) => audioEngine.decodeAudioData(arrayBuffer))
        if (!decoded) return
        await applyBuffer(decoded)
      } catch {}
      return
    }

    if (loadingClipIds.has(clipId)) return
    loadingClipIds.add(clipId)
    try {
      const existing = untrack(() => tracks().flatMap(t => t.clips).find(c => c.id === clipId))
      const projectId = options.projectId?.()
      if (projectId && isLocalId('project', projectId) && existing?.sourceAssetKey && isLocalId('asset', existing.sourceAssetKey)) {
        const bytes = await readLocalAssetBytes(projectId, existing.sourceAssetKey)
        if (bytes.status === 'ready') {
          const decoded = await audioEngine.decodeAudioData(await bytes.file.arrayBuffer())
          await applyBuffer(decoded)
          return
        }
        setMediaStatus(clipId, bytes.status)
        return
      }
      if (existing?.sampleUrl) {
        const decoded = await sampleBufferLoader.load(existing.sampleUrl, (arrayBuffer) => audioEngine.decodeAudioData(arrayBuffer))
        if (!decoded) return
        await applyBuffer(decoded)
      }
    } catch {
    } finally {
      loadingClipIds.delete(clipId)
    }
  }

  const clearClipBufferCaches = () => {
    const hadEntries = loadingClipIds.size > 0 || audioBufferCache.size > 0
    loadingClipIds.clear()
    audioBufferCache.clear()
    clipMediaStatus.clear()
    sampleBufferLoader.clear()
    clearWaveformAssetCache()
    if (hadEntries) publishBufferUpdate()
  }

  return {
    audioBufferCache,
    clipMediaStatus,
    ensureClipBuffer,
    uploadToR2,
    clearClipBufferCaches,
  }
}
