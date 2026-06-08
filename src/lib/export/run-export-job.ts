import type { ExportRange, ExportFx } from '@daw-browser/audio-engine/export-mixdown'
import type { ExportAudioFormat } from '@daw-browser/shared'
import { formatExportFileTimestamp, getExportAudioFormatMetadata, isLocalId } from '@daw-browser/shared'
import type { FunctionReturnType } from 'convex/server'

import { convexApi, convexClient } from '~/lib/convex'
import { saveCloudExport } from '~/lib/cloud-export'
import { isAbortError } from '~/lib/dom-errors'
import { chooseLocalExportFile, createLocalExportTarget, createLocalExportWritable, saveBlobLocally } from '~/lib/local-export'
import { chooseStemExportDirectory, createStemExportWritable, sanitizeStemFileName } from '~/lib/local-stem-export'
import { listLocalEffects, type LocalEffectRow } from '~/lib/local-effects'
import { saveLocalExportMetadata } from '~/lib/local-export-metadata'
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
}

export type TimelineExportRequest = {
  tracks: RuntimeTrack[]
  getTracks: () => RuntimeTrack[]
  bpm: number
  range: ExportRange
  format: ExportAudioFormat
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

export type ExportOutcome =
  | { type: 'success'; url?: string; localSavedName?: string }
  | { type: 'canceled' }
  | { type: 'error'; message: string }

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
      fx.masterReverb = row.params
      continue
    }
    if (row.effect === 'eq') applyTrackFxPatch(trackFx, row.targetId, { eq: row.params })
    if (row.effect === 'reverb') applyTrackFxPatch(trackFx, row.targetId, { reverb: row.params })
    if (row.effect === 'arp') applyTrackFxPatch(trackFx, row.targetId, { arp: row.params })
    if (row.effect === 'synth') applyTrackFxPatch(trackFx, row.targetId, { synth: row.params })
  }
}

