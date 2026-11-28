export const nativeAudioHostMagic = 0x44415748

import {
  maxNativeExternalAttachments,
  maxVst3WorkerFrames,
  maxVst3WorkerSampleRateHz,
  maxVst3WorkerStateBytes,
  nativeExternalAttachmentPlanSchema,
} from "@daw-browser/plugin-host-protocol"
import { z } from "zod"

export const nativeAudioHostProtocolVersion = 30
export const nativeRecordingSpoolImportVersion = 1

export type NativeRecordingSpoolImportVersion = typeof nativeRecordingSpoolImportVersion

export const nativeAudioHostArtifactId = "daw-audio-host-macos/v10"

export type NativeAudioHostParkingLimits = {
  maximumParkedInstances: number
  parkedAgeMs: number
}

export const nativeKeepLatencyDivergentMixedBusDiagnostic = 3
export const nativeAudioHostFrameHeaderBytes = 16
export const nativeAudioHostMaximumPayloadBytes = 1_048_576
export const nativeAudioHostMaximumMeterEntries = 64
export const nativeAudioHostMaximumSpectrumBins = 1024
export const nativeAudioHostNativeGraphFrameHeaderBytes = 12
export const nativeAudioHostMaximumSerializedPlanBytes = nativeAudioHostMaximumPayloadBytes
export const nativeAudioHostRequiredCapabilities = 0x000003ff

// The host's virtual-memory page on Apple Silicon: mapped asset arenas round up to it.
export const nativeAudioHostPageBytes = 16_384

/**
 * Every table below maps a wire code to the name TS uses for it. The generator emits the same names as C++
 * enumerators (`kebab-case` and `camelCase` become `kPascalCase`), so a code is added in exactly one place.
 */
export const nativeAudioHostLifecycleStates = { idle: 0, configured: 1, running: 2, faulted: 3 } as const

export const nativeAudioHostReadinessReasons = {
  ready: 0,
  "device-not-configured": 1,
  "graph-not-prepared": 2,
  "transport-not-prepared": 3,
} as const

export const nativeAudioHostRejectedBlockReasons = {
  none: 0,
  "not-running-or-core-unavailable": 1,
  "insufficient-channels": 2,
  "null-channel": 3,
  transport: 4,
  "scratch-capacity": 5,
  "processor-event-capacity": 6,
  "instrument-event-capacity": 7,
  "source-schedule": 8,
  "core-process": 9,
} as const

export const nativeAudioHostRevisionStatusCodes = {
  prepared: 1,
  published: 2,
  retired: 3,
  "rolled-back": 4,
  "stale-revision": 5,
  "invalid-revision": 6,
  "prepare-failed": 7,
  "publish-failed": 8,
  "retirement-not-safe": 9,
  "retirement-capacity-exceeded": 10,
  "publish-pending": 11,
  "rebase-required": 12,
  "capture-target-locked": 13,
} as const

export const nativeAudioHostRevisionContinuities = {
  "not-evaluated": 0,
  accepted: 1,
  fallback: 2,
  rejected: 3,
} as const

export const nativeAudioHostNotificationKinds = {
  latency: 1,
  buses: 2,
  restart: 3,
  fault: 4,
  miss: 5,
  "editor-interaction": 6,
  "parameter-edit": 7,
  tail: 8,
  "editor-state": 9,
} as const

export const nativeAudioHostPatchOutcomes = { applied: 1, refused: 2, claimed: 3 } as const

export const nativeAudioHostPatchRefusals = {
  none: 0,
  unavailable: 1,
  preparing: 2,
  "claim-pending": 3,
  invalid: 4,
  "stale-revision": 5,
  "stage-failed": 6,
  "not-claimed": 7,
  "apply-failed": 8,
} as const

export const nativeAudioHostVstEditorCommands = { open: 1, close: 2, focus: 3, resize: 4, status: 5 } as const

