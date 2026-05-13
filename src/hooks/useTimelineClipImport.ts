import type { Accessor } from 'solid-js'

import { buildClipCreatePayload, buildLocalClip, createUploadedAudioClip, pushClipCreateHistory, type ClipCreateSnapshot } from '~/lib/clip-create'
import { createAudioAssetKey, getAudioSourceMetadata, type AudioSourceKind } from '~/lib/audio-source'
import type { AudioEngine } from '~/lib/audio-engine'
import { canTrackReceiveAudioClip, getTrackChannelRole } from '~/lib/track-routing'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { parseSampleDragData, SAMPLE_DRAG_DATA_TYPE, type SampleDragData } from '~/lib/sample-drag-data'
import { clientXToSec, yToLaneIndex, willOverlap, calcNonOverlapStart, quantizeSecToGrid, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'
import { createOptimisticTrackWithHistory } from '~/lib/tracks'
import type { Clip, Track } from '~/types/timeline'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type UploadToR2 = (
  roomId: string,
  assetKey: string,
  file: File,
  durationSec?: number,
) => Promise<string | null>

export type InsertSampleInput = SampleDragData

type TimelineClipImportOptions = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  insertLocalTrack: (track: Track, index: number) => void
  insertLocalClip: (trackId: Track['id'], clip: Clip) => void
  selection: TimelineSelectionController
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
  grantWrite?: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
  grantClipWrite?: (clipId: string, scope?: OptimisticGrantScope | null) => void
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
    insertLocalTrack,
    insertLocalClip,
    selection,
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
      insertLocalTrack,
      index: tracks().length,
      grantWrite,
      grantScope: { roomId: rid, userId: uid },
      historyPush: options.historyPush,
    })
    if (!track) return null

    selection.selectTrackTarget(track.id)
    return track
  }

  const ensureTargetAudioTrack = async (trackId?: Track['id'], message?: string) => {
    if (trackId) {
      return requireAudioTrack(tracks().find((track) => track.id === trackId), message)
    }

    const selectedId = selection.selectedTrackId()
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

  const createServerClip = async (trackId: Track['id'], clip: ClipCreateSnapshot) => {
    const rid = roomId()
    const uid = userId()
    if (!rid || !uid) return null
    return await convexClient.mutation(
      convexApi.clips.create,
      buildClipCreatePayload({ roomId: rid, userId: uid, trackId, clip }),
    )
  }

  const applySelectionAfterCreate = (trackId: Track['id'], clipId: string) => {
    selection.selectPrimaryClip({ trackId, clipId })
  }

  const ensureNonOverlappingStart = (track: Track | undefined, desiredStart: number, duration: number) => {
    if (!track) return desiredStart
    if (!willOverlap(track.clips, null, desiredStart, duration)) return desiredStart
    return calcNonOverlapStart(track.clips, null, desiredStart, duration)
  }

  const createAudioSourceClip = async (input: {
    trackId: Track['id']
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
    const uid = userId()
    const grantScope = rid && uid ? { roomId: rid, userId: uid } : null
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
    grantClipWrite?.(createdClipId, grantScope)

    insertLocalClip(input.trackId, buildLocalClip({
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

  const handleFilesInternal = async (file: File, trackId?: Track['id'], desiredStart?: number) => {
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
        createServerClip: async (payload) => await convexClient.mutation(convexApi.clips.create, payload),
        insertLocalClip,
        selectClip: applySelectionAfterCreate,
        historyPush: options.historyPush,
        uploadToR2,
        audioBufferCache,
        grantClipWrite,
        grantScope: { roomId: rid, userId: uid },
      })
    } catch {}
  }

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault()
    const dt = event.dataTransfer

    const placeUrlClip = async (
      input: InsertSampleInput | null,
    ) => {
      if (!input) return false
      const placement = await resolveDropPlacement(event.clientX, event.clientY, input.duration)
      if (!placement) return false
      await createAudioSourceClip({
        trackId: placement.track.id,
        startSec: placement.startSec,
        duration: input.duration,
        source: input.source,
        url: input.url,
        name: input.name,
        assetKey: input.assetKey,
        sourceKind: input.sourceKind,
      })
      return true
    }

    const samplePayload = dt?.getData(SAMPLE_DRAG_DATA_TYPE)
    if (samplePayload && await placeUrlClip(parseSampleDragData(samplePayload))) return

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

  const isAbortError = (error: unknown) => {
    if (error instanceof DOMException) return error.name === 'AbortError'
    return false
  }

  const handleAddAudio = async () => {
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [fileHandle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: 'Audio files',
            accept: { 'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.webm'] },
          }],
        })
        if (!fileHandle) return
        const file = await fileHandle.getFile()
        if (!file || !file.type.startsWith('audio')) return
        await handleFilesInternal(file)
        return
      } catch (error) {
        if (isAbortError(error)) return
      }
    }
    getFileInput()?.click()
  }

  const handleInsertSample = async (input: InsertSampleInput) => {
    const targetTrack = await ensureTargetAudioTrack(undefined, '[Import] Cannot insert audio into this track')
    if (!targetTrack) return
    const startSec = resolveClipStartSec(targetTrack, playheadSec(), input.duration)

    await createAudioSourceClip({
      trackId: targetTrack.id,
      startSec,
      duration: input.duration,
      source: input.source,
      url: input.url,
      name: input.name,
      assetKey: input.assetKey,
      sourceKind: input.sourceKind,
    })
  }

  return {
    handleDrop,
    handleFiles,
    handleAddAudio,
    handleInsertSample,
  }
}
