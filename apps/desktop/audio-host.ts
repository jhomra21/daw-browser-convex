import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { access } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { audioCoreWasmAbiVersion } from "@daw-browser/audio-core-wasm"
import { maxVst3WorkerEventsPerBlock } from "@daw-browser/plugin-host-protocol"
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
  nativeAudioHostMaximumDeviceIdBytes as maximumDeviceIdBytes,
  nativeAudioHostMaximumMeterEntries as maximumMeterEntries,
  nativeAudioHostMaximumPayloadBytes as maximumPayloadBytes,
  nativeAudioHostMaximumVstPathBytes as maximumVstPathBytes,
  nativeAudioHostMaximumVstStringBytes as maximumVstStringBytes,
  nativeAudioHostProtocolVersion as protocolVersion,
  nativeAudioHostVstAttachFingerprintBytes as vstAttachFingerprintBytes,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type {
  NativeHostDeviceConfiguration,
  NativeHostDiagnostics,
  NativeHostRecordingBlock,
  NativeHostRecordingConfiguration,
  NativeHostRecordingStatus,
  NativeHostMeterBatch,
  NativeScheduleProgress,
  NativeOutputDevice,
  NativeHostPcmAsset,
  NativeHostTransport,
  NativeInputDevice,
} from "@daw-browser/audio-engine/native-host-wire"

const {
  hostHello: hostHelloType,
  hostCapabilities: hostCapabilitiesType,
  deviceConfigure: deviceConfigureType,
  graphSnapshot: graphSnapshotType,
  assetInstall: assetInstallType,
  assetRelease: assetReleaseType,
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
  scheduleWindow: scheduleWindowType,
  scheduleProgress: scheduleProgressType,
  vstScheduleAutomationEnable: vstScheduleAutomationEnableType,
  instrumentStates: instrumentStatesType,
} = nativeAudioHostControlTypes
const requiredHostCapabilities = 0x000003ff
const nativeAudioHostArtifactId = "daw-audio-host-macos/v3"

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
    || (input.transitionId !== undefined && (
      input.transitionId <= 0n || input.transitionId > 0xffff_ffff_ffff_ffffn
    ))) return undefined
  const output = Buffer.alloc(24)
  output.writeUInt32BE(input.epoch)
  output[4] = input.running ? 1 : 0
  output.writeBigInt64BE(BigInt(input.frame), 8)
  output.writeBigUInt64BE(input.transitionId ?? 1n, 16)
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
    || expectedPcmBytes > maximumPayloadBytes - assetInstallHeaderBytes
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
  chainIndex: number
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
  transportLatencyFrames: number
  workerTransport: {
    slotCount: number
    maximumFrames: number
    inputChannels: number
    outputChannels: number
    maximumEventsPerBlock: number
  }
  renderEnabled?: boolean
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
    || !unsigned32(input.chainIndex) || input.chainIndex > 0x7fff_ffff
    || (input.role !== "effect" && input.role !== "instrument")
    || (input.inputLayout !== "none" && input.inputLayout !== "mono" && input.inputLayout !== "stereo")
    || (input.role === "instrument" && input.inputLayout !== "none")
    || (input.role === "effect" && input.inputLayout === "none")
    || (input.outputLayout !== "mono" && input.outputLayout !== "stereo")
    || !unsigned32(input.declaredLatencyFrames)
    || !unsigned32(input.transportLatencyFrames)
    || !unsigned32(input.workerTransport.slotCount) || input.workerTransport.slotCount === 0 || input.workerTransport.slotCount > 8
    || !unsigned32(input.workerTransport.maximumFrames) || input.workerTransport.maximumFrames === 0 || input.workerTransport.maximumFrames > 8_192
    || !unsigned32(input.workerTransport.inputChannels) || input.workerTransport.inputChannels > 64
    || (input.role === "instrument" && input.workerTransport.inputChannels !== 0)
    || (input.role === "effect" && input.workerTransport.inputChannels === 0)
    || !unsigned32(input.workerTransport.outputChannels) || input.workerTransport.outputChannels === 0 || input.workerTransport.outputChannels > 64
    || !unsigned32(input.workerTransport.maximumEventsPerBlock)
    || input.workerTransport.maximumEventsPerBlock === 0
    || input.workerTransport.maximumEventsPerBlock > maxVst3WorkerEventsPerBlock
  ) return undefined
  const bundleFingerprint = fingerprintBytes(input.bundleFingerprint)
  const binaryFingerprint = fingerprintBytes(input.binaryFingerprint)
  if (!bundleFingerprint || !binaryFingerprint || bundleFingerprint.byteLength !== vstAttachFingerprintBytes || binaryFingerprint.byteLength !== vstAttachFingerprintBytes) {
    return undefined
  }
  const encodedStrings = [...strings, input.canonicalBundlePath, input.canonicalExecutablePath].map((value) => Buffer.from(value, "utf8"))
  return Buffer.concat([
    ...encodedStrings.flatMap((value) => [writeUnsigned32(value.byteLength), value]),
    writeUnsigned32(input.chainIndex),
    writeUnsigned64(input.graphNodeId),
    Buffer.from([1]),
    bundleFingerprint,
    binaryFingerprint,
    writeUnsigned32(input.scannerProtocolVersion),
    Buffer.from([
      input.role === "effect" ? 1 : 2,
      input.inputLayout === "none" ? 0 : input.inputLayout === "mono" ? 1 : 2,
      input.outputLayout === "mono" ? 1 : 2,
      input.renderEnabled === true ? 1 : 0,
    ]),
    writeUnsigned32(input.declaredLatencyFrames),
    writeUnsigned32(input.transportLatencyFrames),
    writeUnsigned32(input.workerTransport.slotCount),
    writeUnsigned32(input.workerTransport.maximumFrames),
    writeUnsigned32(input.workerTransport.inputChannels),
    writeUnsigned32(input.workerTransport.outputChannels),
    writeUnsigned32(input.workerTransport.maximumEventsPerBlock),
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
  requestedRevision: number
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
    kind: "latency" | "buses" | "restart" | "fault" | "miss" | "editor-interaction"
    value: number
  })
  | (NativeWorkerNotificationBase & {
    kind: "parameter-edit"
    parameterId: number
    normalizedValue: number
  })

