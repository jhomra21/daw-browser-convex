import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono<{ Bindings: Env }>()

// Add CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Accept'],
}));

app.get('/api/test', (c) => c.text('Hono!'))

// Upload a sample to R2
app.post('/api/samples', async (c) => {
  try {
    const form = await c.req.formData()
    const roomId = form.get('roomId')?.toString()
    const clipId = form.get('clipId')?.toString()
    const file = form.get('file')
    const durationStr = form.get('duration')?.toString()

    if (!roomId || !clipId || !(file instanceof File)) {
      return c.json({ error: 'Missing roomId, clipId or file' }, 400)
    }

    // Sanitize filename for use as a key segment
    const baseName = file.name?.toString() || 'audio'
    const sanitized = baseName
      .replace(/\\/g, '/')              // normalize separators
      .split('/')
      .pop()!
      .replace(/[^A-Za-z0-9._-]/g, '_')  // safe chars
      .slice(0, 180)                      // keep key short-ish
    // Primary layout: rooms/<roomId>/clips/<filename>
    // Handle collisions by appending " (n)" or timestamp.
    const clipsPrefix = `rooms/${roomId}/clips/`
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
      // If existing belongs to this clip, reuse the same name, otherwise try next suffix
      const existingClip = existing.customMetadata?.clipId
      if (existingClip === clipId) {
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
        roomId,
        clipId,
        filename: chosenName,
        originalFilename: file.name,
        mimeType: file.type || 'application/octet-stream',
        durationSec: durationStr || '',
        uploadedAt: new Date().toISOString(),
      },
    })

    // Return a URL that includes the exact key so the GET route can fetch without indirection
    const url = `/api/samples/${roomId}/${clipId}?key=${encodeURIComponent(key)}`
    return c.json({ key, url })
  } catch (err) {
    console.error('Upload error', err)
    return c.json({ error: 'Failed to upload sample' }, 500)
  }
})

// Stream a sample from R2
app.get('/api/samples/:roomId/:clipId', async (c) => {
  try {
    // Require exact key so we don't list buckets or rely on pointers
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)

    const obj = await c.env.daw_audio_samples.get(key)
    if (!obj) return c.json({ error: 'Not found' }, 404)

    const headers = new Headers()
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Access-Control-Allow-Origin', '*')
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

export default app