const applyRoomEffectRowsToFx = (fx: ExportFx, rows: RoomEffectRow[]) => {
  const trackFx = ensureTrackFxMap(fx)
  for (const row of rows) {
    if (row.targetType === 'master') {
      if (row.type === 'eq' && row.params) fx.masterEq = row.params
      if (row.type === 'reverb' && row.params) fx.masterReverb = row.params
      continue
    }
    const trackId = row.trackId
    if (!trackId || !row.params) continue
    if (row.type === 'eq') applyTrackFxPatch(trackFx, trackId, { eq: row.params })
    if (row.type === 'reverb') applyTrackFxPatch(trackFx, trackId, { reverb: row.params })
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

async function ensureBuffersForRange(input: Pick<TimelineExportRequest, 'tracks' | 'ensureClipBuffer' | 'signal'> & { range: ExportRange }) {
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

async function loadExportFx(projectId: string | undefined, userId: string | undefined): Promise<ExportFx> {
  const fx: ExportFx = { trackFx: {} }
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

const collectStemTracks = (input: Pick<StemExportRequest, 'tracks' | 'stemMode' | 'selectedTrackIds'>): RuntimeTrack[] => {
  if (input.stemMode === 'all-tracks') return input.tracks.filter(isRenderableStemTrack)
  const selectedIds = new Set(input.selectedTrackIds ?? [])
  return input.tracks.filter((track) => selectedIds.has(track.id) && isRenderableStemTrack(track))
}

const createUniqueStemFileName = (
  stemName: string,
  extension: string,
  usedNames: Map<string, number>,
): string => {
  const baseName = sanitizeStemFileName(stemName)
  const previousCount = usedNames.get(baseName) ?? 0
  usedNames.set(baseName, previousCount + 1)
  return previousCount === 0
    ? `${baseName}${extension}`
    : `${baseName} ${previousCount + 1}${extension}`
}

export async function runTimelineExport(input: TimelineExportRequest): Promise<ExportOutcome> {
  try {
    input.onProgress?.({ phase: 'preparing' })
    const metadata = getExportAudioFormatMetadata(input.format)
    const fileName = `mixdown_${formatExportFileTimestamp(new Date())}${metadata.fileExtension}`
    const projectId = input.projectId
    const localProjectId = projectId && isLocalId('project', projectId) ? projectId : undefined
    const saveTypes = [{ description: `${metadata.label} audio`, accept: { [metadata.mimeType]: [metadata.fileExtension] } }]
    const localFileHandle = localProjectId ? await chooseLocalExportFile({ suggestedName: fileName, types: saveTypes }) : undefined
    throwIfExportAborted(input.signal)
    const savedName = localFileHandle?.name ?? fileName
    const mixdownModule = import('@daw-browser/audio-engine/export-mixdown')
    const [exportMixdown, , fx] = await Promise.all([
      mixdownModule,
      ensureBuffersForRange(input),
      loadExportFx(input.projectId, input.userId),
    ])
    const tracks = input.getTracks()
    throwIfExportAborted(input.signal)
    input.onProgress?.({ phase: 'rendering' })
    const rendered = await exportMixdown.renderMixdown({
      tracks,
      bpm: input.bpm,
      range: input.range,
      fx,
      signal: input.signal,
    })
    throwIfExportAborted(input.signal)
    const localWritable = localFileHandle ? await createLocalExportWritable(localFileHandle) : undefined
    input.onProgress?.({ phase: 'encoding' })
    const reportEncodingProgress = createEncodingProgressReporter((sizeBytes) => {
      input.onProgress?.({ phase: 'encoding', sizeBytes })
    })
    const enc = await exportMixdown.encodeAudioBuffer(rendered, {
      format: input.format,
      target: localWritable ? createLocalExportTarget(localWritable) : { mode: 'buffer' },
      signal: input.signal,
      onWrite: reportEncodingProgress,
    })
    throwIfExportAborted(input.signal)
    if (localProjectId) {
      if (!localWritable) {
        if (!enc.blob) throw new Error('Export did not produce a downloadable file.')
        input.onProgress?.({ phase: 'saving' })
        await saveBlobLocally({ blob: enc.blob, suggestedName: fileName, types: saveTypes })
        throwIfExportAborted(input.signal)
      }
      input.onProgress?.({ phase: 'saving' })
      await saveLocalExportMetadata(localProjectId, {
        name: savedName,
        format: enc.format,
        durationSec: enc.durationSec,
        sampleRate: enc.sampleRate,
        sizeBytes: enc.sizeBytes,
      })
      throwIfExportAborted(input.signal)
      return { type: 'success', localSavedName: savedName }
    }
    if (!projectId) throw new Error('Missing room')
    if (!enc.blob) throw new Error('Export did not produce an uploadable file.')
    input.onProgress?.({ phase: 'saving' })
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
    return { type: 'success', url: upload.url }
  } catch (err) {
    if (isAbortError(err)) return { type: 'canceled' }
    return { type: 'error', message: err instanceof Error ? err.message : 'Export failed' }
  }
}

export async function runStemExport(input: StemExportRequest): Promise<ExportOutcome> {
  try {
    input.onProgress?.({ phase: 'preparing' })
    const metadata = getExportAudioFormatMetadata(input.format)
    const stemTracks = collectStemTracks(input)
    if (stemTracks.length === 0) throw new Error('Select at least one track to export stems.')
    const exportDirectory = await chooseStemExportDirectory()
    throwIfExportAborted(input.signal)
    const mixdownModule = import('@daw-browser/audio-engine/export-mixdown')
    const [exportMixdown, , fx] = await Promise.all([
      mixdownModule,
      ensureBuffersForRange({ ...input, tracks: stemTracks }),
      loadExportFx(input.projectId, input.userId),
    ])
    const tracks = input.getTracks()
    const renderStemTracks = collectStemTracks({ ...input, tracks })
    if (renderStemTracks.length === 0) throw new Error('Select at least one track to export stems.')
    throwIfExportAborted(input.signal)
    let completedStems = 0
    const usedStemFileNames = new Map<string, number>()
    const stemRenderSession = exportMixdown.createStemRenderSession({
      tracks,
      bpm: input.bpm,
      range: input.range,
      fx,
      signal: input.signal,
    })
    for (const track of renderStemTracks) {
      input.onProgress?.({
        phase: 'rendering',
        currentStemName: track.name,
        completedStems,
        totalStems: renderStemTracks.length,
      })
      const stemBuffer = await stemRenderSession.renderTrackStem(track)
      throwIfExportAborted(input.signal)
      const fileName = createUniqueStemFileName(track.name, metadata.fileExtension, usedStemFileNames)
      const localWritable = await createStemExportWritable(exportDirectory, fileName)
      input.onProgress?.({
        phase: 'encoding',
        currentStemName: track.name,
        completedStems,
        totalStems: renderStemTracks.length,
      })
      const reportEncodingProgress = createEncodingProgressReporter((sizeBytes) => {
        input.onProgress?.({
          phase: 'encoding',
          sizeBytes,
          currentStemName: track.name,
          completedStems,
          totalStems: renderStemTracks.length,
        })
      })
      await exportMixdown.encodeAudioBuffer(stemBuffer, {
        format: input.format,
        target: createLocalExportTarget(localWritable),
        signal: input.signal,
        onWrite: reportEncodingProgress,
      })
      completedStems += 1
      throwIfExportAborted(input.signal)
    }
    input.onProgress?.({ phase: 'saving', completedStems, totalStems: renderStemTracks.length })
    return { type: 'success', localSavedName: `stems/${renderStemTracks.length} files` }
  } catch (err) {
    if (isAbortError(err)) return { type: 'canceled' }
    return { type: 'error', message: err instanceof Error ? err.message : 'Stem export failed' }
  }
}
