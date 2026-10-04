import {
  LOCAL_PROJECT_SCHEMA_VERSION,
  PROJECT_PERSISTENCE_VERSIONS,
  normalizeProjectManifest,
  type JsonValue,
  type ProjectManifest,
} from '@daw-browser/shared'
import { normalizeMixedEffectEntityRows } from '~/lib/mixed-effect-order'
import { z } from 'zod'

type DurableProjectEntityRow<Value = unknown> = {
  kind: string
  id: string
  value: Value
  updatedAt: number
}

export const migrateProjectManifest = (value: JsonValue): ProjectManifest => (
  normalizeProjectManifest(value)
)

export const migrateDurableProjectEntityRows = <Row extends DurableProjectEntityRow>(
  rows: readonly Row[],
): Row[] => {
  const jsonRows = rows.flatMap((row) => {
    const parsed = z.json().safeParse(row.value)
    return parsed.success ? [{ ...row, value: parsed.data }] : []
  })
  const normalizedByKey = new Map(
    normalizeMixedEffectEntityRows(jsonRows).map((row) => [`${row.kind}\u0000${row.id}`, row]),
  )
  return rows.map((row) => {
    const normalized = normalizedByKey.get(`${row.kind}\u0000${row.id}`)
    return normalized === undefined ? row : { ...row, value: normalized.value }
  })
}

export const PROJECT_PERSISTENCE_MIGRATION_AUTHORITY = {
  versions: PROJECT_PERSISTENCE_VERSIONS,
  manifest: migrateProjectManifest,
  entities: migrateDurableProjectEntityRows,
} as const

export { LOCAL_PROJECT_SCHEMA_VERSION, PROJECT_PERSISTENCE_VERSIONS }
