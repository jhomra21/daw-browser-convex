import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CallToolRequestSchema,
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { CanonicalControlClient } from "@daw-browser/control-sdk"
import {
  canonicalJson,
  controlCapabilitiesQuerySchemaV1,
  controlCapabilitiesSchemaV1,
  controlCapabilitiesSchemaV2,
  controlCommitRequestSchemaV1,
  controlCommitResultSchemaV1,
  controlApprovalRequestSchemaV1,
  controlApprovalResultSchemaV1,
  controlErrorSchemaV1,
  controlHistoryQuerySchemaV1,
  controlHistoryResultSchemaV1,
  controlRecoveriesQuerySchemaV1,
  controlRecoveriesResultSchemaV1,
  controlPreviewRequestSchemaV1,
  controlPreviewResultSchemaV1,
  controlSnapshotQuerySchemaV1,
  projectSnapshotSchemaV1,
  projectSnapshotSchemaV2,
  type ControlErrorV1,
  type ControlCapabilitiesV1,
  type ControlCapabilitiesV2,
  type ControlCommitRequestV1,
  type ControlCommitResultV1,
  type ControlApprovalRequestV1,
  type ControlApprovalResultV1,
  type ControlSnapshotQueryV1,
  type ControlHistoryResultV1,
  type ControlHistoryQueryV1,
  type ControlRecoveriesQueryV1,
  type ControlRecoveriesResultV1,
  type ControlPreviewResultV1,
  type ControlPreviewRequestV1,
  type ProjectSnapshotV1,
  type ProjectSnapshotV2,
  projectCurrentResultSchema,
  projectListResultSchema,
  type ProjectCurrentResult,
  type ProjectListResult,
  projectCanonicalControlCapabilitiesV1,
  projectCanonicalProjectSnapshotV1,
} from "@daw-browser/control"
import {
  hostErrorSchemaV1,
  hostErrorSchemaV2,
  type HostErrorV1,
} from "@daw-browser/desktop-protocol"
import { executeHostTool, registerHostTools, type HostToolService } from "./host-tools"

export type ControlService = {
  projects?: {
    list: () => Promise<ProjectListResult>;
    current?: () => Promise<ProjectCurrentResult>;
  };
  capabilities: () => Promise<ControlCapabilitiesV1>;
  capabilitiesV2: () => Promise<ControlCapabilitiesV2>;
  snapshot: (input: ControlSnapshotQueryV1) => Promise<ProjectSnapshotV1>;
  snapshotV2: (input: ControlSnapshotQueryV1) => Promise<ProjectSnapshotV2>;
  preview: (input: ControlPreviewRequestV1) => Promise<ControlPreviewResultV1>;
  commit: (input: ControlCommitRequestV1) => Promise<ControlCommitResultV1>;
  requestApproval: (input: ControlApprovalRequestV1) => Promise<ControlApprovalResultV1>;
  history: (input: ControlHistoryQueryV1) => Promise<ControlHistoryResultV1>;
  recoveries: (input: ControlRecoveriesQueryV1) => Promise<ControlRecoveriesResultV1>;
}

export const controlServiceFromCanonicalMethods = (
  methods: CanonicalControlClient<"cloud">,
): ControlService => ({
  projects: { list: () => methods.projects.list({}) },
  capabilities: async () => projectCanonicalControlCapabilitiesV1(await methods.control.capabilities({})),
  capabilitiesV2: async () => methods.control.capabilities({}),
  snapshot: async (input) => projectCanonicalProjectSnapshotV1(await methods.control.snapshot(input)),
  snapshotV2: async (input) => methods.control.snapshot(input),
  preview: methods.control.preview,
  commit: methods.control.commit,
  requestApproval: methods.control.requestApproval,
  history: methods.control.history,
  recoveries: methods.control.recoveries,
})

export type ControlMcpScope = "control:read" | "control:write"
export type ControlMcpTarget = "cloud" | "host"
export type ControlMcpHostService = () => Promise<{ service: ControlService; close: () => void }>

type ControlMcpOptions = {
  authorize?: (scope: ControlMcpScope) => boolean | Promise<boolean>;
  hostTools?: HostToolService;
  hostService?: ControlMcpHostService;
  cloudService?: (scope: ControlMcpScope) => Promise<ControlService>;
}

