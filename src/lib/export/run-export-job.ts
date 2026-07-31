import type { AudioEffectRuntimeInstance, ExportFx, StemMode, StemRecombinationMetadata } from '@daw-browser/audio-engine/export-mixdown'
import { getExportRangeBounds, type ExportRange } from '@daw-browser/audio-engine/export-range'
import { getExportTailMaximumSec, type ExportAnalysisReport } from '@daw-browser/audio-engine/export-fidelity'
import { type AutomationEnvelope, automationEnvelopeFromRow, type ExportAudioFormat, formatExportFileTimestamp, getExportAudioFormatMetadata, isAudioEffectKind, isLocalId, isLossyExportAudioFormat, normalizeCompressorParams,
  normalizeAutoFilterParamsEnvelope, normalizeAutoPanParamsEnvelope, normalizeChorusParamsEnvelope, normalizeDelayParams,
  normalizeEnsembleParamsEnvelope, normalizeFlangerParamsEnvelope, normalizeGateParamsEnvelope, normalizeLimiterParamsEnvelope,
  normalizeLoFiParamsEnvelope, normalizePhaserParamsEnvelope, normalizeReverbParams, normalizeSaturatorParams,
  normalizeSpectralParamsEnvelope, normalizeTremoloParamsEnvelope, normalizeUtilityParamsEnvelope } from '@daw-browser/shared'
import type { FunctionReturnType } from 'convex/server'

import type { convexApi } from '~/lib/convex'
import { isAbortError } from '~/lib/dom-errors'
import { createUniqueStemFileName } from '~/lib/export/stem-file-names'
import { audioEffectKindFromLocalEffect, type LocalEffectRow } from '~/lib/local-effects'
import { createSampleBufferLoader } from '~/lib/sample-buffer-loader'
import { compareAudioEffectOrderEntries } from '~/lib/audio-effect-order-rows'
import { saveLocalExportMetadataBatch, type LocalExportMetadataInput } from '~/lib/local-export-metadata'
import { runWithConcurrency } from '~/lib/run-with-concurrency'
import { readInstrumentParamsFromEffectRow } from '~/lib/effect-row-instrument-params'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import { isRenderableExportTrack, type ExportEncodingSettings, type ExportRenderSettings } from '~/lib/export/export-settings'
import { processRenderedExport } from '~/lib/export/process-rendered-export'
import type { ExportOutputTargetFactory } from '~/lib/export/export-output-targets'
import { preflightExportResources } from '~/lib/export/export-resource-preflight'
import { captureLocalExportRenderRowsSnapshot } from '~/lib/export/capture-local-export-render-rows'
import type { ExportEffectRow, ExportEffectsProjection } from '~/lib/export/export-effect-rows'
import { listLocalExternalProcessors } from '~/lib/external-plugins'
import { getLocalProject } from '~/lib/local-project-db'
import { assertBrowserExportHasNoLiveExternalPlugins } from '@daw-browser/external-plugins'

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

type TimelineExportRequest = {
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
  loadCapturedClipBuffer: (clip: RuntimeClip, signal: AbortSignal) => Promise<void>
  signal: AbortSignal
  onProgress?: (progress: ExportProgress) => void
  outputTargets: ExportOutputTargetFactory
  renderStateSnapshot: ExportRenderStateSnapshot
}

type StemExportSelection =
  | { stemSelection: 'all-tracks'; stemMode: StemMode }
  | { stemSelection: 'selected-tracks'; stemMode: StemMode; selectedTrackIds: readonly string[] }

type StemExportRequest = TimelineExportRequest & StemExportSelection

export type ExportOutput =
  | { destination: 'local'; name: string; sizeBytes: number; analysis?: ExportAnalysisReport; stem?: StemRecombinationMetadata }
  | { destination: 'cloud'; name: string; url: string; sizeBytes: number; analysis?: ExportAnalysisReport; stem?: StemRecombinationMetadata }

export type ExportOutcome =
  | { type: 'success'; outputs: readonly ExportOutput[] }
  | { type: 'canceled'; outputs: readonly ExportOutput[] }
  | { type: 'error'; message: string; outputs: readonly ExportOutput[] }

export type ExportRenderStateSnapshot = {
  readonly fx: ExportFx
  readonly automationEnvelopes: readonly AutomationEnvelope[]
}

export type ExportCloudRenderRowsSnapshot = Pick<
  FunctionReturnType<typeof convexApi.timeline.fullView>,
  'effects' | 'automationEnvelopes'
>

export type ExportAutomationPatch = {
  targetKey: string
  envelope: AutomationEnvelope | undefined
}

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

