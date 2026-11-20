import type { AudioEffectRuntimeInstance, ExportFx } from '@daw-browser/audio-engine/export-mixdown'
import type { FunctionReturnType } from 'convex/server'
import type { NativeExternalAttachmentPlan } from '@daw-browser/plugin-host-protocol'
import {
  type AutomationEnvelope,
  type JsonValue,
  arpeggiatorParamsSchema,
  isDspAudioEffectKind,
  type DspAudioEffectKind,
  normalizeAudioEffect,
  normalizeAudioEffectRow,
  normalizeArpeggiatorParams,
  normalizeSynthParams,
  normalizeTrackInstrumentParams,
  parseJsonValue,
} from '@daw-browser/shared'
import type { convexApi } from '~/lib/convex'
import { audioEffectKindFromLocalEffect, type LocalEffectRow } from '~/lib/local-effects'
import { compareAudioEffectOrderEntries } from '~/lib/audio-effect-order-rows'
import { readInstrumentParamsFromEffectRow } from '~/lib/effect-row-instrument-params'
import type { ExportEffectRow, ExportEffectsProjection } from '~/lib/export/export-effect-rows'

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number]

type RoomEffectParams = RoomEffectRow['params']

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
  if (isDspAudioEffectKind(type)) return normalizeAudioEffect(type, params).params

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

const cloneExportEffectInstance = (instance: AudioEffectRuntimeInstance): AudioEffectRuntimeInstance => (
  { id: instance.id, ...normalizeAudioEffect(instance.kind, instance.params) }
)

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

const isDspEffectRow = (row: ExportEffectRow): row is Extract<ExportEffectRow, { effect: DspAudioEffectKind }> => isDspAudioEffectKind(row.effect)

const cloneExportEffectRow = (row: ExportEffectRow): ExportEffectRow => {
  const metadata = {
    targetId: row.targetId,
    instanceId: row.instanceId,
    index: row.index,
  }

  if (isDspEffectRow(row)) return { ...metadata, ...normalizeAudioEffectRow(row.effect, row.params) }

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

const normalizeExportEffectInstances = (rows: ExportEffectInstanceRow[]): AudioEffectRuntimeInstance[] => {
  const seen = new Set<string>()
  const instances: AudioEffectRuntimeInstance[] = []

  for (const { targetId: _targetId, index: _index, ...instance } of rows.sort(compareAudioEffectOrderEntries)) {
    if (seen.has(instance.id)) continue
    seen.add(instance.id)
    instances.push(instance)
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

    instances.push({ targetId, id: row.instanceId, index: row.index, ...normalizeAudioEffect(row.effect, row.params) })
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

      if (isDspAudioEffectKind(kind)) instanceRows.push({ targetId: row.targetId, id, index: row.index, ...normalizeAudioEffect(kind, row.params) })
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

        instanceRows.push({ targetId, id, index: row.index, ...normalizeAudioEffect(row.type, row.params) })
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
      instances.push({ targetId: row.targetId, id: row.instanceId, index: row.index, ...normalizeAudioEffect(row.effect, row.params) })
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
