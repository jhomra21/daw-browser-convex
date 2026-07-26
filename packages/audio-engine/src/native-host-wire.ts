import type {
  AudioAssetRef,
  AudioCoreGraphSnapshot,
  AudioCoreSampleSourceEventDto,
} from "../../audio-core-contract/src/index"
import type { PortableWasmInstrumentEvent, PortableWasmProcessorEvent } from "./portable-wasm-protocol"

const graphEnvelopeVersion = 3
const nativeGraphFrameHeaderBytes = 12
const maximumNativeAssetId = 0xffff_ffff

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

const eventKind = (value: PortableWasmInstrumentEvent["type"]) => (
  value === "note-on" ? 1 : value === "note-off" ? 2 : value === "sustain" ? 3 : 4
)

const writeId = (view: DataView, offset: number, id: string) => view.setBigUint64(offset, nativeGraphNodeId(id), true)

/**
 * Native control frames deliberately reuse the portable core's byte envelopes.
 * Only portable projections enter this boundary; file paths and Web Audio
 * objects never cross into the native host.
 */
export const encodePortableGraphEnvelope = (snapshot: AudioCoreGraphSnapshot) => {
  const processors = snapshot.nodes.flatMap((node) => node.processorOrder.map((processor) => ({ node, processor })))
  let byteLength = 24 + snapshot.nodes.length * 132 + snapshot.edges.length * 48
  for (const { processor } of processors) byteLength += 48 + processor.state.byteLength + processor.parameterTargets.length * 4
  const output = new Uint8Array(byteLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, graphEnvelopeVersion, true)
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
    const instrument = node.kind === "instrument" ? node.instrument : undefined
    view.setUint32(offset + 28, instrument?.kind === 'synth' ? 1 : instrument?.kind === 'sampler' ? 2 : instrument?.kind === 'drum-rack' ? 3 : instrument?.kind === 'granular' ? 4 : 0, true)
    view.setUint32(offset + 32, instrument?.version ?? 0, true)
    view.setUint32(offset + 36, instrument?.voiceCapacity ?? 0, true)
    view.setUint32(offset + 40, instrument?.kind === 'synth' ? instrument.parameterTargets.length : 0, true)
    for (let index = 0; index < 16; index += 1) view.setUint32(offset + 44 + index * 4, instrument?.kind === 'synth' ? instrument.parameterTargets[index]?.target ?? 0 : 0, true)
    const mixer = node.mixer
    view.setBigUint64(offset + 108, BigInt(mixer?.instanceId ?? 0), true)
    view.setFloat32(offset + 116, mixer?.gain ?? 0, true)
    view.setFloat32(offset + 120, mixer?.pan ?? 0, true)
    view.setUint32(offset + 124, mixer?.muted ? 1 : 0, true)
    view.setUint32(offset + 128, mixer?.soloed ? 1 : 0, true)
    offset += 132
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
    writeId(view, offset, node.id)
    view.setUint32(offset + 8, processor.kindId, true)
    view.setUint32(offset + 12, processor.stateVersion, true)
    view.setUint32(offset + 16, processor.state.byteLength, true)
    view.setUint32(offset + 20, processor.instanceId, true)
    view.setUint32(offset + 24, processor.bypassed ? 1 : 0, true)
    view.setUint32(offset + 28, node.inputLayout === "mono" ? 1 : 2, true)
    view.setUint32(offset + 32, node.outputLayout === "mono" ? 1 : 2, true)
    view.setUint32(offset + 36, processor.parameterTargets.length, true)
    view.setUint32(offset + 40, processor.latencyFrames, true)
    view.setUint32(offset + 44, processor.tailFrames, true)
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

export const serializeNativeProcessorEvents = (events: readonly PortableWasmProcessorEvent[]) => {
  const output = new Uint8Array(4 + events.length * 20)
  const view = new DataView(output.buffer)
  view.setUint32(0, events.length, true)
  let offset = 4
  for (const event of events) {
    view.setBigUint64(offset, BigInt(event.processorInstanceId), true)
    view.setUint32(offset + 8, event.parameterTarget, true)
    view.setUint32(offset + 12, event.frameOffset, true)
    view.setFloat32(offset + 16, event.value, true)
    offset += 20
  }
  return output
}

export const serializeNativeInstrumentEvents = (epoch: number, events: readonly PortableWasmInstrumentEvent[]) => {
  const output = new Uint8Array(4 + events.length * 48)
  const view = new DataView(output.buffer)
  view.setUint32(0, events.length, true)
  let offset = 4
  for (const event of events) {
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

export type NativeAssetIdentity = Pick<AudioAssetRef, "assetId" | "frameCount" | "sampleRateHz" | "channelCount">

export type NativeSessionAsset = {
  asset: AudioAssetRef
  sessionAssetId: number
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
  "epoch" | "sequence" | "sourceNodeId" | "assetId" | "startFrame" | "stopFrame" | "sourceOffsetFrame" | "sourceFrameCount" | "gain" | "fadeInStartFrame" | "fadeInEndFrame" | "fadeOutStartFrame" | "fadeOutEndFrame">

export const serializeNativeSourceEvents = (
  events: readonly NativeSourceEvent[],
  assets: readonly NativeSessionAsset[],
) => {
  const assetIds = new Map(assets.map(({ asset, sessionAssetId }) => [asset.assetId, sessionAssetId]))
  const output = new Uint8Array(4 + events.length * 92)
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
    offset += 92
  }
  return output
}