const replaceExportEffectInstancesForTarget = (
  fx: ExportFx,
  targetId: string,
  rows: readonly ExportEffectRow[],
) => {
  const instances: ExportEffectInstanceRow[] = []
  for (const row of rows) {
    if (!isAudioEffectKind(row.effect) || !row.instanceId) continue
    if (row.effect === 'eq') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: row.params })
    else if (row.effect === 'compressor') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeCompressorParams(row.params) })
    else if (row.effect === 'saturator') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeSaturatorParams(row.params) })
    else if (row.effect === 'delay') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeDelayParams(row.params) })
    else if (row.effect === 'reverb') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeReverbParams(row.params) })
    else instances.push(createOwnedExportEffectRow(targetId, row.instanceId, row.effect, row.params, row.index))
  }
  if (targetId === 'master') {
    fx.masterFxInstances = normalizeExportEffectInstances(instances)
    return
  }
  applyTrackFxPatch(ensureTrackFxMap(fx), targetId, { instances: normalizeExportEffectInstances(instances) })
}

const applyLocalEffectRowsToFx = (fx: ExportFx, rows: readonly LocalEffectRow[]) => {
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

const applyRoomEffectRowsToFx = (fx: ExportFx, rows: readonly RoomEffectRow[]) => {
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

const applyProjectedEffectRowsToFx = (fx: ExportFx, rows: readonly ExportEffectRow[]) => {
  const trackFx = ensureTrackFxMap(fx)
  const instances: ExportEffectInstanceRow[] = []
  for (const row of rows) {
    if (isAudioEffectKind(row.effect) && row.instanceId) {
      if (row.effect === 'eq') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: row.params })
      else if (row.effect === 'compressor') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeCompressorParams(row.params) })
      else if (row.effect === 'saturator') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeSaturatorParams(row.params) })
      else if (row.effect === 'delay') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeDelayParams(row.params) })
      else if (row.effect === 'reverb') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeReverbParams(row.params) })
      else instances.push(createOwnedExportEffectRow(row.targetId, row.instanceId, row.effect, row.params, row.index))
    }
    if (row.effect === 'arp') applyTrackFxPatch(trackFx, row.targetId, { arp: structuredClone(row.params) })
    if (row.effect === 'synth') applyTrackFxPatch(trackFx, row.targetId, { synth: structuredClone(row.params) })
    if (row.effect === 'instrument') {
      const instrument = readInstrumentParamsFromEffectRow({ type: 'instrument', params: row.params })
      if (instrument) applyTrackFxPatch(trackFx, row.targetId, { instrument })
    }
  }
  if (instances.length > 0) applyExportEffectInstances(fx, instances)
}

const applyEffectsProjectionToFx = (fx: ExportFx, projection: ExportEffectsProjection | undefined) => {
  if (!projection) return
  for (const replacement of projection.replaceAudioEffectTargets) {
    replaceExportEffectInstancesForTarget(fx, replacement.targetId, replacement.rows)
  }
  applyProjectedEffectRowsToFx(fx, projection.upsertDeviceRows)
}

const applyAutomationPatches = (
  envelopes: readonly AutomationEnvelope[],
  patches: readonly ExportAutomationPatch[] | undefined,
) => {
  if (!patches || patches.length === 0) return structuredClone(envelopes)
  const merged = new Map(envelopes.map((envelope) => [envelope.targetKey, envelope]))
  for (const patch of patches) {
    if (patch.envelope) merged.set(patch.targetKey, structuredClone(patch.envelope))
    else merged.delete(patch.targetKey)
  }
  return Array.from(merged.values())
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

type ExportTrackSnapshotInput = Pick<TimelineExportRequest, 'loadCapturedClipBuffer' | 'signal'> & {
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
      jobs.push(() => input.loadCapturedClipBuffer(clip, input.signal))
    }
  }
  await runWithConcurrency(jobs, MAX_CONCURRENT_BUFFER_LOADS, async (job) => {
    throwIfExportAborted(input.signal)
    await job()
  })
  throwIfExportAborted(input.signal)
}

const createExportFx = (masterVolume: number): ExportFx => ({
  trackFx: {},
  masterFxInstances: [],
  masterVolume,
})

export type ExportExternalPluginPolicy = 'browser-export' | 'native-playback'

