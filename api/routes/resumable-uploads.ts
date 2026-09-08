import { z } from 'zod'
import {
  controlErrorSchemaV1,
  resumableUploadLimitsV1,
  resumableUploadMaximumBytes,
} from '@daw-browser/control'
import { api as convexApi } from '../../convex/_generated/api'
import type { ApiContext, App } from '../app-types'
import { createMaintenanceWorkerConvexClient, type ApiConvexClient } from '../convex-auth'
import { requireProjectRoleContextForApi } from '../project-access'
import {
  AudioUploadValidationError,
  inspectControlUploadR2Metadata,
} from '../control-upload-audio-metadata'
import {
  finalizeSerializableSha256State,
  parseSerializableSha256State,
  updateSerializableSha256State,
} from '../resumable-sha256'

const maximumPartBytes = resumableUploadLimitsV1.partSizeBytes
const maximumPartCount = resumableUploadLimitsV1.maxPartCount
const maximumProtocolUploadBytes = resumableUploadMaximumBytes
const verificationChunkBytes = resumableUploadLimitsV1.partSizeBytes
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._~-]{8,128}$/)
const uploadMetadataSchema = z.object({
  projectId: z.string().min(1),
  idempotencyKey: idempotencyKeySchema,
  contentSha256: digestSchema,
  name: z.string().min(1).max(120),
  mimeType: z.string().min(1).max(128),
  sizeBytes: z.number().int().safe().positive().max(maximumProtocolUploadBytes),
  folderId: z.string().min(1).optional(),
})

const errorMessage = 'Resumable upload failed.'
type UploadErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500
type UploadError = Error | z.infer<typeof errorEnvelopeSchema>
const errorEnvelopeSchema = z.object({
  data: z.json().optional(),
  errorData: z.json().optional(),
}).passthrough()

