import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { z } from "zod";
import { requireAuthenticatedUserId, requireMasterBusWriteAccess, requireProjectAccess } from "./projectAccess";
import { getTrackWriteAccess } from "./trackWrites";
import { runSharedOperationOnce } from "./sharedOperationResults";
import { advanceProjectRevision } from "./projectRows";
import { legacySynthParamsValidator, synthParamsValidator, trackInstrumentValidator } from "./synthValidators";
import {
  normalizeEqParamsForUpdate,
  normalizeCompressorParamsForUpdate,
  normalizeDelayParamsForUpdate,
  normalizeReverbParamsForUpdate,
  normalizeSaturatorParamsForUpdate,
  normalizeSynthParams,
  normalizeTrackInstrumentParams,
  normalizeArpeggiatorParams,
  normalizeAudioEffectParamsForUpdate,
  AUDIO_EFFECT_CONTRACTS,
  audioEffectOrderItemId,
  audioEffectOrderItemKind,
  mergeOwnedProcessorParams,
  serializeCompressorParams,
  serializeDelayParams,
  serializeEqParams,
  serializeReverbParams,
  serializeSaturatorParams,
  parseGranularAutomationKey,
  parseInstrumentAutomationKey,
  parseSynthAutomationKey,
  isJsonObject,
  isJsonString,
  type JsonValue,
} from "@daw-browser/shared";

const reverbParamsValidator = v.object({
  enabled: v.boolean(),
  wet: v.number(),
  decaySec: v.number(),
  preDelayMs: v.number(),
  reflections: v.optional(v.number()),
  reflectionSpin: v.optional(v.boolean()),
  reflectionModAmountMs: v.optional(v.number()),
  reflectionModRateHz: v.optional(v.number()),
  ["reflectionShape"]: v.optional(v.number()),
  diffuse: v.optional(v.number()),
  size: v.optional(v.number()),
  diffusion: v.optional(v.number()),
  density: v.optional(v.number()),
  lowCutHz: v.optional(v.number()),
  highCutHz: v.optional(v.number()),
  diffusionLowCutHz: v.optional(v.number()),
  diffusionHighCutHz: v.optional(v.number()),
  stereoWidth: v.optional(v.number()),
})

const eqBandTypeValidator = v.union(
  v.literal("allpass"),
  v.literal("bandpass"),
  v.literal("highpass"),
  v.literal("highshelf"),
  v.literal("lowpass"),
  v.literal("lowshelf"),
  v.literal("notch"),
  v.literal("peaking"),
)

const eqParamsValidator = v.object({
  enabled: v.boolean(),
  channelMode: v.optional(v.union(v.literal("mono"), v.literal("stereo"))),
  bands: v.array(v.object({
    id: v.string(),
    type: eqBandTypeValidator,
    frequency: v.number(),
    gainDb: v.number(),
    q: v.number(),
    enabled: v.boolean(),
  })),
})

const compressorParamsValidator = v.object({
  enabled: v.boolean(),
  thresholdDb: v.number(),
  ratio: v.number(),
  attackMs: v.number(),
  releaseMs: v.number(),
  autoRelease: v.boolean(),
  makeupDb: v.number(),
  outputDb: v.number(),
  dryWet: v.number(),
  kneeDb: v.number(),
  lookaheadMs: v.number(),
  detectorMode: v.union(v.literal('peak'), v.literal('rms')),
  dynamicsMode: v.union(v.literal('compress'), v.literal('expand')),
  envelopeCurve: v.union(v.literal('log'), v.literal('linear')),
  sidechain: v.object({
    enabled: v.boolean(),
    filterType: v.union(v.literal('lowpass'), v.literal('highpass'), v.literal('bandpass')),
    frequencyHz: v.number(),
    q: v.number(),
  }),
})

const saturatorParamsValidator = v.object({
  enabled: v.boolean(),
  driveDb: v.number(),
  curve: v.union(v.literal("soft"), v.literal("medium"), v.literal("hard"), v.literal("clip")),
  color: v.boolean(),
  colorFrequencyHz: v.number(),
  colorAmount: v.number(),
  outputDb: v.number(),
  dryWet: v.number(),
})

const delayParamsValidator = v.object({
  enabled: v.boolean(),
  mode: v.union(v.literal("sync"), v.literal("time")),
  timeMs: v.number(),
  syncDivision: v.union(v.literal("1/16"), v.literal("1/8"), v.literal("1/4"), v.literal("1/2"), v.literal("1/1")),
  feedback: v.number(),
  dryWet: v.number(),
  pingPong: v.boolean(),
  filterEnabled: v.boolean(),
  lowCutHz: v.number(),
  highCutHz: v.number(),
})

const processorEnvelopeValidator = v.object({ version: v.literal(1), state: v.any() })
const processorEffectValidator = v.union(v.literal("utility"), v.literal("gate"), v.literal("limiter"), v.literal("spectral"))
const modulationEffectValidator = v.union(v.literal("autofilter"), v.literal("chorus"), v.literal("flanger"), v.literal("phaser"), v.literal("tremolo"), v.literal("autopan"), v.literal("ensemble"), v.literal("lofi"))
const canonicalAudioEffectKindValidator = v.union(v.literal("utility"), v.literal("eq"), v.literal("autofilter"), v.literal("gate"), v.literal("compressor"), v.literal("saturator"), v.literal("limiter"), v.literal("lofi"), v.literal("chorus"), v.literal("flanger"), v.literal("phaser"), v.literal("tremolo"), v.literal("autopan"), v.literal("ensemble"), v.literal("delay"), v.literal("reverb"), v.literal("spectral"))
const audioEffectOrderItemValidator = v.union(
  canonicalAudioEffectKindValidator,
  v.object({ id: v.string(), kind: canonicalAudioEffectKindValidator }),
)

type AudioEffectKind = 'utility' | 'eq' | 'autofilter' | 'gate' | 'compressor' | 'saturator' | 'limiter' | 'lofi' | 'chorus' | 'flanger' | 'phaser' | 'tremolo' | 'autopan' | 'ensemble' | 'delay' | 'reverb' | 'spectral'
type TrackAudioEffectType = 'instrument' | 'synth' | 'arpeggiator' | AudioEffectKind
type MasterAudioEffectType = AudioEffectKind
type SharedAudioEffectType = TrackAudioEffectType | MasterAudioEffectType
type AudioEffectOrderItem = AudioEffectKind | { id: string; kind: AudioEffectKind }
type EffectRowWriteResult = {
  changed: boolean
  status: 'created' | 'updated' | 'noop' | 'invalid'
  effectId?: Id<'effects'>
}
type EffectRowRemoveResult = {
  changed: boolean
  status: 'deleted' | 'not-found'
  effectId?: Id<'effects'>
}
type EffectRowReorderResult = {
  changed: boolean
  status: 'applied' | 'noop'
}
const isCanonicalAudioEffectKind = (type: string): type is AudioEffectKind => (
  type === 'utility' || type === 'eq' || type === 'autofilter' || type === 'gate' || type === 'compressor' || type === 'saturator' || type === 'limiter'
  || type === 'lofi' || type === 'chorus' || type === 'flanger' || type === 'phaser' || type === 'tremolo' || type === 'autopan' || type === 'ensemble'
  || type === 'delay' || type === 'reverb' || type === 'spectral'
)

