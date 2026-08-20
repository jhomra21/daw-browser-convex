import {
  canonicalControlCapabilities,
  canonicalProjectSnapshotSchema,
  controlApprovalResultSchemaV1,
  controlCommitResultSchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewResultSchemaV1,
  controlRecoveriesResultSchemaV1,
  projectListResultSchema,
  type ControlOperationHandlers,
  type ControlRequestContext,
} from '@daw-browser/control'
import { api as convexApi } from '../convex/_generated/api'
import type { createControlConvexClient } from './convex-auth'

export type ControlGateway = Pick<
  Awaited<ReturnType<typeof createControlConvexClient>>,
  'query' | 'mutation'
>

export const createCloudControlHandlers = (input: {
  gateway?: ControlGateway
}) => {
  const invoke = (_context: ControlRequestContext) => {
    if (!input.gateway) throw new Error('Cloud control gateway is unavailable.')
    return input.gateway
  }
  return {
    'project.list': async (_request, context) => (
      projectListResultSchema.parse({
        projects: await invoke(context).query(convexApi.projects.listMineDetailed, {}),
      })
    ),
    'control.capabilities': () => canonicalControlCapabilities,
    'control.snapshot': async (request, context) => (
      canonicalProjectSnapshotSchema.parse(await invoke(context).query(convexApi.control.snapshotV2, {
        projectId: request.projectId,
      }))
    ),
    'control.preview': async (request, context) => (
      controlPreviewResultSchemaV1.parse(await invoke(context).query(convexApi.control.previewV1, { request }))
    ),
    'control.requestApproval': async (request, context) => (
      controlApprovalResultSchemaV1.parse(await invoke(context).mutation(convexApi.control.requestApprovalV1, { request }))
    ),
    'control.commit': async (request, context) => (
      controlCommitResultSchemaV1.parse(await invoke(context).mutation(convexApi.control.commitV1, { request }))
    ),
    'control.history': async (request, context) => (
      controlHistoryResultSchemaV1.parse(await invoke(context).query(convexApi.control.historyV1, request))
    ),
    'control.recoveries': async (request, context) => (
      controlRecoveriesResultSchemaV1.parse(await invoke(context).query(convexApi.control.recoveriesV1, request))
    ),
  } satisfies ControlOperationHandlers<'cloud'>
}
