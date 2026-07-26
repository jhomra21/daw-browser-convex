import type {
  SharedTimelineOperation,
} from '@daw-browser/shared'

export type {
  SharedTimelineOperation,
  SharedTimelineOperationKind,
} from '@daw-browser/shared'

export class SharedTimelineOperationHttpError extends Error {
  constructor(public readonly status: number, detail?: string) {
    super(detail ? `Shared timeline operation failed: ${status} ${detail}` : `Shared timeline operation failed: ${status}`)
    this.name = 'SharedTimelineOperationHttpError'
  }
}

export class SharedTimelineOperationRejectedError extends Error {
  constructor(detail?: string) {
    super(detail ?? 'Shared timeline operation was rejected.')
    this.name = 'SharedTimelineOperationRejectedError'
  }
}

export const isAppliedSharedTimelineOperationResult = (value: unknown) => (
  typeof value === 'object' && value !== null && 'status' in value && value.status === 'applied'
)

export const assertAppliedSharedTimelineOperationResult = (result: unknown) => {
  if (!isAppliedSharedTimelineOperationResult(result)) {
    throw new Error('Shared timeline operation was not applied.')
  }
}

const assertValidClipCreateResult = (
  operation: SharedTimelineOperation,
  result: unknown,
) => {
  if (operation.kind === 'clips.create' && result === null) {
    throw new SharedTimelineOperationRejectedError('Clip creation was rejected.')
  }
  if (
    operation.kind === 'clips.createMany'
    && (
      !Array.isArray(result)
      || result.length !== operation.payload.items.length
      || result.some((item) => item === null)
    )
  ) {
    throw new SharedTimelineOperationRejectedError('One or more clip creations were rejected.')
  }
}

export const publishSharedTimelineOperation = async (
  projectId: string,
  operation: SharedTimelineOperation,
  options?: { fetch?: typeof fetch },
): Promise<unknown> => {
  const response = await (options?.fetch ?? fetch)(`/api/projects/${encodeURIComponent(projectId)}/timeline/operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(operation),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new SharedTimelineOperationHttpError(response.status, detail || undefined)
  }
  const result = await response.json().catch(() => null)
  if (
    typeof result === 'object'
    && result !== null
    && 'status' in result
    && result.status === 'rejected'
  ) {
    const detail = (
      typeof result === 'object'
      && result !== null
      && 'reason' in result
      && typeof result.reason === 'string'
    ) ? result.reason : undefined
    throw new SharedTimelineOperationRejectedError(detail)
  }
  assertValidClipCreateResult(operation, result)
  return result
}

export const buildSharedTrackCreateOperation = (
  payload: Omit<Extract<SharedTimelineOperation, { kind: 'tracks.create' }>['payload'], 'operationId'>,
): Extract<SharedTimelineOperation, { kind: 'tracks.create' }> => ({
  kind: 'tracks.create',
  payload: { ...payload, operationId: crypto.randomUUID() },
})

export const buildSharedClipCreateOperation = (
  payload: Omit<Extract<SharedTimelineOperation, { kind: 'clips.create' }>['payload'], 'operationId'>,
): Extract<SharedTimelineOperation, { kind: 'clips.create' }> => ({
  kind: 'clips.create',
  payload: { ...payload, operationId: crypto.randomUUID() },
})

export const buildSharedClipCreateManyOperation = (
  payload: Omit<Extract<SharedTimelineOperation, { kind: 'clips.createMany' }>['payload'], 'operationId'>,
  operationId: string,
): Extract<SharedTimelineOperation, { kind: 'clips.createMany' }> => ({
  kind: 'clips.createMany',
  payload: { ...payload, operationId },
})
