import { compileLiveNativeProjection, resolveMixerTiming } from "@daw-browser/audio-engine/live-native-projection"
import { arrangementFrameForLoop, effectiveLoopForStart, loopFramesForTransport } from "@daw-browser/audio-engine/loop-frame-schedule"
import { NativePlaybackAbortError } from "./native-playback-abort"
import type { PlaybackAcceptanceObserver } from "./acceptance-observer"
import { nativeExternalLatencyFrames as nativeOfflineExternalLatencyFrames } from "~/lib/export/native-offline-render-plan"
import {
  nativeAudioHostMaximumInstalledAssets,
  nativeKeepLatencyDivergentMixedBusDiagnostic,
} from "@daw-browser/desktop-protocol/native-audio-host"
import {
  mapNativeSessionAssets,
  serializeNativeGraph,
  nativeProcessorLatencyForState,
  nativeProcessorOutputLayoutForState,
  serializeNativeInstrumentStates,
  serializeNativeVstParameterEvents,
} from "@daw-browser/audio-engine/native-host-wire"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import { compilePortableSynthState } from "@daw-browser/audio-engine/mixer/graph-contract"
import { resolveLiveMixerGraph } from "@daw-browser/audio-engine/live-mixer-runtime"
import type { NativeRevisionReply, NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision"
import { type AudioPcmSourceDescriptor, type TrackInstrumentParams, parseExternalAutomationParameterId, parseJsonValue } from "@daw-browser/shared"
import { createAudioEffectParameterPayload } from "~/lib/audio-effect-parameter-payload"
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
import type {
  NativeHostDeviceConfiguration,
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
import type { importNativeRecordingSpool } from "~/lib/recording/native-spool-importer"
import type { DesktopVstInstanceEvent } from "@daw-browser/desktop-protocol"
import type { DesktopBridge } from "~/types/desktop-bridge"
import { clearInstanceLimits, clearVstInstanceFailures, markVstInstanceFailed, setInstanceLimits } from "./vst-instance-failures"
import { nativeVst3LaunchAuthorizationRequiredMessage } from "~/lib/external-plugin-ui"
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import { SYNTH_KIND_ID } from "~/lib/processor-edit-semantics"
import {
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
  createNativeScheduleCoordinator,
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
  type DispatchExecution,
  type InstalledContent,
  type ProcessorReconcile,
  type ProcessorDesired,
  type Receipt,
  receiptHandle,
} from "./native-processor-state-owner"
import {
  assertReply,
  createPublicationTransaction,
  PublicationFailure,
  runPublication,
  type InstrumentAssetHold,
  type NativeSessionReply,
  type PublicationPass,
  type PublicationStrategy,
  type PublicationTransaction,
} from "./native-publication-transaction"
import {
  createSchedulePublication,
  type ScheduleHost,
  type ScheduleRevisionCandidate,
  type ScheduleSession,
} from "./native-schedule-publication"
import {
  graphStructure,
  processorMembership,
  sampledInstrumentTrackIds,
  sampledKindId,
  scheduledRetention,
  synthNodes,
  targetKinds,
} from "./native-graph-targets"
import {
  hasEquivalentTransportScheduling,
  nativeSnapshotLimitations,
  nativeSnapshotSupportError,
  nativeTransportFor,
  nativeVstParameterEventsForSnapshot,
  pageRoundedBytes,
  planWithWorkerFrames,
  planarBytes,
  sameBytes,
  validateInstrumentAssetBudget,
} from "./native-snapshot-support"
import {
  createNativeHostConnectionLoss,
  indicatesNativeHostConnectionLoss,
  sanitizeNativeVst3DiagnosticError,
} from "./native-host-connection-loss"
import { createNativeParameterEvents, type ParameterReply } from "./native-parameter-events"
import { createNativeRetirement } from "./native-retirement"
import { createNativeStatePatches } from "./native-state-patches"
import { createNativeLiveMidi } from "./native-live-midi"
import { createNativeObservation } from "./native-observation"
import { createNativeRecording } from "./native-recording-session"
import { createNativeTimelinePageManager, nativeTimelinePageStagingBytes, type NativeTimelinePageManager, type NativeTimelineSource } from "./native-timeline-page-manager"
import { createSampledInstrumentRegionBudget, type SampledInstrumentRegionBudget, type SampledInstrumentRegionBudgetScope } from "~/lib/sampled-instrument-region-budget"
import type { NativeInstrumentPreparation } from "./native-instrument-budget-policy"

type NativePreviewAttempt = { orphanedAssetIds?: readonly number[] }

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

type NativePublicationResult =
  | { handled: true }
  | { handled: false; reason: "unprepared" | "unavailable" | "bridge-error" | "unconfirmed" | "latency-unsupported"; error?: string }

// Native's diagnostic says Keep Latency cannot be honoured for this graph: a fault of its own kind, not a failed publication.
class NativeLatencyUnsupportedError extends Error {}

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

const nativeAssetCapacityError =
  `Native playback exceeds the installed audio asset capacity of ${nativeAudioHostMaximumInstalledAssets} assets.`

type ScheduleRevisionPreparation =
  | ScheduleRevisionCandidate
  | { status: "retry"; reason: string; transport?: LivePlaybackTransport }
  | { status: "failed"; reason: string }
  | { status: "unsupported"; reason: string }

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
  // `coreaudio:<uid>` of the saved output; empty or omitted plays on the system default output.
  getOutputDeviceId?: () => string
  getProjectGeneration?: () => number
  getKeepLatencyNodeIds?: () => ReadonlySet<string>
  resolveSource?: AudioPcmSourceResolver
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  reportFault?: (fault: NativePlaybackFault, options?: { retainPlayback: true }) => void
  instrumentBudget?: SampledInstrumentRegionBudget
  onInstrumentPreparation?: (trackIds: readonly string[], status: NativeInstrumentPreparation) => void
  reportUnavailable?: boolean
  importRecordingSpool?: typeof importNativeRecordingSpool
  createPreparedStretchRepository?: () => PreparedStretchArtifactRepository
  createStretchCache?: (options: AudioStretchCacheOptions) => ReturnType<typeof createAudioStretchCache>
  // The content of a compiled schedule, for telling an unchanged one from a changed one; without it every compile is
  // taken as changed.
  fingerprintSnapshot?: (snapshot: LivePlaybackSnapshot) => string
  observer?: {
    // Names the record behind each processor parameter batch for acceptance attribution.
    processorDispatch?: (event: { key: string; editId: string; attempt: number; sequence: bigint }) => void
    adoption?: PlaybackAcceptanceObserver["adoption"]
    mark?: PlaybackAcceptanceObserver["mark"]
    // Another process owns the native session from startup, so this controller never acquires or retires it.
    externalSessionOwner?: boolean
  }
}) => {
  let active = false
  let prepared = false
  let nativeSessionStarted = false
  let livePreviewActive = false

  const hostLoss = createNativeHostConnectionLoss({
    projectGeneration: () => resolveProjectGeneration(),
    reportStopped: (message) => reportStopped(message),
  })

  let preparedProjectId: string | undefined
  let preparedProjectGeneration: number | undefined
  let pendingStart: Promise<NativeStartResult> | undefined
  let pendingStartMode: "play" | "preview" | undefined
  // The Play currently resuming the prepared session, if any; abandoning it leaves the session as it is.
  let pendingResume: { abandoned: boolean } | undefined
  let pendingStartCompileContext: LivePlaybackCompileContext | undefined
  let pendingPreviewAttempt: NativePreviewAttempt | undefined
  let lifecycleGeneration = 0
  let instrumentPreparationGeneration = 0
  let instrumentPreparationRequestGeneration = 0
  let nativeSessionGeneration = 0
  let transportEpoch = 1
  let nextLiveProcessorSequence = 0
  let nextTransportTransitionId = 0n
  // Every session asset the host holds, which Stop releases: the installed ones plus the retired instrument samples kept resident.
  let installedAssetIds: readonly number[] = []
  let installedAssets: readonly NativeSessionAsset[] = []
  let nextSessionAssetId = 1
  const sessionResourceIds = new Map<string, number>()
  // Each instrument-region session asset on the host, installed or retired, oldest install first: its locked bytes, and the
  // budget scope charging them with the buffer lease until the host acknowledges the asset's release. A sample that returns
  // while resident uploads nothing: the host keeps a published instrument mapping read-only and locked until released.
  const instrumentAssets = new Map<number, InstrumentAssetHold>()
  const instrumentReleaseAcks = new Set<Promise<unknown>>()
  // Retired samples stay resident up to this share of the aggregate sample budget, so a swap's peak stays within what it was.
  const residentInstrumentBytesCap = (input.bridge?.instrumentBudgetPolicy?.aggregateBytes ?? 0) / 8
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

  const createInstrumentScope = (scopeName: string) => {
    if (!instrumentBudget) throw new Error("Native sample memory policy is unavailable.")
    const scope = instrumentBudget.createScope(scopeName)
    instrumentMemoryScopes.add(scope)

    return scope
  }

  // One scope per instrument session asset, so its release credits exactly its bytes. A sample that does not fit makes
  // `evictResident` release the oldest retired one (it resolves once the host acknowledged, which credits it) and retries.
  const holdInstrumentAssets = async (
    assets: readonly { asset: AudioCoreGraphSnapshot["assets"][number]; sourceAssetKey: string }[],
    sources: readonly { sourceAssetKey: string; buffer: AudioBuffer }[],
    mappings: ReadonlyMap<string, NativeSessionAsset>,
    evictResident?: () => Promise<boolean>,
  ) => {
    const buffers = new Map(sources.map(({ sourceAssetKey, buffer }) => [sourceAssetKey, buffer]))
    const holds = new Map<number, InstrumentAssetHold>()

    try {
      for (const { asset, sourceAssetKey } of assets) {
        const buffer = buffers.get(sourceAssetKey)
        const mapping = mappings.get(asset.assetId)

        if (!buffer || !mapping) continue
        const bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT

        for (;;) {
          const scope = createInstrumentScope(`native-asset:${mapping.sessionAssetId}:${crypto.randomUUID()}`)

          try {
            scope.lease([{ key: sourceAssetKey, buffer, bytes }], true)
            scope.set(`resident:${sourceAssetKey}`, pageRoundedBytes(bytes), () => undefined)
            holds.set(mapping.sessionAssetId, { scope,
              bytes: pageRoundedBytes(asset.frameCount * asset.channelCount * Float32Array.BYTES_PER_ELEMENT) })
            break
          } catch (error) {
            releaseInstrumentScope(scope)

            if (!await evictResident?.()) throw error
          }
        }
      }
    } catch (error) {
      for (const { scope } of holds.values()) releaseInstrumentScope(scope)
      throw error
    }

    return holds
  }

  let preparedInstrumentTrackIds: readonly string[] = []
  let preparedSnapshot: LivePlaybackSnapshot | undefined
  // The priming of a paused edit's published schedule. A loop change and a Play follow its publication and this priming:
  // a Play resumes the schedule that settles with them, not the one they replace.
  let pausedPriming: Promise<void> | undefined
  // A Play resuming the prepared session is waiting for the adoption of the graph structure it compiled. Adoptions otherwise
  // wait for a pending Play; this one is the Play's own, and an adoption already waiting wakes to run it.
  let resumeAdoptionPending = false
  let resumeAdoptionWake = Promise.withResolvers<void>()
  let preparedGraph: AudioCoreGraphSnapshot | undefined
  let structuralGraphGeneration = 0

  // Renderer edit order, never bridge completion order. Every stamp comes from
  // the renderer's single edit allocator; the controller never mints orders.
  const processorState = createNativeProcessorStateOwner<ScheduleRevisionCandidate>({
    onTerminal: () => {
      executeReconcile(processorState.reoffer())
      void statePatches.drain()
    },
    // One notice per incident: later failures join it, and a new one notifies only after it closed.
    reportIncident: (category, targets) => input.reportFault?.(
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

  const statePatches = createNativeStatePatches({
    bridge: input.bridge,
    processorState,
    session: () => ({ prepared, sampleRate, graph: preparedGraph, snapshot: preparedSnapshot }),
    setPreparedGraph: (graph) => { preparedGraph = graph },
    isRetiredTarget,
    executeReconcile: (reconcile) => executeReconcile(reconcile),
    outstandingOperation: () => outstandingOperation(),
    requestLatencyPublication: () => requestLatencyPublication(),
    queueTransition: (task) => queuePreparedTransportTransition(task),
  })

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
  let unsubscribeVstInstanceEvents: (() => void) | undefined
  let sampleRate = 0
  let maximumFramesPerBlock = 0
  let transportFrame = 0
  let loopAppliesAtTransportPosition = true
  let preparedTransportTransitionGeneration = 0
  let loopUpdateSequence = 0
  let pendingLoopUpdates = 0

  const liveMidi = createNativeLiveMidi({
    bridge: input.bridge,
    state: () => ({
      hostLost: hostLoss.isLost(),
      livePreviewActive,
      sampleRate,
      transportEpoch,
      preparedTracks: preparedSnapshot?.tracks,
      preparedNodes: preparedGraph?.nodes,
    }),
    observeControl: (operation) => retirement.observeControl(operation),
    reportStopped: (message) => reportStopped(message),
    ensureLivePreview: (playheadSec) => ensureLivePreview(playheadSec),
  })

  let scheduleCoordinator: NativeScheduleCoordinator | undefined

  const nativeRecording = createNativeRecording({
    bridge: input.bridge,
    importRecordingSpool: input.importRecordingSpool,
    state: () => ({
      active,
      destroyed,
      sampleRate,
      projectId: input.getProjectId?.(),
      projectGeneration: resolveProjectGeneration(),
    }),
  })

  const observation = createNativeObservation({
    session: input.bridge?.session,
    transportEpoch: () => transportEpoch,
    state: () => ({
      sessionStarted: nativeSessionStarted,
      sessionGeneration: nativeSessionGeneration,
      prepared,
      preparedProjectId,
      preparedProjectGeneration,
      projectId: input.getProjectId?.(),
      projectGeneration: resolveProjectGeneration(),
    }),
  })

  let latestScheduleProgress: NativeScheduleProgress | undefined

  const queueBuiltInParameterEvents = createNativeParameterEvents({
    bridge: input.bridge,
    processorState,
    state: () => ({ prepared, graph: preparedGraph, snapshot: preparedSnapshot, transportEpoch }),
    observeControl: (operation) => retirement.observeControl(operation),
    nextEventSequence: () => liveMidi.nextEventSequence(),
    lastEventSequence: () => liveMidi.lastEventSequence(),
    observer: input.observer,
  })

  const retirement = createNativeRetirement({
    processorState,
    revisions: input.bridge?.session.revisions,
    state: () => ({
      lifecycleGeneration,
      prepared,
      hostLost: hostLoss.isLost(),
      preparedProjectId,
      transportEpoch,
      latestScheduleProgress,
    }),
  })

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
  signal?: AbortSignal, registerSources = true, mark?: (name: string) => void) => {
    for (const resource of resources) {
      signal?.throwIfAborted()
      await resource.create()
    }

    if (registerSources && resources.length > 0) pageManager.addSources(resources.map(({ source }) => source))
    await pageManager.ensureRanges(fullRegionRanges, signal, mark)
  }

  const createMappedAsset = async (
    session: NativePlaybackBridge["session"],
    asset: { frameCount: number; sampleRateHz: number; channelCount: number },
    mapping: { sessionAssetId: number },
    preparedStretchArtifactId: string | undefined,
    transactionToken?: string,
    mark?: (name: string) => void,
  ) => {
    if (!session.createMappedAsset) throw new Error("Native mapped asset hydration is unavailable.")
    mark?.("asset-create-request")

    const reply = await session.createMappedAsset({
      sessionAssetId: mapping.sessionAssetId, frameCount: asset.frameCount,
      sampleRateHz: asset.sampleRateHz, channelCount: asset.channelCount, preparedStretchArtifactId,
    }, transactionToken)

    mark?.("asset-create-reply")

    if (!reply.ok) throw new PublicationFailure(reply.error,
      "kind" in reply && (reply.kind === "refused" || reply.kind === "unconfirmed" || reply.kind === "unavailable")
        ? reply.kind : "refused")
  }

  const safePreparedProjectGeneration = (projectGeneration: number) =>
    Number.isSafeInteger(projectGeneration) && projectGeneration > 0 ? projectGeneration : 1

  const clearVstInstanceEvents = () => {
    unsubscribeVstInstanceEvents?.()
    unsubscribeVstInstanceEvents = undefined
  }

  const reportStopped = (message: string, options?: { retainPlayback: true }) =>
    input.reportFault?.({ kind: "session-stopped", message }, options)

  // A live edit that fails to adopt is never shown: the old graph keeps playing, the edit stays in the project,
  // and the next submission retries it. The log is the only record.
  const logFailedAdoption = (reason: string) => console.warn("[native-live-edit] adoption failed; the playing graph is unchanged", { reason })

  const handleNativeScheduleProgress = (progress: NativeScheduleProgress) => {
    const retirementChanged = progress.epoch === transportEpoch
      && progress.latencyCompletionGeneration > nativeLatencyCompletionGeneration

    const capacity = progress.admissionCapacityGeneration

    if (progress.epoch === transportEpoch && capacity > nativeAdmissionCapacityGeneration) {
      nativeAdmissionCapacityGeneration = capacity
      advanceScheduleCapacityEpoch()
    }

    const completions = progress.latencyCompletionGeneration

    if (progress.epoch === transportEpoch && completions > nativeLatencyCompletionGeneration) {
      nativeLatencyCompletionGeneration = completions
      prepareAdmissionWake?.()
    }

    latestScheduleProgress = progress
    processorState.reportProgress(progress)
    executeReconcile(processorState.observe(progress))
    // The token names the claim that resolved, so it settles while paused and quiet; the fence it releases lets the
    // lane send again and every target that waited for it be reconciled.
    const resolved = progress.processorPatchResolved

    if (resolved) executeReconcile(processorState.resolution(BigInt(resolved.token), resolved.result))

    if (processorState.hasQueuedPatch()) void statePatches.drain()
    const held = processorState.retirement()

    if (progress.epoch === transportEpoch && held) {
      const point = held.readerPoint

      const readerPassed = point && (progress.epoch > point.epoch
        || (!held.readerPassed && progress.epoch === point.epoch && progress.renderedThroughFrame > point.frame))

      if (readerPassed) {
        held.readerPassed = true
        held.readerPoint = { ...point, epoch: progress.epoch, frame: progress.renderedThroughFrame }
      }

      if (readerPassed || retirementChanged) retirement.opportunity()
    }
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
        queueScheduleWindow: (...args) => retirement.observeControl(bridge.session.queueScheduleWindow(...args)),
        queueInstrumentEvents: (...args) => retirement.observeControl(bridge.session.queueInstrumentEvents(...args)),
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
      mark: input.observer?.mark,
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
    liveMidi.restartQueue()

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
      || nativeRecording.isRecording()

    if (hostLost) {
      for (const scope of instrumentMemoryScopes) scope.release()
      instrumentMemoryScopes.clear()
      instrumentMemoryScope = undefined
      input.onInstrumentPreparation?.(preparedInstrumentTrackIds, {
        state: "error", error: hostLoss.message(),
      })
      preparedInstrumentTrackIds = []
    }

    if (hostLost) nativeRecording.loseHost(hostLoss.message)
    active = false
    prepared = false
    loopAppliesAtTransportPosition = true
    nativeSessionStarted = false
    livePreviewActive = false
    liveMidi.reset()
    scheduleCoordinator?.dispose()
    scheduleCoordinator = undefined
    observation.clear()
    clearVstInstanceEvents()
    preparedProjectGeneration = undefined
    preparedProjectId = undefined
    preparedSnapshot = undefined
    preparedGraph = undefined
    structuralGraphGeneration++
    preparedHostIdentity = undefined
    installedAssets = []
    installedAssetIds = []
    instrumentAssets.clear()
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
    hostLoss.beginIntentionalTransition()
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
        ? loopFramesForTransport(preparedSnapshot.transport, sampleRate)
        : undefined

      instrumentMemoryScope = undefined
      input.onInstrumentPreparation?.(preparedInstrumentTrackIds, { state: "loading" })
      preparedInstrumentTrackIds = []
      const hostLost = hostLoss.isLost()
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
            arrangementFrameForLoop(Number(reply.diagnostics.transportFrame), stoppedLoop) / stoppedSampleRate,
          )
        })
        : stopPromise

      // A refused cancel must not abort Stop: the renderer's recording session is cleared either way and the host Stop is already sent.
      await nativeRecording.cancel().catch(() => undefined)

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
      hostLoss.endIntentionalTransition()
    }
  }

  const dispose = (
    options?: { invalidateProjectArtifacts?: boolean; onStoppedPosition?: (seconds: number) => void },
    reason?: string,
  ) => {
    if (input.observer?.externalSessionOwner) return Promise.resolve()

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

  // Stop and Pause win over a Play resuming the paused session, not the session: the resume ends without sending a
  // run transport (or the caller's next paused transport undoes it), and ownership, graph and publications stay.
  // Settles once the Play has; undefined when no Play is resuming.
  const abandonResume = () => {
    if (!pendingResume || !pendingStart) return undefined
    pendingResume.abandoned = true

    return pendingStart.then(() => undefined, () => undefined)
  }

  const handleNativeHostLoss = (error?: string) => {
    if (hostLoss.isIntentionalTransition()) return

    const ownsNativeSession = prepared
      || nativeSessionStarted
      || active
      || livePreviewActive
      || scheduleCoordinator !== undefined
      || nativeRecording.isRecording()

    if (!ownsNativeSession) return
    const message = error ?? "Native playback host connection was lost."

    if (!hostLoss.markLost(message)) return
    invalidateNativeOwnership(true, true)
    hostLoss.reportFault(message)
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

    if (hostLoss.isLost()) {
      hostLoss.reportBlockedStart()

      return "unavailable"
    }

    let attemptedCoordinator: NativeScheduleCoordinator | undefined
    let attemptedPageManager: NativeTimelinePageManager | undefined
    let attemptStartController = startAbortController
    const resume = { abandoned: false }

    const cancelled = () => resume.abandoned
      || generation !== lifecycleGeneration
      || projectGeneration !== resolveProjectGeneration()
      || preparedProjectIdForAttempt !== input.getProjectId?.()
      || (attemptStartController !== undefined && startAbortController !== attemptStartController)
      || (attemptedCoordinator !== undefined
        && (scheduleCoordinator !== attemptedCoordinator || attemptedCoordinator.isDisposed()))
      || (attemptedPageManager !== undefined
        && (nativeTimelinePageManager !== attemptedPageManager || attemptedPageManager.isDisposed()))

    if (prepared && preparedProjectGeneration === projectGeneration && preparedProjectId === preparedProjectIdForAttempt) {
      let previousCoordinator: NativeScheduleCoordinator | undefined

      if (runTransport) pendingResume = resume

      try {
        await processorState.publication()?.terminal
        await pausedPriming

        // Only an abandonment returns here: any other cancellation is read after the compile, as it always was.
        if (resume.abandoned) return "unavailable"
        previousCoordinator = scheduleCoordinator
        attemptedCoordinator = previousCoordinator
        attemptedPageManager = nativeTimelinePageManager
        // Public project control can persist automation while a paused native
        // session remains prepared. Recompile before resuming its coordinator.
        let compiled = await input.compileSnapshot(transport, compileContext)

        // A track, send or sidechain edit the paused session has not adopted: a resume never rebuilds for it. The session
        // adopts it at seam 0 and primes it, then this Play compiles again and resumes what it holds.
        if (compiled.supported && graphStructure(compiled.snapshot) !== graphStructure(preparedSnapshot)) {
          const structure = graphStructure(compiled.snapshot)
          resumeAdoptionPending = true
          resumeAdoptionWake.resolve()

          try {
            await adoptSchedule({
              key: `resume:${structure}`, schedule: structure,
              context: { instrumentOverride: compileContext?.instrumentOverride, externalProcessor: compileContext?.externalProcessor },
              loop: { loopEnabled: transport.loopEnabled, loopStartSec: transport.loopStartSec, loopEndSec: transport.loopEndSec },
            })
            await pausedPriming
          } finally {
            resumeAdoptionPending = false
            resumeAdoptionWake = Promise.withResolvers<void>()
          }

          // The priming moved the session to a new epoch and coordinator.
          previousCoordinator = attemptedCoordinator = scheduleCoordinator
          attemptedPageManager = nativeTimelinePageManager
          compiled = await input.compileSnapshot(transport, compileContext)
        }

        const refreshed = compiled.supported
          ? { ...compiled, snapshot: { ...compiled.snapshot, transport } }
          : compiled

        // An abandoned resume must not fall through to a prepare, which replaces the session it was to resume.
        if (resume.abandoned) return "unavailable"
        // The prepared session schedules only the sources and processors it installed: a recompile that names another
        // source, places other processors or routes other nodes, needs a prepare.
        const installedSources = new Set(preparedSnapshot?.assets.map((asset) => asset.assetId))

        if (!refreshed.supported || refreshed.snapshot.revision !== preparedSnapshot?.revision
          || refreshed.snapshot.assets.some((asset) => !installedSources.has(asset.assetId))
          // Only an adoption that failed leaves the structure behind: the one case a resume prepares for it.
          || graphStructure(refreshed.snapshot) !== graphStructure(preparedSnapshot)
          || processorMembership(refreshed.snapshot) !== processorMembership(preparedSnapshot)) {
          preparedProjectGeneration = undefined
        } else {
          const frame = Math.round(transport.playheadSec * sampleRate)
          const effectiveTransport = effectiveLoopForStart(transport, frame, sampleRate)
          const effectiveSnapshot = { ...refreshed.snapshot, transport: effectiveTransport }

          // The recompile carries processor content the prepared graph may not hold: the ledger takes it and sends it,
          // as a prepare does for content edited after its compile.
          const adoptRecompiled = () => {
            const plan = refreshed.snapshot.nativeExternalAttachmentPlan
            preparedSnapshot = plan ? { ...refreshed.snapshot, nativeExternalAttachmentPlan: planWithWorkerFrames(plan, maximumFramesPerBlock) }
              : refreshed.snapshot
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

            const result = await queuePreparedTransportTransition(async () => {
              if (cancelled()) return "unavailable"

              // A publication admitted while this Play compiled holds its prepared bank outside the lane: a run transport
              // now would make native discard it. Start again: the attempt waits for it outside the lane first.
              if (processorState.publication()) return undefined
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

            if (result !== undefined || resume.abandoned) return result ?? "unavailable"

            return startAttempt(transport, generation, projectGeneration, runTransport, compileContext, previewAttempt)
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
          observation.clearSpectrumFrame()
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
          hostLoss.markLost(error instanceof Error ? error.message : undefined)
        }

        if (!wasCancelled && ownsAttemptedCoordinator && !indicatesNativeHostConnectionLoss(diagnosticError)) {
          reportStopped(error instanceof Error ? error.message : "Native playback could not resume.")
        }

        if (ownsAttemptedCoordinator && !wasCancelled) {
          if (hostLoss.isLost()) invalidateNativeOwnership(true, true)
          else await disposeNativeSession(undefined, "native-start-resume-failure")
        }

        return "unavailable"
      } finally {
        // A recursive resume registered itself first and owns the slot.
        if (pendingResume === resume) pendingResume = undefined
      }
    }

    if (prepared) {
      const assetIds = installedAssetIds
      const pageManager = nativeTimelinePageManager
      const releaseStretch = preparedStretchLeaseSession
      const memoryScope = instrumentMemoryScope
      instrumentMemoryScope = undefined
      installedAssetIds = []
      instrumentAssets.clear()
      nativeSessionGeneration += 1
      disposeKept(processorState.clear())
      scheduleCoordinator?.dispose()
      scheduleCoordinator = undefined
      observation.clear()
      clearVstInstanceEvents()
      active = false
      prepared = false
      nativeSessionStarted = false
      livePreviewActive = false
      liveMidi.supersedeEvents()
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
    let attemptedInstrumentHolds = new Map<number, InstrumentAssetHold>()

    const releaseAttemptedInstrumentMemory = () => {
      releaseInstrumentScope(attemptedInstrumentScope)

      for (const { scope } of attemptedInstrumentHolds.values()) releaseInstrumentScope(scope)
    }

    let instrumentStateAdmitted = false
    let instrumentTrackIds: readonly string[] = []
    let releasePageStaging: (() => void) | undefined
    let requiresNative = false
    let startStage = "compile"

    try {
      const snapshotResult = await input.compileSnapshot(transport, compileContext)

      // A cancelled start of a project that requires native playback stays blocked, as one cancelled later in the
      // transaction is, so the caller never falls back to a backend that cannot play the project.
      if (cancelled()) return snapshotResult.supported && snapshotResult.snapshot.requiresNativePlayback === true ? "blocked" : "unavailable"

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
      const outputDeviceId = input.getOutputDeviceId?.() || undefined
      const deviceReply = await bridge.resolveOutputDevice(outputDeviceId)

      if (cancelled()) return "unavailable"

      if (!deviceReply.ok && indicatesNativeHostConnectionLoss(deviceReply.error)) {
        hostLoss.markLost(deviceReply.error)
      }

      if (!deviceReply.ok || !deviceReply.device?.available) return unavailable(
        outputDeviceId && deviceReply.ok
          ? "Saved output (unavailable)"
          : "No native audio output device is available for the active VST3 effect.",
      )
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
        attemptedInstrumentHolds = await holdInstrumentAssets(projection.assets, instrumentRegionSources, sessionAssetsById)
        const scope = createInstrumentScope(`native-live:${crypto.randomUUID()}`)
        attemptedInstrumentScope = scope
        releasePageStaging = scope.reserve("page-staging", nativeTimelinePageStagingBytes).release
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

          if (reply?.ok) releaseAttemptedInstrumentMemory()
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

      instrumentAssets.clear()

      for (const [sessionAssetId, hold] of attemptedInstrumentHolds) instrumentAssets.set(sessionAssetId, hold)
      attemptedInstrumentHolds = new Map()
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
      observation.configure(snapshot.revision, snapshot.tracks)
      observation.attach()
      clearVstInstanceEvents()
      clearVstInstanceFailures()
      unsubscribeVstInstanceEvents = bridge.session.onVstInstanceEvent?.(handleVstInstanceEvent)
      observation.forgetSpectrumSelection()
      startStage = "start-session"
      assertReply(await bridge.session.start())

      if (cancelled()) {
        noteOrphanedSession()

        return "unavailable"
      }

      nativeSessionStarted = true
      observation.reconcileSpectrumSelection(true)
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
        hostLoss.markLost(error instanceof Error ? error.message : undefined)
      }

      const hostLost = hostLoss.isLost()

      if (transactionOpen && !hostLost) {
        if (transactionToken) await bridge.session.rollbackTransaction(transactionToken)

        if (!wasCancelled) await disposeNativeSession(undefined, "native-start-transaction-failure")
        else if (instrumentStateAdmitted) {
          // Rollback retires the bank but Phase 2 deliberately retains locks.
          // The successor is serialized behind this attempt; retire its host
          // resources without invalidating the successor's renderer generation.
          const teardown = await bridge.session.teardown("native-instrument-start-cancelled").catch(() => undefined)

          if (teardown?.ok) releaseAttemptedInstrumentMemory()
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
      if (!instrumentStateAdmitted) releaseAttemptedInstrumentMemory()
    }
  }

  const start = (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<NativeStartResult> => {
    if (destroyed || input.observer?.externalSessionOwner) return Promise.resolve("unavailable")

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
      hostLoss.beginRecovery()
      let result = await startAttempt(transport, generation, projectGeneration, true, compileContext)

      if (result !== "started" && hostLoss.isLost() && hostLoss.beginRecovery()) {
        result = await startAttempt(
          transport,
          lifecycleGeneration,
          projectGeneration,
          true,
          compileContext,
        )
      }

      if (result !== "started" && hostLoss.isLost() && !hostLoss.reported()) {
        hostLoss.reportFault(hostLoss.message())
      }

      if (result === "started") hostLoss.completeRecovery()

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
      hostLoss.beginRecovery()

      const transport: LivePlaybackTransport = {
        state: "paused",
        playheadSec,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }

      let result = await startAttempt(transport, generation, projectGeneration, false, compileContext, previewAttempt)

      if (result !== "started" && hostLoss.isLost() && hostLoss.beginRecovery()) {
        result = await startAttempt(
          transport,
          lifecycleGeneration,
          projectGeneration,
          false,
          compileContext,
          previewAttempt,
        )
      }

      if (result !== "started" && hostLoss.isLost() && !hostLoss.reported()) {
        hostLoss.reportFault(hostLoss.message())
      }

      if (result === "started") hostLoss.completeRecovery()

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
    if (destroyed || input.observer?.externalSessionOwner) return Promise.resolve("unavailable")

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

          if (supersededAttempt && orphanedAssetIds && bridge && !hostLoss.isLost()) {
            // The superseded attempt has settled and no replacement can start
            // until this continuation finishes. Only its successful Commit owns
            // this cleanup; never cancel an unrelated recording.
            supersededAttempt.orphanedAssetIds = undefined
            hostLoss.beginIntentionalTransition()

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
              hostLoss.endIntentionalTransition()
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
      if (!input.observer?.externalSessionOwner) await disposeNativeSession(undefined, "renderer-unmount")
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
    observation.clearSpectrumFrame()

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
        while (ownsTransition() && !hostLoss.isLost()) {
          const latest = await pendingPublication.inspect()

          if (!ownsTransition() || hostLoss.isLost()) return false

          if (latest.status !== "reply" || !latest.reply.ok || latest.reply.revision.status !== "publish-pending") {
            reply = await bridge.session.setTransport(transport)
            transportError = undefined
            break
          }

          await pendingPublication.awaitWake()
        }

        pendingPublication.stopAwaitingWake()
      }

      if (transportError !== undefined) throw transportError

      if (!reply) throw new Error("Native transport reply was unavailable.")
      assertReply(reply)

      if (!ownsTransition()) return false
      // A cancelled Publish can win the callback immediately before Seek.
      // The paused transport ACK settles callback ownership; inspect it before
      // waiting on a coordinator whose runtime revision may now be stale.
      const settling = processorState.publication()
      const adoptedLate = !!settling && await settling.acknowledge(transportEpoch)

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
          const sequence = liveMidi.nextEventSequence()

          return liveMidi.queueEvent({
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
    observation.reconcileSpectrumSelection(true)

    return true
  }

  const pause = async (playheadSec: number) => {
    const bridge = input.bridge

    if (!bridge || !active) return

    if (nativeRecording.isRecording()) throw new Error("Native recording must stop before playback can pause.")
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

    if (nativeRecording.isRecording()) throw new Error("Native recording must stop before playback can seek.")
    stagedTransportIntent++
    processorState.cancelPublication()
    const sequence = ++preparedSeekSequence
    const generation = preparedTransportTransitionGeneration

    try {
      return await queuePreparedTransportTransition(async () => {
        if (!prepared || generation !== preparedTransportTransitionGeneration) return "unavailable"

        if (sequence !== preparedSeekSequence) return "started"

        if (nativeRecording.isRecording()) return "unavailable"
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
    // Hydrated loop settings must not replace it with a paused epoch mid-start. The start's own adoption is its first step.
    await Promise.race([pendingStart, resumeAdoptionWake.promise])

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
      await pausedPriming
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

      // Only a host that reports the session gone ends it. Otherwise the transition left the host paused on its graph:
      // the session stays, and the next Play primes the loop again.
      if (hostLoss.isLost()) await disposeNativeSession(undefined, "native-loop-transition-failure")
      else active = false
      throw error
    } finally { pendingLoopUpdates-- }
  }

  const epochApplied = (epoch: number | undefined) => epoch === undefined || (latestScheduleProgress?.epoch ?? 0) >= epoch

  // The instrument edit's params are typed at the registry as `object`.
  const isInstrumentParams = (params: LiveProcessorEditIdentity["content"]["params"] | undefined): params is TrackInstrumentParams =>
    params !== undefined && "kind" in params && params.kind === "synth" && "instanceId" in params && typeof params.instanceId === "string"

  type ParameterFailure = Extract<ParameterReply, { ok: false }>

  // A prepare, a publication or a staged candidate this controller has outstanding names the event that offers a send
  // native refused over it again; with none, the refusal is definite.
  const outstandingOperation = () => processorState.compiling() || processorState.adoptionRunning()

  const resendRequest = (execution: DispatchExecution): LiveProcessorControlRequest => ({
    instanceId: execution.key,
    values: [...execution.values].map(([parameterId, value]) => ({ parameterId, value })),
  })

  // The completion of a refused send acts on the ledger's answer in the same turn (design 1.6): no timer, no frame.
  const parameterFailed = (execution: DispatchExecution, failure: ParameterFailure, reconciling: boolean) => {
    if (failure.kind === "refused" || failure.kind === "unconfirmed") {
      const kind = failure.kind === "unconfirmed" ? "uncertain" : outstandingOperation() ? "transient" : "definite"
      const action = processorState.refuse(execution, kind)

      if (action === "retry") void sendExecution({ ...resendRequest(execution), resent: execution }, true)
      else if (action === "ladder") void statePatches.drain()
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
      { edit: LiveProcessorEditIdentity; resent?: never } | { resent: DispatchExecution }
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
    let execution: DispatchExecution | undefined

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

    // A record dispatched again while this send was out is that dispatch's now, except for a parameter its processor
    // has no target for: no dispatch can carry it, and a frame redispatches an unsent record, which would otherwise
    // take the verdict from every send in turn.
    if (execution && (execution.attempt === attempt || !result.ok && result.kind === "not-sent" && result.reason === "unsupported")) {
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

    if (plan.carrier === "patch") void statePatches.drain()
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
      if ("patch" in item) void statePatches.drain()
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
    if (!prepared || !preparedGraph || !preparedSnapshot) return { accepted: false, reason: "unprepared" }
    const externalParameters = parameterIds.map((parameterId) => parseExternalAutomationParameterId(parameterId))
    const externalInstanceId = externalParameters[0]?.instanceId

    if (externalInstanceId !== undefined) {
      const attachment = preparedSnapshot.nativeExternalAttachmentPlan?.attachments
        .find((candidate) => candidate.instanceId === externalInstanceId)

      const parameters = new Map(attachment?.parameters?.map((parameter) => [parameter.id, parameter]))

      const targets = externalParameters.flatMap((external) => (
          external?.instanceId === instanceId
          && external.instanceId === externalInstanceId
          && parameters.get(external.parameterId)?.readOnly === false
        ) ? [external.parameterId] : [])

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

    const targets = parameterIds.flatMap((parameterId) => {
      const target = processor.parameterTargets.get(parameterId)

      return target === undefined ? [] : [target]
    })

    if (targets.length !== parameterIds.length) return { accepted: false, reason: "unsupported" }
    // Native resolves a lane only from the schedule it was published with, and a lane overridden by hand is left out of
    // that compile. The lane drives again once a publication from the current position carries it.
    const sequence = ++nextLiveProcessorSequence
    const key = `reenable-automation:${sequence}`
    const { loopEnabled, loopStartSec, loopEndSec } = preparedSnapshot.transport
    const outcome = await adoptSchedule({ key, schedule: key, context: {}, loop: { loopEnabled, loopStartSec, loopEndSec } }, true)

    return outcome.status === "adopted" || outcome.status === "unchanged"
      ? { accepted: true, sequence }
      : { accepted: false, reason: "bridge-error", error: `The native schedule did not take the re-enabled lane (${outcome.status}).` }
  }

  // Aborted when the transport domain ends, and the compile is abandoned at that moment: what it returns later is
  // dropped without a trace.
  const prepareScheduleRevision = async (
    context?: LivePlaybackCompileContext,
  ): Promise<ScheduleRevisionPreparation> => {
    const owner = processorState.openCompile()
    const previous = preparedSnapshot
    const coordinator = scheduleCoordinator

    if (!prepared || !previous || !preparedGraph || !coordinator) {
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
      const limitations = nativeSnapshotLimitations(snapshot)

      if (limitations.length === 0) clearInstanceLimits()
      else {
        setInstanceLimits(new Map(limitations.flatMap(({ reason, carriers }) => carriers.map((id): [string, string] => [id, reason]))))

        return { status: "unsupported", reason: limitations[0].reason }
      }

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

        // A Play resuming the paused session settles first, as a schedule adoption does in `runAdoption`: an edit admitted
        // while it compiles would hold its bank again when the Play's run transport is due, and a burst could starve it.
        if (payload.kind === "latency" && prepared && !active && pendingStartMode === "play" && pendingStart)
          return { starting: pendingStart }

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

      if (admitted.starting) {
        await admitted.starting.then(() => undefined, () => undefined)
        continue
      }

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

  // What executePublication captured of the prepared session, which both kinds of publication start from.
  type PublicationFacts = {
    previous: NonNullable<typeof preparedSnapshot>
    previousGraph: NonNullable<typeof preparedGraph>
    projectId: string
    coordinator: NativeScheduleCoordinator
    revisions: NativeRevisionSession
    publicationEpoch: number
    snapshot: NonNullable<typeof preparedSnapshot>
    graph: NonNullable<typeof preparedGraph>
    keep: Set<string>
    inputVersion: number
  }

  type NativeBridgeSession = NonNullable<NonNullable<typeof input.bridge>["session"]>

  const stagesInstruments = (session: NativeBridgeSession): session is NativeBridgeSession & ScheduleSession =>
    session.configureInstrumentStates !== undefined

  const createLatencyPublication = (tx: PublicationTransaction, facts: PublicationFacts): PublicationStrategy => {
    const { record, current, sessionAlive, retry, notify, waitForOpportunity, withoutLane, quietPublicationLane, finish, inspect, classifyPublication } = tx
    const { previous, previousGraph, projectId, coordinator, revisions, publicationEpoch } = facts
    let { graph, snapshot, keep: serializedKeepLatencyNodeIds, inputVersion: capturedInputVersion } = facts
    let runtimeRevision = previousGraph.revision
    let resumeSafe = true
    let ready: NativeRevisionReply | undefined
    const capturedGeneration = lifecycleGeneration

    const capture = () => {
      const frozen = captureLatencyInputs()
      graph = frozen.graph
      snapshot = frozen.snapshot
      serializedKeepLatencyNodeIds = frozen.keep
      record.refresh(publicationContent(graph, snapshot, frozen.ledger, captureInstrumentIncarnations(snapshot)))

      return frozen.sequence
    }

    let includedOrder = capture()
    let initialPreparation = true

    const resume = () => {
      if (sessionAlive() && resumeSafe && coordinator === scheduleCoordinator)
        coordinator.resumeGraphPublication(runtimeRevision)
    }

    const prepareBank = async () => {
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
        tx.binding = { projectId, revision: reply.revision.requestedRevision, hostGeneration: reply.hostGeneration }
        tx.preparedRevision = tx.binding.revision
      }

      return reply
    }

    tx.adoptPublication = (proof, acknowledgedEpoch) => {
      if (!proof.ok || !ready?.ok || !tx.binding || !sessionAlive() || capturedGeneration !== lifecycleGeneration
        || proof.hostPid !== ready.hostPid || proof.hostGeneration !== ready.hostGeneration
        || proof.revision.activeRevision !== tx.binding.revision
        || (proof.revision.transportEpoch !== undefined
          && proof.revision.transportEpoch !== (acknowledgedEpoch ?? publicationEpoch))) return false
      runtimeRevision = tx.binding.revision
      resumeSafe = true
      preparedGraph = { ...graph, revision: runtimeRevision }
      processorState.published(runtimeRevision)

      if (JSON.stringify(snapshot.nativeExternalAttachmentPlan) !== JSON.stringify(previous.nativeExternalAttachmentPlan))
        preparedSnapshot = { ...snapshot, revision: preparedSnapshot?.revision ?? snapshot.revision }
      preparedKeepLatencyNodeIds = serializedKeepLatencyNodeIds
      observation.setMeterRevision(runtimeRevision)
      const previousStates = new Map(previousGraph.nodes.flatMap(node => node.processorOrder.map(processor => [processor.id, processor])))

      const restated = new Set(graph.nodes.flatMap(node => node.processorOrder.flatMap(processor =>
        sameBytes(previousStates.get(processor.id)?.state ?? new Uint8Array(), processor.state) ? [] : [processor.id])))

      const reconciles = processorState.adopted(targetKinds(graph, snapshot), new Set(), restated,
        includedOrder, desired => statePatchMatchesCurrentProcessor(desired.target.instanceId, desired.content.state), record.content)

      if (acknowledgedEpoch === undefined) coordinator.resumeGraphPublication(runtimeRevision)
      advanceScheduleSettledEpoch()
      retirement.hold(proof, projectId)
      tx.resourcesPromoted = true
      tx.binding = undefined
      executeReconcile(reconciles)

      return true
    }

    return {
      proofMismatch: "Native latency publication proof does not match its capture.",
      releasesLane: true,
      publishReplyProves: true,
      prepare: async () => {
        ready = await prepareBank()
        let observed = tx.sequence

        while (ready.ok && ready.revision.status === "publish-pending" && !tx.binding) {
          resume()
          await waitForOpportunity(observed)
          observed = tx.sequence
          const admission = await inspect({ projectId, revision: ready.revision.requestedRevision, hostGeneration: ready.hostGeneration })

          if (admission?.ok && (admission.hostPid !== ready.hostPid || admission.hostGeneration !== ready.hostGeneration)) {
            invalidateNativeOwnership(true, true)

            return { record }
          }

          if (!admission?.ok || admission.revision.status === "publish-pending") continue
          retry()
          includedOrder = capture()
          ready = await prepareBank()
        }

        if (!ready.ok) throw new PublicationFailure(ready.error, ready.kind)
        processorState.observeRetirement(ready)

        if (ready.revision.status !== "prepared" || ready.revision.continuity !== "accepted") {
          if (ready.revision.diagnosticCode === nativeKeepLatencyDivergentMixedBusDiagnostic)
            throw new NativeLatencyUnsupportedError("Keep Latency can't be used here: this bus mixes monitored and other tracks, then splits to outputs with different latency. Route them through separate buses.")
          throw new PublicationFailure(`Native latency prepare was ${ready.revision.status}/${ready.revision.continuity}.`, "refused")
        }

        if (!tx.binding) throw new Error("Native latency prepare did not create the requested bank.")
        resumeSafe = false
        processorState.prepared(tx.binding.revision, scheduledRetention(previousGraph, graph,
          { before: previous, after: snapshot }, new Set()))
        let submittedProgress = -1

        const step = async (reply: NativeRevisionReply): Promise<PublicationPass> => {
          let status = reply
          classifyPublication(status)

          if (tx.failure) throw new Error("Native latency publication failed.")

          if (status.ok && status.revision.status === "prepared" && tx.progressVersion !== submittedProgress) {
            if (tx.publishSent) {
              retry()

              const changed = processorState.hasQueuedPatch()
                || serializedKeepLatencyNodeIds.size !== desiredKeepLatencyNodeIds.size
                || [...serializedKeepLatencyNodeIds].some(id => !desiredKeepLatencyNodeIds.has(id))
                || latencyInputVersion !== capturedInputVersion

              if (changed) {
                const bound = tx.binding

                if (!bound) throw new Error("Missing latency binding.")
                const rollback = await withoutLane(revisions.rollback(bound)).catch(() => undefined)

                if (!rollback?.ok || rollback.revision.status !== "rolled-back") {
                  tx.detached = true

                  return { status, next: "ended" }
                }

                processorState.unprepared(bound.revision)
                tx.binding = undefined
                resumeSafe = true
                resume()
                includedOrder = capture()
                capturedInputVersion = latencyInputVersion
                ready = await prepareBank()
                tx.checked(ready)

                if (!tx.binding || ready.revision.status !== "prepared") throw new Error("Native latency recapture was not prepared.")
                status = ready
                resumeSafe = false
              }
            }

            submittedProgress = tx.progressVersion
            tx.publishSent = true
            record.held()
            const request = tx.binding

            if (!request) throw new Error("Missing latency binding.")
            tx.publishCompletion = revisions.publish(request).then(reply => {
              if (!sessionAlive()) return
              tx.publishReply = reply
              notify()
            }, () => { if (sessionAlive()) notify() })
          }

          if (tx.failure && status.ok && status.revision.status !== "publish-pending" && status.revision.status !== "prepared")
            throw new Error("Native latency publication failed.")

          return { status, next: "wait" }
        }

        const hostChanged = (status: NativeRevisionReply) => {
          if (!(status.ok && ready?.ok && (status.hostPid !== ready.hostPid || status.hostGeneration !== ready.hostGeneration))) return false
          invalidateNativeOwnership(true, true)

          return true
        }

        return { status: ready, hostChanged, step }
      },
      fail: (error) => {
        if (!current() || error instanceof NativePlaybackAbortError) record.cancel()

        const outcome: AdoptionOutcome = {
          status: "failed", reason: error instanceof Error ? error.message : "Native latency publication failed.",
          ...(error instanceof PublicationFailure ? { failureKind: { kind: error.kind, message: error.message } }
            : error instanceof NativeLatencyUnsupportedError ? { failureKind: { kind: "latency-unsupported", message: error.message } } : {}),
        }

        if (error instanceof PublicationFailure && error.kind === "refused")
          tx.failure = { outcome, reason: "stage-failed" }

        return () => finish(outcome,
          record.cancelled ? "cancelled" : error instanceof PublicationFailure && error.kind === "unavailable" ? "lost" : tx.failure ? "failed" : "uncertain", tx.failure?.reason)
      },
      onDetached: () => { resumeSafe = false },
      finalize: () => { resume();

 return undefined },
    }
  }

  const scheduleHost: ScheduleHost = {
    input,
    processorState,
    get active() { return active },
    get transportEpoch() { return transportEpoch },
    get nextTransportTransitionId() { return nextTransportTransitionId },
    get sampleRate() { return sampleRate },
    get maximumFramesPerBlock() { return maximumFramesPerBlock },
    get scheduleSettledEpoch() { return scheduleSettledEpoch },
    get nativeAdmissionCapacityGeneration() { return nativeAdmissionCapacityGeneration },
    get nativeLatencyCompletionGeneration() { return nativeLatencyCompletionGeneration },
    get latestScheduleProgress() { return latestScheduleProgress },
    get preparedHostIdentity() { return preparedHostIdentity },
    get nativeTimelinePageManager() { return nativeTimelinePageManager },
    get instrumentBudget() { return instrumentBudget },
    get preparedStretchRepository() { return preparedStretchRepository },
    residentInstrumentBytesCap,
    instrumentAssets,
    instrumentReleaseAcks,
    sessionResourceIds,
    scheduleCandidates,
    pendingStretchCandidates,
    get installedAssets() { return installedAssets }, set installedAssets(value) { installedAssets = value },
    get installedAssetIds() { return installedAssetIds }, set installedAssetIds(value) { installedAssetIds = value },
    get installedAssetSourceKeys() { return installedAssetSourceKeys }, set installedAssetSourceKeys(value) { installedAssetSourceKeys = value },
    get nextSessionAssetId() { return nextSessionAssetId }, set nextSessionAssetId(value) { nextSessionAssetId = value },
    get preparedStretchAssetsForSession() { return preparedStretchAssetsForSession }, set preparedStretchAssetsForSession(value) { preparedStretchAssetsForSession = value },
    get preparedStretchLeaseSession() { return preparedStretchLeaseSession }, set preparedStretchLeaseSession(value) { preparedStretchLeaseSession = value },
    get nativePcmChunkDescriptorsForSession() { return nativePcmChunkDescriptorsForSession }, set nativePcmChunkDescriptorsForSession(value) { nativePcmChunkDescriptorsForSession = value },
    get preparedInstrumentTrackIds() { return preparedInstrumentTrackIds }, set preparedInstrumentTrackIds(value) { preparedInstrumentTrackIds = value },
    get preparedSnapshot() { return preparedSnapshot }, set preparedSnapshot(value) { preparedSnapshot = value },
    get preparedGraph() { return preparedGraph }, set preparedGraph(value) { preparedGraph = value },
    get preparedKeepLatencyNodeIds() { return preparedKeepLatencyNodeIds }, set preparedKeepLatencyNodeIds(value) { preparedKeepLatencyNodeIds = value },
    get structuralGraphGeneration() { return structuralGraphGeneration }, set structuralGraphGeneration(value) { structuralGraphGeneration = value },
    get scheduleCoordinator() { return scheduleCoordinator }, set scheduleCoordinator(value) { scheduleCoordinator = value },
    get pausedPriming() { return pausedPriming }, set pausedPriming(value) { pausedPriming = value },
    get prepareAdmissionWake() { return prepareAdmissionWake }, set prepareAdmissionWake(value) { prepareAdmissionWake = value },
    isScheduleCandidateValid,
    advanceScheduleSettledEpoch,
    resourceKey,
    createInstrumentScope,
    releaseInstrumentScope,
    holdInstrumentAssets,
    resolveTimelineDescriptor,
    prepareMappedResources,
    nativeObservationMaps: observation.maps,
    promoteNativeObservationMaps: observation.promote,
    holdRetirement: retirement.hold,
    reportStopped,
    executeReconcile,
    reprimePausedAdoption: () => reprimePausedAdoption(),
    statePatchMatchesCurrentProcessor: (instanceId, state) => statePatchMatchesCurrentProcessor(instanceId, state),
  }

  const executePublication = async (payload: PublicationPayload,
    relinquish: (record: NonNullable<ReturnType<typeof processorState.publication>>, register: (resume: () => void) => void) => Promise<void>,
  ) => {
      const candidate = payload.kind === "schedule" ? payload.candidate : undefined
      const attempt = payload.kind === "schedule" ? payload.attempt : undefined
      input.observer?.adoption?.(attempt?.intent.key)?.("lane-admitted")
      const intent = payload.kind === "schedule" ? payload.intent : stagedTransportIntent

      const abandonCandidate = async () => {
        await candidate?.dispose()

        return { outcome: { status: "superseded" } } satisfies { outcome: AdoptionOutcome }
      }

      // A candidate compiled against a session that has since moved takes no receipts: the adoption compiles again.
      if (intent !== stagedTransportIntent || (candidate && !isScheduleCandidateValid(candidate))) return abandonCandidate()

      if (!candidate && latencyInputsApplied()) return { outcome: { status: "unchanged" } } satisfies { outcome: AdoptionOutcome }
      const session = input.bridge?.session
      const revisions = session?.revisions
      const coordinator = scheduleCoordinator
      const previous = preparedSnapshot
      const previousGraph = preparedGraph
      const projectId = preparedProjectId

      if (!prepared || !coordinator || !previous || !previousGraph || !projectId) return abandonCandidate()

      if (!session || !revisions || !stagesInstruments(session)) return abandonCandidate()
      // A stopped transport never reaches a seam frame, so a paused edit publishes with seam 0, which native applies at
      // its next callback block. No window can be staged for an unpublished bank, so the schedule is primed afterwards.
      const paused = candidate !== undefined && !active
      const generation = lifecycleGeneration
      const projectGeneration = resolveProjectGeneration()
      const publicationEpoch = transportEpoch
      const merged = candidate ? rebaseScheduleCandidate(candidate) : captureLatencyInputs()
      const snapshot = candidate?.snapshot ?? previous
      const graph = structuredClone(merged.graph)
      const keep = new Set(desiredKeepLatencyNodeIds)

      const record = processorState.capturePublication(attempt,
        publicationContent(graph, snapshot, merged.ledger, candidate?.instrumentIncarnations))

      const tx: PublicationTransaction = createPublicationTransaction({
        record, attempt, candidate, revisions, coordinator, previousRevision: previousGraph.revision, paused, processorState,
        current: () => generation === lifecycleGeneration && projectGeneration === resolveProjectGeneration()
          && projectId === input.getProjectId?.() && coordinator === scheduleCoordinator && prepared,
        // Epoch coordinators increment nativeSessionGeneration. Only lifecycle invalidation
        // ends this session; renderer generation changes still owe proof for a sent bank.
        owned: () => generation === lifecycleGeneration && prepared && !hostLoss.isLost()
          && preparedProjectId === projectId,
        transportEpoch: () => transportEpoch,
        runNextStatePatch: statePatches.runNext,
        queueTransition: queuePreparedTransportTransition,
        releaseInstrumentScope,
        logFailedAdoption,
      }, relinquish)

      return runPublication(tx, candidate
        ? createSchedulePublication(tx, {
          candidate, attempt, session, revisions, coordinator, previous, previousGraph, snapshot, graph, keep, projectId,
          publicationEpoch, paused, mergedSequence: merged.sequence,
          createMappedAsset: (asset, mapping, preparedStretchArtifactId, mark) =>
            createMappedAsset(session, asset, mapping, preparedStretchArtifactId, undefined, mark),
        }, scheduleHost)
        : createLatencyPublication(tx, {
          previous, previousGraph, projectId, coordinator, revisions, publicationEpoch, snapshot, graph, keep,
          inputVersion: latencyInputVersion,
        }))
  }

  type AdoptionRun = { outcome: AdoptionOutcome; content?: string; transport?: LivePlaybackTransport }

  const superseded: AdoptionRun = { outcome: { status: "superseded" } }

  // A paused edit was published with seam 0 and no window. A new epoch at the same frame primes the schedule of the
  // published bank, and its transport command carries the tempo and loop the edit changed.
  const reprimePausedAdoption = async () => {
    try {
      // Like a loop change, the transition follows a publication still in flight instead of moving the epoch under it.
      const publication = processorState.publication()

      if (publication) await publication.terminal
      await queuePreparedTransportTransition(async () => {
        if (!prepared || active) return
        await transitionPreparedTransport(currentPositionSec() ?? transportFrame / sampleRate, false)
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Native playback could not apply a paused edit."

      // Only a host that reports the session gone ends it. Otherwise the edit is already the session's published graph and
      // every transport transition, a Play included, primes it again.
      if (hostLoss.isLost()) {
        reportStopped(reason)
        await disposeNativeSession(undefined, "native-paused-adoption-failure")

        return
      }

      console.warn("[native-live-edit] paused adoption could not be primed; the session stays and the next transport change retries", { reason })
    }
  }

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
      const preparation = reusable ?? await prepareScheduleRevision({ ...intent.context, mark: input.observer?.adoption?.(intent.key) })

      if (preparation.status === "retry") return preparation.transport ? { ...superseded, transport: preparation.transport } : superseded

      if (preparation.status === "failed") return { outcome: { status: "failed", reason: preparation.reason } }

      // A limitation settles the intent without the refusal the UD 8 retry reopens.
      if (preparation.status === "unsupported") {
        console.warn("[native-live-edit] adoption not carried by the native graph yet; the playing graph is unchanged", { reason: preparation.reason })

        return { outcome: { status: "unsupported", reason: preparation.reason } }
      }

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

      // A Play resuming the prepared session settles first: the edit then lands on the playing session it left. From here
      // to the registration below nothing awaits, so a Play either is seen here or sees the registration.
      if (prepared && !active && pendingStart && !resumeAdoptionPending) {
        await Promise.race([pendingStart.then(() => undefined, () => undefined), resumeAdoptionWake.promise])
        continue
      }

      attempt.fields = adoptionFields()
      const transportIntent = stagedTransportIntent
      const run = await executeAdoption(attempt)
      // A publication a pause or seek cancelled ends the attempt; one a Play's transport move cancelled held nothing,
      // so the intent runs again in the new epoch.
      const endedByDrop = !!attempt.publication && transportIntent !== stagedTransportIntent

      if (run.transport && !mismatched) {
        loop = run.transport
        mismatched = true
      } else if (run.outcome.status !== "superseded" || endedByDrop || attempt.fields.epoch === transportEpoch || !processorState.isNewest(attempt))
        return run
    }
  }

  const runAdoptions = async (first: AdoptionStart<ScheduleRevisionCandidate>) => {
    for (let start: AdoptionStart<ScheduleRevisionCandidate> | undefined = first; start;) {
      disposeKept(start.dispose)
      const { outcome, content } = await runAdoption(start.attempt)
      processorState.settleAdoption(start.attempt, outcome, content)
      void statePatches.drain()

      // An edit adopted while no transport runs has no window for its bank: the priming its publication started
      // settles before the next adoption.
      if (outcome.status === "adopted") await pausedPriming
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

    // The worker's trust gate refused the launch record: not the plug-in's fault, so the existing trust flow (a rescan
    // after the acknowledgement) resolves it and the device does not show a crash. The mixer keeps playing.
    if (event.kind === "launch-not-trusted") return reportStopped(nativeVst3LaunchAuthorizationRequiredMessage, { retainPlayback: true })
    void (async () => {
      try {
        const result = await publishAttachmentLatency({ instanceId: event.instanceId, generation, latencyFrames: event.latencyFrames })

        if (!result.handled) console.warn("[native-vst3] latency publication not applied", { reason: result.reason })
      } catch (error) {
        console.error("[native-vst3] latency publication failed", { error: error instanceof Error ? error.message : "unknown" })
      }
    })()
  }

  const currentPositionSec = () => {
    if (sampleRate <= 0) return undefined

    const loop = preparedSnapshot && loopAppliesAtTransportPosition
      ? loopFramesForTransport(preparedSnapshot.transport, sampleRate)
      : undefined

    return arrangementFrameForLoop(transportFrame, loop) / sampleRate
  }

  return {
    schedulerDiagnostics: () => scheduleCoordinator?.refillDiagnostics(),
    getPendingStart: () => pendingStart
      ? { mode: pendingStartMode, promise: pendingStart }
      : undefined,
    cancelPendingStart,
    abandonResume,
    resetNativeHostConnectionLoss: hostLoss.reset,
    start,
    pause,
    dispose,
    destroy,
    isActive: () => active,
    isAvailable: () => input.bridge !== undefined && !hostLoss.isLost(),
    canProcessLiveMidi: () => livePreviewActive,
    hasLiveMidiTails: liveMidi.hasTails,
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
    startRecording: nativeRecording.start,
    stopRecording: nativeRecording.stop,
    cancelRecording: nativeRecording.cancel,
    isRecording: nativeRecording.isRecording,
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
    witness: {
      // Read-only view of the adoption record for acceptance attribution.
      adoption: processorState.adoptionWitness,
      // The facts a refusal answers to, as they stand now, to show none has moved since it.
      adoptionFields,
      // Compiled schedule candidates not yet published or disposed: a candidate that outlives its attempt keeps its stretched assets.
      liveScheduleCandidates: () => scheduleCandidates.size,
    },
    startLiveMidiNote: liveMidi.startNote,
    releaseLiveMidiNote: liveMidi.releaseNote,
    subscribeNativeLiveMidiReset: liveMidi.subscribeReset,
    subscribeTrackMeters: observation.subscribeTrackMeters,
    subscribeMasterMeter: observation.subscribeMasterMeter,
    subscribeSpectrum: observation.subscribeSpectrum,
  }
}
