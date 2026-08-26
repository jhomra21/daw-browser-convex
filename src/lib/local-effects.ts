import { createLocalProjectEntityRow, openLocalProjectDb, type LocalProjectEntityRow, type LocalProjectStoredValue } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { INSTRUMENT_CONTRACTS, audioEffectOrderItemId, audioEffectOrderItemKind, automationTargetMatchesEffectInstance, createAudioEffectInstanceId, createInstrumentInstanceId, isJsonObject, isJsonString, normalizeTrackInstrumentParams, type AudioEffectKind, type AudioEffectOrderItem, type JsonValue, type SynthParamsInput, type TrackInstrumentParams } from '@daw-browser/shared'
import { compareAudioEffectOrderEntries } from '~/lib/audio-effect-order-rows'
import { audioEffectKindFromLocalEffect } from '~/lib/audio-effect-kind'
import { externalPluginEntityKind, parseExternalProcessorValue } from '@daw-browser/external-plugins'
import { withExternalProcessorProjectWriteLock } from '~/lib/external-plugins'
import { assertExactMixedEffectOrder, mixedOrderFromRows, type MixedEffectOrderItem, normalizeMixedEffectEntityRows } from '~/lib/mixed-effect-order'
import { z } from 'zod'
import { parseExternalPluginJsonValue } from '~/lib/external-plugin-json'

export { audioEffectKindFromLocalEffect, createAudioEffectInstanceId }

export type LocalEffectKind = AudioEffectKind | `master-${AudioEffectKind}` | 'instrument' | 'synth' | 'arp'

export type LocalEffectRow<TParams> = {
  id: string
  targetId: string
  effect: LocalEffectKind
  instanceId?: string
  params: TParams
  index?: number
  updatedAt: number
}

const EFFECT_KIND = 'effect'
const SIDECHAIN_KIND = 'sidechain-route'
export const localSidechainRouteRowId = (targetTrackId: string, effectInstanceId: string) => `${targetTrackId}:sidechain:${effectInstanceId}`
export const localEffectRowId = (
  targetId: string,
  effect: LocalEffectKind,
  instanceId?: string,
) => instanceId ? `${targetId}:effect:${instanceId}` : `${targetId}:${effect}`
const now = () => Date.now()
const externalProcessorIndex = (row: { id: string; value: JsonValue }): number => {
  const parsed = parseExternalProcessorValue(parseExternalPluginJsonValue(row.value))
  if (!parsed.success) throw new Error(`External plugin row "${row.id}" is incompatible or corrupt.`)
  return parsed.data.index
}

const localEffectRowSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  effect: z.string(),
  params: z.unknown(),
}).passthrough()

export const isLocalEffectRow = <TParams = JsonValue>(
  value: LocalProjectStoredValue | LocalEffectRow<TParams>,
): value is LocalProjectStoredValue & LocalEffectRow<TParams> => {
  return localEffectRowSchema.safeParse(value).success
}

const jsonEntityRows = (rows: readonly LocalProjectEntityRow[]) => rows.flatMap((row) => {
  const parsed = z.json().safeParse(row.value)
  return parsed.success ? [{ ...row, value: parsed.data }] : []
})

const localEffectJsonValue = <TParams>(row: LocalEffectRow<TParams>): JsonValue => {
  const value = {
    id: row.id,
    targetId: row.targetId,
    effect: row.effect,
    params: row.params,
    updatedAt: row.updatedAt,
  }
  if (row.instanceId !== undefined) Object.assign(value, { instanceId: row.instanceId })
  if (row.index !== undefined) Object.assign(value, { index: row.index })
  return z.json().parse(value)
}

const getExactLocalEffect = async <TParams>(
  projectId: string,
  targetId: string,
  effect: LocalEffectKind,
): Promise<LocalEffectRow<TParams> | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('entities', [EFFECT_KIND, localEffectRowId(targetId, effect)])
  return isLocalEffectRow<TParams>(row?.value) ? row.value : undefined
}

