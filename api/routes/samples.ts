import { api as convexApi } from '../../convex/_generated/api'
import type { App } from '../app-types'
import { hashFile } from '../hash-file'
import { requireProjectRoleContextForApi } from '../project-access'
import { streamProjectR2Object } from '../project-r2-stream'
import { drainR2DeleteQueue } from '../r2-delete-queue'
import { createR2ObjectResponse } from '../r2-object-response'
import { sanitizeFileNameSegment } from '../sanitize-file-name-segment'

export function registerSampleRoutes(app: App) {
// Upload a sample to R2 (protected route)
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
    // Primary layout: rooms/<projectId>/clips/<filename>
    // Handle collisions by appending " (n)" or timestamp.
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

    // Return a URL that includes the exact key so the GET route can fetch without indirection
    const url = `/api/samples/${projectId}/${encodeURIComponent(assetKey)}?key=${encodeURIComponent(key)}`
    return c.json({ key, url })
  } catch (err) {
    console.error('Upload error', err)
    return c.json({ error: 'Failed to upload sample' }, 500)
  }
})

// Stream a sample from R2
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

  app.get('/api/default-samples', async (c) => {
  try {
    const bucket = c.env.daw_audio_samples
    if (!bucket) {
      return c.json({ samples: [] })
    }
    const prefix = 'default/'
    let cursor: string | undefined
    const samples: Array<Record<string, unknown>> = []

    do {
      const page = await bucket.list({
        prefix,
        cursor,
        limit: 1000,
      })
      for (const obj of page.objects) {
        if (!obj || typeof obj.key !== 'string' || !obj.key.startsWith(prefix)) continue
        if (obj.key === prefix || obj.key.endsWith('/')) continue
        const key: string = obj.key
        const metadata = obj.customMetadata
        const duration = Number(metadata?.durationSec)
        const sampleRate = Number(metadata?.sampleRate)
        const channelCount = Number(metadata?.channelCount)
        const hasMetadata = Number.isFinite(duration) && duration > 0
          && Number.isFinite(sampleRate) && sampleRate > 0
          && Number.isFinite(channelCount) && channelCount > 0
        const rawName = key.slice(prefix.length)
        let decodedName = rawName || key
        try {
          decodedName = decodeURIComponent(decodedName)
        } catch {}
        const url = `/api/default-sample?key=${encodeURIComponent(key)}`
        samples.push({
          key,
          assetKey: `asset:default:${key}`,
          sourceKind: 'url',
          name: decodedName,
          url,
          duration: hasMetadata ? duration : undefined,
          source: hasMetadata
            ? {
                durationSec: duration,
                sampleRate,
                channelCount,
              }
            : undefined,
          sizeBytes: typeof obj.size === 'number' ? obj.size : undefined,
        })
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)

    samples.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }))

    return c.json({ samples })
  } catch (err) {
    console.error('Default samples list error', err)
    return c.json({ error: 'Failed to list default samples' }, 500)
  }
})

  app.get('/api/default-sample', async (c) => {
  try {
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)
    if (!key.startsWith('default/')) return c.json({ error: 'Invalid key' }, 400)

    const obj = await c.env.daw_audio_samples.get(key)
    if (!obj) return c.json({ error: 'Not found' }, 404)

    return createR2ObjectResponse(obj, key, 'public, max-age=31536000, immutable')
  } catch (err) {
    console.error('Default sample fetch error', err)
    return c.json({ error: 'Failed to fetch default sample' }, 500)
  }
})
}
