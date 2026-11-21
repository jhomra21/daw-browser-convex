import { sha256HexPattern, unsigned32Max, unsigned64Max } from "@daw-browser/desktop-protocol/wire-patterns"
import path from "node:path"
import {
  maxVst3EditorDimension,
  maxVst3PluginParameters,
  maxVst3WorkerChannels,
  maxVst3WorkerEventsPerBlock,
  maxVst3WorkerFrames,
  maxVst3WorkerStateBytes,
  maxVst3WorkerTransportSlots,
} from "@daw-browser/plugin-host-protocol"
import {
  nativeAudioHostAssetInstallHeaderBytes as assetInstallHeaderBytes,
  nativeAudioHostVstEditorCommands,
  nativeAudioHostMaximumAssetChannels as maximumAssetChannels,
  nativeAudioHostMaximumAssetFrames as maximumAssetFrames,
  nativeAudioHostMaximumAssetFramesForChannels as maximumAssetFramesForChannels,
  nativeAudioHostMaximumDeviceIdBytes as maximumDeviceIdBytes,
  nativeAudioHostMaximumPayloadBytes as maximumPayloadBytes,
  nativeAudioHostMaximumVstPathBytes as maximumVstPathBytes,
  nativeAudioHostMaximumVstStringBytes as maximumVstStringBytes,
  nativeAudioHostVstAttachFingerprintBytes as vstAttachFingerprintBytes,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type {
  NativeHostDeviceConfiguration,
  NativeHostRecordingConfiguration,
  NativeHostPcmAsset,
  NativeOfflineRenderPlan,
  NativeHostTransport,
} from "@daw-browser/audio-engine/native-host-wire"

export const unsigned32 = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= unsigned32Max

export const writeUnsigned32 = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)

  return bytes
}

const writeUnsigned64 = (value: bigint) => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(value)

  return bytes
}

