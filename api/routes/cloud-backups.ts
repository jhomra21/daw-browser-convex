import { ConvexHttpClient } from 'convex/browser'
import { api as convexApi } from '../../convex/_generated/api'
import { parseProjectManifest, type ProjectManifest, withProjectManifestAssetKeys } from '../../src/lib/project-manifest-contract'
import { isValidR2DeleteKey } from '../../src/lib/r2-delete-keys'
import type { App } from '../app-types'
import { hashFile } from '../hash-file'
import { parseJsonBody } from '../json-body'
import { requireAuthenticatedConvexForApi, requireProjectDeleteOwnerContextForApi } from '../project-access'
import { deleteR2Keys, drainProjectPrefixDelete, drainR2DeleteQueue } from '../r2-delete-queue'
import { z } from 'zod'

type BackupAssetUploadValidation =
  | { ok: true; manifestAssetIds: Set<string> }
  | { ok: false; error: string }

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

const cloudProjectCreateBodySchema = z.object({
  projectId: z.string(),
})

const readPendingDeletedCloudKeys = (value: FormDataEntryValue | null, projectId: string) => {
  if (value === null) return []
  if (typeof value !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) return null
  const keys = [...new Set(parsed)]
  return keys.every((key) => isValidR2DeleteKey(projectId, 'backup-asset', key)) ? keys : null
}

const ensureCloudProjectWritable = async (input: {
  convex: ConvexHttpClient
  projectId: string
}) => {
  const canWrite = async () => {
    const role = await input.convex.query(convexApi.projectAccess.roleForUser, {
      projectId: input.projectId,
    })
    return role === 'owner' || role === 'editor'
  }
  if (await input.convex.query(convexApi.projects.exists, { projectId: input.projectId })) {
    return { writable: await canWrite(), created: false }
  }
  try {
    const result = await input.convex.mutation(convexApi.projects.createOwnedRoom, {
      projectId: input.projectId,
    })
    return { writable: true, created: result.status === 'created' }
  } catch (error) {
    if (await input.convex.query(convexApi.projects.exists, { projectId: input.projectId })) {
      return { writable: await canWrite(), created: false }
    }
    throw error
  }
}

const uploadBackupAssets = async (input: {
  bucket: R2Bucket
  form: FormData
  manifest: ProjectManifest
  manifestAssetIds: Set<string>
  projectId: string
  uploadedBy: string
}) => {
  const uploadedAssetKeys: Record<string, string> = {}
  const uploadedR2Keys: string[] = []
  for (const [key, value] of input.form.entries()) {
    if (!key.startsWith('asset:') || !(value instanceof File)) continue
    const assetId = key.slice('asset:'.length)
    if (!input.manifestAssetIds.has(assetId)) continue
    const hash = await hashFile(value)
    const ext = value.name.includes('.') ? value.name.slice(value.name.lastIndexOf('.')) : ''
    const r2Key = `projects/${input.projectId}/assets/${assetId}/${crypto.randomUUID()}-${hash}${ext}`
    await input.bucket.put(r2Key, value.stream(), {
      httpMetadata: { contentType: value.type || 'application/octet-stream' },
      customMetadata: {
        projectId: input.projectId,
        assetId,
        contentHash: hash,
        uploadedBy: input.uploadedBy,
        uploadedAt: new Date().toISOString(),
      },
    })
    uploadedAssetKeys[assetId] = r2Key
    uploadedR2Keys.push(r2Key)
  }
  return {
    manifest: withProjectManifestAssetKeys(input.manifest, uploadedAssetKeys),
    uploadedAssetKeys,
    uploadedR2Keys,
  }
}

