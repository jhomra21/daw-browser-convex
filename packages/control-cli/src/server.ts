import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  controlApprovalResultSchemaV1,
  controlCapabilitiesSchemaV1,
  controlCommitResultSchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewResultSchemaV1,
  controlRecoveriesResultSchemaV1,
  projectSnapshotSchemaV1,
} from "@daw-browser/control"
import type { ControlMcpScope, ControlService } from "@daw-browser/control-mcp"
import { createControlMcpServer } from "@daw-browser/control-mcp"
import { createControlClient } from "@daw-browser/control-sdk"
import { createAccessTokenProvider } from "./auth"
import { credentialIdentity, createCredentialStore, sameCredentialIdentity, type ControlCredentialIdentity, type ControlCredentials } from "./credentials"
import { createHostClient } from "./host"

class CloudControlError extends Error {
  readonly data = {
    version: "v1" as const,
    code: "authorization" as const,
    message: "Cloud control credentials are unavailable.",
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
    return {
      capabilities: client.capabilities,
      snapshot: async ({ projectId }) => client.snapshot(projectId),
      preview: client.preview,
      requestApproval: client.requestApproval,
      commit: client.commit,
      history: client.history,
      recoveries: client.recoveries,
    }
  }
  const hostService = async (): Promise<{ service: ControlService; close: () => void }> => {
    const client = await createHostClient()
    const service: ControlService = {
      capabilities: async () => controlCapabilitiesSchemaV1.parse(await client.request("control.capabilities", {})),
      snapshot: async (input) => projectSnapshotSchemaV1.parse(await client.request("control.snapshot", input)),
      preview: async (input) => controlPreviewResultSchemaV1.parse(await client.request("control.preview", input)),
      requestApproval: async (input) => controlApprovalResultSchemaV1.parse(await client.request("control.requestApproval", input)),
      commit: async (input) => controlCommitResultSchemaV1.parse(await client.request("control.commit", input)),
      history: async (input) => controlHistoryResultSchemaV1.parse(await client.request("control.history", input)),
      recoveries: async (input) => controlRecoveriesResultSchemaV1.parse(await client.request("control.recoveries", input)),
    }
    return {
      service,
      close: client.close,
    }
  }
  const hostTools = {
    status: async () => {
      const client = await createHostClient()
      try { return await client.request("host.status", {}) } finally { client.close() }
    },
    transportStatus: async () => {
      const client = await createHostClient()
      try { return await client.request("transport.status", {}) } finally { client.close() }
    },
    play: async () => {
      const client = await createHostClient()
      try { return await client.request("transport.play", {}) } finally { client.close() }
    },
    pause: async () => {
      const client = await createHostClient()
      try { return await client.request("transport.pause", {}) } finally { client.close() }
    },
    stop: async () => {
      const client = await createHostClient()
      try { return await client.request("transport.stop", {}) } finally { client.close() }
    },
    seek: async (input: { seconds: number }) => {
      const client = await createHostClient()
      try { return await client.request("transport.seek", input) } finally { client.close() }
    },
    diagnostics: async () => {
      const client = await createHostClient()
      try { return await client.request("diagnostics.snapshot", {}) } finally { client.close() }
    },
    importAudio: async (input: unknown) => {
      const client = await createHostClient()
      try { return await client.request("host.import.audio", input) } finally { client.close() }
    },
    exportRun: async (input: unknown) => {
      const client = await createHostClient()
      try { return await client.request("host.export.run", input) } finally { client.close() }
    },
    exportStatus: async () => {
      const client = await createHostClient()
      try { return await client.request("host.export.status", {}) } finally { client.close() }
    },
    exportCancel: async (input: { jobId: string }) => {
      const client = await createHostClient()
      try { return await client.request("host.export.cancel", input) } finally { client.close() }
    },
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
