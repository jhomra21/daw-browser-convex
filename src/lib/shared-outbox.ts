import { openLocalProjectDb, type LocalProjectSyncStateRow } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { isSharedTimelineOperationKind, readSharedTimelineClipCreatePayload } from '~/lib/shared-timeline-operations'
import {
  publishSharedTimelineOperationParts,
  SharedTimelineOperationHttpError,
  type SharedTimelineOperation,
  type SharedTimelineOperationKind,
} from '~/lib/shared-timeline-operations-api'

type SharedOutboxStatus = 'pending' | 'failed'
type SharedOutboxKind = SharedTimelineOperationKind | 'clips.createUploadedAudio'

type UploadedAudioClipPayload = {
  projectId: string
  assetKey: string
  file: File
  duration?: number
  clipPayload: Extract<SharedTimelineOperation, { kind: 'clips.create' }>['payload']
}

type SharedOutboxEntry = {
  id: string
  kind: SharedOutboxKind
  projectId: string
  userId: string
  payload: unknown
  status: SharedOutboxStatus
  attempts: number
  nextAttemptAt: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

type SharedOutboxSummary = {
  pending: number
  failed: number
}

const OUTBOX_PREFIX = 'shared-outbox:'
const OUTBOX_STATUS_KEY = 'shared-outbox-status'

const now = () => Date.now()
const retryDelayMs = (attempts: number) => Math.min(60 * 1000, 2 ** Math.min(attempts, 6) * 1000)
export class SharedOutboxQueuedError extends Error {
  constructor(kind: SharedOutboxKind) {
    super(`${kind} queued for retry`)
    this.name = 'SharedOutboxQueuedError'
  }
}

export const isSharedOutboxQueuedError = (error: unknown) =>
  error instanceof SharedOutboxQueuedError

const shouldQueueSharedOperationError = (error: unknown) => (
  !(error instanceof SharedTimelineOperationHttpError)
  || error.status === 408
  || error.status === 429
  || error.status >= 500
)

const keyFor = (id: string) => `${OUTBOX_PREFIX}${id}`

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isOutboxKind = (value: unknown): value is SharedOutboxKind => (
  isSharedTimelineOperationKind(value) || value === 'clips.createUploadedAudio'
)

const readEntry = (value: unknown): SharedOutboxEntry | null => {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string'
    || !isOutboxKind(value.kind)
    || typeof value.projectId !== 'string'
    || typeof value.userId !== 'string'
    || (value.status !== 'pending' && value.status !== 'failed')
    || typeof value.attempts !== 'number'
    || typeof value.nextAttemptAt !== 'number'
    || typeof value.createdAt !== 'number'
    || typeof value.updatedAt !== 'number'
  ) return null
  return {
    id: value.id,
    kind: value.kind,
    projectId: value.projectId,
    userId: value.userId,
    payload: value.payload,
    status: value.status,
    attempts: value.attempts,
    nextAttemptAt: value.nextAttemptAt,
    lastError: typeof value.lastError === 'string' ? value.lastError : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

const summarizeOutboxRows = (rows: LocalProjectSyncStateRow[], userId: string) => (
  rows.reduce<SharedOutboxSummary>((acc, row) => {
    if (!row.key.startsWith(OUTBOX_PREFIX)) return acc
    const entry = readEntry(row.value)
    if (!entry || entry.userId !== userId) return acc
    return entry.status === 'failed'
      ? { ...acc, failed: acc.failed + 1 }
      : { ...acc, pending: acc.pending + 1 }
  }, { pending: 0, failed: 0 })
)

const writeSummary = async (projectId: string, userId: string, rows?: LocalProjectSyncStateRow[]) => {
  const db = await openLocalProjectDb(projectId)
  const source = rows ?? await db.getAll('syncState')
  const summary = summarizeOutboxRows(source, userId)
  await db.put('syncState', { key: OUTBOX_STATUS_KEY, value: summary, updatedAt: now() })
  notifyLocalProjectChanged(projectId)
  return summary
}

const readUploadedAudioClipPayload = (value: unknown): UploadedAudioClipPayload | null => {
  if (!isRecord(value)) return null
  const clipPayload = readSharedTimelineClipCreatePayload(value.clipPayload)
  if (
    typeof value.projectId !== 'string'
    || typeof value.assetKey !== 'string'
    || !(value.file instanceof File)
    || !clipPayload
  ) return null
  return {
    projectId: value.projectId,
    assetKey: value.assetKey,
    file: value.file,
    duration: typeof value.duration === 'number' ? value.duration : undefined,
    clipPayload,
  }
}

const uploadSharedAudioClipAsset = async (payload: UploadedAudioClipPayload) => {
  const form = new FormData()
  form.append('projectId', payload.projectId)
  form.append('assetKey', payload.assetKey)
  form.append('file', payload.file, payload.file.name)
  if (typeof payload.duration === 'number' && Number.isFinite(payload.duration)) {
    form.append('duration', String(payload.duration))
  }
  const response = await fetch('/api/samples', { method: 'POST', body: form })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail ? `Shared audio upload failed: ${response.status} ${detail}` : `Shared audio upload failed: ${response.status}`)
  }
  const data = await response.json().catch(() => null)
  if (!isRecord(data) || typeof data.url !== 'string') throw new Error('Shared audio upload failed.')
  return data.url
}

