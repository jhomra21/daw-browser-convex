import { batch, type Accessor, type Setter } from 'solid-js'

import type { AudioEngine } from '~/lib/audio-engine'
import { clientXToSec, yToLaneIndex, willOverlap, calcNonOverlapStart } from '~/lib/timeline-utils'
import type { Clip, SelectedClip, Track } from '~/types/timeline'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type UploadToR2 = (
  roomId: string,
  clipId: string,
  file: File,
  durationSec?: number,
) => Promise<string | null>

type TimelineClipImportOptions = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
  selectedTrackId: Accessor<string>
  setSelectedTrackId: Setter<string>
  setSelectedClip: Setter<SelectedClip>
  setSelectedClipIds: Setter<Set<string>>
  setSelectedFXTarget: Setter<string>
  playheadSec: Accessor<number>
  roomId: Accessor<string | undefined>
  userId: Accessor<string | undefined>
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  audioBufferCache: Map<string, AudioBuffer>
  uploadToR2: UploadToR2
  getScrollElement: () => HTMLDivElement | undefined
  getFileInput: () => HTMLInputElement | undefined
}

type TimelineClipImportHandlers = {
  handleDrop: (event: DragEvent) => Promise<void>
  handleFiles: (files: FileList | null) => Promise<void>
  handleAddAudio: () => Promise<void>
}

export function useTimelineClipImport(options: TimelineClipImportOptions): TimelineClipImportHandlers {
  const {
    audioEngine,
    tracks,
    setTracks,
    selectedTrackId,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
    playheadSec,
    roomId,
    userId,
    convexClient,
    convexApi,
    audioBufferCache,
    uploadToR2,
    getScrollElement,
    getFileInput,
  } = options

  const createServerTrack = async () => {
    const rid = roomId()
    const uid = userId()
    return await convexClient.mutation(convexApi.tracks.create, { roomId: rid as any, userId: uid } as any) as any as string
  }

  const insertOptimisticClip = (trackId: string, clip: Clip) => {
    setTracks(ts => {
      const idx = ts.findIndex(t => t.id === trackId)
      if (idx === -1) {
        const newTrack: Track = {
          id: trackId,
          name: `Track ${ts.length + 1}`,
          volume: 0.8,
          clips: [clip],
          muted: false,
          soloed: false,
        }
        return [...ts, newTrack]
      }
      const track = ts[idx]
      const existsIdx = track.clips.findIndex(c => c.id === clip.id)
      if (existsIdx >= 0) {
        const updatedClips = track.clips.map(c => c.id === clip.id ? { ...c, name: clip.name, buffer: clip.buffer ?? null } : c)
        return ts.map((t, i) => (i !== idx ? t : { ...t, clips: updatedClips }))
      }
      return ts.map((t, i) => (i !== idx ? t : { ...t, clips: [...t.clips, clip] }))
    })
  }

  const createServerClip = async (
    trackId: string,
    startSec: number,
    duration: number,
    name: string,
  ) => {
    const rid = roomId()
    const uid = userId()
    return await convexClient.mutation(convexApi.clips.create, {
      roomId: rid,
      trackId: trackId as any,
      startSec,
      duration,
      userId: uid,
      name,
    } as any) as any as string
  }

  const uploadSampleUrl = async (clipId: string, file: File, duration: number) => {
    const rid = roomId()
    if (!rid) return
    const url = await uploadToR2(rid, clipId, file, duration)
    if (!url) return
    try {
      await convexClient.mutation(convexApi.clips.setSampleUrl, { clipId: clipId as any, sampleUrl: url })
    } catch {}
    setTracks(ts => ts.map(t => ({
      ...t,
      clips: t.clips.map(c => (c.id === clipId ? { ...c, sampleUrl: url } : c)),
    })))
  }

  const applySelectionAfterCreate = (trackId: string, clipId: string) => {
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
      setSelectedClipIds(new Set([clipId]))
      setSelectedFXTarget(trackId)
    })
  }

  const ensureNonOverlappingStart = (track: Track | undefined, desiredStart: number, duration: number) => {
    if (!track) return desiredStart
    if (!willOverlap(track.clips, null, desiredStart, duration)) return desiredStart
    return calcNonOverlapStart(track.clips, null, desiredStart, duration)
  }

  const handleFilesInternal = async (file: File, targetTrackId?: string, desiredStart?: number) => {
    const ab = await file.arrayBuffer()
    const decoded = await audioEngine.decodeAudioData(ab)

    let trackId = targetTrackId
    if (!trackId) {
      trackId = selectedTrackId()
      if (!trackId) {
        trackId = await createServerTrack()
        if (trackId) {
          setSelectedTrackId(trackId)
          setSelectedFXTarget(trackId)
        }
      }
    }
    if (!trackId) return

    const tsSnapshot = tracks()
    const targetTrack = tsSnapshot.find(t => t.id === trackId)
    let startSec = typeof desiredStart === 'number' ? Math.max(0, desiredStart) : Math.max(0, playheadSec())
    startSec = ensureNonOverlappingStart(targetTrack, startSec, decoded.duration)

    const createdClipId = await createServerClip(trackId, startSec, decoded.duration, file.name)
    if (!createdClipId) return

    audioBufferCache.set(createdClipId, decoded)
    void uploadSampleUrl(createdClipId, file, decoded.duration)

    insertOptimisticClip(trackId, {
      id: createdClipId,
      name: file.name,
      buffer: decoded,
      startSec,
      duration: decoded.duration,
      color: '#22c55e',
    })

    applySelectionAfterCreate(trackId, createdClipId)
  }

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer?.files?.[0]
    if (!file || !file.type.startsWith('audio')) return

    const scroll = getScrollElement()
    if (!scroll) return

    const desiredStart = clientXToSec(event.clientX, scroll)
    let laneIdx = yToLaneIndex(event.clientY, scroll)

    const ts0 = tracks()
    let targetTrackId: string | undefined
    if (ts0.length === 0 || laneIdx >= ts0.length || laneIdx < 0) {
      targetTrackId = await createServerTrack()
    } else {
      laneIdx = Math.max(0, Math.min(laneIdx, ts0.length - 1))
      targetTrackId = ts0[laneIdx]?.id
    }
    if (!targetTrackId) return

    await handleFilesInternal(file, targetTrackId, desiredStart)
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const file = Array.from(files).find(f => f.type.startsWith('audio'))
    if (!file) return
    await handleFilesInternal(file)
  }

  const handleAddAudio = async () => {
    const w = window as unknown as {
      showOpenFilePicker?: (options: any) => Promise<any>
    }
    if (typeof w.showOpenFilePicker === 'function') {
      try {
        const handles: any[] = await w.showOpenFilePicker({
          multiple: false,
          types: [
            {
              description: 'Audio files',
              accept: { 'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.webm'] },
            },
          ],
        })
        const fileHandle: any = Array.isArray(handles) ? handles[0] : handles
        if (!fileHandle) return
        const file: File | undefined = await fileHandle.getFile?.()
        if (!file || !file.type.startsWith('audio')) return
        await handleFilesInternal(file)
        return
      } catch (err: any) {
        if (err && (err.name === 'AbortError' || err.code === 20)) return
      }
    }
    getFileInput()?.click()
  }

  return {
    handleDrop,
    handleFiles,
    handleAddAudio,
  }
}
