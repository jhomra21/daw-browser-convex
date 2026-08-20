import {
  controlOperationCatalog,
  listControlOperationDescriptors,
  parseControlOperationId,
  projectListInputSchema,
  projectCurrentInputSchema,
  canonicalControlCapabilitiesQuerySchema,
  canonicalControlSnapshotQuerySchema,
  controlPreviewRequestSchemaV1,
  controlApprovalRequestSchemaV1,
  controlCommitRequestSchemaV1,
  controlHistoryQuerySchemaV1,
  controlRecoveriesQuerySchemaV1,
  supportsControlOperation,
  type ControlInvoker,
  type ControlOperationId,
  type ControlOperationTarget,
} from "@daw-browser/control";
import { z } from "zod";

export const maxJsonlLineBytes = 64 * 1024;
export const maxJsonlDepth = 12;
export const maxJsonRpcIdLength = 128;

type JsonRpcId = string | number;
type JsonRpcRequest = Readonly<{
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}>;

type JsonRpcResponse = Readonly<{
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: Readonly<{
    code: number;
    message: string;
    data?: unknown;
  }>;
}>;

export type JsonlRpcAdapter = Readonly<{
  processLine: (line: string) => Promise<string>;
  methods: () => readonly ControlOperationId[];
}>;

type JsonlRpcAdapterOptions = Readonly<{
  invoker: ControlInvoker<"cloud"> | ControlInvoker<"desktop">;
}>;

const canonicalError = (code: "invalid-request" | "unsupported-target" | "invalid-input" | "internal", message: string) => ({
  version: "v1" as const,
  code,
  message,
});

const response = (id: JsonRpcId | null, value: Omit<JsonRpcResponse, "jsonrpc" | "id">): string =>
  JSON.stringify({ jsonrpc: "2.0", id, ...value });

const depthOf = (value: unknown, depth = 0): number => {
  if (depth > maxJsonlDepth) return depth;
  if (Array.isArray(value)) return Math.max(depth, ...value.map((entry) => depthOf(entry, depth + 1)));
  if (typeof value === "object" && value !== null) {
    return Math.max(depth, ...Object.values(value).map((entry) => depthOf(entry, depth + 1)));
  }
  return depth;
};

const validId = (value: unknown): value is JsonRpcId => (
  (typeof value === "string" && value.length > 0 && value.length <= maxJsonRpcIdLength)
  || (typeof value === "number" && Number.isSafeInteger(value))
);

const parseRequest = (value: unknown): JsonRpcRequest => {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || depthOf(value) > maxJsonlDepth
  ) throw new Error("Invalid JSON-RPC request.");
  const recordResult = z.record(z.string(), z.unknown()).safeParse(value);
  if (!recordResult.success) throw new Error("Invalid JSON-RPC request.");
  const record = recordResult.data;
  if (
    record.jsonrpc !== "2.0"
    || !validId(record.id)
    || typeof record.method !== "string"
    || record.method.length === 0
    || record.method.length > 128
    || (Object.hasOwn(record, "params") && typeof record.params !== "object")
    || Array.isArray(record.params)
  ) throw new Error("Invalid JSON-RPC request.");
  const keys = Object.keys(record);
  if (keys.some((key) => !["jsonrpc", "id", "method", "params"].includes(key))) {
    throw new Error("Invalid JSON-RPC request.");
  }
  return {
    jsonrpc: "2.0",
    id: record.id,
    method: record.method,
    ...(Object.hasOwn(record, "params") ? { params: record.params } : {}),
  };
};

const methodsFor = (target: ControlOperationTarget): readonly ControlOperationId[] => (
  Object.freeze(listControlOperationDescriptors()
    .map((descriptor) => parseControlOperationId(descriptor.id))
    .filter((operationId) => supportsControlOperation(operationId, target)))
);

