import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { SampledInstrumentRegionBudgetScope } from "~/lib/sampled-instrument-region-budget"
import type { PlaybackAcceptanceObserver } from "./acceptance-observer"
import type {
  AdoptionAttempt,
  AdoptionOutcome,
  createNativeProcessorStateOwner,
  InstalledContent,
  ProcessorDesired,
  Publication,
} from "./native-processor-state-owner"
import {
  createPublicationTransaction,
  runPublication,
  type PublicationStrategy,
  type PublicationTransaction,
} from "./native-publication-transaction"
import {
  createSchedulePublication,
  type ScheduleHost,
  type ScheduleRevisionCandidate,
  type ScheduleSession,
} from "./native-schedule-publication"
import type { NativeScheduleCoordinator } from "./native-schedule-coordinator"

export type PublicationPayload =
  | { kind: "schedule"; candidate: ScheduleRevisionCandidate; intent: number; attempt: AdoptionAttempt }
  | { kind: "latency" }

// What one publication captured of the prepared session, which both kinds of publication start from.
export type PublicationFacts = {
  previous: LivePlaybackSnapshot
  previousGraph: AudioCoreGraphSnapshot
  projectId: string
  coordinator: NativeScheduleCoordinator
  revisions: NativeRevisionSession
  publicationEpoch: number
  snapshot: LivePlaybackSnapshot
  graph: AudioCoreGraphSnapshot
  keep: Set<string>
  inputVersion: number
}

type LatencyCapture = {
  graph: AudioCoreGraphSnapshot
  sequence: number
  ledger: ReadonlyMap<string, ProcessorDesired>
}

// The playback controller's capabilities one publication attempt uses. State members are read live, at the moment the
// attempt asks.
type ExecutorSession = { revisions?: NativeRevisionSession; configureInstrumentStates?: unknown }

export type PublicationExecutorHost<Session extends ExecutorSession> = {
  input: {
    bridge?: { session: Session }
    observer?: { adoption?: PlaybackAcceptanceObserver["adoption"] }
    getProjectId?: () => string | undefined
  }
  processorState: ReturnType<typeof createNativeProcessorStateOwner<ScheduleRevisionCandidate>>
  scheduleHost: ScheduleHost
  readonly stagedTransportIntent: number
  readonly prepared: boolean
  readonly active: boolean
  readonly lifecycleGeneration: number
  readonly transportEpoch: number
  readonly scheduleCoordinator: NativeScheduleCoordinator | undefined
  readonly preparedSnapshot: LivePlaybackSnapshot | undefined
  readonly preparedGraph: AudioCoreGraphSnapshot | undefined
  readonly preparedProjectId: string | undefined
  readonly projectGeneration: number
  readonly hostLost: boolean
  readonly desiredKeepLatencyNodeIds: ReadonlySet<string>
  readonly latencyInputVersion: number
  isScheduleCandidateValid: (candidate: ScheduleRevisionCandidate) => boolean
  latencyInputsApplied: () => boolean
  rebaseScheduleCandidate: (candidate: ScheduleRevisionCandidate) => LatencyCapture
  captureLatencyInputs: () => LatencyCapture
  publicationContent: (
    graph: AudioCoreGraphSnapshot,
    snapshot: LivePlaybackSnapshot,
    ledger: ReadonlyMap<string, ProcessorDesired>,
    incarnations?: ReadonlyMap<string, number>,
  ) => Map<string, InstalledContent>
  runNextStatePatch: () => Promise<boolean>
  queueTransition: <Value>(task: () => Promise<Value>) => Promise<Value>
  releaseInstrumentScope: (scope: SampledInstrumentRegionBudgetScope | undefined) => void
  logFailedAdoption: (reason: string) => void
  createMappedAsset: (
    session: Session & ScheduleSession,
    asset: { frameCount: number; sampleRateHz: number; channelCount: number },
    mapping: { sessionAssetId: number },
    preparedStretchArtifactId: string | undefined,
    transactionToken?: string,
    mark?: (name: string) => void,
  ) => Promise<void>
  createLatencyPublication: (tx: PublicationTransaction, facts: PublicationFacts) => PublicationStrategy
}

