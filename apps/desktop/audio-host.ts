import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { access } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { audioCoreWasmAbiVersion } from "@daw-browser/audio-core-wasm"
import {
  maxVst3WorkerEventsPerBlock,
  maxVst3WorkerFrames,
} from "@daw-browser/plugin-host-protocol"
import {
  portableGraphContractHash,
  processorContractHash,
} from "@daw-browser/audio-core-contract/generated"
import {
  nativeAudioHostAssetInstallHeaderBytes as assetInstallHeaderBytes,
  nativeAudioHostControlTypes,
  nativeAudioHostFrameHeaderBytes as headerBytes,
  nativeAudioHostMagic as magic,
  nativeAudioHostMaximumAssetChannels as maximumAssetChannels,
  nativeAudioHostMaximumAssetFrames as maximumAssetFrames,
  nativeAudioHostMaximumAssetFramesForChannels as maximumAssetFramesForChannels,
  nativeAudioHostMaximumDeviceIdBytes as maximumDeviceIdBytes,
  nativeAudioHostMaximumMeterEntries as maximumMeterEntries,
  nativeAudioHostMaximumSpectrumBins as maximumSpectrumBins,
  nativeAudioHostMaximumPayloadBytes as maximumPayloadBytes,
  nativeAudioHostMaximumVstPathBytes as maximumVstPathBytes,
  nativeAudioHostMaximumVstStringBytes as maximumVstStringBytes,
  nativeAudioHostProtocolVersion as protocolVersion,
  nativeAudioHostVstAttachFingerprintBytes as vstAttachFingerprintBytes,
  nativeOfflineRenderPlanSchema,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type {
  NativeHostDeviceConfiguration,
  NativeHostDiagnostics,
  NativeHostRecordingBlock,
  NativeHostRecordingConfiguration,
  NativeHostRecordingStatus,
  NativeHostMeterBatch,
  NativeHostSpectrumFrame,
  NativeScheduleProgress,
  NativeOutputDevice,
  NativeHostPcmAsset,
  NativeHostMappedAsset,
  NativeHostMappedAssetPage,
  NativeOfflineRenderPlan,
  NativeOfflinePcmChunk,
  NativeHostTransport,
  NativeInputDevice,
} from "@daw-browser/audio-engine/native-host-wire"
import { serializeNativeSpectrumSelection } from "@daw-browser/audio-engine/native-host-wire"

const {
  hostHello: hostHelloType,
  hostCapabilities: hostCapabilitiesType,
  deviceConfigure: deviceConfigureType,
  graphSnapshot: graphSnapshotType,
  assetInstall: assetInstallType,
  assetRelease: assetReleaseType,
  mappedAssetCreate: mappedAssetCreateType,
  mappedAssetWritePage: mappedAssetWritePageType,
  mappedAssetPrepareRange: mappedAssetPrepareRangeType,
  mappedAssetRelease: mappedAssetReleaseType,
  transport: transportType,
  parameterEvents: parameterEventsType,
  midiEvents: midiEventsType,
  vstAttach: vstAttachType,
  vstDetach: vstDetachType,
  diagnostics: diagnosticsType,
  ack: ackType,
  notification: notificationType,
  start: startType,
  stop: stopType,
  teardown: teardownType,
  sourceEvents: sourceEventsType,
  deviceList: deviceListType,
  transactionBegin: transactionBeginType,
  transactionCommit: transactionCommitType,
  transactionRollback: transactionRollbackType,
  vstParameterEvents: vstParameterEventsType,
  vstMidiEvents: vstMidiEventsType,
  vstStateSet: vstStateSetType,
  vstStateGet: vstStateGetType,
  vstState: vstStateType,
  recordingConfigure: recordingConfigureType,
  recordingStart: recordingStartType,
  recordingStop: recordingStopType,
  recordingCancel: recordingCancelType,
  recordingBlock: recordingBlockType,
  recordingStatus: recordingStatusType,
  recordingDeviceQuery: recordingDeviceQueryType,
  recordingDeviceList: recordingDeviceListType,
  graphPrepare: graphPrepareType,
  graphPublish: graphPublishType,
  graphRetire: graphRetireType,
  graphRollback: graphRollbackType,
  graphRevisionStatus: graphRevisionStatusType,
  vstEditor: vstEditorType,
  vstEditorStatus: vstEditorStatusType,
  diagnosticStart: diagnosticStartType,
  meterBatch: meterBatchType,
  spectrumSelection: spectrumSelectionType,
  spectrumFrame: spectrumFrameType,
  processorStatePatch: processorStatePatchType,
  offlineConfigure: offlineConfigureType,
  offlineStart: offlineStartType,
  offlinePcmChunk: offlinePcmChunkType,
  offlineComplete: offlineCompleteType,
  offlineError: offlineErrorType,
  scheduleWindow: scheduleWindowType,
  scheduleProgress: scheduleProgressType,
  vstScheduleAutomationEnable: vstScheduleAutomationEnableType,
  instrumentStates: instrumentStatesType,
} = nativeAudioHostControlTypes
const requiredHostCapabilities = 0x000003ff
const nativeAudioHostArtifactId = "daw-audio-host-macos/v5"
const maximumOfflineStderrBytes = 16 * 1024
const maximumOfflineQueuedFrames = 4
const nativeOfflineStageTimeoutMs = 10_000
const nativeOfflineCompletionInactivityTimeoutMs = 10_000

export const isNativeOfflineTelemetryFrame = (frameType: number) => (
  frameType === notificationType
  || frameType === meterBatchType
  || frameType === scheduleProgressType
)

const deviceState = (value: number): AudioHostHello["deviceState"] | undefined => {
  if (value === 0) return "idle"
  if (value === 1) return "configured"
  if (value === 2) return "running"
  if (value === 3) return "faulted"
  return undefined
}

const readinessReason = (value: number): AudioHostHello["readinessReason"] | undefined => {
  if (value === 0) return "ready"
  if (value === 1) return "device-not-configured"
  if (value === 2) return "graph-not-prepared"
  if (value === 3) return "transport-not-prepared"
  return undefined
}

export const encodeNativeAudioHostControlFrame = (type: number, payload: Uint8Array = new Uint8Array()) => {
  if (payload.byteLength > maximumPayloadBytes) return undefined
  const output = Buffer.alloc(headerBytes + payload.byteLength)
  output.writeUInt32BE(magic, 0)
  output.writeUInt32BE(protocolVersion, 4)
  output.writeUInt32BE(type, 8)
  output.writeUInt32BE(payload.byteLength, 12)
  output.set(payload, headerBytes)
  return output
}

const unsigned32 = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff

const writeUnsigned32 = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

const writeUnsigned64 = (value: bigint) => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(value)
  return bytes
}

const serializeDeviceConfiguration = (input: NativeHostDeviceConfiguration) => {
  const deviceId = Buffer.from(input.deviceId, "utf8")
  if (
    deviceId.byteLength === 0
    || deviceId.byteLength > maximumDeviceIdBytes
    || !coreAudioDeviceId(input.deviceId)
    || !unsigned32(input.sampleRateHz) || input.sampleRateHz === 0
    || !unsigned32(input.maxFramesPerBlock) || input.maxFramesPerBlock === 0
    || !unsigned32(input.channelCount) || input.channelCount === 0
    || !unsigned32(input.revision) || input.revision === 0
  ) return undefined
  return Buffer.concat([
    writeUnsigned32(input.sampleRateHz),
    writeUnsigned32(input.maxFramesPerBlock),
    writeUnsigned32(input.channelCount),
    writeUnsigned32(input.revision),
    writeUnsigned32(deviceId.byteLength),
    deviceId,
  ])
}

const serializeTransport = (input: NativeHostTransport) => {
  if (!unsigned32(input.epoch) || !Number.isSafeInteger(input.frame) || input.frame < 0
    || (input.bpm !== undefined && (!Number.isFinite(input.bpm) || input.bpm <= 0))
    || (input.timeSignatureNumerator !== undefined
      && (!Number.isSafeInteger(input.timeSignatureNumerator)
        || input.timeSignatureNumerator <= 0 || input.timeSignatureNumerator > 32))
    || (input.timeSignatureDenominator !== undefined
      && (!Number.isSafeInteger(input.timeSignatureDenominator)
        || input.timeSignatureDenominator <= 0 || input.timeSignatureDenominator > 32))
    || ((input.timeSignatureNumerator === undefined) !== (input.timeSignatureDenominator === undefined))
    || (input.cycleStartSec !== undefined && (!Number.isFinite(input.cycleStartSec) || input.cycleStartSec < 0))
    || (input.cycleEndSec !== undefined && (!Number.isFinite(input.cycleEndSec) || input.cycleEndSec < 0))
    || ((input.cycleStartSec !== undefined || input.cycleEndSec !== undefined)
      && (input.cycleStartSec === undefined || input.cycleEndSec === undefined
        || input.cycleEndSec <= input.cycleStartSec))
    || (input.transitionId !== undefined && (
      input.transitionId <= 0n || input.transitionId > 0xffff_ffff_ffff_ffffn
    ))) return undefined
  const output = Buffer.alloc(64)
  output.writeUInt32BE(input.epoch)
  output[4] = input.running ? 1 : 0
  output.writeBigInt64BE(BigInt(input.frame), 8)
  output.writeBigUInt64BE(input.transitionId ?? 1n, 16)
  output.writeDoubleBE(input.bpm ?? 0, 24)
  output.writeUInt32BE(input.cycleActive === true ? 1 : 0, 32)
  output.writeUInt32BE(input.timeSignatureNumerator ?? 0, 36)
  output.writeUInt32BE(input.timeSignatureDenominator ?? 0, 40)
  output.writeDoubleBE(input.cycleStartSec ?? 0, 48)
  output.writeDoubleBE(input.cycleEndSec ?? 0, 56)
  return output
}

const serializeRecordingConfiguration = (input: NativeHostRecordingConfiguration) => {
  const deviceUid = Buffer.from(input.deviceUid, "utf8")
  if (
    !unsigned32(input.generation) || input.generation === 0
    || input.sessionId <= 0n || input.sessionId > 0xffff_ffff_ffff_ffffn
    || (input.channelCount !== 1 && input.channelCount !== 2)
    || input.inputChannels.length !== input.channelCount
    || input.inputChannels.some((channel) => !unsigned32(channel))
    || !Number.isFinite(input.gain) || input.gain < 0
    || (input.polarity !== 1 && input.polarity !== -1)
    || !Number.isSafeInteger(input.punchStartFrame) || input.punchStartFrame < 0
    || (input.punchEndFrame !== null && (
      !Number.isSafeInteger(input.punchEndFrame) || input.punchEndFrame < input.punchStartFrame
    ))
    || !coreAudioDeviceId(input.deviceUid)
    || deviceUid.byteLength === 0 || deviceUid.byteLength > 4096
  ) return undefined
  const output = Buffer.alloc(60 + deviceUid.byteLength)
  output.writeUInt32BE(input.generation, 0)
  output.writeBigUInt64BE(input.sessionId, 4)
  output.writeUInt32BE(input.channelCount, 12)
  output.writeUInt32BE(input.inputChannels[0] ?? 0, 16)
  output.writeUInt32BE(input.inputChannels[1] ?? 0, 20)
  output.writeFloatBE(input.gain, 24)
  output.writeInt32BE(input.polarity, 28)
  output.writeBigInt64BE(BigInt(input.punchStartFrame), 32)
  output.writeBigInt64BE(BigInt(input.punchEndFrame ?? -1), 40)
  output.writeUInt32BE(input.monitoring ? 1 : 0, 48)
  output.writeUInt32BE(deviceUid.byteLength, 56)
  output.set(deviceUid, 60)
  return output
}

const nativeBinaryPayload = (payload: Uint8Array, minimumBytes: number) => (
  payload.byteLength >= minimumBytes && payload.byteLength <= maximumPayloadBytes
    ? Buffer.from(payload)
    : undefined
)

const serializeAssetInstall = (input: NativeHostPcmAsset) => {
  const hash = input.contentHashPrefix ?? new Uint8Array(8)
  const expectedPcmBytes = input.frameCount * input.channelCount * 4
  if (
    !unsigned32(input.sessionAssetId) || input.sessionAssetId === 0
    || !unsigned32(input.frameCount) || input.frameCount === 0 || input.frameCount > maximumAssetFrames
    || !unsigned32(input.sampleRateHz) || input.sampleRateHz === 0
    || !unsigned32(input.channelCount) || input.channelCount === 0 || input.channelCount > maximumAssetChannels
    || !Number.isSafeInteger(expectedPcmBytes)
    || input.frameCount > maximumAssetFramesForChannels(input.channelCount)
    || input.planarPcm.byteLength !== expectedPcmBytes
    || hash.byteLength !== 8
  ) return undefined
  const output = Buffer.alloc(assetInstallHeaderBytes + expectedPcmBytes)
  output.writeUInt32BE(input.sessionAssetId, 0)
  output.writeUInt32BE(input.frameCount, 4)
  output.writeUInt32BE(input.sampleRateHz, 8)
  output.writeUInt32BE(input.channelCount, 12)
  output.set(hash, 16)
  output.set(input.planarPcm, assetInstallHeaderBytes)
  return output
}

