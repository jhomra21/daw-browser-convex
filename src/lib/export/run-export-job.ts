import type { ExportRange, ExportFx } from '@daw-browser/audio-engine/export-mixdown'
import type { ExportAudioFormat } from '@daw-browser/shared'
import { formatExportFileTimestamp, getExportAudioFormatMetadata, isLocalId, normalizeDelayParams, normalizeReverbParams, normalizeSaturatorParams } from '@daw-browser/shared'
import type { FunctionReturnType } from 'convex/server'

import { convexApi, convexClient } from '~/lib/convex'
import { saveCloudExport } from '~/lib/cloud-export'
import { isAbortError } from '~/lib/dom-errors'
import { chooseLocalExportDirectory, chooseLocalExportFile, createLocalExportDirectoryWritable, createLocalExportTarget, createLocalExportWritable, saveBlobLocally } from '~/lib/local-export'
import { chooseStemExportDirectory, createStemExportWritable, sanitizeStemFileName } from '~/lib/local-stem-export'
import { listLocalEffects, type LocalEffectRow } from '~/lib/local-effects'
import { saveLocalExportMetadataBatch, type LocalExportMetadataInput } from '~/lib/local-export-metadata'
import { runWithConcurrency } from '~/lib/run-with-concurrency'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number]

export type ExportPhase = 'preparing' | 'rendering' | 'encoding' | 'saving'

export type ExportProgress = {
  phase: ExportPhase
  sizeBytes?: number
  currentStemName?: string
  completedStems?: number
  totalStems?: number
  currentFormat?: ExportAudioFormat
  completedFormats?: number
  totalFormats?: number
}

export type TimelineExportRequest = {
  getTracks: () => RuntimeTrack[]
  bpm: number
  masterVolume: number
  range: ExportRange
  formats: readonly ExportAudioFormat[]
  projectId?: string
  userId?: string
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
  signal: AbortSignal
  onProgress?: (progress: ExportProgress) => void
}

export type StemExportMode = 'all-tracks' | 'selected-tracks'

export type StemExportRequest = TimelineExportRequest & {
  stemMode: StemExportMode
  selectedTrackIds?: readonly string[]
}

export type ExportOutput =
  | { destination: 'local'; name: string }
  | { destination: 'cloud'; name: string; url: string }

export type ExportOutcome =
  | { type: 'success'; outputs: readonly ExportOutput[] }
  | { type: 'canceled'; outputs: readonly ExportOutput[] }
  | { type: 'error'; message: string; outputs: readonly ExportOutput[] }

type TrackFxMap = NonNullable<ExportFx['trackFx']>
type TrackFxPatch = TrackFxMap[string]

const ensureTrackFxMap = (fx: ExportFx): TrackFxMap => {
  const trackFx = fx.trackFx ?? {}
  fx.trackFx = trackFx
  return trackFx
}

const applyTrackFxPatch = (trackFx: TrackFxMap, trackId: string, patch: TrackFxPatch) => {
  trackFx[trackId] = { ...(trackFx[trackId] ?? {}), ...patch }
}

const applyLocalEffectRowsToFx = (fx: ExportFx, rows: LocalEffectRow[]) => {
  const trackFx = ensureTrackFxMap(fx)
  for (const row of rows) {
    if (row.effect === 'master-eq') {
      fx.masterEq = row.params
      continue
    }
    if (row.effect === 'master-reverb') {
      fx.masterReverb = normalizeReverbParams(row.params)
      continue
    }
    if (row.effect === 'master-saturator') {
      fx.masterSaturator = normalizeSaturatorParams(row.params)
      continue
    }
    if (row.effect === 'master-delay') {
      fx.masterDelay = normalizeDelayParams(row.params)
      continue
    }
    if (row.effect === 'eq') applyTrackFxPatch(trackFx, row.targetId, { eq: row.params })
    if (row.effect === 'saturator') applyTrackFxPatch(trackFx, row.targetId, { saturator: normalizeSaturatorParams(row.params) })
    if (row.effect === 'delay') applyTrackFxPatch(trackFx, row.targetId, { delay: normalizeDelayParams(row.params) })
    if (row.effect === 'reverb') applyTrackFxPatch(trackFx, row.targetId, { reverb: normalizeReverbParams(row.params) })
    if (row.effect === 'arp') applyTrackFxPatch(trackFx, row.targetId, { arp: row.params })
    if (row.effect === 'synth') applyTrackFxPatch(trackFx, row.targetId, { synth: row.params })
  }
}

