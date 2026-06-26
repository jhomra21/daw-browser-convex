import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { AUDIO_EFFECT_CONTRACTS, AUDIO_EFFECT_ORDER, type AudioEffectKind } from '@daw-browser/shared'

export type LocalEffectKind = 'eq' | 'saturator' | 'delay' | 'reverb' | 'synth' | 'arp' | 'master-eq' | 'master-saturator' | 'master-delay' | 'master-reverb'

export type LocalEffectRow<TParams = any> = {
  id: string
  targetId: string
  effect: LocalEffectKind
  params: TParams
  index?: number
  updatedAt: number
}

const EFFECT_KIND = 'effect'
const effectId = (targetId: string, effect: LocalEffectKind) => `${targetId}:${effect}`
const now = () => Date.now()

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isLocalEffectRow = (value: unknown): value is LocalEffectRow => (
  isObject(value)
  && typeof value.id === 'string'
  && typeof value.targetId === 'string'
  && typeof value.effect === 'string'
  && 'params' in value
)

export const getLocalEffect = async <TParams>(
  projectId: string,
  targetId: string,
  effect: LocalEffectKind,
): Promise<LocalEffectRow<TParams> | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('entities', [EFFECT_KIND, effectId(targetId, effect)])
  return isLocalEffectRow(row?.value) ? row.value : undefined
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
  const db = await openLocalProjectDb(projectId)
  const timestamp = now()
  const row: LocalEffectRow<TParams> = {
    id: effectId(targetId, effect),
    targetId,
    effect,
    params,
    index,
    updatedAt: timestamp,
  }
  await db.put('entities', createLocalProjectEntityRow(EFFECT_KIND, row.id, row, row.updatedAt))
  notifyLocalProjectChanged(projectId)
  return row
}

export const audioEffectKindFromLocalEffect = (effect: LocalEffectKind): AudioEffectKind | undefined => {
  for (const kind of AUDIO_EFFECT_ORDER) {
    if (effect === kind || effect === AUDIO_EFFECT_CONTRACTS[kind].masterKind) return kind
  }
  return undefined
}

export const reorderLocalAudioEffects = async (
  projectId: string,
  targetId: string,
  order: AudioEffectKind[],
): Promise<void> => {
  const rows = (await listLocalEffects(projectId))
    .filter((row) => row.targetId === targetId)
    .flatMap((row) => {
      const kind = audioEffectKindFromLocalEffect(row.effect)
      return kind ? [{ row, kind }] : []
    })
    .sort((a, b) => (a.row.index ?? 0) - (b.row.index ?? 0))
  const requestedKinds = new Set<AudioEffectKind>()
  const requested = order.flatMap((kind) => {
    if (requestedKinds.has(kind)) return []
    const row = rows.find((entry) => entry.kind === kind)
    if (!row) return []
    requestedKinds.add(kind)
    return [row]
  })
  const requestedIds = new Set(requested.map((entry) => entry.row.id))
  const omitted = rows.filter((entry) => !requestedIds.has(entry.row.id))
  const changes = [...requested, ...omitted].flatMap((entry, index) => (
    entry.row.index === index ? [] : [{ row: entry.row, index }]
  ))
  if (changes.length === 0) return
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  const timestamp = now()
  for (const change of changes) {
    const row = { ...change.row, index: change.index, updatedAt: timestamp }
    await tx.store.put(createLocalProjectEntityRow(EFFECT_KIND, row.id, row, row.updatedAt))
  }
  await tx.done
  notifyLocalProjectChanged(projectId)
}
