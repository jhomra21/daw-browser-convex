import { type Accessor, type Setter, untrack } from 'solid-js'

import type { AudioEngine } from '~/lib/audio-engine'
import type { Track } from '~/types/timeline'

const audioBufferCache = new Map<string, AudioBuffer>()
const sampleUrlBufferCache = new Map<string, AudioBuffer>()
const pendingSampleBuffers = new Map<string, Promise<AudioBuffer>>()
const loadingClipIds = new Set<string>()

export type UploadToR2Result = string | null

export type UploadToR2 = (
  roomId: string,
  clipId: string,
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

  const uploadToR2: UploadToR2 = async (room, clip, file, durationSec) => {
    try {
      const fd = new FormData()
      fd.append('roomId', room)
      fd.append('clipId', clip)
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

  const ensureClipBuffer: EnsureClipBuffer = async (clipId, sampleUrl) => {
    if (audioBufferCache.has(clipId)) return

    const applyBuffer = (buffer: AudioBuffer) => {
      if (sampleUrl) {
        const matchingClipIds = new Set<string>()
        const snapshot = untrack(() => tracks())
        for (const track of snapshot) {
          for (const clip of track.clips) {
            if (clip.sampleUrl === sampleUrl) {
              matchingClipIds.add(clip.id)
              audioBufferCache.set(clip.id, buffer)
            }
          }
        }
        if (matchingClipIds.size === 0) {
          audioBufferCache.set(clipId, buffer)
          matchingClipIds.add(clipId)
        }
        setTracks(ts => ts.map(t => ({
          ...t,
          clips: t.clips.map(c => matchingClipIds.has(c.id) ? { ...c, buffer } : c),
        })))
      } else {
        audioBufferCache.set(clipId, buffer)
        setTracks(ts => ts.map(t => ({
          ...t,
          clips: t.clips.map(c => c.id === clipId ? { ...c, buffer } : c),
        })))
      }
    }

    if (sampleUrl) {
      if (sampleUrlBufferCache.has(sampleUrl)) {
        applyBuffer(sampleUrlBufferCache.get(sampleUrl)!)
        return
      }

      let pending = pendingSampleBuffers.get(sampleUrl)
      if (!pending) {
        pending = (async () => {
          const res = await fetch(sampleUrl)
          if (!res.ok) throw new Error('failed to fetch sample')
          const ab = await res.arrayBuffer()
          return audioEngine.decodeAudioData(ab)
        })()
        pendingSampleBuffers.set(sampleUrl, pending)
      }

      try {
        const decoded = await pending
        sampleUrlBufferCache.set(sampleUrl, decoded)
        applyBuffer(decoded)
      } catch {
        // Ignore errors; buffer remains unset
      } finally {
        if (pendingSampleBuffers.get(sampleUrl) === pending) {
          pendingSampleBuffers.delete(sampleUrl)
        }
      }
      return
    }

    if (loadingClipIds.has(clipId)) return
    loadingClipIds.add(clipId)
    try {
      const existing = untrack(() => tracks().flatMap(t => t.clips).find(c => c.id === clipId))
      const res = existing?.sampleUrl ? await fetch(existing.sampleUrl) : null
      if (res && res.ok) {
        const ab = await res.arrayBuffer()
        const decoded = await audioEngine.decodeAudioData(ab)
        applyBuffer(decoded)
      }
    } catch {
      // Ignore errors; buffer remains unset
    } finally {
      loadingClipIds.delete(clipId)
    }
  }

  const clearClipBufferCaches = () => {
    loadingClipIds.clear()
    audioBufferCache.clear()
    sampleUrlBufferCache.clear()
    pendingSampleBuffers.clear()
  }

  return {
    audioBufferCache,
    ensureClipBuffer,
    uploadToR2,
    clearClipBufferCaches,
  }
}
