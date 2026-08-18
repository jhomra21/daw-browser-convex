import type { AudioAssetRef, AudioCoreGraphSnapshot, AudioCoreInstrumentState, AudioCoreProcessorStateEnvelope, AudioCoreSampleSourceEventDto, UtilityProcessorState } from '../../audio-core-contract/src/index'
import {
  audioCoreContractVersion,
  audioCoreMaxGraphProcessors,
  audioCoreMaxProcessorParameterTargets,
  audioCoreMaxProcessorsPerNode,
  decodeAudioCoreProcessorStateEnvelope,
  isAudioCoreGraphProcessor,
  isAudioCoreInstrumentState,
} from '../../audio-core-contract/src/index'
import { audioCoreWasmAbiVersion } from '../../audio-core-wasm/src/index'
import { isPortableFrameSchedule, type PortableFrameSchedule } from './portable-frame-scheduling'

export const portableWasmProtocolVersion = 1
export const portableWasmMaxPendingEvents = 256
export const portableWasmMaxInstrumentEvents = 256
export const portableWasmMaxGraphNodes = 64
export const portableWasmMaxGraphEdges = 256
export const portableWasmMaxAssets = 64
export const portableWasmMaxScheduleEvents = 256

export type PortableWasmParameterBlock = {
  processorInstanceId: number
  frameCount: number
  parameterTargets: readonly number[]
  values: Float32Array
}

export type PortableWasmProcessorEvent = {
  processorInstanceId: number
  parameterTarget: number
  frameOffset: number
  value: number
}

type RecordingCaptureConfigureFields = {
  type: 'recording-capture-configure'
  generation: number
  sessionId: number
  channelCount: number
  inputChannels: readonly number[]
  gain: number
  polarity: 1 | -1
  monitoring: boolean
  punchStartFrame: number
  punchEndFrame: number | null
}

export type PortableWasmControlMessage =
  | { version: typeof portableWasmProtocolVersion; type: 'initialize'; abiVersion: number; contractHash: string; maxFramesPerBlock: number }
  | { version: typeof portableWasmProtocolVersion; type: 'publish-graph'; requestId: number; revision: number }
  | { version: typeof portableWasmProtocolVersion; type: 'prepare-graph'; requestId: number; snapshot: AudioCoreGraphSnapshot }
  | { version: typeof portableWasmProtocolVersion; type: 'processor-state'; revision: number; envelope: AudioCoreProcessorStateEnvelope }
  | { version: typeof portableWasmProtocolVersion; type: 'parameter-blocks'; revision: number; blocks: readonly PortableWasmParameterBlock[] }
  | { version: typeof portableWasmProtocolVersion; type: 'processor-events'; requestId: number; revision: number; epoch: number; sequence: number; events: readonly PortableWasmProcessorEvent[] }
  | { version: typeof portableWasmProtocolVersion; type: 'reenable-processor-automation'; requestId: number; revision: number; epoch: number; processorInstanceId: number; parameterTargets: readonly number[] }
  | { version: typeof portableWasmProtocolVersion; type: 'utility-state'; revision: number; state: UtilityProcessorState }
  | { version: typeof portableWasmProtocolVersion; type: 'instrument-state'; revision: number; nodeId: string; state: AudioCoreInstrumentState }
  | { version: typeof portableWasmProtocolVersion; type: 'transport'; requestId: number; epoch: number; running: boolean; frame: number }
  | { version: typeof portableWasmProtocolVersion; type: 'instrument-events'; epoch: number; events: readonly PortableWasmInstrumentEvent[] }
  | { version: typeof portableWasmProtocolVersion; type: 'install-schedule'; requestId: number; schedule: PortableFrameSchedule }
  | { version: typeof portableWasmProtocolVersion; type: 'schedule-sources'; requestId: number; revision: number; epoch: number; events: readonly AudioCoreSampleSourceEventDto[] }
  | { version: typeof portableWasmProtocolVersion; type: 'register-asset'; requestId: number; generation: number; asset: AudioAssetRef; planes: readonly Float32Array[] }
  | { version: typeof portableWasmProtocolVersion; type: 'release-asset'; requestId: number; generation: number; assetId: string }
  | { version: typeof portableWasmProtocolVersion; type: 'retire-assets'; generation: number }
  | ({ version: typeof portableWasmProtocolVersion } & RecordingCaptureConfigureFields)
  | { version: typeof portableWasmProtocolVersion; type: 'recording-capture-finalize'; stopFrame: number | null }
  | { version: typeof portableWasmProtocolVersion; type: 'recording-capture-cancel' }
  | { version: typeof portableWasmProtocolVersion; type: 'recording-capture-drain' }
  | { version: typeof portableWasmProtocolVersion; type: 'diagnostics' }
  | { version: typeof portableWasmProtocolVersion; type: 'dispose' }

