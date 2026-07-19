import { z } from "zod"
import {
  controlApprovalRequestSchemaV1, controlApprovalResultSchemaV1, controlCapabilitiesQuerySchemaV1,
  controlCapabilitiesSchemaV1, controlCommitRequestSchemaV1, controlCommitResultSchemaV1,
  controlErrorSchemaV1, controlHistoryQuerySchemaV1, controlHistoryResultSchemaV1,
  controlPreviewRequestSchemaV1, controlPreviewResultSchemaV1, controlRecoveriesQuerySchemaV1,
  controlRecoveriesResultSchemaV1, controlSnapshotQuerySchemaV1, projectSnapshotSchemaV1,
  type ControlErrorV1,
} from "@daw-browser/control"
export type { ControlErrorV1 } from "@daw-browser/control"

export const desktopProtocolVersion = "v1" as const
export const maxDesktopFrameBytes = 1_048_576
export const maxDesktopReplyFrameBytes = 512 * 1024
export const maxDesktopReplyBytes = 64 * 1024 * 1024
export const maxDesktopReplyPayloadBytes = 380 * 1024
export const maxDesktopReplyPayloadBase64Characters = 4 * Math.ceil(maxDesktopReplyPayloadBytes / 3)
export const maxDesktopReplyChunks = Math.ceil(maxDesktopReplyBytes / maxDesktopReplyPayloadBytes)
export const maxCorrelationIdLength = 96
export const maxDeadlineMs = 60_000

const correlationId = z.string().min(1).max(maxCorrelationIdLength).regex(/^[A-Za-z0-9._-]+$/)
const version = z.literal(desktopProtocolVersion)
export const desktopEmptyInputSchemaV1 = z.object({}).strict()
const finiteSeconds = z.number().finite().min(0).max(86_400)
export const desktopSeekInputSchemaV1 = z.object({ seconds: finiteSeconds }).strict()

export const desktopOperationSchemaV1 = z.enum([
  "host.status",
  "host.import.audio",
  "host.export.run",
  "host.export.status",
  "host.export.cancel",
  "transport.status",
  "transport.play",
  "transport.pause",
  "transport.stop",
  "transport.seek",
  "diagnostics.snapshot",
  "control.capabilities",
  "control.snapshot",
  "control.preview",
  "control.commit",
  "control.requestApproval",
  "control.history",
  "control.recoveries",
])
export type DesktopOperationV1 = z.infer<typeof desktopOperationSchemaV1>

