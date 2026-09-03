import type { AudioEffectRuntimeInstance, ExportFx, StemMode, StemRecombinationMetadata } from '@daw-browser/audio-engine/export-mixdown'
import { getExportRangeBounds, type ExportRange } from '@daw-browser/audio-engine/export-range'
import { getExportTailMaximumSec, type ExportAnalysisReport } from '@daw-browser/audio-engine/export-fidelity'
import { AUDIO_EFFECT_CONTRACTS, type AutomationEnvelope, arpeggiatorParamsSchema, automationEnvelopeFromRow, type ExportAudioFormat, formatExportFileTimestamp, getExportAudioFormatMetadata, isAudioEffectKind, isJsonObject, isLocalId, isLossyExportAudioFormat, type JsonValue, normalizeArpeggiatorParams, normalizeCompressorParams,
  normalizeAutoFilterParamsEnvelope, normalizeAutoPanParamsEnvelope, normalizeChorusParamsEnvelope, normalizeDelayParams,
  normalizeEnsembleParamsEnvelope, normalizeEqParams, normalizeFlangerParamsEnvelope, normalizeGateParamsEnvelope, normalizeLimiterParamsEnvelope,
  normalizeLoFiParamsEnvelope, normalizePhaserParamsEnvelope, normalizeReverbParams, normalizeSaturatorParams,
  normalizeSpectralParamsEnvelope, normalizeSynthParams, normalizeTremoloParamsEnvelope, normalizeTrackInstrumentParams, normalizeUtilityParamsEnvelope, parseJsonValue } from '@daw-browser/shared'
import type { FunctionReturnType } from 'convex/server'

import type { convexApi } from '~/lib/convex'
import { isAbortError } from '~/lib/dom-errors'
import { createUniqueStemFileName } from '~/lib/export/stem-file-names'
import { audioEffectKindFromLocalEffect, type LocalEffectRow } from '~/lib/local-effects'
import { loadSampledInstrumentRegion } from '~/lib/sampled-instrument-region-loader'
import {
  sampledInstrumentRegion,
  sampledInstrumentRegionBytes,
  sampledInstrumentRegionIdentity,
  sampledInstrumentRetainedBytes,
  validateSampledInstrumentBuffer,
  type SampledInstrumentBuffer,
} from '@daw-browser/audio-engine/sampled-instrument-region'
import { compareAudioEffectOrderEntries } from '~/lib/audio-effect-order-rows'
import { saveLocalExportMetadataBatch, type LocalExportMetadataInput } from '~/lib/local-export-metadata'
import { runWithConcurrency } from '~/lib/run-with-concurrency'
import { readInstrumentParamsFromEffectRow } from '~/lib/effect-row-instrument-params'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import { isRenderableExportTrack, type ExportEncodingSettings, type ExportRenderSettings } from '~/lib/export/export-settings'
import { processRenderedExport } from '~/lib/export/process-rendered-export'
import { processNativeOfflinePcmSpool } from '~/lib/export/process-native-offline-pcm-spool'
import type { ExportFileSink, ExportOutputTargetFactory } from '~/lib/export/export-output-targets'
import { preflightExportResources } from '~/lib/export/export-resource-preflight'
import { captureLocalExportRenderRowsSnapshot } from '~/lib/export/capture-local-export-render-rows'
import type { ExportEffectRow, ExportEffectsProjection } from '~/lib/export/export-effect-rows'
import { listLocalExternalProcessors } from '~/lib/external-plugins'
import { getLocalProject } from '~/lib/local-project-db'
import { assertBrowserExportHasNoLiveExternalPlugins } from '@daw-browser/external-plugins'
import { compileNativeOfflineRenderPlan } from '~/lib/export/native-offline-render-plan'
import { NativeOfflineRenderError, type NativeOfflinePcmRenderer } from '~/lib/export/desktop-native-offline-pcm-renderer'
import type { NativeOfflinePcmSpoolSession } from '~/lib/export/native-offline-pcm-spool'
import type { NativeExternalAttachmentPlan } from '@daw-browser/plugin-host-protocol'
import {
  nativeAudioHostMaximumInstalledAssets,
  nativeAudioHostMaximumStretchPreparationBytes,
} from '@daw-browser/desktop-protocol/native-audio-host'
import { preparePortableStretchAssets, isPortableStretchClip, type PortablePreparedStretchAsset } from '@daw-browser/audio-engine/portable-stretch-preparation'
import type { SampledInstrumentRegionBudgetScope } from '~/lib/sampled-instrument-region-budget'

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number]
type RoomEffectParams = RoomEffectRow['params']
type OwnedExportEffectParams = ExportEffectRow['params'] | LocalEffectRow<JsonValue>['params'] | RoomEffectParams
type ExportFileCommit = Awaited<ReturnType<ExportFileSink['commit']>>

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
  renderedFrames?: number
  totalRenderFrames?: number
  analysis?: ExportAnalysisReport
}