export const readSharedOutboxSummary = async (projectId: string, userId: string): Promise<SharedOutboxSummary> => {
  const db = await openLocalProjectDb(projectId)
  return summarizeOutboxRows(await db.getAll('syncState'), userId)
}

const enqueueSharedOutboxOperation = async (
  input: {
    projectId: string
    userId: string
    kind: SharedOutboxKind
    payload: unknown
    error?: unknown
  },
) => {
  const timestamp = now()
  const entry: SharedOutboxEntry = {
    id: crypto.randomUUID(),
    kind: input.kind,
    projectId: input.projectId,
    userId: input.userId,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: timestamp,
    lastError: input.error instanceof Error ? input.error.message : undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const db = await openLocalProjectDb(input.projectId)
  await db.put('syncState', { key: keyFor(entry.id), value: entry, updatedAt: timestamp })
  await writeSummary(input.projectId, input.userId)
}

const listEntries = async (projectId: string, userId: string) => {
  const db = await openLocalProjectDb(projectId)
  return (await db.getAll('syncState'))
    .flatMap((row) => row.key.startsWith(OUTBOX_PREFIX) ? [readEntry(row.value)].filter((entry) => entry !== null) : [])
    .filter((entry) => entry.userId === userId)
    .sort((left, right) => left.createdAt - right.createdAt)
}

const publishEntry = async (entry: SharedOutboxEntry) => {
  if (entry.kind === 'clips.createUploadedAudio') {
    const payload = readUploadedAudioClipPayload(entry.payload)
    if (!payload) throw new Error('Invalid queued shared audio clip.')
    const sampleUrl = await uploadSharedAudioClipAsset(payload)
    await publishSharedTimelineOperationParts(entry.projectId, 'clips.create', {
      ...payload.clipPayload,
      sampleUrl,
    })
    return
  }
  await publishSharedTimelineOperationParts(entry.projectId, entry.kind, entry.payload)
}

export const enqueueSharedTimelineOperationOnFailure = async (
  input: { projectId: string; userId: string; operation: SharedTimelineOperation; error?: unknown },
) => enqueueSharedOutboxOperation({
  projectId: input.projectId,
  userId: input.userId,
  kind: input.operation.kind,
  payload: input.operation.payload,
  error: input.error,
})

export const publishSharedTimelineOperationOrQueue = async <T = undefined>(
  input: {
    projectId: string
    userId: string
    operation: SharedTimelineOperation
    queuedResult?: T
    throwQueued?: boolean
  },
): Promise<unknown | T | undefined> => await publishSharedTimelineOperationParts(
  input.projectId,
  input.operation.kind,
  input.operation.payload,
).catch(async (error) => {
  if (!shouldQueueSharedOperationError(error)) throw error
  await enqueueSharedTimelineOperationOnFailure(input)
  if (input.throwQueued) throw new SharedOutboxQueuedError(input.operation.kind)
  return input.queuedResult
})

export const enqueueSharedAudioClipCreateOnFailure = async (
  input: { projectId: string; userId: string; assetKey: string; file: File; duration?: number; clipPayload: UploadedAudioClipPayload['clipPayload']; error?: unknown },
) => enqueueSharedOutboxOperation({
  projectId: input.projectId,
  userId: input.userId,
  kind: 'clips.createUploadedAudio',
  payload: {
    projectId: input.projectId,
    assetKey: input.assetKey,
    file: input.file,
    duration: input.duration,
    clipPayload: input.clipPayload,
  },
  error: input.error,
})

export const flushSharedOutbox = async (
  projectId: string,
  userId: string,
  options: { retryFailed?: boolean } = {},
) => {
  const timestamp = now()
  const db = await openLocalProjectDb(projectId)
  const entries = (await listEntries(projectId, userId)).filter((entry) => (
    (entry.nextAttemptAt <= timestamp && (entry.status === 'pending' || entry.status === 'failed'))
    || (options.retryFailed && entry.status === 'failed')
  ))
  for (const entry of entries) {
    try {
      await publishEntry(entry)
      await db.delete('syncState', keyFor(entry.id))
    } catch (error) {
      const attempts = entry.attempts + 1
      await db.put('syncState', {
        key: keyFor(entry.id),
        value: {
          ...entry,
          status: 'failed',
          attempts,
          nextAttemptAt: now() + retryDelayMs(attempts),
          lastError: error instanceof Error ? error.message : 'Shared change publish failed',
          updatedAt: now(),
        },
        updatedAt: now(),
      })
      break
    }
  }
  return await writeSummary(projectId, userId)
}