export type PortableWasmStatusMessage =
  | { version: typeof portableWasmProtocolVersion; type: 'ready'; revision: number }
  | { version: typeof portableWasmProtocolVersion; type: 'health'; revision: number; framesProcessed: number; memoryBytes: number }
  | { version: typeof portableWasmProtocolVersion; type: 'asset-registered'; requestId: number; generation: number; assetId: string; result: 'registered'; handle: { slot: number; generation: number } }
  | { version: typeof portableWasmProtocolVersion; type: 'asset-registered'; requestId: number; generation: number; assetId: string; result: 'capacity-exceeded' | 'stale-generation' | 'invalid-pcm' }
  | { version: typeof portableWasmProtocolVersion; type: 'asset-released'; requestId: number; generation: number; assetId: string; result: 'released' | 'stale-generation' }
  | { version: typeof portableWasmProtocolVersion; type: 'graph-prepared'; requestId: number; revision: number; result: 'prepared' | 'rejected' }
  | { version: typeof portableWasmProtocolVersion; type: 'graph-published'; requestId: number; revision: number; result: 'published' | 'rejected' }
  | { version: typeof portableWasmProtocolVersion; type: 'graph-continuity'; revision: number; result: 'accepted' | 'fallback' | 'rejected' | 'capacity' }
  | { version: typeof portableWasmProtocolVersion; type: 'transport-applied'; requestId: number; epoch: number; result: 'applied' | 'rejected' }
  | { version: typeof portableWasmProtocolVersion; type: 'transport-position'; sessionId: number; epoch: number; sequence: number; running: boolean; frame: number }
  | { version: typeof portableWasmProtocolVersion; type: 'schedule-installed'; requestId: number; revision: number; epoch: number; result: 'installed' | 'rejected' }
  | { version: typeof portableWasmProtocolVersion; type: 'sources-scheduled'; requestId: number; revision: number; epoch: number; result: 'scheduled' | 'rejected' }
  | { version: typeof portableWasmProtocolVersion; type: 'processor-events-applied'; requestId: number; revision: number; epoch: number; sequence: number; result: 'applied' | 'rejected' }
  | { version: typeof portableWasmProtocolVersion; type: 'processor-automation-reenabled'; requestId: number; revision: number; epoch: number; result: 'applied' | 'rejected' }
  | { version: typeof portableWasmProtocolVersion; type: 'recording-capture-block'; generation: number; sessionId: number; sequence: number; frameCount: number; channelCount: number; planes: readonly Float32Array[]; rms: number; peak: number }
  | { version: typeof portableWasmProtocolVersion; type: 'recording-capture-available'; generation: number; sessionId: number }
  | { version: typeof portableWasmProtocolVersion; type: 'recording-capture-applied'; generation: number; sessionId: number; action: 'configured' | 'finalized' | 'cancelled'; frame: number }
  | { version: typeof portableWasmProtocolVersion; type: 'recording-capture-diagnostics'; generation: number; sessionId: number; capturedFrames: number; droppedFrames: number; droppedBlocks: number; availableBlocks: number; queuedBlocks: number; rms: number; peak: number; fatal: boolean; active: boolean }
  | { version: typeof portableWasmProtocolVersion; type: 'fault'; code: 'malformed-message' | 'abi-mismatch' | 'contract-mismatch' | 'capacity-exceeded' | 'initialization-failed' | 'event-overflow' | 'core-error' }

export type PortableWasmInstrumentEvent = {
  nodeId: string
  noteId: number
  sequence: number
  frameOffset: number
  type: 'note-on' | 'note-off' | 'sustain' | 'expression' | 'parameter'
  channel: number
  note: number
  value: number
}

type ProtocolValue = null | boolean | number | string | readonly ProtocolValue[] | ProtocolObject | Float32Array | Uint8Array
type ProtocolObject = { [key: string]: ProtocolValue }

