import type { AudioEffectRuntimeInstance, ExportFx, StemMode, StemRecombinationMetadata } from '@daw-browser/audio-engine/export-mixdown'
import { getExportRangeBounds, type ExportRange } from '@daw-browser/audio-engine/export-range'
import { getExportTailMaximumSec, type ExportAnalysisReport } from '@daw-browser/audio-engine/export-fidelity'
import type { ExportAudioFormat } from '@daw-browser/shared'
import { formatExportFileTimestamp, getExportAudioFormatMetadata, isAudioEffectKind, isLocalId, isLossyExportAudioFormat, normalizeCompressorParams,
  normalizeAutoFilterParamsEnvelope, normalizeAutoPanParamsEnvelope, normalizeChorusParamsEnvelope, normalizeDelayParams,
  normalizeEnsembleParamsEnvelope, normalizeFlangerParamsEnvelope, normalizeGateParamsEnvelope, normalizeLimiterParamsEnvelope,
  normalizeLoFiParamsEnvelope, normalizePhaserParamsEnvelope, normalizeReverbParams, normalizeSaturatorParams,
  normalizeSpectralParamsEnvelope, normalizeTremoloParamsEnvelope, normalizeUtilityParamsEnvelope } from '@daw-browser/shared'
import type { FunctionReturnType } from 'convex/server'

import { convexApi, convexClient } from '~/lib/convex'
import { saveCloudExport } from '~/lib/cloud-export'
import { isAbortError } from '~/lib/dom-errors'
import { chooseLocalExportDirectory, chooseLocalExportFile, createLocalExportDirectoryWritable, createLocalExportTarget, createLocalExportWritable, saveBlobLocally } from '~/lib/local-export'
import { chooseStemExportDirectory, createStemExportWritable, sanitizeStemFileName } from '~/lib/local-stem-export'
import { audioEffectKindFromLocalEffect, listLocalEffects, type LocalEffectRow } from '~/lib/local-effects'
import { loadLocalAutomationEnvelopes } from '~/lib/local-automation'
import { createSampleBufferLoader } from '~/lib/sample-buffer-loader'
import { compareAudioEffectOrderEntries } from '~/lib/audio-effect-order-rows'
import { saveLocalExportMetadataBatch, type LocalExportMetadataInput } from '~/lib/local-export-metadata'
import { runWithConcurrency } from '~/lib/run-with-concurrency'
import { readInstrumentParamsFromEffectRow } from '~/lib/effect-row-instrument-params'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import { automationEnvelopeFromRow, type AutomationEnvelope } from '@daw-browser/shared'
import { isRenderableExportTrack, type ExportEncodingSettings, type ExportRenderSettings } from '~/lib/export/export-settings'
import { processRenderedExport } from '~/lib/export/process-rendered-export'

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number]

export type ExportPhase =
  | 'snapshot'
  | 'source-range'
  | 'preroll'
  | 'tail'
  | 'rendering'
  | 'analyzing'
  | 'gain'
  | 'limiting'
  | 'verifying'
  | 'quantizing'
  | 'encoding'
  | 'saving'

export type ExportProgress = {
  phase: ExportPhase
  sizeBytes?: number
  currentStemName?: string
  completedStems?: number
  totalStems?: number
  currentFormat?: ExportAudioFormat
  completedFormats?: number
  totalFormats?: number
  analysis?: ExportAnalysisReport
}

export type TimelineExportRequest = {
  getTracks: () => RuntimeTrack[]
  bpm: number
  masterVolume: number
  range: ExportRange
  formats: readonly ExportAudioFormat[]
  render: ExportRenderSettings
  encoding: ExportEncodingSettings
  projectId?: string
  userId?: string
  sidechainRoutes: ExternalSidechainRoute[]
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
  signal: AbortSignal
  onProgress?: (progress: ExportProgress) => void
}

export type StemExportSelection =
  | { stemSelection: 'all-tracks'; stemMode: StemMode }
  | { stemSelection: 'selected-tracks'; stemMode: StemMode; selectedTrackIds: readonly string[] }

