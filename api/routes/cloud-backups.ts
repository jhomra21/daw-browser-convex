import { ConvexHttpClient } from 'convex/browser'
import { api as convexApi } from '../../convex/_generated/api'
import { parseProjectManifest, type ProjectManifest, withProjectManifestAssetKeys } from '../../src/lib/project-manifest-contract'
import type { App } from '../app-types'
import { hashFile } from '../hash-file'
import { requireProjectDeleteOwnerForApi } from '../project-access'

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
  } catch (cleanupError) {
    console.warn('Failed to delete uploaded backup assets', cleanupError)
  }
}

const validateBackupAssetUploads = (form: FormData, manifest: ProjectManifest): BackupAssetUploadValidation => {
  const manifestAssetIds = new Set(manifest.assets.map((asset) => asset.id))
  const uploadedAssetIds = new Set<string>()
  const isExistingCloudAsset = (asset: ProjectManifest['assets'][number]) => (
    Boolean(asset.cloudKey?.startsWith(`projects/${manifest.projectId}/assets/${asset.id}/`))
  )
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('asset:') || !(value instanceof File)) continue
    const assetId = key.slice('asset:'.length)
    if (!manifestAssetIds.has(assetId)) continue
    if (uploadedAssetIds.has(assetId)) {
      return { ok: false, error: 'Duplicate backup asset upload' }
    }
    uploadedAssetIds.add(assetId)
  }
  if (manifest.assets.some((asset) => !asset.missing && !asset.cloudKey && !uploadedAssetIds.has(asset.id))) {
    return { ok: false, error: 'Missing backup asset upload' }
  }
  if (manifest.assets.some((asset) => !asset.missing && asset.cloudKey && !isExistingCloudAsset(asset))) {
    return { ok: false, error: 'Invalid backup asset cloud key' }
  }
  return { ok: true, manifestAssetIds }
}

const readCloudProjectCreateBody = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('projectId' in value) || typeof value.projectId !== 'string') return null
  return { projectId: value.projectId }
}

const ensureCloudProjectWritable = async (input: {
  convex: ConvexHttpClient
  projectId: string
  userId: string
  serverSecret: string
}) => {
  const canWrite = async () => {
    const role = await input.convex.query(convexApi.projectAccess.roleForUser, {
      projectId: input.projectId,
      userId: input.userId,
    })
    return role === 'owner' || role === 'editor'
  }
  if (await input.convex.query(convexApi.projects.exists, { projectId: input.projectId })) {
    return { writable: await canWrite(), created: false }
  }
  try {
    const result = await input.convex.mutation(convexApi.projects.createOwnedRoom, {
      projectId: input.projectId,
      userId: input.userId,
      serverSecret: input.serverSecret,
    })
    return { writable: true, created: result.status === 'created' }
  } catch (error) {
    if (await input.convex.query(convexApi.projects.exists, { projectId: input.projectId })) {
      return { writable: await canWrite(), created: false }
    }
    throw error
  }
}

export function registerCloudBackupRoutes(app: App) {
  app.post('/api/cloud-projects', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const body = readCloudProjectCreateBody(await c.req.json().catch(() => null))
    if (!body) return c.json({ error: 'Invalid body' }, 400)
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    const projectWrite = await ensureCloudProjectWritable({
      convex,
      projectId: body.projectId,
      userId: user.id,
      serverSecret: c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
    })
    if (!projectWrite.writable) return c.json({ error: 'Forbidden' }, 403)
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
    const baseManifestVersion = form.get('baseManifestVersion')?.toString()
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
    const uploadedAssetKeys: Record<string, string> = {}
    const uploadedR2Keys: string[] = []
    let createdCloudProject = false
    try {
      const projectWrite = await ensureCloudProjectWritable({
        convex,
        projectId,
        userId: user.id,
        serverSecret: c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
      })
      createdCloudProject = projectWrite.created
      if (!projectWrite.writable) {
        return c.json({ error: 'Forbidden' }, 403)
      }
      if (conflictAction === 'detect') {
        const conflict = await convex.query(convexApi.cloudBackups.checkConflict, {
          projectId,
          userId: user.id,
          manifest,
          baseManifestVersion,
          serverSecret: c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
        })
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

      const result = await convex.mutation(convexApi.cloudBackups.upsertLatest, {
        projectId,
        userId: user.id,
        manifest,
        conflictAction,
        baseManifestVersion,
        serverSecret: c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
      })
      if (result.conflict) {
        await deleteUploadedBackupAssetsBestEffort(c.env.daw_audio_samples, uploadedR2Keys)
        return c.json({ ok: false, conflict: result.conflict }, 409)
      }
      try {
        await deleteR2Keys(c.env.daw_audio_samples, result.supersededCloudKeys)
      } catch (cleanupError) {
        console.warn('Failed to delete superseded backup assets', cleanupError)
      }
      return c.json({ ok: true, manifestVersion: result.manifestVersion, uploadedAssetKeys })
    } catch (err) {
      await deleteUploadedBackupAssetsBestEffort(c.env.daw_audio_samples, uploadedR2Keys)
      if (createdCloudProject) {
        try {
          await convex.mutation(convexApi.projects.finalizeCloudRoomDeleteAsOwner, {
            projectId,
            userId: user.id,
            serverSecret: c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
          })
        } catch (rollbackError) {
          console.warn('Failed to roll back newly-created cloud project after backup failure', rollbackError)
        }
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
    const row = await convex.query(convexApi.cloudBackups.getLatest, {
      projectId,
      userId: user.id,
      serverSecret: c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
    })
    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json({ manifest: row.manifest, manifestVersion: row.manifestVersion })
  } catch (err) {
    console.error('Cloud backup fetch error', err)
    return c.json({ error: 'Failed to fetch backup' }, 500)
  }
})

  app.delete('/api/cloud-projects/:projectId', async (c) => {
  let preparedDelete: { convex: ConvexHttpClient; projectId: string; userId: string } | undefined
  try {
    const projectId = c.req.param('projectId')
    const user = await requireProjectDeleteOwnerForApi(c, projectId)
    if (!user) return c.json({ error: 'Forbidden' }, 403)
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    await convex.mutation(convexApi.projects.prepareCloudRoomDeleteAsOwner, {
      projectId,
      userId: user.id,
      serverSecret: c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
    })
    preparedDelete = { convex, projectId, userId: user.id }
    const result = await convex.mutation(convexApi.projects.finalizeCloudRoomDeleteAsOwner, {
      projectId,
      userId: user.id,
      serverSecret: c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
    })
    preparedDelete = undefined
    try {
      await deleteR2Prefix(c.env.daw_audio_samples, `projects/${projectId}/`)
    } catch (cleanupError) {
      console.warn('Failed to delete cloud project assets after Convex delete', cleanupError)
    }
    return c.json({ ok: true, result })
  } catch (err) {
    if (preparedDelete) {
      try {
        await preparedDelete.convex.mutation(convexApi.projects.clearCloudRoomDeletePendingAsOwner, {
          projectId: preparedDelete.projectId,
          userId: preparedDelete.userId,
          serverSecret: c.env.CLOUD_PROJECTS_SERVICE_TOKEN,
        })
      } catch (rollbackError) {
        console.warn('Failed to clear pending cloud project delete', rollbackError)
      }
    }
    console.error('Cloud project delete error', err)
    return c.json({ error: 'Failed to delete cloud project' }, 500)
  }
})
}