type TimelineExportRequest = {
  nativeRendererRequired?: boolean
  getTracks: () => RuntimeTrack[]
  bpm: number
  timeSignature?: { numerator: number; denominator: number }
  masterVolume: number
  range: ExportRange
  formats: readonly ExportAudioFormat[]
  render: ExportRenderSettings
  encoding: ExportEncodingSettings
  projectId?: string
  userId?: string
  projectGeneration: number
  getProjectGeneration?: () => number
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  sidechainRoutes: ExternalSidechainRoute[]
  loadCapturedClipBuffer: (clip: RuntimeClip, signal: AbortSignal) => Promise<void>
  signal: AbortSignal
  onProgress?: (progress: ExportProgress) => void
  outputTargets: ExportOutputTargetFactory
  renderStateSnapshot: ExportRenderStateSnapshot
  nativeOfflinePcmRenderer?: NativeOfflinePcmRenderer
  sampledInstrumentRegionScope?: SampledInstrumentRegionBudgetScope
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
  | {
    type: 'error'
    message: string
    failureOwner?: 'native'
    outputs: readonly ExportOutput[]
  }

export const NATIVE_EXPORT_UNAVAILABLE_MESSAGE =
  'Native desktop export is unavailable until native offline rendering is implemented.'

export type ExportRenderStateSnapshot = {
  readonly fx: ExportFx
  readonly automationEnvelopes: readonly AutomationEnvelope[]
  readonly nativeExternalAttachments?: NativeExternalAttachmentPlan
  readonly capturedVstStates?: readonly {
    instanceId: string
    bytes: Uint8Array
    sha256: string
  }[]
}

export type ExportCloudRenderRowsSnapshot = Pick<
  FunctionReturnType<typeof convexApi.timeline.fullView>,
  'effects' | 'automationEnvelopes'
>

export type ExportAutomationPatch = {
  targetKey: string
  envelope: AutomationEnvelope | undefined
}

const cloneCloudEffectParams = (
  type: string,
  params: RoomEffectParams,
): RoomEffectParams => {
  if (type === 'eq') return normalizeEqParams(params)
  if (type === 'compressor') return normalizeCompressorParams(params)
  if (type === 'saturator') return normalizeSaturatorParams(params)
  if (type === 'delay') return normalizeDelayParams(params)
  if (type === 'reverb') return normalizeReverbParams(params)
  if (type === 'utility') return normalizeUtilityParamsEnvelope(params)
  if (type === 'autofilter') return normalizeAutoFilterParamsEnvelope(params)
  if (type === 'gate') return normalizeGateParamsEnvelope(params)
  if (type === 'limiter') return normalizeLimiterParamsEnvelope(params)
  if (type === 'lofi') return normalizeLoFiParamsEnvelope(params)
  if (type === 'chorus') return normalizeChorusParamsEnvelope(params)
  if (type === 'flanger') return normalizeFlangerParamsEnvelope(params)
  if (type === 'phaser') return normalizePhaserParamsEnvelope(params)
  if (type === 'tremolo') return normalizeTremoloParamsEnvelope(params)
  if (type === 'autopan') return normalizeAutoPanParamsEnvelope(params)
  if (type === 'ensemble') return normalizeEnsembleParamsEnvelope(params)
  if (type === 'spectral') return normalizeSpectralParamsEnvelope(params)
  if (type === 'arpeggiator') return normalizeArpeggiatorParams(params)
  if (type === 'synth') return normalizeSynthParams(params)
  if (type === 'instrument') {
    const instrument = normalizeTrackInstrumentParams(params)
    if (!instrument) throw new Error('Cloud export instrument parameters are invalid.')
    return instrument
  }
  throw new Error(`Cloud export effect "${type}" is unsupported.`)
}

export const snapshotCloudRenderRows = (
  rows: ExportCloudRenderRowsSnapshot | undefined,
): ExportCloudRenderRowsSnapshot | undefined => rows
  ? {
    effects: rows.effects.map((row) => ({
      _id: row._id,
      _creationTime: row._creationTime,
      projectId: row.projectId,
      targetType: row.targetType,
      trackId: row.trackId,
      index: row.index,
      type: row.type,
      instanceId: row.instanceId,
      params: cloneCloudEffectParams(row.type, row.params),
      createdAt: row.createdAt,
    })),
    automationEnvelopes: rows.automationEnvelopes.map((row) => ({
      _id: row._id,
      _creationTime: row._creationTime,
      projectId: row.projectId,
      targetKind: row.targetKind,
      trackId: row.trackId,
      effectInstanceId: row.effectInstanceId,
      targetKey: row.targetKey,
      parameterId: row.parameterId,
      enabled: row.enabled,
      points: row.points.map((point) => ({
        id: point.id,
        timeSec: point.timeSec,
        value: point.value,
        interpolation: point.interpolation,
      })),
      updatedAt: row.updatedAt,
    })),
  }
  : undefined

type TrackFxMap = NonNullable<ExportFx['trackFx']>
type TrackFxPatch = Partial<TrackFxMap[string]>
type ExportEffectInstanceRow = AudioEffectRuntimeInstance & {
  targetId: string
  index?: number
}

const cloneAudioBufferMap = <Value,>(buffers: ReadonlyMap<string, Value> | undefined): ReadonlyMap<string, Value> | undefined => {
  if (!buffers) return undefined
  const clone = new Map<string, Value>()
  for (const [key, buffer] of buffers) clone.set(key, buffer)
  return clone
}

const cloneExportEffectInstance = (instance: AudioEffectRuntimeInstance): AudioEffectRuntimeInstance => {
  if (instance.kind === 'eq') return { id: instance.id, kind: instance.kind, params: normalizeEqParams(instance.params) }
  if (instance.kind === 'compressor') return { id: instance.id, kind: instance.kind, params: normalizeCompressorParams(instance.params) }
  if (instance.kind === 'saturator') return { id: instance.id, kind: instance.kind, params: normalizeSaturatorParams(instance.params) }
  if (instance.kind === 'delay') return { id: instance.id, kind: instance.kind, params: normalizeDelayParams(instance.params) }
  if (instance.kind === 'reverb') return { id: instance.id, kind: instance.kind, params: normalizeReverbParams(instance.params) }
  if (instance.kind === 'utility') return { id: instance.id, kind: instance.kind, params: normalizeUtilityParamsEnvelope(instance.params) }
  if (instance.kind === 'autofilter') return { id: instance.id, kind: instance.kind, params: normalizeAutoFilterParamsEnvelope(instance.params) }
  if (instance.kind === 'gate') return { id: instance.id, kind: instance.kind, params: normalizeGateParamsEnvelope(instance.params) }
  if (instance.kind === 'limiter') return { id: instance.id, kind: instance.kind, params: normalizeLimiterParamsEnvelope(instance.params) }
  if (instance.kind === 'lofi') return { id: instance.id, kind: instance.kind, params: normalizeLoFiParamsEnvelope(instance.params) }
  if (instance.kind === 'chorus') return { id: instance.id, kind: instance.kind, params: normalizeChorusParamsEnvelope(instance.params) }
  if (instance.kind === 'flanger') return { id: instance.id, kind: instance.kind, params: normalizeFlangerParamsEnvelope(instance.params) }
  if (instance.kind === 'phaser') return { id: instance.id, kind: instance.kind, params: normalizePhaserParamsEnvelope(instance.params) }
  if (instance.kind === 'tremolo') return { id: instance.id, kind: instance.kind, params: normalizeTremoloParamsEnvelope(instance.params) }
  if (instance.kind === 'autopan') return { id: instance.id, kind: instance.kind, params: normalizeAutoPanParamsEnvelope(instance.params) }
  if (instance.kind === 'ensemble') return { id: instance.id, kind: instance.kind, params: normalizeEnsembleParamsEnvelope(instance.params) }
  return { id: instance.id, kind: instance.kind, params: normalizeSpectralParamsEnvelope(instance.params) }
}

const cloneExportFx = (fx: ExportFx): ExportFx => {
  const trackFx = fx.trackFx
    ? Object.fromEntries(Object.entries(fx.trackFx).map(([trackId, entry]) => {
      const instrument = entry.instrument ? normalizeTrackInstrumentParams(entry.instrument) : undefined
      if (entry.instrument && !instrument) throw new Error(`Track "${trackId}" has invalid instrument parameters.`)
      return [
        trackId,
        {
          instances: entry.instances.map(cloneExportEffectInstance),
          arp: entry.arp ? normalizeArpeggiatorParams(entry.arp) : undefined,
          synth: entry.synth ? normalizeSynthParams(entry.synth) : undefined,
          instrument: instrument ? instrument : undefined,
          drumRackBuffers: entry.drumRackBuffers ? cloneAudioBufferMap(entry.drumRackBuffers) : undefined,
          samplerBuffers: entry.samplerBuffers ? cloneAudioBufferMap(entry.samplerBuffers) : undefined,
          granularBuffer: entry.granularBuffer ? {
            assetKey: entry.granularBuffer.assetKey,
            buffer: entry.granularBuffer.buffer,
            sourceStartFrame: entry.granularBuffer.sourceStartFrame,
            sourceIdentity: entry.granularBuffer.sourceIdentity,
          } : undefined,
        },
      ]
    }))
    : undefined
  return {
    masterVolume: fx.masterVolume,
    masterFxInstances: fx.masterFxInstances.map(cloneExportEffectInstance),
    trackFx: trackFx ? trackFx : undefined,
  }
}

const cloneAutomationEnvelope = (envelope: AutomationEnvelope): AutomationEnvelope => ({
  id: envelope.id,
  projectId: envelope.projectId,
  target: envelope.target.kind === 'track'
    ? {
      kind: envelope.target.kind,
      trackId: envelope.target.trackId,
      effectInstanceId: envelope.target.effectInstanceId,
    }
    : {
      kind: envelope.target.kind,
      effectInstanceId: envelope.target.effectInstanceId,
    },
  targetKey: envelope.targetKey,
  parameterId: envelope.parameterId,
  enabled: envelope.enabled,
  points: envelope.points.map((point) => ({
    id: point.id,
    timeSec: point.timeSec,
    value: point.value,
    interpolation: point.interpolation,
  })),
  updatedAt: envelope.updatedAt,
})

const cloneExportEffectRow = (row: ExportEffectRow): ExportEffectRow => {
  const metadata = {
    targetId: row.targetId,
    instanceId: row.instanceId,
    index: row.index,
  }
  if (row.effect === 'eq') return { ...metadata, effect: row.effect, params: normalizeEqParams(row.params) }
  if (row.effect === 'compressor') return { ...metadata, effect: row.effect, params: normalizeCompressorParams(row.params) }
  if (row.effect === 'saturator') return { ...metadata, effect: row.effect, params: normalizeSaturatorParams(row.params) }
  if (row.effect === 'delay') return { ...metadata, effect: row.effect, params: normalizeDelayParams(row.params) }
  if (row.effect === 'reverb') return { ...metadata, effect: row.effect, params: normalizeReverbParams(row.params) }
  if (row.effect === 'utility') return { ...metadata, effect: row.effect, params: normalizeUtilityParamsEnvelope(row.params) }
  if (row.effect === 'autofilter') return { ...metadata, effect: row.effect, params: normalizeAutoFilterParamsEnvelope(row.params) }
  if (row.effect === 'gate') return { ...metadata, effect: row.effect, params: normalizeGateParamsEnvelope(row.params) }
  if (row.effect === 'limiter') return { ...metadata, effect: row.effect, params: normalizeLimiterParamsEnvelope(row.params) }
  if (row.effect === 'lofi') return { ...metadata, effect: row.effect, params: normalizeLoFiParamsEnvelope(row.params) }
  if (row.effect === 'chorus') return { ...metadata, effect: row.effect, params: normalizeChorusParamsEnvelope(row.params) }
  if (row.effect === 'flanger') return { ...metadata, effect: row.effect, params: normalizeFlangerParamsEnvelope(row.params) }
  if (row.effect === 'phaser') return { ...metadata, effect: row.effect, params: normalizePhaserParamsEnvelope(row.params) }
  if (row.effect === 'tremolo') return { ...metadata, effect: row.effect, params: normalizeTremoloParamsEnvelope(row.params) }
  if (row.effect === 'autopan') return { ...metadata, effect: row.effect, params: normalizeAutoPanParamsEnvelope(row.params) }
  if (row.effect === 'ensemble') return { ...metadata, effect: row.effect, params: normalizeEnsembleParamsEnvelope(row.params) }
  if (row.effect === 'spectral') return { ...metadata, effect: row.effect, params: normalizeSpectralParamsEnvelope(row.params) }
  if (row.effect === 'arp') return { targetId: row.targetId, effect: row.effect, params: normalizeArpeggiatorParams(row.params) }
  if (row.effect === 'synth') return { targetId: row.targetId, effect: row.effect, params: normalizeSynthParams(parseJsonValue(row.params) ?? null) }
  const instrument = normalizeTrackInstrumentParams(row.params)
  if (!instrument) throw new Error(`Instrument effect "${row.targetId}" has invalid parameters.`)
  return { targetId: row.targetId, effect: row.effect, params: instrument }
}

export const cloneExportEffectsProjection = (projection: ExportEffectsProjection | undefined): ExportEffectsProjection | undefined => (
  projection
    ? {
      replaceAudioEffectTargets: projection.replaceAudioEffectTargets.map((replacement) => ({
        targetId: replacement.targetId,
        rows: replacement.rows.map(cloneExportEffectRow),
      })),
      upsertDeviceRows: projection.upsertDeviceRows.map(cloneExportEffectRow),
    }
    : undefined
)

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
  params: OwnedExportEffectParams,
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
  const masterInstances = normalizeExportEffectInstances(masterRows)
  fx.masterFxInstances = masterInstances
  for (const [trackId, instances] of trackRows) {
    const normalized = normalizeExportEffectInstances(instances)
    applyTrackFxPatch(trackFx, trackId, { instances: normalized })
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
    if (row.effect === 'eq') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeEqParams(row.params) })
    else if (row.effect === 'compressor') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeCompressorParams(row.params) })
    else if (row.effect === 'saturator') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeSaturatorParams(row.params) })
    else if (row.effect === 'delay') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeDelayParams(row.params) })
    else if (row.effect === 'reverb') instances.push({ targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeReverbParams(row.params) })
    else instances.push(createOwnedExportEffectRow(targetId, row.instanceId, row.effect, row.params, row.index))
  }
  const normalized = normalizeExportEffectInstances(instances)
  if (targetId === 'master') {
    fx.masterFxInstances = normalized
    return
  }
  applyTrackFxPatch(ensureTrackFxMap(fx), targetId, { instances: normalized })
}

