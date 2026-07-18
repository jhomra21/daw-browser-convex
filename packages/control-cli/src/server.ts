import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { ControlMcpScope, ControlService } from "@daw-browser/control-mcp"
import { createControlMcpServer } from "@daw-browser/control-mcp"
import { createControlClient } from "@daw-browser/control-sdk"
import { createAccessTokenProvider } from "./auth"
import { credentialIdentity, createCredentialStore, sameCredentialIdentity, type ControlCredentialIdentity, type ControlCredentials } from "./credentials"
import { createHostClient } from "./host"

type ControlCredentialReader = {
  read: () => Promise<ControlCredentials | undefined>
}

export const authorizeControlMcpScope = async (
  scope: ControlMcpScope,
  startupCredentialIdentity: ControlCredentialIdentity,
  store: ControlCredentialReader,
) => {
  if (scope === "control:read") return true
  const current = await store.read()
  return current !== undefined
    && sameCredentialIdentity(startupCredentialIdentity, current)
    && current.scopes.includes("control:write")
}

export const startControlMcp = async () => {
  const store = createCredentialStore()
  const credentials = await store.read()
  if (!credentials) throw new Error("Run daw-control auth login first.")
  const startupCredentialIdentity = credentialIdentity(credentials)
  const accessToken = createAccessTokenProvider(startupCredentialIdentity, store)
  const client = createControlClient({ baseUrl: credentials.baseUrl, accessToken })
  const service: ControlService = {
    capabilities: client.capabilities,
    snapshot: async ({ projectId }) => client.snapshot(projectId),
    preview: client.preview,
    requestApproval: client.requestApproval,
    commit: client.commit,
    history: client.history,
    recoveries: client.recoveries,
  }
  const hostClient = await createHostClient().catch(() => undefined)
  const hostTools = hostClient === undefined ? undefined : {
    operations: hostClient.capabilities(),
    status: () => hostClient.request("host.status", {}),
    transportStatus: () => hostClient.request("transport.status", {}),
    play: () => hostClient.request("transport.play", {}),
    pause: () => hostClient.request("transport.pause", {}),
    stop: () => hostClient.request("transport.stop", {}),
    seek: (input: { seconds: number }) => hostClient.request("transport.seek", input),
    diagnostics: () => hostClient.request("diagnostics.snapshot", {}),
    importAudio: (input: unknown) => hostClient.request("host.import.audio", input),
    exportRun: (input: unknown) => hostClient.request("host.export.run", input),
    exportStatus: () => hostClient.request("host.export.status", {}),
    exportCancel: (input: { jobId: string }) => hostClient.request("host.export.cancel", input),
  }
  const server = createControlMcpServer(service, {
    authorize: (scope) => authorizeControlMcpScope(scope, startupCredentialIdentity, store),
    hostTools,
  })
  const transport = new StdioServerTransport()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await transport.close()
    await server.close()
    hostClient?.close()
  }
  process.once("SIGINT", () => { void close().finally(() => process.exit(0)) })
  process.once("SIGTERM", () => { void close().finally(() => process.exit(0)) })
  transport.onerror = () => { void close() }
  transport.onclose = () => { void close() }
  await server.connect(transport)
}
