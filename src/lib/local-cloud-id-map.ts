import { openLocalProjectDb } from '~/lib/local-project-db'

export type CloudMappedEntityKind = 'track' | 'clip' | 'asset'

export type CloudIdMapping = {
  kind: CloudMappedEntityKind
  localId: string
  cloudId: string
  historyRef: string
  updatedAt: number
}

const keyFor = (kind: CloudMappedEntityKind, localId: string) => `cloud-id:${kind}:${localId}`
const indexKeyFor = (kind: CloudMappedEntityKind, cloudId: string) => `local-id:${kind}:${cloudId}`
const now = () => Date.now()

const isMapping = (value: unknown): value is CloudIdMapping => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return (
    'kind' in value
    && 'localId' in value
    && 'cloudId' in value
    && 'historyRef' in value
    && typeof value.kind === 'string'
    && typeof value.localId === 'string'
    && typeof value.cloudId === 'string'
    && typeof value.historyRef === 'string'
  )
}

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
  const mapping = {
    kind,
    localId,
    cloudId,
    historyRef,
    updatedAt: now(),
  }
  const tx = db.transaction('syncState', 'readwrite')
  const writes: Promise<unknown>[] = [
    tx.store.put({ key: keyFor(kind, localId), value: mapping, updatedAt: mapping.updatedAt }),
    tx.store.put({ key: indexKeyFor(kind, cloudId), value: localId, updatedAt: mapping.updatedAt }),
  ]
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
