import { expect, test } from 'bun:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ApiBindings } from '../app-types'
import { AudioUploadValidationError } from '../control-upload-audio-metadata'
import { registerResumableUploadRoutes } from './resumable-uploads'
import { initialSerializableSha256State } from '../resumable-sha256'

// oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unsafe-dictionary-type

const projectId = 'project-1'
const actorId = 'actor-1'
const sessionId = 'session-1'
const assetKey = 'asset-1'
const uploadId = 'r2-upload-1'
const partSizeBytes = 8 * 1024 * 1024
const partBytes = new Uint8Array(partSizeBytes)
const digest = Array.from(sha256(partBytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

const request = (path: string, init?: RequestInit) => new Request(`https://control.example${path}`, init)

const createHarness = (options: {
  actor?: string
  metadataError?: Error
  wrongDigest?: boolean
  storageError?: Error
} = {}) => {
  let uploaded = false
  let accepted = false
  let completed = false
  let status: 'uploading' | 'completing' | 'verifying' | 'finalizing' | 'completed' | 'failed' = 'uploading'
  let aborted = false
  let finalized = false
  const mutation = async (_reference: object, value: Record<string, unknown>) => {
    const input = z.object({ projectId: z.string() }).passthrough().parse(value)
    if ('transport' in input) return { status: 'pending', assetKey, r2Key: 'asset/object', sessionId }
    if ('durationSec' in input) {
      finalized = true
      status = 'completed'
      return { asset: { id: assetKey }, idempotencyReplay: false }
    }
    if (status === 'verifying' && 'offsetBytes' in input) {
      status = options.wrongDigest ? 'failed' : 'finalizing'
      return { status }
    }
    if ('completionToken' in input && status === 'uploading') {
      status = 'completing'
      return { status: 'completing', completionToken: 'completion-1', parts: [{ partNumber: 1, etag: 'etag-1' }] }
    }
    if ('completionToken' in input) {
      status = 'verifying'
      return { status: 'verifying' }
    }
    if ('multipartUploadId' in input) return { assetKey, r2Key: 'asset/object', multipartUploadId: uploadId }
    if ('partNumber' in input && 'leaseToken' in input && 'etag' in input) {
      accepted = true
      return { accepted: true, etag: 'etag-1' }
    }
    if ('partNumber' in input) return { status: 'claimed', leaseToken: 'lease-1' }
    if (status === 'verifying') {
      return {
        status: 'verifying',
        claimed: true,
        session: {
          leaseToken: 'verify-lease',
          verificationOffsetBytes: 0,
          verificationState: initialSerializableSha256State(),
        },
      }
    }
    return { status: 'completing', completionToken: 'completion-1', parts: [{ partNumber: 1, etag: 'etag-1' }] }
  }
  const query = async (_reference: object, value: Record<string, unknown>) => {
    const input = z.object({ projectId: z.string(), sessionId: z.string() }).parse(value)
    if (input.sessionId !== sessionId || options.actor !== undefined && options.actor !== actorId) {
      throw new Error('not found')
    }
    return {
      assetKey, r2Key: 'asset/object', multipartUploadId: uploadId, contentSha256: digest,
      idempotencyKey: 'resumable-test-key', sizeBytes: partSizeBytes, mimeType: 'audio/wav',
      name: 'Long.wav', sessionId, partSizeBytes, partCount: 1,
      acceptedBytes: accepted ? partSizeBytes : 0, status,
      expiresAt: Date.now() + 60_000, parts: accepted ? [{ partNumber: 1, etag: 'etag-1', sizeBytes: partSizeBytes }] : [],
      completionToken: 'completion-1',
      verificationOffsetBytes: status === 'finalizing' ? partSizeBytes : 0,
      verificationState: initialSerializableSha256State(),
    }
  }
  const multipart = {
    uploadId,
    uploadPart: async () => {
      uploaded = true
      return { etag: 'etag-1' }
    },
    complete: async () => {
      if (options.storageError) throw options.storageError
      completed = true
    },
    abort: async () => { aborted = true },
  }
  const bucket = {
    createMultipartUpload: async () => multipart,
    resumeMultipartUpload: () => multipart,
    get: async (_key: string, rangeOptions?: { range?: { offset: number; length: number } }) => completed ? {
      size: partSizeBytes,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = rangeOptions?.range
            ? (options.wrongDigest ? Uint8Array.from(partBytes, () => 1) : partBytes).slice(
              rangeOptions.range.offset,
              rangeOptions.range.offset + rangeOptions.range.length,
            )
            : options.wrongDigest ? Uint8Array.from(partBytes, () => 1) : partBytes
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    } : null,
    head: async () => completed ? { size: partSizeBytes } : null,
    delete: async () => {},
  }
  const application = new Hono<ApiBindings>()
  registerResumableUploadRoutes(application, {
    requireProjectRoleContext: async () => options.actor === null ? null : ({
      user: { id: options.actor ?? actorId },
      convex: { query, mutation },
    }),
    createWorkerConvexClient: async () => ({ query, mutation }),
    bucket: () => bucket,
    inspectR2Metadata: async () => {
      if (options.metadataError) throw options.metadataError
      return { durationSec: 10, sampleRate: 44_100, channelCount: 1 }
    },
  })
  return { application, state: () => ({ uploaded, completed, aborted, finalized }) }
}

test('resumable routes reject unauthenticated starts before storage access', async () => {
  const harness = createHarness({ actor: null })
  const response = await harness.application.request(request('/api/resumable-uploads', {
    method: 'POST',
    body: JSON.stringify({
      projectId, idempotencyKey: 'resumable-test-key', contentSha256: digest,
      name: 'Long.wav', mimeType: 'audio/wav', sizeBytes: partSizeBytes,
    }),
    headers: { 'Content-Type': 'application/json' },
  }))
  expect(response.status).toBe(403)
})

test('resumable routes use session IDs, enforce geometry, and own completion parts', async () => {
  const harness = createHarness()
  const start = await harness.application.request(request('/api/resumable-uploads', {
    method: 'POST',
    body: JSON.stringify({
      projectId, idempotencyKey: 'resumable-test-key', contentSha256: digest,
      name: 'Long.wav', mimeType: 'audio/wav', sizeBytes: partSizeBytes,
    }),
    headers: { 'Content-Type': 'application/json' },
  }))
  expect(start.status).toBe(201)
  expect(await start.json()).toEqual({ assetKey, sessionId, completed: false })
  const status = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}`))
  expect(status.status).toBe(200)
  const wrongSize = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/1`, {
    method: 'PUT',
    headers: { 'Content-Length': '1' },
    body: new Uint8Array([1]),
  }))
  expect(wrongSize.status).toBe(400)
  const uploaded = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/1`, {
    method: 'PUT',
    headers: { 'Content-Length': String(partSizeBytes) },
    body: partBytes,
  }))
  expect(uploaded.status).toBe(200)
  const complete = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/complete`, {
    method: 'POST',
  }))
  expect(complete.status).toBe(202)
  const finish = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/complete`, {
    method: 'POST',
  }))
  expect(finish.status).toBe(201)
  expect(harness.state()).toEqual({ uploaded: true, completed: true, aborted: false, finalized: true })
})

test('resumable routes isolate actors and abort multipart cleanup', async () => {
  const harness = createHarness({ actor: 'actor-2' })
  const response = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}`))
  expect(response.status).toBe(404)
  const owner = createHarness()
  const aborted = await owner.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}`, {
    method: 'DELETE',
  }))
  expect(aborted.status).toBe(200)
  expect(owner.state().aborted).toBe(true)
})

test('resumable routes map authoritative metadata rejection and do not finalize', async () => {
  const harness = createHarness({ metadataError: new AudioUploadValidationError('bad metadata') })
  await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/complete`, {
    method: 'POST',
  }))
  const response = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/complete`, {
    method: 'POST',
  }))
  expect(response.status).toBe(422)
  expect(harness.state().finalized).toBe(false)
})

test('resumable completion rejects a digest mismatch before finalization', async () => {
  const harness = createHarness({ wrongDigest: true })
  const response = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/complete`, {
    method: 'POST',
  }))
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ assetKey, sessionId, status: 'failed' })
  expect(harness.state().finalized).toBe(false)
})

test('resumable completion keeps transient storage failures retryable', async () => {
  const harness = createHarness({ storageError: new Error('R2 unavailable') })
  const response = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/complete`, {
    method: 'POST',
  }))
  expect(response.status).toBe(500)
  expect(harness.state().aborted).toBe(false)
  expect(harness.state().finalized).toBe(false)
})

test('resumable completion keeps transient metadata failures retryable', async () => {
  const harness = createHarness({ metadataError: new Error('metadata backend unavailable') })
  const response = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/complete`, {
    method: 'POST',
  }))
  const retry = await harness.application.request(request(`/api/resumable-uploads/${projectId}/${assetKey}/${sessionId}/complete`, {
    method: 'POST',
  }))
  expect(response.status).toBe(202)
  expect(retry.status).toBe(500)
  expect(harness.state().aborted).toBe(false)
  expect(harness.state().finalized).toBe(false)
})