export type NativeVstEditorCommand = "open" | "close" | "focus" | "resize" | "status"
export type NativeVstEditorAnchor = { x: number; y: number }
export const nativeVstEditorOwnershipProbe = (instanceId: string): {
  instanceId: string
  command: "status"
} => ({
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
}

type NativeHostRequestType =
  | typeof hostHelloType
  | typeof deviceConfigureType
  | typeof assetInstallType
  | typeof assetReleaseType
  | typeof startType
  | typeof stopType
  | typeof teardownType
  | typeof graphSnapshotType
  | typeof transportType
  | typeof parameterEventsType
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

const coreAudioDeviceId = (value: string): value is `coreaudio:${string}` => (
  value.startsWith("coreaudio:") && value.length > "coreaudio:".length
)
const nativeVstInstanceId = (value: string): boolean => (
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
)

export class NativeAudioHostCommandError extends Error {
  readonly requestType: number
  readonly recoverable = true

  constructor(requestType: number) {
    super(`The native audio host rejected control request ${requestType}.`)
    this.name = "NativeAudioHostCommandError"
    this.requestType = requestType
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
}

type SpawnHost = (hostPath: string) => ChildProcessWithoutNullStreams

export type NativeAudioHostSupervisor = {
  start(): Promise<AudioHostHello>
  runTransaction<T>(operation: (transaction: Pick<NativeAudioHostSupervisor, "attachVst">) => Promise<T>): Promise<T>
  configure(input: NativeHostDeviceConfiguration, transactionToken?: string): Promise<void>
  beginTransaction(): Promise<string>
  commitTransaction(transactionToken: string): Promise<void>
  rollbackTransaction(transactionToken: string): Promise<void>
  attachVst(input: ResolvedVst3Attachment, transactionToken?: string): Promise<void>
  detachVst(instanceId: string, transactionToken?: string): Promise<void>
  executeVstEditorCommand(input: { instanceId: string; command: NativeVstEditorCommand; width?: number; height?: number; anchor?: NativeVstEditorAnchor }, transactionToken?: string): Promise<NativeVstEditorStatus>
  installAsset(input: NativeHostPcmAsset, transactionToken?: string): Promise<void>
  releaseAsset(sessionAssetId: number, transactionToken?: string): Promise<void>
  publishGraph(bytes: Uint8Array, transactionToken?: string): Promise<void>
  configureInstrumentStates(bytes: Uint8Array, transactionToken?: string): Promise<void>
  prepareGraphRevision(bytes: Uint8Array, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  publishGraphRevision(revision: number, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  rollbackGraphRevision(revision: number, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  retireGraphRevision(revision: number, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  queueParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<void>
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
  queueScheduleWindow(bytes: Uint8Array, transactionToken?: string): Promise<void>
  reenableVstScheduleAutomation(bytes: Uint8Array, transactionToken?: string): Promise<void>
  onScheduleProgress(listener: (progress: NativeScheduleProgress) => void): () => void
  onWorkerNotification(listener: (notification: NativeWorkerNotification) => void): () => void
}

export const createNativeAudioHostSupervisor = (
  hostPath: string,
  spawnHost: SpawnHost = (executable) => spawn(executable, [], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] }),
): NativeAudioHostSupervisor => {
  let child: ChildProcessWithoutNullStreams | undefined
  let hello: AudioHostHello | undefined
  let buffer = Buffer.alloc(0)
  let pending: PendingControl | undefined
  let startPromise: Promise<AudioHostHello> | undefined
  let teardownPromise: Promise<void> | undefined
  let lifecycleGeneration = 0
  let transactionTail = Promise.resolve()
  let transactionOwner: symbol | undefined
  let manualTransactionToken: string | undefined
  let manualTransactionGeneration = 0
  let nextTransportTransitionId = 0n
  const lossListeners = new Set<(error: Error) => void>()
  const recordingBlockListeners = new Set<(block: NativeHostRecordingBlock) => void>()
  const recordingStatusListeners = new Set<(status: NativeHostRecordingStatus) => void>()
  const meterBatchListeners = new Set<(batch: NativeHostMeterBatch) => void>()
  const scheduleProgressListeners = new Set<(progress: NativeScheduleProgress) => void>()
  const workerNotificationListeners = new Set<(notification: NativeWorkerNotification) => void>()
  type QueuedSend = {
    type: NativeHostRequestType
    payload?: Buffer
    owner?: symbol
    allowDuringTeardown: boolean
    resolve: () => void
    reject: (error: Error) => void
  }
  const urgentSends: QueuedSend[] = []
  const normalSends: QueuedSend[] = []
  const refillSends: QueuedSend[] = []
  let dispatchNext: () => void = () => {}
  const rejectPending = (error: Error) => {
    const current = pending
    pending = undefined
    if (current) {
      clearTimeout(current.deadline)
      current.reject(error)
    }
    dispatchNext()
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
  const decodeGraphRevisionStatus = (frame: Buffer): NativeGraphRevisionStatus | undefined => {
    if (frame.byteLength !== headerBytes + 28) return undefined
    const code = frame.readUInt32BE(headerBytes)
    const status = code === 1 ? "prepared"
      : code === 2 ? "published"
      : code === 3 ? "retired"
      : code === 4 ? "rolled-back"
      : code === 5 ? "stale-revision"
      : code === 6 ? "invalid-revision"
      : code === 7 ? "prepare-failed"
      : code === 8 ? "publish-failed"
      : code === 9 ? "retirement-not-safe"
      : undefined
    if (!status) return undefined
    return {
      status,
      requestedRevision: frame.readUInt32BE(headerBytes + 4),
      activeRevision: frame.readUInt32BE(headerBytes + 8),
      preparedRevision: frame.readUInt32BE(headerBytes + 12),
      retiredRevision: frame.readUInt32BE(headerBytes + 16),
      renderEpoch: frame.readBigUInt64BE(headerBytes + 20),
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
  const decodeScheduleProgress = (frame: Buffer): NativeScheduleProgress | undefined => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength !== 72) return undefined
    const revision = payload.readUInt32BE(0)
    const epoch = payload.readUInt32BE(4)
    const progressSequence = payload.readBigUInt64BE(8)
    if (revision === 0 || epoch === 0 || progressSequence === 0n) return undefined
    const flags = payload.readUInt32BE(56)
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
      running: (flags & 1) !== 0,
      scheduleComplete: (flags & 2) !== 0,
      instrumentCredits: payload.readUInt32BE(60),
      sourceCredits: payload.readUInt32BE(64),
      automationCredits: payload.readUInt32BE(68),
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
        && frame.readUInt32BE(headerBytes) === pending.expectedAckType
      ) {
        const current = pending
        const accepted = frame.readUInt32BE(headerBytes + 4)
        if (accepted !== 0 && accepted !== 1) return lost("The native audio host returned an invalid control acknowledgement.")
        clearTimeout(current.deadline)
        pending = undefined
        dispatchNext()
        if (accepted === 1) current.resolve()
        else current.reject(new NativeAudioHostCommandError(frame.readUInt32BE(headerBytes)))
      } else return lost("The native audio host rejected a control request.")
    }
  }
  dispatchNext = () => {
    if (pending || !child) return
    const next = urgentSends.shift() ?? refillSends.shift() ?? normalSends.shift()
    if (!next) return
    if ((teardownPromise && !next.allowDuringTeardown)
      || (typeof transactionOwner === "symbol" && transactionOwner !== next.owner)) {
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
    pending = { resolve: next.resolve, reject: next.reject, deadline, expectedAckType: next.type }
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
    if (!child || (teardownPromise && !allowDuringTeardown)
      || (typeof transactionOwner === "symbol" && transactionOwner !== owner)) {
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
  const request = async (type: NativeHostRequestType, payload?: Buffer, token?: string) => {
    await supervisor.start()
    await send(type, payload, assertTransactionAccess(token))
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
      if (teardownPromise) return Promise.reject(new Error("The native audio host is tearing down."))
      if (hello) return Promise.resolve(hello)
      if (startPromise) return startPromise
      const generation = lifecycleGeneration
      let spawned: ChildProcessWithoutNullStreams | undefined
      const attempt = (async () => {
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
      const result = transactionTail.then(async () => {
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
      transactionTail = result.then(() => undefined, () => undefined)
      return result
    },
    async configure(input, transactionToken) {
      const payload = serializeDeviceConfiguration(input)
      if (!payload) throw new Error("The native audio host configuration is invalid.")
      await request(deviceConfigureType, payload, transactionToken)
    },
    async beginTransaction() {
      if (transactionOwner) throw new Error("The native audio host transaction is unavailable.")
      await supervisor.start()
      const owner = Symbol("native-audio-host-manual-transaction")
      const token = randomBytes(32).toString("base64url")
      transactionOwner = owner
      manualTransactionToken = token
      manualTransactionGeneration = lifecycleGeneration
      try {
        await send(transactionBeginType, undefined, owner)
        return token
      } catch (error) {
        if (transactionOwner === owner) {
          transactionOwner = undefined
          manualTransactionToken = undefined
          manualTransactionGeneration = -1
        }
        throw error
      }
    },
    async commitTransaction(transactionToken) {
      const owner = assertTransactionAccess(transactionToken)
      if (!owner) throw new Error("The native audio host transaction is unavailable.")
      try {
        await send(transactionCommitType, undefined, owner)
      } finally {
        if (transactionOwner === owner) {
          transactionOwner = undefined
          manualTransactionToken = undefined
          manualTransactionGeneration = -1
        }
      }
    },
    async rollbackTransaction(transactionToken) {
      const owner = assertTransactionAccess(transactionToken)
      if (!owner) throw new Error("The native audio host transaction is unavailable.")
      try {
        await send(transactionRollbackType, undefined, owner)
      } finally {
        if (transactionOwner === owner) {
          transactionOwner = undefined
          manualTransactionToken = undefined
          manualTransactionGeneration = -1
        }
      }
    },
    async attachVst(input, transactionToken) {
      await attachVst(input, transactionToken)
    },
    async detachVst(instanceId, transactionToken) {
      const payload = serializeVstDetach(instanceId)
      if (!payload) throw new Error("The native VST attachment is invalid.")
      await request(vstDetachType, payload, transactionToken)
    },
    async executeVstEditorCommand(input, transactionToken) {
      const payload = serializeVstEditor(input)
      if (!payload) throw new Error("The native VST editor command is invalid.")
      assertTransactionAccess(transactionToken)
      await supervisor.start()
      const current = child
      if (!current || pending) throw new Error("The native audio host is unavailable.")
      const frame = encodeNativeAudioHostControlFrame(vstEditorType, payload)
      if (!frame) throw new Error("The native audio host protocol is unavailable.")
      return new Promise<NativeVstEditorStatus>((resolve, reject) => {
        const deadline = setTimeout(() => lost("The native VST editor command timed out.", current), 2_000)
        pending = { deadline, reject, resolve: () => undefined, editorResolve: resolve }
        current.stdin.write(frame)
      })
    },
    async installAsset(input, transactionToken) {
      const payload = serializeAssetInstall(input)
      if (!payload) throw new Error("The native audio host asset is invalid.")
      await request(assetInstallType, payload, transactionToken)
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
      const current = child
      const hadPending = pending !== undefined
      const stopping = (async () => {
        try {
          if (hadPending) rejectPending(new Error("The native audio host is tearing down."))
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
    status: () => ({ running: child !== undefined && hello !== undefined, ...(hello ? { hello } : {}) }),
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
