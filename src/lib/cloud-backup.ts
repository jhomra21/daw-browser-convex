import { readLocalAssetBytes } from '~/lib/local-assets'
import { assetCloudIdMappingRows, isCloudIdMappingValue } from '~/lib/local-cloud-id-map'
import { createProjectId, importLocalProject, openLocalProjectDb, replaceLocalProject, setLocalProjectMode, type LocalProjectSyncStateRow } from '~/lib/local-project-db'
import { buildProjectManifest, CLOUD_BACKUP_LAST_MANIFEST_VERSION_KEY, CLOUD_BACKUP_LAST_PROJECT_UPDATED_AT_KEY, createRestoredProjectEntry, isProjectManifestSyncStateKey } from '~/lib/project-manifest'
import {
  assertProjectManifestPublishIntegrity,
  normalizeProjectManifest,
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonValue,
  type ProjectManifest,
} from '@daw-browser/shared'
import { z } from 'zod'

type BackupResult = {
  ok: boolean
  manifestVersion?: string
  uploadedAssetKeys?: Record<string, string>
  deletedAssetKeys?: string[]
  conflict?: {
    localUpdatedAt: number
    cloudUpdatedAt: number
    localEntityCount: number
    cloudEntityCount: number
    localAssetCount: number
    cloudAssetCount: number
  }
  error?: string
}

type CloudBackupSnapshot = {
  manifest: ProjectManifest
  manifestVersion: string
}

const CLOUD_ASSET_DELETE_PREFIX = 'cloud-delete:asset:'
const finiteNumberSchema = z.number().finite()

const cloudAssetDeleteKeyRange = () => IDBKeyRange.bound(CLOUD_ASSET_DELETE_PREFIX, `${CLOUD_ASSET_DELETE_PREFIX}\uffff`)

const readPendingDeletedCloudAssetRows = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  return await db.getAll('syncState', cloudAssetDeleteKeyRange())
}

const readPendingDeletedCloudAssetKey = (row: LocalProjectSyncStateRow): string | null => {
  const cloudKey = z.string().safeParse(row.value)
  if (cloudKey.success) return cloudKey.data
  return isCloudIdMappingValue(row.value) ? row.value.cloudId : null
}

const readNumber = (value: JsonValue): number | undefined => (
  isJsonNumber(value) && Number.isFinite(value) ? value : undefined
)

const readStringRecord = (value: JsonValue): Record<string, string> | undefined => {
  if (!isJsonObject(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!key || !isJsonString(entry) || !entry) return undefined
    result[key] = entry
  }
  return result
}

const readStringArray = (value: JsonValue): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const result = value.filter((entry): entry is string => isJsonString(entry) && entry.length > 0)
  return result.length === value.length ? result : undefined
}

const readBackupConflict = (value: JsonValue): BackupResult['conflict'] | undefined => {
  if (!isJsonObject(value)) return undefined
  const localUpdatedAt = readNumber(value.localUpdatedAt)
  const cloudUpdatedAt = readNumber(value.cloudUpdatedAt)
  const localEntityCount = readNumber(value.localEntityCount)
  const cloudEntityCount = readNumber(value.cloudEntityCount)
  const localAssetCount = readNumber(value.localAssetCount)
  const cloudAssetCount = readNumber(value.cloudAssetCount)
  if (
    localUpdatedAt === undefined ||
    cloudUpdatedAt === undefined ||
    localEntityCount === undefined ||
    cloudEntityCount === undefined ||
    localAssetCount === undefined ||
    cloudAssetCount === undefined
  ) {
    return undefined
  }
  return {
    localUpdatedAt,
    cloudUpdatedAt,
    localEntityCount,
    cloudEntityCount,
    localAssetCount,
    cloudAssetCount,
  }
}

const readBackupResult = (value: JsonValue): BackupResult | null => {
  if (!isJsonObject(value) || !isJsonBoolean(value.ok)) return null
  const result: BackupResult = { ok: value.ok }
  if (isJsonString(value.manifestVersion)) result.manifestVersion = value.manifestVersion
  const uploadedAssetKeys = readStringRecord(value.uploadedAssetKeys)
  if (uploadedAssetKeys) result.uploadedAssetKeys = uploadedAssetKeys
  const deletedAssetKeys = readStringArray(value.deletedAssetKeys)
  if (deletedAssetKeys) result.deletedAssetKeys = deletedAssetKeys
  const conflict = readBackupConflict(value.conflict)
  if (conflict) result.conflict = conflict
  if (isJsonString(value.error)) result.error = value.error
  if (value.ok && value.uploadedAssetKeys !== undefined && !uploadedAssetKeys) return null
  if (!value.ok && value.conflict !== undefined && !conflict) return null
  return result
}

