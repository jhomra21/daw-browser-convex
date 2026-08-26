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
  controlLimitsV1,
  controlErrorSchemaV1,
  type ControlInvoker,
  type ControlOperationId,
  type ControlOperationTarget,
  type ControlErrorV1,
} from "@daw-browser/control";
import { z } from "zod";

// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-conditional-empty-object-spread

export const maxJsonlLineBytes = 64 * 1024;
export const jsonlLineTooLarge: { readonly kind: "too-large" } = Object.freeze({ kind: "too-large" });
export type JsonlLine = string | typeof jsonlLineTooLarge;
export const maxJsonlDepth = 12;
export const maxJsonRpcIdLength = 128;

type JsonRpcId = string | number;
type JsonRpcRequest = Readonly<{
  jsonrpc: "2.0";
  id?: JsonRpcId;
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
  processLine: (line: JsonlLine) => Promise<string | undefined>;
  methods: () => readonly ControlOperationId[];
}>;

type JsonlRpcAdapterOptions = Readonly<{
  invoker: ControlInvoker<"cloud"> | ControlInvoker<"desktop">;
}>;

const canonicalError = (
  code: "invalid-request" | "unsupported-target" | "invalid-input" | "internal",
  message: string,
): ControlErrorV1 => ({
  version: "v1",
  code: code === "unsupported-target" ? "unsupported-action" : code === "invalid-input" ? "validation" : code,
  message,
});

const domainError = (error: unknown): ControlErrorV1 | undefined => {
  const direct = controlErrorSchemaV1.safeParse(error);
  const wrapped = z.object({
    data: z.unknown(),
    errorData: z.unknown().optional(),
  }).passthrough().safeParse(error);
  const candidates = [
    error,
    ...(wrapped.success ? [wrapped.data.data, wrapped.data.errorData] : []),
  ];
  if (direct.success) return direct.data;
  for (const candidate of candidates) {
    const record = z.record(z.string(), z.unknown()).safeParse(candidate);
    if (!record.success) continue;
    const detailsRecord = z.record(z.string(), z.unknown()).safeParse(record.data.details);
    const details: Record<string, string> = {};
    if (detailsRecord.success) {
      for (const [key, value] of Object.entries(detailsRecord.data)) {
        if (key.length <= 64 && typeof value === "string" && value.length <= 1000) {
          details[key] = value;
        }
        if (Object.keys(details).length >= controlLimitsV1.maxErrorDetails) break;
      }
    }
    const parsed = controlErrorSchemaV1.safeParse({
      version: record.data.version,
      code: record.data.code,
      message: record.data.message,
      ...(typeof record.data.actionIndex === "number" ? { actionIndex: record.data.actionIndex } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    });
    if (parsed.success) return parsed.data;
  }
  return undefined;
};

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
    || (Object.hasOwn(record, "id") && !validId(record.id))
    || typeof record.method !== "string"
    || record.method.length === 0
    || record.method.length > 128
    || (Object.hasOwn(record, "params") && (typeof record.params !== "object" || record.params === null))
    || Array.isArray(record.params)
  ) throw new Error("Invalid JSON-RPC request.");
  const keys = Object.keys(record);
  if (keys.some((key) => !["jsonrpc", "id", "method", "params"].includes(key))) {
    throw new Error("Invalid JSON-RPC request.");
  }
  return {
    jsonrpc: "2.0",
    ...(validId(record.id) ? { id: record.id } : {}),
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

const processLine = async (
  line: JsonlLine,
  input: JsonlRpcAdapterOptions,
): Promise<string | undefined> => {
  if (typeof line !== "string") {
    return response(null, { error: { code: -32600, message: "Line exceeds the JSONL size limit.", data: canonicalError("invalid-request", "Line exceeds the JSONL size limit.") } });
  }
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
  const notification = request.id === undefined;
  const reply = (
    id: JsonRpcId | null,
    value: Omit<JsonRpcResponse, "jsonrpc" | "id">,
  ): string | undefined => notification ? undefined : response(id, value);
  let operationId: ControlOperationId;
  try {
    operationId = parseControlOperationId(request.method);
  } catch {
    return reply(request.id ?? null, { error: { code: -32601, message: "Method not found.", data: canonicalError("invalid-request", "Unknown control method.") } });
  }
  if (!supportsControlOperation(operationId, input.invoker.target)) {
    return reply(request.id ?? null, { error: { code: -32601, message: "Method not found.", data: canonicalError("unsupported-target", "Method is not supported by this target.") } });
  }
  const descriptor = controlOperationCatalog[operationId];
  const params = request.params ?? {};
  const parsed = descriptor.input.safeParse(params);
  if (!parsed.success) {
    return reply(request.id ?? null, { error: { code: -32602, message: "Invalid params.", data: canonicalError("invalid-input", "Invalid method parameters.") } });
  }
  try {
    const result = await invokeValidated(input.invoker, operationId, parsed.data);
    return reply(request.id ?? null, { result });
  } catch (error) {
    const normalized = domainError(error);
    return reply(request.id ?? null, normalized
      ? { error: { code: -32000, message: "Control operation failed.", data: normalized } }
      : { error: { code: -32603, message: "Internal error.", data: canonicalError("internal", "Control method failed.") } });
  }
};

export const createJsonlRpcAdapter = (
  input: JsonlRpcAdapterOptions,
): JsonlRpcAdapter => {
  let pending = Promise.resolve();
  const queued = (line: JsonlLine) => {
    const result = pending.then(() => processLine(line, input));
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  return Object.freeze({
    processLine: queued,
    methods: () => methodsFor(input.invoker.target),
  });
};

export const processJsonlLines = async (
  lines: AsyncIterable<JsonlLine>,
  adapter: JsonlRpcAdapter,
  write: (line: string) => void | Promise<void>,
): Promise<void> => {
  for await (const line of lines) {
    const output = await adapter.processLine(line);
    if (output !== undefined) await write(output);
  }
};

export const decodeJsonlLines = async function* (
  chunks: AsyncIterable<Uint8Array>,
  maxBytes = maxJsonlLineBytes,
): AsyncIterable<JsonlLine> {
  const buffer = new Uint8Array(maxBytes);
  const textDecoder = new TextDecoder();
  let length = 0;
  let oversized = false;
  let carriageReturn = false;
  const reset = () => {
    length = 0;
    oversized = false;
    carriageReturn = false;
  };
  const append = (byte: number) => {
    if (oversized) return;
    if (length === maxBytes) {
      oversized = true;
      return;
    }
    buffer[length] = byte;
    length += 1;
  };
  for await (const chunk of chunks) {
    for (const byte of chunk) {
      if (carriageReturn) {
        carriageReturn = false;
        if (byte === 0x0A) {
          if (oversized) yield jsonlLineTooLarge;
          else yield textDecoder.decode(buffer.subarray(0, length));
          reset();
          continue;
        }
        append(0x0D);
      }
      if (byte === 0x0D) {
        carriageReturn = true;
        continue;
      }
      if (byte === 0x0A) {
        if (oversized) {
          yield jsonlLineTooLarge;
        } else {
          yield textDecoder.decode(buffer.subarray(0, length));
        }
        reset();
        continue;
      }
      append(byte);
    }
  }
  if (carriageReturn) append(0x0D);
  if (oversized) yield jsonlLineTooLarge;
  else if (length > 0) yield textDecoder.decode(buffer.subarray(0, length));
};
