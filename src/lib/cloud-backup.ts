import { readLocalAssetBytes } from '~/lib/local-assets'
import { createProjectId, importLocalProject, openLocalProjectDb, replaceLocalProject, setLocalProjectMode } from '~/lib/local-project-db'
import { buildProjectManifest, CLOUD_BACKUP_LAST_MANIFEST_VERSION_KEY, CLOUD_BACKUP_LAST_PROJECT_UPDATED_AT_KEY, createRestoredProjectEntry, isProjectManifestSyncStateKey } from '~/lib/project-manifest'
import { normalizeProjectManifest, type ProjectManifest } from '~/lib/project-manifest-contract'
import type { LocalProjectSyncStateRow } from '~/lib/local-project-db'

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

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
)

const readStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!key || typeof entry !== 'string' || !entry) return undefined
    result[key] = entry
  }
  return result
}

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const result = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return result.length === value.length ? result : undefined
}

const readBackupConflict = (value: unknown): BackupResult['conflict'] | undefined => {
  if (!isRecord(value)) return undefined
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

const readBackupResult = (value: unknown): BackupResult | null => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null
  const result: BackupResult = { ok: value.ok }
  if (typeof value.manifestVersion === 'string') result.manifestVersion = value.manifestVersion
  const uploadedAssetKeys = readStringRecord(value.uploadedAssetKeys)
  if (uploadedAssetKeys) result.uploadedAssetKeys = uploadedAssetKeys
  const deletedAssetKeys = readStringArray(value.deletedAssetKeys)
  if (deletedAssetKeys) result.deletedAssetKeys = deletedAssetKeys
  const conflict = readBackupConflict(value.conflict)
  if (conflict) result.conflict = conflict
  if (typeof value.error === 'string') result.error = value.error
  if (value.ok && value.uploadedAssetKeys !== undefined && !uploadedAssetKeys) return null
  if (!value.ok && value.conflict !== undefined && !conflict) return null
  return result
}

const readCloudBackupSnapshot = (value: unknown): CloudBackupSnapshot | null => {
  if (!isRecord(value) || typeof value.manifestVersion !== 'string') return null
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
  return typeof row?.value === 'number' ? row.value : undefined
}

const readLastBackedUpManifestVersion = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('syncState', LAST_BACKED_UP_MANIFEST_VERSION_KEY)
  return typeof row?.value === 'string' ? row.value : undefined
}

const readPendingDeletedCloudAssetKeys = async (projectId: string): Promise<string[]> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAll('syncState')
  return rows.flatMap((row) => {
    if (!row.key.startsWith('cloud-delete:asset:')) return []
    if (typeof row.value === 'string') return [row.value]
    if (!isRecord(row.value) || typeof row.value.cloudId !== 'string') return []
    return [row.value.cloudId]
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

const assetCloudMappingRows = (
  entries: Iterable<{ localId: string; cloudId: string }>,
): LocalProjectSyncStateRow[] => {
  const updatedAt = Date.now()
  return Array.from(entries).flatMap(({ localId, cloudId }) => [
    {
      key: `cloud-id:asset:${localId}`,
      value: {
        kind: 'asset',
        localId,
        cloudId,
        historyRef: localId,
        updatedAt,
      },
      updatedAt,
    },
    {
      key: `local-id:asset:${cloudId}`,
      value: localId,
      updatedAt,
    },
  ])
}

const cloudAssetMappingRows = (manifest: ProjectManifest): LocalProjectSyncStateRow[] => (
  assetCloudMappingRows(manifest.assets.flatMap((asset) => {
    if (!asset.cloudKey) return []
    return [
      {
        localId: asset.id,
        cloudId: asset.cloudKey,
      },
    ]
  }))
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
): LocalProjectSyncStateRow[] => assetCloudMappingRows(
  Object.entries(uploadedAssetKeys).map(([localId, cloudId]) => ({ localId, cloudId })),
)

const applyCloudBackupCommit = async (
  projectId: string,
  manifest: ProjectManifest,
  result: BackupResult,
) => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAll('syncState')
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
    ...rows.flatMap((row) => {
      if (!row.key.startsWith('cloud-delete:asset:')) return []
      const cloudKey = typeof row.value === 'string'
        ? row.value
        : isRecord(row.value) && typeof row.value.cloudId === 'string'
          ? row.value.cloudId
          : null
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
): LocalProjectSyncStateRow[] => [
  ...manifest.syncState.filter((row) => isProjectManifestSyncStateKey(row.key)),
  ...cloudAssetSourceRows(manifest),
  ...(options.linkAssetsForBackup ? cloudAssetMappingRows(manifest) : []),
  ...backupBookkeepingRows(manifest, manifestVersion),
]

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