export type ResolvedVst3Attachment = {
  graphNodeId: bigint
  stageIndex: number
  sourceIndex?: number
  instanceId: string
  classId: string
  vendorId: string
  canonicalBundlePath: string
  canonicalExecutablePath: string
  bundleFingerprint: string
  binaryFingerprint: string
  scannerProtocolVersion: 2
  role: "effect" | "instrument"
  inputLayout: "none" | "mono" | "stereo"
  outputLayout: "mono" | "stereo"
  declaredLatencyFrames: number
  declaredTailFrames?: number | null
  transportLatencyFrames: number
  workerTransport: {
    slotCount: number
    maximumFrames: number
    inputChannels: number
    outputChannels: number
    maximumEventsPerBlock: number
  }
  parameterIds?: readonly number[]
  initialParameterValues?: readonly { id: number; value: number }[]
  initialState?: { bytes: Uint8Array; sha256: string }
  renderEnabled?: boolean
  workerEnabled?: boolean
}

const fingerprintBytes = (value: string) => /^[a-f0-9]{64}$/.test(value) ? Buffer.from(value, "hex") : undefined

const serializeVstAttachment = (input: ResolvedVst3Attachment) => {
  const strings = [input.instanceId, input.classId, input.vendorId]
  if (
    !strings.every((value) => Buffer.byteLength(value, "utf8") > 0 && Buffer.byteLength(value, "utf8") <= maximumVstStringBytes)
    || !input.canonicalBundlePath || !input.canonicalExecutablePath
    || Buffer.byteLength(input.canonicalBundlePath, "utf8") > maximumVstPathBytes
    || Buffer.byteLength(input.canonicalExecutablePath, "utf8") > maximumVstPathBytes
    || !input.canonicalExecutablePath.startsWith(`${input.canonicalBundlePath}/`)
    || input.scannerProtocolVersion !== 2
    || input.graphNodeId <= 0n
    || !unsigned32(input.stageIndex) || input.stageIndex > 0x7fff_ffff
    || (input.sourceIndex !== undefined && (!unsigned32(input.sourceIndex) || input.sourceIndex > 0x7fff_ffff))
    || (input.role !== "effect" && input.role !== "instrument")
    || (input.inputLayout !== "none" && input.inputLayout !== "mono" && input.inputLayout !== "stereo")
    || (input.role === "instrument" && input.inputLayout !== "none")
    || (input.role === "effect" && input.inputLayout === "none")
    || (input.outputLayout !== "mono" && input.outputLayout !== "stereo")
    || !unsigned32(input.declaredLatencyFrames)
    || (input.declaredTailFrames !== undefined
      && input.declaredTailFrames !== null
      && (!unsigned32(input.declaredTailFrames) || input.declaredTailFrames > 100_000_000))
    || !unsigned32(input.transportLatencyFrames)
    || !unsigned32(input.workerTransport.slotCount) || input.workerTransport.slotCount === 0 || input.workerTransport.slotCount > 8
    || !unsigned32(input.workerTransport.maximumFrames) || input.workerTransport.maximumFrames === 0 || input.workerTransport.maximumFrames > maxVst3WorkerFrames
    || !unsigned32(input.workerTransport.inputChannels) || input.workerTransport.inputChannels > 64
    || (input.role === "instrument" && input.workerTransport.inputChannels !== 0)
    || (input.role === "effect" && input.workerTransport.inputChannels === 0)
    || !unsigned32(input.workerTransport.outputChannels) || input.workerTransport.outputChannels === 0 || input.workerTransport.outputChannels > 64
    || !unsigned32(input.workerTransport.maximumEventsPerBlock)
    || input.workerTransport.maximumEventsPerBlock === 0
    || input.workerTransport.maximumEventsPerBlock > maxVst3WorkerEventsPerBlock
    || (input.parameterIds?.length ?? 0) > 16_384
  ) return undefined
  const bundleFingerprint = fingerprintBytes(input.bundleFingerprint)
  const binaryFingerprint = fingerprintBytes(input.binaryFingerprint)
  if (!bundleFingerprint || !binaryFingerprint || bundleFingerprint.byteLength !== vstAttachFingerprintBytes || binaryFingerprint.byteLength !== vstAttachFingerprintBytes) {
    return undefined
  }
  const encodedStrings = [...strings, input.canonicalBundlePath, input.canonicalExecutablePath].map((value) => Buffer.from(value, "utf8"))
  const stateBytes = input.initialState?.bytes ?? new Uint8Array()
  const stateHash = input.initialState?.sha256 ?? ""
  if (
    stateBytes.byteLength > 512 * 1024
    || (stateBytes.byteLength === 0 && stateHash !== "" && !/^[a-f0-9]{64}$/.test(stateHash))
    || (stateBytes.byteLength > 0 && !/^[a-f0-9]{64}$/.test(stateHash))
    || (input.initialParameterValues?.length ?? 0) > 2_048
  ) return undefined
  const parameterBytes = Buffer.alloc((input.initialParameterValues?.length ?? 0) * 12)
  for (const [index, parameter] of (input.initialParameterValues ?? []).entries()) {
    if (!unsigned32(parameter.id) || !Number.isFinite(parameter.value) || parameter.value < 0 || parameter.value > 1) return undefined
    parameterBytes.writeUInt32BE(parameter.id, index * 12)
    parameterBytes.writeDoubleBE(parameter.value, index * 12 + 4)
  }
  const parameterIds = input.parameterIds ?? []
  if (
    new Set(parameterIds).size !== parameterIds.length
    || parameterIds.some((parameterId) => !unsigned32(parameterId))
  ) return undefined
  const parameterIdBytes = Buffer.alloc(parameterIds.length * 4)
  for (const [index, parameterId] of parameterIds.entries()) {
    parameterIdBytes.writeUInt32BE(parameterId, index * 4)
  }
  return Buffer.concat([
    ...encodedStrings.flatMap((value) => [writeUnsigned32(value.byteLength), value]),
    writeUnsigned32(input.stageIndex),
    writeUnsigned32(input.sourceIndex ?? 0xffff_ffff),
    writeUnsigned64(input.graphNodeId),
    Buffer.from([1]),
    bundleFingerprint,
    binaryFingerprint,
    writeUnsigned32(input.scannerProtocolVersion),
    Buffer.from([
      input.role === "effect" ? 1 : 2,
      input.inputLayout === "none" ? 0 : input.inputLayout === "mono" ? 1 : 2,
      input.outputLayout === "mono" ? 1 : 2,
      input.workerEnabled === true || input.renderEnabled === true ? 1 : 0,
      input.renderEnabled === false ? 0 : 1,
    ]),
    writeUnsigned32(input.declaredLatencyFrames),
    writeUnsigned32(input.declaredTailFrames ?? 0xffff_ffff),
    writeUnsigned32(input.transportLatencyFrames),
    writeUnsigned32(input.workerTransport.slotCount),
    writeUnsigned32(input.workerTransport.maximumFrames),
    writeUnsigned32(input.workerTransport.inputChannels),
    writeUnsigned32(input.workerTransport.outputChannels),
    writeUnsigned32(input.workerTransport.maximumEventsPerBlock),
    writeUnsigned32(stateBytes.byteLength),
    writeUnsigned32(Buffer.byteLength(stateHash)),
    Buffer.from(stateBytes),
    Buffer.from(stateHash),
    writeUnsigned32(input.initialParameterValues?.length ?? 0),
    parameterBytes,
    writeUnsigned32(parameterIds.length),
    parameterIdBytes,
  ])
}

const serializeVstDetach = (instanceId: string) => {
  const value = Buffer.from(instanceId, "utf8")
  if (value.byteLength === 0 || value.byteLength > maximumVstStringBytes) return undefined
  return Buffer.concat([writeUnsigned32(value.byteLength), value])
}

const serializeVstEditor = (input: {
  instanceId: string
  command: NativeVstEditorCommand
  width?: number
  height?: number
  anchor?: NativeVstEditorAnchor
}) => {
  const instanceIdBytes = Buffer.from(input.instanceId, "utf8")
  const command = { open: 1, close: 2, focus: 3, resize: 4, status: 5 }[input.command]
  const width = input.width ?? 0
  const height = input.height ?? 0
  const anchor = input.anchor
  const hasAnchor = anchor === undefined ? 0 : 1
  if (
    !command
    || instanceIdBytes.byteLength === 0
    || instanceIdBytes.byteLength > maximumVstStringBytes
    || !unsigned32(width) || width > 8192
    || !unsigned32(height) || height > 8192
    || (anchor !== undefined && input.command !== "open" && input.command !== "focus")
    || (anchor !== undefined && (
      !Number.isSafeInteger(anchor.x) || anchor.x < -0x8000_0000 || anchor.x > 0x7fff_ffff
      || !Number.isSafeInteger(anchor.y) || anchor.y < -0x8000_0000 || anchor.y > 0x7fff_ffff
    ))
  ) return undefined
  const output = Buffer.alloc(28)
  output.writeUInt32BE(command, 0)
  output.writeUInt32BE(width, 4)
  output.writeUInt32BE(height, 8)
  output.writeUInt32BE(hasAnchor, 12)
  output.writeInt32BE(anchor?.x ?? 0, 16)
  output.writeInt32BE(anchor?.y ?? 0, 20)
  output.writeUInt32BE(instanceIdBytes.byteLength, 24)
  return Buffer.concat([output, instanceIdBytes])
}

export type AudioHostHello = {
  capabilities: number
  abiVersion: number
  processorContractHash: string
  graphContractHash: string
  artifactId: string
  deviceState: "idle" | "configured" | "running" | "faulted"
  readinessReason: "ready" | "device-not-configured" | "graph-not-prepared" | "transport-not-prepared"
}

export type NativeGraphRevisionStatus = {
  status: "prepared" | "published" | "retired" | "rolled-back" | "stale-revision"
    | "invalid-revision" | "prepare-failed" | "publish-failed" | "retirement-not-safe"
    | "retirement-capacity-exceeded"
  requestedRevision: number
  continuity: "not-evaluated" | "accepted" | "fallback" | "rejected"
  activeRevision: number
  preparedRevision: number
  retiredRevision: number
  renderEpoch: bigint
}

type NativeWorkerNotificationBase = {
  graphRevision: number
  graphNodeId: bigint
  instanceId: string
}

export type NativeWorkerNotification =
  | (NativeWorkerNotificationBase & {
    kind: "latency" | "buses" | "restart" | "fault" | "miss" | "tail" | "editor-interaction" | "editor-state"
    value: number
  })
  | (NativeWorkerNotificationBase & {
    kind: "parameter-edit"
    parameterId: number
    normalizedValue: number
  })

type NativeVstEditorOwnershipProbe = {
  instanceId: string
  command: "status"
}

type NativeAudioHostTerminationTimers = {
  graceful?: ReturnType<typeof setTimeout>
  sigterm?: ReturnType<typeof setTimeout>
  killObservation?: ReturnType<typeof setTimeout>
}

export type NativeVstEditorCommand = "open" | "close" | "focus" | "resize" | "status"
export type NativeVstEditorAnchor = { x: number; y: number }
export const nativeVstEditorOwnershipProbe = (instanceId: string): NativeVstEditorOwnershipProbe => ({
  instanceId,
  command: "status",
})
export type NativeVstEditorStatus = {
  success: boolean
  owned: boolean
  supported: boolean
  open: boolean
  width: number
  height: number
  capturedState?: { bytes: Uint8Array; sha256: string }
  closeError?: string
  teardownError?: string
}

type NativeHostRequestType =
  | typeof hostHelloType
  | typeof deviceConfigureType
  | typeof assetInstallType
  | typeof assetReleaseType
  | typeof mappedAssetCreateType
  | typeof mappedAssetWritePageType
  | typeof mappedAssetPrepareRangeType
  | typeof mappedAssetReleaseType
  | typeof startType
  | typeof stopType
  | typeof teardownType
  | typeof graphSnapshotType
  | typeof transportType
  | typeof parameterEventsType
  | typeof processorStatePatchType
  | typeof midiEventsType
  | typeof sourceEventsType
  | typeof deviceListType
  | typeof transactionBeginType
  | typeof transactionCommitType
  | typeof transactionRollbackType
  | typeof vstParameterEventsType
  | typeof vstMidiEventsType
  | typeof vstStateSetType
  | typeof vstStateGetType
  | typeof vstStateType
  | typeof recordingConfigureType
  | typeof recordingStartType
  | typeof recordingStopType
  | typeof recordingCancelType
  | typeof recordingDeviceQueryType
  | typeof graphPrepareType
  | typeof graphPublishType
  | typeof graphRetireType
  | typeof graphRollbackType
  | typeof vstAttachType
  | typeof vstDetachType
  | typeof vstEditorType
  | typeof diagnosticStartType
  | typeof scheduleWindowType
  | typeof vstScheduleAutomationEnableType
  | typeof instrumentStatesType
  | typeof spectrumSelectionType