/** The ACK text of a refused asset request. A renderer reads it to tell a full arena (retryable after releasing assets) from a bad request. */
export const nativeAudioHostAssetRefusals = {
  invalidAsset: "invalid-asset",
  invalidAssetPage: "invalid-asset-page",
  publicationPending: "asset-publication-pending",
  identityConflict: "asset-identity-conflict",
  pageIdentityConflict: "asset-page-identity-conflict",
  capacityExceeded: "asset-capacity-exceeded",
  pageCapacityExceeded: "asset-page-capacity-exceeded",
} as const

const nativeHostLossMarkers = [
  "native audio host is unavailable",
  "native audio host stopped",
  "host connection was lost",
  "host connection closed",
]

/** The single place that says which error text means the host connection is gone. */
export const indicatesNativeHostLoss = (message: string) => {
  const normalized = message.toLowerCase()

  return nativeHostLossMarkers.some((marker) => normalized.includes(marker))
}

export const nativeAudioHostSpoolStates = { preparing: 0, ready: 1, complete: 2, failed: 3, cancelled: 4 } as const

/** The name of a wire code, or undefined when the host sent a code outside the table. */
export const nativeAudioHostCodeName = <Table extends Readonly<Record<string, number>>>(table: Table, code: number) => {
  for (const name in table) if (table[name] === code) return name

  return undefined
}

export const nativeAudioHostControlTypes = {
  hostHello: 1,
  hostCapabilities: 2,
  deviceConfigure: 3,
  graphSnapshot: 4,
  assetInstall: 5,
  assetRelease: 6,
  transport: 7,
  parameterEvents: 8,
  midiEvents: 9,
  vstAttach: 10,
  vstDetach: 11,
  diagnostics: 12,
  ack: 13,
  notification: 14,
  start: 15,
  stop: 16,
  teardown: 17,
  sourceEvents: 18,
  deviceList: 19,
  transactionBegin: 20,
  transactionCommit: 21,
  transactionRollback: 22,
  vstParameterEvents: 23,
  vstMidiEvents: 24,
  vstStateSet: 25,
  vstStateGet: 26,
  vstState: 27,
  recordingConfigure: 28,
  recordingStart: 29,
  recordingStop: 30,
  recordingCancel: 31,
  recordingBlock: 32,
  recordingStatus: 33,
  recordingDeviceQuery: 34,
  recordingDeviceList: 35,
  graphPrepare: 36,
  graphPublish: 37,
  graphRetire: 38,
  graphRollback: 39,
  graphRevisionStatus: 40,
  vstEditor: 41,
  vstEditorStatus: 42,
  diagnosticStart: 43,
  meterBatch: 44,
  scheduleWindow: 45,
  scheduleProgress: 46,
  vstScheduleAutomationEnable: 47,
  instrumentStates: 48,
  spectrumSelection: 49,
  spectrumFrame: 50,
  processorStatePatch: 51,
  offlineConfigure: 52,
  offlineStart: 53,
  offlinePcmChunk: 54,
  offlineComplete: 55,
  offlineError: 56,
  mappedAssetCreate: 57,
  mappedAssetWritePage: 58,
  mappedAssetPrepareRange: 59,
  mappedAssetRelease: 60,
  processorStatePatchStatus: 61,
  deviceInventoryQuery: 62,
  deviceInventory: 63,
} as const

export const nativeAudioHostMaximumDeviceIdBytes = 4_096
export const nativeAudioHostAssetInstallHeaderBytes = 24
export const nativeAudioHostMaximumAssetChannels = 64
export const nativeAudioHostMaximumAssetFrames = 262_144
export const nativeAudioHostMaximumInstalledAssets = 64
export const nativeAudioHostMappedAssetPageHeaderBytes = 16
export const nativeAudioHostMaximumMappedAssetRanges = 256
export const nativeAudioHostMaximumMappedAssetPageBytes = nativeAudioHostMaximumPayloadBytes - nativeAudioHostMappedAssetPageHeaderBytes

export const nativeAudioHostMaximumMappedAssetPageFramesForChannels = (channelCount: number) => (
  Number.isSafeInteger(channelCount) && channelCount > 0
    ? Math.floor(
      nativeAudioHostMaximumMappedAssetPageBytes
        / (Float32Array.BYTES_PER_ELEMENT * channelCount),
    )
    : 0
)

