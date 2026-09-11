import type { Accessor } from 'solid-js'

import type { ClipCreateSnapshot } from '@daw-browser/shared'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { ClipBuffers } from '~/lib/clip-buffer-cache'
import { isLocalId } from '@daw-browser/shared'
import { canTrackReceiveAudioClip, getTrackChannelRole } from '@daw-browser/timeline-core/track-routing'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { parseSampleDragData, SAMPLE_DRAG_DATA_TYPE, type SampleDragData } from '~/lib/sample-drag-data'
import { clientYToTimelineTrackY, calcNonOverlapStart, quantizeSecToGrid, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import { trackIndexAtY, type TimelineTrackLayoutRow } from '~/lib/timeline-track-layout'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { createAudioImportTransaction } from '~/lib/timeline-audio-import'
import { readAudioFileMetadata } from '~/lib/media/audio-file-metadata'
import { buildTrackClipCreateHistoryEntry } from '~/lib/undo/builders'
import { isAbortError } from '~/lib/dom-errors'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

import type { TimelineSelectionController } from './useTimelineSelectionState'
import type { UploadToR2 } from './useClipBuffers'

export type InsertSampleInput = SampleDragData

type CreateTimelineTrack = (
  options?: { kind?: 'audio' | 'instrument'; channelRole?: 'track' | 'return' | 'group' },
  behavior?: { pushHistory?: boolean; select?: boolean },
) => Promise<Track | null>

type TimelineClipImportOptions = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  trackLayout: Accessor<TimelineTrackLayoutRow[]>
  removeLocalTrack: (trackId: Track['id']) => void
  insertLocalClip: (trackId: Track['id'], clip: Clip) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  selection: TimelineSelectionController
  playheadSec: Accessor<number>
  projectId: Accessor<string | undefined>
  mountedProjectGeneration: Accessor<number>
  userId: Accessor<string | undefined>
  clipBuffers: ClipBuffers & { uploadToR2: UploadToR2 }
  getScrollElement: () => HTMLDivElement | undefined
  getFileInput: () => HTMLInputElement | undefined
  bpm: Accessor<number>
  gridEnabled: Accessor<boolean>
  gridDenominator: Accessor<number>
  pixelsPerSecond: Accessor<number>
  visibleStartSec?: Accessor<number>
  createTimelineTrack: CreateTimelineTrack
  removeCreatedCloudTrack: (track: Track | undefined) => Promise<void>
  historyPush: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  grantClipWrite?: (clipId: string, scope?: OptimisticGrantScope | null) => void
  onLocalSaveFailed?: (message: string) => void
  notify: (title: string, message: string) => void
  onDecodedClipCreated?: (clip: Clip<AudioBuffer>) => void
}

export type ImportProjectBinding = {
  projectId: string
  mountedProjectGeneration: number
}

type TimelineClipImportHandlers = {
  handleDrop: (event: DragEvent) => Promise<void>
  handleFiles: (files: FileList | null) => Promise<void>
  importFiles: (files: readonly File[], signal?: AbortSignal, binding?: ImportProjectBinding) => Promise<ImportSummary>
  handleAddAudio: () => Promise<void>
  handleInsertSample: (input: InsertSampleInput) => Promise<void>
}

export type ImportFileOutcome = {
  fileName: string
  status: 'created' | 'queued' | 'skipped' | 'local-save-failed' | 'failed' | 'canceled'
  message?: string
  assetId?: string
  clipId?: string
  operationId?: string
}

export type ImportSummary = {
  outcomes: readonly ImportFileOutcome[]
}

type TargetAudioTrack = {
  track: Track
  autoCreated: boolean
}

