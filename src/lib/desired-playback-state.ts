import type { AudioEffectRuntimeInstance, ExportFx } from '@daw-browser/audio-engine/export-mixdown'
import type { FunctionReturnType } from 'convex/server'
import type { NativeExternalAttachmentPlan } from '@daw-browser/plugin-host-protocol'
import {
  AUDIO_EFFECT_CONTRACTS,
  type AutomationEnvelope,
  type JsonValue,
  arpeggiatorParamsSchema,
  isDspAudioEffectKind,
  isOwnedProcessorKind,
  isJsonObject,
  normalizeArpeggiatorParams,
  normalizeAutoFilterParamsEnvelope,
  normalizeAutoPanParamsEnvelope,
  normalizeChorusParamsEnvelope,
  normalizeCompressorParams,
  normalizeDelayParams,
  normalizeEnsembleParamsEnvelope,
  normalizeEqParams,
  normalizeFlangerParamsEnvelope,
  normalizeGateParamsEnvelope,
  normalizeLimiterParamsEnvelope,
  normalizeLoFiParamsEnvelope,
  normalizePhaserParamsEnvelope,
  normalizeReverbParams,
  normalizeSaturatorParams,
  normalizeSpectralParamsEnvelope,
  normalizeSynthParams,
  normalizeTremoloParamsEnvelope,
  normalizeTrackInstrumentParams,
  normalizeUtilityParamsEnvelope,
  parseJsonValue,
  type OwnedProcessorKind,
} from '@daw-browser/shared'
import type { convexApi } from '~/lib/convex'
import { audioEffectKindFromLocalEffect, type LocalEffectRow } from '~/lib/local-effects'
import { compareAudioEffectOrderEntries } from '~/lib/audio-effect-order-rows'
import { readInstrumentParamsFromEffectRow } from '~/lib/effect-row-instrument-params'
import type { ExportEffectRow, ExportEffectsProjection } from '~/lib/export/export-effect-rows'

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number]

type RoomEffectParams = RoomEffectRow['params']

type OwnedExportEffectParams = ExportEffectRow['params'] | LocalEffectRow<JsonValue>['params'] | RoomEffectParams

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

export const cloneExportFx = (fx: ExportFx): ExportFx => {
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
          unavailableSampleAssetKeys: entry.unavailableSampleAssetKeys?.slice(),
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

export const cloneAutomationEnvelope = (envelope: AutomationEnvelope): AutomationEnvelope => ({
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
      clearInstrumentTargets: projection.clearInstrumentTargets?.slice(),
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
  kind: OwnedProcessorKind,
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
    if (!isDspAudioEffectKind(row.effect) || !row.instanceId) continue

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

export const applyLocalEffectRowsToFx = (fx: ExportFx, rows: readonly LocalEffectRow<JsonValue>[]) => {
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

      if (isOwnedProcessorKind(kind)) {
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

export const applyRoomEffectRowsToFx = (fx: ExportFx, rows: readonly RoomEffectRow[]) => {
  const trackFx = ensureTrackFxMap(fx)
  const instanceRows: ExportEffectInstanceRow[] = []

  for (const row of rows) {
    if (isDspAudioEffectKind(row.type)) {
      const targetId = row.targetType === 'master' ? 'master' : row.trackId

      if (targetId && row.params) {
        if (!row.instanceId) throw new Error(`Audio effect "${row.type}" is missing an instance ID.`)
        const id = row.instanceId

        if (row.type === 'eq') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeEqParams(row.params) })

        if (row.type === 'compressor') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeCompressorParams(row.params) })

        if (row.type === 'saturator') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeSaturatorParams(row.params) })

        if (row.type === 'delay') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeDelayParams(row.params) })

        if (row.type === 'reverb') instanceRows.push({ targetId, id, kind: row.type, index: row.index, params: normalizeReverbParams(row.params) })

        if (isOwnedProcessorKind(row.type)) {
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
    if (isDspAudioEffectKind(row.effect) && row.instanceId) {
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

export const applyEffectsProjectionToFx = (fx: ExportFx, projection: ExportEffectsProjection | undefined) => {
  if (!projection) return

  for (const targetId of projection.clearInstrumentTargets ?? []) {
    const entry = fx.trackFx?.[targetId]

    if (entry) {
      delete entry.instrument
      delete entry.synth
      delete entry.arp
    }
  }

  for (const replacement of projection.replaceAudioEffectTargets) {
    replaceExportEffectInstancesForTarget(fx, replacement.targetId, replacement.rows)
  }

  applyProjectedEffectRowsToFx(fx, projection.upsertDeviceRows)
}

export const resolveDesiredPlaybackFx = (
  previous: ExportFx,
  projection: ExportEffectsProjection | undefined,
  cloudRows: ExportCloudRenderRowsSnapshot | undefined,
) => {
  const fx = cloneExportFx(previous)

  if (cloudRows) applyRoomEffectRowsToFx(fx, cloudRows.effects)
  applyEffectsProjectionToFx(fx, projection)

  return fx
}
