import {
  openLocalProjectDb,
  type LocalProjectStoredValue,
  type LocalProjectSyncStateRow,
} from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import {
  assert,
  isDurableSharedTimelineOperationKind,
  parseDurableSharedTimelineOperation,
  sanitizeLegacyMidiClipForCreate,
  type JsonValue,
} from '@daw-browser/shared'
import {
  publishSharedTimelineOperation,
  SharedTimelineOperationHttpError,
  SharedTimelineOperationRejectedError,
  type SharedTimelineOperation,
} from '~/lib/shared-timeline-operations-api'
import { z } from 'zod'
import { sharedOutboxCompletionSchema } from '~/lib/shared-outbox-completion-schema'
import type { SharedOutboxCompletion, SharedOutboxEntry, SharedOutboxKind } from '~/lib/shared-outbox-entry'
import { ResumableAudioUploadHttpError } from './resumable-audio-uploader'
import { isCapabilityFile } from '~/lib/capability-file'
import { materializeLocalRetryFile, removeLocalRetryFile } from '~/lib/local-assets'
import { completeUngroup, attachQueuedClipDeletionRecoveries } from '~/lib/shared-outbox-history'
import { type UploadedAudioClipPayload, uploadedAudioClipPayloadSchema, readUploadedAudioClipPayload, uploadSharedAudioClipAsset } from '~/lib/shared-outbox-uploaded-audio'
import { wakeSettlementObservers } from '~/lib/shared-outbox-settlement'

type SharedOutboxSummary = {
  pending: number
  failed: number
}

type SharedOutboxRetryState = {
  nextAttemptAt?: number
  failure?: { reason: string; permanent: boolean }
}

const OUTBOX_PREFIX = 'shared-outbox:'
const OUTBOX_STATUS_KEY = 'shared-outbox-status'
const OUTBOX_SEQUENCE_KEY = 'shared-outbox-sequence'
const OUTBOX_COMPLETION_PREFIX = 'shared-outbox-completion:'
const OUTBOX_LEASE_MS = 30 * 1000
const MAX_OUTBOX_COMPLETIONS_PER_USER = 64
const outboxFlushes = new Map<string, Promise<unknown>>()
const outboxOwner = crypto.randomUUID()

type SharedOutboxRuntime = {
  now: () => number
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel: (handle: ReturnType<typeof setTimeout>) => void
}

const defaultOutboxRuntime: SharedOutboxRuntime = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle),
}

let outboxRuntime = defaultOutboxRuntime

export const setSharedOutboxRuntimeForTesting = (
  runtime: Partial<SharedOutboxRuntime> | undefined,
) => {
  outboxRuntime = runtime ? { ...defaultOutboxRuntime, ...runtime } : defaultOutboxRuntime
}

const now = () => outboxRuntime.now()
const sharedOutboxRetryDelayMs = (attempts: number) => Math.min(60 * 1000, 2 ** Math.min(attempts, 6) * 1000)

export class SharedOutboxQueuedError extends Error {
  readonly operationId: string

  constructor(kind: SharedOutboxKind, operationId: string) {
    super(`${kind} queued for retry`)
    this.name = 'SharedOutboxQueuedError'
    this.operationId = operationId
  }
}

export class SharedOutboxUnavailableError extends Error {
  constructor() {
    super('Shared outbox publication requires Web Locks.')
    this.name = 'SharedOutboxUnavailableError'
  }
}

type SharedOperationFailure = z.input<ReturnType<typeof z.unknown>>

export const isSharedOutboxQueuedError = (error: SharedOperationFailure) =>
  error instanceof SharedOutboxQueuedError

class SharedOutboxRejectedError extends Error {
  readonly operationId: string

  constructor(operationId: string, reason: string) {
    super(reason)
    this.name = 'SharedOutboxRejectedError'
    this.operationId = operationId
  }
}

export const isPermanentSharedOperationError = (error: SharedOperationFailure) => (
  error instanceof SharedTimelineOperationRejectedError
  || (error instanceof SharedTimelineOperationHttpError && (
    error.status === 400 || error.status === 403 || error.status === 413
  ))
  || (error instanceof ResumableAudioUploadHttpError && (
    error.status === 400 || error.status === 403 || error.status === 413
  ))
  || (error instanceof Error && error.message === 'Queued operation is incompatible with current validation and cannot be published.')
  || (error instanceof Error && error.message === 'Invalid queued shared audio clip.')
)

const keyFor = (id: string) => `${OUTBOX_PREFIX}${id}`
const completionKeyFor = (projectId: string, userId: string, id: string) => `${OUTBOX_COMPLETION_PREFIX}${projectId}:${userId}:${id}`
const flushKeyFor = (projectId: string, userId: string) => `${projectId}:${userId}`
const lockNameFor = (projectId: string, userId: string) => `daw-browser:shared-outbox:${projectId}:${userId}`
const outboxKeyRange = () => IDBKeyRange.bound(OUTBOX_PREFIX, `${OUTBOX_PREFIX}\uffff`)

