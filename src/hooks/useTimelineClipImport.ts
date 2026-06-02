import type { Accessor } from 'solid-js'

import type { ClipCreateSnapshot } from '~/lib/clip-create'
import type { AudioEngine } from '~/lib/audio-engine'
import { isLocalId } from '~/lib/local-ids'
import { canTrackReceiveAudioClip, getTrackChannelRole } from '~/lib/track-routing'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { parseSampleDragData, SAMPLE_DRAG_DATA_TYPE, type SampleDragData } from '~/lib/sample-drag-data'
import { clientXToSec, yToLaneIndex, willOverlap, calcNonOverlapStart, quantizeSecToGrid, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { toLocalTimelineTrack } from '~/lib/timeline-repository/track-row-adapter'
import { createAudioImportTransaction, removeAutoCreatedCloudTrack } from '~/lib/timeline-audio-import'
import { buildTrackClipCreateHistoryEntry } from '~/lib/undo/builders'
import type { HistoryEntry } from '~/lib/undo/types'
import { createOptimisticTrack } from '~/lib/tracks'
import type { Clip, Track } from '~/types/timeline'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type UploadToR2 = (
  projectId: string,
  assetKey: string,
  file: File,
  durationSec?: number,
) => Promise<string | null>

export type InsertSampleInput = SampleDragData

type TimelineClipImportOptions = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  insertLocalTrack: (track: Track, index: number) => void
  removeLocalTrack: (trackId: Track['id']) => void
  insertLocalClip: (trackId: Track['id'], clip: Clip) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  selection: TimelineSelectionController
  playheadSec: Accessor<number>
  projectId: Accessor<string | undefined>
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
  historyPush: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  grantWrite?: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
  grantClipWrite?: (clipId: string, scope?: OptimisticGrantScope | null) => void
  onLocalSaveFailed?: (message: string) => void
  notify: (title: string, message: string) => void
}

type TimelineClipImportHandlers = {
  handleDrop: (event: DragEvent) => Promise<void>
  handleFiles: (files: FileList | null) => Promise<void>
  handleAddAudio: () => Promise<void>
  handleInsertSample: (input: InsertSampleInput) => Promise<void>
}

type TargetAudioTrack = {
  track: Track
  autoCreated: boolean
}

