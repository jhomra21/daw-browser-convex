import { compileLiveNativeProjection, resolveMixerTiming, type LiveNativeProjection } from "@daw-browser/audio-engine/live-native-projection"
import { effectiveLoopForStart } from "@daw-browser/audio-engine/loop-frame-schedule"
import { NativePlaybackAbortError } from "./native-playback-abort"
import { nativeExternalLatencyFrames as nativeOfflineExternalLatencyFrames } from "~/lib/export/native-offline-render-plan"
import {
  nativeAudioHostMaximumInstalledAssets,
  nativeKeepLatencyDivergentMixedBusDiagnostic,
} from "@daw-browser/desktop-protocol/native-audio-host"
import {
  mapNativeSessionAssets,
  serializeNativeGraph,
  serializeNativeProcessorStatePatch,
  nativeProcessorLatencyForState,
  nativeProcessorLayoutsForState,
  nativeProcessorOutputLayoutForState,
  serializeNativeInstrumentStates,
  serializeNativeInstrumentEvents,
  serializeNativeProcessorEvents,
  serializeNativeVstParameterEvents,
  nativeGraphNodeId,
} from "@daw-browser/audio-engine/native-host-wire"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import { compilePortableSynthState } from "@daw-browser/audio-engine/mixer/graph-contract"
import { resolveLiveMixerGraph } from "@daw-browser/audio-engine/live-mixer-runtime"
import type { NativeRevisionReply, NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision"
import { type AudioPcmSourceDescriptor, type TrackInstrumentParams, parseExternalAutomationParameterId, parseJsonValue } from "@daw-browser/shared"
import { createAudioEffectParameterPayload } from "~/components/timeline/audio-effect-parameter-payload"
import { captureNativeBuiltInParameterValues, encodeNativeBuiltInStateCommit, nativeBuiltInPatchTiming } from "./native-built-in-parameter-mapper"
import {
  prepareNativeStretchArtifacts,
  type NativePreparedStretchAsset,
} from "@daw-browser/audio-engine/native-stretch-preparation"
import { createAudioStretchCache, type AudioStretchCacheOptions } from "@daw-browser/audio-engine/audio-stretch-cache"
import {
  createPreparedStretchArtifactRepository,
  type PreparedStretchArtifactRepository,
} from "@daw-browser/audio-engine/prepared-stretch-store"
import type { NativePcmChunkDescriptor } from "@daw-browser/audio-engine/native-pcm-chunking"
import {
  createAudioPcmSourceDescriptor,
} from "@daw-browser/audio-engine/media-pages"
import type { SpectrumFrame, TrackStereoLevels, TrackStereoLevelsBatch } from "@daw-browser/audio-engine/audio-engine"
import type {
  NativeHostDeviceConfiguration,
  NativeHostTransport,
  NativeHostMeterBatch,
  NativeHostSpectrumFrame,
  NativeHostRecordingStatus,
  NativeInstrumentEvent,
  NativeSessionAsset,
  NativeScheduleProgress,
} from "@daw-browser/audio-engine/native-host-wire"
import type { AudioCoreGraphSnapshot, AudioCoreSynthState } from "@daw-browser/audio-core-contract"
import { encodeNativeExternalAttachmentPlan, maxVst3WorkerFrames } from "@daw-browser/plugin-host-protocol"
import type {
  LivePlaybackCompileContext,
  LivePlaybackSnapshot,
  LivePlaybackSnapshotCompilation,
  LivePlaybackTransport,
} from "~/lib/live-playback-snapshot"
import { importNativeRecordingSpool } from "~/lib/recording/native-spool-importer"
import type { RecordingTerminationCause } from "~/lib/recording/recording-diagnostics"
import type { DesktopVstInstanceEvent } from "@daw-browser/desktop-protocol"
import type { DesktopBridge, NativeDeliveryReply, NativeProcessorPatchReply } from "~/types/desktop-bridge"
import { clearVstInstanceFailures, markVstInstanceFailed } from "./vst-instance-failures"
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import {
  SYNTH_KIND_ID,
  nativeInstrumentContentKey,
  nativeSynthValues,
  type DeliveryRegistration,
  type DesiredInstrument,
  type LiveProcessorControlRequest,
  type LiveProcessorControlResult,
  type LiveProcessorEditIdentity,
  type ProcessorDelivery,
  type ProcessorDeliveryOutcome,
  type PublicationJoin,
} from "~/lib/live-processor-control"
import {
  arrangementFrameForNativeFrame,
  createNativeScheduleCoordinator,
  nativeLoopFramesForSnapshot,
  type NativeScheduleCoordinator,
} from "./native-schedule-coordinator"
import {
  createNativeProcessorStateOwner,
  patchProcessorDesired,
  projectedProcessorDesired,
  timedProcessorDesired,
  type AdoptionAttempt,
  type AdoptionFields,
  type AdoptionIntent,
  type AdoptionOutcome,
  type AdoptionStart,
  type Execution,
  type ExecutionRetention,
  type InstalledContent,
  type PatchReply,
  type ProcessorReconcile,
  type ProcessorDesired,
  type Receipt,
  type RetirementObligation,
  receiptHandle,
} from "./native-processor-state-owner"
import { createNativeTimelinePageManager, type NativeTimelinePageManager, type NativeTimelineSource } from "./native-timeline-page-manager"
import { createSampledInstrumentRegionBudget, type SampledInstrumentRegionBudget, type SampledInstrumentRegionBudgetScope } from "~/lib/sampled-instrument-region-budget"
import type { NativeInstrumentPreparation } from "./native-instrument-budget-policy"

type NativeSessionReply = { ok: true } | { ok: false; error: string }
type NativePreviewAttempt = { orphanedAssetIds?: readonly number[] }

export type NativeLiveMidiNoteHandle = {
  backend: "native"
  trackId: string
  pitch: number
  noteId: number
}

type NativePlaybackDiagnosticFailure = Error | string | null | undefined

const sanitizeNativeVst3DiagnosticError = (error: NativePlaybackDiagnosticFailure) => {
  const message = error instanceof Error
    ? error.message
    : error ?? "Native playback could not start."
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256)
}

const indicatesNativeHostConnectionLoss = (error: NativePlaybackDiagnosticFailure) => {
  const message = sanitizeNativeVst3DiagnosticError(error).toLowerCase()
  return message.includes("native playback host connection was lost")
    || message.includes("native audio host is unavailable")
    || message.includes("native audio host stopped")
    || message.includes("host connection was lost")
    || message.includes("host connection closed")
}

// The track node of every synth instance of a snapshot: owner targets for a
// synth are keyed by its instance id, like its edit identity and its requests.
const synthNodes = (snapshot: LivePlaybackSnapshot | undefined) => new Map(
  Object.entries(snapshot?.mixer.fx.trackFx ?? {}).flatMap(([nodeId, fx]): [string, string][] =>
    fx.instrument?.kind === "synth" ? [[fx.instrument.instanceId, nodeId]] : []))

const sampledKindId = (kind: "sampler" | "granular" | "drum-rack") =>
  kind === "sampler" ? 19 : kind === "granular" ? 20 : 21

// The owner's target kinds at a publication: processors by id and the synths
// whose track node carries an instrument.
const targetKinds = (graph: AudioCoreGraphSnapshot, snapshot: LivePlaybackSnapshot | undefined) => {
  const instrumentNodes = new Set(graph.nodes.flatMap((node) => node.instrument ? [node.id] : []))
  return new Map<string, number>([
    ...graph.nodes.flatMap((node) => node.processorOrder.map((processor): [string, number] => [processor.id, processor.kindId])),
    ...[...synthNodes(snapshot)].flatMap(([instanceId, nodeId]): [string, number][] =>
      instrumentNodes.has(nodeId) ? [[instanceId, SYNTH_KIND_ID]] : []),
    ...graph.nodes.flatMap((node): [string, number][] => {
      const instrument = snapshot?.mixer.fx.trackFx?.[node.id]?.instrument
      return instrument && instrument.kind !== "synth" && node.instrument
        ? [[instrument.instanceId, sampledKindId(instrument.kind)]]
        : []
    }),
  ])
}

// The processors and instruments a snapshot places on each node: what a graph prepared from it holds.
const processorMembership = (snapshot: LivePlaybackSnapshot | undefined) => [
  ...(snapshot?.mixer.fx.masterFxInstances ?? []).map((instance) => JSON.stringify(["master", instance.id, instance.kind])),
  ...Object.entries(snapshot?.mixer.fx.trackFx ?? {}).flatMap(([nodeId, fx]) => [
    ...fx.instances, ...(fx.instrument ? [{ id: fx.instrument.instanceId, kind: fx.instrument.kind }] : []),
  ].map((instance) => JSON.stringify([nodeId, instance.id, instance.kind]))),
].sort().join("\n")

// The tracks whose sampled instrument regions a prepared graph holds native state for.
const sampledInstrumentTrackIds = (snapshot: LivePlaybackSnapshot): readonly string[] =>
  Object.entries(snapshot.mixer.fx.trackFx ?? {}).flatMap(([trackId, entry]) =>
    entry.instrument && entry.instrument.kind !== "synth" ? [trackId] : [])

type GraphNode = AudioCoreGraphSnapshot["nodes"][number]
const processorIndex = (graph: AudioCoreGraphSnapshot) => new Map(graph.nodes.flatMap((node) =>
  node.processorOrder.map((processor): [string, { node: GraphNode; kindId: number; targets: ReadonlySet<string> }] =>
    [processor.id, { node, kindId: processor.kindId, targets: new Set(processor.parameterTargets.map(({ id }) => id)) }])))

// Which queued batches native keeps when `next` replaces `previous` (host.cpp
// ReconcileScheduledTargets, core RetainsScheduledTarget). A processor is kept
// on the same node, kind and parameter targets; a synth on the same track node
// and instrument kind. Neither is kept when this publication configures the
// node's instrument again (a synth also when it replaces the instance): the
// node then gets a fresh slot. Slots and generations are native-assigned and not
// visible here: they follow continuity and, for an instrument node, an unchanged
// configuration (core assign_prepared_node 7736-7772, re-run by
// refresh_prepared_node 7776-7784), which Prepare reports as accepted.
const scheduledRetention = (
  previous: AudioCoreGraphSnapshot,
  next: AudioCoreGraphSnapshot,
  synths: { before: LivePlaybackSnapshot | undefined; after: LivePlaybackSnapshot | undefined },
  configuredNodes: ReadonlySet<string>,
): ExecutionRetention => {
  const before = new Map(previous.nodes.map((node) => [node.id, node]))
  const after = new Map(next.nodes.map((node) => [node.id, node]))
  const nodesBefore = synthNodes(synths.before)
  const nodesAfter = synthNodes(synths.after)
  let processors: { before: ReturnType<typeof processorIndex>; after: ReturnType<typeof processorIndex> } | undefined
  return (key, parameterIds) => {
    processors ??= { before: processorIndex(previous), after: processorIndex(next) }
    const was = processors.before.get(key)
    const now = processors.after.get(key)
    if (was || now) {
      return !!was && !!now && was.node.id === now.node.id && was.node.kind === now.node.kind
        && was.kindId === now.kindId && !configuredNodes.has(now.node.id) && [...parameterIds].every((id) => now.targets.has(id))
    }
    const nodeId = nodesBefore.get(key)
    const instrument = nodeId === undefined ? undefined : before.get(nodeId)?.instrument
    return nodeId !== undefined && !!instrument && nodesAfter.get(key) === nodeId
      && after.get(nodeId)?.instrument?.kind === instrument.kind && !configuredNodes.has(nodeId)
  }
}

type NativeSessionBridge = NonNullable<DesktopBridge["audioHost"]>["session"]
type NativePlaybackBridge = Pick<
  NonNullable<DesktopBridge["audioHost"]>,
  "resolveOutputDevice" | "resolveInputDevice"
> & {
  instrumentBudgetPolicy?: NonNullable<DesktopBridge["audioHost"]>["instrumentBudgetPolicy"]
  diagnostics?: () => Promise<
    | { ok: true; status: { pid?: number; generation: number }; configurationGeneration: number; diagnostics: {
      transportFrame: bigint; activeRevision: number; transportEpoch: number
    } }
    | { ok: false; error: string }
  >
  recordingSpool: NonNullable<DesktopBridge["audioHost"]>["recordingSpool"]
  session: Pick<
    NativeSessionBridge,
    | "commitTransaction"
    | "rollbackTransaction"
    | "installAsset"
    | "releaseAsset"
    | "publishGraph"
    | "configureInstrumentStates"
    | "queueInstrumentEvents"
    | "queueParameterEvents"
    | "queueScheduleWindow"
    | "queueSourceEvents"
    | "queueVstParameterEvents"
    | "coordinateVstAttachments"
    | "setTransport"
    | "configureRecording"
    | "startRecording"
    | "stopRecording"
    | "cancelRecording"
    | "start"
    | "stop"
    | "teardown"
    | "onLoss"
    | "onRecordingStatus"
    | "onRecordingFailure"
    | "onMeterBatch"
    | "onScheduleProgress"
  > & {
    revisions?: NativeSessionBridge["revisions"]
    createMappedAsset?: NativeSessionBridge["createMappedAsset"]
    writeMappedAssetPage?: NativeSessionBridge["writeMappedAssetPage"]
    prepareMappedAssetRange?: NativeSessionBridge["prepareMappedAssetRange"]
    configure: (
      input: NativeHostDeviceConfiguration,
      transactionToken?: string,
    ) => Promise<{ ok: true; hostIdentity: { pid: number; generation: number; configurationGeneration: number } } | { ok: false; error: string }>
    beginTransaction: () => Promise<
      | { ok: true; transactionToken: string }
      | { ok: false; error: string }
    >
    queueProcessorStatePatch?: NonNullable<DesktopBridge["audioHost"]>["session"]["queueProcessorStatePatch"]
    reenableVstScheduleAutomation?: NonNullable<DesktopBridge["audioHost"]>["session"]["reenableVstScheduleAutomation"]
    setSpectrumNode?: NonNullable<DesktopBridge["audioHost"]>["session"]["setSpectrumNode"]
    onSpectrumFrame?: NonNullable<DesktopBridge["audioHost"]>["session"]["onSpectrumFrame"]
    onVstInstanceEvent?: NonNullable<DesktopBridge["audioHost"]>["session"]["onVstInstanceEvent"]
  }
}

type NativeStartResult = "started" | "unavailable" | "blocked"
const nativeTransportFor = (
  snapshot: LivePlaybackSnapshot,
  epoch: number,
  running: boolean,
  frame: number,
  transitionId: bigint,
): NativeHostTransport => {
  const transport: NativeHostTransport = {
    epoch,
    running,
    frame,
    bpm: snapshot.bpm,
    timeSignatureNumerator: snapshot.timeSignature?.numerator ?? 4,
    timeSignatureDenominator: snapshot.timeSignature?.denominator ?? 4,
    cycleActive: snapshot.transport.loopEnabled,
    transitionId,
  }
  if (snapshot.transport.loopEnabled) {
    transport.cycleStartSec = snapshot.transport.loopStartSec
    transport.cycleEndSec = snapshot.transport.loopEndSec
  }
  return transport
}

const hasEquivalentTransportScheduling = (
  previous: LivePlaybackTransport,
  next: LivePlaybackTransport,
) => previous.loopEnabled === next.loopEnabled
  && previous.loopStartSec === next.loopStartSec
  && previous.loopEndSec === next.loopEndSec

// Admission is bridge evidence, never an application receipt. Validation can also stop a send locally.
type ParameterReply = NativeDeliveryReply
  | { ok: false; kind: "not-sent"; reason: "unavailable" | "unsupported" | "stale" }

type NativePublicationResult =
  | { handled: true }
  | { handled: false; reason: "unprepared" | "unavailable" | "bridge-error" | "unconfirmed" | "latency-unsupported"; error?: string }

// Native's diagnostic says Keep Latency cannot be honoured for this graph: a fault of its own kind, not a failed publication.
class NativeLatencyUnsupportedError extends Error {}

// A publication step native answered, did not take, or lost. The status decides what the folded patches were told; the
// message is for people. Anything thrown without one may have been taken, so it is unconfirmed.
class PublicationFailure extends Error {
  readonly kind: Extract<NativeRevisionReply, { ok: false }>["kind"]
  constructor(message: string, kind: Extract<NativeRevisionReply, { ok: false }>["kind"]) {
    super(message)
    this.kind = kind
  }
}

// What `reportFault` is told: a typed fault, never text to be matched by prefix.
export type NativePlaybackFault =
  | { kind: "delivery-refused" | "delivery-unconfirmed"; targets: number }
  | { kind: "latency-unsupported"; message: string }
  | { kind: "session-stopped"; message: string }

// Plain text for the places that can only show text; the kind, never this text, is what decides behaviour.
export const nativePlaybackFaultText = (fault: NativePlaybackFault) => {
  switch (fault.kind) {
    case "delivery-refused": return `Native audio refused ${fault.targets} effect update${fault.targets === 1 ? "" : "s"}. Audio continues.`
    case "delivery-unconfirmed": return `Native audio did not confirm ${fault.targets} effect update${fault.targets === 1 ? "" : "s"}. Audio continues.`
    case "latency-unsupported":
    case "session-stopped": return fault.message
  }
}
export type NativeRecordingDiagnostics = Pick<
  NativeHostRecordingStatus,
  "active" | "capturedFrames" | "droppedFrames" | "droppedBlocks" | "availableBlocks" | "queuedBlocks" | "rms" | "peak" | "fatal"
>

type NativeRecordingSession = {
  appSessionId: string
  numericSessionId: bigint
  generation: number
  scope: { projectId: string; projectGeneration: number }
  isCurrent: () => boolean
  takeId?: string
  sampleRate: number
  channelCount: number
  unsubscribeStatus: () => void
  unsubscribeFailure: () => void
  unsubscribeLoss: () => void
  terminal: boolean
  latestStatus?: NativeHostRecordingStatus
  finish?: Promise<Awaited<ReturnType<typeof importNativeRecordingSpool>>>
  waiters: Set<{ predicate: (status: NativeHostRecordingStatus) => boolean;
    resolve: (status: NativeHostRecordingStatus) => void; reject: (error: Error) => void }>
  onDiagnostics?: (diagnostics: NativeRecordingDiagnostics) => void
  onFailure?: (error: Error, cause: RecordingTerminationCause) => void
}

type LiveNoteReadiness = {
  promise: Promise<void>
  released: boolean
  force: boolean
  noteOnQueued: boolean
  releaseQueued: boolean
}

const assertReply: <T extends NativeSessionReply>(reply: T) => asserts reply is Extract<T, { ok: true }> = (reply) => {
  if (!reply.ok) throw new Error(reply.error)
}

const planarPageBytes = (
  planes: readonly Float32Array[],
  startFrame: number,
  frameCount: number,
) => {
  const bytesPerPlane = frameCount * Float32Array.BYTES_PER_ELEMENT
  const output = new Uint8Array(planes.length * bytesPerPlane)
  planes.forEach((plane, index) => {
    output.set(
      new Uint8Array(
        plane.buffer,
        plane.byteOffset + startFrame * Float32Array.BYTES_PER_ELEMENT,
        bytesPerPlane,
      ),
      index * bytesPerPlane,
    )
  })
  return output
}

const planarBytes = (planes: readonly Float32Array[]) => planarPageBytes(
  planes,
  0,
  planes[0]?.length ?? 0,
)

const nativeAssetCapacityError =
  `Native playback exceeds the installed audio asset capacity of ${nativeAudioHostMaximumInstalledAssets} assets.`

const nativeVstParameterEventsForSnapshot = (
  snapshot: LivePlaybackSnapshot,
  includeCurrent = true,
) => {
  const plan = snapshot.nativeExternalAttachmentPlan
  if (!plan) return []
  return plan.attachments.filter((attachment) => !attachment.bypassed).flatMap((attachment) => {
    const descriptors = new Map((attachment.parameters ?? []).map((parameter) => [parameter.id, parameter]))
    const events = new Map<string, { id: number; value: number; sampleOffset: number }>()
    for (const [rawId, value] of Object.entries(attachment.parameterOverrides ?? {})) {
      const id = Number(rawId)
      if (!descriptors.has(id) || !Number.isFinite(value)) continue
      if (includeCurrent) events.set(`${id}:0`, { id, value: Math.min(1, Math.max(0, value)), sampleOffset: 0 })
    }
    const eventsInBlock = [...events.values()]
      .sort((left, right) => left.sampleOffset - right.sampleOffset || left.id - right.id)
      .slice(0, attachment.workerTransport.maximumEventsPerBlock)
    return eventsInBlock.length > 0 ? [{ instanceId: attachment.instanceId, events: eventsInBlock }] : []
  })
}

const nativeSnapshotSupportError = (snapshot: LivePlaybackSnapshot): string | undefined => {
  if (snapshot.tracks.some((track) => track.clips.some((clip) => (
    clip.midi?.mappings !== undefined && clip.midi.mappings.length > 0
  )))) return "Native VST3 playback does not support MIDI expression automation yet."
  if (snapshot.mixer.sidechainRoutes.length > 0)
    return "The native VST3 graph cannot activate with the current sidechain routing."
  if (snapshot.requiresNativePlayback && !snapshot.nativeExternalAttachmentPlan)
    return "The active VST3 attachment plan is unavailable."
}

const validateInstrumentAssetBudget = (
  assets: readonly AudioCoreGraphSnapshot["assets"][number][],
  instruments: readonly NonNullable<AudioCoreGraphSnapshot["nodes"][number]["instrument"]>[],
  maximumBytes: number,
  errorMessage = "Instrument sample memory budget exceeded (1 GiB per device).",
) => {
  const bytesById = new Map(assets.map((asset) =>
    [asset.assetId, asset.frameCount * asset.channelCount * Float32Array.BYTES_PER_ELEMENT]))
  for (const instrument of instruments) {
    if (instrument.kind === "synth") continue
    const assetIds = new Set(instrument.kind === "granular"
      ? [instrument.assetId]
      : instrument.zones.map((zone) => zone.assetId))
    let bytes = 0
    for (const assetId of assetIds) bytes += bytesById.get(assetId) ?? 0
    if (bytes > maximumBytes) throw new Error(errorMessage)
  }
}

type AttachmentPlan = NonNullable<LivePlaybackSnapshot["nativeExternalAttachmentPlan"]>

// A compile carries the plan's default worker block size; the session runs every worker at the device's.
const planWithWorkerFrames = (plan: AttachmentPlan, maximumFrames: number): AttachmentPlan => plan.version === 1
  ? { ...plan, attachments: plan.attachments.map((attachment) => ({
    ...attachment, workerTransport: { ...attachment.workerTransport, maximumFrames } })) }
  : { ...plan, attachments: plan.attachments.map((attachment) => ({
    ...attachment, workerTransport: { ...attachment.workerTransport, maximumFrames } })) }

// What the host must be told about for a graph. A declared latency is not one: it reaches native through
// `publishAttachmentLatency`.
const attachmentsChanged = (previous: LivePlaybackSnapshot, snapshot: LivePlaybackSnapshot, maximumFrames: number) => {
  const bindings = (candidate: LivePlaybackSnapshot) => JSON.stringify({
    attachments: candidate.nativeExternalAttachmentPlan
      && planWithWorkerFrames(candidate.nativeExternalAttachmentPlan, maximumFrames).attachments
        .map(({ declaredLatencyFrames: _latency, ...attachment }) => attachment),
    states: candidate.nativeExternalAttachmentStates,
    requirements: candidate.nativeExternalAttachmentStateRequirements,
  })
  return bindings(snapshot) !== bindings(previous)
}

type ScheduleRevisionCandidate = {
  status: "staged"
  processorStateSequence: number
  previous: LivePlaybackSnapshot
  snapshot: LivePlaybackSnapshot
  graph: AudioCoreGraphSnapshot
  instrumentIncarnations: ReadonlyMap<string, number>
  projection: Extract<LiveNativeProjection, { supported: true }>
  stretchAssets: readonly NativePreparedStretchAsset[]
  // Native refused its publication and it stayed staged: it holds nothing back. One not yet published is the next graph.
  dispose: () => Promise<void>
}
type ScheduleRevisionPreparation =
  | ScheduleRevisionCandidate
  | { status: "retry"; reason: string; transport?: LivePlaybackTransport }
  | { status: "failed"; reason: string }

/**
 * Owns a single native host session and coordinates trusted external effects
 * before publishing the immutable native graph.
 */
