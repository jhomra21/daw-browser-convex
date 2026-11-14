import { createComputed, createMemo, createRoot, createSignal, untrack } from "solid-js"
import { isServer } from "solid-js/web"
import { z } from "zod"
import { replaceEqualDeep } from "@tanstack/solid-query"
import { AudioEngine, type AudioEffectRuntimeInstance } from "@daw-browser/audio-engine/audio-engine"
import { createDefaultSpectralParams, createDefaultSynthParams, createDefaultUtilityParams, normalizeSpectralParamsEnvelope, normalizeUtilityParamsEnvelope, type TrackInstrumentParams } from "@daw-browser/shared"
import type { Track } from "@daw-browser/timeline-core/types"
import { useTimelinePlayback } from "../../src/hooks/useTimelinePlayback"
import { createEffectsPanelAudioDevice } from "../../src/components/timeline/create-effects-panel-audio-effects-state"
import { compileDesiredNativeProcessorState, compileLivePlaybackSnapshot, type LivePlaybackSnapshotInput } from "../../src/lib/live-playback-snapshot"
import { mapNativeBuiltInParameterCommit, type NativeBuiltInParameterPayload } from "../../src/lib/desktop/native-built-in-parameter-mapper"
import type { LiveProcessorEditIdentity, ProcessorDelivery } from "../../src/lib/live-processor-control"
import { setLocalEffectInstance, deleteLocalEffectInstance } from "../../src/lib/local-effects"
import { resolveDesiredPlaybackFx } from "../../src/lib/export/run-export-job"
import { pickNativePlaybackInputs } from "../../src/components/timeline/native-playback-inputs"
import { fixtureEdit, utilityGainPayload } from "./ae-08-processor-state-fuzz-edit"
import a2cChecks, { type Mark } from "./ae-08-processor-state-fuzz-hook-checks"
import bankChecks from "./ae-08-processor-state-fuzz-hook-bank-checks"
import FixtureBuffer from "./ae-08-processor-state-fuzz-hook-buffer"
import createHookBridge from "./ae-08-processor-state-fuzz-hook-bridge"
import createTracedProcessorEdits from "./ae-08-processor-state-fuzz-hook-edits"
import createWaiterLedger from "./ae-08-processor-state-fuzz-hook-waiters"
import createTimelineCommitPath from "../../src/components/timeline/create-timeline-effect-commit"
import mountHookHistory from "./ae-08-processor-state-fuzz-hook-history"
import createWitnessObserver from "./ae-08-processor-state-fuzz-witness"
import { openLocalProjectDb } from "../../src/lib/local-project-db"
import { ParameterGestureHolder } from "../../src/components/timeline/parameter-gesture-owner"
import createFuzzHost, { type Action } from "./ae-08-processor-state-fuzz-host"
import { createVirtualTime } from "./ae-08-processor-state-fuzz-virtual-time"
import { convergenceFailure, coverageFailure, decodeGraph, endingDomainFailure, fields, initialContent, masterGainOf, ownershipFailures, quiescenceFailure, rebuildFailure, settlementFailure, staleFailure, topologyFailure, type Defect, type Failure } from "./ae-08-processor-state-fuzz-oracle"

type RecordEvent = <Value>(event: Value) => void
const synthCutoffTarget = 3
type Command = { id: number; name: string; execute: () => void }
export type HookMutation = Defect | "real-timer" | "native-rollback" | "drop-dispatch" | "drop-transport"
  | "history-replay-on-failure" | "captured-rollback" | "skip-latest-edit" | "no-undo" | "retain-reservation" | "no-release"
  | "no-hold" | "no-loop-end" | "no-abort" | "skip-swap" | "dirty-flush" | "clear-override" | "allocate-only-replay" | "wrong-latest" | "same-stop-wrong-start" | "two-sources"