export const serializeDeviceConfiguration = (input: NativeHostDeviceConfiguration) => {
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

export const serializeTransport = (input: NativeHostTransport) => {
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
      input.transitionId <= 0n || input.transitionId > unsigned64Max
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

export type NativeRecordingSpoolConfiguration = {
  rootPath: string
  rootDevice: bigint
  rootInode: bigint
  token: string
}

// Mirrors kHeaderBytes in native/audio-host-macos/src/main.cpp: the fixed fields, then the device UID and the root path.
const recordingConfigurationHeaderBytes = 152

export const serializeRecordingConfiguration = (input: NativeHostRecordingConfiguration, spool: NativeRecordingSpoolConfiguration) => {
  if (!spool || !sha256HexPattern.test(spool.token) || !path.isAbsolute(spool.rootPath)
    || spool.rootPath.includes("\0") || spool.rootDevice < 0n || spool.rootInode <= 0n
    || spool.rootDevice > unsigned64Max || spool.rootInode > unsigned64Max) return undefined
  const root = Buffer.from(spool.rootPath, "utf8")

  if (root.byteLength > 4096) return undefined
  const deviceUid = Buffer.from(input.deviceUid, "utf8")

  if (
    !unsigned32(input.generation) || input.generation === 0
    || input.sessionId <= 0n || input.sessionId > unsigned64Max
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
    || input.targetNodeId <= 0n || input.targetNodeId > unsigned64Max
  ) return undefined
  const output = Buffer.alloc(recordingConfigurationHeaderBytes + deviceUid.byteLength + root.byteLength)
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
  output.writeBigUInt64BE(spool.rootDevice, 60)
  output.writeBigUInt64BE(spool.rootInode, 68)
  output.set(Buffer.from(spool.token, "ascii"), 76)
  output.writeUInt32BE(root.byteLength, 140)
  output.writeBigUInt64BE(input.targetNodeId, 144)
  output.set(deviceUid, recordingConfigurationHeaderBytes)
  output.set(root, recordingConfigurationHeaderBytes + deviceUid.byteLength)

  return output
}

export const nativeBinaryPayload = (payload: Uint8Array, minimumBytes: number) => (
  payload.byteLength >= minimumBytes && payload.byteLength <= maximumPayloadBytes
    ? Buffer.from(payload)
    : undefined
)

export const serializeAssetInstall = (input: NativeHostPcmAsset) => {
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

const fingerprintBytes = (value: string) => sha256HexPattern.test(value) ? Buffer.from(value, "hex") : undefined

export const serializeVstAttachment = (input: ResolvedVst3Attachment) => {
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
    || !unsigned32(input.workerTransport.slotCount) || input.workerTransport.slotCount === 0 || input.workerTransport.slotCount > maxVst3WorkerTransportSlots
    || !unsigned32(input.workerTransport.maximumFrames) || input.workerTransport.maximumFrames === 0 || input.workerTransport.maximumFrames > maxVst3WorkerFrames
    || !unsigned32(input.workerTransport.inputChannels) || input.workerTransport.inputChannels > maxVst3WorkerChannels
    || (input.role === "instrument" && input.workerTransport.inputChannels !== 0)
    || (input.role === "effect" && input.workerTransport.inputChannels === 0)
    || !unsigned32(input.workerTransport.outputChannels) || input.workerTransport.outputChannels === 0 || input.workerTransport.outputChannels > maxVst3WorkerChannels
    || !unsigned32(input.workerTransport.maximumEventsPerBlock)
    || input.workerTransport.maximumEventsPerBlock === 0
    || input.workerTransport.maximumEventsPerBlock > maxVst3WorkerEventsPerBlock
    || (input.parameterIds?.length ?? 0) > maxVst3PluginParameters
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
    stateBytes.byteLength > maxVst3WorkerStateBytes
    || (stateBytes.byteLength === 0 && stateHash !== "" && !sha256HexPattern.test(stateHash))
    || (stateBytes.byteLength > 0 && !sha256HexPattern.test(stateHash))
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
    writeUnsigned32(input.sourceIndex ?? unsigned32Max),
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
    writeUnsigned32(input.declaredTailFrames ?? unsigned32Max),
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

// The host reads the id of every request that names an existing attachment with ReadNativeInstanceId: a little-endian length.
// Only the attach record, whose fields are all big-endian, carries its own id big-endian.
export const serializeVstInstanceId = (instanceId: string) => {
  const value = Buffer.from(instanceId, "utf8")

  if (value.byteLength === 0 || value.byteLength > maximumVstStringBytes) return undefined
  const length = Buffer.alloc(4)
  length.writeUInt32LE(value.byteLength)

  return Buffer.concat([length, value])
}

export const serializeVstEditor = (input: {
  instanceId: string
  command: NativeVstEditorCommand
  width?: number
  height?: number
  anchor?: NativeVstEditorAnchor
}) => {
  const instanceIdBytes = Buffer.from(input.instanceId, "utf8")
  const command = nativeAudioHostVstEditorCommands[input.command]
  const width = input.width ?? 0
  const height = input.height ?? 0
  const anchor = input.anchor
  const hasAnchor = anchor === undefined ? 0 : 1

  if (
    !command
    || instanceIdBytes.byteLength === 0
    || instanceIdBytes.byteLength > maximumVstStringBytes
    || !unsigned32(width) || width > maxVst3EditorDimension
    || !unsigned32(height) || height > maxVst3EditorDimension
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
  output.writeUInt32LE(instanceIdBytes.byteLength, 24)

  return Buffer.concat([output, instanceIdBytes])
}

export type NativeVstEditorCommand = "open" | "close" | "focus" | "resize" | "status"

export type NativeVstEditorAnchor = { x: number; y: number }

export const coreAudioDeviceId = (value: string): value is `coreaudio:${string}` => (
  value.startsWith("coreaudio:") && value.length > "coreaudio:".length
)

export const encodeOfflineConfigure = (plan: NativeOfflineRenderPlan) => {
  const output = Buffer.alloc(16)
  output.writeUInt32BE(plan.sampleRateHz, 0)
  output.writeUInt32BE(plan.blockFrames, 4)
  output.writeUInt32BE(plan.channelCount, 8)
  output.writeUInt32BE(1, 12)

  return output
}

export const encodeOfflineStart = (plan: NativeOfflineRenderPlan) => {
  const output = Buffer.alloc(16)
  output.writeBigUInt64BE(BigInt(plan.totalFrames), 0)
  output.writeUInt32BE(plan.blockFrames, 8)
  output.writeUInt32BE(plan.channelCount, 12)

  return output
}
