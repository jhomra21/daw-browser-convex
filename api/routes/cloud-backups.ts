import { ConvexHttpClient } from 'convex/browser'
import { api as convexApi } from '../../convex/_generated/api'
import { parseProjectManifest, type ProjectManifest, withProjectManifestAssetKeys } from '../../src/lib/project-manifest-contract'
import type { App } from '../app-types'
import { requireProjectDeleteOwnerForApi, requireProjectRoleForApi } from '../project-access'

type CloudBackupRow = {
  manifest: Omit<ProjectManifest, 'syncState'> & {
    syncState?: ProjectManifest['syncState']
  }
  manifestVersion: string
}

type BackupConflict = {
  localUpdatedAt: number
  cloudUpdatedAt: number
  localEntityCount: number
  cloudEntityCount: number
  localAssetCount: number
  cloudAssetCount: number
}

type BackupUpsertResult = {
  ok: boolean
  manifestVersion?: string
  conflict?: BackupConflict
  supersededCloudKeys?: string[]
}

type BackupAssetUploadValidation =
  | { ok: true; manifestAssetIds: Set<string> }
  | { ok: false; error: string }

const deleteR2Prefix = async (bucket: R2Bucket, prefix: string) => {
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 })
    const keys = page.objects.map((entry) => entry.key).filter(Boolean)
    if (keys.length > 0) await bucket.delete(keys)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

const deleteR2Keys = async (bucket: R2Bucket, keys: string[]) => {
  if (keys.length === 0) return
  await bucket.delete(keys)
}

const deleteUploadedBackupAssetsBestEffort = async (bucket: R2Bucket, keys: string[]) => {
  try {
    await deleteR2Keys(bucket, keys)
    return true
  } catch (cleanupError) {
    console.warn('Failed to delete uploaded backup assets', cleanupError)
    return false
  }
}

const validateBackupAssetUploads = (form: FormData, manifest: ProjectManifest): BackupAssetUploadValidation => {
  const manifestAssetIds = new Set(manifest.assets.map((asset) => asset.id))
  const uploadedAssetIds = new Set<string>()
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('asset:') || !(value instanceof File)) continue
    const assetId = key.slice('asset:'.length)
    if (!manifestAssetIds.has(assetId)) continue
    if (uploadedAssetIds.has(assetId)) {
      return { ok: false, error: 'Duplicate backup asset upload' }
    }
    uploadedAssetIds.add(assetId)
  }
  if (manifest.assets.some((asset) => !asset.missing && !uploadedAssetIds.has(asset.id))) {
    return { ok: false, error: 'Missing backup asset upload' }
  }
  return { ok: true, manifestAssetIds }
}

const projectExistsForBackup = async (convex: ConvexHttpClient, projectId: string): Promise<boolean> => (
  await convex.query(convexApi.projects.exists, { projectId })
)

const createOwnedProjectForBackup = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  serverSecret: string,
) => {
  return await convex.mutation(convexApi.projects.createOwnedRoom, { projectId, userId, serverSecret })
}

const checkBackupConflict = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  manifest: ProjectManifest,
  serverSecret: string,
): Promise<BackupConflict | null> => (
  await convex.query(convexApi.cloudBackups.checkConflict, {
    projectId,
    userId,
    manifest,
    serverSecret,
  })
)

const upsertLatestBackup = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  manifest: ProjectManifest,
  conflictAction: 'detect' | 'overwrite',
  serverSecret: string,
): Promise<BackupUpsertResult> => (
  await convex.mutation(convexApi.cloudBackups.upsertLatest, {
    projectId,
    userId,
    manifest,
    conflictAction,
    serverSecret,
  })
)

const getLatestBackup = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  serverSecret: string,
): Promise<CloudBackupRow | null> => (
  await convex.query(convexApi.cloudBackups.getLatest, {
    projectId,
    userId,
    serverSecret,
  })
)

