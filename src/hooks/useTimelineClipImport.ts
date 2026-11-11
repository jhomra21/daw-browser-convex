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
  onLocalSaveFailed?: (projectId: string, message: string) => void
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

  const removeCreatedTrack = async (rid: string, track: Track) => {
    if (isLocalId('project', rid)) {
      await removeAutoCreatedLocalTrack(rid, track)
    } else {
      await options.removeCreatedCloudTrack(track)
    }
  }

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
      if (track && (getTrackChannelRole(track) !== 'track' || !canTrackReceiveAudioClip(track))) {
        const created = await createAudioTrack()
        return created ? { track: created, autoCreated: true } : null
      }
      const selectedTrack = requireAudioTrack(track, message ?? '[Import] Cannot add audio to this track')
      return selectedTrack ? { track: selectedTrack, autoCreated: false } : null
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

  const resolveDropTargetTrack = async (
    clientY: number,
    binding: ImportProjectBinding,
  ): Promise<TargetAudioTrack | null> => {
    assertCurrentImport(binding)
    const scroll = getScrollElement()
    if (!scroll) return null

    const y = clientYToTimelineTrackY(clientY, scroll)
    const laneIdx = trackIndexAtY(trackLayout(), y)
    const snapshot = tracks()
    const row = laneIdx >= 0 ? trackLayout()[laneIdx] : undefined
    if (snapshot.length === 0 || !row) {
      const created = await createAudioTrack()
      if (projectId() !== binding.projectId
        || options.mountedProjectGeneration() !== binding.mountedProjectGeneration) {
        if (created) await removeCreatedTrack(binding.projectId, created)
        return null
      }
      return created ? { track: created, autoCreated: true } : null
    }
    const track = requireAudioTrack(snapshot.find((entry) => entry.id === row.trackId))
    return track ? { track, autoCreated: false } : null
  }

  const resolveDropPlacement = async (
    clientX: number,
    clientY: number,
    duration: number,
    binding: ImportProjectBinding,
  ) => {
    const scroll = getScrollElement()
    if (!scroll) return null
    const targetTrack = await resolveDropTargetTrack(clientY, binding)
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
    dropPlacement?: {
      source: Awaited<ReturnType<typeof readAudioFileMetadata>>
      startSec: number
      reportFailure: (message: string) => void
    },
  ): Promise<ImportFileOutcome> => {
    const importBinding = binding ?? {
      projectId: projectId() ?? '',
      mountedProjectGeneration: options.mountedProjectGeneration(),
    }
    assertCurrentImport(importBinding, signal)
    signal?.throwIfAborted()
    let source: Awaited<ReturnType<typeof readAudioFileMetadata>>
    try {
      source = dropPlacement?.source ?? await readAudioFileMetadata(file, signal)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error
      const message = error instanceof Error ? error.message : 'Audio file could not be read.'
      const reportFailure = dropPlacement?.reportFailure ?? ((failure: string) => notify('Audio import failed', failure))
      reportFailure(`${file.name}: ${message}`)
      return { fileName: file.name, status: 'failed', message }
    }
    assertCurrentImport(importBinding, signal)
    const target = await ensureTargetAudioTrack(trackId, 'The requested track cannot receive audio clips.')
    try {
      assertCurrentImport(importBinding, signal)
    } catch (error) {
      if (target?.autoCreated) await removeCreatedTrack(importBinding.projectId, target.track)
      throw error
    }
    if (!target) {
      const message = trackId
        ? 'The requested track cannot receive audio clips.'
        : 'An audio track could not be created for this import.'
      const reportFailure = dropPlacement?.reportFailure ?? ((failure: string) => notify('Audio import failed', failure))
      reportFailure(`${file.name}: ${message}`)
      return {
        fileName: file.name,
        status: 'skipped',
        message,
      }
    }
    const startSec = dropPlacement?.startSec
      ?? resolveClipStartSec(target.track, desiredStart ?? playheadSec(), source.durationSec)
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
    if (result.status === 'failed' || result.status === 'skipped') {
      const reportFailure = dropPlacement?.reportFailure ?? ((failure: string) => notify('Audio import failed', failure))
      const message = 'message' in result
        ? result.message
        : 'Audio import requires an active project and user.'
      reportFailure(`${file.name}: ${message}`)
    }
    return {
      fileName: file.name,
      status: result.status,
      message: 'message' in result
        ? result.message
        : result.status === 'skipped'
          ? 'Audio import requires an active project and user.'
          : undefined,
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
      try {
        const outcome = await handleFilesInternal(file, undefined, undefined, undefined, signal, importBinding)
        outcomes.push(outcome)
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) outcomes.push({ fileName: file.name, status: 'canceled' })
        else {
          const message = error instanceof Error ? error.message : 'Audio could not be imported. Please retry the import.'
          notify('Audio import failed', `${file.name}: ${message}`)
          outcomes.push({ fileName: file.name, status: 'failed', message })
        }
      }
    }
    return { outcomes }
  }

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault()
    const dt = event.dataTransfer
    const clientX = event.clientX
    const clientY = event.clientY
    const binding = {
      projectId: projectId() ?? '',
      mountedProjectGeneration: options.mountedProjectGeneration(),
    }

    const placeUrlClip = async (
      input: InsertSampleInput | null,
    ) => {
      if (!input) return false
      assertCurrentImport(binding)
      const placement = await resolveDropPlacement(event.clientX, event.clientY, input.duration, binding)
      if (!placement) return false
      try {
        assertCurrentImport(binding)
      } catch (error) {
        if (placement.autoCreatedTrack) {
          await removeCreatedTrack(binding.projectId, placement.autoCreatedTrack)
        }
        if (isAbortError(error)) return true
        throw error
      }
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

    const files = Array.from(dt?.files ?? [])
    if (files.length === 0) return
    const scroll = getScrollElement()
    if (!scroll) return
    const scrollBounds = scroll.getBoundingClientRect()
    const desiredStart = (options.visibleStartSec?.() ?? 0)
      + (clientX - scrollBounds.left) / options.pixelsPerSecond()
    const dropY = clientYToTimelineTrackY(clientY, scroll)
    const layout = trackLayout()
    const laneIndex = trackIndexAtY(layout, dropY)
    const lane = laneIndex >= 0 ? layout[laneIndex] : undefined
    const capturedTrackId = lane?.trackId
    const tracksAtDrop = tracks()
    const createTrackForDrop = !capturedTrackId
      && (tracksAtDrop.length === 0 || !lane)
    let targetTrackId = capturedTrackId
    let uncommittedCreatedTrack: Track | undefined
    let nextDesiredStart = desiredStart
    const failures: string[] = []
    const reportFailure = (message: string) => failures.push(message)

    for (const file of files) {
      if (projectId() !== binding.projectId
        || options.mountedProjectGeneration() !== binding.mountedProjectGeneration) break

      let source: Awaited<ReturnType<typeof readAudioFileMetadata>>
      try {
        source = await readAudioFileMetadata(file)
        assertCurrentImport(binding)
      } catch (error) {
        if (isAbortError(error)) break
        const message = error instanceof Error ? error.message : 'Audio file could not be read.'
        reportFailure(`${file.name}: ${message}`)
        continue
      }

      let targetTrack = targetTrackId
        ? tracks().find((track) => track.id === targetTrackId)
        : undefined
      if (targetTrackId && (!targetTrack || !canTrackReceiveAudioClip(targetTrack))) {
        reportFailure(`${file.name}: The drop target cannot receive audio clips.`)
        continue
      }

      if (!targetTrack && createTrackForDrop) {
        try {
          assertCurrentImport(binding)
          targetTrack = await createAudioTrack() ?? undefined
          assertCurrentImport(binding)
        } catch (error) {
          if (targetTrack) await removeCreatedTrack(binding.projectId, targetTrack)
          if (isAbortError(error)) break
          const message = error instanceof Error ? error.message : 'An audio track could not be created.'
          reportFailure(`${file.name}: ${message}`)
          continue
        }
        if (!targetTrack) {
          reportFailure(`${file.name}: An audio track could not be created.`)
          continue
        }
        targetTrackId = targetTrack.id
        uncommittedCreatedTrack = targetTrack
      }
      if (!targetTrack) {
        reportFailure(`${file.name}: No audio track is available at the drop location.`)
        continue
      }

      try {
        const startSec = resolveClipStartSec(targetTrack, nextDesiredStart, source.durationSec)
        const outcome = await handleFilesInternal(
          file,
          targetTrack.id,
          nextDesiredStart,
          uncommittedCreatedTrack,
          undefined,
          binding,
          { source, startSec, reportFailure },
        )
        if (outcome.status === 'created' || outcome.status === 'queued') {
          const placementEnd = startSec + source.durationSec
          nextDesiredStart = gridEnabled()
            ? quantizeSecToGrid(placementEnd, bpm(), gridDenominator(), 'ceil')
            : placementEnd
          uncommittedCreatedTrack = undefined
        } else if (uncommittedCreatedTrack && !isActiveProjectTrack(binding.projectId, uncommittedCreatedTrack.id)) {
          targetTrackId = undefined
          uncommittedCreatedTrack = undefined
        }
      } catch (error) {
        if (uncommittedCreatedTrack && !isActiveProjectTrack(binding.projectId, uncommittedCreatedTrack.id)) {
          targetTrackId = undefined
          uncommittedCreatedTrack = undefined
        }
        if (isAbortError(error)) break
        const message = error instanceof Error ? error.message : 'Audio could not be imported. Please retry the import.'
        reportFailure(`${file.name}: ${message}`)
      }
    }
    if (failures.length > 0
      && projectId() === binding.projectId
      && options.mountedProjectGeneration() === binding.mountedProjectGeneration) {
      notify('Audio import failed', failures.join('\n'))
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const file = Array.from(files)[0]
    if (!file) return
    await importFiles([file])
  }

  const handleAddAudio = async () => {
    if (window.showOpenFilePicker) {
      let fileHandle: FileSystemFileHandle | undefined
      try {
        ;[fileHandle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: 'Audio files',
            accept: { 'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.webm'] },
          }],
        })
      } catch (error) {
        if (isAbortError(error)) return
        getFileInput()?.click()
        return
      }
      if (!fileHandle) return
      try {
        const file = await fileHandle.getFile()
        await importFiles([file])
      } catch (error) {
        if (!isAbortError(error)) {
          const message = error instanceof Error ? error.message : 'Audio file could not be read.'
          notify('Audio import failed', message)
        }
      }
      return
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
