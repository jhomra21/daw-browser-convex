import { describe, expect, test } from "bun:test"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { controlCapabilitiesV1 } from "@daw-browser/control"
import { createControlMcpServer, type ControlService } from "./index"

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

const service = (overrides: Partial<ControlService> = {}): ControlService => ({
  capabilities: async () => controlCapabilitiesV1,
  snapshot: async () => snapshot,
  preview: async () => ({ version: "v1", projectId: "project-1", priorRevision: 1, revision: 2, applied: true, requestDigest: "0".repeat(64), resolvedRefs: [], warnings: [], changeSummary: { actionCount: 1, changes: [] } }),
  requestApproval: async () => ({ version: "v1", approvalToken: "a".repeat(32), requestDigest: "0".repeat(64), baseRevision: 1, actionIndexes: [0], expiresAt: 2 }),
  commit: async () => ({ version: "v1", projectId: "project-1", priorRevision: 1, revision: 2, applied: true, idempotencyReplay: false, requestDigest: "0".repeat(64), resolvedRefs: [], warnings: [], changeSummary: { actionCount: 1, changes: [] } }),
  history: async () => ({ entries: [], continueCursor: "cursor-1", isDone: true }),
  recoveries: async () => ({ entries: [], continueCursor: "cursor-1", isDone: true }),
  ...overrides,
})

const request = async (
  body: unknown,
  options: { service?: ControlService; write?: boolean } = {},
) => {
  const server = createControlMcpServer(options.service ?? service(), {
    authorize: (scope) => scope === "control:read" || options.write === true,
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    const response = await transport.handleRequest(new Request("https://control.example/api/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }))
    return await response.json()
  } finally {
    await transport.close()
    await server.close()
  }
}

describe("control MCP tools", () => {
  test("lists exactly the seven canonical tools with accurate annotations", async () => {
    const response = await request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    const tools = response.result.tools
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "control_capabilities",
      "control_snapshot",
      "control_preview",
      "control_commit",
      "control_request_approval",
      "control_history",
      "control_recoveries",
    ])
    expect(tools.find((tool: { name: string }) => tool.name === "control_commit").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(tools.find((tool: { name: string }) => tool.name === "control_preview").annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(tools.find((tool: { name: string }) => tool.name === "control_request_approval").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    })
    expect(tools.find((tool: { name: string }) => tool.name === "control_snapshot").inputSchema.additionalProperties).toBeFalse()
    expect(tools.find((tool: { name: string }) => tool.name === "control_recoveries").annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  })

  test("returns structured and text content with canonical parity", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "control_snapshot", arguments: { projectId: "project-1" } },
    })
    expect(response.result.structuredContent).toEqual(snapshot)
    expect(JSON.parse(response.result.content[0].text)).toEqual(response.result.structuredContent)
  })

  test("returns canonical errors for invalid arguments to every tool", async () => {
    let calls = 0
    const input = service({
      capabilities: async () => { calls += 1; return controlCapabilitiesV1 },
      snapshot: async () => { calls += 1; return snapshot },
      preview: async () => { calls += 1; return {} },
      commit: async () => { calls += 1; return {} },
      history: async () => { calls += 1; return {} },
      recoveries: async () => { calls += 1; return {} },
    })
    for (const [name, arguments_] of [
      ["control_capabilities", { unexpected: true }],
      ["control_snapshot", {}],
      ["control_preview", {}],
      ["control_commit", {}],
      ["control_history", {}],
      ["control_recoveries", {}],
    ]) {
      const response = await request({
        jsonrpc: "2.0",
        id: name,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }, { service: input, write: true })
      expect(response.result.isError).toBeTrue()
      expect(JSON.parse(response.result.content[0].text)).toEqual({
        version: "v1",
        code: "invalid-request",
        message: "Invalid control tool input.",
      })
    }
    expect(calls).toBe(0)
  })

  test("preserves canonical control errors and action indexes", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "control_preview",
        arguments: { version: "v1", projectId: "project-1", actions: [{ kind: "project.rename", name: "Next" }] },
      },
    }, {
      write: true,
      service: service({
        preview: async () => {
          throw { version: "v1", code: "validation", message: "Invalid action.", actionIndex: 0 }
        },
      }),
    })
    expect(response.result.isError).toBeTrue()
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      version: "v1",
      code: "validation",
      message: "Invalid action.",
      actionIndex: 0,
    })
  })

  test("gates write tools without calling the control service", async () => {
    let calls = 0
    const response = await request({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "control_commit",
        arguments: { version: "v1", projectId: "project-1", idempotencyKey: "request-1", actions: [{ kind: "project.rename", name: "Next" }] },
      },
    }, { service: service({ commit: async () => { calls += 1; return {} } }) })
    expect(response.result.isError).toBeTrue()
    expect(JSON.parse(response.result.content[0].text).code).toBe("forbidden")
    expect(calls).toBe(0)
  })
})
