import { z } from 'zod'
import {
  assert,
  isDurableSharedTimelineOperationKind,
  type JsonValue,
} from '@daw-browser/shared'
import type { SharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import type { SharedOutboxCompletion } from '~/lib/shared-outbox-entry'
import { isCapabilityFile } from '~/lib/capability-file'
import { materializeLocalRetryFile, removeLocalRetryFile } from '~/lib/local-assets'
import type { UploadedAudioClipPayload } from '~/lib/shared-outbox-uploaded-audio'
import {
  consumeSharedOutboxCompletion,
  enqueueSharedOutboxOperation,
  flushSharedOutboxOperation,
  isPermanentSharedOperationError,
  SharedOutboxQueuedError,
  SharedOutboxRejectedError,
} from '~/lib/shared-outbox'

const serializeDurableOperationPayload = (payload: SharedTimelineOperation['payload']) => (
  z.json().parse(JSON.parse(JSON.stringify(payload)))
)

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
