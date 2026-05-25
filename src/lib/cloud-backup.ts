import { listLocalAssets, readLocalAssetBytes } from '~/lib/local-assets'
import { openLocalProjectDb, setLocalProjectMode } from '~/lib/local-project-db'
import { saveCloudIdMapping } from '~/lib/local-cloud-id-map'
import { buildProjectManifest } from '~/lib/project-manifest'

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

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const LAST_BACKED_UP_PROJECT_UPDATED_AT_KEY = 'cloudBackup:lastProjectUpdatedAt'

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

const appendProjectAssets = async (form: FormData, projectId: string): Promise<void> => {
  const assets = await listLocalAssets(projectId)
  let active = 0
  let index = 0
  await new Promise<void>((resolve, reject) => {
    const next = () => {
      if (index >= assets.length && active === 0) {
        resolve()
        return
      }
      while (active < 2 && index < assets.length) {
        const asset = assets[index++]
        active++
        void readLocalAssetBytes(projectId, asset.id)
          .then((result) => {
            if (result.status !== 'ready') {
              throw new Error(`Could not read asset ${asset.id} for backup.`)
            }
            form.append(`asset:${asset.id}`, result.file)
          })
          .then(() => {
            active--
            next()
          })
          .catch(reject)
      }
    }
    next()
  })
}

export const runProjectBackup = async (
  projectId: string,
  conflictAction: 'detect' | 'overwrite' = 'detect',
  options: { skipIfUnchanged?: boolean } = {},
): Promise<BackupResult> => {
  const manifest = await buildProjectManifest(projectId, 'backup')
  if (options.skipIfUnchanged && await readLastBackedUpProjectUpdatedAt(projectId) === manifest.updatedAt) {
    return { ok: true }
  }
  const form = new FormData()
  form.set('projectId', projectId)
  form.set('manifest', JSON.stringify(manifest))
  form.set('conflictAction', conflictAction)
  await appendProjectAssets(form, projectId)

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch('/api/cloud-backups', { method: 'POST', body: form })
      const data = await response.json().catch(() => null) as BackupResult | null
      if (response.status === 409 && data?.conflict) return data
      if (!response.ok || !data?.ok) throw new Error(data?.error ?? 'Backup failed.')
      await setLocalProjectMode(projectId, 'backup')
      await Promise.all(Object.entries(data.uploadedAssetKeys ?? {}).map(([localId, cloudId]) => (
        saveCloudIdMapping(projectId, 'asset', localId, cloudId, localId)
      )))
      await writeLastBackedUpProjectUpdatedAt(projectId, manifest.updatedAt)
      return data
    } catch (error) {
      if (attempt === 3) {
        return { ok: false, error: error instanceof Error ? error.message : 'Backup failed.' }
      }
      await sleep(Math.min(8000, 500 * 2 ** attempt))
    }
  }
  return { ok: false, error: 'Backup failed.' }
}
