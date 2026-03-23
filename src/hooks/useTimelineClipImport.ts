import { type Accessor, type Setter } from 'solid-js'

import { buildClipCreatePayload, buildLocalClip, createUploadedAudioClip, pushClipCreateHistory, type ClipCreateSnapshot } from '~/lib/clip-create'
import { createAudioAssetKey, getAudioSourceMetadata, type AudioSourceKind } from '~/lib/audio-source'
import type { AudioEngine } from '~/lib/audio-engine'
import { canTrackReceiveAudioClip, getTrackChannelRole } from '~/lib/track-routing'
import { selectPrimaryClip, selectTrackTarget } from '~/lib/timeline-selection'
import { clientXToSec, yToLaneIndex, willOverlap, calcNonOverlapStart, quantizeSecToGrid, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'
import { createLocalTrack, createOptimisticTrackWithHistory } from '~/lib/tracks'
import type { Clip, SelectedClip, Track } from '~/types/timeline'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type UploadToR2 = (
  roomId: string,
  assetKey: string,
  file: File,
  durationSec?: number,
) => Promise<string | null>

export type InsertSampleInput = {
  url: string
  name?: string
  duration: number
  assetKey: string
  sourceKind: AudioSourceKind
  source: {
    durationSec: number
    sampleRate: number
    channelCount: number
  }
}

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
  bpm: Accessor<number>
  gridEnabled: Accessor<boolean>
  gridDenominator: Accessor<number>
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  grantWrite?: (trackId: string) => void
  grantClipWrite?: (clipId: string) => void
}