export async function getLocalEffect(
  projectId: string,
  targetId: string,
  effect: 'instrument',
): Promise<LocalEffectRow<TrackInstrumentParams> | undefined>
export async function getLocalEffect<TParams>(
  projectId: string,
  targetId: string,
  effect: LocalEffectKind,
): Promise<LocalEffectRow<TParams> | undefined>
export async function getLocalEffect(
  projectId: string,
  targetId: string,
  effect: LocalEffectKind,
) {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('entities', [EFFECT_KIND, localEffectRowId(targetId, effect)])
  const storedEffect = z.json().safeParse(row?.value)
  if (storedEffect.success && isJsonObject(storedEffect.data) && localEffectRowSchema.safeParse(storedEffect.data).success) {
    if (effect !== 'instrument') return storedEffect.data
    const params = normalizeTrackInstrumentParams(storedEffect.data.params)
    return params ? { ...storedEffect.data, params } : undefined
  }
  if (effect !== 'instrument') return undefined
  const synthRow = await db.get('entities', [EFFECT_KIND, localEffectRowId(targetId, 'synth')])
  const synth = synthRow?.value
  if (!isLocalEffectRow<SynthParamsInput>(synth)) return undefined
  const instrument: LocalEffectRow<TrackInstrumentParams> = {
    id: synth.id,
    targetId: synth.targetId,
    effect: 'instrument',
    updatedAt: synth.updatedAt,
    params: {
      kind: 'synth',
      instanceId: createInstrumentInstanceId(),
      params: INSTRUMENT_CONTRACTS.synth.normalizeParams(synth.params),
    },
  }
  if (synth.instanceId !== undefined) instrument.instanceId = synth.instanceId
  if (synth.index !== undefined) instrument.index = synth.index
  return instrument
}

export const listLocalEffects = async (projectId: string): Promise<LocalEffectRow<JsonValue>[]> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAllFromIndex('entities', 'by-kind', EFFECT_KIND)
  return rows.flatMap((row) => isLocalEffectRow(row.value) ? [row.value] : [])
}

export const setLocalEffect = async <TParams>(
  projectId: string,
  targetId: string,
  effect: LocalEffectKind,
  params: TParams,
  index?: number,
): Promise<LocalEffectRow<TParams>> => {
  return withExternalProcessorProjectWriteLock(projectId, async () => {
    const existingRow = await getExactLocalEffect<TParams>(projectId, targetId, effect)
    const db = await openLocalProjectDb(projectId)
    const timestamp = now()
    const rowIndex = index ?? existingRow?.index
    const row: LocalEffectRow<TParams> = {
      id: localEffectRowId(targetId, effect),
      targetId,
      effect,
      params,
      index: rowIndex,
      updatedAt: timestamp,
    }
    const tx = db.transaction('entities', 'readwrite')
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, localEffectJsonValue(row), row.updatedAt))
    if (effect === 'instrument') {
      await tx.store.delete([EFFECT_KIND, localEffectRowId(targetId, 'synth')])
    }
    await tx.done
    notifyLocalProjectChanged(projectId)
    return row
  })
}

export const setLocalEffectInstance = async <TParams>(
  projectId: string,
  targetId: string,
  effect: LocalEffectKind,
  params: TParams,
  input: {
    instanceId: string
    index?: number
  },
): Promise<LocalEffectRow<TParams>> => {
  return withExternalProcessorProjectWriteLock(projectId, async () => {
    const instanceId = input.instanceId
    const db = await openLocalProjectDb(projectId)
    const id = localEffectRowId(targetId, effect, instanceId)
    const existing = await db.get('entities', [EFFECT_KIND, id])
    const existingRow = isLocalEffectRow<TParams>(existing?.value) ? existing.value : undefined
    const appendIndex = existingRow?.index === undefined && input.index === undefined
      ? mixedOrderFromRows(jsonEntityRows(await db.getAll('entities')), targetId).length
      : undefined
    const timestamp = now()
    const row: LocalEffectRow<TParams> = {
      id,
      targetId,
      effect,
      instanceId,
      params,
      index: input?.index ?? existingRow?.index ?? appendIndex,
      updatedAt: timestamp,
    }
    await db.put('entities', createLocalProjectEntityRow(EFFECT_KIND, row.id, localEffectJsonValue(row), row.updatedAt))
    notifyLocalProjectChanged(projectId)
    return row
  })
}

