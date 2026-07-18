import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { ControlService } from "@daw-browser/control-mcp"
import { createControlMcpServer } from "@daw-browser/control-mcp"
import { createControlClient } from "@daw-browser/control-sdk"
import { createAccessTokenProvider } from "./auth"
import { credentialIdentity, createCredentialStore } from "./credentials"
import { createHostClient } from "./host"

export const startControlMcp = async () => {
  const store = createCredentialStore()
  const credentials = await store.read()
  if (!credentials) throw new Error("Run daw-control auth login first.")
  const accessToken = createAccessTokenProvider(credentialIdentity(credentials), store)
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
    status: () => hostClient.request("host.status", {}),
    transportStatus: () => hostClient.request("transport.status", {}),
    play: () => hostClient.request("transport.play", {}),
    pause: () => hostClient.request("transport.pause", {}),
    stop: () => hostClient.request("transport.stop", {}),
    seek: (input: { seconds: number }) => hostClient.request("transport.seek", input),
    diagnostics: () => hostClient.request("diagnostics.snapshot", {}),
  }
  const server = createControlMcpServer(service, {
    authorize: (scope) => scope === "control:read" || credentials.scopes.includes("control:write"),
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
