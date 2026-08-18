import {
  controlApprovalResultSchemaV1,
  controlCommitResultSchemaV1,
  controlErrorSchemaV1,
  controlPreviewResultSchemaV1,
  parseControlApprovalRequestV1,
  parseControlCommitRequestV1,
  parseControlPreviewRequestV1,
  projectSnapshotSchemaV2,
  type ControlApprovalRequestV1,
  type ControlCommitRequestV1,
  type ControlPreviewRequestV1,
} from '@daw-browser/control'
import { isLocalId } from '@daw-browser/shared'
import type { convexApi, convexClient } from '~/lib/convex'
import { createLocalControlService, LocalControlServiceError } from '~/lib/local-control/local-control-service'
import { serializeJsonValue } from '~/lib/json'

class ProjectControlError extends Error {
  constructor(readonly data: ReturnType<typeof controlErrorSchemaV1.parse>) {
    super(data.message)
    this.name = 'ProjectControlError'
  }
}

export const isProjectControlRevisionConflict = (cause: unknown) => (
  cause instanceof ProjectControlError && cause.data.code === 'revision-conflict'
)

export const isProjectControlError = (cause: unknown): cause is ProjectControlError => (
  cause instanceof ProjectControlError
)

const localResult = async <Value>(operation: () => Promise<Value>) => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof LocalControlServiceError) throw new ProjectControlError(error.data)
    throw error
  }
}

const parseResult = <Value>(
  cause: unknown,
  schema: { safeParse: (cause: unknown) => { success: true; data: Value } | { success: false } },
): Value => {
  const result = schema.safeParse(cause)
  if (result.success) return result.data
  throw new ProjectControlError(controlErrorSchemaV1.parse(cause))
}

export type ProjectControlClient = {
  snapshotV2: () => Promise<ReturnType<typeof projectSnapshotSchemaV2.parse>>
  previewV1: (request: ControlPreviewRequestV1) => Promise<ReturnType<typeof controlPreviewResultSchemaV1.parse>>
  requestApprovalV1: (request: ControlApprovalRequestV1) => Promise<ReturnType<typeof controlApprovalResultSchemaV1.parse>>
  commitV1: (request: ControlCommitRequestV1) => Promise<ReturnType<typeof controlCommitResultSchemaV1.parse>>
}

export const createProjectControlClient = (input: {
  projectId: string
  userId?: string
  convexClient: typeof convexClient
  convexApi: typeof convexApi
}): ProjectControlClient => {
  if (isLocalId('project', input.projectId)) {
    const local = createLocalControlService({
      actor: { subject: 'local:00000000-0000-4000-8000-000000000000' },
    })
    return {
      snapshotV2: async () => projectSnapshotSchemaV2.parse(await localResult(() => local.snapshotV2({ projectId: input.projectId }))),
      previewV1: async (request) => controlPreviewResultSchemaV1.parse(await localResult(() => local.preview(serializeJsonValue(parseControlPreviewRequestV1(request))))),
      requestApprovalV1: async (request) => controlApprovalResultSchemaV1.parse(await localResult(() => local.requestApproval(serializeJsonValue(parseControlApprovalRequestV1(request))))),
      commitV1: async (request) => controlCommitResultSchemaV1.parse(await localResult(() => local.commit(serializeJsonValue(parseControlCommitRequestV1(request))))),
    }
  }
  return {
    snapshotV2: async () => projectSnapshotSchemaV2.parse(await input.convexClient.query(
      input.convexApi.control.snapshotV2,
      { projectId: input.projectId },
    )),
    previewV1: async (request) => parseResult(
      await input.convexClient.query(input.convexApi.control.previewV1, { request: serializeJsonValue(parseControlPreviewRequestV1(request)) }),
      controlPreviewResultSchemaV1,
    ),
    requestApprovalV1: async (request) => parseResult(
      await input.convexClient.mutation(input.convexApi.control.requestApprovalV1, { request: serializeJsonValue(parseControlApprovalRequestV1(request)) }),
      controlApprovalResultSchemaV1,
    ),
    commitV1: async (request) => parseResult(
      await input.convexClient.mutation(input.convexApi.control.commitV1, { request: serializeJsonValue(parseControlCommitRequestV1(request)) }),
      controlCommitResultSchemaV1,
    ),
  }
}
