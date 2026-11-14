import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { z } from "zod"
import createControllerFixture, { generatorVersion } from "./ae-08-processor-state-fuzz-fixture"
import type { Action } from "./ae-08-processor-state-fuzz-host"
import { controllerClassTable, classifyFailure, gateSteps } from "./ae-08-processor-state-fuzz-classes"
import type { Defect, Failure } from "./ae-08-processor-state-fuzz-oracle"
import createSeedTrace, { traceSchema, type SeedTrace, type Trace } from "./ae-08-processor-state-fuzz-trace"
import { createVirtualTime, isProcessorWaitTimer } from "./ae-08-processor-state-fuzz-virtual-time"
import browserReceipts from "./ae-08-processor-state-fuzz-browser"
import unavailableSession from "./ae-08-processor-state-fuzz-unavailable"
import { endingDomainFailure } from "./ae-08-processor-state-fuzz-oracle"

// Keep all A1 construction, scheduler policy and output bytes untouched.
if (process.argv.some((value, index) => value === "--fixture" && process.argv[index + 1] === "hook")) {
  const { default: runHookCampaign } = await import("./ae-08-processor-state-fuzz-hook-runner")
  await runHookCampaign()
  process.exit(process.exitCode ?? 0)
}

const root = path.resolve(import.meta.dir, "../..")
const reportRoot = path.join(root, "acceptance-reports/ae-08-phase-5-2026-10-18/fuzz")
const stringify = <Value>(value: Value, space?: number) => JSON.stringify(value,
  (_key, field) => {
    const parsed = z.bigint().safeParse(field)
    return parsed.success ? parsed.data.toString() : field
  }, space)
const writeJson = <Value>(file: string, value: Value) => writeFileSync(file, `${stringify(value, 2)}\n`)
const hash = (file: string) => createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex")
const defectSchema = z.enum(["stale-overwrite", "false-receipt", "early-release", "noop-churn", "drop-batch", "false-rejection", "lost-edit", "swallow-waiter", "never-wake-latency", "underfill", "force-rebuild", "false-urgent-receipt", "cancel-retained", "post-recovery-overwrite"])
const actionSchema = z.object({ kind: z.string(), id: z.number().optional(), scope: z.number().optional(), value: z.number().optional(),
  second: z.number().optional(), sequence: z.number().optional(), mode: z.string().optional() })
const replaySchema = z.object({ seed: z.number(), plant: defectSchema.optional(), unfairHost: z.boolean().optional(), actions: z.array(actionSchema) })
type Options = { seed: number; seeds: number; steps: number; drainSteps: number; out: string; plant?: Defect; replay?: string; scenario?: string; unfairHost?: boolean; gate?: string; trace: Trace }
const options: Options = { seed: 1, seeds: 100, steps: 2000, drainSteps: 1000, out: path.join(reportRoot, "baseline-a1"), trace: "failures" }
const numeric = z.coerce.number().int().positive().safe()
// B3a-ii witnesses: a state patch racing a gesture's override, and a refused dispatch of still-desired content.
const patchScenarios = ["patch-install", "patch-install-late-proof", "patch-first", "patch-negative", "patch-race-before-claim", "patch-race-split",
  "patch-claimed-newest", "patch-installed", "attempt-identity", "refused-resend", "refused-preview",
  "patch-prepared-override", "patch-prepared-pending", "patch-refused-settled", "rebound-credit", "rebound-applied-rejected", "joined-flush-credit", "patch-projected-timing"]
// B3b witnesses: what an ended domain owes its waiters, and the timers a processor wait may not allocate.
const endingScenarios = ["pause-refused-pending", "seek-refused-pending", "rapid-seek", "send-straddles-pause", "two-registry-frame", "browser-flush-pause", "urgent-pause", "processor-timer", "late-inspect",
  "flush-no-bridge", "flush-unprepared", "flush-after-dispose", "flush-after-loss", "terminal-classifier", "compile-domain-end", "abort-no-block", "resume-structure"]
// B4a witnesses: what an adoption owes a cancelled, joined, waiting or refused intent.
const adoptionScenarios = ["adoption-cancel", "adoption-aba", "adoption-context", "adoption-refusal-context", "adoption-refusal-key",
  "adoption-explicit-upgrade", "content-rejection", "content-rejection-explicit",
  "publication-cancel-unclaimed", "publication-cancel-staged", "publication-cancel-queued", "publication-cancel-claimed", "publication-cancel-handoff"]
// B4b witnesses: what a schedule native refused for clip capacity (parked) owes the latency changed meanwhile, and what the
// capacity returning owes it.
const parkedScenarios = ["parked-latency", "parked-rebase", "parked-hold", "hold-dispose", "parked-owner", "leases-invalid", "leases-valid"]
// B5a witnesses: what a publication native holds owes its caller and its resources when a pause or seek ends the attempt.
const publicationScenarios = ["deferred-outcome-pause", "deferred-outcome-seek", "deferred-outcome-pause-late", "deferred-outcome-seek-late",
  "deferred-outcome-pause-deferred", "deferred-outcome-seek-deferred", "deferred-outcome-pause-unclaimed", "publish-reply-lost",
  "inspect-reply-lost", "rollback-reply-lost", "reclaim-held-by-retirement"]
// Scenarios whose clip is a Stretch clip: the candidate then holds real artifact leases while it is parked.
const stretchScenarios = ["leases-invalid", "leases-valid"]
// Microtask turns after the publication's proof at which `publication-cancel-handoff` drops; `handoff-coverage` checks they reach past the settlement.
const handoffSweep = 24
// Staged VST3 attachments the host fake owns: a lost join, and an undo during startup.
const attachmentScenarios = ["attachment-join-lost", "attachment-undo-startup"]
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  if (key === "--unfair-host") { options.unfairHost = true; index--; continue }
  const value = process.argv[index + 1]
  if (!value) throw new Error(`Missing value for ${key}`)
  if (key === "--seed") options.seed = numeric.parse(value)
  else if (key === "--seeds") options.seeds = numeric.parse(value)
  else if (key === "--steps") options.steps = numeric.parse(value)
  else if (key === "--drain-steps") options.drainSteps = numeric.parse(value)
  else if (key === "--out") options.out = path.resolve(value)
  else if (key === "--plant") options.plant = defectSchema.parse(value)
  else if (key === "--replay") options.replay = path.resolve(value)
  else if (key === "--gate") options.gate = value
  else if (key === "--trace") options.trace = traceSchema.parse(value)
  else if (key === "--scenario" && ["pause-latency", "paused-flush", "attachment", "transport-mismatch", "graph-cache", "host-boundary", "transport-refusal", "prefix-11", "prefix-12", "identity-same", "identity-changed", "ledger-inclusion", "ledger-incarnation", "reenable-automation", "instrument-urgent", "urgent-epoch-drop", "held-urgent-note", "retained-drift", "reconcile-seek", "reconcile-inflight", "reconcile-first", "parameter-preack-epoch", "parameter-epoch-drop", "future-epoch-drop", "unsent-second-domain", "retained-instrument", "retained-override-instrument", "restated-override", "restated-inflight", "restated-queued", "two-rejections", "overlapping-flushes", "synth-replaced", "rollback-values", ...attachmentScenarios, ...endingScenarios, ...patchScenarios, ...adoptionScenarios, ...parkedScenarios, ...publicationScenarios].includes(value)) options.scenario = value
  else if (key !== "--fixture" || value !== "controller") throw new Error(`Unknown argument ${key} ${value}`)
}
// A host-model plant corrupts the fake host under a fixed schedule rather than wrapping a request.
if (options.plant === "cancel-retained") options.scenario = "retained-drift"
if (options.plant === "post-recovery-overwrite") options.scenario = "restated-inflight"
const randomFor = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value)
    return ((value ^ value >>> 14) >>> 0) / 0x100000000
  }
}
const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const classTable = controllerClassTable
// Scenarios that drive registry-allocated gestures against history-style desired content.
const historyScenarios = ["reconcile-seek", "reconcile-inflight", "reconcile-first", "parameter-preack-epoch", "parameter-epoch-drop", "future-epoch-drop", "unsent-second-domain", "retained-instrument", "retained-override-instrument", "restated-override", "restated-inflight", "restated-queued", "two-rejections", "overlapping-flushes", "refused-resend"]
// Scenarios that count the timers processor waits allocate, which only a virtual clock can see.
const virtualTimeScenarios = ["processor-timer", "two-registry-frame"]
const instrumentScenarios = ["urgent-pause", "instrument-urgent", "urgent-epoch-drop", "held-urgent-note", "unsent-second-domain", "synth-replaced", "retained-instrument", "retained-override-instrument", "two-rejections", "overlapping-flushes"]
const failureClass = (failure: Failure) => classifyFailure(failure).class ?? "unclassified"
const sourceFiles = [
  "src/lib/desktop/native-playback-controller.ts", "src/lib/desktop/native-schedule-coordinator.ts",
  "src/lib/desktop/native-processor-state-owner.ts", "src/lib/desktop/native-built-in-parameter-mapper.ts",
  "src/lib/live-processor-control.ts", "src/components/timeline/create-processor-edit-registry.ts",
  "src/lib/live-playback-snapshot.ts", "packages/audio-engine/src/native-host-wire.ts",
  "apps/desktop/audio-host.ts", "native/audio-host-macos/src/audio-host.cpp",
  "tools/acceptance/ae-08-processor-state-fuzz-host.ts", "tools/acceptance/ae-08-processor-state-fuzz-oracle.ts",
  "tools/acceptance/ae-08-processor-state-fuzz.ts", "tools/acceptance/ae-08-processor-state-fuzz-fixture.ts",
  "tools/acceptance/ae-08-processor-state-fuzz-trace.ts", "tools/acceptance/ae-08-processor-state-fuzz-classes.ts", "tools/acceptance/ae-08-processor-state-fuzz-edit.ts",
]
const sourceHashes = Object.fromEntries(sourceFiles.map((file) => [file, hash(file)]))
type Run = Awaited<ReturnType<typeof runSeed>>

