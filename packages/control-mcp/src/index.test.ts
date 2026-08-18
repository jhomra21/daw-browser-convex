import { describe, expect, test } from "bun:test"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { CallToolRequest, InitializeRequest, ListToolsRequest } from "@modelcontextprotocol/sdk/spec.types.js"
import { controlCapabilitiesV1 } from "@daw-browser/control"
import { ControlApiError } from "@daw-browser/control-sdk"
import { createControlMcpServer, type ControlService } from "./index"
import type { HostToolService } from "./host-tools"

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

type TestRequest = CallToolRequest | InitializeRequest | ListToolsRequest
type ToolArguments = NonNullable<CallToolRequest["params"]["arguments"]>

const call = (name: string, arguments_: ToolArguments): CallToolRequest => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: arguments_ },
})

const hostTools: HostToolService = {
  status: async () => ({ project: null, ready: true, transport: "stopped", capabilities: { playback: true, diagnostics: true } }),
  transportStatus: async () => ({ state: "stopped", playheadSec: 0 }),
  play: async () => ({ state: "playing", playheadSec: 0 }),
  pause: async () => ({ state: "paused", playheadSec: 0 }),
  stop: async () => ({ state: "stopped", playheadSec: 0 }),
  seek: async ({ seconds }) => ({ state: "paused", playheadSec: seconds }),
  diagnostics: async () => ({ audio: { state: "running", sampleRate: 48_000 }, recording: { transport: null, capturedFrames: null, droppedFrames: null, deviceLost: false }, counts: { tracks: 0, clips: 0 } }),
  importAudio: async () => ({ status: "created", count: 1 }),
  exportRun: async () => ({ jobId: "export-1", status: "queued" }),
  exportStatus: async () => ({ status: "idle" }),
  exportCancel: async () => ({ status: "canceled", job: { id: "export-1" } }),
  vstInstances: async () => ({
    projectId: "project-1",
    instances: [{
      instanceId: "123e4567-e89b-42d3-a456-426614174000",
      targetId: "track-1",
      stageIndex: 0,
      identity: { format: "vst3", classId: "class-1", vendor: "Vendor", name: "Plugin", version: "1", architecture: "arm64" },
      role: "effect",
      bypassed: false,
      health: { state: "ready", updatedAt: 1 },
      parameterCount: 0,
      supportsEditor: false,
      supportsState: true,
    }],
    nextCursor: null,
  }),
  vstParameters: async () => ({ projectId: "project-1", instanceId: "123e4567-e89b-42d3-a456-426614174000", parameters: [], nextCursor: null }),
}