const outboxCompletionKeyRange = (projectId: string, userId: string) => IDBKeyRange.bound(
  `${OUTBOX_COMPLETION_PREFIX}${projectId}:${userId}:`,
  `${OUTBOX_COMPLETION_PREFIX}${projectId}:${userId}:\uffff`,
)

const readOutboxRows = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)

  return await db.getAll('syncState', outboxKeyRange())
}

const outboxSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

const outboxSequence = (value: LocalProjectStoredValue) => (
  outboxSequenceSchema.safeParse(value).data
)

const sharedOutboxKindSchema = z.custom<SharedOutboxKind>((value) => (
  value === 'clips.createUploadedAudio'
  || (() => {
    const parsed = z.json().safeParse(value)

    return parsed.success && isDurableSharedTimelineOperationKind(parsed.data)
  })()
))

const sharedOutboxEntrySchema = z.object({
  id: z.string(),
  kind: sharedOutboxKindSchema,
  projectId: z.string(),
  userId: z.string(),
  payload: z.union([z.json(), uploadedAudioClipPayloadSchema]),
  completion: sharedOutboxCompletionSchema.optional(),
  ownerAwaitsCompletion: z.literal(true).optional(),
  status: z.enum(['pending', 'failed', 'dead-letter', 'completed']),
  attempts: z.number(),
  nextAttemptAt: z.number(),
  lastError: z.string().optional(),
  sequence: outboxSequenceSchema.optional(),
  claimOwner: z.string().optional(),
  claimToken: z.string().optional(),
  leaseExpiresAt: z.number().optional(),
  retryFileCleanup: z.object({
    projectId: z.string(),
    storagePath: z.string().min(1).max(256),
  }).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const readEntry = (value: LocalProjectStoredValue): SharedOutboxEntry | null => {
  const parsed = sharedOutboxEntrySchema.safeParse(value)

  if (!parsed.success) return null
  const entry = parsed.data

  return {
    id: entry.id,
    kind: entry.kind,
    projectId: entry.projectId,
    userId: entry.userId,
    payload: entry.payload,
    completion: entry.completion,
    ownerAwaitsCompletion: entry.ownerAwaitsCompletion,
    status: entry.status,
    attempts: entry.attempts,
    nextAttemptAt: entry.nextAttemptAt,
    lastError: entry.lastError,
    sequence: entry.sequence,
    claimOwner: entry.claimOwner,
    claimToken: entry.claimToken,
    leaseExpiresAt: entry.leaseExpiresAt,
    retryFileCleanup: entry.retryFileCleanup,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

const summarizeOutboxRows = (rows: LocalProjectSyncStateRow[], userId: string) => (
  readOutboxEntries(rows, userId).reduce<SharedOutboxSummary>((acc, entry) => {
    if (entry.status === 'pending') acc.pending += 1
    else if (entry.status === 'failed' || entry.status === 'dead-letter') acc.failed += 1

    return acc
  }, { pending: 0, failed: 0 })
)

const readOutboxEntries = (rows: LocalProjectSyncStateRow[], userId: string) => (
  rows
    .flatMap((row) => {
      const entry = readEntry(row.value)

      return entry && entry.userId === userId ? [entry] : []
    })
)

const migrateLegacyOperationEntry = async (
  projectId: string,
  entry: SharedOutboxEntry,
) => {
  if (
    (entry.kind !== 'clips.removeMany' && entry.kind !== 'clips.create' && entry.kind !== 'clips.createMany' && entry.kind !== 'tracks.create')
    || !z.json().safeParse(entry.payload).success
  ) return entry
  const payload = z.record(z.string(), z.json()).safeParse(entry.payload)

  if (!payload.success || z.string().min(1).safeParse(payload.data.operationId).success) return entry
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const current = readEntry((await store.get(keyFor(entry.id)))?.value)
  const currentPayload = current && z.record(z.string(), z.json()).safeParse(current.payload)

  if (!current || !currentPayload || !currentPayload.success) {
    await tx.done

    return current ?? entry
  }

  const migrated: SharedOutboxEntry = {
    ...current,
    payload: { ...currentPayload.data, operationId: `outbox:${current.id}` },
    updatedAt: now(),
  }

  store.put({ key: keyFor(current.id), value: migrated, updatedAt: migrated.updatedAt })
  await tx.done

  return migrated
}

const writeSummary = async (projectId: string, userId: string, rows?: LocalProjectSyncStateRow[]) => {
  const db = await openLocalProjectDb(projectId)
  const source = rows ?? await readOutboxRows(projectId)
  const summary = summarizeOutboxRows(source, userId)
  await db.put('syncState', { key: OUTBOX_STATUS_KEY, value: summary, updatedAt: now() })
  notifyLocalProjectChanged(projectId)

  return summary
}

const ensureOutboxSequences = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const rows = await store.getAll(outboxKeyRange())

  const legacy = rows
    .flatMap((row) => {
      const entry = readEntry(row.value)

      return entry && entry.sequence === undefined ? [{ row, entry }] : []
    })
    .sort((left, right) => (
      left.entry.createdAt - right.entry.createdAt
      || left.entry.id.localeCompare(right.entry.id)
    ))

  const counter = await store.get(OUTBOX_SEQUENCE_KEY)

  let sequence = outboxSequence(counter?.value) ?? Math.max(
    0,
    ...rows.flatMap((row) => {
      const entry = readEntry(row.value)

      return entry?.sequence === undefined ? [] : [entry.sequence]
    }),
  )

  for (const { row, entry } of legacy) {
    sequence += 1
    store.put({
      ...row,
      value: { ...entry, sequence, updatedAt: now() },
      updatedAt: now(),
    })
  }

  if (legacy.length > 0 || counter === undefined) {
    store.put({ key: OUTBOX_SEQUENCE_KEY, value: sequence, updatedAt: now() })
  }

  await tx.done
}

export const readSharedOutboxSummary = async (projectId: string, userId: string): Promise<SharedOutboxSummary> => {
  return summarizeOutboxRows(await readOutboxRows(projectId), userId)
}

// The one-shot timer of a project's next delivery attempt. The deadline is the persisted head of the outbox, or the
// backoff after a failed flush when that deadline cannot be read. `onRetryDue` fires once per armed deadline, and
// `dispose` cancels the timer, so no attempt outlives its owner.
export const createSharedOutboxRetry = (projectId: string, userId: string, onRetryDue: () => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let version = 0
  let failures = 0
  let notBefore = 0
  let disposed = false

  const cancel = () => {
    if (timer === undefined) return
    outboxRuntime.cancel(timer)
    timer = undefined
  }

  const arm = async () => {
    const armed = ++version
    let nextAttemptAt: number | undefined

    try {
      nextAttemptAt = (await readSharedOutboxRetryState(projectId, userId)).nextAttemptAt
    } catch {
      nextAttemptAt = notBefore || undefined
    }

    if (disposed || armed !== version) return
    cancel()

    if (nextAttemptAt === undefined && !notBefore) return
    timer = outboxRuntime.schedule(() => {
      timer = undefined
      onRetryDue()
    }, Math.max(0, Math.max(nextAttemptAt ?? 0, notBefore) - now()))
  }

  return {
    // A flush finished: re-arm from the persisted deadline, with backoff when the flush itself failed.
    settled: (delivered: boolean) => {
      failures = delivered ? 0 : failures + 1
      notBefore = delivered ? 0 : now() + sharedOutboxRetryDelayMs(failures)

      return arm()
    },
    // The persisted outbox changed: the armed deadline may be stale.
    refresh: () => {
      version += 1
      cancel()
      void arm()
    },
    backingOff: () => notBefore !== 0,
    dispose: () => {
      disposed = true
      version += 1
      cancel()
    },
  }
}

export const readSharedOutboxRetryState = async (
  projectId: string,
  userId: string,
): Promise<SharedOutboxRetryState> => {
  const entries = readOutboxEntries(await readOutboxRows(projectId), userId)
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))

  const failed = entries.filter((entry) => entry.status === 'failed')
  const permanent = entries.filter((entry) => entry.status === 'dead-letter')
  const head = entries.find((entry) => entry.status === 'pending' || entry.status === 'failed')
  const nextAttemptAt = head?.claimToken === undefined ? head?.nextAttemptAt : head.leaseExpiresAt

  const latestFailure = [...failed, ...permanent]
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]

  return {
    nextAttemptAt,
    failure: latestFailure
      ? {
        reason: (latestFailure.lastError ?? 'Shared change publish failed')
          .replace(/^Permanent failure:\s*/, '')
          .slice(0, 160),
        permanent: latestFailure.status === 'dead-letter',
      }
      : undefined,
  }
}

