import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'
import { controlLimitsV1, resumableUploadMaximumBytes } from '@daw-browser/control'
import { isCapabilityFile } from '~/lib/desktop/capability-file'

const startResponseSchema = z.object({
  assetKey: z.string(),
  sessionId: z.string().optional(),
  completed: z.boolean().optional(),
  url: z.string().optional(),
})
const statusResponseSchema = z.object({
  assetKey: z.string(),
  sessionId: z.string(),
  status: z.enum(['uploading', 'completing', 'verifying', 'finalizing', 'completed', 'failed', 'aborted']),
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().positive(),
  acceptedBytes: z.number().int().nonnegative(),
  verificationOffsetBytes: z.number().int().nonnegative().optional(),
  parts: z.array(z.object({
    partNumber: z.number().int().positive(),
    etag: z.string(),
    sizeBytes: z.number().int().positive(),
  })),
  url: z.string().optional(),
})
const completionResponseSchema = z.object({ assetKey: z.string(), url: z.string() })
const verificationResponseSchema = z.object({
  assetKey: z.string(),
  status: z.enum(['verifying', 'finalizing']),
  verificationOffsetBytes: z.number().int().nonnegative(),
})
const terminalCompletionResponseSchema = z.object({
  assetKey: z.string(),
  sessionId: z.string(),
  status: z.enum(['failed', 'aborted']),
})
const directUploadResponseSchema = z.object({ assetKey: z.string(), url: z.string() })
const verificationDeadlineMs = 120_000
const retryBaseDelayMs = 100
const retryMaxDelayMs = 5_000
type UploadFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const throwIfAborted = (signal: AbortSignal | undefined) => {
  signal?.throwIfAborted()
}

const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500

