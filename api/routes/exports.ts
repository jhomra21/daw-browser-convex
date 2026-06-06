import { api as convexApi } from '../../convex/_generated/api'
import type { App } from '../app-types'
import { requireAuthenticatedConvexForApi, requireProjectRoleContextForApi } from '../project-access'
import { streamProjectR2Object } from '../project-r2-stream'
import { drainR2DeleteQueue } from '../r2-delete-queue'
import { sanitizeFileNameSegment } from '../sanitize-file-name-segment'
import { getExportAudioFormatMetadata, isExportAudioFormat, type ExportAudioFormat } from '@daw-browser/shared'

const isExportMimeTypeAllowed = (format: ExportAudioFormat, mimeType: string) => {
  if (!mimeType) return true
  return mimeType === getExportAudioFormatMetadata(format).mimeType
}

export function registerExportRoutes(app: App) {
// Upload an export to R2 (protected route)
  app.post('/api/exports', async (c) => {
  try {
    const form = await c.req.formData()
    const projectId = form.get('projectId')?.toString()
    const requestedFormat = form.get('format')?.toString() ?? 'wav'
    const durationStr = form.get('duration')?.toString()
    const sampleRateStr = form.get('sampleRate')?.toString()
    const file = form.get('file')
    let name = form.get('name')?.toString()

    if (!projectId || !(file instanceof File)) {
      return c.json({ error: 'Missing projectId or file' }, 400)
    }
    if (!isExportAudioFormat(requestedFormat)) {
      return c.json({ error: 'Unsupported export format' }, 400)
    }
    const format = requestedFormat
    const metadata = getExportAudioFormatMetadata(format)
    if (!isExportMimeTypeAllowed(format, file.type)) {
      return c.json({ error: 'Export file type does not match format' }, 400)
    }
    const access = await requireProjectRoleContextForApi(c, projectId, ['owner', 'editor'])
    if (!access) return c.json({ error: 'Forbidden' }, 403)

    // Sanitize filename or generate one
    if (!name) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      name = `export_${ts}${metadata.fileExtension}`
    }
    const sanitized = sanitizeFileNameSegment(name, `export${metadata.fileExtension}`)
    const splitIdx = sanitized.lastIndexOf('.')
    const base = splitIdx > 0 ? sanitized.slice(0, splitIdx) : sanitized
    const chosenName = `${base}${metadata.fileExtension}`
    const key = `projects/${projectId}/exports/${crypto.randomUUID()}-${chosenName}`

    const putRes = await c.env.daw_audio_samples.put(key, file.stream(), {
      httpMetadata: {
        contentType: metadata.mimeType,
        contentDisposition: `inline; filename="${chosenName}"`,
      },
      customMetadata: {
        projectId,
        format,
        durationSec: durationStr || '',
        sampleRate: sampleRateStr || '',
        uploadedAt: new Date().toISOString(),
        uploadedBy: access.user.id,
      },
    })

    const url = `/api/export/${encodeURIComponent(projectId)}?key=${encodeURIComponent(key)}`
    return c.json({ key, url, sizeBytes: putRes.size })
  } catch (err) {
    console.error('Export upload error', err)
    return c.json({ error: 'Failed to upload export' }, 500)
  }
})

  app.delete('/api/exports/:exportId', async (c) => {
  try {
    const access = await requireAuthenticatedConvexForApi(c)
    if (!access) return c.json({ error: 'Unauthorized' }, 401)
    const exportId = c.req.param('exportId')
    if (!exportId) return c.json({ error: 'Missing exportId' }, 400)
    const result = await access.convex.mutation(convexApi.exports.remove, {
      exportId,
    })
    if (result) {
      await drainR2DeleteQueue({
        c,
        user: access.user,
        bucket: c.env.daw_audio_samples,
        projectId: result.projectId,
      }).catch((cleanupError) => {
        console.warn('Failed to drain export R2 cleanup queue', cleanupError)
      })
    }
    return c.json({ ok: true })
  } catch (err) {
    console.error('Export delete error', err)
    return c.json({ error: 'Failed to delete export' }, 500)
  }
})

// Stream an export from R2 by project-scoped key
  app.get('/api/export/:projectId', async (c) => {
  try {
    const key = c.req.query('key')
    const projectId = c.req.param('projectId')
    return await streamProjectR2Object(c, {
      projectId,
      key,
      keyPrefix: `projects/${projectId}/exports/`,
      roles: ['owner', 'editor', 'viewer'],
      cacheControl: 'private, no-store',
      bucket: c.env.daw_audio_samples,
    })
  } catch (err) {
    console.error('Export fetch error', err)
    return c.json({ error: 'Failed to fetch export' }, 500)
  }
})
}