const isProtocolString = <Value>(value: Value): value is Value & string => typeof value === 'string'
const isProtocolNumber = <Value>(value: Value): value is Value & number => typeof value === 'number'
const isProtocolBoolean = <Value>(value: Value): value is Value & boolean => typeof value === 'boolean'

const isRecord = <Value>(value: Value): value is Value & ProtocolObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Float32Array) && !(value instanceof Uint8Array)

const isPositiveInteger = <Value>(value: Value): value is Value & number =>
  isProtocolNumber(value) && Number.isInteger(value) && value > 0

const isBoundedFinite = <Value>(value: Value, minimum: number, maximum: number): value is Value & number =>
  isProtocolNumber(value) && Number.isFinite(value) && value >= minimum && value <= maximum

const isAudioAssetRef = <Value>(value: Value): value is Value & AudioAssetRef => {
  if (!isRecord(value)) return false
  return value.version === audioCoreContractVersion
    && isProtocolString(value.assetId)
    && value.assetId.length > 0
    && isPositiveInteger(value.frameCount)
    && isPositiveInteger(value.sampleRateHz)
    && isPositiveInteger(value.channelCount)
}

const isPlanarAsset = <Value>(asset: AudioAssetRef, planes: Value): planes is Value & readonly Float32Array[] =>
  Array.isArray(planes)
  && planes.length === asset.channelCount
  && planes.every((plane) => plane instanceof Float32Array && plane.length === asset.frameCount)

const isUtilityState = <Value>(value: Value): value is Value & UtilityProcessorState => {
  if (!isRecord(value)) return false
  return isProtocolBoolean(value.enabled)
    && isProtocolNumber(value.gainDb)
    && (value.polarity === 'normal' || value.polarity === 'invert')
    && (value.inputMode === 'stereo' || value.inputMode === 'mono-sum')
    && isProtocolNumber(value.pan)
    && isProtocolNumber(value.balance)
    && isProtocolNumber(value.width)
    && (value.matrix === 'stereo' || value.matrix === 'mid-side-encode' || value.matrix === 'mid-side-decode')
    && isProtocolBoolean(value.swap)
    && isProtocolBoolean(value.dcBlock)
}

const isInstrumentEvent = <Value>(value: Value): value is Value & PortableWasmInstrumentEvent =>
  isRecord(value)
  && isProtocolString(value.nodeId) && value.nodeId.length > 0
  && isPositiveInteger(value.noteId)
  && isPositiveInteger(value.sequence)
  && isProtocolNumber(value.frameOffset) && Number.isInteger(value.frameOffset) && value.frameOffset >= 0 && value.frameOffset < 8192
  && (value.type === 'note-on' || value.type === 'note-off' || value.type === 'sustain' || value.type === 'expression' || value.type === 'parameter')
  && isProtocolNumber(value.channel) && Number.isInteger(value.channel) && value.channel >= 0 && value.channel <= 15
  && isProtocolNumber(value.note) && Number.isInteger(value.note) && value.note >= 0 && value.note <= 127
  && isProtocolNumber(value.value) && Number.isFinite(value.value)
  && (value.type === 'parameter' || value.value >= 0 && value.value <= 1)

