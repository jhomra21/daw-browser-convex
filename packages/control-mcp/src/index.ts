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
  controlLimitsV1,
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

const instructions = "DAW control workflow: (1) discover a project with project_list; (2) call canonical/preferred control_capabilities_v2 and control_snapshot_v2 with the projectId; (3) construct action references from that snapshot, using {source:\"persisted\",id:\"<track id from snapshot>\"}, for example {kind:\"track.rename\",track:{source:\"persisted\",id:\"track-1\"},name:\"Drums\"}; (4) call control_preview with the exact version:\"v1\", projectId, expectedRevision from the snapshot, and actions; (5) if preview.approval.required is true, call control_request_approval with the same request, then pass its approvalToken to control_commit; (6) call control_commit with the exact previewed request, a stable idempotencyKey, and approvalToken when required; (7) re-observe with control_snapshot_v2 and inspect control_history. On revision-conflict, discard the stale expectedRevision, fetch a fresh control_snapshot_v2, rebuild references/actions against it, and preview again. Unsuffixed control_capabilities and control_snapshot are legacy V1 compatibility tools; new integrations should use the V2 tools. control_preview, control_commit, and control_request_approval route through target:\"cloud\" by default; use target:\"host\" only with an attached desktop host and its advertised capabilities."

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

const invalidRequest = (toolName?: string, details?: NonNullable<ControlErrorV1["details"]>): ControlErrorV1 => {
  const error: ControlErrorV1 = {
    version: "v1",
    code: "invalid-request",
    message: toolName === undefined ? "Invalid control tool input." : `Invalid ${toolName} input.`,
  }
  if (details !== undefined) error.details = details
  return error
}
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
const projectDiscoveryInputSchema = z.object({}).strict()
const withTarget = <Schema extends z.ZodObject>(schema: Schema) => schema.extend({ target: targetSchema })
const targetInput = (input: McpToolInput) => {
  if (!isRecord(input)) throw new Error("Invalid control tool input.")
  const { target, ...canonicalInput } = input
  return { target: targetSchema.parse(target), canonicalInput }
}

const publicIssueMessage = (issue: z.ZodIssue): string => {
  switch (issue.code) {
    case "invalid_type":
      return issue.expected === "object" || issue.expected === "array" || issue.expected === "string"
        || issue.expected === "number" || issue.expected === "boolean"
        ? `Expected ${issue.expected}.`
        : "Invalid value."
    case "unrecognized_keys":
      return "Unexpected field."
    case "too_big":
    case "too_small":
    case "invalid_format":
      return "Value is outside the allowed format or range."
    case "invalid_value":
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
    case "custom":
      return "Invalid value."
    default:
      return "Invalid value."
  }
}

const publicIssuePath = (issue: z.ZodIssue): string => {
  const path = issue.code === "unrecognized_keys" && issue.keys.length > 0
    ? [...issue.path, ...issue.keys]
    : issue.path
  const rendered = path.map(String).join(".")
  return rendered.length === 0 ? "$" : rendered.slice(0, 64)
}

const selectPublicIssues = (issues: readonly z.ZodIssue[]): z.ZodIssue[] => {
  const selected: z.ZodIssue[] = []
  for (const issue of issues) {
    if (issue.code !== "invalid_union") {
      selected.push(issue)
      continue
    }
    const branch = issue.errors
      .map((branchIssues) => selectPublicIssues(branchIssues))
      .sort((left, right) => left.length - right.length)[0]
    if (branch !== undefined) selected.push(...branch)
  }
  return selected
}

const publicValidationDetails = (error: z.ZodError): NonNullable<ControlErrorV1["details"]> => {
  const details: NonNullable<ControlErrorV1["details"]> = {}
  for (const issue of selectPublicIssues(error.issues)) {
    const key = publicIssuePath(issue)
    if (details[key] !== undefined) continue
    details[key] = publicIssueMessage(issue).slice(0, 1000)
    if (Object.keys(details).length >= controlLimitsV1.maxErrorDetails) break
  }
  return details
}