const coreAudioDeviceId = (value: string): value is `coreaudio:${string}` => (
  value.startsWith("coreaudio:") && value.length > "coreaudio:".length
)
const nativeVstInstanceId = (value: string): boolean => (
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
)

export class NativeAudioHostCommandError extends Error {
  readonly requestType: number
  readonly recoverable = true

  constructor(requestType: number, message = `The native audio host rejected control request ${requestType}.`) {
    super(message)
    this.name = "NativeAudioHostCommandError"
    this.requestType = requestType
  }
}

export type NativeOfflineWaitStage =
  | "host handshake"
  | "offline configuration"
  | "asset installation"
  | "VST attachment"
  | "graph snapshot"
  | "instrument state"
  | "transport"
  | "schedule window"
  | "offline start"
  | "offline completion"

export class NativeOfflineRenderTimeoutError extends Error {
  readonly stage: NativeOfflineWaitStage

  constructor(stage: NativeOfflineWaitStage) {
    super(`The native offline renderer timed out during ${stage}.`)
    this.name = "NativeOfflineRenderTimeoutError"
    this.stage = stage
  }
}

const encodeOfflineConfigure = (plan: NativeOfflineRenderPlan) => {
  const output = Buffer.alloc(16)
  output.writeUInt32BE(plan.sampleRateHz, 0)
  output.writeUInt32BE(plan.blockFrames, 4)
  output.writeUInt32BE(plan.channelCount, 8)
  output.writeUInt32BE(1, 12)
  return output
}

const encodeOfflineStart = (plan: NativeOfflineRenderPlan) => {
  const output = Buffer.alloc(16)
  output.writeBigUInt64BE(BigInt(plan.totalFrames), 0)
  output.writeUInt32BE(plan.blockFrames, 8)
  output.writeUInt32BE(plan.channelCount, 12)
  return output
}

type NativeOfflineStdoutPumpInput = {
  onFrame: (frame: Buffer) => void
  onPcmFrame: (frame: Buffer) => Promise<void>
  isPcmFrame: (frame: Buffer) => boolean
  onError: (error: Error) => void
  pause: () => void
  resume: () => void
}

export const createNativeOfflineStdoutPump = (input: NativeOfflineStdoutPumpInput) => {
  let buffer = Buffer.alloc(0)
  let maximumBufferedBytes = 0
  let sinkBusy = false
  let stopped = false
  let pumping = false

  const pump = () => {
    if (stopped || sinkBusy || pumping) return
    pumping = true
    try {
      while (!stopped && !sinkBusy && buffer.byteLength >= headerBytes) {
        const payloadBytes = buffer.readUInt32BE(12)
        if (payloadBytes > maximumPayloadBytes) {
          stopped = true
          input.onError(new Error("The native offline renderer returned an oversized frame."))
          return
        }
        if (buffer.byteLength < headerBytes + payloadBytes) return
        const frame = buffer.subarray(0, headerBytes + payloadBytes)
        buffer = buffer.subarray(frame.byteLength)
        if (frame.readUInt32BE(0) !== magic || frame.readUInt32BE(4) !== protocolVersion) {
          stopped = true
          input.onError(new Error("The native offline renderer returned an invalid frame."))
          return
        }
        if (!input.isPcmFrame(frame)) {
          input.onFrame(frame)
          continue
        }
        sinkBusy = true
        input.pause()
        void Promise.resolve().then(() => input.onPcmFrame(frame)).then(
          () => {
            sinkBusy = false
            if (stopped) return
            pump()
            if (!sinkBusy && !stopped) input.resume()
          },
          (error) => {
            stopped = true
            sinkBusy = false
            input.onError(error instanceof Error ? error : new Error("The native offline PCM sink failed."))
          },
        )
      }
    } finally {
      pumping = false
    }
  }

  return {
    push(chunk: Buffer) {
      if (stopped) return
      buffer = Buffer.concat([buffer, chunk])
      pump()
      maximumBufferedBytes = Math.max(maximumBufferedBytes, buffer.byteLength)
    },
    stop() {
      stopped = true
    },
    bufferedBytes: () => buffer.byteLength,
    maximumBufferedBytes: () => maximumBufferedBytes,
    sinkBusy: () => sinkBusy,
  }
}

export const createNativeOfflineFrameMailbox = () => {
  const frames: Buffer[] = []
  let terminalError: Error | undefined
  let closedError: Error | undefined
  let resolveNext: ((frame: Buffer) => void) | undefined
  let rejectNext: ((error: Error) => void) | undefined

  const rejectPending = (error: Error) => {
    const reject = rejectNext
    resolveNext = undefined
    rejectNext = undefined
    reject?.(error)
  }

  return {
    push(frame: Buffer) {
      if (terminalError || closedError) return true
      const resolve = resolveNext
      resolveNext = undefined
      rejectNext = undefined
      if (resolve) {
        resolve(frame)
        return true
      }
      if (frames.length >= maximumOfflineQueuedFrames) return false
      frames.push(frame)
      return true
    },
    next() {
      if (terminalError) return Promise.reject<Buffer>(terminalError)
      if (closedError) return Promise.reject<Buffer>(closedError)
      const queued = frames.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise<Buffer>((resolve, reject) => {
        resolveNext = resolve
        rejectNext = reject
      })
    },
    fail(error: Error) {
      if (terminalError || closedError) return
      terminalError = error
      frames.length = 0
      rejectPending(error)
    },
    close() {
      if (terminalError || closedError) return
      closedError = new Error("The native offline renderer is unavailable.")
      frames.length = 0
      rejectPending(closedError)
    },
  }
}

export const renderNativeOffline = async (input: {
  hostPath: string
  plan: NativeOfflineRenderPlan
  vstAttachments?: readonly ResolvedVst3Attachment[]
  signal: AbortSignal
  onChunk: (chunk: NativeOfflinePcmChunk) => void | Promise<void>
  completionInactivityMs?: number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void
}): Promise<void> => {
  if (!nativeOfflineRenderPlanSchema.safeParse(input.plan).success || (
    input.plan.version !== 1
    || !unsigned32(input.plan.sampleRateHz)
    || !unsigned32(input.plan.blockFrames)
    || input.plan.blockFrames === 0
    || (input.plan.channelCount !== 1 && input.plan.channelCount !== 2)
    || !Number.isSafeInteger(input.plan.totalFrames)
    || input.plan.totalFrames <= 0
    || input.plan.graph.byteLength === 0
    || input.plan.schedule.byteLength === 0
  )) throw new Error("The native offline render plan is invalid.")
  input.signal.throwIfAborted()
  const child = spawn(input.hostPath, [], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let finished = false
  const mailbox = createNativeOfflineFrameMailbox()
  let refreshCompletionWatchdog: (() => void) | undefined
  const schedule = input.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelScheduled = input.cancelScheduled ?? ((timer) => clearTimeout(timer))
  const completionInactivityMs = input.completionInactivityMs ?? nativeOfflineCompletionInactivityTimeoutMs
  const terminate = () => {
    if (!child.killed) child.kill()
  }
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  let stderr = Buffer.alloc(0)
  let stderrTruncated = false
  const stderrText = () => {
    const text = stderr.toString("utf8").trim()
    return stderrTruncated ? `${text}\n[native stderr truncated]` : text
  }
  const withStderr = (message: string) => {
    const diagnostic = stderrText()
    return diagnostic ? `${message} Native stderr: ${diagnostic}` : message
  }
  let stopPump = () => {}
  const fail = (error: Error) => {
    if (finished) return
    finished = true
    mailbox.fail(error)
    stopPump()
    terminate()
  }
  const nextFrame = () => {
    return mailbox.next()
  }
  const consumeOfflinePcmChunk = (frame: Buffer) => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength < 16) throw new Error("The native offline renderer returned an invalid PCM chunk.")
    const startFrame = Number(frame.readBigUInt64BE(headerBytes))
    const frameCount = frame.readUInt32BE(headerBytes + 8)
    const channelCount = frame.readUInt32BE(headerBytes + 12)
    const sampleBytes = frameCount * channelCount * 4
    if (
      channelCount !== input.plan.channelCount
      || frameCount === 0
      || payload.byteLength !== 16 + sampleBytes
      || startFrame + frameCount > input.plan.totalFrames
    ) throw new Error("The native offline renderer returned an invalid PCM chunk.")
    const samples = new Float32Array(frameCount * channelCount)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = payload.readFloatBE(16 + index * Float32Array.BYTES_PER_ELEMENT)
    }
    const planes = Array.from({ length: channelCount }, (_, channel) => (
      samples.subarray(channel * frameCount, (channel + 1) * frameCount)
    ))
    return input.onChunk({ startFrame, frameCount, channelCount, planes })
  }
  const onStdoutFrame = (frame: Buffer) => {
    if (isNativeOfflineTelemetryFrame(frame.readUInt32BE(8))) return
    if (!mailbox.push(frame)) {
      fail(new Error("The native offline renderer produced frames faster than they could be consumed."))
    }
  }
  const pump = createNativeOfflineStdoutPump({
    onFrame: onStdoutFrame,
    onPcmFrame: async (frame) => {
      await consumeOfflinePcmChunk(frame)
      refreshCompletionWatchdog?.()
    },
    isPcmFrame: (frame) => frame.readUInt32BE(8) === offlinePcmChunkType,
    onError: (error) => fail(error),
    pause: () => child.stdout.pause(),
    resume: () => child.stdout.resume(),
  })
  stopPump = pump.stop
  child.stdout.on("data", pump.push)
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.byteLength >= maximumOfflineStderrBytes) {
      stderrTruncated = true
      return
    }
    const remaining = maximumOfflineStderrBytes - stderr.byteLength
    if (chunk.byteLength > remaining) {
      stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)])
      stderrTruncated = true
      return
    }
    stderr = Buffer.concat([stderr, chunk])
  })
  const onError = (error: Error) => fail(error)
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!finished) {
      fail(new Error(withStderr(
        `The native offline renderer exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`,
      )))
    }
  }
  child.on("error", onError)
  child.on("close", onClose)
  const abort = () => {
    if (!finished) fail(new DOMException("Native offline rendering canceled.", "AbortError"))
  }
  input.signal.addEventListener("abort", abort, { once: true })
  const send = (type: number, payload: Uint8Array | Buffer = Buffer.alloc(0)) => {
    const frame = encodeNativeAudioHostControlFrame(type, payload)
    if (!frame || !child.stdin.writable) throw new Error("The native offline renderer is unavailable.")
    child.stdin.write(frame)
  }
  const waitFor = async (
    type: number,
    acknowledgedType: number | undefined,
    stage: NativeOfflineWaitStage,
  ) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectTimeout: ((error: Error) => void) | undefined
    const isCompletion = stage === "offline completion"
    const timeoutDelay = isCompletion ? completionInactivityMs : nativeOfflineStageTimeoutMs
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject
      timer = schedule(() => reject(new NativeOfflineRenderTimeoutError(stage)), timeoutDelay)
    })
    const refresh = () => {
      if (!isCompletion || rejectTimeout === undefined) return
      if (timer !== undefined) cancelScheduled(timer)
      timer = schedule(() => rejectTimeout?.(new NativeOfflineRenderTimeoutError(stage)), completionInactivityMs)
    }
    if (isCompletion) refreshCompletionWatchdog = refresh
    const receive = async () => {
      while (true) {
        const frame = await nextFrame()
        const frameType = frame.readUInt32BE(8)
        if (frameType === type && frameType !== ackType) return frame
        if (frameType === offlineErrorType) {
          const payload = frame.subarray(headerBytes)
          if (payload.byteLength < 4) throw new Error("The native offline renderer failed.")
          const length = payload.readUInt32BE(0)
          throw new Error(withStderr(payload.subarray(4, 4 + Math.min(length, 256)).toString("utf8")))
        }
        if (frameType === ackType) {
          if (acknowledgedType === undefined) continue
          if (frame.subarray(headerBytes).byteLength !== 8
            || frame.readUInt32BE(headerBytes) !== acknowledgedType
            || frame.readUInt32BE(headerBytes + 4) !== 1) {
            throw new Error("The native offline renderer rejected a request.")
          }
          return frame
        }
        if (frameType === offlineCompleteType && type === offlineCompleteType) return frame
      }
    }
    try {
      return await Promise.race([receive(), timeout])
    } finally {
      if (timer !== undefined) cancelScheduled(timer)
      if (isCompletion && refreshCompletionWatchdog === refresh) refreshCompletionWatchdog = undefined
    }
  }
  try {
    send(hostHelloType)
    const capabilities = readResponse(await waitFor(hostCapabilitiesType, undefined, "host handshake"))
    if (!capabilities || !isCompatibleAudioHostHello(capabilities)) {
      throw new Error("The native offline renderer has an incompatible host contract.")
    }
    send(offlineConfigureType, encodeOfflineConfigure(input.plan))
    await waitFor(ackType, offlineConfigureType, "offline configuration")
    for (const asset of input.plan.assets) {
      const payload = serializeAssetInstall(asset)
      if (!payload) throw new Error("The native offline asset is invalid.")
      send(assetInstallType, payload)
      await waitFor(ackType, assetInstallType, "asset installation")
    }
    for (const attachment of input.vstAttachments ?? []) {
      const payload = serializeVstAttachment(attachment)
      if (!payload) throw new Error("The native offline VST attachment is invalid.")
      send(vstAttachType, payload)
      await waitFor(ackType, vstAttachType, "VST attachment")
    }
    send(graphSnapshotType, input.plan.graph)
    await waitFor(ackType, graphSnapshotType, "graph snapshot")
    if (input.plan.instrumentStates) {
      send(instrumentStatesType, input.plan.instrumentStates)
      await waitFor(ackType, instrumentStatesType, "instrument state")
    }
    const transport = serializeTransport(input.plan.transport)
    if (!transport) throw new Error("The native offline transport is invalid.")
    send(transportType, transport)
    await waitFor(ackType, transportType, "transport")
    for (const schedule of input.plan.scheduleWindows ?? [input.plan.schedule]) {
      send(scheduleWindowType, schedule)
      await waitFor(ackType, scheduleWindowType, "schedule window")
    }
    send(offlineStartType, encodeOfflineStart(input.plan))
    await waitFor(ackType, offlineStartType, "offline start")
    await waitFor(offlineCompleteType, undefined, "offline completion")
    finished = true
  } finally {
    finished = true
    mailbox.close()
    input.signal.removeEventListener("abort", abort)
    stopPump()
    child.stdout.removeListener("data", pump.push)
    child.removeListener("error", onError)
    child.removeListener("close", onClose)
    terminate()
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ])
    child.stdout.removeAllListeners("data")
  }
}

