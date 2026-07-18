import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  canonicalJson,
  controlCapabilitiesQuerySchemaV1,
  controlCapabilitiesSchemaV1,
  controlCommitRequestSchemaV1,
  controlCommitResultSchemaV1,
  controlErrorSchemaV1,
  controlHistoryQuerySchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewRequestSchemaV1,
  controlPreviewResultSchemaV1,
  controlSnapshotQuerySchemaV1,
  projectSnapshotSchemaV1,
  type ControlErrorV1,
  type ControlCapabilitiesV1,
  type ControlCommitRequestV1,
  type ControlCommitResultV1,
  type ControlSnapshotQueryV1,
  type ControlHistoryResultV1,
  type ControlHistoryQueryV1,
  type ControlPreviewResultV1,
  type ControlPreviewRequestV1,
  type ProjectSnapshotV1,
} from "@daw-browser/control"

export type ControlService = {
  capabilities: () => Promise<ControlCapabilitiesV1>;
  snapshot: (input: ControlSnapshotQueryV1) => Promise<ProjectSnapshotV1>;
  preview: (input: ControlPreviewRequestV1) => Promise<ControlPreviewResultV1>;
  commit: (input: ControlCommitRequestV1) => Promise<ControlCommitResultV1>;
  history: (input: ControlHistoryQueryV1) => Promise<ControlHistoryResultV1>;
}

export type ControlMcpScope = "control:read" | "control:write"

type ControlMcpOptions = {
  authorize?: (scope: ControlMcpScope) => boolean | Promise<boolean>;
}

const annotations = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  preview: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  commit: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}

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

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
)

const controlError = (error: unknown): ControlErrorV1 => {
  for (const candidate of [
    error,
    isRecord(error) ? error.data : undefined,
    isRecord(error) ? error.errorData : undefined,
  ]) {
    const parsed = controlErrorSchemaV1.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  return internalError()
}

const success = <Value>(value: Value) => ({
  structuredContent: value,
  content: [{ type: "text" as const, text: canonicalJson(value) }],
})

const failure = (error: ControlErrorV1) => ({
  isError: true,
  content: [{ type: "text" as const, text: canonicalJson(error) }],
})

const execute = async <Input, Output>(
  input: unknown,
  parseInput: (value: unknown) => Input,
  invoke: (value: Input) => Promise<unknown>,
  parseOutput: (value: unknown) => Output,
) => {
  let parsedInput: Input
  try {
    parsedInput = parseInput(input)
  } catch {
    return failure(invalidRequest())
  }
  try {
    return success(parseOutput(await invoke(parsedInput)))
  } catch (error) {
    return failure(controlError(error))
  }
}

export const createControlMcpServer = (
  service: ControlService,
  options: ControlMcpOptions = {},
) => {
  const server = new McpServer({ name: "daw-browser-control", version: "1.0.0" })
  const canWrite = async () => options.authorize === undefined || await options.authorize("control:write")
  const write = <Input, Output>(
    input: unknown,
    parseInput: (value: unknown) => Input,
    invoke: (value: Input) => Promise<unknown>,
    parseOutput: (value: unknown) => Output,
  ) => canWrite().then((allowed) => (
    allowed ? execute(input, parseInput, invoke, parseOutput) : failure(forbidden())
  ))
  const capabilities = (input: unknown) => (
    execute(input, controlCapabilitiesQuerySchemaV1.parse, service.capabilities, controlCapabilitiesSchemaV1.parse)
  )
  const snapshot = (input: unknown) => (
    execute(input, controlSnapshotQuerySchemaV1.parse, service.snapshot, projectSnapshotSchemaV1.parse)
  )
  const preview = (input: unknown) => (
    write(input, controlPreviewRequestSchemaV1.parse, service.preview, controlPreviewResultSchemaV1.parse)
  )
  const commit = (input: unknown) => (
    write(input, controlCommitRequestSchemaV1.parse, service.commit, controlCommitResultSchemaV1.parse)
  )
  const history = (input: unknown) => (
    execute(input, controlHistoryQuerySchemaV1.parse, service.history, controlHistoryResultSchemaV1.parse)
  )

  server.registerTool("control_capabilities", {
    description: "Return the supported DAW control API capabilities.",
    inputSchema: controlCapabilitiesQuerySchemaV1,
    outputSchema: controlCapabilitiesSchemaV1,
    annotations: annotations.read,
  }, capabilities)

  server.registerTool("control_snapshot", {
    description: "Return the canonical snapshot for a DAW project.",
    inputSchema: controlSnapshotQuerySchemaV1,
    outputSchema: projectSnapshotSchemaV1,
    annotations: annotations.read,
  }, snapshot)

  server.registerTool("control_preview", {
    description: "Validate and preview a DAW control request without committing it.",
    inputSchema: controlPreviewRequestSchemaV1,
    outputSchema: controlPreviewResultSchemaV1,
    annotations: annotations.preview,
  }, preview)

  server.registerTool("control_commit", {
    description: "Commit an idempotent DAW control request.",
    inputSchema: controlCommitRequestSchemaV1,
    outputSchema: controlCommitResultSchemaV1,
    annotations: annotations.commit,
  }, commit)

  server.registerTool("control_history", {
    description: "Return bounded DAW control history for a project.",
    inputSchema: controlHistoryQuerySchemaV1,
    outputSchema: controlHistoryResultSchemaV1,
    annotations: annotations.read,
  }, history)

  server.server.removeRequestHandler("tools/call")
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const input = request.params.arguments
    if (request.params.name === "control_capabilities") return capabilities(input)
    if (request.params.name === "control_snapshot") return snapshot(input)
    if (request.params.name === "control_preview") return preview(input)
    if (request.params.name === "control_commit") return commit(input)
    if (request.params.name === "control_history") return history(input)
    return failure(invalidRequest())
  })

  return server
}