const applyRoomEffectRowsToFx = (fx: ExportFx, rows: RoomEffectRow[]) => {
  const trackFx = ensureTrackFxMap(fx)
  for (const row of rows) {
    if (row.targetType === 'master') {
      if (row.type === 'eq' && row.params) fx.masterEq = row.params
      if (row.type === 'saturator' && row.params) fx.masterSaturator = normalizeSaturatorParams(row.params)
      if (row.type === 'delay' && row.params) fx.masterDelay = normalizeDelayParams(row.params)
      if (row.type === 'reverb' && row.params) fx.masterReverb = normalizeReverbParams(row.params)
      continue
    }
    const trackId = row.trackId
    if (!trackId || !row.params) continue
    if (row.type === 'eq') applyTrackFxPatch(trackFx, trackId, { eq: row.params })
    if (row.type === 'saturator') applyTrackFxPatch(trackFx, trackId, { saturator: normalizeSaturatorParams(row.params) })
    if (row.type === 'delay') applyTrackFxPatch(trackFx, trackId, { delay: normalizeDelayParams(row.params) })
    if (row.type === 'reverb') applyTrackFxPatch(trackFx, trackId, { reverb: normalizeReverbParams(row.params) })
    if (row.type === 'arpeggiator') applyTrackFxPatch(trackFx, trackId, { arp: row.params })
    if (row.type === 'synth') applyTrackFxPatch(trackFx, trackId, { synth: row.params })
  }
}

const throwIfExportAborted = (signal: AbortSignal) => {
  signal.throwIfAborted()
}

const ENCODING_PROGRESS_STEP_BYTES = 256 * 1024
const MAX_CONCURRENT_BUFFER_LOADS = 4

const createEncodingProgressReporter = (
  report: (sizeBytes: number) => void,
): ((sizeBytes: number) => void) => {
  let lastReportedBytes = 0
  return (sizeBytes) => {
    if (sizeBytes - lastReportedBytes < ENCODING_PROGRESS_STEP_BYTES) return
    lastReportedBytes = sizeBytes
    report(sizeBytes)
  }
}

type ExportTrackSnapshotInput = Pick<TimelineExportRequest, 'ensureClipBuffer' | 'signal'> & {
  tracks: RuntimeTrack[]
  range: ExportRange
}

async function ensureBuffersForRange(input: ExportTrackSnapshotInput) {
  let rangeStart = 0
  let rangeEnd = 0
  if (input.range.mode === 'whole') {
    for (const track of input.tracks) {
      for (const clip of track.clips) {
        rangeEnd = Math.max(rangeEnd, clip.startSec + clip.duration)
      }
    }
  } else {
    rangeStart = input.range.startSec
    rangeEnd = input.range.endSec
  }
  const intersects = (clip: RuntimeClip) => {
    const clipStart = clip.startSec
    const clipEnd = clip.startSec + clip.duration
    return clipEnd > rangeStart && clipStart < rangeEnd
  }
  const jobs: (() => Promise<void>)[] = []
  for (const track of input.tracks) {
    for (const clip of track.clips) {
      if (clip.midi || !intersects(clip) || clip.buffer) continue
      jobs.push(() => input.ensureClipBuffer(clip.id, clip.sampleUrl))
    }
  }
  await runWithConcurrency(jobs, MAX_CONCURRENT_BUFFER_LOADS, async (job) => {
    throwIfExportAborted(input.signal)
    await job()
  })
  throwIfExportAborted(input.signal)
}

async function loadExportFx(projectId: string | undefined, userId: string | undefined, masterVolume: number): Promise<ExportFx> {
  const fx: ExportFx = { trackFx: {}, masterVolume }
  const localOnly = projectId ? isLocalId('project', projectId) : false
  if (localOnly && projectId) {
    try {
      applyLocalEffectRowsToFx(fx, await listLocalEffects(projectId))
    } catch {}
  }
  if (!localOnly && projectId && userId) {
    try {
      const rows = await convexClient.query(convexApi.effects.listByRoom, { projectId })
      applyRoomEffectRowsToFx(fx, rows)
    } catch {}
  }
  return fx
}

const isRenderableStemTrack = (track: RuntimeTrack): boolean => (
  (track.channelRole ?? 'track') === 'track' && track.clips.length > 0
)

const collectStemTracks = (input: Pick<StemExportRequest, 'stemMode' | 'selectedTrackIds'> & { tracks: RuntimeTrack[] }): RuntimeTrack[] => {
  if (input.stemMode === 'all-tracks') return input.tracks.filter(isRenderableStemTrack)
  const selectedIds = new Set(input.selectedTrackIds ?? [])
  return input.tracks.filter((track) => selectedIds.has(track.id) && isRenderableStemTrack(track))
}

const createUniqueStemFileName = (
  stemName: string,
  extension: string,
  usedNames: Set<string>,
): string => {
  const baseName = sanitizeStemFileName(stemName)
  let index = 1
  while (true) {
    const fileName = index === 1
      ? `${baseName}${extension}`
      : `${baseName} ${index}${extension}`
    if (!usedNames.has(fileName)) {
      usedNames.add(fileName)
      return fileName
    }
    index += 1
  }
}