const stagesInstruments = <Session extends ExecutorSession>(
  session: Session,
): session is Session & ScheduleSession => session.configureInstrumentStates !== undefined

// `relinquish` hands the transport lane back while the publication waits on native, and returns once it is retaken.
export const createPublicationExecutor = <Session extends ExecutorSession>(host: PublicationExecutorHost<Session>) => async (payload: PublicationPayload,
  relinquish: (record: Publication, register: (resume: () => void) => void) => Promise<void>,
) => {
    const candidate = payload.kind === "schedule" ? payload.candidate : undefined
    const attempt = payload.kind === "schedule" ? payload.attempt : undefined
    host.input.observer?.adoption?.(attempt?.intent.key)?.("lane-admitted")
    const intent = payload.kind === "schedule" ? payload.intent : host.stagedTransportIntent

    const abandonCandidate = async () => {
      await candidate?.dispose()

      return { outcome: { status: "superseded" } } satisfies { outcome: AdoptionOutcome }
    }

    // A candidate compiled against a session that has since moved takes no receipts: the adoption compiles again.
    if (intent !== host.stagedTransportIntent || (candidate && !host.isScheduleCandidateValid(candidate))) return abandonCandidate()

    if (!candidate && host.latencyInputsApplied()) return { outcome: { status: "unchanged" } } satisfies { outcome: AdoptionOutcome }
    const session = host.input.bridge?.session
    const revisions = session?.revisions
    const coordinator = host.scheduleCoordinator
    const previous = host.preparedSnapshot
    const previousGraph = host.preparedGraph
    const projectId = host.preparedProjectId

    if (!host.prepared || !coordinator || !previous || !previousGraph || !projectId) return abandonCandidate()

    if (!session || !revisions || !stagesInstruments(session)) return abandonCandidate()
    // A stopped transport never reaches a seam frame, so a paused edit publishes with seam 0, which native applies at
    // its next callback block. No window can be staged for an unpublished bank, so the schedule is primed afterwards.
    const paused = candidate !== undefined && !host.active
    const generation = host.lifecycleGeneration
    const projectGeneration = host.projectGeneration
    const publicationEpoch = host.transportEpoch
    const merged = candidate ? host.rebaseScheduleCandidate(candidate) : host.captureLatencyInputs()
    const snapshot = candidate?.snapshot ?? previous
    const graph = structuredClone(merged.graph)
    const keep = new Set(host.desiredKeepLatencyNodeIds)

    const record = host.processorState.capturePublication(attempt,
      host.publicationContent(graph, snapshot, merged.ledger, candidate?.instrumentIncarnations))

    const tx: PublicationTransaction = createPublicationTransaction({
      record, attempt, candidate, revisions, coordinator, previousRevision: previousGraph.revision, paused, processorState: host.processorState,
      current: () => generation === host.lifecycleGeneration && projectGeneration === host.projectGeneration
        && projectId === host.input.getProjectId?.() && coordinator === host.scheduleCoordinator && host.prepared,
      // Epoch coordinators increment nativeSessionGeneration. Only lifecycle invalidation
      // ends this session; renderer generation changes still owe proof for a sent bank.
      owned: () => generation === host.lifecycleGeneration && host.prepared && !host.hostLost
        && host.preparedProjectId === projectId,
      transportEpoch: () => host.transportEpoch,
      runNextStatePatch: host.runNextStatePatch,
      queueTransition: host.queueTransition,
      releaseInstrumentScope: host.releaseInstrumentScope,
      logFailedAdoption: host.logFailedAdoption,
    }, relinquish)

    return runPublication(tx, candidate
      ? createSchedulePublication(tx, {
        candidate, attempt, session, revisions, coordinator, previous, previousGraph, snapshot, graph, keep, projectId,
        publicationEpoch, paused, mergedSequence: merged.sequence,
        createMappedAsset: (asset, mapping, preparedStretchArtifactId, mark) =>
          host.createMappedAsset(session, asset, mapping, preparedStretchArtifactId, undefined, mark),
      }, host.scheduleHost)
      : host.createLatencyPublication(tx, {
        previous, previousGraph, projectId, coordinator, revisions, publicationEpoch, snapshot, graph, keep,
        inputVersion: host.latencyInputVersion,
      }))
}
