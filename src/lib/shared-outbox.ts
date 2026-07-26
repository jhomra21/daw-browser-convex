import { openLocalProjectDb, type LocalProjectSyncStateRow } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { assert, isDurableSharedTimelineOperationKind, parseDurableSharedTimelineOperation, readSharedTimelineClipCreatePayload, sanitizeLegacyMidiClipForCreate, type SharedTimelineClipCreatePayload } from '@daw-browser/shared'
import {
  publishSharedTimelineOperation,
  SharedTimelineOperationHttpError,
  SharedTimelineOperationRejectedError,
  type SharedTimelineOperation,
  type SharedTimelineOperationKind,
} from '~/lib/shared-timeline-operations-api'
import type { Track } from '@daw-browser/timeline-core/types'
import { loadHistory, saveHistory } from '~/lib/timeline-storage'
import { buildCommittedSharedUngroupHistoryEntry, readSharedUngroupResult } from '~/lib/undo/shared-ungroup-history'
import type { HistoryEntry, TrackAutomationSnapshot, TrackEffectSnapshot } from '~/lib/undo/types'

type SharedOutboxStatus = 'pending' | 'failed' | 'dead-letter'
type SharedOutboxKind = SharedTimelineOperationKind | 'clips.createUploadedAudio'

type UploadedAudioClipPayload = {
  projectId: string
  assetKey: string
  file: File
  duration?: number
  clipPayload: SharedTimelineClipCreatePayload
}

type SharedOutboxEntry = {
  id: string
  kind: SharedOutboxKind
  projectId: string
  userId: string
  payload: unknown
  completion?: SharedOutboxCompletion
  status: SharedOutboxStatus
  attempts: number
  nextAttemptAt: number
  lastError?: string
  sequence?: number
  claimOwner?: string
  claimToken?: string
  leaseExpiresAt?: number
  createdAt: number
  updatedAt: number
}

type SharedOutboxCompletion = {
  kind: 'tracks.ungroup'
  tracks: Track[]
  groupTrack: Track
  effects: TrackEffectSnapshot
  automation: TrackAutomationSnapshot
}

const isSharedOutboxCompletion = (value: unknown): value is SharedOutboxCompletion => (
  isRecord(value)
  && value.kind === 'tracks.ungroup'
  && Array.isArray(value.tracks)
  && isRecord(value.groupTrack)
  && isRecord(value.effects)
  && Array.isArray(value.automation)
)

type SharedOutboxHistoryUpdate =
  | { kind: 'entry'; entry: HistoryEntry }
  | {
      kind: 'clip-deletion-recoveries'
      projectId: string
      userId: string
      operationId: string
      recoveryIdsBySourceClipId: ReadonlyMap<string, string>
    }

export const attachClipDeletionRecoveriesToHistory = (
  history: { undo: HistoryEntry[]; redo: HistoryEntry[] },
  operationId: string,
  recoveryIdsBySourceClipId: ReadonlyMap<string, string>,
) => {
  const attach = (historyEntry: HistoryEntry): boolean => {
    if (historyEntry.type === 'section-edit') {
      let changed = false
      for (const child of historyEntry.data.entries) changed = attach(child) || changed
      return changed
    }
    if (historyEntry.type !== 'clip-delete') return false
    let changed = false
    for (const item of historyEntry.data.items) {
      if (item.clip.recoveryOperationId !== operationId || !item.clip.recoverySourceClipId) continue
      const recoveryId = recoveryIdsBySourceClipId.get(item.clip.recoverySourceClipId)
      if (!recoveryId) continue
      item.clip.recoveryId = recoveryId
      changed = true
    }
    return changed
  }
  let changed = false
  for (const historyEntry of [...history.undo, ...history.redo]) changed = attach(historyEntry) || changed
  return changed
}

const sharedOutboxHistoryHandlers = new Set<(update: SharedOutboxHistoryUpdate) => boolean>()
const pendingClipDeletionRecoveryUpdates = new Map<string, Extract<
  SharedOutboxHistoryUpdate,
  { kind: 'clip-deletion-recoveries' }
>>()

const pendingClipDeletionRecoveryUpdateKey = (
  update: Extract<SharedOutboxHistoryUpdate, { kind: 'clip-deletion-recoveries' }>,
) => `${update.projectId}:${update.userId}:${update.operationId}`