const isSampleSourceEvent = <Value>(value: Value): value is Value & AudioCoreSampleSourceEventDto =>
  isRecord(value)
  && value.version === audioCoreContractVersion
  && isPositiveInteger(value.epoch)
  && isPositiveInteger(value.sequence)
  && isProtocolString(value.sourceNodeId) && value.sourceNodeId.length > 0
  && isProtocolString(value.assetId) && value.assetId.length > 0
  && isProtocolNumber(value.startFrame) && Number.isSafeInteger(value.startFrame)
  && isProtocolNumber(value.stopFrame) && Number.isSafeInteger(value.stopFrame) && value.stopFrame > value.startFrame
  && isProtocolNumber(value.sourceOffsetFrame) && Number.isSafeInteger(value.sourceOffsetFrame) && value.sourceOffsetFrame >= 0
  && (value.sourceOffsetFraction === undefined
    || isProtocolNumber(value.sourceOffsetFraction) && Number.isFinite(value.sourceOffsetFraction)
      && value.sourceOffsetFraction >= 0 && value.sourceOffsetFraction < 1)
  && isPositiveInteger(value.sourceFrameCount)
  && isProtocolNumber(value.gain) && Number.isFinite(value.gain)
  && isProtocolNumber(value.fadeInStartFrame) && Number.isSafeInteger(value.fadeInStartFrame)
  && isProtocolNumber(value.fadeInEndFrame) && Number.isSafeInteger(value.fadeInEndFrame) && value.fadeInEndFrame >= value.fadeInStartFrame
  && isProtocolNumber(value.fadeOutStartFrame) && Number.isSafeInteger(value.fadeOutStartFrame)
  && isProtocolNumber(value.fadeOutEndFrame) && Number.isSafeInteger(value.fadeOutEndFrame) && value.fadeOutEndFrame >= value.fadeOutStartFrame
  && (value.fadeInCurve === undefined || isBoundedFinite(value.fadeInCurve, -1, 1))
  && (value.fadeInCurvePosition === undefined || isBoundedFinite(value.fadeInCurvePosition, 0, 1))
  && (value.fadeOutCurve === undefined || isBoundedFinite(value.fadeOutCurve, -1, 1))
  && (value.fadeOutCurvePosition === undefined || isBoundedFinite(value.fadeOutCurvePosition, 0, 1))

const isParameterBlock = <Value>(value: Value): value is Value & PortableWasmParameterBlock =>
  isRecord(value)
  && isPositiveInteger(value.processorInstanceId)
  && isPositiveInteger(value.frameCount)
  && value.frameCount <= 8192
  && Array.isArray(value.parameterTargets)
  && value.parameterTargets.length > 0
  && value.parameterTargets.length <= audioCoreMaxProcessorParameterTargets
  && value.parameterTargets.every(isPositiveInteger)
  && value.values instanceof Float32Array
  && value.values.length === value.parameterTargets.length * value.frameCount

const isProcessorEvent = <Value>(value: Value): value is Value & PortableWasmProcessorEvent =>
  isRecord(value)
  && isPositiveInteger(value.processorInstanceId)
  && isPositiveInteger(value.parameterTarget)
  && isProtocolNumber(value.frameOffset) && Number.isInteger(value.frameOffset) && value.frameOffset >= 0 && value.frameOffset < 8192
  && isProtocolNumber(value.value) && Number.isFinite(value.value)

const isRecordingCaptureConfigure = (value: ProtocolObject): value is ProtocolObject & RecordingCaptureConfigureFields =>
  value.type === 'recording-capture-configure'
  && isProtocolNumber(value.generation) && Number.isSafeInteger(value.generation) && value.generation >= 0
  && isProtocolNumber(value.sessionId) && Number.isSafeInteger(value.sessionId) && value.sessionId >= 0
  && (value.channelCount === 1 || value.channelCount === 2)
  && Array.isArray(value.inputChannels) && value.inputChannels.length === value.channelCount
  && value.inputChannels.every((channel) => isProtocolNumber(channel) && Number.isInteger(channel) && channel >= 0 && channel < 64)
  && isProtocolNumber(value.gain) && Number.isFinite(value.gain) && value.gain >= 0
  && (value.polarity === 1 || value.polarity === -1)
  && isProtocolBoolean(value.monitoring)
  && isProtocolNumber(value.punchStartFrame) && Number.isSafeInteger(value.punchStartFrame) && value.punchStartFrame >= 0
  && (value.punchEndFrame === null || (isProtocolNumber(value.punchEndFrame)
    && Number.isSafeInteger(value.punchEndFrame) && value.punchEndFrame >= value.punchStartFrame))

