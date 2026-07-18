import { openLocalProjectDb, type LocalProjectSyncStateRow } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { assert, isDurableSharedTimelineOperationKind, parseSharedTimelineOperation, readSharedTimelineClipCreatePayload, type SharedTimelineClipCreatePayload } from '@daw-browser/shared'
import {
  publishSharedTimelineOperation,
  SharedTimelineOperationHttpError,
  type SharedTimelineOperation,
  type SharedTimelineOperationKind,
} from '~/lib/shared-timeline-operations-api'
import type { Track } from '@daw-browser/timeline-core/types'
import { loadHistory, saveHistory } from '~/lib/timeline-storage'
import { buildCommittedSharedUngroupHistoryEntry, readSharedUngroupResult } from '~/lib/undo/shared-ungroup-history'
import type { HistoryEntry, TrackAutomationSnapshot, TrackEffectSnapshot } from '~/lib/undo/types'

type SharedOutboxStatus = 'pending' | 'failed'
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

let sharedOutboxHistoryHandler: ((entry: HistoryEntry) => boolean) | undefined

export const registerSharedOutboxHistoryHandler = (handler: (entry: HistoryEntry) => boolean) => {
  sharedOutboxHistoryHandler = handler
  return () => {
    if (sharedOutboxHistoryHandler === handler) sharedOutboxHistoryHandler = undefined
  }
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
  if (sharedOutboxHistoryHandler?.(historyEntry)) return
  const scope = { projectId: entry.projectId, userId: entry.userId }
  const history = loadHistory(scope)
  saveHistory(scope, { undo: [...history.undo, historyEntry].slice(-50), redo: [] })
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
  readonly operationId?: string

  constructor(kind: SharedOutboxKind, operationId?: string) {
    super(`${kind} queued for retry`)
    this.name = 'SharedOutboxQueuedError'
    this.operationId = operationId
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
const outboxKeyRange = () => IDBKeyRange.bound(OUTBOX_PREFIX, `${OUTBOX_PREFIX}\uffff`)

const readOutboxRows = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  return await db.getAll('syncState', outboxKeyRange())
}

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
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

const summarizeOutboxRows = (rows: LocalProjectSyncStateRow[], userId: string) => (
  readOutboxEntries(rows, userId).reduce<SharedOutboxSummary>((acc, entry) => {
    return entry.status === 'failed'
      ? { ...acc, failed: acc.failed + 1 }
      : { ...acc, pending: acc.pending + 1 }
  }, { pending: 0, failed: 0 })
)

const readOutboxEntries = (rows: LocalProjectSyncStateRow[], userId: string) => (
  rows
    .flatMap((row) => {
      const entry = readEntry(row.value)
      return entry && entry.userId === userId ? [entry] : []
    })
)

const writeSummary = async (projectId: string, userId: string, rows?: LocalProjectSyncStateRow[]) => {
  const db = await openLocalProjectDb(projectId)
  const source = rows ?? await readOutboxRows(projectId)
  const summary = summarizeOutboxRows(source, userId)
  await db.put('syncState', { key: OUTBOX_STATUS_KEY, value: summary, updatedAt: now() })
  notifyLocalProjectChanged(projectId)
  return summary
}

const readUploadedAudioClipPayload = (value: unknown): UploadedAudioClipPayload | null => {
  if (!isRecord(value)) return null
  const clipPayload = readSharedTimelineClipCreatePayload(value.clipPayload, { requireAudioSampleUrl: false })
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
  const entry: SharedOutboxEntry = {
    id: crypto.randomUUID(),
    kind: input.kind,
    projectId: input.projectId,
    userId: input.userId,
    payload: input.payload,
    completion: input.completion,
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
  return readOutboxEntries(await readOutboxRows(projectId), userId)
    .sort((left, right) => left.createdAt - right.createdAt)
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
  const operation = parseSharedTimelineOperation({ kind: entry.kind, payload: entry.payload })
  if (!operation) throw new Error('Invalid queued shared timeline operation.')
  const result = await publishSharedTimelineOperation(entry.projectId, operation)
  completeUngroup(entry, result)
}

export const enqueueSharedTimelineOperationOnFailure = async (
  input: { projectId: string; userId: string; operation: SharedTimelineOperation; error?: unknown; completion?: SharedOutboxCompletion },
) => {
  assert(isDurableSharedTimelineOperationKind(input.operation.kind), `Shared timeline operation ${input.operation.kind} is not durable.`)
  await enqueueSharedOutboxOperation({
    projectId: input.projectId,
    userId: input.userId,
    kind: input.operation.kind,
    payload: input.operation.payload,
    error: input.error,
    completion: input.completion,
  })
}

export const publishDurableSharedTimelineOperation = async <T = undefined>(
  input: {
    projectId: string
    userId: string
    operation: SharedTimelineOperation
    queuedResult?: T
    throwQueued?: boolean
    completion?: SharedOutboxCompletion
  },
): Promise<unknown | T | undefined> => {
  assert(isDurableSharedTimelineOperationKind(input.operation.kind), `Shared timeline operation ${input.operation.kind} is not durable.`)
  return await publishSharedTimelineOperation(
    input.projectId,
    input.operation,
  ).catch(async (error) => {
    if (!shouldQueueSharedOperationError(error)) throw error
    await enqueueSharedTimelineOperationOnFailure(input)
    if (input.throwQueued) throw new SharedOutboxQueuedError(input.operation.kind)
    return input.queuedResult
  })
}

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