const invalidInputFor = (toolName: string, cause: unknown): ControlErrorV1 => (
  cause instanceof z.ZodError
    ? invalidRequest(toolName, publicValidationDetails(cause))
    : invalidRequest(toolName)
)

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
    toolName: string,
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
    } catch (error) {
      return failure(invalidInputFor(toolName, error))
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
  const capabilities = (input: McpToolInput) => executeRouted(input, "control_capabilities", controlCapabilitiesQuerySchemaV1.parse, (service_) => service_.capabilities(), controlCapabilitiesSchemaV1.parse, false)
  const capabilitiesV2 = (input: McpToolInput) => executeRouted(input, "control_capabilities_v2", controlCapabilitiesQuerySchemaV1.parse, (service_) => service_.capabilitiesV2(), controlCapabilitiesSchemaV2.parse, false)
  const snapshot = (input: McpToolInput) => executeRouted(input, "control_snapshot", controlSnapshotQuerySchemaV1.parse, (service_, value) => service_.snapshot(value), projectSnapshotSchemaV1.parse, false)
  const snapshotV2 = (input: McpToolInput) => executeRouted(input, "control_snapshot_v2", controlSnapshotQuerySchemaV1.parse, (service_, value) => service_.snapshotV2(value), projectSnapshotSchemaV2.parse, false)
  const preview = (input: McpToolInput) => executeRouted(input, "control_preview", controlPreviewRequestSchemaV1.parse, (service_, value) => service_.preview(value), controlPreviewResultSchemaV1.parse, true)
  const commit = (input: McpToolInput) => executeRouted(input, "control_commit", controlCommitRequestSchemaV1.parse, (service_, value) => service_.commit(value), controlCommitResultSchemaV1.parse, true)
  const requestApproval = (input: McpToolInput) => executeRouted(input, "control_request_approval", controlApprovalRequestSchemaV1.parse, (service_, value) => service_.requestApproval(value), controlApprovalResultSchemaV1.parse, true)
  const history = (input: McpToolInput) => executeRouted(input, "control_history", controlHistoryQuerySchemaV1.parse, (service_, value) => service_.history(value), controlHistoryResultSchemaV1.parse, false)
  const recoveries = (input: McpToolInput) => executeRouted(input, "control_recoveries", controlRecoveriesQuerySchemaV1.parse, (service_, value) => service_.recoveries(value), controlRecoveriesResultSchemaV1.parse, false)
  const projectsList = (input: McpToolInput) => executeRouted(input, "project_list", (value) => projectDiscoveryInputSchema.parse(value), (service_) => {
    if (!service_.projects) throw new Error("Project discovery is unavailable.")
    return service_.projects.list()
  }, projectListResultSchema.parse, false)
  const projectCurrent = (input: McpToolInput) => {
    try {
      const routing = targetInput(input)
      projectDiscoveryInputSchema.parse(routing.canonicalInput)
      if (routing.target === "cloud") {
        return Promise.resolve(failure({
          version: "v1",
          code: "unsupported-action",
          message: "Current project discovery is available only on the host.",
        }))
      }
    } catch (error) {
      return Promise.resolve(failure(invalidInputFor("project_current", error)))
    }
    return executeRouted(input, "project_current", (value) => projectDiscoveryInputSchema.parse(value), (service_) => {
      if (!service_.projects?.current) throw new Error("Current project discovery is unavailable.")
      return service_.projects.current()
    }, projectCurrentResultSchema.parse, false)
  }

  server.registerTool("project_list", {
    description: "List projects accessible through the selected control target.",
    inputSchema: withTarget(projectDiscoveryInputSchema),
    outputSchema: projectListResultSchema,
    annotations: annotations.read,
  }, projectsList)
  server.registerTool("project_current", {
    description: "Return the currently mounted local project. This is host-only.",
    inputSchema: withTarget(projectDiscoveryInputSchema),
    outputSchema: projectCurrentResultSchema,
    annotations: annotations.read,
  }, projectCurrent)

  server.registerTool("control_capabilities", {
    description: "Legacy V1 compatibility: return supported DAW control capabilities. New integrations should use canonical/preferred control_capabilities_v2.",
    inputSchema: withTarget(controlCapabilitiesQuerySchemaV1),
    outputSchema: controlCapabilitiesSchemaV1,
    annotations: annotations.read,
  }, capabilities)

  server.registerTool("control_snapshot", {
    description: "Legacy V1 compatibility: return a V1 DAW project snapshot. New integrations should use canonical/preferred control_snapshot_v2.",
    inputSchema: withTarget(controlSnapshotQuerySchemaV1),
    outputSchema: projectSnapshotSchemaV1,
    annotations: annotations.read,
  }, snapshot)
  server.registerTool("control_capabilities_v2", {
    description: "Canonical/preferred capabilities for new integrations. Return supported DAW control API V2 capabilities.",
    inputSchema: withTarget(controlCapabilitiesQuerySchemaV1),
    outputSchema: controlCapabilitiesSchemaV2,
    annotations: annotations.read,
  }, capabilitiesV2)
  server.registerTool("control_snapshot_v2", {
    description: "Canonical/preferred V2 project snapshot for new integrations. Use its project revision and entity IDs to construct control requests.",
    inputSchema: withTarget(controlSnapshotQuerySchemaV1),
    outputSchema: projectSnapshotSchemaV2,
    annotations: annotations.read,
  }, snapshotV2)

  server.registerTool("control_preview", {
    description: "Validate and preview without committing. Example: {version:\"v1\",projectId:\"project-1\",expectedRevision:7,actions:[{kind:\"track.rename\",track:{source:\"persisted\",id:\"track-1\"},name:\"Drums\"}]}. Use target:\"cloud\" by default or target:\"host\" only for an attached host; commit the exact previewed request.",
    inputSchema: withTarget(controlPreviewRequestSchemaV1),
    outputSchema: controlPreviewResultSchemaV1,
    annotations: annotations.preview,
  }, preview)

  server.registerTool("control_commit", {
    description: "Commit the exact previewed request. Include a stable idempotencyKey for retries and approvalToken from control_request_approval when preview.approval.required is true. Example: {version:\"v1\",projectId:\"project-1\",expectedRevision:7,idempotencyKey:\"rename-track-1\",approvalToken:\"<token when required>\",actions:[{kind:\"track.rename\",track:{source:\"persisted\",id:\"track-1\"},name:\"Drums\"}]}. Routes with target:\"cloud\" by default or target:\"host\" for an attached host.",
    inputSchema: withTarget(controlCommitRequestSchemaV1),
    outputSchema: controlCommitResultSchemaV1,
    annotations: annotations.commit,
  }, commit)

  server.registerTool("control_request_approval", {
    description: "Request a one-time approval token for a previewed destructive request. Example: {version:\"v1\",projectId:\"project-1\",expectedRevision:7,actions:[{kind:\"track.delete\",track:{source:\"persisted\",id:\"track-1\"}}]}. Reuse the exact request in control_commit and pass the returned approvalToken; route with target:\"cloud\" by default or target:\"host\" for an attached host.",
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