export const readPortableWasmRecordingStatusMessage = (
  value: ProtocolValue,
): Extract<PortableWasmStatusMessage, { type: `recording-${string}` }> | null => {
  if (!isRecord(value) || value.version !== portableWasmProtocolVersion || !isProtocolString(value.type)
    || !isProtocolNumber(value.generation) || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !isProtocolNumber(value.sessionId) || !Number.isSafeInteger(value.sessionId) || value.sessionId < 0) return null
  if (value.type === 'recording-capture-available') {
    return { version: portableWasmProtocolVersion, type: 'recording-capture-available', generation: value.generation, sessionId: value.sessionId }
  }
  if (value.type === 'recording-capture-applied'
    && (value.action === 'configured' || value.action === 'finalized' || value.action === 'cancelled')
    && isProtocolNumber(value.frame) && Number.isSafeInteger(value.frame) && value.frame >= 0) {
    return {
      version: portableWasmProtocolVersion,
      type: 'recording-capture-applied',
      generation: value.generation,
      sessionId: value.sessionId,
      action: value.action,
      frame: value.frame,
    }
  }
  if (value.type === 'recording-capture-block'
    && isProtocolNumber(value.sequence) && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && isProtocolNumber(value.frameCount) && Number.isSafeInteger(value.frameCount) && value.frameCount > 0
    && (value.channelCount === 1 || value.channelCount === 2)
    && Array.isArray(value.planes) && value.planes.length === value.channelCount
    && value.planes.every((plane) => plane instanceof Float32Array && plane.length === value.frameCount)
    && isProtocolNumber(value.rms) && Number.isFinite(value.rms) && value.rms >= 0
    && isProtocolNumber(value.peak) && Number.isFinite(value.peak) && value.peak >= 0) {
    return {
      version: portableWasmProtocolVersion,
      type: 'recording-capture-block',
      generation: value.generation,
      sessionId: value.sessionId,
      sequence: value.sequence,
      frameCount: value.frameCount,
      channelCount: value.channelCount,
      planes: value.planes,
      rms: value.rms,
      peak: value.peak,
    }
  }
  if (value.type === 'recording-capture-diagnostics'
    && isProtocolNumber(value.capturedFrames) && Number.isSafeInteger(value.capturedFrames) && value.capturedFrames >= 0
    && isProtocolNumber(value.droppedFrames) && Number.isSafeInteger(value.droppedFrames) && value.droppedFrames >= 0
    && isProtocolNumber(value.droppedBlocks) && Number.isSafeInteger(value.droppedBlocks) && value.droppedBlocks >= 0
    && isProtocolNumber(value.availableBlocks) && Number.isSafeInteger(value.availableBlocks) && value.availableBlocks >= 0
    && isProtocolNumber(value.queuedBlocks) && Number.isSafeInteger(value.queuedBlocks) && value.queuedBlocks >= 0
    && isProtocolNumber(value.rms) && Number.isFinite(value.rms) && value.rms >= 0
    && isProtocolNumber(value.peak) && Number.isFinite(value.peak) && value.peak >= 0
    && isProtocolBoolean(value.fatal) && isProtocolBoolean(value.active)) {
    return {
      version: portableWasmProtocolVersion,
      type: 'recording-capture-diagnostics',
      generation: value.generation,
      sessionId: value.sessionId,
      capturedFrames: value.capturedFrames,
      droppedFrames: value.droppedFrames,
      droppedBlocks: value.droppedBlocks,
      availableBlocks: value.availableBlocks,
      queuedBlocks: value.queuedBlocks,
      rms: value.rms,
      peak: value.peak,
      fatal: value.fatal,
      active: value.active,
    }
  }
  return null
}

export const readPortableWasmGraphContinuityMessage = (
  value: ProtocolValue,
): Extract<PortableWasmStatusMessage, { type: 'graph-continuity' }> | null => {
  if (!isRecord(value) || value.version !== portableWasmProtocolVersion || value.type !== 'graph-continuity'
    || !isProtocolNumber(value.revision) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.result !== 'accepted' && value.result !== 'fallback' && value.result !== 'rejected' && value.result !== 'capacity')) return null
  return {
    version: portableWasmProtocolVersion,
    type: 'graph-continuity',
    revision: value.revision,
    result: value.result,
  }
}

export const readPortableWasmTransportPositionMessage = (
  value: ProtocolValue,
): Extract<PortableWasmStatusMessage, { type: 'transport-position' }> | null => {
  if (!isRecord(value) || value.version !== portableWasmProtocolVersion || value.type !== 'transport-position'
    || !isProtocolNumber(value.sessionId) || !Number.isSafeInteger(value.sessionId) || value.sessionId < 1
    || !isProtocolNumber(value.epoch) || !Number.isSafeInteger(value.epoch) || value.epoch < 1
    || !isProtocolNumber(value.sequence) || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !isProtocolBoolean(value.running)
    || !isProtocolNumber(value.frame) || !Number.isSafeInteger(value.frame) || value.frame < 0) return null
  return {
    version: portableWasmProtocolVersion,
    type: 'transport-position',
    sessionId: value.sessionId,
    epoch: value.epoch,
    sequence: value.sequence,
    running: value.running,
    frame: value.frame,
  }
}

