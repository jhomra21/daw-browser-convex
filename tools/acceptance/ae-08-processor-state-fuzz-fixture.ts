import { createNativePlaybackController } from "../../src/lib/desktop/native-playback-controller"
import { createNativeProcessorStateOwner, projectedProcessorDesired, timedProcessorDesired, type AdoptionIntent, type Execution, type ProcessorDesired } from "../../src/lib/desktop/native-processor-state-owner"
import { getEffectTiming } from "@daw-browser/audio-engine/effects/timing"
import { compileLivePlaybackSnapshot, type LivePlaybackSnapshotInput } from "../../src/lib/live-playback-snapshot"
import { compileLiveNativeProjection } from "@daw-browser/audio-engine/live-native-projection"
import { createDefaultDelayParams, createDefaultSpectralParams, createDefaultSynthParams, createDefaultUtilityParams, normalizeDelayParams, type TrackInstrumentParams } from "@daw-browser/shared"
import type { AudioEffectRuntimeInstance } from "@daw-browser/audio-engine/audio-engine"
import type { EffectParamsCommitPayload } from "../../src/lib/undo/types"
import { z } from "zod"
import attachmentPlan, { attachmentInstanceId, workerTransportFrames } from "./ae-08-processor-state-fuzz-attachment"
import { fixtureEdit, utilityGainPayload } from "./ae-08-processor-state-fuzz-edit"
import { createProcessorEditRegistry } from "../../src/components/timeline/create-processor-edit-registry"
import { createPreparedStretchArtifactRepository } from "@daw-browser/audio-engine/prepared-stretch-store"
import { SYNTH_KIND_ID } from "../../src/lib/live-processor-control"
import type { LiveProcessorControlRequest, LiveProcessorEditIdentity } from "../../src/lib/live-processor-control"
import { captureNativeBuiltInParameterValues, captureNativeBuiltInStateCommit, nativeBuiltInPatchTiming, type NativeBuiltInParameterPayload } from "../../src/lib/desktop/native-built-in-parameter-mapper"
import createFuzzHost, { type Action } from "./ae-08-processor-state-fuzz-host"
import { expectedTopology, ownershipFailures, settlementFailure, quiescenceFailure, endingDomainFailure, rebuildResultFailure, decodeGraph, fields, masterGainOf, coverageFailure, rebuildFailure, convergenceFailure, topologyFailure, staleFailure, receiptFailure, rejectionClassification, recordBatches, proofDeadlineFailure, endingRejectionClass, initialContent, reduceDesired, type Content, type Defect, type Failure } from "./ae-08-processor-state-fuzz-oracle"

type Command = { id: number; name: string; execute: () => void }
type Waiter = { id: number; name: string; settled: boolean; result?: unknown; content: Content; domain: number; nativeIncarnation: number; synth?: number;
  fieldOrder: number; applicationStart: number; epoch: number; editId?: string; editOrder: number; settlementApplied?: bigint; settledDomain?: string; settledProven?: boolean; settlementDomain?: number; settlementEpoch?: number; settlementIncarnation?: number; settlementPatchFloor?: number }

export const generatorVersion = "controller-a1-final-r2-v1"
// The owner's one entry for a patch is `deliver` (design L1/L4), and its reply is `patchReplied` (L5). These two keep the
// replays below in the vocabulary they were written in: `ownerPatch` answers the old "superseded" when nothing needs
// sending, and `matchesPrepared` is the content the prepared graph already carries (the owner's installed content).
const ownerPatch = (owner: ReturnType<typeof createNativeProcessorStateOwner>, desired: ProcessorDesired, matchesPrepared: () => boolean) => {
  const { instanceId, kindId, incarnation } = desired.target
  if (matchesPrepared()) owner.configured(owner.includedOrder(), new Map([[instanceId, { kindId, state: desired.content.state, values: desired.content.values }]]))
  const { plan } = owner.deliver({ key: instanceId, editId: desired.id, order: desired.order, kindId, incarnation, epoch: 1,
    state: desired.content.state, values: desired.content.values ?? {}, desired })
  return plan.carrier === "patch" ? plan.execution : { superseded: true as const }
}
const ownerPatchReplied = (owner: ReturnType<typeof createNativeProcessorStateOwner>, execution: Execution, outcome: "applied" | "claimed") =>
  owner.patchReplied(execution, outcome === "applied" ? { kind: "applied" } : { kind: "claimed", token: 1n })
const synthInstanceId = "synth:1"
// Cutoff is the synth parameter the instrument-urgent witness edits (synthParameterRegistry target 3).
const synthCutoffTarget = 3
type Controller = ReturnType<typeof createNativePlaybackController>
type Candidate = {
  intent: AdoptionIntent
  status: string
  incarnation: number
  captured: PromiseWithResolvers<string>
  release: PromiseWithResolvers<void>
  settled?: ReturnType<Controller["adoptSchedule"]>
}
class FixtureBuffer implements AudioBuffer {
  readonly length = 48_000
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  readonly duration = 1
  private readonly planes = [new Float32Array(this.length), new Float32Array(this.length)]
  getChannelData(channel: number) {
    const plane = this.planes[channel]
    if (!plane) throw new Error("Invalid fixture channel")
    return plane
  }
  copyFromChannel(destination: Float32Array<ArrayBuffer>, channel: number, start = 0) {
    destination.set(this.getChannelData(channel).subarray(start, start + destination.length))
  }
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number, start = 0) {
    this.getChannelData(channel).set(source, start)
  }
}