type StemExportRequest = TimelineExportRequest & StemExportSelection

export type ExportOutput =
  | { destination: 'local'; name: string; analysis?: ExportAnalysisReport; stem?: StemRecombinationMetadata }
  | { destination: 'cloud'; name: string; url: string; analysis?: ExportAnalysisReport; stem?: StemRecombinationMetadata }

export type ExportOutcome =
  | { type: 'success'; outputs: readonly ExportOutput[] }
  | { type: 'canceled'; outputs: readonly ExportOutput[] }
  | { type: 'error'; message: string; outputs: readonly ExportOutput[] }

type TrackFxMap = NonNullable<ExportFx['trackFx']>
type TrackFxPatch = Partial<TrackFxMap[string]>
type ExportEffectInstanceRow = AudioEffectRuntimeInstance & {
  targetId: string
  index?: number
}

const ensureTrackFxMap = (fx: ExportFx): TrackFxMap => {
  const trackFx = fx.trackFx ?? {}
  fx.trackFx = trackFx
  return trackFx
}

const applyTrackFxPatch = (trackFx: TrackFxMap, trackId: string, patch: TrackFxPatch) => {
  trackFx[trackId] = { ...(trackFx[trackId] ?? { instances: [] }), ...patch }
}

const createOwnedExportEffectRow = (
  targetId: string,
  id: string,
  kind: 'utility' | 'autofilter' | 'gate' | 'limiter' | 'lofi' | 'chorus' | 'flanger' | 'phaser' | 'tremolo' | 'autopan' | 'ensemble' | 'spectral',
  params: unknown,
  index?: number,
): ExportEffectInstanceRow => {
  if (kind === 'utility') return { targetId, id, kind, index, params: normalizeUtilityParamsEnvelope(params) }
  if (kind === 'autofilter') return { targetId, id, kind, index, params: normalizeAutoFilterParamsEnvelope(params) }
  if (kind === 'gate') return { targetId, id, kind, index, params: normalizeGateParamsEnvelope(params) }
  if (kind === 'limiter') return { targetId, id, kind, index, params: normalizeLimiterParamsEnvelope(params) }
  if (kind === 'lofi') return { targetId, id, kind, index, params: normalizeLoFiParamsEnvelope(params) }
  if (kind === 'chorus') return { targetId, id, kind, index, params: normalizeChorusParamsEnvelope(params) }
  if (kind === 'flanger') return { targetId, id, kind, index, params: normalizeFlangerParamsEnvelope(params) }
  if (kind === 'phaser') return { targetId, id, kind, index, params: normalizePhaserParamsEnvelope(params) }
  if (kind === 'tremolo') return { targetId, id, kind, index, params: normalizeTremoloParamsEnvelope(params) }
  if (kind === 'autopan') return { targetId, id, kind, index, params: normalizeAutoPanParamsEnvelope(params) }
  if (kind === 'spectral') return { targetId, id, kind, index, params: normalizeSpectralParamsEnvelope(params) }
  return { targetId, id, kind, index, params: normalizeEnsembleParamsEnvelope(params) }
}

const normalizeExportEffectInstances = (rows: ExportEffectInstanceRow[]): AudioEffectRuntimeInstance[] => {
  const seen = new Set<string>()
  const instances: AudioEffectRuntimeInstance[] = []
  for (const row of rows.sort(compareAudioEffectOrderEntries)) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    if (row.kind === 'utility') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'autofilter') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'eq') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'gate') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'compressor') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'saturator') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'limiter') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'lofi') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'delay') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'reverb') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'chorus') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'flanger') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'phaser') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'tremolo') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'autopan') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else if (row.kind === 'spectral') instances.push({ id: row.id, kind: row.kind, params: row.params })
    else instances.push({ id: row.id, kind: row.kind, params: row.params })
  }
  return instances
}

