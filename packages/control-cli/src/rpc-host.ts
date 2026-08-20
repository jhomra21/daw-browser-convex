import {
  canonicalControlCapabilitiesSchema,
  canonicalLocalControlCapabilities,
  canonicalProjectSnapshotSchema,
  projectCanonicalProjectSnapshotV2,
  projectSnapshotSchemaV1,
  controlApprovalResultSchemaV1,
  controlCommitResultSchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewResultSchemaV1,
  controlRecoveriesResultSchemaV1,
  createDirectControlInvoker,
  controlApprovalRequestSchemaV1,
  controlCommitRequestSchemaV1,
  controlHistoryQuerySchemaV1,
  controlPreviewRequestSchemaV1,
  controlRecoveriesQuerySchemaV1,
  controlSnapshotQuerySchemaV1,
  projectCurrentResultSchema,
  projectListResultSchema,
  type ControlInvoker,
  type ControlOperationHandlers,
} from "@daw-browser/control"
import { createCanonicalControlClient, type CanonicalControlClient } from "@daw-browser/control-sdk"
import { desktopHostStatusSchemaV1 } from "@daw-browser/desktop-protocol"
import { createHostClient } from "./host"

export const createHostCanonicalClient = async (): Promise<{
  client: CanonicalControlClient<"desktop">
  invoker: ControlInvoker<"desktop">
  close: () => void
}> => {
  const host = await createHostClient()
  const status = async () => host.request("host.status", {})
  const handlers: ControlOperationHandlers<"desktop"> = {
    "project.list": async () => {
      const result = desktopHostStatusSchemaV1.parse(await status())
      return projectListResultSchema.parse({
        projects: result.project ? [{ projectId: result.project.id }] : [],
      })
    },
    "project.current": async () => {
      const result = desktopHostStatusSchemaV1.parse(await status())
      return projectCurrentResultSchema.parse(result.project
        ? { status: "present", project: { projectId: result.project.id } }
        : { status: "absent" })
    },
    "control.capabilities": async () => host.protocolVersion === "v2"
      ? canonicalControlCapabilitiesSchema.parse(await host.requestV2("control.capabilities", {}))
      : canonicalLocalControlCapabilities,
    "control.snapshot": async (input) => canonicalProjectSnapshotSchema.parse(
      host.protocolVersion === "v2"
        ? await host.requestV2("control.snapshot", controlSnapshotQuerySchemaV1.parse(input))
        : projectCanonicalProjectSnapshotV2(projectSnapshotSchemaV1.parse(
          await host.request("control.snapshot", controlSnapshotQuerySchemaV1.parse(input)),
        )),
    ),
    "control.preview": async (input) => controlPreviewResultSchemaV1.parse(
      await host.request("control.preview", JSON.parse(JSON.stringify(controlPreviewRequestSchemaV1.parse(input)))),
    ),
    "control.requestApproval": async (input) => controlApprovalResultSchemaV1.parse(
      await host.request("control.requestApproval", JSON.parse(JSON.stringify(controlApprovalRequestSchemaV1.parse(input)))),
    ),
    "control.commit": async (input) => controlCommitResultSchemaV1.parse(
      await host.request("control.commit", JSON.parse(JSON.stringify(controlCommitRequestSchemaV1.parse(input)))),
    ),
    "control.history": async (input) => controlHistoryResultSchemaV1.parse(
      await host.request("control.history", controlHistoryQuerySchemaV1.parse(input)),
    ),
    "control.recoveries": async (input) => controlRecoveriesResultSchemaV1.parse(
      await host.request("control.recoveries", controlRecoveriesQuerySchemaV1.parse(input)),
    ),
  }
  const invoker: ControlInvoker<"desktop"> = createDirectControlInvoker({
    handlers,
    context: { target: "desktop", principal: { subject: "daw-control" } },
  })
  return { client: createCanonicalControlClient(invoker), invoker, close: host.close }
}