export const createNativePlaybackController = (input: {
  bridge: NativePlaybackBridge | undefined
  compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
  getProcessorTarget?: (nodeId: string, instanceId: string) => {
    kindId: number
    incarnation: number
    latest?: LiveProcessorEditIdentity
  } | undefined
  getDesiredProcessorState?: (snapshot: LivePlaybackSnapshot, sampleRate: number) => {
    sequence: number
    graph: AudioCoreGraphSnapshot
    // Graph-only producers remain supported until the atomic 3B compatibility cutover.
    instruments?: ReadonlyMap<string, DesiredInstrument>
  }
  getProjectId?: () => string
  getProjectGeneration?: () => number
  getKeepLatencyNodeIds?: () => ReadonlySet<string>
  resolveSource?: AudioPcmSourceResolver
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  reportFault?: (fault: NativePlaybackFault, options?: { retainPlayback: true }) => void
  // Names the record behind each processor parameter batch for acceptance attribution; the fuzzer fixture is its only consumer.
  onProcessorDispatch?: (event: { key: string; editId: string; attempt: number; sequence: bigint }) => void
  instrumentBudget?: SampledInstrumentRegionBudget
  onInstrumentPreparation?: (trackIds: readonly string[], status: NativeInstrumentPreparation) => void
  reportUnavailable?: boolean
  importRecordingSpool?: typeof importNativeRecordingSpool
  createPreparedStretchRepository?: () => PreparedStretchArtifactRepository
  createStretchCache?: (options: AudioStretchCacheOptions) => ReturnType<typeof createAudioStretchCache>
  // The content of a compiled schedule, for telling an unchanged one from a changed one; without it every compile is
  // taken as changed.
  fingerprintSnapshot?: (snapshot: LivePlaybackSnapshot) => string
  // Acceptance only: another process owns the native session from startup, so this controller never acquires or retires it.
  externalSessionOwner?: boolean
}) => {
  let active = false
  let prepared = false
  let nativeSessionStarted = false
  let livePreviewActive = false
  let nativeHostConnectionLost = false
  let nativeHostLossProjectGeneration: number | undefined
  let nativeHostLossReason: string | undefined
  let nativeHostRecoveryAvailable = false
  let nativeHostRecoveryUsed = false
  let nativeHostLossReported = false
  let intentionalHostTransitionDepth = 0
  let preparedProjectId: string | undefined
  let preparedProjectGeneration: number | undefined
  let pendingStart: Promise<NativeStartResult> | undefined
  let pendingStartMode: "play" | "preview" | undefined
  let pendingStartCompileContext: LivePlaybackCompileContext | undefined
  let pendingPreviewAttempt: NativePreviewAttempt | undefined
  let lifecycleGeneration = 0
  let instrumentPreparationGeneration = 0
  let instrumentPreparationRequestGeneration = 0
  let nativeSessionGeneration = 0
  let transportEpoch = 1
  let nextLiveProcessorSequence = 0
  let nextTransportTransitionId = 0n
  let installedAssetIds: readonly number[] = []
  let installedAssets: readonly NativeSessionAsset[] = []
  let nextSessionAssetId = 1
  const sessionResourceIds = new Map<string, number>()
  const bufferIdentities = new WeakMap<AudioBuffer, number>()
  let nextBufferIdentity = 1
  const resourceKey = (
    asset: AudioCoreGraphSnapshot["assets"][number],
    source: LivePlaybackSnapshot["assets"][number] | undefined,
  ) => {
    const buffer = source?.buffer
    let bufferIdentity = buffer ? bufferIdentities.get(buffer) : undefined
    if (buffer && bufferIdentity === undefined) {
      bufferIdentity = nextBufferIdentity++
      bufferIdentities.set(buffer, bufferIdentity)
    }
    return JSON.stringify([asset, source?.sampleUrl, source?.source, bufferIdentity])
  }
  let preparedStretchAssetsForSession: readonly NativePreparedStretchAsset[] = []
  let preparedStretchLeaseSession: (() => Promise<void>) | undefined
  let nativePcmChunkDescriptorsForSession: readonly NativePcmChunkDescriptor[] = []
  let nativeTimelinePageManager: ReturnType<typeof createNativeTimelinePageManager> | undefined
  let instrumentMemoryScope: SampledInstrumentRegionBudgetScope | undefined
  const instrumentBudget = input.instrumentBudget ?? (input.bridge?.instrumentBudgetPolicy
    ? createSampledInstrumentRegionBudget(input.bridge.instrumentBudgetPolicy.aggregateBytes) : undefined)
  const instrumentMemoryScopes = new Set<SampledInstrumentRegionBudgetScope>()
  const releaseInstrumentScope = (scope: SampledInstrumentRegionBudgetScope | undefined) => {
    scope?.release()
    if (scope) instrumentMemoryScopes.delete(scope)
  }
  const createInstrumentMemoryScope = (
    sources: readonly { sourceAssetKey: string; buffer: AudioBuffer }[],
    assets: AudioCoreGraphSnapshot["assets"],
    instruments: readonly NonNullable<AudioCoreGraphSnapshot["nodes"][number]["instrument"]>[],
    maximumBytes: number,
    scopeName: string,
    budgetErrorMessage?: string,
  ) => {
    if (sources.length === 0) return undefined
    if (!instrumentBudget) throw new Error("Native sample memory policy is unavailable.")
    validateInstrumentAssetBudget(assets, instruments, maximumBytes, budgetErrorMessage)
    const scope = instrumentBudget.createScope(scopeName)
    instrumentMemoryScopes.add(scope)
    try {
      scope.lease(sources.map(({ sourceAssetKey, buffer }) => ({
        key: sourceAssetKey, buffer, bytes: buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
      })), true)
      for (const { sourceAssetKey, buffer } of sources) {
        const bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT
        scope.set(`resident:${sourceAssetKey}`, Math.ceil(bytes / 16_384) * 16_384, () => undefined)
      }
      return scope
    } catch (error) {
      releaseInstrumentScope(scope)
      throw error
    }
  }
  let preparedInstrumentTrackIds: readonly string[] = []
  let preparedSnapshot: LivePlaybackSnapshot | undefined
  let preparedGraph: AudioCoreGraphSnapshot | undefined
  let structuralGraphGeneration = 0
  // Renderer edit order, never bridge completion order. Every stamp comes from
  // the renderer's single edit allocator; the controller never mints orders.
  const processorState = createNativeProcessorStateOwner<ScheduleRevisionCandidate>({
    onTerminal: () => {
      executeReconcile(processorState.reoffer())
      void drainStatePatches()
    },
    // One notice per incident: later failures join it, and a new one notifies only after it closed.
    reportIncident: (category, targets) => reportFault(
      { kind: category === "refused" ? "delivery-refused" : "delivery-unconfirmed", targets }, { retainPlayback: true }),
  })
  const scheduleCandidates = new Set<ScheduleRevisionCandidate>()
  const disposeKept = (candidate: ScheduleRevisionCandidate | undefined) => {
    void candidate?.dispose().catch(() => undefined)
  }
  // The edit's complete target must be a current member of the renderer's live
  // identity capture. A request never establishes its own validity, and a
  // retired or re-created target is rejected.
  const isRetiredTarget = (edit: LiveProcessorEditIdentity | undefined, instanceId: string) => {
    if (!edit || !input.getProcessorTarget) return false
    const live = input.getProcessorTarget(edit.target.nodeId, edit.target.instanceId)
    return edit.target.instanceId !== instanceId
      || live?.kindId !== edit.target.kindId
      || live.incarnation !== edit.target.incarnation
  }
  const isScheduleCandidateValid = (candidate: ScheduleRevisionCandidate) =>
    candidate.previous === preparedSnapshot
  // The ledger is the only source of desired content: the host's effective
  // projection is ingested into it first, then every winner is read from it.
  const ingestProjectedProcessors = (snapshot: LivePlaybackSnapshot) => {
    const projected = input.getDesiredProcessorState?.(snapshot, sampleRate)
    if (projected) for (const node of projected.graph.nodes) for (const processor of node.processorOrder) {
      const desired = projectedProcessorDesired(node.id, processor, input.getProcessorTarget?.(node.id, processor.id))
      if (desired) processorState.submit(desired)
    }
    if (projected?.instruments) for (const [nodeId, instrument] of projected.instruments) {
      if (instrument.kind !== "synth") continue
      const identity = input.getProcessorTarget?.(nodeId, instrument.instanceId)
      const edit = identity?.latest
      if (!edit || identity.kindId !== SYNTH_KIND_ID || edit.target.nodeId !== nodeId
        || edit.target.instanceId !== instrument.instanceId || edit.target.kindId !== SYNTH_KIND_ID
        || edit.target.incarnation !== identity.incarnation) continue
      processorState.submit({
        id: edit.id,
        order: edit.order,
        target: edit.target,
        // Synths have no processor-state bytes; their compiled instrument is the complete native content.
        content: { state: new Uint8Array(), instrument: { state: instrument.state, incarnation: identity.incarnation },
          values: nativeSynthValues(instrument.state), params: edit.content.params },
        bypassed: false, tailFrames: 0,
      })
    }
    return projected
  }
  // The graph with every ledger winner newer than `floor` over its processor. A graph already carries content up to
  // its floor; B4b's recovery rebase relies on that. Tails follow the tempo `bpm` of the graph written, not the one the
  // edit was submitted at.
  const graphWithLedger = (
    graph: AudioCoreGraphSnapshot,
    floor: number,
    ledger: ReadonlyMap<string, ProcessorDesired>,
    bpm: number,
    snapshot?: LivePlaybackSnapshot,
    instrumentIncarnations: ReadonlyMap<string, number> = new Map(),
  ): AudioCoreGraphSnapshot => ({ ...graph, nodes: graph.nodes.map((node) => {
    let latencyFrames = 0
    let inputLayout = node.inputLayout
    const processorOrder = node.processorOrder.map((processor) => {
      const outputLayout = nativeProcessorOutputLayoutForState(processor, inputLayout, processor.state)
      const entry = ledger.get(processor.id)
      const desired = entry && timedProcessorDesired(entry, sampleRate, bpm)
      let winner = processor
      if (desired && desired.order > floor && desired.target.kindId === processor.kindId
        && desired.bypassed === processor.bypassed
        && nativeProcessorOutputLayoutForState(processor, inputLayout, desired.content.state) === outputLayout) {
        const { tailKind: _tailKind, ...withoutTailKind } = processor
        winner = { ...withoutTailKind, state: desired.content.state.slice(), tailFrames: desired.tailFrames }
        if (desired.tailKind) winner.tailKind = desired.tailKind
      }
      const latency = nativeProcessorLatencyForState(winner, winner.state)
      latencyFrames += latency
      inputLayout = outputLayout
      return { ...winner, latencyFrames: latency }
    })
    const instrument = snapshot?.mixer.fx.trackFx?.[node.id]?.instrument
    const desired = instrument?.kind === "synth" ? ledger.get(instrument.instanceId) : undefined
    const winner = node.instrument?.kind === "synth" && desired?.content.instrument
      && desired.order > floor && desired.target.nodeId === node.id && desired.target.kindId === SYNTH_KIND_ID
      && desired.target.incarnation === instrumentIncarnations.get(desired.target.instanceId)
      ? desired.content.instrument.state : node.instrument
    return { ...node, processorOrder, latencyFrames, ...(winner && { instrument: winner }) }
  }) })
  // What a configured or published graph puts in force for each of its processors: native holds exactly this state.
  const installedContentOf = (
    graph: AudioCoreGraphSnapshot,
    snapshot?: LivePlaybackSnapshot,
    instrumentIncarnations: ReadonlyMap<string, number> = new Map(),
  ): ReadonlyMap<string, InstalledContent> => new Map([
    ...graph.nodes.flatMap((node) => {
      const instances = new Map((node.id === "master" ? snapshot?.mixer.fx.masterFxInstances
        : snapshot?.mixer.fx.trackFx?.[node.id]?.instances)?.map(instance => [instance.id, instance]))
      return node.processorOrder.map((processor): [string, InstalledContent] => {
        const instance = instances.get(processor.id)
        const params = instance && parseJsonValue(instance.params)
        const payload = instance && params !== undefined
          ? createAudioEffectParameterPayload({ targetId: node.id, instanceId: processor.id, kind: instance.kind }, params, params)
          : undefined
        const encoded = payload && encodeNativeBuiltInStateCommit(payload, snapshot?.bpm ?? 120)
        // A rebased graph may differ from the snapshot. Only an exact encoding match can establish what its bytes carry.
        return [processor.id, { nodeId: node.id, kindId: processor.kindId, state: processor.state,
          ...(payload && encoded && sameBytes(encoded.state, processor.state) && {
            values: captureNativeBuiltInParameterValues(payload, snapshot?.bpm ?? 120),
            timing: nativeBuiltInPatchTiming(payload),
          }) }]
      })
    }),
    ...graph.nodes.flatMap((node): [string, InstalledContent][] => {
      if (!node.instrument) return []
      const instrument = snapshot?.mixer.fx.trackFx?.[node.id]?.instrument
      if (!instrument) return []
      const instrumentState = node.instrument
      if (instrumentState.kind !== instrument.kind) return []
      return [[instrument.instanceId, {
        nodeId: node.id,
        kindId: instrument.kind === "synth" ? SYNTH_KIND_ID : sampledKindId(instrument.kind),
        ...(instrumentState.kind === "synth" && {
          instrument: instrumentState, values: nativeSynthValues(instrumentState),
          incarnation: instrumentIncarnations.get(instrument.instanceId),
        }),
        contentKey: nativeInstrumentContentKey(instrumentState),
      }]]
    }),
  ])
  const publicationContent = (graph: AudioCoreGraphSnapshot, snapshot: LivePlaybackSnapshot,
    ledger: ReadonlyMap<string, ProcessorDesired>, incarnations?: ReadonlyMap<string, number>) =>
    new Map([...installedContentOf(graph, snapshot, incarnations)].map(([key, content]): [string, InstalledContent] => {
      const desired = ledger.get(key)
      return [key, desired && content.state && sameBytes(desired.content.state, content.state)
        ? { ...content, values: desired.content.values, timing: desired.content.timing } : content]
    }))
  const rebaseScheduleCandidate = (candidate: ScheduleRevisionCandidate) => {
    const projected = ingestProjectedProcessors(candidate.snapshot)
    const ledger = processorState.capture()
    const sequence = Math.max(candidate.processorStateSequence, projected?.sequence ?? 0)
    return { graph: compensateGraph(graphWithLedger(candidate.graph, candidate.processorStateSequence, ledger,
      candidate.snapshot.bpm, candidate.snapshot, candidate.instrumentIncarnations), candidate.snapshot), sequence, ledger }
  }
  // Capture registry identity while the configuration is built, before any asynchronous native preparation.
  const captureInstrumentIncarnations = (snapshot: LivePlaybackSnapshot) => new Map(
    [...synthNodes(snapshot)].flatMap(([instanceId, nodeId]): [string, number][] => {
      const identity = input.getProcessorTarget?.(nodeId, instanceId)
      return identity ? [[instanceId, identity.incarnation]] : []
    }))
  const compensateGraph = (graph: AudioCoreGraphSnapshot, snapshot: LivePlaybackSnapshot) => {
    const mixer = resolveLiveMixerGraph(snapshot.tracks, {})
    const latency = new Map(graph.nodes.map((node) =>
      [node.id, node.latencyFrames + (node.externalLatencyFrames ?? 0)]))
    const timing = resolveMixerTiming(mixer, sampleRate, snapshot.bpm, latency)
    return { ...graph, edges: graph.edges.map((edge) => ({
      ...edge, pdcDelayFrames: edge.sidechain ? 0 : timing.routeDelayFrames.get(edge.id) ?? 0,
    })) }
  }
  let preparedHostIdentity: { pid: number; generation: number; configurationGeneration: number } | undefined
  let preparedKeepLatencyNodeIds: ReadonlySet<string> = new Set()
  let desiredKeepLatencyNodeIds: ReadonlySet<string> = new Set()
  // `capacity` counts what native reclaimed; `settled` counts local publication terminals.
  let scheduleCapacityEpoch = 0
  let scheduleSettledEpoch = 0
  let nativeAdmissionCapacityGeneration = 0n
  let nativeLatencyCompletionGeneration = 0n
  let prepareAdmissionWake: (() => void) | undefined
  const adoptionFields = (): AdoptionFields => ({ host: JSON.stringify(preparedHostIdentity), epoch: transportEpoch,
    structural: structuralGraphGeneration, capacity: scheduleCapacityEpoch, settled: scheduleSettledEpoch })
  // The only wake for a refused adoption: a field it answers to moved. It starts after the current turn, never inside
  // the transport lane operation that moved it, because the attempt publishes through that lane.
  const wakeReopenedAdoption = () => {
    const reopened = processorState.reopenedIntent(adoptionFields())
    if (reopened) void Promise.resolve().then(() => adoptSchedule(reopened, false))
  }
  const advanceScheduleCapacityEpoch = () => {
    scheduleCapacityEpoch++
    wakeReopenedAdoption()
  }
  const advanceScheduleSettledEpoch = () => {
    scheduleSettledEpoch++
    prepareAdmissionWake?.()
    wakeReopenedAdoption()
  }
  let stagedTransportIntent = 0
  let unsubscribeMeters: (() => void) | undefined
  let unsubscribeVstInstanceEvents: (() => void) | undefined
  let recording: NativeRecordingSession | undefined
  let sampleRate = 0
  let maximumFramesPerBlock = 0
  let nextRecordingSessionId = 1n
  let recordingGeneration = 1
  let transportFrame = 0
  let loopAppliesAtTransportPosition = true
  let nextLiveNoteId = 1
  let nextLiveEventSequence = 1_000_000
  let liveInstrumentQueueGeneration = 0
  let liveInstrumentEventTail = Promise.resolve()
  let preparedTransportTransitionGeneration = 0
  let loopUpdateSequence = 0
  let pendingLoopUpdates = 0
  let drainingStatePatches = false
  const liveNoteReadiness = new Map<number, LiveNoteReadiness>()
  const releasedLiveNoteHandles = new WeakSet<NativeLiveMidiNoteHandle>()
  let liveMidiTailOwned = false
  let scheduleCoordinator: NativeScheduleCoordinator | undefined
  const nativeLiveMidiResetListeners = new Set<() => void>()
  const nativeMeterListeners = new Set<(levels: TrackStereoLevelsBatch) => void>()
  const nativeMasterMeterListeners = new Set<(levels: TrackStereoLevels) => void>()
  const nativeSpectrumListeners = new Set<(frame: SpectrumFrame | null) => void>()
  let nativeMeterNodeIds = new Map<bigint, string>()
  let nativeMeterRevision = 0
  let latestMeterSequence = 0n
  let nativeLevels: TrackStereoLevelsBatch = new Map()
  let nativeMasterLevels: TrackStereoLevels = { left: 0, right: 0 }
  let nativeSpectrumNodeIds = new Map<string, bigint>()
  let nativeSpectrumTarget: string | undefined
  let nativeSpectrumDesiredNodeId: bigint | null | undefined
  let nativeSpectrumSelectedNodeId: bigint | null | undefined
  let nativeSpectrumSelectionGeneration = 0
  let nativeSpectrumSelectionRequest: { generation: number; nodeId: bigint | null } | undefined
  let latestSpectrumSequence = 0n
  let latestScheduleProgress: NativeScheduleProgress | undefined
  const retirementAlive = (held: RetirementObligation) =>
    processorState.retirement() === held && held.sessionGeneration === lifecycleGeneration
      && prepared && !hasNativeHostConnectionLoss() && held.binding.projectId === preparedProjectId
  const dispatchRetirement = () => {
    const held = processorState.retirement()
    const revisions = input.bridge?.session.revisions
    if (!held || !revisions || !retirementAlive(held) || held.running || held.attempted === held.opportunity) return
    held.attempted = held.opportunity
    held.running = true
    void (async () => {
      try {
        if (held.uncertain) {
          const proof = await revisions.inspect(held.binding)
          if (!retirementAlive(held)) return
          processorState.observeRetirement(proof)
          if (!retirementAlive(held) || !proof.ok || proof.hostPid !== held.hostPid
            || proof.hostGeneration !== held.binding.hostGeneration || proof.revision.status === "publish-pending") return
          held.uncertain = false
        }
        if (!retirementAlive(held)) return
        const reply = await revisions.retire(held.binding)
        if (retirementAlive(held)) {
          held.uncertain = !reply.ok && reply.kind === "unconfirmed"
          held.waitingControl = !reply.ok && reply.kind === "unavailable"
          // Native samples the reader check and reply epoch separately
          // (audio-host.cpp:3174, 3194). The first crossing needs one more
          // frame-driven proof: only a serialized Retire dispatched after that
          // observation cannot be reader-blocked by the monotonic counter.
          // Then not-safe means latency pending; later transport epochs still wake.
          if (reply.ok && reply.revision.status === "retirement-not-safe"
            && reply.revision.progressFrame !== undefined) {
            const epoch = reply.revision.transportEpoch ?? transportEpoch
            const progress = latestScheduleProgress
            const newerProgress = progress && (progress.epoch > epoch
              || (progress.epoch === epoch && progress.renderedThroughFrame > reply.revision.progressFrame))
            const renderEpoch = held.readerPoint?.renderEpoch ?? reply.revision.renderEpoch
            const crossed = held.readerPoint?.crossed ?? false
            held.readerPoint = { epoch: newerProgress ? progress.epoch : epoch,
              frame: newerProgress ? progress.renderedThroughFrame : reply.revision.progressFrame,
              renderEpoch, crossed: crossed || reply.revision.renderEpoch > renderEpoch }
            held.readerPassed = crossed
          }
          processorState.observeRetirement(reply)
        }
      } catch {
        held.uncertain = true
        // Lost/unavailable cleanup is still owed. Only an external opportunity
        // can retry it; the retirement reply itself never supplies one.
      } finally {
        held.running = false
        // Only an external event received during this request can leave a
        // newer opportunity. Our own reply never increments the counter.
        if (retirementAlive(held) && held.attempted !== held.opportunity) dispatchRetirement()
      }
    })()
  }
  const retirementOpportunity = () => {
    const held = processorState.retirement()
    if (!held) return
    held.opportunity++
    dispatchRetirement()
  }
  const observeRetirementControl = <T>(operation: Promise<T>) => {
    const generation = lifecycleGeneration
    const completed = () => {
      const held = processorState.retirement()
      if (generation !== lifecycleGeneration || !held || !held.waitingControl || !retirementAlive(held)) return
      held.waitingControl = false
      retirementOpportunity()
    }
    void operation.then(completed, completed)
    return operation
  }
  const holdRetirement = (proof: Extract<NativeRevisionReply, { ok: true }>, projectId: string,
    release: () => Promise<void> = async () => {}) => {
    processorState.observeRetirement(proof)
    const revision = proof.revision.retiredRevision
    if (!revision) { void release().catch(() => undefined); return }
    processorState.holdRetirement({ binding: { projectId, revision, hostGeneration: proof.hostGeneration },
      hostPid: proof.hostPid, sessionGeneration: lifecycleGeneration, release,
      opportunity: 0, attempted: -1, running: false, uncertain: false, readerPassed: false, waitingControl: false })
    dispatchRetirement()
  }
  let stretchPreparationAbortController: AbortController | undefined
  let startAbortController: AbortController | undefined
  let preparedStretchRepository: PreparedStretchArtifactRepository | undefined
  let stretchCache: ReturnType<typeof createAudioStretchCache> | undefined
  const pendingStretchCandidates = new Set<() => Promise<void>>()
  const ensureStretchStorage = () => {
    if (!preparedStretchRepository) {
      preparedStretchRepository = input.createPreparedStretchRepository?.()
      if (!preparedStretchRepository) {
        if (!globalThis.indexedDB || !globalThis.navigator?.locks)
          throw new Error("Native Stretch playback requires IndexedDB and cross-realm Web Locks for bounded artifact storage.")
        preparedStretchRepository = createPreparedStretchArtifactRepository()
      }
    }
    stretchCache ??= (input.createStretchCache ?? createAudioStretchCache)({
      resolveSource: input.resolveSource, artifactRepository: preparedStretchRepository,
    })
    return { repository: preparedStretchRepository, cache: stretchCache }
  }
  let installedAssetSourceKeys = new Map<string, string>()
  let destroyed = false
  let destroyPromise: Promise<void> | undefined
  let nativeStretchDrainPromise: Promise<void> | undefined
  const resolveProjectGeneration = () => input.getProjectGeneration?.() ?? 0
  const resolveTimelineDescriptor = async (
    sourceAssetKey: string,
    asset: AudioCoreGraphSnapshot["assets"][number],
    snapshotAssets: ReadonlyMap<string, LivePlaybackSnapshot["assets"][number]>,
    clips: ReadonlyMap<string, LivePlaybackSnapshot["tracks"][number]["clips"][number]>,
    regionalBuffer: AudioBuffer | undefined,
    signal?: AbortSignal,
  ): Promise<AudioPcmSourceDescriptor> => {
    const snapshotAsset = snapshotAssets.get(sourceAssetKey)
    const buffer = regionalBuffer ?? snapshotAsset?.buffer
    if (!snapshotAsset && !regionalBuffer)
      throw new Error(`Native audio asset "${sourceAssetKey}" is absent from the playback snapshot.`)
    const clip = clips.get(sourceAssetKey)
    const descriptor = buffer
      ? createAudioPcmSourceDescriptor({
        identity: `buffer:${safePreparedProjectGeneration(resolveProjectGeneration())}:${sourceAssetKey}`,
        durationSec: buffer.duration, frameCount: buffer.length, sampleRate: buffer.sampleRate,
        channelCount: buffer.numberOfChannels, source: buffer,
      })
      : clip && input.resolveSource ? await input.resolveSource(clip, signal) : undefined
    if (!descriptor) throw new Error(`Native audio asset "${sourceAssetKey}" has no resolvable PCM source descriptor.`)
    if (descriptor.frameCount !== asset.frameCount || descriptor.sampleRate !== asset.sampleRateHz
      || descriptor.channelCount !== asset.channelCount)
      throw new Error(`Native audio asset "${sourceAssetKey}" metadata is inconsistent.`)
    return descriptor
  }
  const prepareMappedResources = async (resources: readonly {
    source: NativeTimelineSource
    create: () => Promise<void>
  }[], pageManager: ReturnType<typeof createNativeTimelinePageManager>,
  fullRegionRanges: readonly { sourceAssetKey: string; startFrame: number; endFrame: number }[],
  signal?: AbortSignal, registerSources = true) => {
    for (const resource of resources) {
      signal?.throwIfAborted()
      await resource.create()
    }
    if (registerSources && resources.length > 0) pageManager.addSources(resources.map(({ source }) => source))
    await pageManager.ensureRanges(fullRegionRanges, signal)
  }
  const createMappedAsset = async (
    session: NativePlaybackBridge["session"],
    asset: { frameCount: number; sampleRateHz: number; channelCount: number },
    mapping: { sessionAssetId: number },
    preparedStretchArtifactId: string | undefined,
    transactionToken?: string,
  ) => {
    if (!session.createMappedAsset) throw new Error("Native mapped asset hydration is unavailable.")
    const reply = await session.createMappedAsset({
      sessionAssetId: mapping.sessionAssetId, frameCount: asset.frameCount,
      sampleRateHz: asset.sampleRateHz, channelCount: asset.channelCount, preparedStretchArtifactId,
    }, transactionToken)
    if (!reply.ok) throw new PublicationFailure(reply.error,
      "kind" in reply && (reply.kind === "refused" || reply.kind === "unconfirmed" || reply.kind === "unavailable")
        ? reply.kind : "refused")
  }
  const safePreparedProjectGeneration = (projectGeneration: number) =>
    Number.isSafeInteger(projectGeneration) && projectGeneration > 0 ? projectGeneration : 1
  let unsubscribeSpectrum: (() => void) | undefined

  const resetNativeMeters = () => {
    const levels = new Map<string, TrackStereoLevels>()
    for (const nodeId of nativeMeterNodeIds.values()) {
      if (nodeId !== "master") levels.set(nodeId, { left: 0, right: 0 })
    }
    nativeLevels = levels
    nativeMasterLevels = { left: 0, right: 0 }
    for (const listener of nativeMeterListeners) listener(levels)
    for (const listener of nativeMasterMeterListeners) listener(nativeMasterLevels)
  }

  const configureNativeMeters = (revision: number, tracks: readonly { id: string }[]) => {
    nativeMeterRevision = revision
    latestMeterSequence = 0n
    nativeMeterNodeIds = new Map([
      ...tracks.map((track) => [nativeGraphNodeId(track.id), track.id] as const),
      [nativeGraphNodeId("master"), "master"],
    ])
    resetNativeMeters()
  }

  const clearNativeMeters = () => {
    unsubscribeMeters?.()
    unsubscribeMeters = undefined
    resetNativeMeters()
    nativeMeterNodeIds = new Map()
    nativeMeterRevision = 0
    latestMeterSequence = 0n
  }

  const clearVstInstanceEvents = () => {
    unsubscribeVstInstanceEvents?.()
    unsubscribeVstInstanceEvents = undefined
  }

  const clearNativeSpectrum = () => {
    unsubscribeSpectrum?.()
    unsubscribeSpectrum = undefined
    nativeSpectrumNodeIds = new Map()
    latestSpectrumSequence = 0n
    nativeSpectrumSelectionGeneration += 1
    nativeSpectrumDesiredNodeId = undefined
    nativeSpectrumSelectedNodeId = undefined
    nativeSpectrumSelectionRequest = undefined
    for (const listener of nativeSpectrumListeners) listener(null)
  }

  const configureNativeSpectrum = (tracks: readonly { id: string }[]) => {
    nativeSpectrumNodeIds = new Map([
      ...tracks.map((track) => [track.id, nativeGraphNodeId(track.id)] as const),
      ["master", nativeGraphNodeId("master")] as const,
    ])
    latestSpectrumSequence = 0n
    for (const listener of nativeSpectrumListeners) listener(null)
  }

  const reconcileNativeSpectrumSelection = (ownershipReleased = false) => {
    if (!nativeSessionStarted) return
    const target = nativeSpectrumTarget
    nativeSpectrumDesiredNodeId = target === undefined ? null : nativeSpectrumNodeIds.get(target)
    // A target absent from the active map may be a candidate-only node. Keep
    // the request pending until publication promotes its observation map.
    const nodeId = nativeSpectrumDesiredNodeId
    if (nodeId === undefined) return
    const supersedesRequest = nativeSpectrumSelectionRequest !== undefined
      && nativeSpectrumSelectionRequest.nodeId !== nodeId
    if (nodeId === nativeSpectrumSelectedNodeId && !supersedesRequest) return
    if (!ownershipReleased && nativeSpectrumSelectionRequest?.nodeId === nodeId) return
    const bridge = input.bridge
    const sessionGeneration = nativeSessionGeneration
    const projectId = input.getProjectId?.()
    const projectGeneration = resolveProjectGeneration()
    const selectionGeneration = ++nativeSpectrumSelectionGeneration
    nativeSpectrumSelectionRequest = { generation: selectionGeneration, nodeId }
    const finish = (reply: NativeSessionReply | undefined) => {
      if (nativeSpectrumSelectionRequest?.generation !== selectionGeneration) {
        // A stale successful command still changed the host. Reassert the
        // desired target after that reply, not merely the renderer cache.
        if (reply?.ok && sessionGeneration === nativeSessionGeneration
          && nodeId !== nativeSpectrumDesiredNodeId) {
          nativeSpectrumSelectedNodeId = undefined
          reconcileNativeSpectrumSelection(true)
        }
        return
      }
      nativeSpectrumSelectionRequest = undefined
      if (!reply?.ok || selectionGeneration !== nativeSpectrumSelectionGeneration
        || sessionGeneration !== nativeSessionGeneration || !prepared || !nativeSessionStarted
        || preparedProjectId !== projectId || preparedProjectGeneration !== projectGeneration
        || projectId !== input.getProjectId?.() || projectGeneration !== resolveProjectGeneration()) return
      nativeSpectrumSelectedNodeId = nodeId
    }
    void bridge?.session.setSpectrumNode?.(nodeId).then(finish, () => finish(undefined))
  }

  const nativeObservationMaps = (tracks: readonly { id: string }[]) => ({
    meters: new Map<bigint, string>([
      ...tracks.map((track) => [nativeGraphNodeId(track.id), track.id] as const),
      [nativeGraphNodeId("master"), "master"],
    ]),
    spectrum: new Map<string, bigint>([
      ...tracks.map((track) => [track.id, nativeGraphNodeId(track.id)] as const),
      ["master", nativeGraphNodeId("master")] as const,
    ]),
  })

  const promoteNativeObservationMaps = (
    revision: number,
    candidate: ReturnType<typeof nativeObservationMaps>,
  ) => {
    const previousTracks = new Set([...nativeMeterNodeIds.values()].filter((id) => id !== "master"))
    const nextTracks = new Set([...candidate.meters.values()].filter((id) => id !== "master"))
    const changed = new Map<string, TrackStereoLevels>()
    const levels = new Map(nativeLevels)
    for (const id of previousTracks) {
      if (nextTracks.has(id)) continue
      levels.delete(id)
      changed.set(id, { left: 0, right: 0 })
    }
    for (const id of nextTracks) {
      if (previousTracks.has(id)) continue
      levels.set(id, { left: 0, right: 0 })
      changed.set(id, { left: 0, right: 0 })
    }
    const target = nativeSpectrumTarget
    const wasSelected = target !== undefined && nativeSpectrumNodeIds.has(target)
    const nextNodeId = target === undefined ? undefined : candidate.spectrum.get(target)
    nativeMeterRevision = revision
    nativeMeterNodeIds = candidate.meters
    nativeSpectrumNodeIds = candidate.spectrum
    if (target !== undefined && candidate.spectrum.has(target)) {
      nativeSpectrumDesiredNodeId = candidate.spectrum.get(target)
      reconcileNativeSpectrumSelection(true)
    }
    nativeLevels = levels
    if (changed.size > 0) {
      for (const listener of nativeMeterListeners) listener(changed)
    }

    if (target === undefined) return
    if (nextNodeId !== undefined) return
    if (!wasSelected) return
    nativeSpectrumTarget = undefined
    nativeSpectrumDesiredNodeId = null
    latestSpectrumSequence = 0n
    for (const listener of nativeSpectrumListeners) listener(null)
    if (nativeSessionStarted) reconcileNativeSpectrumSelection(true)
  }

  const handleNativeSpectrumFrame = (frame: NativeHostSpectrumFrame) => {
    const nodeId = nativeSpectrumNodeIds.get(nativeSpectrumTarget ?? "")
    if (
      !nodeId || frame.graphRevision !== nativeMeterRevision
      || frame.transportEpoch !== transportEpoch || frame.nodeId !== nodeId
      || frame.sequence <= latestSpectrumSequence
    ) return
    latestSpectrumSequence = frame.sequence
    const next: SpectrumFrame = {
      data: frame.data,
      sampleRate: frame.sampleRateHz,
      graphRevision: frame.graphRevision,
      transportEpoch: frame.transportEpoch,
      sequence: frame.sequence,
      nodeId: frame.nodeId,
      fftSize: frame.fftSize,
      binCount: frame.binCount,
    }
    for (const listener of nativeSpectrumListeners) listener(next)
  }
  const clearNativeSpectrumFrame = () => {
    latestSpectrumSequence = 0n
    for (const listener of nativeSpectrumListeners) listener(null)
  }

  const handleNativeMeterBatch = (batch: NativeHostMeterBatch) => {
    if (batch.graphRevision !== nativeMeterRevision || batch.transportEpoch !== transportEpoch
      || batch.sequence <= latestMeterSequence) return
    latestMeterSequence = batch.sequence
    const levels = new Map<string, TrackStereoLevels>()
    let master: TrackStereoLevels | undefined
    for (const entry of batch.entries) {
      const nodeId = nativeMeterNodeIds.get(entry.nodeId)
      if (!nodeId) continue
      const next = {
        left: Math.min(1, Math.max(0, entry.leftRms)),
        right: Math.min(1, Math.max(0, entry.rightRms)),
      }
      if (nodeId === "master") master = next
      else levels.set(nodeId, next)
    }
    if (levels.size > 0) {
      nativeLevels = new Map([...nativeLevels, ...levels])
      for (const listener of nativeMeterListeners) listener(levels)
    }
    if (master) {
      nativeMasterLevels = master
      for (const listener of nativeMasterMeterListeners) listener(master)
    }
  }

  const reportFault = (fault: NativePlaybackFault, options?: { retainPlayback: true }) => {
    input.reportFault?.(fault, options)
  }
  const reportStopped = (message: string, options?: { retainPlayback: true }) =>
    reportFault({ kind: "session-stopped", message }, options)
  // A live edit that fails to adopt is never shown: the old graph keeps playing, the edit stays in the project,
  // and the next submission retries it. The log is the only record.
  const logFailedAdoption = (reason: string) => console.warn("[native-live-edit] adoption failed; the playing graph is unchanged", { reason })

  const handleNativeScheduleProgress = (progress: NativeScheduleProgress) => {
    const retirementChanged = progress.epoch === transportEpoch
      && (progress.latencyCompletionGeneration ?? 0n) > nativeLatencyCompletionGeneration
    const capacity = progress.admissionCapacityGeneration
    if (progress.epoch === transportEpoch && capacity !== undefined && capacity > nativeAdmissionCapacityGeneration) {
      nativeAdmissionCapacityGeneration = capacity
      advanceScheduleCapacityEpoch()
    }
    const completions = progress.latencyCompletionGeneration
    if (progress.epoch === transportEpoch && completions !== undefined && completions > nativeLatencyCompletionGeneration) {
      nativeLatencyCompletionGeneration = completions
      prepareAdmissionWake?.()
    }
    latestScheduleProgress = progress
    processorState.publication()?.transportWake?.()
    processorState.publication()?.progress?.(progress)
    executeReconcile(processorState.observe(progress))
    // The token names the claim that resolved, so it settles while paused and quiet; the fence it releases lets the
    // lane send again and every target that waited for it be reconciled.
    const resolved = progress.processorPatchResolved
    if (resolved) executeReconcile(processorState.resolution(BigInt(resolved.token), resolved.result))
    if (processorState.hasQueuedPatch()) void drainStatePatches()
    const held = processorState.retirement()
    if (progress.epoch === transportEpoch && held) {
      const point = held.readerPoint
      const readerPassed = point && (progress.epoch > point.epoch
        || (!held.readerPassed && progress.epoch === point.epoch && progress.renderedThroughFrame > point.frame))
      if (readerPassed) {
        held.readerPassed = true
        held.readerPoint = { ...point, epoch: progress.epoch, frame: progress.renderedThroughFrame }
      }
      if (readerPassed || retirementChanged) retirementOpportunity()
    }
  }

  const hasNativeHostConnectionLoss = () => {
    if (!nativeHostConnectionLost) return false
    const projectGeneration = resolveProjectGeneration()
    if (
      nativeHostLossProjectGeneration !== undefined
      && projectGeneration !== nativeHostLossProjectGeneration
    ) {
      nativeHostConnectionLost = false
      nativeHostLossProjectGeneration = undefined
      nativeHostLossReason = undefined
      nativeHostRecoveryAvailable = false
      nativeHostRecoveryUsed = false
      nativeHostLossReported = false
      return false
    }
    return true
  }

  const nativeHostConnectionLossMessage = () =>
    nativeHostLossReason ?? "Native playback host connection was lost."

  const reportBlockedByNativeHostConnectionLoss = () => {
    const message = `Native playback start was skipped: ${nativeHostConnectionLossMessage()}`
    console.error("[native-vst3] native start unavailable", {
      result: "unavailable",
      error: message,
    })
    reportStopped(message)
  }

  const markNativeHostConnectionLost = (reason?: string) => {
    if (nativeHostConnectionLost) return false
    nativeHostConnectionLost = true
    nativeHostLossProjectGeneration = resolveProjectGeneration()
    nativeHostLossReason = reason ?? nativeHostConnectionLossMessage()
    nativeHostRecoveryAvailable = !nativeHostRecoveryUsed
    nativeHostLossReported = false
    return true
  }

  const beginNativeHostRecovery = () => {
    if (!hasNativeHostConnectionLoss() || !nativeHostRecoveryAvailable) return false
    nativeHostRecoveryAvailable = false
    nativeHostRecoveryUsed = true
    nativeHostConnectionLost = false
    nativeHostLossProjectGeneration = undefined
    nativeHostLossReason = undefined
    nativeHostLossReported = false
    return true
  }

  const completeNativeHostRecovery = () => {
    nativeHostRecoveryUsed = false
  }

  const reportNativeHostLossFault = (message: string) => {
    if (nativeHostLossReported) return
    nativeHostLossReported = true
    reportStopped(message)
  }

  const resetNativeHostConnectionLoss = () => {
    nativeHostConnectionLost = false
    nativeHostLossProjectGeneration = undefined
    nativeHostLossReason = undefined
    nativeHostRecoveryAvailable = false
    nativeHostRecoveryUsed = false
    nativeHostLossReported = false
  }

  const createCoordinatorForEpoch = (options: {
    snapshot: LivePlaybackSnapshot
    epoch: number
    sampleRateHz: number
    assets: readonly NativeSessionAsset[]
    preparedStretchAssets?: readonly NativePreparedStretchAsset[]
    nativePcmChunkDescriptors?: readonly NativePcmChunkDescriptor[]
    projectGeneration?: number
    startFrame: number
    graph?: AudioCoreGraphSnapshot
  }) => {
    const bridge = input.bridge
    if (!bridge) throw new Error("The native playback bridge is unavailable.")
    const sessionGeneration = ++nativeSessionGeneration
    return createNativeScheduleCoordinator({
      bridge: {
        queueScheduleWindow: (...args) => observeRetirementControl(bridge.session.queueScheduleWindow(...args)),
        queueInstrumentEvents: (...args) => observeRetirementControl(bridge.session.queueInstrumentEvents(...args)),
        reenableVstScheduleAutomation: bridge.session.reenableVstScheduleAutomation,
        onScheduleProgress: (listener) => bridge.session.onScheduleProgress((progress) => {
          if (sessionGeneration !== nativeSessionGeneration) return
          handleNativeScheduleProgress(progress)
          listener(progress)
        }),
        onLoss: bridge.session.onLoss,
      },
      snapshot: { ...options.snapshot, revision: options.graph?.revision ?? options.snapshot.revision },
      graph: options.graph,
      acceptsLiveMidi: true,
      epoch: options.epoch,
      sampleRateHz: options.sampleRateHz,
      capacity: {
        maximumFramesPerBlock: maximumFramesPerBlock,
        maximumVstEventsPerBlock: maxVst3WorkerFrames,
      },
      assets: options.assets,
      assetSourceKeys: installedAssetSourceKeys,
      preparedStretchAssets: options.preparedStretchAssets,
      nativePcmChunkDescriptors: options.nativePcmChunkDescriptors,
      pageManager: nativeTimelinePageManager,
      projectGeneration: options.projectGeneration,
      startFrame: options.startFrame,
      onFault: (error) => {
        if (sessionGeneration !== nativeSessionGeneration) return
        void disposeNativeSession(undefined, "native-fault").catch(() => undefined)
        reportStopped(error.message)
      },
      onRenderedFrame: (renderedFrame) => {
        if (renderedFrame >= transportFrame) transportFrame = renderedFrame
      },
      onRefillDiagnostics: () => undefined,
      onHostLoss: (error) => {
        if (sessionGeneration !== nativeSessionGeneration) return
        handleNativeHostLoss(error)
      },
    })
  }

  const invalidateNativeOwnership = (hostLost = false, preservePendingStart = false) => {
    lifecycleGeneration += 1
    stagedTransportIntent++
    preparedTransportTransitionGeneration += 1
    nativeSessionGeneration += 1
    latestScheduleProgress = undefined
    nativeAdmissionCapacityGeneration = 0n
    nativeLatencyCompletionGeneration = 0n
    disposeKept(processorState.clear())
    scheduleCandidates.clear()
    liveInstrumentQueueGeneration += 1
    liveInstrumentEventTail = Promise.resolve()
    if (!preservePendingStart) {
      pendingStart = undefined
      pendingStartMode = undefined
      pendingStartCompileContext = undefined
    }
    const reason = new NativePlaybackAbortError("ownership-invalidated")
    stretchPreparationAbortController?.abort(reason)
    stretchPreparationAbortController = undefined
    startAbortController?.abort(reason)
    startAbortController = undefined
    const hadSession = prepared
      || nativeSessionStarted
      || active
      || livePreviewActive
      || scheduleCoordinator !== undefined
      || recording !== undefined
    if (hostLost) {
      for (const scope of instrumentMemoryScopes) scope.release()
      instrumentMemoryScopes.clear()
      instrumentMemoryScope = undefined
      input.onInstrumentPreparation?.(preparedInstrumentTrackIds, {
        state: "error", error: nativeHostConnectionLossMessage(),
      })
      preparedInstrumentTrackIds = []
    }
    if (hostLost && recording && recording.latestStatus?.spool?.state !== 2) {
      recording.terminal = true
      recording.onFailure?.(new Error(nativeHostConnectionLossMessage()), "controller-cleanup")
      const lostRecording = recording
      const error = new Error(nativeHostConnectionLossMessage())
      for (const waiter of lostRecording.waiters) waiter.reject(error)
      lostRecording.waiters.clear()
      lostRecording.unsubscribeStatus()
      lostRecording.unsubscribeFailure()
      lostRecording.unsubscribeLoss()
      recording = undefined
    }
    active = false
    prepared = false
    loopAppliesAtTransportPosition = true
    nativeSessionStarted = false
    livePreviewActive = false
    for (const listener of nativeLiveMidiResetListeners) listener()
    liveNoteReadiness.clear()
    liveMidiTailOwned = false
    scheduleCoordinator?.dispose()
    scheduleCoordinator = undefined
    clearNativeMeters()
    clearNativeSpectrum()
    clearVstInstanceEvents()
    preparedProjectGeneration = undefined
    preparedProjectId = undefined
    preparedSnapshot = undefined
    preparedGraph = undefined
    structuralGraphGeneration++
    preparedHostIdentity = undefined
    installedAssets = []
    installedAssetIds = []
    preparedStretchAssetsForSession = []
    nativePcmChunkDescriptorsForSession = []
    installedAssetSourceKeys = new Map()
    const pageManager = nativeTimelinePageManager
    const releaseStretch = preparedStretchLeaseSession
    const candidateLeases = [...pendingStretchCandidates]
    pendingStretchCandidates.clear()
    const drain = (async () => {
      await pageManager?.dispose()
      await releaseStretch?.()
      if (candidateLeases.length > 0) await Promise.all(candidateLeases.map((release) => release()))
    })().catch(() => {})
    nativeStretchDrainPromise = nativeStretchDrainPromise
      ? Promise.all([nativeStretchDrainPromise, drain]).then(() => undefined)
      : drain
    nativeTimelinePageManager = undefined
    preparedStretchLeaseSession = undefined
    sampleRate = 0
    maximumFramesPerBlock = 0
    transportFrame = 0
    if (hadSession) transportEpoch += 1
  }

  const disposeNativeSession = async (
    options?: { invalidateProjectArtifacts?: boolean; onStoppedPosition?: (seconds: number) => void },
    reason = "native-session-dispose",
  ) => {
    intentionalHostTransitionDepth += 1
    let unsubscribeRetirementLoss: (() => void) | undefined
    try {
      const bridge = input.bridge
      const assetIds = installedAssetIds
      const pageManager = nativeTimelinePageManager
      const memoryScope = instrumentMemoryScope
      const stoppedSampleRate = sampleRate
      const retiringHost = preparedHostIdentity
      const retiringRevision = preparedGraph?.revision
      const retiringEpoch = transportEpoch
      const stoppedLoop = preparedSnapshot && loopAppliesAtTransportPosition
        ? nativeLoopFramesForSnapshot(preparedSnapshot, sampleRate)
        : undefined
      instrumentMemoryScope = undefined
      input.onInstrumentPreparation?.(preparedInstrumentTrackIds, { state: "loading" })
      preparedInstrumentTrackIds = []
      const hostLost = hasNativeHostConnectionLoss()
      let lostDuringRetirement = hostLost
      unsubscribeRetirementLoss = bridge?.session.onLoss(() => { lostDuringRetirement = true })
      invalidateNativeOwnership()
      await pageManager?.dispose()
      await nativeStretchDrainPromise
      if (options?.invalidateProjectArtifacts) stretchCache?.invalidate()
      if (!bridge || hostLost) {
        for (const scope of instrumentMemoryScopes) scope.release()
        instrumentMemoryScopes.clear()
        if (hostLost && options?.onStoppedPosition) throw new Error("Native playback host connection was lost before Stop.")
        return
      }
      const stopPromise = bridge.session.stop(reason)
      const readDiagnostics = bridge.diagnostics
      const stoppedPosition = options?.onStoppedPosition && readDiagnostics && stoppedSampleRate > 0
        ? stopPromise.then(async (stopReply) => {
          assertReply(stopReply)
          if (lostDuringRetirement || !retiringHost || retiringRevision === undefined) {
            throw new Error("The retiring native playback session is unavailable.")
          }
          const reply = await readDiagnostics()
          if (!reply.ok) throw new Error(reply.error)
          if (lostDuringRetirement
            || !Number.isSafeInteger(retiringHost.pid)
            || !Number.isSafeInteger(retiringHost.generation)
            || !Number.isSafeInteger(retiringHost.configurationGeneration)
            || !Number.isSafeInteger(reply.configurationGeneration)
            || reply.status.pid !== retiringHost.pid
            || reply.status.generation !== retiringHost.generation
            || reply.diagnostics.activeRevision !== retiringRevision
            || reply.diagnostics.transportEpoch !== retiringEpoch
            || reply.configurationGeneration !== retiringHost.configurationGeneration) {
            throw new Error("The stopped native playback session identity changed.")
          }
          options.onStoppedPosition?.(
            arrangementFrameForNativeFrame(Number(reply.diagnostics.transportFrame), stoppedLoop) / stoppedSampleRate,
          )
        })
        : stopPromise
      await cancelRecording().catch(() => undefined)
      // Diagnostics uses the host's single control slot directly. Read the Stop
      // boundary before queuing releases, which would otherwise occupy that slot.
      if (options?.onStoppedPosition && readDiagnostics && stoppedSampleRate > 0) {
        await stoppedPosition.catch(() => undefined)
      }
      const [stopResult] = await Promise.allSettled([
        stoppedPosition,
        ...assetIds.map((sessionAssetId) => bridge.session.releaseAsset(sessionAssetId)),
      ])
      const teardown = await bridge.session.teardown(reason).catch(() => undefined)
      if (teardown?.ok) {
        releaseInstrumentScope(memoryScope)
        // Teardown also owns attempts cancelled while their ACK was in flight.
        for (const scope of instrumentMemoryScopes) scope.release()
        instrumentMemoryScopes.clear()
      }
      if (options?.onStoppedPosition && stopResult?.status === "rejected") throw stopResult.reason
      if (options?.onStoppedPosition && stopResult?.status === "fulfilled" && stopResult.value) assertReply(stopResult.value)
    } finally {
      unsubscribeRetirementLoss?.()
      intentionalHostTransitionDepth -= 1
    }
  }
  const dispose = (
    options?: { invalidateProjectArtifacts?: boolean; onStoppedPosition?: (seconds: number) => void },
    reason?: string,
  ) => {
    if (input.externalSessionOwner) return Promise.resolve()
    // Paused-preview maintenance can race the playing→paused signal change.
    // It never owns an active transport, including its publication/ACK handoff: it waits for that transition, and
    // disposes the session only if it is still paused then. A failed pause has already disposed it.
    if (reason === "paused-preview-structural-change" && active && processorState.publication())
      return preparedTransportTransition.then(() => active || !prepared ? undefined : disposeNativeSession(options, reason))
    return disposeNativeSession(options, reason)
  }
  const cancelPendingStart = () => {
    const request = pendingStart
    if (!request) return Promise.resolve()
    instrumentPreparationRequestGeneration += 1
    invalidateNativeOwnership()
    return request.catch(() => undefined)
  }
  const handleNativeHostLoss = (error?: string) => {
    if (intentionalHostTransitionDepth > 0) return
    const ownsNativeSession = prepared
      || nativeSessionStarted
      || active
      || livePreviewActive
      || scheduleCoordinator !== undefined
      || recording !== undefined
    if (!ownsNativeSession) return
    const message = error ?? "Native playback host connection was lost."
    if (!markNativeHostConnectionLost(message)) return
    invalidateNativeOwnership(true, true)
    reportNativeHostLossFault(message)
  }

  const startAttempt = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
    compileContext?: LivePlaybackCompileContext,
    previewAttempt?: NativePreviewAttempt,
  ): Promise<NativeStartResult> => {
    const bridge = input.bridge
    if (!bridge) return "unavailable"
    const preparedProjectIdForAttempt = input.getProjectId?.()
    const instrumentPreparationIdentity = ++instrumentPreparationGeneration
    const instrumentPreparationRequestIdentity = instrumentPreparationRequestGeneration
    if (hasNativeHostConnectionLoss()) {
      reportBlockedByNativeHostConnectionLoss()
      return "unavailable"
    }
    let attemptedCoordinator: NativeScheduleCoordinator | undefined
    let attemptedPageManager: NativeTimelinePageManager | undefined
    let attemptStartController = startAbortController
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== resolveProjectGeneration()
      || preparedProjectIdForAttempt !== input.getProjectId?.()
      || (attemptStartController !== undefined && startAbortController !== attemptStartController)
      || (attemptedCoordinator !== undefined
        && (scheduleCoordinator !== attemptedCoordinator || attemptedCoordinator.isDisposed()))
      || (attemptedPageManager !== undefined
        && (nativeTimelinePageManager !== attemptedPageManager || attemptedPageManager.isDisposed()))
    if (prepared && preparedProjectGeneration === projectGeneration && preparedProjectId === preparedProjectIdForAttempt) {
      let previousCoordinator: NativeScheduleCoordinator | undefined
      try {
        previousCoordinator = scheduleCoordinator
        attemptedCoordinator = previousCoordinator
        attemptedPageManager = nativeTimelinePageManager
        // Public project control can persist automation while a paused native
        // session remains prepared. Recompile before resuming its coordinator.
        const compiled = await input.compileSnapshot(transport, compileContext)
        const refreshed = compiled.supported
          ? { ...compiled, snapshot: { ...compiled.snapshot, transport } }
          : compiled
        // The prepared session schedules only the sources and processors it installed: a recompile that names another
        // source, or places other processors, needs a prepare.
        const installedSources = new Set(preparedSnapshot?.assets.map((asset) => asset.assetId))
        if (!refreshed.supported || refreshed.snapshot.revision !== preparedSnapshot?.revision
          || refreshed.snapshot.assets.some((asset) => !installedSources.has(asset.assetId))
          || processorMembership(refreshed.snapshot) !== processorMembership(preparedSnapshot)) {
          preparedProjectGeneration = undefined
        } else {
          const frame = Math.round(transport.playheadSec * sampleRate)
          const effectiveTransport = effectiveLoopForStart(transport, frame, sampleRate)
          const effectiveSnapshot = { ...refreshed.snapshot, transport: effectiveTransport }
          // The recompile carries processor content the prepared graph may not hold: the ledger takes it and sends it,
          // as a prepare does for content edited after its compile.
          const adoptRecompiled = () => {
            preparedSnapshot = refreshed.snapshot
            ingestProjectedProcessors(refreshed.snapshot)
            if (preparedGraph) executeReconcile(processorState.reconcile(targetKinds(preparedGraph, refreshed.snapshot)))
          }
          if (cancelled()) return "unavailable"
          // An orphaned prepare leaves its tracks `loading` while the session stays prepared: resuming it restores `ready`.
          const resumed = (): "started" => {
            input.onInstrumentPreparation?.(preparedInstrumentTrackIds, { state: "ready" })
            return "started"
          }
          if (
            runTransport
            && !compileContext
            && previousCoordinator
            && preparedSnapshot
            && hasEquivalentTransportScheduling(preparedSnapshot.transport, transport)
            && loopAppliesAtTransportPosition === effectiveTransport.loopEnabled
            && frame === transportFrame
          ) {
            // A same-frame seek may still be stopping and priming this epoch. Resume in its transaction lane,
            // after its existing transition/accepted waits, and keep a following pause ordered behind the resume.
            const coordinator = previousCoordinator
            return await queuePreparedTransportTransition(async () => {
              if (cancelled()) return "unavailable"
              const runTransitionId = ++nextTransportTransitionId
              assertReply(await bridge.session.setTransport(
                nativeTransportFor(effectiveSnapshot, transportEpoch, true, frame, runTransitionId),
              ))
              await coordinator.waitForTransition(runTransitionId, true)
              if (cancelled()) return "unavailable"
              adoptRecompiled()
              transportFrame = frame
              loopAppliesAtTransportPosition = effectiveTransport.loopEnabled
              active = true
              livePreviewActive = true
              return resumed()
            })
          }
          const nextCoordinator = createCoordinatorForEpoch({
            snapshot: effectiveSnapshot,
            epoch: transportEpoch + 1,
            sampleRateHz: sampleRate,
            assets: installedAssets,
            preparedStretchAssets: preparedStretchAssetsForSession,
            nativePcmChunkDescriptors: nativePcmChunkDescriptorsForSession,
            projectGeneration: safePreparedProjectGeneration(projectGeneration),
            startFrame: frame,
            graph: preparedGraph,
          })
          if (preparedGraph) nextCoordinator.preflight(preparedGraph)
          transportEpoch += 1
          disposeKept(processorState.endDomain(transportEpoch))
          clearNativeSpectrumFrame()
          previousCoordinator?.dispose()
          nextCoordinator.install()
          scheduleCoordinator = nextCoordinator
          attemptedCoordinator = nextCoordinator
          const transitionId = ++nextTransportTransitionId
          assertReply(await bridge.session.setTransport(
            nativeTransportFor(effectiveSnapshot, transportEpoch, false, frame, transitionId),
          ))
          await nextCoordinator.waitForTransition(transitionId, false)
          await nextCoordinator.prime(frame)
          await nextCoordinator.waitForAccepted(frame + Math.min(maximumFramesPerBlock, nextCoordinator.scheduleEndFrame() - frame))
          // Acceptance can resolve in the turn a dispose retires this attempt: never run a transport it no longer owns.
          if (cancelled()) return "unavailable"
          if (runTransport) {
            const runTransitionId = ++nextTransportTransitionId
            assertReply(await bridge.session.setTransport(
              nativeTransportFor(effectiveSnapshot, transportEpoch, true, frame, runTransitionId),
            ))
            await nextCoordinator.waitForTransition(runTransitionId, true)
          }
          if (cancelled()) {
            return "unavailable"
          }
          adoptRecompiled()
          transportFrame = frame
          loopAppliesAtTransportPosition = effectiveTransport.loopEnabled
          active = runTransport
          livePreviewActive = true
          return resumed()
        }
      } catch (error) {
        const diagnosticError = error === null || error === undefined
          ? undefined
          : error instanceof Error ? error : String(error)
        const ownsAttemptedCoordinator = attemptedCoordinator !== undefined
          ? scheduleCoordinator === attemptedCoordinator
          : scheduleCoordinator === previousCoordinator
        const wasCancelled = cancelled()
        if (ownsAttemptedCoordinator && !wasCancelled) {
          console.error("[native-vst3] session.start failed", {
            result: "unavailable",
            error: sanitizeNativeVst3DiagnosticError(diagnosticError),
          })
        }
        if (indicatesNativeHostConnectionLoss(diagnosticError)) {
          markNativeHostConnectionLost(error instanceof Error ? error.message : undefined)
        }
        if (!wasCancelled && ownsAttemptedCoordinator && !indicatesNativeHostConnectionLoss(diagnosticError)) {
          reportStopped(error instanceof Error ? error.message : "Native playback could not resume.")
        }
        if (ownsAttemptedCoordinator && !wasCancelled) {
          if (hasNativeHostConnectionLoss()) invalidateNativeOwnership(true, true)
          else await disposeNativeSession(undefined, "native-start-resume-failure")
        }
        return "unavailable"
      }
    }
    if (prepared) {
      const assetIds = installedAssetIds
      const pageManager = nativeTimelinePageManager
      const releaseStretch = preparedStretchLeaseSession
      const memoryScope = instrumentMemoryScope
      instrumentMemoryScope = undefined
      installedAssetIds = []
      nativeSessionGeneration += 1
      disposeKept(processorState.clear())
      scheduleCoordinator?.dispose()
      scheduleCoordinator = undefined
      clearNativeMeters()
      clearNativeSpectrum()
      clearVstInstanceEvents()
      active = false
      prepared = false
      nativeSessionStarted = false
      livePreviewActive = false
      liveInstrumentQueueGeneration += 1
      preparedProjectGeneration = undefined
      preparedProjectId = undefined
      preparedSnapshot = undefined
      preparedGraph = undefined
      structuralGraphGeneration++
      installedAssets = []
      preparedStretchAssetsForSession = []
      nativeTimelinePageManager = undefined
      preparedStretchLeaseSession = undefined
      nativePcmChunkDescriptorsForSession = []
      sampleRate = 0
      maximumFramesPerBlock = 0
      await Promise.allSettled([
        bridge.session.stop("native-start-replaced"),
        ...assetIds.map((sessionAssetId) => bridge.session.releaseAsset(sessionAssetId)),
      ])
      await pageManager?.dispose()
      await releaseStretch?.()
      const teardown = await bridge.session.teardown("native-start-replaced").catch(() => undefined)
      if (teardown?.ok) releaseInstrumentScope(memoryScope)
      else return "blocked"
    }
    const startAbortControllerForAttempt = new AbortController()
    startAbortController = startAbortControllerForAttempt
    attemptedCoordinator = undefined
    attemptedPageManager = undefined
    attemptStartController = startAbortControllerForAttempt
    let transactionOpen = false
    let transactionToken: string | undefined
    let committedAssetIds: readonly number[] | undefined
    const noteOrphanedSession = () => {
      if (previewAttempt && committedAssetIds) previewAttempt.orphanedAssetIds = committedAssetIds
    }
    let attemptedStretchLeaseDispose: (() => Promise<void>) | undefined
    let attemptedInstrumentScope: SampledInstrumentRegionBudgetScope | undefined
    let instrumentStateAdmitted = false
    let instrumentTrackIds: readonly string[] = []
    let releasePageStaging: (() => void) | undefined
    let requiresNative = false
    let startStage = "compile"
    try {
      const snapshotResult = await input.compileSnapshot(transport, compileContext)
      if (cancelled()) return "unavailable"
      if (!snapshotResult.supported) {
        const message = snapshotResult.reasons.join(" ") || "The project cannot be compiled for native playback."
        console.error("[native-vst3] native snapshot unsupported", { error: message })
        reportStopped(message)
        return "unavailable"
      }
      const { snapshot } = snapshotResult
      instrumentTrackIds = sampledInstrumentTrackIds(snapshot)
      input.onInstrumentPreparation?.(instrumentTrackIds, { state: "loading" })
      requiresNative = snapshot.requiresNativePlayback === true
      const unavailable = (message: string) => {
        if (!cancelled()) input.onInstrumentPreparation?.(instrumentTrackIds, { state: "error", error: message })
        if (!requiresNative) {
          if (input.reportUnavailable && !cancelled()) reportStopped(message)
          return "unavailable" as const
        }
        if (!cancelled()) reportStopped(message)
        return "blocked" as const
      }
      const supportError = nativeSnapshotSupportError(snapshot)
      if (supportError) return unavailable(supportError)
      const deviceReply = await bridge.resolveOutputDevice()
      if (cancelled()) return "unavailable"
      if (!deviceReply.ok && indicatesNativeHostConnectionLoss(deviceReply.error)) {
        markNativeHostConnectionLost(deviceReply.error)
      }
      if (!deviceReply.ok || !deviceReply.device?.available) return unavailable("No native audio output device is available for the active VST3 effect.")
      const runtimeMaximumFrames = Math.min(deviceReply.device.maximumFramesPerBlock, maxVst3WorkerFrames)
      sampleRate = deviceReply.device.nominalSampleRateHz
      maximumFramesPerBlock = runtimeMaximumFrames
      const attachmentPlan = snapshot.nativeExternalAttachmentPlan
        && planWithWorkerFrames(snapshot.nativeExternalAttachmentPlan, runtimeMaximumFrames)
      const configuredSnapshot = attachmentPlan
        ? { ...snapshot, nativeExternalAttachmentPlan: attachmentPlan }
        : snapshot
      const effectiveTransport = effectiveLoopForStart(
        snapshot.transport,
        Math.round(snapshot.transport.playheadSec * sampleRate),
        sampleRate,
      )
      const runtimeSnapshot = { ...configuredSnapshot, transport: effectiveTransport }
      const hasStretchClips = snapshot.tracks.some((track) => track.clips.some((clip) => (
        clip.midi === undefined
        && clip.audioWarp?.enabled === true
        && clip.audioWarp.mode === "stretch"
      )))
      preparedStretchAssetsForSession = []
      let preparedStretchAssets: readonly NativePreparedStretchAsset[] = []
      if (hasStretchClips) {
        const storage = ensureStretchStorage()
        const preparationAbortController = new AbortController()
        stretchPreparationAbortController = preparationAbortController
        try {
          const preparation = await prepareNativeStretchArtifacts({
            tracks: snapshot.tracks,
            projectBpm: snapshot.bpm,
            projectGeneration: safePreparedProjectGeneration(projectGeneration),
            cache: storage.cache,
            repository: storage.repository,
            signal: preparationAbortController.signal,
          })
          if (!preparation.supported) {
            return unavailable(preparation.diagnostics.map((diagnostic) => diagnostic.message).join(" "))
          }
          if (cancelled()) {
            await preparation.dispose()
            return "unavailable"
          }
          preparedStretchAssets = preparation.assets
          attemptedStretchLeaseDispose = preparation.dispose
        } finally {
          if (stretchPreparationAbortController === preparationAbortController) {
            stretchPreparationAbortController = undefined
          }
        }
      }
      const projection = compileLiveNativeProjection({
        tracks: snapshot.tracks,
        bpm: snapshot.bpm,
        sampleRateHz: deviceReply.device.nominalSampleRateHz,
        revision: snapshot.revision,
        epoch: transportEpoch,
        firstSequence: 1,
        fx: snapshot.mixer.fx,
        externalLatencyFrames: nativeOfflineExternalLatencyFrames(attachmentPlan),
        projectGeneration: safePreparedProjectGeneration(projectGeneration),
        preparedStretchAssets,
        instrumentRegionMode: "metadata",
      })
      if (!projection.supported) return unavailable(projection.reasons.join(" "))
      const instrumentRegionSources = projection.instrumentRegionSources ?? []
      const preparedStretchAssetsById = new Map(
        preparedStretchAssets.map((prepared) => [prepared.preparedStretchArtifactId ?? prepared.asset.assetId, prepared]),
      )
      for (const { asset, preparedStretchArtifactId } of projection.assets) {
        if (!preparedStretchArtifactId) continue
        const prepared = preparedStretchAssetsById.get(preparedStretchArtifactId)
        if (!prepared
          || prepared.asset.assetId !== preparedStretchArtifactId
          || prepared.asset.frameCount !== asset.frameCount
          || prepared.asset.sampleRateHz !== asset.sampleRateHz
          || prepared.asset.channelCount !== asset.channelCount) {
          return unavailable(`Native Stretch prepared artifact "${preparedStretchArtifactId}" is not a known source for this project.`)
        }
      }
      if (projection.assets.length > nativeAudioHostMaximumInstalledAssets) {
        return unavailable(nativeAssetCapacityError)
      }
      if (deviceReply.device.outputChannelCount < 2) return unavailable("The native audio output does not provide compatible stereo routing.")
      const assets = mapNativeSessionAssets(projection.graph.assets)
      const sessionAssetsById = new Map(assets.map((mapping) => [mapping.asset.assetId, mapping]))
      const instrumentSourcesByKey = new Map(instrumentRegionSources.map((source) => [source.sourceAssetKey, source.buffer]))
      if (instrumentSourcesByKey.size > 0) {
        const policy = bridge.instrumentBudgetPolicy
        if (!policy) throw new Error("Native sample memory policy is unavailable. Restart desktop audio and retry.")
        validateInstrumentAssetBudget(projection.graph.assets,
          projection.graph.nodes.flatMap((node) => node.instrument ? [node.instrument] : []), policy.deviceDecodedBytes)
        if (!instrumentBudget) throw new Error("Native sample memory policy is unavailable.")
        const scope = createInstrumentMemoryScope(instrumentRegionSources, projection.graph.assets,
          projection.graph.nodes.flatMap((node) => node.instrument ? [node.instrument] : []),
          policy.deviceDecodedBytes, `native-live:${crypto.randomUUID()}`,
          "Instrument sample memory budget exceeded (1 GiB per device). Shorten the region or remove samples and retry.")
        if (!scope) throw new Error("Native sample memory policy is unavailable.")
        attemptedInstrumentScope = scope
        releasePageStaging = scope.reserve("page-staging", 2 * 1024 ** 2).release
      }
      installedAssetSourceKeys = new Map(
        projection.assets.map(({ asset, sourceAssetKey }) => [asset.assetId, sourceAssetKey]),
      )
      const nativeGraph = projection.graph
      const instrumentIncarnations = captureInstrumentIncarnations(configuredSnapshot)
      startStage = "begin-transaction"
      const transactionReply = await bridge.session.beginTransaction()
      assertReply(transactionReply)
      transactionToken = transactionReply.transactionToken
      transactionOpen = true
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      if (attachmentPlan) {
        const coordinateVstAttachments = bridge.session.coordinateVstAttachments
        if (!coordinateVstAttachments) throw new Error("The native VST3 attachment coordinator is unavailable.")
        if (!preparedProjectIdForAttempt) throw new Error("The native VST3 attachment project is unavailable.")
        startStage = "coordinate-vst-attachments"
        const coordination = await coordinateVstAttachments({
          projectId: preparedProjectIdForAttempt,
          serializedPlan: encodeNativeExternalAttachmentPlan(attachmentPlan),
          sampleRateHz: deviceReply.device.nominalSampleRateHz,
          capturedVstStates: runtimeSnapshot.nativeExternalAttachmentStates,
          requiredVstStateInstanceIds: runtimeSnapshot.nativeExternalAttachmentStateRequirements,
        }, transactionToken)
        assertReply(coordination)
      }
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      startStage = "configure"
      const configurationReply = await bridge.session.configure({
        deviceId: deviceReply.device.deviceId,
        sampleRateHz: deviceReply.device.nominalSampleRateHz,
        maxFramesPerBlock: runtimeMaximumFrames,
        channelCount: 2,
        revision: snapshot.revision,
      }, transactionToken)
      assertReply(configurationReply)
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      if (bridge.session.createMappedAsset && bridge.session.writeMappedAssetPage && bridge.session.prepareMappedAssetRange) {
        const snapshotAssetsById = new Map(snapshot.assets.map((asset) => [asset.assetId, asset]))
        const clipsBySourceKey = new Map(snapshot.tracks.flatMap((track) => track.clips)
          .filter((clip): clip is typeof clip & { sourceAssetKey: string } => clip.sourceAssetKey !== undefined)
          .map((clip) => [clip.sourceAssetKey, clip]))
        const ordinaryAssets = projection.assets
          .filter(({ pcm }) => !pcm)
        const ordinarySources = (await Promise.all(ordinaryAssets.map(async ({ asset, sourceAssetKey }) => {
            const prepared = preparedStretchAssets.find((candidate) => (
              candidate.preparedStretchArtifactId === sourceAssetKey
            ))
            if (prepared) {
              return {
                sourceAssetKey,
                sessionAssetId: sessionAssetsById.get(asset.assetId)?.sessionAssetId ?? 0,
                frameCount: prepared.asset.frameCount,
                sampleRateHz: prepared.asset.sampleRateHz,
                channelCount: prepared.asset.channelCount,
                preparedStretchArtifactId: prepared.preparedStretchArtifactId,
                artifactRepository: preparedStretchRepository,
              }
            }
            const regionalBuffer = instrumentSourcesByKey.get(sourceAssetKey)
            const descriptor = await resolveTimelineDescriptor(sourceAssetKey, asset, snapshotAssetsById,
              clipsBySourceKey, regionalBuffer, startAbortControllerForAttempt.signal)
            return {
              sourceAssetKey,
              sessionAssetId: sessionAssetsById.get(asset.assetId)?.sessionAssetId ?? 0,
              frameCount: descriptor.frameCount,
              sampleRateHz: descriptor.sampleRate,
              channelCount: descriptor.channelCount,
              descriptor,
              immutableAfterPreparation: regionalBuffer !== undefined,
            }
          }))).filter((source) => source.sessionAssetId > 0)
        nativeTimelinePageManager = createNativeTimelinePageManager({
          sources: ordinarySources,
          writePage: async (page, signal) => {
            signal?.throwIfAborted()
            const writeMappedAssetPage = bridge.session.writeMappedAssetPage
            if (!writeMappedAssetPage) throw new Error("The native mapped asset page bridge is unavailable.")
            assertReply(await writeMappedAssetPage(page, nativeSessionStarted ? undefined : transactionToken))
          },
          prepareRange: async (sessionAssetId, startFrame, frameCount, signal) => {
            signal?.throwIfAborted()
            const prepareMappedAssetRange = bridge.session.prepareMappedAssetRange
            if (!prepareMappedAssetRange) throw new Error("The native mapped asset preparation bridge is unavailable.")
            assertReply(await prepareMappedAssetRange(
              sessionAssetId,
              startFrame,
              frameCount,
              nativeSessionStarted ? undefined : transactionToken,
            ))
          },
        })
        attemptedPageManager = nativeTimelinePageManager
      }
      for (const { asset, pcm, preparedStretchArtifactId } of projection.assets) {
        startStage = "install-asset"
        const mapping = sessionAssetsById.get(asset.assetId)
        if (!mapping) throw new Error("Native session asset mapping is incomplete.")
        if (pcm) {
          assertReply(await bridge.session.installAsset({
            sessionAssetId: mapping.sessionAssetId,
            frameCount: asset.frameCount,
            sampleRateHz: asset.sampleRateHz,
            channelCount: asset.channelCount,
            planarPcm: planarBytes(pcm.planes),
          }, transactionToken))
        } else if (bridge.session.createMappedAsset && bridge.session.writeMappedAssetPage && bridge.session.prepareMappedAssetRange) {
          await createMappedAsset(bridge.session, asset, mapping, preparedStretchArtifactId, transactionToken)
        } else {
          throw new Error("Native mapped asset hydration is unavailable.")
        }
        if (cancelled()) throw new Error("Native playback startup was cancelled.")
      }
      startStage = "prepare-instrument-regions"
      if (instrumentRegionSources.length > 0) {
        if (!attemptedPageManager) throw new Error("Native mapped instrument preparation is unavailable.")
        await prepareMappedResources([], attemptedPageManager, instrumentRegionSources.map(({ sourceAssetKey, buffer }) => ({
          sourceAssetKey, startFrame: 0, endFrame: buffer.length,
        })), startAbortControllerForAttempt.signal, false)
        releasePageStaging?.()
      }
      if (cancelled()) throw new NativePlaybackAbortError("ownership-invalidated")
      startStage = "publish-graph"
      const keepLatencyNodeIds = new Set(input.getKeepLatencyNodeIds?.())
      assertReply(await bridge.session.publishGraph(serializeNativeGraph(nativeGraph, keepLatencyNodeIds), transactionToken))
      if (instrumentRegionSources.length > 0 && !bridge.session.configureInstrumentStates) {
        throw new Error("Native instrument state preparation is unavailable.")
      }
      if (bridge.session.configureInstrumentStates) {
        startStage = "configure-instrument-states"
        assertReply(await bridge.session.configureInstrumentStates(
          serializeNativeInstrumentStates(
            nativeGraph.nodes.flatMap((node) => node.kind === "instrument" && node.instrument
              ? [{ nodeId: node.id, state: node.instrument }]
              : []),
            assets,
          ),
          transactionToken,
        ))
        instrumentStateAdmitted = true
      }
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      const parameterQueue = bridge.session.queueVstParameterEvents
      const parameterBatches = nativeVstParameterEventsForSnapshot(
        runtimeSnapshot,
      )
      if (parameterBatches.length > 0 && !parameterQueue) {
        throw new Error("The native VST3 parameter event bridge is unavailable.")
      }
      for (const batch of parameterBatches) {
        if (!parameterQueue) break
        assertReply(await parameterQueue(serializeNativeVstParameterEvents(batch.instanceId, batch.events), transactionToken))
      }
      const initialFrame = Math.round(snapshot.transport.playheadSec * deviceReply.device.nominalSampleRateHz)
      const nextCoordinator = createCoordinatorForEpoch({
        snapshot: runtimeSnapshot,
        epoch: transportEpoch,
        sampleRateHz: deviceReply.device.nominalSampleRateHz,
        assets,
        preparedStretchAssets,
        nativePcmChunkDescriptors: projection.nativePcmChunkDescriptors,
        projectGeneration: safePreparedProjectGeneration(projectGeneration),
        startFrame: initialFrame,
        graph: nativeGraph,
      })
      if (runTransport) nextCoordinator.preflight(nativeGraph)
      nextCoordinator.install()
      scheduleCoordinator = nextCoordinator
      attemptedCoordinator = nextCoordinator
      const initialTransitionId = ++nextTransportTransitionId
      startStage = "set-initial-transport"
      assertReply(await bridge.session.setTransport(
        nativeTransportFor(runtimeSnapshot, transportEpoch, false, initialFrame, initialTransitionId),
        transactionToken,
      ))
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      await nextCoordinator.queueInitialSynthState(initialFrame, transactionToken)
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      if (!transactionToken) throw new Error("Native playback transaction token was lost.")
      startStage = "commit-transaction"
      assertReply(await bridge.session.commitTransaction(transactionToken))
      transactionOpen = false
      transactionToken = undefined
      committedAssetIds = assets.map(({ sessionAssetId }) => sessionAssetId)
      if (cancelled()) {
        if (previewAttempt) {
          // Preview supersession reclaims this committed attempt once the
          // replacement is serialized behind its renderer delivery.
          noteOrphanedSession()
          // Retain the scope until serialized Stop/supersession teardown.
          attemptedInstrumentScope = undefined
        } else {
          await Promise.allSettled([
            bridge.session.stop("native-start-cancelled-after-commit"),
            ...committedAssetIds.map((sessionAssetId) => bridge.session.releaseAsset(sessionAssetId)),
          ])
          const reply = await bridge.session.teardown("native-start-cancelled-after-commit").catch(() => undefined)
          if (reply?.ok) releaseInstrumentScope(attemptedInstrumentScope)
        }
        return "unavailable"
      }
      installedAssetIds = committedAssetIds
      installedAssets = assets
      sessionResourceIds.clear()
      const snapshotAssetsByKey = new Map(snapshot.assets.map((asset) => [asset.assetId, asset]))
      for (const { asset, sourceAssetKey } of projection.assets) {
        const mapping = sessionAssetsById.get(asset.assetId)
        if (mapping) sessionResourceIds.set(resourceKey(asset, snapshotAssetsByKey.get(sourceAssetKey)), mapping.sessionAssetId)
      }
      nextSessionAssetId = Math.max(nextSessionAssetId, ...assets.map((asset) => asset.sessionAssetId + 1))
      preparedStretchAssetsForSession = preparedStretchAssets
      preparedStretchLeaseSession = attemptedStretchLeaseDispose
      attemptedStretchLeaseDispose = undefined
      nativePcmChunkDescriptorsForSession = projection.nativePcmChunkDescriptors
      preparedSnapshot = configuredSnapshot
      processorState.configured(configuredSnapshot.processorStateSequence ?? 0, installedContentOf(nativeGraph, configuredSnapshot, instrumentIncarnations))
      loopAppliesAtTransportPosition = effectiveTransport.loopEnabled
      preparedGraph = nativeGraph
      structuralGraphGeneration++
      preparedHostIdentity = configurationReply.hostIdentity
      preparedKeepLatencyNodeIds = keepLatencyNodeIds
      sampleRate = deviceReply.device.nominalSampleRateHz
      maximumFramesPerBlock = runtimeMaximumFrames
      transportFrame = Math.round(snapshot.transport.playheadSec * sampleRate)
      prepared = true
      instrumentMemoryScope = attemptedInstrumentScope
      attemptedInstrumentScope = undefined
      preparedInstrumentTrackIds = instrumentTrackIds
      preparedProjectId = preparedProjectIdForAttempt
      preparedProjectGeneration = projectGeneration
      configureNativeMeters(snapshot.revision, snapshot.tracks)
      configureNativeSpectrum(snapshot.tracks)
      unsubscribeMeters?.()
      unsubscribeMeters = bridge.session.onMeterBatch?.(handleNativeMeterBatch)
      unsubscribeSpectrum?.()
      unsubscribeSpectrum = bridge.session.onSpectrumFrame?.(handleNativeSpectrumFrame)
      clearVstInstanceEvents()
      clearVstInstanceFailures()
      unsubscribeVstInstanceEvents = bridge.session.onVstInstanceEvent?.(handleVstInstanceEvent)
      nativeSpectrumSelectedNodeId = undefined
      startStage = "start-session"
      assertReply(await bridge.session.start())
      if (cancelled()) {
        noteOrphanedSession()
        return "unavailable"
      }
      nativeSessionStarted = true
      reconcileNativeSpectrumSelection(true)
      await nextCoordinator.waitForTransition(nextTransportTransitionId, false)
      // VST workers are started only after the graph transaction is committed.
      // Prime the bounded owned schedule before either paused preview or playback.
      startStage = "prime-schedule"
      await nextCoordinator.prime(initialFrame)
      await nextCoordinator.waitForAccepted(initialFrame + Math.min(runtimeMaximumFrames, nextCoordinator.scheduleEndFrame() - initialFrame))
      // Acceptance can resolve in the turn a dispose retires this attempt: never run a transport it no longer owns.
      if (cancelled()) {
        noteOrphanedSession()
        return "unavailable"
      }
      if (runTransport) {
        const runTransitionId = ++nextTransportTransitionId
        assertReply(await bridge.session.setTransport(
          nativeTransportFor(runtimeSnapshot, transportEpoch, true, initialFrame, runTransitionId),
        ))
        await nextCoordinator.waitForTransition(runTransitionId, true)
      }
      if (cancelled()) {
        noteOrphanedSession()
        return "unavailable"
      }
      // Content edited since this compile read its snapshot is in the host's projection now: the ledger takes it and
      // sends what the session did not start with, before the session is reported active.
      ingestProjectedProcessors(configuredSnapshot)
      executeReconcile(processorState.reconcile(targetKinds(nativeGraph, configuredSnapshot)))
      active = runTransport
      livePreviewActive = true
      const membership = await updateKeepLatency()
      if (!membership.handled) throw new Error(membership.error ?? "Keep Latency could not be updated.")
      input.onInstrumentPreparation?.(instrumentTrackIds, { state: "ready" })
      return "started"
    } catch (error) {
      const wasCancelled = cancelled()
      if (wasCancelled) noteOrphanedSession()
      const diagnosticError = error instanceof Error && error.message.includes("byte aggregate limit")
        ? new Error(`${error.message} Remove unused samples or shorten the region, then retry.`)
        : error === null || error === undefined
        ? undefined
        : error instanceof Error ? error : String(error)
      const connectionLoss = indicatesNativeHostConnectionLoss(diagnosticError)
      if (connectionLoss) {
        markNativeHostConnectionLost(error instanceof Error ? error.message : undefined)
      }
      const hostLost = hasNativeHostConnectionLoss()
      if (transactionOpen && !hostLost) {
        if (transactionToken) await bridge.session.rollbackTransaction(transactionToken)
        if (!wasCancelled) await disposeNativeSession(undefined, "native-start-transaction-failure")
        else if (instrumentStateAdmitted) {
          // Rollback retires the bank but Phase 2 deliberately retains locks.
          // The successor is serialized behind this attempt; retire its host
          // resources without invalidating the successor's renderer generation.
          const teardown = await bridge.session.teardown("native-instrument-start-cancelled").catch(() => undefined)
          if (teardown?.ok) releaseInstrumentScope(attemptedInstrumentScope)
        }
      }
      else if (!wasCancelled && !hostLost) await disposeNativeSession(undefined, "native-start-failure")
      else if (!wasCancelled && hostLost) invalidateNativeOwnership(true, true)
      const result = requiresNative ? "blocked" : "unavailable"
      console.error("[native-vst3] native start failed", {
        result,
        stage: startStage,
        error: sanitizeNativeVst3DiagnosticError(diagnosticError),
      })
      if (
        !wasCancelled
        && instrumentPreparationIdentity === instrumentPreparationGeneration
        && instrumentPreparationRequestIdentity === instrumentPreparationRequestGeneration
        && preparedProjectIdForAttempt === input.getProjectId?.()
        && projectGeneration === resolveProjectGeneration()
        && !connectionLoss
      ) {
        input.onInstrumentPreparation?.(instrumentTrackIds, {
          state: "error", error: sanitizeNativeVst3DiagnosticError(diagnosticError),
        })
        reportStopped(
          `Native playback failed during ${startStage}: ${sanitizeNativeVst3DiagnosticError(diagnosticError)}`,
        )
      }
      return result
    } finally {
      if (startAbortController === startAbortControllerForAttempt) {
        startAbortController = undefined
      }
      await attemptedStretchLeaseDispose?.()
      if (!prepared || nativeTimelinePageManager !== attemptedPageManager) {
        await attemptedPageManager?.dispose()
      }
      releasePageStaging?.()
      // Phase 2 retains successful locks even after bank cancellation. A failed
      // or pending teardown must retain its charge until teardown or host loss.
      if (!instrumentStateAdmitted) releaseInstrumentScope(attemptedInstrumentScope)
    }
  }

  const start = (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<NativeStartResult> => {
    if (destroyed || input.externalSessionOwner) return Promise.resolve("unavailable")
    if (active) return Promise.resolve("started")
    if (pendingStart) {
      if (pendingStartMode === "play") return pendingStart
      const previewRequest = pendingStart
      instrumentPreparationRequestGeneration += 1
      const projectGeneration = resolveProjectGeneration()
      const projectId = input.getProjectId?.()
      // A seek made while this Play waits supersedes it, as it supersedes a resume under way: resuming at the Play's
      // older position would replace the seek's coordinator.
      const seekSequence = preparedSeekSequence
      // Cancelling the pending start retires this request too. A preview that fails on its own retires only itself.
      const preparationRequest = instrumentPreparationRequestGeneration
      const request = previewRequest.then(() =>
        destroyed || preparationRequest !== instrumentPreparationRequestGeneration || projectGeneration !== resolveProjectGeneration()
          || projectId !== input.getProjectId?.()
          || seekSequence !== preparedSeekSequence
          ? "unavailable"
          : startAttempt(transport, lifecycleGeneration, projectGeneration, true, compileContext))
      pendingStart = request
      pendingStartMode = "play"
      pendingStartCompileContext = compileContext
      void request.finally(() => {
        if (pendingStart === request) {
          pendingStart = undefined
          pendingStartMode = undefined
          pendingStartCompileContext = undefined
        }
      })
      return request
    }
    const generation = lifecycleGeneration
    const projectGeneration = resolveProjectGeneration()
    const request = (async () => {
      beginNativeHostRecovery()
      let result = await startAttempt(transport, generation, projectGeneration, true, compileContext)
      if (result !== "started" && hasNativeHostConnectionLoss() && beginNativeHostRecovery()) {
        result = await startAttempt(
          transport,
          lifecycleGeneration,
          projectGeneration,
          true,
          compileContext,
        )
      }
      if (result !== "started" && hasNativeHostConnectionLoss() && !nativeHostLossReported) {
        reportNativeHostLossFault(nativeHostConnectionLossMessage())
      }
      if (result === "started") completeNativeHostRecovery()
      return result
    })()
    pendingStart = request
    pendingStartMode = "play"
    pendingStartCompileContext = compileContext
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
        pendingStartCompileContext = undefined
      }
    })
    return request
  }

  const createLivePreviewStart = (
    playheadSec: number,
    compileContext?: LivePlaybackCompileContext,
  ): Promise<NativeStartResult> => {
    const generation = lifecycleGeneration
    const projectGeneration = resolveProjectGeneration()
    const previewAttempt: NativePreviewAttempt = {}
    pendingPreviewAttempt = previewAttempt
    const request = (async () => {
      beginNativeHostRecovery()
      const transport: LivePlaybackTransport = {
        state: "paused",
        playheadSec,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }
      let result = await startAttempt(transport, generation, projectGeneration, false, compileContext, previewAttempt)
      if (result !== "started" && hasNativeHostConnectionLoss() && beginNativeHostRecovery()) {
        result = await startAttempt(
          transport,
          lifecycleGeneration,
          projectGeneration,
          false,
          compileContext,
          previewAttempt,
        )
      }
      if (result !== "started" && hasNativeHostConnectionLoss() && !nativeHostLossReported) {
        reportNativeHostLossFault(nativeHostConnectionLossMessage())
      }
      if (result === "started") completeNativeHostRecovery()
      return result
    })()
    pendingStart = request
    pendingStartMode = "preview"
    pendingStartCompileContext = compileContext
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
        pendingStartCompileContext = undefined
      }
    })
    return request
  }

  const ensureLivePreview = (playheadSec: number, compileContext?: LivePlaybackCompileContext): Promise<NativeStartResult> => {
    if (destroyed || input.externalSessionOwner) return Promise.resolve("unavailable")
    if (!input.bridge) return Promise.resolve("unavailable")
    if (livePreviewActive) return Promise.resolve("started")
    if (pendingStart) {
      if (
        !compileContext
        || pendingStartMode !== "preview"
        || pendingStartCompileContext === compileContext
      ) return pendingStart
      const supersededPreview = pendingStart
      const supersededAttempt = pendingPreviewAttempt
      instrumentPreparationRequestGeneration += 1
      invalidateNativeOwnership(false, true)
      const supersessionGeneration = lifecycleGeneration
      const request = supersededPreview
        .catch((): NativeStartResult => "unavailable")
        .then(async () => {
          if (destroyed || supersessionGeneration !== lifecycleGeneration) return "unavailable"
          const orphanedAssetIds = supersededAttempt?.orphanedAssetIds
          const bridge = input.bridge
          if (supersededAttempt && orphanedAssetIds && bridge && !hasNativeHostConnectionLoss()) {
            // The superseded attempt has settled and no replacement can start
            // until this continuation finishes. Only its successful Commit owns
            // this cleanup; never cancel an unrelated recording.
            supersededAttempt.orphanedAssetIds = undefined
            intentionalHostTransitionDepth += 1
            try {
              invalidateNativeOwnership(false, true)
              await nativeStretchDrainPromise
              await Promise.allSettled([
                bridge.session.stop("preview-supersession"),
                ...orphanedAssetIds.map((assetId) => bridge.session.releaseAsset(assetId)),
              ])
              const teardown = await bridge.session.teardown("preview-supersession").catch(() => undefined)
              if (!teardown?.ok) return "blocked"
              for (const scope of instrumentMemoryScopes) scope.release()
              instrumentMemoryScopes.clear()
              instrumentMemoryScope = undefined
            } finally {
              intentionalHostTransitionDepth -= 1
            }
          }
          if (destroyed || pendingStart !== request) return "unavailable"
          return createLivePreviewStart(playheadSec, compileContext)
        })
      pendingStart = request
      pendingStartMode = "preview"
      pendingStartCompileContext = compileContext
      void request.finally(() => {
        if (pendingStart === request) {
          pendingStart = undefined
          pendingStartMode = undefined
          pendingStartCompileContext = undefined
        }
      })
      return request
    }
    return createLivePreviewStart(playheadSec, compileContext)
  }

  let preparedTransportTransition = Promise.resolve()
  const queuePreparedTransportTransition = <T>(task: () => Promise<T>) => {
    const transition = preparedTransportTransition.then(task)
    preparedTransportTransition = transition.then(() => undefined, () => undefined)
    return transition
  }

  const destroy = async () => {
    if (destroyPromise) return destroyPromise
    destroyed = true
    instrumentPreparationRequestGeneration += 1
    const pending = pendingStart
    destroyPromise = (async () => {
      if (!input.externalSessionOwner) await disposeNativeSession(undefined, "renderer-unmount")
      await pending?.catch(() => undefined)
      await stretchCache?.dispose()
      stretchCache = undefined
      await preparedStretchRepository?.dispose?.()
      preparedStretchRepository = undefined
    })()
    return destroyPromise
  }

  const transitionPreparedTransport = async (
    playheadSec: number,
    releaseTransportNotes: boolean,
    resumePlayback = false,
    loop?: Pick<LivePlaybackTransport, "loopEnabled" | "loopStartSec" | "loopEndSec">,
  ): Promise<boolean> => {
    const bridge = input.bridge
    if (!bridge) return false
    const frame = Math.round(playheadSec * sampleRate)
    const transitionGeneration = preparedTransportTransitionGeneration
    transportEpoch += 1
    disposeKept(processorState.endDomain(transportEpoch))
    clearNativeSpectrumFrame()
    let nextSnapshot = preparedSnapshot && loop
      ? { ...preparedSnapshot, transport: { ...preparedSnapshot.transport, ...loop } }
      : preparedSnapshot
    let transitionSnapshot = nextSnapshot && {
      ...nextSnapshot,
      transport: effectiveLoopForStart(nextSnapshot.transport, frame, sampleRate),
    }
    let nextCoordinator = transitionSnapshot && scheduleCoordinator
      ? createCoordinatorForEpoch({
        snapshot: transitionSnapshot,
        epoch: transportEpoch,
        sampleRateHz: sampleRate,
        assets: installedAssets,
        preparedStretchAssets: preparedStretchAssetsForSession,
        nativePcmChunkDescriptors: nativePcmChunkDescriptorsForSession,
        projectGeneration: preparedProjectGeneration === undefined
          ? undefined
          : safePreparedProjectGeneration(preparedProjectGeneration),
        startFrame: frame,
        graph: preparedGraph,
      })
      : undefined
    scheduleCoordinator?.dispose()
    nextCoordinator?.install()
    scheduleCoordinator = nextCoordinator
    const ownsTransition = () => transitionGeneration === preparedTransportTransitionGeneration
      && scheduleCoordinator === nextCoordinator
      && !nextCoordinator?.isDisposed()
    const transitionId = ++nextTransportTransitionId
    if (!nextSnapshot || !transitionSnapshot) return false
    try {
      const transport = nativeTransportFor(transitionSnapshot, transportEpoch, false, frame, transitionId)
      let reply: NativeSessionReply | undefined
      let transportError: unknown
      try {
        reply = await bridge.session.setTransport(transport)
      } catch (error) {
        transportError = error
      }
      const definiteRefusal = reply !== undefined && !reply.ok
        && "kind" in reply && reply.kind === "refused"
      const pendingPublication = processorState.publication()
      if (definiteRefusal && pendingPublication) {
        // The record supplies the one publication/control opportunity. No
        // transport-private subscription or cancellation lifetime is needed.
        while (ownsTransition() && !hasNativeHostConnectionLoss()) {
          const latest = await pendingPublication.inspect?.()
          if (!ownsTransition() || hasNativeHostConnectionLoss()) return false
          if (!latest?.ok || latest.revision.status !== "publish-pending") {
            reply = await bridge.session.setTransport(transport)
            transportError = undefined
            break
          }
          await new Promise<void>(resolve => { pendingPublication.transportWake = resolve })
        }
        pendingPublication.transportWake = undefined
      }
      if (transportError !== undefined) throw transportError
      if (!reply) throw new Error("Native transport reply was unavailable.")
      assertReply(reply)
      if (!ownsTransition()) return false
      // A cancelled Publish can win the callback immediately before Seek.
      // The paused transport ACK settles callback ownership; inspect it before
      // waiting on a coordinator whose runtime revision may now be stale.
      const settlePublication = processorState.publication()?.acknowledge
      const adoptedLate = !!settlePublication && await settlePublication(transportEpoch)
      // Settling a publication native never took ends that attempt, like a rollback does.
      if (adoptedLate) {
        nextCoordinator?.dispose()
        nextSnapshot = preparedSnapshot && loop
          ? { ...preparedSnapshot, transport: { ...preparedSnapshot.transport, ...loop } }
          : preparedSnapshot
        if (!nextSnapshot) return false
        transitionSnapshot = { ...nextSnapshot,
          transport: effectiveLoopForStart(nextSnapshot.transport, frame, sampleRate) }
        nextCoordinator = createCoordinatorForEpoch({
          snapshot: transitionSnapshot, epoch: transportEpoch, sampleRateHz: sampleRate,
          assets: installedAssets, preparedStretchAssets: preparedStretchAssetsForSession,
          nativePcmChunkDescriptors: nativePcmChunkDescriptorsForSession,
          projectGeneration: preparedProjectGeneration === undefined ? undefined
            : safePreparedProjectGeneration(preparedProjectGeneration),
          startFrame: frame, graph: preparedGraph,
        })
        scheduleCoordinator = nextCoordinator
        nextCoordinator.install()
        if (latestScheduleProgress) nextCoordinator.onProgress(latestScheduleProgress)
      }
      if (!ownsTransition()) return false
      await nextCoordinator?.waitForTransition(transitionId, false)
      if (!ownsTransition()) return false
      // Reset the progress floor on backward seeks before resuming callbacks.
      transportFrame = frame
      if (releaseTransportNotes) {
        const instrumentNodeIds = preparedGraph?.nodes
          .filter((node) => node.kind === "instrument")
          .map((node) => node.id) ?? []
        const releasePromises = instrumentNodeIds.map((nodeId) => {
          const sequence = nextLiveEventSequence++
          return queueLiveInstrumentEvent({
            nodeId,
            noteId: 1,
            sequence,
            // Urgent live events are applied in the next realtime block.
            frameOffset: 0,
            type: "transport-release",
            channel: 0,
            note: 0,
            value: 0,
          }).then((queued) => ({ queued, sequence }))
        })
        const releases = await Promise.all(releasePromises)
        const lastSequence = releases.reduce(
          (maximum, release) => release.queued ? Math.max(maximum, release.sequence) : maximum,
          0,
        )
        if (lastSequence > 0) await nextCoordinator?.waitForUrgent(BigInt(lastSequence))
        if (!ownsTransition()) return false
      }
      // A new epoch starts with no accepted schedule. Prime it while stopped
      // so a same-frame resume can run only after native lookahead exists.
      await nextCoordinator?.prime(frame)
      if (!ownsTransition()) return false
      await nextCoordinator?.waitForAccepted(
        frame + Math.min(maximumFramesPerBlock, nextCoordinator.scheduleEndFrame() - frame),
      )
      if (!ownsTransition()) return false
      if (resumePlayback) {
        // The host supports a running locate, but a new epoch first needs
        // accepted lookahead. Resume the same session only after priming it.
        const runTransitionId = ++nextTransportTransitionId
        assertReply(await bridge.session.setTransport(
        nativeTransportFor(transitionSnapshot, transportEpoch, true, frame, runTransitionId),
        ))
        if (!ownsTransition()) return false
        await nextCoordinator?.waitForTransition(runTransitionId, true)
        if (!ownsTransition()) return false
      }
    } catch (error) {
      if (!ownsTransition()) return false
      throw error
    }
    transportFrame = resumePlayback ? Math.max(frame, transportFrame) : frame
    active = resumePlayback
    preparedSnapshot = nextSnapshot
    loopAppliesAtTransportPosition = transitionSnapshot.transport.loopEnabled
    reconcileNativeSpectrumSelection(true)
    return true
  }

  const pause = async (playheadSec: number) => {
    const bridge = input.bridge
    if (!bridge || !active) return
    if (recording) throw new Error("Native recording must stop before playback can pause.")
    stagedTransportIntent++
    processorState.cancelPublication()
    try {
      await queuePreparedTransportTransition(async () => {
        if (!prepared || !active) return
        await transitionPreparedTransport(playheadSec, true)
      })
    } catch (error) {
      reportStopped(error instanceof Error ? error.message : "Native playback could not pause.")
      await disposeNativeSession(undefined, "native-pause-failure")
      throw error
    }
  }

  let preparedSeekSequence = 0
  const seekPrepared = async (playheadSec: number): Promise<NativeStartResult> => {
    const bridge = input.bridge
    if (!bridge || !prepared) return "unavailable"
    if (recording) throw new Error("Native recording must stop before playback can seek.")
    stagedTransportIntent++
    processorState.cancelPublication()
    const sequence = ++preparedSeekSequence
    const generation = preparedTransportTransitionGeneration
    try {
      return await queuePreparedTransportTransition(async () => {
        if (!prepared || generation !== preparedTransportTransitionGeneration) return "unavailable"
        if (sequence !== preparedSeekSequence) return "started"
        if (recording) return "unavailable"
        // Notes sounding before a running seek never receive their scheduled
        // note-off in the new epoch, so release them as pause does.
        const transitioned = await transitionPreparedTransport(playheadSec, active, active)
        return transitioned ? "started" : "unavailable"
      })
    } catch (error) {
      reportStopped(error instanceof Error ? error.message : "Native playback could not seek.")
      await disposeNativeSession(undefined, "native-seek-failure")
      throw error
    }
  }

  const updateLoop = async (loop: Pick<LivePlaybackTransport, "loopEnabled" | "loopStartSec" | "loopEndSec">) => {
    // Startup owns its coordinator until priming and the running ACK finish.
    // Hydrated loop settings must not replace it with a paused epoch mid-start.
    await pendingStart
    if (!prepared || !preparedSnapshot) return
    const sequence = ++loopUpdateSequence
    const matches = () => preparedSnapshot?.transport.loopEnabled === loop.loopEnabled
      && preparedSnapshot.transport.loopStartSec === loop.loopStartSec
      && preparedSnapshot.transport.loopEndSec === loop.loopEndSec
    if (pendingLoopUpdates === 0 && matches()) return
    pendingLoopUpdates++
    try {
      // A loop change follows the captured bank instead of moving its epoch
      // while Publish is still unresolved. This wait owns no execution lane.
      const publication = processorState.publication()
      if (publication) await publication.terminal
      await queuePreparedTransportTransition(async () => {
        if (!prepared || !preparedSnapshot) return
        if (sequence !== loopUpdateSequence) return
        if (matches()) return
        const position = currentPositionSec() ?? transportFrame / sampleRate
        await transitionPreparedTransport(position, active, active, loop)
      })
      // A newer loop request may have replaced ours while publication settled.
      // Its queued transition still owns completion of the caller's loop intent.
      await preparedTransportTransition
    } catch (error) {
      reportStopped(error instanceof Error ? error.message : "Native playback could not update its loop.")
      await disposeNativeSession(undefined, "native-loop-transition-failure")
      throw error
    } finally { pendingLoopUpdates-- }
  }

  const clearRecording = (session: NativeRecordingSession) => {
    session.unsubscribeStatus()
    session.unsubscribeFailure()
    session.unsubscribeLoss()
    for (const waiter of session.waiters) waiter.reject(new Error("Native recording session ended."))
    session.waiters.clear()
    if (recording === session) recording = undefined
  }

  const waitForStatus = (session: NativeRecordingSession, predicate: (status: NativeHostRecordingStatus) => boolean) => {
    if (session.latestStatus && predicate(session.latestStatus)) return Promise.resolve(session.latestStatus)
    if (session.terminal) return Promise.reject(new Error("Native recording was interrupted."))
    return new Promise<NativeHostRecordingStatus>((resolve, reject) => {
      session.waiters.add({ predicate, resolve, reject })
    })
  }

  const startRecording = async (recordingInput: {
    appSessionId: string
    projectId?: string
    projectGeneration?: number
    isCurrent?: () => boolean
    layout: "mono" | "stereo"
    inputChannel: number
    gain: number
    polarity: 1 | -1
    monitoring: boolean
    punchStartFrame: number
    punchEndFrame?: number
    onDiagnostics?: (diagnostics: NativeRecordingDiagnostics) => void
    onFailure?: (error: Error, cause: RecordingTerminationCause) => void
  }) => {
    const bridge = input.bridge
    if (!active || !bridge || recording || sampleRate === 0) throw new Error("Native playback is not active for recording.")
    const projectId = recordingInput.projectId ?? input.getProjectId?.()
    if (!projectId) throw new Error("Native recording requires a declared project intent.")
    const projectGeneration = resolveProjectGeneration()
    const scope = { projectId, projectGeneration: recordingInput.projectGeneration ?? projectGeneration }
    const channelCount = recordingInput.layout === "stereo" ? 2 : 1
    const inputChannels = channelCount === 2
      ? [recordingInput.inputChannel, recordingInput.inputChannel + 1] : [recordingInput.inputChannel]
    const numericSessionId = nextRecordingSessionId++
    const generation = recordingGeneration++
    const session: NativeRecordingSession = {
      appSessionId: recordingInput.appSessionId, numericSessionId, generation, scope,
      sampleRate, channelCount, terminal: false, waiters: new Set(),
      isCurrent: () => recording === session && !session.terminal && !destroyed && (recordingInput.isCurrent?.() ?? true)
        && (input.getProjectId?.() ?? projectId) === projectId && resolveProjectGeneration() === projectGeneration,
      unsubscribeStatus: () => undefined, unsubscribeFailure: () => undefined, unsubscribeLoss: () => undefined,
      onDiagnostics: recordingInput.onDiagnostics, onFailure: recordingInput.onFailure,
    }
    const rejectSession = (error: Error, cause: RecordingTerminationCause, proofFailure = false) => {
      if (session.terminal || (!proofFailure && session.latestStatus?.spool?.state === 2)) return
      session.terminal = true
      for (const waiter of session.waiters) waiter.reject(error)
      session.waiters.clear()
      // Main sends this only after native Complete. Auto-punch may have
      // finished before renderer Stop, so retire the local session before its
      // failure callback can request cleanup; never send Cancel to that owner.
      if (proofFailure && !session.finish) clearRecording(session)
      session.onFailure?.(error, cause)
      // Never cancel an accepted Finish. Its native owner resolves truthfully;
      // all published sources outlive this controller regardless of failure.
      if (!session.finish && !proofFailure) void cancelRecording().catch(() => undefined)
    }
    session.unsubscribeStatus = bridge.session.onRecordingStatus((status) => {
      if (status.generation !== generation || status.sessionId !== numericSessionId) return
      session.latestStatus = status
      session.onDiagnostics?.(status)
      if (status.fatal || status.spool?.state === 3 || status.spool?.state === 4) {
        rejectSession(new Error("Native recording was interrupted; retained sources remain available."), "native-fatal")
        return
      }
      for (const waiter of session.waiters) {
        if (!waiter.predicate(status)) continue
        session.waiters.delete(waiter)
        waiter.resolve(status)
      }
    })
    session.unsubscribeFailure = bridge.session.onRecordingFailure?.((failure) => {
      if (failure.generation !== generation || failure.sessionId !== numericSessionId) return
      rejectSession(new Error(failure.message), "writer-failure", true)
    }) ?? (() => undefined)
    session.unsubscribeLoss = bridge.session.onLoss((message) => {
      rejectSession(new Error(message ?? "Native recording host connection was lost."), "controller-cleanup")
    })
    recording = session
    try {
      const inputDeviceReply = await bridge.resolveInputDevice()
      const inputDevice = inputDeviceReply.ok ? inputDeviceReply.device : null
      if (!inputDevice?.available || inputChannels.some((channel) => channel >= inputDevice.inputChannelCount))
        throw new Error("No compatible native recording input device is available.")
      if (!session.isCurrent()) throw new Error("Recording scope changed.")
      const ready = await bridge.session.configureRecording({ ...scope, spoolImportVersion: 1,
        deviceUid: inputDevice.deviceId, generation, sessionId: numericSessionId, channelCount, inputChannels,
        gain: recordingInput.gain, polarity: recordingInput.polarity, punchStartFrame: recordingInput.punchStartFrame,
        punchEndFrame: recordingInput.punchEndFrame ?? null, monitoring: recordingInput.monitoring })
      assertReply(ready)
      if (!ready.takeId || ready.sampleRateHz !== sampleRate || ready.channelCount !== channelCount)
        throw new Error("Native recording verified readiness or sample rate mismatch.")
      session.takeId = ready.takeId
      session.sampleRate = ready.sampleRateHz
      if (!session.isCurrent()) throw new Error("Recording scope changed.")
      const started = waitForStatus(session, (status) => status.active)
      // Observe rejection immediately if Start itself rejects before the status.
      void started.catch(() => undefined)
      assertReply(await bridge.session.startRecording({ ...scope, generation, sessionId: numericSessionId }))
      const status = await started
      if (!session.isCurrent()) throw new Error("Recording scope changed.")
      return { sampleRate: session.sampleRate, channelCount, startFrame: status.timelineFrame }
    } catch (error) {
      if (!session.terminal) await bridge.session.cancelRecording().catch(() => undefined)
      clearRecording(session)
      throw error
    }
  }

  const stopRecording = () => {
    const bridge = input.bridge
    const session = recording
    if (!bridge || !session) return Promise.reject(new Error("Native recording is not active."))
    if (session.finish) return session.finish
    if (session.terminal) return Promise.reject(new Error("Native recording was interrupted."))
    // Install the promise before any asynchronous stop/control traffic. There is
    // intentionally no drain deadline: slow fsync is not evidence of lost data.
    session.finish = Promise.resolve().then(async () => {
      try {
        const complete = waitForStatus(session, (status) => status.spool?.state === 2)
        void complete.catch(() => undefined)
        assertReply(await bridge.session.stopRecording())
        const status = await complete
        if (!session.isCurrent()) throw new Error("Recording import scope changed; native source retained.")
        if (!session.takeId || !status.spool) throw new Error("Native recording Complete proof is unavailable.")
        let cursor: string | undefined
        do {
          const page = await bridge.recordingSpool.list(session.scope, cursor)
          if (!session.isCurrent()) throw new Error("Recording import scope changed; native source retained.")
          const take = page.takes.find((candidate) => candidate.takeId === session.takeId)
          if (take) {
            if (take.frames !== status.capturedFrames || take.frames !== status.spool.writtenFrames
              || take.bytes !== status.spool.writtenBytes || take.blocks !== status.spool.writtenBlocks
              || take.sampleRateHz !== session.sampleRate || take.channelCount !== session.channelCount)
              throw new Error("Native recording registry and Complete proof disagree.")
            return await (input.importRecordingSpool ?? importNativeRecordingSpool)({ bridge: bridge.recordingSpool,
              scope: session.scope, take, sessionId: session.appSessionId,
              expectedSampleRateHz: session.sampleRate, isCurrent: session.isCurrent })
          }
          cursor = page.nextCursor ?? undefined
        } while (cursor)
        throw new Error("Native recording retained take is unavailable.")
      } finally { clearRecording(session) }
    })
    return session.finish
  }

  async function cancelRecording() {
    const bridge = input.bridge
    const session = recording
    if (!bridge || !session) return
    if (session.finish) { await session.finish.catch(() => undefined); return }
    session.terminal = true
    try { assertReply(await bridge.session.cancelRecording()) }
    finally { clearRecording(session) }
  }

  const queueLiveInstrumentEvent = (event: NativeInstrumentEvent) => {
    const bridge = input.bridge
    if (!bridge || hasNativeHostConnectionLoss() || !livePreviewActive || sampleRate === 0) return Promise.resolve(false)
    const generation = liveInstrumentQueueGeneration
    const bytes = serializeNativeInstrumentEvents(transportEpoch, [event])
    const queued = liveInstrumentEventTail.then(async () => {
      if (
        generation !== liveInstrumentQueueGeneration
        || !input.bridge
        || hasNativeHostConnectionLoss()
        || !livePreviewActive
        || sampleRate === 0
      ) return false
      try {
        const reply = await observeRetirementControl(bridge.session.queueInstrumentEvents(bytes))
        if (!reply.ok && generation === liveInstrumentQueueGeneration) reportStopped(reply.error)
        return reply.ok
      } catch (error: unknown) {
        if (generation === liveInstrumentQueueGeneration && livePreviewActive) {
          reportStopped(error instanceof Error ? error.message : "Native live MIDI event failed.")
        }
        return false
      }
    }).catch(() => undefined)
    liveInstrumentEventTail = queued.then(() => undefined)
    return queued
  }

  const epochApplied = (epoch: number | undefined) => epoch === undefined || (latestScheduleProgress?.epoch ?? 0) >= epoch

  const queueBuiltInParameterEvents = async (request: {
    instanceId: string
    values: readonly { parameterId: string; value: number }[]
    revision?: number
    epoch?: number
    sequence?: number
    // The registered record of this send. Its sequences are allocated, and it becomes provable, only when
    // the batch is handed to the bridge.
    execution?: Execution
  }): Promise<ParameterReply> => {
    const bridge = input.bridge
    if (!bridge) return { ok: false, kind: "not-sent", reason: "unavailable" }
    if (!prepared || !preparedGraph) return { ok: false, kind: "not-sent", reason: "unavailable" }
    const instrumentEntry = Object.entries(preparedSnapshot?.mixer.fx.trackFx ?? {})
      .find(([, fx]) => fx.instrument?.instanceId === request.instanceId)
    if (instrumentEntry) {
      const node = preparedGraph.nodes.find((entry) => entry.id === instrumentEntry[0])
      if (node?.instrument?.kind !== "synth") return { ok: false, kind: "not-sent", reason: "unsupported" }
      const targets = new Map(node.instrument.parameterTargets.map((entry) => [entry.id, entry.target]))
      const parameters: { target: number; value: number }[] = []
      for (const value of request.values) {
        const target = targets.get(value.parameterId)
        if (target === undefined || !Number.isFinite(value.value)) return { ok: false, kind: "not-sent", reason: "unsupported" }
        parameters.push({ target, value: value.value })
      }
      try {
        if (parameters.length === 0) return { ok: true }
        const events: NativeInstrumentEvent[] = parameters.map(({ target, value }) => ({
          nodeId: node.id, type: "parameter", noteId: 1, sequence: nextLiveEventSequence++, frameOffset: 0, channel: 0, note: target, value,
        }))
        if (request.execution && !processorState.send(request.execution, request.execution.sequence, nextLiveEventSequence - 1))
          return { ok: false, kind: "not-sent", reason: "stale" }
        return await observeRetirementControl(bridge.session.queueInstrumentEvents(serializeNativeInstrumentEvents(transportEpoch, events)))
      } catch (error) {
        return { ok: false, kind: "unconfirmed", error: String(error) }
      }
    }
    const processor = resolveGraphProcessor(preparedGraph, request.instanceId)
    if (!processor) return { ok: false, kind: "not-sent", reason: "unsupported" }
    const events = []
    for (const value of request.values) {
      const parameterTarget = processor.parameterTargets.get(value.parameterId)
      if (parameterTarget === undefined || !Number.isFinite(value.value)) {
        return { ok: false, kind: "not-sent", reason: "unsupported" }
      }
      events.push({
        processorInstanceId: processor.processor.instanceId,
        parameterTarget,
        frameOffset: 0,
        value: value.value,
      })
    }
    if (events.length === 0) return { ok: true }
    try {
      const { sequence } = request
      if (request.execution && sequence !== undefined && !processorState.send(request.execution, sequence)) return { ok: false, kind: "not-sent", reason: "stale" }
      const batch = request.revision === undefined || request.epoch === undefined || sequence === undefined
        ? undefined
        : {
            revision: request.revision,
            epoch: request.epoch,
            sequence,
          }
      if (request.execution && batch) {
        const { key, editId, attempt } = request.execution
        input.onProcessorDispatch?.({ key, editId, attempt, sequence: BigInt(batch.sequence) })
      }
      return await observeRetirementControl(bridge.session.queueParameterEvents(serializeNativeProcessorEvents(events, batch)))
    } catch (error) {
      // A thrown or lost reply says nothing about whether native took the batch.
      return {
        ok: false,
        kind: "unconfirmed",
        error: error instanceof Error ? error.message : "Native built-in parameter queue failed.",
      }
    }
  }

  // The instrument edit's params are typed at the registry as `object`.
  const isInstrumentParams = (params: LiveProcessorEditIdentity["content"]["params"] | undefined): params is TrackInstrumentParams =>
    params !== undefined && "kind" in params && params.kind === "synth" && "instanceId" in params && typeof params.instanceId === "string"
  type ParameterFailure = Extract<ParameterReply, { ok: false }>
  // A prepare, a publication or a staged candidate this controller has outstanding names the event that offers a send
  // native refused over it again; with none, the refusal is definite.
  const outstandingOperation = () => processorState.compiling() || processorState.adoptionRunning()
  const resendRequest = (execution: Execution): LiveProcessorControlRequest => ({
    instanceId: execution.key,
    values: [...execution.values].map(([parameterId, value]) => ({ parameterId, value })),
  })
  // The completion of a refused send acts on the ledger's answer in the same turn (design 1.6): no timer, no frame.
  const parameterFailed = (execution: Execution, failure: ParameterFailure, reconciling: boolean) => {
    if (failure.kind === "refused" || failure.kind === "unconfirmed") {
      const kind = failure.kind === "unconfirmed" ? "uncertain" : outstandingOperation() ? "transient" : "definite"
      const action = processorState.refuse(execution, kind)
      if (action === "retry") void sendExecution({ ...resendRequest(execution), resent: execution }, true)
      else if (action === "ladder") void drainStatePatches()
      executeReconcile(processorState.settledReconciles())
      return
    }
    const unsupported = failure.kind === "not-sent" && failure.reason === "unsupported"
    executeReconcile(processorState.cancel(execution, !reconciling, unsupported ? { state: "refused", reason: "unsupported" } : { state: "unavailable" }))
  }

  // Registers the execution when its sequence is allocated, before the bridge
  // call: an adoption can run before the ACK and must see the batch it has to
  // rebind or defer behind. A batch the host refused stays desired and is sent
  // again; an accepted one is only admitted, and native progress proves it.
  // The requests it answers are the record's receipts, never this function's result.
  const sendExecution = async (
    request: LiveProcessorControlRequest & { receipt?: Receipt } & (
      { edit: LiveProcessorEditIdentity; resent?: never } | { resent: Execution }
    ),
    reconciling = false,
  ): Promise<number | undefined> => {
    // Only a session reports progress or ends a domain, so a record registered without one would wait forever. A
    // dispatched-again record (`resent`) was registered in a session; its owner answers it when that session ends.
    if (!request.resent && (!input.bridge || !prepared || !preparedGraph)) {
      if (request.receipt) processorState.answer(request.receipt, { state: "unavailable" })
      return undefined
    }
    const sequence = Math.max(nextLiveProcessorSequence + 1, request.sequence ?? 0)
    nextLiveProcessorSequence = sequence
    const revision = preparedGraph?.revision ?? 0
    const epoch = transportEpoch
    // An instrument's events take consecutive urgent sequences when they are built.
    const urgent = synthNodes(preparedSnapshot).has(request.instanceId)
    const binding = { epoch, revision }
    let execution: Execution | undefined
    if (request.resent) {
      execution = request.resent
      processorState.rebind(execution, binding, sequence)
    } else if (request.values.length > 0) {
      const edit = request.edit
      execution = processorState.register({
        key: request.instanceId, editId: edit.id, order: edit.order,
        kindId: edit.target.kindId, sequence, content: edit.content,
        values: new Map(request.values.map(({ parameterId, value }) => [parameterId, value])),
        strategy: urgent ? { kind: "urgent", sequence: 0 } : { kind: "parameters" },
        ...(request.receipt && { receipts: [request.receipt], spec: request.receipt.spec }),
      }, binding)
    }
    // Native admits a batch against its last queued SetTransport, but a callback that began before that command
    // still drains the lane under the older epoch and drops it (audio-host.cpp:3119, 5383-5434), and a later
    // batch's floor would read as applying it. The record stays unsent until a frame shows its epoch applied.
    if (execution && !epochApplied(epoch)) return execution.sequence
    const attempt = execution?.attempt
    const result = await queueBuiltInParameterEvents({ ...request, revision, epoch, sequence, ...(execution && { execution }) })
    // A record dispatched again while this send was out is that dispatch's now.
    if (execution && execution.attempt === attempt) {
      if (result.ok) processorState.admit(execution)
      else parameterFailed(execution, result, reconciling)
    }
    // A publication, a domain move or the end of the session since allocation leaves the record to the owner:
    // it follows native's decision, the frame that shows the batch dropped, or the session clear.
    // Native may have applied it before the ACK reached us; the last frame already says so.
    if (latestScheduleProgress?.epoch === epoch) executeReconcile(processorState.observe(latestScheduleProgress))
    return execution?.sequence ?? sequence
  }

  // The content of one delivery, whole: what native is asked to hold for a target (design 1.1).
  type ContentDelivery = {
    instanceId: string
    editId: string
    order: number
    kindId: number
    incarnation: number
    state?: Uint8Array
    values: Readonly<Record<string, number>>
    desired?: ProcessorDesired
    edit: LiveProcessorEditIdentity
    instrument?: AudioCoreSynthState
    preparedInstrument?: boolean
  }
  type Delivered = {
    registration: DeliveryRegistration
    // The completion of the first dispatch, with its sequence; resolves at once when nothing was dispatched.
    sent: Promise<number | undefined>
    // Absent when nothing was registered: the answer is the registration's.
    receipt?: Receipt
  }
  const unregistered = (instanceId: string, outcome: ProcessorDeliveryOutcome): Delivered => ({
    registration: { receipt: { key: instanceId, serial: 0 }, settled: Promise.resolve(outcome) },
    sent: Promise.resolve(undefined),
  })
  // The closed-effect content of an edit as a patch the ladder can send: only an edit that carries its encoded state
  // and timing is patchable.
  const editDesired = (edit: LiveProcessorEditIdentity): ProcessorDesired | undefined => {
    const { state, timing } = edit.content
    const match = preparedGraph && resolveGraphProcessor(preparedGraph, edit.target.instanceId)
    return state && timing && match
      ? patchProcessorDesired(match.processor, { edit, state, timing })
      : undefined
  }
  // Registration is synchronous (A8.3): the receipt, rule 0, the carrier choice and the carrier's queueing all happen
  // before this returns. The caller follows `settled`; it never decides what to resend.
  const deliverContent = (content: ContentDelivery): Delivered => {
    if (!input.bridge || !prepared || !preparedGraph) return unregistered(content.instanceId, { state: "unavailable" })
    const { receipt, plan } = processorState.deliver({
      key: content.instanceId, editId: content.editId, order: content.order, kindId: content.kindId,
      incarnation: content.incarnation, epoch: transportEpoch, state: content.state, values: content.values,
      desired: content.desired, edit: content.edit,
      instrument: content.instrument, preparedInstrument: content.preparedInstrument,
    })
    let sent: Promise<number | undefined> = Promise.resolve(undefined)
    if (plan.carrier === "patch") void drainStatePatches()
    else if (plan.carrier === "parameters" || plan.carrier === "urgent") {
      if (plan.values.size === 0) processorState.answer(receipt, { state: "refused", reason: "unsupported" })
      else sent = sendExecution({
        instanceId: content.instanceId,
        values: [...plan.values].map(([parameterId, value]) => ({ parameterId, value })),
        edit: content.edit, receipt,
      })
    }
    return { registration: { receipt: receiptHandle(receipt), settled: receipt.settled }, sent, receipt }
  }
  // A holding delivery owns the target until its closing delivery; the close runs first and releases what waited.
  const applyGesture = (instanceId: string, incarnation: number, gesture: ProcessorDelivery["gesture"]) => {
    if (!gesture) return
    if (gesture.holds) processorState.holdGesture(instanceId, gesture.token, incarnation)
    else executeReconcile(processorState.endGesture(instanceId, gesture.token))
  }
  const deliverProcessor = (edit: ProcessorDelivery["edit"], gesture?: ProcessorDelivery["gesture"]): DeliveryRegistration => {
    if (isRetiredTarget(edit, edit.target.instanceId)) return unregistered(edit.target.instanceId, { state: "unavailable" }).registration
    applyGesture(edit.target.instanceId, edit.target.incarnation, gesture)
    const instrument = isInstrumentParams(edit.content.params) ? edit.content.params : undefined
    const synth = edit.target.kindId === SYNTH_KIND_ID && instrument?.kind === "synth"
      ? compilePortableSynthState(instrument.params) : undefined
    return deliverContent({
      instanceId: edit.target.instanceId, editId: edit.id, order: edit.order, kindId: edit.target.kindId,
      incarnation: edit.target.incarnation, state: edit.content.state, values: edit.content.values ?? {},
      desired: editDesired(edit), edit,
      ...(synth && { instrument: synth, preparedInstrument: preparedSnapshot?.mixer.fx.trackFx?.[edit.target.nodeId]?.instrument?.instanceId === edit.target.instanceId }),
    }).registration
  }
  // Structural or sampled content with no registry edit: answered by the adoption that carries it.
  const joinPublication = (join: PublicationJoin): DeliveryRegistration => {
    if (!input.bridge || !prepared || !preparedGraph) return unregistered(join.target.instanceId, { state: "unavailable" }).registration
    const receipt = processorState.join(join.target.instanceId, -1, join.contentKey, join.lifetime, join.target.nodeId)
    return { receipt: receiptHandle(receipt), settled: receipt.settled }
  }

  // Adoption and settlement hand back desired content native still has to take.
  // It bypasses the supersession floor of live edits: after an adoption that
  // floor is the registry's global sequence, which every folded desired but the
  // newest is below. A refused dispatch leaves the target pending for the next
  // adoption or settlement.
  const executeReconcile = (reconcile: readonly ProcessorReconcile[]) => {
    for (const item of reconcile) {
      if ("patch" in item) void drainStatePatches()
      else if ("resend" in item) void sendExecution({ ...resendRequest(item.resend), resent: item.resend }, true)
      else {
        const { desired: processor, values } = item
        void sendExecution({
          instanceId: processor.target.instanceId,
          values: [...values].map(([parameterId, value]) => ({ parameterId, value })),
          edit: { id: processor.id, order: processor.order, target: processor.target,
            content: { params: processor.content.params ?? {}, values: processor.content.values } },
        }, true)
      }
    }
  }
  // A candidate that publishes nothing still carries the latest desired content.
  const reconcileUnpublishedCandidate = (candidate: ScheduleRevisionCandidate) => {
    if (!preparedGraph || !isScheduleCandidateValid(candidate)) return
    ingestProjectedProcessors(candidate.snapshot)
    executeReconcile(processorState.reconcile(targetKinds(preparedGraph, preparedSnapshot)))
  }
  const reenableProcessorAutomation = async (
    instanceId: string,
    parameterIds: readonly string[],
  ): Promise<LiveProcessorControlResult> => {
    if (!prepared || !preparedGraph) return { accepted: false, reason: "unprepared" }
    const externalParameters = parameterIds.map((parameterId) => parseExternalAutomationParameterId(parameterId))
    const externalInstanceId = externalParameters[0]?.instanceId
    if (externalInstanceId !== undefined) {
      const attachment = preparedSnapshot?.nativeExternalAttachmentPlan?.attachments
        .find((candidate) => candidate.instanceId === externalInstanceId)
      const parameters = new Map(attachment?.parameters?.map((parameter) => [parameter.id, parameter]))
      const targets = externalParameters
        .filter((external): external is NonNullable<typeof external> => (
          external?.instanceId === instanceId
          && external.instanceId === externalInstanceId
          && parameters.get(external.parameterId)?.readOnly === false
        ))
        .map((external) => external.parameterId)
      if (!attachment || targets.length !== parameterIds.length || !scheduleCoordinator) {
        return { accepted: false, reason: "unsupported" }
      }
      try {
        await scheduleCoordinator.reenableAutomation(externalInstanceId, targets)
        return { accepted: true, sequence: ++nextLiveProcessorSequence }
      } catch (error) {
        return { accepted: false, reason: "bridge-error", error: error instanceof Error ? error.message : String(error) }
      }
    }
    const processor = resolveGraphProcessor(preparedGraph, instanceId)
    if (!processor) {
      return { accepted: false, reason: "unsupported" }
    }
    const targets = parameterIds.map((parameterId) => processor.parameterTargets.get(parameterId))
      .filter((target): target is number => target !== undefined)
    if (targets.length !== parameterIds.length) return { accepted: false, reason: "unsupported" }
    return { accepted: true, sequence: ++nextLiveProcessorSequence }
  }

  // Aborted when the transport domain ends, and the compile is abandoned at that moment: what it returns later is
  // dropped without a trace.
  const prepareScheduleRevision = async (
    context?: LivePlaybackCompileContext,
  ): Promise<ScheduleRevisionPreparation> => {
    const owner = processorState.openCompile()
    const previous = preparedSnapshot
    const coordinator = scheduleCoordinator
    if (!active || !previous || !preparedGraph || !coordinator) {
      processorState.closeCompile(owner)
      return { status: "retry", reason: "ownership-invalidated" }
    }
    let disposeStretch = async () => {}
    let transferred = false
    try {
      const compiledIncarnations = captureInstrumentIncarnations(previous)
      const abandoned = new Promise<never>((_, reject) => {
        owner.signal.addEventListener("abort", () => reject(new NativePlaybackAbortError("ownership-invalidated")), { once: true })
      })
      abandoned.catch(() => undefined)
      const compilation = await Promise.race([input.compileSnapshot({ ...previous.transport, state: "playing",
        playheadSec: coordinator.currentFrame() / sampleRate }, { ...context, liveAdoption: true }), abandoned])
      owner.signal.throwIfAborted()
      if (!compilation.supported) throw new Error(compilation.reasons.join(" "))
      if (previous !== preparedSnapshot || coordinator !== scheduleCoordinator)
        throw new NativePlaybackAbortError("ownership-invalidated")
      const plan = compilation.snapshot.nativeExternalAttachmentPlan
      const snapshot = plan ? { ...compilation.snapshot, nativeExternalAttachmentPlan: planWithWorkerFrames(plan, maximumFramesPerBlock) }
        : compilation.snapshot
      // The compile never moves the transport: a loop it disagrees on is applied by the adoption, outside any attempt.
      if (!hasEquivalentTransportScheduling(previous.transport, snapshot.transport))
        return { status: "retry", reason: "transport-mismatch", transport: snapshot.transport }
      const supportError = nativeSnapshotSupportError(snapshot)
      if (supportError) throw new Error(supportError)
      let stretchAssets: readonly NativePreparedStretchAsset[] = []
      if (snapshot.tracks.some((track) => track.clips.some((clip) =>
        !clip.midi && clip.audioWarp?.enabled && clip.audioWarp.mode === "stretch"))) {
        const storage = ensureStretchStorage()
        const preparation = await prepareNativeStretchArtifacts({
          tracks: snapshot.tracks, projectBpm: snapshot.bpm,
          projectGeneration: safePreparedProjectGeneration(resolveProjectGeneration()),
          cache: storage.cache, repository: storage.repository, signal: owner.signal,
        })
        if (!preparation.supported) throw new Error(preparation.diagnostics.map((entry) => entry.message).join(" "))
        stretchAssets = preparation.assets
        disposeStretch = async () => {
          pendingStretchCandidates.delete(disposeStretch)
          await preparation.dispose()
        }
        pendingStretchCandidates.add(disposeStretch)
        owner.signal.throwIfAborted()
      }
      if (previous !== preparedSnapshot || coordinator !== scheduleCoordinator)
        throw new NativePlaybackAbortError("ownership-invalidated")
      const projection = compileLiveNativeProjection({
        tracks: snapshot.tracks, bpm: snapshot.bpm, sampleRateHz: sampleRate,
        revision: snapshot.revision, epoch: transportEpoch, firstSequence: 1,
        fx: snapshot.mixer.fx, externalLatencyFrames: nativeOfflineExternalLatencyFrames(snapshot.nativeExternalAttachmentPlan),
        projectGeneration: safePreparedProjectGeneration(resolveProjectGeneration()),
        preparedStretchAssets: stretchAssets, instrumentRegionMode: "metadata",
      })
      if (!projection.supported) throw new Error(projection.reasons.join(" "))
      // A cold session has the same fixed asset table, so rebuilding cannot help.
      if (projection.assets.length > nativeAudioHostMaximumInstalledAssets)
        throw new Error("Native snapshot exceeds installed audio asset capacity.")
      const graph = projection.graph
      const instrumentIncarnations = captureInstrumentIncarnations(snapshot)
      for (const [key, incarnation] of compiledIncarnations)
        if (instrumentIncarnations.has(key)) instrumentIncarnations.set(key, incarnation)
      const stateSequence = snapshot.processorStateSequence ?? 0
      const dispose = disposeStretch
      let released = false
      const candidate: ScheduleRevisionCandidate = { status: "staged",
        processorStateSequence: stateSequence, previous, snapshot, graph, instrumentIncarnations, projection, stretchAssets,
        dispose: async () => {
          if (released) return
          released = true
          const owned = scheduleCandidates.delete(candidate)
          await dispose()
          if (owned) processorState.disposedCandidate()
        } }
      scheduleCandidates.add(candidate)
      transferred = true
      return candidate
    } catch (error) {
      await disposeStretch()
      if (error instanceof NativePlaybackAbortError || owner.signal.aborted) return { status: "retry", reason: "ownership-invalidated" }
      const reason = error instanceof Error ? error.message : String(error)
      logFailedAdoption(reason)
      return { status: "failed", reason }
    } finally {
      processorState.closeCompile(owner, transferred)
    }
  }

  type PublicationPayload =
    | { kind: "schedule"; candidate: ScheduleRevisionCandidate; intent: number; attempt: AdoptionAttempt }
    | { kind: "latency" }

  // The queue admits one record, never its caller promise. Every native/event
  // wait belongs to that record, leaving transport free to supply its proof.
  const publishRevision = async (payload: PublicationPayload): Promise<{ record: NonNullable<ReturnType<typeof processorState.publication>> } | { outcome: AdoptionOutcome }> => {
    for (;;) {
      const admitted = await queuePreparedTransportTransition(async () => {
        const held = processorState.publication()
        if (held) return { waiting: held }
        type Step = Awaited<ReturnType<typeof executePublication>>
        let yielded = Promise.withResolvers<Step>()
        const execution = executePublication(payload, (record, register) => {
          const next = new Promise<void>(resume => {
            let resumed = false
            register(() => {
              if (resumed) return
              resumed = true
              yielded = Promise.withResolvers<Step>()
              void queuePreparedTransportTransition(async () => {
                resume()
                return Promise.race([execution, yielded.promise])
              })
            })
          })
          yielded.resolve({ record })
          return next
        })
        return { step: await Promise.race([execution, yielded.promise]) }
      })
      if (admitted.waiting) {
        const outcome = await admitted.waiting.terminal
        if (payload.kind === "latency" && admitted.waiting.kind === "latency" && outcome.status !== "adopted")
          return { record: admitted.waiting }
        continue
      }
      if (!admitted.step) throw new Error("Publication admission did not return an execution.")
      return admitted.step
    }
  }

  const executePublication = async (payload: PublicationPayload,
    relinquish: (record: NonNullable<ReturnType<typeof processorState.publication>>, register: (resume: () => void) => void) => Promise<void>,
  ) => {
      const candidate = payload.kind === "schedule" ? payload.candidate : undefined
      const attempt = payload.kind === "schedule" ? payload.attempt : undefined
      const intent = payload.kind === "schedule" ? payload.intent : stagedTransportIntent
      const abandonCandidate = async () => {
        await candidate?.dispose()
        return { outcome: { status: "superseded" } } satisfies { outcome: AdoptionOutcome }
      }
      if (intent !== stagedTransportIntent) return abandonCandidate()
      if (!candidate && latencyInputsApplied()) return { outcome: { status: "unchanged" } } satisfies { outcome: AdoptionOutcome }
      const session = input.bridge?.session
      const revisions = session?.revisions
      const coordinator = scheduleCoordinator
      const previous = preparedSnapshot
      const previousGraph = preparedGraph
      const projectId = preparedProjectId
      if ((candidate && !active) || !prepared || !coordinator || !previous || !previousGraph || !projectId)
        return abandonCandidate()
      if (!session || !revisions || !session.configureInstrumentStates) return abandonCandidate()
      const generation = lifecycleGeneration
      const projectGeneration = resolveProjectGeneration()
      const publicationEpoch = transportEpoch
      let staged: NativeScheduleCoordinator | undefined
      let adoptPublication: ((reply: NativeRevisionReply, acknowledgedEpoch?: number) => boolean) | undefined
      let discardAddedSources: (() => Promise<void>) | undefined
      let stagedMemoryScope: SampledInstrumentRegionBudgetScope | undefined
      let resourcesPromoted = false
      let retainCandidate = false
      let preparedRevision: number | undefined
      const pageManager = nativeTimelinePageManager
      let removedAssetIds: readonly number[] = []
      let binding: Parameters<NativeRevisionSession["publish"]>[0] | undefined
      let sequence = 0
      let progressVersion = 0
      let lastProgressSequence = -1n
      let wake: (() => void) | undefined
      let detached = false
      let resolving = false
      const merged = candidate ? rebaseScheduleCandidate(candidate) : captureLatencyInputs()
      let snapshot = candidate?.snapshot ?? previous
      let graph = structuredClone(merged.graph)
      let serializedKeepLatencyNodeIds = new Set(desiredKeepLatencyNodeIds)
      let capturedInputVersion = latencyInputVersion
      const record = processorState.capturePublication(attempt,
        publicationContent(graph, snapshot, merged.ledger, candidate?.instrumentIncarnations))
      const retry = () => {
        if (record.resubmits >= 8) throw new Error("Native publication resubmit budget exhausted.")
        record.resubmits++
      }
      const notify = () => {
        sequence++; wake?.(); wake = undefined
        record.transportWake?.()
        if (detached && record.phase !== "ended" && !resolving) {
          resolving = true
          void queuePreparedTransportTransition(async () => {
            try { await resolvePublication() } finally { resolving = false }
          })
        }
      }
      const publicationAbort = new AbortController()
      const cancel = () => {
        record.cancelled = true
        publicationAbort.abort(new NativePlaybackAbortError("ownership-invalidated"))
        staged?.abortPreparation()
        notify()
      }
      record.wake = () => { if (record.cancelled) cancel(); else notify() }
      let publishSent = false
      let publishReply: NativeRevisionReply | undefined
      let publishCompletion: Promise<void> = Promise.resolve()
      const cancelUnclaimed = () => {
        if (publishSent) return false
        cancel()
        return true
      }
      if (attempt) attempt.withdrawPublication = cancelUnclaimed
      const current = () => generation === lifecycleGeneration && projectGeneration === resolveProjectGeneration()
        && projectId === input.getProjectId?.() && coordinator === scheduleCoordinator && prepared
      // Epoch coordinators increment nativeSessionGeneration. Only lifecycle invalidation
      // ends this session; renderer generation changes still owe proof for a sent bank.
      const sessionAlive = () => generation === lifecycleGeneration && prepared && !hasNativeHostConnectionLoss()
        && preparedProjectId === projectId && record.phase !== "ended"
      record.progress = (progress) => {
        if (progress.epoch !== transportEpoch || progress.progressSequence <= lastProgressSequence) return
        lastProgressSequence = progress.progressSequence
        progressVersion++
        notify()
      }
      const waitForOpportunity = async (observed: number) => {
        if (sequence === observed && sessionAlive() && current() && !record.cancelled)
          await relinquish(record, resume => { wake = resume })
        if (!current() || record.cancelled || !sessionAlive()) throw new NativePlaybackAbortError("ownership-invalidated")
      }
      const withoutLane = async <Value>(operation: Promise<Value>): Promise<Value> => {
        let settled: { value: Value } | { error: Error } | undefined
        const result = operation.then(value => { settled = { value } }, error => {
          settled = { error: error instanceof Error ? error : new Error(String(error)) }
        })
        await Promise.resolve()
        if (!settled) await relinquish(record, resume => { void result.then(resume) })
        if (!settled) throw new Error("Publication reply resumed before it settled.")
        if ("error" in settled) throw settled.error
        return settled.value
      }
      const quietPublicationLane = async () => {
        while (processorState.fence().kind === "uncertain" && await runNextStatePatch()) continue
        if (processorState.fence().kind === "claimed") {
          const released = processorState.released()
          await relinquish(record, resume => { void released.then(resume); wake = resume })
        }
        if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
      }
      const awaitPreparation = async <Value>(operation: Promise<Value>): Promise<Value> => {
        const signal = publicationAbort.signal
        signal.throwIfAborted()
        let onAbort = () => {}
        try {
          return await Promise.race([operation, new Promise<never>((_, reject) => {
            onAbort = () => reject(new NativePlaybackAbortError("ownership-invalidated"))
            signal.addEventListener("abort", onAbort, { once: true })
          })])
        } finally { signal.removeEventListener("abort", onAbort) }
      }
      // 25 ms of blocks (at least two): what staging and one Publish round trip need after the seam is bound.
      const boundLeadBlocks = () => Math.max(2, Math.ceil(0.025 * sampleRate / maximumFramesPerBlock))
      const chooseFrame = (progress: bigint, blocks: number) => {
        const frame = Number(progress) + maximumFramesPerBlock * blocks
        if (!Number.isSafeInteger(frame)) throw new Error("Native publication frame exceeds renderer precision.")
        return frame
      }
      let disposition: Promise<void> | undefined
      const disposePublication = () => disposition ??= (async () => {
        staged?.dispose()
        if (!resourcesPromoted) {
          await discardAddedSources?.()
          releaseInstrumentScope(stagedMemoryScope)
          if (!retainCandidate) await candidate?.dispose()
          if (preparedRevision !== undefined) processorState.unprepared(preparedRevision)
        }
      })()
      const finish = async (outcome: AdoptionOutcome, evidence: Parameters<typeof processorState.finishPublication>[2],
        reason?: Parameters<typeof processorState.finishPublication>[3]) => {
        await disposePublication()
        if (outcome.status === "failed" && record.kind === "schedule") logFailedAdoption(outcome.reason)
        processorState.finishPublication(record,
          record.kind === "latency" && outcome.status === "failed" && !outcome.failureKind
            ? { ...outcome, failureKind: { kind: evidence === "failed" ? "refused" : "unconfirmed" } } : outcome,
          evidence, reason)
        return { record }
      }
      const inspect = async (request = binding, releaseLane = false) => {
        if (!sessionAlive() || !request) return undefined
        try {
          const reply = revisions.inspect(request)
          return await (releaseLane ? withoutLane(reply) : reply)
        } catch { return undefined }
      }
      record.inspect = inspect
      let failure: { outcome: AdoptionOutcome; reason: Parameters<typeof processorState.finishPublication>[3] } | undefined
      let invalidProof = false
      let uncertainPreparation = false
      function checked(reply: NativeSessionReply): asserts reply is Extract<NativeSessionReply, { ok: true }> {
        if (!reply.ok) {
          uncertainPreparation = "kind" in reply && reply.kind === "unconfirmed"
          const capacity = reply.error === "asset-capacity-exceeded" || reply.error === "asset-page-capacity-exceeded"
            || reply.error === "asset-publication-pending"
          if ("kind" in reply && reply.kind === "refused") {
            retainCandidate = capacity
            failure = { outcome: { status: capacity ? "blocked" : "failed", reason: reply.error }, reason: "native-refused" }
          }
          throw new Error(reply.error)
        }
      }
      const classifyPublication = (reply: NativeRevisionReply | undefined) => {
        if (!reply) return
        if (!reply.ok) {
          if (reply.kind === "refused") failure = {
            outcome: { status: "failed", reason: reply.error }, reason: "native-refused",
          }
          return
        }
        const status = reply.revision.status
        if (status === "publish-failed" || status === "stale-revision" || status === "invalid-revision")
          failure = { outcome: { status: "failed", reason: `Native live publication was ${status}.` },
            reason: status === "publish-failed" ? "apply-failed" : status === "stale-revision" ? "stale-revision" : "invalid" }
      }
      const notTaken = () => finish(failure?.outcome ?? (record.cancelled
        ? { status: "superseded" } : { status: "failed", reason: "Native live publication was not taken." }),
      invalidProof ? "uncertain" : failure ? "failed" : record.cancelled ? "cancelled" : "failed", failure?.reason)
      const resolvePublication = async (acknowledgedEpoch?: number, releaseLane = false): Promise<boolean> => {
        if (!sessionAlive()) { await disposePublication(); return false }
        record.phase = acknowledgedEpoch === undefined ? "resolving" : "awaitingTransport"
        const proof = await inspect(binding, releaseLane)
        if (!sessionAlive()) { await disposePublication(); return false }
        if (proof?.ok && proof.revision.status === "publish-failed") failure = {
          outcome: { status: "failed", reason: "Native live publication was publish-failed." }, reason: "apply-failed",
        }
          if (proof?.ok && proof.revision.status === "published") {
          if (adoptPublication?.(proof, acknowledgedEpoch)) {
            await finish({ status: "adopted" }, "promoted")
            return true
          }
          // A mismatching proof cannot promote our resources or answer its cohort.
          // Rollback still reconciles the bank this session actually owns.
          invalidProof = true
        }
        if (acknowledgedEpoch !== undefined) {
          if (proof?.ok) await notTaken()
          return false
        }
        if (proof?.ok && proof.revision.status === "stale-revision") { await notTaken(); return false }
        if (proof?.ok && proof.revision.status === "publish-pending" && !record.cancelled && !failure) return false
        if (!binding || !sessionAlive()) return false
        const rollback = revisions.rollback(binding)
        const rolledBack = await (releaseLane ? withoutLane(rollback) : rollback).catch(() => undefined)
        if (!sessionAlive()) { await disposePublication(); return false }
        if (rolledBack?.ok && rolledBack.revision.status === "stale-revision") {
          const resolved = await inspect(binding, releaseLane)
          if (!sessionAlive()) { await disposePublication(); return false }
          if (resolved?.ok && resolved.revision.status === "published") {
            if (adoptPublication?.(resolved)) {
              await finish({ status: "adopted" }, "promoted")
              return true
            }
          } else if (resolved?.ok) await notTaken()
        } else if (rolledBack?.ok && rolledBack.revision.status === "rolled-back") await notTaken()
        else record.phase = record.cancelled ? "awaitingTransport" : "resolving"
        return false
      }
      let acknowledged: number | undefined
      record.acknowledge = async epoch => {
        if (acknowledged === epoch) return record.outcome?.status === "adopted"
        acknowledged = epoch
        detached = false
        try { return await resolvePublication(epoch) } finally { detached = record.phase !== "ended" }
      }
      if (!candidate) {
        let runtimeRevision = previousGraph.revision
        let resumeSafe = true
        let ready: NativeRevisionReply | undefined
        const capturedGeneration = lifecycleGeneration
        const capture = () => {
          const frozen = captureLatencyInputs()
          graph = frozen.graph
          snapshot = frozen.snapshot
          serializedKeepLatencyNodeIds = frozen.keep
          record.content = publicationContent(graph, snapshot, frozen.ledger, captureInstrumentIncarnations(snapshot))
          processorState.refreshPublication(record)
          return frozen.sequence
        }
        let includedOrder = capture()
        let initialPreparation = true
        const resume = () => {
          if (sessionAlive() && resumeSafe && coordinator === scheduleCoordinator)
            coordinator.resumeGraphPublication(runtimeRevision)
        }
        const prepare = async () => {
          await quietPublicationLane()
          if (initialPreparation) {
            includedOrder = capture()
            capturedInputVersion = latencyInputVersion
            initialPreparation = false
          }
          if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
          await coordinator.coverThrough(coordinator.currentFrame() + maximumFramesPerBlock * 16)
          await coordinator.suspendGraphPublication()
          if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
          const reply = await withoutLane(revisions.prepare({ projectId, projectRevision: graph.revision,
            bytes: serializeNativeGraph(graph, serializedKeepLatencyNodeIds) }))
          if (reply.ok && reply.revision.status === "prepared" && reply.revision.preparedRevision === reply.revision.requestedRevision) {
            binding = { projectId, revision: reply.revision.requestedRevision, hostGeneration: reply.hostGeneration }
            preparedRevision = binding.revision
          }
          return reply
        }
        adoptPublication = (proof, acknowledgedEpoch) => {
          if (!proof.ok || !ready?.ok || !binding || !sessionAlive() || capturedGeneration !== lifecycleGeneration
            || proof.hostPid !== ready.hostPid || proof.hostGeneration !== ready.hostGeneration
            || proof.revision.activeRevision !== binding.revision
            || (proof.revision.transportEpoch !== undefined
              && proof.revision.transportEpoch !== (acknowledgedEpoch ?? publicationEpoch))) return false
          runtimeRevision = binding.revision
          resumeSafe = true
          preparedGraph = { ...graph, revision: runtimeRevision }
          processorState.published(runtimeRevision)
          if (JSON.stringify(snapshot.nativeExternalAttachmentPlan) !== JSON.stringify(previous.nativeExternalAttachmentPlan))
            preparedSnapshot = { ...snapshot, revision: preparedSnapshot?.revision ?? snapshot.revision }
          preparedKeepLatencyNodeIds = serializedKeepLatencyNodeIds
          nativeMeterRevision = runtimeRevision
          const previousStates = new Map(previousGraph.nodes.flatMap(node => node.processorOrder.map(processor => [processor.id, processor])))
          const restated = new Set(graph.nodes.flatMap(node => node.processorOrder.flatMap(processor =>
            sameBytes(previousStates.get(processor.id)?.state ?? new Uint8Array(), processor.state) ? [] : [processor.id])))
          const reconciles = processorState.adopted(targetKinds(graph, snapshot), new Set(), restated,
            includedOrder, desired => statePatchMatchesCurrentProcessor(desired.target.instanceId, desired.content.state), record.content)
          if (acknowledgedEpoch === undefined) coordinator.resumeGraphPublication(runtimeRevision)
          advanceScheduleSettledEpoch()
          holdRetirement(proof, projectId)
          resourcesPromoted = true
          binding = undefined
          executeReconcile(reconciles)
          return true
        }
        try {
          ready = await prepare()
          let observed = sequence
          while (ready.ok && ready.revision.status === "publish-pending" && !binding) {
            resume()
            await waitForOpportunity(observed)
            observed = sequence
            const admission = await inspect({ projectId, revision: ready.revision.requestedRevision, hostGeneration: ready.hostGeneration })
            if (admission?.ok && (admission.hostPid !== ready.hostPid || admission.hostGeneration !== ready.hostGeneration)) {
              invalidateNativeOwnership(true, true)
              return { record }
            }
            if (!admission?.ok || admission.revision.status === "publish-pending") continue
            retry()
            includedOrder = capture()
            ready = await prepare()
          }
          if (!ready.ok) throw new PublicationFailure(ready.error, ready.kind)
          processorState.observeRetirement(ready)
          if (ready.revision.status !== "prepared" || ready.revision.continuity !== "accepted") {
            if (ready.revision.diagnosticCode === nativeKeepLatencyDivergentMixedBusDiagnostic)
              throw new NativeLatencyUnsupportedError("Keep Latency can't be used here: this bus mixes monitored and other tracks, then splits to outputs with different latency. Route them through separate buses.")
            throw new PublicationFailure(`Native latency prepare was ${ready.revision.status}/${ready.revision.continuity}.`, "refused")
          }
          if (!binding) throw new Error("Native latency prepare did not create the requested bank.")
          resumeSafe = false
          processorState.prepared(binding.revision, scheduledRetention(previousGraph, graph,
            { before: previous, after: snapshot }, new Set()))
          let submittedProgress = -1
          let status: NativeRevisionReply = ready
          for (;;) {
            if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
            observed = sequence
            classifyPublication(publishReply)
            if (status.ok && ready.ok && (status.hostPid !== ready.hostPid || status.hostGeneration !== ready.hostGeneration)) {
              invalidateNativeOwnership(true, true)
              return { record }
            }
            if (status.ok && status.revision.status === "published") {
              if (!adoptPublication(status)) throw new Error("Native latency publication proof does not match its capture.")
              return await finish({ status: "adopted" }, "promoted")
            }
            classifyPublication(status)
            if (failure) throw new Error("Native latency publication failed.")
            if (status.ok && status.revision.status === "prepared" && progressVersion !== submittedProgress) {
              if (publishSent) {
                retry()
                const changed = processorState.hasQueuedPatch()
                  || serializedKeepLatencyNodeIds.size !== desiredKeepLatencyNodeIds.size
                  || [...serializedKeepLatencyNodeIds].some(id => !desiredKeepLatencyNodeIds.has(id))
                  || latencyInputVersion !== capturedInputVersion
                if (changed) {
                  const rollback = await withoutLane(revisions.rollback(binding)).catch(() => undefined)
                  if (!rollback?.ok || rollback.revision.status !== "rolled-back") {
                    detached = true
                    return { record }
                  }
                  processorState.unprepared(binding.revision)
                  binding = undefined
                  resumeSafe = true
                  resume()
                  includedOrder = capture()
                  capturedInputVersion = latencyInputVersion
                  ready = await prepare()
                  checked(ready)
                  if (!binding || ready.revision.status !== "prepared") throw new Error("Native latency recapture was not prepared.")
                  status = ready
                  resumeSafe = false
                }
              }
              submittedProgress = progressVersion
              publishSent = true
              record.phase = "held"
              const request = binding
              if (!request) throw new Error("Missing latency binding.")
              publishCompletion = revisions.publish(request).then(reply => {
                if (!sessionAlive()) return
                publishReply = reply
                notify()
              }, () => { if (sessionAlive()) notify() })
            }
            if (failure && status.ok && status.revision.status !== "publish-pending" && status.revision.status !== "prepared")
              throw new Error("Native latency publication failed.")
            await waitForOpportunity(observed)
            status = publishReply?.ok && publishReply.revision.status === "published"
              ? publishReply : await inspect(binding, true) ?? { ok: false, kind: "unconfirmed", error: "Publication status unavailable." }
          }
        } catch (error) {
          if (!sessionAlive()) { await disposePublication(); return { record } }
          if (!current() || error instanceof NativePlaybackAbortError) record.cancelled = true
          const outcome: AdoptionOutcome = {
            status: "failed", reason: error instanceof Error ? error.message : "Native latency publication failed.",
            ...(error instanceof PublicationFailure ? { failureKind: { kind: error.kind, message: error.message } }
              : error instanceof NativeLatencyUnsupportedError ? { failureKind: { kind: "latency-unsupported", message: error.message } } : {}),
          }
          if (error instanceof PublicationFailure && error.kind === "refused")
            failure = { outcome, reason: "stage-failed" }
          if (binding) {
            await withoutLane(publishCompletion)
            classifyPublication(publishReply)
            await resolvePublication(undefined, true)
            detached = record.phase !== "ended"
            if (detached) resumeSafe = false
            return { record }
          }
          return await finish(outcome,
            record.cancelled ? "cancelled" : error instanceof PublicationFailure && error.kind === "unavailable" ? "lost" : failure ? "failed" : "uncertain", failure?.reason)
        } finally { resume() }
      }
      const { projection } = candidate
      try {
        if (!current() || record.cancelled || !isScheduleCandidateValid(candidate))
          return await finish({ status: "superseded" }, "cancelled")
        const candidateObservations = nativeObservationMaps(snapshot.tracks)
        const snapshotAssets = new Map(snapshot.assets.map((asset) => [asset.assetId, asset]))
        const previousIds = new Set(installedAssets.map((mapping) => mapping.sessionAssetId))
        const assets = projection.assets.map(({ asset, sourceAssetKey }) => {
          const key = resourceKey(asset, snapshotAssets.get(sourceAssetKey))
          const sessionAssetId = sessionResourceIds.get(key) ?? nextSessionAssetId++
          sessionResourceIds.set(key, sessionAssetId)
          return { asset, sessionAssetId }
        })
        if (assets.some((asset) => asset.sessionAssetId > 0xffff_ffff)) throw new Error("Native session asset identity capacity exceeded.")
        const mappings = new Map(assets.map((mapping) => [mapping.asset.assetId, mapping]))
        const addedAssets = projection.assets.filter(({ asset }) => {
          const mapping = mappings.get(asset.assetId)
          return mapping && !previousIds.has(mapping.sessionAssetId)
        })
        const sourceKeys = new Map(projection.assets.map(({ asset, sourceAssetKey }) => {
          const mapping = mappings.get(asset.assetId)
          const retained = mapping && previousIds.has(mapping.sessionAssetId)
          return [asset.assetId, retained
            ? installedAssetSourceKeys.get(asset.assetId) ?? sourceAssetKey
            : `${sourceAssetKey}:native-session:${mapping?.sessionAssetId}`]
        }))
        const nextIds = new Set(assets.map((mapping) => mapping.sessionAssetId))
        const removedAssets = installedAssets.filter((mapping) => !nextIds.has(mapping.sessionAssetId))
        removedAssetIds = removedAssets.map((mapping) => mapping.sessionAssetId)
        const oldInstruments = new Map(previousGraph.nodes.map((node) => [node.id, node.instrument]))
        const addedInstruments = graph.nodes.flatMap((node) => {
          if (!node.instrument) return []
          const old = oldInstruments.get(node.id)
          const changedSample = node.instrument.kind !== "synth" && (
            node.instrument.kind === "granular" ? [node.instrument.assetId] : node.instrument.zones.map((zone) => zone.assetId)
          ).some((assetId) => {
            const mapping = mappings.get(assetId)
            return mapping && !previousIds.has(mapping.sessionAssetId)
          })
          return !changedSample && JSON.stringify(old) === JSON.stringify(node.instrument) ? [] : [{ nodeId: node.id, state: node.instrument }]
        })
        // Native refuses a prepare while a patch claim is unreported (design 2.4.6): none is sent until the fence opens.
        await quietPublicationLane()
        if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
        // The host attaches a plug-in this graph adds and starts its worker before the graph that binds it is prepared.
        // A removed one goes in the same plan, with no instance left in it, and is detached once the graph is live.
        if (attachmentsChanged(previous, snapshot, maximumFramesPerBlock)) {
          const emptied = previous.nativeExternalAttachmentPlan && { ...previous.nativeExternalAttachmentPlan, attachments: [] }
          const plan = snapshot.nativeExternalAttachmentPlan ?? emptied
          const coordinateVstAttachments = session.coordinateVstAttachments
          if (!plan || !coordinateVstAttachments) throw new Error("The native VST3 attachment coordinator is unavailable.")
          checked(await awaitPreparation(coordinateVstAttachments({
            projectId, serializedPlan: encodeNativeExternalAttachmentPlan(plan), sampleRateHz: sampleRate,
            capturedVstStates: snapshot.nativeExternalAttachmentStates,
            requiredVstStateInstanceIds: snapshot.nativeExternalAttachmentStateRequirements,
          })))
        }
        // Provisional: long enough for the prepare and hydration below. The seam binds late, after them.
        let seam = chooseFrame(BigInt(coordinator.currentFrame()), 16)
        let observed = sequence
        let ready = await withoutLane(revisions.prepare({
          projectId, projectRevision: snapshot.revision, bytes: serializeNativeGraph(graph, serializedKeepLatencyNodeIds),
          requestedPublicationFrame: BigInt(seam),
        }))
        while (ready.ok && (ready.revision.status === "publish-pending" || ready.revision.status === "invalid-revision")) {
          if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
          let progress = ready.revision.progressFrame ?? BigInt(coordinator.currentFrame())
          if (ready.revision.status === "invalid-revision") {
            const fresh = await inspect({ projectId, revision: ready.revision.requestedRevision,
              hostGeneration: ready.hostGeneration })
            if (!fresh?.ok || fresh.hostPid !== ready.hostPid || fresh.hostGeneration !== ready.hostGeneration
              || fresh.revision.preparedRevision !== 0 || fresh.revision.transportEpoch !== publicationEpoch
              || fresh.revision.progressFrame === undefined || BigInt(seam) > fresh.revision.progressFrame) break
            progress = fresh.revision.progressFrame
          }
          if (record.resubmits >= 8) {
            const error = "Native live preparation is waiting for publication ownership."
            throw new Error(error)
          }
          if (ready.revision.status === "publish-pending"
            && (ready.revision.retiredRevision !== 0 || ready.revision.preparedRevision !== 0)) {
            // Prepare's pending reply owns no bank. Resolve admission before
            // spending a retry, then wait on completion/terminal/control facts,
            // not ordinary frames while a latency transition is still running.
            prepareAdmissionWake = notify
            try {
              let admission: NativeRevisionReply | undefined
              let inspected = false
              let completion = nativeLatencyCompletionGeneration
              let settled = scheduleSettledEpoch
              let applied = latestScheduleProgress
              do {
                await waitForOpportunity(observed)
                observed = sequence
                if (inspected && completion === nativeLatencyCompletionGeneration && settled === scheduleSettledEpoch
                  && applied?.appliedProcessorSequence === latestScheduleProgress?.appliedProcessorSequence
                  && applied?.appliedUrgentSequence === latestScheduleProgress?.appliedUrgentSequence
                  && applied?.appliedTransportTransitionId === latestScheduleProgress?.appliedTransportTransitionId) continue
                completion = nativeLatencyCompletionGeneration
                settled = scheduleSettledEpoch
                applied = latestScheduleProgress
                inspected = true
                admission = await inspect({ projectId, revision: ready.revision.requestedRevision,
                  hostGeneration: ready.hostGeneration })
                if (admission?.ok && (admission.hostPid !== ready.hostPid || admission.hostGeneration !== ready.hostGeneration))
                  throw new NativePlaybackAbortError("ownership-invalidated")
              } while (!admission?.ok || admission.revision.status === "publish-pending")
              checked(admission)
            } finally { prepareAdmissionWake = undefined }
            progress = BigInt(coordinator.currentFrame())
          } else if (ready.revision.status === "publish-pending") {
            // With no retained/prepared publication, the pending admission is
            // the ordinary queued-control opportunity, not a latency wait.
            await waitForOpportunity(observed)
            progress = BigInt(coordinator.currentFrame())
          }
          await quietPublicationLane()
          if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
          observed = sequence
          retry()
          seam = chooseFrame(progress, 16 * (record.resubmits + 1))
          ready = await withoutLane(revisions.prepare({
            projectId, projectRevision: snapshot.revision, bytes: serializeNativeGraph(graph, serializedKeepLatencyNodeIds),
            requestedPublicationFrame: BigInt(seam),
          }))
        }
        checked(ready)
        processorState.observeRetirement(ready)
        if (ready.revision.preparedRevision === ready.revision.requestedRevision) {
          binding = { projectId, revision: ready.revision.requestedRevision, hostGeneration: ready.hostGeneration,
            requestedPublicationFrame: BigInt(seam) }
        }
        if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
        if (ready.revision.status !== "prepared" || ready.revision.continuity !== "accepted") {
          const reason = `Native live prepare was ${ready.revision.status}/${ready.revision.continuity}.`
          failure = { outcome: { status: "failed", reason }, reason: "native-refused" }
          throw new Error(reason)
        }
        if (!binding) throw new Error("Native live prepare did not create the requested bank.")
        preparedRevision = binding.revision
        processorState.prepared(binding.revision,
          scheduledRetention(previousGraph, graph, { before: previous, after: snapshot },
            new Set(addedInstruments.map(({ nodeId }) => nodeId))))
        if (snapshot.bpm !== previous.bpm
          || JSON.stringify(snapshot.timeSignature) !== JSON.stringify(previous.timeSignature)) {
          // The existing transport command stages context against the prepared
          // bank when it reuses the running transition. Native applies it only
          // after successful publication on that exact callback seam.
          assertReply(await awaitPreparation(session.setTransport(nativeTransportFor(snapshot,
            transportEpoch, true, 0, nextTransportTransitionId))))
        }
        let addedTimelineSources = false
        if (addedAssets.length > 0) {
          if (!pageManager || !session.createMappedAsset) throw new Error("Native mapped asset hydration is unavailable.")
          const regionalSources = new Map(projection.instrumentRegionSources?.map((source) => [source.sourceAssetKey, source.buffer]))
          const clips = new Map(snapshot.tracks.flatMap((track) => track.clips)
            .filter((clip): clip is typeof clip & { sourceAssetKey: string } => clip.sourceAssetKey !== undefined)
            .map((clip) => [clip.sourceAssetKey, clip]))
          const sources: NativeTimelineSource[] = []
          const mappedResources: { source: NativeTimelineSource; create: () => Promise<void> }[] = []
          const addedSourceKeys = new Set(addedAssets.map((asset) => asset.sourceAssetKey))
          const instrumentSources = (projection.instrumentRegionSources ?? [])
            .filter((source) => addedSourceKeys.has(source.sourceAssetKey))
          if (instrumentSources.length > 0) {
            const policy = input.bridge?.instrumentBudgetPolicy
            if (!instrumentBudget || !policy) throw new Error("Native sample memory policy is unavailable.")
            validateInstrumentAssetBudget(projection.graph.assets, addedInstruments.map(({ state }) => state),
              policy.deviceDecodedBytes)
            stagedMemoryScope = createInstrumentMemoryScope(instrumentSources, projection.graph.assets,
              addedInstruments.map(({ state }) => state), policy.deviceDecodedBytes,
              `native-stage:${crypto.randomUUID()}`)
            if (!stagedMemoryScope) throw new Error("Native sample memory policy is unavailable.")
            stagedMemoryScope.set("page-staging", 2 * 1024 ** 2, () => undefined)
          }
          for (const { asset, pcm, sourceAssetKey, preparedStretchArtifactId } of addedAssets) {
            publicationAbort.signal.throwIfAborted()
            const mapping = mappings.get(asset.assetId)
            if (!mapping) throw new Error("Native session asset mapping is incomplete.")
            if (pcm) {
              checked(await awaitPreparation(session.installAsset({ sessionAssetId: mapping.sessionAssetId,
                frameCount: asset.frameCount, sampleRateHz: asset.sampleRateHz, channelCount: asset.channelCount,
                planarPcm: planarBytes(pcm.planes) })))
              continue
            }
            const pageSourceKey = sourceKeys.get(asset.assetId)
            if (!pageSourceKey) throw new Error("Native page source mapping is incomplete.")
            if (preparedStretchArtifactId) {
              const source: NativeTimelineSource = {
                sourceAssetKey: pageSourceKey, sessionAssetId: mapping.sessionAssetId,
                frameCount: asset.frameCount, sampleRateHz: asset.sampleRateHz, channelCount: asset.channelCount,
                preparedStretchArtifactId, artifactRepository: preparedStretchRepository,
              }
              sources.push(source)
              mappedResources.push({ source, create: async () => awaitPreparation(
                createMappedAsset(session, asset, mapping, preparedStretchArtifactId)) })
              continue
            }
            const regionalBuffer = regionalSources.get(sourceAssetKey)
            const descriptor = await awaitPreparation(resolveTimelineDescriptor(sourceAssetKey, asset,
              snapshotAssets, clips, regionalBuffer, publicationAbort.signal))
            const source = { sourceAssetKey: pageSourceKey, sessionAssetId: mapping.sessionAssetId, frameCount: asset.frameCount,
              sampleRateHz: asset.sampleRateHz, channelCount: asset.channelCount, descriptor,
              immutableAfterPreparation: regionalBuffer !== undefined }
            sources.push(source)
            mappedResources.push({ source, create: async () => awaitPreparation(
              createMappedAsset(session, asset, mapping, preparedStretchArtifactId)) })
          }
          publicationAbort.signal.throwIfAborted()
          discardAddedSources = pageManager.addSources(sources)
          addedTimelineSources = sources.length > 0
          await prepareMappedResources(mappedResources, pageManager, sources.filter((source) => source.immutableAfterPreparation)
            .map((source) => ({ sourceAssetKey: source.sourceAssetKey, startFrame: 0, endFrame: source.frameCount })),
          publicationAbort.signal, false)
          stagedMemoryScope?.set("page-staging", 0, () => undefined)
        }
        publicationAbort.signal.throwIfAborted()
        checked(await awaitPreparation(session.configureInstrumentStates(serializeNativeInstrumentStates(addedInstruments, assets))))
        // New timeline sources hydrate while a window is staged, which would spend the short bound lead. Page the
        // candidate first on a discarded coordinator, submitting nothing.
        if (addedTimelineSources) {
          const candidateRevision = ready.revision.requestedRevision
          await awaitPreparation(coordinator.prepareCandidatePages({ ...snapshot, revision: candidateRevision },
            { ...graph, revision: candidateRevision }, coordinator.currentFrame(), seam, { assets, assetSourceKeys: sourceKeys,
              nativePcmChunkDescriptors: projection.nativePcmChunkDescriptors, preparedStretchAssets: candidate.stretchAssets },
            publicationAbort.signal))
        }
        // Nothing the seam depends on is left to do: rebind it to fresh native progress, before any staging
        // (native resets the still-empty prepared bank). A refused bind keeps the provisional seam, which is safe. The bind
        // spends no resubmit, so the rebase growth and budget start from zero; two attempts bound it.
        for (let attempt = 0; attempt < 2; attempt++) {
          const fresh = await inspect(binding, true)
          if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
          if (!fresh?.ok || fresh.revision.status !== "prepared" || fresh.revision.progressFrame === undefined
            || fresh.revision.requestedPublicationFrame !== BigInt(seam)) break
          if (fresh.revision.transportEpoch !== transportEpoch) throw new NativePlaybackAbortError("ownership-invalidated")
          const bound = chooseFrame(fresh.revision.progressFrame, boundLeadBlocks())
          if (bound >= seam) break
          const rebind = { ...binding, requestedPublicationFrame: BigInt(bound) }
          const rebound = await withoutLane(revisions.publish(rebind))
          if (!rebound.ok) classifyPublication(rebound)
          checked(rebound)
          if (rebound.revision.status === "prepared") { seam = bound; binding = rebind; break }
        }
        let status: NativeRevisionReply = ready
        let fill = true
        let submittedProgress = -1
        adoptPublication = (proof, acknowledgedEpoch) => {
          const afterTransport = acknowledgedEpoch !== undefined
          if (!proof.ok || !binding || !sessionAlive() || proof.hostGeneration !== ready.hostGeneration
            || proof.hostPid !== ready.hostPid
            || proof.revision.transportEpoch !== (acknowledgedEpoch ?? publicationEpoch)
            || !staged?.activateRevision(proof.revision)) return false
          if (afterTransport) staged.dispose()
          else {
            coordinator.dispose()
            scheduleCoordinator = staged
            staged.install()
          }
          staged = undefined
          preparedGraph = { ...graph, revision: binding.revision }
          structuralGraphGeneration++
          processorState.published(binding.revision)
          scheduleCandidates.delete(candidate)
          const synthInstances = new Map([...synthNodes(snapshot)].map(([instanceId, nodeId]) => [nodeId, instanceId]))
          // A configured-again instrument starts its synth from the graph's values. Its processors keep their
          // history slot, and so their applied overrides, unless their own structure changed (audio_core.cpp:8044-8072).
          const configuredNodes = new Set(addedInstruments.map(({ nodeId }) => nodeId))
          const reconfiguredTargets = new Set(graph.nodes.flatMap((node) => {
            const synth = configuredNodes.has(node.id) ? synthInstances.get(node.id) : undefined
            return synth === undefined ? [] : [synth]
          }))
          const previousStates = new Map(previousGraph.nodes.flatMap((node) =>
            node.processorOrder.map((processor): [string, typeof processor] => [processor.id, processor])))
          // A retained processor whose published state changed may have a fresh native history slot.
          const restatedTargets = new Set(graph.nodes.flatMap((node) => node.processorOrder.flatMap((processor) => {
            const was = previousStates.get(processor.id)
            return was?.kindId === processor.kindId && !sameBytes(was.state, processor.state) ? [processor.id] : []
          })))
          const reconcile = processorState.adopted(
            targetKinds(graph, snapshot),
            reconfiguredTargets,
            restatedTargets,
            merged.sequence,
            (included) => statePatchMatchesCurrentProcessor(included.target.instanceId, included.content.state),
            record.content,
          )
          preparedSnapshot = snapshot
          preparedInstrumentTrackIds = sampledInstrumentTrackIds(snapshot)
          const predecessorStretchLease = preparedStretchLeaseSession
          preparedStretchAssetsForSession = candidate.stretchAssets
          preparedStretchLeaseSession = candidate.dispose
          pendingStretchCandidates.delete(candidate.dispose)
          installedAssets = assets
          installedAssetIds = assets.map((mapping) => mapping.sessionAssetId)
          installedAssetSourceKeys = sourceKeys
          nativePcmChunkDescriptorsForSession = projection.nativePcmChunkDescriptors
          resourcesPromoted = true
          advanceScheduleSettledEpoch()
          // Release ACK registers deferred collection, not reusable IDs or a
          // proof that queued sources/fading voices have finished reading.
          for (const mapping of removedAssets) {
            void session.releaseAsset(mapping.sessionAssetId).then((reply) => {
              if (!reply.ok) reportStopped(reply.error, { retainPlayback: true })
            }, () => reportStopped("Native deferred asset release failed.", { retainPlayback: true }))
          }
          preparedKeepLatencyNodeIds = serializedKeepLatencyNodeIds
          promoteNativeObservationMaps(binding.revision, candidateObservations)
          holdRetirement(proof, projectId, async () => {
            await pageManager?.removeSources(removedAssetIds)
            await predecessorStretchLease?.()
          })
          binding = undefined
          executeReconcile(reconcile)
          input.onInstrumentPreparation?.(preparedInstrumentTrackIds, { state: "ready" })
          return true
        }
        for (;;) {
          if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
          observed = sequence
          classifyPublication(publishReply)
          if (status.ok) classifyPublication(status)
          if (!status.ok) {
            throw new Error(status.error)
          }
          if (status.revision.status === "published") {
            if (!adoptPublication(status))
              throw new Error("Native live publication proof does not match the staged bank.")
            return await finish({ status: "adopted" }, "promoted")
          }
          if (failure && "reason" in failure.outcome) throw new Error(failure.outcome.reason)
          if (fill) {
            staged?.dispose()
            try {
              // Cancel only this publication's wait. The active refill remains
              // owned by its coordinator until the transport transition.
              await awaitPreparation(coordinator.coverThrough(seam + maximumFramesPerBlock))
              publicationAbort.signal.throwIfAborted()
              staged = coordinator.stageRevision({ ...snapshot, revision: binding.revision },
                { ...graph, revision: binding.revision }, seam, async () => {
                  if (!binding) throw new NativePlaybackAbortError("ownership-invalidated")
                  const rejectedAt = sequence
                  const inspection = await inspect()
                  if (!inspection?.ok || inspection.revision.status !== "prepared")
                    throw new Error("Native staged window needs publication reconciliation.")
                  await waitForOpportunity(rejectedAt)
                }, { assets, assetSourceKeys: sourceKeys, nativePcmChunkDescriptors: projection.nativePcmChunkDescriptors,
                  preparedStretchAssets: candidate.stretchAssets })
              staged.preflight({ ...graph, revision: binding.revision })
              await staged.prime(seam)
            } catch (error) {
              const inspection = await inspect()
              if (!inspection?.ok || inspection.revision.status !== "rebase-required") throw error
              status = inspection
            }
            fill = false
          }
          if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
          if (status.ok && status.revision.status === "rebase-required") {
            if (record.resubmits >= 8) {
              const error = "Native live publication needs a fresh progress window."
              throw new Error(error)
            }
            await waitForOpportunity(observed)
            const inspection = await inspect()
            if (!inspection) throw new Error("Publication status unavailable.")
            checked(inspection)
            status = inspection
            if (status.revision.status === "published") continue
            if (status.revision.transportEpoch !== transportEpoch)
              throw new NativePlaybackAbortError("ownership-invalidated")
            retry()
            seam = chooseFrame(status.revision.progressFrame ?? BigInt(coordinator.currentFrame()),
              Math.min(boundLeadBlocks() * 2 ** record.resubmits, 16 * (record.resubmits + 1)))
            binding = { ...binding, requestedPublicationFrame: BigInt(seam) }
            publishSent = true
            record.phase = "held"
            if (!sessionAlive()) throw new NativePlaybackAbortError("ownership-invalidated")
            const published = await withoutLane(revisions.publish(binding))
            classifyPublication(published)
            checked(published)
            status = published
            if (status.revision.status !== "prepared") throw new Error(`Native rebase was ${status.revision.status}.`)
            fill = true
            continue
          }
          if (publishReply && !publishReply.ok) checked(publishReply)
          if (status.revision.status !== "prepared" && status.revision.status !== "publish-pending")
            throw new Error(`Native live publication was ${status.revision.status}.`)
          if (status.revision.status === "prepared" && progressVersion !== submittedProgress) {
            if (publishSent) retry()
            submittedProgress = progressVersion
            const request = binding
            publishSent = true
            record.phase = "held"
            if (!sessionAlive()) throw new NativePlaybackAbortError("ownership-invalidated")
            // A lost IPC reply must not prevent progress-based reconciliation.
            publishCompletion = revisions.publish(request).then((reply) => {
              if (!sessionAlive()) return
              publishReply = reply
              notify()
            }, () => { if (sessionAlive()) notify() })
          }
          await waitForOpportunity(observed)
          status = await inspect(binding, true) ?? { ok: false, error: "Publication status unavailable.", kind: "unconfirmed" }
        }
      } catch (error) {
        if (!sessionAlive()) { await disposePublication(); return { record } }
        if (error instanceof PublicationFailure) {
          const capacity = error.kind === "refused" && (error.message === "asset-capacity-exceeded"
            || error.message === "asset-page-capacity-exceeded" || error.message === "asset-publication-pending")
          retainCandidate = capacity
          if (error.kind === "refused") failure = {
            outcome: { status: capacity ? "blocked" : "failed", reason: error.message }, reason: "stage-failed",
          }
          else uncertainPreparation = error.kind === "unconfirmed"
        }
        if (!current() || error instanceof NativePlaybackAbortError) record.cancelled = true
        if (binding) {
          // A revision deadline proves nothing about publication. Reconcile from
          // that reply/deadline event before releasing the lane.
          await publishCompletion
          classifyPublication(publishReply)
          await resolvePublication()
          // The lane is free for transport. The caller still follows this owner's terminal.
          detached = record.phase !== "ended"
          return { record }
        }
        const reason = error instanceof Error ? error.message : "Native live publication failed."
        if (record.cancelled) return await finish({ status: "superseded" }, "cancelled")
        return await finish(failure?.outcome ?? { status: "failed", reason },
          failure ? "failed" : uncertainPreparation || !publishSent ? "uncertain" : "failed", failure?.reason)
      } finally {
        if (!sessionAlive()) await disposePublication()
      }
  }

  type AdoptionRun = { outcome: AdoptionOutcome; content?: string; transport?: LivePlaybackTransport }
  const superseded: AdoptionRun = { outcome: { status: "superseded" } }
  // One attempt: compile (or reuse what native's last refusal kept), decide whether anything changed, publish. It
  // never throws; the owner retains its publication until native proof ends it.
  const executeAdoption = async (attempt: AdoptionAttempt): Promise<AdoptionRun> => {
    const { intent } = attempt
    const transportIntent = stagedTransportIntent
    // A pause or seek ends the domain the compile was made for, even before its transition has run.
    const inDomain = () => attempt.fields.epoch === transportEpoch && transportIntent === stagedTransportIntent
    try {
      const kept = processorState.takeRetained(intent)
      const reusable = kept && isScheduleCandidateValid(kept) ? kept : undefined
      if (kept && !reusable) await kept.dispose()
      const preparation = reusable ?? await prepareScheduleRevision(intent.context)
      if (preparation.status === "retry") return preparation.transport ? { ...superseded, transport: preparation.transport } : superseded
      if (preparation.status === "failed") return { outcome: { status: "failed", reason: preparation.reason } }
      if (!processorState.isNewest(attempt) || !inDomain()) {
        if (preparation.status === "staged") await preparation.dispose()
        return superseded
      }
      const content = input.fingerprintSnapshot?.(preparation.snapshot)
      if (content !== undefined) {
        if (content === input.fingerprintSnapshot?.(preparation.previous)) {
          reconcileUnpublishedCandidate(preparation)
          // The prepared session already plays this compile's content, so it takes the compile's revision: a resume
          // compares revisions to tell whether its own compile is the prepared content.
          if (isScheduleCandidateValid(preparation)) preparedSnapshot = { ...preparation.previous, revision: preparation.snapshot.revision }
          await preparation.dispose()
          return { outcome: { status: "unchanged" } }
        }
        if (processorState.rejectedContent(content, adoptionFields())) {
          await preparation.dispose()
          return { outcome: { status: "failed", reason: "previous-content-rejection" }, content }
        }
      }
      const result = await publishRevision({ kind: "schedule", candidate: preparation, intent: transportIntent, attempt })
      const outcome = "record" in result ? await result.record.terminal : result.outcome
      if (outcome.status === "blocked") {
        // Publication keeps the candidate for the retry only when it was still valid to publish.
        if (scheduleCandidates.has(preparation) && (!inDomain() || !processorState.retainCandidate(attempt, preparation)))
          await preparation.dispose()
        return { outcome }
      }
      return { outcome, content }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logFailedAdoption(reason)
      return { outcome: { status: "failed", reason } }
    }
  }
  // The transport takes the loop before every compile, so no compile ever moves it. A loop the compile disagrees on is
  // applied once and the same intent compiles again; so is an intent whose domain ended under it, as a seek does,
  // when nothing newer waits.
  const runAdoption = async (attempt: AdoptionAttempt): Promise<AdoptionRun> => {
    let loop: Pick<LivePlaybackTransport, "loopEnabled" | "loopStartSec" | "loopEndSec"> = attempt.intent.loop
    let mismatched = false
    // Notifications of one user action arrive together: the newest intent among them is the one that runs.
    await Promise.resolve()
    if (!processorState.isNewest(attempt)) return superseded
    for (;;) {
      try {
        await updateLoop(loop)
      } catch (error) {
        return { outcome: { status: "failed", reason: error instanceof Error ? error.message : String(error) } }
      }
      // Cancelled, or overtaken by an intent that changes the schedule, while the loop was applied.
      if (!processorState.isNewest(attempt)) return superseded
      attempt.fields = adoptionFields()
      const run = await executeAdoption(attempt)
      if (run.transport && !mismatched) {
        loop = run.transport
        mismatched = true
      } else if (attempt.publication || run.outcome.status !== "superseded" || attempt.fields.epoch === transportEpoch || !processorState.isNewest(attempt))
        return run
    }
  }
  const runAdoptions = async (first: AdoptionStart<ScheduleRevisionCandidate>) => {
    for (let start: AdoptionStart<ScheduleRevisionCandidate> | undefined = first; start;) {
      disposeKept(start.dispose)
      const { outcome, content } = await runAdoption(start.attempt)
      processorState.settleAdoption(start.attempt, outcome, content)
      void drainStatePatches()
      start = processorState.nextAdoption(adoptionFields(), outcome.status === "blocked" || outcome.status === "failed")
    }
  }
  // A newer differing intent waits behind a running attempt and never cancels it; each caller is answered with the
  // outcome of its own intent.
  const adoptSchedule = (intent: AdoptionIntent, explicit = false): Promise<AdoptionOutcome> => {
    const submitted = processorState.submitAdoption(intent, explicit, adoptionFields())
    if (submitted.start) void runAdoptions(submitted.start)
    return submitted.settled
  }

  // The attempt running is cancelled, its publication too while native cannot hold it: a queued one sees the moved intent
  // and never starts, one under way is rolled back. Once Publish was sent native may claim it in any callback, and the
  // attempt ends with what native did: rolling it back would only be answered "pending", which a transport transition
  // settles and a drop does not.
  const dropAdoptionIntents = () => {
    stagedTransportIntent++
    disposeKept(processorState.dropIntents())
  }

  const sameBytes = (left: Uint8Array, right: Uint8Array) =>
    left.length === right.length && left.every((byte, index) => byte === right[index])
  const statePatchMatchesCurrentProcessor = (instanceId: string, state: Uint8Array) => {
    const match = preparedGraph ? resolveGraphProcessor(preparedGraph, instanceId) : undefined
    return !!match && sameBytes(state, match.processor.state)
  }
  // Session-owned latest inputs. Requests write these synchronously, while each
  // execution freezes its own graph, routing snapshot, membership and attachment plan.
  let latencyInputVersion = 0
  const attachmentLatencies = new Map<string, { generation: number; latencyFrames: number }>()
  const captureLatencyInputs = () => {
    if (!preparedGraph || !preparedSnapshot) throw new Error("Native graph is unprepared.")
    // Only the attachment plan is replaced below. Snapshots are never written in place, and their clip and instrument
    // buffers are live AudioBuffers that structuredClone refuses, so they are shared as the compile shares them.
    const snapshot = { ...preparedSnapshot }
    const plan = snapshot.nativeExternalAttachmentPlan
    if (plan) snapshot.nativeExternalAttachmentPlan = { ...plan, attachments: plan.attachments.map(attachment => {
      const desired = attachmentLatencies.get(attachment.instanceId)
      return desired?.generation === lifecycleGeneration
        ? { ...attachment, declaredLatencyFrames: desired.latencyFrames } : attachment
    }) }
    const projected = ingestProjectedProcessors(snapshot)
    const ledger = processorState.capture()
    const sequence = Math.max(processorState.includedOrder(), projected?.sequence ?? 0,
      ...[...ledger.values()].map(desired => desired.order))
    const external = snapshot.nativeExternalAttachmentPlan && nativeOfflineExternalLatencyFrames(snapshot.nativeExternalAttachmentPlan)
    const base = structuredClone(preparedGraph)
    const graph = graphWithLedger({ ...base, nodes: base.nodes.map(node => ({
      ...node, ...(external && { externalLatencyFrames: external.get(node.id) }),
    })) }, processorState.includedOrder() - 1, ledger, snapshot.bpm, snapshot, captureInstrumentIncarnations(snapshot))
    return { graph: compensateGraph(graph, snapshot), snapshot, sequence, ledger, keep: new Set(desiredKeepLatencyNodeIds) }
  }
  const latencyInputsApplied = () => {
    if (!preparedGraph || !preparedSnapshot) return false
    const capture = captureLatencyInputs()
    return sameBytes(serializeNativeGraph(capture.graph, capture.keep),
      serializeNativeGraph(preparedGraph, preparedKeepLatencyNodeIds))
  }
  const requestLatencyPublication = async (): Promise<NativePublicationResult> => {
    if (!prepared) return { handled: false, reason: "unprepared" }
    const result = await publishRevision({ kind: "latency" })
    if (!("record" in result)) return result.outcome.status === "unchanged" ? { handled: true } : { handled: false, reason: "unprepared" }
    const outcome = await result.record.terminal
    if (outcome.status === "adopted") return { handled: true }
    if (outcome.status === "superseded" && outcome.evidence === "lost") return { handled: false, reason: "unprepared" }
    if (outcome.status === "failed" && outcome.failureKind)
      return { handled: false, reason: outcome.failureKind.kind === "refused" ? "bridge-error" : outcome.failureKind.kind,
        ...(outcome.failureKind.message !== undefined && { error: outcome.failureKind.message }) }
    return { handled: false, reason: "unconfirmed" }
  }
  const updateKeepLatency = () => {
    const next = new Set(input.getKeepLatencyNodeIds?.())
    if (next.size !== desiredKeepLatencyNodeIds.size || [...next].some(id => !desiredKeepLatencyNodeIds.has(id))) latencyInputVersion++
    desiredKeepLatencyNodeIds = next
    if (!processorState.publication() && next.size === preparedKeepLatencyNodeIds.size
      && [...next].every(id => preparedKeepLatencyNodeIds.has(id))) return Promise.resolve<NativePublicationResult>({ handled: true })
    return requestLatencyPublication()
  }
  const attachmentGeneration = (instanceId: string) => prepared
    && preparedSnapshot?.nativeExternalAttachmentPlan?.attachments.some(attachment =>
      attachment.instanceId === instanceId && !attachment.bypassed) ? lifecycleGeneration : undefined
  const publishAttachmentLatency = (change: { instanceId: string; generation: number; latencyFrames: number }): Promise<NativePublicationResult | { handled: false; reason: "stale" | "invalid-latency" }> => {
    if (attachmentGeneration(change.instanceId) !== change.generation)
      return Promise.resolve({ handled: false, reason: "stale" } satisfies { handled: false; reason: "stale" })
    if (!Number.isSafeInteger(change.latencyFrames) || change.latencyFrames < 0 || change.latencyFrames > 65_536)
      return Promise.resolve({ handled: false, reason: "invalid-latency" } satisfies { handled: false; reason: "invalid-latency" })
    attachmentLatencies.set(change.instanceId, { generation: change.generation, latencyFrames: change.latencyFrames })
    latencyInputVersion++
    return requestLatencyPublication()
  }
  // A plug-in's own report reaches the live graph with no stop and no rebuild: latency is a publication, a fault
  // is that instance's failed state. An instance this session does not hold is ignored.
  const handleVstInstanceEvent = (event: DesktopVstInstanceEvent) => {
    const generation = attachmentGeneration(event.instanceId)
    if (generation === undefined) return
    if (event.kind === "failed") return markVstInstanceFailed(event.instanceId)
    void (async () => {
      try {
        const result = await publishAttachmentLatency({ instanceId: event.instanceId, generation, latencyFrames: event.latencyFrames })
        if (!result.handled) console.warn("[native-vst3] latency publication not applied", { reason: result.reason })
      } catch (error) {
        console.error("[native-vst3] latency publication failed", { error: error instanceof Error ? error.message : "unknown" })
      }
    })()
  }
  // The typed reply of one patch send. The answer decides nothing here: the ledger's fence and policy do.
  const patchReplyOf = (reply: NativeProcessorPatchReply): PatchReply => {
    if (!reply.ok) return reply.kind === "refused" ? { kind: "refused", refusal: "native-refused", transient: false } : { kind: reply.kind }
    switch (reply.outcome) {
      case "applied": return { kind: "applied" }
      case "claimed": return { kind: "claimed", token: BigInt(reply.token) }
      case "refused": {
        if (reply.refusal === "unavailable") return { kind: "unavailable" }
        // A refusal over a prepare, a publication or a transition this controller has outstanding is offered again at
        // that operation's end; with none outstanding it is definite.
        const transient = (reply.refusal === "preparing" || reply.refusal === "stale-revision") && outstandingOperation()
        return { kind: "refused", refusal: reply.refusal, transient, ...(reply.token !== undefined && { token: BigInt(reply.token) }) }
      }
    }
  }
  const runBuiltInStatePatch = async ({ execution, desired: materialized }: { execution: Execution; desired: ProcessorDesired }) => {
    // A patch that was never sent: its requests are answered and the ledger takes its desired back.
    const unsent = (outcome?: ProcessorDeliveryOutcome) => executeReconcile(processorState.abandon(execution, outcome))
    const bridge = input.bridge
    if (!bridge || !prepared || !preparedGraph || !preparedSnapshot) return unsent()
    const queueProcessorStatePatch = bridge.session.queueProcessorStatePatch
    const { instanceId } = materialized.target
    if (isRetiredTarget(execution.edit, instanceId)) return executeReconcile(processorState.cancel(execution, true))
    const graph = preparedGraph
    const match = resolveGraphProcessor(graph, instanceId)
    if (!match) return unsent()
    const { state } = materialized.content
    const layouts = nativeProcessorLayoutsForState(match.node, instanceId, state)
    if (!layouts || materialized.bypassed !== match.processor.bypassed
      || layouts.output !== nativeProcessorLayoutsForState(match.node, instanceId, match.processor.state)?.output) {
      return unsent({ state: "refused", reason: "unsupported" })
    }
    if (nativeProcessorLatencyForState(match.processor, state) !== match.processor.latencyFrames) {
      // The publication folds the ledger, which holds this patch's newest content, and settles its record. A transport
      // that cancels it requeues the record, which can be dispatched again before this answer: only this dispatch acts.
      const { attempt } = execution
      void requestLatencyPublication().then(result => {
        if (!result.handled && execution.attempt === attempt && execution.state !== "cancelled" && execution.state !== "applied")
          executeReconcile(result.reason === "unprepared"
            ? processorState.abandon(execution)
            : processorState.patchReplied(execution, { kind: "refused", refusal: "stage-failed", transient: false }))
      })
      return
    }
    if (!queueProcessorStatePatch) return unsent()
    const patch = serializeNativeProcessorStatePatch({
      graphRevision: graph.revision,
      nodeId: match.node.id,
      instanceId: match.processor.instanceId,
      kindId: match.processor.kindId,
      stateVersion: match.processor.stateVersion,
      state,
      bypassed: match.processor.bypassed,
      inputLayout: layouts.input,
      outputLayout: layouts.output,
      parameterTargets: [...match.parameterTargets.values()],
      latencyFrames: match.processor.latencyFrames,
      tailFrames: materialized.tailFrames,
    })
    const reply = await queueProcessorStatePatch(patch).catch((error): NativeProcessorPatchReply => ({
      ok: false,
      kind: "unconfirmed",
      error: error instanceof Error ? error.message : "Native built-in processor state patch failed.",
    }))
    if (reply.ok && reply.outcome === "applied" && preparedGraph) {
      preparedGraph = {
        ...preparedGraph,
        nodes: preparedGraph.nodes.map((node) => ({
          ...node,
          processorOrder: node.processorOrder.map((processor) => {
            if (processor.id !== instanceId) return processor
            const { tailKind: _tailKind, ...withoutTailKind } = processor
            return { ...withoutTailKind, state: state.slice(), tailFrames: materialized.tailFrames,
              ...(materialized.tailKind && { tailKind: materialized.tailKind }) }
          }),
        })),
      }
    }
    executeReconcile(processorState.patchReplied(execution, patchReplyOf(reply)))
  }

  // Native refuses a patch while a core is prepared (audio-host.cpp:3150). The lane serializes this controller's own
  // prepare, publish and adoption with patches, so the one prepared core a patch can meet is a rolled-back
  // publication native still holds as publish-pending; every patch waits for its owner's terminal. One
  // that changes latency also waits while an adoption attempt runs: it folds the latest desired content into its own
  // seam, and the lane would otherwise publish a revision against it. A retained candidate left by a refusal holds nothing.
  const runNextStatePatch = async () => {
    const next = processorState.nextPatch((desired) => {
      if (processorState.publication()) return undefined
      const match = preparedGraph && resolveGraphProcessor(preparedGraph, desired.target.instanceId)
      const pending = processorState.compiling() || processorState.adoptionRunning()
      if (pending && !!match
        && nativeProcessorLatencyForState(match.processor, desired.content.state) !== match.processor.latencyFrames) return undefined
      // Its parameters give the enabled flag and tail at the tempo now, not those of the edit it was queued for.
      return preparedSnapshot ? timedProcessorDesired(desired, sampleRate, preparedSnapshot.bpm) : desired
    })
    if (!next) {
      drainingStatePatches = false
      return false
    }
    await runBuiltInStatePatch(next)
    return true
  }
  // `nextPatch` runs in the lane task that sends what it returns: nothing is sent between the content it picks and
  // the send. The flag is cleared in the task that finds nothing, so a patch queued after it starts a new drain.
  const drainStatePatches = async () => {
    if (drainingStatePatches) return
    drainingStatePatches = true
    while (await queuePreparedTransportTransition(runNextStatePatch)) continue
  }

  const startLiveMidiNote = (note: {
    trackId: string
    pitch: number
    velocity: number
    playheadSec?: number
  }): NativeLiveMidiNoteHandle | undefined => {
    if (!input.bridge || hasNativeHostConnectionLoss() || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127
      || !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) return undefined
    if (preparedSnapshot && !preparedSnapshot.tracks.some((track) => track.id === note.trackId)) {
      return undefined
    }
    if (preparedGraph && !preparedGraph.nodes.some((node) => (
      node.id === note.trackId && node.kind === "instrument"
    ))) {
      return undefined
    }
    const noteId = nextLiveNoteId++
    const wasReady = livePreviewActive
    const queueNoteOn = () => queueLiveInstrumentEvent({
        nodeId: note.trackId,
        noteId,
        sequence: nextLiveEventSequence++,
        frameOffset: 0,
        type: "live-note-on",
        channel: 0,
        note: note.pitch,
        value: note.velocity,
      })
    const readiness: LiveNoteReadiness = {
      promise: Promise.resolve(),
      released: false,
      force: false,
      noteOnQueued: false,
      releaseQueued: false,
    }
    const queueRelease = () => {
      if (!readiness.noteOnQueued || readiness.releaseQueued) return
      readiness.releaseQueued = true
      void queueLiveInstrumentEvent({
        nodeId: note.trackId,
        noteId,
        sequence: nextLiveEventSequence++,
        frameOffset: 0,
        type: "live-note-off",
        channel: 0,
        note: note.pitch,
        value: 0,
      }).finally(() => {
        liveNoteReadiness.delete(noteId)
      })
    }
    const queueAfterPreparation = async (result: NativeStartResult) => {
      const instrument = preparedGraph?.nodes.find((node) => node.id === note.trackId)?.instrument
      if (
        result !== "started"
        || readiness.force
        || (!wasReady && instrument?.kind !== "synth")
        || !preparedSnapshot?.tracks.some((track) => track.id === note.trackId)
        || !preparedGraph?.nodes.some((node) => (
          node.id === note.trackId && node.kind === "instrument"
        ))
      ) {
        liveNoteReadiness.delete(noteId)
        return
      }
      readiness.noteOnQueued = (await queueNoteOn()) === true
      if (readiness.noteOnQueued) liveMidiTailOwned = true
      if (readiness.released && readiness.noteOnQueued) queueRelease()
      else liveNoteReadiness.delete(noteId)
    }
    readiness.promise = (livePreviewActive
      ? queueAfterPreparation("started")
      : ensureLivePreview(note.playheadSec ?? 0).then(queueAfterPreparation)
    ).catch(() => {
      liveNoteReadiness.delete(noteId)
    })
    liveNoteReadiness.set(noteId, readiness)
    return { backend: "native", trackId: note.trackId, pitch: note.pitch, noteId }
  }

  const releaseLiveMidiNote = (handle: NativeLiveMidiNoteHandle, force = false) => {
    if (handle.backend !== "native" || !input.bridge) return
    if (releasedLiveNoteHandles.has(handle)) return
    releasedLiveNoteHandles.add(handle)
    const readiness = liveNoteReadiness.get(handle.noteId)
    if (readiness) {
      readiness.released = true
      readiness.force = force
      void readiness.promise
      return
    }
    if (!livePreviewActive) return
    void queueLiveInstrumentEvent({
      nodeId: handle.trackId,
      noteId: handle.noteId,
      sequence: nextLiveEventSequence++,
      frameOffset: 0,
      type: "live-note-off",
      channel: 0,
      note: handle.pitch,
      value: 0,
    })
  }

  const subscribeNativeLiveMidiReset = (listener: () => void) => {
    nativeLiveMidiResetListeners.add(listener)
    return () => nativeLiveMidiResetListeners.delete(listener)
  }

  const subscribeTrackMeters = (listener: (levels: TrackStereoLevelsBatch) => void) => {
    nativeMeterListeners.add(listener)
    if (nativeLevels.size > 0) listener(new Map(nativeLevels))
    return () => nativeMeterListeners.delete(listener)
  }

  const subscribeMasterMeter = (listener: (levels: TrackStereoLevels) => void) => {
    nativeMasterMeterListeners.add(listener)
    listener(nativeMasterLevels)
    return () => nativeMasterMeterListeners.delete(listener)
  }

  const subscribeSpectrum = (targetId: string, listener: (frame: SpectrumFrame | null) => void) => {
    nativeSpectrumListeners.add(listener)
    nativeSpectrumTarget = targetId
    if (prepared) reconcileNativeSpectrumSelection()
    listener(null)
    return () => {
      nativeSpectrumListeners.delete(listener)
      if (nativeSpectrumListeners.size === 0) {
        nativeSpectrumTarget = undefined
        reconcileNativeSpectrumSelection(true)
      }
    }
  }

  const currentPositionSec = () => {
    if (sampleRate <= 0) return undefined
    const loop = preparedSnapshot && loopAppliesAtTransportPosition
      ? nativeLoopFramesForSnapshot(preparedSnapshot, sampleRate)
      : undefined
    return arrangementFrameForNativeFrame(transportFrame, loop) / sampleRate
  }

  return {
    schedulerDiagnostics: () => scheduleCoordinator?.refillDiagnostics(),
    getPendingStart: () => pendingStart
      ? { mode: pendingStartMode, promise: pendingStart }
      : undefined,
    cancelPendingStart,
    resetNativeHostConnectionLoss,
    start,
    pause,
    dispose,
    destroy,
    isActive: () => active,
    isAvailable: () => input.bridge !== undefined && !hasNativeHostConnectionLoss(),
    canProcessLiveMidi: () => livePreviewActive,
    hasLiveMidiTails: () => liveMidiTailOwned,
    isPrepared: () => prepared,
    preparedInstrumentIdentity: (targetId: string) => {
      if (!preparedGraph) return undefined
      const instrument = preparedSnapshot?.mixer.fx.trackFx?.[targetId]?.instrument
      return instrument ? { kind: instrument.kind, instanceId: instrument.instanceId } : null
    },
    // The prepared instrument, unless a dispatched edit has left native holding newer parameters.
    preparedInstrument: (targetId: string) => {
      const prepared = preparedSnapshot?.mixer.fx.trackFx?.[targetId]?.instrument
      const held = prepared && processorState.heldParams(prepared.instanceId)
      return isInstrumentParams(held) && held.instanceId === prepared?.instanceId ? held : prepared
    },
    preparedVstCapture: () => {
      const instanceIds = preparedSnapshot?.nativeExternalAttachmentPlan?.attachments
        .filter((attachment) => !attachment.bypassed)
        .map((attachment) => attachment.instanceId) ?? []
      return preparedProjectId
        ? { projectId: preparedProjectId, instanceIds }
        : undefined
    },
    startRecording,
    stopRecording,
    cancelRecording,
    isRecording: () => recording !== undefined,
    sampleRate: () => sampleRate,
    currentPositionSec,
    ensureLivePreview,
    seekPrepared,
    updateLoop,
    deliverProcessor,
    joinPublication,
    reenableProcessorAutomation,
    updateKeepLatency,
    attachmentGeneration,
    publishAttachmentLatency,
    adoptSchedule,
    dropAdoptionIntents,
    // Read-only view of the adoption record for acceptance attribution; the fuzzer fixture is its only consumer.
    adoptionWitness: processorState.adoptionWitness,
    // The facts a refusal answers to, as they stand now, to show none has moved since it.
    adoptionFieldsWitness: adoptionFields,
    // Compiled schedule candidates not yet published or disposed: a candidate that outlives its attempt keeps its stretched assets.
    liveScheduleCandidates: () => scheduleCandidates.size,
    startLiveMidiNote,
    releaseLiveMidiNote,
    subscribeNativeLiveMidiReset,
    subscribeTrackMeters,
    subscribeMasterMeter,
    subscribeSpectrum,
  }
}