export const createExportRenderStateSnapshot = async (input: {
  projectId: string | undefined
  userId: string | undefined
  masterVolume: number
  cloudRows: ExportCloudRenderRowsSnapshot | undefined
  effectsProjection?: ExportEffectsProjection
  automationPatches?: readonly ExportAutomationPatch[]
  externalPluginPolicy?: ExportExternalPluginPolicy
}): Promise<ExportRenderStateSnapshot> => {
  const {
    projectId,
    userId,
    masterVolume,
    cloudRows,
    effectsProjection,
    automationPatches,
    externalPluginPolicy = 'browser-export',
  } = input
  const fx = createExportFx(masterVolume)
  const localProject = projectId ? await getLocalProject(projectId) : undefined
  const localOnly = projectId ? isLocalId('project', projectId) || localProject !== undefined : false
  if (localOnly && projectId) {
    const rows = await captureLocalExportRenderRowsSnapshot(projectId)
    if (externalPluginPolicy === 'browser-export') {
      assertBrowserExportHasNoLiveExternalPlugins(await listLocalExternalProcessors(projectId))
    }
    applyLocalEffectRowsToFx(fx, rows.effects)
    applyEffectsProjectionToFx(fx, effectsProjection)
    return {
      fx,
      automationEnvelopes: applyAutomationPatches(rows.automationEnvelopes, automationPatches),
    }
  }
  if (!localOnly && projectId && userId) {
    if (!cloudRows) throw new Error('Cloud timeline snapshot is unavailable.')
    applyRoomEffectRowsToFx(fx, cloudRows.effects)
    applyEffectsProjectionToFx(fx, effectsProjection)
    return {
      fx,
      automationEnvelopes: applyAutomationPatches(cloudRows.automationEnvelopes.flatMap((row) => {
        const envelope = automationEnvelopeFromRow(row)
        return envelope ? [envelope] : []
      }), automationPatches),
    }
  }
  return { fx, automationEnvelopes: [] }
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
      const buffer = await loader.load(job.url, (data) => ctx.decodeAudioData(data), signal)
      if (!buffer) throw new Error(`Failed to preload export sample ${job.url}`)
      job.install(buffer)
    })
  } finally {
    await ctx.close().catch(() => undefined)
  }
  throwIfExportAborted(signal)
}