const applyLocalEffectRowsToFx = (fx: ExportFx, rows: readonly LocalEffectRow<JsonValue>[]) => {
  const trackFx = ensureTrackFxMap(fx)
  const instanceRows: ExportEffectInstanceRow[] = []
  for (const row of rows) {
    const kind = audioEffectKindFromLocalEffect(row.effect)
    if (kind) {
      if (!row.instanceId) throw new Error(`Audio effect "${kind}" is missing an instance ID.`)
      const id = row.instanceId
      const params = isJsonObject(row.params) ? row.params : {}
      if (kind === 'eq') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: AUDIO_EFFECT_CONTRACTS.eq.normalizeParams(params) })
      if (kind === 'compressor') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams(params) })
      if (kind === 'saturator') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams(params) })
      if (kind === 'delay') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams(params) })
      if (kind === 'reverb') instanceRows.push({ targetId: row.targetId, id, kind, index: row.index, params: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams(params) })
      if (kind === 'utility' || kind === 'autofilter' || kind === 'gate' || kind === 'limiter' || kind === 'lofi' ||
        kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo' || kind === 'autopan' || kind === 'ensemble' || kind === 'spectral') {
        instanceRows.push(createOwnedExportEffectRow(row.targetId, id, kind, row.params, row.index))
      }
    }
    if (row.effect === 'arp') {
      const parsed = arpeggiatorParamsSchema.safeParse(row.params)
      if (parsed.success) applyTrackFxPatch(trackFx, row.targetId, { arp: normalizeArpeggiatorParams(parsed.data) })
    }
    if (row.effect === 'synth') applyTrackFxPatch(trackFx, row.targetId, { synth: normalizeSynthParams(parseJsonValue(row.params) ?? null) })
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
        if (row.type === 'eq') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeEqParams(row.params) })
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
    if (row.type === 'arpeggiator') applyTrackFxPatch(trackFx, trackId, { arp: normalizeArpeggiatorParams(row.params) })
    if (row.type === 'synth') applyTrackFxPatch(trackFx, trackId, { synth: normalizeSynthParams(row.params) })
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
      if (row.effect === 'eq') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeEqParams(row.params) })
      else if (row.effect === 'compressor') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeCompressorParams(row.params) })
      else if (row.effect === 'saturator') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeSaturatorParams(row.params) })
      else if (row.effect === 'delay') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeDelayParams(row.params) })
      else if (row.effect === 'reverb') instances.push({ targetId: row.targetId, id: row.instanceId, kind: row.effect, index: row.index, params: normalizeReverbParams(row.params) })
      else instances.push(createOwnedExportEffectRow(row.targetId, row.instanceId, row.effect, row.params, row.index))
    }
    if (row.effect === 'arp') applyTrackFxPatch(trackFx, row.targetId, { arp: normalizeArpeggiatorParams(row.params) })
    if (row.effect === 'synth') applyTrackFxPatch(trackFx, row.targetId, { synth: normalizeSynthParams(parseJsonValue(row.params) ?? null) })
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
  if (!patches || patches.length === 0) return envelopes.map(cloneAutomationEnvelope)
  const merged = new Map(envelopes.map((envelope) => [envelope.targetKey, envelope]))
  for (const patch of patches) {
    if (patch.envelope) merged.set(patch.targetKey, cloneAutomationEnvelope(patch.envelope))
    else merged.delete(patch.targetKey)
  }
  return Array.from(merged.values(), cloneAutomationEnvelope)
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

