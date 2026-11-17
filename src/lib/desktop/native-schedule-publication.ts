import type { LiveNativeProjection } from "@daw-browser/audio-engine/live-native-projection"
import type {
  NativeHostTransport,
  NativeScheduleProgress,
  NativeSessionAsset,
} from "@daw-browser/audio-engine/native-host-wire"
import { serializeNativeGraph, serializeNativeInstrumentStates } from "@daw-browser/audio-engine/native-host-wire"
import type { NativePcmChunkDescriptor } from "@daw-browser/audio-engine/native-pcm-chunking"
import type { NativePreparedStretchAsset } from "@daw-browser/audio-engine/native-stretch-preparation"
import type { PreparedStretchArtifactRepository } from "@daw-browser/audio-engine/prepared-stretch-store"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import { nativeAudioHostMaximumInstalledAssets } from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeRevisionReply, NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision"
import { encodeNativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import type { AudioPcmSourceDescriptor } from "@daw-browser/shared"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { SampledInstrumentRegionBudget, SampledInstrumentRegionBudgetScope } from "~/lib/sampled-instrument-region-budget"
import type { DesktopBridge } from "~/types/desktop-bridge"
import type { PlaybackAcceptanceObserver } from "./acceptance-observer"
import { NativePlaybackAbortError } from "./native-playback-abort"
import type { NativeInstrumentPreparation } from "./native-instrument-budget-policy"
import type {
  AdoptionAttempt,
  ExecutionRetention,
  createNativeProcessorStateOwner,
  ProcessorReconcile,
} from "./native-processor-state-owner"
import {
  assertReply,
  PublicationFailure,
  type InstrumentAssetHold,
  type PublicationPass,
  type PublicationStrategy,
  type PublicationTransaction,
} from "./native-publication-transaction"
import type { NativeScheduleCoordinator } from "./native-schedule-coordinator"
import { nativeTimelinePageStagingBytes, type NativeTimelinePageManager, type NativeTimelineSource } from "./native-timeline-page-manager"
import { markVstInstanceFailed } from "./vst-instance-failures"

export type ScheduleRevisionCandidate = {
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

type NativeSessionBridge = NonNullable<DesktopBridge["audioHost"]>["session"]
type AudioAssetRef = AudioCoreGraphSnapshot["assets"][number]
type LivePlaybackAsset = LivePlaybackSnapshot["assets"][number]
type LiveClip = LivePlaybackSnapshot["tracks"][number]["clips"][number]
type SessionAssetMappingLike = { sessionAssetId: number }

// The native session calls the staging makes of its own.
export type ScheduleSession = Pick<NativeSessionBridge,
  "installAsset" | "createMappedAsset" | "releaseAsset" | "setTransport" | "coordinateVstAttachments"
> & Required<Pick<NativeSessionBridge, "configureInstrumentStates">>

// What executePublication captured of the prepared session for one schedule publication.
export type ScheduleFacts = {
  candidate: ScheduleRevisionCandidate
  attempt: AdoptionAttempt | undefined
  session: ScheduleSession
  revisions: NativeRevisionSession
  coordinator: NativeScheduleCoordinator
  previous: LivePlaybackSnapshot
  previousGraph: AudioCoreGraphSnapshot
  snapshot: LivePlaybackSnapshot
  graph: AudioCoreGraphSnapshot
  keep: ReadonlySet<string>
  projectId: string
  publicationEpoch: number
  paused: boolean
  mergedSequence: number
  createMappedAsset: (
    asset: { frameCount: number; sampleRateHz: number; channelCount: number },
    mapping: SessionAssetMappingLike,
    preparedStretchArtifactId: string | undefined,
    mark?: (name: string) => void,
  ) => Promise<void>
}

// The playback controller's own state, which a schedule publication reads while it stages and replaces when it is
// published. Members the controller assigns are writable; the rest are read live.
export type ScheduleHost = {
  input: {
    bridge?: { instrumentBudgetPolicy?: NonNullable<DesktopBridge["audioHost"]>["instrumentBudgetPolicy"] }
    onInstrumentPreparation?: (trackIds: readonly string[], status: NativeInstrumentPreparation) => void
    observer?: { adoption?: PlaybackAcceptanceObserver["adoption"] }
  }
  processorState: ReturnType<typeof createNativeProcessorStateOwner<ScheduleRevisionCandidate>>
  readonly active: boolean
  readonly transportEpoch: number
  readonly nextTransportTransitionId: bigint
  readonly sampleRate: number
  readonly maximumFramesPerBlock: number
  readonly scheduleSettledEpoch: number
  readonly nativeAdmissionCapacityGeneration: bigint
  readonly nativeLatencyCompletionGeneration: bigint
  readonly latestScheduleProgress: NativeScheduleProgress | undefined
  readonly preparedHostIdentity: { pid: number; generation: number; configurationGeneration: number } | undefined
  readonly nativeTimelinePageManager: NativeTimelinePageManager | undefined
  readonly instrumentBudget: SampledInstrumentRegionBudget | undefined
  readonly preparedStretchRepository: PreparedStretchArtifactRepository | undefined
  readonly residentInstrumentBytesCap: number
  readonly instrumentAssets: Map<number, InstrumentAssetHold>
  readonly instrumentReleaseAcks: Set<Promise<unknown>>
  readonly sessionResourceIds: Map<string, number>
  readonly scheduleCandidates: Set<ScheduleRevisionCandidate>
  readonly pendingStretchCandidates: Set<() => Promise<void>>
  installedAssets: readonly NativeSessionAsset[]
  installedAssetIds: readonly number[]
  installedAssetSourceKeys: Map<string, string>
  nextSessionAssetId: number
  preparedStretchAssetsForSession: readonly NativePreparedStretchAsset[]
  preparedStretchLeaseSession: (() => Promise<void>) | undefined
  nativePcmChunkDescriptorsForSession: readonly NativePcmChunkDescriptor[]
  preparedInstrumentTrackIds: readonly string[]
  preparedSnapshot: LivePlaybackSnapshot | undefined
  preparedGraph: AudioCoreGraphSnapshot | undefined
  preparedKeepLatencyNodeIds: ReadonlySet<string>
  structuralGraphGeneration: number
  scheduleCoordinator: NativeScheduleCoordinator | undefined
  pausedPriming: Promise<void> | undefined
  prepareAdmissionWake: (() => void) | undefined
  isScheduleCandidateValid: (candidate: ScheduleRevisionCandidate) => boolean
  advanceScheduleSettledEpoch: () => void
  resourceKey: (asset: AudioAssetRef, source: LivePlaybackAsset | undefined) => string
  createInstrumentScope: (scopeName: string) => SampledInstrumentRegionBudgetScope
  releaseInstrumentScope: (scope: SampledInstrumentRegionBudgetScope | undefined) => void
  holdInstrumentAssets: (
    assets: readonly { asset: AudioAssetRef; sourceAssetKey: string }[],
    sources: readonly { sourceAssetKey: string; buffer: AudioBuffer }[],
    mappings: ReadonlyMap<string, NativeSessionAsset>,
    evictResident?: () => Promise<boolean>,
  ) => Promise<Map<number, InstrumentAssetHold>>
  resolveTimelineDescriptor: (
    sourceAssetKey: string,
    asset: AudioAssetRef,
    snapshotAssets: ReadonlyMap<string, LivePlaybackAsset>,
    clips: ReadonlyMap<string, LiveClip>,
    regionalBuffer: AudioBuffer | undefined,
    signal?: AbortSignal,
  ) => Promise<AudioPcmSourceDescriptor>
  prepareMappedResources: (
    resources: readonly { source: NativeTimelineSource; create: () => Promise<void> }[],
    pageManager: NativeTimelinePageManager,
    fullRegionRanges: readonly { sourceAssetKey: string; startFrame: number; endFrame: number }[],
    signal?: AbortSignal,
    registerSources?: boolean,
    mark?: (name: string) => void,
  ) => Promise<void>
  nativeObservationMaps: (tracks: readonly { id: string }[]) => { meters: Map<bigint, string>; spectrum: Map<string, bigint> }
  promoteNativeObservationMaps: (revision: number, candidate: { meters: Map<bigint, string>; spectrum: Map<string, bigint> }) => void
  holdRetirement: (proof: Extract<NativeRevisionReply, { ok: true }>, projectId: string, release?: () => Promise<void>) => void
  reportStopped: (message: string, options?: { retainPlayback: true }) => void
  executeReconcile: (reconcile: readonly ProcessorReconcile[]) => void
  reprimePausedAdoption: () => Promise<void>
  sameBytes: (left: Uint8Array, right: Uint8Array) => boolean
  statePatchMatchesCurrentProcessor: (instanceId: string, state: Uint8Array) => boolean
  synthNodes: (snapshot: LivePlaybackSnapshot | undefined) => Map<string, string>
  targetKinds: (graph: AudioCoreGraphSnapshot, snapshot: LivePlaybackSnapshot | undefined) => Map<string, number>
  sampledInstrumentTrackIds: (snapshot: LivePlaybackSnapshot) => readonly string[]
  scheduledRetention: (
    previous: AudioCoreGraphSnapshot,
    next: AudioCoreGraphSnapshot,
    synths: { before: LivePlaybackSnapshot | undefined; after: LivePlaybackSnapshot | undefined },
    configuredNodes: ReadonlySet<string>,
  ) => ExecutionRetention
  nativeTransportFor: (snapshot: LivePlaybackSnapshot, epoch: number, running: boolean, frame: number, transitionId: bigint) => NativeHostTransport
  planarBytes: (planes: readonly Float32Array[]) => Uint8Array
  validateInstrumentAssetBudget: (
    assets: readonly AudioAssetRef[],
    instruments: readonly NonNullable<AudioCoreGraphSnapshot["nodes"][number]["instrument"]>[],
    maximumBytes: number,
  ) => void
  attachmentsChanged: (previous: LivePlaybackSnapshot, snapshot: LivePlaybackSnapshot, maximumFrames: number) => boolean
}

export const createSchedulePublication = (tx: PublicationTransaction, facts: ScheduleFacts, host: ScheduleHost): PublicationStrategy => {
  const { record, current, sessionAlive, retry, notify, waitForOpportunity, withoutLane, quietPublicationLane, finish, inspect, classifyPublication, disposePublication } = tx
  const { candidate, attempt, session, mergedSequence, previous, previousGraph, projectId, coordinator, revisions, publicationEpoch, paused, snapshot, graph, keep: serializedKeepLatencyNodeIds } = facts
  const publicationAbort = tx.abort
  const pageManager = host.nativeTimelinePageManager
  let removedAssetIds: readonly number[] = []
  // The renderer's bound on how old a prepare reply's progress is: the request's send to the reply's receipt. It also spans the
  // host's work before it sampled that progress, so it never understates the age.
  let prepareAgeMs = 0
  const prepareRevision = async (request: Parameters<typeof revisions.prepare>[0]) => {
    const sentAt = performance.now()
    const reply = await withoutLane(revisions.prepare(request))
    prepareAgeMs = performance.now() - sentAt
    return reply
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
  const boundLeadBlocks = () => Math.max(2, Math.ceil(0.025 * host.sampleRate / host.maximumFramesPerBlock))
  const chooseFrame = (progress: bigint, blocks: number) => {
    if (paused) return 0
    const frame = Number(progress) + host.maximumFramesPerBlock * blocks
    if (!Number.isSafeInteger(frame)) throw new Error("Native publication frame exceeds renderer precision.")
    return frame
  }
  const { projection } = candidate
  return {
    proofMismatch: "Native live publication proof does not match the staged bank.",
    releasesLane: false,
    publishReplyProves: false,
    prepare: async () => {
      if (!current() || record.cancelled || !host.isScheduleCandidateValid(candidate))
        return await finish({ status: "superseded" }, "cancelled")
      const candidateObservations = host.nativeObservationMaps(snapshot.tracks)
      const snapshotAssets = new Map(snapshot.assets.map((asset) => [asset.assetId, asset]))
      const previousIds = new Set(host.installedAssets.map((mapping) => mapping.sessionAssetId))
      const assets = projection.assets.map(({ asset, sourceAssetKey }) => {
        const key = host.resourceKey(asset, snapshotAssets.get(sourceAssetKey))
        const sessionAssetId = host.sessionResourceIds.get(key) ?? host.nextSessionAssetId++
        host.sessionResourceIds.set(key, sessionAssetId)
        return { asset, sessionAssetId }
      })
      if (assets.some((asset) => asset.sessionAssetId > 0xffff_ffff)) throw new Error("Native session asset identity capacity exceeded.")
      const mappings = new Map(assets.map((mapping) => [mapping.asset.assetId, mapping]))
      const addedAssets = projection.assets.filter(({ asset }) => {
        const mapping = mappings.get(asset.assetId)
        return mapping && !previousIds.has(mapping.sessionAssetId) && !host.instrumentAssets.has(mapping.sessionAssetId)
      })
      const sourceKeys = new Map(projection.assets.map(({ asset, sourceAssetKey }) => {
        const mapping = mappings.get(asset.assetId)
        const retained = mapping && previousIds.has(mapping.sessionAssetId)
        return [asset.assetId, retained
          ? host.installedAssetSourceKeys.get(asset.assetId) ?? sourceAssetKey
          : `${sourceAssetKey}:native-session:${mapping?.sessionAssetId}`]
      }))
      const nextIds = new Set(assets.map((mapping) => mapping.sessionAssetId))
      const removedAssets = host.installedAssets.filter((mapping) => !nextIds.has(mapping.sessionAssetId))
      removedAssetIds = removedAssets.map((mapping) => mapping.sessionAssetId)
      const releaseSessionAsset = (sessionAssetId: number, hold: InstrumentAssetHold | undefined) => {
        const acknowledged = session.releaseAsset(sessionAssetId).then((reply) => {
          if (reply.ok) host.releaseInstrumentScope(hold?.scope)
          return reply
        })
        host.instrumentReleaseAcks.add(acknowledged)
        const settled = () => { host.instrumentReleaseAcks.delete(acknowledged) }
        acknowledged.then(settled, settled)
        return acknowledged
      }
      // A first swap that does not fit in the sample budget gives up the oldest retired sample first, or waits for the
      // acknowledgement of releases already sent, which credit the budget.
      const retiredResidentIds = () => [...host.instrumentAssets.keys()].filter((id) => !previousIds.has(id) && !nextIds.has(id))
      const releaseResident = async (sessionAssetId: number) => {
        const hold = host.instrumentAssets.get(sessionAssetId)
        host.instrumentAssets.delete(sessionAssetId)
        return (await releaseSessionAsset(sessionAssetId, hold)).ok
      }
      const evictResident = async () => {
        const [oldest] = retiredResidentIds()
        if (oldest !== undefined) return releaseResident(oldest)
        const pending = [...host.instrumentReleaseAcks]
        await Promise.allSettled(pending)
        return pending.length > 0
      }
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
      host.input.observer?.adoption?.(attempt?.intent.key)?.("fence-open")
      if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
      // The host attaches a plug-in this graph adds and starts its worker before the graph that binds it is prepared.
      // A removed one goes in the same plan, with no instance left in it, and is detached once the graph is live.
      let stagedWorkers = false
      if (host.attachmentsChanged(previous, snapshot, host.maximumFramesPerBlock)) {
        const emptied = previous.nativeExternalAttachmentPlan && { ...previous.nativeExternalAttachmentPlan, attachments: [] }
        const plan = snapshot.nativeExternalAttachmentPlan ?? emptied
        const coordinateVstAttachments = session.coordinateVstAttachments
        if (!plan || !coordinateVstAttachments) throw new Error("The native VST3 attachment coordinator is unavailable.")
        stagedWorkers = plan.attachments.length > 0
        const stage = () => awaitPreparation(coordinateVstAttachments({
          projectId, serializedPlan: encodeNativeExternalAttachmentPlan(plan), sampleRateHz: host.sampleRate,
          capturedVstStates: snapshot.nativeExternalAttachmentStates,
          requiredVstStateInstanceIds: snapshot.nativeExternalAttachmentStateRequirements,
        }))
        let staging = await stage()
        let stagingResubmits = 0
        // A refused staging keeps the playing graph and resubmits itself, with no further user edit. The wait is
        // counted in native progress reports (one per rendered window, the same event that wakes a publication), so
        // it needs no timer: min(2^r, 16(r+1)) reports, up to 8 resubmits, then the edit waits for the next opportunity.
        // The count is this staging's own: publication rebases keep their budget.
        while (!staging.ok) {
          // The plug-in's own crash or API error is deterministic and its fault: the device shows it, nothing retries.
          if (staging.failure?.origin === "plugin") {
            if (staging.failure.instanceId) markVstInstanceFailed(staging.failure.instanceId)
            break
          }
          if (stagingResubmits >= 8) {
            console.error("[native-live-edit] defect: VST staging was refused after 8 resubmits; the insertion stays in the project and applies on the next successful publication", { reason: staging.error })
            break
          }
          console.warn(`[native-live-edit] VST staging refused; resubmit ${stagingResubmits + 1} of 8 at a later block boundary`, { reason: staging.error })
          const resumeAt = tx.progressVersion + Math.min(2 ** stagingResubmits, 16 * (stagingResubmits + 1))
          stagingResubmits++
          while (tx.progressVersion < resumeAt) await waitForOpportunity(tx.sequence)
          await quietPublicationLane()
          staging = await stage()
        }
        tx.checked(staging)
      }
      // The host table holds 64 assets, the installed ones, this graph's and the residents. It reclaims a release only
      // while no bank is prepared and after one more render epoch, which a progress report announces and an inspect
      // acts on: the residents that would crowd this graph out are released and reclaimed before the prepare.
      const hostIdentity = host.preparedHostIdentity
      const crowded = new Set([...previousIds, ...nextIds, ...host.instrumentAssets.keys()]).size - nativeAudioHostMaximumInstalledAssets
      const crowding = retiredResidentIds().slice(0, Math.max(0, crowded))
      if (crowding.length > 0 && hostIdentity) {
        const capacity = host.nativeAdmissionCapacityGeneration
        let reported = tx.sequence
        const acknowledged = await Promise.all(crowding.map(releaseResident))
        for (; acknowledged.every(Boolean) && host.nativeAdmissionCapacityGeneration === capacity; reported = tx.sequence) {
          await waitForOpportunity(reported)
          await inspect({ projectId, revision: previousGraph.revision, hostGeneration: hostIdentity.generation }, true)
        }
      }
      // A published bank refuses the host.active window a refill would send; a stopped transport needs no refill.
      if (paused) await coordinator.suspendGraphPublication()
      // Provisional: long enough for the prepare and hydration below. The seam binds late, after them.
      let seam = chooseFrame(BigInt(coordinator.currentFrame()), 16)
      let observed = tx.sequence
      host.input.observer?.adoption?.(attempt?.intent.key)?.("prepare-sent")
      let ready = await prepareRevision({
        projectId, projectRevision: snapshot.revision, bytes: serializeNativeGraph(graph, serializedKeepLatencyNodeIds),
        requestedPublicationFrame: BigInt(seam),
      })
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
        // The host holds the prepare until a staged plug-in's worker is ready, which takes more than eight blocks: that
        // wait ends with the worker (ready or faulted), so it spends no resubmit.
        const workerWait = stagedWorkers && ready.revision.status === "publish-pending"
        if (!workerWait && record.resubmitsSpent) {
          const error = "Native live preparation is waiting for publication ownership."
          throw new Error(error)
        }
        if (ready.revision.status === "publish-pending"
          && (ready.revision.retiredRevision !== 0 || ready.revision.preparedRevision !== 0)) {
          // Prepare's pending reply owns no bank. Resolve admission before
          // spending a retry, then wait on completion/terminal/control facts,
          // not ordinary frames while a latency transition is still running.
          host.prepareAdmissionWake = notify
          try {
            let admission: NativeRevisionReply | undefined
            let inspected = false
            let completion = host.nativeLatencyCompletionGeneration
            let settled = host.scheduleSettledEpoch
            let applied = host.latestScheduleProgress
            do {
              await waitForOpportunity(observed)
              observed = tx.sequence
              if (inspected && completion === host.nativeLatencyCompletionGeneration && settled === host.scheduleSettledEpoch
                && applied?.appliedProcessorSequence === host.latestScheduleProgress?.appliedProcessorSequence
                && applied?.appliedUrgentSequence === host.latestScheduleProgress?.appliedUrgentSequence
                && applied?.appliedTransportTransitionId === host.latestScheduleProgress?.appliedTransportTransitionId) continue
              completion = host.nativeLatencyCompletionGeneration
              settled = host.scheduleSettledEpoch
              applied = host.latestScheduleProgress
              inspected = true
              admission = await inspect({ projectId, revision: ready.revision.requestedRevision,
                hostGeneration: ready.hostGeneration })
              if (admission?.ok && (admission.hostPid !== ready.hostPid || admission.hostGeneration !== ready.hostGeneration))
                throw new NativePlaybackAbortError("ownership-invalidated")
            } while (!admission?.ok || admission.revision.status === "publish-pending")
            tx.checked(admission)
          } finally { host.prepareAdmissionWake = undefined }
          progress = BigInt(coordinator.currentFrame())
        } else if (ready.revision.status === "publish-pending") {
          // With no retained/prepared publication, the pending admission is
          // the ordinary queued-control opportunity, not a latency wait.
          await waitForOpportunity(observed)
          progress = BigInt(coordinator.currentFrame())
        }
        await quietPublicationLane()
        if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
        observed = tx.sequence
        if (!workerWait) retry()
        seam = chooseFrame(progress, 16 * (record.resubmits + 1))
        ready = await prepareRevision({
          projectId, projectRevision: snapshot.revision, bytes: serializeNativeGraph(graph, serializedKeepLatencyNodeIds),
          requestedPublicationFrame: BigInt(seam),
        })
      }
      host.input.observer?.adoption?.(attempt?.intent.key)?.("prepare-reply-received")
      tx.checked(ready)
      host.processorState.observeRetirement(ready)
      if (ready.revision.preparedRevision === ready.revision.requestedRevision) {
        tx.binding = { projectId, revision: ready.revision.requestedRevision, hostGeneration: ready.hostGeneration,
          requestedPublicationFrame: BigInt(seam) }
      }
      if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
      if (ready.revision.status !== "prepared" || ready.revision.continuity !== "accepted") {
        const reason = `Native live prepare was ${ready.revision.status}/${ready.revision.continuity}.`
        // A take bound to a node on the route keeps its routing: that is an expected refusal, not a defect to log.
        const takeLocked = ready.revision.status === "capture-target-locked"
        tx.failure = { outcome: { status: takeLocked ? "blocked" : "failed", reason }, reason: "native-refused" }
        throw new Error(reason)
      }
      if (!tx.binding) throw new Error("Native live prepare did not create the requested bank.")
      tx.preparedRevision = tx.binding.revision
      host.processorState.prepared(tx.binding.revision,
        host.scheduledRetention(previousGraph, graph, { before: previous, after: snapshot },
          new Set(addedInstruments.map(({ nodeId }) => nodeId))))
      // A paused edit takes its tempo from the transport command that re-primes the schedule.
      const transportRestated = !paused && (snapshot.bpm !== previous.bpm
        || JSON.stringify(snapshot.timeSignature) !== JSON.stringify(previous.timeSignature))
      if (transportRestated) {
        // The existing transport command stages context against the prepared
        // bank when it reuses the running transition. Native applies it only
        // after successful publication on that exact callback seam.
        assertReply(await awaitPreparation(session.setTransport(host.nativeTransportFor(snapshot,
          host.transportEpoch, true, 0, host.nextTransportTransitionId))))
      }
      let addedTimelineSources = false
      const hydrationMark = host.input.observer?.adoption?.(attempt?.intent.key)
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
          const policy = host.input.bridge?.instrumentBudgetPolicy
          if (!host.instrumentBudget || !policy) throw new Error("Native sample memory policy is unavailable.")
          host.validateInstrumentAssetBudget(projection.graph.assets, addedInstruments.map(({ state }) => state),
            policy.deviceDecodedBytes)
          tx.stagedMemoryScope = host.createInstrumentScope(`native-stage:${crypto.randomUUID()}`)
          tx.stagedMemoryScope.set("page-staging", nativeTimelinePageStagingBytes, () => undefined)
          tx.stagedHolds = await host.holdInstrumentAssets(addedAssets, instrumentSources, mappings, evictResident)
        }
        for (const { asset, pcm, sourceAssetKey, preparedStretchArtifactId } of addedAssets) {
          publicationAbort.signal.throwIfAborted()
          const mapping = mappings.get(asset.assetId)
          if (!mapping) throw new Error("Native session asset mapping is incomplete.")
          if (pcm) {
            tx.checked(await awaitPreparation(session.installAsset({ sessionAssetId: mapping.sessionAssetId,
              frameCount: asset.frameCount, sampleRateHz: asset.sampleRateHz, channelCount: asset.channelCount,
              planarPcm: host.planarBytes(pcm.planes) })))
            continue
          }
          const pageSourceKey = sourceKeys.get(asset.assetId)
          if (!pageSourceKey) throw new Error("Native page source mapping is incomplete.")
          if (preparedStretchArtifactId) {
            const source: NativeTimelineSource = {
              sourceAssetKey: pageSourceKey, sessionAssetId: mapping.sessionAssetId,
              frameCount: asset.frameCount, sampleRateHz: asset.sampleRateHz, channelCount: asset.channelCount,
              preparedStretchArtifactId, artifactRepository: host.preparedStretchRepository,
            }
            sources.push(source)
            mappedResources.push({ source, create: async () => awaitPreparation(
              facts.createMappedAsset(asset, mapping, preparedStretchArtifactId, hydrationMark)) })
            continue
          }
          const regionalBuffer = regionalSources.get(sourceAssetKey)
          const descriptor = await awaitPreparation(host.resolveTimelineDescriptor(sourceAssetKey, asset,
            snapshotAssets, clips, regionalBuffer, publicationAbort.signal))
          const source = { sourceAssetKey: pageSourceKey, sessionAssetId: mapping.sessionAssetId, frameCount: asset.frameCount,
            sampleRateHz: asset.sampleRateHz, channelCount: asset.channelCount, descriptor,
            immutableAfterPreparation: regionalBuffer !== undefined }
          sources.push(source)
          mappedResources.push({ source, create: async () => awaitPreparation(
            facts.createMappedAsset(asset, mapping, preparedStretchArtifactId, hydrationMark)) })
        }
        publicationAbort.signal.throwIfAborted()
        tx.discardAddedSources = pageManager.addSources(sources)
        addedTimelineSources = sources.length > 0
        await host.prepareMappedResources(mappedResources, pageManager, sources.filter((source) => source.immutableAfterPreparation)
          .map((source) => ({ sourceAssetKey: source.sourceAssetKey, startFrame: 0, endFrame: source.frameCount })),
        publicationAbort.signal, false, hydrationMark)
        host.releaseInstrumentScope(tx.stagedMemoryScope)
        hydrationMark?.("asset-sources-ready")
      }
      publicationAbort.signal.throwIfAborted()
      // The host's prepare settles the instrument flags itself, so a graph that adds none needs no round trip.
      if (addedInstruments.length > 0)
        tx.checked(await awaitPreparation(session.configureInstrumentStates(serializeNativeInstrumentStates(addedInstruments, assets))))
      hydrationMark?.("bind-states-configured")
      if (addedAssets.length > 0) hydrationMark?.("asset-instrument-states-ready")
      // New timeline sources hydrate while a window is staged, which would spend the short bound lead. Page the
      // candidate first on a discarded coordinator, submitting nothing.
      if (addedTimelineSources && !paused) {
        const candidateRevision = ready.revision.requestedRevision
        await awaitPreparation(coordinator.prepareCandidatePages({ ...snapshot, revision: candidateRevision },
          { ...graph, revision: candidateRevision }, coordinator.currentFrame(), seam, { assets, assetSourceKeys: sourceKeys,
            nativePcmChunkDescriptors: projection.nativePcmChunkDescriptors, preparedStretchAssets: candidate.stretchAssets },
          publicationAbort.signal, hydrationMark))
      }
      // Nothing the seam depends on is left to do: rebind it to fresh native progress, before any staging
      // (native resets the still-empty prepared bank). A refused bind keeps the provisional seam, which is safe. The bind
      // spends no resubmit, so the rebase growth and budget start from zero; two attempts bound it. A hydration longer
      // than the provisional lead has native past the seam, which Inspect reports as rebase-required: that seam binds
      // later, to the same lead, instead of publishing at a seam that was already reached.
      // With no await since the prepare reply (the transport restatement, the asset hydration and the states call are the
      // awaits), an inspect would read no fresher progress than that reply carries: the first attempt reads the reply. That holds
      // while the reply is under a block old: the lead then absorbs the age, and a slower reply inspects for fresher progress.
      const replyIsLatest = !transportRestated && addedAssets.length === 0 && addedInstruments.length === 0
        && prepareAgeMs * host.sampleRate < 1000 * host.maximumFramesPerBlock
      for (let attempt = 0; attempt < 2; attempt++) {
        const fresh = attempt === 0 && replyIsLatest ? ready
          : await inspect(tx.binding, true, hydrationMark && (() => hydrationMark("bind-progress-reply")))
        hydrationMark?.("bind-progress-read")
        if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
        if (!fresh?.ok || (fresh.revision.status !== "prepared" && fresh.revision.status !== "rebase-required")
          || fresh.revision.progressFrame === undefined || fresh.revision.requestedPublicationFrame !== BigInt(seam)) break
        if (fresh.revision.transportEpoch !== host.transportEpoch) throw new NativePlaybackAbortError("ownership-invalidated")
        const bound = chooseFrame(fresh.revision.progressFrame, boundLeadBlocks())
        if (bound === seam) break
        const rebind = { ...tx.binding, requestedPublicationFrame: BigInt(bound) }
        hydrationMark?.("bind-request-sent")
        const rebound = await withoutLane(revisions.publish(rebind))
        if (!rebound.ok) classifyPublication(rebound)
        tx.checked(rebound)
        if (rebound.revision.status === "prepared") { seam = bound; tx.binding = rebind; break }
      }
      let fill = !paused
      let submittedProgress = -1
      tx.adoptPublication = (proof, acknowledgedEpoch) => {
        const afterTransport = acknowledgedEpoch !== undefined
        if (!proof.ok || !tx.binding || !sessionAlive() || proof.hostGeneration !== ready.hostGeneration
          || proof.hostPid !== ready.hostPid
          || proof.revision.transportEpoch !== (acknowledgedEpoch ?? publicationEpoch)
          || (!paused && !tx.staged?.activateRevision(proof.revision))) return false
        if (paused) coordinator.dispose()
        else if (afterTransport) tx.staged?.dispose()
        else {
          coordinator.dispose()
          host.scheduleCoordinator = tx.staged
          tx.staged?.install()
        }
        tx.staged = undefined
        host.preparedGraph = { ...graph, revision: tx.binding.revision }
        host.structuralGraphGeneration++
        host.processorState.published(tx.binding.revision)
        host.scheduleCandidates.delete(candidate)
        const synthInstances = new Map([...host.synthNodes(snapshot)].map(([instanceId, nodeId]) => [nodeId, instanceId]))
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
          return was?.kindId === processor.kindId && !host.sameBytes(was.state, processor.state) ? [processor.id] : []
        })))
        const reconcile = host.processorState.adopted(
          host.targetKinds(graph, snapshot),
          reconfiguredTargets,
          restatedTargets,
          mergedSequence,
          (included) => host.statePatchMatchesCurrentProcessor(included.target.instanceId, included.content.state),
          record.content,
        )
        host.preparedSnapshot = snapshot
        host.preparedInstrumentTrackIds = host.sampledInstrumentTrackIds(snapshot)
        const predecessorStretchLease = host.preparedStretchLeaseSession
        host.preparedStretchAssetsForSession = candidate.stretchAssets
        host.preparedStretchLeaseSession = candidate.dispose
        host.pendingStretchCandidates.delete(candidate.dispose)
        for (const [id, hold] of tx.stagedHolds) host.instrumentAssets.set(id, hold)
        // The installed samples are the newest, a returning resident among them.
        for (const id of nextIds) {
          const hold = host.instrumentAssets.get(id)
          if (!hold) continue
          host.instrumentAssets.delete(id)
          host.instrumentAssets.set(id, hold)
        }
        const released = new Map<number, InstrumentAssetHold | undefined>(
          removedAssetIds.filter((id) => !host.instrumentAssets.has(id)).map((id) => [id, undefined]))
        // A retiree above the cap is never admitted, so it cannot push the smaller residents out.
        const retired = [...host.instrumentAssets].filter(([id]) => !nextIds.has(id))
        let residentBytes = 0
        let residentCount = 0
        const residents = retired.filter(([id, hold]) => {
          if (hold.bytes > host.residentInstrumentBytesCap) { released.set(id, hold); return false }
          residentBytes += hold.bytes
          residentCount += 1
          return true
        })
        // The host table holds 64 assets; resident samples keep the installed ones within half of it.
        for (const [id, hold] of residents) {
          if (residentBytes <= host.residentInstrumentBytesCap
            && nextIds.size + residentCount <= nativeAudioHostMaximumInstalledAssets / 2) break
          released.set(id, hold)
          residentBytes -= hold.bytes
          residentCount -= 1
        }
        for (const id of released.keys()) host.instrumentAssets.delete(id)
        host.installedAssets = assets
        host.installedAssetIds = [...new Set([...nextIds, ...host.instrumentAssets.keys()])]
        host.installedAssetSourceKeys = sourceKeys
        host.nativePcmChunkDescriptorsForSession = projection.nativePcmChunkDescriptors
        tx.resourcesPromoted = true
        host.advanceScheduleSettledEpoch()
        // Release ACK registers deferred collection, not reusable IDs or a
        // proof that queued sources/fading voices have finished reading.
        for (const [sessionAssetId, hold] of released) {
          void releaseSessionAsset(sessionAssetId, hold).then((reply) => {
            if (!reply.ok) host.reportStopped(reply.error, { retainPlayback: true })
          }, () => host.reportStopped("Native deferred asset release failed.", { retainPlayback: true }))
        }
        host.preparedKeepLatencyNodeIds = serializedKeepLatencyNodeIds
        host.promoteNativeObservationMaps(tx.binding.revision, candidateObservations)
        host.holdRetirement(proof, projectId, async () => {
          await pageManager?.removeSources(removedAssetIds)
          await predecessorStretchLease?.()
        })
        tx.binding = undefined
        host.executeReconcile(reconcile)
        host.input.onInstrumentPreparation?.(host.preparedInstrumentTrackIds, { state: "ready" })
        // The published bank has no window, and its coordinator was disposed above. A Play that waited for this
        // publication must find the priming already registered when its wait ends.
        if (paused && !host.active && publicationEpoch === host.transportEpoch) host.pausedPriming = host.reprimePausedAdoption()
        return true
      }
      const step = async (reply: NativeRevisionReply, observed: number): Promise<PublicationPass> => {
        let status = reply
        if (status.ok) classifyPublication(status)
        if (!status.ok) {
          throw new Error(status.error)
        }
        if (tx.failure && "reason" in tx.failure.outcome) throw new Error(tx.failure.outcome.reason)
        const binding = tx.binding
        if (!binding) throw new NativePlaybackAbortError("ownership-invalidated")
        if (fill) {
          tx.staged?.dispose()
          try {
            // Cancel only this publication's wait. The host.active refill remains
            // owned by its coordinator until the transport transition.
            await awaitPreparation(coordinator.coverThrough(seam + host.maximumFramesPerBlock))
            hydrationMark?.("armed-cover-end")
            publicationAbort.signal.throwIfAborted()
            tx.staged = coordinator.stageRevision({ ...snapshot, revision: binding.revision },
              { ...graph, revision: binding.revision }, seam, async () => {
                if (!tx.binding) throw new NativePlaybackAbortError("ownership-invalidated")
                const rejectedAt = tx.sequence
                const inspection = await inspect()
                if (!inspection?.ok || inspection.revision.status !== "prepared")
                  throw new Error("Native staged window needs publication reconciliation.")
                await waitForOpportunity(rejectedAt)
              }, { assets, assetSourceKeys: sourceKeys, nativePcmChunkDescriptors: projection.nativePcmChunkDescriptors,
                preparedStretchAssets: candidate.stretchAssets })
            hydrationMark?.("armed-stage-returned")
            tx.staged.preflight({ ...graph, revision: binding.revision })
            hydrationMark?.("armed-prime-start")
            await tx.staged.prime(seam)
            hydrationMark?.("armed-prime-end")
          } catch (error) {
            const inspection = await inspect()
            if (!inspection?.ok || inspection.revision.status !== "rebase-required") throw error
            status = inspection
          }
          fill = false
        }
        if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
        if (status.ok && status.revision.status === "rebase-required") {
          if (record.resubmitsSpent) {
            const error = "Native live publication needs a fresh progress window."
            throw new Error(error)
          }
          await waitForOpportunity(observed)
          const inspection = await inspect()
          if (!inspection) throw new Error("Publication status unavailable.")
          tx.checked(inspection)
          status = inspection
          if (status.revision.status === "published") return { status, next: "again" }
          if (status.revision.transportEpoch !== host.transportEpoch)
            throw new NativePlaybackAbortError("ownership-invalidated")
          retry()
          seam = chooseFrame(status.revision.progressFrame ?? BigInt(coordinator.currentFrame()),
            Math.min(boundLeadBlocks() * 2 ** record.resubmits, 16 * (record.resubmits + 1)))
          const rebound = { ...binding, requestedPublicationFrame: BigInt(seam) }
          tx.binding = rebound
          tx.publishSent = true
          record.held()
          if (!sessionAlive()) throw new NativePlaybackAbortError("ownership-invalidated")
          const published = await withoutLane(revisions.publish(rebound))
          classifyPublication(published)
          tx.checked(published)
          status = published
          if (status.revision.status !== "prepared") throw new Error(`Native rebase was ${status.revision.status}.`)
          fill = true
          return { status, next: "again" }
        }
        if (tx.publishReply && !tx.publishReply.ok) tx.checked(tx.publishReply)
        if (status.revision.status !== "prepared" && status.revision.status !== "publish-pending")
          throw new Error(`Native live publication was ${status.revision.status}.`)
        if (status.revision.status === "prepared" && tx.progressVersion !== submittedProgress) {
          if (tx.publishSent) retry()
          submittedProgress = tx.progressVersion
          tx.publishSent = true
          record.held()
          if (!sessionAlive()) throw new NativePlaybackAbortError("ownership-invalidated")
          hydrationMark?.("bind-request-sent")
          // A lost IPC reply must not prevent progress-based reconciliation.
          tx.publishCompletion = revisions.publish(binding).then((reply) => {
            if (!sessionAlive()) return
            tx.publishReply = reply
            notify()
          }, () => { if (sessionAlive()) notify() })
        }
        return { status, next: "wait" }
      }
      return { status: ready, step }
    },
    fail: (error) => {
      if (error instanceof PublicationFailure) {
        const capacity = error.kind === "refused" && (error.message === "asset-capacity-exceeded"
          || error.message === "asset-page-capacity-exceeded" || error.message === "asset-publication-pending")
        tx.retainCandidate = capacity
        if (error.kind === "refused") tx.failure = {
          outcome: { status: capacity ? "blocked" : "failed", reason: error.message }, reason: "stage-failed",
        }
        else tx.uncertainPreparation = error.kind === "unconfirmed"
      }
      if (!current() || error instanceof NativePlaybackAbortError) record.cancel()
      const reason = error instanceof Error ? error.message : "Native live publication failed."
      return () => record.cancelled ? finish({ status: "superseded" }, "cancelled")
        : finish(tx.failure?.outcome ?? { status: "failed", reason },
          tx.failure ? "failed" : tx.uncertainPreparation || !tx.publishSent ? "uncertain" : "failed", tx.failure?.reason)
    },
    finalize: () => sessionAlive() ? undefined : disposePublication(),
  }
}