type TimelineClipImportHandlers = {
  handleDrop: (event: DragEvent) => Promise<void>
  handleFiles: (files: FileList | null) => Promise<void>
  handleAddAudio: () => Promise<void>
  handleInsertSample: (input: InsertSampleInput) => Promise<void>
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
    bpm,
    gridEnabled,
    gridDenominator,
    grantWrite,
    grantClipWrite,
  } = options

  const selectionSetters = {
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
  }

  const requireAudioTrack = (track: Track | undefined, message = '[Import] Cannot insert audio into this track') => {
    if (!track || !canTrackReceiveAudioClip(track)) {
      console.warn(message)
      return null
    }
    return track
  }

  const createAudioTrack = async () => {
    const rid = roomId()
    const uid = userId()
    if (!rid || !uid) return null

    const track = await createOptimisticTrackWithHistory({
      convexClient,
      convexApi,
      roomId: rid,
      userId: uid,
      tracks,
      setTracks,
      grantWrite,
      historyPush: options.historyPush,
    })
    if (!track) return null

    selectTrackTarget(selectionSetters, track.id)
    return track
  }

  const ensureTargetAudioTrack = async (trackId?: string, message?: string) => {
    if (trackId) {
      return requireAudioTrack(tracks().find((track) => track.id === trackId), message)
    }

    const selectedId = selectedTrackId()
    if (selectedId) {
      const track = tracks().find((item) => item.id === selectedId)
      if (track && getTrackChannelRole(track) !== 'track') {
        return createAudioTrack()
      }
      const selectedTrack = requireAudioTrack(track, message ?? '[Import] Cannot add audio to this track')
      if (!selectedTrack) return null
      return selectedTrack
    }

    return createAudioTrack()
  }

  const resolveClipStartSec = (track: Track | undefined, desiredStart: number, duration: number) => {
    const startSec = gridEnabled()
      ? quantizeSecToGrid(Math.max(0, desiredStart), bpm(), gridDenominator(), 'round')
      : Math.max(0, desiredStart)
    return gridEnabled()
      ? calcNonOverlapStartGridAligned(track?.clips ?? [], null, startSec, duration, bpm(), gridDenominator())
      : ensureNonOverlappingStart(track, startSec, duration)
  }

  const resolveDropTargetTrack = async (clientY: number) => {
    const scroll = getScrollElement()
    if (!scroll) return null

    let laneIdx = yToLaneIndex(clientY, scroll)
    const snapshot = tracks()
    return (snapshot.length === 0 || laneIdx >= snapshot.length || laneIdx < 0)
      ? await createAudioTrack()
      : requireAudioTrack(snapshot[Math.max(0, Math.min(laneIdx, snapshot.length - 1))])
  }

  const resolveDropPlacement = async (clientX: number, clientY: number, duration: number) => {
    const scroll = getScrollElement()
    if (!scroll) return null
    const targetTrack = await resolveDropTargetTrack(clientY)
    if (!targetTrack) return null

    return {
      track: targetTrack,
      startSec: resolveClipStartSec(targetTrack, clientXToSec(clientX, scroll), duration),
    }
  }

  const insertOptimisticClip = (trackId: string, clip: Clip) => {
    setTracks(ts => {
      const idx = ts.findIndex(t => t.id === trackId)
      if (idx === -1) {
        return [...ts, createLocalTrack({ id: trackId, index: ts.length, clips: [clip] })]
      }
      const track = ts[idx]
      const existsIdx = track.clips.findIndex(c => c.id === clip.id)
      if (existsIdx >= 0) {
        const updatedClips = track.clips.map(c => c.id === clip.id ? { ...c, ...clip, buffer: clip.buffer ?? c.buffer ?? null } : c)
        return ts.map((t, i) => (i !== idx ? t : { ...t, clips: updatedClips }))
      }
      return ts.map((t, i) => (i !== idx ? t : { ...t, clips: [...t.clips, clip] }))
    })
  }

  const createServerClip = async (trackId: string, clip: ClipCreateSnapshot) => {
    const rid = roomId()
    const uid = userId()
    if (!rid || !uid) return null
    return await convexClient.mutation(
      convexApi.clips.create,
      buildClipCreatePayload({ roomId: rid, userId: uid, trackId, clip }) as any,
    ) as any as string
  }

  const applySelectionAfterCreate = (trackId: string, clipId: string) => {
    selectPrimaryClip(selectionSetters, { trackId, clipId })
  }

  const ensureNonOverlappingStart = (track: Track | undefined, desiredStart: number, duration: number) => {
    if (!track) return desiredStart
    if (!willOverlap(track.clips, null, desiredStart, duration)) return desiredStart
    return calcNonOverlapStart(track.clips, null, desiredStart, duration)
  }

  const resolveInsertSample = (input: InsertSampleInput): InsertSampleInput | null => {
    const duration = input.duration
    const assetKey = input.assetKey
    const sourceKind = input.sourceKind
    const source = input.source
    if (!(typeof duration === 'number' && duration > 0)) return null
    if (!assetKey || !sourceKind) return null
    if (!(typeof source?.durationSec === 'number' && source.durationSec > 0)) return null
    if (!(typeof source.sampleRate === 'number' && source.sampleRate > 0)) return null
    if (!(typeof source.channelCount === 'number' && source.channelCount > 0)) return null

    return {
      url: input.url,
      name: input.name,
      duration,
      assetKey,
      sourceKind,
      source,
    }
  }

  const createAudioSourceClip = async (input: {
    trackId: string
    startSec: number
    duration: number
    source: {
      durationSec: number
      sampleRate: number
      channelCount: number
    }
    url: string
    name?: string
    assetKey: string
    sourceKind: AudioSourceKind
  }) => {
    const rid = roomId()
    const clipName = input.name?.trim()?.length ? input.name : 'Sample'
    const clipSnapshot: ClipCreateSnapshot = {
      startSec: input.startSec,
      duration: input.duration,
      name: clipName,
      sampleUrl: input.url,
      source: input.source,
      sourceAssetKey: input.assetKey,
      sourceKind: input.sourceKind,
    }

    const createdClipId = await createServerClip(input.trackId, clipSnapshot)
    if (!createdClipId) return null
    grantClipWrite?.(createdClipId)

    insertOptimisticClip(input.trackId, buildLocalClip({
      id: createdClipId,
      clip: clipSnapshot,
    }))

    applySelectionAfterCreate(input.trackId, createdClipId)
    pushClipCreateHistory({
      historyPush: options.historyPush,
      roomId: rid,
      trackId: input.trackId,
      trackRef: getTrackHistoryRef(tracks().find((entry) => entry.id === input.trackId)),
      clipId: createdClipId,
      clip: clipSnapshot,
    })

    return createdClipId
  }

  const handleFilesInternal = async (file: File, trackId?: string, desiredStart?: number) => {
    const ab = await file.arrayBuffer()
    const decoded = await audioEngine.decodeAudioData(ab)
    const sourceMetadata = getAudioSourceMetadata(decoded)
    const sourceAssetKey = createAudioAssetKey()

    const targetTrack = await ensureTargetAudioTrack(trackId)
    if (!targetTrack) return
    const resolvedTrackId = targetTrack.id
    const startSec = resolveClipStartSec(
      targetTrack,
      typeof desiredStart === 'number' ? desiredStart : playheadSec(),
      decoded.duration,
    )

    const rid = roomId()
    const uid = userId()
    if (!rid || !uid) return

    try {
      await createUploadedAudioClip({
        roomId: rid,
        userId: uid,
        trackId: resolvedTrackId,
        trackRef: getTrackHistoryRef(tracks().find((entry) => entry.id === resolvedTrackId)),
        startSec,
        file,
        decoded,
        source: sourceMetadata,
        sourceAssetKey,
        sourceKind: 'upload',
        createServerClip: async (payload) => await convexClient.mutation(convexApi.clips.create, payload as any) as any as string,
        insertLocalClip: insertOptimisticClip,
        selectClip: applySelectionAfterCreate,
        historyPush: options.historyPush,
        uploadToR2,
        audioBufferCache,
        grantClipWrite,
      })
    } catch {}
  }

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault()
    const dt = event.dataTransfer

    const placeUrlClip = async (
      input: InsertSampleInput,
    ) => {
      const resolved = resolveInsertSample(input)
      if (!resolved) return false
      const placement = await resolveDropPlacement(event.clientX, event.clientY, resolved.duration)
      if (!placement) return false
      await createAudioSourceClip({
        trackId: placement.track.id,
        startSec: placement.startSec,
        duration: resolved.duration,
        source: resolved.source,
        url: resolved.url,
        name: resolved.name,
        assetKey: resolved.assetKey,
        sourceKind: resolved.sourceKind,
      })
      return true
    }

    const samplePayload = dt?.getData('application/x-mediabunny-sample')
    if (samplePayload) {
      try {
        const parsed = JSON.parse(samplePayload) as InsertSampleInput
        if (parsed?.url) {
          if (await placeUrlClip(parsed)) return
        }
      } catch {}
    }

    const file = dt?.files?.[0]
    if (!file || !file.type.startsWith('audio')) return

    const scroll = getScrollElement()
    if (!scroll) return
    const targetTrack = await resolveDropTargetTrack(event.clientY)
    if (!targetTrack) return
    await handleFilesInternal(file, targetTrack.id, clientXToSec(event.clientX, scroll))
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const file = Array.from(files).find(f => f.type.startsWith('audio'))
    if (!file) return
    await handleFilesInternal(file)
  }

  const handleAddAudio = async () => {
    const w = window as unknown as { showOpenFilePicker?: (options: any) => Promise<any> }
    if (typeof w.showOpenFilePicker === 'function') {
      try {
        const handles: any[] = await w.showOpenFilePicker({
          multiple: false,
          types: [{
            description: 'Audio files',
            accept: { 'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.webm'] },
          }],
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

  const handleInsertSample = async (input: InsertSampleInput) => {
    if (!input.url) return
    const targetTrack = await ensureTargetAudioTrack(undefined, '[Import] Cannot insert audio into this track')
    if (!targetTrack) return
    const resolved = resolveInsertSample(input)
    if (!resolved) return
    const startSec = resolveClipStartSec(targetTrack, playheadSec(), resolved.duration)

    await createAudioSourceClip({
      trackId: targetTrack.id,
      startSec,
      duration: resolved.duration,
      source: resolved.source,
      url: resolved.url,
      name: resolved.name,
      assetKey: resolved.assetKey,
      sourceKind: resolved.sourceKind,
    })
  }

  return {
    handleDrop,
    handleFiles,
    handleAddAudio,
    handleInsertSample,
  }
}
