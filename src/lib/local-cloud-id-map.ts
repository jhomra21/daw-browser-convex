import { openLocalProjectDb } from '~/lib/local-project-db'
import type { LocalProjectSyncStateRow } from '~/lib/local-project-db'

export type CloudMappedEntityKind = 'track' | 'clip' | 'asset'

export type CloudIdMapping = {
  kind: CloudMappedEntityKind
  localId: string
  cloudId: string
  historyRef: string
  updatedAt?: number
}

const keyFor = (kind: CloudMappedEntityKind, localId: string) => `cloud-id:${kind}:${localId}`
const indexKeyFor = (kind: CloudMappedEntityKind, cloudId: string) => `local-id:${kind}:${cloudId}`
const now = () => Date.now()

const isCloudMappedEntityKind = (value: unknown): value is CloudMappedEntityKind => (
  value === 'track' || value === 'clip' || value === 'asset'
)

const createCloudIdMapping = (
  kind: CloudMappedEntityKind,
  mapping: {
    localId: string
    cloudId: string
    historyRef?: string
  },
  updatedAt: number,
): CloudIdMapping => ({
  kind,
  localId: mapping.localId,
  cloudId: mapping.cloudId,
  historyRef: mapping.historyRef ?? mapping.localId,
  updatedAt,
})

export const assetCloudIdMappingKey = (assetId: string) => keyFor('asset', assetId)

export const isCloudIdMappingMetadataKey = (key: string) => (
  key.startsWith('cloud-id:') || key.startsWith('local-id:')
)

const cloudIdMappingRows = (
  kind: CloudMappedEntityKind,
  mappings: Iterable<{
    localId: string
    cloudId: string
    historyRef?: string
  }>,
  updatedAt = now(),
): LocalProjectSyncStateRow[] => {
  const rows: LocalProjectSyncStateRow[] = []
  for (const mapping of mappings) {
    rows.push({
      key: keyFor(kind, mapping.localId),
      value: createCloudIdMapping(kind, mapping, updatedAt),
      updatedAt,
    })
    rows.push({
      key: indexKeyFor(kind, mapping.cloudId),
      value: mapping.localId,
      updatedAt,
    })
  }
  return rows
}

export const assetCloudIdMappingRows = (
  mappings: Iterable<{
    localId: string
    cloudId: string
    historyRef?: string
  }>,
  updatedAt = now(),
) => cloudIdMappingRows('asset', mappings, updatedAt)

const isMapping = (value: unknown): value is CloudIdMapping => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return (
    'kind' in value
    && 'localId' in value
    && 'cloudId' in value
    && 'historyRef' in value
    && isCloudMappedEntityKind(value.kind)
    && typeof value.localId === 'string'
    && typeof value.cloudId === 'string'
    && typeof value.historyRef === 'string'
    && (!('updatedAt' in value) || typeof value.updatedAt === 'number')
  )
}

export const isCloudIdMappingValue = isMapping

export const isAssetCloudMappingRow = (
  row: LocalProjectSyncStateRow,
): row is LocalProjectSyncStateRow & { value: CloudIdMapping } => (
  isMapping(row.value)
  && row.value.kind === 'asset'
  && row.key === assetCloudIdMappingKey(row.value.localId)
)

export const saveCloudIdMapping = async (
  projectId: string,
  kind: CloudMappedEntityKind,
  localId: string,
  cloudId: string,
  historyRef = localId,
): Promise<CloudIdMapping> => {
  const db = await openLocalProjectDb(projectId)
  const [existingMappingRow, existingIndexRow] = await Promise.all([
    db.get('syncState', keyFor(kind, localId)),
    db.get('syncState', indexKeyFor(kind, cloudId)),
  ])
  if (
    isMapping(existingMappingRow?.value)
    && existingMappingRow.value.kind === kind
    && existingMappingRow.value.localId === localId
    && existingMappingRow.value.cloudId === cloudId
    && existingMappingRow.value.historyRef === historyRef
    && existingIndexRow?.value === localId
  ) {
    return existingMappingRow.value
  }
  const updatedAt = now()
  const mapping = createCloudIdMapping(kind, {
    localId,
    cloudId,
    historyRef,
  }, updatedAt)
  const tx = db.transaction('syncState', 'readwrite')
  const writes: Promise<unknown>[] = cloudIdMappingRows(
    kind,
    [{ localId, cloudId, historyRef }],
    updatedAt,
  ).map((row) => tx.store.put(row))
  if (isMapping(existingMappingRow?.value) && existingMappingRow.value.cloudId !== cloudId) {
    writes.push(tx.store.delete(indexKeyFor(kind, existingMappingRow.value.cloudId)))
  }
  await Promise.all([...writes, tx.done])
  return mapping
}

export const getCloudIdMapping = async (
  projectId: string,
  kind: CloudMappedEntityKind,
  localId: string,
): Promise<CloudIdMapping | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('syncState', keyFor(kind, localId))
  return isMapping(row?.value) ? row.value : undefined
}

export const getLocalIdForCloudId = async (
  projectId: string,
  kind: CloudMappedEntityKind,
  cloudId: string,
): Promise<string | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('syncState', indexKeyFor(kind, cloudId))
  return typeof row?.value === 'string' ? row.value : undefined
}