const readCloudBackupSnapshot = (value: JsonValue): CloudBackupSnapshot | null => {
  if (!isJsonObject(value) || !isJsonString(value.manifestVersion)) return null
  try {
    return {
      manifest: normalizeProjectManifest(value.manifest),
      manifestVersion: value.manifestVersion,
    }
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const LAST_BACKED_UP_PROJECT_UPDATED_AT_KEY = CLOUD_BACKUP_LAST_PROJECT_UPDATED_AT_KEY
const LAST_BACKED_UP_MANIFEST_VERSION_KEY = CLOUD_BACKUP_LAST_MANIFEST_VERSION_KEY

const readLastBackedUpProjectUpdatedAt = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('syncState', LAST_BACKED_UP_PROJECT_UPDATED_AT_KEY)
  const parsed = finiteNumberSchema.safeParse(row?.value)
  return parsed.success ? parsed.data : undefined
}

const readLastBackedUpManifestVersion = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('syncState', LAST_BACKED_UP_MANIFEST_VERSION_KEY)
  const parsed = z.string().safeParse(row?.value)
  return parsed.success ? parsed.data : undefined
}

const readPendingDeletedCloudAssetKeys = async (projectId: string): Promise<string[]> => {
  return (await readPendingDeletedCloudAssetRows(projectId)).flatMap((row) => {
    const cloudKey = readPendingDeletedCloudAssetKey(row)
    return cloudKey === null ? [] : [cloudKey]
  })
}

export const disableProjectBackup = async (projectId: string) => {
  await setLocalProjectMode(projectId, 'local-only')
}

const cloudAssetSourceRows = (manifest: ProjectManifest): LocalProjectSyncStateRow[] => {
  const updatedAt = Date.now()
  return manifest.assets.flatMap((asset) => {
    if (!asset.cloudKey) return []
    return [{
      key: `cloud-source:asset:${asset.id}`,
      value: asset.cloudKey,
      updatedAt,
    }]
  })
}

const cloudAssetMappingRows = (manifest: ProjectManifest): LocalProjectSyncStateRow[] => (
  assetCloudIdMappingRows(manifest.assets.flatMap((asset) => (
    asset.cloudKey ? [{ localId: asset.id, cloudId: asset.cloudKey }] : []
  )))
)

const backupBookkeepingRows = (
  manifest: ProjectManifest,
  manifestVersion: string,
): LocalProjectSyncStateRow[] => {
  const updatedAt = Date.now()
  return [
    {
      key: LAST_BACKED_UP_PROJECT_UPDATED_AT_KEY,
      value: manifest.updatedAt,
      updatedAt,
    },
    {
      key: LAST_BACKED_UP_MANIFEST_VERSION_KEY,
      value: manifestVersion,
      updatedAt,
    },
  ]
}

const uploadedAssetMappingRows = (
  uploadedAssetKeys: Record<string, string>,
): LocalProjectSyncStateRow[] => assetCloudIdMappingRows(
  Object.entries(uploadedAssetKeys).map(([localId, cloudId]) => ({ localId, cloudId })),
)

const dedupeSyncRows = (rows: LocalProjectSyncStateRow[]): LocalProjectSyncStateRow[] => (
  Array.from(new Map(rows.map((row) => [row.key, row])).values())
)

const applyCloudBackupCommit = async (
  projectId: string,
  manifest: ProjectManifest,
  result: BackupResult,
) => {
  const db = await openLocalProjectDb(projectId)
  const pendingDeletedRows = await db.getAll('syncState', cloudAssetDeleteKeyRange())
  const deleted = new Set(result.deletedAssetKeys ?? [])
  const tx = db.transaction('syncState', 'readwrite')
  await Promise.all([
    ...uploadedAssetMappingRows(result.uploadedAssetKeys ?? {}).map((row) => tx.objectStore('syncState').put(row)),
    tx.objectStore('syncState').put({
      key: LAST_BACKED_UP_PROJECT_UPDATED_AT_KEY,
      value: manifest.updatedAt,
      updatedAt: Date.now(),
    }),
    ...(result.manifestVersion
      ? [tx.objectStore('syncState').put({
        key: LAST_BACKED_UP_MANIFEST_VERSION_KEY,
        value: result.manifestVersion,
        updatedAt: Date.now(),
      })]
      : []),
    ...pendingDeletedRows.flatMap((row) => {
      const cloudKey = readPendingDeletedCloudAssetKey(row)
      return cloudKey && deleted.has(cloudKey) ? [tx.objectStore('syncState').delete(row.key)] : []
    }),
    tx.done,
  ])
  await setLocalProjectMode(projectId, 'backup')
}

const restoreSyncRows = (
  manifest: ProjectManifest,
  manifestVersion: string,
  options: { linkAssetsForBackup: boolean },
): LocalProjectSyncStateRow[] => dedupeSyncRows([
  ...manifest.syncState.filter((row) => isProjectManifestSyncStateKey(row.key)),
  ...cloudAssetSourceRows(manifest),
  ...(options.linkAssetsForBackup ? cloudAssetMappingRows(manifest) : []),
  ...backupBookkeepingRows(manifest, manifestVersion),
])

