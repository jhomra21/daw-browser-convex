import { api as convexApi } from '../../convex/_generated/api'
import type { App } from '../app-types'
import { createR2ObjectResponse } from '../r2-object-response'
import { fetchFallbackDefaultSample, listDefaultSamples } from '../default-samples'
import { hashFile } from '../hash-file'
import { requireProjectRoleContextForApi } from '../project-access'
import { controlErrorSchemaV1 } from '@daw-browser/control'
import { z } from 'zod'

const maxUploadBytes = 10 * 1024 * 1024
const trustedDesktopSampleOrigins = new Set([
  'daw://app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

type SampleRouteDependencies = {
  requireProjectRoleContext?: typeof requireProjectRoleContextForApi
  putObject?: (key: string, file: File, contentSha256: string) => Promise<void>
}

type PublicSampleRouteDependencies = {
  listDefaultSamples?: typeof listDefaultSamples
}

const browserIdempotencyKey = async (assetKey: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(assetKey))
  const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `browser-${suffix}`
}

const uploadErrorEnvelopeSchema = z.object({
  data: z.json().optional(),
  errorData: z.json().optional(),
}).passthrough()

const sampleUploadErrorStatus = (error: Error | z.infer<typeof uploadErrorEnvelopeSchema>) => {
  const envelope = uploadErrorEnvelopeSchema.safeParse(error)
  const candidates = [error, envelope.success ? envelope.data.data : undefined, envelope.success ? envelope.data.errorData : undefined]
  for (const candidate of candidates) {
    const parsed = controlErrorSchemaV1.safeParse(candidate)
    if (parsed.success && parsed.data.code === 'idempotency-conflict') return 409
  }
  return 500
}

const getTrustedDesktopSampleOrigin = (origin: string | undefined) => (
  origin && trustedDesktopSampleOrigins.has(origin) ? origin : undefined
)

const withPublicSampleCors = (response: Response, origin: string | undefined) => {
  const allowedOrigin = getTrustedDesktopSampleOrigin(origin)
  const headers = new Headers(response.headers)
  headers.delete('Access-Control-Allow-Origin')
  headers.delete('Access-Control-Allow-Credentials')
  if (!allowedOrigin) return new Response(response.body, { status: response.status, headers })
  headers.set('Access-Control-Allow-Origin', allowedOrigin)
  headers.set('Vary', 'Origin')
  return new Response(response.body, { status: response.status, headers })
}

export function registerPublicSampleRoutes(app: App, dependencies: PublicSampleRouteDependencies = {}) {
  const list = dependencies.listDefaultSamples ?? listDefaultSamples
  app.options('/api/default-samples', (c) => {
    const origin = getTrustedDesktopSampleOrigin(c.req.header('Origin'))
    if (!origin) return c.body(null, 403)
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    })
  })

  app.options('/api/default-sample', (c) => {
    const origin = getTrustedDesktopSampleOrigin(c.req.header('Origin'))
    if (!origin) return c.body(null, 403)
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    })
  })

  app.get('/api/default-samples', async (c) => (
    withPublicSampleCors(c.json(await list(c.env, c.req.url)), c.req.header('Origin'))
  ))

  app.get('/api/default-sample', async (c) => {
    const origin = getTrustedDesktopSampleOrigin(c.req.header('Origin'))
    try {
      const key = c.req.query('key')
      if (!key) return withPublicSampleCors(c.json({ error: 'Missing key query parameter' }, 400), origin)
      if (!key.startsWith('default/')) return withPublicSampleCors(c.json({ error: 'Invalid key' }, 400), origin)

      const obj = await c.env.daw_audio_samples.get(key)
      if (!obj) {
        const fallbackResponse = await fetchFallbackDefaultSample(c.env, c.req.url, key)
        if (fallbackResponse) return withPublicSampleCors(fallbackResponse, origin)
        return withPublicSampleCors(c.json({ error: 'Not found' }, 404), origin)
      }

      return createR2ObjectResponse(obj, 'public, max-age=31536000, immutable', origin)
    } catch (err) {
      console.error('Default sample fetch error', err)
      return withPublicSampleCors(c.json({ error: 'Failed to fetch default sample' }, 500), origin)
    }
  })
}