type McpToolInput = CallToolRequest["params"]["arguments"]
type ControlServiceResult =
  | ControlCapabilitiesV1
  | ControlCapabilitiesV2
  | ProjectSnapshotV1
  | ProjectSnapshotV2
  | ControlPreviewResultV1
  | ControlCommitResultV1
  | ControlApprovalResultV1
  | ControlHistoryResultV1
  | ControlRecoveriesResultV1
  | ProjectListResult
  | ProjectCurrentResult
type McpStructuredContent = NonNullable<CallToolResult["structuredContent"]>

const annotations = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  preview: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  commit: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  approval: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}

const instructions = "Workflow: call control_capabilities, observe control_snapshot, and preview every mutation with control_preview. Request approval only when required, then commit the exact previewed request with a stable idempotencyKey. Re-observe control_snapshot and control_history after committing. Use target: \"host\" and host_* tools only for capabilities exposed by an attached desktop host."

const internalError = (): ControlErrorV1 => ({
  version: "v1",
  code: "internal",
  message: "Control service failed.",
})

const forbidden = (): ControlErrorV1 => ({
  version: "v1",
  code: "forbidden",
  message: "Control write scope is required.",
})

const invalidRequest = (): ControlErrorV1 => ({
  version: "v1",
  code: "invalid-request",
  message: "Invalid control tool input.",
})
const hostUnavailable = (): ControlErrorV1 => ({
  version: "v1",
  code: "not-found",
  message: "A local desktop host is unavailable.",
})
const canonicalHostError = (cause: unknown): HostErrorV1 | undefined => {
  const v1 = hostErrorSchemaV1.safeParse(cause)
  if (v1.success) return v1.data
  const v2 = hostErrorSchemaV2.safeParse(cause)
  return v2.success ? { version: 'v1', code: v2.data.code, message: v2.data.message } : undefined
}
const hostTransportError = (cause: unknown): ControlErrorV1 | HostErrorV1 => {
  for (const candidate of [
    cause,
    isRecord(cause) ? cause.data : undefined,
    isRecord(cause) ? cause.errorData : undefined,
  ]) {
    const control = controlErrorSchemaV1.safeParse(candidate)
    if (control.success) return control.data
    const host = canonicalHostError(candidate)
    if (host) return host
  }
  return hostUnavailable()
}

const isRecord = (cause: unknown): cause is NonNullable<McpToolInput> => (
  typeof cause === "object" && cause !== null && !Array.isArray(cause)
)

const serviceError = (cause: unknown): ControlErrorV1 | HostErrorV1 => {
  for (const candidate of [
    cause,
    isRecord(cause) ? cause.data : undefined,
    isRecord(cause) ? cause.errorData : undefined,
  ]) {
    const parsed = controlErrorSchemaV1.safeParse(candidate)
    if (parsed.success) return parsed.data
    const host = canonicalHostError(candidate)
    if (host) return host
  }
  return internalError()
}

const success = <Value extends object>(value: Value) => {
  const canonicalContent = JSON.parse(JSON.stringify(value))
  const structuredContent: McpStructuredContent = canonicalContent
  return {
    structuredContent,
    content: [{ type: "text" as const, text: canonicalJson(canonicalContent) }],
  }
}

const failure = (error: ControlErrorV1 | HostErrorV1) => ({
  isError: true,
  content: [{ type: "text" as const, text: canonicalJson(error) }],
})

const execute = async <Output extends object>(
  invoke: () => Promise<ControlServiceResult>,
  parseOutput: (value: ControlServiceResult) => Output,
  errorFor: (cause: unknown) => ControlErrorV1 | HostErrorV1 = serviceError,
) => {
  try {
    return success(parseOutput(await invoke()))
  } catch (error) {
    return failure(errorFor(error))
  }
}

const targetSchema = z.enum(["cloud", "host"]).default("cloud")
const withTarget = <Schema extends z.ZodObject>(schema: Schema) => schema.extend({ target: targetSchema })
const targetInput = (input: McpToolInput) => {
  if (!isRecord(input)) throw new Error("Invalid control tool input.")
  const { target, ...canonicalInput } = input
  return { target: targetSchema.parse(target), canonicalInput }
}

