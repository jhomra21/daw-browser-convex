import {
  exportLocalProjectRows,
  getLocalProject,
  LOCAL_PROJECT_SCHEMA_VERSION,
  type LocalProjectStoredValue,
} from '~/lib/local-project-db'
import {
  isAssetCloudMappingRow,
  isCloudIdMappingMetadataKey,
} from '~/lib/local-cloud-id-map'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'
import {
  normalizeProjectManifestPluginArtifact,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  isJsonObject,
  type ProjectManifest,
} from '@daw-browser/shared'
import { z } from 'zod'

export const CLOUD_BACKUP_LAST_PROJECT_UPDATED_AT_KEY = 'cloudBackup:lastProjectUpdatedAt'
export const CLOUD_BACKUP_LAST_MANIFEST_VERSION_KEY = 'cloudBackup:lastManifestVersion'

const isLocalSyncMetadataKey = (key: string) => (
  key === CLOUD_BACKUP_LAST_PROJECT_UPDATED_AT_KEY
  || key === CLOUD_BACKUP_LAST_MANIFEST_VERSION_KEY
  || isCloudIdMappingMetadataKey(key)
)

export const isProjectManifestSyncStateKey = (key: string) => (
  !key.startsWith('cloud-delete:')
  && !key.startsWith('shared-outbox:')
  && key !== 'shared-outbox-status'
)

const storedValueSchema = z.custom<LocalProjectStoredValue>()
const nonJsonStructuredValueSchema = z.union([
  z.bigint(),
  z.date(),
  z.instanceof(RegExp),
  z.instanceof(Blob),
  z.instanceof(ArrayBuffer),
  z.custom<ArrayBufferView<ArrayBufferLike>>(ArrayBuffer.isView),
  z.map(storedValueSchema, storedValueSchema),
  z.set(storedValueSchema),
])

const hasNonJsonStructuredValue = (value: LocalProjectStoredValue): boolean => {
  if (nonJsonStructuredValueSchema.safeParse(value).success) return true
  const array = z.array(storedValueSchema).safeParse(value)
  if (array.success) return array.data.some(hasNonJsonStructuredValue)
  const record = z.record(z.string(), storedValueSchema).safeParse(value)
  return record.success && Object.values(record.data).some(hasNonJsonStructuredValue)
}

const archiveJsonValue = (value: LocalProjectStoredValue) => {
  if (hasNonJsonStructuredValue(value)) return undefined
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return undefined
    const parsed = z.json().safeParse(JSON.parse(serialized))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

const archiveSafeEntity = (entity: Awaited<ReturnType<typeof exportLocalProjectRows>>["entities"][number]) => {
  const value = archiveJsonValue(entity.value)
  if (value === undefined) return undefined
  if (entity.kind !== "external-plugin" || !isJsonObject(value)
    || !isJsonObject(value.manifest)
    || !isJsonObject(value.manifest.identity)
    || !("discoveredPath" in value.manifest.identity)) return { ...entity, value }
  const { discoveredPath: _discoveredPath, ...identity } = value.manifest.identity
  return { ...entity, value: { ...value, manifest: { ...value.manifest, identity } } }
}

const archiveSafeStateRows = (
  rows: Awaited<ReturnType<typeof exportLocalProjectRows>>["projectState"],
) => rows.flatMap((row) => {
  const value = archiveJsonValue(row.value)
  return value === undefined ? [] : [{ ...row, value }]
})

const latestLocalProjectUpdate = (
  projectUpdatedAt: number,
  rows: Awaited<ReturnType<typeof exportLocalProjectRows>>,
) => {
  let latest = projectUpdatedAt
  for (const row of rows.entities) latest = Math.max(latest, row.updatedAt)
  for (const row of rows.assets) latest = Math.max(latest, row.updatedAt)
  for (const row of rows.projectState) latest = Math.max(latest, row.updatedAt)
  for (const row of rows.syncState) {
    if (!isLocalSyncMetadataKey(row.key)) latest = Math.max(latest, row.updatedAt)
  }
  for (const row of rows.externalPluginArtifacts) latest = Math.max(latest, row.updatedAt)
  return latest
}

const buildAssetCloudKeys = (
  rows: Awaited<ReturnType<typeof exportLocalProjectRows>>,
) => {
  const cloudKeys = new Map<string, string>()
  for (const row of rows.syncState) {
    if (isAssetCloudMappingRow(row)) {
      cloudKeys.set(row.value.localId, row.value.cloudId)
    }
  }
  return cloudKeys
}

export const buildProjectManifest = async (
  projectId: string,
  mode: 'backup' | 'shared' = 'backup',
): Promise<ProjectManifest> => {
  const project = await getLocalProject(projectId)
  if (!project) throw new Error('Local project not found.')
  await flushLocalProjectPendingWrites(projectId)
  const rows = await exportLocalProjectRows(projectId)
  const updatedAt = latestLocalProjectUpdate(project.updatedAt, rows)
  const assetCloudKeys = buildAssetCloudKeys(rows)
  const assets = rows.assets.map((asset) => {
    if (asset.missing) return asset
    const cloudKey = assetCloudKeys.get(asset.id)
    return cloudKey ? { ...asset, cloudKey } : asset
  })
  const syncState = rows.syncState.filter((row) => isProjectManifestSyncStateKey(row.key))
  const entities = rows.entities.flatMap((entity) => {
    const archived = archiveSafeEntity(entity)
    return archived ? [archived] : []
  })
  const projectState = archiveSafeStateRows(rows.projectState)
  const archivedSyncState = archiveSafeStateRows(syncState)
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    projectId,
    name: project.name,
    mode,
    updatedAt,
    entityCount: entities.length,
    assetCount: assets.length,
    entities,
    assets,
    projectState,
    syncState: archivedSyncState,
    externalPluginArtifacts: rows.externalPluginArtifacts.map(({ updatedAt: _updatedAt, ...artifact }) => (
      normalizeProjectManifestPluginArtifact(artifact)
    )),
  }
}

export const createRestoredProjectEntry = (manifest: ProjectManifest, name = manifest.name) => {
  const timestamp = Date.now()
  return {
    id: manifest.projectId,
    name: name.trim() || manifest.name || 'Untitled',
    schemaVersion: LOCAL_PROJECT_SCHEMA_VERSION,
    mode: 'local-only' as const,
    storageKind: 'opfs' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
  }
}