const audioEffectPersistenceDescriptors = {
  utility: {
    normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('utility', params, existing),
    serializeParams: AUDIO_EFFECT_CONTRACTS.utility.serializeParams,
  },
  eq: {
    normalizeParamsForUpdate: normalizeEqParamsForUpdate,
    serializeParams: serializeEqParams,
  },
  autofilter: {
    normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('autofilter', params, existing),
    serializeParams: AUDIO_EFFECT_CONTRACTS.autofilter.serializeParams,
  },
  gate: {
    normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('gate', params, existing),
    serializeParams: AUDIO_EFFECT_CONTRACTS.gate.serializeParams,
  },
  limiter: {
    normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('limiter', params, existing),
    serializeParams: AUDIO_EFFECT_CONTRACTS.limiter.serializeParams,
  },
  lofi: {
    normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('lofi', params, existing),
    serializeParams: AUDIO_EFFECT_CONTRACTS.lofi.serializeParams,
  },
  compressor: {
    normalizeParamsForUpdate: normalizeCompressorParamsForUpdate,
    serializeParams: serializeCompressorParams,
  },
  saturator: {
    normalizeParamsForUpdate: normalizeSaturatorParamsForUpdate,
    serializeParams: serializeSaturatorParams,
  },
  delay: {
    normalizeParamsForUpdate: normalizeDelayParamsForUpdate,
    serializeParams: serializeDelayParams,
  },
  reverb: {
    normalizeParamsForUpdate: normalizeReverbParamsForUpdate,
    serializeParams: serializeReverbParams,
  },
  chorus: { normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('chorus', params, existing), serializeParams: AUDIO_EFFECT_CONTRACTS.chorus.serializeParams },
  flanger: { normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('flanger', params, existing), serializeParams: AUDIO_EFFECT_CONTRACTS.flanger.serializeParams },
  phaser: { normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('phaser', params, existing), serializeParams: AUDIO_EFFECT_CONTRACTS.phaser.serializeParams },
  tremolo: { normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('tremolo', params, existing), serializeParams: AUDIO_EFFECT_CONTRACTS.tremolo.serializeParams },
  autopan: { normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('autopan', params, existing), serializeParams: AUDIO_EFFECT_CONTRACTS.autopan.serializeParams },
  ensemble: { normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('ensemble', params, existing), serializeParams: AUDIO_EFFECT_CONTRACTS.ensemble.serializeParams },
  spectral: { normalizeParamsForUpdate: (params: any, existing?: any) => mergeOwnedProcessorParams('spectral', params, existing), serializeParams: AUDIO_EFFECT_CONTRACTS.spectral.serializeParams },
}
type AudioEffectPersistenceType = keyof typeof audioEffectPersistenceDescriptors
const deletedStatus = () => ({ status: 'deleted' })
const notFoundStatus = () => ({ status: 'not-found' })
const effectRowWriteResult = (
  status: 'created' | 'updated' | 'noop',
  effectId: Id<'effects'>,
): EffectRowWriteResult => ({
  changed: status !== 'noop',
  status,
  effectId,
})

const finishEffectMutation = async <Value>(
  ctx: any,
  projectId: string,
  result: { changed: boolean; value: Value },
) => {
  if (result.changed) await advanceProjectRevision(ctx, projectId)
  return result.value
}

const sanitizeArpParams = (params: {
  enabled: boolean
  pattern: 'up' | 'down' | 'updown' | 'random'
  rate: '1/4' | '1/8' | '1/16' | '1/32'
  octaves: number
  gate: number
  hold: boolean
}) => normalizeArpeggiatorParams(params)

const isAudioEffectPersistenceType = (type: SharedAudioEffectType): type is AudioEffectPersistenceType => (
  type !== 'instrument' && type !== 'synth' && type !== 'arpeggiator'
)

const normalizeEffectParamsForUpdate = (
  type: SharedAudioEffectType,
  params: any,
  existing?: any,
) => {
  if (isAudioEffectPersistenceType(type)) {
    return normalizeAudioEffectParamsForUpdate(type, params, existing)
  }
  return params
}