const isPortableGraphSnapshot = <Value>(value: Value): value is Value & AudioCoreGraphSnapshot => {
  if (!isRecord(value)
    || value.version !== audioCoreContractVersion
    || !isPositiveInteger(value.revision)
    || !isProtocolString(value.contractHash)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !isProtocolString(value.masterNodeId)
    || !Array.isArray(value.assets)
    || value.nodes.length > portableWasmMaxGraphNodes
    || value.edges.length > portableWasmMaxGraphEdges
    || value.assets.length > portableWasmMaxAssets) return false
  const processorCount = value.nodes.reduce((total, node) => (
    total + (isRecord(node) && Array.isArray(node.processorOrder) ? node.processorOrder.length : 0)
  ), 0)
  if (processorCount > audioCoreMaxGraphProcessors) return false
  const processorInstanceIds = new Set<number>()
  const processorIds = new Set<string>()
  const processorNodeIds = new Map<string, string>()
  const nodeIds = new Set<string>()
  const validNodes = value.nodes.every((node) => isRecord(node)
    && isProtocolString(node.id)
    && node.id.length > 0
    && !nodeIds.has(node.id)
    && (nodeIds.add(node.id), true)
    && (node.kind === 'source' || node.kind === 'instrument' || node.kind === 'mixer' || node.kind === 'return' || node.kind === 'group' || node.kind === 'master')
    && (node.inputLayout === 'mono' || node.inputLayout === 'stereo')
    && (node.outputLayout === 'mono' || node.outputLayout === 'stereo')
    && isProtocolNumber(node.latencyFrames) && Number.isInteger(node.latencyFrames) && node.latencyFrames >= 0
    && (node.kind === 'instrument'
      ? node.inputLayout === 'stereo' && node.outputLayout === 'stereo' && isAudioCoreInstrumentState(node.instrument)
      : node.instrument === undefined)
    && Array.isArray(node.processorOrder)
    && node.processorOrder.length <= audioCoreMaxProcessorsPerNode
    && node.processorOrder.every((processor: ProtocolValue) => {
      if (!isAudioCoreGraphProcessor(processor) || processorInstanceIds.has(processor.instanceId) || processorIds.has(processor.id)) return false
      processorInstanceIds.add(processor.instanceId)
      processorIds.add(processor.id)
      processorNodeIds.set(processor.id, isProtocolString(node.id) ? node.id : '')
      return true
    })
  )
  if (!validNodes || !nodeIds.has(value.masterNodeId)) return false
  const edgeIds = new Set<string>()
  return value.edges.every((edge) => isRecord(edge)
    && edge.version === audioCoreContractVersion
    && isProtocolString(edge.id)
    && edge.id.length > 0
    && !edgeIds.has(edge.id)
    && (edgeIds.add(edge.id), true)
    && isProtocolString(edge.fromNodeId)
    && isProtocolString(edge.toNodeId)
    && edge.fromNodeId !== edge.toNodeId
    && nodeIds.has(edge.fromNodeId)
    && nodeIds.has(edge.toNodeId)
    && isProtocolNumber(edge.gain)
    && Number.isFinite(edge.gain)
    && (edge.kind === 'output' || edge.kind === 'send')
    && (edge.tap === 'pre-fx' || edge.tap === 'pre-fader' || edge.tap === 'post-fader')
    && isProtocolBoolean(edge.sidechain)
    && isProtocolNumber(edge.pdcDelayFrames)
    && Number.isInteger(edge.pdcDelayFrames)
    && edge.pdcDelayFrames >= 0
    && (edge.sidechain
      ? isProtocolString(edge.targetProcessorId) && edge.targetProcessorId.length > 0
        && processorIds.has(edge.targetProcessorId) && processorNodeIds.get(edge.targetProcessorId) === edge.toNodeId
      : edge.targetProcessorId === undefined))
}