const createExportRangeClipPredicate = (
  tracks: readonly RuntimeTrack[],
  range: ExportRange,
): ((clip: RuntimeClip) => boolean) => {
  const { startSec: rangeStart, endSec: rangeEnd } = getExportRangeBounds(tracks, range)
  return (clip) => {
    const clipEnd = clip.startSec + clip.duration
    return clipEnd > rangeStart && clip.startSec < rangeEnd
  }
}

const filterTracksToExportRange = (
  tracks: readonly RuntimeTrack[],
  range: ExportRange,
) => {
  const intersects = createExportRangeClipPredicate(tracks, range)
  return tracks.map((track) => ({
    ...track,
    clips: track.clips.filter(intersects),
  }))
}

async function ensureBuffersForRange(input: ExportTrackSnapshotInput) {
  const intersects = createExportRangeClipPredicate(input.tracks, input.range)
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

export type ExportExternalPluginPolicy = 'browser-export' | 'native-playback' | 'native-offline'

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
      fx: cloneExportFx(fx),
      automationEnvelopes: applyAutomationPatches(rows.automationEnvelopes, automationPatches),
    }
  }
  if (!localOnly && projectId && userId) {
    if (!cloudRows) throw new Error('Cloud timeline snapshot is unavailable.')
    applyRoomEffectRowsToFx(fx, cloudRows.effects)
    applyEffectsProjectionToFx(fx, effectsProjection)
    return {
      fx: cloneExportFx(fx),
      automationEnvelopes: applyAutomationPatches(cloudRows.automationEnvelopes.flatMap((row) => {
        const envelope = automationEnvelopeFromRow(row)
        return envelope ? [envelope] : []
      }), automationPatches),
    }
  }
  return { fx: cloneExportFx(fx), automationEnvelopes: [] }
}

