import { encodeAudioCoreInstrumentState } from "../../audio-core-contract/src/index"
import type {
  AudioAssetRef,
  AudioCoreGraphSnapshot,
  AudioCoreSampleSourceEventDto,
  AudioCoreInstrumentState,
} from "../../audio-core-contract/src/index"
import type { PortableWasmInstrumentEvent, PortableWasmProcessorEvent } from "./portable-wasm-protocol"
import {
  nativeAudioHostMaximumScheduleAutomationSegments,
  nativeAudioHostMaximumScheduleChunks,
  nativeAudioHostMaximumScheduleInstanceIdBytes,
  nativeAudioHostMaximumScheduleRecords,
} from "@daw-browser/desktop-protocol/native-audio-host"

const graphEnvelopeVersion = 3
const graphEnvelopeVersionExternalLatency = 4
const nativeGraphFrameHeaderBytes = 12
const maximumNativeAssetId = 0xffff_ffff
const nativeTextEncoder = new TextEncoder()

/**
 * The desktop bridge accepts only these portable, path-free session DTOs.
 * Binary fields are already encoded with the serializers in this module.
 */
export type NativeHostDeviceConfiguration = {
  deviceId: string
  sampleRateHz: number
  maxFramesPerBlock: number
  channelCount: number
  revision: number
}

export type NativeHostTransport = {
  epoch: number
  running: boolean
  frame: number
  bpm?: number
  timeSignatureNumerator?: number
  timeSignatureDenominator?: number
  cycleActive?: boolean
  cycleStartSec?: number
  cycleEndSec?: number
  transitionId?: bigint
}

export type NativeHostRecordingConfiguration = {
  deviceUid: string
  generation: number
  sessionId: bigint
  channelCount: 1 | 2
  inputChannels: readonly number[]
  gain: number
  polarity: 1 | -1
  punchStartFrame: number
  punchEndFrame: number | null
  monitoring: boolean
}

export type NativeHostRecordingBlock = {
  generation: number
  sessionId: bigint
  sequence: number
  frameCount: number
  channelCount: 1 | 2
  rms: number
  peak: number
  planarPcm: Uint8Array
}

export type NativeHostRecordingStatus = {
  generation: number
  sessionId: bigint
  timelineFrame: number
  capturedFrames: number
  droppedFrames: number
  droppedBlocks: number
  availableBlocks: number
  queuedBlocks: number
  rms: number
  peak: number
  fatal: boolean
  active: boolean
  configured: boolean
}

export type NativeHostMeterEntry = {
  nodeId: bigint
  leftRms: number
  rightRms: number
}

export type NativeHostMeterBatch = {
  graphRevision: number
  transportEpoch: number
  sequence: bigint
  entries: readonly NativeHostMeterEntry[]
}

export type NativeHostSpectrumFrame = {
  graphRevision: number
  transportEpoch: number
  sequence: bigint
  nodeId: bigint
  sampleRateHz: number
  fftSize: number
  binCount: number
  data: Float32Array
}

export const serializeNativeSpectrumSelection = (nodeId: bigint | null) => {
  if (nodeId !== null && (nodeId <= 0n || nodeId > 0xffff_ffff_ffff_ffffn)) {
    throw new Error("Native spectrum node selection is invalid.")
  }
  const output = new Uint8Array(8)
  new DataView(output.buffer).setBigUint64(0, nodeId ?? 0n)
  return output
}

/**
 * Session-local, planar float32 PCM transferred as raw bytes. No persistent
 * identity, path, handle, or Web Audio object crosses the native boundary.
 */
export type NativeHostPcmAsset = {
  sessionAssetId: number
  frameCount: number
  sampleRateHz: number
  channelCount: number
  planarPcm: Uint8Array
  contentHashPrefix?: Uint8Array
}

export type NativeHostDiagnostics = {
  state: "idle" | "configured" | "running" | "faulted"
  activeRevision: number
  preparedRevision: number
  retiredRevision: number
  transportEpoch: number
  renderEpoch: bigint
  installedAssets: number
  callbacks: number
  rejectedBlocks: number
  lastRejectedReason: number
  lastRejectedCallback: bigint
  lastRejectedRenderEpoch: bigint
  lastRejectedTransportEpoch: number
  lastRejectedCoreResult: number
  lastRejectedFrameCount: number
  lastRejectedChannelCount: number
  lastRejectedProcessorEventCount: number
  lastRejectedInstrumentEventCount: number
  lastRejectedGraphRevision: number
}

