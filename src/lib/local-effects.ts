import { openLocalProjectDb, type LocalProjectEntityRow } from '~/lib/local-project-db'

export type LocalEffectKind = 'eq' | 'reverb' | 'synth' | 'arp' | 'master-eq' | 'master-reverb'

export type LocalEffectRow<TParams = unknown> = {
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

const toEntityRow = (row: LocalEffectRow): LocalProjectEntityRow => ({
  kind: EFFECT_KIND,
  id: row.id,
  value: row,
  updatedAt: row.updatedAt,
})

export const getLocalEffect = async <TParams>(
  projectId: string,
  targetId: string,
  effect: LocalEffectKind,
): Promise<LocalEffectRow<TParams> | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('entities', [EFFECT_KIND, effectId(targetId, effect)])
  return isLocalEffectRow(row?.value) ? row.value as LocalEffectRow<TParams> : undefined
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
  await db.put('entities', toEntityRow(row))
  return row
}