const applyExportEffectInstances = (fx: ExportFx, rows: ExportEffectInstanceRow[]) => {
  const trackFx = ensureTrackFxMap(fx)
  const masterRows: ExportEffectInstanceRow[] = []
  const trackRows = new Map<string, ExportEffectInstanceRow[]>()
  for (const row of rows) {
    if (row.targetId === 'master') {
      masterRows.push(row)
      continue
    }
    const existing = trackRows.get(row.targetId)
    if (existing) existing.push(row)
    else trackRows.set(row.targetId, [row])
  }
  fx.masterFxInstances = normalizeExportEffectInstances(masterRows)
  for (const [trackId, instances] of trackRows) {
    applyTrackFxPatch(trackFx, trackId, { instances: normalizeExportEffectInstances(instances) })
  }
}

const applyLocalEffectRowsToFx = (fx: ExportFx, rows: LocalEffectRow[]) => {
  const trackFx = ensureTrackFxMap(fx)
  const instanceRows: ExportEffectInstanceRow[] = []
  for (const row of rows) {
    const kind = audioEffectKindFromLocalEffect(row.effect)
    if (kind) {
      if (!row.instanceId) throw new Error(`Audio effect "${kind}" is missing an instance ID.`)
      const id = row.instanceId
      if (kind === 'eq') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: row.params })
      if (kind === 'compressor') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: normalizeCompressorParams(row.params) })
      if (kind === 'saturator') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: normalizeSaturatorParams(row.params) })
      if (kind === 'delay') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: normalizeDelayParams(row.params) })
      if (kind === 'reverb') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: normalizeReverbParams(row.params) })
      if (kind === 'utility' || kind === 'autofilter' || kind === 'gate' || kind === 'limiter' || kind === 'lofi' ||
        kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo' || kind === 'autopan' || kind === 'ensemble' || kind === 'spectral') {
        instanceRows.push(createOwnedExportEffectRow(row.targetId, id, kind, row.params, row.index))
      }
    }
    if (row.effect === 'arp') applyTrackFxPatch(trackFx, row.targetId, { arp: row.params })
    if (row.effect === 'synth') applyTrackFxPatch(trackFx, row.targetId, { synth: row.params })
    if (row.effect === 'instrument') {
      const instrument = readInstrumentParamsFromEffectRow(row)
      if (instrument) applyTrackFxPatch(trackFx, row.targetId, { instrument })
    }
  }
  applyExportEffectInstances(fx, instanceRows)
}

const applyRoomEffectRowsToFx = (fx: ExportFx, rows: RoomEffectRow[]) => {
  const trackFx = ensureTrackFxMap(fx)
  const instanceRows: ExportEffectInstanceRow[] = []
  for (const row of rows) {
    if (isAudioEffectKind(row.type)) {
      const targetId = row.targetType === 'master' ? 'master' : row.trackId
      if (targetId && row.params) {
        if (!row.instanceId) throw new Error(`Audio effect "${row.type}" is missing an instance ID.`)
        const id = row.instanceId
        if (row.type === 'eq') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: row.params })
        if (row.type === 'compressor') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeCompressorParams(row.params) })
        if (row.type === 'saturator') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeSaturatorParams(row.params) })
        if (row.type === 'delay') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeDelayParams(row.params) })
        if (row.type === 'reverb') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeReverbParams(row.params) })
        if (row.type === 'utility' || row.type === 'autofilter' || row.type === 'gate' || row.type === 'limiter' || row.type === 'lofi' ||
          row.type === 'chorus' || row.type === 'flanger' || row.type === 'phaser' || row.type === 'tremolo' || row.type === 'autopan' || row.type === 'ensemble' || row.type === 'spectral') {
          instanceRows.push(createOwnedExportEffectRow(targetId, id, row.type, row.params, row.index))
        }
      }
    }
    if (row.targetType === 'master') continue
    const trackId = row.trackId
    if (!trackId || !row.params) continue
    if (row.type === 'arpeggiator') applyTrackFxPatch(trackFx, trackId, { arp: row.params })
    if (row.type === 'synth') applyTrackFxPatch(trackFx, trackId, { synth: row.params })
    if (row.type === 'instrument') {
      const instrument = readInstrumentParamsFromEffectRow(row)
      if (instrument) applyTrackFxPatch(trackFx, trackId, { instrument })
    }
  }
  applyExportEffectInstances(fx, instanceRows)
}

