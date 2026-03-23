import { type Accessor, type Setter, untrack } from 'solid-js'

import { clearWaveformAssetCache } from '~/lib/audio-peaks/asset-store'
import { createSampleBufferLoader } from '~/lib/sample-buffer-loader'

import type { AudioEngine } from '~/lib/audio-engine'
import type { Track } from '~/types/timeline'

const audioBufferCache = new Map<string, AudioBuffer>()
const loadingClipIds = new Set<string>()
const sampleBufferLoader = createSampleBufferLoader()

export type UploadToR2Result = string | null

export type UploadToR2 = (
  roomId: string,
  assetKey: string,
  file: File,
  durationSec?: number,
) => Promise<UploadToR2Result>

type EnsureClipBuffer = (clipId: string, sampleUrl?: string) => Promise<void>

type ClipBufferOptions = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
}

type ClipBufferControls = {
  audioBufferCache: Map<string, AudioBuffer>
  ensureClipBuffer: EnsureClipBuffer
  uploadToR2: UploadToR2
  clearClipBufferCaches: () => void
}

export function useClipBuffers(options: ClipBufferOptions): ClipBufferControls {
  const { audioEngine, tracks, setTracks } = options

  const uploadToR2: UploadToR2 = async (room, assetKey, file, durationSec) => {
    try {
      const fd = new FormData()
      fd.append('roomId', room)
      fd.append('assetKey', assetKey)
      fd.append('file', file, file.name)
      if (typeof durationSec === 'number' && isFinite(durationSec)) {
        fd.append('duration', String(durationSec))
      }
      const res = await fetch('/api/samples', { method: 'POST', body: fd })
      if (!res.ok) return null
      const data: any = await res.json().catch(() => null as any)
      return data?.url ?? null
    } catch {
      return null
    }
  }

  const applyBufferToTracks = (clipIds: Iterable<string>, buffer: AudioBuffer) => {
    const ids = new Set(clipIds)
    if (ids.size === 0) return
    setTracks(current => current.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ids.has(clip.id) ? { ...clip, buffer } : clip),
    })))
  }

  const ensureClipBuffer: EnsureClipBuffer = async (clipId, sampleUrl) => {
    if (audioBufferCache.has(clipId)) return

    const applyBuffer = async (buffer: AudioBuffer) => {
      if (sampleUrl) {
        const snapshot = untrack(() => tracks())
        const matchingClipIds: string[] = []
        for (const track of snapshot) {
          for (const clip of track.clips) {
            if (clip.sampleUrl !== sampleUrl) continue
            matchingClipIds.push(clip.id)
            audioBufferCache.set(clip.id, buffer)
          }
        }
        if (matchingClipIds.length === 0) {
          audioBufferCache.set(clipId, buffer)
          matchingClipIds.push(clipId)
        }
        applyBufferToTracks(matchingClipIds, buffer)
        return
      }

      audioBufferCache.set(clipId, buffer)
      applyBufferToTracks([clipId], buffer)
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
    loadingClipIds.clear()
    audioBufferCache.clear()
    sampleBufferLoader.clear()
    clearWaveformAssetCache()
  }

  return {
    audioBufferCache,
    ensureClipBuffer,
    uploadToR2,
    clearClipBufferCaches,
  }
}