export default function createControllerFixture(
  record: <Value>(event: Value) => void,
  plant?: Defect,
  replay = false,
  unfairHost = false,
  attachment = false,
  registry = false,
  instrument: boolean | "key-only" = false,
  history = false,
  synthEffects = false,
  stretch = false,
) {
  // All mutable host state belongs to this fixture, never shared between seeds.
  // Supervisor transactionOwner gating is out of scope: this controller
  // fixture opens transactions only during initial install, never overlaps
  // an independent transaction owner with live processor operations.
  const buffer = new FixtureBuffer()
  let sampleSource = "source"
  let incarnation = 1
  let desired = { ...initialContent }
  let gainOrder = 0
  let fftOrder = 0
  const gainBoundaries: number[] = []
  let reAddedAt: number | undefined
  let freshCandidate: Candidate | undefined
  let freshRevision: number | undefined
  let freshPublication: number | undefined
  const fftBoundaries: number[] = []
  let minimumCoverageBlocks: number | undefined
  const candidateStatuses: Record<string, number> = {}
  let populatedOwnershipChecks = 0
  let boundaryWaiter: Waiter | undefined
  let crossedIncarnation = false
  let attachmentLatency = 0
  const inspectStatuses: string[] = []
  let pauseCompletions = 0
  let identityBaseline: { dispatches: number; sequence?: number } | undefined
  // The edits the fixture issues carry the parameter values a registry edit captures (see `fixtureEdit`).
  let valued = false
  let urgentBaseline: number | undefined
  let synthId = synthInstanceId
  let utilitySwap = false
  const utilityPayload = (gain: number): NativeBuiltInParameterPayload => ({ effect: "utility", instanceId: "utility:1", targetId: "track",
    from: { version: 1, state: createDefaultUtilityParams() },
    to: { version: 1, state: { ...createDefaultUtilityParams(), gainDb: gain, swap: utilitySwap } } })
  let synthParams = createDefaultSynthParams()
  let replacementValues: Readonly<Record<string, number>> | undefined
  // History mode orders desired content as the product does: by the registry's
  // global edit order, not by the fixture's own sequence.
  const stateSequence = (content: Content) => history && processorEdits ? processorEdits.sequence() : content.sequence
  const effects = (content: Content): AudioEffectRuntimeInstance[] => [
    ...(content.utilityPresent === false ? [] : [{ id: "utility:1", kind: "utility", params: { version: 1, state: { ...createDefaultUtilityParams(), gainDb: content.gain, swap: utilitySwap } } } satisfies AudioEffectRuntimeInstance]),
    { id: "spectral:1", kind: "spectral", params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: content.fft } } },
  ]
  const snapshot = (content: Content, masterVolume = 1, warped = stretch): LivePlaybackSnapshotInput => ({
    revision: 1, processorStateSequence: stateSequence(content), bpm: 120,
    transport: { state: "playing", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
    tracks: [
      { id: "track", name: "Track", volume: 1, clips: content.sample ? [{
        id: "clip", name: "Clip", color: "#fff", startSec: 0, duration: 1,
        sourceAssetKey: sampleSource, sourceKind: "url", sampleUrl: `fixture:${sampleSource}`, buffer,
        ...(warped && { audioWarp: { enabled: true, mode: "stretch" as const, sourceBpm: 200 } }),
      }] : [] },
      { id: "parallel", name: "Parallel", volume: 1, clips: [] },
      ...(content.routed ? [{ id: "extra", name: "Extra", volume: 1, clips: [] }] : []),
    ],
    renderState: { fx: { masterVolume, masterFxInstances: [], trackFx: { ...(instrument && !synthEffects && { parallel: {
      instances: [],
      instrument: { kind: "synth", instanceId: synthId, params: synthParams },
    } }), track: {
      instances: effects(content),
      ...(synthEffects && { instrument: { kind: "synth", instanceId: synthId, params: synthParams } }),
    } } }, automationEnvelopes: [] }, sidechainRoutes: [],
  })
  const compilations: Command[] = []
  const waiters: Waiter[] = []
  let outstandingWaiters = 0
  let releaseMutationWaiter: (() => void) | undefined
  const failures: Failure[] = []
  const checks = new Map<string, number>()
  const checked = (invariant: string) => checks.set(invariant, (checks.get(invariant) ?? 0) + 1)
  const fail = (invariant: string, detail: string, classification = h.lost ? "dead-host" : "live", failureClass?: string) => {
    if (!failures.some((failure) => failure.invariant === invariant && failure.detail === detail)) {
      failures.push({ invariant, detail, domain: classification, class: failureClass }); record({ event: "failure", invariant, detail, domain: classification, class: failureClass })
    }
  }
  // A wait left open by a domain that moved on (or the pause/seek that moved it) is the ending-domain symptom, not starvation.
  const unsettledDomain = () => waiters.some((waiter) => !waiter.settled
    && (waiter.domain !== h.domain || waiter.name === "pause" || waiter.name === "seek")) ? "ending-transport-domain" : h.lost ? "dead-host" : "live"
  const pendingRejections: Waiter[] = []
  // The highest batch a delivered progress frame has named as applied.
  let deliveredApplied = 0n
  const rejectionClasses: { id: number; name: string; domain: string; result: unknown; classification: string; class?: string }[] = []
  let drainWitness: { steps: number; bound: number; exhausted: boolean } | undefined
  let confirmedGain = 0
  let confirmedOrder = 1
  let slotsReplacedSeen = 0
  // Native dropped an override with its slot: I2 is judged again once an application restores the desired value.
  let awaitingRestore = false
  let quiescentCounts: string | undefined
  let ownershipWitness: string | undefined
  let expectedPrepareCount: number | undefined
  // Schedule-compile knobs and counters: a compile that disagrees with the prepared loop, one that fails, and the
  // faults and compiles seen since a mark.
  let compileLoop = false
  let compileUnsupported = false
  let compileCount = 0
  let productFaults = 0
  const heldAssets = () => new Set([...h.assets].filter(([, asset]) => !asset.released).map(([id]) => id))
  // What a refusal left behind, to count the attempt a returning capacity buys from there.
  let afterRefusal = { compiles: 0, prepares: 0 }
  const nativeMaster = (context: string | undefined) => ({ native: masterGainOf(h.active), compiled: Math.fround(contextVolume(context)) })
  let mark = { faults: 0, compiles: 0, epoch: 0, transports: 0, prepares: 0, spawns: 0, publishes: 0, revision: 0, assets: new Set<number>(), attempts: 0, edits: 0 }
  // Adoption witnesses name their intents "key/schedule/context/loop": a context is an instrument override of that
  // name (one object per name), so another name is another reference, and any loop part asks for a loop.
  const overrides = new Map<string, { targetId: string; instrument: TrackInstrumentParams }>()
  const overrideNamed = (name: string) => {
    const known = overrides.get(name)
    if (known) return known
    const made = { targetId: name, instrument: { kind: "synth", instanceId: synthInstanceId, params: createDefaultSynthParams() } satisfies TrackInstrumentParams }
    overrides.set(name, made)
    return made
  }
  // A compile context compiles to its own master volume (the plain one to 1), so what native published says which context it was.
  const contextVolume = (name: string | undefined) => name === undefined ? 1 : 1 / (2 + [...overrides.keys()].indexOf(name))
  const adoptionIntent = (mode = ""): AdoptionIntent => {
    const [key, schedule, context, loop] = mode.split("/")
    return { key: key || "fixture", schedule: schedule || key || "fixture", context: context ? { instrumentOverride: overrideNamed(context) } : {},
      loop: loop ? { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 } : { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } }
  }
  // A schedule compiled while a content tag is set has that content, so two intents can compile to the same one; any
  // other snapshot is distinct from every other.
  const contentTags = new WeakMap<object, number>()
  let contentTag: number | undefined
  let distinctSnapshots = 0
  const compileContexts: (string | undefined)[] = []
  // The key of the attempt each compile ran for.
  const compileKeys: (string | undefined)[] = []
  const outcomeOf = (name: string) => {
    const parsed = z.object({ status: z.string(), reason: z.string().optional() }).safeParse(waiters.find((waiter) => waiter.name === `schedule-adoption:${name}`)?.result)
    return parsed.success ? parsed.data : undefined
  }
  let compilationFloor: number | undefined
  let latencySubmittedEpoch = 0n
  let latencyProgressOpportunities = 0
  let lastLatencyProgress = 0n
  let blockedCapacityGeneration = 0n
  let attachmentEdits = 0
  let terminalPublication: { kind: string; pending: boolean; validDomain: boolean } | undefined
  // Registry mode reports real target incarnations through the production
  // registry, observing the fixture's desired model as Timeline observes its
  // projection. Other seeds keep the unregistered host.
  const processorEdits = registry || history ? createProcessorEditRegistry(() => 120) : undefined
  const observeDesired = () => {
    if (!processorEdits) return
    const compiled = compileLivePlaybackSnapshot(snapshot(desired))
    if (compiled.supported) processorEdits.observe(compiled.snapshot.mixer.fx)
  }
  // Non-registry scenarios allocate projection identities with their commands,
  // using the same fixture order as their explicit deliveries. No read or
  // controller fallback allocates an identity, and this map selects no winner.
  const projectedEdits = new Map<string, LiveProcessorEditIdentity>()
  const allocateProjection = () => {
    if (processorEdits) return
    projectedEdits.clear()
    for (const instance of effects(desired)) {
      const payload: NativeBuiltInParameterPayload = instance.kind === "utility" ? utilityPayload(desired.gain)
        : { effect: "spectral", instanceId: "spectral:1", targetId: "track",
          from: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: desired.fft } },
          to: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: desired.fft } } }
      const edit = fixtureEdit(payload, desired.sequence, 120, incarnation, true)
      if (!edit) throw new Error("Projection requires a fixture-allocated identity")
      projectedEdits.set(instance.id, edit)
    }
    // Key-only contract witnesses have no registry synth edit, unlike product synth deliveries.
    if (instrument && instrument !== "key-only") projectedEdits.set(synthId, {
      id: `synth-projection:${desired.sequence}`, order: desired.sequence,
      target: { nodeId: synthEffects ? "track" : "parallel", instanceId: synthId, kindId: SYNTH_KIND_ID, incarnation: 1 },
      content: { params: { kind: "synth", instanceId: synthId, params: synthParams } },
    })
  }
  const updateDesired = (change: Parameters<typeof reduceDesired>[1]) => {
    desired = reduceDesired(desired, change)
    allocateProjection()
  }
  allocateProjection()
  const h = createFuzzHost((event) => {
    if (z.object({ event: z.literal("latency-transition-complete-on-pause") }).safeParse(event).success) pauseCompletions++
    record(event)
  }, plant, unfairHost, fail, () => checkOwnership())
  const { simple, reclaimAssets, nativeFields, endLeases, bridge } = h
  // The controller names the record behind every parameter batch, so a waiter owns the batches of its record whoever sent them.
  const dispatches: { editId: string; sequence: bigint }[] = []
  // A schedule candidate's Stretch artifact leases are the only resources it holds before its publication: the real
  // repository lends them, and these counts are what the candidate's disposal must balance.
  const stretchLeases = { acquired: 0, released: 0 }
  let compileCheckpoint: Candidate | undefined
  const controller = createNativePlaybackController({
    ...(stretch && { createPreparedStretchRepository: () => {
      const repository = createPreparedStretchArtifactRepository()
      return { ...repository, acquireLease: async (manifest: Parameters<typeof repository.acquireLease>[0]) => {
        const lease = await repository.acquireLease(manifest)
        stretchLeases.acquired++
        return { ...lease, release: async () => { stretchLeases.released++; await lease.release() } }
      } }
    } }),
    bridge, onProcessorDispatch: ({ editId, sequence }) => dispatches.push({ editId, sequence }), getProjectId: () => "fixture-project", getProjectGeneration: () => 1,
    fingerprintSnapshot: (snapshot) => {
      const tag = contentTags.get(snapshot)
      return tag === undefined ? `distinct:${++distinctSnapshots}` : `content:${tag}`
    },
    compileSnapshot: (transportValue, context) => {
      const checkpoint = compileCheckpoint
      compileCheckpoint = undefined
      if (history) observeDesired()
      compileCount++
      compileContexts.push(context?.instrumentOverride?.targetId)
      compileKeys.push(controller.adoptionWitness().running)
      const compiled = compileLivePlaybackSnapshot({ ...snapshot(desired, contextVolume(context?.instrumentOverride?.targetId)),
        processorStateSequence: compilationFloor ?? stateSequence(desired),
        transport: compileLoop ? { ...transportValue, loopEnabled: true, loopStartSec: 0, loopEndSec: 1 } : transportValue })
      const captured = attachment && compiled.supported ? { ...compiled,
        snapshot: { ...compiled.snapshot, nativeExternalAttachmentPlan: attachmentPlan(attachmentLatency) } } : compiled
      if (captured.supported && contentTag !== undefined) contentTags.set(captured.snapshot, contentTag)
      const gate = Promise.withResolvers<typeof captured | { supported: false; reasons: string[] }>()
      const id = ++h.nextId
      compilations.push({ id, name: "compile", execute: () => gate.resolve(compileUnsupported ? { supported: false, reasons: ["unsupported"] } : captured) })
      record({ event: "compile", id, captured: desired })
      return gate.promise.then(async compilation => {
        if (checkpoint) {
          if (checkpoint.status === "compiling") checkpoint.status = compilation.supported ? "captured" : "failed"
          if (reAddedAt !== undefined && checkpoint.incarnation === incarnation && compilation.supported)
            freshCandidate ??= checkpoint
          checkpoint.captured.resolve(checkpoint.status)
          await checkpoint.release.promise
        }
        return compilation
      })
    },
    getProcessorTarget: processorEdits?.target ?? ((_nodeId, instanceId) => {
      const latest = projectedEdits.get(instanceId)
      return latest && { kindId: latest.target.kindId, incarnation: latest.target.incarnation, latest }
    }),
    getDesiredProcessorState: () => {
      observeDesired()
      // Processor latency does not depend on the clip's warp, and a Stretch clip projects only with its artifacts.
      const compiled = compileLivePlaybackSnapshot(snapshot(desired, 1, false))
      if (!compiled.supported) throw new Error("Fixture snapshot unsupported")
      const projection = compileLiveNativeProjection({ tracks: compiled.snapshot.tracks, bpm: 120,
        sampleRateHz: 48_000, revision: 1, epoch: h.epoch, firstSequence: 1, fx: compiled.snapshot.mixer.fx })
      if (!projection.supported) throw new Error("Fixture graph unsupported")
      return { sequence: stateSequence(desired), graph: projection.graph }
    },
    reportFault: (message) => { productFaults++; record({ event: "product-fault", message }) },
  })
  // The intents are dropped this many microtask turns after the controller is handed the Inspect that proves its publication
  // promoted: a sweep of that value walks the drop across adoption, the publication's cleanup and the owner's settlement.
  let handoffTurns: number | undefined
  let handoffDroppedRunning: boolean | undefined
  const inspectRevision = bridge.session.revisions.inspect
  bridge.session.revisions.inspect = async (request) => {
    const reply = await inspectRevision(request)
    if (handoffTurns !== undefined && reply.ok && reply.revision.status === "published") {
      const turns = handoffTurns
      handoffTurns = undefined
      void (async () => {
        for (let turn = 0; turn < turns; turn++) await Promise.resolve()
        handoffDroppedRunning = controller.adoptionWitness().running !== undefined
        controller.dropAdoptionIntents()
      })()
    }
    return reply
  }
  let liveEditCounts: Map<string, number> | undefined
  let candidate: Candidate | undefined
  // A captured preparation belongs to its original domain. Unlike a standing
  // desired schedule, its caller withdraws the intent when that domain ends.
  const withdrawCandidate = () => {
    if (candidate?.status === "compiling" || candidate?.status === "captured") controller.dropAdoptionIntents()
  }
  const watch = <Value>(name: string, promise: Promise<Value>, synth?: number, editId?: string) => {
    const submittedNative = nativeFields(h.active)
    const latestEdit = processorEdits?.target("track", "utility:1")?.latest
    const waiter: Waiter = { id: ++h.nextId, name, settled: false, content: { ...desired }, domain: h.domain, synth,
      fieldOrder: name === "latency" ? fftOrder : gainOrder, applicationStart: h.applications.length, epoch: h.epoch, nativeIncarnation: h.utilityIncarnation, editId,
      editOrder: latestEdit && latestEdit.id === editId ? latestEdit.order : desired.sequence }
    waiters.push(waiter)
    outstandingWaiters++
    void promise.then((result) => {
      if (plant === "swallow-waiter" && name === "wrapper-waiter") return
      if (plant === "never-wake-latency" && name === "latency") {
        releaseMutationWaiter = () => {
          outstandingWaiters--; waiter.settled = true; waiter.result = result
          record({ event: "mutation-cleanup-settlement", id: waiter.id, name, result })
        }
        return
      }
      outstandingWaiters--; waiter.settled = true; waiter.result = result
      waiter.settlementDomain = h.domain; waiter.settlementEpoch = h.epoch
      waiter.settlementIncarnation = h.utilityIncarnation
      waiter.settlementPatchFloor = h.patchFloor
      waiter.settlementApplied = deliveredApplied
      waiter.settledProven = waiter.synth !== undefined && h.synthValues.get(synthCutoffTarget) === waiter.synth
      waiter.settledDomain = h.lost ? "dead-host" : waiter.domain !== h.domain ? "ending-transport-domain"
        : (name === "flush" || name === "preview")
          && (nativeFields(h.active).gain === null || waiter.nativeIncarnation !== waiter.settlementIncarnation) ? "ending-incarnation"
        : !controller.isPrepared() ? "dead-session" : "live"
      record({ event: "settled", id: waiter.id, name, result })
      // A typed policy terminal is not a legacy rejected flush. In particular,
      // unconfirmed permits an application whose proof was lost, and a later recovery
      // does not retroactively contradict an earlier refusal. A refusal of a record
      // already applied before this settlement still is a false rejection.
      const deliveryRejection = z.object({ state: z.literal("refused") }).safeParse(result)
      const refusedAfterApplication = deliveryRejection.success && h.applications.slice(waiter.applicationStart).some(proof =>
        proof.incarnation === waiter.nativeIncarnation && proof.epoch === waiter.epoch
        && (name === "latency" ? proof.strategy === "publication" && proof.content.fft === waiter.content.fft
          : proof.strategy === "parameters" && proof.sequence !== undefined && proof.content.gain === waiter.content.gain
            && recordBatches(dispatches, waiter.editId).includes(BigInt(proof.sequence))))
      // An urgent (instrument) wait is judged only for the ending domain; its live-domain proof is the urgent-event check above.
      if ((["flush", "preview", "latency"].includes(name) || synth !== undefined && waiter.settledDomain === "ending-transport-domain")
        && refusedAfterApplication) pendingRejections.push(waiter)
      const rebuildResult = z.union([z.string(), z.object({ status: z.string() }).transform((value) => value.status)]).safeParse(result)
      if (name === "candidate" && rebuildResult.success)
        candidateStatuses[rebuildResult.data] = (candidateStatuses[rebuildResult.data] ?? 0) + 1
      if (liveEditCounts && rebuildResult.success) {
        const status = rebuildResult.data
        checked("I9")
        if (rebuildResultFailure(status))
          fail("I9", "Supported live edit yielded rebuild", undefined, attachment ? "attachment-spurious-rebuild" : undefined)
      }
      if (z.object({ state: z.literal("applied") }).safeParse(result).success && (["flush", "preview", "latency", "gain-patch", "wrapper-flush"].includes(name) || synth !== undefined)) {
        checked("I3")
        const matches = (content: ReturnType<typeof nativeFields>) => name === "latency"
          ? content.fft === waiter.content.fft : content.gain === waiter.content.gain
        // Promise continuations may run after a subsequent native command. Judge the independent callback
        // record (or already installed content at registration), not whatever happens to be playing later.
        // Renderer removal/re-add can be coalesced before publication. Its registry
        // creation token changes while native retains the same physical history slot.
        const proven = matches(submittedNative) || h.applications.slice(waiter.applicationStart).some(application =>
          application.incarnation === waiter.nativeIncarnation && matches(application.content))
        if (synth !== undefined ? !waiter.settledProven : !proven)
          fail("I3", "Applied receipt has no matching native application")
        if (synth === undefined && name !== "latency" && waiter.content.sequence >= confirmedOrder) {
          confirmedOrder = waiter.content.sequence; confirmedGain = waiter.content.gain
        }
      }
    }, (error) => { outstandingWaiters--; waiter.settled = true; waiter.result = String(error); record({ event: "rejected", id: waiter.id, name, error: String(error) }) })
    return waiter
  }
  const patchGain = (gain: number, sequence: number, aheadOrder = false) => {
    gainBoundaries.push(h.applications.length)
    gainOrder++
    updateDesired({ gain, sequence })
    // Registry mode submits the patch as its target's edit; `ahead` gives it an
    // order beyond every later allocation.
    const incarnationNow = processorEdits?.target("track", "utility:1")?.incarnation
    const payload = utilityPayload(gain)
    const edit = incarnationNow === undefined ? undefined
      : fixtureEdit(payload, aheadOrder ? sequence + 1000 : sequence, 120, incarnationNow, valued)
    watch("gain-patch", stateDelivery({ ...payload, edit }, sequence).settled)
  }
  const stateDelivery = (payload: NativeBuiltInParameterPayload, order: number) => {
    const captured = captureNativeBuiltInStateCommit(payload, 120)
    const timing = nativeBuiltInPatchTiming(payload)
    const identity = payload.edit ?? fixtureEdit(payload, order, 120, processorEdits?.target(payload.targetId, payload.instanceId ?? "")?.incarnation ?? incarnation, valued)
    if (!captured || !timing || !identity) throw new Error("State delivery needs a processor edit")
    // The cutover consumer submits a registry-shaped whole edit, including all captured live values.
    // Omitting them would let a graph-equal request leave a refused older parameter carrier unshadowed.
    return controller.deliverProcessor({ ...identity, content: { ...identity.content, state: captured.state, timing,
      values: identity.content.values ?? captureNativeBuiltInParameterValues(payload, 120) } })
  }
  // Preserve the identity's whole content, not only this request's live values.
  // A parameter carrier still owes proof of every field the identity names.
  const parameterDelivery = (request: LiveProcessorControlRequest, holds: boolean) => {
    const identity: LiveProcessorEditIdentity = request.edit ?? {
      id: `independent:${desired.sequence}`, order: desired.sequence,
      target: { nodeId: "track", instanceId: request.instanceId, kindId: 1, incarnation },
      content: { params: {} },
    }
    const captured = identity.content.timing?.input
    const absolute = captured?.kind === "utility"
      ? captureNativeBuiltInParameterValues({ effect: "utility", instanceId: "utility:1", targetId: "track",
        from: captured.params, to: captured.params }, 120) : undefined
    return controller.deliverProcessor({ ...identity, content: { ...identity.content,
      values: { ...absolute, ...identity.content.values,
        ...Object.fromEntries(request.values.map(value => [value.parameterId, value.value])) } } },
    { token: `gesture:${request.instanceId}:${identity.target.incarnation}`, holds })
  }
  const latency = (fft: Content["fft"], sequence: number) => {
    fftBoundaries.push(h.applications.length)
    fftOrder++
    latencySubmittedEpoch = h.renderEpoch
    latencyProgressOpportunities = 0; lastLatencyProgress = h.progressSequence
    updateDesired({ fft, sequence })
    const payload: EffectParamsCommitPayload = { effect: "spectral", instanceId: "spectral:1", targetId: "track",
      from: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 512 } },
      to: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: fft } } }
    watch("latency", stateDelivery(payload, sequence).settled)
  }
  const enabled = () => h.enabled(compilations)
  const act = (action: Action) => {
    observeDesired()
    record({ event: "action", action, enabled: enabled() })
    if (h.act(action, compilations, () => act({ kind: "loss" }), (progress) => {
      deliveredApplied = progress.appliedProcessorSequence > deliveredApplied ? progress.appliedProcessorSequence : deliveredApplied
      if (progress.progressSequence > lastLatencyProgress) {
        lastLatencyProgress = progress.progressSequence; latencyProgressOpportunities++
      }
    })) return
    if (action.kind === "attachment-setup" || action.kind === "registry-setup" || action.kind === "instrument-setup" || action.kind === "history-setup") {}
    else if (action.kind === "registry-gesture" || action.kind === "registry-preview") {
      // A gesture issued as the panel issues it: the registry allocates the edit, then the flush carries it.
      // A preview opens it and `registry-flush` ends it.
      for (const value of [action.value ?? -9, ...(action.second === undefined ? [] : [action.second])]) {
        gainBoundaries.push(h.applications.length)
        gainOrder++
        updateDesired({ gain: value, sequence: desired.sequence + 1 })
        observeDesired()
        const edit = processorEdits?.target("track", "utility:1")?.latest
        if (!edit) throw new Error("Registry gesture needs a registered utility target")
        const request = { instanceId: "utility:1", edit, values: [{ parameterId: "utility.gainDb", value }] }
        if (action.kind === "registry-preview") watch("preview", parameterDelivery(request, true).settled, undefined, request.edit.id)
        else watch("flush", parameterDelivery(request, false).settled, undefined, request.edit.id)
      }
    }
    else if (action.kind === "registry-flush") {
      const edit = processorEdits?.target("track", "utility:1")?.latest
      if (!edit) throw new Error("Registry flush needs a registered utility target")
      watch("flush", parameterDelivery({ instanceId: "utility:1", edit,
        values: [{ parameterId: "utility.gainDb", value: desired.gain }] }, false).settled, undefined, edit.id)
    }
    // Desired content that changes with no gesture or dispatch (history replay, an external writer).
    else if (action.kind === "desire") {
      updateDesired({ gain: action.value ?? 0, sequence: desired.sequence + 1 })
      observeDesired()
    }
    else if (action.kind === "replace-synth") { synthId = "synth:2"; allocateProjection() }
    // The next candidate configures the synth again: native gives its node a fresh slot.
    else if (action.kind === "synth-params") { synthParams = { ...synthParams, filter: { ...synthParams.filter, frequencyHz: 5000 } }; allocateProjection() }
    // The rollback replacement of a structurally different edit, as the panel issues it after a failed save.
    else if (action.kind === "registry-replace") {
      const failed = processorEdits?.target("track", "spectral:1")?.latest
      if (!processorEdits || !failed) throw new Error("Registry replace needs a registered spectral target")
      replacementValues = processorEdits.replace(failed, { effect: "spectral", instanceId: "spectral:1", targetId: "track",
        from: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 4096 } },
        to: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 512 } } })?.content.values
    }
    else if (action.kind === "start") watch("start", controller.start({
      ...snapshot(desired).transport, playheadSec: action.value ?? 0,
    }))
    else if (action.kind === "gain") patchGain(action.value ?? -6, action.sequence ?? desired.sequence + 1, action.mode === "ahead")
    else if (action.kind === "latency") latency(action.value === 4096 ? 4096 : action.value === 512 ? 512 : 2048, action.sequence ?? desired.sequence + 1)
    else if (action.kind === "membership") {
      const present = action.value !== 0
      if (present && desired.utilityPresent === false) { incarnation++; reAddedAt = h.applications.length; freshCandidate = undefined; freshRevision = undefined; freshPublication = undefined }
      confirmedOrder = 1
      updateDesired({ utilityPresent: present, gain: present ? 0 : desired.gain, sequence: desired.sequence + 1, incarnation })
      record({ event: "incarnation", present, incarnation, desired })
    }
    // A track neither the assets nor the processor membership name: the one kind of structural edit a resume's gate cannot see.
    else if (action.kind === "structure") updateDesired({ routed: action.value !== 0, sequence: desired.sequence + 1 })
    else if (action.kind === "sample") updateDesired({ sample: action.value !== 0, sequence: desired.sequence + 1 })
    else if (action.kind === "sample-source") sampleSource = action.mode ?? "source"
    else if (action.kind === "release-asset") {
      const id = h.assets.keys().next().value
      if (id === undefined) throw new Error("No acquired asset to release")
      watch("release-probe", bridge.session.releaseAsset(id))
    }
    else if (action.kind === "retire-predecessor") {
      // The explicit Retire the latency path sends; the schedule path never does.
      const revision = h.retired?.revision
      if (revision === undefined) throw new Error("No predecessor plan to retire")
      watch("retire-probe", bridge.session.revisions.retire({ projectId: "fixture-project", revision, hostGeneration: 7 }))
    }
    else if (action.kind === "prepare-candidate") {
      // Stop the actual callback of a public intent, not a returned candidate.
      // Re-add identity is pinned before the callback can be released.
      const observation: Candidate = { intent: adoptionIntent(`capture-${++h.nextId}`),
        status: "compiling", incarnation, captured: Promise.withResolvers<string>(), release: Promise.withResolvers<void>() }
      candidate = observation
      compileCheckpoint = observation
      observation.settled = controller.adoptSchedule(observation.intent, true).then(outcome => {
        observation.status = outcome.status
        observation.captured.resolve(outcome.status)
        return outcome
      })
      watch("candidate", observation.captured.promise)
    } else if (action.kind === "publish-candidate") {
      // The host allocates the runtime revision during adoption's host prepare,
      // so the pinned candidate's revision is the one active when its own
      // adoption settles.
      const published = candidate
      published?.release.resolve()
      const adoption = published?.status === "compiling" || published?.status === "captured"
        ? published.settled : controller.adoptSchedule(published?.intent ?? adoptionIntent(`publish-${++h.nextId}`), true)
      if (!adoption) throw new Error("Public adoption did not start")
      watch("adoption", adoption.then((result) => {
        if (published && published === freshCandidate && result.status === "adopted") freshRevision ??= h.active?.revision
        return result
      }))
    }
    else if (action.kind === "forget-candidate") candidate = undefined
    else if (action.kind === "dispose-candidate") {
      controller.dropAdoptionIntents()
      candidate?.release.resolve()
      if (candidate?.settled) watch("candidate-dispose", candidate.settled)
      candidate = undefined
    }
    else if (action.kind === "block-asset") {
      h.blockAsset = action.value !== 0
      h.blockAssetError = action.mode === "publication-pending" ? "asset-publication-pending" : "asset-capacity-exceeded"
      if (h.blockAsset) blockedCapacityGeneration = h.capacityGeneration
    }
    else if (action.kind === "reject-prepare") h.rejectPrepare = action.value !== 0
    else if (action.kind === "split-render") h.splitRender = action.value !== 0
    else if (action.kind === "compile-floor") compilationFloor = action.value
    else if (action.kind === "capture-ownership") {
      ownershipWitness = JSON.stringify(controller.adoptionWitness()); expectedPrepareCount = h.counts.get("prepare") ?? 0
    }
    else if (action.kind === "compile-loop") compileLoop = action.value !== 0
    else if (action.kind === "compile-unsupported") compileUnsupported = action.value !== 0
    else if (action.kind === "mark-compiles")
      mark = { faults: productFaults, compiles: compileCount, epoch: h.epoch, transports: h.counts.get("transport") ?? 0, prepares: h.counts.get("prepare") ?? 0,
        spawns: ["begin", "configure", "start"].reduce((sum, name) => sum + (h.counts.get(name) ?? 0), 0), publishes: h.counts.get("publish") ?? 0, revision: h.active?.revision ?? 0, assets: heldAssets(), attempts: h.counts.get("asset") ?? 0, edits: fftOrder + attachmentEdits }
    // The owner path the hook takes: an intent, retried only by an explicit request or a capacity fact. Each ask is
    // watched under the intent's name.
    else if (action.kind === "submit-schedule") {
      watch(`schedule-adoption${action.mode ? `:${action.mode}` : ""}`, controller.adoptSchedule(adoptionIntent(action.mode), action.value === 1))
      // Dropped in the same step, before the attempt has had a turn.
      if (action.second === 1) controller.dropAdoptionIntents()
    }
    else if (action.kind === "drop-intents") controller.dropAdoptionIntents()
    else if (action.kind === "arm-handoff-drop") handoffTurns = action.value
    // The intents dropped and another asked for in one step, while the dropped attempt has not yet seen its cancellation.
    else if (action.kind === "replace-schedule") {
      controller.dropAdoptionIntents()
      watch(`schedule-adoption:${action.mode}`, controller.adoptSchedule(adoptionIntent(action.mode), false))
    }
    else if (action.kind === "content-fingerprint") contentTag = action.value
    else if (action.kind === "patch-mode") h.patchMode = action.mode ?? "normal"
    else if (action.kind === "edit-values") valued = true
    else if (action.kind === "refuse-parameters") h.refuseParameters = action.value ?? 1
    else if (action.kind === "reclaim") reclaimAssets()
    else if (action.kind === "confirm") {
      const actual = nativeFields(h.active)
      if (actual.gain === desired.gain) { confirmedGain = desired.gain; confirmedOrder = desired.sequence }
    }
    else if (action.kind === "mutation-probe") {
      if (plant === "drop-batch" || plant === "lost-edit" || plant === "false-rejection") {
        gainBoundaries.push(h.applications.length)
        gainOrder++
        updateDesired({ gain: -17, sequence: desired.sequence + 1 })
        // Preview ACK proves admission only. Dropping its host batch should
        // fail convergence alone, not fabricate an application receipt.
        const edit = fixtureEdit(utilityGainPayload(desired.gain), desired.sequence, 120, incarnation)
        const result = parameterDelivery({ instanceId: "utility:1",
          edit,
          values: [{ parameterId: "utility.gainDb", value: desired.gain }] }, true).settled
        if (plant === "false-rejection") watch("preview", result.then(() => ({ state: "refused", reason: "native-refused" })), undefined, edit?.id)
        else watch("preview", result, undefined, edit?.id)
      }
      if (plant === "swallow-waiter") watch("wrapper-waiter", Promise.resolve({ state: "applied" }))
      // A broken instrument wrapper reports the urgent edit applied when only its admission happened.
      if (plant === "false-urgent-receipt") watch("instrument-flush", Promise.resolve({ state: "applied" }), 4000)
      // I8 starvation and I9 attachment rebuild require A2 schedules. Do not
      // inject the predicate's symptom into an oracle input in A1.
      if (plant === "force-rebuild") watch("forced-rebuild", simple("stop"))
      if (plant === "false-receipt") {
        // A broken result wrapper reports application for an immutable request
        // it never sent. Normal receipt verification, not a special assertion,
        // must reject this.
        updateDesired({ gain: 24, sequence: desired.sequence + 1 })
        watch("wrapper-flush", Promise.resolve({ state: "applied" }))
      }
      if (plant === "early-release") {
        const id = h.activeBank.sources.keys().next().value
        if (id === undefined) throw new Error("Early-release mutation needs installed asset")
        watch("wrapper-release", bridge.session.releaseAsset(id))
      }
      if (plant === "noop-churn") {
        // Broken idle wrapper keeps submitting work for unchanged input.
        watch("wrapper-noop", simple("instruments"))
      }
    }
    else if (action.kind === "boundary-probe") {
      // Explicit acceptance work, never a product mutation shortcut.
      if (action.mode === "revision") {
        watch("deadline-inspect", bridge.session.revisions.inspect({ projectId: "fixture-project", revision: h.active?.revision ?? 1, hostGeneration: 7 }))
        watch("queued-normal", simple("instruments"))
        watch("queued-refill", simple("window"))
        watch("queued-urgent", simple("instrument-events"))
      } else if (action.mode === "enqueue") {
        watch("enqueue-after-deadline", simple("instruments"))
      } else {
        watch("watchdog-control", simple("instruments"))
        watch("busy-inspect", bridge.session.revisions.inspect({ projectId: "fixture-project", revision: h.active?.revision ?? 1, hostGeneration: 7 }))
      }
    }
    else if (action.kind === "loss") {
      checkOwnership()
      endLeases()
      terminalPublication = { kind: "loss", pending: h.publicationPending, validDomain: controller.isActive() }
      h.lose()
    }
    else if (action.kind === "attachment-latency") {
      const generation = controller.attachmentGeneration(attachmentInstanceId)
      if (generation === undefined) throw new Error("Attachment generation unavailable")
      attachmentLatency = action.value ?? 2048
      attachmentEdits++
      watch("attachment-latency", controller.publishAttachmentLatency({
        instanceId: attachmentInstanceId, generation, latencyFrames: attachmentLatency,
      }))
    }
    else if (action.kind === "attachment-plan") attachmentLatency = action.value ?? 1024
    else if (action.kind === "inspect-latency") {
      // The controller's transition wait inspects the superseded revision;
      // native reports it publish-pending while the latency transition runs.
      const revision = h.retired?.revision ?? h.active?.revision
      if (revision === undefined) throw new Error("Inspect requires a graph revision")
      watch("inspect-latency", bridge.session.revisions.inspect({ projectId: "fixture-project", revision, hostGeneration: 7 }).then((result) => {
        if (result.ok) inspectStatuses.push(result.revision.status)
        return result
      }))
    }    else if (action.kind === "pause") {
      withdrawCandidate()
      terminalPublication = { kind: "pause", pending: h.publicationPending, validDomain: controller.isActive() }
      h.domain++; watch("pause", controller.pause(0))
    }
    else if (action.kind === "seek") {
      withdrawCandidate()
      terminalPublication = { kind: "seek", pending: h.publicationPending, validDomain: controller.isActive() }
      h.domain++; watch("seek", controller.seekPrepared(0.25))
    }
    else if (action.kind === "release-mutation-waiter") {
      if (!h.lost || !releaseMutationWaiter) throw new Error("Mutation cleanup before ending-domain observation")
      releaseMutationWaiter(); releaseMutationWaiter = undefined
    }
    else if (action.kind === "dispose") watch("dispose", controller.dispose())
    else if (action.kind === "stop") watch("stop", controller.destroy())
    else if (action.kind === "freeze") quiescentCounts = JSON.stringify(Object.fromEntries(h.counts))
    else if (action.kind === "identity-baseline")
      identityBaseline = { dispatches: h.counts.get("parameters") ?? 0, sequence: h.lastParameterSequence }
    else if (action.kind === "capture-boundary") {
      boundaryWaiter = waiters.findLast((waiter) => waiter.name === "flush")
      if (!boundaryWaiter || boundaryWaiter.settled || !h.controls.length)
        throw new Error("Prefix 12 requires admitted flush without callback proof")
      record({ witness: "prefix-12-in-flight", waiter: boundaryWaiter })
    }
    else if (action.kind === "reenable") watch("reenable", controller.reenableProcessorAutomation("utility:1", ["utility.gainDb"]))
    else if (action.kind === "synth-preview" || action.kind === "synth-flush") {
      // The instrument edit's identity is the fixture's own; its content is the cutoff the host must apply.
      const value = action.value ?? 4000
      const order = action.sequence ?? 10
      urgentBaseline ??= h.counts.get("instrument-events") ?? 0
      const edit = { id: `edit:${order}`, order, target: { nodeId: "parallel", instanceId: synthId, kindId: SYNTH_KIND_ID, incarnation: 1 },
        content: { params: { cutoff: value } } }
      const request = { instanceId: synthId, edit, values: [{ parameterId: "synth.filterCutoffHz", value }] }
      watch(action.kind === "synth-flush" ? "instrument-flush" : "instrument-preview",
        parameterDelivery(request, action.kind === "synth-preview").settled, value)
    }
    else if (action.kind === "utility-swap") { utilitySwap = action.value !== 0; allocateProjection() }
    else if (action.kind === "live-note") void controller.startLiveMidiNote({ trackId: "parallel", pitch: 60, velocity: 0.5 })
    else if (action.kind === "check") check(action.mode, action.value)
    else throw new Error(`Unknown action ${action.kind}`)
  }
  const dispatch = (action: Action) => {
    if (["gain", "preview", "flush", "latency", "mutation-probe", "prepare-candidate", "publish-candidate"].includes(action.kind)) liveEditCounts ??= new Map(h.counts)
    if (["pause", "seek", "loss", "dispose", "start"].includes(action.kind)) liveEditCounts = undefined
    if (action.kind !== "preview" && action.kind !== "flush") { act(action); return }
    record({ event: "action", action, enabled: enabled() })
    gainBoundaries.push(h.applications.length)
    gainOrder++
    updateDesired({ gain: action.value ?? -6, sequence: action.sequence ?? desired.sequence + 1 })
    const kind = action.kind
    const liveIncarnation = processorEdits?.target("track", "utility:1")?.incarnation ?? incarnation
    const edit = action.mode === "unstamped" ? undefined : fixtureEdit(utilityPayload(desired.gain),
      action.mode === "ahead" ? desired.sequence + 1000 : desired.sequence, 120, liveIncarnation, valued)
    watch(kind, parameterDelivery({ instanceId: "utility:1", edit,
      values: [{ parameterId: "utility.gainDb", value: desired.gain }] }, kind === "preview").settled, undefined, edit?.id)
  }
  const check = (mode = "converged", minimumCallbacks = 25) => {
    const actual = nativeFields(h.active)
    if (mode === "pause-latency") {
      checked("I7")
      if (!pauseCompletions || inspectStatuses[0] !== "publish-pending" || inspectStatuses[1] === undefined || inspectStatuses[1] === "publish-pending")
        fail("I7", "Pause did not complete pending native latency transition with Inspect proof", "ending-transport-domain", "pause-latency-completion")
      record({ witness: mode, pauseCompletions, inspectStatuses })
      return
    }
    if (mode === "paused-flush") {
      checked("I4")
      const flush = waiters.findLast((waiter) => waiter.name === "flush")
      if (!flush) throw new Error("Paused flush witness missing flush")
      if (!flush.settled || !z.object({ state: z.literal("applied") }).safeParse(flush.result).success)
        fail("I4", "Prepared paused flush did not settle by progress", "live", "paused-prepared-flush")
      record({ witness: mode, flush, prepared: controller.isPrepared() })
      return
    }
    if (mode === "refused-batch-publication") {
      checked("I3")
      const flush = waiters.findLast((waiter) => waiter.name === "flush")
      if (!flush?.settled || !z.object({ state: z.literal("applied") }).safeParse(flush.result).success) {
        fail("I3", `A flush satisfied by publication reported an invalid receipt: ${JSON.stringify(flush?.result)}`, "live", "refused-batch-publication-receipt")
      }
      record({ witness: mode, flush: flush?.result, native: actual.gain, desired: desired.gain })
      return
    }
    if (mode === "ending-domain") {
      // Every wait of the domain that ended is answered, and what is still desired is where native ends up (paused or not).
      checked("I7"); checked("I1")
      if (waiters.some((waiter) => !waiter.settled))
        fail("I7", "Ending domain left a controller waiter unsettled", "ending-transport-domain", "late-reply-domain")
      checkRejections(true)
      if (controller.isPrepared() && (actual.gain !== desired.gain))
        fail("I1", `Content still desired when its domain ended was never executed again: native ${actual.gain}, desired ${desired.gain}`, "live", "ending-domain-stranded")
      record({ witness: mode, waiters: waiters.map(({ id, name, settled, result }) => ({ id, name, settled, result })), native: actual.gain, desired: desired.gain })
      return
    }
    if (mode === "session-unavailable") {
      // A flush or preview submitted with no session, stamped or not, is answered unavailable/unprepared: never kept, never accepted.
      checked("I4"); checked("I3")
      const submitted = waiters.filter((waiter) => waiter.name === "flush" || waiter.name === "preview")
      if (submitted.length !== 4) throw new Error("Unavailable-session witness lost a submission")
      for (const waiter of submitted) {
        const label = `${waiter.name} ${waiter.editId ? "stamped" : "unstamped"}`
        const answer = z.object({ state: z.literal("unavailable") }).safeParse(waiter.result)
        if (!waiter.settled) fail("I4", `A ${label} submitted with no session stayed pending`, "live", "session-unavailable-pending")
        else if (!answer.success) fail("I3", `A ${label} submitted with no session was answered ${JSON.stringify(waiter.result)}`, "live", "session-unavailable-pending")
      }
      return
    }
    if (mode === "terminal-classifier") {
      // `value` counts the synthetic cases the seed-7 exemption classified wrongly.
      checked("I7")
      if (minimumCallbacks) fail("I7", `The publication-lane exemption misclassified ${minimumCallbacks} synthetic wait shapes`, "live", "old-domain-waiter")
      return
    }
    if (mode === "session-unavailable-answers") {
      // `value` says whether every submission to a controller with no bridge was settled and answered unavailable.
      checked("I4")
      if (!minimumCallbacks) fail("I4", "A flush or preview submitted with no bridge was kept pending or accepted", "live", "session-unavailable-pending")
      return
    }
    if (mode === "frame-released") {
      // `value` says whether the send held for its epoch went out with the frame that showed the epoch applied.
      checked("I7")
      if (!minimumCallbacks) fail("I7", "The frame that applied the new epoch did not release the flush held for it", "ending-transport-domain", "late-reply-domain")
      return
    }
    if (mode === "browser-receipts") {
      // `value` is 1 when a flush across a pause was accepted and one across a schedule-replacing restart stayed `stale`.
      checked("I7")
      if (!minimumCallbacks) fail("I7", "Portable browser flush receipts changed across a pause or restart", "live", "browser-receipt-changed")
      return
    }
    if (mode === "no-processor-timer") {
      // `value` is the count of processor-wait timers the scenario's virtual clock saw allocated (semantic attribution).
      checked("I7")
      if (minimumCallbacks) fail("I7", `Processor wait allocated ${minimumCallbacks} timers`, "live", "processor-wait-timer")
      return
    }
    if (mode === "preview-held") {
      // An open preview stays where it was put: a late Inspect reply is no reason to snap it back before its flush.
      checked("I1")
      if (actual.gain !== desired.gain)
        fail("I1", `Late Inspect reply left the open preview at ${actual.gain}, not ${desired.gain}`, "live", "late-inspect-preview")
      return
    }
    if (mode === "compile-aborted") {
      checked("I7")
      if (candidate?.status !== "superseded")
        fail("I7", `Compile held across ${["pause", "seek", "loss"][minimumCallbacks]} came back ${candidate?.status}`, "live", "compile-domain-end")
      // What the abandoned compile does when it finally resolves, supported or not, is nothing: no fault of its own.
      if (productFaults !== mark.faults)
        fail("I7", `Compile abandoned at ${["pause", "seek", "loss"][minimumCallbacks]} reported ${productFaults - mark.faults} fault(s) when it resolved`, "live", "compile-domain-end")
      record({ witness: mode, candidate: candidate?.status, faults: productFaults - mark.faults })
      return
    }
    if (mode === "abort-no-block") {
      checked("I7")
      const outcome = z.object({ status: z.string() }).safeParse(waiters.find((waiter) => waiter.name === "schedule-adoption")?.result)
      const blocked = controller.adoptionWitness().blocked
      record({ witness: mode, outcome: outcome.success ? outcome.data.status : undefined, blocked })
      if (blocked || !outcome.success || !["adopted", "unchanged"].includes(outcome.data.status))
        fail("I7", `An adoption cancelled by a seek ended ${outcome.success ? outcome.data.status : "unsettled"}${blocked ? " with a refusal on record" : ""}`, "live", "compile-abort-block")
      return
    }
    if (mode === "resume-structure") {
      // A Play resuming the prepared session recompiled a track the prepared graph lacks: what it runs holds that track.
      checked("I1")
      const installed = h.active?.nodes.size
      const wanted = expectedTopology(desired.fft).nodeLatencies.length + (desired.routed ? 1 : 0)
      // A session prepare opens a transaction, configures the host and starts it: a resume sends none of them.
      const spawns = ["begin", "configure", "start"].reduce((sum, name) => sum + (h.counts.get(name) ?? 0), 0) - mark.spawns
      record({ witness: mode, installed, wanted, spawns, prepared: controller.isPrepared(), active: controller.isActive() })
      if (!controller.isActive())
        fail("I1", "A Play resuming a paused session left it not playing", "live", "resume-structure-not-started")
      else if (installed !== wanted)
        fail("I1", `A resumed session runs ${installed} graph nodes, its compile has ${wanted}`, "live", "resume-structure-uninstalled")
      else if (spawns)
        fail("I1", `A Play resuming a paused session spawned the host again (${spawns} begin/configure/start) for a track added while paused`, "live", "resume-structure-rebuilt")
      return
    }
    if (mode === "transport-lane") {
      checked("I7")
      if (!h.lost && ![h.pendingControl, ...h.queuedSends, ...h.commands].some(command => command?.name === "transport"))
        fail("I7", "Transport was not admitted immediately after the old domain ended", "terminal", "transport-cancellation")
      return
    }
    if (mode === "transport-mismatch") {
      checked("I7")
      const outcome = z.object({ status: z.string() }).safeParse(waiters.find((waiter) => waiter.name === "schedule-adoption")?.result)
      const blocked = controller.adoptionWitness().blocked
      const compiles = compileCount - mark.compiles
      const moved = h.epoch === mark.epoch + 1 && (h.counts.get("transport") ?? 0) > mark.transports
      record({ witness: mode, outcome: outcome.success ? outcome.data.status : undefined, blocked, compiles, moved })
      if (!outcome.success || outcome.data.status !== "adopted" || blocked || compiles !== 2 || !moved)
        fail("I7", `A compile whose loop differed from the prepared one ended ${outcome.success ? outcome.data.status : "unsettled"} `
          + `after ${compiles} compile(s)${blocked ? " with a block" : ""}${moved ? "" : ", the transport not moved once"}`, "live", "compile-transport-mismatch")
      return
    }
    if (mode === "adoption-cancelled") {
      // `value` 0: dropped as it was asked for; 1: dropped while its loop was applied; 2: its host lost then, and the
      // replacement session started (its own startup compile is the one compile allowed); 3: dropped while applying its
      // loop and asked for again by another intent, whose compile is the one allowed and which is adopted. The attempt
      // compiles nothing, and nothing is left behind (4: dropped while its compile is held, in the step another intent is
      // asked for; the held compile and the new one are the two compiles, and the new ask is adopted): every caller answered, no attempt running, no refusal on record.
      checked("I7")
      const witness = controller.adoptionWitness()
      const compiles = compileCount - mark.compiles - ([0, 0, 1, 1, 2][minimumCallbacks] ?? 0)
      const unsettled = waiters.filter((waiter) => waiter.name.startsWith("schedule-adoption") && !waiter.settled).length
      const replacement = minimumCallbacks === 3 ? outcomeOf("B///loop")?.status : minimumCallbacks === 4 ? outcomeOf("C///loop")?.status : "adopted"
      record({ witness: mode, value: minimumCallbacks, compiles, unsettled, replacement, adoption: witness })
      if (compiles || unsettled || witness.running || witness.blocked || replacement !== "adopted")
        fail("I7", `An adoption cancelled ${["as it was asked for", "while its loop was applied", "as its host was lost", "and asked for again meanwhile", "while compiling and replaced"][minimumCallbacks]} left ${compiles} compile(s), ${unsettled} unsettled caller(s)`
          + `${witness.running ? ", a running attempt" : ""}${witness.blocked ? ", a refusal on record" : ""}${replacement === "adopted" ? "" : `, the new ask ${replacement ?? "unsettled"}`}`, "live", "adoption-cancel-leak")
      return
    }
    if (mode === "handoff-coverage") {
      // The sweep of `publication-cancel-handoff` must start inside the window and end past it, or a settlement that moved
      // later would leave the witness green over turns that no longer reach it. `value` 0: its first cell dropped while the
      // attempt was running; 1: its last cell dropped once the owner had settled it.
      checked("I7")
      record({ witness: mode, value: minimumCallbacks, droppedRunning: handoffDroppedRunning })
      if (handoffDroppedRunning !== (minimumCallbacks === 0))
        fail("I7", `The ${minimumCallbacks === 0 ? "first" : "last"} cell of the handoff sweep dropped ${handoffDroppedRunning === undefined ? "nothing" : handoffDroppedRunning ? "a running attempt" : "a settled attempt"}`, "live", "handoff-sweep-short")
      return
    }
    if (mode === "publication-cancelled") {
      // `value` 0-2: dropped before native claimed the publication, so native never publishes it, holds no bank or asset of
      // it, and its caller is `superseded`; 3: dropped once a callback claimed it, so native promotes it and the caller is
      // told so.
      checked("I7"); checked("I5")
      const outcome = outcomeOf("A")
      const publishes = (h.counts.get("publish") ?? 0) - mark.publishes
      const prepares = (h.counts.get("prepare") ?? 0) - mark.prepares
      const promoted = (h.active?.revision ?? 0) !== mark.revision
      const leaked = [...heldAssets()].filter((id) => !mark.assets.has(id))
      record({ witness: mode, value: minimumCallbacks, outcome, publishes, prepares, promoted, staged: h.prepared?.revision, leaked })
      if (minimumCallbacks === 3) {
        if (!promoted || outcome?.status !== "adopted")
          fail("I7", `A publication native claimed before the intents were dropped ended ${outcome?.status ?? "unsettled"} while native ${promoted ? "promoted" : "did not promote"} it`, "live", "outcome-contradicts-native")
      } else if (publishes || promoted || h.prepared || leaked.length || outcome?.status !== "superseded" || (minimumCallbacks === 2 && prepares))
        fail("I7", `A publication dropped before native claimed it ended ${outcome?.status ?? "unsettled"} after ${prepares} prepare(s) and ${publishes} publish(es)`
          + `${promoted ? ", native promoted it" : ""}${h.prepared ? ", its bank still staged" : ""}${leaked.length ? `, ${leaked.length} asset(s) still held` : ""}`, "live", "publication-cancel-leak")
      return
    }
    if (mode === "deferred-outcome") {
      // A's publication was taken by native, then pause (0) or seek (1) cancelled the attempt, or (2) the Publish's reply was
      // lost, or a pause ended it and (3) the Inspect that promoted the graph or (4) the Rollback answered publish-pending
      // lost its reply. Native owns the publication, so the caller's answer is what native did: `adopted` if it promoted the
      // graph (the transport move being what proves it), nothing it did not.
      checked("I7"); checked("I5")
      const outcome = outcomeOf("A")
      const promoted = (h.active?.revision ?? 0) !== mark.revision
      const endedName = minimumCallbacks === 0 || minimumCallbacks >= 3 ? "pause" : minimumCallbacks === 1 ? "seek" : undefined
      const ended = waiters.find((waiter) => waiter.name === endedName)
      const leaked = [...heldAssets()].filter((id) => !mark.assets.has(id))
      record({ witness: mode, value: minimumCallbacks, outcome, promoted, staged: h.prepared?.revision, publicationPending: h.publicationPending, endedSettled: ended?.settled, leaked })
      // Native promoted the graph under the attempt: the transport move waits on a graph the controller no longer tracks, and
      // the caller is told nothing or the opposite of what native did.
      if (promoted && ended && !ended.settled)
        fail("I7", `A ${endedName} stays unsettled after native promoted the publication it ended`, "live", "native-promotion-untracked")
      else if (!outcome) fail("I7", "A publication native took never answered its caller", "live", "deferred-outcome-contradicts-native")
      else if (promoted !== (outcome.status === "adopted" || outcome.status === "unchanged"))
        fail("I7", `A publication native took ended ${outcome.status} while native ${promoted ? "promoted" : "did not promote"} it`, "live", "deferred-outcome-contradicts-native")
      // What native did not promote leaves no staged bank, and its staged assets are native's to release at the rollback.
      if (!promoted && (h.prepared || leaked.length))
        fail("I5", `A publication native did not promote left ${h.prepared ? "its bank staged" : `${leaked.length} staged asset(s) held`}`, "live", "publication-cancel-leak")
      return
    }
    if (mode === "asset-reclaimed") {
      // A schedule publication removed a clip: the controller released its asset after the promote. Native reclaims it once
      // nothing blocks ReclaimAssets, and a published predecessor's plan blocks it until a Retire or the next Prepare.
      checked("I5")
      const waiting = [...h.assets].filter(([, asset]) => asset.releaseRequested).map(([id]) => id)
      record({ witness: mode, waiting, retired: h.retired?.revision, capacityGeneration: h.capacityGeneration })
      if (waiting.length)
        fail("I5", `${waiting.length} released asset(s) never reclaimed${h.retired ? ` while the predecessor plan ${h.retired.revision} stays unretired` : ""}`, "live", "retirement-starves-reclamation")
      return
    }
    if (mode === "adoption-aba") {
      // B waited behind A, and the edit went back to A: B is neither compiled nor published.
      checked("I7")
      const compiles = compileCount - mark.compiles
      const stale = outcomeOf("B")
      const wanted = outcomeOf("A")
      record({ witness: mode, compiles, stale, wanted })
      if (compiles !== 1 || stale?.status !== "superseded" || (wanted?.status !== "adopted" && wanted?.status !== "unchanged"))
        fail("I7", `An edit back to the running intent left the intent waiting behind it ${stale?.status ?? "unsettled"} after ${compiles} compile(s); the running one ended ${wanted?.status ?? "unsettled"}`,
          "live", "stale-intent-published")
      return
    }
    if (mode === "adoption-context") {
      // The compile of the plain context was held when the same key was asked for with an override: only the override publishes.
      checked("I7")
      const compiles = compileCount - mark.compiles
      const prepares = (h.counts.get("prepare") ?? 0) - mark.prepares
      const plain = outcomeOf("A")
      const master = nativeMaster("x")
      record({ witness: mode, compiles, prepares, plain, contexts: compileContexts, master })
      if (compiles !== 2 || prepares !== 1 || compileContexts.at(-1) !== "x" || plain?.status !== "superseded")
        fail("I7", `A restart changing only the compile context, asked for during a held compile, made ${prepares} publication(s) over ${compiles} compile(s); the plain context ended ${plain?.status ?? "unsettled"}`,
          "live", "context-stale-published")
      // The override is what native holds: its compile is the one that materialized.
      if (master.native !== master.compiled)
        fail("I7", `The override's master volume ${master.compiled} is not what native holds (${master.native})`, "live", "context-stale-published")
      return
    }
    if (mode === "adoption-refusal") {
      // `value` 0: a caller of another context that waited behind a refused attempt; 1: one of another key, same schedule and
      // context; 2: an explicit ask that joined a queued one, and native published it; 3: after native's capacity came back,
      // the one retry is of the newest intent B (compiled for it, or its own retained candidate) and native published it.
      checked("I7")
      const compiles = compileCount - mark.compiles
      const prepares = (h.counts.get("prepare") ?? 0) - mark.prepares
      const witness = controller.adoptionWitness()
      const promoted = (h.active?.revision ?? 0) !== mark.revision
      record({ witness: mode, value: minimumCallbacks, compiles, prepares, promoted, adoption: witness, contexts: compileContexts })
      if (minimumCallbacks === 0 || minimumCallbacks === 1) afterRefusal = { compiles, prepares }
      if (minimumCallbacks === 0 && compiles !== 2)
        fail("I7", `A caller of another context that waited behind a refused attempt was answered with its refusal after ${compiles} compile(s)`, "live", "refusal-intent-stale")
      if (minimumCallbacks === 1 && (compiles !== 1 || witness.blocked?.key !== "B"))
        fail("I7", `A caller of another key that waited behind a refused attempt left ${witness.blocked?.key ?? "no refusal"} as the refused intent after ${compiles} compile(s)`, "live", "refusal-intent-stale")
      if (minimumCallbacks === 2 && (compiles !== 2 || prepares !== 1 || !promoted || outcomeOf("B")?.status !== "adopted"))
        fail("I7", `An explicit ask that joined a queued one was not retried and published (${compiles} compile(s), ${prepares} native prepare(s), ended ${outcomeOf("B")?.status})`, "live", "refusal-intent-stale")
      if (minimumCallbacks === 3) {
        // The newest intent's context is the one native holds: B of another context is `x`, B of another key is the plain one.
        const master = nativeMaster(compileContexts.at(-1))
        const retried = compiles - afterRefusal.compiles
        if (witness.blocked || witness.running || retried !== (compileContexts.at(-1) === undefined ? 1 : 0) || (retried > 0 && compileKeys.at(-1) !== "B")
          || prepares - afterRefusal.prepares !== 1 || !promoted || master.native !== master.compiled)
          fail("I7", `Capacity returning ended with ${witness.blocked ? "a refusal" : witness.running ? "an attempt" : "no attempt"} after ${retried} retry compile(s) of ${compileKeys.at(-1)} and `
            + `${prepares - afterRefusal.prepares} native prepare(s), native ${promoted ? "published" : "did not publish"} (master ${master.native}, compiled ${master.compiled})`, "live", "refusal-intent-stale")
      }
      return
    }
    if (mode === "content-rejected") {
      // Content native refused for one intent is not offered again for another while nothing native decides on has changed.
      checked("I7")
      const prepares = (h.counts.get("prepare") ?? 0) - mark.prepares
      const first = outcomeOf("A")
      const second = outcomeOf("B")
      if (first?.status !== "failed") throw new Error(`Invalid content-rejected witness: the first intent ended ${first?.status}`)
      record({ witness: mode, value: minimumCallbacks, prepares, first, second })
      // `value` 1: the same ask repeated explicitly while its plain form compiles is a retry, which native sees once and adopts.
      if (minimumCallbacks === 1) {
        if (second?.status !== "adopted" || prepares !== 1)
          fail("I7", `An explicit ask that joined the running attempt was answered ${second?.status}/${second?.reason} after ${prepares} native prepare(s), not retried once`, "live", "content-rejection-lost")
      } else if (second?.reason !== "previous-content-rejection" || prepares)
        fail("I7", `Content native refused for one intent was sent again for another (${prepares} native prepare(s), ended ${second?.status}/${second?.reason})`, "live", "content-rejection-lost")
      return
    }
    if (mode === "recovery-reached") {
      // Clip capacity returned to a parked schedule: its attempt must reach native, whatever else the witness then proves.
      checked("I7")
      if (minimumCallbacks !== 1)
        fail("I7", "Clip capacity returning never started the parked schedule's attempt", "live", "parked-wake")
      return
    }
    if (mode === "capacity-unchanged") {
      // The witness claims a retry bought by the latency completion alone: no clip capacity may have returned.
      if (h.capacityGeneration !== blockedCapacityGeneration) throw new Error("Invalid witness: clip capacity changed")
      return
    }
    if (mode === "leases-balanced") {
      checked("I5")
      record({ witness: mode, leases: { ...stretchLeases } })
      if (stretchLeases.acquired !== stretchLeases.released)
        fail("I5", `Stretch leases ended unbalanced: ${stretchLeases.acquired} acquired, ${stretchLeases.released} released`, "live", "parked-wake")
      return
    }
    if (mode === "leases-parked" || mode === "leases-recovered") {
      // The candidate native refused holds the Stretch artifact lease its compile took, whole, while it is parked. Recovering
      // it either publishes that candidate (the lease passes to the session, none released) or disposes it as invalid and
      // compiles anew: the old lease is released exactly once and the new one is held.
      checked("I5"); checked("I7")
      const leases = stretchLeases
      const witness = controller.adoptionWitness()
      const attempts = (h.counts.get("asset") ?? 0) - mark.attempts
      const compiles = compileCount - mark.compiles
      if (mode === "leases-parked") {
        record({ witness: mode, leases: { ...leases }, attempts, compiles, adoption: witness })
        if (!h.blockAsset || witness.blocked === undefined) throw new Error("Invalid leases-parked witness: the schedule is not parked")
        if (leases.acquired !== 1 || leases.released !== 0)
          fail("I5", `A parked candidate did not hold exactly its one Stretch lease (${leases.acquired} acquired, ${leases.released} released)`, "live", "parked-wake")
        return
      }
      const invalid = minimumCallbacks === 1
      const promoted = [...heldAssets()].some((id) => !mark.assets.has(id))
      record({ witness: mode, leases: { ...leases }, attempts, compiles, promoted, adoption: witness })
      if (!promoted || attempts !== 1)
        fail("I7", `Clip capacity returning bought ${attempts} attempt(s) and native ${promoted ? "published" : "did not publish"} the schedule`, "live", "parked-wake")
      else if (invalid ? leases.acquired !== 2 || leases.released !== 1 || compiles !== 1 : leases.acquired !== 1 || leases.released !== 0 || compiles !== 0)
        fail("I5", `The recovery ${invalid ? "disposing an invalid candidate" : "publishing the retained candidate"} left ${leases.acquired} Stretch lease(s) acquired and ${leases.released} released over ${compiles} compile(s)`, "live", "parked-wake")
      return
    }
    if (mode === "hold-released") {
      // A latency held back by a recovery attempt or an unpublished candidate starts once its holder ends (the attempt
      // settles, the candidate is disposed), though no progress frame follows to look again.
      checked("I4")
      record({ witness: mode, started: minimumCallbacks === 1, adoption: controller.adoptionWitness() })
      if (minimumCallbacks !== 1)
        fail("I4", "A latency held back never started once its holder ended", "live", "latency-starvation")
      return
    }
    if (mode === "parked-settled" || mode === "parked-recovered") {
      // A schedule native refused for clip capacity is parked: it holds neither the execution lane nor the latency graph,
      // and only the clip capacity returning attempts it again. The mark is taken once it is refused.
      // `parked-settled`: latency changed meanwhile (a spectral FFT, and with an attachment plan its declared latency)
      // reaches native with no pause, seek, loss or clip-capacity recovery, and buys no attempt of the parked schedule.
      // `parked-recovered`: the returned capacity bought exactly one attempt, which published the latest latency
      // (processor state and PDC) and left every lease balanced. It compiles once when the attachment's latency moved
      // (that edit invalidated the retained candidate) and never otherwise: a second compile is a second wake.
      checked("I1"); checked("I4"); checked("I7")
      const witness = controller.adoptionWitness()
      const owned = waiters.some((waiter) => waiter.name.startsWith("schedule-adoption") || waiter.name === "adoption")
      const attempts = (h.counts.get("asset") ?? 0) - mark.attempts
      const compiles = compileCount - mark.compiles
      const submitted = h.active && h.submittedGraphs.get(h.active.revision)
      if (!submitted) throw new Error("Missing independent graph bytes")
      const graph = fields(decodeGraph(submitted))
      const reached = !convergenceFailure(actual, desired)
        && (attachment ? JSON.stringify(graph.nodeLatencies) === JSON.stringify(expectedTopology(desired.fft).nodeLatencies)
          && graph.pdc[1] === desired.fft + attachmentLatency + workerTransportFrames : !topologyFailure(graph, desired))
      if (h.lost || h.domain > 0) throw new Error(`Invalid ${mode} witness after the transport domain ended`)
      if (mode === "parked-settled") {
        const refused = owned && witness.blocked?.reason === "asset-capacity-exceeded" && witness.retained !== undefined
        if (!refused || !h.blockAsset || h.capacityGeneration !== blockedCapacityGeneration)
          throw new Error("Invalid parked-settled witness: the schedule is not parked at unchanged clip capacity")
        // Starvation is claimed only after native had independent opportunities; a settled latency needs none.
        if (!reached && (h.renderEpoch - latencySubmittedEpoch < 25n || latencyProgressOpportunities < 25
          || h.pendingControl || h.queuedSends.length || h.commands.length || h.replies.length))
          throw new Error("Invalid parked-settled check without independent native opportunity")
        record({ witness: mode, actual, graph, attempts, compiles, reached, adoption: witness })
        if (!reached) fail("I1", "Parked latency did not settle without pause, seek, loss or clip-capacity recovery", "live", "latency-starvation")
        // Each latency edit is published by one lane turn: a release that wakes the lane again publishes it again.
        const publications = (h.counts.get("publish") ?? 0) - mark.publishes
        const edits = fftOrder + attachmentEdits - mark.edits
        if (attempts !== 0 || compiles !== 0 || publications > edits)
          fail("I7", `A latency change attempted the parked schedule ${attempts} time(s) over ${compiles} compile(s) with no clip capacity returned, and was published ${publications} time(s) for ${edits} edit(s)`, "live", "parked-wake")
        return
      }
      if (h.blockAsset) throw new Error("Invalid parked-recovered witness without returned clip capacity")
      checkOwnership()
      // The schedule's clip asset is the one thing native holds only once it published the schedule.
      const promoted = [...heldAssets()].some((id) => !mark.assets.has(id))
      record({ witness: mode, actual, graph, attempts, compiles, promoted, adoption: witness })
      if (attempts !== 1 || compiles !== (attachment ? 1 : 0) || !promoted || (owned && (witness.blocked || witness.running || witness.retained)))
        fail("I7", `Clip capacity returning bought ${attempts} attempt(s) and ${compiles} compile(s) of the parked schedule, native ${promoted ? "published" : "did not publish"} it${owned && (witness.blocked || witness.retained) ? " and the owner still holds it" : ""}`,
          "live", "parked-wake")
      // The refused attempt's candidate, invalid by now when the attachment's latency moved the graph, is disposed rather than left staged.
      if (controller.liveScheduleCandidates() !== 0)
        fail("I5", `A compiled schedule candidate outlived the recovery that published or replaced it: ${controller.liveScheduleCandidates()}`, "live", "parked-wake")
      if (promoted && !reached)
        fail("I1", `The recovered schedule did not carry the latest latency: ${JSON.stringify({ actual, graph, desired, attachmentLatency })}`, "live", "parked-rebase-stale")
      return
    }
    if (mode === "attachment-join-lost" || mode === "attachment-undo-startup") {
      // Both paths end alike: the ready instance is active, the other never binds, and no instance stays staged.
      checked("I5")
      const owners = [...h.attachments].map(([id, attachment]) => `${id}:${attachment.state}`).join(",")
      const ignored = mode === "attachment-join-lost" ? { stale: 0, joinLost: 1 } : { stale: 1, joinLost: 0 }
      if (owners !== "instance-1:active,instance-2:retired" || JSON.stringify(h.ignoredReady) !== JSON.stringify(ignored))
        fail("I5", `Attachment ownership ${owners} with ignored ready ${JSON.stringify(h.ignoredReady)}`, undefined, "attachment-ownership")
      record({ witness: mode, owners, ignoredReady: h.ignoredReady })
      return
    }
    if (mode === "attachment") {
      checked("I9"); checked("I1")
      const rebuild = waiters.some((waiter) => waiter.name === "adoption"
        && z.object({ rebuild: z.literal(true) }).safeParse(waiter.result).success)
      if (candidate?.status === "rebuild" || rebuild)
        fail("I9", "Attachment latency plan change classified supported edit as rebuild", "live", "attachment-spurious-rebuild")
      // A rebuilt candidate is already the I9 failure; its stale PDC is not a second defect.
      if (!rebuild && candidate?.status !== "rebuild" && actual.pdc[1] !== desired.fft + attachmentLatency + workerTransportFrames)
        fail("I1", "Parked candidate did not rebase frozen attachment latency", "live", "attachment-rebase")
      record({ witness: mode, candidate: candidate?.status, actual, attachmentLatency })
      return
    }    // Shrinking cannot relabel an undrained schedule as convergence/settlement.
    // Parked work must have had a bounded run of real callbacks at unchanged
    // capacity, not a check inserted immediately after submission.
    if ((mode === "converged" || (replay && mode === "drained"))
      && !drainWitness && (waiters.some((waiter) => !waiter.settled) || h.pendingControl || h.queuedSends.length || h.commands.length || h.replies.length || h.controls.length || h.patch))
      throw new Error("Invalid convergence check before fair drain")
    if (mode === "terminal" && (!terminalPublication?.validDomain
      || waiters.some((waiter) => waiter.name === "start" && !waiter.settled)))
      throw new Error("Invalid terminal check without terminal action")
    if (mode === "terminal" && terminalPublication?.kind !== "loss" && !terminalPublication?.pending)
      throw new Error("Invalid terminal witness without admitted publication wait")
    const convergence = mode === "converged" || mode === "drained"
    if (convergence && staleFailure(actual.gain, desired, confirmedGain, confirmedOrder))
      fail("I2", "Native content regressed below newer confirmed edit")
    if (convergence && confirmedOrder > 1) checked("I2")
    checkOwnership()
    if (convergence) checkRejections(true)
    if (convergence) {
      checked("I1"); checked("I4"); checked("I5")
      // Native keeps a publication in flight until an Inspect settles it (audio-host.cpp:2978, 2994-3012); once the controller
      // has nothing left to ask, one still in flight is a publication it lost track of, and its flush waiters never settle.
      if (h.publicationPending)
        fail("I5", `Native still holds revision ${h.publicationRevision} as an in-flight publication (${h.publicationAcknowledged ? "acknowledged" : h.publicationDeferred ? "deferred" : "unacknowledged"}) that no controller request will settle`, "live", "publication-left-in-flight")
      if (convergenceFailure(actual, desired))
        fail("I1", `Native differs from desired: ${JSON.stringify({ actual, desired })}`)
      if (settlementFailure(waiters.some((waiter) => !waiter.settled))) fail("I4", "Unsettled controller request at logical drain bound", unsettledDomain())
      const submitted = h.active && h.submittedGraphs.get(h.active.revision)
      if (!submitted) throw new Error("Missing independent graph bytes")
      if (topologyFailure(fields(decodeGraph(submitted)), desired))
        fail("I1", "Fixed parallel topology latency/PDC differs from desired FFT")
      if ((h.frame < 48_000n || !desired.sample)
        && (h.activeBank.sourceHistory.size > 0) !== desired.sample)
        fail("I1", "Published schedule sample membership differs from desired clip")
    }
    if (mode === "instrument-urgent") {
      const flush = waiters.findLast((waiter) => waiter.name === "instrument-flush")
      if (!flush || urgentBaseline === undefined) throw new Error("Instrument witness needs a flush")
      checked("I3"); checked("I6")
      const accepted = z.object({ state: z.literal("applied") }).safeParse(flush.result).success
      const dispatches = (h.counts.get("instrument-events") ?? 0) - urgentBaseline
      const cutoff = h.synthValues.get(synthCutoffTarget)
      if (!flush.settled || !accepted)
        fail("I3", `Instrument flush did not settle applied: ${flush.settled ? JSON.stringify(flush.result) : "unsettled"} (native cutoff ${cutoff})`, undefined, "urgent-instrument-proof")
      else if (cutoff !== flush.synth)
        fail("I1", `Native cutoff ${cutoff} differs from the flushed ${flush.synth}`, undefined, "urgent-instrument-proof")
      if (dispatches !== 1)
        fail("I6", `Unchanged instrument flush across a publication dispatched ${dispatches} urgent batches`, undefined, "urgent-instrument-proof")
      record({ witness: "instrument-urgent", flush, dispatches, cutoff })
      return
    }
    if (mode === "held-urgent") {
      // The receipt is judged when it settles (urgent-instrument-proof); a settled flush must also have
      // left the cutoff it names, and it may not settle before native has applied it.
      const flush = waiters.findLast((waiter) => waiter.name === "instrument-flush")
      if (!flush) throw new Error("Held urgent witness needs a flush")
      checked("I3")
      const cutoff = h.synthValues.get(synthCutoffTarget)
      if (flush.settled && z.object({ state: z.literal("applied") }).safeParse(flush.result).success && cutoff !== flush.synth)
        fail("I3", `Flush settled applied while native cutoff is ${cutoff}, not ${flush.synth}`, undefined, "urgent-instrument-proof")
      record({ witness: mode, flush, cutoff })
      return
    }
    if (mode === "synth-replaced") {
      // The replacement shares the track and its parameters; only its instance id differs. Its flush is
      // a new target's edit and must reach native, not join the replaced instance's applied execution.
      const flushes = waiters.filter((waiter) => waiter.name === "instrument-flush")
      if (flushes.length !== 2 || urgentBaseline === undefined) throw new Error("Replacement witness needs both flushes")
      checked("I3"); checked("I6")
      const dispatches = (h.counts.get("instrument-events") ?? 0) - urgentBaseline
      if (dispatches !== 2 || !flushes.every((flush) => flush.settled && z.object({ state: z.literal("applied") }).safeParse(flush.result).success))
        fail("I3", `Replacement instrument's flush did not execute: ${dispatches} urgent batches for 2 flushes`, undefined, "urgent-instrument-proof")
      record({ witness: mode, dispatches, flushes })
      return
    }
    if (mode === "rollback-values") {
      checked("I1")
      if (!replacementValues) fail("I1", "Rollback replacement edit carries no parameter values", undefined, "rollback-without-values")
      record({ witness: mode, replacementValues })
      return
    }
    if (mode === "patch-install" || mode === "patch-first" || mode === "patch-claimed") {
      checked("I1"); checked("I3")
      for (const patch of waiters.filter((waiter) => waiter.name === "gain-patch")) {
        const rejected = patch.settled && z.object({ state: z.literal("refused") }).safeParse(patch.result).success
        if (rejected && h.applications.some((application) => application.strategy === "patch" && application.content.gain === patch.content.gain))
          fail("I3", `Patch to ${patch.content.gain} settled rejected after native installed it: ${JSON.stringify(patch.result)}`, undefined, "claimed-patch-settled-as-rejected")
      }
      // Installing a patch zeroes the slot's overrides, so a gesture applied before it is gone: native, the
      // newest edit and the flush's receipt must still agree.
      if (actual.gain !== desired.gain)
        fail("I1", `Native holds ${actual.gain} after a patch installed, the newest edit is ${desired.gain}`, undefined, "patch-install-erased-override")
      const flush = waiters.findLast((waiter) => waiter.name === "flush")
      const applied = z.object({ state: z.literal("applied") }).safeParse(flush?.result).success
      // A receipt naming a batch that drained before an install is true only if the install carries the flush's value
      // (a patch materialized from the newest edit does); an install of another value erased what the receipt names.
      const floor = flush?.settlementPatchFloor ?? 0
      const installed = h.applications.findLast((application) => application.strategy === "patch")
      const batches = recordBatches(dispatches, flush?.editId)
      if (applied && batches.length > 0 && batches.every(sequence => sequence <= BigInt(floor))
        && installed?.content.gain !== flush?.content.gain)
        fail("I3", `Flush settled applied by batches ${batches.join(",")}, drained before a patch installed ${installed?.content.gain} over it at floor ${floor}`, undefined, "patch-install-erased-override")
      if (mode !== "patch-install") {
        // patch-first: the gesture came after the install, so its carrier is current and must not be invalidated.
        // patch-claimed: a publication carrying the claimed patch's content leaves nothing to send.
        const dispatches = (h.counts.get("parameters") ?? 0) - (identityBaseline?.dispatches ?? 0)
        const wanted = mode === "patch-first" ? 1 : 0
        if (!identityBaseline || dispatches !== wanted)
          fail("I6", `After the install ${dispatches} batches were dispatched, not ${wanted}`, undefined, "patch-install-over-invalidation")
      }
      record({ witness: mode, actual: actual.gain, desired: desired.gain, flush: flush?.result, patchFloor: h.patchFloor })
      return
    }
    if (mode === "patch-dedupe") {
      // The prepared bytes describe the base state: an override over them, or a patch still on its way, makes an
      // equal patch a real change, so acknowledging it without sending leaves native on the other value.
      checked("I1")
      if (actual.gain !== desired.gain)
        fail("I1", `A patch equal to the prepared bytes was acknowledged while native holds ${actual.gain}, not ${desired.gain}`, undefined, "patch-dedupe-lost-edit")
      record({ witness: mode, actual: actual.gain, desired: desired.gain })
      return
    }
    if (mode === "patch-refused-settled") {
      // Checked before any frame: the install itself answers the refused flush, no later offer or deadline does.
      checked("I3")
      const flush = waiters.findLast((waiter) => waiter.name === "flush")
      if (!flush?.settled || !z.object({ state: z.literal("applied") }).safeParse(flush.result).success)
        fail("I3", `A flush whose values a patch installed is ${flush?.settled ? JSON.stringify(flush.result) : "still pending"}`, undefined, "patch-install-refused-stranded")
      record({ witness: mode, actual: actual.gain, flush: flush?.result, settled: flush?.settled })
      return
    }
    if (mode === "refused-resend") {
      checked("I1")
      if (actual.gain !== desired.gain)
        fail("I1", `Refused dispatch left desired ${desired.gain} unsent: native ${actual.gain}`, undefined, "refused-resend-stranded")
      record({ witness: mode, actual: actual.gain, desired: desired.gain })
      return
    }
    if (mode === "reconcile" || mode === "reconcile-inflight") {
      const latest = processorEdits?.target("track", "utility:1")?.latest
      // Every owner desired for a built-in processor must carry the values it reconciles from.
      if (!latest?.content.values) throw new Error("Registry edit carries no parameter values")
      const gesture = waiters.findLast((waiter) => waiter.name === "flush")
      checked(mode === "reconcile" ? "I1" : "I2")
      if (mode === "reconcile" && actual.gain !== desired.gain)
        fail("I1", `Desired change with no gesture never reached native: ${JSON.stringify({ actual: actual.gain, desired: desired.gain })}`, undefined, "graph-only-desired-change")
      // The host refuses a gesture stamped before the adoption (stale stamp); the older rebased content
      // must still not take its place.
      const accepted = z.object({ state: z.literal("applied") }).safeParse(gesture?.result).success
      const rebased = waiters.findLast((waiter) => waiter.name === "candidate")?.content.gain
      if (mode === "reconcile-inflight" && (accepted ? actual.gain !== gesture?.content.gain : actual.gain === rebased))
        fail("I2", `Reconcile overwrote the in-flight gesture: native ${actual.gain}, gesture ${gesture?.content.gain}`, undefined, "reconcile-overwrote-gesture")
      checkOwnership()
      record({ witness: mode, actual: actual.gain, desired: desired.gain, gesture: gesture?.result })
      return
    }
    if (mode === "reconcile-first") {
      const owner = createNativeProcessorStateOwner()
      const target = { nodeId: "track", instanceId: "utility:1", kindId: 1, incarnation: 1 }
      const content = (value: number) => ({ state: new Uint8Array(), values: { "utility.gainDb": value } })
      const first = owner.register({ key: target.instanceId, editId: "edit-1", order: 1, kindId: 1, sequence: 1,
        strategy: { kind: "parameters" }, values: new Map([["utility.gainDb", -9]]) }, { revision: 1, epoch: 1 })
      owner.send(first, 1)
      owner.submit({ id: "edit-2", order: 2, target, content: content(-2), bypassed: false, tailFrames: 0 })
      owner.prepared(2, () => true); owner.published(2)
      const adoption = owner.adopted(new Map([[target.instanceId, 1]]), new Set(), new Set(), 2, () => true)
      const settlement = owner.observe({ revision: 2, epoch: 1, progressSequence: 1n, renderedThroughFrame: 512n, acceptedThroughFrame: 4096n,
        lastAcceptedWindowId: 1n, appliedTransportTransitionId: 0n, appliedUrgentSequence: 0n, appliedProcessorSequence: 1n, running: true,
        scheduleComplete: false, instrumentCredits: 1, sourceCredits: 1, automationCredits: 1 })
      checked("I1")
      if (first.state !== "applied" || adoption.length + settlement.length === 0)
        fail("I1", `Desired change with no gesture never reached native: ${JSON.stringify({ execution: first.state, adoption: adoption.length, settlement: settlement.length })}`, undefined, "graph-only-desired-change")
      record({ witness: mode, execution: first.state, adoption: adoption.length, settlement: settlement.length })
      return
    }
    if (mode === "rejection-classes") {
      checkRejections(true)
      // A refused or cancelled flush is sent again on the next binding, so its caller sees the resend's result:
      // a rejection that still reaches the caller must carry its own batch's class, and none is a pass.
      const classOf = (gain: number) => {
        const flush = waiters.find((waiter) => waiter.name === "flush" && waiter.content.gain === gain)
        const rejected = rejectionClasses.find((entry) => entry.id === flush?.id)
        const superseded = z.object({ state: z.literal("superseded"), by: z.number() }).safeParse(flush?.result)
        if (flush && superseded.success && superseded.data.by > flush.editOrder
          && waiters.some(newer => newer.id > flush.id && newer.editOrder === superseded.data.by
            && newer.content.incarnation === flush.content.incarnation && newer.content.gain !== gain
            && recordBatches(dispatches, newer.editId).length > 0)) return "superseded"
        return rejected ? rejected.class : z.object({ state: z.literal("applied") }).safeParse(flush?.result).success ? "resent" : undefined
      }
      const expected: [number, string][] = [[-9, "post-admission-publication-cancel/resend"], [-3, "stale-stamp-at-dispatch/host-refused/resend"]]
      checked("I3")
      for (const [gain, wanted] of expected) if (classOf(gain) !== wanted && classOf(gain) !== "resent" && classOf(gain) !== "superseded")
        fail("I3", `Flush to ${gain} classified ${classOf(gain)}, not ${wanted}`, undefined, "rejection-misattributed")
      record({ witness: mode, classes: expected.map(([gain]) => classOf(gain)) })
      return
    }
    if (mode === "unsent-proof") {
      // A registered execution whose send is still held is proven by nothing native reports: a floor another
      // send lifted, or its own reserved sequence, says nothing about a batch native has not been given.
      const owner = createNativeProcessorStateOwner()
      const held = owner.register({ key: "synth:1", editId: "edit-1", order: 1, kindId: 2, sequence: 5,
        strategy: { kind: "urgent", sequence: 0 }, values: new Map([["synth.cutoff", 4000]]) }, { revision: 1, epoch: 2 })
      const progress = (progressSequence: bigint, applied: bigint) => ({ revision: 1, epoch: 2, progressSequence, renderedThroughFrame: 512n, acceptedThroughFrame: 4096n,
        lastAcceptedWindowId: 1n, appliedTransportTransitionId: 0n, appliedUrgentSequence: applied, appliedProcessorSequence: applied, running: true,
        scheduleComplete: false, instrumentCredits: 1, sourceCredits: 1, automationCredits: 1 })
      owner.observe(progress(1n, 9n))
      const whileHeld = held.state
      owner.send(held, 5, 12)
      owner.observe(progress(2n, 9n))
      const belowOwn = held.state
      owner.observe(progress(3n, 12n))
      checked("I3")
      if (whileHeld !== "queued" || belowOwn !== "queued" || held.state !== "applied")
        fail("I3", `Held execution states ${JSON.stringify({ whileHeld, belowOwn, afterOwn: held.state })}`, undefined, "urgent-instrument-proof")
      record({ witness: mode, whileHeld, belowOwn, afterOwn: held.state })
      return
    }
    if (mode === "patch-installed") {
      // The owner's bookkeeping alone, replayed in the order the lane gives it: a gesture applied, then a newer patch
      // submitted, picked up by the lane and answered. A true reply puts the patch's values in force; an unexplained false while
      // running leaves them unknown, so the next reconcile offers the desired values again.
      checked("I1")
      const key = "utility:1"
      const binding = { revision: 1, epoch: 1 }
      const patch: ProcessorDesired = { id: "edit-11", order: 11, target: { nodeId: "track", instanceId: key, kindId: 1, incarnation: 1 },
        content: { state: new Uint8Array([11]), values: { "utility.gainDb": 0 } }, bypassed: false, tailFrames: 0 }
      const frame = (applied: bigint) => ({ revision: 1, epoch: 1, progressSequence: applied, renderedThroughFrame: 512n, acceptedThroughFrame: 4096n,
        lastAcceptedWindowId: 1n, appliedTransportTransitionId: 0n, appliedUrgentSequence: 0n, appliedProcessorSequence: applied, running: true,
        scheduleComplete: false, instrumentCredits: 1, sourceCredits: 1, automationCredits: 1 })
      // `newer`: an edit registered after the patch was queued is what the lane sends, so the install carries its order.
      // `gain`: what the gesture proved live. A claimed patch carrying that same value still leaves it unknown.
      const replay = (outcome: "applied" | "claimed", newer = false, gain = -9) => {
        const owner = createNativeProcessorStateOwner()
        const gesture = owner.register({ key, editId: "edit-10", order: 10, kindId: 1, sequence: 1, strategy: { kind: "parameters" },
          values: new Map([["utility.gainDb", gain]]) }, binding)
        owner.send(gesture, 1)
        owner.observe(frame(1n))
        const submitted = ownerPatch(owner, patch, () => false)
        if ("superseded" in submitted) return undefined
        if (newer) {
          const edit = owner.register({ key, editId: "edit-12", order: 12, kindId: 1, sequence: 2, strategy: { kind: "parameters" }, values: new Map([["utility.gainDb", -4]]), content: { params: {}, state: new Uint8Array([12]), values: { "utility.gainDb": -4 } } }, binding)
          owner.send(edit, 2)
          owner.observe(frame(2n))
        }
        const next = owner.nextPatch((desired) => desired)
        ownerPatchReplied(owner, submitted, outcome)
        const order = newer ? 12 : patch.order
        // A publication that does not carry the installed bytes replaces the slot: the install's value is sent again.
        const reconciles = newer ? owner.adopted(new Map([[key, 1]]), new Set(), new Set([key]), 12, () => false).length
          : owner.reconcile(new Map([[key, 1]])).length
        return { picked: next?.execution === submitted && next.desired.order === order && next.desired.content.state[0] === order,
          state: submitted.state, reconciles }
      }
      const applied = replay("applied")
      const claimed = replay("claimed", false, 0)
      const materialized = replay("applied", true)
      if (!applied || !claimed || !materialized || !applied.picked || !claimed.picked || !materialized.picked)
        fail("I1", `The lane's pickup did not return the submitted patch: ${JSON.stringify({ applied, claimed, materialized })}`, undefined, "patch-installed-bookkeeping")
      else if (applied.state !== "applied" || applied.reconciles !== 0)
        fail("I1", `A patch answered true left the owner ${applied.state} with ${applied.reconciles} reconciles for values it installed`, undefined, "patch-installed-bookkeeping")
      else if (claimed.state === "applied" || claimed.state === "cancelled" || claimed.reconciles !== 0)
        fail("I1", `An unresolved claim left the owner ${claimed.state} with ${claimed.reconciles} sends before its resolution`, undefined, "patch-installed-bookkeeping")
      else if (materialized.reconciles !== 1)
        fail("I1", `A patch that installed a newer edit's values at its order left ${materialized.reconciles} reconciles after a publication of other bytes, not 1`, undefined, "patch-installed-bookkeeping")
      const parameters = (order: number, gain: number, extra: Record<string, number> = {}): Parameters<ReturnType<typeof createNativeProcessorStateOwner>["register"]>[0] => ({
        key, editId: `edit-${order}`, order, kindId: 1, sequence: order, strategy: { kind: "parameters" }, values: new Map(Object.entries({ "utility.gainDb": gain, ...extra })),
        content: { params: {}, state: new Uint8Array([order]), values: { "utility.gainDb": gain } } })
      // Bytes equal to the prepared ones are done only when nothing stands between them and native: no override over
      // them, none on its way, and no other patch to install after.
      const other: ProcessorDesired = { ...patch, id: "edit-10", order: 10, content: { state: new Uint8Array([10]), values: { "utility.gainDb": -1 } } }
      const done = (setup: (owner: ReturnType<typeof createNativeProcessorStateOwner>) => void) => {
        const owner = createNativeProcessorStateOwner()
        owner.configured(owner.includedOrder(), new Map([[key, { kindId: 1, state: patch.content.state, values: patch.content.values }]]))
        setup(owner)
        const { plan } = owner.deliver({
          key, editId: patch.id, order: patch.order, kindId: patch.target.kindId, incarnation: patch.target.incarnation,
          epoch: 1, state: patch.content.state, values: patch.content.values ?? {}, desired: patch,
        })
        return plan.carrier === "none"
      }
      const deduped = {
        clean: done(() => {}),
        overridden: done((owner) => { const gesture = owner.register(parameters(10, -9), binding); owner.send(gesture, 10); owner.observe(frame(10n)) }),
        unproven: done((owner) => { owner.send(owner.register(parameters(10, -9), binding), 10) }),
        queued: done((owner) => { ownerPatch(owner, other, () => false) }),
        dispatched: done((owner) => { ownerPatch(owner, other, () => false); owner.nextPatch((desired) => desired) }),
      }
      if (!deduped.clean || deduped.overridden || deduped.unproven || deduped.queued || deduped.dispatched)
        fail("I1", `A patch equal to the prepared bytes was acknowledged unsent: ${JSON.stringify(deduped)}, wanted only clean`, undefined, "patch-dedupe-lost-edit")
      // A refused flush whose values the installed content carries is satisfied by the install; one with a field it
      // does not carry, or a claimed install whose values are unknown, is not.
      const refusedAt = (outcome: "applied" | "claimed", extra: Record<string, number> = {}) => {
        const owner = createNativeProcessorStateOwner()
        const submitted = ownerPatch(owner, patch, () => false)
        if ("superseded" in submitted) return undefined
        const flush = owner.register(parameters(12, -9, extra), binding)
        owner.send(flush, 12); owner.refuse(flush, "definite")
        owner.nextPatch((desired) => desired)
        ownerPatchReplied(owner, submitted, outcome)
        return { state: flush.state, reoffers: owner.reoffer().length }
      }
      const refused = { satisfied: refusedAt("applied"), extra: refusedAt("applied", { "utility.pan": 0.25 }), claimed: refusedAt("claimed") }
      if (refused.satisfied?.state !== "applied" || refused.satisfied.reoffers !== 0)
        fail("I1", `A refused flush the install satisfied is ${refused.satisfied?.state} with ${refused.satisfied?.reoffers} offers`, undefined, "patch-installed-bookkeeping")
      else if (refused.extra?.state !== "refused" || refused.claimed?.state !== "refused")
        fail("I1", `A refused flush the install does not satisfy ended ${JSON.stringify(refused)}`, undefined, "patch-installed-bookkeeping")
      // The install is applied content at the order it was built from, so an older edit is already superseded.
      const floor = (() => {
        const owner = createNativeProcessorStateOwner()
        const submitted = ownerPatch(owner, patch, () => false)
        if ("superseded" in submitted) return undefined
        const newer = owner.register(parameters(12, -9), binding)
        owner.send(newer, 12)
        owner.observe(frame(12n))
        owner.nextPatch((desired) => desired)
        ownerPatchReplied(owner, submitted, "applied")
        return owner.isSuperseded(key, 11)
      })()
      if (floor !== true)
        fail("I1", "An edit older than the one a patch installed is not superseded after the install", undefined, "patch-installed-bookkeeping")
      record({ witness: mode, applied, claimed, materialized, deduped, refused, floor })
      return
    }
    if (mode === "patch-projected-timing") {
      // A candidate at another tempo ingests the projection of a delay edit; a patch queued before it is then built from
      // that ledger content. The tail it sends is the one at the prepared tempo, not the candidate's.
      checked("I1")
      const delay = createDefaultDelayParams()
      const to = { ...delay, feedback: 0.5 }
      const edit = createProcessorEditRegistry(() => 60).allocate({ effect: "delay", instanceId: "delay:1", targetId: "track", from: delay, to })
      if (!edit?.content.state) throw new Error("Projected timing witness needs a delay edit")
      const tailAt = (bpm: number) => getEffectTiming({ kind: "delay", params: normalizeDelayParams(to) }, 48_000, bpm).tail
      const candidateTail = tailAt(60)
      const processor: Parameters<typeof projectedProcessorDesired>[1] = { id: "delay:1", kind: "delay", instanceId: 1, kindId: edit.target.kindId, stateVersion: 1,
        state: edit.content.state, bypassed: false, latencyFrames: 0, parameterTargets: [],
        tailFrames: candidateTail.kind === "finite" ? candidateTail.frames : 0 }
      const projected = projectedProcessorDesired("track", processor, {
        kindId: edit.target.kindId, incarnation: edit.target.incarnation, latest: edit,
      })
      if (!projected) throw new Error("Projected timing requires its current edit")
      const owner = createNativeProcessorStateOwner()
      ownerPatch(owner, { ...projected, id: "older", order: 0 }, () => false)
      owner.submit(projected)
      const sent = owner.nextPatch((desired) => timedProcessorDesired(desired, 48_000, 120))?.desired
      const wanted = tailAt(120)
      if (!sent || sent.order !== projected.order || sent.tailFrames !== (wanted.kind === "finite" ? wanted.frames : undefined))
        fail("I1", `A patch built from ledger content sends tail ${sent?.tailFrames} (order ${sent?.order}), wanted ${JSON.stringify(wanted)} at the prepared tempo`, undefined, "patch-projected-stale-tail")
      record({ witness: mode, sent: sent && { order: sent.order, tailFrames: sent.tailFrames }, wanted, candidateTail })
      return
    }
    if (mode === "rebound-credit") {
      // Batches 1 and 3 are one record's dispatch and its rebound, 2 is another record's: each caller owns its record's
      // batches, and a flush that joined the record owns the same ones without having sent any.
      checked("I3")
      const dispatched = [{ editId: "a", sequence: 1n }, { editId: "b", sequence: 2n }, { editId: "a", sequence: 3n }]
      const owned = (editId: string | undefined) => recordBatches(dispatched, editId).map(Number)
      const credited = JSON.stringify({ first: owned("a"), joined: owned("a"), another: owned("b"), unnamed: owned(undefined) })
      if (credited !== JSON.stringify({ first: [1, 3], joined: [1, 3], another: [2], unnamed: [] }))
        fail("I3", `Record batches ${credited}, wanted each caller credited with its own record's batches`, undefined, "rejection-misattributed")
      record({ witness: mode, owned: credited })
      return
    }
    if (mode === "attempt-identity") {
      // A dispatch's identity is the record's attempt: a new one on each register and rebind, so a caller can tell
      // whether the record it holds was dispatched again while it waited, even on an unchanged revision.
      checked("I3")
      const owner = createNativeProcessorStateOwner()
      const binding = { revision: 1, epoch: 1 }
      const make = (order: number) => owner.register({ key: "utility:1", editId: `edit-${order}`, order, kindId: 1, sequence: order,
        strategy: { kind: "parameters" }, values: new Map([["utility.gainDb", -order]]) }, binding)
      const attemptOf = (execution: Execution) => execution.attempt
      const first = make(1)
      const second = make(2)
      const before = attemptOf(first)
      owner.rebind(first, binding, 3)
      const after = attemptOf(first)
      const other = attemptOf(second)
      if (after <= before || other === before || other === after)
        fail("I3", `Dispatch attempts: register ${before}, rebind ${after}, other record ${other}`, undefined, "dispatch-attempt-identity")
      record({ witness: mode, before, after, other })
      return
    }
    if (mode === "gesture-applied") {
      const gesture = waiters.findLast((waiter) => waiter.name === "flush")
      checked("I3")
      if (!gesture?.settled || !z.object({ state: z.literal("applied") }).safeParse(gesture.result).success)
        fail("I3", `Flush admitted under the new epoch settled ${JSON.stringify(gesture?.result)} after old-epoch frames`, undefined, "parameter-pre-admission-cancel")
      else if (actual.gain !== gesture.content.gain)
        fail("I3", `Native holds ${actual.gain}, not the flush's ${gesture.content.gain}`, undefined, "parameter-pre-admission-cancel")
      record({ witness: mode, gesture: gesture?.result, actual: actual.gain })
      return
    }
    if (mode === "future-epoch-drop") {
      const [first, later] = waiters.filter((waiter) => waiter.name === "flush")
      if (!first?.settled || !later?.settled) throw new Error("Future-epoch witness needs both flushes settled")
      checked("I3")
      const applied = z.object({ state: z.literal("applied") }).safeParse(first.result).success
      const batches = recordBatches(dispatches, first.editId)
      const proven = h.applications.slice(first.applicationStart).some(proof => proof.strategy === "parameters"
        && proof.sequence !== undefined && batches.includes(BigInt(proof.sequence))
        && proof.incarnation === first.nativeIncarnation && proof.content.gain === first.content.gain)
      if (applied && !proven)
        fail("I3", "Flush settled applied over a batch native dropped: its callback had not applied the batch's epoch", undefined, "parameter-future-epoch-drop")
      if (!z.object({ state: z.literal("applied") }).safeParse(later.result).success || actual.gain !== later.content.gain)
        fail("I3", `Later flush did not apply: ${JSON.stringify(later.result)}, native ${actual.gain}`, undefined, "parameter-future-epoch-drop")
      record({ witness: mode, first: first.result, later: later.result, actual: actual.gain })
      return
    }
    if (mode === "parameter-dropped") {
      const [dropped, later] = waiters.filter((waiter) => waiter.name === "flush")
      if (!dropped?.settled || !later?.settled) throw new Error("Drop witness needs both flushes settled")
      checked("I3")
      // Native dropped the batch: the flush is cancelled/stale, or applied by a batch sent again that native applied.
      const refused = z.object({ state: z.enum(["superseded", "unavailable"]) }).safeParse(dropped.result)
      const resent = z.object({ state: z.literal("applied") }).safeParse(dropped.result)
      const batches = recordBatches(dispatches, dropped.editId)
      const appliedResend = h.applications.slice(dropped.applicationStart).some(proof =>
        proof.strategy === "parameters" && proof.sequence !== undefined && batches.includes(BigInt(proof.sequence))
        && proof.incarnation === dropped.nativeIncarnation && !receiptFailure(proof.content.gain, dropped.content.gain))
      if (!refused.success && !(resent.success && appliedResend))
        fail("I3", `Flush whose batch native dropped at a newer epoch settled ${JSON.stringify(dropped.result)}`, undefined, "parameter-dropped-receipt")
      if (!z.object({ state: z.literal("applied") }).safeParse(later.result).success || actual.gain !== later.content.gain)
        fail("I3", `Later flush did not apply: ${JSON.stringify(later.result)}, native ${actual.gain}`, undefined, "parameter-dropped-receipt")
      record({ witness: mode, dropped: dropped.result, later: later.result, actual: actual.gain })
      return
    }
    if (mode === "urgent-epoch-drop") {
      const flush = waiters.find((waiter) => waiter.name === "instrument-flush")
      if (!flush || !h.synthValues.has(synthCutoffTarget) || h.urgentDropped === 0)
        throw new Error("Epoch-drop witness needs a dropped flush event and a later applied event")
      checked("I3")
      // An applied answer must name an urgent event native applied: the settlement check above judges it against the host's value
      // when the flush settles, so the dropped event cannot be credited by the later event's floor. A settled-applied flush here is
      // the same flush sent again in the new epoch.
      const settledApplied = z.object({ state: z.literal("applied") }).safeParse(flush.result).success
      if (settledApplied && !flush.settledProven)
        fail("I3", "Instrument flush settled applied over an urgent event native dropped at an epoch change", undefined, "urgent-instrument-proof")
      record({ witness: mode, flush, cutoff: h.synthValues.get(synthCutoffTarget) })
      return
    }
    if (mode === "retained-drift") {
      const flush = waiters.find((waiter) => waiter.name === "flush")
      if (!flush?.settled) throw new Error("Drift witness flush did not settle")
      // Native Prepare answers publish-pending while a graph control is queued (audio-host.cpp:2523), so a
      // queued batch is re-stamped at most once; a host model that allows a chain (R->S->T) needs its own witness.
      if ([...h.restampCounts.values()].some((count) => count > 1)) throw new Error("A queued batch was re-stamped twice")
      record({ witness: mode, receipt: flush.result, restamped: [...h.restampedSequences], appliedBatches: [...h.appliedBatches.keys()] })
      return
    }
    if (mode === "prefix-11") {
      const flush = waiters.find((waiter) => waiter.name === "flush")
      if (!flush?.settled || h.restampedSequences.size === 0 || actual.gain !== -9)
        throw new Error("Prefix 11 did not re-stamp and apply retained flush")
      checked("I3")
      if (!z.object({ state: z.literal("applied") }).safeParse(flush.result).success)
        fail("I3", "Prefix 11 retained flush did not settle applied", "live", "restamp-timeout")
      record({ witness: "prefix-11", nativeApplied: true, restamped: [...h.restampedSequences], receipt: flush.result })
    }
    if (mode === "incarnation") {
      // The -9 edit belongs to the first incarnation, which was removed and
      // re-added in the renderer. Its desired must not outlive it: not in the
      // fresh bytes, and not applied again from the publication of the first
      // candidate captured after the re-add onward. An in-flight patch or an
      // older candidate's publication may still apply the old content before
      // that publication. The window is an application index pinned by that
      // candidate's revision, whatever is active at check time: the host never
      // sees the removal. Scenario precondition: -9 is reserved for the ended
      // incarnation and the fresh baseline is gain 0, so later edits must not
      // use -9.
      const revision = h.active?.revision
      const frozen = revision === undefined ? undefined : h.submittedGraphs.get(revision)
      if (!frozen || reAddedAt === undefined) throw new Error("Incarnation witness has no published graph or re-add")
      const reAdded = reAddedAt
      const fresh = freshRevision
      if (freshPublication === undefined && fresh !== undefined) {
        const index = h.applications.findIndex((application, at) =>
          at >= reAdded && application.strategy === "publication" && application.revision === fresh)
        if (index >= 0) freshPublication = index
      }
      const decoded = fields(decodeGraph(frozen))
      const wrong = decoded.gain !== 0 || actual.gain !== desired.gain
      // A check before the fresh publication applied has nothing to scan, which
      // is a harness error unless the active content is already wrong.
      if (freshPublication === undefined && !wrong) throw new Error("Incarnation witness checked before the fresh publication applied")
      const afterBoundary = h.applications.slice(freshPublication ?? h.applications.length)
      checked("I1")
      const leaked = afterBoundary.some((application) => application.content.gain === -9)
      if (wrong || leaked)
        fail("I1", `Ended incarnation's desired survived: ${JSON.stringify({ decoded, actual, desired, leaked, observed: afterBoundary.length })}`, "live", "ledger-incarnation")
      record({ witness: mode, decoded, actual, leaked, observed: afterBoundary.length })
    }
    if (mode === "inclusion") {
      const revision = h.prepared?.revision
      const frozen = revision === undefined ? undefined : h.submittedGraphs.get(revision)
      if (!frozen) throw new Error("Inclusion witness has no frozen prepared graph")
      const decoded = fields(decodeGraph(frozen))
      checked("I1")
      if (decoded.gain !== desired.gain || decoded.fft !== desired.fft)
        fail("I1", `Frozen publication omitted newer desired content: ${JSON.stringify({ decoded, desired })}`)
      record({ witness: mode, decoded, desired })
    }
    if (mode === "prefix-12") {
      if (incarnation !== 2 || desired.utilityPresent !== true || actual.gain !== -9
        || waiters.some((waiter) => !waiter.settled))
        throw new Error("Prefix 12 did not remove/re-add and settle fresh incarnation")
      checked("I1"); checked("I7")
      record({ witness: "prefix-12", incarnation, actual, settled: true })
    }
    if (mode === "fresh-incarnation") {
      const submitted = h.active && h.submittedGraphs.get(h.active.revision)
      if (!submitted || !boundaryWaiter) throw new Error("Missing incarnation boundary evidence")
      const decoded = fields(decodeGraph(submitted))
      if (!crossedIncarnation) throw new Error("Prefix 12 lost its in-flight removal boundary")
      checked("I1"); checked("I7")
      if (decoded.gain !== 0 || actual.gain !== 0)
        fail("I1", "Old incarnation leaked into fresh decoded bytes or runtime", "live", "retained-override")
      if (!boundaryWaiter.settled) fail("I7", "Removed incarnation flush remains unsettled", "live", "transport-cancellation")
      if (z.object({ state: z.literal("applied") }).safeParse(boundaryWaiter.result).success)
        fail("I3", "Removed incarnation flush falsely settled applied", "live", "restamp-timeout")
      record({ witness: "fresh-incarnation", decoded, actual, oldWaiter: boundaryWaiter })
    }
    if (mode === "identity-same" || mode === "identity-changed") {
      if (!identityBaseline) throw new Error("Missing edit identity baseline")
      const dispatches = (h.counts.get("parameters") ?? 0) - identityBaseline.dispatches
      checked("I6"); checked("I1")
      if (mode === "identity-same" && (dispatches !== 0 || h.lastParameterSequence !== identityBaseline.sequence))
        fail("I6", "Same-value terminal flush dispatches a second edit", "live", "edit-identity")
      if (mode === "identity-changed" && (dispatches !== 1 || h.lastParameterSequence === identityBaseline.sequence || actual.gain !== -9))
        fail("I1", "Changed terminal bytes did not allocate and apply a new edit", "live", "edit-identity")
      record({ witness: mode, identityBaseline, dispatches, nativeSequence: h.lastParameterSequence, actual })
    }
    if (mode === "removed") {
      checked("I1")
      if (actual.gain !== null) fail("I1", "Removed incarnation remains in active graph")
    }
    if (mode === "terminal") checked("I7")
    if (mode === "terminal" && endingDomainFailure(waiters, h.domain)) {
      fail("I7", `Old-domain controller waiter survives ${terminalPublication?.kind} without progress`, h.lost ? "dead-host" : "ending-transport-domain",
        "transport-cancellation")
    }
    if (mode === "transport-refusal") {
      checked("I7")
      if (!controller.isPrepared()) fail("I7", "Pause disposes native session after callback-claimed SetTransport refusal", "ending-transport-domain")
    }
    if (mode === "retry-budget") {
      checked("I6")
      if ((h.counts.get("prepare") ?? 0) !== expectedPrepareCount)
        fail("I6", "Cheap patches reopened persistent adoption attempt")
      record({ event: "retry-ownership", before: ownershipWitness, after: JSON.stringify(controller.adoptionWitness()),
        hookRetryDecision: "deferred-to-A2" })
    }
    if (mode === "quiescent") {
      checked("I6")
      if (quiescenceFailure(quiescentCounts, JSON.stringify(Object.fromEntries(h.counts))))
        fail("I6", "Frozen identical input produced additional bridge work")
    }
  }
  const checkOwnership = () => {
    checked("I5")
    if (h.leases.size) populatedOwnershipChecks++
    for (const detail of ownershipFailures(h.leases, h.assets, [h.activeBank, h.preparedBank, h.retiredBank])) fail("I5", detail)
  }
  const checkRejections = (convergence = false) => {
    for (const waiter of pendingRejections.splice(0)) {
      const domain = waiter.settledDomain ?? "dead-session"
      if (!convergence && domain === "live") { pendingRejections.push(waiter); continue }
      // The hook fixture judges the same answers; a controller caller must not see an ending domain as a failure either.
      // The B3a-i prefixes that seek mid-flush still see their stale answer today; their table entries defer this class to B3b.
      const ending = z.object({ reason: z.string().optional(), error: z.string().optional() }).safeParse(waiter.result)
      const endingClass = domain === "ending-transport-domain" && ending.success
        ? endingRejectionClass(domain, ending.data.reason) ?? (ending.data.error?.includes("timeout") ? "domain-end-timeout" : undefined)
        : undefined
      if (endingClass) {
        rejectionClasses.push({ id: waiter.id, name: waiter.name, domain, result: waiter.result, classification: "stale-ending-domain", class: endingClass })
        checked("I7")
        fail("I7", `Pause/seek ${waiter.name} settled ${endingClass === "domain-end-timeout" ? "as a timeout" : "stale"}: ${waiter.id}`, domain, endingClass)
        continue
      }
      const latencyField = waiter.name === "latency"
      // A later same-field edit may deliver identical bytes. It cannot
      // retroactively prove this waiter's rejected dispatch.
      const proofEnd = (latencyField ? fftBoundaries : gainBoundaries)[waiter.fieldOrder]
      const proofs = h.applications.slice(waiter.applicationStart).filter((proof, index) =>
        proof.domain === waiter.domain && proof.epoch === waiter.epoch
        && (latencyField ? proof.strategy === "publication" && (proofEnd === undefined || waiter.applicationStart + index < proofEnd)
          && proof.content.fft === waiter.content.fft && proof.content.latency === waiter.content.fft
          : proof.content.gain === waiter.content.gain && waiter.nativeIncarnation === proof.incarnation
            && (proof.strategy === "publication" ? proofEnd === undefined || waiter.applicationStart + index < proofEnd
              : proof.strategy === "parameters" && proof.sequence !== undefined && recordBatches(dispatches, waiter.editId).includes(BigInt(proof.sequence)))))
      const superseded = (latencyField ? fftOrder : gainOrder) > waiter.fieldOrder
        || (!latencyField && waiter.content.incarnation !== incarnation)
      const classification = domain === "live" ? rejectionClassification(proofs.length > 0, superseded) : "cancelled"
      const failureClass = classification === "applied-but-rejected"
        ? latencyField ? "latency-after-publish-false-rejection"
          : proofDeadlineFailure(z.object({ error: z.string() }).safeParse(waiter.result).data?.error,
            proofs.map((proof) => proof.sequence), waiter.settlementApplied ?? 0n) ? "processor-proof-deadline" : "restamp-timeout"
        : latencyField && classification === "lost-edit" ? "latency-before-publish-lost-edit"
          : waiter.name === "flush" && recordBatches(dispatches, waiter.editId).some((sequence) => h.publicationCancelled.has(sequence))
            ? "post-admission-publication-cancel/resend"
            : "stale-stamp-at-dispatch/host-refused/resend"
      rejectionClasses.push({ id: waiter.id, name: waiter.name, domain, result: waiter.result, classification,
        class: classification === "cancelled" ? undefined : failureClass })
      record({ event: "rejection-classification", waiter, domain, classification, class: failureClass, proofs, superseded })
      if (domain !== "live") continue
      checked(classification === "lost-edit" ? "I1" : "I3")
      if (classification !== "rejected-then-superseded")
        fail(classification === "lost-edit" ? "I1" : "I3", `${classification}: ${waiter.name} ${waiter.id}`, domain, failureClass)
    }
  }
  const observe = () => {
    // O(1) I2 comparison/receipt proof and convergence eligibility; rejected
    // waiters inspect only applications within their same-field edit span.
    // Ownership is O(A + L) asset/reader conservation.
    // R is bounded by submitted edits, not all historical settled waiters.
    const actual = nativeFields(h.active)
    if (boundaryWaiter && !crossedIncarnation && actual.gain === null) {
      if (boundaryWaiter.settled) throw new Error("Prefix 12 flush settled before removal promotion")
      crossedIncarnation = true
      record({ witness: "prefix-12-crossed-removal", waiter: boundaryWaiter, decoded: fields(h.active) })
    }
    if (!h.lost && h.started) {
      if (h.running) minimumCoverageBlocks = Math.min(minimumCoverageBlocks ?? Infinity, Number(h.activeBank.through - h.frame) / 512)
      checked("I8")
      const coverage = coverageFailure(h.running, h.activeBank.through, h.frame)
      if (coverage) fail("I8", coverage)
    }
    if (!h.lost && liveEditCounts) {
      checked("I9")
      const rebuild = rebuildFailure(liveEditCounts, h.counts)
      if (rebuild) fail("I9", rebuild)
    }
    // Native drops an override with its history slot: that regression is native's, the controller's
    // part is sending the desired value again, which convergence judges.
    if (h.historySlotsReplaced !== slotsReplacedSeen) { slotsReplacedSeen = h.historySlotsReplaced; confirmedOrder = 1; awaitingRestore = true }
    if (awaitingRestore && actual.gain === desired.gain && desired.sequence > 1) {
      awaitingRestore = false; confirmedGain = desired.gain; confirmedOrder = desired.sequence
    }
    if (!h.lost && confirmedOrder > 1 && desired.utilityPresent !== false) {
      checked("I2")
      if (staleFailure(actual.gain, desired, confirmedGain, confirmedOrder))
        fail("I2", "Native content regressed below newer confirmed edit")
    }
    checkRejections(outstandingWaiters === 0 && !h.pendingControl
      && !h.queuedSends.length && !h.commands.length && !h.replies.length && !h.controls.length
      && !h.patch && !h.publicationPending && h.latencyReadyEpoch === undefined)
    checkOwnership()
  }
  return {
    // A2 can reuse this bridge/scheduler boundary; its mounted-hook fixture
    // must own a separate instance rather than share this controller's host.
    bridge, enabled, act: dispatch, failures, check, observe, joinPublication: controller.joinPublication,
    finishDrain: (steps: number, bound: number, exhausted: boolean) => {
      drainWitness = { steps, bound, exhausted }
      record({ event: "fair-drain", ...drainWitness })
      checkOwnership()
      if (waiters.some((waiter) => !waiter.settled)) {
        checked("I4"); fail("I4", "Unsettled controller request at logical drain bound", unsettledDomain())
      }
    },
    invalidateDrain: () => { drainWitness = undefined },
    setActionScope: (scope: number) => { h.nextId = scope * 1000 },
    hasActionId: (id: number) => h.pendingControl?.id === id || [...h.commands, ...h.queuedSends, ...compilations, ...h.replies].some((entry) => entry.id === id),
    checkpoint: async () => { for (let turn = 0; turn < 100; turn++) await Promise.resolve() },
    // The Stretch artifact repository is a real IndexedDB store, whose requests complete on the host's macrotasks.
    storage: async () => { for (let turn = 0; turn < 40; turn++) await new Promise<void>((resolve) => setImmediate(resolve)) },
    state: () => ({ desired, incarnation, actual: nativeFields(h.active), materializedGraph: fields(h.active), activeRevision: h.active?.revision, preparedRevision: h.prepared?.revision,
      retiredRevision: h.retired?.revision, frame: h.frame, epoch: h.epoch, renderEpoch: h.renderEpoch, capacityGeneration: h.capacityGeneration, blockAsset: h.blockAsset, candidate: candidate?.status,
      seam: h.seam, pendingControl: h.pendingControl && { id: h.pendingControl.id, name: h.pendingControl.name },
      queuedSends: h.queuedSends.map(({ id, name }) => ({ id, name })), publicationPending: h.publicationPending, publicationRequested: h.publicationRequested, publicationClaimed: h.publicationClaimed,
      publicationAcknowledged: h.publicationAcknowledged, publicationDeferred: h.publicationDeferred, latencyReadyEpoch: h.latencyReadyEpoch, rebaseRequired: h.rebaseRequired,
      commands: h.commands.map(({ id, name }) => ({ id, name })), replies: h.replies.map(({ id, name }) => ({ id, name })),
      waiters, assets: [...h.assets], leases: [...h.leases].map(([id, lease]) => ({ id, ...lease,
        owners: [...lease.owners].map((bank) => ({ revision: bank.revision, epoch: bank.epoch })) })),
      rejectionClasses, metrics: { minimumCoverageBlocks, candidateStatuses, populatedOwnershipChecks }, drainWitness, counts: Object.fromEntries(h.counts), checks: Object.fromEntries(checks), published: h.published }),
    pending: () => waiters.filter((waiter) => !waiter.settled),
    adoptionRunning: () => controller.adoptionWitness().running !== undefined,
    adoptionRetained: () => controller.adoptionWitness().retained !== undefined,
    stretchLeases: () => ({ ...stretchLeases }),
    nativeWork: () => h.controls.length > 0 || h.patch !== undefined || h.transport !== undefined
      || h.publicationPending || h.reclaimable() || h.progressSequence > h.deliveredProgressSequence,
    needsReclaim: () => h.reclaimable(),
    commandName: (id: number | undefined) => h.commands.find((command) => command.id === id)?.name,
    replyName: (id: number | undefined) => h.replies.find((reply) => reply.id === id)?.name,
  }
}
