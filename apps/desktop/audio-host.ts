import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { access } from "node:fs/promises"
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
} = nativeAudioHostControlTypes
const requiredHostCapabilities = 0x000001ff
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
  if (!unsigned32(input.epoch) || !Number.isSafeInteger(input.frame)) return undefined
  const output = Buffer.alloc(16)
  output.writeUInt32BE(input.epoch)
  output[4] = input.running ? 1 : 0
  output.writeBigInt64BE(BigInt(input.frame), 8)
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
  instanceId: string
  classId: string
  vendorId: string
  canonicalBundlePath: string
  canonicalExecutablePath: string
  bundleFingerprint: string
  binaryFingerprint: string
  scannerProtocolVersion: 2
  role: "effect" | "instrument"
  inputLayout: "mono" | "stereo"
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
    || (input.role !== "effect" && input.role !== "instrument")
    || (input.inputLayout !== "mono" && input.inputLayout !== "stereo")
    || (input.outputLayout !== "mono" && input.outputLayout !== "stereo")
    || !unsigned32(input.declaredLatencyFrames)
    || !unsigned32(input.transportLatencyFrames)
    || !unsigned32(input.workerTransport.slotCount) || input.workerTransport.slotCount === 0 || input.workerTransport.slotCount > 8
    || !unsigned32(input.workerTransport.maximumFrames) || input.workerTransport.maximumFrames === 0 || input.workerTransport.maximumFrames > 8_192
    || !unsigned32(input.workerTransport.inputChannels) || input.workerTransport.inputChannels === 0 || input.workerTransport.inputChannels > 64
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
    writeUnsigned64(input.graphNodeId),
    Buffer.from([1]),
    bundleFingerprint,
    binaryFingerprint,
    writeUnsigned32(input.scannerProtocolVersion),
    Buffer.from([
      input.role === "effect" ? 1 : 2,
      input.inputLayout === "mono" ? 1 : 2,
      input.outputLayout === "mono" ? 1 : 2,
      // Attachment and preflight are proven, but real plug-in PCM execution is
      // not. Keep the native worker render hook disabled until an in-repo VST3
      // fixture proves the production path end to end.
      0,
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

export type NativeWorkerNotification = {
  kind: "latency" | "buses" | "restart" | "fault" | "miss"
  graphRevision: number
  graphNodeId: bigint
  instanceId: string
  value: number
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

const coreAudioDeviceId = (value: string): value is `coreaudio:${string}` => (
  value.startsWith("coreaudio:") && value.length > "coreaudio:".length
)

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
}

type SpawnHost = (hostPath: string) => ChildProcessWithoutNullStreams

export type NativeAudioHostSupervisor = {
  start(): Promise<AudioHostHello>
  runTransaction<T>(operation: (transaction: Pick<NativeAudioHostSupervisor, "attachVst">) => Promise<T>): Promise<T>
  configure(input: NativeHostDeviceConfiguration): Promise<void>
  beginTransaction(): Promise<void>
  commitTransaction(): Promise<void>
  rollbackTransaction(): Promise<void>
  attachVst(input: ResolvedVst3Attachment): Promise<void>
  detachVst(instanceId: string): Promise<void>
  installAsset(input: NativeHostPcmAsset): Promise<void>
  releaseAsset(sessionAssetId: number): Promise<void>
  publishGraph(bytes: Uint8Array): Promise<void>
  prepareGraphRevision(bytes: Uint8Array): Promise<NativeGraphRevisionStatus>
  publishGraphRevision(revision: number): Promise<NativeGraphRevisionStatus>
  rollbackGraphRevision(revision: number): Promise<NativeGraphRevisionStatus>
  retireGraphRevision(revision: number): Promise<NativeGraphRevisionStatus>
  queueParameterEvents(bytes: Uint8Array): Promise<void>
  queueInstrumentEvents(bytes: Uint8Array): Promise<void>
  queueSourceEvents(bytes: Uint8Array): Promise<void>
  setTransport(input: NativeHostTransport): Promise<void>
  resolveOutputDevice(preferredDeviceId?: string): Promise<NativeOutputDevice | null>
  resolveInputDevice(preferredDeviceId?: string): Promise<NativeInputDevice | null>
  startAudio(): Promise<void>
  stopAudio(): Promise<void>
  diagnostics(): Promise<NativeHostDiagnostics>
  configureRecording(input: NativeHostRecordingConfiguration): Promise<void>
  startRecording(): Promise<void>
  stopRecording(stopFrame?: number): Promise<void>
  cancelRecording(): Promise<void>
  teardown(): Promise<void>
  status(): { running: boolean; hello?: AudioHostHello }
  onLoss(listener: (error: Error) => void): () => void
  onRecordingBlock(listener: (block: NativeHostRecordingBlock) => void): () => void
  onRecordingStatus(listener: (status: NativeHostRecordingStatus) => void): () => void
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
  let transactionOwner: symbol | "manual" | undefined
  const lossListeners = new Set<(error: Error) => void>()
  const recordingBlockListeners = new Set<(block: NativeHostRecordingBlock) => void>()
  const recordingStatusListeners = new Set<(status: NativeHostRecordingStatus) => void>()
  const workerNotificationListeners = new Set<(notification: NativeWorkerNotification) => void>()
  const rejectPending = (error: Error) => {
    const current = pending
    pending = undefined
    if (current) {
      clearTimeout(current.deadline)
      current.reject(error)
    }
  }
  const lost = (message: string, source = child) => {
    if (!source || child !== source) return
    const error = new Error(message)
    rejectPending(error)
    child = undefined
    hello = undefined
    startPromise = undefined
    transactionOwner = undefined
    buffer = Buffer.alloc(0)
    const currentChild = source
    currentChild?.kill()
    for (const listener of lossListeners) listener(error)
  }
  const decodeDiagnostics = (frame: Buffer): NativeHostDiagnostics | undefined => {
    if (frame.byteLength !== headerBytes + 40) return undefined
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
  const decodeWorkerNotification = (frame: Buffer): NativeWorkerNotification | undefined => {
    const payload = frame.subarray(headerBytes)
    if (payload.byteLength < 24) return undefined
    const kindValue = payload.readUInt32BE(0)
    const kind = kindValue === 1 ? "latency"
      : kindValue === 2 ? "buses"
      : kindValue === 3 ? "restart"
      : kindValue === 4 ? "fault"
      : kindValue === 5 ? "miss"
      : undefined
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
      } else if (frame.readUInt32BE(8) === diagnosticsType && pending?.diagnosticsResolve) {
        const resolve = pending.diagnosticsResolve
        const diagnostic = decodeDiagnostics(frame)
        if (!diagnostic) return lost("The native audio host returned an invalid diagnostics response.")
        clearTimeout(pending.deadline)
        pending = undefined
        resolve(diagnostic)
      } else if (frame.readUInt32BE(8) === deviceListType && pending?.devicesResolve) {
        const resolve = pending.devicesResolve
        const device = decodeOutputDevice(frame)
        if (device === undefined) return lost("The native audio host returned an invalid device response.")
        clearTimeout(pending.deadline)
        pending = undefined
        resolve(device)
      } else if (frame.readUInt32BE(8) === recordingDeviceListType && pending?.inputDeviceResolve) {
        const resolve = pending.inputDeviceResolve
        const device = decodeInputDevice(frame)
        if (device === undefined) return lost("The native audio host returned an invalid input device response.")
        clearTimeout(pending.deadline)
        pending = undefined
        resolve(device)
      } else if (frame.readUInt32BE(8) === graphRevisionStatusType && pending?.graphRevisionResolve) {
        const resolve = pending.graphRevisionResolve
        const status = decodeGraphRevisionStatus(frame)
        if (!status) return lost("The native audio host returned an invalid graph revision status.")
        clearTimeout(pending.deadline)
        pending = undefined
        resolve(status)
      } else if (
        frame.readUInt32BE(8) === ackType
        && frame.byteLength === headerBytes + 8
        && pending
        && frame.readUInt32BE(headerBytes) === pending.expectedAckType
        && frame.readUInt32BE(headerBytes + 4) === 1
      ) {
        if (pending) {
          clearTimeout(pending.deadline)
          pending.resolve()
        }
        pending = undefined
      } else return lost("The native audio host rejected a control request.")
    }
  }
  const send = (
    type: NativeHostRequestType,
    payload?: Buffer,
    owner?: symbol,
    allowDuringTeardown = false,
  ) => new Promise<void>((resolve, reject) => {
    if (
      !child || pending || (teardownPromise && !allowDuringTeardown)
      || (typeof transactionOwner === "symbol" && transactionOwner !== owner)
    ) return reject(new Error("The native audio host is unavailable."))
    const frame = encodeNativeAudioHostControlFrame(type, payload)
    if (!frame) return reject(new Error("The native audio host protocol is unavailable."))
    // A host control request owns exactly one bounded in-flight slot; the
    // deadline prevents a silent child from retaining that slot indefinitely.
    const current = child
    const deadline = setTimeout(() => lost("The native audio host control request timed out.", current), 2_000)
    pending = { resolve, reject, deadline, expectedAckType: type }
    child.stdin.write(frame)
  })
  const request = async (type: NativeHostRequestType, payload?: Buffer) => {
    await supervisor.start()
    await send(type, payload)
  }
  const requestGraphRevision = async (type: NativeHostRequestType, payload: Buffer) => {
    await supervisor.start()
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
  const attachVst = async (input: ResolvedVst3Attachment, owner?: symbol) => {
    const payload = serializeVstAttachment(input)
    if (!payload) throw new Error("The native VST attachment is invalid.")
    await supervisor.start()
    await send(vstAttachType, payload, owner)
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
        spawned.once("close", () => {
          if (teardownPromise && child === spawned) return
          lost("The native audio host stopped.", spawned)
        })
        spawned.stderr.resume()
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
            attachVst: (input) => attachVst(input, owner),
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
    async configure(input) {
      const payload = serializeDeviceConfiguration(input)
      if (!payload) throw new Error("The native audio host configuration is invalid.")
      await request(deviceConfigureType, payload)
    },
    async beginTransaction() {
      if (transactionOwner) throw new Error("The native audio host transaction is unavailable.")
      await request(transactionBeginType)
      transactionOwner = "manual"
    },
    async commitTransaction() {
      if (transactionOwner !== "manual") throw new Error("The native audio host transaction is unavailable.")
      try {
        await request(transactionCommitType)
      } finally {
        transactionOwner = undefined
      }
    },
    async rollbackTransaction() {
      if (transactionOwner !== "manual") throw new Error("The native audio host transaction is unavailable.")
      try {
        await request(transactionRollbackType)
      } finally {
        transactionOwner = undefined
      }
    },
    async attachVst(input) {
      await attachVst(input)
    },
    async detachVst(instanceId) {
      const payload = serializeVstDetach(instanceId)
      if (!payload) throw new Error("The native VST attachment is invalid.")
      await request(vstDetachType, payload)
    },
    async installAsset(input) {
      const payload = serializeAssetInstall(input)
      if (!payload) throw new Error("The native audio host asset is invalid.")
      await request(assetInstallType, payload)
    },
    async releaseAsset(sessionAssetId) {
      if (!unsigned32(sessionAssetId) || sessionAssetId === 0) throw new Error("The native audio host asset is invalid.")
      await request(assetReleaseType, writeUnsigned32(sessionAssetId))
    },
    async publishGraph(bytes) {
      const payload = nativeBinaryPayload(bytes, 13)
      if (!payload) throw new Error("The native audio host graph payload is invalid.")
      await request(graphSnapshotType, payload)
    },
    async prepareGraphRevision(bytes) {
      const payload = nativeBinaryPayload(bytes, 13)
      if (!payload) throw new Error("The native audio host graph payload is invalid.")
      return requestGraphRevision(graphPrepareType, payload)
    },
    async publishGraphRevision(revision) {
      if (!unsigned32(revision) || revision === 0) throw new Error("The native audio host graph revision is invalid.")
      return requestGraphRevision(graphPublishType, writeUnsigned32(revision))
    },
    async rollbackGraphRevision(revision) {
      if (!unsigned32(revision) || revision === 0) throw new Error("The native audio host graph revision is invalid.")
      return requestGraphRevision(graphRollbackType, writeUnsigned32(revision))
    },
    async retireGraphRevision(revision) {
      if (!unsigned32(revision) || revision === 0) throw new Error("The native audio host graph revision is invalid.")
      return requestGraphRevision(graphRetireType, writeUnsigned32(revision))
    },
    async queueParameterEvents(bytes) {
      const payload = nativeBinaryPayload(bytes, 4)
      if (!payload) throw new Error("The native audio host parameter payload is invalid.")
      await request(parameterEventsType, payload)
    },
    async queueInstrumentEvents(bytes) {
      const payload = nativeBinaryPayload(bytes, 4)
      if (!payload) throw new Error("The native audio host instrument payload is invalid.")
      await request(midiEventsType, payload)
    },
    async queueSourceEvents(bytes) {
      const payload = nativeBinaryPayload(bytes, 4)
      if (!payload) throw new Error("The native audio host source payload is invalid.")
      await request(sourceEventsType, payload)
    },
    async setTransport(input) {
      const payload = serializeTransport(input)
      if (!payload) throw new Error("The native audio host transport is invalid.")
      await request(transportType, payload)
    },
    async resolveOutputDevice(preferredDeviceId) {
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
    async stopAudio() {
      await request(stopType)
    },
    async diagnostics() {
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
    onWorkerNotification(listener) {
      workerNotificationListeners.add(listener)
      return () => workerNotificationListeners.delete(listener)
    },
  }
  return supervisor
}