const retryDelay = async (response: Response, attempt: number, signal?: AbortSignal) => {
  const retryAfter = Number(response.headers.get('retry-after'))
  const serverDelay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1_000 : 0
  const delay = Math.min(retryMaxDelayMs, Math.max(serverDelay, retryBaseDelayMs * 2 ** attempt))
  await new Promise<void>((resolve, reject) => {
    throwIfAborted(signal)
    // Verification polling is bounded and always cancelled by the caller's signal.
    const timer = setTimeout(resolve, delay)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}
type PersistedUploadSession = {
  projectId: string
  assetKey: string
  sessionId: string
  contentSha256: string
  sizeBytes: number
  name: string
  mimeType: string
}

const sessionStorageKey = (projectId: string, idempotencyKey: string) => (
  `daw-resumable-upload:${projectId}:${idempotencyKey}`
)

const readStorage = () => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

const readPersistedSession = (projectId: string, idempotencyKey: string): PersistedUploadSession | null => {
  const storage = readStorage()
  if (!storage) return null
  let value: unknown
  try {
    value = JSON.parse(storage.getItem(sessionStorageKey(projectId, idempotencyKey)) ?? 'null')
  } catch {
    clearPersistedSession(projectId, idempotencyKey)
    return null
  }
  const parsed = z.object({
    projectId: z.string(), assetKey: z.string(), sessionId: z.string(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().positive(), name: z.string().min(1), mimeType: z.string().min(1),
  }).safeParse(value)
  return parsed.success ? parsed.data : null
}

const persistSession = (session: PersistedUploadSession, idempotencyKey: string) => {
  const storage = readStorage()
  if (!storage) return
  try {
    storage.setItem(sessionStorageKey(session.projectId, idempotencyKey), JSON.stringify(session))
  } catch {
    // Upload progress remains resumable through the server-owned session.
  }
}

const clearPersistedSession = (projectId: string, idempotencyKey: string) => {
  const storage = readStorage()
  if (!storage) return
  storage.removeItem(sessionStorageKey(projectId, idempotencyKey))
}

export type ResumableAudioUploadResult = {
  assetKey: string
  url: string
}

export class ResumableAudioUploadHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ResumableAudioUploadHttpError'
    this.status = status
  }
}

const digestFile = async (file: File, signal?: AbortSignal) => {
  const hash = sha256.create()
  const reader = file.stream().getReader()
  try {
    while (true) {
      throwIfAborted(signal)
      const result = await reader.read()
      if (result.done) break
      hash.update(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const readJson = async (response: Response) => {
  const value: unknown = await response.json().catch(() => null)
  return value
}

const uploadPart = async (input: {
  fetch: UploadFetch
  projectId: string
  assetKey: string
  sessionId: string
  partNumber: number
  part: Blob | Uint8Array<ArrayBuffer>
  signal?: AbortSignal
}) => {
  let lastStatus = 500
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(input.signal)
    const response = await input.fetch(
      `/api/resumable-uploads/${encodeURIComponent(input.projectId)}/${encodeURIComponent(input.assetKey)}/${encodeURIComponent(input.sessionId)}/${input.partNumber}`,
      {
        method: 'PUT',
        headers: { 'Content-Length': String(input.part instanceof Blob ? input.part.size : input.part.byteLength) },
        body: input.part instanceof Blob ? input.part : new Blob([input.part]),
        signal: input.signal,
      },
    )
    if (response.ok) return
    lastStatus = response.status
    if (!retryableStatus(response.status)) {
      throw new ResumableAudioUploadHttpError(lastStatus, 'Resumable audio part upload failed.')
    }
    if (!response.ok && attempt === 2) {
      throw new ResumableAudioUploadHttpError(lastStatus, 'Resumable audio part upload failed.')
    }
    await retryDelay(response, attempt, input.signal)
  }
  throw new Error('Resumable audio part upload failed.')
}

const uploadAudioFileInternal = async (input: {
  projectId: string
  idempotencyKey: string
  assetKey: string
  file: File
  durationSec?: number
  fetch?: UploadFetch
  signal?: AbortSignal
}, terminalRestarted = false): Promise<ResumableAudioUploadResult> => {
  throwIfAborted(input.signal)
  const fetcher = input.fetch ?? fetch
  if (!isCapabilityFile(input.file) && input.file.size <= controlLimitsV1.maxAssetUploadBytes) {
    const form = new FormData()
    form.append('projectId', input.projectId)
    form.append('assetKey', input.assetKey)
    form.append('file', input.file, input.file.name)
    if (input.durationSec !== undefined && Number.isFinite(input.durationSec)) {
      form.append('duration', String(input.durationSec))
    }
    const response = await fetcher(`/api/samples?projectId=${encodeURIComponent(input.projectId)}`, {
      method: 'POST', body: form, signal: input.signal,
    })
    if (!response.ok) throw new ResumableAudioUploadHttpError(response.status, 'Audio upload failed.')
    const direct = directUploadResponseSchema.safeParse(await readJson(response))
    if (!direct.success) throw new Error('Audio upload returned an invalid asset.')
    return direct.data
  }
  if (input.file.size > resumableUploadMaximumBytes) {
    throw new ResumableAudioUploadHttpError(413, 'Resumable audio upload exceeds the protocol capacity.')
  }
  const contentSha256 = await digestFile(input.file, input.signal)
  const persistedCandidate = readPersistedSession(input.projectId, input.idempotencyKey)
  const persisted = persistedCandidate
    && persistedCandidate.contentSha256 === contentSha256
    && persistedCandidate.sizeBytes === input.file.size
    && persistedCandidate.name === input.file.name
    && persistedCandidate.mimeType === input.file.type
    ? persistedCandidate
    : null
  if (persistedCandidate && !persisted) clearPersistedSession(input.projectId, input.idempotencyKey)
  const startedValue = persisted
    ? { assetKey: persisted.assetKey, sessionId: persisted.sessionId, completed: false }
    : await (async () => {
      const startedResponse = await fetcher('/api/resumable-uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
          contentSha256,
          name: input.file.name,
          mimeType: input.file.type,
          sizeBytes: input.file.size,
        }),
        signal: input.signal,
      })
      if (!startedResponse.ok) {
        throw new ResumableAudioUploadHttpError(
          startedResponse.status,
          'Resumable audio upload could not start.',
        )
      }
      return await readJson(startedResponse)
    })()
  const started = startResponseSchema.safeParse(startedValue)
  if (!started.success) {
    throw new Error('Resumable audio upload returned an invalid session.')
  }
  if (started.data.completed) {
    clearPersistedSession(input.projectId, input.idempotencyKey)
    return {
      assetKey: started.data.assetKey,
      url: started.data.url
        ?? `/api/samples/${encodeURIComponent(input.projectId)}/${encodeURIComponent(started.data.assetKey)}`,
    }
  }
  if (!started.data.sessionId) throw new Error('Resumable audio upload returned an invalid session.')
  persistSession({
    projectId: input.projectId, assetKey: started.data.assetKey, sessionId: started.data.sessionId,
    contentSha256, sizeBytes: input.file.size, name: input.file.name, mimeType: input.file.type,
  }, input.idempotencyKey)
  const restartAfterTerminalStatus = async () => {
    clearPersistedSession(input.projectId, input.idempotencyKey)
    if (terminalRestarted) {
      throw new Error('Resumable audio upload restart returned another terminal session.')
    }
    return await uploadAudioFileInternal(input, true)
  }
  const statusResponse = await fetcher(
    `/api/resumable-uploads/${encodeURIComponent(input.projectId)}/${encodeURIComponent(started.data.assetKey)}/${encodeURIComponent(started.data.sessionId)}`,
    { signal: input.signal },
  )
  if (!statusResponse.ok && persisted) {
    clearPersistedSession(input.projectId, input.idempotencyKey)
    return await uploadAudioFile(input)
  }
  if (!statusResponse.ok) {
    throw new ResumableAudioUploadHttpError(
      statusResponse.status,
      'Resumable audio upload session could not be resumed.',
    )
  }
  const status = statusResponseSchema.safeParse(await readJson(statusResponse))
  if (!status.success) throw new Error('Resumable audio upload returned invalid status.')
  if (status.data.status === 'completed') {
    clearPersistedSession(input.projectId, input.idempotencyKey)
    return {
      assetKey: status.data.assetKey,
      url: status.data.url
        ?? `/api/samples/${encodeURIComponent(input.projectId)}/${encodeURIComponent(status.data.assetKey)}`,
    }
  }
  if (status.data.status === 'failed' || status.data.status === 'aborted') {
    return await restartAfterTerminalStatus()
  }
  const accepted = new Set(status.data.parts.map((part) => part.partNumber))
  for (let partNumber = 1; partNumber <= status.data.partCount; partNumber += 1) {
    if (accepted.has(partNumber)) continue
    const offset = (partNumber - 1) * status.data.partSizeBytes
    const part = new Uint8Array(await input.file.slice(
      offset,
      Math.min(input.file.size, offset + status.data.partSizeBytes),
    ).arrayBuffer())
    await uploadPart({
      fetch: fetcher, projectId: input.projectId, assetKey: status.data.assetKey,
      sessionId: status.data.sessionId, partNumber, part,
      signal: input.signal,
    })
  }
  const verificationDeadline = Date.now() + verificationDeadlineMs
  let completionAttempt = 0
  while (Date.now() < verificationDeadline) {
    throwIfAborted(input.signal)
    const completedResponse = await fetcher(
      `/api/resumable-uploads/${encodeURIComponent(input.projectId)}/${encodeURIComponent(status.data.assetKey)}/${encodeURIComponent(status.data.sessionId)}/complete`,
      { method: 'POST', signal: input.signal },
    )
    const responseValue = await readJson(completedResponse)
    const terminal = terminalCompletionResponseSchema.safeParse(responseValue)
    if (terminal.success) return await restartAfterTerminalStatus()
    if (!completedResponse.ok && completedResponse.status !== 202) {
      if (retryableStatus(completedResponse.status)) {
        await retryDelay(completedResponse, completionAttempt, input.signal)
        completionAttempt += 1
        continue
      }
      throw new ResumableAudioUploadHttpError(
        completedResponse.status,
        'Resumable audio upload could not be completed.',
      )
    }
    const completed = completionResponseSchema.safeParse(responseValue)
    if (completed.success) {
      clearPersistedSession(input.projectId, input.idempotencyKey)
      return completed.data
    }
    const verification = verificationResponseSchema.safeParse(responseValue)
    if (!verification.success) throw new Error('Resumable audio upload returned an invalid verification status.')
    await retryDelay(completedResponse, 0, input.signal)
    let nextStatusResponse = await fetcher(
      `/api/resumable-uploads/${encodeURIComponent(input.projectId)}/${encodeURIComponent(verification.data.assetKey)}/${encodeURIComponent(status.data.sessionId)}`,
      { signal: input.signal },
    )
    let statusAttempt = 0
    while (!nextStatusResponse.ok && retryableStatus(nextStatusResponse.status)
      && Date.now() < verificationDeadline) {
      await retryDelay(nextStatusResponse, statusAttempt, input.signal)
      statusAttempt += 1
      nextStatusResponse = await fetcher(
        `/api/resumable-uploads/${encodeURIComponent(input.projectId)}/${encodeURIComponent(verification.data.assetKey)}/${encodeURIComponent(status.data.sessionId)}`,
        { signal: input.signal },
      )
    }
    if (!nextStatusResponse.ok) {
      throw new ResumableAudioUploadHttpError(nextStatusResponse.status, 'Resumable audio upload verification could not continue.')
    }
    const nextStatus = statusResponseSchema.safeParse(await readJson(nextStatusResponse))
    if (!nextStatus.success) throw new Error('Resumable audio upload returned invalid verification status.')
    if (nextStatus.data.status === 'completed') {
      clearPersistedSession(input.projectId, input.idempotencyKey)
      return {
        assetKey: nextStatus.data.assetKey,
        url: nextStatus.data.url
          ?? `/api/samples/${encodeURIComponent(input.projectId)}/${encodeURIComponent(nextStatus.data.assetKey)}`,
      }
    }
    if (nextStatus.data.status === 'failed' || nextStatus.data.status === 'aborted') {
      return await restartAfterTerminalStatus()
    }
    if (nextStatus.data.status !== 'verifying' && nextStatus.data.status !== 'finalizing') {
      throw new Error('Resumable audio upload verification stopped unexpectedly.')
    }
  }
  throw new ResumableAudioUploadHttpError(504, 'Resumable audio upload verification timed out.')
}

export const uploadAudioFile = (input: {
  projectId: string
  idempotencyKey: string
  assetKey: string
  file: File
  durationSec?: number
  fetch?: UploadFetch
  signal?: AbortSignal
}) => uploadAudioFileInternal(input)
