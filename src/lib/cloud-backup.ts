import { readLocalAssetBytes } from '~/lib/local-assets'
import { openLocalProjectDb, setLocalProjectMode } from '~/lib/local-project-db'
import { saveCloudIdMapping } from '~/lib/local-cloud-id-map'
import { buildProjectManifest, CLOUD_BACKUP_LAST_MANIFEST_VERSION_KEY, CLOUD_BACKUP_LAST_PROJECT_UPDATED_AT_KEY } from '~/lib/project-manifest'
import type { ProjectManifest } from '~/lib/project-manifest-contract'

type BackupResult = {
  ok: boolean
  manifestVersion?: string
  uploadedAssetKeys?: Record<string, string>
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
  const conflict = readBackupConflict(value.conflict)
  if (conflict) result.conflict = conflict
  if (typeof value.error === 'string') result.error = value.error
  if (value.ok && value.uploadedAssetKeys !== undefined && !uploadedAssetKeys) return null
  if (!value.ok && value.conflict !== undefined && !conflict) return null
  return result
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const LAST_BACKED_UP_PROJECT_UPDATED_AT_KEY = CLOUD_BACKUP_LAST_PROJECT_UPDATED_AT_KEY
const LAST_BACKED_UP_MANIFEST_VERSION_KEY = CLOUD_BACKUP_LAST_MANIFEST_VERSION_KEY

const readLastBackedUpProjectUpdatedAt = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('syncState', LAST_BACKED_UP_PROJECT_UPDATED_AT_KEY)
  return typeof row?.value === 'number' ? row.value : undefined
}

const writeLastBackedUpProjectUpdatedAt = async (projectId: string, updatedAt: number) => {
  const db = await openLocalProjectDb(projectId)
  await db.put('syncState', {
    key: LAST_BACKED_UP_PROJECT_UPDATED_AT_KEY,
    value: updatedAt,
    updatedAt: Date.now(),
  })
}

const readLastBackedUpManifestVersion = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('syncState', LAST_BACKED_UP_MANIFEST_VERSION_KEY)
  return typeof row?.value === 'string' ? row.value : undefined
}

const writeLastBackedUpManifestVersion = async (projectId: string, manifestVersion: string) => {
  const db = await openLocalProjectDb(projectId)
  await db.put('syncState', {
    key: LAST_BACKED_UP_MANIFEST_VERSION_KEY,
    value: manifestVersion,
    updatedAt: Date.now(),
  })
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
    if (options.skipIfUnchanged && baseManifestVersion && await readLastBackedUpProjectUpdatedAt(projectId) === manifest.updatedAt) {
      return { ok: true }
    }
    const form = new FormData()
    form.set('projectId', projectId)
    form.set('manifest', JSON.stringify(manifest))
    form.set('conflictAction', conflictAction)
    if (baseManifestVersion) form.set('baseManifestVersion', baseManifestVersion)
    await appendProjectAssets(form, projectId, manifest)

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch('/api/cloud-backups', { method: 'POST', body: form })
        const data = readBackupResult(await response.json().catch(() => null))
        if (response.status === 409 && data?.conflict) return data
        if (!response.ok || !data?.ok) throw new Error(data?.error ?? 'Backup failed.')
        await setLocalProjectMode(projectId, 'backup')
        await Promise.all(Object.entries(data.uploadedAssetKeys ?? {}).map(([localId, cloudId]) => (
          saveCloudIdMapping(projectId, 'asset', localId, cloudId, localId)
        )))
        await writeLastBackedUpProjectUpdatedAt(projectId, manifest.updatedAt)
        if (data.manifestVersion) await writeLastBackedUpManifestVersion(projectId, data.manifestVersion)
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