export const deleteLocalEffect = async (
  projectId: string,
  targetId: string,
  effect: LocalEffectKind,
): Promise<void> => {
  await withExternalProcessorProjectWriteLock(projectId, async () => {
    const db = await openLocalProjectDb(projectId)
    const key: [string, string] = [EFFECT_KIND, localEffectRowId(targetId, effect)]
    const row = await db.get('entities', key)
    if (!isLocalEffectRow(row?.value)) return
    await db.delete('entities', key)
    notifyLocalProjectChanged(projectId)
  })
}

export const deleteLocalEffectInstance = async (
  projectId: string,
  targetId: string,
  effect: LocalEffectKind,
  instanceId?: string,
): Promise<void> => {
  if (!instanceId) {
    await deleteLocalEffect(projectId, targetId, effect)
    return
  }
  await withExternalProcessorProjectWriteLock(projectId, async () => {
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const key: [string, string] = [EFFECT_KIND, localEffectRowId(targetId, effect, instanceId)]
    const row = await tx.store.get(key)
    if (!isLocalEffectRow(row?.value)) {
      await tx.done
      return
    }
    const automationRows = await tx.store.index('by-kind').getAll('automation-envelope')
    const sidechainRows = effect === 'compressor' || effect === 'gate' || effect === 'spectral'
      ? await tx.store.index('by-kind').getAll(SIDECHAIN_KIND)
      : []
    await tx.store.delete(key)
    for (const automationRow of automationRows) {
      const parsed = z.json().safeParse(automationRow.value)
      const value = parsed.success ? parsed.data : undefined
      if (
        isJsonObject(value)
        && automationTargetMatchesEffectInstance(value.target, instanceId)
      ) {
        await tx.store.delete(['automation-envelope', automationRow.id])
      }
    }
    for (const sidechainRow of sidechainRows) {
      const parsed = z.json().safeParse(sidechainRow.value)
      const value = parsed.success ? parsed.data : undefined
      if (isJsonObject(value) && value.effectInstanceId === instanceId && value.targetTrackId === targetId) {
        await tx.store.delete([SIDECHAIN_KIND, sidechainRow.id])
      }
    }
    await tx.done
    notifyLocalProjectChanged(projectId)
  })
}

export const reorderLocalAudioEffects = async (
  projectId: string,
  targetId: string,
  order: AudioEffectOrderItem[],
): Promise<void> => {
  const rows = (await listLocalEffects(projectId))
    .filter((row) => row.targetId === targetId)
    .flatMap((row) => {
      const kind = audioEffectKindFromLocalEffect(row.effect)
      if (!kind) return []
      if (!row.instanceId) throw new Error(`Audio effect "${kind}" is missing an instance ID.`)
      return [{ row, kind }]
    })
    .sort((a, b) => compareAudioEffectOrderEntries(
      { kind: a.kind, index: a.row.index },
      { kind: b.kind, index: b.row.index },
    ))
  const requestedIds = new Set<string>()
  const requireInstanceId = (row: LocalEffectRow<JsonValue>) => {
    if (!row.instanceId) throw new Error(`Audio effect "${row.effect}" is missing an instance ID.`)
    return row.instanceId
  }
  const requested = order.flatMap((item) => {
    const id = audioEffectOrderItemId(item)
    if (requestedIds.has(id)) return []
    const kind = audioEffectOrderItemKind(item)
    const row = isJsonString(item)
      ? rows.find((entry) => entry.kind === kind && !requestedIds.has(requireInstanceId(entry.row)))
      : rows.find((entry) => entry.row.instanceId === item.id && entry.kind === item.kind)
    if (!row) return []
    requestedIds.add(requireInstanceId(row.row))
    return [row]
  })
  const requestedRowIds = new Set(requested.map((entry) => entry.row.id))
  const omitted = rows.filter((entry) => !requestedRowIds.has(entry.row.id))
  const builtinOrder = [...requested, ...omitted].map((entry) => ({
    kind: 'builtin',
    instanceId: entry.row.instanceId ?? '',
  } satisfies MixedEffectOrderItem))
  const db = await openLocalProjectDb(projectId)
  const currentMixedOrder = mixedOrderFromRows(jsonEntityRows(await db.getAll('entities')), targetId)
  let builtinIndex = 0
  const mixedOrder = currentMixedOrder.map((entry) => (
    entry.kind === 'builtin' ? builtinOrder[builtinIndex++] : entry
  ))
  await reorderLocalMixedEffects(projectId, targetId, mixedOrder)
}

