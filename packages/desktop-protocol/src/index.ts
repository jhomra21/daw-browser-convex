import { z } from "zod"

export const desktopProtocolVersion = "v1" as const
export const maxDesktopFrameBytes = 1_048_576
export const maxCorrelationIdLength = 96
export const maxDeadlineMs = 60_000

const correlationId = z.string().min(1).max(maxCorrelationIdLength).regex(/^[A-Za-z0-9._-]+$/)
const version = z.literal(desktopProtocolVersion)
export const desktopEmptyInputSchemaV1 = z.object({}).strict()
const finiteSeconds = z.number().finite().min(0).max(86_400)
export const desktopSeekInputSchemaV1 = z.object({ seconds: finiteSeconds }).strict()

export const desktopOperationSchemaV1 = z.enum([
  "host.status",
  "transport.status",
  "transport.play",
  "transport.pause",
  "transport.stop",
  "transport.seek",
  "diagnostics.snapshot",
])
export type DesktopOperationV1 = z.infer<typeof desktopOperationSchemaV1>

const requestInputs = {
  "host.status": desktopEmptyInputSchemaV1,
  "transport.status": desktopEmptyInputSchemaV1,
  "transport.play": desktopEmptyInputSchemaV1,
  "transport.pause": desktopEmptyInputSchemaV1,
  "transport.stop": desktopEmptyInputSchemaV1,
  "transport.seek": desktopSeekInputSchemaV1,
  "diagnostics.snapshot": desktopEmptyInputSchemaV1,
} as const

export const hostErrorSchemaV1 = z.object({
  version,
  code: z.enum(["invalid-request", "unauthorized", "unsupported-version", "unavailable", "cancelled", "deadline-exceeded", "internal"]),
  message: z.string().min(1).max(512),
}).strict()
export type HostErrorV1 = z.infer<typeof hostErrorSchemaV1>

export const desktopHostStatusSchemaV1 = z.object({
  project: z.object({ id: z.string().min(1).max(256), kind: z.enum(["local", "cloud"]) }).nullable(),
  ready: z.boolean(),
  transport: z.enum(["playing", "paused", "stopped"]),
  capabilities: z.object({
    playback: z.boolean(),
    diagnostics: z.boolean(),
  }).strict(),
}).strict()
export const desktopTransportStatusSchemaV1 = z.object({ state: z.enum(["playing", "paused", "stopped"]), playheadSec: finiteSeconds }).strict()
export const desktopDiagnosticsSchemaV1 = z.object({
  audio: z.object({
    state: z.string().max(64),
    sampleRate: z.number().finite().nullable(),
  }).strict(),
  recording: z.object({
    transport: z.enum(["sab", "transferable"]).nullable(),
    capturedFrames: z.number().int().nonnegative().nullable(),
    droppedFrames: z.number().int().nonnegative().nullable(),
    deviceLost: z.boolean(),
  }).strict(),
  counts: z.object({ tracks: z.number().int().nonnegative(), clips: z.number().int().nonnegative() }).strict(),
}).strict()

export type DesktopOperationMapV1 = {
  "host.status": { input: Record<string, never>; result: z.infer<typeof desktopHostStatusSchemaV1> }
  "transport.status": { input: Record<string, never>; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "transport.play": { input: Record<string, never>; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "transport.pause": { input: Record<string, never>; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "transport.stop": { input: Record<string, never>; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "transport.seek": { input: { seconds: number }; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "diagnostics.snapshot": { input: Record<string, never>; result: z.infer<typeof desktopDiagnosticsSchemaV1> }
}

const request = z.object({
  version,
  type: z.literal("request"),
  id: correlationId,
  operation: desktopOperationSchemaV1,
  input: z.unknown(),
  deadlineMs: z.number().int().positive().max(maxDeadlineMs).optional(),
}).strict().superRefine((value, context) => {
  const parsed = requestInputs[value.operation].safeParse(value.input)
  if (!parsed.success) context.addIssue({ code: "custom", message: "Invalid operation input.", path: ["input"] })
})
export const desktopRequestSchemaV1 = request
export type DesktopRequestV1 = z.infer<typeof request>

const lifecyclePrepareToCloseRequest = z.object({
  version,
  type: z.literal("request"),
  id: correlationId,
  operation: z.literal("lifecycle.prepareToClose"),
  input: desktopEmptyInputSchemaV1,
  deadlineMs: z.number().int().positive().max(maxDeadlineMs).optional(),
}).strict()
export const desktopRendererRequestSchemaV1 = z.union([desktopRequestSchemaV1, lifecyclePrepareToCloseRequest])
export type DesktopRendererRequestV1 = z.infer<typeof desktopRendererRequestSchemaV1>

export const desktopReplySchemaV1 = z.object({
  version,
  type: z.literal("reply"),
  id: correlationId,
  result: z.unknown().optional(),
  error: hostErrorSchemaV1.optional(),
}).strict().superRefine((value, context) => {
  if ((value.result === undefined) === (value.error === undefined)) context.addIssue({ code: "custom", message: "Reply requires exactly one result or error." })
})
export const desktopCancelSchemaV1 = z.object({ version, type: z.literal("cancel"), id: correlationId }).strict()
export const desktopProgressSchemaV1 = z.object({ version, type: z.literal("progress"), id: correlationId, message: z.string().max(256) }).strict()
export const desktopHelloSchemaV1 = z.object({ version, type: z.literal("hello"), secret: z.string().regex(/^[a-f0-9]{64}$/), client: z.string().min(1).max(128) }).strict()
export const desktopHelloAckSchemaV1 = z.object({ version, type: z.literal("helloAck"), sessionId: z.string().min(16).max(128), capabilities: z.array(desktopOperationSchemaV1).max(8) }).strict()
export const desktopLifecycleSchemaV1 = z.object({ version, type: z.literal("lifecycle"), event: z.enum(["renderer-lost", "closing"]) }).strict()
export const desktopFrameSchemaV1 = z.discriminatedUnion("type", [desktopRequestSchemaV1, desktopReplySchemaV1, desktopCancelSchemaV1, desktopProgressSchemaV1, desktopHelloSchemaV1, desktopHelloAckSchemaV1, desktopLifecycleSchemaV1])
export type DesktopFrameV1 = z.infer<typeof desktopFrameSchemaV1>

export const desktopRegistrationSchemaV1 = z.object({
  version,
  instanceId: z.string().regex(/^[a-f0-9]{32}$/),
  pid: z.number().int().positive(),
  createdAt: z.number().int().positive(),
  address: z.string().min(1).max(512),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type DesktopRegistrationV1 = z.infer<typeof desktopRegistrationSchemaV1>

export const parseDesktopResult = (operation: DesktopOperationV1, value: unknown): unknown => {
  const schema = operation === "host.status" ? desktopHostStatusSchemaV1
    : operation === "diagnostics.snapshot" ? desktopDiagnosticsSchemaV1
      : desktopTransportStatusSchemaV1
  return schema.parse(value)
}

export const hostError = (code: HostErrorV1["code"], message: string): HostErrorV1 => ({ version: desktopProtocolVersion, code, message })