const readResponse = (bytes: Buffer): AudioHostHello | undefined => {
  if (!(bytes.byteLength >= headerBytes + 12
  && bytes.readUInt32BE(0) === magic
  && bytes.readUInt32BE(4) === protocolVersion
  && bytes.readUInt32BE(8) === hostCapabilitiesType
  && bytes.readUInt32BE(headerBytes) === protocolVersion)) return undefined
  let offset = headerBytes + 12
  const readString = () => {
    if (offset + 4 > bytes.byteLength) return undefined
    const length = bytes.readUInt32BE(offset)
    offset += 4
    if (length === 0 || offset + length > bytes.byteLength) return undefined
    const value = bytes.subarray(offset, offset + length).toString("utf8")
    offset += length
    return value
  }
  const processorContractHash = readString()
  const graphContractHash = readString()
  const artifactId = readString()
  if (!processorContractHash || !graphContractHash || !artifactId || offset + 8 !== bytes.byteLength) return undefined
  const parsedDeviceState = deviceState(bytes.readUInt32BE(offset))
  const parsedReadinessReason = readinessReason(bytes.readUInt32BE(offset + 4))
  if (!parsedDeviceState || !parsedReadinessReason) return undefined
  return {
    capabilities: bytes.readUInt32BE(headerBytes + 4),
    abiVersion: bytes.readUInt32BE(headerBytes + 8),
    processorContractHash,
    graphContractHash,
    artifactId,
    deviceState: parsedDeviceState,
    readinessReason: parsedReadinessReason,
  }
}

const isCompatibleAudioHostHello = (hello: AudioHostHello) => (
  (hello.capabilities & requiredHostCapabilities) === requiredHostCapabilities
  && hello.abiVersion === audioCoreWasmAbiVersion
  && hello.processorContractHash === processorContractHash
  && hello.graphContractHash === portableGraphContractHash
  && hello.artifactId === nativeAudioHostArtifactId
)

export const packagedAudioHostPath = (resourcesPath: string, isPackaged: boolean, explicitPath?: string) => (
  isPackaged ? path.join(resourcesPath, "daw-audio-host-macos") : explicitPath
)

export const runAudioHostDiagnostic = async (hostPath: string): Promise<{ ok: true; hello: AudioHostHello } | { ok: false; error: string }> => {
  try {
    await access(hostPath)
  } catch {
    return { ok: false, error: "The native audio host is unavailable." }
  }
  const request = encodeNativeAudioHostControlFrame(hostHelloType)
  if (!request) return { ok: false, error: "The native audio host protocol is unavailable." }
  return new Promise((resolve) => {
    const child = spawn(hostPath, [], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (result: { ok: true; hello: AudioHostHello } | { ok: false; error: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ ok: false, error: "The native audio host diagnostic timed out." })
    }, 2_000)
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > headerBytes + maximumPayloadBytes) child.kill("SIGKILL")
      else chunks.push(chunk)
    })
    child.once("error", () => finish({ ok: false, error: "The native audio host could not start." }))
    child.once("close", () => {
      const hello = readResponse(Buffer.concat(chunks))
      finish(hello && isCompatibleAudioHostHello(hello)
      ? { ok: true, hello }
      : { ok: false, error: "The native audio host returned an incompatible protocol response." })
    })
    child.stdin.end(request)
  })
}

type PendingControl = {
  resolve: () => void
  reject: (error: Error) => void
  deadline: ReturnType<typeof setTimeout>
  expectedAckType?: NativeHostRequestType
  diagnosticsResolve?: (value: NativeHostDiagnostics) => void
  devicesResolve?: (value: NativeOutputDevice | null) => void
  inputDeviceResolve?: (value: NativeInputDevice | null) => void
  graphRevisionResolve?: (value: NativeGraphRevisionStatus) => void
  editorResolve?: (value: NativeVstEditorStatus) => void
  stateResolve?: (value: { bytes: Uint8Array; sha256: string }) => void
  stateInstanceId?: string
  stateCancelled?: boolean
}

type SpawnHost = (hostPath: string) => ChildProcessWithoutNullStreams

export type NativeAudioHostSupervisorOptions = {
  gracefulTerminationMs?: number
  sigtermTerminationMs?: number
  sigkillObservationMs?: number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void
  kill?: (child: ChildProcessWithoutNullStreams, signal: "SIGTERM" | "SIGKILL") => boolean
}