export const reorderLocalMixedEffects = async (
  projectId: string,
  targetId: string,
  order: readonly MixedEffectOrderItem[],
): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  return withExternalProcessorProjectWriteLock(projectId, async () => {
    const tx = db.transaction('entities', 'readwrite')
    const storedRows = await tx.store.getAll()
    const legacyExternalRows = storedRows.flatMap((row) => {
      if (row.kind !== externalPluginEntityKind) return []
      const json = z.json().safeParse(row.value)
      if (!json.success) return []
      const parsed = parseExternalProcessorValue(parseExternalPluginJsonValue(json.data))
      return parsed.success && parsed.migrated ? [row] : []
    })
    const rows = normalizeMixedEffectEntityRows(jsonEntityRows(storedRows))
    const current = mixedOrderFromRows(rows, targetId)
    assertExactMixedEffectOrder(current, order)
    const rowByIdentity = new Map<string, typeof rows[number]>()
    for (const row of rows) {
      if (row.kind === EFFECT_KIND && isLocalEffectRow(row.value)
        && row.value.targetId === targetId
        && row.value.instanceId
        && audioEffectKindFromLocalEffect(row.value.effect) !== undefined) {
        rowByIdentity.set(`builtin:${row.value.instanceId}`, row)
        continue
      }
      if (row.kind !== externalPluginEntityKind) continue
      const processor = parseExternalProcessorValue(parseExternalPluginJsonValue(row.value))
      if (processor.success && processor.data.targetId === targetId && processor.data.manifest.role === 'effect') {
        rowByIdentity.set(`external:${processor.data.instanceId}`, row)
      }
    }
    let didChange = false
    for (const [index, entry] of order.entries()) {
      const row = rowByIdentity.get(`${entry.kind}:${entry.instanceId}`)
      if (!row) throw new Error('Mixed effect reorder references an unknown effect.')
      const currentIndex = entry.kind === 'builtin' && isLocalEffectRow(row.value)
        ? row.value.index
        : externalProcessorIndex(row)
      if (currentIndex !== index) {
        didChange = true
        break
      }
    }
    if (!didChange) {
      for (const legacyRow of legacyExternalRows) {
        const json = z.json().safeParse(legacyRow.value)
        if (!json.success) continue
        const migrated = parseExternalProcessorValue(parseExternalPluginJsonValue(json.data))
        if (!migrated.success) continue
        await tx.store.put(createLocalProjectEntityRow(
          externalPluginEntityKind,
          legacyRow.id,
          migrated.data,
          legacyRow.updatedAt,
        ))
      }
      await tx.done
      if (legacyExternalRows.length > 0) notifyLocalProjectChanged(projectId)
      return
    }
    const timestamp = now()
    const rewrittenExternalIds = new Set<string>()
    for (const [index, entry] of order.entries()) {
      const row = rowByIdentity.get(`${entry.kind}:${entry.instanceId}`)
      if (!row) throw new Error('Mixed effect reorder references an unknown effect.')
      const currentIndex = entry.kind === 'builtin' && isLocalEffectRow(row.value)
        ? row.value.index
        : externalProcessorIndex(row)
      if (currentIndex === index) continue
      if (entry.kind === 'builtin') {
        if (!isLocalEffectRow(row.value)) throw new Error('Mixed effect row is corrupt.')
        const value = z.json().parse(row.value)
        if (!isJsonObject(value)) throw new Error('Mixed effect row is corrupt.')
        await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, {
          ...value,
          index,
          updatedAt: timestamp,
        }, timestamp))
        continue
      }
      const parsed = parseExternalProcessorValue(parseExternalPluginJsonValue(row.value))
      if (!parsed.success) throw new Error(`External plugin row "${row.id}" is incompatible or corrupt.`)
      const processor = parsed.data
      await tx.store.put(createLocalProjectEntityRow(externalPluginEntityKind, row.id, {
        ...processor,
        index,
        updatedAt: timestamp,
      }, timestamp))
      rewrittenExternalIds.add(row.id)
    }
    for (const legacyRow of legacyExternalRows) {
      if (rewrittenExternalIds.has(legacyRow.id)) continue
      const normalized = rows.find((row) => row.id === legacyRow.id)
      if (normalized) await tx.store.put(normalized)
    }
    await tx.done
    notifyLocalProjectChanged(projectId)
  })
}