export const createControlMcpServer = (
  service: ControlService | undefined,
  options: ControlMcpOptions = {},
) => {
  const server = new McpServer(
    { name: "daw-browser-control", version: "1.0.0" },
    { instructions },
  )
  const canWrite = async () => options.authorize === undefined || await options.authorize("control:write")
  const executeRouted = async <Input, Output extends object>(
    input: McpToolInput,
    parseInput: (value: McpToolInput) => Input,
    invoke: (service_: ControlService, value: Input) => Promise<ControlServiceResult>,
    parseOutput: (value: ControlServiceResult) => Output,
    requiresWriteScope: boolean,
  ) => {
    let target: ControlMcpTarget
    let parsedInput: Input
    try {
      const routing = targetInput(input)
      target = routing.target
      parsedInput = parseInput(routing.canonicalInput)
    } catch {
      return failure(invalidRequest())
    }
    if (target === "cloud") {
      let cloud: ControlService | undefined = service
      try {
        cloud = options.cloudService
          ? await options.cloudService(requiresWriteScope ? "control:write" : "control:read")
          : service
      } catch (error) {
        return failure(serviceError(error))
      }
      if (!cloud) return failure(internalError())
      if (requiresWriteScope) {
        try {
          if (!await canWrite()) return failure(forbidden())
        } catch (error) {
          return failure(serviceError(error))
        }
      }
      return execute(() => invoke(cloud, parsedInput), parseOutput)
    }
    if (!options.hostService) return failure(hostUnavailable())
    let host: Awaited<ReturnType<ControlMcpHostService>>
    try {
      host = await options.hostService()
    } catch (error) {
      return failure(hostTransportError(error))
    }
    try {
      return await execute(() => invoke(host.service, parsedInput), parseOutput, hostTransportError)
    } finally {
      host.close()
    }
  }
  const capabilities = (input: McpToolInput) => executeRouted(input, controlCapabilitiesQuerySchemaV1.parse, (service_) => service_.capabilities(), controlCapabilitiesSchemaV1.parse, false)
  const capabilitiesV2 = (input: McpToolInput) => executeRouted(input, controlCapabilitiesQuerySchemaV1.parse, (service_) => service_.capabilitiesV2(), controlCapabilitiesSchemaV2.parse, false)
  const snapshot = (input: McpToolInput) => executeRouted(input, controlSnapshotQuerySchemaV1.parse, (service_, value) => service_.snapshot(value), projectSnapshotSchemaV1.parse, false)
  const snapshotV2 = (input: McpToolInput) => executeRouted(input, controlSnapshotQuerySchemaV1.parse, (service_, value) => service_.snapshotV2(value), projectSnapshotSchemaV2.parse, false)
  const preview = (input: McpToolInput) => executeRouted(input, controlPreviewRequestSchemaV1.parse, (service_, value) => service_.preview(value), controlPreviewResultSchemaV1.parse, true)
  const commit = (input: McpToolInput) => executeRouted(input, controlCommitRequestSchemaV1.parse, (service_, value) => service_.commit(value), controlCommitResultSchemaV1.parse, true)
  const requestApproval = (input: McpToolInput) => executeRouted(input, controlApprovalRequestSchemaV1.parse, (service_, value) => service_.requestApproval(value), controlApprovalResultSchemaV1.parse, true)
  const history = (input: McpToolInput) => executeRouted(input, controlHistoryQuerySchemaV1.parse, (service_, value) => service_.history(value), controlHistoryResultSchemaV1.parse, false)
  const recoveries = (input: McpToolInput) => executeRouted(input, controlRecoveriesQuerySchemaV1.parse, (service_, value) => service_.recoveries(value), controlRecoveriesResultSchemaV1.parse, false)
  const projectsList = (input: McpToolInput) => executeRouted(input, () => ({}), (service_) => {
    if (!service_.projects) throw new Error("Project discovery is unavailable.")
    return service_.projects.list()
  }, projectListResultSchema.parse, false)
  const projectCurrent = (input: McpToolInput) => {
    try {
      if (targetInput(input).target === "cloud") {
        return Promise.resolve(failure({
          version: "v1",
          code: "unsupported-action",
          message: "Current project discovery is available only on the host.",
        }))
      }
    } catch {
      return Promise.resolve(failure(invalidRequest()))
    }
    return executeRouted(input, () => ({}), (service_) => {
      if (!service_.projects?.current) throw new Error("Current project discovery is unavailable.")
      return service_.projects.current()
    }, projectCurrentResultSchema.parse, false)
  }

  server.registerTool("project_list", {
    description: "List projects accessible through the selected control target.",
    inputSchema: withTarget(z.object({}).strict()),
    outputSchema: projectListResultSchema,
    annotations: annotations.read,
  }, projectsList)
  server.registerTool("project_current", {
    description: "Return the currently mounted local project. This is host-only.",
    inputSchema: withTarget(z.object({}).strict()),
    outputSchema: projectCurrentResultSchema,
    annotations: annotations.read,
  }, projectCurrent)

  server.registerTool("control_capabilities", {
    description: "Return the supported DAW control API capabilities.",
    inputSchema: withTarget(controlCapabilitiesQuerySchemaV1),
    outputSchema: controlCapabilitiesSchemaV1,
    annotations: annotations.read,
  }, capabilities)

  server.registerTool("control_snapshot", {
    description: "Return the canonical snapshot for a DAW project.",
    inputSchema: withTarget(controlSnapshotQuerySchemaV1),
    outputSchema: projectSnapshotSchemaV1,
    annotations: annotations.read,
  }, snapshot)
  server.registerTool("control_capabilities_v2", {
    description: "Return the supported DAW control API V2 capabilities.",
    inputSchema: withTarget(controlCapabilitiesQuerySchemaV1),
    outputSchema: controlCapabilitiesSchemaV2,
    annotations: annotations.read,
  }, capabilitiesV2)
  server.registerTool("control_snapshot_v2", {
    description: "Return the canonical V2 snapshot for a DAW project.",
    inputSchema: withTarget(controlSnapshotQuerySchemaV1),
    outputSchema: projectSnapshotSchemaV2,
    annotations: annotations.read,
  }, snapshotV2)

  server.registerTool("control_preview", {
    description: "Validate and preview a DAW control request without committing it.",
    inputSchema: withTarget(controlPreviewRequestSchemaV1),
    outputSchema: controlPreviewResultSchemaV1,
    annotations: annotations.preview,
  }, preview)

  server.registerTool("control_commit", {
    description: "Commit an idempotent DAW control request.",
    inputSchema: withTarget(controlCommitRequestSchemaV1),
    outputSchema: controlCommitResultSchemaV1,
    annotations: annotations.commit,
  }, commit)

  server.registerTool("control_request_approval", {
    description: "Request a one-time approval token for material destructive DAW actions.",
    inputSchema: withTarget(controlApprovalRequestSchemaV1),
    outputSchema: controlApprovalResultSchemaV1,
    annotations: annotations.approval,
  }, requestApproval)

  server.registerTool("control_history", {
    description: "Return bounded DAW control history for a project.",
    inputSchema: withTarget(controlHistoryQuerySchemaV1),
    outputSchema: controlHistoryResultSchemaV1,
    annotations: annotations.read,
  }, history)
  server.registerTool("control_recoveries", {
    description: "Return active recovery descriptors for a DAW project.",
    inputSchema: withTarget(controlRecoveriesQuerySchemaV1),
    outputSchema: controlRecoveriesResultSchemaV1,
    annotations: annotations.read,
  }, recoveries)

  if (options.hostTools) registerHostTools(server, options.hostTools)
  server.server.removeRequestHandler("tools/call")
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const input = request.params.arguments
    if (request.params.name === "control_capabilities") return capabilities(input)
    if (request.params.name === "control_snapshot") return snapshot(input)
    if (request.params.name === "control_capabilities_v2") return capabilitiesV2(input)
    if (request.params.name === "control_snapshot_v2") return snapshotV2(input)
    if (request.params.name === "control_preview") return preview(input)
    if (request.params.name === "control_commit") return commit(input)
    if (request.params.name === "control_request_approval") return requestApproval(input)
    if (request.params.name === "control_history") return history(input)
    if (request.params.name === "control_recoveries") return recoveries(input)
    if (request.params.name === "project_list") return projectsList(input)
    if (request.params.name === "project_current") return projectCurrent(input)
    if (options.hostTools) {
      return executeHostTool(request.params.name, input, options.hostTools)
    }
    return failure(invalidRequest())
  })

  return server
}