export function registerSampleRoutes(app: App, dependencies: SampleRouteDependencies = {}) {
  const requireProjectRoleContext = dependencies.requireProjectRoleContext ?? requireProjectRoleContextForApi
  app.post('/api/samples', async (c) => {
    const contentLength = c.req.header('content-length')
    if (!contentLength) return c.json({ error: 'Content-Length is required' }, 411)
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maxUploadBytes + 16 * 1024) {
      return c.json({ error: 'Upload exceeds the 10 MiB limit' }, 413)
    }
    try {
      const form = await c.req.formData()
      const projectId = form.get('projectId')?.toString()
      const clientAssetKeyResult = z.string().min(1).safeParse(form.get('assetKey'))
      const file = form.get('file')
      if (!projectId || !clientAssetKeyResult.success || !(file instanceof File) || file.size < 1 || file.size > maxUploadBytes) {
        return c.json({ error: 'Invalid sample upload' }, 400)
      }
      const clientAssetKey = clientAssetKeyResult.data
      const access = await requireProjectRoleContext(c, projectId, ['owner', 'editor'])
      if (!access) return c.json({ error: 'Forbidden' }, 403)
      const contentSha256 = await hashFile(file)
      const idempotencyKey = await browserIdempotencyKey(clientAssetKey)
      const begun = await access.convex.mutation(convexApi.assets.beginUpload, {
        projectId, idempotencyKey, contentSha256, name: file.name, mimeType: file.type, sizeBytes: file.size,
      })
      if (begun.status !== 'completed') {
        try {
          if (dependencies.putObject) {
            await dependencies.putObject(begun.r2Key, file, contentSha256)
          } else {
            await c.env.daw_audio_samples.put(begun.r2Key, file.stream(), {
              httpMetadata: { contentType: file.type },
              customMetadata: { contentSha256 },
            })
          }
        } catch (error) {
          await access.convex.mutation(convexApi.assets.failUpload, { projectId, idempotencyKey, contentSha256 })
          throw error
        }
      }
      let result
      try {
        result = await access.convex.mutation(convexApi.assets.finalizeUpload, {
          projectId, idempotencyKey, contentSha256,
        })
      } catch (error) {
        await access.convex.mutation(convexApi.assets.failUpload, { projectId, idempotencyKey, contentSha256 })
        throw error
      }
      return c.json({
        assetKey: result.asset.id,
        url: `/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(result.asset.id)}`,
      }, 201)
    } catch (error) {
      const parsedError = z.union([z.instanceof(Error), uploadErrorEnvelopeSchema]).safeParse(error)
      const uploadError = parsedError.success ? parsedError.data : new Error('Sample upload failed')
      return c.json({ error: uploadError instanceof Error ? uploadError.message : 'Sample upload failed' }, sampleUploadErrorStatus(uploadError))
    }
  })

  app.get('/api/samples/:projectId/:assetKey', async (c) => {
    const projectId = c.req.param('projectId')
    const access = await requireProjectRoleContext(c, projectId, ['owner', 'editor', 'viewer'])
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    const locator = await access.convex.query(convexApi.assets.getContentLocator, {
      projectId, assetKey: c.req.param('assetKey'),
    })
    if (!locator) return c.json({ error: 'Not found' }, 404)
    const object = await c.env.daw_audio_samples.get(locator.r2Key, { range: c.req.raw.headers })
    if (!object) return c.json({ error: 'Not found' }, 404)
    return createR2ObjectResponse(object, 'private, no-store')
  })

  app.delete('/api/samples/:projectId/:assetKey', async (c) => {
    const projectId = c.req.param('projectId')
    const access = await requireProjectRoleContext(c, projectId, ['owner', 'editor'])
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    return c.json(await access.convex.mutation(convexApi.assets.deleteAsset, {
      projectId, assetKey: c.req.param('assetKey'),
    }))
  })
}
