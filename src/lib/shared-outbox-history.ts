import { loadHistory, saveHistory } from '~/lib/timeline-storage'
import { buildCommittedSharedUngroupHistoryEntry, readSharedUngroupResult } from '~/lib/undo/shared-ungroup-history'
import type { HistoryEntry } from '~/lib/undo/types'
import type { JsonValue } from '@daw-browser/shared'
import type { SharedOutboxEntry } from '~/lib/shared-outbox-entry'
import { z } from 'zod'

export type SharedOutboxHistoryUpdate =
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

export const completeUngroup = (entry: SharedOutboxEntry, result: JsonValue) => {
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

const clipDeletionResultSchema = z.object({
  recoveries: z.array(z.object({
    sourceClipId: z.string(),
    recoveryId: z.string(),
  })),
  removedClipIds: z.array(z.string()),
})

const clipDeletionPayloadSchema = z.object({
  clipIds: z.array(z.string()),
})

export const attachQueuedClipDeletionRecoveries = (entry: SharedOutboxEntry, result: JsonValue) => {
  if (entry.kind !== 'clips.removeMany') return
  const parsedResult = clipDeletionResultSchema.safeParse(result)

  if (!parsedResult.success) return
  const parsedPayload = clipDeletionPayloadSchema.safeParse(entry.payload)

  if (!parsedPayload.success) {
    throw new Error('Queued clip deletion is missing clip IDs.')
  }

  const recoveries = parsedResult.data.recoveries
  const removedClipIds = parsedResult.data.removedClipIds
  const expectedClipIds = parsedPayload.data.clipIds

  if (
    expectedClipIds.length === 0
    || new Set(expectedClipIds).size !== expectedClipIds.length
    || removedClipIds.length !== expectedClipIds.length
    || new Set(removedClipIds).size !== removedClipIds.length
    || !expectedClipIds.every((clipId) => removedClipIds.includes(clipId))
    || recoveries.length !== expectedClipIds.length
  ) throw new Error('Queued clip deletion did not return a complete recovery result.')
  const recoveryIdBySourceClipId = new Map<string, string>()

  for (const recovery of recoveries) {
    recoveryIdBySourceClipId.set(recovery.sourceClipId, recovery.recoveryId)
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
        && item.clip.recoverySourceClipId !== undefined
        && item.clip.recoveryId !== undefined
      ) recoveryIds.set(item.clip.recoverySourceClipId, item.clip.recoveryId)
    }
  }

  const history = loadHistory({ projectId, userId })

  for (const entry of [...history.undo, ...history.redo]) read(entry)

  return recoveryIds
}