export async function loadInstrumentExportBuffers(
  fx: ExportFx,
  signal: AbortSignal,
  allowedTrackIds?: ReadonlySet<string>,
  projectId?: string,
  sampledInstrumentRegionScope?: SampledInstrumentRegionBudgetScope,
): Promise<void> {
  const trackFx = fx.trackFx
  if (!trackFx) return
  const budget = sampledInstrumentRegionScope
  type ExportSample = {
    assetKey: string
    url: string
    sourceKind: 'upload' | 'url' | 'recording'
    source: { durationSec: number; sampleRate: number; channelCount: number }
  }
  type Consumer = {
    input: ExportSample
    bounds: { sourceStartFrame: number; sourceEndFrame: number }
    decodedBytes: number
    maxDecodedBytes: number
    install: (buffer: SampledInstrumentBuffer) => void
    current: SampledInstrumentBuffer | undefined
  }
  type RegionJob = {
    key: string
    bytes: number
    consumers: Consumer[]
    existing?: SampledInstrumentBuffer
  }
  const jobsByIdentity = new Map<string, RegionJob>()
  const matchesRegion = (
    buffer: SampledInstrumentBuffer | undefined,
    sample: ExportSample,
    region: { sourceStartFrame: number; sourceEndFrame: number },
  ) => buffer !== undefined
    && buffer.sourceIdentity === sampledInstrumentRegionIdentity(sample, region)
    && (() => {
      try {
        return validateSampledInstrumentBuffer(buffer, sample.source, region) === buffer
      } catch {
        return false
      }
    })()
  const addConsumer = (
    key: string,
    retainedBytes: number,
    consumer: Consumer,
  ) => {
    if (consumer.decodedBytes > consumer.maxDecodedBytes) {
      throw new Error(`Sampled instrument region exceeds the ${consumer.maxDecodedBytes} byte limit.`)
    }
    const existing = jobsByIdentity.get(key)
    if (existing) {
      existing.consumers.push(consumer)
      existing.bytes = Math.max(existing.bytes, retainedBytes)
      if (!existing.existing && consumer.current) existing.existing = consumer.current
      return
    }
    jobsByIdentity.set(key, {
      key,
      bytes: retainedBytes,
      consumers: [consumer],
      existing: consumer.current,
    })
  }
  for (const [trackId, entry] of Object.entries(trackFx)) {
    if (allowedTrackIds && !allowedTrackIds.has(trackId)) continue
    if (entry.instrument?.kind === 'drum-rack') {
      const buffers = new Map<string, SampledInstrumentBuffer>(entry.drumRackBuffers ?? [])
      entry.drumRackBuffers = buffers
      for (const pad of entry.instrument.params.pads) {
        const sample = pad.sample
        const region = sample
          ? sampledInstrumentRegion(sample.source, pad.startSec, pad.endSec ?? sample.source.durationSec)
          : undefined
        if (sample && region) {
          const key = sampledInstrumentRegionIdentity(sample, region)
          addConsumer(key, sampledInstrumentRegionBytes(region, sample.source.channelCount), {
            input: sample,
            bounds: region,
            decodedBytes: sampledInstrumentRegionBytes(region, sample.source.channelCount),
            maxDecodedBytes: 64 * 1024 * 1024,
            current: matchesRegion(buffers.get(pad.id), sample, region) ? buffers.get(pad.id) : undefined,
            install: (buffer) => buffers.set(pad.id, buffer),
          })
        }
      }
      const localRegions = new Map<string, number>()
      for (const pad of entry.instrument.params.pads) {
        if (!pad.sample) continue
        const region = sampledInstrumentRegion(pad.sample.source, pad.startSec, pad.endSec ?? pad.sample.source.durationSec)
        localRegions.set(sampledInstrumentRegionIdentity(pad.sample, region), sampledInstrumentRegionBytes(region, pad.sample.source.channelCount))
      }
      const localBytes = [...localRegions.values()].reduce((total, bytes) => total + bytes, 0)
      if (localBytes > 64 * 1024 * 1024) throw new Error(`Drum Rack regions exceed the ${64 * 1024 * 1024} byte limit.`)
    }
    if (entry.instrument?.kind === 'sampler') {
      const buffers = new Map<string, SampledInstrumentBuffer>(entry.samplerBuffers ?? [])
      entry.samplerBuffers = buffers
      const localRegions = new Map<string, number>()
      for (const zone of entry.instrument.params.zones) {
        const region = sampledInstrumentRegion(zone.sample.source, zone.startSec, zone.endSec ?? zone.sample.source.durationSec)
        const key = sampledInstrumentRegionIdentity(zone.sample, region)
        const bytes = sampledInstrumentRegionBytes(region, zone.sample.source.channelCount)
        localRegions.set(key, bytes)
        addConsumer(key, bytes, {
          input: zone.sample,
          bounds: region,
          decodedBytes: bytes,
          maxDecodedBytes: entry.instrument.params.maxDecodedBytes,
          current: matchesRegion(buffers.get(zone.id), zone.sample, region) ? buffers.get(zone.id) : undefined,
          install: (buffer) => buffers.set(zone.id, buffer),
        })
      }
      const localBytes = [...localRegions.values()].reduce((total, bytes) => total + bytes, 0)
      if (localBytes > entry.instrument.params.maxDecodedBytes) {
        throw new Error(`Sampler regions exceed the ${entry.instrument.params.maxDecodedBytes} byte limit.`)
      }
    }
    if (entry.instrument?.kind === 'granular') {
      const zone = entry.instrument.params.zone
      if (!zone) {
        entry.granularBuffer = undefined
      } else {
        const region = sampledInstrumentRegion(zone.sample.source, zone.startSec, zone.endSec ?? zone.sample.source.durationSec)
        const existing = entry.granularBuffer
        const currentIdentity = sampledInstrumentRegionIdentity(zone.sample, region)
        const decodedBytes = sampledInstrumentRegionBytes(region, zone.sample.source.channelCount)
        addConsumer(currentIdentity, sampledInstrumentRetainedBytes(decodedBytes, 2), {
          input: zone.sample,
          bounds: region,
          decodedBytes,
          maxDecodedBytes: entry.instrument.params.maxDecodedBytes,
          current: existing?.assetKey === currentIdentity && matchesRegion(existing, zone.sample, region) ? existing : undefined,
          install: (buffer) => {
            entry.granularBuffer = {
              assetKey: currentIdentity,
              buffer: buffer.buffer,
              sourceStartFrame: buffer.sourceStartFrame,
              sourceIdentity: buffer.sourceIdentity,
            }
          },
        })
        if (decodedBytes > entry.instrument.params.maxDecodedBytes) {
          throw new Error(`Granular regions exceed the ${entry.instrument.params.maxDecodedBytes} byte limit.`)
        }
      }
    }
  }
  const jobs = [...jobsByIdentity.values()]
  if (jobs.length === 0) return
  const leasedExisting = (job: RegionJob) => (
    job.existing !== undefined
    && budget?.isLeased(job.existing.buffer) === true
  )
  if (budget) {
    budget.ensureCapacityFor(new Map(
      jobs
        .filter((job) => !leasedExisting(job))
        .map((job) => [job.key, job.bytes]),
    ))
  }
  for (const job of jobs) {
    if (!job.existing) continue
    if (!leasedExisting(job)) budget?.set(job.key, job.bytes, () => undefined, job.existing.buffer)
    for (const consumer of job.consumers) consumer.install(job.existing)
  }
  const loads = jobs.filter((job) => !job.existing)
  const reservations = new Map<string, { release: () => void; commit: () => void }>()
  if (budget) {
    for (const job of loads) reservations.set(job.key, budget.reserve(job.key, job.bytes))
  }
  try {
    await runWithConcurrency(loads, MAX_CONCURRENT_BUFFER_LOADS, async (job) => {
    throwIfExportAborted(signal)
    const buffer = await loadSampledInstrumentRegion(
      job.consumers[0]?.input ?? (() => { throw new Error('Export sample job has no consumer.') })(),
      job.consumers[0]?.bounds ?? (() => { throw new Error('Export sample job has no bounds.') })(),
      job.consumers[0]?.maxDecodedBytes ?? 0,
      signal,
      projectId ? { projectId: () => projectId } : {},
    )
    if (!buffer) throw new Error(`Failed to preload export sample ${job.consumers[0]?.input.url ?? job.key}`)
    const reservation = reservations.get(job.key)
    reservation?.commit()
    budget?.set(job.key, job.bytes, () => undefined, buffer.buffer)
    for (const consumer of job.consumers) consumer.install(buffer)
    })
    throwIfExportAborted(signal)
  } finally {
    for (const reservation of reservations.values()) reservation.release()
  }
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
  let outputTarget: Awaited<ReturnType<ExportOutputTargetFactory["createMixdownTarget"]>> | undefined
  let localProjectId: string | undefined
  let nativeSpool: NativeOfflinePcmSpoolSession | undefined
  let nativeSpoolRemoved = false
  const removeNativeSpool = async () => {
    if (!nativeSpool || nativeSpoolRemoved) return
    await nativeSpool.remove()
    nativeSpoolRemoved = true
  }
  const saveCompletedLocalMetadata = async () => {
    if (!localProjectId) return
    await saveLocalExportMetadataBatch(localProjectId, localMetadataRows)
    localMetadataRows.length = 0
  }
  try {
    if (input.nativeRendererRequired && !input.nativeOfflinePcmRenderer) {
      throw new Error(NATIVE_EXPORT_UNAVAILABLE_MESSAGE)
    }
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
    const localProject = projectId ? await getLocalProject(projectId) : undefined
    localProjectId = projectId && (isLocalId('project', projectId) || localProject !== undefined) ? projectId : undefined
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
    const fx = cloneExportFx(input.renderStateSnapshot.fx)
    const automationEnvelopes = input.renderStateSnapshot.automationEnvelopes.map(cloneAutomationEnvelope)
    const bufferLoadTracks = input.nativeRendererRequired
      ? preloadTracks.map((track) => ({
        ...track,
        clips: track.clips.filter(isPortableStretchClip),
      }))
      : preloadTracks
    const [exportMixdown] = await Promise.all([
      mixdownModule,
      ensureBuffersForRange({ ...input, tracks: bufferLoadTracks }),
      loadInstrumentExportBuffers(
        fx,
        input.signal,
        undefined,
        localProjectId,
        input.sampledInstrumentRegionScope,
      ),
    ])
    throwIfExportAborted(input.signal)
    let preparedStretchAssets: readonly PortablePreparedStretchAsset[] = []
    const nativeTracks = input.nativeRendererRequired
      ? filterTracksToExportRange(preloadTracks, input.range)
      : preloadTracks
    if (input.nativeRendererRequired && nativeTracks.some((track) => track.clips.some(isPortableStretchClip))) {
      const preparation = await preparePortableStretchAssets({
        tracks: nativeTracks,
        projectBpm: input.bpm,
        projectGeneration: input.projectGeneration,
        requiredSampleRateHz: input.render.sampleRate,
        maximumAssetCount: nativeAudioHostMaximumInstalledAssets,
        maximumPreparationBytes: nativeAudioHostMaximumStretchPreparationBytes,
        createBuffer: input.createBuffer ?? ((channels, frames, sampleRate) => new AudioBuffer({
          numberOfChannels: channels,
          length: frames,
          sampleRate,
        })),
        signal: input.signal,
      })
      throwIfExportAborted(input.signal)
      if (!preparation.supported) {
        throw new Error(preparation.diagnostics.map((diagnostic) => diagnostic.message).join(' '))
      }
      preparedStretchAssets = preparation.assets
    }
    if (input.getProjectGeneration && input.getProjectGeneration() !== input.projectGeneration) {
      throw new Error('Project changed while preparing export.')
    }
    const nativePlan = input.nativeRendererRequired
      ? compileNativeOfflineRenderPlan({
        tracks: nativeTracks,
        fx,
        automationEnvelopes,
        sidechainRoutes: input.sidechainRoutes,
        bpm: input.bpm,
        timeSignature: input.timeSignature,
        range: input.range,
        sampleRateHz: input.render.sampleRate,
        channelCount: input.render.numberOfChannels,
        tailFrames: Math.ceil(tailMaximumSec * input.render.sampleRate),
        projectId: input.projectId,
        projectGeneration: input.projectGeneration,
        preparedStretchAssets,
        externalAttachments: input.renderStateSnapshot.nativeExternalAttachments,
        capturedVstStates: input.renderStateSnapshot.capturedVstStates,
      })
      : undefined
    outputTarget = await input.outputTargets.createMixdownTarget({
      projectId,
      localProject: Boolean(localProjectId),
      multiFormat,
      firstFormat,
      firstFileName,
      firstFileTypes: createSaveTypes(firstFormat),
    })
    throwIfExportAborted(input.signal)
    input.onProgress?.({ phase: 'rendering' })
    let rendered: AudioBuffer | undefined
    if (nativePlan) {
      const nativeRenderer = input.nativeOfflinePcmRenderer
      if (!nativeRenderer) throw new Error(NATIVE_EXPORT_UNAVAILABLE_MESSAGE)
      const spool = await nativeRenderer(nativePlan, input.signal, (renderedFrames, totalFrames) => {
        input.onProgress?.({ phase: 'rendering', renderedFrames, totalRenderFrames: totalFrames })
      })
      nativeSpool = spool
      nativeSpoolRemoved = false
      const processed = await processNativeOfflinePcmSpool({
        spool,
        sourceDurationSec: sourceBounds.endSec - sourceBounds.startSec,
        render: input.render,
        signal: input.signal,
      })
      input.onProgress?.({ phase: 'analyzing' })
      if (input.render.normalization.mode !== 'none') input.onProgress?.({ phase: 'gain' })
      if (input.render.normalization.mode === 'loudness' && input.render.normalization.limiting === 'true-peak') {
        input.onProgress?.({ phase: 'limiting' })
      }
      input.onProgress?.({ phase: 'verifying', analysis: processed.analysis })
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
          const enc = await exportMixdown.encodeAudioChunks(processed.replay(), {
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
            outputs.push({ destination: 'local', name: savedName, sizeBytes, analysis: processed.analysis })
          } else {
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
            throwIfExportAborted(input.signal)
            if (localProjectId) {
              if (saved.destination !== 'local') {
                throw new Error('Local export target selected a cloud destination.')
              }
              localMetadataRows.push({
                name: saved.name,
                format: enc.format,
                durationSec: enc.durationSec,
                sampleRate: enc.sampleRate,
                sizeBytes,
              })
              outputs.push({
                destination: 'local',
                name: saved.name,
                sizeBytes,
                analysis: processed.analysis,
              })
            } else {
              if (saved.destination !== 'cloud') {
                throw new Error('Cloud export target selected a local destination.')
              }
              outputs.push({
                destination: 'cloud',
                name: saved.name,
                url: saved.url,
                sizeBytes,
                analysis: processed.analysis,
              })
            }
          }
        } catch (error) {
          await fileSink?.abort(error)
          throw error
        }
        completedFormats += 1
      }
      await saveCompletedLocalMetadata()
      await removeNativeSpool()
      return { type: 'success', outputs }
    } else {
      rendered = await exportMixdown.renderMixdown({
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
    }
    throwIfExportAborted(input.signal)
    if (!rendered) throw new Error('Browser export did not produce audio.')
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
    return {
      type: 'error',
      message: err instanceof Error ? err.message : 'Export failed',
      failureOwner: err instanceof NativeOfflineRenderError ? 'native' : undefined,
      outputs,
    }
  } finally {
    try {
      await removeNativeSpool()
    } catch (cleanupError) {
      console.error('[export] native offline PCM cleanup failed after export failure', cleanupError)
    }
    try {
      await outputTarget?.dispose?.()
    } catch {}
    input.sampledInstrumentRegionScope?.release()
  }
}

export async function runStemExport(input: StemExportRequest): Promise<ExportOutcome> {
  const outputs: ExportOutput[] = []
  try {
    if (input.nativeRendererRequired) {
      return { type: 'error', message: NATIVE_EXPORT_UNAVAILABLE_MESSAGE, outputs }
    }
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
    const fx = cloneExportFx(input.renderStateSnapshot.fx)
    const automationEnvelopes = input.renderStateSnapshot.automationEnvelopes.map(cloneAutomationEnvelope)
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
    const localProject = input.projectId ? await getLocalProject(input.projectId) : undefined
    const localProjectId = input.projectId
      && (isLocalId('project', input.projectId) || localProject !== undefined)
      ? input.projectId
      : undefined
    await Promise.all([
      ensureBuffersForRange({ ...input, tracks: preloadAssetTracks, range: input.range }),
      loadInstrumentExportBuffers(
        fx,
        input.signal,
        preloadTrackIds,
        localProjectId,
        input.sampledInstrumentRegionScope,
      ),
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
        let committed: ExportFileCommit = {}
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
    return {
      type: 'error',
      message: err instanceof Error ? err.message : 'Stem export failed',
      outputs,
    }
  } finally {
    input.sampledInstrumentRegionScope?.release()
  }
}