export const restoreLocalTrackEffectChain = async (
  projectId: string,
  targetId: string,
  input: {
    audioEffects: Array<{ id: string; kind: AudioEffectKind; params: unknown }>
    instrument?: TrackInstrumentParams
    synth?: SynthParamsInput
    arp?: unknown
  },
): Promise<void> => {
  const audioIds = new Set<string>()
  for (const effect of input.audioEffects) {
    if (!effect.id || audioIds.has(effect.id)) throw new Error('Audio effect instance IDs must be unique.')
    audioIds.add(effect.id)
  }
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  const timestamp = now()
  const effectRows = await tx.store.index('by-kind').getAll(EFFECT_KIND)
  for (const entity of effectRows) {
    if (!isLocalEffectRow(entity.value) || entity.value.targetId !== targetId) continue
    if (audioEffectKindFromLocalEffect(entity.value.effect) || entity.value.effect === 'instrument' || entity.value.effect === 'synth' || entity.value.effect === 'arp') {
      await tx.store.delete([EFFECT_KIND, entity.id])
    }
  }
  for (const [index, effect] of input.audioEffects.entries()) {
    const params = z.json().parse(effect.params)
    const row: LocalEffectRow<typeof params> = {
      id: localEffectRowId(targetId, effect.kind, effect.id),
      targetId,
      effect: effect.kind,
      instanceId: effect.id,
      params,
      index,
      updatedAt: timestamp,
    }
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, localEffectJsonValue(row), timestamp))
  }
  if (input.instrument) {
    const row: LocalEffectRow<TrackInstrumentParams> = {
      id: localEffectRowId(targetId, 'instrument'),
      targetId,
      effect: 'instrument',
      params: input.instrument,
      updatedAt: timestamp,
    }
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, localEffectJsonValue(row), timestamp))
  }
  if (!input.instrument && input.synth) {
    const row: LocalEffectRow<SynthParamsInput> = {
      id: localEffectRowId(targetId, 'synth'),
      targetId,
      effect: 'synth',
      params: input.synth,
      updatedAt: timestamp,
    }
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, localEffectJsonValue(row), timestamp))
  }
  if (input.arp !== undefined) {
    const params = z.json().parse(input.arp)
    const row: LocalEffectRow<typeof params> = {
      id: localEffectRowId(targetId, 'arp'),
      targetId,
      effect: 'arp',
      params,
      updatedAt: timestamp,
    }
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, localEffectJsonValue(row), timestamp))
  }
  await tx.done
  notifyLocalProjectChanged(projectId)
}