export type NativeAudioHostSupervisor = {
  start(): Promise<AudioHostHello>
  runTransaction<T>(operation: (transaction: Pick<NativeAudioHostSupervisor, "attachVst">) => Promise<T>): Promise<T>
  invalidateManualTransaction(): Promise<void>
  configure(input: NativeHostDeviceConfiguration, transactionToken?: string): Promise<void>
  beginTransaction(): Promise<string>
  commitTransaction(transactionToken: string): Promise<void>
  rollbackTransaction(transactionToken: string): Promise<void>
  attachVst(input: ResolvedVst3Attachment, transactionToken?: string): Promise<void>
  getVstState(instanceId: string, transactionToken?: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; sha256: string }>
  detachVst(instanceId: string, transactionToken?: string): Promise<void>
  executeVstEditorCommand(input: { instanceId: string; command: NativeVstEditorCommand; width?: number; height?: number; anchor?: NativeVstEditorAnchor }, transactionToken?: string): Promise<NativeVstEditorStatus>
  installAsset(input: NativeHostPcmAsset, transactionToken?: string): Promise<void>
  createMappedAsset(input: NativeHostMappedAsset, transactionToken?: string): Promise<void>
  writeMappedAssetPage(input: NativeHostMappedAssetPage, transactionToken?: string): Promise<void>
  prepareMappedAssetRange(sessionAssetId: number, startFrame: number, frameCount: number, transactionToken?: string): Promise<void>
  releaseMappedAsset(sessionAssetId: number, transactionToken?: string): Promise<void>
  releaseAsset(sessionAssetId: number, transactionToken?: string): Promise<void>
  publishGraph(bytes: Uint8Array, transactionToken?: string): Promise<void>
  configureInstrumentStates(bytes: Uint8Array, transactionToken?: string): Promise<void>
  prepareGraphRevision(bytes: Uint8Array, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  publishGraphRevision(revision: number, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  rollbackGraphRevision(revision: number, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  retireGraphRevision(revision: number, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  queueParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<void>
  queueProcessorStatePatch(bytes: Uint8Array, transactionToken?: string): Promise<void>
  queueVstParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<void>
  queueInstrumentEvents(bytes: Uint8Array, transactionToken?: string): Promise<void>
  queueSourceEvents(bytes: Uint8Array, transactionToken?: string): Promise<void>
  setTransport(input: NativeHostTransport, transactionToken?: string): Promise<void>
  resolveOutputDevice(preferredDeviceId?: string): Promise<NativeOutputDevice | null>
  resolveInputDevice(preferredDeviceId?: string): Promise<NativeInputDevice | null>
  startAudio(): Promise<void>
  startDiagnosticAudio(): Promise<void>
  stopAudio(): Promise<void>
  diagnostics(): Promise<NativeHostDiagnostics>
  configureRecording(input: NativeHostRecordingConfiguration): Promise<void>
  startRecording(): Promise<void>
  stopRecording(stopFrame?: number): Promise<void>
  cancelRecording(): Promise<void>
  teardown(): Promise<void>
  status(): { running: boolean; hello?: AudioHostHello }
  transactionOpen(): boolean
  onLoss(listener: (error: Error) => void): () => void
  onRecordingBlock(listener: (block: NativeHostRecordingBlock) => void): () => void
  onRecordingStatus(listener: (status: NativeHostRecordingStatus) => void): () => void
  onMeterBatch(listener: (batch: NativeHostMeterBatch) => void): () => void
  setSpectrumNode(nodeId: bigint | null): Promise<void>
  onSpectrumFrame(listener: (frame: NativeHostSpectrumFrame) => void): () => void
  queueScheduleWindow(bytes: Uint8Array, transactionToken?: string): Promise<void>
  reenableVstScheduleAutomation(bytes: Uint8Array, transactionToken?: string): Promise<void>
  onScheduleProgress(listener: (progress: NativeScheduleProgress) => void): () => void
  onWorkerNotification(listener: (notification: NativeWorkerNotification) => void): () => void
  suspend(): Promise<void>
  resume(): Promise<void>
}

export const createNativeAudioHostSupervisor = (
  hostPath: string,
  spawnHost: SpawnHost = (executable) => spawn(executable, [], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] }),
  options: NativeAudioHostSupervisorOptions = {},
): NativeAudioHostSupervisor => {
  let child: ChildProcessWithoutNullStreams | undefined
  let hello: AudioHostHello | undefined
  let buffer = Buffer.alloc(0)
  let pending: PendingControl | undefined
  let startPromise: Promise<AudioHostHello> | undefined
  let teardownPromise: Promise<void> | undefined
  let childTerminationPromise: Promise<void> | undefined
  let resumePromise: Promise<void> | undefined
  let lifecycleGeneration = 0
  let suspended = false
  let lifecycleIntentVersion = 0
  let terminationFailure: Error | undefined
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelScheduled = options.cancelScheduled ?? ((timer) => clearTimeout(timer))
  const gracefulTerminationMs = options.gracefulTerminationMs ?? 250
  const sigtermTerminationMs = options.sigtermTerminationMs ?? 250
  const sigkillObservationMs = options.sigkillObservationMs ?? 250
  let transactionTail = Promise.resolve()
  let transactionOwner: symbol | undefined
  let manualTransactionToken: string | undefined
  let manualTransactionGeneration = 0
  let manualTransactionInvalidationVersion = 0
  let manualInvalidationPromise: Promise<void> | undefined
  let nextTransportTransitionId = 0n
  const lossListeners = new Set<(error: Error) => void>()
  const recordingBlockListeners = new Set<(block: NativeHostRecordingBlock) => void>()
  const recordingStatusListeners = new Set<(status: NativeHostRecordingStatus) => void>()
  const meterBatchListeners = new Set<(batch: NativeHostMeterBatch) => void>()
  const spectrumFrameListeners = new Set<(frame: NativeHostSpectrumFrame) => void>()
  const scheduleProgressListeners = new Set<(progress: NativeScheduleProgress) => void>()
  const workerNotificationListeners = new Set<(notification: NativeWorkerNotification) => void>()
  type QueuedSend = {
    type: NativeHostRequestType
    payload?: Buffer
    owner?: symbol
    allowDuringTeardown: boolean
    resolve: () => void
    reject: (error: Error) => void
    editorResolve?: (status: NativeVstEditorStatus) => void
    stateResolve?: (value: { bytes: Uint8Array; sha256: string }) => void
    stateInstanceId?: string
    stateCancelled?: boolean
  }
  const urgentSends: QueuedSend[] = []
  const normalSends: QueuedSend[] = []
  const refillSends: QueuedSend[] = []
  let dispatchNext: () => void = () => {}
  const rejectPending = (error: Error, dispatch = true) => {
    const current = pending
    pending = undefined
    if (current) {
      clearTimeout(current.deadline)
      current.reject(error)
    }
    if (dispatch) dispatchNext()
  }
  const lost = (message: string, source = child) => {
    if (!source || child !== source) return
    const error = new Error(message)
    rejectPending(error)
    child = undefined
    hello = undefined
    startPromise = undefined
    transactionOwner = undefined
    manualTransactionToken = undefined
    manualTransactionGeneration = -1
    nextTransportTransitionId = 0n
    buffer = Buffer.alloc(0)
    const currentChild = source
    currentChild?.kill()
    for (const queue of [urgentSends, normalSends, refillSends]) {
      while (queue.length > 0) queue.shift()?.reject(error)
    }
    for (const listener of lossListeners) listener(error)
  }
  const decodeDiagnostics = (frame: Buffer): NativeHostDiagnostics | undefined => {
    if (frame.byteLength !== headerBytes + 88) return undefined
    const state = frame.readUInt32BE(headerBytes)
    if (state !== 0 && state !== 1 && state !== 2 && state !== 3) return undefined
    return {
      state: state === 0 ? "idle" : state === 1 ? "configured" : state === 2 ? "running" : "faulted",
      activeRevision: frame.readUInt32BE(headerBytes + 4),
      preparedRevision: frame.readUInt32BE(headerBytes + 8),
      retiredRevision: frame.readUInt32BE(headerBytes + 12),
      transportEpoch: frame.readUInt32BE(headerBytes + 16),
      installedAssets: frame.readUInt32BE(headerBytes + 20),
      callbacks: frame.readUInt32BE(headerBytes + 24),
      rejectedBlocks: frame.readUInt32BE(headerBytes + 28),
      renderEpoch: frame.readBigUInt64BE(headerBytes + 32),
      lastRejectedReason: frame.readUInt32BE(headerBytes + 40),
      lastRejectedCallback: frame.readBigUInt64BE(headerBytes + 44),
      lastRejectedRenderEpoch: frame.readBigUInt64BE(headerBytes + 52),
      lastRejectedTransportEpoch: frame.readUInt32BE(headerBytes + 60),
      lastRejectedCoreResult: frame.readUInt32BE(headerBytes + 64),
      lastRejectedFrameCount: frame.readUInt32BE(headerBytes + 68),
      lastRejectedChannelCount: frame.readUInt32BE(headerBytes + 72),
      lastRejectedProcessorEventCount: frame.readUInt32BE(headerBytes + 76),
      lastRejectedInstrumentEventCount: frame.readUInt32BE(headerBytes + 80),
      lastRejectedGraphRevision: frame.readUInt32BE(headerBytes + 84),
    }
  }
  const terminateDetachedChild = (current: ChildProcessWithoutNullStreams) => new Promise<void>((resolve, reject) => {
    let settled = false
    const timers: NativeAudioHostTerminationTimers = {}
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timers.graceful) cancelScheduled(timers.graceful)
      if (timers.sigterm) cancelScheduled(timers.sigterm)
      if (timers.killObservation) cancelScheduled(timers.killObservation)
      if (error) {
        terminationFailure = error
        reject(error)
      }
      else resolve()
    }
    current.once("close", () => finish())
    // An error does not prove that the child has closed. Keep the bounded
    // termination sequence alive until close is observed or it hard-fails.
    current.once("error", () => undefined)
    const kill = (signal: "SIGTERM" | "SIGKILL") => {
      try {
        return options.kill?.(current, signal) ?? current.kill(signal)
      } catch {
        return false
      }
    }
    timers.graceful = schedule(() => {
      kill("SIGTERM")
      timers.sigterm = schedule(() => {
        const killed = kill("SIGKILL")
        timers.killObservation = schedule(() => {
          finish(new Error(
            killed
              ? "The native audio host did not close after SIGKILL."
              : "The native audio host could not be terminated.",
          ))
        }, sigkillObservationMs)
      }, sigtermTerminationMs)
    }, gracefulTerminationMs)
  })
  const decodeGraphRevisionStatus = (frame: Buffer): NativeGraphRevisionStatus | undefined => {
    const legacy = frame.byteLength === headerBytes + 28
    if (!legacy && frame.byteLength !== headerBytes + 32) return undefined
    const code = frame.readUInt32BE(headerBytes)
    const continuityCode = legacy ? 0 : frame.readUInt32BE(headerBytes + 4)
    const continuity = continuityCode === 1 ? "accepted"
      : continuityCode === 2 ? "fallback"
      : continuityCode === 3 ? "rejected"
      : "not-evaluated"
    const status = code === 1 ? "prepared"
      : code === 2 ? "published"
      : code === 3 ? "retired"
      : code === 4 ? "rolled-back"
      : code === 5 ? "stale-revision"
      : code === 6 ? "invalid-revision"
      : code === 7 ? "prepare-failed"
      : code === 8 ? "publish-failed"
      : code === 9 ? "retirement-not-safe"
      : code === 10 ? "retirement-capacity-exceeded"
      : undefined
    if (!status) return undefined
    return {
      status,
      requestedRevision: frame.readUInt32BE(headerBytes + (legacy ? 4 : 8)),
      continuity,
      activeRevision: frame.readUInt32BE(headerBytes + (legacy ? 8 : 12)),
      preparedRevision: frame.readUInt32BE(headerBytes + (legacy ? 12 : 16)),
      retiredRevision: frame.readUInt32BE(headerBytes + (legacy ? 16 : 20)),
      renderEpoch: frame.readBigUInt64BE(headerBytes + (legacy ? 20 : 24)),
    }
  }
  const decodeVstEditorStatus = (frame: Buffer): NativeVstEditorStatus | undefined => {
    if (frame.byteLength !== headerBytes + 24) return undefined
    const flags = frame.readUInt32BE(headerBytes)
    if (
      flags > 1
      || frame.readUInt32BE(headerBytes + 4) > 1
      || frame.readUInt32BE(headerBytes + 8) > 1
      || frame.readUInt32BE(headerBytes + 12) > 1
    ) return undefined
    return {
      success: flags === 1,
      owned: frame.readUInt32BE(headerBytes + 4) === 1,
      supported: frame.readUInt32BE(headerBytes + 8) === 1,
      open: frame.readUInt32BE(headerBytes + 12) === 1,
      width: frame.readUInt32BE(headerBytes + 16),
      height: frame.readUInt32BE(headerBytes + 20),
    }
  }
  const decodeWorkerNotification = (frame: Buffer): NativeWorkerNotification | undefined => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength < 24) return undefined
    const kindValue = payload.readUInt32BE(0)
    const kind = kindValue === 1 ? "latency"
      : kindValue === 2 ? "buses"
      : kindValue === 3 ? "restart"
      : kindValue === 4 ? "fault"
      : kindValue === 5 ? "miss"
      : kindValue === 6 ? "editor-interaction"
      : kindValue === 7 ? "parameter-edit"
      : kindValue === 8 ? "tail"
      : kindValue === 9 ? "editor-state"
      : undefined
    if (kind === "parameter-edit") {
      if (payload.byteLength < 32) return undefined
      const parameterId = payload.readUInt32BE(16)
      const normalizedValue = payload.readDoubleBE(20)
      const instanceBytes = payload.readUInt32BE(28)
      const instanceId = payload.subarray(32).toString("utf8")
      if (parameterId > 0xffff_ffff
        || !Number.isFinite(normalizedValue)
        || normalizedValue < 0
        || normalizedValue > 1
        || instanceBytes === 0
        || instanceBytes > maximumVstStringBytes
        || payload.byteLength !== 32 + instanceBytes
        || !nativeVstInstanceId(instanceId)) return undefined
      return {
        kind,
        graphRevision: payload.readUInt32BE(4),
        graphNodeId: payload.readBigUInt64BE(8),
        parameterId,
        normalizedValue,
        instanceId,
      }
    }
    const instanceBytes = payload.readUInt32BE(20)
    if (!kind || instanceBytes === 0 || instanceBytes > maximumVstStringBytes
      || payload.byteLength !== 24 + instanceBytes) return undefined
    return {
      kind,
      graphRevision: payload.readUInt32BE(4),
      graphNodeId: payload.readBigUInt64BE(8),
      value: payload.readUInt32BE(16),
      instanceId: payload.subarray(24).toString("utf8"),
    }
  }
  const decodeOutputDevice = (frame: Buffer): NativeOutputDevice | null | undefined => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength === 4 && payload.readUInt32BE(0) === 0) return null
    if (payload.byteLength < 4 || payload.readUInt32BE(0) !== 1) return undefined
    let offset = 4
    const readString = () => {
      if (offset + 4 > payload.byteLength) return undefined
      const length = payload.readUInt32BE(offset)
      offset += 4
      if (length === 0 || offset + length > payload.byteLength) return undefined
      const value = payload.subarray(offset, offset + length).toString("utf8")
      offset += length
      return value
    }
    const deviceId = readString()
    const name = readString()
    if (!deviceId || !coreAudioDeviceId(deviceId) || !name || offset + 16 !== payload.byteLength) return undefined
    const nominalSampleRateHz = payload.readUInt32BE(offset)
    const outputChannelCount = payload.readUInt32BE(offset + 4)
    const maximumFramesPerBlock = payload.readUInt32BE(offset + 8)
    const availability = payload.readUInt32BE(offset + 12)
    if (availability !== 0 && availability !== 1) return undefined
    return { deviceId, name, nominalSampleRateHz, outputChannelCount, maximumFramesPerBlock, available: availability === 1 }
  }
  const decodeInputDevice = (frame: Buffer): NativeInputDevice | null | undefined => {
    const device = decodeOutputDevice(frame)
    if (device === undefined || device === null) return device
    return {
      deviceId: device.deviceId,
      name: device.name,
      nominalSampleRateHz: device.nominalSampleRateHz,
      inputChannelCount: device.outputChannelCount,
      maximumFramesPerBlock: device.maximumFramesPerBlock,
      available: device.available,
    }
  }
  const safeUnsigned64 = (value: bigint) => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
  const decodeRecordingBlock = (frame: Buffer): NativeHostRecordingBlock | undefined => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength < 32) return undefined
    const channelCount = payload.readUInt32BE(20)
    const frameCount = payload.readUInt32BE(16)
    const expectedBytes = frameCount * channelCount * Float32Array.BYTES_PER_ELEMENT
    if (
      (channelCount !== 1 && channelCount !== 2)
      || frameCount === 0 || frameCount > 2_048
      || expectedBytes !== payload.byteLength - 32
    ) return undefined
    return {
      generation: payload.readUInt32BE(0),
      sessionId: payload.readBigUInt64BE(4),
      sequence: payload.readUInt32BE(12),
      frameCount,
      channelCount,
      rms: payload.readFloatBE(24),
      peak: payload.readFloatBE(28),
      planarPcm: Uint8Array.from(payload.subarray(32)),
    }
  }
  const decodeRecordingStatus = (frame: Buffer): NativeHostRecordingStatus | undefined => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength !== 60) return undefined
    const timelineFrame = payload.readBigInt64BE(12)
    const capturedFrames = safeUnsigned64(payload.readBigUInt64BE(20))
    const droppedFrames = safeUnsigned64(payload.readBigUInt64BE(28))
    const flags = payload.readUInt32BE(56)
    if (
      timelineFrame < 0 || timelineFrame > BigInt(Number.MAX_SAFE_INTEGER)
      || capturedFrames === undefined || droppedFrames === undefined
      || (flags & ~7) !== 0
    ) return undefined
    return {
      generation: payload.readUInt32BE(0),
      sessionId: payload.readBigUInt64BE(4),
      timelineFrame: Number(timelineFrame),
      capturedFrames,
      droppedFrames,
      droppedBlocks: payload.readUInt32BE(36),
      availableBlocks: payload.readUInt32BE(40),
      queuedBlocks: payload.readUInt32BE(44),
      rms: payload.readFloatBE(48),
      peak: payload.readFloatBE(52),
      fatal: (flags & 1) !== 0,
      active: (flags & 2) !== 0,
      configured: (flags & 4) !== 0,
    }
  }
  const decodeMeterBatch = (frame: Buffer): NativeHostMeterBatch | undefined => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength < 20) return undefined
    const entryCount = payload.readUInt32BE(16)
    if (entryCount > maximumMeterEntries || payload.byteLength !== 20 + entryCount * 16) return undefined
    const entries: NativeHostMeterBatch["entries"][number][] = []
    for (let index = 0; index < entryCount; index += 1) {
      const offset = 20 + index * 16
      const leftRms = payload.readFloatBE(offset + 8)
      const rightRms = payload.readFloatBE(offset + 12)
      if (!Number.isFinite(leftRms) || !Number.isFinite(rightRms) || leftRms < 0 || rightRms < 0) return undefined
      entries.push({
        nodeId: payload.readBigUInt64BE(offset),
        leftRms,
        rightRms,
      })
    }
    return {
      graphRevision: payload.readUInt32BE(0),
      transportEpoch: payload.readUInt32BE(4),
      sequence: payload.readBigUInt64BE(8),
      entries,
    }
  }
  const decodeSpectrumFrame = (frame: Buffer): NativeHostSpectrumFrame | undefined => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength < 48) return undefined
    const graphRevision = payload.readUInt32BE(0)
    const transportEpoch = payload.readUInt32BE(4)
    const sequence = payload.readBigUInt64BE(8)
    const nodeId = payload.readBigUInt64BE(16)
    const sampleRateHz = payload.readUInt32BE(24)
    const fftSize = payload.readUInt32BE(28)
    const binCount = payload.readUInt32BE(32)
    const payloadBytes = payload.readUInt32BE(36)
    if (
      graphRevision === 0 || transportEpoch === 0 || sequence === 0n || nodeId === 0n
      || sampleRateHz === 0 || fftSize === 0 || fftSize > 16_384
      || binCount === 0 || binCount > maximumSpectrumBins || binCount !== fftSize / 2
      || payloadBytes !== binCount * 4 || payload.byteLength !== 40 + payloadBytes
    ) return undefined
    const data = new Float32Array(binCount)
    for (let index = 0; index < binCount; index += 1) {
      const value = payload.readFloatBE(40 + index * 4)
      if (!Number.isFinite(value) || value < 0 || value > 1) return undefined
      data[index] = value
    }
    return { graphRevision, transportEpoch, sequence, nodeId, sampleRateHz, fftSize, binCount, data }
  }
  const decodeScheduleProgress = (frame: Buffer): NativeScheduleProgress | undefined => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength !== 80) return undefined
    const revision = payload.readUInt32BE(0)
    const epoch = payload.readUInt32BE(4)
    const progressSequence = payload.readBigUInt64BE(8)
    if (revision === 0 || epoch === 0 || progressSequence === 0n) return undefined
    const flags = payload.readUInt32BE(64)
    if ((flags & ~3) !== 0) return undefined
    return {
      revision,
      epoch,
      progressSequence,
      renderedThroughFrame: payload.readBigUInt64BE(16),
      acceptedThroughFrame: payload.readBigUInt64BE(24),
      lastAcceptedWindowId: payload.readBigUInt64BE(32),
      appliedTransportTransitionId: payload.readBigUInt64BE(40),
      appliedUrgentSequence: payload.readBigUInt64BE(48),
      appliedProcessorSequence: payload.readBigUInt64BE(56),
      running: (flags & 1) !== 0,
      scheduleComplete: (flags & 2) !== 0,
      instrumentCredits: payload.readUInt32BE(68),
      sourceCredits: payload.readUInt32BE(72),
      automationCredits: payload.readUInt32BE(76),
    }
  }
  const decode = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.byteLength >= headerBytes) {
      const payloadBytes = buffer.readUInt32BE(12)
      if (payloadBytes > maximumPayloadBytes || buffer.byteLength < headerBytes + payloadBytes) return
      const frame = buffer.subarray(0, headerBytes + payloadBytes)
      buffer = buffer.subarray(headerBytes + payloadBytes)
      if (frame.readUInt32BE(0) !== magic || frame.readUInt32BE(4) !== protocolVersion) return lost("The native audio host returned an invalid control frame.")
      if (frame.readUInt32BE(8) === recordingBlockType) {
        const block = decodeRecordingBlock(frame)
        if (!block) return lost("The native audio host returned an invalid recording block.")
        for (const listener of recordingBlockListeners) listener(block)
      } else if (frame.readUInt32BE(8) === recordingStatusType) {
        const status = decodeRecordingStatus(frame)
        if (!status) return lost("The native audio host returned invalid recording status.")
        for (const listener of recordingStatusListeners) listener(status)
      } else if (frame.readUInt32BE(8) === meterBatchType) {
        const batch = decodeMeterBatch(frame)
        if (!batch) return lost("The native audio host returned an invalid meter batch.")
        for (const listener of meterBatchListeners) listener(batch)
      } else if (frame.readUInt32BE(8) === spectrumFrameType) {
        const spectrum = decodeSpectrumFrame(frame)
        if (!spectrum) return lost("The native audio host returned an invalid spectrum frame.")
        for (const listener of spectrumFrameListeners) listener(spectrum)
      } else if (frame.readUInt32BE(8) === scheduleProgressType) {
        const progress = decodeScheduleProgress(frame)
        if (!progress || progress.revision === 0 || progress.epoch === 0
          || progress.progressSequence === 0n) {
          return lost("The native audio host returned invalid schedule progress.")
        }
        for (const listener of scheduleProgressListeners) listener(progress)
      } else if (frame.readUInt32BE(8) === notificationType) {
        const notification = decodeWorkerNotification(frame)
        if (!notification) return lost("The native audio host returned an invalid worker notification.")
        for (const listener of workerNotificationListeners) listener(notification)
      } else if (frame.readUInt32BE(8) === hostCapabilitiesType && !hello) {
        const parsed = readResponse(frame)
        if (!parsed || !isCompatibleAudioHostHello(parsed)) {
          return lost("The native audio host returned an incompatible protocol response.")
        }
        hello = parsed
        if (pending) {
          clearTimeout(pending.deadline)
          pending.resolve()
        }
        pending = undefined
        dispatchNext()
      } else if (frame.readUInt32BE(8) === diagnosticsType && pending?.diagnosticsResolve) {
        const resolve = pending.diagnosticsResolve
        const diagnostic = decodeDiagnostics(frame)
        if (!diagnostic) return lost("The native audio host returned an invalid diagnostics response.")
        clearTimeout(pending.deadline)
        pending = undefined
        dispatchNext()
        resolve(diagnostic)
      } else if (frame.readUInt32BE(8) === deviceListType && pending?.devicesResolve) {
        const resolve = pending.devicesResolve
        const device = decodeOutputDevice(frame)
        if (device === undefined) return lost("The native audio host returned an invalid device response.")
        clearTimeout(pending.deadline)
        pending = undefined
        dispatchNext()
        resolve(device)
      } else if (frame.readUInt32BE(8) === recordingDeviceListType && pending?.inputDeviceResolve) {
        const resolve = pending.inputDeviceResolve
        const device = decodeInputDevice(frame)
        if (device === undefined) return lost("The native audio host returned an invalid input device response.")
        clearTimeout(pending.deadline)
        pending = undefined
        dispatchNext()
        resolve(device)
      } else if (frame.readUInt32BE(8) === graphRevisionStatusType && pending?.graphRevisionResolve) {
        const resolve = pending.graphRevisionResolve
        const status = decodeGraphRevisionStatus(frame)
        if (!status) return lost("The native audio host returned an invalid graph revision status.")
        clearTimeout(pending.deadline)
        pending = undefined
        dispatchNext()
        resolve(status)
      } else if (frame.readUInt32BE(8) === vstStateType && pending?.stateResolve) {
        const current = pending
        const resolve = current.stateResolve
        const payload = frame.subarray(headerBytes)
        const rejectState = (message: string) => {
          clearTimeout(current.deadline)
          pending = undefined
          dispatchNext()
          current.reject(new NativeAudioHostCommandError(vstStateGetType, message))
        }
        if (payload.byteLength < 4) {
          rejectState("The native audio host returned an invalid VST state response.")
          continue
        }
        const instanceBytes = payload.readUInt32LE(0)
        const instanceEnd = 4 + instanceBytes
        if (instanceBytes === 0 || instanceBytes > maximumVstStringBytes || payload.byteLength < instanceEnd + 8) {
          rejectState("The native audio host returned an invalid VST state response.")
          continue
        }
        const instanceId = payload.subarray(4, instanceEnd).toString("utf8")
        const stateBytes = payload.readUInt32LE(instanceEnd)
        const hashBytes = payload.readUInt32LE(instanceEnd + 4)
        const start = instanceEnd + 8
        const sha256 = payload.subarray(start + stateBytes).toString("utf8")
        if (
          instanceId !== current.stateInstanceId
          || hashBytes !== 64
          || stateBytes > 512 * 1024
          || payload.byteLength !== start + stateBytes + hashBytes
          || !/^[a-f0-9]{64}$/.test(sha256)
        ) {
          rejectState("The native audio host returned an invalid VST state response.")
          continue
        }
        const bytes = Uint8Array.from(payload.subarray(start, start + stateBytes))
        clearTimeout(pending.deadline)
        pending = undefined
        dispatchNext()
        if (!current.stateCancelled) resolve?.({ bytes, sha256 })
      } else if (frame.readUInt32BE(8) === vstEditorStatusType && pending?.editorResolve) {
        const resolve = pending.editorResolve
        const status = decodeVstEditorStatus(frame)
        if (!status) return lost("The native audio host returned an invalid VST editor response.")
        clearTimeout(pending.deadline)
        pending = undefined
        dispatchNext()
        resolve(status)
      } else if (
        frame.readUInt32BE(8) === ackType
        && frame.byteLength === headerBytes + 8
        && pending
        && (
          (pending.expectedAckType !== undefined && frame.readUInt32BE(headerBytes) === pending.expectedAckType)
          || (pending.stateResolve && frame.readUInt32BE(headerBytes) === vstStateGetType)
        )
      ) {
        const current = pending
        const accepted = frame.readUInt32BE(headerBytes + 4)
        if (accepted !== 0 && accepted !== 1) return lost("The native audio host returned an invalid control acknowledgement.")
        clearTimeout(current.deadline)
        pending = undefined
        dispatchNext()
        if (accepted === 1) current.resolve()
        else current.reject(new NativeAudioHostCommandError(
          frame.readUInt32BE(headerBytes),
          frame.readUInt32BE(headerBytes) === vstStateGetType
            ? "The native audio host could not capture VST state."
            : undefined,
        ))
      } else return lost("The native audio host rejected a control request.")
    }
  }
  dispatchNext = () => {
    if (suspended || pending || !child) return
    const next = urgentSends.shift() ?? refillSends.shift() ?? normalSends.shift()
    if (!next) return
    if ((teardownPromise && !next.allowDuringTeardown)
      || (transactionOwner !== undefined && transactionOwner !== next.owner)) {
      next.reject(new Error("The native audio host is unavailable."))
      dispatchNext()
      return
    }
    const frame = encodeNativeAudioHostControlFrame(next.type, next.payload)
    if (!frame) {
      next.reject(new Error("The native audio host protocol is unavailable."))
      dispatchNext()
      return
    }
    const current = child
    const deadline = setTimeout(() => lost("The native audio host control request timed out.", current), 2_000)
    pending = next.stateResolve
      ? {
        resolve: () => undefined,
        reject: next.reject,
        deadline,
        stateResolve: next.stateResolve,
        stateInstanceId: next.stateInstanceId,
      }
      : next.editorResolve
      ? { resolve: () => undefined, reject: next.reject, deadline, editorResolve: next.editorResolve }
      : { resolve: next.resolve, reject: next.reject, deadline, expectedAckType: next.type }
    current.stdin.write(frame)
  }
  const ownerForToken = (token: string | undefined) => (
    token !== undefined
    && token.length <= 128
    && manualTransactionToken === token
    && manualTransactionGeneration === lifecycleGeneration
      ? transactionOwner
      : undefined
  )
  const assertTransactionAccess = (token: string | undefined) => {
    if (transactionOwner === undefined) {
      if (token !== undefined) throw new Error("The native audio host transaction token is stale.")
      return undefined
    }
    if (token === undefined || ownerForToken(token) !== transactionOwner) {
      throw new Error("The native audio host transaction token is invalid.")
    }
    return transactionOwner
  }
  const send = (
    type: NativeHostRequestType,
    payload?: Buffer,
    owner?: symbol,
    allowDuringTeardown = false,
  ) => new Promise<void>((resolve, reject) => {
    if (suspended || !child || (teardownPromise && !allowDuringTeardown)
      || (transactionOwner !== undefined && transactionOwner !== owner)) {
      reject(new Error("The native audio host is unavailable."))
      return
    }
    const queued: QueuedSend = { type, payload, owner, allowDuringTeardown, resolve, reject }
    if (type === transportType || type === midiEventsType || type === stopType || type === teardownType
      || type === vstScheduleAutomationEnableType) {
      if (urgentSends.length >= 64) {
        reject(new Error("The native audio host urgent request queue is full."))
        return
      }
      urgentSends.push(queued)
    } else if (type === scheduleWindowType) {
      if (refillSends.length >= 8) {
        reject(new Error("The native audio host schedule queue is full."))
        return
      }
      refillSends.push(queued)
    } else {
      if (normalSends.length >= 32) {
        reject(new Error("The native audio host request queue is full."))
        return
      }
      normalSends.push(queued)
    }
    dispatchNext()
  })
  const enqueueTransaction = <T>(operation: () => Promise<T>) => {
    const result = transactionTail.then(operation)
    transactionTail = result.then(() => undefined, () => undefined)
    return result
  }
  const request = async (type: NativeHostRequestType, payload?: Buffer, token?: string) => {
    await supervisor.start()
    await send(type, payload, assertTransactionAccess(token))
  }
  const requestEditor = async (
    payload: Buffer,
    owner?: symbol,
  ): Promise<NativeVstEditorStatus> => {
    await supervisor.start()
    return new Promise((resolve, reject) => {
      if (suspended || !child || teardownPromise
        || (transactionOwner !== undefined && transactionOwner !== owner)) {
        reject(new Error("The native audio host is unavailable."))
        return
      }
      if (normalSends.length >= 32) {
        reject(new Error("The native host request queue is full."))
        return
      }
      normalSends.push({
        type: vstEditorType,
        payload,
        owner,
        allowDuringTeardown: false,
        resolve: () => undefined,
        reject,
        editorResolve: resolve,
      })
      dispatchNext()
    })
  }
  const requestGraphRevision = async (type: NativeHostRequestType, payload: Buffer, token?: string) => {
    await supervisor.start()
    assertTransactionAccess(token)
    const current = child
    if (!current || pending) throw new Error("The native audio host is unavailable.")
    const frame = encodeNativeAudioHostControlFrame(type, payload)
    if (!frame) throw new Error("The native audio host protocol is unavailable.")
    return new Promise<NativeGraphRevisionStatus>((resolve, reject) => {
      const deadline = setTimeout(() => lost("The native audio host graph revision request timed out.", current), 2_000)
      pending = { deadline, reject, resolve: () => undefined, graphRevisionResolve: resolve }
      current.stdin.write(frame)
    })
  }
  const attachVst = async (input: ResolvedVst3Attachment, token?: string, owner?: symbol) => {
    const payload = serializeVstAttachment(input)
    if (!payload) throw new Error("The native VST attachment is invalid.")
    await supervisor.start()
    await send(vstAttachType, payload, owner ?? assertTransactionAccess(token))
  }
  const supervisor: NativeAudioHostSupervisor = {
    start() {
      if (suspended) {
        if (resumePromise) return resumePromise.then(() => supervisor.start())
        return Promise.reject(new Error("The native audio host is suspended."))
      }
      if (terminationFailure) return Promise.reject(terminationFailure)
      if (childTerminationPromise) return childTerminationPromise.then(() => supervisor.start())
      if (teardownPromise) return Promise.reject(new Error("The native audio host is tearing down."))
      if (hello) return Promise.resolve(hello)
      if (startPromise) return startPromise
      const generation = lifecycleGeneration
      let spawned: ChildProcessWithoutNullStreams | undefined
      const attempt = (async () => {
        if (childTerminationPromise) await childTerminationPromise
        await access(hostPath)
        if (generation !== lifecycleGeneration || teardownPromise) {
          throw new Error("The native audio host startup was cancelled.")
        }
        spawned = spawnHost(hostPath)
        child = spawned
        spawned.once("error", () => lost("The native audio host could not start.", spawned))
        spawned.once("close", (code, signal) => {
          console.error("[native-vst3] native audio host closed", { code, signal })
          if (teardownPromise && child === spawned) return
          lost("The native audio host stopped.", spawned)
        })
        spawned.stderr.on("data", (chunk: Buffer) => {
          console.error("[native-vst3] native audio host stderr", chunk.toString("utf8").trim())
        })
        spawned.stdout.on("data", (chunk: Buffer) => {
          if (child === spawned) decode(chunk)
        })
        await send(hostHelloType)
        if (child !== spawned || !hello) throw new Error("The native audio host did not complete its handshake.")
        return hello
      })()
      startPromise = attempt
      void attempt.then(
        () => {
          if (startPromise === attempt) startPromise = undefined
        },
        () => {
          if (startPromise === attempt) startPromise = undefined
          if (spawned && child === spawned) lost("The native audio host could not start.", spawned)
        },
      )
      return attempt
    },
    runTransaction(operation) {
      return enqueueTransaction(async () => {
        const generation = lifecycleGeneration
        await supervisor.start()
        if (generation !== lifecycleGeneration || teardownPromise) {
          throw new Error("The native audio host transaction was cancelled.")
        }
        if (transactionOwner) throw new Error("The native audio host transaction is unavailable.")
        const owner = Symbol("native-audio-host-transaction")
        transactionOwner = owner
        let transactionOpen = false
        try {
          await send(transactionBeginType, undefined, owner)
          transactionOpen = true
          const value = await operation({
            attachVst: (input) => attachVst(input, undefined, owner),
          })
          await send(transactionCommitType, undefined, owner)
          transactionOpen = false
          return value
        } catch (error) {
          if (transactionOpen) {
            try {
              await send(transactionRollbackType, undefined, owner)
            } catch {
              // The original transaction failure remains authoritative.
            }
          }
          throw error
        } finally {
          if (transactionOwner === owner) transactionOwner = undefined
        }
      })
    },
    async configure(input, transactionToken) {
      const payload = serializeDeviceConfiguration(input)
      if (!payload) throw new Error("The native audio host configuration is invalid.")
      await request(deviceConfigureType, payload, transactionToken)
    },
    async beginTransaction() {
      const invalidationVersion = manualTransactionInvalidationVersion
      return enqueueTransaction(async () => {
        if (invalidationVersion !== manualTransactionInvalidationVersion || transactionOwner) {
          throw new Error("The native audio host transaction is unavailable.")
        }
        const generation = lifecycleGeneration
        await supervisor.start()
        if (
          invalidationVersion !== manualTransactionInvalidationVersion
          || generation !== lifecycleGeneration
          || teardownPromise
          || suspended
        ) throw new Error("The native audio host transaction was cancelled.")
        const owner = Symbol("native-audio-host-manual-transaction")
        const token = randomBytes(32).toString("base64url")
        transactionOwner = owner
        manualTransactionToken = token
        manualTransactionGeneration = generation
        let nativeTransactionOpen = false
        try {
          await send(transactionBeginType, undefined, owner)
          nativeTransactionOpen = true
          if (
            invalidationVersion !== manualTransactionInvalidationVersion
            || generation !== lifecycleGeneration
            || transactionOwner !== owner
            || manualTransactionToken !== token
          ) throw new Error("The native audio host transaction was cancelled.")
          return token
        } catch (error) {
          if (nativeTransactionOpen) {
            try {
              await send(transactionRollbackType, undefined, owner)
            } catch {
              // A lost host may reject the best-effort cleanup.
            }
          }
          if (transactionOwner === owner && manualTransactionToken === token) {
            transactionOwner = undefined
            manualTransactionToken = undefined
            manualTransactionGeneration = -1
          }
          throw error
        }
      })
    },
    async invalidateManualTransaction() {
      manualTransactionInvalidationVersion += 1
      if (manualInvalidationPromise) return manualInvalidationPromise
      const owner = transactionOwner
      const token = manualTransactionToken
      if (!owner || !token) return
      const generation = manualTransactionGeneration
      manualTransactionToken = undefined
      manualTransactionGeneration = -1
      const operation = transactionTail.then(async () => {
        const current = child
        const shouldRollback = (
          generation === lifecycleGeneration
          && current !== undefined
          && hello !== undefined
          && !suspended
          && teardownPromise === undefined
          && transactionOwner === owner
        )
        try {
          if (shouldRollback) {
            try {
              await send(transactionRollbackType, undefined, owner)
            } catch {
              // Renderer loss must release local ownership even if rollback fails.
            }
          }
        } finally {
          if (transactionOwner === owner) transactionOwner = undefined
        }
      })
      manualInvalidationPromise = operation
      transactionTail = operation.then(() => undefined, () => undefined)
      void operation.then(
        () => {
          if (manualInvalidationPromise === operation) manualInvalidationPromise = undefined
        },
        () => {
          if (manualInvalidationPromise === operation) manualInvalidationPromise = undefined
        },
      )
      return operation
    },
    async commitTransaction(transactionToken) {
      const invalidationVersion = manualTransactionInvalidationVersion
      return enqueueTransaction(async () => {
        const owner = assertTransactionAccess(transactionToken)
        if (!owner) throw new Error("The native audio host transaction is unavailable.")
        try {
          await send(transactionCommitType, undefined, owner)
          if (
            invalidationVersion !== manualTransactionInvalidationVersion
            || manualTransactionToken !== transactionToken
            || manualTransactionGeneration !== lifecycleGeneration
          ) {
            try {
              await send(transactionRollbackType, undefined, owner)
            } catch {
              lost("The native audio host transaction was committed after renderer invalidation.")
            }
            throw new Error("The native audio host transaction was cancelled.")
          }
        } finally {
          if (transactionOwner === owner) {
            transactionOwner = undefined
            manualTransactionToken = undefined
            manualTransactionGeneration = -1
          }
        }
      })
    },
    async rollbackTransaction(transactionToken) {
      const invalidationVersion = manualTransactionInvalidationVersion
      return enqueueTransaction(async () => {
        const owner = assertTransactionAccess(transactionToken)
        if (!owner) throw new Error("The native audio host transaction is unavailable.")
        try {
          await send(transactionRollbackType, undefined, owner)
          if (
            invalidationVersion !== manualTransactionInvalidationVersion
            || manualTransactionToken !== transactionToken
            || manualTransactionGeneration !== lifecycleGeneration
          ) {
            throw new Error("The native audio host transaction was cancelled.")
          }
        } finally {
          if (transactionOwner === owner) {
            transactionOwner = undefined
            manualTransactionToken = undefined
            manualTransactionGeneration = -1
          }
        }
      })
    },
    async attachVst(input, transactionToken) {
      await attachVst(input, transactionToken)
    },
    async getVstState(instanceId, transactionToken, signal) {
      const payload = serializeVstDetach(instanceId)
      if (!payload) throw new Error("The native VST state request is invalid.")
      signal?.throwIfAborted()
      await supervisor.start()
      const current = child
      if (!current) throw new Error("The native audio host is unavailable.")
      signal?.throwIfAborted()
      const owner = assertTransactionAccess(transactionToken)
      if (owner) throw new Error("The native audio host transaction token is invalid.")
      let queued: QueuedSend | undefined
      const requestPromise = new Promise<{ bytes: Uint8Array; sha256: string }>((resolve, reject) => {
        if (normalSends.length >= 32) {
          reject(new Error("The native host request queue is full."))
          return
        }
        queued = {
          type: vstStateGetType,
          payload,
          allowDuringTeardown: false,
          resolve: () => undefined,
          reject,
          stateResolve: resolve,
          stateInstanceId: instanceId,
        }
        normalSends.push(queued)
        dispatchNext()
      })
      if (!signal) return requestPromise
      return new Promise((resolve, reject) => {
        const abort = () => {
          const abortError = new DOMException("Native VST state capture canceled.", "AbortError")
          const queuedIndex = queued ? normalSends.indexOf(queued) : -1
          if (queuedIndex >= 0) {
            normalSends.splice(queuedIndex, 1)
            queued?.reject(abortError)
            dispatchNext()
            reject(abortError)
            return
          }
          if (pending?.stateResolve && pending.stateInstanceId === instanceId) {
            pending.stateCancelled = true
            pending.reject(abortError)
          }
          reject(abortError)
        }
        signal.addEventListener("abort", abort, { once: true })
        requestPromise.then(
          (value) => {
            signal.removeEventListener("abort", abort)
            resolve(value)
          },
          (error: Error) => {
            signal.removeEventListener("abort", abort)
            reject(error)
          },
        )
      })
    },
    async detachVst(instanceId, transactionToken) {
      const payload = serializeVstDetach(instanceId)
      if (!payload) throw new Error("The native VST attachment is invalid.")
      await request(vstDetachType, payload, transactionToken)
    },
    async executeVstEditorCommand(input, transactionToken) {
      const payload = serializeVstEditor(input)
      if (!payload) throw new Error("The native VST editor command is invalid.")
      return requestEditor(payload, assertTransactionAccess(transactionToken))
    },
    async installAsset(input, transactionToken) {
      const payload = serializeAssetInstall(input)
      if (!payload) throw new Error("The native audio host asset is invalid.")
      await request(assetInstallType, payload, transactionToken)
    },
    async createMappedAsset(input, transactionToken) {
      const hash = input.contentHashPrefix ?? 0n
      if (
        !unsigned32(input.sessionAssetId) || input.sessionAssetId === 0
        || !Number.isSafeInteger(input.frameCount) || input.frameCount <= 0
        || !unsigned32(input.sampleRateHz) || input.sampleRateHz === 0
        || !unsigned32(input.channelCount) || input.channelCount === 0 || input.channelCount > maximumAssetChannels
        || hash < 0n || hash > 0xffff_ffff_ffff_ffffn
      ) throw new Error("The native mapped audio asset is invalid.")
      const payload = Buffer.alloc(28)
      payload.writeUInt32BE(input.sessionAssetId, 0)
      payload.writeBigUInt64BE(BigInt(input.frameCount), 4)
      payload.writeUInt32BE(input.sampleRateHz, 12)
      payload.writeUInt32BE(input.channelCount, 16)
      payload.writeBigUInt64BE(hash, 20)
      await request(mappedAssetCreateType, payload, transactionToken)
    },
    async writeMappedAssetPage(input, transactionToken) {
      if (
        !unsigned32(input.sessionAssetId) || input.sessionAssetId === 0
        || !Number.isSafeInteger(input.startFrame) || input.startFrame < 0
        || !unsigned32(input.frameCount) || input.frameCount === 0
        || input.planarPcm.byteLength === 0
        || input.planarPcm.byteLength > maximumPayloadBytes - 16
        || input.planarPcm.byteLength % (input.frameCount * 4) !== 0
      ) throw new Error("The native mapped audio page is invalid.")
      const payload = Buffer.alloc(16 + input.planarPcm.byteLength)
      payload.writeUInt32BE(input.sessionAssetId, 0)
      payload.writeBigUInt64BE(BigInt(input.startFrame), 4)
      payload.writeUInt32BE(input.frameCount, 12)
      payload.set(input.planarPcm, 16)
      await request(mappedAssetWritePageType, payload, transactionToken)
    },
    async prepareMappedAssetRange(sessionAssetId, startFrame, frameCount, transactionToken) {
      if (
        !unsigned32(sessionAssetId) || sessionAssetId === 0
        || !Number.isSafeInteger(startFrame) || startFrame < 0
        || !Number.isSafeInteger(frameCount) || frameCount <= 0
      ) throw new Error("The native mapped audio range is invalid.")
      const payload = Buffer.alloc(20)
      payload.writeUInt32BE(sessionAssetId, 0)
      payload.writeBigUInt64BE(BigInt(startFrame), 4)
      payload.writeBigUInt64BE(BigInt(frameCount), 12)
      await request(mappedAssetPrepareRangeType, payload, transactionToken)
    },
    async releaseMappedAsset(sessionAssetId, transactionToken) {
      if (!unsigned32(sessionAssetId) || sessionAssetId === 0) throw new Error("The native mapped audio asset is invalid.")
      await request(mappedAssetReleaseType, writeUnsigned32(sessionAssetId), transactionToken)
    },
    async releaseAsset(sessionAssetId, transactionToken) {
      if (!unsigned32(sessionAssetId) || sessionAssetId === 0) throw new Error("The native audio host asset is invalid.")
      await request(assetReleaseType, writeUnsigned32(sessionAssetId), transactionToken)
    },
    async publishGraph(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 13)
      if (!payload) throw new Error("The native audio host graph payload is invalid.")
      await request(graphSnapshotType, payload, transactionToken)
    },
    async configureInstrumentStates(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 4)
      if (!payload) throw new Error("The native audio host instrument state payload is invalid.")
      await request(instrumentStatesType, payload, transactionToken)
    },
    async prepareGraphRevision(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 13)
      if (!payload) throw new Error("The native audio host graph payload is invalid.")
      return requestGraphRevision(graphPrepareType, payload, transactionToken)
    },
    async publishGraphRevision(revision, transactionToken) {
      if (!unsigned32(revision) || revision === 0) throw new Error("The native audio host graph revision is invalid.")
      return requestGraphRevision(graphPublishType, writeUnsigned32(revision), transactionToken)
    },
    async rollbackGraphRevision(revision, transactionToken) {
      if (!unsigned32(revision) || revision === 0) throw new Error("The native audio host graph revision is invalid.")
      return requestGraphRevision(graphRollbackType, writeUnsigned32(revision), transactionToken)
    },
    async retireGraphRevision(revision, transactionToken) {
      if (!unsigned32(revision) || revision === 0) throw new Error("The native audio host graph revision is invalid.")
      return requestGraphRevision(graphRetireType, writeUnsigned32(revision), transactionToken)
    },
    async queueParameterEvents(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 4)
      if (!payload) throw new Error("The native audio host parameter payload is invalid.")
      await request(parameterEventsType, payload, transactionToken)
    },
    async queueProcessorStatePatch(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 56)
      if (!payload) throw new Error("The native audio host processor state patch is invalid.")
      await request(processorStatePatchType, payload, transactionToken)
    },
    async queueVstParameterEvents(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 8)
      if (!payload) throw new Error("The native VST parameter payload is invalid.")
      await request(vstParameterEventsType, payload, transactionToken)
    },
    async queueInstrumentEvents(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 4)
      if (!payload) throw new Error("The native audio host instrument payload is invalid.")
      await request(midiEventsType, payload, transactionToken)
    },
    async queueScheduleWindow(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 56)
      if (!payload) throw new Error("The native schedule window payload is invalid.")
      await request(scheduleWindowType, payload, transactionToken)
    },
    async reenableVstScheduleAutomation(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 8)
      if (!payload) throw new Error("The native VST schedule automation enable payload is invalid.")
      await request(vstScheduleAutomationEnableType, payload, transactionToken)
    },
    async queueSourceEvents(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 4)
      if (!payload) throw new Error("The native audio host source payload is invalid.")
      await request(sourceEventsType, payload, transactionToken)
    },
    async setTransport(input, transactionToken) {
      const transitionId = input.transitionId ?? (nextTransportTransitionId + 1n)
      if (transitionId > nextTransportTransitionId) nextTransportTransitionId = transitionId
      const payload = serializeTransport({...input, transitionId})
      if (!payload) throw new Error("The native audio host transport is invalid.")
      await request(transportType, payload, transactionToken)
    },
    async resolveOutputDevice(preferredDeviceId) {
      assertTransactionAccess(undefined)
      await supervisor.start()
      const current = child
      if (!current || pending || (preferredDeviceId !== undefined && !coreAudioDeviceId(preferredDeviceId))) {
        throw new Error("The native audio host device request is invalid.")
      }
      const payload = preferredDeviceId === undefined ? undefined : Buffer.from(preferredDeviceId, "utf8")
      const frame = encodeNativeAudioHostControlFrame(deviceListType, payload)
      if (!frame) throw new Error("The native audio host protocol is unavailable.")
      return new Promise<NativeOutputDevice | null>((resolve, reject) => {
        const deadline = setTimeout(() => lost("The native audio host device request timed out."), 2_000)
        pending = { deadline, reject, resolve: () => undefined, devicesResolve: resolve }
        current.stdin.write(frame)
      })
    },
    async resolveInputDevice(preferredDeviceId) {
      assertTransactionAccess(undefined)
      await supervisor.start()
      const current = child
      if (!current || pending || (preferredDeviceId !== undefined && !coreAudioDeviceId(preferredDeviceId))) {
        throw new Error("The native audio host input device request is invalid.")
      }
      const payload = preferredDeviceId === undefined ? undefined : Buffer.from(preferredDeviceId, "utf8")
      const frame = encodeNativeAudioHostControlFrame(recordingDeviceQueryType, payload)
      if (!frame) throw new Error("The native audio host protocol is unavailable.")
      return new Promise<NativeInputDevice | null>((resolve, reject) => {
        const deadline = setTimeout(() => lost("The native audio host input device request timed out."), 2_000)
        pending = { deadline, reject, resolve: () => undefined, inputDeviceResolve: resolve }
        current.stdin.write(frame)
      })
    },
    async startAudio() {
      await request(startType)
    },
    async startDiagnosticAudio() {
      await request(diagnosticStartType)
    },
    async stopAudio() {
      await request(stopType)
    },
    async diagnostics() {
      assertTransactionAccess(undefined)
      await supervisor.start()
      const current = child
      if (!current || pending) throw new Error("The native audio host is unavailable.")
      const frame = encodeNativeAudioHostControlFrame(diagnosticsType)
      if (!frame) throw new Error("The native audio host protocol is unavailable.")
      return new Promise<NativeHostDiagnostics>((resolve, reject) => {
        const deadline = setTimeout(() => lost("The native audio host diagnostics timed out."), 2_000)
        pending = {
          deadline,
          reject,
          resolve: () => undefined,
          diagnosticsResolve: resolve,
        }
        current.stdin.write(frame)
      })
    },
    async configureRecording(input) {
      const payload = serializeRecordingConfiguration(input)
      if (!payload) throw new Error("The native recording configuration is invalid.")
      await request(recordingConfigureType, payload)
    },
    async startRecording() {
      await request(recordingStartType)
    },
    async stopRecording(stopFrame) {
      if (stopFrame !== undefined && (!Number.isSafeInteger(stopFrame) || stopFrame < 0)) {
        throw new Error("The native recording stop frame is invalid.")
      }
      let payload: Buffer | undefined
      if (stopFrame !== undefined) {
        payload = Buffer.alloc(8)
        payload.writeBigInt64BE(BigInt(stopFrame))
      }
      await request(recordingStopType, payload)
    },
    async cancelRecording() {
      await request(recordingCancelType)
    },
    teardown() {
      if (teardownPromise) return teardownPromise
      lifecycleGeneration += 1
      lifecycleIntentVersion += 1
      const current = child
      const hadPending = pending !== undefined
      const termination = childTerminationPromise
      const stopping = (async () => {
        try {
          if (termination) await termination
          else if (hadPending) rejectPending(new Error("The native audio host is tearing down."))
          else if (current && hello && !transactionOwner) await send(teardownType, undefined, undefined, true)
        } finally {
          rejectPending(new Error("The native audio host is tearing down."))
          transactionOwner = undefined
          manualTransactionToken = undefined
          manualTransactionGeneration = -1
          if (child === current) child = undefined
          hello = undefined
          buffer = Buffer.alloc(0)
          current?.kill()
        }
      })()
      teardownPromise = stopping
      void stopping.then(
        () => {
          if (teardownPromise === stopping) teardownPromise = undefined
        },
        () => {
          if (teardownPromise === stopping) teardownPromise = undefined
        },
      )
      return stopping
    },
    suspend() {
      if (suspended && !resumePromise) return childTerminationPromise ?? (terminationFailure
        ? Promise.reject(terminationFailure)
        : Promise.resolve())
      suspended = true
      lifecycleIntentVersion += 1
      lifecycleGeneration += 1
      const current = child
      const error = new Error("The native audio host was suspended.")
      // Install the boundary before settling anything: rejected work must not
      // dispatch another pre-suspend command.
      child = undefined
      hello = undefined
      startPromise = undefined
      transactionOwner = undefined
      manualTransactionToken = undefined
      manualTransactionGeneration = -1
      nextTransportTransitionId = 0n
      buffer = Buffer.alloc(0)
      rejectPending(error, false)
      for (const queue of [urgentSends, normalSends, refillSends]) {
        while (queue.length > 0) queue.shift()?.reject(error)
      }
      if (current) {
        try {
          const frame = encodeNativeAudioHostControlFrame(teardownType)
          if (frame) current.stdin.write(frame)
        } catch {}
      }
      const termination = childTerminationPromise ?? (current ? terminateDetachedChild(current) : Promise.resolve())
      childTerminationPromise = termination
      void termination.then(
        () => {
          if (childTerminationPromise === termination) childTerminationPromise = undefined
        },
        () => {
          if (childTerminationPromise === termination) childTerminationPromise = undefined
        },
      )
      return termination
    },
    resume() {
      if (teardownPromise) return teardownPromise
      if (resumePromise) return resumePromise
      if (terminationFailure) return Promise.reject(terminationFailure)
      const requestedIntentVersion = lifecycleIntentVersion + 1
      lifecycleIntentVersion = requestedIntentVersion
      const termination = childTerminationPromise ?? Promise.resolve()
      const next = termination.then(() => {
        if (lifecycleIntentVersion === requestedIntentVersion) suspended = false
      })
      resumePromise = next
      void next.then(
        () => {
          if (resumePromise === next) resumePromise = undefined
        },
        () => {
          if (resumePromise === next) resumePromise = undefined
        },
      )
      return next
    },
    status: () => ({ running: child !== undefined && hello !== undefined, hello: hello ? hello : undefined }),
    transactionOpen: () => transactionOwner !== undefined,
    onLoss(listener) {
      lossListeners.add(listener)
      return () => lossListeners.delete(listener)
    },
    onRecordingBlock(listener) {
      recordingBlockListeners.add(listener)
      return () => recordingBlockListeners.delete(listener)
    },
    onRecordingStatus(listener) {
      recordingStatusListeners.add(listener)
      return () => recordingStatusListeners.delete(listener)
    },
    onMeterBatch(listener) {
      meterBatchListeners.add(listener)
      return () => meterBatchListeners.delete(listener)
    },
    async setSpectrumNode(nodeId) {
      const payload = Buffer.from(serializeNativeSpectrumSelection(nodeId))
      await request(spectrumSelectionType, payload)
    },
    onSpectrumFrame(listener) {
      spectrumFrameListeners.add(listener)
      return () => spectrumFrameListeners.delete(listener)
    },
    onScheduleProgress(listener) {
      scheduleProgressListeners.add(listener)
      return () => scheduleProgressListeners.delete(listener)
    },
    onWorkerNotification(listener) {
      workerNotificationListeners.add(listener)
      return () => workerNotificationListeners.delete(listener)
    },
  }
  return supervisor
}

export const probeNativeAudioOutputDevice = async (
  hostPath: string,
  preferredDeviceId?: string,
  createSupervisor: (hostPath: string) => NativeAudioHostSupervisor = createNativeAudioHostSupervisor,
): Promise<NativeOutputDevice | null> => {
  const probe = createSupervisor(hostPath)
  try {
    return await probe.resolveOutputDevice(preferredDeviceId)
  } finally {
    await probe.teardown().catch(() => undefined)
  }
}