const serializeDurableOperationPayload = (payload: SharedTimelineOperation['payload']) => (
  z.json().parse(JSON.parse(JSON.stringify(payload)))
)

const enqueueSharedOutboxOperation = async (
  input: {
    projectId: string
    userId: string
    kind: SharedOutboxKind
    payload: LocalProjectStoredValue
    error?: unknown
    completion?: SharedOutboxCompletion
    ownerAwaitsCompletion?: true
  },
) => {
  const timestamp = now()
  const permanent = input.error !== undefined && isPermanentSharedOperationError(input.error)
  const db = await openLocalProjectDb(input.projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const counter = await store.get(OUTBOX_SEQUENCE_KEY)
  const existingRows = await store.getAll(outboxKeyRange())

  let sequence = outboxSequence(counter?.value) ?? Math.max(
    0,
    ...existingRows.flatMap((row) => {
      const existing = readEntry(row.value)

      return existing?.sequence === undefined ? [] : [existing.sequence]
    }),
  )

  const legacy = existingRows
    .flatMap((row) => {
      const existing = readEntry(row.value)

      return existing && existing.sequence === undefined ? [{ row, entry: existing }] : []
    })
    .sort((left, right) => (
      left.entry.createdAt - right.entry.createdAt
      || left.entry.id.localeCompare(right.entry.id)
    ))

  for (const { row, entry: legacyEntry } of legacy) {
    sequence += 1
    store.put({
      ...row,
      value: { ...legacyEntry, sequence, updatedAt: timestamp },
      updatedAt: timestamp,
    })
  }

  sequence += 1

  const entry: SharedOutboxEntry = {
    id: crypto.randomUUID(),
    kind: input.kind,
    projectId: input.projectId,
    userId: input.userId,
    payload: input.payload,
    completion: input.completion,
    ownerAwaitsCompletion: input.ownerAwaitsCompletion,
    status: permanent ? 'dead-letter' : 'pending',
    attempts: 0,
    nextAttemptAt: timestamp,
    lastError: permanent && input.error instanceof Error
      ? `Permanent failure: ${input.error.message}`
      : input.error instanceof Error ? input.error.message : undefined,
    sequence,
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  store.put({ key: keyFor(entry.id), value: entry, updatedAt: timestamp })
  store.put({ key: OUTBOX_SEQUENCE_KEY, value: sequence, updatedAt: timestamp })
  await tx.done
  await writeSummary(input.projectId, input.userId)

  return entry
}

const listEntries = async (projectId: string, userId: string) => {
  await ensureOutboxSequences(projectId)
  const entries = readOutboxEntries(await readOutboxRows(projectId), userId)

  return (await Promise.all(entries.map((entry) => migrateLegacyOperationEntry(projectId, entry))))
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
}

const publishEntry = async (entry: SharedOutboxEntry) => {
  if (entry.kind === 'clips.createUploadedAudio') {
    const payload = await readUploadedAudioClipPayload(entry.payload)

    if (!payload) throw new Error('Invalid queued shared audio clip.')
    const upload = await uploadSharedAudioClipAsset(payload, `outbox-${entry.id}`)

    const result = await publishSharedTimelineOperation(entry.projectId, {
      kind: 'clips.create',
      payload: { ...payload.clipPayload, sampleUrl: upload.url, assetKey: upload.assetKey },
    })

    return result
  }

  const storedOperation = z.json().safeParse({ kind: entry.kind, payload: entry.payload })

  const operation = storedOperation.success
    ? parseDurableSharedTimelineOperation(storedOperation.data)
    : null

  if (!operation) throw new Error('Queued operation is incompatible with current validation and cannot be published.')

  const compatibleOperation = operation.kind === 'clips.create'
    ? {
        ...operation,
        payload: {
          ...operation.payload,
          midi: operation.payload.midi ? sanitizeLegacyMidiClipForCreate(operation.payload.midi) : undefined,
        },
      }
    : operation.kind === 'clips.createMany'
      ? {
          ...operation,
          payload: {
            ...operation.payload,
            items: operation.payload.items.map((item) => ({
              ...item,
              midi: item.midi ? sanitizeLegacyMidiClipForCreate(item.midi) : undefined,
            })),
          },
        }
      : operation

  const result = await publishSharedTimelineOperation(entry.projectId, compatibleOperation)

  return result
}

export const enqueueSharedTimelineOperationOnFailure = async (
  input: { projectId: string; userId: string; operation: SharedTimelineOperation; error?: unknown; completion?: SharedOutboxCompletion },
) => {
  assert(isDurableSharedTimelineOperationKind(input.operation.kind), `Shared timeline operation ${input.operation.kind} is not durable.`)

  return (await enqueueSharedOutboxOperation({
    projectId: input.projectId,
    userId: input.userId,
    kind: input.operation.kind,
    payload: serializeDurableOperationPayload(input.operation.payload),
    error: input.error,
    completion: input.completion,
  })).id
}

export const publishDurableSharedTimelineOperation = async <T = undefined>(
  input: {
    projectId: string
    userId: string
    operation: SharedTimelineOperation
    queuedResult?: T
    throwQueued?: boolean
    completion?: SharedOutboxCompletion
    completionOwner?: 'background' | 'caller'
  },
): Promise<JsonValue | T | undefined | { result: JsonValue; completionOwner: 'background' | 'caller' }> => {
  assert(isDurableSharedTimelineOperationKind(input.operation.kind), `Shared timeline operation ${input.operation.kind} is not durable.`)

  const entry = await enqueueSharedOutboxOperation({
    projectId: input.projectId,
    userId: input.userId,
    kind: input.operation.kind,
    payload: serializeDurableOperationPayload(input.operation.payload),
    completion: input.completion,
  })

  const result = await flushSharedOutboxOperation(
    input.projectId,
    input.userId,
    entry.id,
    input.completionOwner === 'caller' ? { completionOwner: 'caller' } : {},
  )

  if (result.status === 'applied') {
    return input.completionOwner === 'caller'
      ? { result: result.result, completionOwner: result.completionOwner }
      : result.result
  }

  if (input.throwQueued) throw new SharedOutboxQueuedError(input.operation.kind, entry.id)

  return input.queuedResult
}

export type DurableEffectsPublication =
  | { kind: 'applied'; result: JsonValue; entryId: string }
  | { kind: 'admitted'; entryId: string }
  | { kind: 'rejected'; entryId: string; reason: string }

// The effects publishers' door to the outbox: the outcome is one of three typed values, and an applied one carries the
// server's result. A permanent rejection is an outcome here, not an exception.
export const publishDurableEffectsOperation = async (
  input: { projectId: string; userId: string; operation: SharedTimelineOperation },
): Promise<DurableEffectsPublication> => {
  assert(isDurableSharedTimelineOperationKind(input.operation.kind), `Shared timeline operation ${input.operation.kind} is not durable.`)

  const entry = await enqueueSharedOutboxOperation({
    projectId: input.projectId,
    userId: input.userId,
    kind: input.operation.kind,
    payload: serializeDurableOperationPayload(input.operation.payload),
    ownerAwaitsCompletion: true,
  })

  try {
    const flushed = await flushSharedOutboxOperation(input.projectId, input.userId, entry.id, { completionOwner: 'caller' })

    if (flushed.status !== 'applied') return { kind: 'admitted', entryId: entry.id }

    // Another drain recorded the result before this flush ran; returning it here is the owner's read.
    if (flushed.completionOwner === 'background') await consumeSharedOutboxCompletion(input.projectId, input.userId, entry.id)

    return { kind: 'applied', result: flushed.result, entryId: entry.id }
  } catch (error) {
    if (error instanceof SharedOutboxRejectedError) return { kind: 'rejected', entryId: entry.id, reason: error.message }
    throw error
  }
}

export const enqueueSharedAudioClipCreateOnFailure = async (
  input: { projectId: string; userId: string; assetKey: string; file: File; duration?: number; clipPayload: UploadedAudioClipPayload['clipPayload']; error?: unknown },
) => {
  if (input.error !== undefined && isPermanentSharedOperationError(input.error)) {
    throw input.error
  }

  const materialized = isCapabilityFile(input.file)
    ? await materializeLocalRetryFile(input.projectId, input.file)
    : undefined

  try {
    return (await enqueueSharedOutboxOperation({
      projectId: input.projectId,
      userId: input.userId,
      kind: 'clips.createUploadedAudio',
      payload: {
        projectId: input.projectId,
        assetKey: input.assetKey,
        file: materialized ? undefined : input.file,
        materializedPath: materialized?.storagePath,
        fileName: input.file.name,
        mimeType: input.file.type,
        duration: input.duration,
        clipPayload: input.clipPayload,
      },
      error: input.error,
    })).id
  } catch (error) {
    if (materialized) {
      try {
        await removeLocalRetryFile(input.projectId, materialized.storagePath)
      } catch (cleanupError) {
        throw new Error(
          `Retry file cleanup failed after queue admission failed: ${
            cleanupError instanceof Error ? cleanupError.message : 'project storage cleanup failed.'
          }`,
        )
      }
    }

    throw error
  }
}

type ClaimedOutboxEntry = SharedOutboxEntry & { claimToken: string }

type SharedOutboxCompletionResult = {
  result: JsonValue
  createdAt: number
  completionOwner: 'background' | 'caller'
  consumed: boolean
}

type SharedOutboxOperationResult =
  | { status: 'applied'; result: JsonValue; completionOwner: 'background' | 'caller' }
  | { status: 'missing' | 'pending' }

type SharedOutboxOperationRead =
  | SharedOutboxOperationResult
  | { status: 'rejected'; lastError?: string }

// Records written before completions stopped expiring still carry `expiresAt`; zod drops it, so no age decides anything.
const sharedOutboxCompletionResultSchema = z.object({
  result: z.json(),
  createdAt: z.number(),
  completionOwner: z.enum(['background', 'caller']).optional(),
  consumed: z.boolean().optional(),
})

const readCompletionResult = (value: LocalProjectStoredValue): SharedOutboxCompletionResult | null => {
  const parsed = sharedOutboxCompletionResultSchema.safeParse(value)

  if (!parsed.success) return null

  return {
    result: parsed.data.result,
    createdAt: parsed.data.createdAt,
    completionOwner: parsed.data.completionOwner === 'caller' ? 'caller' : 'background',
    consumed: parsed.data.consumed !== false,
  }
}

const claimNextEntry = async (
  projectId: string,
  userId: string,
  options: { retryFailed?: boolean; allowExpiredClaimRecovery: boolean },
): Promise<ClaimedOutboxEntry | undefined> => {
  await listEntries(projectId, userId)
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const timestamp = now()

  const entries = (await store.getAll(outboxKeyRange()))
    .flatMap((row) => {
      const entry = readEntry(row.value)

      return entry && entry.userId === userId ? [entry] : []
    })
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))

  const head = entries.find((entry) => entry.status === 'pending' || entry.status === 'failed')

  if (
    !head
    || (
      head.claimToken !== undefined
      && (!options.allowExpiredClaimRecovery || head.leaseExpiresAt === undefined || head.leaseExpiresAt > timestamp)
    )
    || (head.nextAttemptAt > timestamp && !(options.retryFailed && head.status === 'failed'))
  ) {
    await tx.done

    return undefined
  }

  const claimToken = crypto.randomUUID()

  const claimed: ClaimedOutboxEntry = {
    ...head,
    claimOwner: outboxOwner,
    claimToken,
    leaseExpiresAt: timestamp + OUTBOX_LEASE_MS,
    updatedAt: timestamp,
  }

  store.put({ key: keyFor(claimed.id), value: claimed, updatedAt: timestamp })
  await tx.done

  return claimed
}