const throwIfExportAborted = (signal: AbortSignal) => {
  signal.throwIfAborted()
}

const ENCODING_PROGRESS_STEP_BYTES = 256 * 1024
const MAX_CONCURRENT_BUFFER_LOADS = 4

const createExportSeed = () => {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return values[0]
}

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
  const { startSec: rangeStart, endSec: rangeEnd } = getExportRangeBounds(input.tracks, input.range)
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
  const fx: ExportFx = { trackFx: {}, masterFxInstances: [], masterVolume }
  const localOnly = projectId ? isLocalId('project', projectId) : false
  if (localOnly && projectId) {
    applyLocalEffectRowsToFx(fx, await listLocalEffects(projectId))
  }
  if (!localOnly && projectId && userId) {
    const rows = await convexClient.query(convexApi.effects.listByRoom, { projectId })
    applyRoomEffectRowsToFx(fx, rows)
  }
  return fx
}

async function loadExportAutomation(projectId: string | undefined, userId: string | undefined): Promise<AutomationEnvelope[]> {
  const localOnly = projectId ? isLocalId('project', projectId) : false
  if (localOnly && projectId) {
    return loadLocalAutomationEnvelopes(projectId)
  }
  if (!localOnly && projectId && userId) {
    const rows = await convexClient.query(convexApi.automation.listByProject, { projectId })
    return rows.flatMap((row) => {
      const envelope = automationEnvelopeFromRow(row)
      return envelope ? [envelope] : []
    })
  }
  return []
}

async function loadInstrumentExportBuffers(fx: ExportFx, signal: AbortSignal, allowedTrackIds?: ReadonlySet<string>): Promise<void> {
  const trackFx = fx.trackFx
  if (!trackFx) return
  const jobs: Array<{
    url: string
    install: (buffer: AudioBuffer) => void
  }> = []
  for (const [trackId, entry] of Object.entries(trackFx)) {
    if (allowedTrackIds && !allowedTrackIds.has(trackId)) continue
    const buffers = new Map<string, AudioBuffer>()
    if (entry.instrument?.kind === 'drum-rack') {
      entry.drumRackBuffers = buffers
      for (const pad of entry.instrument.params.pads) {
        const sample = pad.sample
        if (sample) jobs.push({ url: sample.url, install: (buffer) => buffers.set(pad.id, buffer) })
      }
    }
    if (entry.instrument?.kind === 'sampler') {
      entry.samplerBuffers = buffers
      for (const zone of entry.instrument.params.zones) {
        jobs.push({ url: zone.sample.url, install: (buffer) => buffers.set(zone.id, buffer) })
      }
    }
    if (entry.instrument?.kind === 'granular' && entry.instrument.params.zone) {
      const zone = entry.instrument.params.zone
      jobs.push({
        url: zone.sample.url,
        install: (buffer) => {
          entry.granularBuffer = { assetKey: zone.sample.assetKey, buffer }
        },
      })
    }
  }
  if (jobs.length === 0) return
  const ctx = new AudioContext()
  const loader = createSampleBufferLoader()
  try {
    await runWithConcurrency(jobs, MAX_CONCURRENT_BUFFER_LOADS, async (job) => {
      throwIfExportAborted(signal)
      const buffer = await loader.load(job.url, (data) => ctx.decodeAudioData(data))
      if (!buffer) throw new Error(`Failed to preload export sample ${job.url}`)
      job.install(buffer)
    })
  } finally {
    await ctx.close().catch(() => undefined)
  }
  throwIfExportAborted(signal)
}

async function loadExportFxWithDrumRackBuffers(
  projectId: string | undefined,
  userId: string | undefined,
  masterVolume: number,
  signal: AbortSignal,
  allowedTrackIds?: ReadonlySet<string>,
): Promise<ExportFx> {
  const fx = await loadExportFx(projectId, userId, masterVolume)
  await loadInstrumentExportBuffers(fx, signal, allowedTrackIds)
  return fx
}