export const parsePortableWasmControlMessage = <Value>(value: Value): PortableWasmControlMessage | null => {
  if (!isRecord(value) || value.version !== portableWasmProtocolVersion || !isProtocolString(value.type)) return null
  if (value.type === 'dispose' || value.type === 'diagnostics' || value.type === 'recording-capture-cancel' || value.type === 'recording-capture-drain') {
    if (value.type === 'dispose') return { version: portableWasmProtocolVersion, type: 'dispose' }
    if (value.type === 'diagnostics') return { version: portableWasmProtocolVersion, type: 'diagnostics' }
    if (value.type === 'recording-capture-cancel') return { version: portableWasmProtocolVersion, type: 'recording-capture-cancel' }
    return { version: portableWasmProtocolVersion, type: 'recording-capture-drain' }
  }
  if (isRecordingCaptureConfigure(value)) {
    return {
      version: portableWasmProtocolVersion,
      type: 'recording-capture-configure',
      generation: value.generation,
      sessionId: value.sessionId,
      channelCount: value.channelCount,
      inputChannels: value.inputChannels,
      gain: value.gain,
      polarity: value.polarity,
      monitoring: value.monitoring,
      punchStartFrame: value.punchStartFrame,
      punchEndFrame: value.punchEndFrame,
    }
  }
  if (value.type === 'recording-capture-finalize'
    && (value.stopFrame === null || (isProtocolNumber(value.stopFrame) && Number.isSafeInteger(value.stopFrame) && value.stopFrame >= 0))) {
    return { version: portableWasmProtocolVersion, type: 'recording-capture-finalize', stopFrame: value.stopFrame }
  }
  if (value.type === 'publish-graph' && isPositiveInteger(value.requestId) && isPositiveInteger(value.revision)) return { version: portableWasmProtocolVersion, type: 'publish-graph', requestId: value.requestId, revision: value.revision }
  if (value.type === 'prepare-graph' && isPositiveInteger(value.requestId) && isPortableGraphSnapshot(value.snapshot)) {
    return { version: portableWasmProtocolVersion, type: 'prepare-graph', requestId: value.requestId, snapshot: value.snapshot }
  }
  if (value.type === 'processor-state' && isPositiveInteger(value.revision) && value.envelope instanceof Uint8Array) {
    try {
      return {
        version: portableWasmProtocolVersion,
        type: 'processor-state',
        revision: value.revision,
        envelope: decodeAudioCoreProcessorStateEnvelope(value.envelope),
      }
    } catch {
      return null
    }
  }
  if (value.type === 'parameter-blocks' && isPositiveInteger(value.revision) && Array.isArray(value.blocks)
    && value.blocks.length <= 512 && value.blocks.every(isParameterBlock)) {
    return { version: portableWasmProtocolVersion, type: 'parameter-blocks', revision: value.revision, blocks: value.blocks }
  }
  if (value.type === 'processor-events' && isPositiveInteger(value.revision) && Array.isArray(value.events)
    && value.events.length <= portableWasmMaxPendingEvents && value.events.every(isProcessorEvent)
    && isPositiveInteger(value.requestId)
    && isPositiveInteger(value.epoch)
    && isPositiveInteger(value.sequence)) {
    let previousOffset = -1
    for (const event of value.events) {
      if (event.frameOffset < previousOffset) return null
      previousOffset = event.frameOffset
    }
    return {
      version: portableWasmProtocolVersion,
      type: 'processor-events',
      revision: value.revision,
      requestId: value.requestId,
      epoch: value.epoch,
      sequence: value.sequence,
      events: value.events,
    }
  }
  if (value.type === 'reenable-processor-automation'
    && isPositiveInteger(value.requestId)
    && isPositiveInteger(value.revision)
    && isPositiveInteger(value.epoch)
    && isPositiveInteger(value.processorInstanceId)
    && Array.isArray(value.parameterTargets)
    && value.parameterTargets.length > 0
    && value.parameterTargets.length <= audioCoreMaxProcessorParameterTargets
    && value.parameterTargets.every(isPositiveInteger)) {
    return {
      version: portableWasmProtocolVersion,
      type: 'reenable-processor-automation',
      requestId: value.requestId,
      revision: value.revision,
      epoch: value.epoch,
      processorInstanceId: value.processorInstanceId,
      parameterTargets: value.parameterTargets,
    }
  }
  if (value.type === 'utility-state' && isPositiveInteger(value.revision) && isUtilityState(value.state)) {
    return { version: portableWasmProtocolVersion, type: 'utility-state', revision: value.revision, state: value.state }
  }
  if (value.type === 'instrument-state' && isPositiveInteger(value.revision) && isProtocolString(value.nodeId)
    && value.nodeId.length > 0 && isAudioCoreInstrumentState(value.state)) {
    return { version: portableWasmProtocolVersion, type: 'instrument-state', revision: value.revision, nodeId: value.nodeId, state: value.state }
  }
  if (value.type === 'transport' && isPositiveInteger(value.requestId) && isPositiveInteger(value.epoch) && isProtocolBoolean(value.running)
    && isProtocolNumber(value.frame) && Number.isSafeInteger(value.frame) && value.frame >= 0) {
    return { version: portableWasmProtocolVersion, type: 'transport', requestId: value.requestId, epoch: value.epoch, running: value.running, frame: value.frame }
  }
  if (value.type === 'instrument-events' && isPositiveInteger(value.epoch) && Array.isArray(value.events)
    && value.events.length <= portableWasmMaxInstrumentEvents && value.events.every(isInstrumentEvent)) {
    let previousOffset = -1
    let previousSequence = 0
    for (const event of value.events) {
      if (event.frameOffset < previousOffset || event.sequence <= previousSequence) return null
      previousOffset = event.frameOffset
      previousSequence = event.sequence
    }
    return { version: portableWasmProtocolVersion, type: 'instrument-events', epoch: value.epoch, events: value.events }
  }
  if (value.type === 'install-schedule' && isPositiveInteger(value.requestId)
    && isRecord(value.schedule)
    && Array.isArray(value.schedule.events)
    && value.schedule.events.length <= portableWasmMaxScheduleEvents
    && isPortableFrameSchedule(value.schedule)) {
    return { version: portableWasmProtocolVersion, type: 'install-schedule', requestId: value.requestId, schedule: value.schedule }
  }
  if (value.type === 'schedule-sources' && isPositiveInteger(value.requestId) && isPositiveInteger(value.revision)
    && isPositiveInteger(value.epoch) && Array.isArray(value.events) && value.events.length <= portableWasmMaxPendingEvents
    && value.events.every(isSampleSourceEvent)) {
    let previousSequence = 0
    for (const event of value.events) {
      if (event.epoch !== value.epoch || event.sequence <= previousSequence) return null
      previousSequence = event.sequence
    }
    return { version: portableWasmProtocolVersion, type: 'schedule-sources', requestId: value.requestId, revision: value.revision, epoch: value.epoch, events: value.events }
  }
  if (value.type === 'register-asset'
    && isPositiveInteger(value.requestId)
    && isPositiveInteger(value.generation)
    && isAudioAssetRef(value.asset)
    && isPlanarAsset(value.asset, value.planes)) {
    return {
      version: portableWasmProtocolVersion,
      type: 'register-asset',
      requestId: value.requestId,
      generation: value.generation,
      asset: value.asset,
      planes: value.planes,
    }
  }
  if (value.type === 'release-asset'
    && isPositiveInteger(value.requestId)
    && isPositiveInteger(value.generation)
    && isProtocolString(value.assetId)
    && value.assetId.length > 0) {
    return {
      version: portableWasmProtocolVersion,
      type: 'release-asset',
      requestId: value.requestId,
      generation: value.generation,
      assetId: value.assetId,
    }
  }
  if (value.type === 'retire-assets' && isPositiveInteger(value.generation)) {
    return { version: portableWasmProtocolVersion, type: 'retire-assets', generation: value.generation }
  }
  if (value.type === 'initialize'
    && isPositiveInteger(value.abiVersion)
    && isProtocolString(value.contractHash)
    && isPositiveInteger(value.maxFramesPerBlock)
    && value.maxFramesPerBlock > 0
    && value.maxFramesPerBlock <= 8192) {
    return {
      version: portableWasmProtocolVersion,
      type: 'initialize',
      abiVersion: value.abiVersion,
      contractHash: value.contractHash,
      maxFramesPerBlock: value.maxFramesPerBlock,
    }
  }
  return null
}

export const createPortableWasmInitializeMessage = (
  contractHash: string,
  maxFramesPerBlock: number,
): PortableWasmControlMessage => ({
  version: portableWasmProtocolVersion,
  type: 'initialize',
  abiVersion: audioCoreWasmAbiVersion,
  contractHash,
  maxFramesPerBlock,
})
