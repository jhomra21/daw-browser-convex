import type { AudioCoreGraphSnapshot, AudioCoreSynthState } from "@daw-browser/audio-core-contract"
import type { NativeProcessorPatchRefusal, NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"
import { getEffectTiming } from "@daw-browser/audio-engine/effects/timing"
import type { LivePlaybackCompileContext, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import type {
  LiveProcessorEditIdentity, ProcessorDeliveryOutcome, ProcessorRefusal, ProcessorTiming, ReceiptHandle,
} from "~/lib/live-processor-control"
import { SYNTH_KIND_ID, nativeInstrumentContentKey, nativeSynthStructureKey, nativeSynthValues } from "~/lib/live-processor-control"
import { NativePlaybackAbortError } from "./native-playback-abort"
import { nativeBuiltInLiveStateCovered } from "./native-built-in-parameter-mapper"
import type { NativeRevisionReply, NativeRevisionRequest } from "@daw-browser/desktop-protocol/native-revision"

type GraphProcessor = AudioCoreGraphSnapshot["nodes"][number]["processorOrder"][number]

// Desired content of one built-in processor: the edit identity plus the
// normalized absolute state a publication materializes for it. `values` are the
// parameter values the edit captured, never re-derived from `params`.
export type ProcessorDesired = {
  id: string
  order: number
  target: LiveProcessorEditIdentity["target"]
  content: { state: Uint8Array; params?: object; values?: Readonly<Record<string, number>>; timing?: ProcessorTiming; instrument?: ContentSpec["instrument"] }
  bypassed: boolean
  tailFrames: number
  tailKind?: GraphProcessor["tailKind"]
}

// The UI-projected content of a graph processor, resolved by the host from the
// effective projection. Only a matching current registry edit identifies it;
// without one, the configured graph remains the installed baseline.
export const projectedProcessorDesired = (
  nodeId: string,
  processor: GraphProcessor,
  live: { kindId: number; incarnation: number; latest?: LiveProcessorEditIdentity } | undefined,
): ProcessorDesired | undefined => {
  const edit = live?.latest
  // The edit identifies the projected content only when it is that content: values are a function of the state bytes.
  if (!edit || live.kindId !== processor.kindId || edit.target.nodeId !== nodeId
    || edit.target.instanceId !== processor.id || edit.target.kindId !== processor.kindId
    || edit.target.incarnation !== live.incarnation
    || (edit.content.state !== undefined && bytesText(edit.content.state) !== bytesText(processor.state))) return undefined
  return {
    id: edit.id,
    order: edit.order,
    target: edit.target,
    content: { state: processor.state, params: edit.content.params, values: edit.content.values, timing: edit.content.timing },
    bypassed: processor.bypassed,
    tailFrames: processor.tailFrames,
    ...(processor.tailKind && { tailKind: processor.tailKind }),
  }
}

// A submitted state patch, ordered by its edit. Its enabled flag and tail are the
// processor's until `timedProcessorDesired` reads them from `timing`.
export const patchProcessorDesired = (
  processor: GraphProcessor,
  patch: { edit: LiveProcessorEditIdentity; state: Uint8Array; timing: ProcessorTiming },
): ProcessorDesired => ({
  id: patch.edit.id,
  order: patch.edit.order,
  target: patch.edit.target,
  content: { state: patch.state, params: patch.edit.content.params, values: patch.edit.content.values, timing: patch.timing },
  bypassed: processor.bypassed,
  tailFrames: processor.tailFrames,
  ...(processor.tailKind && { tailKind: processor.tailKind }),
})

// The content with its enabled flag and tail read from its own parameters at this tempo, when it carries them. Every
// content that can be sent carries them (a patch, a registered edit, its projection), so the tail is derived here only.
export const timedProcessorDesired = (desired: ProcessorDesired, sampleRateHz: number, bpm: number): ProcessorDesired => {
  const { timing } = desired.content
  if (!timing) return desired
  const { tailKind: _tailKind, ...rest } = desired
  const { tail } = getEffectTiming(timing.input, sampleRateHz, bpm)
  return { ...rest, bypassed: timing.enabled === undefined ? desired.bypassed : !timing.enabled,
    ...(tail.kind === "unbounded" ? { tailFrames: 0xffff_ffff, tailKind: "unbounded" } : { tailFrames: tail.frames }) }
}

// The content a delivery asks native to hold, compared by value and never by edit id: the state bytes (as text) and
// the absolute parameter values. Two contents are the same exactly when their keys are.
export type ContentSpec = {
  state?: string
  timing?: ProcessorTiming
  instrument?: { state: AudioCoreSynthState; incarnation: number }
  values: Readonly<Record<string, number>>
}
const bytesText = (bytes: Uint8Array) => {
  let text = ""
  for (const byte of bytes) text += String.fromCharCode(byte)
  return text
}
export const processorContentSpec = (content: { state?: Uint8Array; timing?: ProcessorTiming; values?: Readonly<Record<string, number>>; instrument?: ContentSpec["instrument"] }): ContentSpec => ({
  ...(content.instrument ? { instrument: content.instrument } : content.state && { state: bytesText(content.state) }),
  ...(content.timing && { timing: content.timing }),
  values: content.values ?? {},
})
const contentKeyOf = (spec: ContentSpec) => spec.instrument ? nativeInstrumentContentKey(spec.instrument.state) : JSON.stringify([
  spec.state ?? null, Object.entries(spec.values).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
])

type ProcessorEntry = {
  target: ProcessorDesired["target"]
  desired: ProcessorDesired
  applied?: ProcessorDesired
}

export type ExecutionSettlement = "applied" | "cancelled"

// One request for a target's content, answered once (design 1.3). `attempts` is the history of every carrier that
// tried to take it; the carriers' own settlement is bookkeeping and never answers a receipt.
type Attempt = "pending" | "definite-refusal" | "uncertain" | "proved"
export type Receipt = {
  serial: number
  key: string
  // Lineage order of the edit (-1 for a request without one); never decides equality.
  order: number
  contentKey: string
  incarnation: number
  lifetime?: number
  nodeId?: string
  publication?: PublicationRecord
  edit?: LiveProcessorEditIdentity
  spec: ContentSpec
  attempts: Attempt[]
  reason?: ProcessorRefusal
  // A structural join: answered by the adoption that carries the target, not by a proof of its own.
  join?: true
  answered?: ProcessorDeliveryOutcome
  // The newest carrier that was sent or joined for it: what an old entry names as the batch that proved the request.
  carrier?: Execution
  settled: Promise<ProcessorDeliveryOutcome>
  answer: (outcome: ProcessorDeliveryOutcome) => void
}
export const receiptHandle = (receipt: Receipt): ReceiptHandle => ({ key: receipt.key, serial: receipt.serial })

// One dispatch of an edit's parameter values, registered before its send so an adoption sees it
// (`queued`): the send may wait for its epoch, and an adoption can also run before the queue ACK
// (`admitted`). Admission is not application: `applied` is only ever set from native progress, and
// only for a send that has been made (`sent`). A refused dispatch keeps its content (`refused`) and
// is sent again from the completion of its refusal, then at an event (an adoption, a domain end). A state patch is
// the same record with no native sequence: it settles by its status, by its claim's resolution, by a publication that
// carries it, or by a newer one.
export type Execution = {
  // Processor or synth instance id.
  key: string
  editId: string
  // -1 for a request without an edit: it never supersedes or short-circuits anything.
  order: number
  kindId?: number
  // The transport epoch it was dispatched in; while unsent, the epoch a frame must show applied before it is sent.
  epoch: number
  revision: number
  // Set when a publication kept the batch and native re-stamped it.
  rebound?: number
  // Controller sequence; it is also the parameter lane's proof sequence. Final once `sent`, unless a publication
  // dispatches the batch again (`rebind`).
  sequence: number
  // Which dispatch of the record this is: new at each register, rebind and patch dispatch, so a caller can tell
  // whether the record was dispatched again while it waited, even on an unchanged revision.
  attempt: number
  // The urgent lane's proof sequence is the last event's, allocated when the events are sent.
  strategy: { kind: "parameters" } | { kind: "urgent"; sequence: number } | { kind: "patch" }
  // False until the controller hands the batch to the bridge. Nothing native reports can be about a batch
  // that was never sent: a later note or batch may already have lifted the lane's floor past its sequence.
  sent: boolean
  values: ReadonlyMap<string, number>
  // The edit's content: instrument params and, for a built-in processor, its full state and parameter values.
  content?: LiveProcessorEditIdentity["content"]
  // What this record puts in force once proven, and the receipts it is an attempt for.
  spec?: ContentSpec
  contentKey?: string
  receipts: Receipt[]
  state: "queued" | "admitted" | "refused" | ExecutionSettlement
  // The one retry the policy allows has been taken, an attempt of this record was lost, and the ladder patch was queued.
  retried?: true
  uncertain?: true
  laddered?: true
  // Patch only: the submitted desired, and the newest content `nextPatch` found for it, which is what is sent.
  desired?: ProcessorDesired
  materialized?: ProcessorDesired
  // Patch only: native claimed it and its resolution has not been reported.
  claimed?: true
  // A refused batch a state install satisfied: its values are in force, but no parameter batch proved them.
  installed?: true
  // Patch only: native refused it for an operation this controller has outstanding; that operation's end offers it again.
  held?: true
  // Patch only: the registry edit it was queued for, which says whether the target was retired before it was sent.
  edit?: LiveProcessorEditIdentity
}

// Executions of one target. It lives from its first dispatch until a
// publication no longer carries the instance with the same kind, or `clear()`:
// native keeps a slot's overrides across epochs, so nothing shorter may end
// `live`, the keys native holds an override for. `live` only grows from proven
// applications: a stale key costs one redundant dispatch, a missing key hides
// an override.
type TargetExecutions = {
  // Join targets use this ledger-issued identity. Registry targets carry their own identity on installed content.
  incarnation: number
  registryIncarnation?: number
  installedIncarnation?: number
  instrument?: AudioCoreSynthState
  kindId?: number
  latest?: Execution
  // The latest dispatch carrying each parameter. A gesture's previews each send only the fields they
  // changed, so the flush that ends it covers fields an earlier preview's dispatch carried.
  carriers: Map<string, Execution>
  inflight: Map<number, Execution>
  // Refused batches: kept for the next recovery offer (an adoption, a domain end, a newer delivery).
  refused: Set<Execution>
  // The patch last dispatched (sent, claimed or refused) and the one waiting behind it.
  patch?: Execution
  queuedPatch?: Execution
  // The gesture that owns native for this target until its closing delivery.
  gesture?: string
  gestureIncarnation?: number
  // The state bytes native is proven to hold, and the values that state carries.
  state?: string
  installedTiming?: ProcessorTiming
  installedValues: Map<string, number>
  // The value is unknown (undefined) for a key whose override may not have survived a publication that
  // replaced the processor's state.
  live: Map<string, number | undefined>
  // The edit order that applied each live value.
  liveOrder: Map<string, number>
  applied?: Execution
  // Requests not answered yet.
  receipts: Set<Receipt>
  // A follower offer blocked by a carrier or patch, revisited only when that work ends.
  deferredFollowers?: true
  structural?: { lifetime: number }
  // The content whose policy ended and how it was answered: the same content is answered alike until an event offers
  // it again (design 1.6: recovery comes from events only, never from asking again). A record answers every request
  // linked to it, whichever carrier it was escalated to.
  exhausted?: ReadonlyMap<string, ProcessorDeliveryOutcome>
}

// What a publication or a session start put in force for a target.
export type InstalledContent = {
  nodeId?: string
  kindId: number
  state?: Uint8Array
  timing?: ProcessorTiming
  values?: Readonly<Record<string, number>>
  contentKey?: string
  incarnation?: number
  instrument?: AudioCoreSynthState
}

// Whether native keeps a queued batch across one publication, for a target key
// and the parameter ids the batch carries.
export type ExecutionRetention = (key: string, parameterIds: Iterable<string>) => boolean

// Desired content to dispatch, a dispatch to repeat on the current publication, or a patch the ledger queued.
export type ProcessorReconcile = { desired: ProcessorDesired; values: ReadonlyMap<string, number> } | { resend: Execution } | { patch: Execution }

// The host-wide fence on the patch lane (design 2.4.6). Native holds at most one claim, and a patch or a prepare sent
// meanwhile is refused, so nothing is sent for any target until the claim's resolution is reported.
export type PatchFence =
  | { kind: "open" }
  | { kind: "claimed"; token: bigint; carrier?: Execution }
  | { kind: "uncertain"; target: string; resends: 0 | 1 }

// The typed answer to one patch send. `transient`: the refusal names an operation the controller has outstanding
// (a prepare, a publication), whose end requeues the patch; without one it is definite.
export type PatchReply =
  | { kind: "applied" }
  | { kind: "claimed"; token: bigint }
  | { kind: "refused"; refusal: Extract<ProcessorRefusal, NativeProcessorPatchRefusal> | "native-refused"; token?: bigint; transient: boolean }
  | { kind: "unconfirmed" }
  | { kind: "unavailable" }

export type RefusalKind = "transient" | "definite" | "uncertain"
export type RefusalAction = "retry" | "ladder" | "waiting" | "ended"

export type DeliverInput = {
  key: string
  editId: string
  order: number
  kindId: number
  incarnation: number
  // The transport epoch the delivery would be sent in.
  epoch: number
  state?: Uint8Array
  values: Readonly<Record<string, number>>
  // A processor's desired content, which becomes the target's desired when it is the newest. A synth has none.
  desired?: ProcessorDesired
  edit?: LiveProcessorEditIdentity
  instrument?: AudioCoreSynthState
  preparedInstrument?: boolean
}
export type DeliveryPlan =
  | { carrier: "none" | "publication" }
  | { carrier: "parameters" | "urgent"; values: ReadonlyMap<string, number> }
  | { carrier: "patch"; execution: Execution }
export type Delivery = { receipt: Receipt; plan: DeliveryPlan }

// What an incident reports once: the category of its first failure and how many targets it holds then.
export type IncidentReporter = (category: "refused" | "unconfirmed", targets: number) => void

// What a schedule adoption is for: the projection `key`, and what the compile is handed besides it (the instrument
// override and external processor change what is compiled without changing the projection). Two intents are the same
// attempt only when both match; the `loop` is applied to the transport before the attempt compiles. `schedule` is the
// part of `key` that decides what is published: a compile that finished while only the rest changed is still used.
export type AdoptionIntent = {
  key: string
  schedule: string
  context: Pick<LivePlaybackCompileContext, "instrumentOverride" | "externalProcessor">
  loop: Pick<LivePlaybackTransport, "loopEnabled" | "loopStartSec" | "loopEndSec">
}
export type AdoptionRefusal =
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string; failureKind?: {
      kind: "refused" | "unconfirmed" | "unavailable" | "latency-unsupported"; message?: string
    } }
export type AdoptionOutcome =
  | { status: "adopted" | "unchanged" }
  | { status: "superseded"; evidence?: "lost" }
  | AdoptionRefusal
// The facts that make a refused attempt stale: a changed host, transport domain, structural graph, native admission
// capacity (reclaims) or `settled`, a publication or latency transition that ended. An arena refusal (the clip asset
// or page table is full) answers to capacity alone; any other refusal answers to all five.
export type AdoptionFields = { host: string; epoch: number; structural: number; capacity: number; settled: number }
type AdoptionWaiting = {
  intent: AdoptionIntent
  explicit: boolean
  settled: Promise<AdoptionOutcome>
  resolve: (outcome: AdoptionOutcome) => void
}
// `withdrawPublication` is set by the publication the attempt runs: it cancels it and answers false once native may hold it.
export type AdoptionAttempt = AdoptionWaiting & { fields: AdoptionFields; withdrawPublication?: () => boolean; publication?: PublicationRecord }
export type PublicationRecord = {
  kind: "schedule" | "latency"
  resubmits: number
  progress?: (progress: NativeScheduleProgress) => void
  transportWake?: () => void
  phase: "prepared" | "held" | "resolving" | "awaitingTransport" | "ended"
  cancelled: boolean
  content: ReadonlyMap<string, InstalledContent & { lifetime?: number }>
  cohort: Map<Receipt, number>
  terminal: Promise<AdoptionOutcome>
  resolve: (outcome: AdoptionOutcome) => void
  outcome?: AdoptionOutcome
  inspect?: () => Promise<NativeRevisionReply | undefined>
  acknowledge?: (epoch: number) => Promise<boolean>
  wake?: () => void
}
type Disposable = { dispose: () => Promise<void> }
export type RetirementObligation = {
  binding: NativeRevisionRequest
  hostPid: number
  sessionGeneration: number
  release: () => Promise<void>
  opportunity: number
  attempted: number
  running: boolean
  uncertain: boolean
  readerPoint?: { epoch: number; frame: bigint; renderEpoch: bigint; crossed: boolean }
  readerPassed: boolean
  waitingControl: boolean
}
// An attempt the caller must run, and a candidate that belonged to another intent for the caller to dispose.
export type AdoptionStart<Candidate> = { attempt: AdoptionAttempt; dispose?: Candidate }
type AdoptionSubmission<Candidate> = { settled: Promise<AdoptionOutcome>; start?: AdoptionStart<Candidate> }

const sameContext = (left: AdoptionIntent, right: AdoptionIntent) => left.context.instrumentOverride === right.context.instrumentOverride
  && left.context.externalProcessor === right.context.externalProcessor
const sameIntent = (left: AdoptionIntent, right: AdoptionIntent) => left.key === right.key && sameContext(left, right)

const inFlight = (execution: Execution) => execution.state === "queued" || execution.state === "admitted"
const unsettled = (execution: Execution) => inFlight(execution) || execution.state === "refused"
// An applied patch stands at the order of the content it installed, which may be a newer edit's than the one it was
// queued for; the record keeps its own order for identity.
const appliedOrder = (execution: Execution) => execution.materialized?.order ?? execution.order

// Execution intent, keyed by processor or synth instance. A processor's desired
// ends with its incarnation: nothing older than the current one can write or survive.
export const createNativeProcessorStateOwner = <Candidate extends Disposable = Disposable>(
  options: { reportIncident?: IncidentReporter; onTerminal?: () => void } = {},
) => {
  const entries = new Map<string, ProcessorEntry>()
  // Cleanup outlives the publication's caller, but never the native session.
  let retirement: RetirementObligation | undefined
  const finishRetirement = (held: RetirementObligation) => {
    if (retirement !== held) return
    retirement = undefined
    void held.release().catch(() => undefined)
  }
  // Execution state outlives entries: publication adoption deletes an entry
  // once its desired content is included. A registry delivery may also exist without a projected desired entry.
  const targets = new Map<string, TargetExecutions>()
  const active = new Set<string>()
  const decisions: { revision: number; retains: ExecutionRetention }[] = []
  // Desired content whose reconcile waits for in-flight executions or for its own to apply.
  const unreconciled = new Map<string, ProcessorDesired>()
  const settledKeys = new Set<string>()
  // The newest caller delivery, including synth requests with no projected desired entry.
  const delivered = new Map<string, { order: number; spec: ContentSpec; edit?: LiveProcessorEditIdentity }>()
  // Targets a publication or the registry ended in this session: asking for one is unavailable, not unsupported.
  const ended = new Set<string>()
  let lastProgress = -1n
  let attempts = 0
  let serials = 0
  let incarnations = 0
  // The order the published graph carries up to: an older edit is in it already.
  let includedThrough = 0
  let fence: PatchFence = { kind: "open" }
  // Lane work that waits for the claim to resolve (a prepare): woken by the transition itself, never by a timer.
  const claimWaiters: (() => void)[] = []
  const setFence = (next: PatchFence) => {
    fence = next
    if (next.kind !== "claimed") for (const wake of claimWaiters.splice(0)) wake()
  }
  // The resolution the last frame carried, for a claim whose reply the frame overtook. One slot: native holds at
  // most one claim and publishes only a recorded one. Fed only by the controller's filtered progress subscription.
  let lastResolution: { token: bigint; result: number } | undefined
  let incident: { category: "refused" | "unconfirmed"; targets: Set<string> } | undefined

  const targetFor = (key: string, kindId: number | undefined) => {
    let target = targets.get(key)
    if (!target) {
      target = { incarnation: ++incarnations, ...(kindId !== undefined && { kindId }), inflight: new Map(), refused: new Set(), live: new Map(), liveOrder: new Map(),
        carriers: new Map(), installedValues: new Map(), receipts: new Set() }
      targets.set(key, target)
    }
    if (kindId !== undefined) target.kindId ??= kindId
    return target
  }

  // What native is proven to sound as: the installed state, the values it carries and the overrides applied over it.
  // An unknown value is never equal to anything.
  const resolved = (target: TargetExecutions, id: string) => target.live.has(id) ? target.live.get(id) : target.installedValues.get(id)
  const unknownOverrides = (target: TargetExecutions, spec: ContentSpec) =>
    spec.state !== undefined && Object.keys(spec.values).length === 0
      && (target.live.size > 0 || target.inflight.size > 0)
  // Native's installed bytes and applied overrides jointly define effective content. A full registry state may differ
  // only at live fields; it is comparable through the shared mapper only when the request names every such field.
  const sameStructure = (target: TargetExecutions, spec: ContentSpec) => {
    if (spec.state === undefined || spec.state === target.state) return true
    if (!target.installedTiming || !spec.timing) return false
    return nativeBuiltInLiveStateCovered(target.installedTiming, spec.timing, spec.values)
  }
  const proves = (target: TargetExecutions, spec: ContentSpec) => sameStructure(target, spec)
    && (!spec.instrument || (target.instrument !== undefined && target.installedIncarnation === spec.instrument.incarnation
      && nativeSynthStructureKey(target.instrument) === nativeSynthStructureKey(spec.instrument.state)))
    && !unknownOverrides(target, spec)
    && Object.entries(spec.values).every(([id, value]) => resolved(target, id) === value)
  // What the ledger currently wants native to hold for a target: the newest of the content last delivered and the
  // desired a projection or a patch put there.
  const currentSpec = (key: string) => {
    const desired = entries.get(key)?.desired
    const last = delivered.get(key)
    return desired && (!last || desired.order > last.order) ? processorContentSpec(desired.content) : last?.spec
  }

  // Incident: one per session. A target joins at its failure and leaves when native is proven to hold the ledger's
  // current desired for it, or when it ends; the notice is sent once, when the first target joins.
  const joinIncident = (key: string, category: "refused" | "unconfirmed") => {
    if (incident) incident.targets.add(key)
    else {
      incident = { category, targets: new Set([key]) }
      options.reportIncident?.(category, 1)
    }
  }
  const leaveIncident = (key: string) => {
    incident?.targets.delete(key)
    if (incident?.targets.size === 0) incident = undefined
  }
  const clearIncident = (key: string) => {
    if (!incident?.targets.has(key)) return
    const target = targets.get(key)
    const spec = currentSpec(key)
    if (target && spec && proves(target, spec)
      && coverage(target, spec, contentKeyOf(spec), target.latest?.epoch ?? 0).kind === "proven") leaveIncident(key)
  }

  const newReceipt = (target: TargetExecutions, input: Pick<Receipt, "key" | "order" | "incarnation" | "lifetime" | "nodeId" | "spec" | "contentKey"> & { join?: true }) => {
    let answer: (outcome: ProcessorDeliveryOutcome) => void = () => {}
    const settled = new Promise<ProcessorDeliveryOutcome>((done) => { answer = done })
    const receipt: Receipt = { ...input, serial: ++serials, attempts: [], settled, answer }
    target.receipts.add(receipt)
    return receipt
  }
  const answerReceipt = (receipt: Receipt, outcome: ProcessorDeliveryOutcome) => {
    if (receipt.answered) return
    receipt.answered = outcome
    targets.get(receipt.key)?.receipts.delete(receipt)
    receipt.answer(outcome)
  }
  const finishAttempt = (execution: Execution, result: Exclude<Attempt, "pending">) => {
    for (const receipt of execution.receipts) {
      const pending = receipt.attempts.lastIndexOf("pending")
      if (pending >= 0) receipt.attempts[pending] = result
      else receipt.attempts.push(result)
    }
  }
  // A request older than the content a record carries: a lower order, or the same order registered before it (callers
  // with no registry edit share one).
  const precedes = (receipt: Receipt, execution: Execution, order: number) => {
    if (receipt.order < 0) return false
    const newest = Math.max(0, ...execution.receipts.filter((carried) => carried.contentKey === execution.contentKey).map((carried) => carried.serial))
    return receipt.order < order || (receipt.order === order && receipt.serial < newest)
  }
  // Rule c: newer, different content is dispatched or materialized, so what is older and still unanswered is superseded.
  const supersedeOlder = (target: TargetExecutions, execution: Execution, order: number) => {
    if (order < 0) return
    for (const receipt of target.receipts) {
      if (receipt.contentKey !== execution.contentKey && precedes(receipt, execution, order)) answerReceipt(receipt, { state: "superseded", by: order })
    }
  }
  // Rules a and b: after a proof, every request native is proven to hold is applied, and an older one it does not is
  // superseded by the proof's order. A request is never answered from an order alone.
  const resolveReceipts = (key: string, proof?: Execution) => {
    const target = targets.get(key)
    if (!target) return
    for (const receipt of target.receipts) {
      if (receipt.join) continue
      // Current equality is not a proof for a request ordered behind different pending content.
      // Reuse rule 0: a joined carrier still owes its own proof, even if an older frame sounds equal.
      if (proves(target, receipt.spec)
        && (receipt.carrier === proof && proof !== undefined
          || coverage(target, receipt.spec, receipt.contentKey, proof?.epoch ?? receipt.carrier?.epoch ?? 0).kind === "proven"))
        answerReceipt(receipt, { state: "applied" })
      else if (proof && precedes(receipt, proof, proof.order)) answerReceipt(receipt, { state: "superseded", by: proof.order })
    }
    clearIncident(key)
  }
  // Rule e: the policy ended for this record. Every attempt a definite refusal is a refusal; one that may have been
  // taken makes it unconfirmed. The desired stays, and the target joins the session's incident.
  const endPolicy = (execution: Execution, noIncident = false) => {
    let uncertain = !!execution.uncertain
    let outcome: ProcessorDeliveryOutcome = { state: "refused", reason: "native-refused" }
    for (const receipt of execution.receipts) {
      if (receipt.answered) continue
      const lost = receipt.attempts.includes("uncertain")
      uncertain ||= lost
      outcome = lost ? { state: "unconfirmed" } : { state: "refused", reason: receipt.reason ?? "native-refused" }
      answerReceipt(receipt, outcome)
    }
    const target = targets.get(execution.key)
    if (target) {
      const final: ProcessorDeliveryOutcome = uncertain ? { state: "unconfirmed" } : outcome
      target.exhausted = new Map([...execution.receipts.map((receipt) => receipt.contentKey), ...execution.contentKey === undefined ? [] : [execution.contentKey]]
        .map((contentKey): [string, ProcessorDeliveryOutcome] => [contentKey, final]))
    }
    if (!noIncident) joinIncident(execution.key, uncertain ? "unconfirmed" : "refused")
    if (target?.deferredFollowers) settledKeys.add(execution.key)
  }
  const refusalReason = (execution: Execution, reason: ProcessorRefusal) => {
    for (const receipt of execution.receipts) receipt.reason = reason
  }

  const leaveFlight = (target: TargetExecutions, execution: Execution) => {
    target.inflight.delete(execution.sequence)
    if (target.inflight.size === 0) active.delete(execution.key)
  }
  // `reevaluate` is false for a refusal: it must not retry itself in a loop.
  const settle = (execution: Execution, state: ExecutionSettlement, reevaluate = true) => {
    if (!unsettled(execution)) return
    execution.state = state
    const target = targets.get(execution.key)
    if (target) {
      const flying = target.inflight.get(execution.sequence) === execution
      const held = flying || target.refused.delete(execution) || target.patch === execution || target.queuedPatch === execution
      if (flying) {
        leaveFlight(target, execution)
        if (state === "applied") {
          for (const [id, value] of execution.values) {
            target.live.set(id, value)
            target.liveOrder.set(id, execution.order)
          }
          if (!target.applied || execution.order >= appliedOrder(target.applied)) target.applied = execution
        }
      }
      if (target.patch === execution) target.patch = undefined
      if (target.queuedPatch === execution) target.queuedPatch = undefined
      if (held && (reevaluate && unreconciled.has(execution.key) || target.deferredFollowers)) settledKeys.add(execution.key)
    }
  }
  // Native took the record as proven (a frame, a status, a resolution): its attempts are proofs, and what the target
  // is now proven to hold decides every request.
  const prove = (execution: Execution) => {
    finishAttempt(execution, "proved")
    resolveReceipts(execution.key, execution)
  }
  // A batch a publication dropped or an attempt that is not one (a transient refusal): it stays desired and is sent
  // again at the next recovery offer, with its attempts untouched.
  const keep = (target: TargetExecutions, execution: Execution) => {
    leaveFlight(target, execution)
    execution.state = "refused"
    target.refused.add(execution)
  }
  // The parameters of a batch that no newer dispatch carries and no newer desired edit sets to another value. Values
  // are absolute, so an older one must not replace a newer one; an equal one is the newer value.
  const carriedValues = (target: TargetExecutions, execution: Execution) => {
    const desired = entries.get(execution.key)?.desired
    return new Map([...execution.values].filter(([id, value]) => {
      const newer = desired && desired.order > execution.order ? desired.content.values?.[id] : undefined
      return target.carriers.get(id) === execution && (newer === undefined || newer === value)
    }))
  }
  // A refused batch is sent again for what it still carries; none left, it is superseded.
  const resendable = (target: TargetExecutions, execution: Execution): ProcessorReconcile[] => {
    const carried = carriedValues(target, execution)
    if (carried.size === 0) {
      settle(execution, "cancelled")
      return []
    }
    execution.values = carried
    return [{ resend: execution }]
  }
  const recoverFollowers = (target: TargetExecutions) => {
    const recovered: Execution[] = []
    target.deferredFollowers = undefined
    for (const receipt of target.receipts) {
      const desired = entries.get(receipt.key)?.desired
      const spec = receipt.edit ? currentSpec(receipt.key) ?? receipt.spec : receipt.spec
      if (receipt.join || receipt.carrier || !spec.instrument || !target.instrument
        || target.installedIncarnation !== receipt.incarnation
        || spec.instrument.incarnation !== receipt.incarnation
        || nativeSynthStructureKey(target.instrument) !== nativeSynthStructureKey(spec.instrument.state)) continue
      if (target.inflight.size > 0 || target.queuedPatch || target.patch && unsettled(target.patch)) {
        target.deferredFollowers = true
        break
      }
      const order = receipt.edit ? Math.max(receipt.order, desired?.order ?? -1, delivered.get(receipt.key)?.order ?? -1) : -1
      const edit = receipt.edit && (desired?.order === order ? desired : delivered.get(receipt.key)?.edit ?? receipt.edit)
      const content = edit?.content.params ? { ...edit.content, params: edit.content.params } : undefined
      const execution: Execution = { key: receipt.key, editId: edit?.id ?? receipt.key, order,
        kindId: SYNTH_KIND_ID, epoch: 0, revision: 0, sequence: 0, attempt: ++attempts, sent: false,
        strategy: { kind: "urgent", sequence: 0 }, values: new Map(Object.entries(spec.values)),
        state: "refused", spec, contentKey: contentKeyOf(spec),
        content, receipts: [receipt] }
      receipt.carrier = execution
      target.latest = execution
      for (const id of execution.values.keys()) target.carriers.set(id, execution)
      target.refused.add(execution)
      recovered.push(execution)
    }
    return recovered
  }
  // A publication changed the binding, or an attempt of this controller ended without one (and with it whatever
  // native refused over: a stale stamp, a prepared core). Each refused batch is offered once per such event.
  const reoffer = () => [...targets.values()].flatMap((target) => {
    target.exhausted = undefined
    if (target.queuedPatch) target.queuedPatch.held = undefined
    recoverFollowers(target)
    return [...target.refused].flatMap((execution) => resendable(target, execution))
  })
  const dropTarget = (key: string) => {
    const target = targets.get(key)
    for (const execution of [...target?.inflight.values() ?? [], ...target?.refused ?? [], target?.patch, target?.queuedPatch])
      if (execution) settle(execution, "cancelled", false)
    ended.add(key)
    delivered.delete(key)
    for (const receipt of target?.receipts ?? []) answerReceipt(receipt, { state: "unavailable" })
    if (fence.kind === "claimed" && fence.carrier?.key === key) setFence({ kind: "claimed", token: fence.token })
    if (fence.kind === "uncertain" && fence.target === key) setFence({ kind: "open" })
    leaveIncident(key)
    targets.delete(key)
    active.delete(key)
    unreconciled.delete(key)
  }
  // A publication kept or cancelled every batch queued before it. The decision
  // of the revision native shows (or Inspect says published) applies before that
  // frame is judged for proof. A lower prepared revision was abandoned: native
  // re-stamps a queued batch at most once, because Prepare answers publish-pending
  // while a graph control is queued. Patches are not in flight: a publication cannot cancel one.
  const decide = (revision: number) => {
    const decision = decisions.find((candidate) => candidate.revision === revision)
    for (let index = decisions.length - 1; index >= 0; index--) if ((decisions[index]?.revision ?? 0) <= revision) decisions.splice(index, 1)
    if (!decision) return
    for (const key of active) for (const execution of targets.get(key)?.inflight.values() ?? []) {
      if ((execution.rebound ?? execution.revision) >= decision.revision) continue
      if (decision.retains(key, execution.values.keys())) execution.rebound = decision.revision
      else {
        const target = targets.get(key)
        if (target) keep(target, execution)
      }
    }
  }
  const write = (instanceId: string, entry: ProcessorEntry | undefined) => {
    if (entry) entries.set(instanceId, entry)
    else entries.delete(instanceId)
  }
  const sameIncarnation = (left: ProcessorDesired["target"], right: ProcessorDesired["target"]) =>
    left.incarnation === right.incarnation && left.kindId === right.kindId
  // The values a state carries are a function of its bytes: a desired whose state is the installed one says what
  // the installed values are.
  const learnInstalledValues = (target: TargetExecutions, desired: ProcessorDesired) => {
    if (target.state !== undefined && desired.content.values && bytesText(desired.content.state) === target.state) {
      target.installedValues = new Map(Object.entries(desired.content.values))
      target.installedTiming = desired.content.timing
    }
  }
  // The only place a desired value is written. The applied baseline carries
  // over within an incarnation and ends with it.
  const setDesired = (previous: ProcessorEntry | undefined, desired: ProcessorDesired) => {
    const applied = previous && sameIncarnation(previous.target, desired.target) ? previous.applied : undefined
    write(desired.target.instanceId, { target: desired.target, desired, ...(applied && { applied }) })
    const target = targetFor(desired.target.instanceId, desired.target.kindId)
    if (target.registryIncarnation !== undefined && target.registryIncarnation !== desired.target.incarnation) {
      // Registry retirement ends edit ordering, not native's retained history slot.
      // This identity outlives the desired entry consumed by publication. Keep
      // known overrides and pending batches so fresh desired content must replace them.
      target.latest = undefined
      target.applied = undefined
      if (target.gestureIncarnation !== desired.target.incarnation) {
        target.gesture = undefined
        target.gestureIncarnation = undefined
      }
      delivered.delete(desired.target.instanceId)
      unreconciled.delete(desired.target.instanceId)
      leaveIncident(desired.target.instanceId)
      for (const receipt of target.receipts) if (receipt.incarnation !== desired.target.incarnation)
        answerReceipt(receipt, { state: "unavailable" })
    }
    target.registryIncarnation = desired.target.incarnation
    learnInstalledValues(target, desired)
  }
  const setInstalled = (key: string, content: InstalledContent) => {
    const target = targetFor(key, content.kindId)
    target.kindId = content.kindId
    target.installedIncarnation = content.instrument ? content.incarnation : target.incarnation
    target.instrument = content.instrument
    const state = content.state && bytesText(content.state)
    // The values a state carries are a function of its bytes: the same bytes keep what was learned for them.
    if (content.values || state !== target.state) {
      target.installedValues = new Map(Object.entries(content.values ?? {}))
      target.installedTiming = content.timing
    }
    target.state = state
    const desired = entries.get(key)?.desired
    if (desired) learnInstalledValues(target, desired)
  }

  // A field needs a dispatch unless an in-flight carrier of this epoch holds exactly this value (a different one would
  // overwrite it), or nothing is in flight for it and native is proven to hold it. A sent earlier-epoch batch can
  // still apply until progress proves or drops it; cached equality cannot cover a request ordered after it.
  const needsDispatch = (target: TargetExecutions, id: string, value: number, epoch: number) => {
    const carrier = target.carriers.get(id)
    if (carrier && unsettled(carrier)) {
      if (carrier.epoch === epoch) return carrier.values.get(id) !== value
      if (carrier.sent && inFlight(carrier)) return true
    }
    // A sent batch the carrier replaced still applies after what native holds now.
    for (const execution of target.inflight.values())
      if (execution.sent && execution.values.has(id) && execution.values.get(id) !== value) return true
    return resolved(target, id) !== value
  }
  // Rule 0 (design 1.3): is the content already carried? Every field it names is either held by an in-flight carrier
  // of the same value in this epoch (the request joins the newest), or proven in force with nothing different pending.
  const coverage = (target: TargetExecutions, spec: ContentSpec, contentKey: string, epoch: number, publicationProof = false):
    { kind: "joined"; carrier: Execution } | { kind: "proven" | "publication" | "dispatch" } => {
    if (!publicationProof && [...target.receipts].some((receipt) => receipt.join)) return { kind: "publication" }
    const patches = [target.queuedPatch, target.patch].flatMap((patch) => patch && unsettled(patch) ? [patch] : [])
    if (patches.length > 0) {
      const same = patches.find((patch) => patch.contentKey === contentKey)
      return same ? { kind: "joined", carrier: same } : { kind: "dispatch" }
    }
    if (unknownOverrides(target, spec)) return { kind: "dispatch" }
    if (spec.instrument && (!target.instrument || target.installedIncarnation !== spec.instrument.incarnation
      || nativeSynthStructureKey(target.instrument) !== nativeSynthStructureKey(spec.instrument.state))) return { kind: "dispatch" }
    let newest: Execution | undefined
    for (const [id, value] of Object.entries(spec.values)) {
      if (needsDispatch(target, id, value, epoch)) return { kind: "dispatch" }
      const carrier = target.carriers.get(id)
      if (carrier && unsettled(carrier) && carrier.epoch === epoch && (!newest || newest.sequence < carrier.sequence)) newest = carrier
    }
    if (!sameStructure(target, spec) && newest?.spec?.state !== spec.state) return { kind: "dispatch" }
    return newest ? { kind: "joined", carrier: newest } : { kind: "proven" }
  }
  // L4: the one selector of a whole content's carrier. A synth is urgent; a pending patch orders everything behind
  // it; a state that differs with every value already in force is structural, so a patch; otherwise the values.
  const carrierFor = (target: TargetExecutions, spec: ContentSpec, kindId: number | undefined): "parameters" | "urgent" | "patch" => {
    if (kindId === SYNTH_KIND_ID) return "urgent"
    if ([target.queuedPatch, target.patch].some((patch) => patch !== undefined && unsettled(patch))) return "patch"
    return !sameStructure(target, spec) || unknownOverrides(target, spec) ? "patch" : "parameters"
  }

  // A patch of this desired, queued behind the one in flight. Requests for the same content are attempts of one
  // record; older content it replaces keeps its requests unanswered until this one is dispatched or proven.
  const queuePatch = (desired: ProcessorDesired, receipts: readonly Receipt[], edit?: LiveProcessorEditIdentity): Execution => {
    const key = desired.target.instanceId
    const target = targetFor(key, desired.target.kindId)
    const spec = processorContentSpec(desired.content)
    const contentKey = contentKeyOf(spec)
    const replaced = target.queuedPatch
    const linked = [...new Set([...receipts, ...replaced?.contentKey === contentKey ? replaced.receipts : []])]
    if (replaced) settle(replaced, "cancelled")
    const execution: Execution = { key, editId: desired.id, order: desired.order, kindId: desired.target.kindId,
      epoch: 0, revision: 0, sequence: 0, attempt: ++attempts, strategy: { kind: "patch" }, sent: false,
      values: new Map(Object.entries(desired.content.values ?? {})), state: "queued", desired, spec, contentKey, receipts: linked,
      ...(edit && { edit }) }
    target.queuedPatch = execution
    for (const receipt of linked) receipt.carrier = execution
    return execution
  }

  // Native keeps an override across a compatible publication, so desired content
  // that changed with no gesture (history, external writes) must be executed:
  // the fields native is not proven to hold, by the carrier that fits the whole content. Work in flight, an open
  // gesture or an execution at least as new as the desired edit wins; a deferred target
  // is evaluated again when one of its executions settles.
  const evaluate = (key: string): ProcessorReconcile | undefined => {
    const target = targets.get(key)
    const entry = entries.get(key)?.desired
    const held = unreconciled.get(key)
    const desired = entry && (!held || entry.order >= held.order) ? entry : held
    if (!desired || !target) {
      unreconciled.delete(key)
      return undefined
    }
    // A first dispatch has made nothing live yet: its settlement decides. A patch decides it too until it is
    // answered; a claimed or refused one has not put its values in force.
    if (target.inflight.size > 0 || target.refused.size > 0 || target.queuedPatch || (target.patch && unsettled(target.patch))) {
      unreconciled.set(key, desired)
      return undefined
    }
    const { latest } = target
    const spec = processorContentSpec(desired.content)
    // A newer edit wins even if it never applied: older content must not replace it.
    const newer = !!latest && (latest.order > desired.order || (latest.order === desired.order && latest.state === "applied"))
    if (newer || proves(target, spec)) {
      unreconciled.delete(key)
      return undefined
    }
    // An open gesture owns native until its closing delivery (`endGesture`).
    if (target.gesture !== undefined) {
      unreconciled.set(key, desired)
      return undefined
    }
    // Stays unreconciled until its own execution applies; a refused dispatch is retried.
    unreconciled.set(key, desired)
    // Live values cannot establish a different synth structure or registry incarnation. Only a publication can.
    if (spec.instrument && (!target.instrument || target.installedIncarnation !== spec.instrument.incarnation
      || nativeSynthStructureKey(target.instrument) !== nativeSynthStructureKey(spec.instrument.state)
      || [...target.receipts].some(receipt => receipt.join))) return undefined
    if (carrierFor(target, spec, desired.target.kindId) === "patch") {
      return { patch: queuePatch(desired, [...target.receipts].filter((receipt) => receipt.contentKey === contentKeyOf(spec))) }
    }
    const values = new Map(Object.entries(spec.values).filter(([id, value]) => resolved(target, id) !== value))
    return { desired, values }
  }
  const settledReconciles = () => {
    const executions = [...settledKeys].flatMap((key) => {
      const target = targets.get(key)
      const followers = target?.deferredFollowers ? recoverFollowers(target).flatMap(execution => resendable(target, execution)) : []
      const desired = evaluate(key)
      return [...followers, ...desired ? [desired] : []]
    })
    settledKeys.clear()
    return executions
  }
  // Every target whose content waited for an event the fence's release is: it is reconciled from its current desired.
  const afterRelease = () => {
    for (const key of unreconciled.keys()) settledKeys.add(key)
    return settledReconciles()
  }
  const reconcile = (kinds: ReadonlyMap<string, number>): ProcessorReconcile[] => {
    const result: ProcessorReconcile[] = []
    for (const key of new Set([...entries.keys(), ...unreconciled.keys()])) {
      if (kinds.get(key) !== (entries.get(key)?.desired ?? unreconciled.get(key))?.target.kindId) {
        unreconciled.delete(key)
        continue
      }
      const execution = evaluate(key)
      if (execution) result.push(execution)
    }
    return result
  }

  // Latest order wins; an older edit or an ended incarnation is refused.
  const submit = (desired: ProcessorDesired) => {
    const entry = entries.get(desired.target.instanceId)
    if (entry && (sameIncarnation(entry.target, desired.target)
      ? desired.order < entry.desired.order
      : desired.target.incarnation < entry.target.incarnation)) return false
    setDesired(entry, desired)
    return true
  }
  // Native took this content as applied. It becomes the baseline a failed newer submission falls back to.
  const baseline = (desired: ProcessorDesired) => {
    const entry = entries.get(desired.target.instanceId)
    if (entry && sameIncarnation(entry.target, desired.target) && (!entry.applied || desired.order >= entry.applied.order))
      write(desired.target.instanceId, { ...entry, applied: desired })
  }
  // The patch records the publication carries: it settles them `applied`, or ends their policy by the typed status of
  // the failure: `refused` (native said no), `unconfirmed` (a reply was lost) or `unavailable` (nothing was delivered).
  // `done` is the adoption rule: every order below `includedOrder`, and the equal one if the published bytes match.
  // Their requests are answered by what the target is then proven to hold, not by this settlement.
  const settlePatches = (
    includedOrder: number,
    matchesPublished: (desired: ProcessorDesired) => boolean,
    outcome: "applied" | "refused" | "unconfirmed" | "unavailable" = "applied",
  ): Execution[] => {
    const settled: Execution[] = []
    for (const target of targets.values()) for (const execution of [target.queuedPatch, target.patch]) {
      const desired = execution?.desired
      if (!execution || !desired || !unsettled(execution) || !(desired.order < includedOrder
        || (desired.order === includedOrder && matchesPublished(desired)))) continue
      settled.push(execution)
      if (outcome === "applied") {
        const older = target.queuedPatch === execution ? target.patch : undefined
        const carried = matchesPublished(desired)
        baseline(desired)
        if (carried) installed(target, execution)
        settle(execution, "applied")
        // The newer patch is in the graph, so what was dispatched before it is superseded, whatever its bytes.
        if (older) settle(older, "cancelled")
        // What the publication carries decides its requests: the patch's own content proves them, newer content
        // supersedes them.
        if (carried) prove(execution)
        else for (const receipt of execution.receipts) answerReceipt(receipt, { state: "superseded", by: includedOrder })
      } else {
        if (target.queuedPatch === execution) {
          if (target.patch) settle(target.patch, "cancelled")
          target.queuedPatch = undefined
          target.patch = execution
        }
        delete execution.claimed
        if (outcome === "unavailable") {
          settle(execution, "cancelled", false)
          for (const receipt of execution.receipts) answerReceipt(receipt, { state: "unavailable" })
        } else {
          if (outcome === "refused") {
            refusalReason(execution, "stage-failed")
            finishAttempt(execution, "definite-refusal")
          } else {
            finishAttempt(execution, "uncertain")
            execution.uncertain = true
          }
          settle(execution, "cancelled", false)
          endPolicy(execution)
        }
      }
      // A publication that took the place of the recovery resend is that resend's reply.
      if (fence.kind === "uncertain" && fence.target === execution.key) setFence({ kind: "open" })
    }
    return settled
  }
  // Values the installed state carries are in force. Carriers of older edits that held different ones are gone
  // with the overrides the install zeroed; a newer dispatch lands after the install and keeps its own.
  // A refused batch whose every value the install carries is in force with it, so it needs no further offer.
  const installed = (target: TargetExecutions, execution: Execution) => {
    const order = appliedOrder(execution)
    const state = execution.materialized ?? execution.desired
    if (state) {
      target.state = bytesText(state.content.state)
      target.installedTiming = state.content.timing
    }
    target.installedValues = new Map(execution.values)
    // The install zeroed every override of an older edit, whether or not it names the field.
    for (const id of target.live.keys()) if ((target.liveOrder.get(id) ?? -1) <= order) {
      target.live.delete(id)
      target.liveOrder.delete(id)
    }
    for (const [id, value] of execution.values) {
      target.live.set(id, value)
      target.liveOrder.set(id, order)
      const carrier = target.carriers.get(id)
      if (carrier && carrier.order <= order && carrier.values.get(id) !== value) target.carriers.delete(id)
    }
    if (!target.applied || order >= appliedOrder(target.applied)) target.applied = execution
    if (execution.materialized) baseline(execution.materialized)
    for (const refused of target.refused) if (refused.order <= order && [...refused.values].every(([id, value]) => execution.values.get(id) === value)) {
      refused.installed = true
      settle(refused, "applied")
    }
  }

  // A parameter dispatch of an edit the published graph carries, or that a newer applied edit replaced, has
  // nothing left to do. A newer desired edit that was never dispatched (a candidate's) does not replace it.
  const isSuperseded = (instanceId: string, order: number) => {
    const applied = targets.get(instanceId)?.applied
    return order < includedThrough || (!!applied && order < appliedOrder(applied))
  }

  // The claim's resolution, from a frame or from the cache a frame filled before the reply. A claimed carrier is proven
  // by an OK result and definitely refused by a failure; either way the fence opens, and the controller reconciles
  // every target that differs from what is now proven.
  const resolveClaim = (): boolean => {
    if (fence.kind !== "claimed" || !lastResolution || lastResolution.token !== fence.token) return false
    const { result } = lastResolution
    const { carrier } = fence
    lastResolution = undefined
    setFence({ kind: "open" })
    for (const target of targets.values()) target.exhausted = undefined
    const target = carrier && targets.get(carrier.key)
    if (carrier && target && target.patch === carrier && unsettled(carrier)) {
      delete carrier.claimed
      if (result === 0) {
        installed(target, carrier)
        settle(carrier, "applied")
        prove(carrier)
      } else {
        refusalReason(carrier, "claim-failed")
        finishAttempt(carrier, "definite-refusal")
        settle(carrier, "cancelled", false)
        endPolicy(carrier)
      }
    }
    return true
  }
  // A patch the lane may send for `key` while the fence is not open: only the target's one recovery resend.
  const fenceAllows = (key: string) => fence.kind === "open" || (fence.kind === "uncertain" && fence.target === key && fence.resends === 0)

  // Schedule adoption: which compiled schedule is wanted, running, waiting, kept or refused. One attempt runs at a
  // time; the newest differing intent waits behind it and replaces any older one that waited.
  let publication: PublicationRecord | undefined
  let running: AdoptionAttempt | undefined
  let latest: AdoptionWaiting | undefined
  let retained: { intent: AdoptionIntent; candidate: Candidate } | undefined
  let blocked: { intent: AdoptionIntent; fields: AdoptionFields; outcome: AdoptionRefusal; content?: string } | undefined
  // Compiles in progress, aborted when their transport domain ends or the session does.
  const compiles = new Set<AbortController>()
  const attachPublication = (record: PublicationRecord, receipt: Receipt) => {
    const content = record.content.get(receipt.key)
    if (record.phase === "ended" || receipt.answered || !content || record.cohort.has(receipt)) return
    if (receipt.join) {
      if (content.nodeId !== receipt.nodeId || content.contentKey !== receipt.contentKey
        || content.incarnation !== receipt.incarnation || content.lifetime !== receipt.lifetime) return
    } else {
      if ((targets.get(receipt.key)?.registryIncarnation ?? content.incarnation) !== receipt.incarnation
        || (receipt.spec.state !== undefined && receipt.spec.state !== (content.state && bytesText(content.state)))) return
    }
    receipt.publication = record
    record.cohort.set(receipt, receipt.attempts.length)
    receipt.attempts.push("pending")
  }
  const finishPublication = (record: PublicationRecord, finished: AdoptionOutcome,
    evidence: "promoted" | "cancelled" | "failed" | "uncertain" | "lost", reason: ProcessorRefusal = "native-refused") => {
    if (record.phase === "ended") return
    record.phase = "ended"
    if (publication === record) publication = undefined
    const outcome: AdoptionOutcome = finished.status === "superseded" && evidence === "lost" ? { status: "superseded", evidence } : finished
    record.outcome = outcome
    if (evidence === "promoted") for (const receipt of record.cohort.keys()) {
      const content = record.content.get(receipt.key)
      receipt.join = undefined
      receipt.publication = undefined
      if (content && !receipt.edit) receipt.spec = content.instrument
        ? { instrument: { state: content.instrument, incarnation: receipt.incarnation }, values: content.values ?? {} }
        : processorContentSpec({ state: content.state, timing: content.timing, values: content.values })
    }
    for (const [receipt, index] of record.cohort) {
      if (evidence === "promoted") {
        const target = targets.get(receipt.key)
        if (!target || !proves(target, receipt.spec)
          || coverage(target, receipt.spec, receipt.contentKey, receipt.carrier?.epoch ?? 0, true).kind !== "proven") {
          receipt.attempts.splice(index, 1)
          continue
        }
      }
      receipt.attempts[index] = evidence === "uncertain" ? "uncertain" : evidence === "promoted" ? "proved" : "definite-refusal"
      if (receipt.answered || evidence === "uncertain") continue
      if (evidence === "promoted") answerReceipt(receipt, { state: "applied" })
      else if (evidence === "lost") answerReceipt(receipt, { state: "unavailable" })
      else if (evidence === "cancelled") answerReceipt(receipt, { state: "refused", reason: "not-claimed" })
      else {
        const uncertain = receipt.attempts.includes("uncertain")
        const answer: ProcessorDeliveryOutcome = uncertain ? { state: "unconfirmed" } : { state: "refused", reason }
        answerReceipt(receipt, answer)
        const target = targets.get(receipt.key)
        if (target) target.exhausted = new Map([...target.exhausted ?? [], [receipt.contentKey, answer]])
        joinIncident(receipt.key, uncertain ? "unconfirmed" : "refused")
      }
    }
    if (evidence === "promoted") for (const [key, content] of record.content) {
      if (content.lifetime === undefined) continue
      const target = targets.get(key)
      for (const receipt of target?.receipts ?? [])
        if (!receipt.publication && receipt.nodeId === content.nodeId && receipt.incarnation === content.incarnation
          && receipt.lifetime !== undefined && receipt.lifetime < content.lifetime)
          answerReceipt(receipt, { state: "unavailable" })
    }
    // A transport that cancels the publication leaves its patch's content owed: the patch waits in the queue for the
    // next domain, unless a newer one is already queued. An admitted patch here never reached native: one that changes
    // latency is carried only by the publication, and one sent to native is answered, or its claim released, in the
    // lane before a publication runs.
    for (const target of targets.values()) for (const execution of [target.patch, target.queuedPatch]) {
      if (!execution || !execution.receipts.some(receipt => record.cohort.has(receipt))
        || evidence === "promoted" || evidence === "uncertain") continue
      if (evidence !== "cancelled" || (target.queuedPatch && execution !== target.queuedPatch)) settle(execution, "cancelled", false)
      else if (execution === target.patch) {
        target.patch = undefined
        execution.state = "queued"
        target.queuedPatch = execution
      }
    }
    // Re-select a follower that joined only because a structural carrier held the target.
    // Its same receipt and desired survive; only its obsolete publication-only obligation ends.
    for (const target of targets.values()) for (const receipt of target.receipts)
      if (receipt.join && !receipt.publication && receipt.spec.instrument && target.instrument
        && target.installedIncarnation === receipt.incarnation
        && nativeSynthStructureKey(receipt.spec.instrument.state) === nativeSynthStructureKey(target.instrument))
        receipt.join = undefined
    record.resolve(outcome)
    record.wake?.()
    record.transportWake?.()
    options.onTerminal?.()
  }
  const arenaRefusals = new Set(["asset-capacity-exceeded", "asset-page-capacity-exceeded"])
  const reopens = (fields: AdoptionFields) => !!blocked && (blocked.fields.host !== fields.host
    || blocked.fields.epoch !== fields.epoch || blocked.fields.structural !== fields.structural
    || blocked.fields.capacity !== fields.capacity
    || (!arenaRefusals.has(blocked.outcome.reason) && blocked.fields.settled !== fields.settled))
  const waiting = (intent: AdoptionIntent, explicit: boolean): AdoptionWaiting => {
    let resolve: (outcome: AdoptionOutcome) => void = () => {}
    const settled = new Promise<AdoptionOutcome>((done) => { resolve = done })
    return { intent, explicit, settled, resolve }
  }
  const takeRetainedOut = () => {
    const held = retained?.candidate
    retained = undefined
    return held
  }
  const abortCompiles = () => {
    const reason = new NativePlaybackAbortError("ownership-invalidated")
    for (const abort of compiles) {
      compiles.delete(abort)
      abort.abort(reason)
      options.onTerminal?.()
    }
  }
  // The attempt that was running no longer is: its caller stops where it stands when it next asks the owner. One whose
  // publication native may already hold stays, and is answered with what native did.
  const cancelIntents = (publicationHeld = false) => {
    abortCompiles()
    if (!publicationHeld) {
      const attempt = running
      if (attempt?.publication) finishPublication(attempt.publication, { status: "superseded" }, "lost")
      running?.resolve({ status: "superseded" })
      running = undefined
      if (attempt) options.onTerminal?.()
    }
    latest?.resolve({ status: "superseded" })
    latest = undefined
  }
  // Opens `next` unless native's refusal of the same schedule in the same context still stands: that waits for a field
  // to change, or for an explicit request, which also forgets the content that failed. An intent that differs only in
  // what the attempt folds in at its seam (the projection key beyond the schedule) is answered with the refusal and
  // becomes the intent a changed field retries. The refusal stays across another schedule's attempt, as that schedule
  // may compile the content native refused. A candidate belongs to the intent that compiled it.
  const admit = (next: AdoptionWaiting, fields: AdoptionFields): AdoptionStart<Candidate> | undefined => {
    if (next.explicit) blocked = undefined
    else if (blocked && next.intent.schedule === blocked.intent.schedule && sameContext(next.intent, blocked.intent)
      && !reopens(fields)) {
      blocked = { ...blocked, intent: next.intent }
      next.resolve(blocked.outcome)
      return undefined
    }
    const dispose = retained && !sameIntent(retained.intent, next.intent) ? takeRetainedOut() : undefined
    running = { ...next, fields }
    return { attempt: running, dispose }
  }

  const refreshPublication = (record: PublicationRecord) => {
    record.content = new Map([...record.content].map(([key, value]) => [key, { ...value,
      incarnation: value.incarnation ?? targets.get(key)?.incarnation,
      lifetime: targets.get(key)?.structural?.lifetime }]))
    for (const target of targets.values()) for (const receipt of target.receipts) attachPublication(record, receipt)
  }

  return {
    capturePublication: (attempt: AdoptionAttempt | undefined, content: ReadonlyMap<string, InstalledContent>) => {
      if (publication) throw new Error("A publication already owns the native bank.")
      let resolve: (outcome: AdoptionOutcome) => void = () => {}
      const terminal = new Promise<AdoptionOutcome>(done => { resolve = done })
      const record: PublicationRecord = { kind: attempt ? "schedule" : "latency", resubmits: 0, phase: "prepared", cancelled: false, terminal, resolve,
        content, cohort: new Map() }
      publication = record
      if (attempt) attempt.publication = record
      refreshPublication(record)
      return record
    },
    finishPublication,
    refreshPublication,
    retirement: () => retirement,
    holdRetirement: (held: RetirementObligation) => { retirement = held },
    observeRetirement: (reply: NativeRevisionReply) => {
      const held = retirement
      if (!held || !reply.ok || reply.hostPid !== held.hostPid
        || reply.hostGeneration !== held.binding.hostGeneration) return
      const status = reply.revision
      if (status.status === "publish-pending" || status.status === "retirement-not-safe"
        || status.activeRevision === held.binding.revision || status.preparedRevision === held.binding.revision
        || (status.status !== "retired" && status.retiredRevision === held.binding.revision)) return
      finishRetirement(held)
    },
    publication: () => publication,
    cancelPublication: () => {
      const record = publication
      if (record && record.phase !== "ended") { record.cancelled = true; record.wake?.() }
    },
    disposedCandidate: () => options.onTerminal?.(),
    reconcile,
    submit,
    settlePatches,
    reoffer,
    isSuperseded,
    // The published graph carries every edit below `order` (a configured session, an adopted publication), and holds
    // `installed` for each target it carries: what native is proven to hold when the session starts.
    configured: (order: number, content: ReadonlyMap<string, InstalledContent>) => {
      includedThrough = order
      for (const [key, installedContent] of content) setInstalled(key, installedContent)
    },
    includedOrder: () => includedThrough,
    hasQueuedPatch: () => [...targets.values()].some((target) => target.queuedPatch),
    // Immutable view for materialization.
    capture: (): ReadonlyMap<string, ProcessorDesired> =>
      new Map([...entries].map(([instanceId, entry]) => [instanceId, entry.desired])),

    // L1/L4. A request for content, registered synchronously with its answer: a different content pending continues,
    // the same content in flight is joined, content native is proven to hold is applied now with nothing dispatched,
    // and anything else gets the one carrier that fits the whole content. The edit id is lineage and decides nothing.
    deliver: (input: DeliverInput): Delivery => {
      const spec: ContentSpec = input.instrument
        ? { instrument: { state: input.instrument, incarnation: input.incarnation }, values: nativeSynthValues(input.instrument) }
        : processorContentSpec({ state: input.state, timing: input.edit?.content.timing, values: input.values })
      const contentKey = contentKeyOf(spec)
      ended.delete(input.key)
      const target = targetFor(input.key, input.kindId)
      const receipt = newReceipt(target, { key: input.key, order: input.order, incarnation: input.incarnation,
        nodeId: input.edit?.target.nodeId, spec, contentKey })
      receipt.edit = input.edit
      const accepted = input.desired
        ? submit(input.desired)
        : input.order < 0 || input.order >= (delivered.get(input.key)?.order ?? -1)
      if (accepted && (input.order >= 0 || !delivered.has(input.key))) delivered.set(input.key, { order: input.order, spec, edit: input.edit })
      const exhausted = target.exhausted?.get(contentKey)
      if (exhausted && !proves(target, spec)) {
        answerReceipt(receipt, exhausted)
        return { receipt, plan: { carrier: "none" } }
      }
      if (!exhausted) target.exhausted = undefined
      const cover = coverage(target, spec, contentKey, input.epoch)
      if (cover.kind === "proven") {
        answerReceipt(receipt, { state: "applied" })
        clearIncident(input.key)
        return { receipt, plan: { carrier: "none" } }
      }
      if (cover.kind === "joined") {
        if (!cover.carrier.receipts.includes(receipt)) cover.carrier.receipts.push(receipt)
        receipt.carrier = cover.carrier
        return { receipt, plan: { carrier: "none" } }
      }
      if (cover.kind === "publication") {
        receipt.join = true
        if (publication) attachPublication(publication, receipt)
        return { receipt, plan: { carrier: "publication" } }
      }
      // A registry synth still uses deliverProcessor for structural work. Eight live fields cannot establish its
      // non-live state or a different prepared identity; the publication carries this edit's incarnation and key.
      if (spec.instrument && (!input.preparedInstrument || !target.instrument
        || target.installedIncarnation !== input.incarnation
        || nativeSynthStructureKey(target.instrument) !== nativeSynthStructureKey(spec.instrument.state))) {
        receipt.join = true
        if (publication) attachPublication(publication, receipt)
        return { receipt, plan: { carrier: "publication" } }
      }
      const newer = entries.get(input.key)?.desired
      // Only newer, different content supersedes (§1.2): an older request the newer desired also names still owns its carrier.
      const newerSpec = newer && processorContentSpec(newer.content)
      const replaced = !accepted && !(newerSpec && (spec.state === undefined || spec.state === newerSpec.state)
        && Object.entries(spec.values).every(([id, value]) => newerSpec.values[id] === value))
      if (replaced || (input.order >= 0 && isSuperseded(input.key, input.order))) {
        const by = replaced ? newer?.order ?? delivered.get(input.key)?.order ?? input.order : Math.max(includedThrough, input.order)
        answerReceipt(receipt, { state: "superseded", by })
        return { receipt, plan: { carrier: "none" } }
      }
      const carrier = carrierFor(target, spec, input.kindId)
      if (carrier === "patch" && input.desired) return { receipt, plan: { carrier, execution: queuePatch(input.desired, [receipt], input.edit) } }
      // A pending patch replaces what native holds, so values that merely equal the installed ones are not in force behind it.
      const behindPatch = carrier === "patch"
      const values = new Map(Object.entries(spec.values).filter(([id, value]) => behindPatch || needsDispatch(target, id, value, input.epoch)))
      return { receipt, plan: { carrier: carrier === "urgent" ? "urgent" : "parameters", values } }
    },
    // A request the controller could not dispatch at all (no session, an ended target): nothing is owed.
    answer: answerReceipt,
    // A structural join: answered by the adoption that carries the target, or by the end of the target or session.
    join: (key: string, order: number, contentKey: string, lifetime: number, nodeId?: string): Receipt => {
      const target = targetFor(key, undefined)
      if (nodeId && (!target.structural || lifetime >= target.structural.lifetime)) target.structural = { lifetime }
      const receipt = newReceipt(target, { key, order, incarnation: target.incarnation, nodeId, lifetime, spec: { values: {} }, contentKey, join: true })
      if (publication) attachPublication(publication, receipt)
      return receipt
    },
    // Receipts nobody has answered yet: the drain reports them, and never waits for them with a timer.
    unanswered: (): ReceiptHandle[] => [...targets.values()].flatMap((target) => [...target.receipts].map(receiptHandle)),

    // A gesture owns native for its target until its closing delivery; a mismatched close is not that gesture's.
    holdGesture: (key: string, token: string, incarnation?: number) => {
      const target = targetFor(key, undefined)
      target.gesture = token
      target.gestureIncarnation = incarnation
    },
    endGesture: (key: string, token: string): ProcessorReconcile[] => {
      const target = targets.get(key)
      if (!target || target.gesture !== token) return []
      target.gesture = undefined
      target.gestureIncarnation = undefined
      const reconcile = unreconciled.has(key) ? evaluate(key) : undefined
      return reconcile ? [reconcile] : []
    },

    // The next patch to send, with the newest content registered for its target: a gesture that registered after the
    // patch was queued has the newer state, and installing the patch's own would zero that gesture's overrides.
    // Must run in the turn that sends it. `prepare` returns the content to send, timed for now, or undefined to leave
    // the target's patch queued. While a claim is unresolved nothing is sent; after a lost reply, only the target's
    // one recovery resend.
    nextPatch: (prepare: (desired: ProcessorDesired) => ProcessorDesired | undefined): { execution: Execution; desired: ProcessorDesired } | undefined => {
      for (const [key, target] of targets) {
        const execution = target.queuedPatch
        const submitted = execution?.desired
        // Native applies a staged patch before draining queued parameter batches in the callback.
        // An earlier admitted batch could therefore overwrite this newer state. Its progress/refusal
        // is the event that permits this target's patch; an ACK alone cannot release it.
        if (!execution || !submitted || execution.held || !fenceAllows(key) || target.inflight.size > 0) continue
        const ledger = entries.get(key)?.desired
        const latest = target.latest
        if (ledger && !sameIncarnation(ledger.target, submitted.target)) {
          settle(execution, "cancelled")
          continue
        }
        const newest = latest && latest.order > Math.max(submitted.order, ledger?.order ?? -1) ? latest : undefined
        if (newest && !newest.content?.state) {
          // Nothing could have been built for that edit either: it replaces this one.
          settle(execution, "cancelled")
          continue
        }
        const chosen: ProcessorDesired = newest?.content?.state
          ? { ...submitted, id: newest.editId, order: newest.order,
            content: { state: newest.content.state, params: newest.content.params, values: newest.content.values, timing: newest.content.timing } }
          : ledger && ledger.order > submitted.order ? ledger : submitted
        const desired = prepare(chosen)
        if (!desired) continue
        // The newest edit is what is desired from here on, wherever it was registered.
        if (newest) submit(desired)
        target.queuedPatch = undefined
        if (target.patch) settle(target.patch, "cancelled")
        target.patch = execution
        // What is sent is the newest content: requests for it join this record, and what is older is superseded.
        const spec = processorContentSpec(desired.content)
        const contentKey = contentKeyOf(spec)
        Object.assign(execution, { materialized: desired, values: new Map(Object.entries(desired.content.values ?? {})), sent: true,
          state: "admitted", attempt: ++attempts, spec, contentKey })
        for (const receipt of target.receipts) if (receipt.contentKey === contentKey && !execution.receipts.includes(receipt)) execution.receipts.push(receipt)
        supersedeOlder(target, execution, desired.order)
        for (const receipt of execution.receipts) {
          receipt.attempts.push("pending")
          receipt.carrier = execution
        }
        if (fence.kind === "uncertain") setFence({ ...fence, resends: 1 })
        return { execution, desired }
      }
      return undefined
    },
    // The typed reply to a dispatched patch (design 2.4.6). Only a reply for the carrier the ledger still holds moves
    // the fence: after `clear` a late reply for a disposed carrier changes nothing.
    patchReplied: (execution: Execution, reply: PatchReply): ProcessorReconcile[] => {
      const target = targets.get(execution.key)
      if (!target || target.patch !== execution || !unsettled(execution)) return []
      const resend = fence.kind === "uncertain" && fence.target === execution.key
      let opened = false
      const requeue = (settledFence: PatchFence) => {
        target.patch = undefined
        execution.state = "queued"
        target.queuedPatch = execution
        setFence(settledFence)
      }
      if (reply.kind === "applied") {
        installed(target, execution)
        settle(execution, "applied")
        prove(execution)
        if (resend) setFence({ kind: "open" })
      } else if (reply.kind === "claimed") {
        execution.claimed = true
        for (const id of execution.values.keys()) target.live.set(id, undefined)
        setFence({ kind: "claimed", token: reply.token, carrier: execution })
        opened = resolveClaim()
      } else if (reply.kind === "refused" && reply.refusal === "claim-pending" && reply.token !== undefined) {
        // Native holds a claim this lane does not: one whose reply was lost, or an earlier session state's. This send
        // was not taken, and says nothing about its content; it waits for the claim's resolution.
        requeue({ kind: "claimed", token: reply.token })
        opened = resolveClaim()
      } else if (reply.kind === "refused" && reply.transient) {
        requeue(resend ? { kind: "uncertain", target: execution.key, resends: 0 } : fence)
        execution.held = true
      } else if (reply.kind === "refused" && reply.refusal === "not-claimed" && !execution.retried) {
        execution.retried = true
        finishAttempt(execution, "definite-refusal")
        requeue(fence)
      } else if (reply.kind === "refused") {
        refusalReason(execution, reply.refusal)
        finishAttempt(execution, "definite-refusal")
        settle(execution, "cancelled", false)
        endPolicy(execution)
        if (fence.kind === "uncertain") setFence({ kind: "open" })
      } else if (reply.kind === "unavailable") {
        settle(execution, "cancelled", false)
        for (const receipt of execution.receipts) answerReceipt(receipt, { state: "unavailable" })
        if (fence.kind === "uncertain") setFence({ kind: "open" })
      } else {
        // Lost or thrown: native may have taken it and nothing proves it.
        finishAttempt(execution, "uncertain")
        execution.uncertain = true
        if (resend && fence.kind === "uncertain" && fence.resends === 1) {
          settle(execution, "cancelled", false)
          endPolicy(execution)
          setFence({ kind: "open" })
        } else {
          const lost = execution
          settle(lost, "cancelled", false)
          const desired = entries.get(lost.key)?.desired
          const spec = desired && processorContentSpec(desired.content)
          // Nothing to resend when the target ended, or native is proven to hold the desired already: the fence opens,
          // and an ended target has nothing left to be an incident about.
          const gone = ended.has(lost.key)
          if (desired && spec && !gone && !proves(target, spec)) {
            setFence({ kind: "uncertain", target: lost.key, resends: 0 })
            const receipts = [...target.receipts].filter((receipt) => receipt.contentKey === contentKeyOf(spec) || lost.receipts.includes(receipt))
            queuePatch(desired, receipts)
          } else {
            setFence({ kind: "open" })
            endPolicy(lost, gone)
          }
        }
      }
      return opened ? afterRelease() : settledReconciles()
    },
    // The claim named by a frame resolved. True when the fence opened, and every target should be reconciled.
    resolution: (token: bigint, result: number): ProcessorReconcile[] => {
      lastResolution = { token, result }
      return resolveClaim() ? afterRelease() : []
    },
    fence: (): PatchFence => fence,
    // Native refuses a prepare while a claim is unreported, so the lane sends none until the claim resolves. A lost
    // reply holds no claim the lane knows of: the recovery resend is itself on the lane, ahead of any prepare.
    released: (): Promise<void> => fence.kind === "claimed"
      ? new Promise<void>((resolve) => { claimWaiters.push(resolve) })
      : Promise.resolve(),
    // A patch that was never sent returns its desired to the applied baseline, unless a newer submission already
    // replaced it.
    abandon: (execution: Execution, outcome: ProcessorDeliveryOutcome = { state: "unavailable" }): ProcessorReconcile[] => {
      const desired = execution.desired
      const entry = desired && entries.get(desired.target.instanceId)
      if (entry && entry.desired === desired) {
        if (entry.applied) setDesired(entry, entry.applied)
        else write(entry.target.instanceId, undefined)
      }
      settle(execution, "cancelled")
      for (const receipt of execution.receipts) answerReceipt(receipt, outcome)
      return settledReconciles()
    },
    // A parameter or urgent dispatch was refused or lost (design 1.6). The completion that learned it acts on the
    // answer in the same turn: `retry` (the one retry), `ladder` (a patch of the current desired), `waiting` (a transient
    // refusal: an adoption or a domain end offers it again) or `ended` (the policy is over: rule e).
    refuse: (execution: Execution, kind: RefusalKind, reason: ProcessorRefusal = "native-refused"): RefusalAction => {
      const target = targets.get(execution.key)
      if (!target || target.inflight.get(execution.sequence) !== execution) return "ended"
      if (kind === "transient") {
        keep(target, execution)
        return "waiting"
      }
      finishAttempt(execution, kind === "uncertain" ? "uncertain" : "definite-refusal")
      if (kind === "uncertain") execution.uncertain = true
      else refusalReason(execution, reason)
      keep(target, execution)
      if (!execution.retried) {
        execution.retried = true
        // What a newer dispatch or desired edit carries is not sent again; with nothing left the record is done.
        return resendable(target, execution).length > 0 ? "retry" : "waiting"
      }
      const desired = entries.get(execution.key)?.desired
      if (kind === "definite" && execution.strategy.kind === "parameters" && !execution.uncertain && !execution.laddered
        && target.gesture === undefined && desired) {
        execution.laddered = true
        queuePatch(desired, [...execution.receipts, ...[...target.receipts].filter((receipt) => receipt.contentKey === contentKeyOf(processorContentSpec(desired.content)))])
        return "ladder"
      }
      endPolicy(execution)
      return "ended"
    },
    settledReconciles,
    // Registered when the sequence is allocated, before the bridge call.
    register: (
      input: Pick<Execution, "key" | "editId" | "order" | "kindId" | "sequence" | "strategy" | "values" | "content"> & Partial<Pick<Execution, "spec" | "receipts">>,
      binding: Pick<Execution, "epoch" | "revision">,
    ): Execution => {
      const target = targetFor(input.key, input.kindId)
      const spec = input.spec ?? processorContentSpec({ values: Object.fromEntries(input.values) })
      const execution: Execution = { ...input, ...binding, attempt: ++attempts, sent: false, state: "queued", spec,
        contentKey: contentKeyOf(spec), receipts: input.receipts ? [...input.receipts] : [...target.receipts].filter((receipt) => receipt.contentKey === contentKeyOf(spec)) }
      target.inflight.set(execution.sequence, execution)
      target.latest = execution
      for (const id of input.values.keys()) target.carriers.set(id, execution)
      active.add(input.key)
      return execution
    },
    // A batch sent before a publication is dispatched again on its successor: a new sequence and binding, the
    // same record, so whoever waits for it follows it.
    rebind: (execution: Execution, binding: Pick<Execution, "epoch" | "revision">, sequence: number) => {
      const target = targets.get(execution.key)
      if (target?.inflight.get(execution.sequence) === execution) target.inflight.delete(execution.sequence)
      target?.refused.delete(execution)
      Object.assign(execution, binding, { sequence, attempt: ++attempts, sent: false, state: "queued", rebound: undefined })
      target?.inflight.set(sequence, execution)
      active.add(execution.key)
    },
    // The controller is about to hand the batch to the bridge, in this synchronous turn: from here native
    // progress can prove it. Its sequences are allocated in send order, so a floor reached by anything sent
    // earlier is below them. False if the record was settled while the send waited.
    send: (execution: Execution, sequence: number, urgentSequence?: number) => {
      if (!inFlight(execution)) return false
      const target = targets.get(execution.key)
      if (target?.inflight.get(execution.sequence) === execution && execution.sequence !== sequence) {
        target.inflight.delete(execution.sequence)
        target.inflight.set(sequence, execution)
      }
      execution.sequence = sequence
      if (urgentSequence !== undefined) execution.strategy = { kind: "urgent", sequence: urgentSequence }
      execution.sent = true
      for (const receipt of execution.receipts) {
        receipt.attempts.push("pending")
        receipt.carrier = execution
      }
      if (target) supersedeOlder(target, execution, execution.order)
      return true
    },
    // The queue ACK. Native may already have applied it: a progress frame can precede the reply.
    admit: (execution: Execution) => {
      if (execution.state === "queued") execution.state = "admitted"
    },
    // The controller learned the batch never reached native: nothing was delivered, so nothing is owed.
    // `retry` is false for a reconcile's own cancellation, which must not retry itself in a loop; otherwise content
    // that waited behind it is evaluated again.
    cancel: (execution: Execution, retry: boolean, outcome: ProcessorDeliveryOutcome = { state: "unavailable" }): ProcessorReconcile[] => {
      settle(execution, "cancelled", retry)
      for (const receipt of execution.receipts) answerReceipt(receipt, outcome)
      return settledReconciles()
    },
    // The target ended (the registry retired it): what it was owed is unavailable and it leaves the incident.
    retire: (key: string) => {
      const target = targets.get(key)
      ended.add(key)
      for (const receipt of target?.receipts ?? []) answerReceipt(receipt, { state: "unavailable" })
      leaveIncident(key)
    },
    hasEnded: (key: string) => ended.has(key),
    // A parameter flush of the target's latest edit joins nothing here: `deliver` decides that by content.
    // The proof entry. A frame of another epoch shows an urgent event dropped:
    // native drops one whose epoch is not the applied one, and a later live note
    // could lift a floor over it. A parameter batch is checked against the
    // transport epoch at admission, so only a newer epoch shows it was dropped
    // at drain; a frame of an older one says nothing about it. A dropped record is
    // answered by being sent again, not cancelled: the session is still there.
    // Returns the reconciles that settling or dropping unblocked.
    observe: (progress: NativeScheduleProgress): ProcessorReconcile[] => {
      if (progress.progressSequence < lastProgress) return []
      lastProgress = progress.progressSequence
      decide(progress.revision)
      const redispatch: Execution[] = []
      const proven: Execution[] = []
      for (const key of active) for (const execution of targets.get(key)?.inflight.values() ?? []) {
        const parameters = execution.strategy.kind === "parameters"
        // An unsent record waits for the frame that shows its epoch applied.
        if (!execution.sent) { if (progress.epoch >= execution.epoch) redispatch.push(execution) }
        // The domain moved on and native dropped the batch: the same edit is sent again, once.
        else if (parameters ? progress.epoch > execution.epoch : progress.epoch !== execution.epoch) redispatch.push(execution)
        else if (progress.epoch !== execution.epoch) continue
        else if (execution.strategy.kind === "urgent") {
          if (progress.appliedUrgentSequence >= BigInt(execution.strategy.sequence)) { settle(execution, "applied"); proven.push(execution) }
        } else if (progress.revision > (execution.rebound ?? execution.revision)) {
          const target = targets.get(key)
          if (target) keep(target, execution)
        } else if (progress.appliedProcessorSequence >= BigInt(execution.sequence)) { settle(execution, "applied"); proven.push(execution) }
      }
      for (const execution of proven) prove(execution)
      const redispatched = redispatch.flatMap((execution) => {
        const target = targets.get(execution.key)
        return target ? resendable(target, execution) : []
      })
      return [...redispatched, ...settledReconciles()]
    },
    // The transport epoch moved on with the session kept. What was never sent now waits for a frame of the new
    // epoch, and a refused batch is offered once more on it. Nothing is sent from here: native admits a batch
    // against its last queued SetTransport, but a callback that began before that command still drains the lane
    // under the older epoch and drops it. Admitted batches are judged by the frames.
    // The attempt running in the domain that ended is aborted and its candidate, compiled for that domain's epoch,
    // is returned to dispose. An intent waiting behind it, and a refusal, carry into the next domain.
    endDomain: (epoch: number) => {
      for (const target of targets.values()) {
        recoverFollowers(target)
        target.exhausted = undefined
        if (target.queuedPatch) target.queuedPatch.held = undefined
        for (const execution of target.inflight.values()) if (!execution.sent) execution.epoch = epoch
        for (const execution of target.refused) {
          target.refused.delete(execution)
          Object.assign(execution, { epoch, sent: false, state: "queued", retried: undefined, uncertain: undefined })
          target.inflight.set(execution.sequence, execution)
          active.add(execution.key)
        }
      }
      abortCompiles()
      return takeRetainedOut()
    },
    // The attempt for `intent`. `start` is set when the caller must run it; otherwise the answer is that of an attempt
    // already running or waiting for the same intent, or the refusal still standing for it. An explicit request
    // retries a refusal.
    submitAdoption: (intent: AdoptionIntent, explicit: boolean, fields: AdoptionFields): AdoptionSubmission<Candidate> => {
      if (running && sameIntent(running.intent, intent)) {
        // Back to the running intent: what waited behind it is no longer wanted. An explicit ask forgets the refusal
        // as an admitted one does, and joins the attempt instead of compiling again.
        if (explicit) blocked = undefined
        latest?.resolve({ status: "superseded" })
        latest = undefined
        return { settled: running.settled }
      }
      if (latest && sameIntent(latest.intent, intent)) {
        if (explicit) latest = { ...latest, explicit }
        return { settled: latest.settled }
      }
      const next = waiting(intent, explicit)
      if (running) {
        latest?.resolve({ status: "superseded" })
        latest = next
        return { settled: next.settled }
      }
      return { settled: next.settled, start: admit(next, fields) }
    },
    // The candidate this intent kept when native refused its publication, if no domain has ended since.
    takeRetained: (intent: AdoptionIntent) => retained && sameIntent(retained.intent, intent) ? takeRetainedOut() : undefined,
    retainCandidate: (attempt: AdoptionAttempt, candidate: Candidate) => {
      if (running !== attempt || retained) return false
      retained = { intent: attempt.intent, candidate }
      return true
    },
    // A compile's result is used unless it was cancelled or a newer intent waits behind it that changes what is
    // published: the schedule, or the context it was compiled with.
    isNewest: (attempt: AdoptionAttempt) => running === attempt
      && (!latest || (latest.intent.schedule === attempt.intent.schedule && sameContext(latest.intent, attempt.intent))),
    // `content` is the fingerprint of the schedule a failed publication carried: the same content is not tried again
    // until a refusal field changes or an explicit request. An attempt cancelled meanwhile was answered then, and
    // leaves nothing behind.
    settleAdoption: (attempt: AdoptionAttempt, outcome: AdoptionOutcome, content?: string) => {
      if (running !== attempt) return
      attempt.resolve(outcome)
      running = undefined
      if (outcome.status === "blocked" || outcome.status === "failed") blocked = { intent: attempt.intent, fields: attempt.fields, outcome, content }
      else if (outcome.status !== "superseded") blocked = undefined
      if (!attempt.publication) options.onTerminal?.()
    },
    // The next attempt after one settled: the intent that waited, or the refused one when a field changed while it ran.
    nextAdoption: (fields: AdoptionFields, afterRefusal: boolean): AdoptionStart<Candidate> | undefined => {
      if (running) return undefined
      if (latest) {
        const next = latest
        latest = undefined
        return admit(next, fields)
      }
      return afterRefusal && blocked && reopens(fields) ? admit(waiting(blocked.intent, false), fields) : undefined
    },
    // The refused intent when a field changed and nothing else is wanted: a wake.
    reopenedIntent: (fields: AdoptionFields) => !running && !latest && reopens(fields) ? blocked?.intent : undefined,
    rejectedContent: (content: string, fields: AdoptionFields) => blocked?.content === content && !reopens(fields),
    openCompile: () => {
      const abort = new AbortController()
      compiles.add(abort)
      return abort
    },
    closeCompile: (abort: AbortController, transferred = false) => {
      if (compiles.delete(abort) && !transferred) options.onTerminal?.()
    },
    compiling: () => compiles.size > 0,
    adoptionRunning: () => running !== undefined,
    // Intents that no longer have a playing transport to adopt into: the running attempt is cancelled wherever it is
    // (waiting for its turn, applying its loop, compiling, publishing) and answered, a waiting intent dropped, a kept
    // candidate returned. A refusal stays. An attempt whose publication native may already hold is left to end with what
    // native did, until it settles, instead of being answered `superseded` here.
    dropIntents: () => {
      const held = running?.withdrawPublication?.() === false
      cancelIntents(held || running?.publication !== undefined)
      return takeRetainedOut()
    },
    adoptionWitness: () => ({
      running: running?.intent.key, waiting: latest?.intent.key, retained: retained?.intent.key,
      blocked: blocked && { key: blocked.intent.key, reason: blocked.outcome.reason, ...blocked.fields },
    }),
    // A same-core prepare is pending: when native shows `revision`, `retains`
    // says which queued batches it kept.
    prepared: (revision: number, retains: ExecutionRetention) => {
      decisions.push({ revision, retains })
    },
    unprepared: (revision: number) => {
      const index = decisions.findIndex((decision) => decision.revision === revision)
      if (index >= 0) decisions.splice(index, 1)
    },
    // Inspect proved the successor published. A batch sent stamped below it that no decision covered (a frame of the
    // successor settled the decision first) is kept for the recovery that follows, as a batch the decision dropped.
    published: (revision: number) => {
      decide(revision)
      for (const key of active) {
        const target = targets.get(key)
        for (const execution of target?.inflight.values() ?? [])
          if (target && execution.sent && execution.strategy.kind === "parameters"
            && (execution.rebound ?? execution.revision) < revision) keep(target, execution)
      }
    },
    // A publication carries every order up to `includedOrder` and the targets in
    // `kinds` (processor and synth instance ids), holding `content` for each. Entries it subsumes, or whose
    // instance it removed or replaced, are done; targets it no longer carries
    // end. Returns what `reconcile` says is left to execute.
    adopted: (
      kinds: ReadonlyMap<string, number>,
      reconfigured: ReadonlySet<string>,
      restated: ReadonlySet<string>,
      includedOrder: number,
      matchesPublished: (desired: ProcessorDesired) => boolean,
      content: ReadonlyMap<string, InstalledContent> = new Map(),
    ): ProcessorReconcile[] => {
      includedThrough = includedOrder
      const done = (desired: ProcessorDesired) => desired.order < includedOrder
        || (desired.order === includedOrder && matchesPublished(desired))
      const included = (key: string, order: number) => {
        const desired = entries.get(key)?.desired
        return order >= 0 && (order < includedOrder || (order === includedOrder && desired?.order === order && matchesPublished(desired)))
      }
      const resends: Execution[] = []
      for (const [key, target] of targets) {
        const kindId = kinds.get(key)
        const pendingJoin = [...target.receipts].some((receipt) => receipt.join && receipt.answered === undefined)
        if ((kindId === undefined && !(target.kindId === undefined && pendingJoin))
          || (kindId !== undefined && target.kindId !== undefined && target.kindId !== kindId)) dropTarget(key)
        else if (reconfigured.has(key)) { target.live.clear(); target.liveOrder.clear(); target.applied = undefined; target.latest = undefined; target.carriers.clear() }
        else if (restated.has(key)) {
          // Native may have given the changed state a fresh history slot, which holds no override, or kept the
          // slot and its override: nothing in its replies says which. What the successor's state already carries
          // is the same either way. An override applied after the state froze may be gone, so no application of
          // it stands for the value any more and the value is sent again (it is absolute). A batch still in flight
          // may have drained on either slot, and a floor cannot say which (progress carries no slot identity), so
          // it is sent again too: only its successor-sent sequence can prove it. Batches ahead of it that drain
          // later change nothing, as the lane is FIFO and the values absolute. Only what it still carries is sent.
          for (const execution of [...target.inflight.values()]
            .filter((execution) => execution.sent && !included(key, execution.order))
            .sort((left, right) => left.sequence - right.sequence)) {
            const carried = carriedValues(target, execution)
            if (carried.size === 0) settle(execution, "cancelled")
            else {
              execution.values = carried
              resends.push(execution)
            }
          }
          const lost = (execution: Execution | undefined) => execution?.state === "applied" && !included(key, execution.order)
          for (const [id, carrier] of target.carriers) if (lost(carrier)) target.carriers.delete(id)
          if (lost(target.latest)) target.latest = undefined
          if (lost(target.applied)) target.applied = undefined
          for (const [id, order] of target.liveOrder) if (!included(key, order)) target.live.set(id, undefined)
        }
      }
      for (const [key, installedContent] of content) {
        if (kinds.get(key) !== installedContent.kindId) continue
        setInstalled(key, installedContent)
      }
      // Graph bytes do not erase a retained native override. A captured patch
      // whose live values differ still owes an absolute successor dispatch.
      for (const target of targets.values()) for (const execution of [target.patch, target.queuedPatch]) {
        if (!execution?.desired || !unsettled(execution) || !matchesPublished(execution.desired)
          || ![...execution.values].some(([id, value]) => target.live.has(id) && target.live.get(id) !== value)) continue
        if (target.patch === execution) target.patch = undefined
        if (target.queuedPatch === execution) target.queuedPatch = undefined
        execution.strategy = { kind: "parameters" }
        execution.state = "refused"
        target.refused.add(execution)
        target.latest = execution
        for (const id of execution.values.keys()) target.carriers.set(id, execution)
      }
      const replays = resends.map((execution): ProcessorReconcile => {
        const target = targets.get(execution.key)
        const desired = entries.get(execution.key)?.desired
        // A successor can replace non-live structure as well as its override slot.
        // Repeating only the batch cannot prove that whole edit; transfer its requests
        // to a patch of current desired content, even while its gesture remains open.
        if (target && desired && execution.spec && !sameStructure(target, execution.spec)) {
          settle(execution, "cancelled", false)
          return { patch: queuePatch(desired, execution.receipts) }
        }
        return { resend: execution }
      })
      for (const [key, kindId] of kinds) targetFor(key, kindId)
      // Publication is also whole-content proof. A refused batch whose content
      // it now holds needs no replay, just as when a state patch satisfied it.
      for (const target of targets.values()) for (const execution of target.refused) {
        if (!execution.spec || !proves(target, execution.spec)) continue
        execution.installed = true
        settle(execution, "applied")
      }
      const refused = reoffer()
      settlePatches(includedOrder, matchesPublished)
      // Rule b: the publication's installed content decides every request; what is older than the floor and not
      // held is superseded by it. A request at or above the floor stays: the reconcile below sends it.
      for (const [key, target] of targets) {
        for (const receipt of target.receipts) {
          if (receipt.join) {
            // Captured joins are answered only by their record's target/content/incarnation proof.
            if (receipt.publication || receipt.nodeId !== undefined) continue
            const installedContent = content.get(key)
            if (installedContent?.contentKey === receipt.contentKey
              && (installedContent.incarnation ?? target.incarnation) === receipt.incarnation
              && (!receipt.spec.instrument || proves(target, receipt.spec))) {
              answerReceipt(receipt, { state: "applied" })
            } else if (installedContent && (receipt.order < 0 || receipt.order < includedOrder)) {
              answerReceipt(receipt, { state: "superseded", by: includedOrder })
            }
            continue
          }
          if (proves(target, receipt.spec)
            && (receipt.carrier?.strategy.kind === "patch" && target.inflight.size === 0
              || coverage(target, receipt.spec, receipt.contentKey, receipt.carrier?.epoch ?? 0).kind === "proven"))
            answerReceipt(receipt, { state: "applied" })
          else if (receipt.order >= 0 && receipt.order < includedOrder) answerReceipt(receipt, { state: "superseded", by: includedOrder })
        }
        clearIncident(key)
      }
      const executions = [...replays, ...refused, ...reconcile(kinds)]
      settledKeys.clear()
      for (const [instanceId, entry] of entries) {
        if (kinds.get(instanceId) !== entry.target.kindId || done(entry.desired)) write(instanceId, undefined)
        else if (entry.applied && done(entry.applied)) write(instanceId, { ...entry, applied: undefined })
      }
      return executions
    },
    // The instrument parameters native holds or is about to hold: the latest
    // dispatched edit, or the last applied one if that was cancelled. Ends when a
    // publication configures the node again.
    heldParams: (key: string) => {
      const target = targets.get(key)
      return (target?.latest?.state === "cancelled" ? target.applied : target?.latest)?.content?.params
    },
    clear: () => {
      if (publication) finishPublication(publication, { status: "superseded" }, "lost")
      if (retirement) finishRetirement(retirement)
      for (const key of targets.keys()) dropTarget(key)
      decisions.length = 0
      unreconciled.clear()
      settledKeys.clear()
      delivered.clear()
      lastProgress = -1n
      includedThrough = 0
      entries.clear()
      setFence({ kind: "open" })
      lastResolution = undefined
      incident = undefined
      ended.clear()
      cancelIntents()
      blocked = undefined
      return takeRetainedOut()
    },
  }
}