export const collectStemTracks = (input: StemExportSelection & { tracks: RuntimeTrack[] }): RuntimeTrack[] => {
  const matchesMode = (track: RuntimeTrack) => input.stemMode === 'channel-output'
    ? track.channelRole === 'group' || track.channelRole === 'return'
    : isRenderableExportTrack(track)
  if (input.stemSelection === 'all-tracks') return input.tracks.filter(matchesMode)
  const selectedIds = new Set(input.selectedTrackIds)
  return input.tracks.filter((track) => selectedIds.has(track.id) && matchesMode(track))
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
    const preloadTracks = input.getTracks()
    preflightExportResources({
      tracks: preloadTracks,
      range: input.range,
      formats,
      render: input.render,
      encoding: input.encoding,
      stemCount: 1,
      resourceLimits: input.outputTargets.resourceLimits,
    })
    const projectId = input.projectId
    localProjectId = projectId && isLocalId('project', projectId) ? projectId : undefined
    const outputTarget = await input.outputTargets.createMixdownTarget({
      projectId,
      localProject: Boolean(localProjectId),
      multiFormat,
      firstFileName,
      firstFileTypes: createSaveTypes(firstFormat),
    })
    throwIfExportAborted(input.signal)
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
    const fx = structuredClone(input.renderStateSnapshot.fx)
    const automationEnvelopes = input.renderStateSnapshot.automationEnvelopes.map((envelope) => structuredClone(envelope))
    const [exportMixdown] = await Promise.all([
      mixdownModule,
      ensureBuffersForRange({ ...input, tracks: preloadTracks }),
      loadInstrumentExportBuffers(fx, input.signal),
    ])
    throwIfExportAborted(input.signal)
    input.onProgress?.({ phase: 'rendering' })
    const rendered = await exportMixdown.renderMixdown({
      tracks: preloadTracks,
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
      const fileSink = await outputTarget.openFile(fileName)
      try {
        if (format === 'wav') reportFormatProgress(input, 'quantizing', format, completedFormats, formats.length)
        reportFormatProgress(input, 'encoding', format, completedFormats, formats.length)
        const reportEncodingProgress = createEncodingProgressReporter((sizeBytes) => {
          reportFormatProgress(input, 'encoding', format, completedFormats, formats.length, sizeBytes)
        })
        const enc = await exportMixdown.encodeAudioBuffer(exportBuffer, {
          format,
          bitrate: isLossyExportAudioFormat(format) ? input.encoding.bitrateByFormat[format] : undefined,
          target: fileSink?.target ?? { mode: 'buffer' },
          signal: input.signal,
          onWrite: reportEncodingProgress,
          wav: input.encoding.wav,
          ditherSeed,
        })
        throwIfExportAborted(input.signal)
        const committed = await fileSink?.commit()
        const savedName = fileSink?.name ?? fileName
        const sizeBytes = committed?.byteLength ?? enc.sizeBytes
        if (fileSink) {
          reportFormatProgress(input, 'saving', format, completedFormats, formats.length)
          if (localProjectId) {
            localMetadataRows.push({
              name: savedName,
              format: enc.format,
              durationSec: enc.durationSec,
              sampleRate: enc.sampleRate,
              sizeBytes,
            })
          }
          outputs.push({ destination: 'local', name: savedName, sizeBytes, analysis })
          completedFormats += 1
          continue
        }
        if (localProjectId) {
          if (!enc.blob) throw new Error('Export did not produce a downloadable file.')
          reportFormatProgress(input, 'saving', format, completedFormats, formats.length)
          const saved = await outputTarget.saveBuffer({
            blob: enc.blob,
            fileName,
            types: createSaveTypes(format),
            format: enc.format,
            durationSec: enc.durationSec,
            sampleRate: enc.sampleRate,
            signal: input.signal,
          })
          if (saved.destination !== 'local') throw new Error('Local export target selected a cloud destination.')
          throwIfExportAborted(input.signal)
          reportFormatProgress(input, 'saving', format, completedFormats, formats.length)
          localMetadataRows.push({
            name: savedName,
            format: enc.format,
            durationSec: enc.durationSec,
            sampleRate: enc.sampleRate,
            sizeBytes: enc.sizeBytes,
          })
          throwIfExportAborted(input.signal)
          outputs.push({ destination: 'local', name: savedName, sizeBytes, analysis })
        } else {
          if (!enc.blob) throw new Error('Export did not produce an uploadable file.')
          reportFormatProgress(input, 'saving', format, completedFormats, formats.length)
          const saved = await outputTarget.saveBuffer({
            blob: enc.blob,
            fileName,
            types: createSaveTypes(format),
            format: enc.format,
            durationSec: enc.durationSec,
            sampleRate: enc.sampleRate,
            signal: input.signal,
          })
          throwIfExportAborted(input.signal)
          if (saved.destination !== 'cloud') throw new Error('Cloud export target selected a local destination.')
          outputs.push({ destination: 'cloud', name: saved.name, url: saved.url, sizeBytes, analysis })
        }
      } catch (error) {
        await fileSink?.abort(error)
        throw error
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
    preflightExportResources({
      tracks: preloadTracks,
      range: input.range,
      formats,
      render: input.render,
      encoding: input.encoding,
      stemCount: preloadStemTracks.length,
      resourceLimits: input.outputTargets.resourceLimits,
    })
    const outputTarget = await input.outputTargets.createStemTarget()
    throwIfExportAborted(input.signal)
    const fx = structuredClone(input.renderStateSnapshot.fx)
    const automationEnvelopes = input.renderStateSnapshot.automationEnvelopes.map((envelope) => structuredClone(envelope))
    const exportMixdown = await import('@daw-browser/audio-engine/export-mixdown')
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
    const tracks = preloadTracks
    const stemTracks = preloadStemTracks
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
        const fileSink = await outputTarget.openFile(fileName)
        let committed: { byteLength?: number } = {}
        let encodedSizeBytes = 0
        try {
          reportStemFormatProgress(input, 'encoding', format, track, completedStems, stemTracks.length, completedFormats, formats.length)
          const reportEncodingProgress = createEncodingProgressReporter((sizeBytes) => {
            reportStemFormatProgress(input, 'encoding', format, track, completedStems, stemTracks.length, completedFormats, formats.length, sizeBytes)
          })
          const encoded = await exportMixdown.encodeAudioBuffer(stemBuffer, {
            format,
            bitrate: isLossyExportAudioFormat(format) ? input.encoding.bitrateByFormat[format] : undefined,
            target: fileSink.target,
            signal: input.signal,
            onWrite: reportEncodingProgress,
            wav: input.encoding.wav,
            ditherSeed: createExportSeed(),
          })
          encodedSizeBytes = encoded.sizeBytes
          throwIfExportAborted(input.signal)
          committed = await fileSink.commit()
        } catch (error) {
          await fileSink.abort(error)
          throw error
        }
        outputs.push({ destination: 'local', name: `stems/${fileName}`, sizeBytes: committed.byteLength ?? encodedSizeBytes, analysis, stem: renderedStem.metadata })
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
