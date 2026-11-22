import { serializeNativeGraph } from "@daw-browser/audio-engine/native-host-wire"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import { nativeKeepLatencyDivergentMixedBusDiagnostic } from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeRevisionReply, NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import { NativePlaybackAbortError } from "./native-playback-abort"
import type {
  AdoptionOutcome,
  createNativeProcessorStateOwner,
  InstalledContent,
  ProcessorDesired,
  ProcessorReconcile,
} from "./native-processor-state-owner"
import {
  PublicationFailure,
  type PublicationPass,
  type PublicationStrategy,
  type PublicationTransaction,
} from "./native-publication-transaction"
import { scheduledRetention, targetKinds } from "./native-graph-targets"
import type { createNativeRetirement } from "./native-retirement"
import type { NativeScheduleCoordinator } from "./native-schedule-coordinator"
import type { ScheduleRevisionCandidate } from "./native-schedule-publication"
import { sameBytes } from "./native-snapshot-support"

// Native's diagnostic says Keep Latency cannot be honoured for this graph: a fault of its own kind, not a failed publication.
class NativeLatencyUnsupportedError extends Error {}

// What one latency publication captured of the prepared session.
export type LatencyFacts = {
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

// The playback controller's own state, which a latency publication reads while it prepares and replaces when it is
// published. Members the controller assigns are writable; the rest are read live.
export type LatencyHost = {
  processorState: ReturnType<typeof createNativeProcessorStateOwner<ScheduleRevisionCandidate>>
  observation: { setMeterRevision: (revision: number) => void }
  retirement: Pick<ReturnType<typeof createNativeRetirement>, "hold">
  readonly lifecycleGeneration: number
  readonly scheduleCoordinator: NativeScheduleCoordinator | undefined
  readonly desiredKeepLatencyNodeIds: ReadonlySet<string>
  readonly latencyInputVersion: number
  readonly maximumFramesPerBlock: number
  preparedGraph: AudioCoreGraphSnapshot | undefined
  preparedSnapshot: LivePlaybackSnapshot | undefined
  preparedKeepLatencyNodeIds: ReadonlySet<string>
  captureLatencyInputs: () => {
    graph: AudioCoreGraphSnapshot
    snapshot: LivePlaybackSnapshot
    keep: Set<string>
    sequence: number
    ledger: ReadonlyMap<string, ProcessorDesired>
  }
  captureInstrumentIncarnations: (snapshot: LivePlaybackSnapshot) => Map<string, number>
  publicationContent: (
    graph: AudioCoreGraphSnapshot,
    snapshot: LivePlaybackSnapshot,
    ledger: ReadonlyMap<string, ProcessorDesired>,
    incarnations?: ReadonlyMap<string, number>,
  ) => Map<string, InstalledContent>
  statePatchMatchesCurrentProcessor: (instanceId: string, state: Uint8Array) => boolean
  executeReconcile: (reconcile: readonly ProcessorReconcile[]) => void
  invalidateNativeOwnership: (hostLost?: boolean, preservePendingStart?: boolean) => void
  advanceScheduleSettledEpoch: () => void
}

export const createLatencyPublication = (tx: PublicationTransaction, facts: LatencyFacts, host: LatencyHost): PublicationStrategy => {
  const { processorState, observation, retirement, captureLatencyInputs, captureInstrumentIncarnations, publicationContent,
    statePatchMatchesCurrentProcessor, executeReconcile, invalidateNativeOwnership, advanceScheduleSettledEpoch } = host

  const { record, current, sessionAlive, retry, notify, waitForOpportunity, withoutLane, quietPublicationLane, finish, inspect, classifyPublication } = tx
  const { previous, previousGraph, projectId, coordinator, revisions, publicationEpoch } = facts
  let { graph, snapshot, keep: serializedKeepLatencyNodeIds, inputVersion: capturedInputVersion } = facts
  let runtimeRevision = previousGraph.revision
  let resumeSafe = true
  let ready: NativeRevisionReply | undefined
  const capturedGeneration = host.lifecycleGeneration

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
    if (sessionAlive() && resumeSafe && coordinator === host.scheduleCoordinator)
      coordinator.resumeGraphPublication(runtimeRevision)
  }

  const prepareBank = async () => {
    await quietPublicationLane()

    if (initialPreparation) {
      includedOrder = capture()
      capturedInputVersion = host.latencyInputVersion
      initialPreparation = false
    }

    if (!current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
    await coordinator.coverThrough(coordinator.currentFrame() + host.maximumFramesPerBlock * 16)
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
    if (!proof.ok || !ready?.ok || !tx.binding || !sessionAlive() || capturedGeneration !== host.lifecycleGeneration
      || proof.hostPid !== ready.hostPid || proof.hostGeneration !== ready.hostGeneration
      || proof.revision.activeRevision !== tx.binding.revision
      || (proof.revision.transportEpoch !== undefined
        && proof.revision.transportEpoch !== (acknowledgedEpoch ?? publicationEpoch))) return false
    runtimeRevision = tx.binding.revision
    resumeSafe = true
    host.preparedGraph = { ...graph, revision: runtimeRevision }
    processorState.published(runtimeRevision)

    if (JSON.stringify(snapshot.nativeExternalAttachmentPlan) !== JSON.stringify(previous.nativeExternalAttachmentPlan))
      host.preparedSnapshot = { ...snapshot, revision: host.preparedSnapshot?.revision ?? snapshot.revision }
    host.preparedKeepLatencyNodeIds = serializedKeepLatencyNodeIds
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
              || serializedKeepLatencyNodeIds.size !== host.desiredKeepLatencyNodeIds.size
              || [...serializedKeepLatencyNodeIds].some(id => !host.desiredKeepLatencyNodeIds.has(id))
              || host.latencyInputVersion !== capturedInputVersion

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
              capturedInputVersion = host.latencyInputVersion
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