const renewClaim = async (
  projectId: string,
  entry: ClaimedOutboxEntry,
) => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const current = readEntry((await store.get(keyFor(entry.id)))?.value)
  const timestamp = now()

  if (
    !current
    || current.claimToken !== entry.claimToken
    || current.claimOwner !== outboxOwner
    || current.leaseExpiresAt === undefined
    || current.leaseExpiresAt <= timestamp
  ) {
    await tx.done

    return false
  }

  store.put({
    key: keyFor(current.id),
    value: { ...current, leaseExpiresAt: timestamp + OUTBOX_LEASE_MS, updatedAt: timestamp },
    updatedAt: timestamp,
  })
  await tx.done

  return true
}

const keepClaimAlive = (projectId: string, entry: ClaimedOutboxEntry) => {
  let active = true
  let owned = true
  let handle: ReturnType<typeof setTimeout> | undefined

  const renew = () => {
    void renewClaim(projectId, entry).then((renewed) => {
      owned = renewed

      if (active && renewed) handle = outboxRuntime.schedule(renew, Math.floor(OUTBOX_LEASE_MS / 2))
    }).catch(() => {
      owned = false
    })
  }

  handle = outboxRuntime.schedule(renew, Math.floor(OUTBOX_LEASE_MS / 2))

  return {
    isOwned: () => owned,
    stop: () => {
      active = false

      if (handle) outboxRuntime.cancel(handle)
    },
  }
}