const requestInputs = {
  "host.status": desktopEmptyInputSchemaV1,
  "host.import.audio": z.object({
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("path"), path: z.string().min(1).max(4096) }).strict(),
      z.object({ kind: z.literal("picker") }).strict(),
    ]),
  }).strict(),
  "host.export.run": z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("mixdown"),
      format: z.enum(["wav", "mp3", "ogg-opus", "flac"]),
      destination: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("file"), path: z.string().min(1).max(4096) }).strict(),
        z.object({ kind: z.literal("file-picker") }).strict(),
      ]),
      range: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("whole") }).strict(),
        z.object({ mode: z.literal("loop"), startSec: finiteSeconds, endSec: finiteSeconds }).strict().refine((value) => value.startSec < value.endSec),
        z.object({ mode: z.literal("custom"), startSec: finiteSeconds, endSec: finiteSeconds }).strict().refine((value) => value.startSec < value.endSec),
      ]),
      render: z.object({
        sampleRate: z.union([z.literal(44100), z.literal(48000), z.literal(96000)]),
        channels: z.union([z.literal(1), z.literal(2)]),
        normalization: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("none") }).strict(),
          z.object({ mode: z.literal("sample-peak"), targetDbfs: z.number().finite().min(-120).max(0) }).strict(),
          z.object({ mode: z.literal("loudness"), targetLufs: z.number().finite().min(-36).max(-5), ceiling: z.number().finite().min(-12).max(0), limiting: z.enum(["off", "true-peak"]) }).strict(),
        ]),
        tail: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("none") }).strict(),
          z.object({ mode: z.literal("fixed"), durationSec: z.number().finite().min(0).max(60) }).strict(),
          z.object({ mode: z.literal("automatic"), thresholdDbfs: z.number().finite().min(-120).max(-20), holdSec: z.number().finite().min(0.1).max(10), maximumSec: z.number().finite().min(0.1).max(120) }).strict(),
        ]),
      }).strict(),
      encoding: z.object({
        mp3Bitrate: z.number().int().min(32000).max(320000).optional(),
        oggOpusBitrate: z.number().int().min(6000).max(510000).optional(),
        wav: z.union([
          z.object({ codec: z.literal("pcm-s16"), dither: z.enum(["none", "tpdf"]) }).strict(),
          z.object({ codec: z.literal("pcm-s24"), dither: z.enum(["none", "tpdf"]) }).strict(),
          z.object({ codec: z.literal("pcm-f32"), dither: z.literal("none") }).strict(),
        ]),
      }).strict(),
    }).strict(),
    z.object({
      mode: z.literal("stems"),
      formats: z.array(z.enum(["wav", "mp3", "ogg-opus", "flac"])).min(1).max(4).refine((value) => new Set(value).size === value.length),
      destination: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("directory"), path: z.string().min(1).max(4096) }).strict(),
        z.object({ kind: z.literal("directory-picker") }).strict(),
      ]),
      selection: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("all-tracks") }).strict(),
        z.object({ kind: z.literal("selected-tracks"), trackIds: z.array(z.string().min(1).max(256)).min(1).max(500).refine((value) => new Set(value).size === value.length) }).strict(),
      ]),
      stemMode: z.enum(["dry-source", "post-track-fx", "reachable-routing", "channel-output", "full-master-contribution"]),
      range: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("whole") }).strict(),
        z.object({ mode: z.literal("loop"), startSec: finiteSeconds, endSec: finiteSeconds }).strict().refine((value) => value.startSec < value.endSec),
        z.object({ mode: z.literal("custom"), startSec: finiteSeconds, endSec: finiteSeconds }).strict().refine((value) => value.startSec < value.endSec),
      ]),
      render: z.object({
        sampleRate: z.union([z.literal(44100), z.literal(48000), z.literal(96000)]),
        channels: z.union([z.literal(1), z.literal(2)]),
        normalization: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("none") }).strict(),
          z.object({ mode: z.literal("sample-peak"), targetDbfs: z.number().finite().min(-120).max(0) }).strict(),
          z.object({ mode: z.literal("loudness"), targetLufs: z.number().finite().min(-36).max(-5), ceiling: z.number().finite().min(-12).max(0), limiting: z.enum(["off", "true-peak"]) }).strict(),
        ]),
        tail: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("none") }).strict(),
          z.object({ mode: z.literal("fixed"), durationSec: z.number().finite().min(0).max(60) }).strict(),
          z.object({ mode: z.literal("automatic"), thresholdDbfs: z.number().finite().min(-120).max(-20), holdSec: z.number().finite().min(0.1).max(10), maximumSec: z.number().finite().min(0.1).max(120) }).strict(),
        ]),
      }).strict(),
      encoding: z.object({
        mp3Bitrate: z.number().int().min(32000).max(320000).optional(),
        oggOpusBitrate: z.number().int().min(6000).max(510000).optional(),
        wav: z.union([
          z.object({ codec: z.literal("pcm-s16"), dither: z.enum(["none", "tpdf"]) }).strict(),
          z.object({ codec: z.literal("pcm-s24"), dither: z.enum(["none", "tpdf"]) }).strict(),
          z.object({ codec: z.literal("pcm-f32"), dither: z.literal("none") }).strict(),
        ]),
      }).strict(),
    }).strict(),
  ]),
  "host.export.status": desktopEmptyInputSchemaV1,
  "host.export.cancel": z.object({ jobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/) }).strict(),
  "transport.status": desktopEmptyInputSchemaV1,
  "transport.play": desktopEmptyInputSchemaV1,
  "transport.pause": desktopEmptyInputSchemaV1,
  "transport.stop": desktopEmptyInputSchemaV1,
  "transport.seek": desktopSeekInputSchemaV1,
  "diagnostics.snapshot": desktopEmptyInputSchemaV1,
  "control.capabilities": controlCapabilitiesQuerySchemaV1,
  "control.snapshot": controlSnapshotQuerySchemaV1,
  "control.preview": controlPreviewRequestSchemaV1,
  "control.commit": controlCommitRequestSchemaV1,
  "control.requestApproval": controlApprovalRequestSchemaV1,
  "control.history": controlHistoryQuerySchemaV1,
  "control.recoveries": controlRecoveriesQuerySchemaV1,
} as const

