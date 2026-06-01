import type { App } from '../app-types'
import { requireProjectRoleForApi } from '../project-access'
import { createR2ObjectResponse } from '../r2-object-response'
import { sanitizeFileNameSegment } from '../sanitize-file-name-segment'

export function registerExportRoutes(app: App) {
// Upload an export to R2 (protected route)
  app.post('/api/exports', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    const form = await c.req.formData()
    const projectId = form.get('projectId')?.toString()
    const format = 'wav'
    const durationStr = form.get('duration')?.toString()
    const sampleRateStr = form.get('sampleRate')?.toString()
    const file = form.get('file')
    let name = form.get('name')?.toString()

    if (!projectId || !(file instanceof File)) {
      return c.json({ error: 'Missing projectId or file' }, 400)
    }
    if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor'])) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Sanitize filename or generate one
    if (!name) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      name = `export_${ts}.wav`
    }
    const sanitized = sanitizeFileNameSegment(name, 'export.wav')

    const exportsPrefix = `projects/${projectId}/exports/`
    const splitIdx = sanitized.lastIndexOf('.')
    const base = splitIdx > 0 ? sanitized.slice(0, splitIdx) : sanitized
    const ext = splitIdx > 0 ? sanitized.slice(splitIdx) : ''
    let chosenName = sanitized
    let attempts = 0
    while (attempts < 5) {
      const probeKey = exportsPrefix + chosenName
      const existing = await c.env.daw_audio_samples.head(probeKey)
      if (!existing) break
      attempts++
      chosenName = `${base} (${attempts})${ext}`
    }
    if (attempts >= 5) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      chosenName = `${base}_${ts}${ext}`
    }
    const key = exportsPrefix + chosenName

    const putRes = await c.env.daw_audio_samples.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || 'audio/wav',
        contentDisposition: `inline; filename="${chosenName}"`,
      },
      customMetadata: {
        projectId,
        format,
        durationSec: durationStr || '',
        sampleRate: sampleRateStr || '',
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
      },
    })

    const url = `/api/export/${encodeURIComponent(projectId)}?key=${encodeURIComponent(key)}`
    return c.json({ key, url, sizeBytes: putRes.size })
  } catch (err) {
    console.error('Export upload error', err)
    return c.json({ error: 'Failed to upload export' }, 500)
  }
})

// Stream an export from R2 by project-scoped key
  app.get('/api/export/:projectId', async (c) => {
  try {
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)
    const projectId = c.req.param('projectId')
    if (!key.startsWith(`projects/${projectId}/exports/`)) return c.json({ error: 'Invalid key' }, 400)
    if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor', 'viewer'])) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const obj = await c.env.daw_audio_samples.get(key)
    if (!obj) return c.json({ error: 'Not found' }, 404)

    return createR2ObjectResponse(obj, key, 'private, no-store')
  } catch (err) {
    console.error('Export fetch error', err)
    return c.json({ error: 'Failed to fetch export' }, 500)
  }
})
}
