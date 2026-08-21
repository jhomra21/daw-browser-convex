import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  controlApprovalResultSchemaV1,
  controlCapabilitiesSchemaV1,
  controlCapabilitiesSchemaV2,
  controlCommitResultSchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewResultSchemaV1,
  controlRecoveriesResultSchemaV1,
  projectSnapshotSchemaV1,
  projectSnapshotSchemaV2,
  projectCurrentResultSchema,
  projectListResultSchema,
} from "@daw-browser/control"
import type { ControlMcpScope, ControlService } from "@daw-browser/control-mcp"
import { controlServiceFromCanonicalMethods, createControlMcpServer } from "@daw-browser/control-mcp"
import { ControlTransportError, createCanonicalControlMethodsFromLegacy, createControlClient } from "@daw-browser/control-sdk"
import {
  desktopDiagnosticsSchemaV1,
  desktopHostExportCancelInputSchemaV1,
  desktopHostExportRunInputSchemaV1,
  desktopHostExportRunResultSchemaV1,
  desktopHostExportStatusSchemaV1,
  desktopHostImportInputSchemaV1,
  desktopHostImportResultSchemaV1,
  desktopHostStatusSchemaV1,
  desktopHostVstInstancesInputSchemaV1,
  desktopHostVstInstancesResultSchemaV1,
  desktopHostVstParametersInputSchemaV1,
  desktopHostVstParametersResultSchemaV1,
  desktopSeekInputSchemaV1,
  desktopTransportStatusSchemaV1,
  hostError,
  type DesktopJsonValue,
  type DesktopOperationV1,
} from "@daw-browser/desktop-protocol"
import { createAccessTokenProvider } from "./auth"
import { credentialIdentity, createCredentialStore, sameCredentialIdentity, type ControlCredentialIdentity, type ControlCredentials } from "./credentials"
import { createAvailableHostClient } from "./host"

class CloudControlError extends Error {
  readonly data = {
    version: "v1" as const,
    code: "authorization" as const,
    message: "Cloud control credentials are unavailable.",
  }
}

class CloudControlTransportError extends Error {
  readonly data = hostError("unavailable", "Cloud control service is unavailable.")

  constructor() {
    super("Cloud control service is unavailable.")
    this.name = "CloudControlTransportError"
  }
}

type ControlCredentialReader = {
  read: () => Promise<ControlCredentials | undefined>
}

export const authorizeControlMcpScope = async (
  scope: ControlMcpScope,
  expectedIdentity: ControlCredentialIdentity,
  store: ControlCredentialReader,
) => {
  if (scope === "control:read") return true
  const credentials = await store.read()
  return credentials !== undefined
    && sameCredentialIdentity(expectedIdentity, credentials)
    && credentials.scopes.includes("control:write")
}