const stableEffectParams = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(stableEffectParams).join(',')}]`
  if (!isJsonObject(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableEffectParams(value[key])}`).join(',')}}`
}

const areEffectParamsEqual = (
  type: SharedAudioEffectType,
  current: any,
  next: any,
) => {
  if (stableEffectParams(current) === stableEffectParams(next)) return true
  if (isAudioEffectPersistenceType(type)) {
    const descriptor = audioEffectPersistenceDescriptors[type]
    return descriptor.serializeParams(normalizeEffectParamsForUpdate(type, current))
      === descriptor.serializeParams(normalizeEffectParamsForUpdate(type, next))
  }
  if (type === 'instrument') {
    return JSON.stringify(normalizeTrackInstrumentParams(current)) === JSON.stringify(normalizeTrackInstrumentParams(next))
  }
  if (type === 'synth') {
    return JSON.stringify(normalizeSynthParams(current)) === JSON.stringify(normalizeSynthParams(next))
  }
  return JSON.stringify(current) === JSON.stringify(next)
}

export const upsertTrackEffectRow = async (
  ctx: any,
  input: {
    projectId: string
    trackId: Id<'tracks'>
    type: TrackAudioEffectType
    params: any
    instanceId?: string
  },
): Promise<EffectRowWriteResult> => {
  const existing = (await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', input.trackId)).collect())
    .sort((left: EffectOrderRow, right: EffectOrderRow) => (
      (left.index ?? 0) - (right.index ?? 0)
      || (String(left._id) < String(right._id) ? -1 : 1)
    ))
  if (input.instanceId) {
    const audioRows = existing.filter((entry: EffectOrderRow) => entry.targetType === 'track' && isCanonicalAudioEffectKind(entry.type))
    validateAudioEffectInstanceId(audioRows, input.instanceId, input.type)
  }
  const row = input.type === 'instrument'
    ? existing.find((entry: EffectOrderRow) => entry.type === 'instrument' && entry.targetType === 'track')
      ?? existing.find((entry: EffectOrderRow) => entry.type === 'synth' && entry.targetType === 'track')
      ?? null
    : input.instanceId
      ? existing.find((entry: EffectOrderRow) => entry.instanceId === input.instanceId && entry.targetType === 'track') ?? null
      : existing.find((entry: EffectOrderRow) => entry.type === input.type && entry.targetType === 'track' && !entry.instanceId) ?? null
  let consolidated = false
  if (input.type === 'instrument' || input.type === 'arpeggiator') {
    await Promise.all(existing.flatMap((entry: EffectOrderRow) => (
      entry.targetType === 'track'
        && (
          input.type === 'instrument'
            ? entry.type === 'instrument' || entry.type === 'synth'
            : entry.type === 'arpeggiator'
        )
        && entry._id !== row?._id
        ? [ctx.db.delete(entry._id).then(() => { consolidated = true })]
        : []
    )))
  }
  if (consolidated) await compactTrackProcessorIndexes(ctx, input.trackId)
  if (row) {
    const params = normalizeEffectParamsForUpdate(input.type, input.params, row.params)
    if (row.type === input.type && stableEffectParams(row.params) === stableEffectParams(params)) {
      return effectRowWriteResult(consolidated ? 'updated' : 'noop', row._id)
    }
    if (row.type === 'instrument' && row.instanceId === input.instanceId && areEffectParamsEqual(input.type, row.params, params)) {
      return effectRowWriteResult(consolidated ? 'updated' : 'noop', row._id)
    }
    if (row.type === 'instrument' && areEffectParamsEqual(input.type, row.params, params)) {
      await ctx.db.patch(row._id, { instanceId: input.instanceId, targetType: 'track' })
      return effectRowWriteResult('updated', row._id)
    }
    await ctx.db.patch(row._id, { params, targetType: 'track', type: input.type, instanceId: input.instanceId })
    return effectRowWriteResult('updated', row._id)
  }
  const params = normalizeEffectParamsForUpdate(input.type, input.params)
  const effectId = await ctx.db.insert('effects', {
    projectId: input.projectId,
    targetType: 'track',
    trackId: input.trackId,
    index: existing.filter((entry: any) => entry.targetType === 'track').length,
    type: input.type,
    instanceId: input.instanceId,
    params,
    createdAt: Date.now(),
  })
  return effectRowWriteResult('created', effectId)
}

export const setTrackInstrumentRow = async (
  ctx: any,
  input: {
    projectId: string
    trackId: Id<'tracks'>
    instrument: { kind: 'synth' | 'drum-rack' | 'sampler' | 'granular'; instanceId?: string; params: any }
  },
): Promise<EffectRowWriteResult> => {
  const params = normalizeTrackInstrumentParams(input.instrument)
  if (!params) return { changed: false, status: 'invalid' }
  return await upsertTrackEffectRow(ctx, { ...input, type: 'instrument', params })
}

export const setArpeggiatorRow = async (
  ctx: any,
  input: {
    projectId: string
    trackId: Id<'tracks'>
    params: Parameters<typeof sanitizeArpParams>[0]
  },
) => await upsertTrackEffectRow(ctx, {
  projectId: input.projectId,
  trackId: input.trackId,
  type: 'arpeggiator',
  params: sanitizeArpParams(input.params),
})

export const upsertMasterEffectRow = async (
  ctx: any,
  input: {
    projectId: string
    type: MasterAudioEffectType
    params: any
    instanceId?: string
  },
): Promise<EffectRowWriteResult> => {
  const existing = await ctx.db.query('effects').withIndex('by_room_target', (q: any) => q.eq('projectId', input.projectId).eq('targetType', 'master')).collect()
  if (input.instanceId) {
    const audioRows = existing.filter((entry: EffectOrderRow) => isCanonicalAudioEffectKind(entry.type))
    validateAudioEffectInstanceId(audioRows, input.instanceId, input.type)
  }
  const row = input.instanceId
    ? existing.find((entry: EffectOrderRow) => entry.instanceId === input.instanceId && entry.targetType === 'master') ?? null
    : existing.find((entry: EffectOrderRow) => entry.type === input.type && !entry.instanceId) ?? null
  if (row) {
    const params = normalizeEffectParamsForUpdate(input.type, input.params, row.params)
    if (areEffectParamsEqual(input.type, row.params, params)) return effectRowWriteResult('noop', row._id)
    await ctx.db.patch(row._id, { params, targetType: 'master' })
    return effectRowWriteResult('updated', row._id)
  }
  const params = normalizeEffectParamsForUpdate(input.type, input.params)
  const effectId = await ctx.db.insert('effects', {
    projectId: input.projectId,
    targetType: 'master',
    index: existing.filter((entry: any) => entry.targetType === 'master').length,
    type: input.type,
    instanceId: input.instanceId,
    params,
    createdAt: Date.now(),
  })
  return effectRowWriteResult('created', effectId)
}

const legacyEffectWriteResult = (result: EffectRowWriteResult) => ({
  changed: result.changed,
  value: result.effectId,
})

const upsertTrackEffectForUser = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    trackId: any
    type: TrackAudioEffectType
    params: any
    instanceId?: string
  },
) => {
  const access = await getTrackWriteAccess(ctx, input.trackId, input.userId)
  if (!access || access.track.projectId !== input.projectId) return { changed: false, value: undefined }
  return legacyEffectWriteResult(await upsertTrackEffectRow(ctx, input))
}

const setTrackInstrumentForUser = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    trackId: any
    instrument: { kind: 'synth' | 'drum-rack' | 'sampler' | 'granular'; instanceId?: string; params: any }
  },
) => {
  const access = await getTrackWriteAccess(ctx, input.trackId, input.userId)
  if (!access || access.track.projectId !== input.projectId) return { changed: false, value: undefined }
  return legacyEffectWriteResult(await setTrackInstrumentRow(ctx, input))
}

const setArpeggiatorForUser = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    trackId: any
    params: Parameters<typeof sanitizeArpParams>[0]
  },
) => {
  const access = await getTrackWriteAccess(ctx, input.trackId, input.userId)
  if (!access || access.track.projectId !== input.projectId) return { changed: false, value: undefined }
  return legacyEffectWriteResult(await setArpeggiatorRow(ctx, input))
}

const upsertMasterEffectForUser = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    type: MasterAudioEffectType
    params: any
    instanceId?: string
  },
) => {
  await requireMasterBusWriteAccess(ctx, input.projectId, input.userId)
  return legacyEffectWriteResult(await upsertMasterEffectRow(ctx, input))
}

const getTrackEffect = async (
  ctx: any,
  input: {
    projectId: string
    trackId: any
    userId: string
    type: TrackAudioEffectType
  },
) => {
  const access = await getTrackWriteAccess(ctx, input.trackId, input.userId)
  if (!access || access.track.projectId !== input.projectId) return null
  const rows = await ctx.db
    .query("effects")
    .withIndex("by_track", (q: any) => q.eq("trackId", input.trackId))
    .collect();
  rows.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
  return rows.find((row: any) => row.type === input.type && row.targetType === 'track') ?? null;
}

type EffectOrderRow = {
  _id: string
  type: string
  targetType?: string
  trackId?: string
  instanceId?: string
  index?: number
}

export const validateAudioEffectInstanceId = (
  rows: readonly EffectOrderRow[],
  instanceId: string,
  type: SharedAudioEffectType,
) => {
  if (!instanceId.trim()) throw new Error('Audio effect instance id must be nonempty.')
  if (rows.some((entry) => entry.instanceId === instanceId && entry.type !== type)) {
    throw new Error('Audio effect instance id must be unique per target.')
  }
}

type EffectOrderContext = {
  db: {
    patch: (id: string, value: { index: number }) => Promise<void>
  }
}

const reorderRows = async (ctx: EffectOrderContext, rows: EffectOrderRow[], order: AudioEffectOrderItem[]) => {
  const audioRows = rows
    .filter((row) => isCanonicalAudioEffectKind(row.type))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const requestedIds = new Set<string>()
  const requested = order.flatMap((item) => {
    const id = audioEffectOrderItemId(item)
    if (requestedIds.has(id)) return []
    const kind = audioEffectOrderItemKind(item)
    const row = isJsonString(item)
      ? audioRows.find((entry) => entry.type === kind && !requestedIds.has(entry.instanceId ?? entry.type))
      : audioRows.find((entry) => entry.instanceId === item.id && entry.type === item.kind)
    if (!row) return []
    requestedIds.add(row.instanceId ?? row.type)
    return [row]
  })
  const requestedRowIds = new Set(requested.map((row) => row._id))
  const omitted = audioRows.filter((row) => !requestedRowIds.has(row._id))
  const nextRows = [...requested, ...omitted]
  const nextIndex = (index: number) => index
  const changed = nextRows.some((row, index) => row.index !== index)
  if (!changed) return { changed: false }
  await Promise.all(nextRows.map((row, index) => row.index === nextIndex(index) ? undefined : ctx.db.patch(row._id, { index: nextIndex(index) })))
  return { changed: true }
}

export const reorderAudioEffectRows = async (
  ctx: any,
  input: {
    projectId: string
    targetType: 'track' | 'master'
    trackId?: Id<'tracks'>
    order: AudioEffectOrderItem[]
  },
): Promise<EffectRowReorderResult> => {
  if (input.targetType === 'track') {
    const rows = await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', input.trackId)).collect()
    const result = await reorderRows(ctx, rows.filter((row: EffectOrderRow) => row.targetType === 'track'), input.order)
    const status: 'applied' | 'noop' = result.changed ? 'applied' : 'noop'
    return { ...result, status }
  }
  const rows = await ctx.db.query('effects').withIndex('by_room_target', (q: any) => q.eq('projectId', input.projectId).eq('targetType', 'master')).collect()
  const result = await reorderRows(ctx, rows, input.order)
  const status: 'applied' | 'noop' = result.changed ? 'applied' : 'noop'
  return { ...result, status }
}

const reorderAudioEffectsForUser = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    targetType: 'track' | 'master'
    trackId?: any
    order: AudioEffectOrderItem[]
  },
): Promise<EffectRowReorderResult> => {
  if (input.targetType === 'track') {
    const access = await getTrackWriteAccess(ctx, input.trackId, input.userId)
    if (!access || access.track.projectId !== input.projectId) return { changed: false, status: 'noop' }
  } else {
    await requireMasterBusWriteAccess(ctx, input.projectId, input.userId)
  }
  return await reorderAudioEffectRows(ctx, input)
}

export const removeAudioEffectRow = async (
  ctx: any,
  input: {
    projectId: string
    targetType: 'track' | 'master'
    trackId?: Id<'tracks'>
    effect: AudioEffectKind
    instanceId?: string
  },
): Promise<EffectRowRemoveResult> => {
  const deleteEffectAutomation = async (instanceId: string, targetType: 'track' | 'master', trackId?: Id<'tracks'>) => {
    const automationRows = await ctx.db.query('automationEnvelopes').withIndex('by_project', (q: any) => q.eq('projectId', input.projectId)).collect()
    for (const envelope of automationRows) {
      if (
        envelope.effectInstanceId === instanceId
        && envelope.targetKind === targetType
        && (targetType === 'master' || envelope.trackId === trackId)
      ) await ctx.db.delete(envelope._id)
    }
    if (targetType === 'track' && trackId) {
      const sidechainRows = await ctx.db.query('sidechainRoutes')
        .withIndex('by_room_target_effect', (q: any) => (
          q.eq('projectId', input.projectId).eq('targetTrackId', trackId).eq('effectInstanceId', instanceId)
        ))
        .collect()
      for (const route of sidechainRows) await ctx.db.delete(route._id)
    }
  }
  if (input.targetType === 'track') {
    const rows = await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', input.trackId)).collect()
    const row = input.instanceId
      ? rows.find((entry: EffectOrderRow) => entry.instanceId === input.instanceId && entry.type === input.effect && entry.targetType === 'track') ?? null
      : rows.find((entry: EffectOrderRow) => entry.type === input.effect && entry.targetType === 'track' && !entry.instanceId) ?? null
    if (!row) return { changed: false, status: 'not-found' }
    await ctx.db.delete(row._id)
    if (row.instanceId) await deleteEffectAutomation(row.instanceId, 'track', input.trackId)
    await reorderRows(ctx, rows.filter((entry: EffectOrderRow) => entry._id !== row._id && entry.targetType === 'track'), [])
    return { changed: true, status: 'deleted', effectId: row._id }
  }
  const rows = await ctx.db.query('effects').withIndex('by_room_target', (q: any) => q.eq('projectId', input.projectId).eq('targetType', 'master')).collect()
  const row = input.instanceId
    ? rows.find((entry: EffectOrderRow) => entry.instanceId === input.instanceId && entry.type === input.effect) ?? null
    : rows.find((entry: EffectOrderRow) => entry.type === input.effect && !entry.instanceId) ?? null
  if (!row) return { changed: false, status: 'not-found' }
  await ctx.db.delete(row._id)
  if (row.instanceId) await deleteEffectAutomation(row.instanceId, 'master')
  await reorderRows(ctx, rows.filter((entry: EffectOrderRow) => entry._id !== row._id), [])
  return { changed: true, status: 'deleted', effectId: row._id }
}

async function compactTrackProcessorIndexes(ctx: any, trackId: Id<'tracks'>) {
  const rows = (await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', trackId)).collect())
    .filter((row: EffectOrderRow) => row.targetType === 'track')
    .sort((left: EffectOrderRow, right: EffectOrderRow) => (left.index ?? 0) - (right.index ?? 0))
  for (const [index, row] of rows.entries()) {
    if (row.index !== index) await ctx.db.patch(row._id, { index })
  }
}

export const removeTrackInstrumentRow = async (
  ctx: any,
  input: { projectId: string; trackId: Id<'tracks'> },
) => {
  const rows = await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', input.trackId)).collect()
  const instruments = rows.filter((entry: any) => (
    entry.targetType === 'track' && (entry.type === 'instrument' || entry.type === 'synth')
  ))
  if (instruments.length === 0) return { changed: false }
  const instanceIds = new Set(instruments.flatMap((row: any) => {
    const instrument = row.type === 'instrument'
      ? normalizeTrackInstrumentParams(row.params)
      : normalizeTrackInstrumentParams({ kind: 'synth', instanceId: row.instanceId, params: row.params })
    return instrument?.instanceId ? [instrument.instanceId] : []
  }))
  const automation = await ctx.db.query('automationEnvelopes').withIndex('by_project_track', (q: any) => (
    q.eq('projectId', input.projectId).eq('trackId', input.trackId)
  )).collect()
  for (const envelope of automation) {
    const key = parseInstrumentAutomationKey(envelope.parameterId)
      ?? parseGranularAutomationKey(envelope.parameterId)
      ?? parseSynthAutomationKey(envelope.parameterId)
    if (key && instanceIds.has(key.instanceId)) await ctx.db.delete(envelope._id)
  }
  for (const row of instruments) await ctx.db.delete(row._id)
  await compactTrackProcessorIndexes(ctx, input.trackId)
  return { changed: true }
}

export const removeArpeggiatorRow = async (
  ctx: any,
  input: { projectId: string; trackId: Id<'tracks'> },
) => {
  const rows = await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', input.trackId)).collect()
  const arpeggiators = rows.filter((entry: any) => entry.targetType === 'track' && entry.type === 'arpeggiator')
  if (arpeggiators.length === 0) return { changed: false }
  for (const row of arpeggiators) await ctx.db.delete(row._id)
  await compactTrackProcessorIndexes(ctx, input.trackId)
  return { changed: true }
}

const removeTrackDeviceForUser = async (
  ctx: any,
  input: { projectId: string; trackId: string; operationId?: string; device: 'instrument' | 'arpeggiator' },
) => {
  const userId = await requireAuthenticatedUserId(ctx)
  const trackId = ctx.db.normalizeId('tracks', input.trackId)
  if (!trackId) return { status: 'rejected' as const }
  return await runSharedOperationOnce(ctx, {
    projectId: input.projectId,
    userId,
    operationId: input.operationId,
    isResult: (value): value is { status: 'applied' | 'noop' | 'rejected' } => (
      typeof value === 'object' && value !== null && 'status' in value
      && (value.status === 'applied' || value.status === 'noop' || value.status === 'rejected')
    ),
    run: async () => {
      const access = await getTrackWriteAccess(ctx, trackId, userId)
      if (!access || access.track.projectId !== input.projectId) return { status: 'rejected' as const }
      const result = input.device === 'instrument'
        ? await removeTrackInstrumentRow(ctx, { projectId: input.projectId, trackId })
        : await removeArpeggiatorRow(ctx, { projectId: input.projectId, trackId })
      if (!result.changed) return { status: 'noop' as const }
      await advanceProjectRevision(ctx, input.projectId)
      return { status: 'applied' as const }
    },
  })
}

export const serverRemoveTrackInstrument = mutation({
  args: { projectId: v.string(), trackId: v.string(), operationId: v.optional(v.string()) },
  handler: async (ctx, input) => await removeTrackDeviceForUser(ctx, { ...input, device: 'instrument' }),
})

export const serverRemoveArpeggiator = mutation({
  args: { projectId: v.string(), trackId: v.string(), operationId: v.optional(v.string()) },
  handler: async (ctx, input) => await removeTrackDeviceForUser(ctx, { ...input, device: 'arpeggiator' }),
})

const removeAudioEffectForUser = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    targetType: 'track' | 'master'
    trackId?: any
    effect: AudioEffectKind
    instanceId?: string
  },
) => {
  if (input.targetType === 'track') {
    const access = await getTrackWriteAccess(ctx, input.trackId, input.userId)
    if (!access || access.track.projectId !== input.projectId) return { changed: false, value: notFoundStatus() }
  } else {
    await requireMasterBusWriteAccess(ctx, input.projectId, input.userId)
  }
  const result: EffectRowRemoveResult = await removeAudioEffectRow(ctx, input)
  return {
    changed: result.changed,
    value: result.status === 'deleted' ? deletedStatus() : notFoundStatus(),
  }
}

// Return the EQ effect row for a track if it exists (we use a single EQ per track for now)
export const listByRoom = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect();
    rows.sort((a, b) => {
      if ((a.targetType ?? '') !== (b.targetType ?? '')) return (a.targetType ?? '').localeCompare(b.targetType ?? '');
      if (String(a.trackId ?? '') !== String(b.trackId ?? '')) return String(a.trackId ?? '').localeCompare(String(b.trackId ?? ''));
      return (a.index ?? 0) - (b.index ?? 0);
    });
    return rows;
  },
});

export const listByTrack = query({
  args: { projectId: v.string(), trackId: v.id("tracks") },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_track", (q) => q.eq("trackId", trackId))
      .collect();
    return rows
      .filter((row) => row.projectId === projectId && row.targetType === 'track')
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  },
});

export const getEqForTrack = query({
  args: { projectId: v.string(), trackId: v.id("tracks") },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: "eq" });
  },
});

export const getCompressorForTrack = query({
  args: { projectId: v.string(), trackId: v.id("tracks") },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: "compressor" });
  },
});

// Synth: get synth row for a track
export const getSynthForTrack = query({
  args: { projectId: v.string(), trackId: v.id('tracks') },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const access = await getTrackWriteAccess(ctx, trackId, userId)
    if (!access || access.track.projectId !== projectId) return null
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_track", (q: any) => q.eq("trackId", trackId))
      .collect()
    const instrument = rows.find((row: any) => row.type === 'instrument' && row.targetType === 'track') ?? null
    const instrumentParams = normalizeTrackInstrumentParams(instrument?.params)
    if (instrument && instrumentParams?.kind === 'synth') return { ...instrument, type: 'synth', params: instrumentParams.params }
    return rows.find((row: any) => row.type === 'synth' && row.targetType === 'track') ?? null
  },
})

export const getInstrumentForTrack = query({
  args: { projectId: v.string(), trackId: v.id('tracks') },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const access = await getTrackWriteAccess(ctx, trackId, userId)
    if (!access || access.track.projectId !== projectId) return null
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_track", (q: any) => q.eq("trackId", trackId))
      .collect()
    const instrument = rows.find((row: any) => row.type === 'instrument' && row.targetType === 'track') ?? null
    if (instrument) return instrument
    const synth = rows.find((row: any) => row.type === 'synth' && row.targetType === 'track') ?? null
    return synth ? { ...synth, type: 'instrument', params: { kind: 'synth', params: normalizeSynthParams(synth.params ?? {}) } } : null
  },
})

// Arpeggiator: get arpeggiator row for a track
export const getArpeggiatorForTrack = query({
  args: { projectId: v.string(), trackId: v.id('tracks') },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: 'arpeggiator' });
  },
})

// Synth: set or create synth params for a track
export const setSynthParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id('tracks'),
    instanceId: v.string(),
    params: v.union(synthParamsValidator, legacySynthParamsValidator),
  },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const sanitized = normalizeSynthParams(params)
    const existing = await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', trackId)).collect()
    const existingInstrument = existing.find((row: any) => row.type === 'instrument' && row.targetType === 'track')
      ?? existing.find((row: any) => row.type === 'synth' && row.targetType === 'track')
    return await finishEffectMutation(ctx, projectId, await setTrackInstrumentForUser(ctx, {
      projectId,
      userId,
      trackId,
      instrument: {
        kind: 'synth',
        instanceId: existingInstrument?.instanceId ?? instanceId,
        params: sanitized,
      },
    }))
  },
})

export const setTrackInstrument = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id('tracks'),
    instrument: trackInstrumentValidator,
  },
  handler: async (ctx, { projectId, trackId, instrument }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await setTrackInstrumentForUser(ctx, { projectId, userId, trackId, instrument }))
  },
})

// Arpeggiator: set or create arpeggiator params for a track
export const setArpeggiatorParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id('tracks'),
    params: v.object({
      enabled: v.boolean(),
      pattern: v.union(
        v.literal('up'),
        v.literal('down'),
        v.literal('updown'),
        v.literal('random'),
      ),
      rate: v.union(
        v.literal('1/4'),
        v.literal('1/8'),
        v.literal('1/16'),
        v.literal('1/32'),
      ),
      octaves: v.number(), // 1-4
      gate: v.number(), // 0.1-1.0
      hold: v.boolean(), // Keep arpeggiation looping until clip ends
    }),
  },
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await setArpeggiatorForUser(ctx, { projectId, userId, trackId, params }))
  },
})

// Set or create the Reverb params for a given track
export const setReverbParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id("tracks"),
    instanceId: v.optional(v.string()),
    params: reverbParamsValidator,
  },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId, type: 'reverb', instanceId, params }));
  },
});

export const setMasterReverbParams = mutation({
  args: {
    projectId: v.string(),
    instanceId: v.optional(v.string()),
    params: reverbParamsValidator,
  },
  handler: async (ctx, { projectId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: 'reverb', instanceId, params }))
  },
});

// Master-level EQ (per room)
export const getEqForMaster = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === 'eq' && r.targetType === 'master') ?? null;
  },
});

// Reverb: get first reverb row for a track
export const getReverbForTrack = query({
  args: { projectId: v.string(), trackId: v.id("tracks") },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: "reverb" });
  },
});

export const getSaturatorForTrack = query({
  args: { projectId: v.string(), trackId: v.id("tracks") },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: "saturator" });
  },
});

export const getDelayForTrack = query({
  args: { projectId: v.string(), trackId: v.id("tracks") },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: "delay" });
  },
});

// Reverb: get first master reverb row for room
export const getReverbForMaster = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === 'reverb' && r.targetType === 'master') ?? null;
  },
});

// Set or create the EQ params for a given track. We enforce ownership based on the track owner.
export const setEqParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id("tracks"),
    instanceId: v.optional(v.string()),
    params: eqParamsValidator,
  },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId, type: 'eq', instanceId, params }));
  },
});

// Set or create the EQ params for the room master bus. We enforce that the user owns the project for this room.
export const setMasterEqParams = mutation({
  args: {
    projectId: v.string(),
    instanceId: v.optional(v.string()),
    params: eqParamsValidator,
  },
  handler: async (ctx, { projectId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: 'eq', instanceId, params }))
  }
})

export const reorderAudioEffects = mutation({
  args: {
    projectId: v.string(),
    targetType: v.union(v.literal('track'), v.literal('master')),
    trackId: v.optional(v.id('tracks')),
    order: v.array(audioEffectOrderItemValidator),
  },
  handler: async (ctx, { projectId, targetType, trackId, order }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    if (targetType === 'track' && !trackId) return
    const result = await reorderAudioEffectsForUser(ctx, { projectId, userId, targetType, trackId, order })
    if (result.changed) await advanceProjectRevision(ctx, projectId)
    return { status: 'applied' }
  },
})

export const removeAudioEffect = mutation({
  args: {
    projectId: v.string(),
    targetType: v.union(v.literal('track'), v.literal('master')),
    trackId: v.optional(v.id('tracks')),
    effect: canonicalAudioEffectKindValidator,
    instanceId: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, targetType, trackId, effect, instanceId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    if (targetType === 'track' && !trackId) return notFoundStatus()
    return await finishEffectMutation(ctx, projectId, await removeAudioEffectForUser(ctx, { projectId, userId, targetType, trackId, effect, instanceId }))
  },
})

export const serverSetSynthParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    instanceId: v.string(),
    params: v.union(synthParamsValidator, legacySynthParamsValidator),
  },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    const sanitized = normalizeSynthParams(params)
    const existing = await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', normalizedTrackId)).collect()
    const existingInstrument = existing.find((row: any) => row.type === 'instrument' && row.targetType === 'track')
      ?? existing.find((row: any) => row.type === 'synth' && row.targetType === 'track')
    return await finishEffectMutation(ctx, projectId, await setTrackInstrumentForUser(ctx, {
      projectId,
      userId,
      trackId: normalizedTrackId,
      instrument: {
        kind: 'synth',
        instanceId: existingInstrument?.instanceId ?? instanceId,
        params: sanitized,
      },
    }))
  },
})

export const serverSetTrackInstrument = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    instrument: trackInstrumentValidator,
  },
  handler: async (ctx, { projectId, trackId, instrument }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await setTrackInstrumentForUser(ctx, { projectId, userId, trackId: normalizedTrackId, instrument }))
  },
})

export const serverSetArpeggiatorParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    params: v.object({
      enabled: v.boolean(),
      pattern: v.union(v.literal('up'), v.literal('down'), v.literal('updown'), v.literal('random')),
      rate: v.union(v.literal('1/4'), v.literal('1/8'), v.literal('1/16'), v.literal('1/32')),
      octaves: v.number(),
      gate: v.number(),
      hold: v.boolean(),
    }),
  },
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await setArpeggiatorForUser(ctx, { projectId, userId, trackId: normalizedTrackId, params }))
  },
})

export const serverSetReverbParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    instanceId: v.optional(v.string()),
    params: reverbParamsValidator,
  },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'reverb', instanceId, params }))
  },
})

export const serverSetEqParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    instanceId: v.optional(v.string()),
    params: eqParamsValidator,
  },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'eq', instanceId, params }))
  },
})

export const serverSetUtilityParams = mutation({
  args: { projectId: v.string(), trackId: v.string(), instanceId: v.string(), params: processorEnvelopeValidator },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'utility', instanceId, params }))
  },
})

export const serverSetProcessorParams = mutation({
  args: { projectId: v.string(), trackId: v.string(), effect: processorEffectValidator, instanceId: v.string(), params: processorEnvelopeValidator },
  handler: async (ctx, { projectId, trackId, effect, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId: normalizedTrackId, type: effect, instanceId, params }))
  },
})

export const serverSetModulationParams = mutation({
  args: { projectId: v.string(), trackId: v.string(), effect: modulationEffectValidator, instanceId: v.string(), params: processorEnvelopeValidator },
  handler: async (ctx, { projectId, trackId, effect, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId: normalizedTrackId, type: effect, instanceId, params }))
  },
})

export const serverSetGateParams = mutation({
  args: { projectId: v.string(), trackId: v.string(), instanceId: v.string(), params: processorEnvelopeValidator },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'gate', instanceId, params }))
  },
})

export const serverSetMasterReverbParams = mutation({
  args: {
    projectId: v.string(),
    instanceId: v.optional(v.string()),
    params: reverbParamsValidator,
  },
  handler: async (ctx, { projectId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: 'reverb', instanceId, params }))
  },
})

export const serverSetMasterEqParams = mutation({
  args: {
    projectId: v.string(),
    instanceId: v.optional(v.string()),
    params: eqParamsValidator,
  },
  handler: async (ctx, { projectId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: 'eq', instanceId, params }))
  },
})

export const serverSetMasterUtilityParams = mutation({
  args: { projectId: v.string(), instanceId: v.string(), params: processorEnvelopeValidator },
  handler: async (ctx, { projectId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: 'utility', instanceId, params }))
  },
})

export const serverSetMasterProcessorParams = mutation({
  args: { projectId: v.string(), effect: processorEffectValidator, instanceId: v.string(), params: processorEnvelopeValidator },
  handler: async (ctx, { projectId, effect, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: effect, instanceId, params }))
  },
})

export const serverSetMasterModulationParams = mutation({
  args: { projectId: v.string(), effect: modulationEffectValidator, instanceId: v.string(), params: processorEnvelopeValidator },
  handler: async (ctx, { projectId, effect, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: effect, instanceId, params }))
  },
})

export const serverSetMasterGateParams = mutation({
  args: { projectId: v.string(), instanceId: v.string(), params: processorEnvelopeValidator },
  handler: async (ctx, { projectId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: 'gate', instanceId, params }))
  },
})

export const serverSetCompressorParams = mutation({
  args: { projectId: v.string(), trackId: v.string(), instanceId: v.optional(v.string()), params: compressorParamsValidator },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'compressor', instanceId, params }))
  },
})

export const serverSetSaturatorParams = mutation({
  args: { projectId: v.string(), trackId: v.string(), instanceId: v.optional(v.string()), params: saturatorParamsValidator },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'saturator', instanceId, params }))
  },
})

export const serverSetDelayParams = mutation({
  args: { projectId: v.string(), trackId: v.string(), instanceId: v.optional(v.string()), params: delayParamsValidator },
  handler: async (ctx, { projectId, trackId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await finishEffectMutation(ctx, projectId, await upsertTrackEffectForUser(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'delay', instanceId, params }))
  },
})

export const serverSetMasterCompressorParams = mutation({
  args: { projectId: v.string(), instanceId: v.optional(v.string()), params: compressorParamsValidator },
  handler: async (ctx, { projectId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: 'compressor', instanceId, params }))
  },
})

export const serverSetMasterSaturatorParams = mutation({
  args: { projectId: v.string(), instanceId: v.optional(v.string()), params: saturatorParamsValidator },
  handler: async (ctx, { projectId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: 'saturator', instanceId, params }))
  },
})

export const serverSetMasterDelayParams = mutation({
  args: { projectId: v.string(), instanceId: v.optional(v.string()), params: delayParamsValidator },
  handler: async (ctx, { projectId, instanceId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await finishEffectMutation(ctx, projectId, await upsertMasterEffectForUser(ctx, { projectId, userId, type: 'delay', instanceId, params }))
  },
})

export const serverReorderAudioEffects = mutation({
  args: {
    projectId: v.string(),
    targetType: v.union(v.literal('track'), v.literal('master')),
    trackId: v.optional(v.string()),
    order: v.array(audioEffectOrderItemValidator),
  },
  handler: async (ctx, { projectId, targetType, trackId, order }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    if (targetType === 'track') {
      if (!trackId) return
      const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
      if (!normalizedTrackId) return
      const result = await reorderAudioEffectsForUser(ctx, { projectId, userId, targetType, trackId: normalizedTrackId, order })
      if (result.changed) await advanceProjectRevision(ctx, projectId)
      return { status: 'applied' }
    }
    const result = await reorderAudioEffectsForUser(ctx, { projectId, userId, targetType, order })
    if (result.changed) await advanceProjectRevision(ctx, projectId)
    return { status: 'applied' }
  },
})

export const restoreChainArgsValidator = {
  projectId: v.string(),
  trackId: v.string(),
  audioEffects: v.array(v.object({
    id: v.string(),
    kind: canonicalAudioEffectKindValidator,
    params: v.any(),
  })),
  instrument: v.optional(trackInstrumentValidator),
  arpeggiator: v.optional(v.object({
    enabled: v.boolean(),
    pattern: v.union(v.literal('up'), v.literal('down'), v.literal('updown'), v.literal('random')),
    rate: v.union(v.literal('1/4'), v.literal('1/8'), v.literal('1/16'), v.literal('1/32')),
    octaves: v.number(),
    gate: v.number(),
    hold: v.boolean(),
  })),
  operationId: v.string(),
}

const sameRestoreChainState = async (
  ctx: any,
  input: {
    projectId: string
    trackId: any
    audioEffects: Array<{ id: string; kind: AudioEffectKind; params: any }>
    instrument?: { kind: 'synth' | 'drum-rack' | 'sampler' | 'granular'; instanceId?: string; params: any }
    arpeggiator?: ReturnType<typeof sanitizeArpParams>
  },
) => {
  const existing = await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', input.trackId)).collect()
  const existingAudio = existing
    .filter((effect: any) => effect.targetType === 'track' && isCanonicalAudioEffectKind(effect.type))
    .sort((left: any, right: any) => left.index - right.index)
  const expectedAudio = input.audioEffects.map((effect, index) => ({
    ...effect,
    index,
    params: normalizeEffectParamsForUpdate(effect.kind, effect.params),
  }))
  if (
    existingAudio.length !== expectedAudio.length
    || existingAudio.some((effect: any, index: number) => {
      const expected = expectedAudio[index]
      return !expected
        || effect.index !== expected.index
        || effect.type !== expected.kind
        || effect.instanceId !== expected.id
        || !areEffectParamsEqual(expected.kind, effect.params, expected.params)
    })
  ) return false
  const existingInstruments = existing.filter((effect: any) => (
    effect.targetType === 'track' && (effect.type === 'instrument' || effect.type === 'synth')
  ))
  const nextInstrument = input.instrument && normalizeTrackInstrumentParams(input.instrument)
  if (
    (nextInstrument === undefined && existingInstruments.length !== 0)
    || (nextInstrument !== undefined && (
      existingInstruments.length !== 1
      || !areEffectParamsEqual('instrument', existingInstruments[0]?.params, nextInstrument)
    ))
  ) return false
  const existingArpeggiators = existing.filter((effect: any) => effect.targetType === 'track' && effect.type === 'arpeggiator')
  if (
    (input.arpeggiator === undefined && existingArpeggiators.length !== 0)
    || (input.arpeggiator !== undefined && (
      existingArpeggiators.length !== 1
      || !areEffectParamsEqual('arpeggiator', existingArpeggiators[0]?.params, input.arpeggiator)
    ))
  ) return false
  const audioInstanceIds = new Set(existingAudio.flatMap((effect: any) => effect.instanceId ? [effect.instanceId] : []))
  const [automation, sidechains] = await Promise.all([
    ctx.db.query('automationEnvelopes').withIndex('by_project_track', (q: any) => (
      q.eq('projectId', input.projectId).eq('trackId', input.trackId)
    )).collect(),
    ctx.db.query('sidechainRoutes').withIndex('by_target', (q: any) => q.eq('targetTrackId', input.trackId)).collect(),
  ])
  return !automation.some((envelope: any) => audioInstanceIds.has(envelope.effectInstanceId))
    && !sidechains.some((route: any) => route.projectId === input.projectId && audioInstanceIds.has(route.effectInstanceId))
}

export const serverRestoreChain = mutation({
  args: restoreChainArgsValidator,
  handler: async (ctx, { projectId, trackId, audioEffects, instrument, arpeggiator, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return notFoundStatus()
    const instanceIds = new Set<string>()
    for (const effect of audioEffects) {
      if (!effect.id || instanceIds.has(effect.id)) throw new Error('Audio effect instance IDs must be unique.')
      instanceIds.add(effect.id)
    }
    return await runSharedOperationOnce(ctx, {
      projectId,
      userId,
      operationId,
      isResult: (value): value is { status: 'applied' } | { status: 'noop' } => (
        z.object({ status: z.enum(['applied', 'noop']) }).safeParse(value).success
      ),
      run: async () => {
        const access = await getTrackWriteAccess(ctx, normalizedTrackId, userId)
        if (!access || access.track.projectId !== projectId) return notFoundStatus()
        const existing = await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', normalizedTrackId)).collect()
        const sanitizedArpeggiator = arpeggiator ? sanitizeArpParams(arpeggiator) : undefined
        if (await sameRestoreChainState(ctx, {
          projectId,
          trackId: normalizedTrackId,
          audioEffects,
          instrument,
          arpeggiator: sanitizedArpeggiator,
        })) return { status: 'noop' as const }
        const removedAudioInstanceIds = new Set(existing.flatMap((effect: any) => (
          effect.targetType === 'track' && isCanonicalAudioEffectKind(effect.type) && effect.instanceId
            ? [effect.instanceId]
            : []
        )))
        const [automation, sidechains] = await Promise.all([
          ctx.db.query('automationEnvelopes').withIndex('by_project_track', (q: any) => (
            q.eq('projectId', projectId).eq('trackId', normalizedTrackId)
          )).collect(),
          ctx.db.query('sidechainRoutes').withIndex('by_target', (q: any) => q.eq('targetTrackId', normalizedTrackId)).collect(),
        ])
        for (const envelope of automation) {
          if (removedAudioInstanceIds.has(envelope.effectInstanceId)) await ctx.db.delete(envelope._id)
        }
        for (const route of sidechains) {
          if (route.projectId === projectId && removedAudioInstanceIds.has(route.effectInstanceId)) await ctx.db.delete(route._id)
        }
        for (const effect of existing) {
          if (effect.targetType === 'track' && (isCanonicalAudioEffectKind(effect.type) || effect.type === 'instrument' || effect.type === 'synth' || effect.type === 'arpeggiator')) {
            await ctx.db.delete(effect._id)
          }
        }
        for (const [index, effect] of audioEffects.entries()) {
          const params = normalizeEffectParamsForUpdate(effect.kind, effect.params)
          await ctx.db.insert('effects', {
            projectId,
            targetType: 'track',
            trackId: normalizedTrackId,
            index,
            type: effect.kind,
            instanceId: effect.id,
            params,
            createdAt: Date.now(),
          })
        }
        if (instrument) await setTrackInstrumentRow(ctx, { projectId, trackId: normalizedTrackId, instrument })
        if (sanitizedArpeggiator) {
          await upsertTrackEffectRow(ctx, {
            projectId,
            trackId: normalizedTrackId,
            type: 'arpeggiator',
            params: sanitizedArpeggiator,
          })
        }
        await advanceProjectRevision(ctx, projectId)
        return { status: 'applied' }
      },
    })
  },
})

export const serverRemoveAudioEffect = mutation({
  args: {
    projectId: v.string(),
    targetType: v.union(v.literal('track'), v.literal('master')),
    trackId: v.optional(v.string()),
    effect: canonicalAudioEffectKindValidator,
    instanceId: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, targetType, trackId, effect, instanceId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    if (targetType === 'track') {
      if (!trackId) return notFoundStatus()
      const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
      if (!normalizedTrackId) return notFoundStatus()
      return await finishEffectMutation(ctx, projectId, await removeAudioEffectForUser(ctx, { projectId, userId, targetType, trackId: normalizedTrackId, effect, instanceId }))
    }
    return await finishEffectMutation(ctx, projectId, await removeAudioEffectForUser(ctx, { projectId, userId, targetType, effect, instanceId }))
  },
})
