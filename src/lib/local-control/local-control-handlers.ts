import {
  canonicalLocalControlCapabilities,
  canonicalProjectSnapshotSchema,
  controlApprovalResultSchemaV1,
  controlCommitResultSchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewResultSchemaV1,
  controlRecoveriesResultSchemaV1,
  projectCurrentResultSchema,
  projectListResultSchema,
  type ControlErrorV1,
  type ControlOperationHandlers,
} from '@daw-browser/control'
import { getLocalProject } from '~/lib/local-project-db'
import { serializeJsonValue } from '~/lib/json'
import { createLocalControlService, LocalControlServiceError } from './local-control-service'

const boundProjectError = (projectId: string): LocalControlServiceError => (
  new LocalControlServiceError({
    version: 'v1',
    code: 'invalid-request',
    message: `The requested project is not the mounted local project: ${projectId}.`,
  } satisfies ControlErrorV1)
)

export const createLocalControlHandlers = (input: {
  projectId: string
  actor: { subject: string; issuer?: string; tokenIdentifier?: string }
  assertAvailable?: () => void
}) => {
  const service = createLocalControlService(input)
  const assertBoundProject = (requestedProjectId: string) => {
    if (requestedProjectId !== input.projectId) throw boundProjectError(input.projectId)
  }

  return {
    'project.list': async () => {
      const project = await getLocalProject(input.projectId)
      return projectListResultSchema.parse({
        projects: project === undefined ? [] : [{ projectId: project.id, name: project.name }],
      })
    },
    'project.current': async () => {
      const project = await getLocalProject(input.projectId)
      return projectCurrentResultSchema.parse(project === undefined
        ? { status: 'absent' }
        : { status: 'present', project: { projectId: project.id, name: project.name } })
    },
    'control.capabilities': () => canonicalLocalControlCapabilities,
    'control.snapshot': async (request) => {
      assertBoundProject(request.projectId)
      return canonicalProjectSnapshotSchema.parse(await service.snapshotV2(request))
    },
    'control.preview': async (request) => {
      assertBoundProject(request.projectId)
      return controlPreviewResultSchemaV1.parse(await service.preview(serializeJsonValue(request)))
    },
    'control.requestApproval': async (request) => {
      assertBoundProject(request.projectId)
      return controlApprovalResultSchemaV1.parse(await service.requestApproval(serializeJsonValue(request)))
    },
    'control.commit': async (request) => {
      assertBoundProject(request.projectId)
      return controlCommitResultSchemaV1.parse(await service.commit(serializeJsonValue(request)))
    },
    'control.history': async (request) => {
      assertBoundProject(request.projectId)
      return controlHistoryResultSchemaV1.parse(await service.history(request))
    },
    'control.recoveries': async (request) => {
      assertBoundProject(request.projectId)
      return controlRecoveriesResultSchemaV1.parse(await service.recoveries(request))
    },
  } satisfies ControlOperationHandlers<'desktop'>
}
