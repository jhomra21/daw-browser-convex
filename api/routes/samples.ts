import { api as convexApi } from '../../convex/_generated/api'
import type { App } from '../app-types'
import { createR2ObjectResponse } from '../r2-object-response'
import { fetchFallbackDefaultSample, listDefaultSamples } from '../default-samples'
import { hashFile } from '../hash-file'
import { sha256Hex } from '../http'
import { requireProjectRoleContextForApi } from '../project-access'
import {
  AudioUploadValidationError,
  inspectControlUploadAudioMetadata,
} from '../control-upload-audio-metadata'
import { controlLimitsV1, readControlErrorV1 } from '@daw-browser/control'
import { z } from 'zod'

const trustedDesktopSampleOrigins = new Set([
  'daw://app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

type SampleRouteDependencies = {
  requireProjectRoleContext?: typeof requireProjectRoleContextForApi
  hashFile?: typeof hashFile
  putObject?: (key: string, file: File, contentSha256: string) => Promise<void>
  inspectAudioMetadata?: typeof inspectControlUploadAudioMetadata
}

type PublicSampleRouteDependencies = {
  listDefaultSamples?: typeof listDefaultSamples
}

const browserIdempotencyKey = async (assetKey: string) => `browser-${await sha256Hex(assetKey)}`

const sampleUploadErrorStatus = <Failure>(error: Failure) => {
  if (error instanceof AudioUploadValidationError) return 422

  return readControlErrorV1(error)?.code === 'idempotency-conflict' ? 409 : 500
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
  const hashUploadedFile = dependencies.hashFile ?? hashFile
  const inspectAudioMetadata = dependencies.inspectAudioMetadata ?? inspectControlUploadAudioMetadata
  app.post('/api/samples', async (c) => {
    const contentLength = c.req.header('content-length')

    if (!contentLength) return c.json({ error: 'Content-Length is required' }, 411)

    if (!/^\d+$/.test(contentLength)) return c.json({ error: 'Invalid Content-Length' }, 400)
    const contentLengthBytes = Number(contentLength)

    if (!Number.isSafeInteger(contentLengthBytes) || contentLengthBytes < 1) {
      return c.json({ error: 'Invalid Content-Length' }, 400)
    }

    if (contentLengthBytes > controlLimitsV1.maxAssetUploadRequestBytes) {
      return c.json({ error: 'Upload exceeds the 10 MiB multipart limit' }, 413)
    }

    const projectId = c.req.query('projectId')

    if (!projectId) return c.json({ error: 'Invalid sample upload' }, 400)
    const access = await requireProjectRoleContext(c, projectId, ['owner', 'editor'])

    if (!access) return c.json({ error: 'Forbidden' }, 403)

    try {
      const form = await c.req.formData()
      const formProjectId = form.get('projectId')?.toString()
      const clientAssetKeyResult = z.string().min(1).safeParse(form.get('assetKey'))
      const file = form.get('file')

      if (formProjectId !== projectId || !clientAssetKeyResult.success || !(file instanceof File) || file.size < 1) {
        return c.json({ error: 'Invalid sample upload' }, 400)
      }

      if (file.size > controlLimitsV1.maxAssetUploadBytes) {
        return c.json({ error: 'Upload exceeds the 10 MiB file limit' }, 413)
      }

      const clientAssetKey = clientAssetKeyResult.data
      const contentSha256 = await hashUploadedFile(file)

      const metadata = await inspectAudioMetadata({
        file,
        declaredMimeType: file.type,
      })

      const idempotencyKey = await browserIdempotencyKey(clientAssetKey)

      const begun = await access.convex.mutation(convexApi.resumableAssetUploads.beginUpload, {
        projectId, idempotencyKey, contentSha256, name: file.name, mimeType: file.type, sizeBytes: file.size,
        durationSec: metadata.durationSec, sampleRate: metadata.sampleRate, channelCount: metadata.channelCount,
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
          await access.convex.mutation(convexApi.resumableAssetUploads.failUpload, { projectId, idempotencyKey, contentSha256 })
          throw error
        }
      }

      let result

      try {
        result = await access.convex.mutation(convexApi.resumableAssetUploads.finalizeUpload, {
          projectId, idempotencyKey, contentSha256,
        })
      } catch (error) {
        await access.convex.mutation(convexApi.resumableAssetUploads.failUpload, { projectId, idempotencyKey, contentSha256 })
        throw error
      }

      return c.json({
        assetKey: result.asset.id,
        url: `/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(result.asset.id)}`,
      }, 201)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Sample upload failed' }, sampleUploadErrorStatus(error))
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
