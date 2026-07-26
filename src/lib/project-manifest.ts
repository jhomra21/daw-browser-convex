import {
  exportLocalProjectRows,
  getLocalProject,
  LOCAL_PROJECT_SCHEMA_VERSION,
} from '~/lib/local-project-db'
import {
  isAssetCloudMappingRow,
  isCloudIdMappingMetadataKey,
} from '~/lib/local-cloud-id-map'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'
import {
  normalizeProjectManifestPluginArtifact,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  type ProjectManifest,
} from '@daw-browser/shared'

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

const archiveSafeEntity = (entity: Awaited<ReturnType<typeof exportLocalProjectRows>>["entities"][number]) => {
  if (entity.kind !== "external-plugin" || typeof entity.value !== "object" || entity.value === null
    || !("manifest" in entity.value) || typeof entity.value.manifest !== "object" || entity.value.manifest === null
    || !("identity" in entity.value.manifest) || typeof entity.value.manifest.identity !== "object"
    || entity.value.manifest.identity === null || !("discoveredPath" in entity.value.manifest.identity)) return entity
  const { discoveredPath: _discoveredPath, ...identity } = entity.value.manifest.identity
  return { ...entity, value: { ...entity.value, manifest: { ...entity.value.manifest, identity } } }
}

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
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    projectId,
    name: project.name,
    mode,
    updatedAt,
    entityCount: rows.entities.length,
    assetCount: assets.length,
    entities: rows.entities.map(archiveSafeEntity),
    assets,
    projectState: rows.projectState,
    syncState,
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