export type NativeOutputDevice = {
  deviceId: `coreaudio:${string}`
  name: string
  nominalSampleRateHz: number
  outputChannelCount: number
  maximumFramesPerBlock: number
  available: boolean
}

export type NativeInputDevice = {
  deviceId: string
  name: string
  nominalSampleRateHz: number
  inputChannelCount: number
  maximumFramesPerBlock: number
  available: boolean
}

export const nativeGraphNodeId = (value: string) => {
  let hash = 0xcbf29ce484222325n
  for (const character of value) {
    hash ^= BigInt(character.charCodeAt(0))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash === 0n ? 1n : hash
}

const nodeKind = (kind: AudioCoreGraphSnapshot["nodes"][number]["kind"]) => (
  kind === "source" ? 1 : kind === "instrument" ? 2 : kind === "master" ? 6 : 3
)

const tap = (value: AudioCoreGraphSnapshot["edges"][number]["tap"]) => (
  value === "pre-fx" ? 1 : value === "pre-fader" ? 2 : 3
)

export type NativeInstrumentEvent = Omit<PortableWasmInstrumentEvent, "type"> & {
  type: PortableWasmInstrumentEvent["type"] | "live-note-on" | "live-note-off" | "transport-release" | "all-sound-off"
}

const eventKind = (value: NativeInstrumentEvent["type"]) => {
  switch (value) {
    case "note-on": return 1
    case "note-off": return 2
    case "sustain": return 3
    case "expression": return 4
    case "parameter": return 5
    case "live-note-on": return 101
    case "live-note-off": return 102
    case "transport-release": return 103
    case "all-sound-off": return 104
    default: {
      const exhaustive: never = value
      return exhaustive
    }
  }
}

const writeId = (view: DataView, offset: number, id: string) => view.setBigUint64(offset, nativeGraphNodeId(id), true)

const processorStateUint32 = (state: Uint8Array, offset: number) =>
  state.byteLength >= offset + 4 ? new DataView(state.buffer, state.byteOffset, state.byteLength).getUint32(offset, true) : 0

const processorStateFloat32 = (state: Uint8Array, offset: number) =>
  state.byteLength >= offset + 4 ? new DataView(state.buffer, state.byteOffset, state.byteLength).getFloat32(offset, true) : 0

const processorOutputLayout = (
  processor: AudioCoreGraphSnapshot['nodes'][number]['processorOrder'][number],
  inputLayout: AudioCoreGraphSnapshot['nodes'][number]['inputLayout'],
) => {
  if (processor.bypassed || processorStateUint32(processor.state, 0) === 0) return inputLayout
  if (processor.kind === 'eq' && processorStateUint32(processor.state, 4) === 1) return 'mono'
  if (processor.kind === 'delay' && processorStateUint32(processor.state, 16) === 1) return 'stereo'
  if (processor.kind === 'reverb' && processorStateFloat32(processor.state, 68) > 0) return 'stereo'
  if (processor.kind === 'chorus' || processor.kind === 'flanger' || processor.kind === 'phaser'
    || processor.kind === 'autopan' || processor.kind === 'ensemble') return 'stereo'
  return inputLayout
}

export const nativeProcessorOutputLayoutForState = (
  processor: AudioCoreGraphSnapshot["nodes"][number]["processorOrder"][number],
  inputLayout: AudioCoreGraphSnapshot["nodes"][number]["inputLayout"],
  state: Uint8Array,
) => processorOutputLayout({ ...processor, state }, inputLayout)

export const nativeProcessorLatencyForState = (
  processor: AudioCoreGraphSnapshot["nodes"][number]["processorOrder"][number],
  state: Uint8Array,
) => processor.kind === "spectral" ? processorStateUint32(state, 4) : processor.latencyFrames

export const nativeProcessorLayoutsForState = (
  node: AudioCoreGraphSnapshot["nodes"][number],
  processorId: string,
  state: Uint8Array,
) => {
  let layout = node.inputLayout
  for (const processor of node.processorOrder) {
    const input = layout
    const output = processorOutputLayout({
      ...processor,
      state: processor.id === processorId ? state : processor.state,
    }, input)
    if (processor.id === processorId) return { input, output }
    layout = output
  }
  return undefined
}

/**
 * Native control frames deliberately reuse the portable core's byte envelopes.
 * Only portable projections enter this boundary; file paths and Web Audio
 * objects never cross into the native host.
 */
export const encodePortableGraphEnvelope = (snapshot: AudioCoreGraphSnapshot) => {
  const processorLayouts = new Map<number, { input: 'mono' | 'stereo'; output: 'mono' | 'stereo' }>()
  const processors = snapshot.nodes.flatMap((node) => {
    let layout = node.inputLayout
    return node.processorOrder.map((processor) => {
      const input = layout
      const output = processorOutputLayout(processor, input)
      processorLayouts.set(processor.instanceId, { input, output })
      layout = output
      return { node, processor }
    })
  })
  const hasExternalLatency = snapshot.nodes.some((node) => (
    (node.externalLatencyFrames ?? 0) > 0
  ))
  const hasExtendedNode = hasExternalLatency
  const version = hasExternalLatency ? graphEnvelopeVersionExternalLatency : graphEnvelopeVersion
  const nodeBytes = hasExtendedNode ? 136 : 132
  let byteLength = 24 + snapshot.nodes.length * nodeBytes + snapshot.edges.length * 48
  for (const { processor } of processors) byteLength += 48 + processor.state.byteLength + processor.parameterTargets.length * 4
  const output = new Uint8Array(byteLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, version, true)
  view.setUint32(4, snapshot.revision, true)
  view.setUint32(8, snapshot.nodes.length, true)
  view.setUint32(12, snapshot.edges.length, true)
  view.setUint32(16, processors.length, true)
  let offset = 24
  let sourceBus = 0
  for (const node of snapshot.nodes) {
    writeId(view, offset, node.id)
    view.setUint32(offset + 8, nodeKind(node.kind), true)
    view.setUint32(offset + 12, node.inputLayout === "mono" ? 1 : 2, true)
    view.setUint32(offset + 16, node.outputLayout === "mono" ? 1 : 2, true)
    view.setUint32(offset + 20, node.kind === "source" ? sourceBus++ : 0, true)
    view.setUint32(offset + 24, node.latencyFrames, true)
    const instrumentOffset = hasExtendedNode ? offset + 32 : offset + 28
    if (hasExtendedNode) {
      view.setUint32(offset + 28, node.externalLatencyFrames ?? 0, true)
    }
    const instrument = node.kind === "instrument" ? node.instrument : undefined
    view.setUint32(instrumentOffset, instrument?.kind === 'synth' ? 1 : instrument?.kind === 'sampler' ? 2 : instrument?.kind === 'drum-rack' ? 3 : instrument?.kind === 'granular' ? 4 : 0, true)
    view.setUint32(instrumentOffset + 4, instrument?.version ?? 0, true)
    view.setUint32(instrumentOffset + 8, instrument?.voiceCapacity ?? 0, true)
    view.setUint32(instrumentOffset + 12, instrument?.kind === 'synth' ? instrument.parameterTargets.length : 0, true)
    for (let index = 0; index < 16; index++) view.setUint32(instrumentOffset + 16 + index * 4, instrument?.kind === 'synth' ? instrument.parameterTargets[index]?.target ?? 0 : 0, true)
    const mixer = node.mixer
    const mixerOffset = instrumentOffset + 80
    view.setBigUint64(mixerOffset, BigInt(mixer?.instanceId ?? 0), true)
    view.setFloat32(mixerOffset + 8, mixer?.gain ?? 0, true)
    view.setFloat32(mixerOffset + 12, mixer?.pan ?? 0, true)
    view.setUint32(mixerOffset + 16, mixer?.muted ? 1 : 0, true)
    view.setUint32(mixerOffset + 20, mixer?.soloed ? 1 : 0, true)
    offset += nodeBytes
  }
  for (const edge of snapshot.edges) {
    writeId(view, offset, edge.id)
    writeId(view, offset + 8, edge.fromNodeId)
    writeId(view, offset + 16, edge.toNodeId)
    view.setBigUint64(offset + 24, edge.targetProcessorId ? nativeGraphNodeId(edge.targetProcessorId) : 0n, true)
    view.setFloat32(offset + 32, edge.gain, true)
    view.setUint32(offset + 36, tap(edge.tap), true)
    view.setUint32(offset + 40, edge.sidechain ? 1 : 0, true)
    view.setUint32(offset + 44, edge.pdcDelayFrames, true)
    offset += 48
  }
  for (const { node, processor } of processors) {
    const layout = processorLayouts.get(processor.instanceId)
    if (!layout) throw new Error(`Missing portable layout for processor ${processor.instanceId}.`)
    writeId(view, offset, node.id)
    view.setUint32(offset + 8, processor.kindId, true)
    view.setUint32(offset + 12, processor.stateVersion, true)
    view.setUint32(offset + 16, processor.state.byteLength, true)
    view.setUint32(offset + 20, processor.instanceId, true)
    view.setUint32(offset + 24, processor.bypassed ? 1 : 0, true)
    view.setUint32(offset + 28, layout.input === "mono" ? 1 : 2, true)
    view.setUint32(offset + 32, layout.output === "mono" ? 1 : 2, true)
    view.setUint32(offset + 36, processor.parameterTargets.length, true)
    view.setUint32(offset + 40, processor.latencyFrames, true)
    view.setUint32(offset + 44, processor.tailKind === 'unbounded' ? 0xffffffff : processor.tailFrames, true)
    output.set(processor.state, offset + 48)
    offset += 48 + processor.state.byteLength
    for (const target of processor.parameterTargets) {
      view.setUint32(offset, target.target, true)
      offset += 4
    }
  }
  return output
}

export const serializeNativeGraph = (snapshot: AudioCoreGraphSnapshot) => {
  const output = encodePortableGraphEnvelope(snapshot)
  const frame = new Uint8Array(nativeGraphFrameHeaderBytes + output.byteLength)
  const frameView = new DataView(frame.buffer)
  frameView.setBigUint64(0, BigInt(snapshot.revision), false)
  frameView.setUint32(8, output.byteLength, false)
  frame.set(output, nativeGraphFrameHeaderBytes)
  return frame
}

export type NativeProcessorStatePatch = {
  graphRevision: number
  nodeId: string
  instanceId: number
  kindId: number
  stateVersion: number
  state: Uint8Array
  bypassed: boolean
  inputLayout: "mono" | "stereo"
  outputLayout: "mono" | "stereo"
  parameterTargets: readonly number[]
  latencyFrames: number
  tailFrames: number
}

export const serializeNativeProcessorStatePatch = (patch: NativeProcessorStatePatch) => {
  if (
    !Number.isSafeInteger(patch.graphRevision) || patch.graphRevision <= 0 || patch.graphRevision > 0xffff_ffff
    || !Number.isSafeInteger(patch.instanceId) || patch.instanceId <= 0 || patch.instanceId > 0xffff_ffff
    || !Number.isSafeInteger(patch.kindId) || patch.kindId <= 0 || patch.kindId > 0xffff_ffff
    || !Number.isSafeInteger(patch.stateVersion) || patch.stateVersion <= 0 || patch.stateVersion > 0xffff_ffff
    || patch.state.byteLength > 256
    || patch.parameterTargets.length > 24
    || !patch.parameterTargets.every((target) => Number.isSafeInteger(target) && target > 0 && target <= 0xffff_ffff)
    || !Number.isSafeInteger(patch.latencyFrames) || patch.latencyFrames < 0 || patch.latencyFrames > 0xffff_ffff
    || !Number.isSafeInteger(patch.tailFrames) || patch.tailFrames < 0 || patch.tailFrames > 0xffff_ffff
  ) throw new Error("Native processor state patch is invalid.")
  const output = new Uint8Array(56 + patch.state.byteLength + patch.parameterTargets.length * 4)
  const view = new DataView(output.buffer)
  view.setUint32(0, 1, true)
  view.setUint32(4, patch.graphRevision, true)
  view.setBigUint64(8, nativeGraphNodeId(patch.nodeId), true)
  view.setUint32(16, patch.instanceId, true)
  view.setUint32(20, patch.kindId, true)
  view.setUint32(24, patch.stateVersion, true)
  view.setUint32(28, patch.state.byteLength, true)
  view.setUint32(32, patch.bypassed ? 1 : 0, true)
  view.setUint32(36, patch.inputLayout === "mono" ? 1 : 2, true)
  view.setUint32(40, patch.outputLayout === "mono" ? 1 : 2, true)
  view.setUint32(44, patch.parameterTargets.length, true)
  view.setUint32(48, patch.latencyFrames, true)
  view.setUint32(52, patch.tailFrames, true)
  output.set(patch.state, 56)
  patch.parameterTargets.forEach((target, index) => {
    view.setUint32(56 + patch.state.byteLength + index * 4, target, true)
  })
  return output
}

export type NativeProcessorEventBatch = {
  revision: number
  epoch: number
  sequence: number
}

export const serializeNativeProcessorEvents = (
  events: readonly PortableWasmProcessorEvent[],
  batch?: NativeProcessorEventBatch,
) => {
  const headerBytes = batch ? 20 : 4
  const output = new Uint8Array(headerBytes + events.length * 20)
  const view = new DataView(output.buffer)
  view.setUint32(0, events.length, true)
  if (batch) {
    view.setUint32(4, batch.revision, true)
    view.setUint32(8, batch.epoch, true)
    view.setBigUint64(12, BigInt(batch.sequence), true)
  }
  let offset = headerBytes
  for (const event of events) {
    view.setBigUint64(offset, BigInt(event.processorInstanceId), true)
    view.setUint32(offset + 8, event.parameterTarget, true)
    view.setUint32(offset + 12, event.frameOffset, true)
    view.setFloat32(offset + 16, event.value, true)
    offset += 20
  }
  return output
}

export type NativeVstParameterEvent = {
  id: number
  value: number
  sampleOffset: number
}

export const serializeNativeVstParameterEvents = (
  instanceId: string,
  events: readonly NativeVstParameterEvent[],
) => {
  const instanceBytes = nativeTextEncoder.encode(instanceId)
  if (instanceBytes.byteLength === 0 || instanceBytes.byteLength > 256 || events.length > 2_048) {
    throw new Error("Native VST3 parameter event payload exceeds its bounds.")
  }
  const output = new Uint8Array(4 + instanceBytes.byteLength + 4 + events.length * 16)
  const view = new DataView(output.buffer)
  view.setUint32(0, instanceBytes.byteLength, true)
  output.set(instanceBytes, 4)
  let offset = 4 + instanceBytes.byteLength
  view.setUint32(offset, events.length, true)
  offset += 4
  for (const event of events) {
    if (!Number.isInteger(event.id) || event.id < 0 || event.id > 0xffff_ffff
      || !Number.isInteger(event.sampleOffset) || event.sampleOffset < 0 || event.sampleOffset >= 8_192
      || !Number.isFinite(event.value) || event.value < 0 || event.value > 1) {
      throw new Error("Native VST3 parameter event is invalid.")
    }
    view.setUint32(offset, event.id, true)
    view.setUint32(offset + 4, event.sampleOffset, true)
    view.setFloat64(offset + 8, event.value, true)
    offset += 16
  }
  return output
}

export const serializeNativeInstrumentEvents = (epoch: number, events: readonly NativeInstrumentEvent[]) => {
  // Immediate native live events use a block-relative frameOffset. Scheduled
  // events carry their absolute frame in the schedule-window envelope.
  if (!Number.isInteger(epoch) || epoch <= 0 || epoch > 0xffff_ffff || events.length > 2_048) {
    throw new Error("Native instrument event payload exceeds its bounds.")
  }
  const output = new Uint8Array(4 + events.length * 48)
  const view = new DataView(output.buffer)
  view.setUint32(0, events.length, true)
  let offset = 4
  for (const event of events) {
    const noteEvent = event.type === "note-on" || event.type === "note-off"
      || event.type === "live-note-on" || event.type === "live-note-off"
    if (!Number.isSafeInteger(event.noteId) || event.noteId <= 0
      || !Number.isSafeInteger(event.sequence) || event.sequence <= 0
      || !Number.isSafeInteger(event.frameOffset) || event.frameOffset < 0 || event.frameOffset > 0xffff_ffff
      || !Number.isInteger(event.channel) || event.channel < 0 || event.channel > 15
      || (noteEvent && (!Number.isInteger(event.note) || event.note < 0 || event.note > 127
        || !Number.isFinite(event.value) || event.value < 0 || event.value > 1))
      || !Number.isFinite(event.value)) {
      throw new Error("Native instrument event is invalid.")
    }
    writeId(view, offset, event.nodeId)
    view.setBigUint64(offset + 8, BigInt(event.noteId), true)
    view.setBigUint64(offset + 16, BigInt(event.sequence), true)
    view.setUint32(offset + 24, epoch, true)
    view.setUint32(offset + 28, event.frameOffset, true)
    view.setUint32(offset + 32, eventKind(event.type), true)
    view.setUint32(offset + 36, event.channel, true)
    view.setUint32(offset + 40, event.note, true)
    view.setFloat32(offset + 44, event.value, true)
    offset += 48
  }
  return output
}

export type NativeScheduleWindow = {
  revision: number
  epoch: number
  windowId?: number
  startFrame: number
  endFrame: number
  chunkIndex?: number
  chunkCount?: number
  endsSchedule?: boolean
  instrumentEvents?: readonly NativeInstrumentEvent[]
  sampleSourceEvents?: readonly NativeSourceEvent[]
  vstAutomationSegments?: readonly NativeVstAutomationSegment[]
  assets?: readonly NativeSessionAsset[]
}

export type NativeVstAutomationSegment = {
  instanceId: string
  parameterId: number
  startFrame: number
  endFrame: number
  startValue: number
  endValue: number
  interpolation: "linear" | "hold"
}

export type NativeScheduleProgress = {
  revision: number
  epoch: number
  progressSequence: bigint
  renderedThroughFrame: bigint
  acceptedThroughFrame: bigint
  lastAcceptedWindowId: bigint
  appliedTransportTransitionId: bigint
  appliedUrgentSequence: bigint
  appliedProcessorSequence: bigint
  running: boolean
  scheduleComplete: boolean
  instrumentCredits: number
  sourceCredits: number
  automationCredits: number
}

export const serializeNativeScheduleWindow = (window: NativeScheduleWindow) => {
  const instrumentEvents = window.instrumentEvents ?? []
  const sampleSourceEvents = window.sampleSourceEvents ?? []
  const vstAutomationSegments = window.vstAutomationSegments ?? []
  const encodedInstanceIds = vstAutomationSegments.map((segment) => nativeTextEncoder.encode(segment.instanceId))
  const windowId = window.windowId ?? 1
  const chunkIndex = window.chunkIndex ?? 0
  const chunkCount = window.chunkCount ?? 1
  const endsSchedule = window.endsSchedule ?? true
  if (
    !Number.isSafeInteger(window.revision) || window.revision <= 0 || window.revision > 0xffff_ffff
    || !Number.isSafeInteger(window.epoch) || window.epoch <= 0 || window.epoch > 0xffff_ffff
    || !Number.isSafeInteger(window.startFrame) || window.startFrame < 0
    || !Number.isSafeInteger(window.endFrame) || window.endFrame <= window.startFrame
    || !Number.isSafeInteger(windowId) || windowId <= 0
    || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0
    || !Number.isSafeInteger(chunkCount) || chunkCount <= 0
    || chunkCount > nativeAudioHostMaximumScheduleChunks
    || chunkIndex >= chunkCount
    || instrumentEvents.length + sampleSourceEvents.length + vstAutomationSegments.length
      > nativeAudioHostMaximumScheduleRecords
    || instrumentEvents.length > 256
    || sampleSourceEvents.length > 256
    || vstAutomationSegments.length > nativeAudioHostMaximumScheduleAutomationSegments
    || instrumentEvents.some((event) => event.frameOffset < window.startFrame || event.frameOffset >= window.endFrame)
    || sampleSourceEvents.some((event) => event.startFrame < window.startFrame || event.startFrame >= window.endFrame)
    || vstAutomationSegments.some((segment, index) => (
      !Number.isInteger(segment.parameterId) || segment.parameterId < 0 || segment.parameterId > 0xffff_ffff
      || !Number.isSafeInteger(segment.startFrame) || segment.startFrame < window.startFrame
      || !Number.isSafeInteger(segment.endFrame) || segment.endFrame <= segment.startFrame
      || segment.endFrame > window.endFrame
      || !Number.isFinite(segment.startValue) || segment.startValue < 0 || segment.startValue > 1
      || !Number.isFinite(segment.endValue) || segment.endValue < 0 || segment.endValue > 1
      || (segment.interpolation !== "linear" && segment.interpolation !== "hold")
      || encodedInstanceIds[index]?.byteLength === 0
      || (encodedInstanceIds[index]?.byteLength ?? 0) > nativeAudioHostMaximumScheduleInstanceIdBytes
    ))
  ) throw new Error("Native schedule window is invalid.")
  const instrumentBytes = serializeNativeInstrumentEvents(window.epoch, instrumentEvents)
  const sourceBytes = serializeNativeSourceEvents(sampleSourceEvents, window.assets ?? [])
  const automationBytes = encodedInstanceIds.reduce((total, instanceBytes) => total + 44 + instanceBytes.byteLength, 0)
  const output = new Uint8Array(56 + instrumentBytes.byteLength - 4 + sourceBytes.byteLength - 4 + automationBytes)
  const view = new DataView(output.buffer)
  view.setUint32(0, window.revision, true)
  view.setUint32(4, window.epoch, true)
  view.setBigUint64(8, BigInt(windowId), true)
  view.setBigUint64(16, BigInt(window.startFrame), true)
  view.setBigUint64(24, BigInt(window.endFrame), true)
  view.setUint32(32, chunkIndex, true)
  view.setUint32(36, chunkCount, true)
  view.setUint32(40, endsSchedule ? 1 : 0, true)
  view.setUint32(44, instrumentEvents.length, true)
  view.setUint32(48, sampleSourceEvents.length, true)
  view.setUint32(52, vstAutomationSegments.length, true)
  let offset = 56
  output.set(instrumentBytes.subarray(4), offset)
  offset += instrumentBytes.byteLength - 4
  output.set(sourceBytes.subarray(4), offset)
  offset += sourceBytes.byteLength - 4
  for (const [index, segment] of vstAutomationSegments.entries()) {
    const encodedInstance = encodedInstanceIds[index]
    view.setUint32(offset, encodedInstance.byteLength, true)
    offset += 4
    output.set(encodedInstance, offset)
    offset += encodedInstance.byteLength
    view.setUint32(offset, segment.parameterId, true)
    offset += 4
    view.setBigUint64(offset, BigInt(segment.startFrame), true)
    offset += 8
    view.setBigUint64(offset, BigInt(segment.endFrame), true)
    offset += 8
    view.setFloat64(offset, segment.startValue, true)
    offset += 8
    view.setFloat64(offset, segment.endValue, true)
    offset += 8
    view.setUint32(offset, segment.interpolation === "linear" ? 1 : 0, true)
    offset += 4
  }
  return output
}

export const serializeNativeVstScheduleAutomationEnable = (
  instanceId: string,
  parameterIds: readonly number[],
) => {
  const instanceBytes = nativeTextEncoder.encode(instanceId)
  if (
    instanceBytes.byteLength === 0
    || instanceBytes.byteLength > nativeAudioHostMaximumScheduleInstanceIdBytes
    || parameterIds.length > nativeAudioHostMaximumScheduleAutomationSegments
    || parameterIds.some((id) => !Number.isInteger(id) || id < 0 || id > 0xffff_ffff)
  ) throw new Error("Native VST schedule automation enable payload is invalid.")
  const output = new Uint8Array(8 + instanceBytes.byteLength + parameterIds.length * 4)
  const view = new DataView(output.buffer)
  view.setUint32(0, instanceBytes.byteLength, true)
  output.set(instanceBytes, 4)
  view.setUint32(4 + instanceBytes.byteLength, parameterIds.length, true)
  parameterIds.forEach((id, index) => view.setUint32(8 + instanceBytes.byteLength + index * 4, id, true))
  return output
}

export type NativeAssetIdentity = Pick<AudioAssetRef, "assetId" | "frameCount" | "sampleRateHz" | "channelCount">

export type NativeSessionAsset = {
  asset: AudioAssetRef
  sessionAssetId: number
}

export type NativeInstrumentState = {
  nodeId: string
  state: AudioCoreInstrumentState
}

export const serializeNativeInstrumentStates = (
  instruments: readonly NativeInstrumentState[],
  assets: readonly NativeSessionAsset[],
) => {
  const sessionAssetIds = new Map(assets.map(({ asset, sessionAssetId }) => [asset.assetId, sessionAssetId]))
  const resolveAssetHandle = (assetId: string) => {
    const sessionAssetId = sessionAssetIds.get(assetId)
    if (sessionAssetId === undefined) throw new Error(`Native instrument asset "${assetId}" is not staged.`)
    return 0x1_0000_0000n | BigInt(sessionAssetId)
  }
  const encoded = instruments.map(({ nodeId, state }) => {
    try {
      return {
        nodeId,
        kind: state.kind,
        state: encodeAudioCoreInstrumentState(state, resolveAssetHandle),
      }
    } catch (error) {
      const detail = state.kind === 'synth'
        ? `ampReleaseMs=${state.ampReleaseMs}, keys=${Object.keys(state).join(',')}`
        : `keys=${Object.keys(state).join(',')}`
      throw new Error(`Invalid native instrument state for node "${nodeId}" (${state.kind}; ${detail}).`, { cause: error })
    }
  })
  const byteLength = 4 + encoded.reduce((total, entry) => (
    total + 24 + entry.state.state.byteLength + (entry.state.zones?.byteLength ?? 0)
  ), 0)
  const output = new Uint8Array(byteLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, encoded.length, true)
  let offset = 4
  for (const entry of encoded) {
    view.setBigUint64(offset, nativeGraphNodeId(entry.nodeId), true)
    view.setUint32(offset + 8, entry.kind === "synth" ? 1 : entry.kind === "sampler" ? 2 : entry.kind === "drum-rack" ? 3 : 4, true)
    view.setUint32(offset + 12, entry.state.state.byteLength, true)
    view.setUint32(offset + 16, entry.state.zones?.byteLength ?? 0, true)
    view.setUint32(offset + 20, 0, true)
    offset += 24
    output.set(entry.state.state, offset)
    offset += entry.state.state.byteLength
    if (entry.state.zones) {
      output.set(entry.state.zones, offset)
      offset += entry.state.zones.byteLength
    }
  }
  return output
}

/**
 * Native asset identifiers are never persisted. Sorting the stable
 * AudioAssetRef.assetId makes independently rebuilt session snapshots wire-equal.
 */
export const mapNativeSessionAssets = (assets: readonly AudioAssetRef[]): readonly NativeSessionAsset[] => {
  const unique = new Map<string, AudioAssetRef>()
  for (const asset of assets) {
    const existing = unique.get(asset.assetId)
    if (existing && (
      existing.frameCount !== asset.frameCount
      || existing.sampleRateHz !== asset.sampleRateHz
      || existing.channelCount !== asset.channelCount
    )) throw new Error(`Conflicting native session asset identity: ${asset.assetId}`)
    unique.set(asset.assetId, asset)
  }
  const sorted = [...unique.entries()].sort(([left], [right]) => left.localeCompare(right))
  if (sorted.length > maximumNativeAssetId) throw new Error("Native session asset capacity exceeded.")
  return sorted.map(([, asset], index) => ({ asset, sessionAssetId: index + 1 }))
}

export const nativeAssetIdentity = (asset: AudioAssetRef): NativeAssetIdentity => ({
  assetId: asset.assetId,
  frameCount: asset.frameCount,
  sampleRateHz: asset.sampleRateHz,
  channelCount: asset.channelCount,
})

export type NativeSourceEvent = Pick<AudioCoreSampleSourceEventDto,
  "epoch" | "sequence" | "sourceNodeId" | "assetId" | "startFrame" | "stopFrame" | "sourceOffsetFrame" | "sourceOffsetFraction" | "sourceFrameCount" | "gain" | "fadeInStartFrame" | "fadeInEndFrame" | "fadeOutStartFrame" | "fadeOutEndFrame">

export const serializeNativeSourceEvents = (
  events: readonly NativeSourceEvent[],
  assets: readonly NativeSessionAsset[],
) => {
  const assetIds = new Map(assets.map(({ asset, sessionAssetId }) => [asset.assetId, sessionAssetId]))
  const output = new Uint8Array(4 + events.length * 96)
  const view = new DataView(output.buffer)
  view.setUint32(0, events.length, true)
  let offset = 4
  for (const event of events) {
    const assetId = assetIds.get(event.assetId)
    if (assetId === undefined) throw new Error(`Native session asset is missing: ${event.assetId}`)
    view.setUint32(offset, event.epoch, true)
    view.setBigUint64(offset + 4, BigInt(event.sequence), true)
    writeId(view, offset + 12, event.sourceNodeId)
    view.setUint32(offset + 20, assetId, true)
    view.setBigInt64(offset + 24, BigInt(event.startFrame), true)
    view.setBigInt64(offset + 32, BigInt(event.stopFrame), true)
    view.setBigUint64(offset + 40, BigInt(event.sourceOffsetFrame), true)
    view.setBigUint64(offset + 48, BigInt(event.sourceFrameCount), true)
    view.setFloat32(offset + 56, event.gain, true)
    view.setBigInt64(offset + 60, BigInt(event.fadeInStartFrame), true)
    view.setBigInt64(offset + 68, BigInt(event.fadeInEndFrame), true)
    view.setBigInt64(offset + 76, BigInt(event.fadeOutStartFrame), true)
    view.setBigInt64(offset + 84, BigInt(event.fadeOutEndFrame), true)
    view.setFloat32(offset + 92, event.sourceOffsetFraction ?? 0, true)
    offset += 96
  }
  return output
}