export const flushPendingSharedOutboxHistoryUpdates = () => {
  for (const [key, update] of pendingClipDeletionRecoveryUpdates) {
    if (publishHistoryUpdate(update)) pendingClipDeletionRecoveryUpdates.delete(key)
  }
}

export const registerSharedOutboxHistoryHandler = (handler: (update: SharedOutboxHistoryUpdate) => boolean) => {
  sharedOutboxHistoryHandlers.add(handler)
  flushPendingSharedOutboxHistoryUpdates()
  return () => {
    sharedOutboxHistoryHandlers.delete(handler)
  }
}

const publishHistoryUpdate = (update: SharedOutboxHistoryUpdate) => {
  for (const handler of sharedOutboxHistoryHandlers) {
    if (handler(update)) return true
  }
  return false
}

const completeUngroup = (entry: SharedOutboxEntry, result: unknown) => {
  if (entry.completion?.kind !== 'tracks.ungroup') return
  const committed = readSharedUngroupResult(result)
  if (!committed) throw new Error('Queued shared ungroup was not applied.')
  const historyEntry = buildCommittedSharedUngroupHistoryEntry({
    projectId: entry.projectId,
    ...entry.completion,
    result: committed,
  })
  if (publishHistoryUpdate({ kind: 'entry', entry: historyEntry })) return
  const scope = { projectId: entry.projectId, userId: entry.userId }
  const history = loadHistory(scope)
  saveHistory(scope, { undo: [...history.undo, historyEntry].slice(-50), redo: [] })
}

const attachQueuedClipDeletionRecoveries = (entry: SharedOutboxEntry, result: unknown) => {
  if (
    entry.kind !== 'clips.removeMany'
    || !isRecord(result)
    || !Array.isArray(result.recoveries)
    || !Array.isArray(result.removedClipIds)
  ) return
  const recoveries = result.recoveries
  const removedClipIds = result.removedClipIds
  if (!isRecord(entry.payload) || !Array.isArray(entry.payload.clipIds)) {
    throw new Error('Queued clip deletion is missing clip IDs.')
  }
  const expectedClipIds = entry.payload.clipIds
  if (
    expectedClipIds.length === 0
    || !expectedClipIds.every((clipId) => typeof clipId === 'string')
    || new Set(expectedClipIds).size !== expectedClipIds.length
    || removedClipIds.length !== expectedClipIds.length
    || !removedClipIds.every((clipId) => typeof clipId === 'string')
    || new Set(removedClipIds).size !== removedClipIds.length
    || !expectedClipIds.every((clipId) => removedClipIds.includes(clipId))
    || recoveries.length !== expectedClipIds.length
  ) throw new Error('Queued clip deletion did not return a complete recovery result.')
  const recoveryIdBySourceClipId = new Map<string, string>()
  for (const recovery of recoveries) {
    if (
      isRecord(recovery)
      && typeof recovery.sourceClipId === 'string'
      && typeof recovery.recoveryId === 'string'
    ) recoveryIdBySourceClipId.set(recovery.sourceClipId, recovery.recoveryId)
  }
  if (
    recoveryIdBySourceClipId.size !== expectedClipIds.length
    || !expectedClipIds.every((clipId) => recoveryIdBySourceClipId.has(clipId))
  ) throw new Error('Queued clip deletion did not return every recovery ID.')
  const scope = { projectId: entry.projectId, userId: entry.userId }
  if (publishHistoryUpdate({
    kind: 'clip-deletion-recoveries',
    projectId: entry.projectId,
    userId: entry.userId,
    operationId: entry.id,
    recoveryIdsBySourceClipId: recoveryIdBySourceClipId,
  })) return
  const history = loadHistory(scope)
  const changed = attachClipDeletionRecoveriesToHistory(history, entry.id, recoveryIdBySourceClipId)
  if (changed) {
    saveHistory(scope, history)
    return
  }
  const update = {
    kind: 'clip-deletion-recoveries' as const,
    projectId: entry.projectId,
    userId: entry.userId,
    operationId: entry.id,
    recoveryIdsBySourceClipId: recoveryIdBySourceClipId,
  }
  pendingClipDeletionRecoveryUpdates.set(pendingClipDeletionRecoveryUpdateKey(update), update)
}

