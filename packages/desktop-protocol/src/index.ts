import { z } from "zod"
import {
  controlApprovalRequestSchemaV1, type controlApprovalResultSchemaV1, controlCapabilitiesQuerySchemaV1,
  controlCapabilitiesSchemaV1, controlCommitRequestSchemaV1,
  type controlCommitResultSchemaV1,
  controlCapabilitiesQuerySchemaV2, controlCapabilitiesSchemaV2,
  controlErrorSchemaV1, controlHistoryQuerySchemaV1, type controlHistoryResultSchemaV1,
  controlPreviewRequestSchemaV1, type controlPreviewResultSchemaV1, controlRecoveriesQuerySchemaV1,
  type controlRecoveriesResultSchemaV1,
  controlSnapshotQuerySchemaV1,
  canonicalControlCapabilitiesSchema, canonicalProjectSnapshotSchema,
  getControlOperationDescriptor, projectCanonicalControlCapabilitiesV1,
  projectCanonicalProjectSnapshotV1,
  projectIdSchemaV1, projectSnapshotSchemaV1, projectSnapshotSchemaV2,
  type ControlErrorV1,
} from "@daw-browser/control"
export { projectIdSchemaV1 } from "@daw-browser/control"
import { pluginHealthSchema } from "@daw-browser/plugin-host-protocol"
export type { ControlErrorV1 } from "@daw-browser/control"

export const desktopProtocolVersion = "v1" as const
export const desktopProtocolVersionV2 = "v2" as const
export const desktopProtocolVersions = [desktopProtocolVersion, desktopProtocolVersionV2] as const
export type DesktopProtocolVersion = typeof desktopProtocolVersions[number]
export const maxDesktopFrameBytes = 1_048_576
export const maxDesktopReplyFrameBytes = 512 * 1024
export const maxDesktopReplyBytes = 64 * 1024 * 1024
export const maxDesktopReplyPayloadBytes = 380 * 1024
export const maxDesktopReplyPayloadBase64Characters = 4 * Math.ceil(maxDesktopReplyPayloadBytes / 3)
export const maxDesktopReplyChunks = Math.ceil(maxDesktopReplyBytes / maxDesktopReplyPayloadBytes)
export const maxCorrelationIdLength = 96
export const maxDeadlineMs = 60_000

export type DesktopJsonValue =
  | null
  | boolean
  | number
  | string
  | DesktopJsonValue[]
  | { [key: string]: DesktopJsonValue }

export const desktopJsonValueSchema: z.ZodType<DesktopJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(desktopJsonValueSchema),
  z.record(z.string(), desktopJsonValueSchema),
]))

export const desktopVstParameterEditPayloadSchema = z.object({
  projectId: projectIdSchemaV1,
  source: z.enum(["active-playback", "editor-session"]),
  instanceId: z.string().uuid(),
  parameterId: z.number().int().min(0).max(0xffff_ffff),
  normalizedValue: z.number().finite().min(0).max(1),
}).strict()
export type DesktopVstParameterEditPayload = z.infer<typeof desktopVstParameterEditPayloadSchema>

const correlationId = z.string().min(1).max(maxCorrelationIdLength).regex(/^[A-Za-z0-9._-]+$/)
const version = z.literal(desktopProtocolVersion)
const versionV2 = z.literal(desktopProtocolVersionV2)
export const desktopEmptyInputSchemaV1 = z.object({}).strict()
const finiteSeconds = z.number().finite().min(0).max(86_400)
export const desktopSeekInputSchemaV1 = z.object({ seconds: finiteSeconds }).strict()
export const desktopHostVstCursorSchemaV1 = z.string().min(1).max(String(0xffff_ffff).length).regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => Number(value) <= 0xffff_ffff)

