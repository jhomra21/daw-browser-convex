import type { App } from '../app-types'
import { requireProjectRoleForApi } from '../project-access'

const hashFile = async (file: File) => {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}


export function registerSampleRoutes(app: App) {
// Upload a sample to R2 (protected route)
  app.post('/api/samples', async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const form = await c.req.formData()
    const projectId = form.get('projectId')?.toString()
    const assetKey = form.get('assetKey')?.toString()
    const file = form.get('file')
    const durationStr = form.get('duration')?.toString()

    if (!projectId || !assetKey || !(file instanceof File)) {
      return c.json({ error: 'Missing projectId, assetKey or file' }, 400)
    }
    if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor'])) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Sanitize filename for use as a key segment
    const baseName = file.name?.toString() || 'audio'
    const sanitized = baseName
      .replace(/\\/g, '/')              // normalize separators
      .split('/')
      .pop()!
      .replace(/[^A-Za-z0-9._-]/g, '_')  // safe chars
      .slice(0, 180)                      // keep key short-ish
    // Primary layout: rooms/<projectId>/clips/<filename>
    // Handle collisions by appending " (n)" or timestamp.
    const contentHash = await hashFile(file)
    const clipsPrefix = `projects/${projectId}/assets/${assetKey}/${contentHash}/`
    const splitIdx = sanitized.lastIndexOf('.')
    const base = splitIdx > 0 ? sanitized.slice(0, splitIdx) : sanitized
    const ext = splitIdx > 0 ? sanitized.slice(splitIdx) : ''
    let chosenName = sanitized
    let attempts = 0
    while (attempts < 5) {
      const probeKey = clipsPrefix + chosenName
      const existing = await c.env.daw_audio_samples.get(probeKey)
      if (!existing) {
        break
      }
      const existingAssetKey = existing.customMetadata?.assetKey
      if (existingAssetKey === assetKey) {
        break
      }
      attempts++
      chosenName = `${base} (${attempts})${ext}`
    }
    if (attempts >= 5) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      chosenName = `${base}_${ts}${ext}`
    }
    const key = clipsPrefix + chosenName
    await c.env.daw_audio_samples.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
        contentDisposition: `inline; filename="${file.name}"`,
      },
      customMetadata: {
        projectId,
        assetKey,
        filename: chosenName,
        originalFilename: file.name,
        mimeType: file.type || 'application/octet-stream',
        durationSec: durationStr || '',
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
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
    // Require exact key so we don't list buckets or rely on pointers
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)
    const projectId = c.req.param('projectId')
    if (!key.startsWith(`projects/${projectId}/assets/`)) return c.json({ error: 'Invalid key' }, 400)
    if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor', 'viewer'])) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const obj = await c.env.daw_audio_samples.get(key)
    if (!obj) return c.json({ error: 'Not found' }, 404)

    const headers = new Headers()
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Credentials', 'true')
    if (obj.httpMetadata?.contentDisposition) {
      headers.set('Content-Disposition', obj.httpMetadata.contentDisposition)
    }
    headers.set('X-R2-Key', key)

    return new Response(obj.body, { headers })
  } catch (err) {
    console.error('Fetch error', err)
    return c.json({ error: 'Failed to fetch sample' }, 500)
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
    const objects: R2Object[] = []

    do {
      const page = await bucket.list({
        prefix,
        cursor,
        limit: 1000,
      })
      objects.push(...page.objects)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)

    const samples: Array<Record<string, unknown>> = []
    for (const obj of objects) {
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

    const headers = new Headers()
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Credentials', 'true')
    if (obj.httpMetadata?.contentDisposition) {
      headers.set('Content-Disposition', obj.httpMetadata.contentDisposition)
    }
    headers.set('X-R2-Key', key)

    return new Response(obj.body, { headers })
  } catch (err) {
    console.error('Default sample fetch error', err)
    return c.json({ error: 'Failed to fetch default sample' }, 500)
  }
})
}