const completeClaimedEntry = async (
  projectId: string,
  entry: ClaimedOutboxEntry,
  result: JsonValue,
  completionOwner: 'background' | 'caller',
) => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const current = readEntry((await store.get(keyFor(entry.id)))?.value)
  let completed = false

  if (current?.claimToken === entry.claimToken && current.claimOwner === outboxOwner) {
    const timestamp = now()
    // The count cap collects consumed history only: a result its awaiting owner has not read stays the answer.
    const consumed = !(current.ownerAwaitsCompletion && completionOwner === 'background')
    const completions = await store.getAll(outboxCompletionKeyRange(projectId, entry.userId))
    const stored: { key: string; completion: SharedOutboxCompletionResult }[] = []

    for (const row of completions) {
      const completion = readCompletionResult(row.value)

      if (completion) stored.push({ key: row.key, completion })
      else store.delete(row.key)
    }

    const history = stored
      .filter((row) => row.completion.consumed)
      .sort((left, right) => left.completion.createdAt - right.completion.createdAt)

    for (const row of history.slice(0, Math.max(0, history.length + (consumed ? 1 : 0) - MAX_OUTBOX_COMPLETIONS_PER_USER))) {
      store.delete(row.key)
    }

    store.put({
      key: completionKeyFor(projectId, entry.userId, entry.id),
      value: { result, createdAt: timestamp, completionOwner, consumed },
      updatedAt: timestamp,
    })

    if (entry.kind === 'clips.createUploadedAudio') {
      const payload = uploadedAudioClipPayloadSchema.safeParse(current.payload)

      if (payload.success && payload.data.materializedPath) {
        store.put({
          key: keyFor(current.id),
          value: {
            ...current,
            status: 'completed',
            claimOwner: undefined,
            claimToken: undefined,
            leaseExpiresAt: undefined,
            retryFileCleanup: {
              projectId: current.projectId,
              storagePath: payload.data.materializedPath,
            },
            updatedAt: timestamp,
          },
          updatedAt: timestamp,
        })
      } else {
        store.delete(keyFor(entry.id))
      }
    } else {
      store.delete(keyFor(entry.id))
    }

    completed = true
  }

  await tx.done

  if (completed) wakeSettlementObservers(projectId, entry.userId)
}