export const desktopHostImportInputSchemaV1 = requestInputs["host.import.audio"]
const mixdownExtensionMatchesFormat = (format: string, filePath: string) => {
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
  return (format === "wav" && extension === ".wav")
    || (format === "mp3" && extension === ".mp3")
    || (format === "ogg-opus" && extension === ".ogg")
    || (format === "flac" && extension === ".flac")
}
export const desktopHostExportRunInputSchemaV1 = requestInputs["host.export.run"].superRefine((value, context) => {
  if (value.mode !== "mixdown" || value.destination.kind !== "file") return
  if (!mixdownExtensionMatchesFormat(value.format, value.destination.path)) {
    context.addIssue({ code: "custom", message: "Mixdown file extension must match the selected format.", path: ["destination", "path"] })
  }
})
export const desktopHostExportCancelInputSchemaV1 = requestInputs["host.export.cancel"]

const capabilityToken = z.string().regex(/^[a-f0-9]{64}$/)
const capabilityFile = z.object({
  token: capabilityToken,
  basename: z.string().min(1).max(256),
}).strict()
export const desktopRendererImportInputSchemaV1 = z.object({
  canceled: z.boolean(),
  files: z.array(z.object({
    ...capabilityFile.shape,
    mime: z.string().min(1).max(128),
  }).strict()).min(1).max(1).optional(),
}).strict().superRefine((value, context) => {
  if (!value.canceled && value.files === undefined) context.addIssue({ code: "custom", message: "A non-canceled import requires a file capability." })
})
const internalExportDestination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("capability-file"), ...capabilityFile.shape }).strict(),
  z.object({ kind: z.literal("capability-directory"), ...capabilityFile.shape }).strict(),
])
const internalExportRequestKeys = new Set([
  "canceled", "preflightOnly", "destination", "mode", "format", "formats", "range",
  "render", "encoding", "selection", "stemMode",
])
const activeInternalExport = z.object({
  canceled: z.literal(false),
  preflightOnly: z.literal(true).optional(),
  destination: internalExportDestination,
}).passthrough().superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (!internalExportRequestKeys.has(key)) {
      context.addIssue({ code: "unrecognized_keys", keys: [key], path: [] })
    }
  }
  const { canceled: _canceled, preflightOnly: _preflightOnly, ...request } = value
  const externalDestination = value.destination.kind === "capability-file"
    ? { kind: "file" as const, path: `/capability/${value.destination.basename}` }
    : { kind: "directory" as const, path: "/capability" }
  const parsed = desktopHostExportRunInputSchemaV1.safeParse({ ...request, destination: externalDestination })
  if (!parsed.success) context.addIssue({ code: "custom", message: "Invalid renderer export operation input." })
})
const canceledInternalExport = z.discriminatedUnion("mode", [
  z.object({ canceled: z.literal(true), mode: z.literal("mixdown") }).strict(),
  z.object({ canceled: z.literal(true), mode: z.literal("stems") }).strict(),
])
export const desktopRendererExportInputSchemaV1 = z.union([
  canceledInternalExport,
  activeInternalExport,
])
export type DesktopRendererImportInputV1 = z.infer<typeof desktopRendererImportInputSchemaV1>
export type DesktopRendererExportInputV1 = z.infer<typeof desktopRendererExportInputSchemaV1>

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
const safeExportOutputSchema = z.object({ name: z.string().min(1).max(256), sizeBytes: z.number().int().nonnegative().max(8 * 1024 * 1024 * 1024) }).strict()
export const desktopHostImportResultSchemaV1 = z.object({
  status: z.enum(["created", "queued", "canceled", "failed"]),
  count: z.number().int().min(0).max(1),
}).strict()
export const desktopHostExportRunResultSchemaV1 = z.object({
  status: z.enum(["queued", "canceled"]),
  jobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
}).strict().refine((value) => value.status === "canceled" || value.jobId !== undefined)
export const desktopHostExportStatusSchemaV1 = z.object({
  status: z.enum(["idle", "queued", "running", "completed", "canceled", "failed"]),
  job: z.object({
    id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
    phase: z.string().min(1).max(32).optional(),
    sizeBytes: z.number().int().nonnegative().max(8 * 1024 * 1024 * 1024).optional(),
    outputs: z.array(safeExportOutputSchema).max(1024).optional(),
  }).strict().optional(),
}).strict()