export function useTimelineClipImport(options: TimelineClipImportOptions): TimelineClipImportHandlers {
  const {
    audioEngine,
    tracks,
    insertLocalTrack,
    removeLocalTrack,
    insertLocalClip,
    removeLocalClips,
    selection,
    playheadSec,
    projectId,
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
    notify,
  } = options

  const requireAudioTrack = (track: Track | undefined, message = '[Import] Cannot insert audio into this track') => {
    if (!track || !canTrackReceiveAudioClip(track)) {
      console.warn(message)
      return null
    }
    return track
  }

  const isActiveProjectTrack = (rid: string, trackId: Track['id']) =>
    projectId() === rid && tracks().some((entry) => entry.id === trackId)

  const createAudioTrack = async () => {
    const rid = projectId()
    if (!rid) return null

    if (isLocalId('project', rid)) {
      const row = await createLocalTimelineRepository(rid).createTrack({ index: tracks().length })
      if (projectId() !== rid) {
        await createLocalTimelineRepository(rid).deleteTrack(row.id)
        return null
      }
      const track = toLocalTimelineTrack(row)
      insertLocalTrack(track, tracks().length)
      selection.selectTrackTarget(track.id)
      return track
    }

    const uid = userId()
    if (!uid) return null

    const track = await createOptimisticTrack({
      convexClient,
      convexApi,
      projectId: rid,
      userId: uid,
      insertLocalTrack,
      index: tracks().length,
      grantWrite,
      grantScope: { projectId: rid, userId: uid },
    })
    if (!track) return null

    selection.selectTrackTarget(track.id)
    return track
  }

  const removeAutoCreatedLocalTrack = async (rid: string, track: Track | undefined) => {
    if (!track || !rid || !isLocalId('project', rid)) return
    await createLocalTimelineRepository(rid).deleteTrack(track.id)
    if (projectId() === rid) removeLocalTrack(track.id)
  }

  const removeCreatedCloudTrack = async (track: Track | undefined) => await removeAutoCreatedCloudTrack({
    convexClient,
    convexApi,
    userId: userId(),
    track,
    removeLocalTrack,
  })

  const pushLocalTrackClipCreateHistory = (track: Track, clipId: string, clip: ClipCreateSnapshot) => {
    const historyPush = options.historyPush
    const rid = projectId()
    if (!rid) return
    historyPush(buildTrackClipCreateHistoryEntry({ projectId: rid, track, tracks: tracks(), clipId, clip }))
  }

  const ensureTargetAudioTrack = async (trackId?: Track['id'], message?: string): Promise<TargetAudioTrack | null> => {
    if (trackId) {
      const track = requireAudioTrack(tracks().find((track) => track.id === trackId), message)
      return track ? { track, autoCreated: false } : null
    }

    const selectedId = selection.selectedTrackId()
    if (selectedId) {
      const track = tracks().find((item) => item.id === selectedId)
      if (track && getTrackChannelRole(track) !== 'track') {
        const created = await createAudioTrack()
        return created ? { track: created, autoCreated: true } : null
      }
      const selectedTrack = requireAudioTrack(track, message ?? '[Import] Cannot add audio to this track')
      if (!selectedTrack) return null
      return { track: selectedTrack, autoCreated: false }
    }

    const created = await createAudioTrack()
    return created ? { track: created, autoCreated: true } : null
  }

  const resolveClipStartSec = (track: Track | undefined, desiredStart: number, duration: number) => {
    const startSec = gridEnabled()
      ? quantizeSecToGrid(Math.max(0, desiredStart), bpm(), gridDenominator(), 'round')
      : Math.max(0, desiredStart)
    return gridEnabled()
      ? calcNonOverlapStartGridAligned(track?.clips ?? [], null, startSec, duration, bpm(), gridDenominator())
      : ensureNonOverlappingStart(track, startSec, duration)
  }

  const resolveDropTargetTrack = async (clientY: number): Promise<TargetAudioTrack | null> => {
    const scroll = getScrollElement()
    if (!scroll) return null

    let laneIdx = yToLaneIndex(clientY, scroll)
    const snapshot = tracks()
    if (snapshot.length === 0 || laneIdx >= snapshot.length || laneIdx < 0) {
      const created = await createAudioTrack()
      return created ? { track: created, autoCreated: true } : null
    }
    const track = requireAudioTrack(snapshot[Math.max(0, Math.min(laneIdx, snapshot.length - 1))])
    return track ? { track, autoCreated: false } : null
  }

  const resolveDropPlacement = async (clientX: number, clientY: number, duration: number) => {
    const scroll = getScrollElement()
    if (!scroll) return null
    const targetTrack = await resolveDropTargetTrack(clientY)
    if (!targetTrack) return null

    return {
      track: targetTrack.track,
      autoCreatedTrack: targetTrack.autoCreated ? targetTrack.track : undefined,
      startSec: resolveClipStartSec(targetTrack.track, clientXToSec(clientX, scroll), duration),
    }
  }

  const applySelectionAfterCreate = (trackId: Track['id'], clipId: string) => {
    selection.selectPrimaryClip({ trackId, clipId })
  }

  const ensureNonOverlappingStart = (track: Track | undefined, desiredStart: number, duration: number) => {
    if (!track) return desiredStart
    if (!willOverlap(track.clips, null, desiredStart, duration)) return desiredStart
    return calcNonOverlapStart(track.clips, null, desiredStart, duration)
  }

  const audioImportTransaction = createAudioImportTransaction({
    project: {
      projectId,
      userId,
      tracks,
      isActiveProjectTrack,
    },
    clips: {
      audioEngine,
      audioBufferCache,
      insertLocalClip,
      removeLocalClips,
      selectClip: applySelectionAfterCreate,
      historyPush: options.historyPush,
      pushTrackClipCreateHistory: pushLocalTrackClipCreateHistory,
      grantClipWrite,
    },
    cloud: {
      convexClient,
      convexApi,
      uploadToR2,
    },
    rollback: {
      removeLocalTrack: removeAutoCreatedLocalTrack,
      removeCloudTrack: removeCreatedCloudTrack,
    },
    onLocalSaveFailed: options.onLocalSaveFailed,
  })

  const handleFilesInternal = async (
    file: File,
    trackId?: Track['id'],
    desiredStart?: number,
    autoCreatedTrack?: Track,
  ) => {
    const decoded = await audioEngine.decodeAudioData(await file.arrayBuffer())
    const target = await ensureTargetAudioTrack(trackId)
    if (!target) return
    const startSec = resolveClipStartSec(
      target.track,
      typeof desiredStart === 'number' ? desiredStart : playheadSec(),
      decoded.duration,
    )
    const result = await audioImportTransaction.createUploadedFileClip({
      file,
      decoded,
      track: target.track,
      startSec,
      autoCreatedTrack: autoCreatedTrack ?? (target.autoCreated ? target.track : undefined),
    })
    if (result.status === 'local-save-failed' || result.status === 'failed') {
      notify('Audio import failed', result.message)
    }
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
      await audioImportTransaction.createAudioSourceClip({
        trackId: placement.track.id,
        startSec: placement.startSec,
        duration: input.duration,
        source: input.source,
        url: input.url,
        name: input.name,
        assetKey: input.assetKey,
        sourceKind: input.sourceKind,
        autoCreatedTrack: placement.autoCreatedTrack,
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
    await handleFilesInternal(
      file,
      targetTrack.track.id,
      clientXToSec(event.clientX, scroll),
      targetTrack.autoCreated ? targetTrack.track : undefined,
    )
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
    const startSec = resolveClipStartSec(targetTrack.track, playheadSec(), input.duration)

    await audioImportTransaction.createAudioSourceClip({
      trackId: targetTrack.track.id,
      startSec,
      duration: input.duration,
      source: input.source,
      url: input.url,
      name: input.name,
      assetKey: input.assetKey,
      sourceKind: input.sourceKind,
      autoCreatedTrack: targetTrack.autoCreated ? targetTrack.track : undefined,
    })
  }

  return {
    handleDrop,
    handleFiles,
    handleAddAudio,
    handleInsertSample,
  }
}
