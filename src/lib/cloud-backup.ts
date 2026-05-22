import { listLocalAssets, readLocalAssetBytes } from '~/lib/local-assets'
import { setLocalProjectMode } from '~/lib/local-project-db'
import { saveCloudIdMapping } from '~/lib/local-cloud-id-map'
import { buildProjectManifest, type ProjectManifest } from '~/lib/project-manifest'

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
): Promise<BackupResult> => {
  const manifest = await buildProjectManifest(projectId, 'backup')
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

const fetchCloudBackupManifest = async (projectId: string): Promise<ProjectManifest> => {
  const response = await fetch(`/api/cloud-backups/${encodeURIComponent(projectId)}`)
  if (!response.ok) throw new Error('Could not restore cloud backup.')
  const data = await response.json() as { manifest: ProjectManifest }
  return data.manifest
}