export const startControlMcp = async () => {
  const store = createCredentialStore()
  let cloudCredentialIdentity: ControlCredentialIdentity | undefined
  const readCloudCredentials = async () => {
    let credentials: ControlCredentials | undefined
    try {
      credentials = await store.read()
    } catch {
      throw new CloudControlError()
    }
    if (!credentials) throw new CloudControlError()
    if (cloudCredentialIdentity !== undefined && !sameCredentialIdentity(cloudCredentialIdentity, credentials)) {
      throw new CloudControlError()
    }
    const identity = credentialIdentity(credentials)
    cloudCredentialIdentity ??= identity
    return { credentials, identity }
  }
  const cloudService = async (_scope: ControlMcpScope): Promise<ControlService> => {
    const { credentials, identity } = await readCloudCredentials()
    const client = createControlClient({
      baseUrl: credentials.baseUrl,
      accessToken: createAccessTokenProvider(identity, store),
    })
    const withTransportBoundary = async <Value>(request: () => Promise<Value>) => {
      try {
        return await request()
      } catch (error) {
        if (error instanceof ControlTransportError) throw new CloudControlTransportError()
        throw error
      }
    }
    const methods = createCanonicalControlMethodsFromLegacy(client)
    return controlServiceFromCanonicalMethods({
      ...methods,
      control: {
        capabilities: (input) => withTransportBoundary(() => methods.control.capabilities(input)),
        snapshot: (input) => withTransportBoundary(() => methods.control.snapshot(input)),
        preview: (input) => withTransportBoundary(() => methods.control.preview(input)),
        requestApproval: (input) => withTransportBoundary(() => methods.control.requestApproval(input)),
        commit: (input) => withTransportBoundary(() => methods.control.commit(input)),
        history: (input) => withTransportBoundary(() => methods.control.history(input)),
        recoveries: (input) => withTransportBoundary(() => methods.control.recoveries(input)),
      },
    })
  }
  const hostService = async (): Promise<{ service: ControlService; close: () => void }> => {
    const client = await createAvailableHostClient()
    const service: ControlService = {
      projects: {
        list: async () => {
          const status = desktopHostStatusSchemaV1.parse(await client.request("host.status", {}))
          return projectListResultSchema.parse({
            projects: status.project ? [{ projectId: status.project.id }] : [],
          })
        },
        current: async () => {
          const status = desktopHostStatusSchemaV1.parse(await client.request("host.status", {}))
          return projectCurrentResultSchema.parse(status.project
            ? { status: "present", project: { projectId: status.project.id } }
            : { status: "absent" })
        },
      },
      capabilities: async () => controlCapabilitiesSchemaV1.parse(await client.request("control.capabilities", {})),
      capabilitiesV2: async () => controlCapabilitiesSchemaV2.parse(await client.requestV2("control.capabilities", {})),
      snapshot: async (input) => projectSnapshotSchemaV1.parse(await client.request("control.snapshot", input)),
      snapshotV2: async (input) => projectSnapshotSchemaV2.parse(await client.requestV2("control.snapshot", input)),
      preview: async (input) => controlPreviewResultSchemaV1.parse(await client.request("control.preview", JSON.parse(JSON.stringify(input)))),
      requestApproval: async (input) => controlApprovalResultSchemaV1.parse(await client.request("control.requestApproval", JSON.parse(JSON.stringify(input)))),
      commit: async (input) => controlCommitResultSchemaV1.parse(await client.request("control.commit", JSON.parse(JSON.stringify(input)))),
      history: async (input) => controlHistoryResultSchemaV1.parse(await client.request("control.history", input)),
      recoveries: async (input) => controlRecoveriesResultSchemaV1.parse(await client.request("control.recoveries", input)),
    }
    return {
      service,
      close: client.close,
    }
  }
  const requestHostTool = async <Value>(
    operation: DesktopOperationV1,
    input: DesktopJsonValue,
    parseResult: (value: DesktopJsonValue) => Value,
  ) => {
    const client = await createAvailableHostClient()
    try {
      return parseResult(await client.request(operation, input))
    } finally {
      client.close()
    }
  }
  const hostTools = {
    status: async () => requestHostTool("host.status", {}, desktopHostStatusSchemaV1.parse),
    transportStatus: async () => requestHostTool("transport.status", {}, desktopTransportStatusSchemaV1.parse),
    play: async () => requestHostTool("transport.play", {}, desktopTransportStatusSchemaV1.parse),
    pause: async () => requestHostTool("transport.pause", {}, desktopTransportStatusSchemaV1.parse),
    stop: async () => requestHostTool("transport.stop", {}, desktopTransportStatusSchemaV1.parse),
    seek: async (input: Parameters<typeof desktopSeekInputSchemaV1.parse>[0]) => requestHostTool(
      "transport.seek",
      desktopSeekInputSchemaV1.parse(input),
      desktopTransportStatusSchemaV1.parse,
    ),
    diagnostics: async () => requestHostTool("diagnostics.snapshot", {}, desktopDiagnosticsSchemaV1.parse),
    importAudio: async (input: Parameters<typeof desktopHostImportInputSchemaV1.parse>[0]) => requestHostTool(
      "host.import.audio",
      desktopHostImportInputSchemaV1.parse(input),
      desktopHostImportResultSchemaV1.parse,
    ),
    exportRun: async (input: Parameters<typeof desktopHostExportRunInputSchemaV1.parse>[0]) => requestHostTool(
      "host.export.run",
      desktopHostExportRunInputSchemaV1.parse(input),
      desktopHostExportRunResultSchemaV1.parse,
    ),
    exportStatus: async () => requestHostTool("host.export.status", {}, desktopHostExportStatusSchemaV1.parse),
    exportCancel: async (input: Parameters<typeof desktopHostExportCancelInputSchemaV1.parse>[0]) => requestHostTool(
      "host.export.cancel",
      desktopHostExportCancelInputSchemaV1.parse(input),
      desktopHostExportStatusSchemaV1.parse,
    ),
    vstInstances: async (input: Parameters<typeof desktopHostVstInstancesInputSchemaV1.parse>[0]) => requestHostTool(
      "host.vst.instances",
      desktopHostVstInstancesInputSchemaV1.parse(input),
      desktopHostVstInstancesResultSchemaV1.parse,
    ),
    vstParameters: async (input: Parameters<typeof desktopHostVstParametersInputSchemaV1.parse>[0]) => requestHostTool(
      "host.vst.parameters",
      desktopHostVstParametersInputSchemaV1.parse(input),
      desktopHostVstParametersResultSchemaV1.parse,
    ),
  }
  const server = createControlMcpServer(undefined, {
    authorize: async (scope) => {
      const { credentials } = await readCloudCredentials()
      return credentials.scopes.includes(scope)
    },
    hostTools,
    hostService,
    cloudService,
  })
  const transport = new StdioServerTransport()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await transport.close()
    await server.close()
  }
  process.once("SIGINT", () => { void close().finally(() => process.exit(0)) })
  process.once("SIGTERM", () => { void close().finally(() => process.exit(0)) })
  transport.onerror = () => { void close() }
  transport.onclose = () => { void close() }
  await server.connect(transport)
}
