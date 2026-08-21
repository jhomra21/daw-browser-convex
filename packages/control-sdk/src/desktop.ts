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
import {
  createAvailableDesktopHostClient,
  type DesktopHostClientOptions,
} from "@daw-browser/desktop-protocol/client"
import { desktopHostStatusSchemaV1, maxDeadlineMs } from "@daw-browser/desktop-protocol"

export type DesktopControlConnectionOptions = {
  clientName?: string
  userDataDirectory?: string
  actorPath?: string
  handshakeDeadlineMs?: number
  requestDeadlineMs?: number
}

const defaultClientName = "daw-control-sdk"
const deadline = (value: number | undefined, name: string) => {
  const resolved = value ?? (name === "handshakeDeadlineMs" ? 5_000 : 10_000)
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maxDeadlineMs) {
    throw new Error(`${name} must be a positive integer no greater than ${maxDeadlineMs}.`)
  }
  return resolved
}

const clientName = (value: string | undefined) => {
  const resolved = value ?? defaultClientName
  if (resolved.length < 1 || resolved.length > 128) {
    throw new Error("clientName must contain between 1 and 128 characters.")
  }
  return resolved
}

const rawOptions = (options: DesktopControlConnectionOptions): DesktopHostClientOptions => ({
  clientName: clientName(options.clientName),
  userDataDirectory: options.userDataDirectory,
  actorPath: options.actorPath,
  handshakeDeadlineMs: deadline(options.handshakeDeadlineMs, "handshakeDeadlineMs"),
  requestDeadlineMs: deadline(options.requestDeadlineMs, "requestDeadlineMs"),
})

export const connectDesktopControl = async (
  options: DesktopControlConnectionOptions = {},
): Promise<{ invoker: ControlInvoker<"desktop">; close: () => void }> => {
  const host = await createAvailableDesktopHostClient(rawOptions(options))
  let closed = false
  try {
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
    const invoker = createDirectControlInvoker({
      handlers,
      context: { target: "desktop", principal: { subject: "daw-control" } },
    })
    const close = () => {
      if (closed) return
      closed = true
      host.close()
    }
    return { invoker, close }
  } catch (error) {
    host.close()
    throw error
  }
}