const invokeValidated = async (
  invoker: ControlInvoker<"cloud"> | ControlInvoker<"desktop">,
  operationId: ControlOperationId,
  params: unknown,
) => {
  if (invoker.target === "cloud") {
    switch (operationId) {
      case "project.list": return invoker.invoke(operationId, projectListInputSchema.parse(params));
      case "control.capabilities": return invoker.invoke(operationId, canonicalControlCapabilitiesQuerySchema.parse(params));
      case "control.snapshot": return invoker.invoke(operationId, canonicalControlSnapshotQuerySchema.parse(params));
      case "control.preview": return invoker.invoke(operationId, controlPreviewRequestSchemaV1.parse(params));
      case "control.requestApproval": return invoker.invoke(operationId, controlApprovalRequestSchemaV1.parse(params));
      case "control.commit": return invoker.invoke(operationId, controlCommitRequestSchemaV1.parse(params));
      case "control.history": return invoker.invoke(operationId, controlHistoryQuerySchemaV1.parse(params));
      case "control.recoveries": return invoker.invoke(operationId, controlRecoveriesQuerySchemaV1.parse(params));
      case "project.current": throw new Error("Unsupported target.");
    }
  }
  switch (operationId) {
    case "project.list": return invoker.invoke(operationId, projectListInputSchema.parse(params));
    case "project.current": return invoker.invoke(operationId, projectCurrentInputSchema.parse(params));
    case "control.capabilities": return invoker.invoke(operationId, canonicalControlCapabilitiesQuerySchema.parse(params));
    case "control.snapshot": return invoker.invoke(operationId, canonicalControlSnapshotQuerySchema.parse(params));
    case "control.preview": return invoker.invoke(operationId, controlPreviewRequestSchemaV1.parse(params));
    case "control.requestApproval": return invoker.invoke(operationId, controlApprovalRequestSchemaV1.parse(params));
    case "control.commit": return invoker.invoke(operationId, controlCommitRequestSchemaV1.parse(params));
    case "control.history": return invoker.invoke(operationId, controlHistoryQuerySchemaV1.parse(params));
    case "control.recoveries": return invoker.invoke(operationId, controlRecoveriesQuerySchemaV1.parse(params));
  }
};

const processLine = async <Target extends ControlOperationTarget>(
  line: string,
  input: JsonlRpcAdapterOptions,
): Promise<string> => {
  if (new TextEncoder().encode(line).byteLength > maxJsonlLineBytes) {
    return response(null, { error: { code: -32600, message: "Line exceeds the JSONL size limit.", data: canonicalError("invalid-request", "Line exceeds the JSONL size limit.") } });
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return response(null, { error: { code: -32700, message: "Parse error.", data: canonicalError("invalid-input", "Malformed JSON.") } });
  }
  let request: JsonRpcRequest;
  try {
    request = parseRequest(value);
  } catch {
    return response(null, { error: { code: -32600, message: "Invalid Request.", data: canonicalError("invalid-request", "Invalid JSON-RPC request.") } });
  }
  let operationId: ControlOperationId;
  try {
    operationId = parseControlOperationId(request.method);
  } catch {
    return response(request.id, { error: { code: -32601, message: "Method not found.", data: canonicalError("invalid-request", "Unknown control method.") } });
  }
  if (!supportsControlOperation(operationId, input.invoker.target)) {
    return response(request.id, { error: { code: -32601, message: "Method not found.", data: canonicalError("unsupported-target", "Method is not supported by this target.") } });
  }
  const descriptor = controlOperationCatalog[operationId];
  const params = request.params ?? {};
  const parsed = descriptor.input.safeParse(params);
  if (!parsed.success) {
    return response(request.id, { error: { code: -32602, message: "Invalid params.", data: canonicalError("invalid-input", "Invalid method parameters.") } });
  }
  try {
    const result = await invokeValidated(input.invoker, operationId, parsed.data);
    return response(request.id, { result });
  } catch {
    return response(request.id, { error: { code: -32603, message: "Internal error.", data: canonicalError("internal", "Control method failed.") } });
  }
};

export const createJsonlRpcAdapter = (
  input: JsonlRpcAdapterOptions,
): JsonlRpcAdapter => {
  let pending = Promise.resolve("");
  const queued = (line: string) => {
    const result = pending.then(() => processLine(line, input));
    pending = result.then(() => "", () => "");
    return result;
  };
  return Object.freeze({
    processLine: queued,
    methods: () => methodsFor(input.invoker.target),
  });
};

export const processJsonlLines = async (
  lines: AsyncIterable<string>,
  adapter: JsonlRpcAdapter,
  write: (line: string) => void | Promise<void>,
): Promise<void> => {
  for await (const line of lines) await write(await adapter.processLine(line));
};