export function registerCloudBackupRoutes(app: App) {
  app.post('/api/cloud-projects', async (c) => {
  try {
    const access = await requireAuthenticatedConvexForApi(c)
    if (!access) return c.json({ error: 'Unauthorized' }, 401)
    const body = await parseJsonBody(c, cloudProjectCreateBodySchema)
    if (!body) return c.json({ error: 'Invalid body' }, 400)
    const projectWrite = await ensureCloudProjectWritable({
      convex: access.convex,
      projectId: body.projectId,
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
    const access = await requireAuthenticatedConvexForApi(c)
    if (!access) return c.json({ error: 'Unauthorized' }, 401)
    const form = await c.req.formData()
    const projectId = form.get('projectId')?.toString()
    const manifestRaw = form.get('manifest')?.toString()
    const conflictAction = form.get('conflictAction') === 'overwrite' ? 'overwrite' : 'detect'
    const baseManifestVersion = form.get('baseManifestVersion')?.toString()
    if (!projectId || !manifestRaw) return c.json({ error: 'Missing projectId or manifest' }, 400)
    const pendingDeletedCloudKeys = readPendingDeletedCloudKeys(form.get('pendingDeletedCloudKeys'), projectId)
    if (!pendingDeletedCloudKeys) return c.json({ error: 'Invalid pending delete keys' }, 400)

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
    const { convex, user } = access
    const uploadedAssetKeys: Record<string, string> = {}
    const uploadedR2Keys: string[] = []
    let createdCloudProject = false
    try {
      const projectWrite = await ensureCloudProjectWritable({
        convex,
        projectId,
      })
      createdCloudProject = projectWrite.created
      if (!projectWrite.writable) {
        return c.json({ error: 'Forbidden' }, 403)
      }
      if (conflictAction === 'detect') {
        const conflict = await convex.query(convexApi.cloudBackups.checkConflict, {
          projectId,
          manifest,
          baseManifestVersion,
        })
        if (conflict) return c.json({ ok: false, conflict }, 409)
      }
      const upload = await uploadBackupAssets({
        bucket: c.env.daw_audio_samples,
        form,
        manifest,
        manifestAssetIds: uploadValidation.manifestAssetIds,
        projectId,
        uploadedBy: user.id,
      })
      manifest = upload.manifest
      Object.assign(uploadedAssetKeys, upload.uploadedAssetKeys)
      uploadedR2Keys.push(...upload.uploadedR2Keys)

      const result = await convex.mutation(convexApi.cloudBackups.upsertLatest, {
        projectId,
        manifest,
        conflictAction,
        baseManifestVersion,
        pendingDeletedCloudKeys,
      })
      if (result.conflict) {
        await deleteUploadedBackupAssetsBestEffort(c.env.daw_audio_samples, uploadedR2Keys)
        return c.json({ ok: false, conflict: result.conflict }, 409)
      }
      const cleanup = await drainR2DeleteQueue({
        c,
        user,
        bucket: c.env.daw_audio_samples,
        projectId,
      }).catch((cleanupError) => {
        console.warn('Failed to drain queued R2 deletes', cleanupError)
        return null
      })
      const cleanupKeys = new Set(result.queuedDeletedCloudKeys)
      return c.json({
        ok: true,
        manifestVersion: result.manifestVersion,
        uploadedAssetKeys,
        deletedAssetKeys: cleanup ? cleanup.deletedKeys.filter((key) => cleanupKeys.has(key)) : [],
      })
    } catch (err) {
      await deleteUploadedBackupAssetsBestEffort(c.env.daw_audio_samples, uploadedR2Keys)
      if (createdCloudProject) {
        try {
          await convex.mutation(convexApi.projects.prepareCloudRoomDeleteAsOwner, {
            projectId,
          })
          await convex.mutation(convexApi.projects.finalizeCloudRoomDeleteAsOwner, {
            projectId,
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
    const access = await requireAuthenticatedConvexForApi(c)
    if (!access) return c.json({ error: 'Unauthorized' }, 401)
    const row = await access.convex.query(convexApi.cloudBackups.getLatest, {
      projectId,
    })
    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json({ manifest: row.manifest, manifestVersion: row.manifestVersion })
  } catch (err) {
    console.error('Cloud backup fetch error', err)
    return c.json({ error: 'Failed to fetch backup' }, 500)
  }
})

  app.delete('/api/cloud-projects/:projectId/access', async (c) => {
  try {
    const projectId = c.req.param('projectId')
    const access = await requireAuthenticatedConvexForApi(c)
    if (!access) return c.json({ error: 'Unauthorized' }, 401)
    const result = await access.convex.mutation(convexApi.projects.leaveCloudRoomAccess, {
      projectId,
    })
    return c.json({ ok: true, result })
  } catch (err) {
    console.error('Cloud project leave error', err)
    return c.json({ error: 'Failed to leave cloud project' }, 500)
  }
})

  app.delete('/api/cloud-projects/:projectId', async (c) => {
  let preparedDelete: { convex: ConvexHttpClient; projectId: string } | undefined
  try {
    const projectId = c.req.param('projectId')
    const access = await requireProjectDeleteOwnerContextForApi(c, projectId)
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    const { convex, user } = access
    await convex.mutation(convexApi.projects.prepareCloudRoomDeleteAsOwner, {
      projectId,
    })
    preparedDelete = { convex, projectId }
    const result = await convex.mutation(convexApi.projects.finalizeCloudRoomDeleteAsOwner, {
      projectId,
    })
    preparedDelete = undefined
    try {
      await drainProjectPrefixDelete({
        c,
        user,
        bucket: c.env.daw_audio_samples,
        projectId,
      })
      await drainR2DeleteQueue({
        c,
        user,
        bucket: c.env.daw_audio_samples,
        projectId,
        limit: 100,
      })
    } catch (cleanupError) {
      console.warn('Failed to delete cloud project assets after Convex delete; queued retry will continue', cleanupError)
    }
    return c.json({ ok: true, result })
  } catch (err) {
    if (preparedDelete) {
      try {
        await preparedDelete.convex.mutation(convexApi.projects.clearCloudRoomDeletePendingAsOwner, {
          projectId: preparedDelete.projectId,
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