const collectStemTracks = (input: StemExportSelection & { tracks: RuntimeTrack[] }): RuntimeTrack[] => {
  const matchesMode = (track: RuntimeTrack) => input.stemMode === 'channel-output'
    ? track.channelRole === 'group' || track.channelRole === 'return'
    : isRenderableExportTrack(track)
  if (input.stemSelection === 'all-tracks') return input.tracks.filter(matchesMode)
  const selectedIds = new Set(input.selectedTrackIds)
  return input.tracks.filter((track) => selectedIds.has(track.id) && matchesMode(track))
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
  phase: Extract<ExportPhase, 'quantizing' | 'encoding' | 'saving'>,
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
    input.onProgress?.({ phase: 'snapshot' })
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
    input.onProgress?.({ phase: 'source-range' })
    const sourceBounds = getExportRangeBounds(preloadTracks, input.range)
    input.onProgress?.({ phase: 'preroll' })
    input.onProgress?.({ phase: 'tail' })
    const tailMaximumSec = getExportTailMaximumSec(input.render.tail)
    const renderRange: ExportRange = {
      mode: 'custom',
      startSec: sourceBounds.startSec,
      endSec: sourceBounds.endSec + tailMaximumSec,
    }
    const mixdownModule = import('@daw-browser/audio-engine/export-mixdown')
    const [exportMixdown, , fx, automationEnvelopes] = await Promise.all([
      mixdownModule,
      ensureBuffersForRange({ ...input, tracks: preloadTracks }),
      loadExportFxWithDrumRackBuffers(input.projectId, input.userId, input.masterVolume, input.signal),
      loadExportAutomation(input.projectId, input.userId),
    ])
    throwIfExportAborted(input.signal)
    const tracks = input.getTracks()
    input.onProgress?.({ phase: 'rendering' })
    const rendered = await exportMixdown.renderMixdown({
      tracks,
      bpm: input.bpm,
      range: renderRange,
      sourceEndSec: sourceBounds.endSec,
      sampleRate: input.render.sampleRate,
      numberOfChannels: input.render.numberOfChannels,
      fx,
      automationEnvelopes,
      sidechainRoutes: input.sidechainRoutes,
      signal: input.signal,
    })
    throwIfExportAborted(input.signal)
    const processed = processRenderedExport({
      rendered,
      sourceDurationSec: sourceBounds.endSec - sourceBounds.startSec,
      render: input.render,
      signal: input.signal,
    })
    const exportBuffer = processed.buffer
    input.onProgress?.({ phase: 'analyzing' })
    if (input.render.normalization.mode !== 'none') input.onProgress?.({ phase: 'gain' })
    if (input.render.normalization.mode === 'loudness' && input.render.normalization.limiting === 'true-peak') {
      input.onProgress?.({ phase: 'limiting' })
    }
    const analysis = processed.analysis
    input.onProgress?.({ phase: 'verifying', analysis })
    const ditherSeed = createExportSeed()
    let completedFormats = 0
    for (const format of formats) {
      const fileName = createMixdownFileName(exportDate, format)
      const localWritable = localFileHandle
        ? await createLocalExportWritable(localFileHandle)
        : localDirectory
          ? await createLocalExportDirectoryWritable(localDirectory, fileName)
          : undefined
      if (format === 'wav') reportFormatProgress(input, 'quantizing', format, completedFormats, formats.length)
      reportFormatProgress(input, 'encoding', format, completedFormats, formats.length)
      const reportEncodingProgress = createEncodingProgressReporter((sizeBytes) => {
        reportFormatProgress(input, 'encoding', format, completedFormats, formats.length, sizeBytes)
      })
      const enc = await exportMixdown.encodeAudioBuffer(exportBuffer, {
        format,
        bitrate: isLossyExportAudioFormat(format) ? input.encoding.bitrateByFormat[format] : undefined,
        target: localWritable ? createLocalExportTarget(localWritable) : { mode: 'buffer' },
        signal: input.signal,
        onWrite: reportEncodingProgress,
        wav: input.encoding.wav,
        ditherSeed,
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
        outputs.push({ destination: 'local', name: savedName, analysis })
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
        outputs.push({ destination: 'cloud', name: fileName, url: upload.url, analysis })
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
    input.onProgress?.({ phase: 'snapshot' })
    const formats = requireExportFormats(input.formats)
    const preloadTracks = input.getTracks()
    const preloadStemTracks = collectStemTracks({ ...input, tracks: preloadTracks })
    if (preloadStemTracks.length === 0) throw new Error('Select at least one track to export stems.')
    const exportDirectory = await chooseStemExportDirectory()
    throwIfExportAborted(input.signal)
    const [exportMixdown, fx, automationEnvelopes] = await Promise.all([
      import('@daw-browser/audio-engine/export-mixdown'),
      loadExportFx(input.projectId, input.userId, input.masterVolume),
      loadExportAutomation(input.projectId, input.userId),
    ])
    const sourceBounds = getExportRangeBounds(preloadTracks, input.range)
    const tailMaximumSec = getExportTailMaximumSec(input.render.tail)
    const renderRange: ExportRange = {
      mode: 'custom',
      startSec: sourceBounds.startSec,
      endSec: sourceBounds.endSec + tailMaximumSec,
    }
    const graph = exportMixdown.resolveExportMixerGraph({ tracks: preloadTracks, fx })
    const preloadTrackIds = new Set<string>()
    for (const track of preloadStemTracks) {
      const plan = exportMixdown.createStemRenderPlan(
        graph,
        { id: track.id, name: track.name, mode: input.stemMode, targetTrackId: track.id },
        input.sidechainRoutes,
      )
      for (const id of plan.sourceTrackIds) preloadTrackIds.add(id)
      for (const id of plan.detectorOnlyTrackIds) preloadTrackIds.add(id)
      const scope = exportMixdown.createSourceAutomationScope(plan.graph, {
        sourceTrackIds: plan.sourceTrackIds,
        includeMasterFx: input.stemMode === 'full-master-contribution',
      })
      for (const id of scope.trackIds ?? []) preloadTrackIds.add(id)
    }
    const preloadAssetTracks = preloadTracks.filter((track) => preloadTrackIds.has(track.id))
    await Promise.all([
      ensureBuffersForRange({ ...input, tracks: preloadAssetTracks, range: input.range }),
      loadInstrumentExportBuffers(fx, input.signal, preloadTrackIds),
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
      range: renderRange,
      sourceEndSec: sourceBounds.endSec,
      sampleRate: input.render.sampleRate,
      numberOfChannels: input.render.numberOfChannels,
      fx,
      automationEnvelopes,
      sidechainRoutes: input.sidechainRoutes,
      signal: input.signal,
    })
    for (const track of stemTracks) {
      input.onProgress?.({
        phase: 'rendering',
        currentStemName: track.name,
        completedStems,
        totalStems: stemTracks.length,
      })
      const renderedStem = await stemRenderSession.renderStem({
        id: track.id,
        name: track.name,
        mode: input.stemMode,
        targetTrackId: track.id,
      })
      const processed = processRenderedExport({
        rendered: renderedStem.buffer,
        sourceDurationSec: sourceBounds.endSec - sourceBounds.startSec,
        render: input.render,
        signal: input.signal,
      })
      const stemBuffer = processed.buffer
      throwIfExportAborted(input.signal)
      const analysis = processed.analysis
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
          bitrate: isLossyExportAudioFormat(format) ? input.encoding.bitrateByFormat[format] : undefined,
          target: createLocalExportTarget(localWritable),
          signal: input.signal,
          onWrite: reportEncodingProgress,
          wav: input.encoding.wav,
          ditherSeed: createExportSeed(),
        })
        outputs.push({ destination: 'local', name: `stems/${fileName}`, analysis, stem: renderedStem.metadata })
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