export const desktopOperationSchemaV1 = z.enum([
  "host.status",
  "host.vst.instances",
  "host.vst.parameters",
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

export const desktopControlCapabilitiesInputSchemaV1 = controlCapabilitiesQuerySchemaV1
export const desktopControlSnapshotInputSchemaV1 = controlSnapshotQuerySchemaV1
export const desktopRendererControlCapabilitiesInputSchemaV1 = controlCapabilitiesQuerySchemaV1.extend({
  readVersion: z.literal("v2").optional(),
}).strict()
export const desktopRendererControlSnapshotInputSchemaV1 = controlSnapshotQuerySchemaV1.extend({
  readVersion: z.literal("v2").optional(),
}).strict()
export const desktopControlCapabilitiesInputSchemaV2 = controlCapabilitiesQuerySchemaV2.extend({
  readVersion: z.literal("v2"),
}).strict()
export const desktopControlSnapshotInputSchemaV2 = controlSnapshotQuerySchemaV1.extend({
  readVersion: z.literal("v2"),
}).strict()

const requestInputs = {
  "host.status": desktopEmptyInputSchemaV1,
  "host.vst.instances": z.object({
    projectId: projectIdSchemaV1,
    cursor: desktopHostVstCursorSchemaV1.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }).strict(),
  "host.vst.parameters": z.object({
    projectId: projectIdSchemaV1,
    instanceId: z.string().uuid(),
    cursor: desktopHostVstCursorSchemaV1.optional(),
    limit: z.number().int().min(1).max(256).default(100),
  }).strict(),
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
  "control.capabilities": desktopControlCapabilitiesInputSchemaV1,
  "control.snapshot": desktopControlSnapshotInputSchemaV1,
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
export const desktopHostVstInstancesInputSchemaV1 = requestInputs["host.vst.instances"]
export const desktopHostVstParametersInputSchemaV1 = requestInputs["host.vst.parameters"]
export type DesktopHostVstInstancesInputV1 = z.infer<typeof desktopHostVstInstancesInputSchemaV1>
export type DesktopHostVstParametersInputV1 = z.infer<typeof desktopHostVstParametersInputSchemaV1>

const capabilityToken = z.string().regex(/^[a-f0-9]{64}$/)
const capabilityFile = z.object({
  token: capabilityToken,
  basename: z.string().min(1).max(256),
}).strict()
export const desktopRendererImportInputSchemaV1 = z.object({
  canceled: z.boolean(),
  files: z.array(capabilityFile.extend({
    mime: z.string().min(1).max(128),
  }).strict()).min(1).max(1).optional(),
}).strict().superRefine((value, context) => {
  if (!value.canceled && value.files === undefined) context.addIssue({ code: "custom", message: "A non-canceled import requires a file capability." })
})
const internalExportDestination = z.discriminatedUnion("kind", [
  capabilityFile.extend({ kind: z.literal("capability-file") }).strict(),
  capabilityFile.extend({ kind: z.literal("capability-directory") }).strict(),
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
export const hostErrorSchemaV2 = hostErrorSchemaV1.extend({ version: versionV2 })
export type HostErrorV2 = z.infer<typeof hostErrorSchemaV2>

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
export const desktopHostVstIdentitySchemaV1 = z.object({
  format: z.literal("vst3"),
  classId: z.string().min(1).max(128),
  vendor: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  architecture: z.literal("arm64"),
}).strict()
export const desktopHostVstParameterSchemaV1 = z.object({
  id: z.number().int().nonnegative().max(0xffff_ffff),
  title: z.string().min(1).max(256),
  unit: z.string().max(64),
  minimum: z.number().finite(),
  maximum: z.number().finite(),
  defaultValue: z.number().finite(),
  stepCount: z.number().int().nonnegative().max(1_000_000),
  readOnly: z.boolean(),
  hidden: z.boolean(),
  currentValue: z.number().finite().min(0).max(1),
}).strict().superRefine((value, context) => {
  if (value.minimum > value.maximum) context.addIssue({ code: "custom", message: "Parameter minimum exceeds maximum." })
  if (value.defaultValue < value.minimum || value.defaultValue > value.maximum) context.addIssue({ code: "custom", message: "Parameter default is outside its range." })
})
export const desktopHostVstInstancesResultSchemaV1 = z.object({
  projectId: projectIdSchemaV1,
  instances: z.array(z.object({
    instanceId: z.string().uuid(),
    targetId: z.string().min(1).max(256),
    stageIndex: z.number().int().nonnegative(),
    identity: desktopHostVstIdentitySchemaV1,
    role: z.enum(["effect", "instrument"]),
    bypassed: z.boolean(),
    health: pluginHealthSchema,
    parameterCount: z.number().int().min(0).max(16_384),
    supportsEditor: z.boolean(),
    supportsState: z.boolean(),
  }).strict()).max(100),
  nextCursor: desktopHostVstCursorSchemaV1.nullable(),
}).strict()
export const desktopHostVstParametersResultSchemaV1 = z.object({
  projectId: projectIdSchemaV1,
  instanceId: z.string().uuid(),
  parameters: z.array(desktopHostVstParameterSchemaV1).max(256),
  nextCursor: desktopHostVstCursorSchemaV1.nullable(),
}).strict()
export type DesktopHostVstInstancesResultV1 = z.infer<typeof desktopHostVstInstancesResultSchemaV1>
export type DesktopHostVstParametersResultV1 = z.infer<typeof desktopHostVstParametersResultSchemaV1>
export type DesktopHostVstIdentityV1 = z.infer<typeof desktopHostVstIdentitySchemaV1>
export type DesktopHostVstParameterV1 = z.infer<typeof desktopHostVstParameterSchemaV1>

export type DesktopOperationMapV1 = {
  "host.status": { input: Record<string, never>; result: z.infer<typeof desktopHostStatusSchemaV1> }
  "host.vst.instances": { input: z.infer<typeof desktopHostVstInstancesInputSchemaV1>; result: z.infer<typeof desktopHostVstInstancesResultSchemaV1> }
  "host.vst.parameters": { input: z.infer<typeof desktopHostVstParametersInputSchemaV1>; result: z.infer<typeof desktopHostVstParametersResultSchemaV1> }
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
  "control.capabilities": { input: z.infer<typeof desktopControlCapabilitiesInputSchemaV1>; result: z.infer<typeof controlCapabilitiesSchemaV1> }
  "control.snapshot": { input: z.infer<typeof desktopControlSnapshotInputSchemaV1>; result: z.infer<typeof projectSnapshotSchemaV1> }
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
  input: desktopJsonValueSchema,
  deadlineMs: z.number().int().positive().max(maxDeadlineMs).optional(),
}).strict().superRefine((value, context) => {
  const schema = value.operation === "host.export.run"
    ? desktopHostExportRunInputSchemaV1
    : inputSchemaFor(value.operation)
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
  input: desktopJsonValueSchema,
  deadlineMs: z.number().int().positive().max(maxDeadlineMs).optional(),
}).strict().superRefine((value, context) => {
  const schema = value.operation === "host.import.audio"
    ? desktopRendererImportInputSchemaV1
    : value.operation === "host.export.run"
      ? desktopRendererExportInputSchemaV1
      : inputSchemaFor(value.operation)
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
const trustedRendererControlRequest = z.object({
  version, type: z.literal("request"), id: correlationId, operation: desktopControlOperationSchemaV1,
  input: desktopJsonValueSchema, deadlineMs: z.number().int().positive().max(maxDeadlineMs).optional(),
  actorSubject: z.string().regex(/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
}).strict().superRefine((value, context) => {
  const schema = value.operation === "control.capabilities"
    ? desktopRendererControlCapabilitiesInputSchemaV1
    : value.operation === "control.snapshot"
      ? desktopRendererControlSnapshotInputSchemaV1
      : inputSchemaFor(value.operation)
  if (!schema.safeParse(value.input).success) {
    context.addIssue({ code: "custom", message: "Invalid renderer control operation input.", path: ["input"] })
  }
})
export const desktopTrustedRendererRequestSchemaV1 = z.union([desktopRendererRequestSchemaV1, trustedRendererControlRequest])
export type DesktopTrustedRendererRequestV1 = z.infer<typeof desktopTrustedRendererRequestSchemaV1>

export const desktopReplySchemaV1 = z.object({
  version,
  type: z.literal("reply"),
  id: correlationId,
  result: desktopJsonValueSchema.optional(),
  error: z.union([hostErrorSchemaV1, controlErrorSchemaV1]).optional(),
}).strict().superRefine((value, context) => {
  if ((value.result === undefined) === (value.error === undefined)) context.addIssue({ code: "custom", message: "Reply requires exactly one result or error." })
})
export const desktopCancelSchemaV1 = z.object({ version, type: z.literal("cancel"), id: correlationId }).strict()
const desktopReplyChunkFieldsV1 = {
  version, type: z.literal("replyChunk"), id: correlationId, operation: desktopOperationSchemaV1,
  index: z.number().int().nonnegative(), total: z.number().int().positive().max(maxDesktopReplyChunks),
  byteLength: z.number().int().positive().max(maxDesktopReplyBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.string().max(maxDesktopReplyPayloadBase64Characters).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}
export const desktopReplyChunkSchemaV1 = z.object(desktopReplyChunkFieldsV1).strict().refine((value) => value.index < value.total)
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

const requestInputsV2 = {
  ...requestInputs,
  "control.capabilities": z.union([controlCapabilitiesQuerySchemaV2, desktopControlCapabilitiesInputSchemaV2]),
  "control.snapshot": z.union([controlSnapshotQuerySchemaV1, desktopControlSnapshotInputSchemaV2]),
} as const
const requestV2 = z.object({
  version: versionV2,
  type: z.literal("request"),
  id: correlationId,
  operation: desktopOperationSchemaV1,
  input: desktopJsonValueSchema,
  deadlineMs: z.number().int().positive().max(maxDeadlineMs).optional(),
}).strict().superRefine((value, context) => {
  const schema = value.operation === "host.export.run"
    ? desktopHostExportRunInputSchemaV1
    : isDesktopControlOperation(value.operation)
      ? value.operation === "control.capabilities"
        ? requestInputsV2["control.capabilities"]
        : value.operation === "control.snapshot"
          ? requestInputsV2["control.snapshot"]
          : desktopControlOperationDescriptorsV1[value.operation].input
      : requestInputsV2[value.operation]
  if (!schema.safeParse(value.input).success) {
    context.addIssue({ code: "custom", message: "Invalid operation input.", path: ["input"] })
  }
})
export const desktopRequestSchemaV2 = requestV2
export type DesktopRequestV2 = z.infer<typeof requestV2>

export const desktopReplySchemaV2 = z.object({
  version: versionV2,
  type: z.literal("reply"),
  id: correlationId,
  result: desktopJsonValueSchema.optional(),
  error: z.union([
    hostErrorSchemaV2,
    controlErrorSchemaV1,
  ]).optional(),
}).strict().superRefine((value, context) => {
  if ((value.result === undefined) === (value.error === undefined)) context.addIssue({ code: "custom", message: "Reply requires exactly one result or error." })
})
export const desktopCancelSchemaV2 = z.object({ version: versionV2, type: z.literal("cancel"), id: correlationId }).strict()
export const desktopReplyChunkSchemaV2 = z.object({
  ...desktopReplyChunkFieldsV1,
  version: versionV2,
}).strict().refine((value) => value.index < value.total)
export const desktopProgressSchemaV2 = desktopProgressSchemaV1.extend({ version: versionV2 })
export const desktopExportTerminalSchemaV2 = desktopExportTerminalSchemaV1.extend({ version: versionV2 })
export const desktopHelloSchemaV2 = z.object({
  version: versionV2,
  type: z.literal("hello"),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
  client: z.string().min(1).max(128),
  actorId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  supportedVersions: z.array(z.enum(desktopProtocolVersions)).min(1).max(desktopProtocolVersions.length).refine((versions) => new Set(versions).size === versions.length && versions.includes("v2")),
}).strict()
export const desktopHelloAckSchemaV2 = z.object({
  version: versionV2,
  type: z.literal("helloAck"),
  selectedVersion: z.literal(desktopProtocolVersionV2),
  sessionId: z.string().min(16).max(128),
  capabilities: z.array(desktopOperationSchemaV1).max(desktopOperationSchemaV1.options.length),
}).strict()
export const desktopLifecycleSchemaV2 = desktopLifecycleSchemaV1.extend({ version: versionV2 })
export const desktopFrameSchemaV2 = z.discriminatedUnion("type", [
  desktopRequestSchemaV2, desktopReplySchemaV2, desktopReplyChunkSchemaV2,
  desktopCancelSchemaV2, desktopProgressSchemaV2, desktopExportTerminalSchemaV2,
  desktopHelloSchemaV2, desktopHelloAckSchemaV2, desktopLifecycleSchemaV2,
])
export type DesktopFrameV2 = z.infer<typeof desktopFrameSchemaV2>
export const desktopFrameSchema = z.union([desktopFrameSchemaV1, desktopFrameSchemaV2])
export type DesktopFrame = z.infer<typeof desktopFrameSchema>

export const desktopRegistrationSchemaV1 = z.object({
  version,
  instanceId: z.string().regex(/^[a-f0-9]{32}$/),
  pid: z.number().int().positive(),
  createdAt: z.number().int().positive(),
  address: z.string().min(1).max(512),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type DesktopRegistrationV1 = z.infer<typeof desktopRegistrationSchemaV1>

const nonControlResultSchemas = {
  "host.status": desktopHostStatusSchemaV1,
  "host.vst.instances": desktopHostVstInstancesResultSchemaV1,
  "host.vst.parameters": desktopHostVstParametersResultSchemaV1,
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
} satisfies Partial<Record<DesktopOperationV1, z.ZodType>>

const desktopControlDescriptor = (operation: DesktopControlOperationV1) => {
  const descriptor = getControlOperationDescriptor(operation)
  if (operation === "control.capabilities") {
    return {
      input: desktopControlCapabilitiesInputSchemaV1,
      output: controlCapabilitiesSchemaV1,
      canonicalInput: descriptor.input,
      canonicalOutput: canonicalControlCapabilitiesSchema,
    }
  }
  if (operation === "control.snapshot") {
    return {
      input: desktopControlSnapshotInputSchemaV1,
      output: projectSnapshotSchemaV1,
      canonicalInput: descriptor.input,
      canonicalOutput: canonicalProjectSnapshotSchema,
    }
  }
  return {
    input: descriptor.input,
    output: descriptor.output,
    canonicalInput: descriptor.input,
    canonicalOutput: descriptor.output,
  }
}

export const desktopControlOperationDescriptorsV1 = {
  "control.capabilities": desktopControlDescriptor("control.capabilities"),
  "control.snapshot": desktopControlDescriptor("control.snapshot"),
  "control.preview": desktopControlDescriptor("control.preview"),
  "control.commit": desktopControlDescriptor("control.commit"),
  "control.requestApproval": desktopControlDescriptor("control.requestApproval"),
  "control.history": desktopControlDescriptor("control.history"),
  "control.recoveries": desktopControlDescriptor("control.recoveries"),
} satisfies Record<DesktopControlOperationV1, {
  input: z.ZodType
  output: z.ZodType
  canonicalInput: z.ZodType
  canonicalOutput: z.ZodType
}>

export const isDesktopControlOperation = (operation: DesktopOperationV1): operation is DesktopControlOperationV1 => (
  Object.hasOwn(desktopControlOperationDescriptorsV1, operation)
)

export const desktopControlOperationsV1 = Object.keys(desktopControlOperationDescriptorsV1).map(
  (operation) => desktopControlOperationSchemaV1.parse(operation),
)

const inputSchemaFor = (operation: DesktopOperationV1) => (
  isDesktopControlOperation(operation)
    ? desktopControlOperationDescriptorsV1[operation].input
    : requestInputs[operation]
)

export const parseDesktopResult = (
  operation: DesktopOperationV1,
  value: DesktopJsonValue,
  input: DesktopJsonValue = {},
  protocolVersion: DesktopProtocolVersion = desktopProtocolVersion,
): DesktopJsonValue => {
  if (protocolVersion === desktopProtocolVersionV2 && operation === "control.capabilities" && desktopControlCapabilitiesInputSchemaV2.safeParse(input).success) {
    return desktopJsonValueSchema.parse(controlCapabilitiesSchemaV2.parse(value))
  }
  if (protocolVersion === desktopProtocolVersionV2 && operation === "control.snapshot" && desktopControlSnapshotInputSchemaV2.safeParse(input).success) {
    return desktopJsonValueSchema.parse(projectSnapshotSchemaV2.parse(value))
  }
  if (operation === "control.capabilities") {
    const legacy = controlCapabilitiesSchemaV1.safeParse(value)
    return desktopJsonValueSchema.parse(legacy.success
      ? legacy.data
      : projectCanonicalControlCapabilitiesV1(canonicalControlCapabilitiesSchema.parse(value)))
  }
  if (operation === "control.snapshot") {
    const legacy = projectSnapshotSchemaV1.safeParse(value)
    return desktopJsonValueSchema.parse(legacy.success
      ? legacy.data
      : projectCanonicalProjectSnapshotV1(canonicalProjectSnapshotSchema.parse(value)))
  }
  const schema = isDesktopControlOperation(operation)
    ? desktopControlOperationDescriptorsV1[operation].output
    : nonControlResultSchemas[operation]
  if (!schema) throw new Error("Unknown desktop operation.")
  return desktopJsonValueSchema.parse(schema.parse(value))
}

export const parseDesktopReplyError = (
  operation: DesktopOperationV1,
  value: DesktopJsonValue,
  protocolVersion: DesktopProtocolVersion = desktopProtocolVersion,
): HostErrorV1 | HostErrorV2 | ControlErrorV1 => (
  isDesktopControlOperation(operation)
    ? controlErrorSchemaV1.safeParse(value).success
      ? controlErrorSchemaV1.parse(value)
      : protocolVersion === desktopProtocolVersionV2 ? hostErrorSchemaV2.parse(value) : hostErrorSchemaV1.parse(value)
    : protocolVersion === desktopProtocolVersionV2 ? hostErrorSchemaV2.parse(value) : hostErrorSchemaV1.parse(value)
)

export const hostError = (code: HostErrorV1["code"], message: string): HostErrorV1 => ({ version: desktopProtocolVersion, code, message })
export const hostErrorV2 = (code: HostErrorV1["code"], message: string) => ({ version: desktopProtocolVersionV2, code, message })