async function runSeed(seed: number, plant: Defect | undefined, trace?: SeedTrace, replay?: readonly Action[], pruneDependencies = false) {
  let yielded = false
  // Acceptance-only sentinel detects an unowned real macrotask yield. It never
  // drives host progress; deterministic scheduler actions are the sole clock.
  // The Stretch lease scenarios run a real IndexedDB store, whose requests complete on macrotasks they await in `storage`.
  const sentinel = stretchScenarios.includes(options.scenario ?? "") ? undefined : setTimeout(() => { yielded = true }, 0)
  // Only the timer-counting checks need a clock, installed from the actions that read it as fixture modes are.
  let clock: ReturnType<typeof createVirtualTime> | undefined
  try {
  let step = 0
  const actions: Action[] = []
  // A plant that corrupts the fake host under a fixed scenario instead of wrapping a request.
  const scenarioPlant = plant === "cancel-retained" || plant === "post-recovery-overwrite"
  const failuresAt: (Failure & { step: number })[] = []
  const divergentStates: { step: number; state: ReturnType<ReturnType<typeof createControllerFixture>["state"]> }[] = []
  const checks = new Map<string, number>()
  const record = <Value>(event: Value) => {
    trace?.record(`${stringify({ step, event })}\n`)
  }
  if (replay ? replay.some((action) => action.kind === "check" && action.mode === "no-processor-timer") : virtualTimeScenarios.includes(options.scenario ?? "")) {
    clock = createVirtualTime(record); clock.install()
  }
  if (stretchScenarios.includes(options.scenario ?? "")) {
    // The virtual-time module has already installed fake IndexedDB. One process holds every lock, so a named lock is granted at once.
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { ...globalThis.navigator,
      locks: { request: async <Value>(name: string, _options: { ifAvailable?: boolean; mode?: "shared" | "exclusive" }, callback: (lock: { name: string }) => Promise<Value>) => callback({ name }) } } })
  }
  let fixture = createControllerFixture(record, plant, replay !== undefined, options.unfairHost,
    options.scenario === "attachment" || options.scenario === "parked-rebase" || options.scenario === "leases-invalid" || replay?.some((action) => action.kind === "attachment-setup"),
    options.scenario === "ledger-incarnation" || options.scenario === "rollback-values" || (!replay && options.scenario === "joined-flush-credit") || replay?.some((action) => action.kind === "registry-setup"),
    instrumentScenarios.includes(options.scenario ?? "") || plant === "false-urgent-receipt" || replay?.some((action) => action.kind === "instrument-setup"),
    historyScenarios.includes(options.scenario ?? "") || replay?.some((action) => action.kind === "history-setup"),
    ["retained-instrument", "retained-override-instrument", "two-rejections", "overlapping-flushes"].includes(options.scenario ?? ""),
    stretchScenarios.includes(options.scenario ?? ""))
  const archivedMetrics: ReturnType<typeof fixture.state>["metrics"][] = []
  const archivedRejections: ReturnType<typeof fixture.state>["rejectionClasses"] = []
  let beforeCleanup: ReturnType<typeof fixture.state> | undefined
  let draining: { bound: number; steps: number } | undefined
  const act = async (action: Action) => {
    action = { ...action, scope: action.scope ?? step + 1 }
    actions.push(action); step++
    fixture.setActionScope(action.scope ?? step)
    if (action.kind === "drain-begin") {
      if (draining || !action.value || action.value > options.drainSteps) throw new Error("Invalid fair drain bound")
      draining = { bound: action.value, steps: 0 }
      if (action.sequence === undefined) throw new Error("Fair drain missing scheduler cursor")
      turn = action.sequence
      fixture.invalidateDrain()
    } else if (action.kind === "drain-end") {
      if (!draining || draining.steps > draining.bound
        || (draining.steps < draining.bound
          && (fixture.needsReclaim() || fixture.enabled().some((entry) => !["revision-deadline", "control-watchdog"].includes(entry.kind)))
          && (fixture.pending().length || fixture.nativeWork() || fixture.enabled().some((entry) => entry.id !== undefined))))
        throw new Error("Invalid incomplete fair drain")
      fixture.finishDrain(draining.steps, draining.bound, draining.steps === draining.bound)
      draining = undefined
    } else if (action.kind === "reset-fixture") {
      record({ event: "reset-fixture", previous: fixture.state() })
      archivedMetrics.push(fixture.state().metrics)
      archivedRejections.push(...fixture.state().rejectionClasses)
      for (const [invariant, count] of Object.entries(fixture.state().checks))
        checks.set(invariant, (checks.get(invariant) ?? 0) + count)
      fixture = createControllerFixture(record, plant, replay !== undefined, options.unfairHost)
    } else {
      if (action.kind === "loss") beforeCleanup = structuredClone(fixture.state())
      if (draining) {
        if (replay) {
          const expected = fairAction()
          if (!expected || expected.kind !== action.kind || expected.id !== action.id)
            throw new Error("Dependency-invalid unfair replay drain")
        }
        draining.steps++
      } else if (action.kind !== "check") fixture.invalidateDrain()
      fixture.act(action)
    }
    await fixture.checkpoint()
    fixture.observe()
    for (const failure of fixture.failures) {
      if (!failuresAt.some((entry) => entry.invariant === failure.invariant && entry.detail === failure.detail)) {
        failuresAt.push({ step, ...classifyFailure(failure), class: failureClass(failure) })
        divergentStates.push({ step, state: structuredClone(fixture.state()) })
      }
    }
  }
  // Finite scheduler policy. Every host action is explicit and traced. Promise
  // checkpoints never drive native work. Playback is frozen after settlement.
  let turn = 0
  // Frames rendered meanwhile stay in the host's IPC: a scenario holds them back to order a proof late.
  let progressWithheld = false
  const fairAction = (): Action | undefined => {
    const enabled = fixture.enabled()
    const queued = enabled.filter((action) => !["render-block", "render-open", "render-close", "deliver-progress", "revision-deadline", "control-watchdog"].includes(action.kind))
    if (queued.length > 0) return queued[0]
    if (fixture.needsReclaim()) return { kind: "reclaim" }
    const action = progressWithheld || turn++ % 2 === 0 ? "render-block" : "deliver-progress"
    return enabled.find((entry) => entry.kind === action)
      ?? enabled.find((entry) => entry.kind === "render-block")
  }
  const drain = async (bound = options.drainSteps, freeze = true, between?: () => Promise<void>) => {
    await act({ kind: "drain-begin", value: bound, sequence: turn })
    for (let index = 0; index < bound; index++) {
      await between?.()
      const pendingCommands = fixture.enabled().some((action) => action.id !== undefined)
      if (freeze && fixture.pending().length === 0 && !pendingCommands && !fixture.nativeWork()) break
      const action = fairAction()
      if (!action) break
      await act(action)
    }
    await act({ kind: "drain-end" })
  }
  // Whether the scheduler reaches the command within its budget: a witness that waits on a wake reports it missing as its
  // own failure rather than a harness error.
  const reachNamed = async (name: string) => {
    for (let count = 0; count < 100; count++) {
      const action = fixture.enabled().find((entry) => entry.kind === "control-wake" && fixture.commandName(entry.id) === name)
      if (action) { await act(action); return true }
      const next = fairAction()
      if (!next) return false
      await act(next)
    }
    return false
  }
  const executeNamed = async (name: string) => {
    if (!await reachNamed(name)) throw new Error(`No scheduler path to ${name}`)
  }
  // Reached once native has promoted the successor: the next Inspect is the adoption's proof.
  const untilAdoptionInspect = async (promotedFrom: number | undefined) => {
    const reached = () => fixture.state().activeRevision !== promotedFrom && fixture.state().pendingControl?.name === "inspect"
    for (let index = 0; index < options.drainSteps && !reached(); index++) {
      const next = fairAction()
      if (!next) break
      await act(next)
    }
    if (!reached()) throw new Error("Never reached the adoption Inspect")
  }
  // The compile the product holds at its gate, once it asks for one: nothing but promise turns stand between.
  const heldCompile = async () => {
    for (let index = 0; index < 200 && !fixture.enabled().some((entry) => entry.kind === "resolve-compile"); index++) await Promise.resolve()
    const held = fixture.enabled().find((entry) => entry.kind === "resolve-compile")
    if (!held) throw new Error("Compile gate never opened")
    return held
  }
  const controlWork = async () => {
    for (let index = 0; index < options.drainSteps; index++) {
      const next = fixture.enabled().find((entry) => entry.kind === "control-wake" || entry.kind === "deliver-reply")
      if (!next) return
      await act(next)
    }
    throw new Error("Control work did not settle")
  }
  // D5 settles the publication before its native latency transition ends.
  // These legacy finite-drain setups must deliver the real completion, not
  // rely on the caller's former awaited Retire to keep rendering for them.
  // One reader callback is still needed when no latency transition remains.
  const completeLatency = async () => {
    for (let index = 0; index < 40 && (index === 0 || fixture.state().latencyReadyEpoch !== undefined); index++) {
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await controlWork()
    }
  }
  const deliverNamed = async (name: string, last = false) => {
    const enabled = fixture.enabled().filter((entry) => entry.kind === "deliver-reply" && fixture.replyName(entry.id) === name)
    const action = last ? enabled.at(-1) : enabled[0]
    if (!action) throw new Error(`No reply ${name}`)
    await act(action)
  }
  // The seam is bound once after Prepare: a fresh Inspect, then a Publish native answers by rebinding, which does not arm it.
  const bindSeam = async () => {
    await executeNamed("inspect"); await deliverNamed("inspect")
    await executeNamed("publish"); await deliverNamed("publish")
  }
  if (replay) {
    for (const action of replay) {
      // Removing a producer removes its absent descendants too. Do not skip a
      // queued-but-disabled action: that would reorder native control work.
      if (pruneDependencies && action.id !== undefined && !fixture.hasActionId(action.id)) continue
      await act(action)
    }
  } else {
    if (plant === "early-release") await act({ kind: "sample", value: 1 })
    if (options.scenario === "attachment" || options.scenario === "parked-rebase" || options.scenario === "leases-invalid") await act({ kind: "attachment-setup" })
    if (instrumentScenarios.includes(options.scenario ?? "")) await act({ kind: "instrument-setup" })
    if (historyScenarios.includes(options.scenario ?? "")) await act({ kind: "history-setup" })
    if (options.scenario === "rollback-values" || options.scenario === "joined-flush-credit") await act({ kind: "registry-setup" })
    // The unprepared witness submits before any session exists.
    if (options.scenario !== "flush-unprepared") {
      await act({ kind: "start" }); await drain()
      if (!fixture.state().activeRevision) throw new Error("Controller did not install graph")
    }
    if (plant === "never-wake-latency") {
      await act({ kind: "latency", value: 2048, sequence: 10 })
      await executeNamed("publish"); await deliverNamed("publish")
      await act({ kind: "loss" }); await act({ kind: "check", mode: "terminal" })
    }
    if (plant && plant !== "stale-overwrite" && plant !== "never-wake-latency" && !scenarioPlant) {
      await act({ kind: "freeze" })
      await act({ kind: "mutation-probe" })
      if (plant === "underfill") {
        // Starve refill notifications, not the oracle input. Native keeps
        // rendering its actual admitted bank without progress delivery.
        for (let index = 0; index < 1000 && (fixture.state().metrics.minimumCoverageBlocks ?? Infinity) >= 1; index++)
          await act({ kind: "render-block" })
      }
      await drain()
      await act({ kind: "check", mode: plant === "noop-churn" ? "quiescent" : "converged" })
    }
    if (plant && plant !== "stale-overwrite" && !scenarioPlant) {
      // Controls isolate one planted wrapper fault from unrelated seed prefixes.
    } else if (options.scenario === "pause-latency" || options.scenario === "paused-flush" || options.scenario === "attachment") {
      const until = async (predicate: () => boolean) => {
        for (let index = 0; index < options.drainSteps && !predicate(); index++) {
          const next = fairAction()
          if (!next) break
          await act(next)
        }
        if (!predicate()) throw new Error(`Unreachable ${options.scenario}`)
      }
      if (options.scenario === "pause-latency") {
        await act({ kind: "latency", value: 2048 })
        await until(() => fixture.state().latencyReadyEpoch !== undefined && !fixture.state().pendingControl)
        await act({ kind: "inspect-latency" }); await executeNamed("inspect"); await deliverNamed("inspect")
        await act({ kind: "pause" }); await executeNamed("transport"); await deliverNamed("transport")
        await until(() => fixture.state().latencyReadyEpoch === undefined)
        await act({ kind: "inspect-latency" }); await executeNamed("inspect"); await deliverNamed("inspect")
        await drain(); await act({ kind: "check", mode: "pause-latency" })
      } else if (options.scenario === "paused-flush") {
        await act({ kind: "pause" }); await drain()
        await act({ kind: "flush", value: -9 }); await drain()
        await act({ kind: "check", mode: "paused-flush" })
      } else {
        await act({ kind: "sample", value: 1 })
        await act({ kind: "block-asset" })
        await act({ kind: "prepare-candidate" }); await drain()
        await act({ kind: "publish-candidate" }); await drain()
        await act({ kind: "attachment-latency", value: 2048 }); await drain()
        await act({ kind: "block-asset", value: 0 })
        await act({ kind: "publish-candidate" }); await drain()
        await act({ kind: "check", mode: "attachment" })
        await act({ kind: "attachment-plan", value: 1024 })
        await act({ kind: "prepare-candidate" }); await drain()
        await act({ kind: "publish-candidate" }); await drain()
        await act({ kind: "check", mode: "attachment" })
      }    } else if (attachmentScenarios.includes(options.scenario ?? "")) {
      // Two instances staged on one prepared revision; one of them never binds, by a lost join or by an undo during its startup.
      await act({ kind: "latency", value: 2048, sequence: 10 })
      await executeNamed("prepare"); await deliverNamed("prepare")
      await act({ kind: "attachment-stage", value: 1 }); await act({ kind: "attachment-stage", value: 2 })
      if (options.scenario === "attachment-join-lost") await act({ kind: "attachment-join-lost", value: 2 })
      else await act({ kind: "attachment-undo", value: 2 })
      await act({ kind: "attachment-ready", value: 2 }); await act({ kind: "attachment-ready", value: 1 })
      await drain()
      await act({ kind: "check", mode: options.scenario })
    } else if (options.scenario === "host-boundary") {
      await act({ kind: "boundary-probe", mode: "revision" })
      const deadline = fixture.enabled().find((action) => action.kind === "revision-deadline")
      if (!deadline) throw new Error("No revision deadline")
      await act(deadline)
      if (fixture.state().pendingControl || fixture.state().queuedSends.length !== 3)
        throw new Error("Revision deadline dispatched queued sends")
      await executeNamed("inspect"); await deliverNamed("inspect")
      if (fixture.state().pendingControl) throw new Error("Late revision reply dispatched queued sends")
      await act({ kind: "boundary-probe", mode: "enqueue" })
      for (const name of ["instrument-events", "window", "instruments", "instruments"]) {
        await executeNamed(name); await deliverNamed(name)
      }
      await act({ kind: "boundary-probe", mode: "control" })
      const watchdog = fixture.enabled().find((action) => action.kind === "control-watchdog")
      if (!watchdog) throw new Error("No control watchdog")
      await act(watchdog)
      await act({ kind: "check", mode: "terminal" })
      record({ witness: "host-boundary-deadlines", revisionLoss: false, watchdogLoss: true,
        dispatchOrder: ["instrument-events", "window", "instruments"], busyRevision: "renderer-ok-false" })
      await act({ kind: "dispose" }); await drain()
      await act({ kind: "reset-fixture" }); await act({ kind: "start" }); await drain()
    } else if (options.scenario === "transport-refusal") {
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" })
      await executeNamed("publish"); await deliverNamed("publish")
      for (let index = 0; index < options.drainSteps && !fixture.state().publicationClaimed; index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      if (!fixture.state().publicationClaimed) throw new Error("No claimed publication")
      await act({ kind: "pause" }); await executeNamed("transport"); await deliverNamed("transport")
      await act({ kind: "publication-acknowledge" }); await drain()
      await act({ kind: "check", mode: "transport-refusal" })
      await act({ kind: "loss" }); await act({ kind: "dispose" }); await drain()
      await act({ kind: "reset-fixture" }); await act({ kind: "start" }); await drain()
    } else if (options.scenario === "prefix-11") {
      await act({ kind: "latency", value: 2048, sequence: 10 })
      await executeNamed("prepare"); await deliverNamed("prepare")
      // Prepare has frozen bytes; Publish is dispatched but not yet executed.
      await act({ kind: "flush", value: -9, sequence: 11 })
      await executeNamed("publish"); await deliverNamed("publish")
      await executeNamed("parameters"); await deliverNamed("parameters")
      await drain(); await act({ kind: "check" })
      await act({ kind: "check", mode: "prefix-11" })
    } else if (options.scenario === "reenable-automation") {
      // Re-enabling automation sends nothing to native, so its result cannot name an applied batch.
      await act({ kind: "reenable" }); await drain(); await act({ kind: "check" })
    } else if (options.scenario === "instrument-urgent") {
      // The preview's urgent event is admitted but not yet rendered when a same-core successor
      // is prepared; the terminal flush then waits across that publication.
      await act({ kind: "synth-preview", value: 4000, sequence: 5 })
      await executeNamed("instrument-events"); await deliverNamed("instrument-events")
      await act({ kind: "latency", value: 2048, sequence: 10 })
      await executeNamed("prepare"); await deliverNamed("prepare")
      await act({ kind: "synth-flush", value: 4000, sequence: 5 })
      await executeNamed("publish"); await deliverNamed("publish")
      await drain(); await act({ kind: "check" })
      await act({ kind: "check", mode: "instrument-urgent" })
    } else if (options.scenario === "retained-drift") {
      // prefix-11's schedule plus a later, higher flush. Native's retained rule decides whether batch 11
      // survives the publication; if the controller rebinds a batch native cancelled, batch 12's floor
      // settles it as applied. The cancel-retained plant makes the host cancel it.
      await act({ kind: "latency", value: 2048, sequence: 10 })
      await executeNamed("prepare"); await deliverNamed("prepare")
      await act({ kind: "flush", value: -9, sequence: 11 })
      await executeNamed("publish"); await deliverNamed("publish")
      await executeNamed("parameters"); await deliverNamed("parameters")
      await drain()
      await act({ kind: "flush", value: -12, sequence: 12 }); await drain()
      await act({ kind: "check" })
      await act({ kind: "check", mode: "retained-drift" })
    } else if (options.scenario === "urgent-epoch-drop") {
      // The flush's urgent event is admitted, then a seek changes the epoch before native renders: native
      // drops the event at drain. A later urgent event in the new epoch lifts the session-wide floor past
      // the dropped sequence, which must not settle the flush as applied.
      await act({ kind: "synth-flush", value: 4000, sequence: 5 })
      await executeNamed("instrument-events"); await deliverNamed("instrument-events")
      await act({ kind: "seek" })
      await drain()
      await act({ kind: "synth-preview", value: 5000, sequence: 6 })
      await drain(); await act({ kind: "check" })
      await act({ kind: "check", mode: "urgent-epoch-drop" })
    } else if (options.scenario === "reconcile-seek") {
      // A gesture's override outlives a transport transition (native keeps a slot's overrides across epochs).
      // History then moves desired back with no dispatch: only the adoption's reconcile can reach native.
      await act({ kind: "registry-gesture", value: -2 }); await drain()
      await act({ kind: "registry-gesture", value: -9 }); await drain()
      await act({ kind: "seek" }); await drain()
      await act({ kind: "desire", value: -2 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "check", mode: "reconcile" })
    } else if (options.scenario === "reconcile-inflight") {
      // The candidate rebased desired -5 (history); a gesture to -3 is allocated and queued while the
      // publication's Inspect holds the host's control slot, so its ACK arrives after adoption.
      // Reached once native has promoted the successor: the next Inspect is the adoption's proof.
      await act({ kind: "registry-gesture", value: -9 }); await drain()
      await act({ kind: "desire", value: -5 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare"); await deliverNamed("prepare")
      const promotedFrom = fixture.state().activeRevision
      await executeNamed("publish"); await deliverNamed("publish")
      await untilAdoptionInspect(promotedFrom)
      await act({ kind: "registry-gesture", value: -3 })
      await executeNamed("inspect"); await deliverNamed("inspect")
      await executeNamed("parameters"); await deliverNamed("parameters")
      await drain()
      await act({ kind: "check", mode: "reconcile-inflight" })
    } else if (options.scenario === "reconcile-first") {
      // A first dispatch is retained by the publication and not yet proven when the adoption carries
      // newer desired content. The fake host's FIFO slot and progress-driven publication prove a batch
      // before any Inspect adopts, so the sequence is replayed against the owner.
      await act({ kind: "check", mode: "reconcile-first" })
    } else if (options.scenario === "unsent-second-domain") {
      // Failure-first B6 obligations: an unsent edit must follow both public
      // moves, ignore old proof, retain lineage, and apply exactly once.
      const verify = (ok: boolean, detail: string) => {
        checks.set("I3", (checks.get("I3") ?? 0) + 1)
        if (ok) return
        const failure = { step, invariant: "I3", detail: `B6 unsent-second-domain: ${detail}`, domain: "live" }
        failuresAt.push(failure)
        divergentStates.push({ step, state: structuredClone(fixture.state()) })
        record({ event: "failure", ...failure })
      }
      await act({ kind: "pause" }); await drain()
      const initialEpoch = fixture.state().epoch
      // Real unrelated urgent applications lift a session-wide floor before
      // the held Utility record exists, without an oracle/host-model plant.
      await act({ kind: "live-note" }); await controlWork()
      await act({ kind: "live-note" }); await controlWork()
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await controlWork()
      await act({ kind: "seek" })
      await act({ kind: "registry-gesture", value: -9 })
      const held = fixture.state().waiters.findLast(waiter => waiter.name === "flush")
      if (!held) throw new Error("B6 witness missing its registry delivery")
      const lineage = { id: held.editId, order: held.editOrder }
      const pending = (phase: string) => {
        verify((fixture.state().counts.parameters ?? 0) === 0 && !held.settled,
          `${phase}: obsolete epoch dispatched or answered the unsent edit`)
        verify(held.editId === lineage.id && held.editOrder === lineage.order, `${phase}: edit lineage changed`)
      }
      pending("seek held")
      await act({ kind: "start", value: 0.5 })
      // Resolve only the real start compile; do not release the older IPC.
      await act(await heldCompile())
      verify(fixture.state().queuedSends.some(command => command.name === "transport"),
        "different-frame start did not queue a second public transport")
      await executeNamed("transport")
      await act({ kind: "render-block" }); await act({ kind: "hold-progress" })
      await act({ kind: "deliver-progress" })
      verify(fixture.state().epoch === initialEpoch + 1, "first moved domain was not observed")
      pending("first-domain progress")
      await deliverNamed("transport")
      pending("old seek ACK")
      await executeNamed("transport"); await deliverNamed("transport")
      await drain()
      verify(fixture.state().epoch === initialEpoch + 2, "second moved domain was not observed")
      verify((fixture.state().counts.parameters ?? 0) === 1, "edit was not dispatched exactly once")
      await act({ kind: "check", mode: "gesture-applied" })
      const before = JSON.stringify(fixture.state().counts)
      await act({ kind: "deliver-held-progress" }); await controlWork()
      verify(JSON.stringify(fixture.state().counts) === before, "late old progress caused native churn")
      verify(held.settled && z.object({ state: z.literal("applied") }).safeParse(held.result).success,
        "second-domain application did not settle the original delivery")
      record({ witness: "B6-unsent-second-domain", epochs: [initialEpoch, initialEpoch + 1, fixture.state().epoch],
        frames: [0, 12_000, 24_000], lineage, dispatches: fixture.state().counts.parameters,
        result: held.result, actual: fixture.state().actual })
      // Keep the original unsent/overlap proof above. Additionally, native
      // refuses a carrier while an existing public adoption holds its compile.
      // Only start's domain end can recover it before that compile is released.
      await act({ kind: "pause" })
      await act({ kind: "prepare-candidate" })
      const oldCompile = await heldCompile()
      for (let callback = 0; callback < 40; callback++) {
        await controlWork()
        await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
      }
      await controlWork()
      const pausedEpoch = fixture.state().epoch
      await act({ kind: "refuse-parameters" })
      await act({ kind: "registry-gesture", value: -6 })
      const refused = fixture.state().waiters.findLast(waiter => waiter.name === "flush")
      if (!refused) throw new Error("B6 refusal witness missing registry delivery")
      const refusedLineage = { id: refused.editId, order: refused.editOrder }
      const sendsBefore = fixture.state().counts.parameters ?? 0
      await executeNamed("parameters"); await deliverNamed("parameters")
      verify(!refused.settled && fixture.state().actual.gain === -9,
        "paused-domain refusal did not retain the unapplied delivery")
      await act({ kind: "start", value: 0.75 })
      const startCompile = fixture.enabled().findLast(action => action.kind === "resolve-compile")
      if (!startCompile || startCompile.id === oldCompile.id) throw new Error("B6 missing separate start compile")
      await act(startCompile)
      // Exclude resolve-compile: releasing the old compile here could mask a
      // missing endDomain by reoffering on the adoption's terminal instead.
      for (let callback = 0; callback < 40; callback++) {
        await controlWork()
        await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
      }
      await controlWork()
      verify(fixture.state().epoch === pausedEpoch + 1, "refused carrier's start domain did not move")
      verify(fixture.state().actual.gain === -6, "refused paused-domain carrier never applied in the start domain")
      verify((fixture.state().counts.parameters ?? 0) === sendsBefore + 1,
        "refused carrier was not dispatched once more")
      verify(refused.editId === refusedLineage.id && refused.editOrder === refusedLineage.order,
        "refused carrier lost its original edit lineage")
      verify(refused.settled && z.object({ state: z.literal("applied") }).safeParse(refused.result).success,
        "refused carrier did not receive applied before the old compile was released")
      record({ witness: "B6-refused-second-domain", epochs: [pausedEpoch, fixture.state().epoch],
        lineage: refusedLineage, result: refused.result, actual: fixture.state().actual,
        dispatches: fixture.state().counts.parameters })
      await act(oldCompile)
      await act({ kind: "dispose-candidate" }); await drain()
    } else if (options.scenario === "parameter-preack-epoch") {
      // A seek's SetTransport is queued ahead of a flush allocated under the new epoch. Frames of the old
      // epoch reach the controller before the flush is admitted: native checks the batch epoch at
      // admission, so they prove nothing about it. It is admitted under the new epoch and applies.
      await act({ kind: "seek" })
      await act({ kind: "registry-gesture", value: -9 })
      for (let index = 0; index < 2; index++) {
        await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
      }
      await drain()
      await act({ kind: "check", mode: "gesture-applied" })
    } else if (options.scenario === "parameter-epoch-drop") {
      // An admitted parameter batch is dropped at drain when a seek changes the epoch first. Only a frame
      // of a newer epoch proves that; a later flush must not be taken for it.
      await act({ kind: "registry-gesture", value: -9 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      // The ACK is consumed before the seek, so the flush waits for native's proof.
      await act({ kind: "deliver-progress" })
      await act({ kind: "seek" })
      await drain()
      await act({ kind: "registry-gesture", value: -4 }); await drain()
      await act({ kind: "check", mode: "parameter-dropped" })
    } else if (options.scenario === "future-epoch-drop") {
      // A callback begins at epoch E. Control then queues the seek's SetTransport(E+1) and a flush that
      // native admits under E+1 (audio-host.cpp:3119). The callback still drains with E applied and drops
      // the batch. A later flush in E+1 lifts the floor over its sequence, which must not read as applied.
      await act({ kind: "split-render", value: 1 })
      await act({ kind: "render-open" })
      await act({ kind: "seek" }); await controlWork()
      await act({ kind: "registry-gesture", value: -9 }); await controlWork()
      await act({ kind: "render-close" })
      await drain()
      await act({ kind: "registry-gesture", value: -4 }); await drain()
      await act({ kind: "check", mode: "future-epoch-drop" })
    } else if (options.scenario === "held-urgent-note") {
      // A seek holds an instrument flush for its epoch. A live MIDI note, which bypasses that gate, is
      // sent later and applies first; its sequence must not stand for the held flush.
      await act({ kind: "seek" }); await controlWork()
      await act({ kind: "synth-flush", value: 4000, sequence: 5 })
      await act({ kind: "live-note" }); await controlWork()
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await controlWork()
      await act({ kind: "check", mode: "held-urgent" })
      await drain()
      await act({ kind: "check" })
      await act({ kind: "check", mode: "held-urgent" })
      await act({ kind: "check", mode: "unsent-proof" })
    } else if (options.scenario === "retained-instrument") {
      // A processor shares the synth's track node and the publication configures the synth again, so native
      // gives the node a fresh slot (assign_prepared_node) and cancels the processor's queued batch at
      // promotion. A controller that rebinds it lets the next flush's floor settle it as applied.
      await act({ kind: "synth-params" })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare"); await deliverNamed("prepare")
      await executeNamed("instruments"); await deliverNamed("instruments")
      await executeNamed("publish"); await deliverNamed("publish")
      // The seam is claimed and the promotion is the next step: the batch is still queued when it happens.
      for (let index = 0; index < options.drainSteps && !fixture.enabled().some((entry) => entry.kind === "publication-acknowledge"); index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      await act({ kind: "registry-gesture", value: -9 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "publication-acknowledge" })
      await drain()
      await act({ kind: "registry-gesture", value: -12 }); await drain()
      await act({ kind: "check" })
      await act({ kind: "check", mode: "retained-drift" })
    } else if (options.scenario === "two-rejections") {
      // A flush cancelled by a publication, then a distinct one refused at admission for a stale stamp:
      // each rejection is classified by its own batch, not by the publication that cancelled the earlier one.
      await act({ kind: "synth-params" })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare"); await deliverNamed("prepare")
      await executeNamed("instruments"); await deliverNamed("instruments")
      await executeNamed("publish"); await deliverNamed("publish")
      for (let index = 0; index < options.drainSteps && !fixture.enabled().some((entry) => entry.kind === "publication-acknowledge"); index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      await act({ kind: "registry-gesture", value: -9 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "publication-acknowledge" })
      await drain()
      await act({ kind: "desire", value: -5 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare"); await deliverNamed("prepare")
      const promotedFrom = fixture.state().activeRevision
      await executeNamed("publish"); await deliverNamed("publish")
      await untilAdoptionInspect(promotedFrom)
      await act({ kind: "registry-gesture", value: -3 })
      await executeNamed("inspect"); await deliverNamed("inspect")
      await executeNamed("parameters"); await deliverNamed("parameters")
      await drain()
      await act({ kind: "check", mode: "rejection-classes" })
    } else if (options.scenario === "overlapping-flushes") {
      // Two flushes begin in one turn, before either send reaches the bridge: the publication cancels the
      // first's batch after admission and native refuses the second's stale stamp. Each is classified by
      // the batches dispatched for its own record, not by the sends made while it was outstanding.
      await act({ kind: "synth-params" })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare"); await deliverNamed("prepare")
      await executeNamed("instruments"); await deliverNamed("instruments")
      await executeNamed("publish"); await deliverNamed("publish")
      for (let index = 0; index < options.drainSteps && !fixture.enabled().some((entry) => entry.kind === "publication-acknowledge"); index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      await act({ kind: "registry-gesture", value: -9, second: -3 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "publication-acknowledge" })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await drain()
      await act({ kind: "check", mode: "rejection-classes" })
    } else if (options.scenario === "retained-override-instrument") {
      // The synth's configuration changes, but the Utility on the same node keeps its processor history
      // slot and with it the applied override (audio_core.cpp:8044-8072). History then moves desired with
      // no gesture: only the next adoption's reconcile can reach native, so it must still know the override.
      await act({ kind: "registry-gesture", value: -9 }); await drain()
      await act({ kind: "synth-params" })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "desire", value: -2 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "check", mode: "reconcile" })
    } else if (options.scenario === "restated-override") {
      // The prepared successor's Utility changes structure (swap), so native gives it a fresh history slot
      // at the captured gain. A gesture applied on the published plan after that Prepare is lost with the
      // old slot: the gesture's flush must not be taken for the preview that applied there.
      await act({ kind: "utility-swap", value: 1 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare"); await deliverNamed("prepare")
      // The successor captured swap=true; this live edit still targets the published processor's old structure.
      await act({ kind: "utility-swap", value: 0 })
      await act({ kind: "registry-preview", value: -9 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await drain()
      await act({ kind: "registry-flush" }); await drain()
      await act({ kind: "check", mode: "reconcile" })
    } else if (options.scenario === "restated-inflight") {
      // As restated-override, but the preview drains on the old processor while its proof frame is still in
      // flight: the publication promotes and the adoption runs first. The floor native then reports cannot
      // say which slot drained the batch, so it must not stand for the edit.
      await act({ kind: "utility-swap", value: 1 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare"); await deliverNamed("prepare")
      await bindSeam()
      await act({ kind: "render-block" }); await act({ kind: "hold-progress" })
      await act({ kind: "utility-swap", value: 0 })
      await act({ kind: "registry-preview", value: -9 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      progressWithheld = true
      await act({ kind: "render-block" })
      const promotedFrom = fixture.state().activeRevision
      await executeNamed("publish"); await deliverNamed("publish")
      await act({ kind: "deliver-held-progress" })
      // The publication promotes while Inspect is still pending, so the adoption finds the batch in flight.
      for (let index = 0; index < options.drainSteps && fixture.state().activeRevision === promotedFrom; index++) {
        const next = fixture.enabled().find((entry) => entry.kind === "publication-acknowledge")
          ?? fixture.enabled().find((entry) => entry.kind === "render-block")
        if (!next) break
        await act(next)
      }
      await executeNamed("inspect"); await deliverNamed("inspect")
      progressWithheld = false
      await act({ kind: "deliver-progress" }); await drain()
      // The post-recovery-overwrite plant: native regresses for a moment after a callback restored the edit,
      // before any receipt confirms it.
      if (plant === "post-recovery-overwrite") { await act({ kind: "overwrite-override", value: 0 }); await act({ kind: "overwrite-override", value: -9 }) }
      await act({ kind: "registry-flush" }); await drain()
      await act({ kind: "check", mode: "reconcile" })
    } else if (options.scenario === "restated-queued") {
      // The preview is queued, not drained, when the publication promotes: native keeps it for the successor,
      // where it drains. The edit still ends on the successor, now behind the controller's own dispatch.
      await act({ kind: "utility-swap", value: 1 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare"); await deliverNamed("prepare")
      await executeNamed("publish"); await deliverNamed("publish")
      for (let index = 0; index < options.drainSteps && !fixture.enabled().some((entry) => entry.kind === "publication-acknowledge"); index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      await act({ kind: "utility-swap", value: 0 })
      await act({ kind: "registry-preview", value: -9 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "publication-acknowledge" })
      await drain()
      await act({ kind: "registry-flush" }); await drain()
      await act({ kind: "check", mode: "reconcile" })
    } else if (options.scenario === "synth-replaced") {
      await act({ kind: "synth-flush", value: 4000, sequence: 5 }); await drain()
      await act({ kind: "replace-synth" })
      await act({ kind: "sample", value: 1 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "synth-flush", value: 4000, sequence: 5 }); await drain()
      await act({ kind: "check", mode: "synth-replaced" })
    } else if (options.scenario === "patch-installed" || options.scenario === "attempt-identity" || options.scenario === "patch-projected-timing" || options.scenario === "rebound-credit") {
      // Owner-level, replayed against the owner alone like reconcile-first: no fixture path orders these calls.
      await act({ kind: "check", mode: options.scenario })
    } else if (options.scenario === "rebound-applied-rejected") {
      // The host refuses the flush's batch 1; the next frame dispatches it again as batch 2 from outside the call. Native
      // applies batch 2 but its progress is withheld: the flush is answered only by the frame that shows it applied.
      await act({ kind: "refuse-parameters" })
      await act({ kind: "flush", value: -9, sequence: 10 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "render-block" })
      await act({ kind: "deliver-progress" }); await drain()
    } else if (options.scenario === "joined-flush-credit") {
      // The panel flushes the gesture and its release joins that record: one dispatch, two callers, one answer each.
      await act({ kind: "registry-gesture", value: -9 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "registry-flush" })
      await act({ kind: "render-block" })
      await act({ kind: "deliver-progress" }); await drain()
    } else if (options.scenario === "patch-refused-settled") {
      // The flush's own dispatch is refused while patch B waits behind A. B is built from the flush's edit, so its install
      // carries the flush's values: the flush is answered by it before any frame offers it again.
      await act({ kind: "edit-values" })
      await act({ kind: "utility-swap", value: 1 })
      await act({ kind: "gain", value: -1, sequence: 10 })
      await executeNamed("patch"); await act({ kind: "render-block" }); await deliverNamed("patch")
      await act({ kind: "flush", value: -9, sequence: 11 })
      await act({ kind: "utility-swap", value: 0 })
      await act({ kind: "gain", value: -3, sequence: 12 })
      await act({ kind: "utility-swap", value: 1 })
      await act({ kind: "flush", value: -9, sequence: 13 })
      await act({ kind: "refuse-parameters" })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await executeNamed("patch"); await act({ kind: "render-block" }); await deliverNamed("patch")
      await act({ kind: "check", mode: "patch-refused-settled" })
    } else if (options.scenario?.startsWith("patch-")) {
      // A installs a real structural edit. Its mapped gesture then precedes B's structural
      // request; the closing whole edit is materialized by B. Native applies patches before
      // draining parameter batches, so B waits for that batch's proof or refusal.
      const behind = async (modeOfB: string) => {
        await act({ kind: "utility-swap", value: 1 })
        await act({ kind: "gain", value: -1, sequence: 10 })
        await executeNamed("patch"); await act({ kind: "render-block" }); await deliverNamed("patch")
        await act({ kind: "flush", value: -9, sequence: 11 })
        await act({ kind: "utility-swap", value: 0 })
        await act({ kind: "gain", value: -3, sequence: 12 })
        await act({ kind: "utility-swap", value: 1 })
        await act({ kind: "flush", value: -9, sequence: 13 })
        await act({ kind: "patch-mode", mode: modeOfB })
        await executeNamed("parameters"); await deliverNamed("parameters")
      }
      if (options.scenario === "patch-install") {
        // The batch drains on A's state and its proof arrives before B installs; B's ACK comes after.
        await behind("normal")
        await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
        await executeNamed("patch"); await act({ kind: "render-block" }); await deliverNamed("patch")
      } else if (options.scenario === "patch-install-late-proof") {
        // Keep a duplicate old proof to deliver after B installed. B still requires an
        // application proof before dispatch; an ACK cannot release the patch.
        await behind("normal")
        await act({ kind: "render-block" }); await act({ kind: "hold-progress" })
        await act({ kind: "deliver-progress" })
        await executeNamed("patch"); await act({ kind: "render-block" })
        await act({ kind: "deliver-held-progress" }); await deliverNamed("patch")
      } else if (options.scenario === "patch-race-split") {
        // Model-only, gates nothing: native claims and applies in one callback (audio-host.cpp:5139-5148), so a gesture
        // cannot drain between the claim and the apply. Kept as a harder interleaving of the fake host.
        await behind("negative")
        await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
        await executeNamed("patch"); await act({ kind: "render-block" }); await act({ kind: "render-block" })
        await act({ kind: "deliver-progress" }); await deliverNamed("patch")
      } else if (options.scenario === "patch-race-before-claim") {
        // Native claims and applies in one callback, before the lane drain: the queued gesture lands on B's state.
        await behind("negative-atomic")
        await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
        await executeNamed("patch"); await act({ kind: "render-block" })
        await act({ kind: "deliver-progress" }); await deliverNamed("patch")
      } else if (options.scenario === "patch-first") {
        await act({ kind: "utility-swap", value: 1 })
        await act({ kind: "gain", value: -1, sequence: 10 })
        await executeNamed("patch"); await act({ kind: "render-block" }); await deliverNamed("patch")
        // The gesture comes after the install: the flush ends it by joining the preview's applied carrier.
        await act({ kind: "identity-baseline" })
        await act({ kind: "preview", value: -9, sequence: 11 }); await drain()
        await act({ kind: "flush", value: -9, sequence: 11 })
      } else if (options.scenario === "patch-prepared-override") {
        // A gesture's override stands over the prepared bytes, which already equal the patch: it must still be reset.
        await act({ kind: "preview", value: -9, sequence: 10 }); await drain()
        await act({ kind: "gain", value: 0, sequence: 11 })
      } else if (options.scenario === "patch-prepared-pending") {
        // Patch A is on its way when one equal to the prepared bytes arrives: A installs over it unless it is sent after.
        await act({ kind: "gain", value: -1, sequence: 10 })
        await act({ kind: "gain", value: 0, sequence: 11 })
      } else if (options.scenario === "patch-claimed-newest") {
        // The claimed patch is the newest edit and a proven gesture precedes it. Its values are in force whatever the
        // reply says, so a publication carrying them leaves nothing to dispatch and native ends on them.
        await act({ kind: "preview", value: -9, sequence: 10 }); await drain()
        await act({ kind: "patch-mode", mode: "negative-atomic" })
        await act({ kind: "utility-swap", value: 1 })
        await act({ kind: "gain", value: -1, sequence: 11 })
        await executeNamed("patch"); await act({ kind: "render-block" }); await deliverNamed("patch")
        await act({ kind: "patch-mode", mode: "normal" }); await drain()
        await act({ kind: "identity-baseline" })
        await act({ kind: "prepare-candidate" }); await drain()
        await act({ kind: "publish-candidate" })
      } else {
        // Claimed in a callback that also applies it, reply negative: the patch is installed whatever the reply says.
        await act({ kind: "patch-mode", mode: "negative-atomic" })
        await act({ kind: "utility-swap", value: 1 })
        await act({ kind: "gain", value: -9, sequence: 10 })
        await executeNamed("patch"); await act({ kind: "render-block" }); await deliverNamed("patch")
        await act({ kind: "patch-mode", mode: "normal" })
        await act({ kind: "flush", value: -5, sequence: 11 })
      }
      await drain(); await act({ kind: "check", mode: options.scenario === "patch-first" ? "patch-first"
        : options.scenario === "patch-claimed-newest" ? "patch-claimed"
          : options.scenario.startsWith("patch-prepared-") ? "patch-dedupe" : "patch-install" })
    } else if (options.scenario === "refused-resend") {
      // History moves desired with no gesture: only the adoption's reconcile reaches native, and the host
      // refuses that one dispatch for capacity. Nothing else will send the content.
      await act({ kind: "registry-gesture", value: -2 }); await drain()
      await act({ kind: "registry-gesture", value: -9 }); await drain()
      await act({ kind: "seek" }); await drain()
      await act({ kind: "desire", value: -2 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "refuse-parameters" })
      await act({ kind: "publish-candidate" }); await drain()
      // Native keeps rendering: the next frame is the signal that a refused dispatch may be tried again.
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain()
      await act({ kind: "check", mode: "refused-resend" })
    } else if (options.scenario === "refused-preview") {
      // A preview's dispatch is refused: its gesture stays open and no flush follows, yet it is still desired.
      await act({ kind: "refuse-parameters" })
      await act({ kind: "preview", value: -9, sequence: 10 }); await drain()
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain()
      await act({ kind: "check", mode: "refused-resend" })
    } else if (options.scenario === "pause-refused-pending" || options.scenario === "seek-refused-pending") {
      // The host refuses the flush's batch, so its record stays pending; the transport action then ends the domain it was
      // sent in, after the one retry the next frame gives it was refused too. The flush is answered without a restore and the
      // desired value still reaches native (hook seeds 3 and 84).
      await act({ kind: "refuse-parameters", value: 2 })
      await act({ kind: "flush", value: -9 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: options.scenario === "pause-refused-pending" ? "pause" : "seek" }); await drain()
      await act({ kind: "refuse-parameters", value: 0 })
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain()
      await act({ kind: "check", mode: "ending-domain" })
    } else if (options.scenario === "rapid-seek") {
      // Two seeks in a row while a flush is admitted: the content is still desired and every wait is answered.
      await act({ kind: "flush", value: -9 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "seek" }); await act({ kind: "seek" }); await drain()
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain()
      await act({ kind: "check", mode: "ending-domain" })
    } else if (options.scenario === "send-straddles-pause") {
      // The flush's batch is admitted by native and its bridge ACK is still out when the pause moves the domain on: the caller
      // follows the record (applied after it is sent again, or cancelled), never a stale answer made at the ACK.
      await act({ kind: "flush", value: -9 })
      await executeNamed("parameters")
      await act({ kind: "pause" })
      await deliverNamed("parameters"); await drain()
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain()
      await act({ kind: "check", mode: "ending-domain" })
    } else if (options.scenario === "two-registry-frame") {
      // A flush sent in the seek's new epoch waits for the frame that shows the epoch applied, while the schedule coordinator
      // waits on the same frame for the seek's transition id. One frame releases both: the send goes out at once, with no timer.
      await act({ kind: "seek" })
      await executeNamed("transport"); await deliverNamed("transport")
      await act({ kind: "flush", value: -9 })
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
      await fixture.checkpoint()
      const outstanding = fixture.state()
      const released = [...outstanding.commands, ...outstanding.queuedSends, ...outstanding.replies].some((entry) => entry.name === "parameters")
        || outstanding.pendingControl?.name === "parameters"
      await act({ kind: "check", mode: "frame-released", value: released ? 1 : 0 })
      await drain()
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain()
      await act({ kind: "check", mode: "ending-domain" })
      await act({ kind: "check", mode: "no-processor-timer",
        value: clock?.inventory().filter((entry) => entry.kind === "fire-timer" && isProcessorWaitTimer(entry.site)).length ?? 0 })
    } else if (options.scenario === "browser-flush-pause") {
      const receipts = await browserReceipts()
      await act({ kind: "check", mode: "browser-receipts", value: receipts.acrossPause.accepted && !receipts.acrossRestart.accepted && receipts.acrossRestart.reason === "stale" ? 1 : 0 })
    } else if (options.scenario === "urgent-pause") {
      // An instrument flush is sent and its urgent event never rendered when the transport pauses: the wait must end with the domain.
      await act({ kind: "synth-flush", value: 4000, sequence: 5 })
      await act({ kind: "pause" }); await drain()
      await act({ kind: "check", mode: "ending-domain" })
    } else if (options.scenario === "processor-timer") {
      // A flush that settles by progress: no processor wait may have allocated a timeout. Attribution is by the requesting
      // file in the timer's stack, not by the helper's name.
      await act({ kind: "flush", value: -9 }); await drain()
      await act({ kind: "check", mode: "no-processor-timer",
        value: clock?.inventory().filter((entry) => entry.kind === "fire-timer" && isProcessorWaitTimer(entry.site)).length ?? 0 })
    } else if (options.scenario === "flush-no-bridge") {
      // Every submission of a controller with no bridge is answered at once, unavailable: a flush is not kept, a preview not accepted.
      const answers = await unavailableSession()
      const refused = answers.every((entry) => entry.settled && z.object({ state: z.literal("unavailable") }).safeParse(entry.result).success)
      await act({ kind: "check", mode: "session-unavailable-answers", value: refused ? 1 : 0 })
    } else if (options.scenario === "flush-unprepared" || options.scenario === "flush-after-dispose" || options.scenario === "flush-after-loss") {
      // No session is left to report progress or to end one: a flush or preview, with or without an edit stamp, is refused at once.
      if (options.scenario === "flush-after-dispose") { await act({ kind: "dispose" }); await controlWork() }
      if (options.scenario === "flush-after-loss") { await act({ kind: "loss" }); await drain() }
      await act({ kind: "flush", value: -9 }); await act({ kind: "flush", value: -8, mode: "unstamped" })
      await act({ kind: "preview", value: -7 }); await act({ kind: "preview", value: -6, mode: "unstamped" })
      await fixture.checkpoint()
      await act({ kind: "check", mode: "session-unavailable" })
    } else if (options.scenario === "terminal-classifier") {
      // Every stranded old-domain wait fails, even while native holds a
      // publication. New-domain transport callers owe their own callback.
      const wait = (name: string, domain: number, settled = false) => ({ name, domain, settled })
      const cases = [
        { expected: true, waiters: [wait("latency", 1), wait("pause", 2)] },
        { expected: true, waiters: [wait("latency", 1), wait("pause", 1), wait("seek", 2)] },
        { expected: true, waiters: [wait("latency", 1)] },
        { expected: true, waiters: [wait("latency", 1), wait("pause", 2, true)] },
        { expected: true, waiters: [wait("flush", 1), wait("pause", 2)] },
        { expected: false, waiters: [wait("latency", 1, true), wait("pause", 2)] },
        { expected: false, waiters: [wait("pause", 2)] },
      ]
      const wrong = cases.filter(entry => endingDomainFailure(entry.waiters, 2) !== entry.expected).length
      await act({ kind: "check", mode: "terminal-classifier", value: wrong })
    } else if (options.scenario === "compile-domain-end") {
      // A schedule compile held at its gate while its transport domain (or its session) ends is cancelled at that moment:
      // the preparation answers retry before the compile ever resolves, and the late compile changes nothing.
      // The compile that comes back late either supported or not: neither adds a candidate or reports a fault.
      for (const [index, terminal] of ["pause", "seek", "loss"].entries()) for (const unsupported of [0, 1]) {
        if (index || unsupported) {
          await act({ kind: "loss" }); await act({ kind: "dispose" }); await drain()
          await act({ kind: "reset-fixture" }); await act({ kind: "start" }); await drain()
        }
        await act({ kind: "forget-candidate" })
        await act({ kind: "prepare-candidate" })
        const compile = fixture.enabled().find((action) => action.kind === "resolve-compile")
        if (!compile) throw new Error("Compile gate never opened")
        await act({ kind: terminal })
        await act({ kind: "compile-unsupported", value: unsupported }); await act({ kind: "mark-compiles" })
        await act({ kind: "check", mode: "compile-aborted", value: index })
        await act(compile); await drain()
        await act({ kind: "check", mode: "compile-aborted", value: index })
        await act({ kind: "compile-unsupported", value: 0 })
      }
    } else if (options.scenario === "resume-structure") {
      // A track added while the session is paused changes neither its assets nor its processors: the Play that resumes the
      // session must still run it (phase 8 step 4).
      await act({ kind: "pause" }); await drain()
      await act({ kind: "mark-compiles" })
      await act({ kind: "structure", value: 1 })
      // On odd seeds the hook's follow has submitted the edit, and its adoption is still under way when Play comes.
      if (seed % 2) await act({ kind: "submit-schedule" })
      await act({ kind: "start" }); await drain()
      await act({ kind: "check", mode: "resume-structure" })
    } else if (options.scenario === "abort-no-block") {
      // An adoption whose compile is cancelled by a seek ends without a refusal on record: nothing blocks the next ask.
      await act({ kind: "submit-schedule" })
      await act({ kind: "seek" }); await drain()
      await act({ kind: "check", mode: "abort-no-block" })
    } else if (options.scenario === "transport-mismatch") {
      // The compile reads a loop the prepared transport does not have: it moves nothing and blocks nothing; the
      // adoption applies the loop once, outside the compile, and compiles again.
      await act({ kind: "mark-compiles" }); await act({ kind: "compile-loop", value: 1 })
      await act({ kind: "submit-schedule" }); await drain()
      await act({ kind: "check", mode: "transport-mismatch" })
    } else if (options.scenario === "adoption-cancel") {
      // Cancelled before its compile registered with the owner: in the turn that coalesces notifications, while the loop
      // is applied, and as its host is lost meanwhile. None compiles; every caller is answered and nothing is left on record.
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A", second: 1 }); await drain()
      await act({ kind: "check", mode: "adoption-cancelled", value: 0 })
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A///loop" })
      await act({ kind: "loss" }); await act({ kind: "dispose" }); await drain()
      await act({ kind: "reset-fixture" }); await act({ kind: "start" }); await drain()
      await act({ kind: "check", mode: "adoption-cancelled", value: 2 })
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A///loop" })
      await act({ kind: "drop-intents" }); await drain()
      await act({ kind: "check", mode: "adoption-cancelled", value: 1 })
      // Asked for again while the cancelled attempt is still applying its loop: only the new ask compiles and is adopted.
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A" })
      await act({ kind: "drop-intents" })
      await act({ kind: "submit-schedule", mode: "B///loop" }); await drain()
      await act({ kind: "check", mode: "adoption-cancelled", value: 3 })
      // Replaced while compiling: the cancelled attempt's unwinding does not take the replacement's place.
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A///loop" })
      await heldCompile()
      await act({ kind: "replace-schedule", mode: "C///loop" }); await drain()
      await act({ kind: "check", mode: "adoption-cancelled", value: 4 })
    } else if (options.scenario === "publication-cancel-handoff") {
      // The intents are dropped once native promoted the publication and the controller was handed its proof, at every
      // microtask turn from there until the owner settled the attempt (the publication's cleanup and the queue's and the
      // attempt's continuations in between): the caller is told `adopted`, whatever the turn.
      for (let turns = 0; turns < handoffSweep; turns++) {
        if (turns) { await act({ kind: "reset-fixture" }); await act({ kind: "start" }); await drain() }
        await act({ kind: "sample", value: 1 })
        await act({ kind: "mark-compiles" })
        await act({ kind: "arm-handoff-drop", value: turns })
        await act({ kind: "submit-schedule", mode: "A" }); await drain()
        await act({ kind: "check", mode: "publication-cancelled", value: 3 })
        if (turns === 0 || turns === handoffSweep - 1) await act({ kind: "check", mode: "handoff-coverage", value: turns ? 1 : 0 })
      }
    } else if (options.scenario?.startsWith("publication-cancel-")) {
      // The intents are dropped while the attempt's publication is under way, at: `unclaimed` (native's Prepare is the first
      // command pending), `staged` (Prepare answered, the bank not yet asked to publish), `queued` (the publication still waits
      // behind a flush that holds the transport queue), `claimed` (a callback claimed the publication). Native never publishes
      // what was dropped before its claim, what was staged is released, and the caller is told `superseded` only then; a
      // claimed publication is native's, so its attempt ends with what native did.
      const at = ["unclaimed", "staged", "queued", "claimed"].indexOf(options.scenario.slice("publication-cancel-".length))
      const reach = async (name: string, reached: () => boolean) => {
        for (let index = 0; index < options.drainSteps && !reached(); index++) {
          const next = fairAction()
          if (!next) break
          await act(next)
        }
        if (!reached()) throw new Error(`Never reached ${name}`)
      }
      await act({ kind: "sample", value: 1 })
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A" })
      const held = await heldCompile()
      // A structural patch takes the transport queue before the compile is let go,
      // and holds it: its native reply is not delivered. Mapped batches use a separate lane.
      if (at === 2) {
        await act({ kind: "utility-swap", value: 1 })
        await act({ kind: "gain", value: -9 }); await fixture.checkpoint()
      }
      await act(held)
      for (let index = 0; index < 200; index++) await Promise.resolve()
      if (at === 0) {
        if (!fixture.state().commands.some((command) => command.name === "prepare")) throw new Error("Never reached the pending Prepare")
      }
      if (at === 1) await reach("a staged bank", () => fixture.state().preparedRevision !== undefined && !fixture.state().counts.publish)
      if (at === 3) await reach("a claimed publication", () => fixture.state().publicationClaimed)
      await act({ kind: "drop-intents" }); await drain()
      await act({ kind: "check", mode: "publication-cancelled", value: at })
    } else if (options.scenario?.startsWith("deferred-outcome-")) {
      // A callback claims A's publication; the pause/seek that ends the attempt reaches native after the acknowledgement, so
      // the cancellation's rollback is answered publish-pending and the transport request finds the graph promoted.
      const seek = options.scenario.startsWith("deferred-outcome-seek")
      const late = options.scenario.endsWith("-late") || options.scenario.endsWith("-deferred")
      const deferred = options.scenario.endsWith("-deferred")
      const unclaimed = options.scenario.endsWith("-unclaimed")
      await act({ kind: "sample", value: 1 })
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A" })
      await act(await heldCompile())
      for (let index = 0; index < 200; index++) await Promise.resolve()
      if (unclaimed) {
        // Native took the Publish and no callback has claimed it yet: the transport request cancels it.
        await executeNamed("prepare"); await deliverNamed("prepare")
        await bindSeam()
        await executeNamed("publish"); await deliverNamed("publish")
        if (!fixture.state().publicationPending || fixture.state().publicationClaimed) throw new Error("No unclaimed pending publication")
      } else {
        for (let index = 0; index < options.drainSteps && !fixture.state().publicationClaimed; index++) {
          const next = fairAction()
          if (!next) break
          await act(next)
        }
        if (!fixture.state().publicationClaimed) throw new Error("Never reached a claimed publication")
      }
      await act({ kind: seek ? "seek" : "pause" })
      // Late: native answers the cancellation's Inspect while it still holds the publication pending, then acknowledges.
      // Deferred: and its Rollback, which native also answers publish-pending, so the settlement waits for the transport ACK.
      if (late) { await executeNamed("inspect"); await deliverNamed("inspect") }
      if (deferred) { await executeNamed("rollback"); await deliverNamed("rollback") }
      if (!unclaimed) await act({ kind: "publication-acknowledge" })
      // A bounded run, not a drain: a stranded pause is the witness's failure, not the drain's generic one.
      for (let index = 0; index < 300; index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      await act({ kind: "check", mode: "deferred-outcome", value: seek ? 1 : 0 })
    } else if (options.scenario === "publish-reply-lost") {
      // Native takes the Publish, but its reply never reaches the controller (the revision deadline); a callback claims it
      // meanwhile. The controller cannot know the Publish was taken, only ask: native's answer is what the caller is told.
      await act({ kind: "sample", value: 1 })
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A" })
      await act(await heldCompile())
      await executeNamed("prepare"); await deliverNamed("prepare")
      await bindSeam()
      await executeNamed("publish")
      const deadline = fixture.enabled().find((action) => action.kind === "revision-deadline")
      if (!deadline) throw new Error("No revision deadline for the Publish")
      await act(deadline)
      for (let index = 0; index < 300; index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      await act({ kind: "check", mode: "deferred-outcome", value: 2 })
    } else if (options.scenario === "inspect-reply-lost" || options.scenario === "rollback-reply-lost") {
      // A callback claims A's publication and a pause ends the attempt. Native answers the controller's next request and the
      // answer never arrives (the revision deadline), so the controller cannot tell what native did and must ask again.
      // Inspect: the callback acknowledged first, so the Inspect promotes the graph and clears the publication; a Rollback
      // then finds nothing prepared (stale-revision). Rollback: native answered publish-pending while the publication was in
      // flight, the callback acknowledged afterwards, and the transport request's own Inspect promotes.
      const rollbackLost = options.scenario === "rollback-reply-lost"
      await act({ kind: "sample", value: 1 })
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A" })
      await act(await heldCompile())
      for (let index = 0; index < 200; index++) await Promise.resolve()
      for (let index = 0; index < options.drainSteps && !fixture.state().publicationClaimed; index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      if (!fixture.state().publicationClaimed) throw new Error("Never reached a claimed publication")
      await act({ kind: "pause" })
      if (rollbackLost) {
        await executeNamed("inspect"); await deliverNamed("inspect")
        await executeNamed("rollback")
      } else {
        await act({ kind: "publication-acknowledge" })
        await executeNamed("inspect")
      }
      const lostDeadline = fixture.enabled().find((action) => action.kind === "revision-deadline")
      if (!lostDeadline) throw new Error(`No revision deadline for the ${rollbackLost ? "Rollback" : "Inspect"}`)
      await act(lostDeadline)
      if (rollbackLost) await act({ kind: "publication-acknowledge" })
      for (let index = 0; index < 300; index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      await act({ kind: "check", mode: "deferred-outcome", value: rollbackLost ? 4 : 3 })
    } else if (options.scenario === "reclaim-held-by-retirement") {
      // A schedule publication removes a clip and the controller releases its asset. Native's ReclaimAssets does nothing
      // while the published predecessor's plan is unretired (audio-host.cpp:1708), and only a Retire or the next Prepare
      // retires it: the schedule path sends neither, so the clip's capacity must still come back once the fair drain ends.
      await act({ kind: "sample", value: 1 }); await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "sample", value: 0 }); await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" }); await drain()
      // The reader wake and a completed render block are all ReclaimAssets waits on besides the retirement.
      await act({ kind: "reclaim" }); await act({ kind: "render-block" }); await act({ kind: "reclaim" })
      // Rendering queues progress; it does not deliver the reader-readiness
      // observation or the product's resulting Retire/reply (rule iv).
      await act({ kind: "deliver-progress" }); await controlWork()
      await act({ kind: "reclaim" }); await act({ kind: "render-block" }); await act({ kind: "reclaim" })
      await act({ kind: "check", mode: "asset-reclaimed" })
    } else if (options.scenario === "adoption-aba" || options.scenario === "adoption-context") {
      // A compile is held. B asked for behind it, then the ask returns to A (aba), or the same key asked for with another
      // compile context (context): the intent that is no longer wanted is never compiled or published.
      const context = options.scenario === "adoption-context"
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A" })
      await heldCompile()
      if (context) await act({ kind: "submit-schedule", mode: "A/A/x" })
      else { await act({ kind: "submit-schedule", mode: "B" }); await act({ kind: "submit-schedule", mode: "A" }) }
      await drain()
      await act({ kind: "check", mode: context ? "adoption-context" : "adoption-aba" })
    } else if (options.scenario === "adoption-refusal-context" || options.scenario === "adoption-refusal-key") {
      // A asked for while its publication is under way; native refuses it for capacity. B asked for meanwhile has the same
      // schedule: another context is attempted (context); another key is answered with the refusal, and it, not A, is the
      // intent a returning capacity retries (key).
      const context = options.scenario === "adoption-refusal-context"
      await act({ kind: "sample", value: 1 }); await act({ kind: "block-asset" })
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A/S" })
      await act(await heldCompile())
      await act({ kind: "submit-schedule", mode: context ? "B/S/x" : "B/S" }); await drain()
      await act({ kind: "check", mode: "adoption-refusal", value: context ? 0 : 1 })
      // Native's capacity returns: the one retry is of B, the intent the refusal now stands for, and native publishes it. B of
      // another key compiles again, B of another context publishes the candidate its own refused attempt retained.
      await act({ kind: "block-asset", value: 0 }); await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" })
      await drain()
      await act({ kind: "check", mode: "adoption-refusal", value: 3 })
    } else if (options.scenario === "adoption-explicit-upgrade") {
      // B was refused. A is compiling when B is asked for again, plainly and then explicitly: the explicit ask is the
      // one queued, so B is attempted again, and published once native accepts it, instead of answered with the standing refusal.
      await act({ kind: "sample", value: 1 }); await act({ kind: "block-asset" })
      await act({ kind: "submit-schedule", mode: "B///" }); await drain()
      await act({ kind: "block-asset", value: 0 })
      await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "A" })
      await heldCompile()
      await act({ kind: "submit-schedule", mode: "B" }); await act({ kind: "submit-schedule", mode: "B", value: 1 }); await drain()
      await act({ kind: "check", mode: "adoption-refusal", value: 2 })
    } else if (options.scenario === "parked-latency") {
      // Seed 4's prefix with the parked witness replaced: a candidate native refused for clip capacity is parked while a
      // spectral FFT change is asked for. The latency reaches native at unchanged clip capacity; the explicit retry then
      // publishes the candidate once, over the latency, and the leases balance.
      await act({ kind: "sample", value: 1 }); await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "block-asset", value: 1 }); await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "mark-compiles" })
      await act({ kind: "latency", value: 2048, sequence: 20 }); await drain()
      await act({ kind: "check", mode: "parked-settled" })
      await act({ kind: "mark-compiles" })
      await act({ kind: "block-asset", value: 0 }); await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" })
      await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "check", mode: "parked-recovered" })
      await act({ kind: "check" })
    } else if (options.scenario === "parked-owner") {
      // The owner's path with a processor-only latency edit while parked: the refused schedule is attempted again once, by
      // the wake alone (no explicit publication follows), reusing its retained candidate over the latest latency.
      await act({ kind: "sample", value: 1 }); await act({ kind: "block-asset", value: 1 })
      await act({ kind: "submit-schedule", mode: "A" }); await drain()
      await act({ kind: "mark-compiles" })
      await act({ kind: "latency", value: 2048, sequence: 20 }); await drain()
      await act({ kind: "check", mode: "parked-settled" })
      await act({ kind: "mark-compiles" })
      await act({ kind: "block-asset", value: 0 }); await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" })
      await drain()
      await completeLatency(); await drain()
      await act({ kind: "check", mode: "parked-recovered" })
      await act({ kind: "check" })
    } else if (options.scenario === "leases-invalid" || options.scenario === "leases-valid") {
      // The schedule's Stretch clip leases its artifact when it is compiled, so the candidate native refused holds the lease
      // while parked. Latency changed meanwhile either leaves the retained candidate valid (a processor edit, rebased and
      // published: its lease passes to the session untouched) or invalidates it (the attachment's declared latency: the
      // recovery disposes it, releasing its lease once, and compiles again).
      const invalid = options.scenario === "leases-invalid"
      // A storage request finishes on host macrotasks, between the scheduler's steps.
      const settle = () => drain(options.drainSteps, true, fixture.storage)
      await act({ kind: "sample", value: 1 }); await act({ kind: "block-asset", value: 1 })
      await act({ kind: "submit-schedule", mode: "A" }); await settle()
      await act({ kind: "mark-compiles" })
      await act({ kind: "latency", value: 2048, sequence: 20 }); await settle()
      if (invalid) { await act({ kind: "attachment-latency", value: 2048 }); await settle() }
      await act({ kind: "check", mode: "leases-parked" })
      await act({ kind: "mark-compiles" })
      await act({ kind: "block-asset", value: 0 }); await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" })
      await settle()
      await completeLatency(); await settle()
      await act({ kind: "check", mode: "leases-recovered", value: invalid ? 1 : 0 })
      await settle()
      // Ending the session releases the one lease still held: every lease acquired was released once.
      await act({ kind: "dispose" }); await settle()
      await act({ kind: "check", mode: "leases-balanced" })

    } else if (options.scenario === "hold-dispose") {
      // A direct prepare stages a candidate that holds a latency edit back (it is the next graph). Disposing it unpublished
      // releases the hold, and nothing but that disposal sends the edit to native: no progress frame reaches the controller.
      await act({ kind: "prepare-candidate" }); await drain()
      const preparesBefore = fixture.state().counts.prepare ?? 0
      progressWithheld = true
      await act({ kind: "latency", value: 2048, sequence: 20 })
      for (let index = 0; index < 20; index++) await act({ kind: "render-block" })
      if ((fixture.state().counts.prepare ?? 0) !== preparesBefore) throw new Error("The staged candidate did not hold the latency back")
      await act({ kind: "dispose-candidate" })
      for (let index = 0; index < 60; index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      await act({ kind: "check", mode: "hold-released", value: (fixture.state().counts.prepare ?? 0) > preparesBefore ? 1 : 0 })
      progressWithheld = false
      await drain()
      await act({ kind: "check" })
    } else if (options.scenario === "parked-hold") {
      // The recovery attempt has frozen its graph when another latency is asked for: it waits for the attempt (a running
      // adoption holds latency) and the attempt settling is what starts it, with no progress frame to look again.
      await act({ kind: "sample", value: 1 }); await act({ kind: "block-asset", value: 1 })
      await act({ kind: "submit-schedule", mode: "A" }); await drain()
      progressWithheld = true
      await act({ kind: "block-asset", value: 0 }); await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" })
      const attempted = await reachNamed("publish")
      await act({ kind: "check", mode: "recovery-reached", value: attempted ? 1 : 0 })
      if (attempted) {
        if (!fixture.adoptionRunning()) throw new Error("The recovery attempt was not running at its publication")
        await act({ kind: "latency", value: 2048, sequence: 20 })
        const preparesBeforeReply = fixture.state().counts.prepare ?? 0
        progressWithheld = false
        await deliverNamed("publish")
        for (let index = 0; index < options.drainSteps && fixture.adoptionRunning(); index++) {
          const next = fairAction()
          if (!next) break
          await act(next)
        }
        if (fixture.adoptionRunning()) throw new Error("The recovery attempt never settled")
        // Native keeps rendering but no progress frame reaches the controller again.
        progressWithheld = true
        for (let index = 0; index < 60; index++) {
          const next = fairAction()
          if (!next) break
          await act(next)
        }
        await act({ kind: "check", mode: "hold-released", value: (fixture.state().counts.prepare ?? 0) > preparesBeforeReply ? 1 : 0 })
      }
      progressWithheld = false
      await drain()
      if (attempted) await act({ kind: "check" })
    } else if (options.scenario === "parked-rebase") {
      // The hook's path: an intent refused for clip capacity is parked in the owner with its compiled candidate, then the
      // processor's FFT and the attachment's declared latency both change. Both reach native while it is parked, without
      // restarting its refusal; the capacity returning buys one attempt whose graph carries the processor state and the PDC
      // of both.
      await act({ kind: "sample", value: 1 }); await act({ kind: "block-asset", value: 1 })
      await act({ kind: "submit-schedule", mode: "A" }); await drain()
      await act({ kind: "mark-compiles" })
      await act({ kind: "latency", value: 2048, sequence: 20 }); await drain()
      await act({ kind: "check", mode: "parked-settled" })
      await act({ kind: "attachment-latency", value: 2048 }); await drain()
      await act({ kind: "check", mode: "parked-settled" })
      await act({ kind: "mark-compiles" })
      await act({ kind: "block-asset", value: 0 }); await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" })
      await drain()
      await completeLatency(); await drain()
      await act({ kind: "check", mode: "parked-recovered" })
    } else if (options.scenario === "content-rejection") {
      // Native refuses the content A compiled. B, another key, compiles the same content under the same facts: refused
      // without native seeing it again.
      await act({ kind: "content-fingerprint", value: 1 }); await act({ kind: "reject-prepare" })
      await act({ kind: "submit-schedule", mode: "A" }); await drain()
      await act({ kind: "reject-prepare", value: 0 }); await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "B" }); await drain()
      await act({ kind: "check", mode: "content-rejected" })
    } else if (options.scenario === "content-rejection-explicit") {
      // As above, but B is asked for explicitly while its plain ask is compiling: the explicit ask forgets the refusal.
      await act({ kind: "content-fingerprint", value: 1 }); await act({ kind: "reject-prepare" })
      await act({ kind: "submit-schedule", mode: "A" }); await drain()
      await act({ kind: "reject-prepare", value: 0 }); await act({ kind: "mark-compiles" })
      await act({ kind: "submit-schedule", mode: "B" })
      await heldCompile()
      await act({ kind: "submit-schedule", mode: "B", value: 1 }); await drain()
      await act({ kind: "check", mode: "content-rejected", value: 1 })
    } else if (options.scenario === "late-inspect") {
      // A latency transition is in flight while a preview is open: the Inspect that completes it must leave the preview's value alone.
      await act({ kind: "latency", value: 2048 })
      for (let index = 0; index < options.drainSteps && !(fixture.state().latencyReadyEpoch !== undefined && !fixture.state().pendingControl); index++) {
        const next = fairAction()
        if (!next) break
        await act(next)
      }
      if (fixture.state().latencyReadyEpoch === undefined) throw new Error("Late-Inspect window never opened")
      // The window is open: published, its Inspect not yet answered. A gesture that starts now is applied live, not at its flush.
      await act({ kind: "preview", value: -9 }); await drain()
      await act({ kind: "check", mode: "preview-held" })
      await act({ kind: "inspect-latency" }); await executeNamed("inspect"); await deliverNamed("inspect"); await drain()
      await act({ kind: "check", mode: "preview-held" })
    } else if (options.scenario === "rollback-values") {
      await act({ kind: "registry-replace" })
      await act({ kind: "check", mode: "rollback-values" })
    } else if (options.scenario === "ledger-inclusion") {
      // Edits land after the candidate compiled and before Prepare freezes its
      // bytes: both the mapped gain and the state-only FFT must be in them.
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "gain", value: -3, sequence: 10 })
      // Whole mapped edits now use parameters. Native refuses Prepare while that
      // admitted control batch is queued, so apply it before asking to freeze the candidate.
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
      await act({ kind: "latency", value: 2048, sequence: 11 })
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare")
      await act({ kind: "check", mode: "inclusion" })
      await drain(); await act({ kind: "check" })
    } else if (options.scenario === "ledger-incarnation") {
      // The first incarnation's edit carries an order beyond every later one.
      // The instance is removed and re-added before any publication, so its
      // desired is still in the ledger when the new incarnation's first
      // candidate is rebased and its first edit arrives.
      await act({ kind: "registry-setup" })
      await act({ kind: "preview", value: -9, sequence: 10, mode: "ahead" }); await drain()
      await act({ kind: "membership", value: 0 })
      await act({ kind: "membership", value: 1 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "check", mode: "incarnation" })
      await act({ kind: "gain", value: -4, sequence: 20 }); await drain()
      await act({ kind: "check" })
      await act({ kind: "check", mode: "incarnation" })
    } else if (options.scenario === "prefix-12") {
      await act({ kind: "preview", value: -2, sequence: 5 }); await drain()
      // Admit while the renderer target is live. Apply on the old graph but
      // withhold its progress proof across the native removal publication.
      await act({ kind: "flush", value: -3, sequence: 10 })
      await executeNamed("parameters"); await deliverNamed("parameters")
      await act({ kind: "capture-boundary" })
      await act({ kind: "render-block" })
      // A newer structural edit is also initiated while the member is live.
      // It queues behind the admitted flush without providing its progress proof.
      await act({ kind: "utility-swap", value: 1 })
      await act({ kind: "gain", value: -5, sequence: 11 })
      await act({ kind: "membership", value: 0 })
      await act({ kind: "prepare-candidate" }); await act(await heldCompile())
      await act({ kind: "publish-candidate" })
      await executeNamed("prepare"); await deliverNamed("prepare")
      await bindSeam()
      await executeNamed("publish"); await deliverNamed("publish")
      for (let index = 0; index < options.drainSteps && fixture.state().frame < fixture.state().seam; index++)
        await act({ kind: "render-block" })
      await act({ kind: "render-block" })
      await act({ kind: "publication-acknowledge" })
      await drain()
      await act({ kind: "check", mode: "removed" })
      await act({ kind: "membership", value: 1 })
      await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "check", mode: "fresh-incarnation" })
      await act({ kind: "check" })
      await act({ kind: "flush", value: -9, sequence: 20 }); await drain()
      await act({ kind: "check" })
      await act({ kind: "check", mode: "prefix-12" })
    } else if (options.scenario?.startsWith("identity-")) {
      await act({ kind: "preview", value: -3, sequence: 10 }); await drain()
      await act({ kind: "identity-baseline" })
      await act({ kind: "flush", value: options.scenario === "identity-same" ? -3 : -9,
        sequence: options.scenario === "identity-same" ? 10 : 11 }); await drain()
      await act({ kind: "check", mode: options.scenario })
    } else if (options.scenario === "graph-cache") {
      await act({ kind: "flush", value: -2, sequence: 10 }); await drain()
      await act({ kind: "latency", value: 2048, sequence: 11 }); await drain()
      await act({ kind: "check" })
    } else if (seed === 1) {
      const before = fixture.state().counts
      await act({ kind: "gain", value: 0, sequence: 1 }); await drain()
      await act({ kind: "freeze" })
      for (let index = 0; index < 25; index++) {
        const progress = fixture.enabled().find((action) => action.kind === "deliver-progress")
        if (progress) await act(progress)
      }
      await act({ kind: "check", mode: "quiescent" })
      record({ witness: "noop", before, after: fixture.state().counts, hook: "deferred-to-A2" })
    } else if (seed === 2 || plant === "stale-overwrite") {
      await act({ kind: "preview", value: -3, sequence: 10 }); await executeNamed("parameters")
      if (!options.unfairHost) await deliverNamed("parameters")
      await act({ kind: "preview", value: -12, sequence: 11 }); await executeNamed("parameters")
      await act({ kind: "render-block" })
      await act({ kind: "confirm" })
      await deliverNamed("parameters", true)
      if (options.unfairHost) await deliverNamed("parameters")
      record({ witness: "seed-2-reversed-replies", status: options.unfairHost ? "fake-only" : "not-exercised" })
      // The mutation isolates the broken completion wrapper. Without the
      // mutation this immediate check passes; the baseline then probes the
      // product's lowered accepted-order watermark with an intermediate edit.
      if (plant !== "stale-overwrite") {
        await act({ kind: "gain", value: -6, sequence: 10 }); await drain()
      } else {
        // Delivery now settles from actual proof, not the old admission ACK. Drain
        // that proof before asking the unchanged convergence/stale-content oracle.
        await drain()
      }
      await act({ kind: "check" })
      await act({ kind: "flush", value: -12, sequence: 11 }); await drain()
    } else if (seed === 3) {
      for (const floor of [10, 11]) {
        if (floor === 11) {
          await act({ kind: "loss" }); await act({ kind: "dispose" }); await drain()
          await act({ kind: "reset-fixture" }); await act({ kind: "start" }); await drain()
        }
        await act({ kind: "compile-floor", value: floor })
        await act({ kind: "prepare-candidate" }); await drain()
        await act({ kind: "gain", value: -3, sequence: 11 }); await drain()
        await act({ kind: "publish-candidate" }); await executeNamed("prepare")
        await act({ kind: "gain", value: -12, sequence: 11 })
        await drain(); await act({ kind: "check" })
      }
    } else if (seed === 4) {
      await act({ kind: "sample", value: 1 }); await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "block-asset", value: 1 }); await act({ kind: "publish-candidate" }); await drain()
      // The direct path: a refused candidate is parked while latency changes at unchanged clip capacity; the capacity
      // returning, one publication of that candidate carries the latency.
      await act({ kind: "mark-compiles" })
      const capacityBefore = fixture.state().capacityGeneration
      await act({ kind: "latency", value: 2048, sequence: 20 })
      await drain()
      await completeLatency(); await drain()
      record({ witness: "parked-independent-latency", capacityBefore, capacityAfter: fixture.state().capacityGeneration })
      await act({ kind: "check", mode: "parked-settled" })
      await act({ kind: "mark-compiles" })
      await act({ kind: "block-asset", value: 0 }); await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" })
      await act({ kind: "publish-candidate" }); await drain()
      await act({ kind: "check", mode: "parked-recovered" })
      await act({ kind: "check" })
      // Release acknowledgement alone cannot grant a capacity opportunity.
      const capacityRecovered = fixture.state().capacityGeneration
      await act({ kind: "release-asset" }); await drain()
      record({ witness: "release-ack-not-reclamation", before: capacityRecovered, after: fixture.state().capacityGeneration })
      if (fixture.state().capacityGeneration > capacityRecovered)
        throw new Error("Seed 4 reclaimed an asset while the predecessor plan was unretired")
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await controlWork()
      const retiresBeforeRemoval = fixture.state().counts.retire ?? 0
      await act({ kind: "sample", value: 0 }); await act({ kind: "prepare-candidate" }); await drain()
      await act({ kind: "publish-candidate" }); await drain()
      // Product retirement replaces the old manual-Retire control (rule ii).
      // Deliver the actual reader observation before checking its proof.
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await controlWork()
      record({ witness: "seed4-product-retirement", state: fixture.state() })
      if (fixture.state().retiredRevision !== undefined || (fixture.state().counts.retire ?? 0) - retiresBeforeRemoval !== 2)
        throw new Error("Seed 4 did not witness product retirement")
      await act({ kind: "deliver-progress" }); await controlWork()
      if ((fixture.state().counts.retire ?? 0) - retiresBeforeRemoval !== 2)
        throw new Error("Seed 4 repeated product retirement after proof")
      await act({ kind: "reclaim" }); await act({ kind: "render-block" }); await act({ kind: "reclaim" })
      if (fixture.state().capacityGeneration <= capacityRecovered)
        throw new Error("Seed 4 did not witness real resource reclamation")
    } else if (seed === 5) {
      // Each patch outcome needs a genuine structural edit; gain-only whole edits use the parameter carrier.
      await act({ kind: "utility-swap", value: 1 })
      await act({ kind: "patch-mode", mode: "reject" }); await act({ kind: "gain", value: -3 }); await drain()
      record({ witness: "rejected-before-claim", state: fixture.state() })
      await act({ kind: "utility-swap", value: 0 })
      await act({ kind: "patch-mode", mode: "negative" }); await act({ kind: "gain", value: -9 }); await drain()
      record({ witness: "claimed-negative", state: fixture.state() })
      await act({ kind: "utility-swap", value: 1 })
      await act({ kind: "patch-mode", mode: "lost" }); await act({ kind: "gain", value: -12 })
      await executeNamed("patch")
      await act({ kind: "render-block" }); await act({ kind: "render-block" }); await act({ kind: "loss" })
      // No progress, commands or replies after loss: promises alone may settle.
      await fixture.checkpoint(); await act({ kind: "check", mode: "terminal" })
    } else if (seed === 7) {
      for (const terminal of ["pause", "seek", "loss"]) {
        if (terminal !== "pause") {
          await act({ kind: "loss" }); await act({ kind: "dispose" }); await drain()
          await act({ kind: "reset-fixture" }); await act({ kind: "start" }); await drain()
        }
        await act({ kind: "latency", value: 2048 })
        await executeNamed("publish"); await deliverNamed("publish")
        const frame = fixture.state().frame
        await act({ kind: terminal }); await fixture.checkpoint()
        const immediate = fixture.state()
        record({ witness: "seed7-lane-release", terminal, frame, pending: immediate.pendingControl, queued: immediate.queuedSends })
        await act({ kind: "check", mode: "transport-lane" })
        // D2: only real control execute/reply events, never a callback or progress.
        // Native claim/ACK proof is still required for any claimed publication.
        for (let control = 0; control < 64; control++) {
          const action = fixture.enabled().find(entry => entry.kind === "control-wake" || entry.kind === "deliver-reply")
          if (!action) break
          record({ witness: "seed7-control-proof", terminal, frame: fixture.state().frame, action })
          await act(action)
        }
        if (fixture.state().frame !== frame) throw new Error("Seed7 control-only drain advanced the render frame")
        await act({ kind: "check", mode: "terminal" })
      }
    } else if (seed === 8) {
      await act({ kind: "reject-prepare", value: 1 })
      await act({ kind: "submit-schedule" }); await drain()
      await act({ kind: "capture-ownership" })
      const ownershipBefore = fixture.state().counts.prepare
      for (let index = 0; index < 25; index++) {
        await act({ kind: "gain", value: -1 - index % 12 }); await drain()
        await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
      }
      record({ witness: "persistent-adoption", prepareBefore: ownershipBefore, prepareAfter: fixture.state().counts.prepare,
        hookRetryBudget: "deferred-to-A2" })
      await act({ kind: "check", mode: "retry-budget" })
      await act({ kind: "reject-prepare", value: 0 })
    }
    if (seed === 5 || seed === 7) {
      await act({ kind: "loss" }); await act({ kind: "dispose" }); await drain()
      await act({ kind: "reset-fixture" }); await act({ kind: "start" }); await drain()
    }
    if (!options.scenario?.startsWith("prefix-") && !options.scenario?.startsWith("identity-")
      && !["pause-latency", "paused-flush", "attachment", "transport-mismatch", "urgent-epoch-drop", "retained-drift", ...historyScenarios, ...attachmentScenarios, ...endingScenarios, ...patchScenarios, ...adoptionScenarios, ...parkedScenarios, ...publicationScenarios, "synth-replaced", "rollback-values"].includes(options.scenario ?? "") && !plant) {
      const random = randomFor(seed)
      let sequence = 100
      for (let index = 0; index < options.steps; index++) {
        // Deadline fault injection is explicit/replayable, not part of the
        // healthy-host random campaign. Otherwise host death would make its
        // desired-vs-live convergence checks meaningless.
        const enabled = fixture.enabled().filter((action) => action.kind !== "revision-deadline" && action.kind !== "control-watchdog")
        const choice = random()
        if (choice < 0.02) await act({ kind: "gain", value: -Math.floor(random() * 24), sequence: ++sequence })
        else if (choice < 0.025) await act({ kind: random() < 0.5 ? "preview" : "flush",
          value: -Math.floor(random() * 24), sequence: ++sequence })
        else if (choice < 0.035 && fixture.pending().length === 0)
          await act({ kind: "latency", value: random() < 0.5 ? 512 : 2048, sequence: ++sequence })
        else {
          const selected = enabled[Math.floor(random() * enabled.length)]
          if (selected) await act(selected)
        }
      }
      await drain()
      // A caller can now settle before the final rendered frame is delivered.
      // Observe that real frame and its control replies before freezing counts;
      // the unchanged I6 check still rejects work from repeated identical input.
      await act({ kind: "deliver-progress" }); await controlWork(); await drain()
      await act({ kind: "check", mode: "drained" })
      await act({ kind: "freeze" })
      for (let index = 0; index < 25; index++) {
        const progress = fixture.enabled().find((action) => action.kind === "deliver-progress")
        if (progress) await act({ ...progress, mode: index % 2 === 0 ? "legacy" : undefined })
      }
      await act({ kind: "check", mode: "quiescent" })
    }
    // No implicit rescue of the parked latency witness or terminal witness.
    record({ event: "before-cleanup", state: fixture.state() })
    if (plant === "never-wake-latency") await act({ kind: "release-mutation-waiter" })
    await act({ kind: "loss" }); await act({ kind: "dispose" })
    await drain(options.drainSteps, true, stretchScenarios.includes(options.scenario ?? "") ? fixture.storage : undefined)
  }
  for (const [invariant, count] of Object.entries(fixture.state().checks))
    checks.set(invariant, (checks.get(invariant) ?? 0) + count)
  if (yielded) {
    const failure = { step, invariant: "time-ownership", detail: "Real macrotask sentinel fired during seed", domain: "harness" }
    failuresAt.push(failure); record({ event: "failure", ...failure })
  }
  const metrics = [...archivedMetrics, fixture.state().metrics]
  const candidateStatuses: Record<string, number> = {}
  for (const entry of metrics) for (const [status, count] of Object.entries(entry.candidateStatuses))
    candidateStatuses[status] = (candidateStatuses[status] ?? 0) + count
  return { seed, failures: failuresAt, divergentStates, actions, checks: Object.fromEntries(checks), state: fixture.state(), beforeCleanup,
    rejections: [...archivedRejections, ...fixture.state().rejectionClasses],
    metrics: { minimumCoverageBlocks: Math.min(...metrics.flatMap((entry) => entry.minimumCoverageBlocks === undefined ? [] : [entry.minimumCoverageBlocks])),
      candidateStatuses, populatedOwnershipChecks: metrics.reduce((sum, entry) => sum + entry.populatedOwnershipChecks, 0) } }
  } finally { clock?.restore(); clearTimeout(sentinel) }
}

// Dependency-invalid removals are rejected, never repaired into cooperative
// schedules. Bound both replay count and action count.
async function minimize(run: Run, plant: Defect | undefined, failure = run.failures[0]) {
  const signature = failure?.invariant
  const detailClass = failure?.detail.split(":")[0]
  if (!signature) return { status: "no-failure", seed: run.seed, actions: [] }
  let best = run.actions.slice(0, failure?.step)
  let attempts = 0
  let verified = false
  const reproduces = async (actions: Action[]) => {
    if (actions.length > 10_000 || attempts++ >= 200) return undefined
    try {
      const result = await runSeed(run.seed, plant, undefined, actions, true)
      return result.failures.some((entry) => entry.invariant === signature && entry.detail.split(":")[0] === detailClass)
        ? result.actions : undefined
    } catch { return undefined }
  }
  const initial = await reproduces(best)
  verified = initial !== undefined
  if (initial) best = initial
  else best = run.actions
  // First remove idle telemetry/render spans, retaining enough callbacks for
  // publications and fair-drain witnesses. Then drop independent producers
  // with their absent command/reply descendants.
  for (const kind of ["deliver-progress", "render-block"]) {
    for (let size = 512; size >= 1 && attempts < 100; size = Math.floor(size / 2)) {
      const indices = best.flatMap((action, index) => action.kind === kind ? [index] : [])
      for (let start = 0; start < indices.length && attempts < 100; start += size) {
        const removed = new Set(indices.slice(start, start + size))
        const reduced = await reproduces(best.filter((_action, index) => !removed.has(index)))
        if (reduced) { best = reduced; verified = true }
      }
    }
  }
  for (const action of best) {
    if (attempts >= 140) break
    if (!["gain", "preview", "flush", "latency"].includes(action.kind)) continue
    const reduced = await reproduces(best.filter((entry) => entry !== action))
    if (reduced) { best = reduced; verified = true }
  }
  for (let chunk = Math.floor(best.length / 2); chunk >= 1 && attempts < 200; chunk = Math.floor(chunk / 2)) {
    for (let index = 0; index + chunk <= best.length && attempts < 200; index += chunk) {
      const candidate = [...best.slice(0, index), ...best.slice(index + chunk)]
      const reduced = await reproduces(candidate)
      if (reduced) { best = reduced; verified = true; index -= chunk }
    }
  }
  return { status: verified ? "verified-bounded-reduction" : "unverified", seed: run.seed, plant,
    invariant: signature, detail: failure?.detail, attempts, originalActions: run.actions.length, actions: best }
}

async function minimizeWitness(run: Run) {
  const witness = options.scenario
  if (witness && ["pause-latency", "paused-flush", "attachment"].includes(witness)) {
    const end = run.actions.findLastIndex((action) => action.kind === "check" && action.mode === witness)
    const actions = run.actions.slice(0, end + 1)
    const verified = await runSeed(run.seed, undefined, undefined, actions)
    if (JSON.stringify(verified.failures.map((failure) => failure.class)) !== JSON.stringify(run.failures.map((failure) => failure.class)))
      throw new Error("A2b witness changed failure signature")
    return { status: "verified-teardown-only-reduction", seed: run.seed, actions }
  }
  if (witness !== "prefix-11" && witness !== "prefix-12") return undefined
  const end = run.actions.findIndex((action) => action.kind === "check" && action.mode === witness)
  if (end < 0) throw new Error("Missing semantic prefix check")
  let best = run.actions.slice(0, end + 1)
  let attempts = 0
  for (const kind of ["deliver-progress", "render-block"]) {
    for (let index = 0; index < best.length && attempts < 200; index++) {
      if (best[index]?.kind !== kind) continue
      const candidate = best.filter((_action, cursor) => cursor !== index)
      attempts++
      try {
        const reduced = await runSeed(run.seed, undefined, undefined, candidate, true)
        if (reduced.actions.some((action) => action.mode === witness)
          && (witness === "prefix-12" ? reduced.failures.length === 0
            : reduced.failures.some((failure) => failure.invariant === "I3"))) {
          best = reduced.actions; index--
        }
      } catch { /* Dependency-invalid removals do not preserve a witness. */ }
    }
  }
  await runSeed(run.seed, undefined, undefined, best)
  return { status: "verified-semantic-prefix", seed: run.seed, witness, attempts,
    originalActions: run.actions.length, actions: best }
}
mkdirSync(options.out, { recursive: true })
const classesPath = path.join(options.out, "classes.json")
if (!options.gate || !existsSync(classesPath)) writeJson(classesPath, classTable)
const replay = options.replay ? replaySchema.parse(JSON.parse(readFileSync(options.replay, "utf8"))) : undefined
if (replay?.unfairHost) options.unfairHost = true
const summaries = []
for (let offset = 0; offset < (replay ? 1 : options.seeds); offset++) {
  const seed = replay?.seed ?? options.seed + offset
  const plant = replay?.plant ?? options.plant
  const directory = path.join(options.out, `seed-${seed}`)
  mkdirSync(directory, { recursive: true })
  const trace = createSeedTrace(options.trace, directory, (value) => `${stringify(value, 2)}\n`)
  trace.seed({ seed, generatorVersion, fixture: "controller", head, sourceHashes,
    bounds: { steps: options.steps, drainSteps: options.drainSteps, checkpointTurns: 100 }, plant, scenario: options.scenario,
    unfairHost: options.unfairHost ?? false })
  try {
    const result = await runSeed(seed, plant, trace, replay?.actions)
    const status = result.failures.length ? "fail" : "pass"
    for (const failure of result.failures) {
      if (failure.class === "retained-override" && result.failures.some((entry) => entry.invariant === "I4"))
        failure.class = "latency-starvation"
      if ((failure.class === "retained-override" || failure.class === "transient-overwrite")
        && result.failures.some((entry) => entry.invariant === "I2")
        && result.failures.some((entry) => entry.invariant === "I1" && entry.detail.includes("Native differs")))
        failure.class = "stale-patch-overwrite"
    }
    trace.replayable(status, "full-replay.json", { seed, plant, unfairHost: options.unfairHost ?? false, generatorVersion, sourceHashes, actions: result.actions })
    const minimized = replay ? { status: "exact-replay", seed, plant, actions: result.actions }
      : await minimizeWitness(result) ?? await minimize(result, plant)
    trace.replayable(status, "minimized.json", { ...minimized, unfairHost: options.unfairHost ?? false })
    if (!replay) for (const [index, failure] of result.failures.entries()) {
      if (index === 0) continue
      trace.replayable(status, `minimized-${index + 1}.json`, { ...await minimize(result, plant, failure), unfairHost: options.unfairHost ?? false })
    }
    trace.bulky(status, "final-state-diff.json", result.failures.length
      ? { failures: result.failures, divergences: result.divergentStates, teardown: result.beforeCleanup } : {})
    const summary = { seed, status, failures: result.failures, checks: result.checks,
      hostModel: options.unfairHost ? "fake-only-unfair" : "supervisor-serialized",
      reversedReplyBranch: seed === 2 ? options.unfairHost ? "fake-only" : "not-exercised" : "not-exercised",
      invariants: Object.fromEntries(["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"].map((invariant) =>
        [invariant, result.failures.some((failure) => failure.invariant === invariant) ? "fail"
          : (result.checks[invariant] ?? 0) > 0 ? "pass-observed-scope" : "not-exercised"])),
      firstDivergentStep: result.failures[0]?.step ?? null, logicalSteps: result.actions.length,
      pendingWaiters: result.state.waiters.filter((waiter) => !waiter.settled),
      firstDivergence: result.divergentStates[0],
      resources: result.state.assets,
      metrics: result.metrics, rejections: result.rejections,
      replayCommand: `perl -e 'alarm shift; exec @ARGV' 120 bun --conditions=browser ${path.join(root, "tools/acceptance/ae-08-processor-state-fuzz.ts")} --fixture controller --replay ${path.join(directory, "minimized.json")} --out ${directory}-replay` }
    summaries.push(summary); writeJson(path.join(directory, "summary.json"), summary)
    trace.finish(status)
    process.stdout.write(`seed ${seed}: ${summary.status} ${result.failures.map((failure) => failure.invariant).join(",")}\n`)
  } catch (error) {
    const summary = { seed, status: "harness-error", error: String(error) }
    summaries.push(summary); writeJson(path.join(directory, "summary.json"), summary)
    trace.finish(summary.status)
    process.stdout.write(`seed ${seed}: harness-error ${String(error)}\n`)
  }
}
writeJson(path.join(options.out, "summary.json"), { generatorVersion, fixture: "controller",
  deferred: { "1": "hook parts deferred-to-A2", "6": "deferred-to-A2", "8": "hook retry budget deferred-to-A2",
    "9": "deferred-to-A2", "10": "deferred-to-A2" }, seeds: summaries })
if (summaries.some((summary) => summary.status !== "pass")) process.exitCode = 1
if (options.gate) {
  const step = gateSteps.indexOf(options.gate)
  if (step < 0) throw new Error(`Unknown gate ${options.gate}`)
  const table = z.object({
    classes: z.array(z.object({ signature: z.string(), owner: z.string(), greenAfter: z.enum(gateSteps) })),
    prefixes: z.array(z.object({ scenario: z.string(), seed: z.number(), greenAfter: z.enum(gateSteps), defers: z.array(z.string()).optional() })),
  }).parse(JSON.parse(readFileSync(classesPath, "utf8")))
  const green = new Set(table.classes.filter((entry) => gateSteps.indexOf(entry.greenAfter) <= step).map((entry) => entry.signature))
  const gated = (failure: { class?: string }) => green.has(failure.class ?? "") || !table.classes.some((entry) => entry.signature === failure.class)
  const violations = summaries.flatMap((summary) => "failures" in summary
    ? summary.failures.filter(gated)
      .map((failure) => ({ seed: summary.seed, ...failure })) : [{ seed: summary.seed, step: 0,
        invariant: "harness", detail: summary.error, domain: "harness", class: "unclassified" }])
  const rejectionViolations = summaries.flatMap((summary) => "rejections" in summary
    ? summary.rejections.filter((entry) => entry.classification !== "cancelled" && green.has(entry.class ?? ""))
      .map((entry) => ({ seed: summary.seed, ...entry })) : [])
  const prefixes = []
  const scenario = options.scenario
  for (const prefix of table.prefixes) {
    options.scenario = prefix.scenario
    const prefixTrace = createSeedTrace(options.trace, path.join(options.out, "gate-prefixes", prefix.scenario), (value) => `${stringify(value, 2)}\n`)
    const result = await runSeed(prefix.seed, undefined, prefixTrace)
    prefixTrace.finish(result.failures.length ? "fail" : "pass")
    const requiredGreen = gateSteps.indexOf(prefix.greenAfter) <= step
    // A deferral covers only a class whose owner step comes after this gate: a due class fails the prefix.
    const deferred = (prefix.defers ?? []).filter((signature) => {
      const owner = table.classes.find((entry) => entry.signature === signature)
      if (!owner) throw new Error(`Prefix ${prefix.scenario} defers unknown class ${signature}`)
      return gateSteps.indexOf(owner.greenAfter) > step
    })
    prefixes.push({ ...prefix, requiredGreen, defers: deferred, failures: result.failures })
  }
  options.scenario = scenario
  const pass = summaries.length === 100 && !replay && !options.plant && !scenario && !options.unfairHost
    && !violations.length && !rejectionViolations.length
    && !prefixes.some((prefix) => prefix.requiredGreen && prefix.failures.some((failure) => !prefix.defers.includes(failure.class ?? ""))
      || prefix.failures.some(gated))
  writeJson(path.join(options.out, "gate.json"), { step: options.gate, pass, violations, rejectionViolations, prefixes,
    completeCampaign: summaries.length === 100 })
  process.exitCode = pass ? 0 : 1
}