const settleClaimedEntryFailure = async (
  projectId: string,
  entry: ClaimedOutboxEntry,
  error: SharedOperationFailure,
) => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const current = readEntry((await store.get(keyFor(entry.id)))?.value)
  let didSettle = false

  if (current?.claimToken === entry.claimToken && current.claimOwner === outboxOwner) {
    const timestamp = now()
    const permanent = isPermanentSharedOperationError(error)
    const attempts = current.attempts + 1

    const lastError = permanent
      ? error instanceof Error
        ? `Permanent failure: ${error.message}`
        : 'Permanent failure: shared change was rejected.'
      : error instanceof Error
        ? error.message
        : 'Shared change publish failed'

    const settled: SharedOutboxEntry = {
      ...current,
      status: permanent ? 'dead-letter' : 'failed',
      attempts,
      nextAttemptAt: permanent ? timestamp : timestamp + sharedOutboxRetryDelayMs(attempts),
      lastError,
      claimOwner: undefined,
      claimToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: timestamp,
    }

    if (permanent && current.kind === 'clips.createUploadedAudio') {
      const payload = uploadedAudioClipPayloadSchema.safeParse(current.payload)

      if (payload.success && payload.data.materializedPath) {
        settled.retryFileCleanup = {
          projectId: current.projectId,
          storagePath: payload.data.materializedPath,
        }
      }
    }

    store.put({ key: keyFor(current.id), value: settled, updatedAt: timestamp })
    didSettle = true
  }

  await tx.done
  const terminal = didSettle && isPermanentSharedOperationError(error)

  if (terminal) wakeSettlementObservers(projectId, entry.userId)

  return terminal
}