const requireExportFormats = (formats: readonly ExportAudioFormat[]): readonly ExportAudioFormat[] => {
  const uniqueFormats = [...new Set(formats)]
  if (uniqueFormats.length === 0) throw new Error('Select at least one export format.')
  return uniqueFormats
}

const createMixdownFileName = (date: Date, format: ExportAudioFormat): string => {
  const metadata = getExportAudioFormatMetadata(format)
  return `mixdown_${formatExportFileTimestamp(date)}${metadata.fileExtension}`
}

const createSaveTypes = (format: ExportAudioFormat): FilePickerAcceptType[] => {
  const metadata = getExportAudioFormatMetadata(format)
  return [{ description: `${metadata.label} audio`, accept: { [metadata.mimeType]: [metadata.fileExtension] } }]
}

const reportFormatProgress = (
  input: Pick<TimelineExportRequest, 'onProgress'>,
  phase: Extract<ExportPhase, 'encoding' | 'saving'>,
  format: ExportAudioFormat,
  completedFormats: number,
  totalFormats: number,
  sizeBytes?: number,
) => {
  input.onProgress?.({ phase, currentFormat: format, completedFormats, totalFormats, sizeBytes })
}

const reportStemFormatProgress = (
  input: Pick<TimelineExportRequest, 'onProgress'>,
  phase: Extract<ExportPhase, 'encoding' | 'saving'>,
  format: ExportAudioFormat,
  track: RuntimeTrack,
  completedStems: number,
  totalStems: number,
  completedFormats: number,
  totalFormats: number,
  sizeBytes?: number,
) => {
  input.onProgress?.({
    phase,
    sizeBytes,
    currentFormat: format,
    currentStemName: track.name,
    completedStems,
    totalStems,
    completedFormats,
    totalFormats,
  })
}

export async function runTimelineExport(input: TimelineExportRequest): Promise<ExportOutcome> {
  const outputs: ExportOutput[] = []
  const localMetadataRows: LocalExportMetadataInput[] = []
  let localProjectId: string | undefined
  const saveCompletedLocalMetadata = async () => {
    if (!localProjectId) return
    await saveLocalExportMetadataBatch(localProjectId, localMetadataRows)
    localMetadataRows.length = 0
  }
  try {
    input.onProgress?.({ phase: 'preparing' })
    const formats = requireExportFormats(input.formats)
    const multiFormat = formats.length > 1
    const exportDate = new Date()
    const firstFormat = formats[0]
    const firstFileName = createMixdownFileName(exportDate, firstFormat)
    const projectId = input.projectId
    localProjectId = projectId && isLocalId('project', projectId) ? projectId : undefined
    const localFileHandle = localProjectId && !multiFormat ? await chooseLocalExportFile({ suggestedName: firstFileName, types: createSaveTypes(firstFormat) }) : undefined
    const localDirectory = localProjectId && multiFormat ? await chooseLocalExportDirectory() : undefined
    throwIfExportAborted(input.signal)
    const preloadTracks = input.getTracks()
    const mixdownModule = import('@daw-browser/audio-engine/export-mixdown')
    const [exportMixdown, , fx] = await Promise.all([
      mixdownModule,
      ensureBuffersForRange({ ...input, tracks: preloadTracks }),
      loadExportFx(input.projectId, input.userId, input.masterVolume),
    ])
    throwIfExportAborted(input.signal)
    const tracks = input.getTracks()
    input.onProgress?.({ phase: 'rendering' })
    const rendered = await exportMixdown.renderMixdown({
      tracks,
      bpm: input.bpm,
      range: input.range,
      fx,
      signal: input.signal,
    })
    throwIfExportAborted(input.signal)
    let completedFormats = 0
    for (const format of formats) {
      const fileName = createMixdownFileName(exportDate, format)
      const localWritable = localFileHandle
        ? await createLocalExportWritable(localFileHandle)
        : localDirectory
          ? await createLocalExportDirectoryWritable(localDirectory, fileName)
          : undefined
      reportFormatProgress(input, 'encoding', format, completedFormats, formats.length)
      const reportEncodingProgress = createEncodingProgressReporter((sizeBytes) => {
        reportFormatProgress(input, 'encoding', format, completedFormats, formats.length, sizeBytes)
      })
      const enc = await exportMixdown.encodeAudioBuffer(rendered, {
        format,
        target: localWritable ? createLocalExportTarget(localWritable) : { mode: 'buffer' },
        signal: input.signal,
        onWrite: reportEncodingProgress,
      })
      throwIfExportAborted(input.signal)
      const savedName = localFileHandle?.name ?? fileName
      if (localProjectId) {
        if (!localWritable) {
          if (!enc.blob) throw new Error('Export did not produce a downloadable file.')
          reportFormatProgress(input, 'saving', format, completedFormats, formats.length)
          await saveBlobLocally({ blob: enc.blob, suggestedName: fileName, types: createSaveTypes(format) })
          throwIfExportAborted(input.signal)
        }
        reportFormatProgress(input, 'saving', format, completedFormats, formats.length)
        localMetadataRows.push({
          name: savedName,
          format: enc.format,
          durationSec: enc.durationSec,
          sampleRate: enc.sampleRate,
          sizeBytes: enc.sizeBytes,
        })
        throwIfExportAborted(input.signal)
        outputs.push({ destination: 'local', name: savedName })
      } else {
        if (!projectId) throw new Error('Missing room')
        if (!enc.blob) throw new Error('Export did not produce an uploadable file.')
        reportFormatProgress(input, 'saving', format, completedFormats, formats.length)
        const upload = await saveCloudExport({
          projectId,
          blob: enc.blob,
          name: fileName,
          format: enc.format,
          durationSec: enc.durationSec,
          sampleRate: enc.sampleRate,
          signal: input.signal,
        })
        throwIfExportAborted(input.signal)
        outputs.push({ destination: 'cloud', name: fileName, url: upload.url })
      }
      completedFormats += 1
    }
    await saveCompletedLocalMetadata()
    return { type: 'success', outputs }
  } catch (err) {
    try {
      await saveCompletedLocalMetadata()
    } catch {}
    if (isAbortError(err)) return { type: 'canceled', outputs }
    return { type: 'error', message: err instanceof Error ? err.message : 'Export failed', outputs }
  }
}

