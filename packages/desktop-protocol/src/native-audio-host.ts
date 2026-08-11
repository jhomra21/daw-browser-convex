export const nativeAudioHostMagic = 0x44415748
import { nativeExternalAttachmentPlanSchema, maxNativeExternalAttachments } from "@daw-browser/plugin-host-protocol"
import { z } from "zod"

export const nativeAudioHostProtocolVersion = 16
export const nativeAudioHostFrameHeaderBytes = 16
export const nativeAudioHostMaximumPayloadBytes = 1_048_576
export const nativeAudioHostMaximumMeterEntries = 64
export const nativeAudioHostMaximumSpectrumBins = 1024
export const nativeAudioHostMaximumSpectrumPayloadBytes = 8_192
export const nativeAudioHostMaximumProcessorStatePatchBytes = 512

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
} as const

export const nativeAudioHostMaximumDeviceIdBytes = 4_096
export const nativeAudioHostAssetInstallHeaderBytes = 24
export const nativeAudioHostMaximumAssetChannels = 64
export const nativeAudioHostMaximumAssetFrames = 262_144
export const nativeAudioHostMaximumInstalledAssets = 64
export const nativeAudioHostMaximumVstStringBytes = 256
export const nativeAudioHostMaximumVstPathBytes = 4_096
export const nativeAudioHostVstAttachFingerprintBytes = 32
export const nativeAudioHostMaximumScheduleChunks = 16
export const nativeAudioHostMaximumScheduleRecords = 2_048
export const nativeAudioHostMaximumScheduleAutomationSegments = 2_048
export const nativeAudioHostMaximumScheduleInstanceIdBytes = 256
export const nativeAudioHostScheduleWindowHeaderBytes = 56
export const nativeAudioHostScheduleProgressBytes = 80
export const nativeAudioHostMaximumSampleRateHz = 384_000
export const nativeAudioHostMaximumFramesPerBlock = 8_192
/**
 * Native renderer output is currently materialized as a monolithic Web Audio
 * AudioBuffer, and post-processing/encoding may hold another copy. Keep this
 * working-set ceiling separate from the 8 GiB aggregate streaming envelope.
 */
export const nativeAudioHostMaximumInMemoryPcmBytes = 512 * 1024 * 1024
export const nativeAudioHostMaximumOfflineRenderBytes = 8 * 1024 * 1024 * 1024
export const nativeAudioHostMaximumCapturedVstStateBytes = 512 * 1024

export const nativeOfflineRenderPcmBytes = (totalFrames: number, channelCount: number) => (
  totalFrames * channelCount * Float32Array.BYTES_PER_ELEMENT
)

const nativeOfflinePcmAssetSchema = z.object({
  sessionAssetId: z.number().int().positive().max(0xffff_ffff),
  frameCount: z.number().int().positive().max(nativeAudioHostMaximumAssetFrames),
  sampleRateHz: z.number().int().positive().max(nativeAudioHostMaximumSampleRateHz),
  channelCount: z.number().int().positive().max(nativeAudioHostMaximumAssetChannels),
  planarPcm: z.instanceof(Uint8Array),
  contentHashPrefix: z.instanceof(Uint8Array).refine((value) => value.byteLength === 8).optional(),
}).strict().superRefine((value, context) => {
  const byteLength = value.frameCount * value.channelCount * Float32Array.BYTES_PER_ELEMENT
  if (
    !Number.isSafeInteger(byteLength)
    || byteLength > nativeAudioHostMaximumPayloadBytes - nativeAudioHostAssetInstallHeaderBytes
    || value.planarPcm.byteLength !== byteLength
  ) {
    context.addIssue({ code: "custom", path: ["planarPcm"], message: "PCM byte length does not match its dimensions." })
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
    (value) => value.byteLength <= nativeAudioHostMaximumCapturedVstStateBytes,
    "Captured VST state exceeds the native limit.",
  ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const nativeOfflineRenderPlanSchema = z.object({
  version: z.literal(1),
  sampleRateHz: z.number().int().positive().max(nativeAudioHostMaximumSampleRateHz),
  channelCount: z.union([z.literal(1), z.literal(2)]),
  totalFrames: z.number().int().positive().safe(),
  blockFrames: z.number().int().positive().max(nativeAudioHostMaximumFramesPerBlock),
  graph: nativeOfflineBinarySchema,
  externalAttachments: nativeExternalAttachmentPlanSchema.optional(),
  instrumentStates: nativeOfflineBinarySchema.optional(),
  assets: z.array(nativeOfflinePcmAssetSchema).max(nativeAudioHostMaximumInstalledAssets),
  transport: nativeOfflineTransportSchema,
  schedule: nativeOfflineBinarySchema,
  scheduleWindows: z.array(nativeOfflineBinarySchema).min(1).optional(),
  capturedVstStates: z.array(nativeOfflineCapturedStateSchema).max(maxNativeExternalAttachments).optional(),
}).strict().superRefine((value, context) => {
  const pcmBytes = nativeOfflineRenderPcmBytes(value.totalFrames, value.channelCount)
  if (!Number.isSafeInteger(pcmBytes) || pcmBytes > nativeAudioHostMaximumInMemoryPcmBytes) {
    context.addIssue({ code: "custom", path: ["totalFrames"], message: "Offline PCM exceeds the native in-memory render limit." })
  }
  if (!Number.isSafeInteger(pcmBytes) || pcmBytes > nativeAudioHostMaximumOfflineRenderBytes) {
    context.addIssue({ code: "custom", path: ["totalFrames"], message: "Offline PCM exceeds the desktop export envelope." })
  }
  if (value.blockFrames > value.totalFrames) {
    context.addIssue({ code: "custom", path: ["blockFrames"], message: "Block size exceeds the render length." })
  }
  if (value.transport.frame > value.totalFrames) {
    context.addIssue({ code: "custom", path: ["transport", "frame"], message: "Transport frame exceeds the render length." })
  }
  const assetBytes = value.assets.reduce((total, asset) => total + asset.planarPcm.byteLength, 0)
  const scheduleBytes = value.schedule.byteLength
    + (value.scheduleWindows?.reduce((total, window) => total + window.byteLength, 0) ?? 0)
  const capturedStateBytes = value.capturedVstStates?.reduce((total, state) => total + state.bytes.byteLength, 0) ?? 0
  const aggregateBytes = assetBytes + value.graph.byteLength + (value.instrumentStates?.byteLength ?? 0)
    + scheduleBytes + capturedStateBytes
  if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > nativeAudioHostMaximumOfflineRenderBytes) {
    context.addIssue({ code: "custom", message: "Offline render inputs exceed the desktop export envelope." })
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