export function useTimelineClipImport(options: TimelineClipImportOptions): TimelineClipImportHandlers {
  const {
    tracks,
    trackLayout,
    removeLocalTrack,
    insertLocalClip,
    removeLocalClips,
    selection,
    playheadSec,
    projectId,
    userId,
    clipBuffers,
    getScrollElement,
    getFileInput,
    bpm,
    gridEnabled,
    gridDenominator,
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
  const assertCurrentImport = (binding: ImportProjectBinding, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (projectId() !== binding.projectId || options.mountedProjectGeneration() !== binding.mountedProjectGeneration) {
      throw new DOMException('The audio import was canceled.', 'AbortError')
    }
  }

  const createAudioTrack = () => options.createTimelineTrack({}, { pushHistory: false, select: true })

  const removeAutoCreatedLocalTrack = async (rid: string, track: Track | undefined) => {
    if (!track || !isLocalId('project', rid)) return
    await createLocalTimelineRepository(rid).deleteTrack(track.id)
    if (projectId() === rid) removeLocalTrack(track.id)
  }

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

  const resolveClipStartSec = (track: Track, desiredStart: number, duration: number) => {
    const startSec = gridEnabled()
      ? quantizeSecToGrid(Math.max(0, desiredStart), bpm(), gridDenominator(), 'round')
      : Math.max(0, desiredStart)
    return gridEnabled()
      ? calcNonOverlapStartGridAligned(track.clips, null, startSec, duration, bpm(), gridDenominator())
      : calcNonOverlapStart(track.clips, null, startSec, duration)
  }

  const resolveDropTargetTrack = async (clientY: number): Promise<TargetAudioTrack | null> => {
    const scroll = getScrollElement()
    if (!scroll) return null

    const y = clientYToTimelineTrackY(clientY, scroll)
    const laneIdx = trackIndexAtY(trackLayout(), y)
    const snapshot = tracks()
    const row = laneIdx >= 0 ? trackLayout()[laneIdx] : undefined
    if (snapshot.length === 0 || !row) {
      const created = await createAudioTrack()
      return created ? { track: created, autoCreated: true } : null
    }
    const track = requireAudioTrack(snapshot.find((entry) => entry.id === row.trackId))
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
      startSec: resolveClipStartSec(
        targetTrack.track,
        (options.visibleStartSec?.() ?? 0)
          + (clientX - scroll.getBoundingClientRect().left) / options.pixelsPerSecond(),
        duration,
      ),
    }
  }

  const applySelectionAfterCreate = (trackId: Track['id'], clipId: string) => {
    selection.selectPrimaryClip({ trackId, clipId })
  }

  const audioImportTransaction = createAudioImportTransaction({
    project: {
      projectId,
      userId,
      tracks,
      isActiveProjectTrack,
    },
    clips: {
      buffers: clipBuffers,
      insertLocalClip,
      removeLocalClips,
      selectClip: applySelectionAfterCreate,
      historyPush: options.historyPush,
      pushTrackClipCreateHistory: pushLocalTrackClipCreateHistory,
      grantClipWrite,
      onClipCreated: options.onDecodedClipCreated,
    },
    cloud: {
      uploadToR2: clipBuffers.uploadToR2,
    },
    rollback: {
      removeLocalTrack: removeAutoCreatedLocalTrack,
      removeCloudTrack: options.removeCreatedCloudTrack,
    },
    onLocalSaveFailed: options.onLocalSaveFailed,
  })

  const handleFilesInternal = async (
    file: File,
    trackId?: Track['id'],
    desiredStart?: number,
    autoCreatedTrack?: Track,
    signal?: AbortSignal,
    binding?: ImportProjectBinding,
  ): Promise<ImportFileOutcome> => {
    const importBinding = binding ?? {
      projectId: projectId() ?? '',
      mountedProjectGeneration: options.mountedProjectGeneration(),
    }
    assertCurrentImport(importBinding, signal)
    signal?.throwIfAborted()
    const source = await readAudioFileMetadata(file, signal)
    assertCurrentImport(importBinding, signal)
    const target = await ensureTargetAudioTrack(trackId)
    assertCurrentImport(importBinding, signal)
    if (!target) return { fileName: file.name, status: 'skipped' }
    const startSec = resolveClipStartSec(
      target.track,
      desiredStart ?? playheadSec(),
      source.durationSec,
    )
    const result = await audioImportTransaction.createUploadedFileClip({
      file,
      source,
      track: target.track,
      startSec,
      autoCreatedTrack: autoCreatedTrack ?? (target.autoCreated ? target.track : undefined),
      signal,
      projectId: importBinding.projectId,
      isCurrentProject: () => projectId() === importBinding.projectId
        && options.mountedProjectGeneration() === importBinding.mountedProjectGeneration,
    })
    if (result.status === 'local-save-failed' || result.status === 'failed') {
      notify('Audio import failed', result.message)
    }
    return {
      fileName: file.name,
      status: result.status,
      message: 'message' in result ? result.message : undefined,
      assetId: 'assetId' in result ? result.assetId : undefined,
      clipId: 'clipId' in result ? result.clipId : undefined,
      operationId: 'operationId' in result ? result.operationId : undefined,
    }
  }

  const importFiles = async (
    files: readonly File[],
    signal?: AbortSignal,
    binding?: ImportProjectBinding,
  ): Promise<ImportSummary> => {
    const importBinding = binding ?? {
      projectId: projectId() ?? '',
      mountedProjectGeneration: options.mountedProjectGeneration(),
    }
    assertCurrentImport(importBinding, signal)
    const outcomes: ImportFileOutcome[] = []
    for (const file of files) {
      if (signal?.aborted) {
        outcomes.push({ fileName: file.name, status: 'canceled' })
        continue
      }
      if (projectId() !== importBinding.projectId
        || options.mountedProjectGeneration() !== importBinding.mountedProjectGeneration) {
        outcomes.push({ fileName: file.name, status: 'canceled' })
        continue
      }
      if (!file.type.startsWith('audio')) {
        outcomes.push({ fileName: file.name, status: 'skipped' })
        continue
      }
      try {
        const outcome = await handleFilesInternal(file, undefined, undefined, undefined, signal, importBinding)
        outcomes.push(outcome)
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) outcomes.push({ fileName: file.name, status: 'canceled' })
        else outcomes.push({ fileName: file.name, status: 'failed', message: 'Audio could not be imported. Please retry the import.' })
      }
    }
    return { outcomes }
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
      (options.visibleStartSec?.() ?? 0)
        + (event.clientX - scroll.getBoundingClientRect().left) / options.pixelsPerSecond(),
      targetTrack.autoCreated ? targetTrack.track : undefined,
    )
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const file = Array.from(files).find(f => f.type.startsWith('audio'))
    if (!file) return
    await importFiles([file])
  }

  const handleAddAudio = async () => {
    if (window.showOpenFilePicker) {
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
    importFiles,
    handleAddAudio,
    handleInsertSample,
  }
}
