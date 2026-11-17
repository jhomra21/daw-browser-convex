import { maxVst3WorkerEventsPerBlock } from "@daw-browser/plugin-host-protocol"
import {
  nativeAudioHostFrameHeaderBytes as headerBytes,
  nativeAudioHostMaximumMeterEntries as maximumMeterEntries,
  nativeAudioHostMaximumSpectrumBins as maximumSpectrumBins,
  nativeAudioHostScheduleProgressBytes,
  nativeAudioHostScheduleProgressCapacityBytes,
  nativeAudioHostScheduleProgressLatencyBytes,
  nativeAudioHostScheduleProgressResolutionBytes,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeGraphRevisionStatus } from "@daw-browser/desktop-protocol/native-revision"
import type {
  NativeHostDiagnostics,
  NativeHostMeterBatch,
  NativeHostSpectrumFrame,
  NativeScheduleProgress,
} from "@daw-browser/audio-engine/native-host-wire"
import { readDiagnosticInstanceId } from "./diagnostic-instance-id"
import type { NativeVstEditorStatus } from "./native-request-broker"

export const decodeDiagnostics = (frame: Buffer): NativeHostDiagnostics | undefined => {
  if (frame.byteLength < headerBytes + 256 || frame.byteLength > headerBytes + 512) return undefined
  const state = frame.readUInt32BE(headerBytes)
  if (state !== 0 && state !== 1 && state !== 2 && state !== 3) return undefined
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
export const decodeGraphRevisionStatus = (frame: Buffer): NativeGraphRevisionStatus | undefined => {
  if (frame.byteLength !== headerBytes + 64) return undefined
  const code = frame.readUInt32BE(headerBytes)
  const continuityCode = frame.readUInt32BE(headerBytes + 4)
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
    : code === 11 ? "publish-pending"
    : code === 12 ? "rebase-required"
    : code === 13 ? "capture-target-locked"
    : undefined
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
  if (payload.byteLength !== nativeAudioHostScheduleProgressBytes
    && payload.byteLength !== nativeAudioHostScheduleProgressCapacityBytes
    && payload.byteLength !== nativeAudioHostScheduleProgressLatencyBytes
    && payload.byteLength !== nativeAudioHostScheduleProgressResolutionBytes) return undefined
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
  }
  if (payload.byteLength >= nativeAudioHostScheduleProgressCapacityBytes)
    progress.admissionCapacityGeneration = payload.readBigUInt64BE(nativeAudioHostScheduleProgressBytes)
  if (payload.byteLength >= nativeAudioHostScheduleProgressLatencyBytes)
    progress.latencyCompletionGeneration = payload.readBigUInt64BE(nativeAudioHostScheduleProgressCapacityBytes)
  if (payload.byteLength === nativeAudioHostScheduleProgressResolutionBytes) {
    if (payload.readUInt32BE(108) !== 0) return undefined
    const resolvedToken = payload.readBigUInt64BE(nativeAudioHostScheduleProgressLatencyBytes)
    if (resolvedToken !== 0n) {
      progress.processorPatchResolved = { token: resolvedToken.toString(), result: payload.readUInt32BE(104) }
    }
  }
  return progress
}