export type DesktopOperationMapV1 = {
  "host.status": { input: Record<string, never>; result: z.infer<typeof desktopHostStatusSchemaV1> }
  "host.import.audio": { input: z.infer<typeof requestInputs["host.import.audio"]>; result: z.infer<typeof desktopHostImportResultSchemaV1> }
  "host.export.run": { input: z.infer<typeof requestInputs["host.export.run"]>; result: z.infer<typeof desktopHostExportRunResultSchemaV1> }
  "host.export.status": { input: Record<string, never>; result: z.infer<typeof desktopHostExportStatusSchemaV1> }
  "host.export.cancel": { input: z.infer<typeof requestInputs["host.export.cancel"]>; result: z.infer<typeof desktopHostExportStatusSchemaV1> }
  "transport.status": { input: Record<string, never>; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "transport.play": { input: Record<string, never>; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "transport.pause": { input: Record<string, never>; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "transport.stop": { input: Record<string, never>; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "transport.seek": { input: { seconds: number }; result: z.infer<typeof desktopTransportStatusSchemaV1> }
  "diagnostics.snapshot": { input: Record<string, never>; result: z.infer<typeof desktopDiagnosticsSchemaV1> }
  "control.capabilities": { input: z.infer<typeof controlCapabilitiesQuerySchemaV1>; result: z.infer<typeof controlCapabilitiesSchemaV1> }
  "control.snapshot": { input: z.infer<typeof controlSnapshotQuerySchemaV1>; result: z.infer<typeof projectSnapshotSchemaV1> }
  "control.preview": { input: z.infer<typeof controlPreviewRequestSchemaV1>; result: z.infer<typeof controlPreviewResultSchemaV1> }
  "control.commit": { input: z.infer<typeof controlCommitRequestSchemaV1>; result: z.infer<typeof controlCommitResultSchemaV1> }
  "control.requestApproval": { input: z.infer<typeof controlApprovalRequestSchemaV1>; result: z.infer<typeof controlApprovalResultSchemaV1> }
  "control.history": { input: z.infer<typeof controlHistoryQuerySchemaV1>; result: z.infer<typeof controlHistoryResultSchemaV1> }
  "control.recoveries": { input: z.infer<typeof controlRecoveriesQuerySchemaV1>; result: z.infer<typeof controlRecoveriesResultSchemaV1> }
}

const request = z.object({
  version,
  type: z.literal("request"),
  id: correlationId,
  operation: desktopOperationSchemaV1,
  input: z.unknown(),
  deadlineMs: z.number().int().positive().max(maxDeadlineMs).optional(),
}).strict().superRefine((value, context) => {
  const schema = value.operation === "host.export.run"
    ? desktopHostExportRunInputSchemaV1
    : requestInputs[value.operation]
  const parsed = schema.safeParse(value.input)
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
const rendererRequest = z.object({
  version,
  type: z.literal("request"),
  id: correlationId,
  operation: desktopOperationSchemaV1.exclude(["control.capabilities", "control.snapshot", "control.preview", "control.commit", "control.requestApproval", "control.history", "control.recoveries"]),
  input: z.unknown(),
  deadlineMs: z.number().int().positive().max(maxDeadlineMs).optional(),
}).strict().superRefine((value, context) => {
  const schema = value.operation === "host.import.audio"
    ? desktopRendererImportInputSchemaV1
    : value.operation === "host.export.run"
      ? desktopRendererExportInputSchemaV1
      : requestInputs[value.operation]
  if (!schema.safeParse(value.input).success) {
    context.addIssue({ code: "custom", message: "Invalid renderer operation input.", path: ["input"] })
  }
})
export const desktopRendererRequestSchemaV1 = z.union([rendererRequest, lifecyclePrepareToCloseRequest])
export type DesktopRendererRequestV1 = z.infer<typeof desktopRendererRequestSchemaV1>

export const desktopControlOperationSchemaV1 = z.enum([
  "control.capabilities", "control.snapshot", "control.preview", "control.commit",
  "control.requestApproval", "control.history", "control.recoveries",
])
export type DesktopControlOperationV1 = z.infer<typeof desktopControlOperationSchemaV1>
export const isDesktopControlOperation = (operation: DesktopOperationV1): operation is DesktopControlOperationV1 => (
  desktopControlOperationSchemaV1.safeParse(operation).success
)
const trustedRendererControlRequest = z.object({
  version, type: z.literal("request"), id: correlationId, operation: desktopControlOperationSchemaV1,
  input: z.unknown(), deadlineMs: z.number().int().positive().max(maxDeadlineMs).optional(),
  actorSubject: z.string().regex(/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
}).strict().superRefine((value, context) => {
  if (!requestInputs[value.operation].safeParse(value.input).success) {
    context.addIssue({ code: "custom", message: "Invalid renderer control operation input.", path: ["input"] })
  }
})
export const desktopTrustedRendererRequestSchemaV1 = z.union([desktopRendererRequestSchemaV1, trustedRendererControlRequest])
export type DesktopTrustedRendererRequestV1 = z.infer<typeof desktopTrustedRendererRequestSchemaV1>

export const desktopReplySchemaV1 = z.object({
  version,
  type: z.literal("reply"),
  id: correlationId,
  result: z.unknown().optional(),
  error: z.union([hostErrorSchemaV1, controlErrorSchemaV1]).optional(),
}).strict().superRefine((value, context) => {
  if ((value.result === undefined) === (value.error === undefined)) context.addIssue({ code: "custom", message: "Reply requires exactly one result or error." })
})
export const desktopCancelSchemaV1 = z.object({ version, type: z.literal("cancel"), id: correlationId }).strict()
export const desktopReplyChunkSchemaV1 = z.object({
  version, type: z.literal("replyChunk"), id: correlationId, operation: desktopOperationSchemaV1,
  index: z.number().int().nonnegative(), total: z.number().int().positive().max(maxDesktopReplyChunks),
  byteLength: z.number().int().positive().max(maxDesktopReplyBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.string().max(maxDesktopReplyPayloadBase64Characters).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict().refine((value) => value.index < value.total)
export const desktopProgressSchemaV1 = z.object({ version, type: z.literal("progress"), id: correlationId, message: z.string().max(256) }).strict()
export const desktopExportTerminalSchemaV1 = z.object({
  version,
  type: z.literal("export-terminal"),
  jobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  status: z.enum(["success", "canceled", "error"]),
}).strict()
export const desktopHelloSchemaV1 = z.object({ version, type: z.literal("hello"), secret: z.string().regex(/^[a-f0-9]{64}$/), client: z.string().min(1).max(128), actorId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) }).strict()
export const desktopHelloAckSchemaV1 = z.object({ version, type: z.literal("helloAck"), sessionId: z.string().min(16).max(128), capabilities: z.array(desktopOperationSchemaV1).max(desktopOperationSchemaV1.options.length) }).strict()
export const desktopLifecycleSchemaV1 = z.object({ version, type: z.literal("lifecycle"), event: z.enum(["renderer-lost", "closing"]) }).strict()
export const desktopFrameSchemaV1 = z.discriminatedUnion("type", [desktopRequestSchemaV1, desktopReplySchemaV1, desktopReplyChunkSchemaV1, desktopCancelSchemaV1, desktopProgressSchemaV1, desktopExportTerminalSchemaV1, desktopHelloSchemaV1, desktopHelloAckSchemaV1, desktopLifecycleSchemaV1])
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

const resultSchemas = {
  "host.status": desktopHostStatusSchemaV1,
  "host.import.audio": desktopHostImportResultSchemaV1,
  "host.export.run": desktopHostExportRunResultSchemaV1,
  "host.export.status": desktopHostExportStatusSchemaV1,
  "host.export.cancel": desktopHostExportStatusSchemaV1,
  "transport.status": desktopTransportStatusSchemaV1,
  "transport.play": desktopTransportStatusSchemaV1,
  "transport.pause": desktopTransportStatusSchemaV1,
  "transport.stop": desktopTransportStatusSchemaV1,
  "transport.seek": desktopTransportStatusSchemaV1,
  "diagnostics.snapshot": desktopDiagnosticsSchemaV1,
  "control.capabilities": controlCapabilitiesSchemaV1,
  "control.snapshot": projectSnapshotSchemaV1,
  "control.preview": controlPreviewResultSchemaV1,
  "control.commit": controlCommitResultSchemaV1,
  "control.requestApproval": controlApprovalResultSchemaV1,
  "control.history": controlHistoryResultSchemaV1,
  "control.recoveries": controlRecoveriesResultSchemaV1,
} satisfies Record<DesktopOperationV1, z.ZodType>

export const parseDesktopResult = (operation: DesktopOperationV1, value: unknown): unknown => (
  resultSchemas[operation].parse(value)
)

export const parseDesktopReplyError = (operation: DesktopOperationV1, value: unknown): HostErrorV1 | ControlErrorV1 => (
  isDesktopControlOperation(operation)
    ? controlErrorSchemaV1.safeParse(value).success
      ? controlErrorSchemaV1.parse(value)
      : hostErrorSchemaV1.parse(value)
    : hostErrorSchemaV1.parse(value)
)

export const hostError = (code: HostErrorV1["code"], message: string): HostErrorV1 => ({ version: desktopProtocolVersion, code, message })
