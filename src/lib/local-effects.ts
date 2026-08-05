import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { INSTRUMENT_CONTRACTS, audioEffectOrderItemId, audioEffectOrderItemKind, automationTargetMatchesEffectInstance, createAudioEffectInstanceId, createInstrumentInstanceId, normalizeTrackInstrumentParams, type AudioEffectKind, type AudioEffectOrderItem, type SynthParamsInput, type TrackInstrumentParams } from '@daw-browser/shared'
import { compareAudioEffectOrderEntries } from '~/lib/audio-effect-order-rows'
import { audioEffectKindFromLocalEffect } from '~/lib/audio-effect-kind'
import { externalPluginEntityKind, parseExternalProcessorValue } from '@daw-browser/external-plugins'
import { withExternalProcessorProjectWriteLock } from '~/lib/external-plugins'
import { assertExactMixedEffectOrder, mixedOrderFromRows, type MixedEffectOrderItem, normalizeMixedEffectEntityRows } from '~/lib/mixed-effect-order'

export { audioEffectKindFromLocalEffect, createAudioEffectInstanceId }

export type LocalEffectKind = AudioEffectKind | `master-${AudioEffectKind}` | 'instrument' | 'synth' | 'arp'

export type LocalEffectRow<TParams = any> = {
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
const externalProcessorIndex = (row: { id: string; value: unknown }): number => {
  const parsed = parseExternalProcessorValue(row.value)
  if (!parsed.success) throw new Error(`External plugin row "${row.id}" is incompatible or corrupt.`)
  return parsed.data.index
}

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

export const isLocalEffectRow = <TParams = any>(value: unknown): value is LocalEffectRow<TParams> => (
  isObject(value)
  && typeof value.id === 'string'
  && typeof value.targetId === 'string'
  && typeof value.effect === 'string'
  && 'params' in value
)

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
  if (isLocalEffectRow(row?.value)) {
    if (effect !== 'instrument') return row.value
    const params = normalizeTrackInstrumentParams(row.value.params)
    return params ? { ...row.value, params } : undefined
  }
  if (effect !== 'instrument') return undefined
  const synthRow = await db.get('entities', [EFFECT_KIND, localEffectRowId(targetId, 'synth')])
  return isLocalEffectRow<SynthParamsInput>(synthRow?.value)
    ? {
      ...synthRow.value,
      effect: 'instrument',
      params: {
        kind: 'synth',
          instanceId: createInstrumentInstanceId(),
        params: INSTRUMENT_CONTRACTS.synth.normalizeParams(synthRow.value.params),
      },
    }
    : undefined
}

export const listLocalEffects = async (projectId: string): Promise<LocalEffectRow[]> => {
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
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, row, row.updatedAt))
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
      ? mixedOrderFromRows(await db.getAll('entities'), targetId).length
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
    await db.put('entities', createLocalProjectEntityRow(EFFECT_KIND, row.id, row, row.updatedAt))
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
      const value = automationRow.value
      if (
        typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && automationTargetMatchesEffectInstance(Reflect.get(value, 'target'), instanceId)
      ) {
        await tx.store.delete(['automation-envelope', automationRow.id])
      }
    }
    for (const sidechainRow of sidechainRows) {
      const value = sidechainRow.value
      if (isObject(value) && value.effectInstanceId === instanceId && value.targetTrackId === targetId) {
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
  const requireInstanceId = (row: LocalEffectRow) => {
    if (!row.instanceId) throw new Error(`Audio effect "${row.effect}" is missing an instance ID.`)
    return row.instanceId
  }
  const requested = order.flatMap((item) => {
    const id = audioEffectOrderItemId(item)
    if (requestedIds.has(id)) return []
    const kind = audioEffectOrderItemKind(item)
    const row = typeof item === 'string'
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
  const currentMixedOrder = mixedOrderFromRows(await db.getAll('entities'), targetId)
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
      const parsed = parseExternalProcessorValue(row.value)
      return parsed.success && parsed.migrated ? [row] : []
    })
    const rows = normalizeMixedEffectEntityRows(storedRows)
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
      const processor = parseExternalProcessorValue(row.value)
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
        const migrated = parseExternalProcessorValue(legacyRow.value)
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
      if (entry.kind === 'builtin' && isLocalEffectRow(row.value)) {
        await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, {
          ...row.value,
          index,
          updatedAt: timestamp,
        }, timestamp))
        continue
      }
      const parsed = parseExternalProcessorValue(row.value)
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
    const row: LocalEffectRow = {
      id: localEffectRowId(targetId, effect.kind, effect.id),
      targetId,
      effect: effect.kind,
      instanceId: effect.id,
      params: effect.params,
      index,
      updatedAt: timestamp,
    }
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, row, timestamp))
  }
  if (input.instrument) {
    const row: LocalEffectRow<TrackInstrumentParams> = {
      id: localEffectRowId(targetId, 'instrument'),
      targetId,
      effect: 'instrument',
      params: input.instrument,
      updatedAt: timestamp,
    }
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, row, timestamp))
  }
  if (!input.instrument && input.synth) {
    const row: LocalEffectRow<SynthParamsInput> = {
      id: localEffectRowId(targetId, 'synth'),
      targetId,
      effect: 'synth',
      params: input.synth,
      updatedAt: timestamp,
    }
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, row, timestamp))
  }
  if (input.arp !== undefined) {
    const row: LocalEffectRow = {
      id: localEffectRowId(targetId, 'arp'),
      targetId,
      effect: 'arp',
      params: input.arp,
      updatedAt: timestamp,
    }
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, row, timestamp))
  }
  await tx.done
  notifyLocalProjectChanged(projectId)
}
