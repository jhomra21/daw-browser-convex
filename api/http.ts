import { controlLimitsV1, type ControlErrorV1 } from '@daw-browser/control'
import type { JsonValue } from '@daw-browser/shared'
import { z } from 'zod'

/** The HTTP status each typed control error code answers with, shared by every route that reports one. */
export const controlErrorStatus = (code: ControlErrorV1['code']) => {
  if (code === 'authorization') return 401

  if (code === 'forbidden' || code === 'approval-required') return 403

  if (code === 'not-found') return 404

  if (code === 'revision-conflict' || code === 'idempotency-conflict') return 409

  if (code === 'invalid-request') return 400

  if (code === 'validation' || code === 'unsupported-action' || code === 'limit-exceeded') return 422

  return 500
}

export const hexOfBytes = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export const sha256Hex = async (value: string) => (
  hexOfBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
)

export const readBearerToken = (authorization: string | null | undefined) => {
  if (!authorization) return null
  const [scheme, token, extra] = authorization.split(' ')

  return scheme === 'Bearer' && token && !extra ? token : null
}

type BoundedJson = { value: JsonValue } | { failure: 'too-large' | 'malformed' }

/** Reads a request body as JSON without trusting content-length, refusing anything over the control body limit. */
export const readBoundedJson = async (request: Request): Promise<BoundedJson> => {
  const contentLength = request.headers.get('content-length')

  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > controlLimitsV1.maxSerializedBodyBytes)) {
    return { failure: 'too-large' }
  }

  const bytes = new Uint8Array(await request.clone().arrayBuffer())

  if (bytes.byteLength > controlLimitsV1.maxSerializedBodyBytes) return { failure: 'too-large' }

  try {
    return { value: z.json().parse(JSON.parse(new TextDecoder().decode(bytes))) }
  } catch {
    return { failure: 'malformed' }
  }
}
