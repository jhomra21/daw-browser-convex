import {
  exportLocalProjectRows,
  getLocalProject,
  LOCAL_PROJECT_SCHEMA_VERSION,
} from '~/lib/local-project-db'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'
import { PROJECT_MANIFEST_SCHEMA_VERSION, type ProjectManifest } from '~/lib/project-manifest-contract'

export const CLOUD_BACKUP_LAST_PROJECT_UPDATED_AT_KEY = 'cloudBackup:lastProjectUpdatedAt'
export const CLOUD_BACKUP_LAST_MANIFEST_VERSION_KEY = 'cloudBackup:lastManifestVersion'

const isLocalSyncMetadataKey = (key: string) => (
  key === CLOUD_BACKUP_LAST_PROJECT_UPDATED_AT_KEY
  || key === CLOUD_BACKUP_LAST_MANIFEST_VERSION_KEY
  || key.startsWith('cloud-id:')
  || key.startsWith('local-id:')
)

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
  return latest
}

const buildAssetCloudKeys = (
  rows: Awaited<ReturnType<typeof exportLocalProjectRows>>,
) => {
  const cloudKeys = new Map<string, string>()
  for (const row of rows.syncState) {
    if (!row.key.startsWith('cloud-id:asset:')) continue
    if (typeof row.value !== 'object' || row.value === null || Array.isArray(row.value)) continue
    if (!('localId' in row.value) || !('cloudId' in row.value)) continue
    if (typeof row.value.localId === 'string' && typeof row.value.cloudId === 'string') {
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
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    projectId,
    name: project.name,
    mode,
    updatedAt,
    entityCount: rows.entities.length,
    assetCount: assets.length,
    entities: rows.entities,
    assets,
    projectState: rows.projectState,
    syncState: rows.syncState,
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
