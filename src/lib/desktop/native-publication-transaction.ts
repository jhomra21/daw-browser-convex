import type { NativeRevisionReply, NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision"
import type { SampledInstrumentRegionBudgetScope } from "~/lib/sampled-instrument-region-budget"
import { NativePlaybackAbortError } from "./native-playback-abort"
import type { NativeScheduleCoordinator } from "./native-schedule-coordinator"
import type {
  AdoptionAttempt,
  AdoptionOutcome,
  Inspection,
  Publication,
  createNativeProcessorStateOwner,
} from "./native-processor-state-owner"

export type NativeSessionReply = { ok: true } | { ok: false; error: string }
export type InstrumentAssetHold = { bytes: number; scope: SampledInstrumentRegionBudgetScope }

type ProcessorStateOwner = Pick<ReturnType<typeof createNativeProcessorStateOwner>, "fence" | "released" | "finishPublication" | "unprepared">
type RevisionBinding = Parameters<NativeRevisionSession["publish"]>[0]
type PublicationEvidence = Parameters<ProcessorStateOwner["finishPublication"]>[2]
type PublicationRefusal = Parameters<ProcessorStateOwner["finishPublication"]>[3]

// What one publication needs of the playback session that admitted it: the facts it captured, and the live questions it
// asks while it runs. `current` is false once the session it was compiled for has moved; `owned` is false once the
// session is gone.
export type PublicationSession = {
  record: Publication
  attempt: AdoptionAttempt | undefined
  candidate: { dispose: () => Promise<void> } | undefined
  revisions: NativeRevisionSession
  coordinator: NativeScheduleCoordinator
  previousRevision: number
  paused: boolean
  processorState: ProcessorStateOwner
  current: () => boolean
  owned: () => boolean
  transportEpoch: () => number
  runNextStatePatch: () => Promise<boolean>
  queueTransition: <Value>(task: () => Promise<Value>) => Promise<Value>
  releaseInstrumentScope: (scope: SampledInstrumentRegionBudgetScope | undefined) => void
  logFailedAdoption: (reason: string) => void
}

export type PublicationTransaction = {
  readonly record: Publication
  readonly abort: AbortController
  sequence: number
  progressVersion: number
  binding: RevisionBinding | undefined
  publishSent: boolean
  publishReply: NativeRevisionReply | undefined
  publishCompletion: Promise<void>
  detached: boolean
  failure: { outcome: AdoptionOutcome; reason: PublicationRefusal } | undefined
  invalidProof: boolean
  uncertainPreparation: boolean
  retainCandidate: boolean
  resourcesPromoted: boolean
  preparedRevision: number | undefined
  staged: NativeScheduleCoordinator | undefined
  discardAddedSources: (() => Promise<void>) | undefined
  stagedMemoryScope: SampledInstrumentRegionBudgetScope | undefined
  stagedHolds: Map<number, InstrumentAssetHold>
  adoptPublication: ((reply: NativeRevisionReply, acknowledgedEpoch?: number) => boolean) | undefined
  retry: () => void
  notify: () => void
  current: () => boolean
  sessionAlive: () => boolean
  waitForOpportunity: (observed: number) => Promise<void>
  withoutLane: <Value>(operation: Promise<Value>) => Promise<Value>
  quietPublicationLane: () => Promise<void>
  disposePublication: () => Promise<void>
  finish: (outcome: AdoptionOutcome, evidence: PublicationEvidence, reason?: PublicationRefusal) => Promise<{ record: Publication }>
  inspect: (request?: RevisionBinding, releaseLane?: boolean, replied?: () => void) => Promise<NativeRevisionReply | undefined>
  checked: (reply: NativeSessionReply) => asserts reply is Extract<NativeSessionReply, { ok: true }>
  classifyPublication: (reply: NativeRevisionReply | undefined) => void
  resolvePublication: (acknowledgedEpoch?: number, releaseLane?: boolean) => Promise<boolean>
}

// `relinquish` hands the transport lane back while the publication waits on native, and returns once it is retaken.
export const createPublicationTransaction = (
  session: PublicationSession,
  relinquish: (record: Publication, register: (resume: () => void) => void) => Promise<void>,
): PublicationTransaction => {
  const { record, attempt, candidate, revisions, coordinator, paused, processorState } = session
  let wake: (() => void) | undefined
  let resolving = false
  let lastProgressSequence = -1n
  let disposition: Promise<void> | undefined
  let acknowledged: number | undefined

  const notify = () => {
    tx.sequence++; wake?.(); wake = undefined
    record.wakeTransport()
    if (tx.detached && record.phase !== "ended" && !resolving) {
      resolving = true
      void session.queueTransition(async () => {
        try { await tx.resolvePublication() } finally { resolving = false }
      })
    }
  }
  const cancel = () => {
    record.cancel()
    tx.abort.abort(new NativePlaybackAbortError("ownership-invalidated"))
    tx.staged?.abortPreparation()
    notify()
  }
  const sessionAlive = () => session.owned() && record.phase !== "ended"
  const waitForOpportunity = async (observed: number) => {
    if (tx.sequence === observed && sessionAlive() && session.current() && !record.cancelled)
      await relinquish(record, resume => { wake = resume })
    if (!session.current() || record.cancelled || !sessionAlive()) throw new NativePlaybackAbortError("ownership-invalidated")
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
    while (processorState.fence().kind === "uncertain" && await session.runNextStatePatch()) continue
    if (processorState.fence().kind === "claimed") {
      const released = processorState.released()
      await relinquish(record, resume => { void released.then(resume); wake = resume })
    }
    if (!session.current() || record.cancelled) throw new NativePlaybackAbortError("ownership-invalidated")
  }
  const disposePublication = () => disposition ??= (async () => {
    // A published paused edit has already disposed the coordinator, so this only revives one native never replaced.
    if (paused) coordinator.resumeGraphPublication(session.previousRevision)
    tx.staged?.dispose()
    if (!tx.resourcesPromoted) {
      await tx.discardAddedSources?.()
      session.releaseInstrumentScope(tx.stagedMemoryScope)
      for (const { scope } of tx.stagedHolds.values()) session.releaseInstrumentScope(scope)
      if (!tx.retainCandidate) await candidate?.dispose()
      if (tx.preparedRevision !== undefined) processorState.unprepared(tx.preparedRevision)
    }
  })()
  const finish = async (outcome: AdoptionOutcome, evidence: PublicationEvidence, reason?: PublicationRefusal) => {
    await disposePublication()
    if (outcome.status === "failed" && record.kind === "schedule") session.logFailedAdoption(outcome.reason)
    processorState.finishPublication(record,
      record.kind === "latency" && outcome.status === "failed" && !outcome.failureKind
        ? { ...outcome, failureKind: { kind: evidence === "failed" ? "refused" : "unconfirmed" } } : outcome,
      evidence, reason)
    return { record }
  }
  const inspectRevision = async (request = tx.binding, releaseLane = false, replied?: () => void): Promise<Inspection> => {
    if (!sessionAlive() || !request) return { status: "unavailable" }
    try {
      const reply = revisions.inspect(request)
      if (replied) void reply.then(replied, () => undefined)
      return { status: "reply", reply: await (releaseLane ? withoutLane(reply) : reply) }
    } catch (error) { return { status: "failed", error: error instanceof Error ? error : new Error(String(error)) } }
  }
  const inspect = (request = tx.binding, releaseLane = false, replied?: () => void) =>
    inspectRevision(request, releaseLane, replied).then(inspection => inspection.status === "reply" ? inspection.reply : undefined)
  const checked: PublicationTransaction["checked"] = (reply) => {
    if (!reply.ok) {
      tx.uncertainPreparation = "kind" in reply && reply.kind === "unconfirmed"
      const capacity = reply.error === "asset-capacity-exceeded" || reply.error === "asset-page-capacity-exceeded"
        || reply.error === "asset-publication-pending"
      if ("kind" in reply && reply.kind === "refused") {
        tx.retainCandidate = capacity
        tx.failure = { outcome: { status: capacity ? "blocked" : "failed", reason: reply.error }, reason: "native-refused" }
      }
      throw new Error(reply.error)
    }
  }
  const classifyPublication = (reply: NativeRevisionReply | undefined) => {
    if (!reply) return
    if (!reply.ok) {
      if (reply.kind === "refused") tx.failure = {
        outcome: { status: "failed", reason: reply.error }, reason: "native-refused",
      }
      return
    }
    const status = reply.revision.status
    if (status === "publish-failed" || status === "stale-revision" || status === "invalid-revision")
      tx.failure = { outcome: { status: "failed", reason: `Native live publication was ${status}.` },
        reason: status === "publish-failed" ? "apply-failed" : status === "stale-revision" ? "stale-revision" : "invalid" }
  }
  const notTaken = () => finish(tx.failure?.outcome ?? (record.cancelled
    ? { status: "superseded" } : { status: "failed", reason: "Native live publication was not taken." }),
  tx.invalidProof ? "uncertain" : tx.failure ? "failed" : record.cancelled ? "cancelled" : "failed", tx.failure?.reason)
  const resolvePublication = async (acknowledgedEpoch?: number, releaseLane = false): Promise<boolean> => {
    if (!sessionAlive()) { await disposePublication(); return false }
    if (acknowledgedEpoch === undefined) record.resolving()
    else record.awaitingTransport()
    const proof = await inspect(tx.binding, releaseLane)
    if (!sessionAlive()) { await disposePublication(); return false }
    if (proof?.ok && proof.revision.status === "publish-failed") tx.failure = {
      outcome: { status: "failed", reason: "Native live publication was publish-failed." }, reason: "apply-failed",
    }
    if (proof?.ok && proof.revision.status === "published") {
      if (tx.adoptPublication?.(proof, acknowledgedEpoch)) {
        await finish({ status: "adopted" }, "promoted")
        return true
      }
      // A mismatching proof cannot promote our resources or answer its cohort.
      // Rollback still reconciles the bank this session actually owns.
      tx.invalidProof = true
    }
    if (acknowledgedEpoch !== undefined) {
      if (proof?.ok) await notTaken()
      return false
    }
    if (proof?.ok && proof.revision.status === "stale-revision") { await notTaken(); return false }
    if (proof?.ok && proof.revision.status === "publish-pending" && !record.cancelled && !tx.failure) return false
    if (!tx.binding || !sessionAlive()) return false
    const rollback = revisions.rollback(tx.binding)
    const rolledBack = await (releaseLane ? withoutLane(rollback) : rollback).catch(() => undefined)
    if (!sessionAlive()) { await disposePublication(); return false }
    if (rolledBack?.ok && rolledBack.revision.status === "stale-revision") {
      const resolved = await inspect(tx.binding, releaseLane)
      if (!sessionAlive()) { await disposePublication(); return false }
      if (resolved?.ok && resolved.revision.status === "published") {
        if (tx.adoptPublication?.(resolved)) {
          await finish({ status: "adopted" }, "promoted")
          return true
        }
      } else if (resolved?.ok) await notTaken()
    } else if (rolledBack?.ok && rolledBack.revision.status === "rolled-back") await notTaken()
    else if (record.cancelled) record.awaitingTransport()
    else record.resolving()
    return false
  }

  const tx: PublicationTransaction = {
    record,
    abort: new AbortController(),
    sequence: 0,
    progressVersion: 0,
    binding: undefined,
    publishSent: false,
    publishReply: undefined,
    publishCompletion: Promise.resolve(),
    detached: false,
    failure: undefined,
    invalidProof: false,
    uncertainPreparation: false,
    retainCandidate: false,
    resourcesPromoted: false,
    preparedRevision: undefined,
    staged: undefined,
    discardAddedSources: undefined,
    stagedMemoryScope: undefined,
    stagedHolds: new Map(),
    adoptPublication: undefined,
    retry: () => record.resubmitted(),
    notify,
    current: session.current,
    sessionAlive,
    waitForOpportunity,
    withoutLane,
    quietPublicationLane,
    disposePublication,
    finish,
    inspect,
    checked,
    classifyPublication,
    resolvePublication,
  }

  record.onWake(() => { if (record.cancelled) cancel(); else notify() })
  if (attempt) attempt.withdrawPublication = () => {
    if (tx.publishSent) return false
    cancel()
    return true
  }
  record.onProgress((progress) => {
    if (progress.epoch !== session.transportEpoch() || progress.progressSequence <= lastProgressSequence) return
    lastProgressSequence = progress.progressSequence
    tx.progressVersion++
    notify()
  })
  record.onInspect(() => inspectRevision())
  record.onAcknowledge(async epoch => {
    if (acknowledged === epoch) return record.outcome?.status === "adopted"
    acknowledged = epoch
    tx.detached = false
    try { return await resolvePublication(epoch) } finally { tx.detached = record.phase !== "ended" }
  })
  return tx
}
