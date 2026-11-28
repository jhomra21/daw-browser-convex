import { unsigned32Max } from "@daw-browser/desktop-protocol/wire-patterns"
import { audioCoreWasmAbiVersion } from "@daw-browser/audio-core-wasm"
import { maxVst3WorkerEventsPerBlock } from "@daw-browser/plugin-host-protocol"
import {
  portableGraphContractHash,
  processorContractHash,
} from "@daw-browser/audio-core-contract/generated"
import {
  nativeAudioHostFrameHeaderBytes as headerBytes,
  nativeAudioHostMagic as magic,
  nativeAudioHostMaximumMeterEntries as maximumMeterEntries,
  nativeAudioHostMaximumVstStringBytes as maximumVstStringBytes,
  nativeAudioHostProtocolVersion as protocolVersion,
  nativeAudioHostArtifactId,
  nativeAudioHostCodeName,
  nativeAudioHostControlTypes,
  nativeAudioHostCpuLoadPayloadBytes,
  nativeAudioHostCpuLoadSchema,
  nativeAudioHostLifecycleStates,
  nativeAudioHostMaximumSpectrumBins as maximumSpectrumBins,
  nativeAudioHostNotificationKinds,
  nativeAudioHostPatchOutcomes,
  nativeAudioHostPatchRefusals,
  nativeAudioHostProcessorPatchStatusBytes,
  nativeAudioHostReadinessReasons,
  nativeAudioHostRequiredCapabilities,
  nativeAudioHostRevisionContinuities,
  nativeAudioHostRevisionStatusCodes,
  nativeAudioHostScheduleProgressBytes,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeAudioHostCpuLoad, NativeAudioHostParkingLimits } from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeGraphRevisionStatus } from "@daw-browser/desktop-protocol/native-revision"
import type {
  NativeAudioDevice,
  NativeHostDiagnostics,
  NativeHostMeterBatch,
  NativeHostRecordingStatus,
  NativeHostSpectrumFrame,
  NativeInputDevice,
  NativeOutputDevice,
  NativeProcessorPatchStatus,
  NativeScheduleProgress,
} from "@daw-browser/audio-engine/native-host-wire"
import { readDiagnosticInstanceId } from "./diagnostic-instance-id"
import { coreAudioDeviceId } from "./native-host-frame-encoders"
import type { NativeVstEditorStatus } from "./native-request-broker"

const { hostCapabilities: hostCapabilitiesType } = nativeAudioHostControlTypes

const nativeVstInstanceId = (value: string): boolean => (
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
)

