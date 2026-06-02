import type {
  SharedTimelineOperation,
  SharedTimelineOperationKind,
} from '~/lib/shared-timeline-operations'

export type {
  SharedTimelineOperation,
  SharedTimelineOperationKind,
} from '~/lib/shared-timeline-operations'

export class SharedTimelineOperationHttpError extends Error {
  constructor(public readonly status: number, detail?: string) {
    super(detail ? `Shared timeline operation failed: ${status} ${detail}` : `Shared timeline operation failed: ${status}`)
    this.name = 'SharedTimelineOperationHttpError'
  }
}

export const publishSharedTimelineOperationParts = async (
  projectId: string,
  kind: SharedTimelineOperationKind,
  payload: unknown,
): Promise<unknown> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/timeline/operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, payload }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new SharedTimelineOperationHttpError(response.status, detail || undefined)
  }
  return await response.json().catch(() => null)
}

export const publishSharedTimelineOperation = async (
  projectId: string,
  operation: SharedTimelineOperation,
): Promise<unknown> => await publishSharedTimelineOperationParts(projectId, operation.kind, operation.payload)

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