const drainSharedOutbox = async (
  projectId: string,
  userId: string,
  options: { retryFailed?: boolean; allowExpiredClaimRecovery: boolean },
  targetOperationId?: string,
  callerCompletionOperationId?: string,
) => {
  const results = new Map<string, JsonValue>()

  while (true) {
    const entry = await claimNextEntry(projectId, userId, options)

    if (!entry) break
    const heartbeat = keepClaimAlive(projectId, entry)

    try {
      const result = await publishEntry(entry)

      if (!heartbeat.isOwned() || !await renewClaim(projectId, entry)) break
      const completionOwner = entry.id === callerCompletionOperationId ? 'caller' : 'background'

      if (completionOwner === 'background') completeUngroup(entry, result)
      attachQueuedClipDeletionRecoveries(entry, result)
      await completeClaimedEntry(projectId, entry, result, completionOwner)
      results.set(entry.id, result)
    } catch (error) {
      if (!heartbeat.isOwned() || !await renewClaim(projectId, entry)) break

      if (!await settleClaimedEntryFailure(projectId, entry, error)) break
    } finally {
      heartbeat.stop()
    }

    if (targetOperationId === entry.id) break
  }

  return { summary: await writeSummary(projectId, userId), results }
}

const retryOutboxFileCleanup = async (projectId: string, userId: string) => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAll('syncState', outboxKeyRange())

  const candidates = rows.flatMap((row) => {
    const entry = readEntry(row.value)

    return entry
      && entry.userId === userId
      && (entry.status === 'completed' || entry.status === 'dead-letter')
      && entry.retryFileCleanup
      ? [entry]
      : []
  })

  for (const entry of candidates) {
    const cleanup = entry.retryFileCleanup

    if (!cleanup) continue

    try {
      await removeLocalRetryFile(cleanup.projectId, cleanup.storagePath)

      if (entry.status === 'completed') {
        await db.delete('syncState', keyFor(entry.id))
      } else {
        await db.put('syncState', {
          key: keyFor(entry.id),
          value: { ...entry, retryFileCleanup: undefined, updatedAt: now() },
          updatedAt: now(),
        })
      }
    } catch (error) {
      const lastError = error instanceof Error ? error.message : 'Retry file cleanup failed.'
      await db.put('syncState', {
        key: keyFor(entry.id),
        value: { ...entry, lastError, updatedAt: now() },
        updatedAt: now(),
      })
    }
  }
}

const serializeSharedOutboxFlush = <T>(
  projectId: string,
  userId: string,
  operation: () => Promise<T>,
) => {
  const key = flushKeyFor(projectId, userId)
  const previous = outboxFlushes.get(key)
  const next = (previous ? previous.catch(() => undefined).then(operation) : operation())
  outboxFlushes.set(key, next)

  return next.finally(() => {
    if (outboxFlushes.get(key) === next) outboxFlushes.delete(key)
  })
}

const webLocks = () => globalThis.navigator?.locks