const request = async (
  body: TestRequest,
  options: {
    service?: ControlService
    write?: boolean
    host?: boolean
    hostTools?: HostToolService
    hostService?: ControlService
    hostFactory?: () => Promise<{ service: ControlService; close: () => void }>
    cloudService?: () => Promise<ControlService>
    authorize?: (scope: "control:read" | "control:write") => boolean | Promise<boolean>
  } = {},
) => {
  const selectedHostService = options.hostService
  const selectedHostTools = options.hostTools ?? (options.host ? hostTools : undefined)
  const server = createControlMcpServer(options.service ?? service(), {
    authorize: options.authorize ?? ((scope) => scope === "control:read" || options.write === true),
    hostTools: selectedHostTools ? selectedHostTools : undefined,
    hostService: options.hostFactory
      ? options.hostFactory
      : selectedHostService
        ? async () => ({ service: selectedHostService, close: () => undefined })
        : undefined,
    cloudService: options.cloudService ? options.cloudService : undefined,
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
  test("publishes the canonical agent workflow instructions", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "DRAFT-2026-v1",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    })
    expect(response.result.instructions).toBe(
      "Workflow: call control_capabilities, observe control_snapshot, and preview every mutation with control_preview. Request approval only when required, then commit the exact previewed request with a stable idempotencyKey. Re-observe control_snapshot and control_history after committing. Use target: \"host\" and host_* tools only for capabilities exposed by an attached desktop host.",
    )
  })

  test("adds local host tools only when explicitly composed", async () => {
    const response = await request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { host: true })
    expect(response.result.tools.map((tool: { name: string }) => tool.name).slice(-13)).toEqual([
      "host_status",
      "host_transport_status",
      "host_play",
      "host_pause",
      "host_stop",
      "host_seek",
      "host_diagnostics",
      "host_import_audio",
      "host_export_run",
      "host_export_status",
      "host_export_cancel",
      "host_vst_instances",
      "host_vst_parameters",
    ])
  })

  test("registers VST tools only for advertised host capabilities", async () => {
    const withoutVst = await request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
      hostTools: { ...hostTools, operations: new Set(["host.status"] as const) },
    })
    expect(withoutVst.result.tools.some((tool: { name: string }) => tool.name === "host_vst_instances")).toBeFalse()
    expect(withoutVst.result.tools.some((tool: { name: string }) => tool.name === "host_vst_parameters")).toBeFalse()

    const withVst = await request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
      hostTools: {
        ...hostTools,
        operations: new Set(["host.vst.instances", "host.vst.parameters"] as const),
      },
    })
    expect(withVst.result.tools.some((tool: { name: string }) => tool.name === "host_vst_instances")).toBeTrue()
    expect(withVst.result.tools.some((tool: { name: string }) => tool.name === "host_vst_parameters")).toBeTrue()
  })

  test("dispatches legacy local writes without cloud authorization", async () => {
    let plays = 0
    const response = await request(call("host_play", {}), {
      host: true,
      authorize: () => { throw new Error("Local host tools must not authorize against cloud credentials.") },
    })
    expect(response.result.isError).not.toBeTrue()
    expect(response.result.structuredContent).toEqual({ state: "playing", playheadSec: 0 })

    const countedTools: HostToolService = {
      ...hostTools,
      play: async () => {
        plays += 1
        return { state: "playing", playheadSec: 0 }
      },
    }
    const server = createControlMcpServer(service(), {
      authorize: () => false,
      hostTools: countedTools,
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    try {
      await server.connect(transport)
      const result = await transport.handleRequest(new Request("https://control.example/api/mcp", {
        method: "POST",
        headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify(call("host_play", {})),
      }))
      expect((await result.json()).result.isError).not.toBeTrue()
    } finally {
      await transport.close()
      await server.close()
    }
    expect(plays).toBe(1)
  })

  test("publishes and executes mounted desktop VST discovery as read-only tools", async () => {
    const listed = await request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { host: true })
    const instancesTool = listed.result.tools.find((tool: { name: string }) => tool.name === "host_vst_instances")
    const parametersTool = listed.result.tools.find((tool: { name: string }) => tool.name === "host_vst_parameters")
    expect(instancesTool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(parametersTool.annotations).toEqual(instancesTool.annotations)
    expect(instancesTool.inputSchema.additionalProperties).toBeFalse()
    const instances = await request(call("host_vst_instances", { projectId: "project-1" }), { host: true })
    expect(instances.result.isError).not.toBeTrue()
    expect(instances.result.structuredContent).toEqual({
      projectId: "project-1",
      instances: [{
        instanceId: "123e4567-e89b-42d3-a456-426614174000",
        targetId: "track-1",
        stageIndex: 0,
        identity: { format: "vst3", classId: "class-1", vendor: "Vendor", name: "Plugin", version: "1", architecture: "arm64" },
        role: "effect",
        bypassed: false,
        health: { state: "ready", updatedAt: 1 },
        parameterCount: 0,
        supportsEditor: false,
        supportsState: true,
      }],
      nextCursor: null,
    })
    const secretHostTools: HostToolService = {
      ...hostTools,
      vstInstances: async () => ({
        projectId: "project-1",
        instances: [{
          instanceId: "123e4567-e89b-42d3-a456-426614174000",
          targetId: "track-1",
          stageIndex: 0,
          identity: {
            format: "vst3",
            classId: "class-1",
            vendor: "Vendor",
            name: "Plugin",
            version: "1",
            architecture: "arm64",
            discoveredPath: "/private/plugin.vst3",
            binaryFingerprint: "a".repeat(64),
          },
          role: "effect",
          bypassed: false,
          health: { state: "ready", updatedAt: 1 },
          parameterCount: 0,
          supportsEditor: false,
          supportsState: true,
        }],
        nextCursor: null,
      }),
    }
    const secretResult = await request(call("host_vst_instances", { projectId: "project-1" }), { hostTools: secretHostTools })
    expect(secretResult.result.isError).toBeTrue()
    const invalid = await request(call("host_vst_parameters", { projectId: "project-1" }), { host: true })
    expect(JSON.parse(invalid.result.content[0].text)).toEqual({
      version: "v1",
      code: "invalid-request",
      message: "Invalid local desktop host tool input.",
    })
  })

  test("lists V1 and V2 read tools with accurate annotations", async () => {
    const response = await request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    const tools = response.result.tools
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "control_capabilities",
      "control_snapshot",
      "control_capabilities_v2",
      "control_snapshot_v2",
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
    for (const tool of tools) {
      expect(tool.inputSchema.properties.target).toEqual({
        type: "string",
        enum: ["cloud", "host"],
        default: "cloud",
      })
    }
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

  test("rejects invalid targets and canonical extras before either route dispatches", async () => {
    let cloudCalls = 0
    let hostCalls = 0
    const cloud = service({ snapshot: async () => { cloudCalls += 1; return snapshot } })
    const hostFactory = async () => ({
      service: service({ snapshot: async () => { hostCalls += 1; return snapshot } }),
      close: () => undefined,
    })
    for (const arguments_ of [
      { projectId: "project-1", target: "other" },
      { projectId: "project-1", target: true },
      { projectId: "project-1", target: "cloud", unexpected: true },
      { projectId: "project-1", target: "host", unexpected: true },
    ]) {
      const response = await request(call("control_snapshot", arguments_), { service: cloud, hostFactory })
      expect(JSON.parse(response.result.content[0].text)).toEqual({
        version: "v1",
        code: "invalid-request",
        message: "Invalid control tool input.",
      })
    }
    expect(cloudCalls).toBe(0)
    expect(hostCalls).toBe(0)
  })

  test("preserves actual SDK canonical errors and action indexes", async () => {
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
          throw new ControlApiError(422, {
            version: "v1",
            code: "validation",
            message: "Invalid action.",
            actionIndex: 0,
            details: { field: "actions.0.name" },
          })
        },
      }),
    })
    expect(response.result.isError).toBeTrue()
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      version: "v1",
      code: "validation",
      message: "Invalid action.",
      actionIndex: 0,
      details: { field: "actions.0.name" },
    })
  })

  test("resolves cloud identity before authorizing writes", async () => {
    const calls: string[] = []
    const response = await request({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "control_commit",
        arguments: { version: "v1", projectId: "project-1", idempotencyKey: "request-1", actions: [{ kind: "project.rename", name: "Next" }] },
      },
    }, {
      cloudService: async () => {
        calls.push("resolve")
        return service({ commit: async (input) => { calls.push("commit"); return service().commit(input) } })
      },
      authorize: () => {
        calls.push("authorize")
        return true
      },
    })
    expect(response.result.isError).not.toBeTrue()
    expect(calls).toEqual(["resolve", "authorize", "commit"])
  })

  test("returns canonical authorization when cloud identity cannot resolve", async () => {
    const response = await request(call("control_commit", {
      version: "v1",
      projectId: "project-1",
      idempotencyKey: "request-1",
      actions: [{ kind: "project.rename", name: "Next" }],
    }), {
      cloudService: async () => { throw { version: "v1", code: "authorization", message: "Cloud control credentials are unavailable." } },
      authorize: () => { throw new Error("Write authorization must not run without cloud identity.") },
    })
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      version: "v1",
      code: "authorization",
      message: "Cloud control credentials are unavailable.",
    })
  })

  test("keeps omitted and explicit cloud targets on the canonical cloud route", async () => {
    let cloudCalls = 0
    let hostCalls = 0
    const cloud = service({
      capabilities: async () => { cloudCalls += 1; return controlCapabilitiesV1 },
      snapshot: async () => { cloudCalls += 1; return snapshot },
      preview: async (input) => { cloudCalls += 1; return service().preview(input) },
      requestApproval: async (input) => { cloudCalls += 1; return service().requestApproval(input) },
      commit: async (input) => { cloudCalls += 1; return service().commit(input) },
      history: async (input) => { cloudCalls += 1; return service().history(input) },
      recoveries: async (input) => { cloudCalls += 1; return service().recoveries(input) },
    })
    const hostFactory = async () => {
      hostCalls += 1
      return { service: cloud, close: () => undefined }
    }
    const tools = [
      ["control_capabilities", {}],
      ["control_snapshot", { projectId: "project-1" }],
      ["control_preview", { version: "v1", projectId: "project-1", actions: [{ kind: "project.rename", name: "Next" }] }],
      ["control_commit", { version: "v1", projectId: "project-1", idempotencyKey: "request-1", actions: [{ kind: "project.rename", name: "Next" }] }],
      ["control_request_approval", { version: "v1", projectId: "project-1", actions: [{ kind: "project.rename", name: "Next" }] }],
      ["control_history", { projectId: "project-1" }],
      ["control_recoveries", { projectId: "project-1" }],
    ]
    for (const [name, canonicalInput] of tools) {
      for (const arguments_ of [canonicalInput, { ...canonicalInput, target: "cloud" }]) {
        const response = await request(call(name, arguments_), { service: cloud, hostFactory, write: true })
        expect(response.result.isError).not.toBeTrue()
      }
    }
    expect(cloudCalls).toBe(14)
    expect(hostCalls).toBe(0)
  })

  test("routes all canonical tools to an explicit host target without cloud fallback", async () => {
    let cloudCalls = 0
    let hostCalls = 0
    const cloud = service({
      capabilities: async () => { cloudCalls += 1; return controlCapabilitiesV1 },
      snapshot: async () => { cloudCalls += 1; return snapshot },
      preview: async () => { cloudCalls += 1; return service().preview({ version: "v1", projectId: "project-1", actions: [] }) },
      requestApproval: async () => { cloudCalls += 1; return service().requestApproval({ version: "v1", projectId: "project-1", actions: [] }) },
      commit: async () => { cloudCalls += 1; return service().commit({ version: "v1", projectId: "project-1", idempotencyKey: "request-1", actions: [] }) },
      history: async () => { cloudCalls += 1; return service().history({ projectId: "project-1" }) },
      recoveries: async () => { cloudCalls += 1; return service().recoveries({ projectId: "project-1" }) },
    })
    let created = 0
    let closed = 0
    let authorized = 0
    const inputs: unknown[] = []
    const hostFactory = async () => ({
      service: service({
        capabilities: async () => { hostCalls += 1; inputs.push({}); return controlCapabilitiesV1 },
        snapshot: async (input) => { hostCalls += 1; inputs.push(input); return snapshot },
        preview: async (input) => { hostCalls += 1; inputs.push(input); return service().preview(input) },
        requestApproval: async (input) => { hostCalls += 1; inputs.push(input); return service().requestApproval(input) },
        commit: async (input) => { hostCalls += 1; inputs.push(input); return service().commit(input) },
        history: async (input) => { hostCalls += 1; inputs.push(input); return service().history(input) },
        recoveries: async (input) => { hostCalls += 1; inputs.push(input); return service().recoveries(input) },
      }),
      close: () => { closed += 1 },
    })
    for (const [name, arguments_] of [
      ["control_capabilities", { target: "host" }],
      ["control_snapshot", { target: "host", projectId: "project-1" }],
      ["control_preview", { target: "host", version: "v1", projectId: "project-1", actions: [{ kind: "project.rename", name: "Next" }] }],
      ["control_request_approval", { target: "host", version: "v1", projectId: "project-1", actions: [{ kind: "project.rename", name: "Next" }] }],
      ["control_commit", { target: "host", version: "v1", projectId: "project-1", idempotencyKey: "request-1", actions: [{ kind: "project.rename", name: "Next" }] }],
      ["control_history", { target: "host", projectId: "project-1" }],
      ["control_recoveries", { target: "host", projectId: "project-1" }],
    ]) {
      const response = await request({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: arguments_ } }, {
        service: cloud,
        hostFactory: async () => {
          created += 1
          return await hostFactory()
        },
        authorize: () => {
          authorized += 1
          return false
        },
      })
      expect(response.result.isError).not.toBeTrue()
    }
    expect(hostCalls).toBe(7)
    expect(cloudCalls).toBe(0)
    expect(created).toBe(7)
    expect(closed).toBe(7)
    expect(authorized).toBe(0)
    expect(inputs).toEqual([
      {},
      { projectId: "project-1" },
      { version: "v1", projectId: "project-1", actions: [{ kind: "project.rename", name: "Next" }] },
      { version: "v1", projectId: "project-1", actions: [{ kind: "project.rename", name: "Next" }] },
      { version: "v1", projectId: "project-1", idempotencyKey: "request-1", actions: [{ kind: "project.rename", name: "Next" }] },
      { projectId: "project-1", limit: 50 },
      { projectId: "project-1", limit: 50 },
    ])
  })

  test("preserves host control errors and safely hides host transport failures", async () => {
    const controlFailure = { version: "v1", code: "validation", message: "Invalid action.", actionIndex: 0 }
    let closeCount = 0
    const factory = (cause: unknown) => async () => ({
      service: service({ preview: async () => { throw cause } }),
      close: () => { closeCount += 1 },
    })
    const arguments_ = { target: "host", version: "v1", projectId: "project-1", actions: [{ kind: "project.rename", name: "Next" }] }
    const preserved = await request(call("control_preview", arguments_), { hostFactory: factory({ data: controlFailure }) })
    expect(JSON.parse(preserved.result.content[0].text)).toEqual(controlFailure)
    const hidden = await request(call("control_preview", arguments_), { hostFactory: factory(new Error("/private/desktop.sock secret")) })
    expect(JSON.parse(hidden.result.content[0].text)).toEqual({
      version: "v1",
      code: "not-found",
      message: "A local desktop host is unavailable.",
    })
    expect(closeCount).toBe(2)
  })

  test("preserves host lifecycle errors for canonical host targets", async () => {
    const lifecycleFailure = {
      version: "v1",
      code: "cancelled",
      message: "The request was cancelled.",
    }
    const response = await request(call("control_preview", {
      target: "host",
      version: "v1",
      projectId: "project-1",
      actions: [{ kind: "project.rename", name: "Next" }],
    }), {
      hostFactory: async () => ({
        service: service({ preview: async () => { throw { data: lifecycleFailure } } }),
        close: () => undefined,
      }),
    })
    expect(JSON.parse(response.result.content[0].text)).toEqual(lifecycleFailure)
  })
})