const uploadErrorResponse = (
  error: UploadError,
  fallbackStatus: UploadErrorStatus = 500,
) => {
  const envelope = errorEnvelopeSchema.safeParse(error)
  const candidates = [
    error,
    envelope.success ? envelope.data.data : undefined,
    envelope.success ? envelope.data.errorData : undefined,
  ]
  for (const candidate of candidates) {
    const parsed = controlErrorSchemaV1.safeParse(candidate)
    if (!parsed.success) continue
    const status: UploadErrorStatus = parsed.data.code === 'authorization' ? 401
      : parsed.data.code === 'forbidden' ? 403
        : parsed.data.code === 'not-found' ? 404
          : parsed.data.code === 'idempotency-conflict' ? 409
            : parsed.data.code === 'invalid-request' ? 400
              : parsed.data.code === 'validation' || parsed.data.code === 'limit-exceeded' ? 422
                : fallbackStatus
    return { status, body: { error: parsed.data.message } }
  }
  return { status: fallbackStatus, body: { error: errorMessage } }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
const parseUploadError = (error: unknown): UploadError => {
  const envelope = errorEnvelopeSchema.safeParse(error)
  if (envelope.success) return envelope.data
  return error instanceof Error ? error : new Error(errorMessage)
}

type ResumableRouteDependencies = {
  requireProjectRoleContext?: typeof requireProjectRoleContextForApi
  createWorkerConvexClient?: (context: ApiContext) => Promise<ApiConvexClient>
  inspectR2Metadata?: (input: {
    bucket: ResumableBucket
    key: string
    size: number
    declaredMimeType: string
  }) => Promise<{
    durationSec: number
    sampleRate: number
    channelCount: number
  }>
  bucket?: (context: ApiContext) => ResumableBucket
}
type ResumableMultipart = {
  uploadId: string
  uploadPart: (partNumber: number, value: Uint8Array) => Promise<{ etag: string }>
  complete: (parts: Array<{ partNumber: number; etag: string }>) => Promise<void>
  abort: () => Promise<void>
}
type ResumableBucket = {
  createMultipartUpload: (key: string, options: {
    httpMetadata: { contentType: string }
    customMetadata: Record<string, string>
  }) => Promise<ResumableMultipart>
  resumeMultipartUpload: (key: string, uploadId: string) => ResumableMultipart
  get: (key: string, options?: { range?: { offset: number; length: number } }) =>
    Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>
  head: (key: string) => Promise<{ size: number } | null>
  delete: (key: string) => Promise<void>
}

export const registerResumableUploadRoutes = (
  app: App,
  dependencies: ResumableRouteDependencies = {},
) => {
  const requireProjectRoleContext = dependencies.requireProjectRoleContext ?? requireProjectRoleContextForApi
  const createWorkerConvexClient = dependencies.createWorkerConvexClient ?? createMaintenanceWorkerConvexClient
  const getBucket = (context: ApiContext): ResumableBucket => {
    const injected = dependencies.bucket?.(context)
    if (injected) return injected
    return {
      createMultipartUpload: async (key, options) => {
        const upload = await context.env.daw_audio_samples.createMultipartUpload(key, options)
        return {
          uploadId: upload.uploadId,
          uploadPart: upload.uploadPart.bind(upload),
          complete: async (parts) => { await upload.complete(parts) },
          abort: upload.abort.bind(upload),
        }
      },
      resumeMultipartUpload: (key, uploadId) => {
        const upload = context.env.daw_audio_samples.resumeMultipartUpload(key, uploadId)
        return {
          uploadId: upload.uploadId,
          uploadPart: upload.uploadPart.bind(upload),
          complete: async (parts) => { await upload.complete(parts) },
          abort: upload.abort.bind(upload),
        }
      },
      get: async (key, options) => context.env.daw_audio_samples.get(key, options),
      head: async (key) => context.env.daw_audio_samples.head(key),
      delete: async (key) => { await context.env.daw_audio_samples.delete(key) },
    }
  }
  app.post('/api/resumable-uploads', async (c) => {
    const body = uploadMetadataSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Invalid resumable upload metadata.' }, 400)
    const input = body.data
    const access = await requireProjectRoleContext(c, input.projectId, ['owner', 'editor'])
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    let multipart: ResumableMultipart | undefined
    try {
      const bucket = getBucket(c)
      const begun = await access.convex.mutation(convexApi.resumableAssetUploads.beginUpload, {
        ...input, transport: 'resumable',
      })
      if (begun.status === 'completed') {
        return c.json({
          assetKey: begun.assetKey,
          sessionId: begun.sessionId,
          completed: true,
          url: `/api/samples/${encodeURIComponent(input.projectId)}/${encodeURIComponent(begun.assetKey)}`,
        }, 200)
      }
      if (begun.multipartUploadId && begun.sessionId) {
        return c.json({ assetKey: begun.assetKey, sessionId: begun.sessionId, completed: false }, 200)
      }
      if (!begun.sessionId) throw new Error('Resumable upload session is missing.')
      multipart = await bucket.createMultipartUpload(begun.r2Key, {
        httpMetadata: { contentType: input.mimeType },
        customMetadata: { contentSha256: input.contentSha256 },
      })
      await access.convex.mutation(convexApi.resumableAssetUploads.attachMultipartUpload, {
        projectId: input.projectId, idempotencyKey: input.idempotencyKey,
        contentSha256: input.contentSha256, multipartUploadId: multipart.uploadId,
      })
      return c.json({
        assetKey: begun.assetKey, sessionId: begun.sessionId, completed: false,
      }, 201)
    } catch (error) {
      await multipart?.abort().catch(() => undefined)
      const failure = uploadErrorResponse(parseUploadError(error))
      return c.json(failure.body, failure.status)
    }
  })

  app.get('/api/resumable-uploads/:projectId/:assetKey/:sessionId', async (c) => {
    const projectId = c.req.param('projectId')
    const sessionId = c.req.param('sessionId')
    const access = await requireProjectRoleContext(c, projectId, ['owner', 'editor'])
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    try {
      const upload = await access.convex.query(convexApi.resumableAssetUploads.getResumableUpload, {
        projectId, sessionId,
      })
      return c.json({
        assetKey: upload.assetKey, sessionId: upload.sessionId, status: upload.status,
        sizeBytes: upload.sizeBytes, partSizeBytes: upload.partSizeBytes, partCount: upload.partCount,
        acceptedBytes: upload.acceptedBytes, parts: upload.parts, expiresAt: upload.expiresAt,
        verificationOffsetBytes: upload.verificationOffsetBytes,
        url: upload.status === 'completed'
          ? `/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(upload.assetKey)}`
          : undefined,
      })
    } catch (error) {
      const failure = uploadErrorResponse(parseUploadError(error), 404)
      return c.json(failure.body, failure.status)
    }
  })

  app.put('/api/resumable-uploads/:projectId/:assetKey/:sessionId/:partNumber', async (c) => {
    const projectId = c.req.param('projectId')
    const assetKey = c.req.param('assetKey')
    const sessionId = c.req.param('sessionId')
    const partNumber = Number(c.req.param('partNumber'))
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maximumPartCount) {
      return c.json({ error: 'Invalid multipart part number.' }, 400)
    }
    const access = await requireProjectRoleContext(c, projectId, ['owner', 'editor'])
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    const contentLength = Number(c.req.header('content-length'))
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maximumPartBytes) {
      return c.json({ error: 'Invalid multipart part size.' }, 400)
    }
    if (!c.req.raw.body) return c.json({ error: 'Multipart part body is required.' }, 400)
    try {
      const upload = await access.convex.query(convexApi.resumableAssetUploads.getResumableUpload, {
        projectId, sessionId,
      })
      const expectedSize = partNumber === upload.partCount
        ? upload.sizeBytes - upload.partSizeBytes * (upload.partCount - 1)
        : upload.partSizeBytes
      if (contentLength !== expectedSize) return c.json({ error: 'Invalid multipart part size.' }, 400)
      const body = new Uint8Array(await c.req.raw.arrayBuffer())
      if (body.byteLength !== expectedSize) return c.json({ error: 'Multipart body size mismatch.' }, 400)
      const claim = await access.convex.mutation(convexApi.resumableAssetUploads.claimUploadPart, {
        projectId, assetKey, sessionId, partNumber, sizeBytes: contentLength,
      })
      if (claim.status === 'accepted') return c.json({ partNumber, etag: claim.etag }, 200)
      const bucket = getBucket(c)
      const multipart = bucket.resumeMultipartUpload(upload.r2Key, upload.multipartUploadId)
      try {
        const uploaded = await multipart.uploadPart(partNumber, body)
        await access.convex.mutation(convexApi.resumableAssetUploads.acceptUploadPart, {
          projectId, assetKey, sessionId, partNumber,
          leaseToken: claim.leaseToken, etag: uploaded.etag,
        })
        return c.json({ partNumber, etag: uploaded.etag }, 200)
      } catch (error) {
        await access.convex.mutation(convexApi.resumableAssetUploads.releaseUploadPart, {
          projectId, assetKey, sessionId, partNumber, leaseToken: claim.leaseToken,
        }).catch(() => undefined)
        const failure = uploadErrorResponse(parseUploadError(error))
        return c.json(failure.body, failure.status)
      }
    } catch (error) {
      const failure = uploadErrorResponse(parseUploadError(error))
      return c.json(failure.body, failure.status)
    }
  })

  app.post('/api/resumable-uploads/:projectId/:assetKey/:sessionId/complete', async (c) => {
    const projectId = c.req.param('projectId')
    const assetKey = c.req.param('assetKey')
    const sessionId = c.req.param('sessionId')
    const access = await requireProjectRoleContext(c, projectId, ['owner', 'editor'])
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    let multipart: ResumableMultipart | undefined
    let completed = false
    let verificationStarted = false
    let completionToken: string | undefined
    let failedUploadSession: { sessionId: string; r2Key: string; contentSha256: string } | undefined
    try {
      const upload = await access.convex.query(convexApi.resumableAssetUploads.getResumableUpload, {
        projectId, sessionId,
      })
      failedUploadSession = {
        sessionId: upload.sessionId, r2Key: upload.r2Key, contentSha256: upload.contentSha256,
      }
      if (upload.status === 'completed') {
        return c.json({
          assetKey: upload.assetKey,
          url: `/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(assetKey)}`,
        }, 200)
      }
      const bucket = getBucket(c)
      const workerConvex = await createWorkerConvexClient(c)
      if (upload.status === 'uploading' || upload.status === 'completing') {
        const completion = await access.convex.mutation(convexApi.resumableAssetUploads.claimResumableCompletion, {
          projectId, assetKey, sessionId, completionToken: upload.completionToken,
        })
        completionToken = completion.completionToken
        if (!completionToken) throw new Error('Resumable completion token is missing.')
        const object = await bucket.head(upload.r2Key)
        completed = object !== null
        if (!object) {
          multipart = bucket.resumeMultipartUpload(upload.r2Key, upload.multipartUploadId)
          await multipart.complete(completion.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })))
          completed = true
        }
        await workerConvex.mutation(convexApi.resumableAssetUploads.beginResumableVerification, {
          projectId, assetKey, sessionId, completionToken,
        })
        verificationStarted = true
      }
      const current = await access.convex.query(convexApi.resumableAssetUploads.getResumableUpload, {
        projectId, sessionId,
      })
      completionToken = current.completionToken ?? completionToken
      verificationStarted = current.status === 'verifying' || current.status === 'finalizing' || verificationStarted
      if (current.status === 'verifying') {
        const claim = await workerConvex.mutation(convexApi.resumableAssetUploads.claimResumableVerification, {
          projectId, assetKey, sessionId, leaseToken: current.leaseToken,
        })
        if (claim.status === 'busy') {
          return c.json({
            assetKey, status: 'verifying',
            verificationOffsetBytes: current.verificationOffsetBytes ?? 0,
          }, 202, { 'Retry-After': '1' })
        }
        if (claim.status === 'verifying' && claim.claimed) {
          const offsetBytes = claim.session.verificationOffsetBytes ?? 0
          const remainingBytes = current.sizeBytes - offsetBytes
          const rangeLength = Math.min(verificationChunkBytes, remainingBytes)
          const object = await bucket.get(current.r2Key, {
            range: { offset: offsetBytes, length: rangeLength },
          })
          if (!object) throw new Error('Uploaded audio object is temporarily unavailable.')
          const reader = object.body.getReader()
          const chunks: Uint8Array[] = []
          let byteLength = 0
          try {
            while (true) {
              const result = await reader.read()
              if (result.done) break
              chunks.push(result.value)
              byteLength += result.value.byteLength
            }
          } finally {
            reader.releaseLock()
          }
          if (byteLength !== rangeLength) throw new Error('Uploaded audio range is incomplete.')
          const bytes = new Uint8Array(byteLength)
          let position = 0
          for (const chunk of chunks) {
            bytes.set(chunk, position)
            position += chunk.byteLength
          }
          const state = updateSerializableSha256State(
            parseSerializableSha256State(claim.session.verificationState),
            bytes,
          )
          const digest = offsetBytes + byteLength === current.sizeBytes
            ? finalizeSerializableSha256State(state)
            : current.contentSha256
          const advanced = await workerConvex.mutation(convexApi.resumableAssetUploads.advanceResumableVerification, {
            projectId, assetKey, sessionId, leaseToken: claim.session.leaseToken ?? '',
            offsetBytes: offsetBytes + byteLength, state, digest,
          })
          if (advanced.status === 'stale') {
            return c.json({
              assetKey, status: 'verifying',
              verificationOffsetBytes: advanced.offsetBytes,
            }, 202)
          }
          if (advanced.status === 'failed') {
            throw new AudioUploadValidationError('Uploaded audio bytes failed digest validation.')
          }
          return c.json({
            assetKey, status: 'verifying',
            verificationOffsetBytes: offsetBytes + byteLength,
          }, 202, { 'Retry-After': '0' })
        }
      }
      const metadata = dependencies.inspectR2Metadata
        ? await dependencies.inspectR2Metadata({
          bucket, key: current.r2Key, size: current.sizeBytes, declaredMimeType: current.mimeType,
        })
        : await inspectControlUploadR2Metadata({
          bucket: c.env.daw_audio_samples, key: current.r2Key,
          size: current.sizeBytes, declaredMimeType: current.mimeType,
        })
      const result = await workerConvex.mutation(convexApi.resumableAssetUploads.finalizeUpload, {
        projectId, assetKey, multipartUploadId: current.multipartUploadId, sessionId,
        completionToken: current.completionToken ?? completionToken ?? '',
        contentSha256: current.contentSha256,
        durationSec: metadata.durationSec, sampleRate: metadata.sampleRate, channelCount: metadata.channelCount,
      })
      return c.json({
        assetKey: result.asset.id,
        url: `/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(result.asset.id)}`,
      }, 201)
    } catch (error) {
      if (error instanceof AudioUploadValidationError && verificationStarted) {
        await createWorkerConvexClient(c).then((workerConvex) => workerConvex.mutation(convexApi.resumableAssetUploads.failResumableVerification, {
          projectId, assetKey, sessionId,
        })).catch(() => undefined)
        return c.json({ assetKey, sessionId, status: 'failed' }, 422)
      } else if (error instanceof AudioUploadValidationError && completionToken && failedUploadSession) {
        const failed = z.object({ failed: z.boolean() }).safeParse(await access.convex.mutation(convexApi.resumableAssetUploads.failResumableUpload, {
          projectId, assetKey, sessionId: failedUploadSession?.sessionId ?? '',
          completionToken, contentSha256: failedUploadSession?.contentSha256 ?? '',
        }).catch(() => undefined))
        if (failed.success && failed.data.failed) {
          await getBucket(c).delete(failedUploadSession.r2Key).catch(() => undefined)
        }
      }
      if (error instanceof AudioUploadValidationError) {
        if (!completed) await multipart?.abort().catch(() => undefined)
        return c.json({ error: error.message }, 422)
      }
      const failure = uploadErrorResponse(parseUploadError(error))
      return c.json(failure.body, failure.status)
    }
  })

  app.delete('/api/resumable-uploads/:projectId/:assetKey/:sessionId', async (c) => {
    const projectId = c.req.param('projectId')
    const assetKey = c.req.param('assetKey')
    const sessionId = c.req.param('sessionId')
    const access = await requireProjectRoleContext(c, projectId, ['owner', 'editor'])
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    try {
      const upload = await access.convex.query(convexApi.resumableAssetUploads.getResumableUpload, {
        projectId, sessionId,
      })
      await getBucket(c).resumeMultipartUpload(upload.r2Key, upload.multipartUploadId).abort()
      await access.convex.mutation(convexApi.resumableAssetUploads.abortResumableUpload, { projectId, assetKey, sessionId })
      return c.json({ aborted: true }, 200)
    } catch (error) {
      const failure = uploadErrorResponse(parseUploadError(error))
      return c.json(failure.body, failure.status)
    }
  })
}