const withSharedOutboxPublicationLock = async <T>(
  projectId: string,
  userId: string,
  operation: (allowExpiredClaimRecovery: boolean) => Promise<T>,
) => {
  const locks = webLocks()

  if (!locks) {
    if (globalThis.window !== undefined) throw new SharedOutboxUnavailableError()

    return await operation(false)
  }

  return await locks.request(lockNameFor(projectId, userId), async () => await operation(true))
}

export const recoverStaleSharedOutboxClaims = async (
  projectId: string,
  userId: string,
) => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const timestamp = now()

  for (const row of await store.getAll(outboxKeyRange())) {
    const entry = readEntry(row.value)

    if (
      entry?.userId === userId
      && entry.claimToken !== undefined
      && entry.leaseExpiresAt !== undefined
      && entry.leaseExpiresAt <= timestamp
    ) {
      store.put({
        ...row,
        value: {
          ...entry,
          claimOwner: undefined,
          claimToken: undefined,
          leaseExpiresAt: undefined,
          updatedAt: timestamp,
        },
        updatedAt: timestamp,
      })
    }
  }

  await tx.done

  return await writeSummary(projectId, userId)
}

export const flushSharedOutbox = async (
  projectId: string,
  userId: string,
  options: { retryFailed?: boolean } = {},
) => {
  const result = await serializeSharedOutboxFlush(
    projectId,
    userId,
    async () => await withSharedOutboxPublicationLock(
      projectId,
      userId,
      async (allowExpiredClaimRecovery) => {
        await retryOutboxFileCleanup(projectId, userId)

        const drained = await drainSharedOutbox(
          projectId,
          userId,
          { ...options, allowExpiredClaimRecovery },
        )

        await retryOutboxFileCleanup(projectId, userId)

        return { summary: await writeSummary(projectId, userId), results: drained.results }
      },
    ),
  )

  return result.summary
}

// One readonly snapshot of the entry row and the completion record: a drain writes the record and removes the entry in one
// transaction, so this never observes the in-between state. It is the only reader of an operation's outcome.
export const readSharedOutboxOperation = async (
  projectId: string,
  userId: string,
  operationId: string,
): Promise<SharedOutboxOperationRead> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readonly')

  const [entryRow, completionRow] = await Promise.all([
    tx.store.get(keyFor(operationId)),
    tx.store.get(completionKeyFor(projectId, userId, operationId)),
  ])

  await tx.done
  const completion = readCompletionResult(completionRow?.value)

  if (completion) return { status: 'applied', result: completion.result, completionOwner: completion.completionOwner }
  const entry = readEntry(entryRow?.value)

  if (!entry || entry.userId !== userId) return { status: 'missing' }

  if (entry.status === 'dead-letter') return { status: 'rejected', lastError: entry.lastError }

  return { status: 'pending' }
}

// The awaiting owner marks a result read once it has bound it; the next completion's cap may then collect it.
// A dead-letter row is the user's recovery item and is never touched here.
export const consumeSharedOutboxCompletion = async (
  projectId: string,
  userId: string,
  operationId: string,
) => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const key = completionKeyFor(projectId, userId, operationId)
  const completion = readCompletionResult((await tx.store.get(key))?.value)

  if (completion && !completion.consumed) tx.store.put({ key, value: { ...completion, consumed: true }, updatedAt: now() })
  await tx.done
}

export const flushSharedOutboxOperation = async (
  projectId: string,
  userId: string,
  operationId: string,
  options: { completionOwner?: 'caller' } = {},
): Promise<SharedOutboxOperationResult> => {
  return await serializeSharedOutboxFlush(projectId, userId, async () => {
    return await withSharedOutboxPublicationLock(projectId, userId, async (allowExpiredClaimRecovery) => {
      await retryOutboxFileCleanup(projectId, userId)
      await listEntries(projectId, userId)
      const before = await readSharedOutboxOperation(projectId, userId, operationId)

      if (before.status === 'rejected') {
        throw new SharedOutboxRejectedError(operationId, before.lastError ?? 'Shared change was rejected.')
      }

      if (before.status !== 'pending') return before

      const drained = await drainSharedOutbox(
        projectId,
        userId,
        { retryFailed: true, allowExpiredClaimRecovery },
        operationId,
        options.completionOwner === 'caller' ? operationId : undefined,
      )

      const result = drained.results.get(operationId)

      if (result !== undefined) {
        return {
          status: 'applied' as const,
          result,
          completionOwner: options.completionOwner === 'caller' ? 'caller' as const : 'background' as const,
        }
      }

      const after = await readSharedOutboxOperation(projectId, userId, operationId)

      if (after.status === 'rejected') {
        throw new SharedOutboxRejectedError(operationId, after.lastError ?? 'Shared change was rejected.')
      }

      return after.status === 'applied' ? after : { status: 'pending' as const }
    })
  })
}

