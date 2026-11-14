import type { NativeGraphRevisionStatus, NativeRevisionReply } from "@daw-browser/desktop-protocol/native-revision"
import type { NativeHostTransport, NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"
import type { DesktopBridge, NativeProcessorPatchReply } from "../../src/types/desktop-bridge"
import { decodeGraph, fields, viewOf, type Graph, type Processor, type Defect } from "./ae-08-processor-state-fuzz-oracle"
type Reply = { ok: true } | { ok: false; error: string }
type Bridge = Pick<NonNullable<DesktopBridge["audioHost"]>, "resolveOutputDevice" | "resolveInputDevice" | "recordingSpool"> & {
  session: Pick<NonNullable<DesktopBridge["audioHost"]>["session"], "commitTransaction" | "rollbackTransaction" | "installAsset" | "createMappedAsset" | "writeMappedAssetPage" | "prepareMappedAssetRange" | "releaseAsset" | "publishGraph" | "configureInstrumentStates" | "queueInstrumentEvents" | "queueSourceEvents" | "queueVstParameterEvents" | "coordinateVstAttachments" | "queueParameterEvents" | "queueProcessorStatePatch" | "queueScheduleWindow" | "setTransport" | "start" | "stop" | "teardown" | "configureRecording" | "startRecording" | "stopRecording" | "cancelRecording" | "onLoss" | "onScheduleProgress" | "onRecordingStatus" | "onRecordingFailure" | "onMeterBatch" | "revisions"> & {
    configure: () => Promise<{ ok: true; hostIdentity: { pid: number; generation: number; configurationGeneration: number } }>
    beginTransaction: () => Promise<{ ok: true; transactionToken: string }>
  }
}
type Bank = { revision: number; epoch: number; through: bigint; window: bigint; complete: boolean; seam?: bigint;
  sources: Map<number, bigint>; sourceHistory: Map<number, { start: bigint; stop: bigint }>
  // Lossless schedule-event ledger keyed by real event identity (sequence and source node), never by asset:
  // several events may share an asset, and a repeated window submission carries the same identity.
  events: Map<string, { sequence: bigint; nodeId: bigint; assetId: number; start: bigint; stop: bigint }> }
// `second` is a second gesture begun in the same turn as the first, before either send has reached the bridge.
export type Action = { kind: string; id?: number; scope?: number; value?: number; second?: number; sequence?: number; mode?: string }
type PendingReply = { id: number; name: string; deliver: () => void }
type Command = { id: number; name: string; execute: () => void }
const revisionNames = new Set(["prepare", "publish", "inspect", "rollback", "retire"])
const priority = (name: string) => ["transport", "instrument-events", "stop", "teardown"].includes(name) ? 0 : name === "window" ? 1 : 2
const progressFrame = (snapshot: NativeScheduleProgress, legacy: boolean) => {
  const bytes = new Uint8Array(legacy ? 80 : 96)
  const view = viewOf(bytes)
  view.setUint32(0, snapshot.revision); view.setUint32(4, snapshot.epoch)
  const values = [snapshot.progressSequence, snapshot.renderedThroughFrame, snapshot.acceptedThroughFrame,
    snapshot.lastAcceptedWindowId, snapshot.appliedTransportTransitionId, snapshot.appliedUrgentSequence,
    snapshot.appliedProcessorSequence]
  values.forEach((value, index) => view.setBigUint64(8 + index * 8, value))
  view.setUint32(64, (snapshot.running ? 1 : 0) | (snapshot.scheduleComplete ? 2 : 0))
  view.setUint32(68, snapshot.instrumentCredits); view.setUint32(72, snapshot.sourceCredits); view.setUint32(76, snapshot.automationCredits)
  if (!legacy) {
    view.setBigUint64(80, snapshot.admissionCapacityGeneration ?? 0n)
    view.setBigUint64(88, snapshot.latencyCompletionGeneration ?? 0n)
  }
  return bytes
}
const decodeProgress = (bytes: Uint8Array): NativeScheduleProgress => {
  if (bytes.length !== 80 && bytes.length !== 88 && bytes.length !== 96 && bytes.length !== 112) throw new Error("Invalid typed progress frame length")
  const view = viewOf(bytes)
  const result: NativeScheduleProgress = {
    revision: view.getUint32(0), epoch: view.getUint32(4), progressSequence: view.getBigUint64(8),
    renderedThroughFrame: view.getBigUint64(16), acceptedThroughFrame: view.getBigUint64(24),
    lastAcceptedWindowId: view.getBigUint64(32), appliedTransportTransitionId: view.getBigUint64(40),
    appliedUrgentSequence: view.getBigUint64(48), appliedProcessorSequence: view.getBigUint64(56),
    running: (view.getUint32(64) & 1) !== 0, scheduleComplete: (view.getUint32(64) & 2) !== 0,
    instrumentCredits: view.getUint32(68), sourceCredits: view.getUint32(72), automationCredits: view.getUint32(76),
  }
  if (bytes.length >= 88) result.admissionCapacityGeneration = view.getBigUint64(80)
  if (bytes.length >= 96) result.latencyCompletionGeneration = view.getBigUint64(88)
  return result
}
export default function createFuzzHost(record: <Value>(event: Value) => void, plant: Defect | undefined, unfairHost: boolean, fail: (invariant: string, detail: string) => void, checkOwnership: () => void, hookLifetime = false) {
  let nextId = 0
  const commands: Command[] = []
  let pendingControl: Command | undefined
  const queuedSends: Command[] = []
  const replies: PendingReply[] = []
  const pendingIpc = new Map<number, (error: Error) => void>()
  const lossListeners = new Set<(error?: string) => void>()
  const progressListeners = new Set<(progress: NativeScheduleProgress) => void>()
  let runtimeRevision = 1
  let active: Graph | undefined
  let prepared: Graph | undefined
  let retired: Graph | undefined
  let retirementEpoch = 0n
  let latencyReadyEpoch: bigint | undefined
  let seam = 0n
  let publicationFrame = 0n
  // Native keeps publication ownership in two places. The control thread's `publication_in_flight` (audio-host.cpp:2978)
  // is set by Publish and cleared only by an Inspect that settles it, a cancelling SetTransport or Stop (:2988, :3007, :3011,
  // :4408, :5026, :5057): the callback's acknowledgement does not clear it. The callback's own atomics are the request
  // (`publish_requested_revision`, consumed by the claim at :5225), the acknowledgement (`publish_acknowledged_revision`,
  // :5318) and the deferral (`publish_deferred_revision`, :5253, :5284).
  let publicationInFlight = false
  let publicationRevision = 0
  let publicationClaimed = false
  let publicationAcknowledged = false
  let publicationDeferred = false
  let callbackMode: "normal" | "not-admitted" | "failed" = "normal"
  let publicationFailed = false
  // The request the callback has not consumed yet: SetTransport and Stop cancel exactly this (`requested.exchange(0)`).
  const publicationRequested = () => publicationInFlight && !publicationClaimed && !publicationAcknowledged && !publicationDeferred
  let rebaseRequired = false
  let instrumentsReady = false
  // Instrument configuration per node as Prepare's ConfigureInstrumentStates carried it, hex of the
  // state and zone blocks; `preparedConfigs` is what the prepared plan will publish.
  let publishedConfigs = new Map<bigint, string>()
  let preparedConfigs = new Map<bigint, string>()
  let running = false
  let started = false
  let frame = 0n
  let epoch = 1
  let renderEpoch = 0n
  let transition = 0n
  let appliedSequence = 0n
  let lastQueuedSequence = 0n
  let droppedBatch = false
  let progressSequence = 0n
  let deliveredProgressSequence = 0n
  let capacityGeneration = 0n
  let latencyCompletionGeneration = 0n
  let activeBank: Bank = { revision: 1, epoch: 1, through: 0n, window: 0n, complete: false, sources: new Map(), sourceHistory: new Map(), events: new Map() }
  let preparedBank: Bank | undefined
  let retiredBank: Bank | undefined
  let progress: NativeScheduleProgress | undefined
  // A frame already in IPC when later ones were rendered: `deliver-held-progress` delivers it after them.
  let heldProgress: NativeScheduleProgress | undefined
  let transport: NativeHostTransport | undefined
  let lastTransport: NativeHostTransport | undefined
  const contextHistory: NativeHostTransport[] = []
  const controls: Uint8Array[] = []
  // Native callback parameter overrides belong to retained runtime slots, not
  // graph configuration bytes (audio_core.cpp latch/prepare parameter cache).
  const gainOverrides = new Map<number, number>()
  // Live instrument parameter events queue until a render callback applies them. The urgent floor
  // folds the maximum applied sequence for the whole session, like native appliedUrgentSequence.
  const urgentQueue: Uint8Array[] = []
  const synthValues = new Map<number, number>()
  let urgentDropped = 0
  let historySlotsReplaced = 0
  let appliedUrgent = 0n
  const nativeFields = (graph: Graph | undefined) => {
    const decoded = fields(graph)
    const utility = graph && [...graph.processors.values()].find((processor) => processor.kind === 1)
    return { ...decoded, gain: utility ? gainOverrides.get(utility.instance) ?? decoded.gain : decoded.gain }
  }
  let patch: { bytes: Uint8Array; finish: (reply: NativeProcessorPatchReply) => void; uncertain: boolean; claimed: boolean } | undefined
  // normal | reject (refused before the claim) | negative-atomic / lost-atomic (claimed and applied in one callback,
  // audio-host.cpp:5139-5148), the reply unconfirmed or never sent. negative / lost split claim and apply across two
  // callbacks, which native cannot do: they are model-only and gate nothing.
  let patchMode = "normal"
  // Admissions the host refuses for capacity after consuming their sequence (audio-host.cpp:3123-3129).
  let refuseParameters = 0
  // The processor floor when the last patch installed: a batch at or below it drained on the state that patch replaced.
  let patchFloor = 0
  let blockAsset = false
  let assetCapacity: number | undefined
  // What a blocked asset command answers: native's capacity refusal, or its refusal while a publication is pending.
  let blockAssetError = "asset-capacity-exceeded"
  let clearOverridesOnPublish = false
  let rejectPrepare = false
  // VST3 attachment ownership as phase 6 stages it: an instance starts staged against the prepared revision and finishes
  // its startup off the command loop, so `ready` arrives later. That revision's publication binds a ready instance
  // (active) and retires one that never became ready; a rollback retires every instance it staged. A ready that arrives
  // for a retired instance (undo during startup) or whose join was lost binds nothing.
  const attachments = new Map<string, { state: "staged" | "active" | "retired"; ready: boolean; revision: number; joinLost: boolean }>()
  const ignoredReady = { stale: 0, joinLost: 0 }
  const settleAttachments = (revision: number, publishing: boolean) => {
    for (const attachment of attachments.values()) {
      if (attachment.state === "staged" && attachment.revision === revision)
        attachment.state = publishing && attachment.ready ? "active" : "retired"
    }
  }
  // A callback split in two, so control work can run between its transport read and its lane drain
  // (audio-host.cpp:5175-5176 and 5385). Only a scenario that asks for it enables the extra actions.
  let splitRender = false
  let renderOpen = false
  let lost = false
  let domain = 0
  let utilityIncarnation = 1
  // `released`: the controller's ReleaseAsset ran (the logical lease is released). `releaseRequested`: native's
  // `release_requested`, also set by Rollback for the assets its revision staged. `staged`: native's `staged_revision`,
  // the prepared revision when the asset was installed, cleared when that revision's publication settles (:4119, :1699-1704).
  const assets = new Map<number, { released: boolean; releaseRequested: boolean; staged: number; after?: bigint }>()
  const installedAsset = () => ({ released: false, releaseRequested: false, staged: prepared?.revision ?? 0 })
  // Independent logical ownership, not reconstructed from the mutable host
  // asset table. Release ACKs do not release graph readers.
  const leases = new Map<number, { acquisitions: number; releases: number; owners: Set<Bank>; reclaimed: boolean }>()
  const acquire = (id: number) => {
    const previous = leases.get(id)
    if (previous && !previous.reclaimed) fail("I5", `Duplicate acquisition ${id}`)
    leases.set(id, { acquisitions: (previous?.acquisitions ?? 0) + 1,
      releases: previous?.releases ?? 0, owners: new Set(), reclaimed: false })
    record({ event: "lease-acquire", id })
  }
  const dropBank = (bank: Bank | undefined) => {
    if (bank) for (const lease of leases.values()) lease.owners.delete(bank)
  }
  const releaseLease = (id: number) => {
    const lease = leases.get(id)
    if (!lease || lease.releases >= lease.acquisitions) fail("I5", `Duplicate logical release ${id}`)
    else { lease.releases++; record({ event: "lease-release", id }) }
  }
  const counts = new Map<string, number>()
  const domainCommands: { id: number; name: string }[] = []
  const restampedSequences = new Set<bigint>()
  const publicationCancelled = new Set<bigint>()
  const restampCounts = new Map<bigint, number>()
  const submittedGraphs = new Map<number, Uint8Array>()
  const published: ReturnType<typeof fields>[] = []
  const applications: { content: ReturnType<typeof fields>; domain: number; epoch: number; revision: number; incarnation: number; strategy: string; sequence?: number }[] = []
  const applied = (strategy: string, sequence?: number) => {
    // A retained runtime override is not proof that this publication carried
    // a waiter's bytes. Publication proves only its frozen decoded content.
    applications.push({ content: strategy === "publication" ? fields(active) : nativeFields(active),
      domain, epoch, revision: active?.revision ?? 0, incarnation: utilityIncarnation, strategy, sequence })
  }
  const appliedBatches = new Map<number, ReturnType<typeof fields>>()
  let lastParameterSequence: number | undefined
  const bump = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)
  const dispatchNext = () => {
    if (pendingControl || lost) return
    let index = -1
    let bestPriority = Infinity
    for (const [cursor, command] of queuedSends.entries()) {
      if (priority(command.name) >= bestPriority) continue
      index = cursor; bestPriority = priority(command.name)
    }
    if (index < 0) return
    const [next] = queuedSends.splice(index, 1)
    pendingControl = next
    if (next) {
      commands.push(next)
      record({ event: "dispatch", id: next.id, name: next.name, priority: priority(next.name) })
    }
  }
  const enqueue = <Value>(name: string, execute: (finish: (value: Value) => void) => void): Promise<Value> => {
    const gate = Promise.withResolvers<Value>()
    const id = ++nextId
    if (["transport", "stop", "teardown", "configure"].includes(name)) domainCommands.push({ id, name })
    if (lost) return Promise.reject(new Error("The native audio host is unavailable."))
    pendingIpc.set(id, gate.reject)
    const command = { id, name, execute: () => execute((value) => {
      replies.push({ id, name, deliver: () => {
        pendingIpc.delete(id)
        if (pendingControl?.id === id) { pendingControl = undefined; dispatchNext() }
        gate.resolve(value)
      } })
      record({ event: "reply-ready", id, name, value })
      if (unfairHost && priority(name) === 2 && !revisionNames.has(name)) {
        pendingControl = undefined; dispatchNext()
      }
    }) }
    queuedSends.push(command); dispatchNext()
    bump(name)
    record({ event: "command", id, name })
    return gate.promise
  }
  const revisionRequest = (name: string, execute: (finish: (value: NativeRevisionReply) => void, allocated: number) => void): Promise<NativeRevisionReply> => {
    // main.ts allocates Prepare's runtime revision before trying the supervisor.
    const allocated = name === "prepare" ? ++runtimeRevision : runtimeRevision
    // The supervisor queues a revision behind a pending control request like a processor patch (audio-host.ts
    // requestGraphRevision); only a lost session refuses it unsent (NotSent: unavailable). A request it sent whose
    // reply never came is unconfirmed (design 1.2).
    const failure = (kind: "unavailable" | "unconfirmed"): NativeRevisionReply => ({ ok: false, error: "The native audio session is unavailable.", kind })
    if (lost) {
      record({ event: "boundary-rejection", name, pending: pendingControl?.name, allocated })
      return Promise.resolve(failure("unavailable"))
    }
    return enqueue<NativeRevisionReply>(name, (finish) => execute(finish, allocated)).catch(() => failure("unconfirmed"))
  }
  const simple = (name: string, effect?: () => void): Promise<Reply> =>
    enqueue(name, (finish) => { effect?.(); finish({ ok: true }) })
  const status = (code: NativeGraphRevisionStatus["status"], revision: number): NativeRevisionReply => ({
    ok: true, hostPid: 123, hostGeneration: 7,
    revision: { status: code, continuity: code === "prepare-failed" ? "rejected" : "accepted",
      requestedRevision: revision, activeRevision: active?.revision ?? 0, preparedRevision: prepared?.revision ?? 0,
      retiredRevision: retired?.revision ?? 0, publicationFrame, renderEpoch,
      // SetTransport stores the epoch when it accepts the request, before any callback applies it (audio-host.cpp:4429).
      requestedPublicationFrame: seam, progressFrame: frame, transportEpoch: lastTransport?.epoch ?? epoch },
  })
  const promoteAssets = (revision: number) => {
    for (const asset of assets.values()) if (asset.staged === revision) asset.staged = 0
  }
  // The control-thread settlement of an in-flight publication (audio-host.cpp:2984-3029). It is the only place an
  // acknowledged publication stops being in flight, and the place a deferred one does.
  const inspectStatus = (revision: number): NativeGraphRevisionStatus["status"] => {
    reclaimAssets()
    if (publicationInFlight && publicationDeferred) {
      publicationInFlight = false; publicationDeferred = false
    }
    if (publicationInFlight) {
      if (!publicationAcknowledged) return "publish-pending"
      if (publicationFailed) {
        publicationInFlight = false; publicationFailed = false
        return "publish-failed"
      }
      promoteAssets(publicationRevision)
      publicationInFlight = false; publicationAcknowledged = false
    }
    return active?.revision === revision ? "published"
      : prepared && seam > 0n && (rebaseRequired || frame > seam) ? "rebase-required"
        : latencyReadyEpoch !== undefined || (revision > (active?.revision ?? 0) && !prepared && controls.length > 0)
          ? "publish-pending" : prepared?.revision === revision ? "prepared" : "stale-revision"
  }
  // Rollback's resource effect (audio-host.cpp:3039-3058): the prepared revision's staged assets are marked for release.
  // That is native's own release of them, so their logical lease ends here and a later ReleaseAsset is idempotent.
  const discardPrepared = () => {
    for (const [id, asset] of assets) {
      if (asset.staged !== prepared?.revision) continue
      asset.releaseRequested = true
      if (!asset.released) { asset.released = true; releaseLease(id) }
    }
    dropBank(preparedBank)
    if (prepared) settleAttachments(prepared.revision, false)
    prepared = undefined; preparedBank = undefined
  }
  // InstallAsset / CreateMappedAsset (audio-host.cpp:4113-4121): a new asset is staged against the prepared revision.
  const stageAsset = (id: number) => { acquire(id); assets.set(id, installedAsset()) }
  const admitAsset = (id: number): Reply => {
    if (blockAsset) return { ok: false, error: blockAssetError }
    // Native reuses an existing unreclaimed identity before it checks table capacity, whether or not a limit is
    // modelled (InstallAsset audio-host.cpp:4229-4239, ReuseAsset :1770-1775).
    const asset = assets.get(id)
    if (asset) {
      const lease = leases.get(id)
      if (asset.released && lease) lease.acquisitions++
      asset.released = false; asset.releaseRequested = false; asset.after = undefined
      if (asset.staged !== 0) asset.staged = prepared?.revision ?? 0
      return { ok: true }
    }
    if (assetCapacity !== undefined && assets.size >= assetCapacity) return { ok: false, error: blockAssetError }
    stageAsset(id)
    return { ok: true }
  }
  const promote = () => {
    if (!prepared) throw new Error("Impossible publication without prepared graph")
    const beforeFft = fields(active).fft ?? 0
    const afterFft = fields(prepared).fft ?? 0
    if (fields(active).gain === null && fields(prepared).gain !== null) utilityIncarnation++
    if (running && beforeFft !== afterFft) {
      // Abstract readiness, not DSP simulation: permit a cold replacement two
      // full FFT windows, common-latency padding, the native 2*240-frame fade,
      // and one callback reader epoch. This is a legal delayed completion for
      // the fixed Freeze fixture, not an assertion of native timing parity.
      const frames = 2 * afterFft + Math.max(beforeFft - afterFft, 0) + 480 + 512
      latencyReadyEpoch = renderEpoch + BigInt(Math.ceil(frames / 512))
    }
    retired = active; retirementEpoch = renderEpoch + 1n
    // A removed target loses its runtime slot. Re-adding its public ID later
    // starts a fresh incarnation, never inherits its old override. The same holds for a target
    // whose node got a fresh slot.
    // Written from native RetainsScheduledTarget (audio_core.cpp:6842-6859) and retained_scheduled_node
    // (:6811-6818), never from the controller's predicate. A node keeps its slot only if its kind is
    // unchanged and an instrument node's configuration is too (assign_prepared_node :7736-7772).
    const instrumentNodeKind = 2
    const sameNodeKind = (id: bigint) => active?.nodes.has(id) === true && prepared?.nodes.has(id) === true
      && active.nodes.get(id) === prepared.nodes.get(id)
    const retainedNode = (id: bigint) => sameNodeKind(id)
      && (active?.nodes.get(id) !== instrumentNodeKind || publishedConfigs.get(id) === preparedConfigs.get(id))
    // An applied override lives in the processor's own history slot (audio_core.cpp:2145-2154), which survives while
    // the processor stays compatible (:8044-8072). Reconfiguring the instrument on its node gives the node a fresh
    // slot, which only matters to queued events (retainedNode), not to the processor's override.
    // compatible_processor_history (audio_core.cpp:7122-7136): same kind and state size, and for a Utility the
    // dc_block, input_mode, matrix and swap words of its state (bytes 36, 12, 28, 32). Otherwise the successor gets
    // a fresh history slot with no override.
    const utilityKind = 1
    const compatibleHistory = (previous: Processor, next: Processor) => previous.kind === next.kind && previous.state.length === next.state.length
      && (next.kind !== utilityKind || [12, 28, 32, 36].every((offset) => viewOf(previous.state).getUint32(offset, true) === viewOf(next.state).getUint32(offset, true)))
    for (const instance of gainOverrides.keys()) {
      const next = prepared.processors.get(instance)
      const previous = active?.processors.get(instance)
      if (!next || !previous || next.node !== previous.node || !sameNodeKind(next.node)) gainOverrides.delete(instance)
      else if (!compatibleHistory(previous, next) && gainOverrides.delete(instance)) historySlotsReplaced++
    }
    // Planted counterfactual: a host whose publication replaces live overrides with the graph's value.
    if (clearOverridesOnPublish) gainOverrides.clear()
    for (let index = controls.length - 1; index >= 0; index--) {
      const bytes = controls[index]
      if (!bytes) continue
      const view = viewOf(bytes)
      const retained = view.getUint32(4, true) === active?.revision && plant !== "cancel-retained"
        && Array.from({ length: view.getUint32(0, true) }, (_, event) => {
          const offset = 20 + event * 20
          const instance = Number(view.getBigUint64(offset, true))
          const previous = active?.processors.get(instance)
          const next = prepared?.processors.get(instance)
          return previous !== undefined && next !== undefined && previous.node === next.node && previous.kind === next.kind
            && retainedNode(next.node) && next.targets.has(view.getUint32(offset + 8, true))
        }).every(Boolean)
      if (retained) {
        restampedSequences.add(view.getBigUint64(12, true))
        restampCounts.set(view.getBigUint64(12, true), (restampCounts.get(view.getBigUint64(12, true)) ?? 0) + 1)
        view.setUint32(4, prepared.revision, true)
        record({ event: "restamp-parameters", from: active?.revision, to: prepared.revision, sequence: view.getBigUint64(12, true) })
      } else {
        publicationCancelled.add(view.getBigUint64(12, true))
        controls.splice(index, 1)
      }
    }
    retiredBank = activeBank
    publishedConfigs = preparedConfigs
    settleAttachments(prepared.revision, true)
    active = prepared; prepared = undefined
    if (seam > 0n) {
      if (!preparedBank) throw new Error("Missing prepared schedule bank")
      activeBank = preparedBank
    } else {
      activeBank = { ...activeBank, revision: active.revision }
      for (const id of activeBank.sources.keys()) leases.get(id)?.owners.add(activeBank)
    }
    preparedBank = undefined; publicationFrame = frame
    published.push(nativeFields(active))
    applied("publication")
    record({ event: "callback-publication", revision: active.revision, graph: fields(active), content: nativeFields(active) })
  }
  // RetireGraphRevision's success path (audio-host.cpp:3079-3095), reached from an explicit Retire or Prepare's
  // auto-retire (:2548). No other control wake retires a predecessor.
  const retirePredecessor = () => {
    if (!retired || renderEpoch < retirementEpoch || latencyReadyEpoch !== undefined) return false
    dropBank(retiredBank)
    record({ event: "retire", revision: retired.revision }); retired = undefined; retiredBank = undefined
    reclaimAssets()
    return true
  }
  // ReclaimAssets (audio-host.cpp:1705-1750). Its callers are Inspect, a successful Retire, the asset commands and the
  // callback's reader wake (:1911, :5460), which the fixture's `reclaim` action stands for. It does nothing while a
  // publication is in flight, a revision is prepared or a predecessor plan is unretired.
  const reclaimBlocked = () => prepared !== undefined || retired !== undefined || publicationInFlight
  const reclaimAssets = () => {
    if (reclaimBlocked()) return
    for (const [id, asset] of assets) {
      const readers = [activeBank, preparedBank].some((bank) => bank?.sources.has(id))
      if (!asset.releaseRequested || readers) continue
      if (asset.after === undefined) asset.after = renderEpoch
      if (!started || renderEpoch > asset.after) {
        assets.delete(id); capacityGeneration++
        const lease = leases.get(id)
        if (lease) lease.reclaimed = true
        if (progress) progress = { ...progress, progressSequence: ++progressSequence, admissionCapacityGeneration: capacityGeneration }
        record({ event: "reclaimed", id, capacityGeneration })
      }
    }
  }
  // Whether ReclaimAssets has work it can finish or start now: the asset-reader wake (audio-host.cpp:5460, :1911) is
  // signalled exactly while a released asset waits on a block the callback has not completed, so a fair scheduler
  // owes it one when this holds.
  const reclaimable = () => !reclaimBlocked() && [...assets].some(([id, asset]) =>
    asset.releaseRequested && ![activeBank, preparedBank].some((bank) => bank?.sources.has(id))
    && (asset.after === undefined || !started || renderEpoch > asset.after))
  const bridge: Bridge = {
    resolveOutputDevice: () => enqueue("device", (finish) => finish({ ok: true, device: {
      deviceId: "coreaudio:fixture", name: "Fixture", nominalSampleRateHz: 48_000,
      outputChannelCount: 2, maximumFramesPerBlock: 512, available: true,
    } })),
    resolveInputDevice: () => enqueue("input-device", (finish) => finish({ ok: false, error: "A1 does not record" })),
    recordingSpool: { list: async () => ({ takes: [], nextCursor: null }), read: async () => new Uint8Array(), release: async () => undefined },
    session: {
      configure: () => enqueue("configure", (finish) => finish({ ok: true,
        hostIdentity: { pid: 123, generation: 7, configurationGeneration: 1 } })),
      beginTransaction: () => enqueue("begin", (finish) => finish({ ok: true, transactionToken: "fixture" })),
      commitTransaction: () => simple("commit"),
      rollbackTransaction: () => simple("transaction-rollback"),
      installAsset: (asset) => enqueue("asset", (finish) => {
        reclaimAssets()
        finish(admitAsset(asset.sessionAssetId))
      }),
      createMappedAsset: (asset) => enqueue("asset", (finish) => {
        reclaimAssets()
        finish(admitAsset(asset.sessionAssetId))
      }),
      writeMappedAssetPage: () => simple("asset-page"),
      prepareMappedAssetRange: () => simple("asset-range"),
      releaseAsset: (id) => simple("release", () => {
        const asset = assets.get(id)
        // Native ReleaseAsset is idempotent, including already-erased IDs.
        if (asset && !asset.released) releaseLease(id)
        if (asset) { asset.released = true; asset.releaseRequested = true }
        if (plant === "early-release" && asset) assets.delete(id)
        reclaimAssets()
      }),
      publishGraph: (bytes) => simple("initial-graph", () => {
        active = decodeGraph(bytes); submittedGraphs.set(active.revision, bytes.slice()); runtimeRevision = active.revision
        activeBank = { ...activeBank, revision: active.revision }; published.push(fields(active))
      }),
      configureInstrumentStates: (bytes) => simple("instruments", () => {
        instrumentsReady = true
        const view = viewOf(bytes)
        let offset = 4
        // Before the first Prepare there is no prepared plan: the initial configuration is the published one.
        const configs = prepared ? preparedConfigs : publishedConfigs
        for (let index = 0; index < view.getUint32(0, true); index++) {
          const length = view.getUint32(offset + 12, true) + view.getUint32(offset + 16, true)
          configs.set(view.getBigUint64(offset, true), Array.from(bytes.subarray(offset + 24, offset + 24 + length), (byte) => byte.toString(16)).join(","))
          offset += 24 + length
        }
      }),
      queueInstrumentEvents: (bytes) => enqueue("instrument-events", (finish) => {
        // Admission only, with no epoch or revision check (audio-host.cpp:3222-3262): native applies a
        // live instrument event at its next render callback and drops it there if its epoch is not current.
        urgentQueue.push(bytes.slice())
        finish({ ok: true })
      }),
      queueSourceEvents: () => simple("source-events"),
      queueVstParameterEvents: () => simple("vst-events"),
      coordinateVstAttachments: () => simple("attachments"),
      queueParameterEvents: (bytes) => {
        lastParameterSequence = Number(viewOf(bytes).getBigUint64(12, true))
        return enqueue("parameters", (finish) => {
          const view = viewOf(bytes)
          const sequence = view.getBigUint64(12, true)
          // Admission checks the epoch of the last queued SetTransport (audio-host.cpp:3119–3121); only the
          // drain compares against the epoch the callback applied.
          if (view.getUint32(4, true) !== active?.revision || view.getUint32(8, true) !== (lastTransport?.epoch ?? epoch)
            || sequence <= lastQueuedSequence) { finish({ ok: false, error: "parameter-admission-rejected", kind: "refused" }); return }
          lastQueuedSequence = sequence
          if (refuseParameters > 0) { refuseParameters--; finish({ ok: false, error: "parameter-admission-rejected", kind: "refused" }); return }
          if ((plant === "drop-batch" || plant === "lost-edit") && !droppedBatch) {
            droppedBatch = true
            record({ event: "mutation-dropped-batch", sequence })
          } else controls.push(bytes.slice())
          finish(plant === "lost-edit" && droppedBatch ? { ok: false, error: "mutation-admission-dropped", kind: "refused" } : { ok: true })
        })
      },
      queueProcessorStatePatch: (bytes) => enqueue("patch", (finish) => {
        if (prepared || patch || viewOf(bytes).getUint32(4, true) !== active?.revision || patchMode === "reject") {
          finish({ ok: false, error: "patch-not-accepted", kind: "refused" }); return
        }
        patch = { bytes: bytes.slice(), finish, uncertain: patchMode !== "normal" && started, claimed: false }
        if (!started) applyPatch()
      }),
      queueScheduleWindow: (bytes) => enqueue("window", (finish) => {
        const view = viewOf(bytes)
        const revision = view.getUint32(0, true)
        const bank = activeBank.revision === revision ? activeBank : preparedBank?.revision === revision ? preparedBank : undefined
        if (!bank || view.getUint32(4, true) !== epoch) { finish({ ok: false, error: "stale-window" }); return }
        const end = view.getBigUint64(24, true)
        const sourceOffset = 72 + view.getUint32(44, true) * 48
        for (let index = 0; index < view.getUint32(48, true); index++) {
          const offset = sourceOffset + index * 112
          const id = view.getUint32(offset + 20, true)
          if (!assets.has(id)) { finish({ ok: false, error: "uninstalled-source" }); return }
          bank.sources.set(id, view.getBigInt64(offset + 32, true))
          leases.get(id)?.owners.add(bank)
          const start = view.getBigInt64(offset + 24, true), stop = view.getBigInt64(offset + 32, true)
          const sequence = view.getBigUint64(offset + 4, true), nodeId = view.getBigUint64(offset + 12, true)
          bank.sourceHistory.set(id, { start, stop })
          bank.events.set(`${sequence}:${nodeId}`, { sequence, nodeId, assetId: id, start, stop })
        }
        // The fixture topology has no chunked automation; complete window chunks are required.
        const chunk = view.getUint32(32, true)
        const chunks = view.getUint32(36, true)
        if (chunk + 1 === chunks) {
          bank.through = end > bank.through ? end : bank.through
          bank.window = view.getBigUint64(8, true); bank.complete = view.getUint32(40, true) === 1
        }
        finish({ ok: true })
      }),
      setTransport: (value) => enqueue("transport", (finish) => {
        const refused = { ok: false, error: "The native audio session rejected transport request 7.", kind: "refused" } satisfies Reply & { kind: string }
        const contextOnly = value.transitionId !== undefined && value.transitionId !== 0n
          && value.transitionId === lastTransport?.transitionId && value.epoch === lastTransport.epoch
          && value.running && running && (value.bpm ?? 0) > 0 && prepared
        if (contextOnly) {
          // Native updates only the prepared musical context, not transport.
          if (hookLifetime && !publicationInFlight) contextHistory.push({ ...value })
          finish(publicationInFlight ? refused : { ok: true })
          return
        }
        // audio-host.cpp:4406-4413: cancel an unclaimed request, otherwise settle the publication with an internal
        // Inspect and refuse if it is still pending; then Rollback whatever stays prepared.
        if (publicationInFlight) {
          if (publicationRequested()) {
            publicationInFlight = false
            record({ event: "transport-cancelled-publication" })
          } else if (inspectStatus(publicationRevision) === "publish-pending") {
            record({ event: "transport-refused", reason: "callback-claimed-publication-unacknowledged" })
            finish(refused); return
          }
        }
        if (prepared) discardPrepared()
        if (hookLifetime) contextHistory.push({ ...value })
        lastTransport = value; transport = value; finish({ ok: true })
      }),
      start: () => simple("start", () => { started = true }),
      stop: () => simple("stop", () => {
        started = false; running = false
        // audio-host.cpp:5024-5062. The device is quiescent first, so a callback that had claimed the request has
        // already acknowledged it.
        if (publicationClaimed) acknowledgePublication()
        if (publicationInFlight && !publicationRequested()) inspectStatus(publicationRevision)
        publicationInFlight = false; publicationClaimed = false; publicationAcknowledged = false; publicationDeferred = false
        if (prepared) discardPrepared()
      }),
      teardown: () => simple("teardown", () => {
        checkOwnership(); endLeases(); assets.clear(); gainOverrides.clear(); activeBank.sources.clear(); attachments.clear()
        active = undefined; prepared = undefined; retired = undefined; started = false
        publishedConfigs = new Map(); preparedConfigs = new Map()
        if (hookLifetime) {
          // Native Teardown destroys all graphs and resets sequence admission
          // and progress floors (audio-host.cpp:5062–5102). A1 freezes its
          // single-install historical model; only the hook reinstalls here.
          domain++
          preparedBank = undefined; retiredBank = undefined
          activeBank = { revision: 0, epoch: 0, through: 0n, window: 0n, complete: false, sources: new Map(), sourceHistory: new Map(), events: new Map() }
          appliedSequence = 0n; lastQueuedSequence = 0n; appliedUrgent = 0n
          appliedBatches.clear(); controls.length = 0; patch = undefined; urgentQueue.length = 0; synthValues.clear()
          transport = undefined; lastTransport = undefined; progress = undefined; heldProgress = undefined
          publicationInFlight = false; publicationClaimed = false; publicationAcknowledged = false; publicationDeferred = false
          latencyReadyEpoch = undefined
          running = false; epoch = 0; frame = 0n; transition = 0n
          deliveredProgressSequence = progressSequence
        }
      }),
      configureRecording: () => enqueue("recording-configure", (finish) => finish({ ok: false, error: "A1 does not record" })),
      startRecording: () => simple("recording-start"),
      stopRecording: () => simple("recording-stop"),
      cancelRecording: () => simple("recording-cancel"),
      onLoss: (listener) => { lossListeners.add(listener); return () => lossListeners.delete(listener) },
      onScheduleProgress: (listener) => { progressListeners.add(listener); return () => progressListeners.delete(listener) },
      onRecordingStatus: () => () => {},
      onRecordingFailure: () => () => {},
      onMeterBatch: () => () => {},
      revisions: {
        prepare: ({ bytes, requestedPublicationFrame = 0n }) => revisionRequest("prepare", (finish, revision) => {
          if (publicationInFlight || controls.length > 0 || latencyReadyEpoch !== undefined) { finish(status("publish-pending", revision)); return }
          if (patch || rejectPrepare) { finish(status("prepare-failed", revision)); return }
          if (prepared) { finish(status("stale-revision", revision)); return }
          if (requestedPublicationFrame > 0n && (requestedPublicationFrame <= frame || (requestedPublicationFrame - frame) % 512n !== 0n)) {
            finish(status("invalid-revision", revision)); return
          }
          // Prepare's auto-retire (audio-host.cpp:2548-2552): the predecessor plan is retired here or the admission
          // stays retryable.
          if (retired && !retirePredecessor()) {
            record({ event: "adoption-waiting", revision })
            finish(status("publish-pending", revision)); return
          }
          const rewritten = bytes.slice()
          viewOf(rewritten).setBigUint64(0, BigInt(revision))
          viewOf(rewritten).setUint32(16, revision, true)
          prepared = decodeGraph(rewritten); submittedGraphs.set(prepared.revision, rewritten); seam = requestedPublicationFrame; instrumentsReady = false; rebaseRequired = false
          preparedConfigs = new Map(publishedConfigs)
          preparedBank = { revision, epoch, through: seam, window: 0n, complete: false, seam, sources: new Map(), sourceHistory: new Map(), events: new Map() }
          record({ event: "prepared", revision, content: fields(prepared), seam })
          record({ event: "adoption-prepared", revision })
          finish(status("prepared", revision))
        }),
        publish: ({ revision, requestedPublicationFrame = 0n }) => revisionRequest("publish", (finish) => {
          if (publicationInFlight || latencyReadyEpoch !== undefined) { finish(status("publish-pending", revision)); return }
          if (prepared?.revision !== revision) { finish(status("stale-revision", revision)); return }
          if (requestedPublicationFrame > 0n && requestedPublicationFrame !== seam) {
            // A rebind rebinds the seam and does not arm the Publish (audio-host.cpp:2985–2995), so it is not a publication.
            counts.set("publish", (counts.get("publish") ?? 0) - 1); bump("rebind")
            seam = requestedPublicationFrame
            dropBank(preparedBank)
            preparedBank = { revision, epoch, through: seam, window: 0n, complete: false, seam, sources: new Map(), sourceHistory: new Map(), events: new Map() }
            finish(status("prepared", revision)); return
          }
          if (seam > 0n && frame >= seam) { finish(status("rebase-required", revision)); return }
          if (seam > 0n && (!instrumentsReady || activeBank.through < seam || !preparedBank || preparedBank.through < seam + 512n)) {
            finish(status("publish-pending", revision)); return
          }
          if (started) {
            publicationInFlight = true; publicationRevision = revision
            publicationAcknowledged = false; publicationDeferred = false
          } else { promote(); promoteAssets(revision) }
          finish(status(started ? "publish-pending" : "published", revision))
        }),
        inspect: ({ revision }) => revisionRequest("inspect", (finish) => { const code = inspectStatus(revision); finish(status(code, revision)) }),
        rollback: ({ revision }) => revisionRequest("rollback", (finish) => {
          if (publicationInFlight) { finish(status("publish-pending", revision)); return }
          if (prepared?.revision !== revision) { finish(status("stale-revision", revision)); return }
          discardPrepared(); finish(status("rolled-back", revision))
        }),
        retire: ({ revision }) => revisionRequest("retire", (finish) => {
          if (publicationInFlight) { finish(status("publish-pending", revision)); return }
          // audio-host.cpp:3079-3095: only the retired plan of that revision answers retired or not-safe.
          if (retired?.revision !== revision) { finish(status("stale-revision", revision)); return }
          finish(status(retirePredecessor() ? "retired" : "retirement-not-safe", revision))
        }),
      },
    },
  }
  const applyPatch = () => {
    if (!patch || !active) return
    if (patch.uncertain && !patch.claimed) {
      patch.claimed = true
      record({ event: "callback-patch-claimed", mode: patchMode })
      if (patchMode.startsWith("negative")) patch.finish({ ok: false, error: "patch-reply-lost-after-install", kind: "unconfirmed" })
      if (!patchMode.endsWith("-atomic")) return
    }
    const claimed = patch
    patch = undefined
    const view = viewOf(claimed.bytes)
    const instance = view.getUint32(16, true)
    const processor = active.processors.get(instance)
    if (!processor) throw new Error("Fake patch target missing")
    active.processors.set(instance, { ...processor, state: claimed.bytes.slice(56, 56 + view.getUint32(28, true)) })
    gainOverrides.delete(instance)
    patchFloor = Number(appliedSequence)
    published.push(nativeFields(active))
    applied("patch")
    record({ event: "callback-patch", content: nativeFields(active), uncertain: claimed.uncertain })
    if (!claimed.uncertain) claimed.finish({ ok: true, outcome: "applied" })
  }
  const completeRender = () => {
    applyPatch()
    for (const bytes of controls.splice(0)) {
      const view = viewOf(bytes)
      if (view.getUint32(4, true) !== active?.revision || view.getUint32(8, true) !== epoch) continue
      for (let index = 0; index < view.getUint32(0, true); index++) {
        const offset = 20 + index * 20
        const processor = active.processors.get(Number(view.getBigUint64(offset, true)))
        if (processor?.kind === 1 && view.getUint32(offset + 8, true) === 1)
          gainOverrides.set(processor.instance, view.getFloat32(offset + 16, true))
      }
      appliedSequence = view.getBigUint64(12, true)
      appliedBatches.set(Number(appliedSequence), nativeFields(active))
      applied("parameters", Number(appliedSequence))
      published.push(nativeFields(active))
    }
    for (const bytes of urgentQueue.splice(0)) {
      const view = viewOf(bytes)
      for (let index = 0; index < view.getUint32(0, true); index++) {
        const offset = 4 + index * 48
        // Dropped at drain when its epoch is not the applied epoch (audio-host.cpp:5409); the floor never sees it.
        if (view.getUint32(offset + 24, true) !== epoch) { urgentDropped++; record({ event: "urgent-dropped", epoch: view.getUint32(offset + 24, true) }); continue }
        synthValues.set(view.getUint32(offset + 40, true), view.getFloat32(offset + 44, true))
        const sequence = view.getBigUint64(offset + 16, true)
        if (sequence > appliedUrgent) appliedUrgent = sequence
      }
      record({ event: "urgent-applied", appliedUrgent })
    }
    if (running) frame += 512n
    if (latencyReadyEpoch !== undefined && renderEpoch >= latencyReadyEpoch) {
      latencyReadyEpoch = undefined; latencyCompletionGeneration++
      record({ event: "latency-transition-complete", latencyCompletionGeneration, renderEpoch })
    }
    for (const [id, stop] of activeBank.sources) if (frame >= stop) {
      activeBank.sources.delete(id); leases.get(id)?.owners.delete(activeBank)
    }
    progressSequence++
    progress = { revision: active?.revision ?? 0, epoch, progressSequence, renderedThroughFrame: frame,
      acceptedThroughFrame: activeBank.through, lastAcceptedWindowId: activeBank.window,
      appliedTransportTransitionId: transition, appliedUrgentSequence: appliedUrgent, appliedProcessorSequence: appliedSequence,
      running, scheduleComplete: activeBank.complete, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
      admissionCapacityGeneration: capacityGeneration, latencyCompletionGeneration }
  }
  // Native claims, activates and acknowledges within one callback (audio-host.cpp:5302-5319). The acknowledgement
  // does not end the publication: it stays in flight until a control-thread Inspect, SetTransport or Stop settles it.
  const acknowledgePublication = () => {
    if (callbackMode === "not-admitted") {
      // DAW_AUDIO_CORE_LATENCY_MOVE_PENDING leaves the bank intact and does not ACK.
      publicationClaimed = false; publicationDeferred = true; callbackMode = "normal"
      record({ event: "callback-publication-not-admitted", revision: prepared?.revision })
      completeRender()
      return
    }
    if (callbackMode === "failed") {
      // A non-pending callback error ACKs without promoting. Inspect reports
      // publish-failed and clears in-flight ownership; only Rollback drops the bank.
      publicationFailed = true; callbackMode = "normal"
      record({ event: "callback-publication-failed", revision: prepared?.revision })
    } else promote()
    publicationClaimed = false; publicationAcknowledged = true
    completeRender()
  }
  const endLeases = () => {
    for (const lease of leases.values()) {
      lease.releases = lease.acquisitions; lease.owners.clear(); lease.reclaimed = true
    }
    record({ event: "lease-domain-ended", leases: [...leases].map(([id, lease]) => ({ id, ...lease, owners: lease.owners.size })) })
  }
  const enabled = (compilations: readonly Command[] = []): Action[] => [
    ...commands.slice(0, 1).map(({ id }) => ({ kind: "control-wake", id })),
    ...(unfairHost && replies[0] && priority(replies[0].name) === 2 && !revisionNames.has(replies[0].name)
      ? replies.filter((reply) => priority(reply.name) === 2 && !revisionNames.has(reply.name)) : replies.slice(0, 1))
      .map(({ id }) => ({ kind: "deliver-reply", id })),
    ...compilations.map(({ id }) => ({ kind: "resolve-compile", id })),
    ...(pendingControl ? [{ kind: revisionNames.has(pendingControl.name) ? "revision-deadline" : "control-watchdog", id: pendingControl.id }] : []),
    ...(publicationClaimed && !lost ? [{ kind: "publication-acknowledge" }] : []),
    ...(started && !lost && !publicationClaimed && !renderOpen ? [{ kind: "render-block" }] : []),
    ...(splitRender && started && !lost && !publicationClaimed && !renderOpen ? [{ kind: "render-open" }] : []),
    ...(renderOpen && !lost ? [{ kind: "render-close" }] : []),
    ...(progress && !lost ? [{ kind: "deliver-progress" }] : []),
  ]
  const take = <Value extends { id: number }>(queue: Value[], id: number | undefined) => {
    const index = queue.findIndex((item) => item.id === id)
    if (index < 0) throw new Error(`Disabled scheduler action ${id}`)
    const [item] = queue.splice(index, 1)
    if (!item) throw new Error("Missing queued action")
    return item
  }
  const act = (action: Action, compilations: Command[], lose: () => void, onProgress: (progress: NativeScheduleProgress) => void) => {
    if (["control-wake", "deliver-reply", "resolve-compile", "render-block", "render-open", "render-close", "deliver-progress",
      "revision-deadline", "control-watchdog", "publication-acknowledge"].includes(action.kind)
      && !enabled(compilations).some((entry) => entry.kind === action.kind && entry.id === action.id))
      throw new Error(`Dependency-invalid scheduler action ${JSON.stringify(action)}`)
    if (action.kind === "callback-mode") {
      callbackMode = action.mode === "not-admitted" ? "not-admitted" : action.mode === "failed" ? "failed" : "normal"
    }
    else if (action.kind === "asset-capacity") assetCapacity = action.value
    else if (["attachment-stage", "attachment-ready", "attachment-join-lost", "attachment-undo"].includes(action.kind)) {
      const id = `instance-${action.value ?? 0}`
      const attachment = attachments.get(id)
      if (action.kind === "attachment-stage") {
        if (!prepared) throw new Error("Attachment staging needs a prepared revision")
        attachments.set(id, { state: "staged", ready: false, revision: prepared.revision, joinLost: false })
      } else if (!attachment) throw new Error(`Unknown attachment ${id}`)
      else if (action.kind === "attachment-undo") { if (attachment.state === "staged") attachment.state = "retired" }
      else if (action.kind === "attachment-join-lost") attachment.joinLost = true
      else if (action.kind === "attachment-ready") {
        if (attachment.state === "retired") ignoredReady.stale++
        else if (attachment.joinLost) ignoredReady.joinLost++
        else attachment.ready = true
      }
    }
    else if (action.kind === "control-wake") take(commands, action.id).execute()
    else if (action.kind === "revision-deadline") {
      const current = pendingControl
      if (!current) throw new Error("Revision deadline without pending revision")
      record({ event: "revision-deadline", id: current.id, milliseconds: 2000, hostLoss: false })
      pendingIpc.get(current.id)?.(new Error("Native graph revision reply timed out; inspect revision status."))
      pendingIpc.delete(current.id)
      pendingControl = undefined
      // The native request/reply may still arrive. Do not dispatch queued sends
      // here: rejectPending(error, false) waits for an enqueue or a later reply.
    }
    else if (action.kind === "control-watchdog") {
      // A1 never accepts recording, so no recording Finish can protect this slot.
      record({ event: "control-watchdog", milliseconds: 2000, hostLoss: true })
      lose()
    }
    else if (action.kind === "publication-acknowledge") acknowledgePublication()
    else if (action.kind === "deliver-reply") {
      const reply = take(replies, action.id)
      reply.deliver()
      if (plant === "stale-overwrite" && reply.name === "parameters" && appliedSequence > 1n && active) {
        const utility = [...active.processors.values()].find((processor) => processor.kind === 1)
        if (utility) gainOverrides.set(utility.instance, 0)
      }
    } else if (action.kind === "resolve-compile") take(compilations, action.id).execute()
    else if (action.kind === "render-close") {
      // The drain reads the epoch this callback applied when it began, not the one queued since.
      renderOpen = false
      completeRender()
    } else if (action.kind === "render-block" || action.kind === "render-open") {
      if (!started || lost) throw new Error("Render without host")
      renderEpoch++
      if (transport) {
        const value = transport; transport = undefined
        if (epoch !== value.epoch) {
          dropBank(activeBank)
          epoch = value.epoch; activeBank = { ...activeBank, epoch, through: BigInt(value.frame), window: 0n, complete: false, sources: new Map(), sourceHistory: new Map(), events: new Map() }
        }
        running = value.running; frame = BigInt(value.frame); transition = value.transitionId ?? transition
        if (!running && latencyReadyEpoch !== undefined) {
          latencyReadyEpoch = undefined; latencyCompletionGeneration++
          record({ event: "latency-transition-complete-on-pause", latencyCompletionGeneration, renderEpoch })
        }
      }
      if (publicationRequested() && seam > 0n && frame > seam) {
        // The callback consumes the request and defers it (audio-host.cpp:5250-5254); the publication stays in flight
        // until an Inspect clears the deferral (:2986).
        publicationDeferred = true; rebaseRequired = true
        record({ event: "callback-rebase-required", frame, seam })
      }
      if (publicationRequested() && (seam === 0n || frame === seam)) {
        publicationClaimed = true
        record({ event: "callback-publication-claimed", revision: prepared?.revision })
      } else if (action.kind === "render-open") renderOpen = true
      else completeRender()
    } else if (action.kind === "deliver-progress") {
      if (!progress) throw new Error("No populated progress")
      deliveredProgressSequence = progress.progressSequence
      onProgress(progress)
      const bytes = progressFrame({ ...progress, admissionCapacityGeneration: capacityGeneration, latencyCompletionGeneration: latencyCompletionGeneration }, action.mode === "legacy")
      record({ event: "progress-wire", byteLength: bytes.length, hex: Buffer.from(bytes).toString("hex") })
      for (const listener of progressListeners) listener(decodeProgress(bytes))
    } else if (action.kind === "overwrite-override") {
      // A host-only change of what a retained slot's override holds: no controller dispatch caused it.
      for (const instance of gainOverrides.keys()) gainOverrides.set(instance, action.value ?? 0)
    } else if (action.kind === "hold-progress") {
      if (!progress) throw new Error("No populated progress")
      heldProgress = progress
    } else if (action.kind === "deliver-held-progress") {
      if (!heldProgress) throw new Error("No held progress")
      const frame = heldProgress
      heldProgress = undefined
      onProgress(frame)
      const bytes = progressFrame({ ...frame, admissionCapacityGeneration: capacityGeneration, latencyCompletionGeneration: latencyCompletionGeneration }, false)
      record({ event: "progress-wire", held: true, byteLength: bytes.length, hex: Buffer.from(bytes).toString("hex") })
      for (const listener of progressListeners) listener(decodeProgress(bytes))
    } else if (action.kind === "grant-capacity") {
      // The only fact that legitimately reopens a capacity-blocked adoption: native reports more admission capacity.
      capacityGeneration++
      if (progress) progress = { ...progress, progressSequence: ++progressSequence, admissionCapacityGeneration: capacityGeneration }
      record({ event: "capacity-granted", capacityGeneration })
    } else return false
    return true
  }
  const lose = () => {
      lost = true; domain++
      // The desktop supervisor rejects outstanding IPC requests on child loss.
      // Silently hanging them forever would be an impossible native schedule.
      for (const reject of pendingIpc.values()) reject(new Error("Native playback host connection was lost."))
      pendingIpc.clear(); commands.length = 0; replies.length = 0; queuedSends.length = 0; pendingControl = undefined
      assets.clear(); gainOverrides.clear(); activeBank.sources.clear(); preparedBank = undefined
      retired = undefined; retiredBank = undefined; latencyReadyEpoch = undefined
      controls.length = 0; urgentQueue.length = 0; patch = undefined; transport = undefined; publicationInFlight = false; publicationClaimed = false; publicationAcknowledged = false; publicationDeferred = false; renderOpen = false
      deliveredProgressSequence = progressSequence
      // Snapshot: loss callbacks unsubscribe and mutate this listener set.
      const listeners = Array.from(lossListeners)
      for (const listener of listeners) listener("Native playback host connection was lost.")
  }
  return {
    enabled, act, lose, submittedGraphs, restampedSequences, publicationCancelled, restampCounts,
    get nextId() { return nextId }, set nextId(value: typeof nextId) { nextId = value },
    get commands() { return commands },
    get pendingControl() { return pendingControl },
    get queuedSends() { return queuedSends },
    get replies() { return replies },
    get active() { return active },
    get prepared() { return prepared },
    get retired() { return retired },
    get retirementEpoch() { return retirementEpoch },
    get latencyReadyEpoch() { return latencyReadyEpoch },
    // Native's `publication_in_flight`: set by Publish, still set after the callback's acknowledgement.
    get publicationPending() { return publicationInFlight },
    get publicationRevision() { return publicationRevision },
    get publicationRequested() { return publicationRequested() },
    get publicationAcknowledged() { return publicationAcknowledged },
    get publicationDeferred() { return publicationDeferred },
    get seam() { return seam },
    get publicationClaimed() { return publicationClaimed },
    get rebaseRequired() { return rebaseRequired },
    get running() { return running },
    get started() { return started },
    get frame() { return frame },
    get epoch() { return epoch },
    get renderEpoch() { return renderEpoch },
    get progressSequence() { return progressSequence },
    get deliveredProgressSequence() { return deliveredProgressSequence },
    get capacityGeneration() { return capacityGeneration },
    get latencyCompletionGeneration() { return latencyCompletionGeneration },
    get activeBank() { return activeBank },
    get preparedBank() { return preparedBank },
    get retiredBank() { return retiredBank },
    get progress() { return progress },
    get transport() { return transport },
    get controls() { return controls },
    get patch() { return patch },
    get patchMode() { return patchMode }, set patchMode(value: typeof patchMode) { patchMode = value },
    get patchFloor() { return patchFloor },
    get refuseParameters() { return refuseParameters }, set refuseParameters(value: number) { refuseParameters = value },
    get clearOverridesOnPublish() { return clearOverridesOnPublish }, set clearOverridesOnPublish(value: boolean) { clearOverridesOnPublish = value },
    get blockAsset() { return blockAsset }, set blockAsset(value: typeof blockAsset) { blockAsset = value },
    get blockAssetError() { return blockAssetError }, set blockAssetError(value: typeof blockAssetError) { blockAssetError = value },
    get rejectPrepare() { return rejectPrepare }, set rejectPrepare(value: typeof rejectPrepare) { rejectPrepare = value },
    get splitRender() { return splitRender }, set splitRender(value: boolean) { splitRender = value },
    get lost() { return lost },
    get domain() { return domain }, set domain(value: typeof domain) { domain = value },
    get utilityIncarnation() { return utilityIncarnation },
    get assets() { return assets },
    get attachments() { return attachments },
    get ignoredReady() { return ignoredReady },
    get leases() { return leases },
    get counts() { return counts },
    get published() { return published },
    get appliedBatches() { return appliedBatches },
    get synthValues() { return synthValues },
    get urgentDropped() { return urgentDropped },
    get historySlotsReplaced() { return historySlotsReplaced },
    get lastParameterSequence() { return lastParameterSequence },
    applications, contextHistory, domainCommands,
    simple, reclaimAssets, reclaimable, nativeFields, endLeases, bridge
  }
}
