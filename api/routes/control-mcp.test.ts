import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { JsonObject, JsonValue } from "@daw-browser/shared"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { controlCapabilitiesV1, controlCapabilitiesV2 } from "@daw-browser/control"
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
  assets: [],
  assetFolders: [],
}

const controlService = (overrides: Partial<ControlService> = {}): ControlService => ({
  capabilities: async () => controlCapabilitiesV1,
  capabilitiesV2: async () => controlCapabilitiesV2,
  snapshot: async () => snapshot,
  snapshotV2: async () => ({ ...snapshot, version: "v2" }),
  preview: async () => ({ version: "v1", projectId: "project-1", priorRevision: 1, revision: 2, applied: true, requestDigest: "0".repeat(64), resolvedRefs: [], warnings: [], changeSummary: { actionCount: 1, changes: [] } }),
  commit: async () => ({ version: "v1", projectId: "project-1", priorRevision: 1, revision: 2, applied: true, idempotencyReplay: false, requestDigest: "0".repeat(64), resolvedRefs: [], warnings: [], changeSummary: { actionCount: 1, changes: [] } }),
  requestApproval: async () => ({ version: "v1", approvalToken: "a".repeat(32), requestDigest: "0".repeat(64), baseRevision: 1, actionIndexes: [0], expiresAt: 2 }),
  history: async () => ({ entries: [], continueCursor: "cursor-1", isDone: true }),
  recoveries: async () => ({ entries: [], continueCursor: "cursor-1", isDone: true }),
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
  body: JsonValue,
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

const call = (name: string, arguments_: JsonObject) => ({
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

  test("serves static V2 capabilities without a gateway while keeping V2 snapshots gateway-backed", async () => {
    let gatewayCalls = 0
    let snapshotCalls = 0
    const application = new Hono<ApiBindings>()
    registerControlMcpRoutes(application, {
      resolveBearer: async () => readBearer,
      createGateway: async () => {
        gatewayCalls += 1
        return controlService({
          snapshotV2: async () => {
            snapshotCalls += 1
            return { ...snapshot, version: "v2" }
          },
        })
      },
    })

    const capabilitiesResponse = await application.request(mcpRequest(call("control_capabilities_v2", {})))
    expect(capabilitiesResponse.status).toBe(200)
    expect((await capabilitiesResponse.json()).result.structuredContent).toEqual(controlCapabilitiesV2)
    expect(gatewayCalls).toBe(0)

    const snapshotResponse = await application.request(mcpRequest(call("control_snapshot_v2", {
      projectId: "project-1",
    })))
    expect(snapshotResponse.status).toBe(200)
    expect((await snapshotResponse.json()).result.structuredContent.version).toBe("v2")
    expect(gatewayCalls).toBe(1)
    expect(snapshotCalls).toBe(1)
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

  test("rejects host-target canonical calls without constructing a cloud gateway", async () => {
    let gatewayCalls = 0
    const application = new Hono<ApiBindings>()
    registerControlMcpRoutes(application, {
      resolveBearer: async () => writeBearer,
      createGateway: async () => {
        gatewayCalls += 1
        return controlService()
      },
    })
    const response = await application.request(mcpRequest(call("control_snapshot", {
      projectId: "project-1",
      target: "host",
    })))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.result.isError).toBeTrue()
    expect(JSON.parse(body.result.content[0].text)).toEqual({
      version: "v1",
      code: "not-found",
      message: "A local desktop host is unavailable.",
    })
    expect(gatewayCalls).toBe(0)
  })

  test("requires base bearer authentication for hosted host targets", async () => {
    let gatewayCalls = 0
    const application = new Hono<ApiBindings>()
    registerControlMcpRoutes(application, {
      resolveBearer: async () => null,
      createGateway: async () => {
        gatewayCalls += 1
        return controlService()
      },
    })
    const response = await application.request(mcpRequest(call("control_preview", {
      target: "host",
      version: "v1",
      projectId: "project-1",
      actions: [{ kind: "project.rename", name: "Next" }],
    })))
    expect(response.status).toBe(401)
    expect(gatewayCalls).toBe(0)
  })

  test("keeps host targets out of hosted write scope and gateway routing", async () => {
    const scopes: string[] = []
    let gatewayCalls = 0
    const application = new Hono<ApiBindings>()
    registerControlMcpRoutes(application, {
      resolveBearer: async (_request, _environment, scope) => {
        scopes.push(scope)
        return scope === "control:read" ? readBearer : null
      },
      createGateway: async () => {
        gatewayCalls += 1
        return controlService()
      },
    })
    const hostPreview = call("control_preview", {
      target: "host",
      version: "v1",
      projectId: "project-1",
      actions: [{ kind: "project.rename", name: "Next" }],
    })
    const hostResponse = await application.request(mcpRequest(hostPreview))
    expect(hostResponse.status).toBe(200)
    expect(JSON.parse((await hostResponse.json()).result.content[0].text)).toEqual({
      version: "v1",
      code: "not-found",
      message: "A local desktop host is unavailable.",
    })
    expect(scopes).toEqual(["control:read"])
    expect(gatewayCalls).toBe(0)

    scopes.splice(0)
    const mixedHostAndRead = await application.request(mcpRequest([
      hostPreview,
      call("control_history", { projectId: "project-1" }),
    ]))
    expect(mixedHostAndRead.status).toBe(200)
    expect(scopes).toEqual(["control:read"])
    expect(gatewayCalls).toBe(1)

    scopes.splice(0)
    const mixedHostAndCloudWrite = await application.request(mcpRequest([
      hostPreview,
      call("control_preview", {
        version: "v1",
        projectId: "project-1",
        actions: [{ kind: "project.rename", name: "Next" }],
      }),
    ]))
    expect(mixedHostAndCloudWrite.status).toBe(403)
    expect(scopes).toEqual(["control:write", "control:read"])
    expect(gatewayCalls).toBe(1)

    scopes.splice(0)
    const invalidTarget = await application.request(mcpRequest(call("control_preview", {
      target: "invalid",
      version: "v1",
      projectId: "project-1",
      actions: [{ kind: "project.rename", name: "Next" }],
    })))
    expect(invalidTarget.status).toBe(403)
    expect(scopes).toEqual(["control:write", "control:read"])
    expect(gatewayCalls).toBe(1)
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
