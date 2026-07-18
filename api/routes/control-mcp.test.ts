import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { controlCapabilitiesV1 } from "@daw-browser/control"
import type { ControlService } from "@daw-browser/control-mcp"
import type { ApiBindings } from "../app-types"
import type { ControlBearer } from "../control-oauth"
import { registerControlMcpRoutes } from "./control-mcp"

const readBearer: ControlBearer = {
  userId: "user-1",
  issuer: "https://control.example",
  tokenIdentifier: "token-1",
  clientId: "client-1",
  scopes: ["control:read"],
}

const writeBearer: ControlBearer = { ...readBearer, scopes: ["control:read", "control:write"] }

const snapshot = {
  version: "v1",
  project: {
    id: "project-1",
    name: "Project",
    revision: 1,
    tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { enabled: false, startSec: 0, endSec: 8 },
    masterVolume: 0.8,
    updatedAt: 1,
  },
  tracks: [],
  clips: [],
  processors: [],
  automation: [],
  sidechains: [],
}

const controlService = (overrides: Partial<ControlService> = {}): ControlService => ({
  capabilities: async () => controlCapabilitiesV1,
  snapshot: async () => snapshot,
  preview: async () => ({ version: "v1", projectId: "project-1", priorRevision: 1, revision: 2, applied: true, requestDigest: "0".repeat(64), resolvedRefs: [], warnings: [], changeSummary: { actionCount: 1, changes: [] } }),
  commit: async () => ({ version: "v1", projectId: "project-1", priorRevision: 1, revision: 2, applied: true, idempotencyReplay: false, requestDigest: "0".repeat(64), resolvedRefs: [], warnings: [], changeSummary: { actionCount: 1, changes: [] } }),
  history: async () => ({ entries: [], continueCursor: "cursor-1", isDone: true }),
  ...overrides,
})

const app = (
  bearer: ControlBearer | null = writeBearer,
  service = controlService(),
) => {
  const application = new Hono<ApiBindings>()
  registerControlMcpRoutes(application, {
    resolveBearer: async (_request, _environment, scope) => (
      bearer?.scopes.includes(scope) ? bearer : null
    ),
    createGateway: async () => service,
  })
  return application
}

const mcpRequest = (
  body: unknown,
  headers: Record<string, string> = {},
) => new Request("https://control.example/api/mcp", {
  method: "POST",
  headers: {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...headers,
  },
  body: JSON.stringify(body),
})

const call = (name: string, arguments_: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: arguments_ },
})