export const nativeAudioHostMaximumAssetFramesForChannels = (channelCount: number) => Math.min(
  nativeAudioHostMaximumAssetFrames,
  Number.isSafeInteger(channelCount) && channelCount > 0
    ? Math.floor(
      (nativeAudioHostMaximumPayloadBytes - nativeAudioHostAssetInstallHeaderBytes)
        / (Float32Array.BYTES_PER_ELEMENT * channelCount),
    )
    : 0,
)

export const nativeAudioHostMaximumVstStringBytes = 256
export const nativeAudioHostMaximumVstPathBytes = 4_096
export const nativeAudioHostVstAttachFingerprintBytes = 32
export const nativeAudioHostMaximumScheduleChunks = 16
export const nativeAudioHostMaximumScheduleRecords = 2_048
export const nativeAudioHostMaximumScheduleAutomationSegments = 2_048
export const nativeAudioHostMaximumProcessorEvents = 256
export const nativeAudioHostMaximumInstrumentEvents = 256
export const nativeAudioHostMaximumSourceEvents = 256
export const nativeAudioHostMaximumScheduleInstanceIdBytes = 256
export const nativeAudioHostScheduleProgressBytes = 112
export const nativeAudioHostProcessorPatchStatusBytes = 20

/**
 * The status word of a control ACK (`ControlAckStatus`, audio_host_macos.h). `unavailable` is a negative ACK that
 * says no audio session or core existed to take the request. ACK text is for people and is never classified.
 */
export const nativeAudioHostAckStatus = { refused: 0, accepted: 1, unavailable: 2 } as const

const nativeOfflinePcmAssetSchema = z.object({
  sessionAssetId: z.number().int().positive().max(0xffff_ffff),
  frameCount: z.number().int().positive().max(nativeAudioHostMaximumAssetFrames),
  sampleRateHz: z.number().int().positive().max(maxVst3WorkerSampleRateHz),
  channelCount: z.number().int().positive().max(nativeAudioHostMaximumAssetChannels),
  planarPcm: z.instanceof(Uint8Array),
  contentHashPrefix: z.instanceof(Uint8Array).refine((value) => value.byteLength === 8).optional(),
}).strict().superRefine((value, context) => {
  const byteLength = value.frameCount * value.channelCount * Float32Array.BYTES_PER_ELEMENT

  if (
    !Number.isSafeInteger(byteLength)
    || value.frameCount > nativeAudioHostMaximumAssetFramesForChannels(value.channelCount)
    || value.planarPcm.byteLength !== byteLength
  ) {
    context.addIssue({ code: "custom", path: ["planarPcm"], message: "PCM byte length does not match its dimensions." })
  }
})

const nativeOfflineMappedAssetSchema = z.object({
  sessionAssetId: z.number().int().positive().max(0xffff_ffff),
  sourceAssetKey: z.string().min(1).max(512),
  projectId: z.string().min(1).max(256).optional(),
  sourceKind: z.enum(["upload", "url", "recording"]).optional(),
  sampleUrl: z.string().min(1).max(4096).optional(),
  frameCount: z.number().int().positive().safe(),
  sampleRateHz: z.number().int().positive().max(maxVst3WorkerSampleRateHz),
  channelCount: z.number().int().positive().max(nativeAudioHostMaximumAssetChannels),
  ranges: z.array(z.object({
    startFrame: z.number().int().nonnegative().safe(),
    frameCount: z.number().int().positive().safe(),
  }).strict()).max(nativeAudioHostMaximumMappedAssetRanges),
  preparedStretchArtifactId: z.string().min(1).max(512).optional(),
}).strict().superRefine((value, context) => {
  for (const [index, range] of value.ranges.entries()) {
    if (range.startFrame + range.frameCount > value.frameCount) {
      context.addIssue({ code: "custom", path: ["ranges", index], message: "Mapped asset range exceeds the asset length." })
    }
  }
})