export async function runStemExport(input: StemExportRequest): Promise<ExportOutcome> {
  const outputs: ExportOutput[] = []
  try {
    input.onProgress?.({ phase: 'preparing' })
    const formats = requireExportFormats(input.formats)
    const preloadTracks = input.getTracks()
    const preloadStemTracks = collectStemTracks({ ...input, tracks: preloadTracks })
    if (preloadStemTracks.length === 0) throw new Error('Select at least one track to export stems.')
    const exportDirectory = await chooseStemExportDirectory()
    throwIfExportAborted(input.signal)
    const mixdownModule = import('@daw-browser/audio-engine/export-mixdown')
    const [exportMixdown, , fx] = await Promise.all([
      mixdownModule,
      ensureBuffersForRange({ ...input, tracks: preloadStemTracks }),
      loadExportFx(input.projectId, input.userId, input.masterVolume),
    ])
    throwIfExportAborted(input.signal)
    const tracks = input.getTracks()
    const stemTracks = collectStemTracks({ ...input, tracks })
    if (stemTracks.length === 0) throw new Error('Select at least one track to export stems.')
    let completedStems = 0
    const usedStemFileNames = new Set<string>()
    const stemRenderSession = exportMixdown.createStemRenderSession({
      tracks,
      bpm: input.bpm,
      range: input.range,
      fx,
      signal: input.signal,
    })
    for (const track of stemTracks) {
      input.onProgress?.({
        phase: 'rendering',
        currentStemName: track.name,
        completedStems,
        totalStems: stemTracks.length,
      })
      const stemBuffer = await stemRenderSession.renderTrackStem(track)
      throwIfExportAborted(input.signal)
      let completedFormats = 0
      for (const format of formats) {
        const metadata = getExportAudioFormatMetadata(format)
        const fileName = createUniqueStemFileName(track.name, metadata.fileExtension, usedStemFileNames)
        const localWritable = await createStemExportWritable(exportDirectory, fileName)
        reportStemFormatProgress(input, 'encoding', format, track, completedStems, stemTracks.length, completedFormats, formats.length)
        const reportEncodingProgress = createEncodingProgressReporter((sizeBytes) => {
          reportStemFormatProgress(input, 'encoding', format, track, completedStems, stemTracks.length, completedFormats, formats.length, sizeBytes)
        })
        await exportMixdown.encodeAudioBuffer(stemBuffer, {
          format,
          target: createLocalExportTarget(localWritable),
          signal: input.signal,
          onWrite: reportEncodingProgress,
        })
        outputs.push({ destination: 'local', name: `stems/${fileName}` })
        completedFormats += 1
        throwIfExportAborted(input.signal)
      }
      completedStems += 1
      throwIfExportAborted(input.signal)
    }
    input.onProgress?.({ phase: 'saving', completedStems, totalStems: stemTracks.length })
    return { type: 'success', outputs }
  } catch (err) {
    if (isAbortError(err)) return { type: 'canceled', outputs }
    return { type: 'error', message: err instanceof Error ? err.message : 'Stem export failed', outputs }
  }
}