describe("hosted control MCP route", () => {
  test("serves stateless MCP tools through the injected control gateway", async () => {
    let snapshots = 0
    const application = app(writeBearer, controlService({
      snapshot: async () => {
        snapshots += 1
        return snapshot
      },
    }))
    const response = await application.request(mcpRequest(call("control_snapshot", { projectId: "project-1" })))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("mcp-session-id")).toBeNull()
    expect(body.result.structuredContent).toEqual(snapshot)
    expect(snapshots).toBe(1)

    const second = await application.request(mcpRequest(call("control_snapshot", { projectId: "project-1" })))
    expect(second.status).toBe(200)
    expect(snapshots).toBe(2)
  })

  test("allows read tools for a read-only bearer", async () => {
    const application = app(readBearer)
    for (const [name, arguments_] of [
      ["control_capabilities", {}],
      ["control_history", { projectId: "project-1" }],
    ]) {
      const response = await application.request(mcpRequest(call(name, arguments_)))
      expect(response.status).toBe(200)
      expect((await response.json()).result.isError).not.toBeTrue()
    }
  })

  test("requires a bearer rather than a cookie and sends the OAuth challenge", async () => {
    const response = await app(null).request(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, {
      Cookie: "better-auth.session_token=session",
    }))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://control.example/.well-known/oauth-protected-resource/api"',
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("rejects preview and commit at the OAuth boundary for read-only bearers", async () => {
    let previewCalls = 0
    let commitCalls = 0
    let gatewayCalls = 0
    const service = controlService({
      preview: async () => {
        previewCalls += 1
        return {}
      },
      commit: async () => {
        commitCalls += 1
        return {}
      },
    })
    const application = new Hono<ApiBindings>()
    registerControlMcpRoutes(application, {
      resolveBearer: async (_request, _environment, scope) => (
        readBearer.scopes.includes(scope) ? readBearer : null
      ),
      createGateway: async () => {
        gatewayCalls += 1
        return service
      },
    })
    const preview = await application.request(mcpRequest(call("control_preview", {
      version: "v1",
      projectId: "project-1",
      actions: [{ kind: "project.rename", name: "Next" }],
    })))
    const commit = await application.request(mcpRequest(call("control_commit", {
      version: "v1",
      projectId: "project-1",
      idempotencyKey: "request-1",
      actions: [{ kind: "project.rename", name: "Next" }],
    })))
    expect(preview.status).toBe(403)
    expect(commit.status).toBe(403)
    expect(preview.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="control:write", resource_metadata="https://control.example/.well-known/oauth-protected-resource/api"',
    )
    expect(await preview.json()).toEqual({
      error: "insufficient_scope",
      error_description: "Control write scope is required.",
    })
    expect(commit.headers.get("cache-control")).toBe("no-store")
    expect(previewCalls).toBe(0)
    expect(commitCalls).toBe(0)
    expect(gatewayCalls).toBe(0)
  })

  test("upscopes mixed batches while allowing read-only batches", async () => {
    const scopes: string[] = []
    const application = new Hono<ApiBindings>()
    registerControlMcpRoutes(application, {
      resolveBearer: async (_request, _environment, scope) => {
        scopes.push(scope)
        return scope === "control:read" ? readBearer : null
      },
      createGateway: async () => controlService(),
    })
    const readBatch = await application.request(mcpRequest([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      call("control_history", { projectId: "project-1" }),
    ]))
    expect(readBatch.status).toBe(200)
    expect(scopes).toEqual(["control:read"])

    const writeBatch = await application.request(mcpRequest([
      call("control_snapshot", { projectId: "project-1" }),
      call("control_preview", {
        version: "v1",
        projectId: "project-1",
        actions: [{ kind: "project.rename", name: "Next" }],
      }),
    ]))
    expect(writeBatch.status).toBe(403)
    expect(scopes).toEqual(["control:read", "control:write", "control:read"])
  })

  test("surfaces insufficient scope to the official MCP client", async () => {
    const application = app(readBearer)
    const transport = new StreamableHTTPClientTransport(new URL("https://control.example/api/mcp"), {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        return await application.fetch(request)
      },
    })
    const client = new Client({ name: "test-client", version: "1.0.0" })
    try {
      await client.connect(transport)
      await expect(client.callTool({
        name: "control_preview",
        arguments: {
          version: "v1",
          projectId: "project-1",
          actions: [{ kind: "project.rename", name: "Next" }],
        },
      })).rejects.toMatchObject({ code: 403 })
    } finally {
      await client.close()
    }
  })

  test("preserves tool errors and rejects invalid tool arguments without dispatch", async () => {
    let snapshots = 0
    const application = app(writeBearer, controlService({
      snapshot: async () => {
        snapshots += 1
        throw { version: "v1", code: "forbidden", message: "No project access.", actionIndex: 0 }
      },
    }))
    const invalid = await (await application.request(mcpRequest(call("control_snapshot", {
      projectId: "project-1",
      extra: true,
    })))).json()
    expect(invalid.result.isError).toBeTrue()
    expect(snapshots).toBe(0)

    const failed = await (await application.request(mcpRequest(call("control_snapshot", {
      projectId: "project-1",
    })))).json()
    expect(JSON.parse(failed.result.content[0].text)).toEqual({
      version: "v1",
      code: "forbidden",
      message: "No project access.",
      actionIndex: 0,
    })
  })

  test("rejects unsupported methods, malformed JSON, and non-JSON content", async () => {
    expect((await app().request("https://control.example/api/mcp")).status).toBe(405)
    const malformed = await app().request(new Request("https://control.example/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }))
    expect(malformed.status).toBe(400)
    const nonJson = await app().request(new Request("https://control.example/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    }))
    expect(nonJson.status).toBe(415)
  })
})