export const decodeDiagnostics = (frame: Buffer): NativeHostDiagnostics | undefined => {
  if (frame.byteLength < headerBytes + 256 || frame.byteLength > headerBytes + 512) return undefined
  const state = nativeAudioHostCodeName(nativeAudioHostLifecycleStates, frame.readUInt32BE(headerBytes))

  if (!state) return undefined
  const present = frame.readUInt32BE(headerBytes + 88)

  if (present > 1) return undefined
  const epoch = frame.readUInt32BE(headerBytes + 100)
  const idBytes = frame.readUInt32BE(headerBytes + 112)
  const performanceOffset = headerBytes + 116 + idBytes

  if (idBytes > 256 || frame.byteLength !== performanceOffset + 140
    || (present === 0 && idBytes !== 0) || (present === 1 && idBytes === 0)) return undefined
  const acceptedPoints = frame.readUInt32BE(headerBytes + 92)

  if (present === 1 && (acceptedPoints === 0 || acceptedPoints > maxVst3WorkerEventsPerBlock
    || epoch === 0 || epoch !== frame.readUInt32BE(headerBytes + 16))) return undefined

  return {
    workerAutomation: present === 0 ? null : {
      instanceId: readDiagnosticInstanceId(frame, headerBytes + 116, idBytes),
      acceptedPoints,
      lastParameterId: frame.readUInt32BE(headerBytes + 96),
      transportEpoch: epoch,
      sequence: frame.readBigUInt64BE(headerBytes + 104),
    },
    transportFrame: frame.readBigInt64BE(performanceOffset),
    realtimePerformance: {
      sampleRateHz: frame.readUInt32BE(performanceOffset + 8),
      framesPerCallback: frame.readUInt32BE(performanceOffset + 12),
      observationCount: frame.readBigUInt64BE(performanceOffset + 16),
      processingP50Nanoseconds: frame.readBigUInt64BE(performanceOffset + 24),
      processingP95Nanoseconds: frame.readBigUInt64BE(performanceOffset + 32),
      processingP99Nanoseconds: frame.readBigUInt64BE(performanceOffset + 40),
      processingMaximumNanoseconds: frame.readBigUInt64BE(performanceOffset + 48),
      deadlineMisses: frame.readBigUInt64BE(performanceOffset + 56),
    },
    vstWorkerPerformance: {
      activeWorkers: frame.readUInt32BE(performanceOffset + 64),
      observationCount: frame.readBigUInt64BE(performanceOffset + 68),
      processingP50Nanoseconds: frame.readBigUInt64BE(performanceOffset + 76),
      processingP95Nanoseconds: frame.readBigUInt64BE(performanceOffset + 84),
      processingP99Nanoseconds: frame.readBigUInt64BE(performanceOffset + 92),
      processingMaximumNanoseconds: frame.readBigUInt64BE(performanceOffset + 100),
      deadlineMisses: frame.readBigUInt64BE(performanceOffset + 108),
      watchdogMisses: frame.readBigUInt64BE(performanceOffset + 116),
      faults: frame.readBigUInt64BE(performanceOffset + 124),
      restarts: frame.readBigUInt64BE(performanceOffset + 132),
    },
    state,
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

export const decodeGraphRevisionStatus = (frame: Buffer): NativeGraphRevisionStatus | undefined => {
  if (frame.byteLength !== headerBytes + 64) return undefined
  const code = frame.readUInt32BE(headerBytes)
  const continuityCode = frame.readUInt32BE(headerBytes + 4)

  const continuity = nativeAudioHostCodeName(nativeAudioHostRevisionContinuities, continuityCode) ?? "not-evaluated"
  const status = nativeAudioHostCodeName(nativeAudioHostRevisionStatusCodes, code)

  if (!status) return undefined

  return {
    status,
    requestedRevision: frame.readUInt32BE(headerBytes + 8),
    continuity,
    activeRevision: frame.readUInt32BE(headerBytes + 12),
    preparedRevision: frame.readUInt32BE(headerBytes + 16),
    retiredRevision: frame.readUInt32BE(headerBytes + 20),
    renderEpoch: frame.readBigUInt64BE(headerBytes + 24),
    publicationFrame: frame.readBigInt64BE(headerBytes + 32),
    diagnosticCode: frame.readUInt32BE(headerBytes + 40),
    requestedPublicationFrame: frame.readBigUInt64BE(headerBytes + 44),
    progressFrame: frame.readBigUInt64BE(headerBytes + 52),
    transportEpoch: frame.readUInt32BE(headerBytes + 60),
  }
}

export const decodeVstEditorStatus = (frame: Buffer): NativeVstEditorStatus | undefined => {
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

export const decodeMeterBatch = (frame: Buffer): NativeHostMeterBatch | undefined => {
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

export const decodeSpectrumFrame = (frame: Buffer): NativeHostSpectrumFrame | undefined => {
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

export const decodeScheduleProgress = (frame: Buffer): NativeScheduleProgress | undefined => {
  const payload = frame.subarray(headerBytes)

  if (payload.byteLength !== nativeAudioHostScheduleProgressBytes) return undefined
  const revision = payload.readUInt32BE(0)
  const epoch = payload.readUInt32BE(4)
  const progressSequence = payload.readBigUInt64BE(8)

  if (revision === 0 || epoch === 0 || progressSequence === 0n) return undefined
  const flags = payload.readUInt32BE(64)

  if ((flags & ~3) !== 0) return undefined

  const progress: NativeScheduleProgress = {
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
    admissionCapacityGeneration: payload.readBigUInt64BE(80),
    latencyCompletionGeneration: payload.readBigUInt64BE(88),
  }

  if (payload.readUInt32BE(108) !== 0) return undefined
  const resolvedToken = payload.readBigUInt64BE(96)

  if (resolvedToken !== 0n) {
    progress.processorPatchResolved = { token: resolvedToken.toString(), result: payload.readUInt32BE(104) }
  }

  return progress
}

export type NativeMainRecordingStatus = NativeHostRecordingStatus & { fileDevice: bigint; fileInode: bigint }

export type AudioHostHello = NativeAudioHostParkingLimits & {
  capabilities: number
  abiVersion: number
  processorContractHash: string
  graphContractHash: string
  artifactId: string
  deviceState: "idle" | "configured" | "running" | "faulted"
  readinessReason: "ready" | "device-not-configured" | "graph-not-prepared" | "transport-not-prepared"
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

export const readResponse = (bytes: Buffer): AudioHostHello | undefined => {
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

  if (!processorContractHash || !graphContractHash || !artifactId || offset + 16 !== bytes.byteLength) return undefined
  const parsedDeviceState = nativeAudioHostCodeName(nativeAudioHostLifecycleStates, bytes.readUInt32BE(offset))
  const parsedReadinessReason = nativeAudioHostCodeName(nativeAudioHostReadinessReasons, bytes.readUInt32BE(offset + 4))

  if (!parsedDeviceState || !parsedReadinessReason) return undefined
  const maximumParkedInstances = bytes.readUInt32BE(offset + 8)
  const parkedAgeMs = bytes.readUInt32BE(offset + 12)

  if (parkedAgeMs === 0) return undefined

  return {
    capabilities: bytes.readUInt32BE(headerBytes + 4),
    abiVersion: bytes.readUInt32BE(headerBytes + 8),
    processorContractHash,
    graphContractHash,
    artifactId,
    deviceState: parsedDeviceState,
    readinessReason: parsedReadinessReason,
    maximumParkedInstances,
    parkedAgeMs,
  }
}

export const isCompatibleAudioHostHello = (hello: AudioHostHello) => (
  (hello.capabilities & nativeAudioHostRequiredCapabilities) === nativeAudioHostRequiredCapabilities
  && hello.abiVersion === audioCoreWasmAbiVersion
  && hello.processorContractHash === processorContractHash
  && hello.graphContractHash === portableGraphContractHash
  && hello.artifactId === nativeAudioHostArtifactId
)

/** Anything but the three valid outcome/refusal/token/core combinations is a protocol error. */
export const decodeNativeProcessorPatchStatus = (payload: Buffer): NativeProcessorPatchStatus | undefined => {
  if (payload.byteLength !== nativeAudioHostProcessorPatchStatusBytes) return undefined
  const outcome = payload.readUInt32BE(0)
  const refusalName = nativeAudioHostCodeName(nativeAudioHostPatchRefusals, payload.readUInt32BE(4))
  const refusalCode = payload.readUInt32BE(4)
  const coreResult = payload.readUInt32BE(8)
  const token = payload.readBigUInt64BE(12)

  if (outcome === 1) return refusalCode === 0 && coreResult === 0 && token === 0n ? { outcome: "applied" } : undefined

  if (outcome === 3) return refusalCode === 0 && coreResult === 0 && token !== 0n ? { outcome: "claimed", token } : undefined
  const refusal = outcome === nativeAudioHostPatchOutcomes.refused && refusalName !== "none" ? refusalName : undefined

  if (!refusal) return undefined

  if ((token !== 0n) !== (refusal === "claim-pending")) return undefined

  if (coreResult !== 0 && refusal !== "stage-failed" && refusal !== "apply-failed") return undefined

  return token === 0n ? { outcome: "refused", refusal, coreResult } : { outcome: "refused", refusal, coreResult, token }
}

export const decodeWorkerNotification = (frame: Buffer): NativeWorkerNotification | undefined => {
  const payload = frame.subarray(headerBytes)

  if (payload.byteLength < 24) return undefined
  const kindValue = payload.readUInt32BE(0)

  const kind = nativeAudioHostCodeName(nativeAudioHostNotificationKinds, kindValue)

  if (kind === "parameter-edit") {
    if (payload.byteLength < 32) return undefined
    const parameterId = payload.readUInt32BE(16)
    const normalizedValue = payload.readDoubleBE(20)
    const instanceBytes = payload.readUInt32BE(28)
    const instanceId = payload.subarray(32).toString("utf8")

    if (parameterId > unsigned32Max
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

const deviceStringReader = (payload: Buffer, start: number) => {
  let offset = start

  return {
    offset: () => offset,
    advance: (bytes: number) => { offset += bytes },
    string: () => {
      if (offset + 4 > payload.byteLength) return undefined
      const length = payload.readUInt32BE(offset)
      offset += 4

      if (length === 0 || offset + length > payload.byteLength) return undefined
      const value = payload.subarray(offset, offset + length).toString("utf8")
      offset += length

      return value
    },
  }
}

export const decodeCpuLoad = (frame: Buffer): NativeAudioHostCpuLoad | undefined => {
  const payload = frame.subarray(headerBytes)

  if (payload.byteLength !== nativeAudioHostCpuLoadPayloadBytes) return undefined

  const parsed = nativeAudioHostCpuLoadSchema.safeParse({
    callbackNanoseconds: Number(payload.readBigUInt64BE(0)),
    bufferNanoseconds: Number(payload.readBigUInt64BE(8)),
    peakLoadPerMillion: Number(payload.readBigUInt64BE(16)),
  })

  return parsed.success ? parsed.data : undefined
}

export const decodeDeviceInventory = (frame: Buffer): NativeAudioDevice[] | undefined => {
  const payload = frame.subarray(headerBytes)

  if (payload.byteLength < 4) return undefined
  const count = payload.readUInt32BE(0)
  const reader = deviceStringReader(payload, 4)
  const devices: NativeAudioDevice[] = []

  for (let index = 0; index < count; index += 1) {
    const deviceId = reader.string()
    const name = reader.string()
    const offset = reader.offset()

    if (!deviceId || !coreAudioDeviceId(deviceId) || !name || offset + 16 > payload.byteLength) return undefined
    const availability = payload.readUInt32BE(offset + 12)

    if (availability !== 0 && availability !== 1) return undefined
    devices.push({
      deviceId,
      name,
      nominalSampleRateHz: payload.readUInt32BE(offset),
      inputChannelCount: payload.readUInt32BE(offset + 4),
      outputChannelCount: payload.readUInt32BE(offset + 8),
      available: availability === 1,
    })
    reader.advance(16)
  }

  return reader.offset() === payload.byteLength ? devices : undefined
}

export const decodeOutputDevice = (frame: Buffer): NativeOutputDevice | null | undefined => {
  const payload = frame.subarray(headerBytes)

  if (payload.byteLength === 4 && payload.readUInt32BE(0) === 0) return null

  if (payload.byteLength < 4 || payload.readUInt32BE(0) !== 1) return undefined
  const reader = deviceStringReader(payload, 4)
  const deviceId = reader.string()
  const name = reader.string()
  const offset = reader.offset()

  if (!deviceId || !coreAudioDeviceId(deviceId) || !name || offset + 16 !== payload.byteLength) return undefined
  const nominalSampleRateHz = payload.readUInt32BE(offset)
  const outputChannelCount = payload.readUInt32BE(offset + 4)
  const maximumFramesPerBlock = payload.readUInt32BE(offset + 8)
  const availability = payload.readUInt32BE(offset + 12)

  if (availability !== 0 && availability !== 1) return undefined

  return { deviceId, name, nominalSampleRateHz, outputChannelCount, maximumFramesPerBlock, available: availability === 1 }
}

export const decodeInputDevice = (frame: Buffer): NativeInputDevice | null | undefined => {
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

export const decodeRecordingStatus = (frame: Buffer): NativeMainRecordingStatus | undefined => {
  const payload = frame.subarray(headerBytes)

  if (payload.byteLength !== 120) return undefined
  const timelineFrame = payload.readBigInt64BE(12)
  const capturedFrames = safeUnsigned64(payload.readBigUInt64BE(20))
  const droppedFrames = safeUnsigned64(payload.readBigUInt64BE(28))
  const flags = payload.readUInt32BE(56)
  const rms = payload.readFloatBE(48)
  const peak = payload.readFloatBE(52)
  const availableBlocks = payload.readUInt32BE(40)
  const queuedBlocks = payload.readUInt32BE(44)

  if (
    timelineFrame < 0 || timelineFrame > BigInt(Number.MAX_SAFE_INTEGER)
    || capturedFrames === undefined || droppedFrames === undefined
    || payload.readUInt32BE(0) === 0 || payload.readBigUInt64BE(4) === 0n
    || !Number.isFinite(rms) || rms < 0 || !Number.isFinite(peak) || peak < 0
    || availableBlocks > 32 || queuedBlocks > 32 || availableBlocks + queuedBlocks > 32
    || (flags & ~31) !== 0
  ) return undefined
  const state = payload.readUInt32BE(60)
  const error = payload.readUInt32BE(64)
  const systemError = payload.readInt32BE(68)
  const writtenFrames = safeUnsigned64(payload.readBigUInt64BE(72))
  const writtenBytes = safeUnsigned64(payload.readBigUInt64BE(80))
  const writtenBlocks = safeUnsigned64(payload.readBigUInt64BE(88))
  const fileDevice = payload.readBigUInt64BE(96)
  const fileInode = payload.readBigUInt64BE(104)
  const sampleRateHz = payload.readUInt32BE(112)
  const channelCount = payload.readUInt32BE(116)

  if (state > 4 || error > 13 || systemError < 0 || writtenFrames === undefined || writtenBytes === undefined
    || writtenBlocks === undefined || (channelCount !== 1 && channelCount !== 2)
    || sampleRateHz > 384000 || (state === 1 && sampleRateHz === 0)) return undefined

  if (state === 2 && (error !== 0 || systemError !== 0 || (flags & 8) === 0 || (flags & 19) !== 0
    || queuedBlocks !== 0 || sampleRateHz === 0
    || fileInode === 0n || writtenFrames !== capturedFrames || droppedFrames !== 0
    || payload.readUInt32BE(36) !== 0 || writtenBytes !== 4 * writtenBlocks + 4 * writtenFrames * channelCount
    || !Number.isSafeInteger(4 * writtenBlocks + 4 * writtenFrames * channelCount))) return undefined

  return {
    fileDevice, fileInode,
    spool: { state, error, systemError, writtenFrames, writtenBytes, writtenBlocks,
      published: (flags & 8) !== 0, partialRetained: (flags & 16) !== 0, sampleRateHz, channelCount },
    generation: payload.readUInt32BE(0),
    sessionId: payload.readBigUInt64BE(4),
    timelineFrame: Number(timelineFrame),
    capturedFrames,
    droppedFrames,
    droppedBlocks: payload.readUInt32BE(36),
    availableBlocks,
    queuedBlocks,
    rms,
    peak,
    fatal: (flags & 1) !== 0,
    active: (flags & 2) !== 0,
    configured: (flags & 4) !== 0,
  }
}
