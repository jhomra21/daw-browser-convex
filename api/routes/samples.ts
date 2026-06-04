import { api as convexApi } from '../../convex/_generated/api'
import type { App } from '../app-types'
import { hashFile } from '../hash-file'
import { requireProjectRoleContextForApi } from '../project-access'
import { streamProjectR2Object } from '../project-r2-stream'
import { drainR2DeleteQueue } from '../r2-delete-queue'
import { createR2ObjectResponse } from '../r2-object-response'
import { sanitizeFileNameSegment } from '../sanitize-file-name-segment'
import { fetchFallbackDefaultSample, listDefaultSamples } from '../default-samples'

export function registerPublicSampleRoutes(app: App) {
  app.get('/api/default-samples', async (c) => c.json(await listDefaultSamples(c.env, c.req.url)))

  app.get('/api/default-sample', async (c) => {
    try {
      const key = c.req.query('key')
      if (!key) return c.json({ error: 'Missing key query parameter' }, 400)
      if (!key.startsWith('default/')) return c.json({ error: 'Invalid key' }, 400)

      const obj = await c.env.daw_audio_samples.get(key)
      if (!obj) {
        const fallbackResponse = await fetchFallbackDefaultSample(c.env, c.req.url, key)
        if (fallbackResponse) return fallbackResponse
        return c.json({ error: 'Not found' }, 404)
      }

      return createR2ObjectResponse(obj, key, 'public, max-age=31536000, immutable')
    } catch (err) {
      console.error('Default sample fetch error', err)
      return c.json({ error: 'Failed to fetch default sample' }, 500)
    }
  })
}

export function registerSampleRoutes(app: App) {
  app.post('/api/samples', async (c) => {
    try {
      const form = await c.req.formData()
      const projectId = form.get('projectId')?.toString()
      const assetKey = form.get('assetKey')?.toString()
      const file = form.get('file')
      const durationStr = form.get('duration')?.toString()

      if (!projectId || !assetKey || !(file instanceof File)) {
        return c.json({ error: 'Missing projectId, assetKey or file' }, 400)
      }
      const access = await requireProjectRoleContextForApi(c, projectId, ['owner', 'editor'])
      if (!access) {
        return c.json({ error: 'Forbidden' }, 403)
      }

      const sanitized = sanitizeFileNameSegment(file.name, 'audio')
      const contentHash = await hashFile(file)
      const clipsPrefix = `projects/${projectId}/assets/${assetKey}/${contentHash}/`
      const chosenName = sanitized
      const key = clipsPrefix + chosenName
      await c.env.daw_audio_samples.put(key, file.stream(), {
        httpMetadata: {
          contentType: file.type || 'application/octet-stream',
          contentDisposition: `inline; filename="${chosenName}"`,
        },
        customMetadata: {
          projectId,
          assetKey,
          filename: chosenName,
          originalFilename: file.name,
          mimeType: file.type || 'application/octet-stream',
          durationSec: durationStr || '',
          uploadedAt: new Date().toISOString(),
          uploadedBy: access.user.id,
        },
      })

      const url = `/api/samples/${projectId}/${encodeURIComponent(assetKey)}?key=${encodeURIComponent(key)}`
      return c.json({ key, url })
    } catch (err) {
      console.error('Upload error', err)
      return c.json({ error: 'Failed to upload sample' }, 500)
    }
  })

  app.get('/api/samples/:projectId/:sourceId', async (c) => {
    try {
      const key = c.req.query('key')
      const projectId = c.req.param('projectId')
      const sourceId = c.req.param('sourceId')
      return await streamProjectR2Object(c, {
        projectId,
        key,
        keyPrefix: `projects/${projectId}/assets/${sourceId}/`,
        roles: ['owner', 'editor', 'viewer'],
        cacheControl: 'private, no-store',
        bucket: c.env.daw_audio_samples,
      })
    } catch (err) {
      console.error('Fetch error', err)
      return c.json({ error: 'Failed to fetch sample' }, 500)
    }
  })

  app.delete('/api/samples/:projectId/:assetKey', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const assetKey = c.req.param('assetKey')
      if (!projectId || !assetKey) return c.json({ error: 'Missing projectId or assetKey' }, 400)
      const access = await requireProjectRoleContextForApi(c, projectId, ['owner', 'editor'])
      if (!access) {
        return c.json({ error: 'Forbidden' }, 403)
      }
      await access.convex.mutation(convexApi.samples.removeFromRoom, {
        projectId,
        assetKey,
      })
      await drainR2DeleteQueue({
        c,
        user: access.user,
        bucket: c.env.daw_audio_samples,
        projectId,
      }).catch((cleanupError) => {
        console.warn('Failed to drain sample R2 cleanup queue', cleanupError)
      })
      return c.json({ ok: true })
    } catch (err) {
      console.error('Sample delete error', err)
      return c.json({ error: 'Failed to delete sample' }, 500)
    }
  })
}