type SharedOutboxSummary = {
  pending: number
  failed: number
}

const OUTBOX_PREFIX = 'shared-outbox:'
const OUTBOX_STATUS_KEY = 'shared-outbox-status'
const OUTBOX_SEQUENCE_KEY = 'shared-outbox-sequence'
const OUTBOX_COMPLETION_PREFIX = 'shared-outbox-completion:'
const OUTBOX_LEASE_MS = 30 * 1000
const OUTBOX_COMPLETION_TTL_MS = 5 * 60 * 1000
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
const retryDelayMs = (attempts: number) => Math.min(60 * 1000, 2 ** Math.min(attempts, 6) * 1000)
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

export const isSharedOutboxQueuedError = (error: unknown) =>
  error instanceof SharedOutboxQueuedError

class SharedOutboxRejectedError extends Error {
  readonly operationId: string

  constructor(operationId: string, reason: string) {
    super(reason)
    this.name = 'SharedOutboxRejectedError'
    this.operationId = operationId
  }
}

export const isPermanentSharedOperationError = (error: unknown) => (
  error instanceof SharedTimelineOperationRejectedError
  || (error instanceof SharedTimelineOperationHttpError && (
    error.status === 400 || error.status === 403
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

const outboxSequence = (value: unknown) => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
)

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isOutboxKind = (value: unknown): value is SharedOutboxKind => (
  isDurableSharedTimelineOperationKind(value) || value === 'clips.createUploadedAudio'
)

const readEntry = (value: unknown): SharedOutboxEntry | null => {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string'
    || !isOutboxKind(value.kind)
    || typeof value.projectId !== 'string'
    || typeof value.userId !== 'string'
    || (value.status !== 'pending' && value.status !== 'failed' && value.status !== 'dead-letter')
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
    completion: isSharedOutboxCompletion(value.completion)
      ? {
          kind: value.completion.kind,
          tracks: value.completion.tracks,
          groupTrack: value.completion.groupTrack,
          effects: value.completion.effects,
          automation: value.completion.automation,
        }
      : undefined,
    status: value.status,
    attempts: value.attempts,
    nextAttemptAt: value.nextAttemptAt,
    lastError: typeof value.lastError === 'string' ? value.lastError : undefined,
    sequence: outboxSequence(value.sequence),
    claimOwner: typeof value.claimOwner === 'string' ? value.claimOwner : undefined,
    claimToken: typeof value.claimToken === 'string' ? value.claimToken : undefined,
    leaseExpiresAt: typeof value.leaseExpiresAt === 'number' ? value.leaseExpiresAt : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

const summarizeOutboxRows = (rows: LocalProjectSyncStateRow[], userId: string) => (
  readOutboxEntries(rows, userId).reduce<SharedOutboxSummary>((acc, entry) => {
    return entry.status === 'pending'
      ? { ...acc, pending: acc.pending + 1 }
      : { ...acc, failed: acc.failed + 1 }
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
    || !isRecord(entry.payload)
    || (typeof entry.payload.operationId === 'string' && entry.payload.operationId.length > 0)
  ) return entry
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const current = readEntry((await store.get(keyFor(entry.id)))?.value)
  if (!current || !isRecord(current.payload)) {
    await tx.done
    return current ?? entry
  }
  const migrated: SharedOutboxEntry = {
    ...current,
    payload: { ...current.payload, operationId: `outbox:${current.id}` },
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

const readUploadedAudioClipPayload = (value: unknown): UploadedAudioClipPayload | null => {
  if (!isRecord(value)) return null
  const clipPayload = readSharedTimelineClipCreatePayload(value.clipPayload, { requireAudioSampleUrl: false, durable: true })
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
    throw new SharedTimelineOperationHttpError(response.status, detail || undefined)
  }
  const data = await response.json().catch(() => null)
  if (!isRecord(data) || typeof data.url !== 'string' || typeof data.assetKey !== 'string') throw new Error('Shared audio upload failed.')
  return { url: data.url, assetKey: data.assetKey }
}

export const readSharedOutboxSummary = async (projectId: string, userId: string): Promise<SharedOutboxSummary> => {
  return summarizeOutboxRows(await readOutboxRows(projectId), userId)
}

const enqueueSharedOutboxOperation = async (
  input: {
    projectId: string
    userId: string
    kind: SharedOutboxKind
    payload: unknown
    error?: unknown
    completion?: SharedOutboxCompletion
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
    const payload = readUploadedAudioClipPayload(entry.payload)
    if (!payload) throw new Error('Invalid queued shared audio clip.')
    const upload = await uploadSharedAudioClipAsset(payload)
    await publishSharedTimelineOperation(entry.projectId, {
      kind: 'clips.create',
      payload: { ...payload.clipPayload, sampleUrl: upload.url, assetKey: upload.assetKey },
    })
    return
  }
  const operation = parseDurableSharedTimelineOperation({ kind: entry.kind, payload: entry.payload })
  if (!operation) throw new Error('Queued operation is incompatible with current validation and cannot be published.')
  const compatibleOperation = operation.kind === 'clips.create'
    ? {
        ...operation,
        payload: {
          ...operation.payload,
          ...(operation.payload.midi
            ? { midi: sanitizeLegacyMidiClipForCreate(operation.payload.midi) }
            : {}),
        },
      }
    : operation.kind === 'clips.createMany'
      ? {
          ...operation,
          payload: {
            ...operation.payload,
            items: operation.payload.items.map((item) => ({
              ...item,
              ...(item.midi ? { midi: sanitizeLegacyMidiClipForCreate(item.midi) } : {}),
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
    payload: input.operation.payload,
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
): Promise<unknown | T | undefined | { result: unknown; completionOwner: 'background' | 'caller' }> => {
  assert(isDurableSharedTimelineOperationKind(input.operation.kind), `Shared timeline operation ${input.operation.kind} is not durable.`)
  const entry = await enqueueSharedOutboxOperation({
    projectId: input.projectId,
    userId: input.userId,
    kind: input.operation.kind,
    payload: input.operation.payload,
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

export const enqueueSharedAudioClipCreateOnFailure = async (
  input: { projectId: string; userId: string; assetKey: string; file: File; duration?: number; clipPayload: UploadedAudioClipPayload['clipPayload']; error?: unknown },
) => (await enqueueSharedOutboxOperation({
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
})).id

type ClaimedOutboxEntry = SharedOutboxEntry & { claimToken: string }

type SharedOutboxCompletionResult = {
  result: unknown
  createdAt: number
  expiresAt: number
  completionOwner: 'background' | 'caller'
}

type SharedOutboxOperationResult =
  | { status: 'applied'; result: unknown; completionOwner: 'background' | 'caller' }
  | { status: 'missing' | 'pending' }

const readCompletionResult = (value: unknown): SharedOutboxCompletionResult | null => (
  isRecord(value)
  && typeof value.createdAt === 'number'
  && typeof value.expiresAt === 'number'
  && 'result' in value
    ? {
        result: value.result,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        completionOwner: value.completionOwner === 'caller' ? 'caller' : 'background',
      }
    : null
)

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
  const head = entries.find((entry) => entry.status !== 'dead-letter')
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
  result: unknown,
  completionOwner: 'background' | 'caller',
) => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const current = readEntry((await store.get(keyFor(entry.id)))?.value)
  if (current?.claimToken === entry.claimToken && current.claimOwner === outboxOwner) {
    const timestamp = now()
    const completions = await store.getAll(outboxCompletionKeyRange(projectId, entry.userId))
    const expired = completions.flatMap((row) => {
      const completion = readCompletionResult(row.value)
      return !completion || completion.expiresAt <= timestamp ? [row.key] : []
    })
    for (const key of expired) store.delete(key)
    const active = completions
      .flatMap((row) => {
        const completion = readCompletionResult(row.value)
        return completion && completion.expiresAt > timestamp ? [{ key: row.key, completion }] : []
      })
      .sort((left, right) => left.completion.createdAt - right.completion.createdAt)
    for (const row of active.slice(0, Math.max(0, active.length + 1 - MAX_OUTBOX_COMPLETIONS_PER_USER))) {
      store.delete(row.key)
    }
    store.put({
      key: completionKeyFor(projectId, entry.userId, entry.id),
      value: { result, createdAt: timestamp, expiresAt: timestamp + OUTBOX_COMPLETION_TTL_MS, completionOwner },
      updatedAt: timestamp,
    })
    store.delete(keyFor(entry.id))
  }
  await tx.done
}

const settleClaimedEntryFailure = async (
  projectId: string,
  entry: ClaimedOutboxEntry,
  error: unknown,
) => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const store = tx.objectStore('syncState')
  const current = readEntry((await store.get(keyFor(entry.id)))?.value)
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
      nextAttemptAt: permanent ? timestamp : timestamp + retryDelayMs(attempts),
      lastError,
      claimOwner: undefined,
      claimToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: timestamp,
    }
    store.put({ key: keyFor(current.id), value: settled, updatedAt: timestamp })
  }
  await tx.done
  return isPermanentSharedOperationError(error)
}

const drainSharedOutbox = async (
  projectId: string,
  userId: string,
  options: { retryFailed?: boolean; allowExpiredClaimRecovery: boolean },
  targetOperationId?: string,
  callerCompletionOperationId?: string,
) => {
  const results = new Map<string, unknown>()
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

type WebLocks = {
  request: <T>(name: string, callback: () => Promise<T>) => Promise<T>
}

const webLocks = (): WebLocks | undefined => {
  const locks = Reflect.get(globalThis.navigator ?? {}, 'locks')
  if (
    !locks
    || typeof locks !== 'object'
    || !('request' in locks)
    || typeof locks.request !== 'function'
  ) return undefined
  return locks
}

const withSharedOutboxPublicationLock = async <T>(
  projectId: string,
  userId: string,
  operation: (allowExpiredClaimRecovery: boolean) => Promise<T>,
) => {
  const locks = webLocks()
  if (!locks) {
    if (typeof window !== 'undefined') throw new SharedOutboxUnavailableError()
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
      async (allowExpiredClaimRecovery) => await drainSharedOutbox(
        projectId,
        userId,
        { ...options, allowExpiredClaimRecovery },
      ),
    ),
  )
  return result.summary
}

export const flushSharedOutboxOperation = async (
  projectId: string,
  userId: string,
  operationId: string,
  options: { completionOwner?: 'caller' } = {},
): Promise<SharedOutboxOperationResult> => {
  return await serializeSharedOutboxFlush(projectId, userId, async () => {
    return await withSharedOutboxPublicationLock(projectId, userId, async (allowExpiredClaimRecovery) => {
      const before = (await listEntries(projectId, userId)).find((entry) => entry.id === operationId)
      if (!before) {
        const db = await openLocalProjectDb(projectId)
        const completion = readCompletionResult((await db.get('syncState', completionKeyFor(projectId, userId, operationId)))?.value)
        if (completion && completion.expiresAt > now()) {
          return { status: 'applied' as const, result: completion.result, completionOwner: completion.completionOwner }
        }
        return { status: 'missing' as const }
      }
      if (before.status === 'dead-letter') {
        throw new SharedOutboxRejectedError(operationId, before.lastError ?? 'Shared change was rejected.')
      }
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
      const db = await openLocalProjectDb(projectId)
      const current = readEntry((await db.get('syncState', keyFor(operationId)))?.value)
      if (current?.status === 'dead-letter') {
        throw new SharedOutboxRejectedError(operationId, current.lastError ?? 'Shared change was rejected.')
      }
      const completion = readCompletionResult((await db.get('syncState', completionKeyFor(projectId, userId, operationId)))?.value)
      if (completion && completion.expiresAt > now()) {
        return { status: 'applied' as const, result: completion.result, completionOwner: completion.completionOwner }
      }
      return { status: 'pending' as const }
    })
  })
}

export const readQueuedClipDeletionRecoveryIds = (
  projectId: string,
  userId: string,
  operationId: string,
) => {
  const recoveryIds = new Map<string, string>()
  const read = (entry: HistoryEntry) => {
    if (entry.type === 'section-edit') {
      for (const child of entry.data.entries) read(child)
      return
    }
    if (entry.type !== 'clip-delete') return
    for (const item of entry.data.items) {
      if (
        item.clip.recoveryOperationId === operationId
        && typeof item.clip.recoverySourceClipId === 'string'
        && typeof item.clip.recoveryId === 'string'
      ) recoveryIds.set(item.clip.recoverySourceClipId, item.clip.recoveryId)
    }
  }
  const history = loadHistory({ projectId, userId })
  for (const entry of [...history.undo, ...history.redo]) read(entry)
  return recoveryIds
}