const prepareCloudProjectDeleteAsOwner = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  serverSecret: string,
) => (
  await convex.mutation(convexApi.projects.prepareCloudRoomDeleteAsOwner, {
    projectId,
    userId,
    serverSecret,
  })
)

const finalizeCloudProjectDeleteAsOwner = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  serverSecret: string,
) => (
  await convex.mutation(convexApi.projects.finalizeCloudRoomDeleteAsOwner, {
    projectId,
    userId,
    serverSecret,
  })
)

const clearCloudProjectDeletePendingAsOwner = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  serverSecret: string,
) => (
  await convex.mutation(convexApi.projects.clearCloudRoomDeletePendingAsOwner, {
    projectId,
    userId,
    serverSecret,
  })
)

const rollbackCreatedCloudProjectIfEmpty = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  serverSecret: string,
) => (
  await convex.mutation(convexApi.projects.rollbackCreatedRoomIfEmpty, {
    projectId,
    userId,
    serverSecret,
  })
)

const hashFile = async (file: File) => {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const readCloudProjectCreateBody = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('projectId' in value) || typeof value.projectId !== 'string') return null
  return { projectId: value.projectId }
}

export function registerCloudBackupRoutes(app: App) {
  app.post('/api/cloud-projects', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const body = readCloudProjectCreateBody(await c.req.json().catch(() => null))
    if (!body) return c.json({ error: 'Invalid body' }, 400)
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    await createOwnedProjectForBackup(convex, body.projectId, user.id, c.env.CLOUD_PROJECTS_SERVICE_TOKEN)
    return c.json({ ok: true })
  } catch (err) {
    console.error('Cloud project create error', err)
    return c.json({ error: 'Failed to create cloud project' }, 500)
  }
})

  app.post('/api/cloud-backups', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const form = await c.req.formData()
    const projectId = form.get('projectId')?.toString()
    const manifestRaw = form.get('manifest')?.toString()
    const conflictAction = form.get('conflictAction') === 'overwrite' ? 'overwrite' : 'detect'
    if (!projectId || !manifestRaw) return c.json({ error: 'Missing projectId or manifest' }, 400)

    let manifest: ProjectManifest
    try {
      manifest = parseProjectManifest(manifestRaw)
    } catch {
      return c.json({ error: 'Invalid manifest' }, 400)
    }
    if (manifest.projectId !== projectId) {
      return c.json({ error: 'Manifest projectId mismatch' }, 400)
    }
    const uploadValidation = validateBackupAssetUploads(form, manifest)
    if (!uploadValidation.ok) {
      return c.json({ error: uploadValidation.error }, 400)
    }

    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    let createdProject = false
    const uploadedAssetKeys: Record<string, string> = {}
    const uploadedR2Keys: string[] = []
    try {
      const projectExists = await projectExistsForBackup(convex, projectId)
      if (!projectExists) {
        const createResult = await createOwnedProjectForBackup(convex, projectId, user.id, c.env.CLOUD_PROJECTS_SERVICE_TOKEN)
        createdProject = createResult?.status === 'created'
      } else if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor'])) {
        return c.json({ error: 'Forbidden' }, 403)
      }
      if (conflictAction === 'detect') {
        const conflict = await checkBackupConflict(convex, projectId, user.id, manifest, c.env.CLOUD_PROJECTS_SERVICE_TOKEN)
        if (conflict) return c.json({ ok: false, conflict }, 409)
      }
      for (const [key, value] of form.entries()) {
        if (!key.startsWith('asset:') || !(value instanceof File)) continue
        const assetId = key.slice('asset:'.length)
        if (!uploadValidation.manifestAssetIds.has(assetId)) continue
        const hash = await hashFile(value)
        const ext = value.name.includes('.') ? value.name.slice(value.name.lastIndexOf('.')) : ''
        const r2Key = `projects/${projectId}/assets/${assetId}/${crypto.randomUUID()}-${hash}${ext}`
        await c.env.daw_audio_samples.put(r2Key, value.stream(), {
          httpMetadata: { contentType: value.type || 'application/octet-stream' },
          customMetadata: {
            projectId,
            assetId,
            contentHash: hash,
            uploadedBy: user.id,
            uploadedAt: new Date().toISOString(),
          },
        })
        uploadedAssetKeys[assetId] = r2Key
        uploadedR2Keys.push(r2Key)
      }
      manifest = withProjectManifestAssetKeys(manifest, uploadedAssetKeys)

      const result = await upsertLatestBackup(convex, projectId, user.id, manifest, conflictAction, c.env.CLOUD_PROJECTS_SERVICE_TOKEN)
      if (result?.conflict) {
        await deleteUploadedBackupAssetsBestEffort(c.env.daw_audio_samples, uploadedR2Keys)
        if (createdProject) {
          await rollbackCreatedCloudProjectIfEmpty(convex, projectId, user.id, c.env.CLOUD_PROJECTS_SERVICE_TOKEN)
        }
        return c.json({ ok: false, conflict: result.conflict }, 409)
      }
      try {
        await deleteR2Keys(c.env.daw_audio_samples, result?.supersededCloudKeys ?? [])
      } catch (cleanupError) {
        console.warn('Failed to delete superseded backup assets', cleanupError)
      }
      return c.json({ ok: true, manifestVersion: result?.manifestVersion, uploadedAssetKeys })
    } catch (err) {
      const cleanupSucceeded = await deleteUploadedBackupAssetsBestEffort(c.env.daw_audio_samples, uploadedR2Keys)
      if (createdProject && cleanupSucceeded) {
        await rollbackCreatedCloudProjectIfEmpty(convex, projectId, user.id, c.env.CLOUD_PROJECTS_SERVICE_TOKEN)
      }
      throw err
    }
  } catch (err) {
    console.error('Cloud backup error', err)
    return c.json({ error: 'Failed to back up project' }, 500)
  }
})

  app.get('/api/cloud-backups/:projectId', async (c) => {
  try {
    const projectId = c.req.param('projectId')
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    const row = await getLatestBackup(convex, projectId, user.id, c.env.CLOUD_PROJECTS_SERVICE_TOKEN)
    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json({ manifest: row.manifest, manifestVersion: row.manifestVersion })
  } catch (err) {
    console.error('Cloud backup fetch error', err)
    return c.json({ error: 'Failed to fetch backup' }, 500)
  }
})

  app.delete('/api/cloud-projects/:projectId', async (c) => {
  let preparedDelete: { convex: ConvexHttpClient; projectId: string; userId: string } | null = null
  try {
    const projectId = c.req.param('projectId')
    const user = await requireProjectDeleteOwnerForApi(c, projectId)
    if (!user) return c.json({ error: 'Forbidden' }, 403)
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    const prepared = await prepareCloudProjectDeleteAsOwner(convex, projectId, user.id, c.env.CLOUD_PROJECTS_SERVICE_TOKEN)
    if (prepared?.status !== 'deleted') return c.json({ ok: false, result: prepared }, 409)
    preparedDelete = { convex, projectId, userId: user.id }
    const result = await finalizeCloudProjectDeleteAsOwner(convex, projectId, user.id, c.env.CLOUD_PROJECTS_SERVICE_TOKEN)
    if (result?.status !== 'deleted') return c.json({ ok: false, result }, 409)
    preparedDelete = null
    try {
      await deleteR2Prefix(c.env.daw_audio_samples, `projects/${projectId}/`)
    } catch (cleanupError) {
      console.warn('Failed to delete cloud project assets after Convex delete', cleanupError)
    }
    return c.json({ ok: true, result })
  } catch (err) {
    if (preparedDelete) {
      await clearCloudProjectDeletePendingAsOwner(
        preparedDelete.convex,
        preparedDelete.projectId,
        preparedDelete.userId,
        c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
      ).catch((rollbackError) => {
        console.warn('Failed to clear pending project delete after R2 delete failure', rollbackError)
      })
    }
    console.error('Cloud project delete error', err)
    return c.json({ error: 'Failed to delete cloud project' }, 500)
  }
})
}