const nativeOfflineTransportSchema = z.object({
  epoch: z.number().int().positive().max(0xffff_ffff),
  running: z.boolean(),
  frame: z.number().int().nonnegative().safe(),
  bpm: z.number().finite().positive().optional(),
  timeSignatureNumerator: z.number().int().positive().max(32).optional(),
  timeSignatureDenominator: z.number().int().positive().max(32).optional(),
  cycleActive: z.boolean().optional(),
  cycleStartSec: z.number().finite().nonnegative().optional(),
  cycleEndSec: z.number().finite().nonnegative().optional(),
  transitionId: z.bigint().positive().max(0xffff_ffff_ffff_ffffn).optional(),
}).strict().superRefine((value, context) => {
  if ((value.timeSignatureNumerator === undefined) !== (value.timeSignatureDenominator === undefined)) {
    context.addIssue({ code: "custom", path: ["timeSignatureNumerator"], message: "Time signature must be complete." })
  }

  if ((value.cycleStartSec === undefined) !== (value.cycleEndSec === undefined)
    || (value.cycleStartSec !== undefined && value.cycleEndSec !== undefined && value.cycleEndSec <= value.cycleStartSec)) {
    context.addIssue({ code: "custom", path: ["cycleStartSec"], message: "Cycle range is invalid." })
  }
})

const nativeOfflineBinarySchema = z.instanceof(Uint8Array)
  .refine((value) => value.byteLength > 0, "Native binary payload must not be empty.")
  .refine((value) => value.byteLength <= nativeAudioHostMaximumPayloadBytes, "Native binary payload exceeds the control frame limit.")

const nativeOfflineCapturedStateSchema = z.object({
  instanceId: z.string().uuid(),
  bytes: z.instanceof(Uint8Array).refine(
    (value) => value.byteLength <= maxVst3WorkerStateBytes,
    "Captured VST state exceeds the native limit.",
  ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const nativeOfflineRenderPlanSchema = z.object({
  version: z.literal(1),
  sampleRateHz: z.number().int().positive().max(maxVst3WorkerSampleRateHz),
  channelCount: z.union([z.literal(1), z.literal(2)]),
  totalFrames: z.number().int().positive().safe(),
  blockFrames: z.number().int().positive().max(maxVst3WorkerFrames),
  graph: nativeOfflineBinarySchema,
  externalAttachments: nativeExternalAttachmentPlanSchema.optional(),
  instrumentStates: nativeOfflineBinarySchema.optional(),
  assets: z.array(nativeOfflinePcmAssetSchema).max(nativeAudioHostMaximumInstalledAssets),
  mappedAssets: z.array(nativeOfflineMappedAssetSchema).max(nativeAudioHostMaximumInstalledAssets).optional(),
  transport: nativeOfflineTransportSchema,
  schedule: nativeOfflineBinarySchema,
  scheduleWindows: z.array(nativeOfflineBinarySchema).min(1).optional(),
  capturedVstStates: z.array(nativeOfflineCapturedStateSchema).max(maxNativeExternalAttachments).optional(),
}).strict().superRefine((value, context) => {
  if (value.blockFrames > value.totalFrames) {
    context.addIssue({ code: "custom", path: ["blockFrames"], message: "Block size exceeds the render length." })
  }

  if (value.transport.frame > value.totalFrames) {
    context.addIssue({ code: "custom", path: ["transport", "frame"], message: "Transport frame exceeds the render length." })
  }

  if (value.assets.length + (value.mappedAssets?.length ?? 0) > nativeAudioHostMaximumInstalledAssets) {
    context.addIssue({ code: "custom", path: ["mappedAssets"], message: "Total native asset count exceeds the installed asset limit." })
  }

  const attachmentIds = new Set(value.externalAttachments?.attachments.map((attachment) => attachment.instanceId) ?? [])
  const stateIds = new Set<string>()

  for (const [index, state] of (value.capturedVstStates ?? []).entries()) {
    if (stateIds.has(state.instanceId)) {
      context.addIssue({ code: "custom", path: ["capturedVstStates", index, "instanceId"], message: "Captured VST state IDs must be unique." })
    }

    stateIds.add(state.instanceId)

    if (!attachmentIds.has(state.instanceId)) {
      context.addIssue({ code: "custom", path: ["capturedVstStates", index, "instanceId"], message: "Captured VST state is not referenced by an attachment." })
    }
  }
})