// Local-only fixture. Convex publishEffectOperation is deliberately not mounted.
// One hook creates one controller; the panel and hook share only product inputs
// and the existing desktop audioHost bridge, never a second controller.
export default async function createHookFixture(output: RecordEvent, seed: number, mutation?: HookMutation, instrument = false) {
  if (isServer) throw new Error("Hook fixture requires --conditions=browser")
  const witness = createWitnessObserver()
  const record: RecordEvent = (event) => { witness.record(event); output(event) }
  const time = createVirtualTime(record)
  const sentinel = time.sentinel()
  const descriptors = new Map(["window", "AudioBuffer"].map((name) =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const projectId = `project:ae08-a2a-${seed}`
  let dispose = () => {}
  let panelDispose = () => {}
  let disposeHistory = () => {}
  let historyFailures = 0
  const rebuilds: { prepared: boolean; playing: boolean; instanceId?: string; targetPresent: boolean }[] = []
  let rebuildsAtCapture = 0
  let disposed = false
  const failures: Failure[] = []
  const checks = new Map<string, number>()
  const checked = (id: string) => checks.set(id, (checks.get(id) ?? 0) + 1)
  const fail = (invariant: string, detail: string, domain = "live", failureClass?: string,
    reason: string | null = null, error: string | null = null, transition: string | null = null) => {
    if (failures.some((entry) => entry.invariant === invariant && entry.detail === detail)) return
    failures.push({ invariant, detail, domain, class: failureClass, reason, error, transition })
    record({ event: "failure", invariant, detail, domain, class: failureClass, reason, error, transition })
  }
  const hostMutation = mutation === "drop-batch" || mutation === "lost-edit"
    || mutation === "stale-overwrite" || mutation === "early-release" ? mutation : undefined
  const h = createFuzzHost(record, hostMutation, false, fail, () => checkOwnership(), true)
  h.clearOverridesOnPublish = mutation === "clear-override"
  const compilations: Command[] = []
  // The instrument gesture is live-only: the project snapshot keeps the synth's stored parameters, as the
  // controller fixture does, so a publication never reconfigures the synth node.
  let synthInstrument: Extract<TrackInstrumentParams, { kind: "synth" }> = { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() }
  const synthWaiters: { name: string; value: number; settled: boolean; result?: unknown }[] = []
  let gestureEdit: { value: number; edit: LiveProcessorEditIdentity | undefined } | undefined
  let synthBaseline: number | undefined
  let desired = { ...initialContent }
  let cheapAcks = 0
  let timerFires = 0
  let declaredLoopEnd = 1
  let mutationGain: number | undefined
  let minimumCoverageBlocks: number | undefined
  let populatedOwnershipChecks = 0
  let liveEditCounts: Map<string, number> | undefined
  let frozenCounts: string | undefined
  let frozenCompilations: number | undefined
  let identityBaseline: { dispatches: number; sequence?: number } | undefined
  let retryCounts: { prepares: number; compilations: number; patches: number; progress: bigint; publishes: number; assets: number } | undefined
  let compileCount = 0
  let heldPages: number | undefined
  // The instrument override each compile was handed, in compile order.
  const compileOverrides: (string | undefined)[] = []
  let stalePrepareCount: number | undefined
  let starvation: { frame: bigint; blocks: number; before: bigint; minimum: bigint } | undefined
  let starvationResult: { blocks: number; boundMs: number; renderedFrames: bigint; beforeFrames: bigint;
    minimumFrames: bigint; safetyHeadroomFrames: bigint; resumedFrames?: bigint } | undefined
  const capturedSnapshots: { bpm: number; numerator: number; loop: boolean }[] = []
  let allowedRollback = 0
  let persistenceFailures = 0
  let panelErrors = 0
  let consumedRollback = 0
  let lastKnob = 0
  let rejectedKnob: number | undefined
  let wroteKnob: number | undefined
  let rejectedDomain = "live"
  let rejectedReason: string | null = null
  let rejectedError: string | null = null
  let rejectedTransition: string | null = null
  let persistedGain: number | undefined
  const marks = new Map<string, Mark>()
  const bridge = createHookBridge({ h, time, mutation, compilations })
  time.install()
  Object.defineProperty(globalThis, "AudioBuffer", { configurable: true, value: FixtureBuffer })
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: bridge.audioHost } } })
  const checkpoint = async () => { for (let turn = 0; turn < 100; turn++) await Promise.resolve() }
  // Each task is selected separately, after all promise continuations settle.
  const drainIdb = async () => {
    for (let count = 0; count < 10_000; count++) {
      await checkpoint()
      const next = time.enabled().find((entry) => entry.kind === "idb-task")
      if (!next) return
      time.run(next.id)
    }
    throw new Error("IDB initialization/cleanup task bound exhausted")
  }
  try {
    // Real rows, stable instance IDs and explicit order avoid UUID/time in traces.
    let setupError: unknown
    let setupDone = false
    void (async () => {
      const db = await openLocalProjectDb(projectId)
      await db.clear("entities")
      await setLocalEffectInstance(projectId, "track", "utility",
        { version: 1, state: createDefaultUtilityParams() }, { instanceId: "utility:1", index: 0 })
      await setLocalEffectInstance(projectId, "track", "spectral",
        { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 512 } }, { instanceId: "spectral:1", index: 1 })
    })().then(() => { setupDone = true }, (error) => { setupError = error })
    await drainIdb()
    if (!setupDone) throw new Error(`Local row initialization failed: ${String(setupError)}`)
    const buffer = new FixtureBuffer()
    const [tracks, setTracks] = createSignal<Track<AudioBuffer>[]>([
      { id: "track", name: "Track", volume: 1, clips: [] },
      { id: "parallel", name: "Parallel", volume: 1, clips: [] },
    ])
    const [loopEnabled, setLoopEnabled] = createSignal(false)
    const [bpm, setBpm] = createSignal(120)
    const [meter, setMeter] = createSignal({ numerator: 4, denominator: 4 })
    const [projection, setProjection] = createSignal(0)
    const [loopEnd, setLoopEnd] = createSignal(1)
    // Timeline's own identity authority: it is the order clock and the target
    // incarnation source, so B1's identity behavior is measured, not modeled.
    const { processorEdits, trace } = createTracedProcessorEdits(bpm, mutation)
    const engine = new AudioEngine()
    const ledger = createWaiterLedger({ h, mutation, record, fail, checked, desired: () => desired,
      prepared: () => mounted.playback.isNativePlaybackPrepared() })
    const { waiters, watch } = ledger
    const mounted = createRoot((cleanup) => {
      dispose = cleanup
      const playback = useTimelinePlayback({
        currentTimelineSec: 0, ensureAudio: () => {}, applyAutomationAtTimelineSec: () => {},
        cancelAutomationSchedules: () => {}, onTransportPause: () => {}, onTransportSeek: () => {},
        onTransportStart: () => {}, onTransportStop: () => {}, resume: async () => {},
        rescheduleClipsAtPlayhead: () => ({ deferredStretchWindows: [] }),
        scheduleAllClipsFromPlayhead: () => ({ deferredStretchWindows: [] }),
        scheduleAutomationFromPlayhead: () => {}, stopAllSources: () => {},
        subscribeStretchRenderState: () => () => true,
      }, { getTracks: tracks, bpm, loopEnabled, loopStartSec: () => 0, loopEndSec: loopEnd }, {
        requiresNativeAudio: true, enabled: () => true, projectId: () => projectId, projectGeneration: () => 1,
        playbackInputs: () => inputs(),
        compileSnapshot: (transport, context) => {
          const captured = compileLivePlaybackSnapshot(snapshot(transport, context?.instrumentOverride !== undefined))
          compileCount++
          compileOverrides.push(context?.instrumentOverride?.targetId)
          if (captured.supported) capturedSnapshots.push({ bpm: captured.snapshot.bpm,
            numerator: captured.snapshot.timeSignature?.numerator ?? 4, loop: captured.snapshot.transport.loopEnabled })
          const gate = Promise.withResolvers<typeof captured>()
          const id = ++h.nextId
          compilations.push({ id, name: "compile", execute: () => gate.resolve(captured) })
          record({ event: "compile", id, captured: { ...desired } })
          return gate.promise
        },
        getProcessorTarget: processorEdits.target,
        // Timeline.tsx getDesiredProcessorState: the effective projection over
        // the compiled snapshot's fx, through the same exported resolvers.
        getDesiredProcessorState: (captured, sampleRate) => {
          return compileDesiredNativeProcessorState(captured, sampleRate, processorEdits.sequence(), panel.snapshotExportProjection())
        },
        reportFault: (message) => record({ event: "product-fault", message }),
      })
      const register = (edit: LiveProcessorEditIdentity, gesture?: ProcessorDelivery["gesture"]) => {
        const registration = playback.deliverProcessor(edit, gesture)
        const gain = edit.target.kindId === 1 ? z.object({ state: z.object({ gainDb: z.number() }) }).parse(edit.content.params).state.gainDb : desired.gain
        const waiter = watch(edit.target.kindId === 15 ? "latency" : gesture?.holds ? "preview" : "flush", registration.settled,
          { ...desired, sequence: edit.order, gain })
        void registration.settled.then(result => {
          if (result.state !== "refused" && result.state !== "unconfirmed") return
          rejectedKnob = edit.target.kindId === 1 ? gain : undefined
          rejectedDomain = waiter.settledDomain ?? "dead-session"
          rejectedReason = result.state === "refused" ? result.reason : "unconfirmed"
          rejectedError = null
          rejectedTransition = h.domainCommands.find(command => command.id > waiter.id)?.name ?? null
          ledger.refuse(waiter)
        })
        return registration
      }
      const panel = createRoot((cleanupPanel) => {
        panelDispose = cleanupPanel
        return createEffectsPanelAudioDevice({
          audioEngine: () => engine, projectId: () => projectId, userId: () => undefined, roomEffects: () => [],
          canWriteCurrentTargetEffects: () => true, projectGeneration: () => 1, usesLegacyAudioEngine: () => false,
          allocateProcessorEdit: processorEdits.allocate,
          deliverProcessor: register,
          onEffectParamsCommitted: (payload, committedProjectId, options) => commitPath.committed(payload, committedProjectId, options),
          onLocalSaveFailed: (_project, message) => {
            allowedRollback++; persistenceFailures++; record({ event: "persistence-failed", message })
            // Planted defect: rollback to a captured baseline regardless of newer writes.
            if (mutation === "captured-rollback") panel.replayInstanceParams({ targetId: "track", effect: "utility",
              instanceId: "utility:1", params: { version: 1, state: createDefaultUtilityParams() } })
          },
          onEffectError: (title, message) => { panelErrors++; record({ event: "panel-error", title, message }) },
        }, () => "track", (id) => tracks().find((track) => track.id === id))
      })
      // The committed row, read through the export snapshot: it carries no gesture preview.
      const committedGain = (instanceId: string) => {
        const row = panel.snapshotExportRows(["track"]).find((entry) => entry.instanceId === instanceId)
        return normalizeUtilityParamsEnvelope(row?.effect === "utility" ? row.params : null).state.gainDb
      }
      const history = mountHookHistory({ projectId, tracks, engine, processorEdits,
        panel: { replayInstanceParams: (payload) => {
          // The entry precedes the allocation the replay takes; a rejected replay withdraws it.
          const entry = payload.effect === "utility" ? trace.length : -1
          if (entry >= 0) trace.push({ kind: "replay", gain: normalizeUtilityParamsEnvelope(payload.params).state.gainDb, applications: h.applications.length })
          // Planted defect: the replay takes its identity but never writes its content to the panel.
          const accepted = entry >= 0 && mutation === "allocate-only-replay"
            ? processorEdits.allocate(utilityGainPayload(normalizeUtilityParamsEnvelope(payload.params).state.gainDb)) !== undefined
            : panel.replayInstanceParams(payload)
          if (entry >= 0 && !accepted) trace.splice(entry, 1)
          else if (entry >= 0) trace.push({ kind: "applied", instanceId: payload.instanceId,
            gain: committedGain(payload.instanceId) })
          return accepted
        } },
        notify: (title, message) => {
          record({ event: "notify", title, message })
          if (title === "Undo failed" || title === "Redo failed") {
            historyFailures++
            // Planted defect: a replay that ignores the failed save.
            if (mutation === "history-replay-on-failure") panel.replayInstanceParams({ targetId: "track", effect: "utility",
              instanceId: "utility:1", params: { version: 1, state: createDefaultUtilityParams() } })
          }
        } })
      const commitPath = createTimelineCommitPath({ projectId: () => projectId, tracks, pushHistory: history.pushHistory })
      disposeHistory = () => { void history.close() }
      function runtimeInstances(): AudioEffectRuntimeInstance[] {
        return panel.orderedEffects().flatMap((instance): AudioEffectRuntimeInstance[] => {
          const params = panel.paramsForInstance(instance) ?? null
          if (instance.kind === "utility") return [{ ...instance, kind: "utility", params: normalizeUtilityParamsEnvelope(params) }]
          if (instance.kind === "spectral") return [{ ...instance, kind: "spectral", params: normalizeSpectralParamsEnvelope(params) }]
          return []
        })
      }
      // The compile context changes what is compiled (Timeline folds an instrument override into the projected fx); the
      // fixture models that as a different master volume, so a compile that is skipped is a publication that never happens.
      function snapshot(transport: LivePlaybackSnapshotInput["transport"], overridden = false): LivePlaybackSnapshotInput {
        return { revision: 1, processorStateSequence: processorEdits.sequence(), bpm: bpm(), timeSignature: meter(), transport, tracks: untrack(tracks),
          renderState: { fx: { masterVolume: overridden ? 0.5 : 1, masterFxInstances: [], trackFx: { ...(instrument && { parallel: { instances: [], instrument: synthInstrument } }),
            track: { instances: untrack(runtimeInstances) } } },
            automationEnvelopes: [] }, sidechainRoutes: [] }
      }
      // The product's projected-input identity is reactive; no explicit restart.
      // Timeline.tsx observes the effective projection before any compile or
      // dispatch reads the desired order; a scope change clears membership first.
      let observed = false
      createComputed(() => {
        projection()
        const fx = resolveDesiredPlaybackFx({ trackFx: instrument ? { parallel: { instances: [], instrument: synthInstrument } } : {}, masterFxInstances: [], masterVolume: 1 },
          panel.snapshotExportProjection(), undefined)
        untrack(() => {
          if (!observed) { processorEdits.reset(); observed = true }
          processorEdits.observe(fx)
        })
      })
      const inputs = createMemo(() => {
        projection()
        return pickNativePlaybackInputs({
          timeSignature: meter(), automationEnvelopes: [], masterVolume: 1, automation: [], sidechains: [],
          processorStructure: processorEdits.structure(),
        })
      }, undefined, { equals: (previous, next) => replaceEqualDeep(previous, next) === previous })
      return { playback, panel, history, commitPath, committedGain }
    })
    const { playback, panel, history, commitPath, committedGain } = mounted
    await drainIdb()
    if (panel.orderedEffects().length !== 2) throw new Error("Real local panel rows did not load")
    // The panel's gesture owner is the control-facing API: one holder stands for the fixture's pointer, `changeInstance`
    // previews while its gesture is open, and the last holder's `end` commits.
    const pointer = new ParameterGestureHolder()
    const beginGesture = (instanceId: string, kind: "utility" | "spectral") => panel.gestureOwner(instanceId, kind).open(pointer)
    // The value is written inside the owner's tick, so a holder the owner has closed (a flush, a removal) writes nothing.
    const tickGesture = (instanceId: string, kind: "utility" | "spectral", emit: () => void) => {
      const handle = panel.gestureOwner(instanceId, kind)
      if (!handle.isOpen(pointer)) handle.open(pointer)
      if (!handle.tick(pointer, emit)) record({ event: "tick-dropped", id: instanceId })
    }
    const commitGesture = (instanceId: string, kind: "utility" | "spectral") => panel.gestureOwner(instanceId, kind).end(pointer)
    const cancelGesture = (instanceId: string, kind: "utility" | "spectral") => panel.gestureOwner(instanceId, kind).cancel(pointer)
    const knob = () => normalizeUtilityParamsEnvelope(panel.paramsForInstance({ id: "utility:1", kind: "utility" }) ?? null).state.gainDb
    const refreshDesired = () => {
      const present = panel.orderedEffects().some((instance) => instance.id === "utility:1")
      desired = { ...desired, gain: mutationGain ?? knob(),
        fft: normalizeSpectralParamsEnvelope(panel.paramsForInstance({ id: "spectral:1", kind: "spectral" }) ?? null).state.fftSize,
        sequence: processorEdits.sequence(), utilityPresent: present,
        incarnation: present && desired.utilityPresent === false ? desired.incarnation + 1 : desired.incarnation }
    }
    const committedKnob = () => committedGain("utility:1")
    const currentMark = (): Mark => ({ knob: knob(), committed: committedKnob(), native: h.nativeFields(h.active).gain, persisted: persistedGain,
      applicationCount: h.applications.length, editSequence: processorEdits.sequence(), historyFailures,
      rebuilds: rebuilds.length, removedRebuilds: rebuilds.filter((entry) => !entry.targetPresent).length,
      trace: trace.length, persistenceFailures, panelErrors, aborts: time.effectTransactions().filter((entry) => entry.state === "aborted").length, prepares: h.counts.get("prepare") ?? 0, publishes: h.counts.get("publish") ?? 0,
      assets: [...h.assets.keys()], sources: [...h.activeBank.sources.keys()],
      coldInstalls: ["stop", "configure", "initial-graph"].reduce((total, name) => total + (h.counts.get(name) ?? 0), 0) })
    const observe = () => {
      bridge.synchronizeSupervisor()
      refreshDesired()
      const current = knob()
      if (current !== lastKnob) {
        checked("I10")
        // A rejection can settle inside the same step as a newer gesture; the knob moving to that gesture's own value is not a rollback.
        if (rejectedKnob !== undefined && current !== rejectedKnob && current !== wroteKnob && allowedRollback === consumedRollback)
          fail("I10", "Panel knob rolled back after native rejection without persistence failure or gesture cancel", rejectedDomain, "panel-rollback-on-native-rejection", rejectedReason, rejectedError, rejectedTransition)
        consumedRollback = allowedRollback
        lastKnob = current
      }
      consumedRollback = allowedRollback
      checkOwnership()
      if (!h.lost && h.started) {
        if (starvation) starvation.minimum = h.activeBank.through - h.frame < starvation.minimum
          ? h.activeBank.through - h.frame : starvation.minimum
        if (h.running) minimumCoverageBlocks = Math.min(minimumCoverageBlocks ?? Infinity, Number(h.activeBank.through - h.frame) / 512)
        checked("I8")
        const coverage = coverageFailure(h.running, h.activeBank.through, h.frame)
        if (coverage) fail("I8", coverage)
      }
      if (!h.lost && liveEditCounts) {
        checked("I9")
        const rebuild = rebuildFailure(liveEditCounts, h.counts)
        // Only a commit for a removed target is a known fallthrough; any other rebuild is a new symptom.
        const fallthroughs = rebuilds.slice(rebuildsAtCapture).filter((entry) => entry.prepared)
        if (rebuild) fail("I9", rebuild, "live", fallthroughs.length && fallthroughs.every((entry) => !entry.targetPresent)
          ? "commit-after-removal-rebuild" : undefined)
      }
      if (!h.lost && playback.isNativePlaybackPrepared() && desired.utilityPresent && ledger.confirmed().order > 1) {
        checked("I2")
        const stale = staleFailure(h.nativeFields(h.active).gain, desired, ledger.confirmed().gain, ledger.confirmed().order)
        if (stale) fail("I2", stale)
      }
    }
    const enabled = (): Action[] => [
      ...h.enabled(compilations).filter((entry) => !["revision-deadline", "control-watchdog"].includes(entry.kind)),
      ...time.enabled().map(({ id, kind }) => ({ kind, id })),
      ...(time.canFailPersistence() ? [{ kind: "persist-fail" }] : []),
      ...(!bridge.lifecycle.isReady() ? [{ kind: "lifecycle-ready" }] : []),
    ]
    const act = async (action: Action) => {
      record({ event: "action", action, enabled: enabled() })
      if (playback.isPlaying() && playback.isNativePlayback() && !playback.isPreparingPlayback()
        && ["gain", "preview", "flush", "latency", "membership", "clip-timing", "undo", "redo", "late-commit"].includes(action.kind) && !liveEditCounts) {
        liveEditCounts = new Map(h.counts); rebuildsAtCapture = rebuilds.length
      }
      if (["pause", "seek", "loss", "dispose", "start", "loop"].includes(action.kind)) liveEditCounts = undefined
      if (["gain", "preview", "flush", "cancel", "membership", "latency"].includes(action.kind)) rejectedKnob = undefined
      wroteKnob = ["gain", "preview", "flush"].includes(action.kind) ? action.value ?? -6 : undefined
      if (action.kind === "fire-timer") timerFires++
      if (["fire-timer", "raf-tick", "idb-task"].includes(action.kind)) {
        if (action.id === undefined) throw new Error("Virtual action without ID")
        time.run(action.id)
      } else if (action.kind === "capture-domain") witness.capture(action.value ?? knob(),
        waiters.filter((waiter) => !waiter.settled).map((waiter) => waiter.id), h.applications.length)
      else if (action.kind === "read-persisted") {
        const db = await openLocalProjectDb(projectId)
        void db.get("entities", ["effect", "track:effect:utility:1"]).then((row) => {
          const parsed = z.object({ params: z.object({ state: z.object({ gainDb: z.number() }) }) }).safeParse(row?.value)
          const saved = parsed.success ? parsed.data.params.state.gainDb : undefined
          checked("I10")
          if (saved !== witness.state().gain)
            fail("I10", "Domain-ended draft was not persisted", "ending-transport-domain", "cancelled-draft-persistence")
          record({ witness: "draft-persisted", expected: witness.state().gain, saved })
        })
      }
      else if (action.kind === "inspect-latency") {
        const revision = h.retired?.revision ?? h.active?.revision
        // A session disposed by Pause has no revision left to Inspect: the
        // check reports that as a missing transition completion.
        if (revision === undefined) record({ event: "inspect-unavailable" })
        else watch("witness-inspect", h.bridge.session.revisions.inspect({ projectId, revision, hostGeneration: 7 }))
      }
      else if (action.kind === "persist-fail") { if (mutation !== "no-abort") time.failNextPersistence() }
      else if (action.kind === "starvation-begin") {
        if (!h.running || h.pendingControl?.name !== "window" || h.activeBank.through - h.frame >= 48_000n)
          throw new Error("Starvation requires running host with threshold refill queued")
        starvation = { frame: h.frame, blocks: action.value ?? 24, before: h.activeBank.through - h.frame,
          minimum: h.activeBank.through - h.frame }
      }
      else if (action.kind === "starvation-end") {
        if (!starvation || h.frame - starvation.frame !== BigInt(starvation.blocks * 512))
          throw new Error("Starvation witness failed to render bounded running window")
        starvationResult = { blocks: starvation.blocks, boundMs: starvation.blocks * 512 / 48,
          renderedFrames: h.frame - starvation.frame, beforeFrames: starvation.before,
          minimumFrames: starvation.minimum, safetyHeadroomFrames: starvation.minimum - 512n }
        starvation = undefined
      }
      else if (action.kind === "capture-stale-compile") stalePrepareCount = h.counts.get("prepare") ?? 0
      else if (action.kind === "identity-baseline") identityBaseline = {
        dispatches: h.counts.get("parameters") ?? 0, sequence: h.lastParameterSequence,
      }
      else if (action.kind === "commit") { commitGesture("utility:1", "utility") }
      else if (action.kind === "project-identical") setProjection((value) => value + 1)
      else if (action.kind === "tempo") setBpm(action.value ?? 137)
      else if (action.kind === "meter") setMeter({ numerator: action.value ?? 7, denominator: 8 })
      else if (action.kind === "long-loop") {
        declaredLoopEnd = 60; setLoopEnd(60); setLoopEnabled(true)
        watch("long-loop", playback.updateNativeLoop())
      }
      else if (action.kind === "cheap-ack") {
        // Equal content reuses its edit identity, so each ACK opportunity is a
        // distinct sub-dB write that the registry orders after the previous one.
        const params: ReturnType<typeof normalizeUtilityParamsEnvelope> = { version: 1,
          state: { ...createDefaultUtilityParams(), gainDb: knob() + ++cheapAcks * 0.01, swap: cheapAcks % 2 !== 0 } }
        const payload: NativeBuiltInParameterPayload = { effect: "utility", instanceId: "utility:1", targetId: "track", from: params, to: params }
        const edit = processorEdits.allocate(payload)
        if (!edit) throw new Error("Cheap-ACK scenario needs an allocated processor edit")
        watch("cheap-ack", playback.deliverProcessor(edit).settled)
      }
      else if (action.kind === "gain-patch") {
        // A real structural change is required to exercise patches after whole-content carrier selection.
        const params: ReturnType<typeof normalizeUtilityParamsEnvelope> = { version: 1,
          state: { ...createDefaultUtilityParams(), gainDb: action.value ?? 0, swap: true } }
        const payload: NativeBuiltInParameterPayload = { effect: "utility", instanceId: "utility:1", targetId: "track",
          from: { version: 1, state: createDefaultUtilityParams() }, to: params }
        const edit = processorEdits.allocate(payload)
        if (!edit) throw new Error("Patch scenario needs an allocated processor edit")
        watch("gain-patch", playback.deliverProcessor(edit).settled)
      }
      else if (action.kind === "external-adoption") watch("external-save",
        setLocalEffectInstance(projectId, "track", "utility", { version: 1,
          state: { ...createDefaultUtilityParams(), gainDb: action.value ?? -11 } }, { instanceId: "utility:1", index: 0 }).then(() => {}))
      else if (action.kind === "block-asset") {
        h.blockAsset = action.value !== 0
        h.blockAssetError = action.mode === "publication-pending" ? "asset-publication-pending" : "asset-capacity-exceeded"
      }
      else if (action.kind === "refuse-parameters") h.refuseParameters = action.value ?? 1
      else if (action.kind === "synth-preview" || action.kind === "synth-flush") {
        // Timeline's instrument path: the registry allocates the edit, the mapper turns it into values and
        // the hook's live control carries it (a flush after a preview must join that preview's execution).
        const value = action.value ?? 4000
        const nextInstrument = { ...synthInstrument, params: { ...synthInstrument.params,
          filter: { ...synthInstrument.params.filter, frequencyHz: value } } }
        const payload: NativeBuiltInParameterPayload = { targetId: "parallel", effect: "instrument",
          from: synthInstrument, to: nextInstrument }
        // The panel keeps one edit per gesture value, so a terminal flush carries the identity its preview did,
        // even when a publication's projection has since allocated another.
        const edit = gestureEdit?.value === value ? gestureEdit.edit : processorEdits.allocate(payload)
        gestureEdit = { value, edit }
        // Publish the same effective instrument the real panel just edited. Leaving the baseline here
        // makes a later compile legitimately supersede the gesture with the old cutoff.
        synthInstrument = nextInstrument
        setProjection(previous => previous + 1)
        const mapped = mapNativeBuiltInParameterCommit({ ...payload, edit }, bpm())
        if (!mapped || !edit) throw new Error("Instrument gesture needs a mapped edit")
        synthBaseline ??= h.counts.get("instrument-events") ?? 0
        const waiter: (typeof synthWaiters)[number] = { name: action.kind, value, settled: false }
        synthWaiters.push(waiter)
        void playback.deliverProcessor(edit, { token: "synth-gesture", holds: action.kind === "synth-preview" }).settled.then((result) => {
          waiter.settled = true; waiter.result = result
          record({ event: "settled", name: waiter.name, result })
        })
      }
      else if (action.kind === "capture-retry") retryCounts = { prepares: h.counts.get("prepare") ?? 0,
        compilations: compileCount, patches: h.applications.filter((entry) => entry.strategy === "patch").length,
        progress: h.deliveredProgressSequence, publishes: h.counts.get("publish") ?? 0, assets: h.counts.get("asset") ?? 0 }
      else if (action.kind === "restart-schedule") watch("restart-schedule", playback.restartTimelineSchedule(untrack(tracks),
        // Timeline's instrument change restarts the schedule with only this context changed.
        action.mode === "override" ? { instrumentOverride: { targetId: "parallel", instrument: synthInstrument } } : undefined))
      else if (action.kind === "late-commit") {
        // A commit callback that arrives after the panel cancelled its gesture for a removed member. The panel stamps the
        // payload with the edit its draft was allocated (`draftEdits`), which names the target as the gesture saw it.
        const gesture = utilityGainPayload(action.value ?? -9)
        const payload = { ...gesture, edit: fixtureEdit(gesture, processorEdits.sequence() + 1, bpm(), 1) }
        watch("late-commit", Promise.resolve(commitPath.committed(payload)))
      }
      else if (action.kind === "undo") { if (mutation !== "no-undo") history.handleUndo() }
      else if (action.kind === "redo") history.handleRedo()
      else if (action.kind === "arm-drop") {
        bridge.arm(action)
      }
      else if (action.kind === "mark") marks.set(action.mode ?? "mark", { ...currentMark(), value: action.value })
      else if (action.kind === "observe-persisted") {
        const db = await openLocalProjectDb(projectId)
        void db.get("entities", ["effect", "track:effect:utility:1"]).then((row) => {
          const parsed = z.object({ params: z.object({ state: z.object({ gainDb: z.number() }) }) }).safeParse(row?.value)
          persistedGain = parsed.success ? parsed.data.params.state.gainDb : undefined
        })
      }
      else if (action.kind === "loop-end") {
        // Timeline.tsx reconciles native loop settings whenever a loop bound changes.
        declaredLoopEnd = action.value ?? 1
        if (mutation !== "no-loop-end") setLoopEnd(declaredLoopEnd)
        if (playback.isNativePlaybackPrepared()) watch("loop-end", playback.updateNativeLoop())
      }
      else if (action.kind === "sample-swap") {
        // A new source identity with its own buffer: the controller keys installed resources by it.
        if (mutation !== "skip-swap") setTracks((previous) => previous.map((track) => track.id === "track" ? { ...track, clips: track.clips.map((clip) => ({
          ...clip, sourceAssetKey: "source-swapped", sampleUrl: "fixture:source-swapped", buffer: new FixtureBuffer() })) } : track))
      }
      else if (action.kind === "lifecycle-ready") {
        bridge.lifecycle.ready()
      } else if (action.kind === "lifecycle-suspend") {
        h.domain++; liveEditCounts = undefined; ledger.resetConfirmed()
        bridge.lifecycle.suspend()
      } else if (h.act(action, compilations, h.lose, () => {})) {}
      else if (action.kind === "start") watch("start", playback.handlePlay(untrack(tracks)))
      else if (["gain", "preview", "flush"].includes(action.kind)) {
        ledger.beginGainEdit()
        tickGesture("utility:1", "utility", () => panel.utility.changeInstance("utility:1", (params) => ({ ...params, state: { ...params.state, gainDb: action.value ?? -6,
          ...(action.mode === "pan" && { pan: 0.25 }), ...(action.mode === "pan-reset" && { pan: 0 }) } })))
        if (action.kind !== "preview") commitGesture("utility:1", "utility")
      } else if (action.kind === "cancel") {
        allowedRollback++; cancelGesture("utility:1", "utility")
      } else if (action.kind === "latency") {
        ledger.beginLatencyEdit()
        beginGesture("spectral:1", "spectral")
        tickGesture("spectral:1", "spectral", () => panel.spectral.changeInstance("spectral:1", (params) => ({ ...params, state: { ...params.state,
          fftSize: action.value === 512 ? 512 : 2048 } })))
        commitGesture("spectral:1", "spectral")
      } else if (action.kind === "membership") {
        allowedRollback++
        if (action.value === 0) ledger.removeTarget()
        watch("membership", action.value === 0
          ? deleteLocalEffectInstance(projectId, "track", "utility", "utility:1")
          : setLocalEffectInstance(projectId, "track", "utility", { version: 1, state: createDefaultUtilityParams() }, { instanceId: "utility:1", index: 0 }).then(() => {}))
      } else if (action.kind === "clip-timing") {
        desired = { ...desired, sample: true }
        // Planted defect: a stale clip from 0 s stays projected beside the survivor, on the same asset.
        const staleClip: Track<AudioBuffer>["clips"][number] = {
          id: "stale", name: "Stale", color: "#fff", startSec: 0, duration: 1,
          sourceAssetKey: "source", sourceKind: "url", sampleUrl: "fixture:source", buffer,
        }
        if (!(mutation === "skip-latest-edit" && action.mode === "latest")) setTracks((previous) => previous.map((track) => track.id === "track" ? { ...track, clips: [{
          id: "clip", name: "Clip", color: "#fff", startSec: mutation === "wrong-latest" && action.mode === "latest" ? 0.5
            : mutation === "same-stop-wrong-start" && action.mode === "latest" ? 0.75 : action.value ?? 0,
          duration: mutation === "same-stop-wrong-start" && action.mode === "latest" ? 0.5 : 1,
          sourceAssetKey: "source", sourceKind: "url", sampleUrl: "fixture:source", buffer,
        }, ...(mutation === "two-sources" && action.mode === "latest" ? [staleClip] : [])] } : track))
      } else if (action.kind === "pause") { h.domain++; ledger.resetConfirmed(); watch("pause", playback.handlePause()) }
      else if (action.kind === "seek") { h.domain++; ledger.resetConfirmed(); playback.setPlayhead(action.value ?? 0.25, untrack(tracks)) }
      else if (action.kind === "loop") { h.domain++; ledger.resetConfirmed(); setLoopEnabled((value) => !value); watch("loop", playback.updateNativeLoop()) }
      else if (action.kind === "patch-mode") h.patchMode = action.mode ?? "normal"
      else if (action.kind === "loss") { h.lose(); h.endLeases() }
      else if (action.kind === "dispose") { panelDispose(); dispose(); disposed = true }
      else if (action.kind === "freeze") {
        frozenCounts = JSON.stringify(Object.fromEntries(h.counts)); frozenCompilations = compileCount
      }
      else if (action.kind === "settle-panel") watch("panel-flush", panel.flushPending())
      else if (action.kind === "reclaim") h.reclaimAssets()
      else if (action.kind === "mutation-probe" && mutation === "real-timer") {
        time.armEscape()
        beginGesture("utility:1", "utility")
        tickGesture("utility:1", "utility", () => panel.utility.changeInstance("utility:1", (params) => ({ ...params, state: { ...params.state, gainDb: -9 } })))
        commitGesture("utility:1", "utility")
      }
      else if (action.kind === "unowned-timer-wait" && mutation === "real-timer") await time.waitEscape()
      else if (action.kind === "mutation-probe" && mutation === "native-rollback") {
        // Refuse at the serialized host boundary. The actual flush reports a
        // rejection and the actual panel catch branch decides whether to roll back.
        bridge.rejectNative()
        commitGesture("utility:1", "utility")
      } else if (action.kind === "mutation-probe" && mutation === "swallow-waiter") {
        watch("wrapper-waiter", Promise.resolve({ state: "applied" }))
      } else if (action.kind === "mutation-probe" && mutation === "false-receipt") {
        watch("wrapper-flush", Promise.resolve({ state: "applied" }), { ...desired, gain: 24 })
      } else if (action.kind === "mutation-probe" && mutation === "early-release") {
        const id = h.activeBank.sources.keys().next().value
        if (id === undefined) throw new Error("Early release requires live source ownership")
        watch("wrapper-release", h.bridge.session.releaseAsset(id))
      } else if (action.kind === "mutation-probe" && mutation === "noop-churn") {
        watch("wrapper-noop", h.simple("instruments"))
      } else if (action.kind === "mutation-probe" && mutation === "force-rebuild") {
        liveEditCounts = new Map(h.counts)
        watch("wrapper-forced-rebuild", h.simple("stop"))
      } else if (action.kind === "mutation-probe" && ["drop-batch", "lost-edit", "false-rejection", "stale-overwrite"].includes(mutation ?? "")) {
        // Fault isolation: drive the mounted hook's public control, not the
        // panel projection that would independently heal a dropped preview.
        // This is the same immutable wrapper mutation used by A1.
        ledger.beginGainEdit()
        mutationGain = action.value ?? -17
        const edit = processorEdits.allocate(utilityGainPayload(mutationGain))
        desired = { ...desired, gain: mutationGain, sequence: edit?.order ?? processorEdits.sequence() }
        if (!edit) throw new Error("Mutation needs a registered edit")
        const promise = playback.deliverProcessor(edit, { token: "mutation", holds: action.mode !== "flush" }).settled
        watch("mutation-preview", mutation === "false-rejection"
          ? promise.then(() => ({ state: "refused", reason: "native-refused" })) : promise)
      } else throw new Error(`Unknown hook action ${action.kind}`)
      refreshDesired()
      await checkpoint()
      observe()
    }
    const quiescent = () => !h.pendingControl && !h.queuedSends.length && !h.commands.length && !h.replies.length
      && !compilations.length && !h.controls.length && !h.patch && !h.transport && !h.publicationPending && h.latencyReadyEpoch === undefined
      && !playback.isPreparingPlayback()
      && h.progressSequence === h.deliveredProgressSequence
      && !waiters.some((waiter) => !waiter.settled) && !synthWaiters.some((waiter) => !waiter.settled)
      && !time.enabled().some((entry) => entry.kind === "idb-task" || entry.kind === "raf-tick" && entry.site.includes("parameter-gesture-owner"))
    const check = (mode = "drained") => {
      refreshDesired()
      if (mode === "instrument-urgent") {
        const flush = synthWaiters.findLast((waiter) => waiter.name === "synth-flush")
        if (!flush || synthBaseline === undefined) throw new Error("Instrument witness needs a flush")
        checked("I3"); checked("I6")
        const accepted = z.object({ state: z.literal("applied") }).safeParse(flush.result).success
        const cutoff = h.synthValues.get(synthCutoffTarget)
        const dispatches = (h.counts.get("instrument-events") ?? 0) - synthBaseline
        if (!flush.settled || !accepted)
          fail("I3", `Instrument flush did not settle applied: ${flush.settled ? JSON.stringify(flush.result) : "unsettled"} (native cutoff ${cutoff})`, "live", "urgent-instrument-proof")
        else if (cutoff !== flush.value)
          fail("I1", `Native cutoff ${cutoff} differs from the flushed ${flush.value}`, "live", "urgent-instrument-proof")
        if (dispatches !== 1)
          fail("I6", `Unchanged instrument flush across a publication dispatched ${dispatches} urgent batches`, "live", "urgent-instrument-proof")
        record({ witness: mode, flush, dispatches, cutoff })
        return
      }
      ledger.checkRejections()
      if (mode === "b5c-live" || mode === "b5c-structure") {
        if (!retryCounts) throw new Error("Missing B5c before capture");
        checked("I6");
        const counts = { compiles: compileCount - retryCounts.compilations,
          prepares: (h.counts.get("prepare") ?? 0) - retryCounts.prepares,
          publishes: (h.counts.get("publish") ?? 0) - retryCounts.publishes };
        record({ witness: mode, counts });
        const expected = mode === "b5c-structure" ? 1 : 0;
        if (counts.compiles !== expected || counts.publishes !== expected)
          fail("I6", `B5c expected ${expected} compile/publication, observed ${JSON.stringify(counts)}`, "live", "b5c-input-cost");
        return;
      }
      if (a2cChecks(mode, { marks, mark: currentMark, quiescent, checked,
        context: () => {
          const published = h.contextHistory.at(-1)
          return { published: published && { bpm: published.bpm, numerator: published.timeSignatureNumerator,
            denominator: published.timeSignatureDenominator, cycle: published.cycleActive,
            cycleStart: published.cycleActive ? published.cycleStartSec : undefined,
            cycleEnd: published.cycleActive ? published.cycleEndSec : undefined },
          projected: { bpm: bpm(), numerator: meter().numerator, denominator: meter().denominator, cycle: loopEnabled(),
            // The bound the scenario declared, not the signal a planted defect may leave stale.
            cycleStart: loopEnabled() ? 0 : undefined, cycleEnd: loopEnabled() ? declaredLoopEnd : undefined } }
        },
        trace, history: () => ({ canUndo: history.canUndo(), canRedo: history.canRedo() }),
        settled: (name) => waiters.some((waiter) => waiter.name === name && waiter.settled),
        unanswered: (name) => waiters.some((waiter) => waiter.name === name && !waiter.settled),
        refused: (name) => waiters.some((waiter) => waiter.name === name && z.object({ state: z.enum(["refused", "unconfirmed", "unavailable"]) }).safeParse(waiter.result).success),
        applicationsSince: (count) => h.applications.slice(count).map((entry) => ({ gain: entry.content.gain, strategy: entry.strategy })),
        fail: (invariant, detail, failureClass) => fail(invariant, detail, "live", failureClass) })) return
      if (mode === "preview-accepted") {
        // Registration settles from proof or the target's ending domain. A
        // domain move during delivery is superseded/unavailable, not a refusal.
        const preview = waiters.findLast((waiter) => waiter.name === "preview")
        if (!preview?.settled) throw new Error("Preview witness did not settle")
        checked("I7")
        if (!z.object({ state: z.enum(["applied", "superseded", "unavailable"]) }).safeParse(preview.result).success)
          fail("I7", `Preview across a domain move answered ${JSON.stringify(preview.result)}`, "live", "preview-domain-fallback")
        return
      }
      if (mode === "no-processor-timer") {
        checked("I7")
        const allocated = witness.processorTimerAllocations()
        if (allocated) fail("I7", `Processor waits allocated ${allocated} timers`, "live", "processor-wait-timer")
        return
      }
      if (["late-domain", "domain-timeout", "pause-latency", "lease-populated"].includes(mode)) {
        const captured = witness.state()
        if (mode === "pause-latency") {
          checked("I7")
          const statuses = waiters.filter((waiter) => waiter.name === "witness-inspect")
            .map((waiter) => z.object({ revision: z.object({ status: z.string() }) }).safeParse(waiter.result))
          if (!witness.pauseCompletions() || statuses.length !== 2
            || !statuses[0]?.success || statuses[0].data.revision.status !== "publish-pending"
            || !statuses[1]?.success || statuses[1].data.revision.status === "publish-pending")
            fail("I7", "Pause did not complete pending native latency transition with Inspect proof", "ending-transport-domain", "pause-latency-completion")
        } else if (mode === "lease-populated") {
          checked("I5")
          if (!populatedOwnershipChecks || !h.leases.size) throw new Error("Lease witness has no populated ownership")
          record({ witness: mode, populatedOwnershipChecks, leases: [...h.leases] })
        } else {
          checked("I7")
          const old = waiters.filter((waiter) => captured.waiterIds.includes(waiter.id))
          if (!old.length) throw new Error("Domain witness has no captured waiter")
          if (old.some((waiter) => !waiter.settled))
            fail("I7", "Ending domain did not settle captured waiters", "ending-transport-domain", "late-reply-domain")
          const timedOut = old.some((waiter) => {
            const result = z.object({ reason: z.string().optional(), error: z.string().optional() }).safeParse(waiter.result)
            return result.success && (result.data.reason === "bridge-error" || result.data.error?.includes("timeout"))
          })
          if (timedOut) fail("I7", "Domain end reported as timeout/bridge-error", "ending-transport-domain", "domain-end-timeout")
          if (captured.processorTimers || witness.processorTimerAllocations())
            fail("I7", "Processor waiter required or allocated a timer", "ending-transport-domain", "processor-wait-timer")
          // A flush live control cancelled is handled: the panel reports nothing and keeps the draft.
          if (panelErrors) fail("I10", "The panel reported an error for a flush that live control cancelled", "ending-transport-domain", "cancelled-draft-persistence")
          if (mode === "late-domain" && knob() !== captured.gain)
            fail("I10", "Late domain reply changed the preserved knob", "ending-transport-domain", "cancelled-draft-persistence")
          record({ witness: mode, captured, old, knob: knob(), applications: h.applications.slice(captured.applied) })
        }
        return
      }      if (mode === "terminal") {
        checked("I7")
        if (endingDomainFailure(waiters, h.domain)) fail("I7", "Old-domain controller waiter survives terminal action")
        return
      }
      if (mode === "quiescent" || mode === "identical") {
        if (mode === "identical" && (compilations.length || h.pendingControl || waiters.some((waiter) => !waiter.settled)))
          throw new Error("Identical-input witness is not quiescent")
        checked("I6")
        const quiet = quiescenceFailure(frozenCounts, JSON.stringify(Object.fromEntries(h.counts)))
        if (quiet || mode === "identical" && frozenCompilations !== compileCount)
          fail("I6", quiet ?? "Identical projected input restarted compilation", "live",
            mode === "identical" ? "noop-adoption-churn" : undefined)
        return
      }
      if (mode === "panel-newer" || mode === "panel-cancel") {
        if (persistenceFailures === 0) throw new Error("Panel witness never failed a real save")
        if (h.pendingControl || compilations.length || waiters.some((waiter) => !waiter.settled))
          throw new Error("Panel witness has unresolved scheduler dependencies")
        checked("I10")
        const expected = mode === "panel-newer" ? -13 : -11
        if (knob() !== expected || h.nativeFields(h.active).gain !== expected)
          fail("I10", `${mode}: newer/current canonical value ${expected} lost to captured rollback`,
            "live", "panel-save-cancel-ownership")
        record({ witness: mode, expected, knob: knob(), actual: h.nativeFields(h.active) })
        return
      }
      if (mode === "gesture-closed") {
        if (!identityBaseline) throw new Error("Gesture witness has no baseline")
        if (h.pendingControl || waiters.some((waiter) => !waiter.settled)) throw new Error("Gesture witness has unsettled dispatch")
        const dispatches = (h.counts.get("parameters") ?? 0) - identityBaseline.dispatches
        checked("I6")
        // One dispatch per preview: the four previews each changed one field.
        if (dispatches !== 4) fail("I6", `${mode}: gesture of four previews allocated ${dispatches} dispatches`, "live", "gesture-end-redispatch")
        record({ witness: mode, dispatches })
        return
      }
      if (mode === "identity-same" || mode === "identity-changed") {
        if (!identityBaseline) throw new Error("Identity witness has no baseline")
        if (h.pendingControl || waiters.some((waiter) => !waiter.settled))
          throw new Error("Identity witness has unsettled dispatch")
        const dispatches = (h.counts.get("parameters") ?? 0) - identityBaseline.dispatches
        checked("I6")
        // identity-same re-dispatches because a publication lands between preview and flush (B3a-i rebinding).
        if (dispatches !== (mode === "identity-changed" ? 1 : 0))
          fail("I6", `${mode}: terminal gesture allocated ${dispatches} additional dispatches`, "live",
            mode === "identity-same" ? "restamp-timeout" : "edit-identity")
        record({ witness: mode, identityBaseline, dispatches, nativeSequence: h.lastParameterSequence })
      }
      if (mode === "retry-budget") {
        if (!retryCounts) throw new Error("Retry witness missing blocked-attempt capture")
        const patches = h.applications.filter((entry) => entry.strategy === "patch").length - retryCounts.patches
        if (patches !== 25 || h.deliveredProgressSequence <= retryCounts.progress)
          throw new Error("Retry witness requires 25 applied cheap patch ACKs and newer progress")
        if (h.pendingControl || compilations.length || waiters.some((waiter) => !waiter.settled))
          throw new Error("Retry witness has unresolved scheduler dependencies")
        checked("I6")
        if (retryCounts.compilations !== compileCount || retryCounts.prepares !== (h.counts.get("prepare") ?? 0))
          fail("I6", "Cheap ACK reopened blocked hook adoption budget", "live", "cheap-ack-retry-churn")
        record({ witness: mode, patches, before: retryCounts, after: { prepares: h.counts.get("prepare") ?? 0, compilations: compileCount } })
        return
      }
      if (mode === "explicit-retry" || mode === "capacity-reopen") {
        if (!retryCounts) throw new Error("Reopening witness missing blocked-attempt capture")
        if (h.pendingControl || compilations.length || waiters.some((waiter) => !waiter.settled))
          throw new Error("Reopening witness has unresolved scheduler dependencies")
        checked("I6")
        // One reopening fact (an explicit request, or native reporting more capacity) buys exactly one attempt of the retained candidate.
        const attempts = (h.counts.get("prepare") ?? 0) - retryCounts.prepares
        if (attempts !== 1 || compileCount !== retryCounts.compilations)
          fail("I6", `${mode}: ${attempts} native attempts and ${compileCount - retryCounts.compilations} recompilations after one reopening fact`,
            "live", mode === "explicit-retry" ? "explicit-retry-lost" : "capacity-wake-lost")
        record({ witness: mode, before: retryCounts, after: { prepares: h.counts.get("prepare") ?? 0, compilations: compileCount } })
        return
      }
      if (mode === "page-quiet") {
        const prepares = h.counts.get("prepare") ?? 0
        record({ witness: mode, prepares, atRetry: retryCounts?.prepares })
        return
      }
      if (mode === "page-held" || mode === "page-released") {
        // The recovery attempt of the parked schedule is inside its mapped-page write: the one page completion native owes.
        const held = marks.get("page-hold")
        if (!held || !retryCounts) throw new Error(`${mode} witness has no page-hold mark`)
        checked("I1"); checked("I4"); checked("I5")
        const pages = h.counts.get("asset-page") ?? 0
        if (mode === "page-held") {
          if (held.value !== 1) {
            fail("I6", "Clip capacity returning never started the parked schedule's attempt", "live", "parked-wake")
            return
          }
          heldPages = pages
          record({ witness: mode, pages, leases: [...h.leases] })
          // The candidate's leases stand until native answers the page: one released now was released early.
          if (!h.leases.size || [...h.leases.values()].some((lease) => lease.releases >= lease.acquisitions))
            fail("I5", "A lease of the parked schedule's candidate was released while its mapped page was in flight", "live", "parked-wake")
          return
        }
        if (!quiescent()) throw new Error("page-released witness has unresolved scheduler dependencies")
        const submitted = h.active && h.submittedGraphs.get(h.active.revision)
        if (!submitted) throw new Error("Missing independent graph bytes")
        const reached = !convergenceFailure(h.nativeFields(h.active), desired) && !topologyFailure(fields(decodeGraph(submitted)), desired)
        const attempts = (h.counts.get("asset") ?? 0) - retryCounts.assets
        const compiles = compileCount - retryCounts.compilations
        record({ witness: mode, pages, attempts, compiles, reached, leases: [...h.leases] })
        // The latency asked for during the held page reaches native once the attempt settled: nothing woke it before.
        if (!reached || waiters.some((waiter) => !waiter.settled && waiter.name === "latency"))
          fail("I4", "A latency change asked for while the parked schedule's attempt was held never reached native", "live", "latency-starvation")
        // One wake: the held attempt reused the retained candidate (no compile of its own); the FFT asked for during it is
        // one newer intent, compiled once and published once, with one page write of its own after the held attempt's.
        else if (heldPages === undefined || pages !== heldPages + 1 || attempts !== 1 || compiles !== 1 || h.activeBank.sourceHistory.size === 0)
          fail("I6", `The parked schedule's recovery held ${heldPages} mapped page write(s) and ended with ${pages} (expected one more for the newer intent), over ${attempts} attempt(s) and ${compiles} compile(s)`, "live", "parked-wake")
        checkOwnership()
        return
      }
      if (mode === "parked-settled" || mode === "parked-recovered") {
        // A capacity-blocked adoption holds a compiled candidate while the panel changes the spectral FFT. `parked-settled`:
        // the change reaches native at unchanged clip capacity (no pause, seek or loss), after native had independent
        // opportunities, and buys neither an attempt nor a compile of the parked schedule. `parked-recovered`: the returned
        // capacity bought exactly one attempt and one compile (the retained candidate belonged to the intent before the
        // edit), which published the clip over the latest FFT and PDC and left every lease balanced.
        if (!retryCounts) throw new Error(`${mode} witness missing blocked-attempt capture`)
        checked("I1"); checked("I4"); checked("I6")
        const attempts = (h.counts.get("asset") ?? 0) - retryCounts.assets
        const compiles = compileCount - retryCounts.compilations
        const submitted = h.active && h.submittedGraphs.get(h.active.revision)
        if (!submitted) throw new Error("Missing independent graph bytes")
        const reached = !convergenceFailure(h.nativeFields(h.active), desired) && !topologyFailure(fields(decodeGraph(submitted)), desired)
        if (h.lost || h.domain > 0 || disposed) throw new Error(`${mode} witness after the transport domain ended`)
        if (mode === "parked-settled") {
          if (!h.blockAsset || h.activeBank.sourceHistory.size > 0 || h.deliveredProgressSequence <= retryCounts.progress + 24n)
            throw new Error("Invalid parked-settled witness: not parked at unchanged clip capacity for 25 progress frames")
          record({ witness: mode, reached, attempts, compiles, actual: h.nativeFields(h.active), waiters: waiters.filter((waiter) => !waiter.settled).map((waiter) => waiter.name) })
          if (!reached || waiters.some((waiter) => !waiter.settled && waiter.name === "latency"))
            fail("I4", "Parked latency did not settle without pause, seek, loss or clip-capacity recovery", "live", "latency-starvation")
          // A processor edit is not a key part of the publication: the standing refusal answers it.
          else if (attempts !== 0 || compiles !== 0)
            fail("I6", `A latency change attempted the parked schedule ${attempts} time(s) over ${compiles} compile(s) with no clip capacity returned`, "live", "parked-wake")
          return
        }
        if (h.blockAsset) throw new Error("Invalid parked-recovered witness without returned clip capacity")
        record({ witness: mode, reached, attempts, compiles, actual: h.nativeFields(h.active) })
        const installed = h.activeBank.sourceHistory.size > 0
        if (attempts !== 1 || compiles !== 1 || !installed)
          fail("I6", `Clip capacity returning bought ${attempts} attempt(s) and ${compiles} compile(s) of the parked schedule, native ${installed ? "published" : "did not publish"} it`, "live", "parked-wake")
        else if (!reached)
          fail("I1", "The recovered schedule did not carry the latest latency", "live", "parked-rebase-stale")
        return
      }
      if (mode === "progress-only") {
        if (!retryCounts) throw new Error("Progress witness missing blocked-attempt capture")
        if (h.deliveredProgressSequence <= retryCounts.progress + 24n)
          throw new Error("Progress witness requires 25 newer progress frames")
        checked("I6")
        if (retryCounts.compilations !== compileCount || retryCounts.prepares !== (h.counts.get("prepare") ?? 0))
          fail("I6", "Ordinary progress reopened a blocked adoption attempt", "live", "cheap-ack-retry-churn")
        else if (h.pendingControl || compilations.length || waiters.some((waiter) => !waiter.settled))
          throw new Error("Progress witness has unresolved scheduler dependencies")
        record({ witness: mode, before: retryCounts, after: { prepares: h.counts.get("prepare") ?? 0, compilations: compileCount } })
        return
      }
      if (["context-compiled", "context-inflight", "aba-final", "aba-waiting", "edits-compiles", "seek-retained"].includes(mode)) {
        if (!retryCounts) throw new Error(`${mode} witness missing capture`)
        if (h.pendingControl || compilations.length || waiters.some((waiter) => !waiter.settled))
          throw new Error(`${mode} witness has unresolved scheduler dependencies`)
        checked("I1")
        const starts = new Set([...h.activeBank.sourceHistory.values()].map((source) => source.start))
        const compiles = compileCount - retryCounts.compilations
        const publishes = (h.counts.get("publish") ?? 0) - retryCounts.publishes
        if (mode === "context-compiled" && (compiles !== 1 || publishes !== 1 || compileOverrides.at(-1) !== "parallel"))
          fail("I1", `An explicit restart changing only the compile context made ${compiles} compiles and ${publishes} publications (override ${compileOverrides.at(-1)})`,
            "live", "context-restart-lost")
        // The held compile of the plain context and then one of the override: joining them loses the override.
        // The override is what native already holds, so the held plain compile, superseded by an intent of another context,
        // publishes nothing, not even transiently, and the override's compile finds nothing to change.
        if (mode === "context-inflight" && (compiles !== 2 || publishes !== 0 || compileOverrides.at(-1) !== "parallel"))
          fail("I1", `A restart changing only the compile context, asked for during a held compile, made ${compiles} compiles and ${publishes} publications (override ${compileOverrides.at(-1)})`,
            "live", "context-restart-lost")
        // What native holds is the override's compile, read from the published graph's master gain (the fixture's model of
        // the context): neither phase may leave the plain 1.0 live.
        if ((mode === "context-compiled" || mode === "context-inflight") && masterGainOf(h.active) !== Math.fround(0.5))
          fail("I1", `The override's master volume 0.5 is not what native holds after ${mode} (${masterGainOf(h.active)})`, "live", "context-restart-lost")
        // B waited behind the compiling A and the edit went back to A: A alone is compiled and published (a compile reads
        // the state of the moment, so the count, not the content, shows B's).
        if (mode === "aba-waiting" && (compiles !== 1 || publishes !== 1 || !starts.has(24_000n)))
          fail("I1", `An edit back to the compiling intent left the intent waiting behind it compiled (${compiles} compiles, ${publishes} publications, sources ${[...starts]})`,
            "live", "stale-intent-published")
        // The edit back to the adopted content is unchanged, so nothing publishes; any publication is the superseded 0.5 s intent.
        if (mode === "aba-final" && (publishes !== 0 || !starts.has(12_000n)))
          fail("I1", "An edit back to the adopted content left the superseded intent's compile published", "live", "stale-intent-published")
        // The held compile plus exactly one for the latest of the edits made while it was held.
        if (mode === "edits-compiles" && (compiles !== 2 || !starts.has(24_000n)))
          fail("I6", `${compiles} compiles for the edits made during one held compile (expected the held one plus one)`, "live", "compile-churn")
        // The capacity fact after the seek reopens the blocked attempt once, compiled for the new domain: the old domain's
        // candidate is disposed (0 compiles with a publication is the stale reuse, 0 with none is a lost wake).
        if (mode === "seek-retained" && (compiles !== 1 || publishes !== 1))
          fail("I1", `A candidate retained across a seek was reused or lost (${compiles} compiles, ${publishes} publications)`, "live", "retained-domain-stale")
        record({ witness: mode, master: masterGainOf(h.active), compiles, publishes, prepares: (h.counts.get("prepare") ?? 0) - retryCounts.prepares, starts: [...starts], overrides: compileOverrides })
        return
      }
      if (mode === "retained-final") {
        checked("I1")
        const starts = new Set([...h.activeBank.sourceHistory.values()].map((source) => source.start))
        // 0.5 s is the retained candidate's clip, superseded by the 0.25 s edit before native ever had capacity.
        if (starts.has(24_000n) || !starts.has(12_000n))
          fail("I1", `Capacity-blocked adoption published ${starts.has(24_000n) ? "the superseded retained candidate" : "no candidate"} after reopening`,
            "live", starts.has(24_000n) ? "retained-candidate-stale" : "capacity-wake-lost")
        record({ witness: mode, starts: [...starts] })
        return
      }
      if (mode === "context") {
        const last = capturedSnapshots.at(-1)
        if (!last || last.bpm !== bpm() || last.numerator !== meter().numerator || last.loop !== loopEnabled())
          throw new Error(`Context witness did not compile tempo/meter/loop projection (compiled ${JSON.stringify(last)}, projected ${bpm()}/${meter().numerator}/${loopEnabled()})`)
        record({ witness: mode, captured: last })
        checked("I1")
        const context = h.contextHistory.at(-1)
        if (context?.bpm !== bpm() || context.timeSignatureNumerator !== meter().numerator
          || context.timeSignatureDenominator !== meter().denominator || context.cycleActive !== loopEnabled())
          fail("I1", "Published native musical context differs from projection", "live", "stale-compile")
      }
      if (mode === "adoption") {
        checked("I1")
        if (knob() !== -11 || h.nativeFields(h.active).gain !== -11)
          fail("I1", "External projected value did not reach panel/native", "live", "retained-override")
        record({ witness: mode, knob: knob(), actual: h.nativeFields(h.active) })
      }
      if (bankChecks(mode, { h, marks, mark: currentMark, quiescent, checked, fail, record,
        populatedOwnershipChecks: () => populatedOwnershipChecks })) return
      if (mode === "stale-released") {
        if (stalePrepareCount === undefined) throw new Error("No stale compile capture")
        checked("I1")
        if ((h.counts.get("prepare") ?? 0) !== stalePrepareCount)
          fail("I1", "Superseded compile reached native prepare", "live", "stale-compile")
        record({ witness: mode, prepareCount: h.counts.get("prepare") ?? 0 })
        return
      }
      if (mode === "stale-final") {
        checked("I1")
        if (![...h.activeBank.sourceHistory.values()].some((source) => source.start === 12_000n))
          fail("I1", "Stale compile replaced latest clip timing", "live", "stale-compile")
        record({ witness: mode, sourceHistory: [...h.activeBank.sourceHistory] })
      }
      if (mode === "starvation") {
        if (!starvationResult) throw new Error("Missing starvation interval")
        starvationResult.resumedFrames = h.activeBank.through - h.frame
        record({ witness: mode, ...starvationResult })
      }
      checked("I1"); checked("I4")
      const actual = h.nativeFields(h.active)
      if (playback.isNativePlaybackPrepared()
        && (desired.utilityPresent ? convergenceFailure(actual, desired) : actual.gain !== null || actual.fft !== desired.fft))
        fail("I1", "Native differs from desired", "live", "retained-override")
      const submitted = h.active && h.submittedGraphs.get(h.active.revision)
      if (submitted && topologyFailure(fields(decodeGraph(submitted)), desired))
        fail("I1", "Fixed parallel topology latency/PDC differs from desired FFT", "live", "latency-starvation")
      if (settlementFailure(waiters.some((waiter) => !waiter.settled) || playback.isPreparingPlayback()
        || playback.isStructuralRebuildInProgress()))
        fail("I4", "Unsettled controller request at logical drain bound", waiters.some((waiter) => !waiter.settled
          && (waiter.domain !== h.domain || waiter.name === "pause" || waiter.name === "seek")) ? "ending-transport-domain" : "live")
    }
    return {
      act, enabled, check, observe, checkpoint, failures, time,
      state: () => ({ desired: { ...desired }, actual: h.nativeFields(h.active), knob: knob(), activeRevision: h.active?.revision,
        playing: playback.isPlaying(), running: h.running, preparing: playback.isPreparingPlayback(),
        frame: h.frame, counts: Object.fromEntries(h.counts), checks: Object.fromEntries(checks), waiters,
        rejections: ledger.rejectionClasses, assets: [...h.assets],
        pendingControl: h.pendingControl && { id: h.pendingControl.id, name: h.pendingControl.name },
        starvation: starvationResult, contextHistory: h.contextHistory, latencyPending: h.latencyReadyEpoch !== undefined,
        publicationPending: h.publicationPending, replies: h.replies.map(({ id, name }) => ({ id, name })),
        compilationIds: compilations.map(({ id }) => id), capturedSnapshots,
        coverageFrames: h.activeBank.through - h.frame,
        metrics: { minimumCoverageBlocks, populatedOwnershipChecks, compileCount }, lifecycleReady: bridge.lifecycle.isReady(),
        history: { canUndo: history.canUndo(), canRedo: history.canRedo(), failures: historyFailures },
        effectTransactions: time.effectTransactions(), trace, persistenceFailures, mutation, timerFires,
        prepared: playback.isNativePlaybackPrepared(),
        bankSources: [...h.activeBank.sources.keys()],
        effectWrites: { started: time.effectWrites(), nextFailure: time.nextFailureOrdinal() }, persistedGain, rebuilds,
        marks: Object.fromEntries(marks) }),
      idle: quiescent,
      commandName: (id: number | undefined) => h.commands.find((command) => command.id === id)?.name,
      replyName: (id: number | undefined) => h.replies.find((reply) => reply.id === id)?.name,
      needsReclaim: () => h.reclaimable(),
      async cleanup() {
        try {
          if (!disposed) { panelDispose(); dispose() }
          disposeHistory()
          h.lose(); h.endLeases()
          await drainIdb()
          if (sentinel.fired()) fail("time-ownership", "Real macrotask sentinel fired during seed", "harness")
        } finally {
          sentinel.clear()
          time.restore()
          for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor)
            else Reflect.deleteProperty(globalThis, name)
          }
        }
      },
    }
  } catch (error) {
    panelDispose(); dispose()
    sentinel.clear(); time.restore()
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    throw error
  }
  function checkOwnership() {
    // Host callbacks can run during initial installation, before roots exist.
    checked("I5")
    if (h.leases.size) populatedOwnershipChecks++
    // A1 retains historical banks after Teardown. Only extant native graphs
    // own readers in the hook's multi-install lifetime.
    for (const detail of ownershipFailures(h.leases, h.assets,
      [h.active ? h.activeBank : undefined, h.prepared ? h.preparedBank : undefined, h.retired ? h.retiredBank : undefined])) fail("I5", detail)
  }
}