const restoredExternalPluginArtifacts = (manifest: ProjectManifest) => {
  const updatedAt = Date.now()
  return manifest.externalPluginArtifacts.map((artifact) => ({ ...artifact, updatedAt }))
}

const fetchCloudBackupSnapshot = async (projectId: string): Promise<CloudBackupSnapshot> => {
  const response = await fetch(`/api/cloud-backups/${encodeURIComponent(projectId)}`)
  const snapshot = readCloudBackupSnapshot(await response.json().catch(() => null))
  if (!response.ok || !snapshot) throw new Error('Cloud backup could not be loaded.')
  return snapshot
}

export const restoreCloudBackupToLocalProject = async (
  projectId: string,
): Promise<string> => {
  const { manifest, manifestVersion } = await fetchCloudBackupSnapshot(projectId)
  const assets = manifest.assets.map(({ cloudKey: _cloudKey, ...asset }) => asset)
  const project = {
    ...createRestoredProjectEntry(manifest),
    id: projectId,
    mode: 'backup' as const,
    updatedAt: manifest.updatedAt,
    lastOpenedAt: Date.now(),
  }
  await replaceLocalProject(project, {
    entities: manifest.entities,
    assets,
    projectState: manifest.projectState,
    syncState: restoreSyncRows(manifest, manifestVersion, { linkAssetsForBackup: true }),
    externalPluginArtifacts: restoredExternalPluginArtifacts(manifest),
  })
  return projectId
}

export const duplicateCloudBackupAsLocalProject = async (
  projectId: string,
): Promise<string> => {
  const { manifest } = await fetchCloudBackupSnapshot(projectId)
  const localProjectId = createProjectId()
  const duplicatedManifest = { ...manifest, projectId: localProjectId }
  const assets = duplicatedManifest.assets.map(({ cloudKey: _cloudKey, ...asset }) => asset)
  const project = {
    ...createRestoredProjectEntry(duplicatedManifest, `${manifest.name} Copy`),
    id: localProjectId,
    mode: 'local-only' as const,
    updatedAt: manifest.updatedAt,
  }
  await importLocalProject(project, {
    entities: duplicatedManifest.entities,
    assets,
    projectState: duplicatedManifest.projectState,
    syncState: cloudAssetSourceRows(manifest),
    externalPluginArtifacts: restoredExternalPluginArtifacts(duplicatedManifest),
  })
  return localProjectId
}

const appendProjectAssets = async (form: FormData, projectId: string, manifest: ProjectManifest): Promise<void> => {
  const assets = manifest.assets.filter((asset) => !asset.missing && !asset.cloudKey)
  for (let index = 0; index < assets.length; index += 2) {
    await Promise.all(assets.slice(index, index + 2).map(async (asset) => {
      const result = await readLocalAssetBytes(projectId, asset.id)
      if (result.status !== 'ready') {
        throw new Error(`Could not read asset ${asset.id} for backup.`)
      }
      form.append(`asset:${asset.id}`, result.file)
    }))
  }
}

export const runProjectBackup = async (
  projectId: string,
  conflictAction: 'detect' | 'overwrite' = 'detect',
  options: { skipIfUnchanged?: boolean } = {},
): Promise<BackupResult> => {
  try {
    const manifest = await buildProjectManifest(projectId, 'backup')
    assertProjectManifestPublishIntegrity(manifest)
    const baseManifestVersion = await readLastBackedUpManifestVersion(projectId)
    const pendingDeletedCloudKeys = await readPendingDeletedCloudAssetKeys(projectId)
    if (
      options.skipIfUnchanged &&
      pendingDeletedCloudKeys.length === 0 &&
      baseManifestVersion &&
      await readLastBackedUpProjectUpdatedAt(projectId) === manifest.updatedAt
    ) {
      return { ok: true }
    }
    const form = new FormData()
    form.set('projectId', projectId)
    form.set('manifest', JSON.stringify(manifest))
    form.set('conflictAction', conflictAction)
    if (baseManifestVersion) form.set('baseManifestVersion', baseManifestVersion)
    if (pendingDeletedCloudKeys.length > 0) {
      form.set('pendingDeletedCloudKeys', JSON.stringify(pendingDeletedCloudKeys))
    }
    await appendProjectAssets(form, projectId, manifest)

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch('/api/cloud-backups', { method: 'POST', body: form })
        const data = readBackupResult(await response.json().catch(() => null))
        if (response.status === 409 && data?.conflict) return data
        if (!response.ok || !data?.ok) throw new Error(data?.error ?? 'Backup failed.')
        await applyCloudBackupCommit(projectId, manifest, data)
        return data
      } catch (error) {
        if (attempt === 3) {
          return { ok: false, error: error instanceof Error ? error.message : 'Backup failed.' }
        }
        await sleep(Math.min(8000, 500 * 2 ** attempt))
      }
    }
    return { ok: false, error: 'Backup failed.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Backup failed.' }
  }
}
