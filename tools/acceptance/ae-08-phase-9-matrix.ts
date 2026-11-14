#!/usr/bin/env bun
import { watch } from "node:fs"
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { ae08ControlCommitReceived } from "../../apps/desktop/ae08-evidence"
import { phase9Matrix, phase9Rows, type LatencyClass, type Row, type Settle } from "./ae-08-phase-9-rows"

// AE-08 phase 9 matrix (plan §8 steps 1-2): one packaged launch per row class carries N alternating edits. This file owns
// the burst schedule, settling on host evidence, publication spacing, the reference rule, fail-fast judging, pooled statistics,
// launch merging and the wall-time budget; the rows are declared in ae-08-phase-9-rows.ts. PCM comparison per oracle window is
// the `compare` callback: ae-08-phase-9-launch.ts builds it from the analyzer's judgeBurst. The runner (ae-08-live-graph.ts
// --phase 9) calls these; there is no second runner protocol.
//
//   bun tools/acceptance/ae-08-phase-9-matrix.ts --self-test
//   bun tools/acceptance/ae-08-phase-9-matrix.ts --plan [--repetitions N] [--vst-repetitions N]

export const repetitionsFor = (row: Row, repetitions: number, vstRepetitions: number) =>
  row.repeat === "single" || row.repeat === "launch" ? 1 : row.repeat === "vst-burst" ? vstRepetitions : repetitions

// A burst always ends on the row's start state: it is rounded up to whole cycles.
export const burstSchedule = (row: Row, repetitions: number) =>
  Array.from({ length: Math.ceil(repetitions / row.cycle.length) }).flatMap((_, round) =>
    row.cycle.map((step, position) => ({ index: round * row.cycle.length + position + 1, ...step })))

// Rows share a launch only where one fixture, class, preparation and device build both, and the state after one row's burst is the
// next row's start. A row that repeats by launch is its own launch.
export const mergeLaunches = (rows: readonly Row[]) => rows.reduce<Row[][]>((launches, row) => {
  const last = launches.at(-1), tail = last?.at(-1)
  const joins = last && tail && tail.fixture !== null && tail.fixture === row.fixture && tail.latencyClass === row.latencyClass
    && tail.repeat === row.repeat && row.repeat !== "launch" && tail.periodSec === row.periodSec && tail.cycle.at(-1)?.state === row.start
    && String(tail.prepare) === String(row.prepare) && tail.device === row.device
  return joins ? [...launches.slice(0, -1), [...last, row]] : [...launches, [row]]
}, [])

// The launches of a run: a row that repeats by launch gives one launch per repetition.
export const launchesFor = (rows: readonly Row[], repetitions: number) => mergeLaunches(rows)
  .flatMap((launch) => launch.every((row) => row.repeat === "launch") ? Array.from({ length: repetitions }, () => launch) : [launch])
const burstOnly = (launch: readonly Row[]) => launch.every((row) => row.repeat === "launch")

// Seconds per launch, per edit and per VST edit. The defaults are plan §8's assumptions (about 2 s to settle plus the 1 s oracle window
// per edit, 20 s per VST insert) and the phase 8 smoke (about 10 s per launch plus import and reload); `--timings <evidence dir>`
// replaces them with what a real phase 9 run measured (`measuredTimings`).
export type Timings = { launchSeconds: number; stepSeconds: number; vstStepSeconds: number }
export const assumedTimings: Timings = { launchSeconds: 25, stepSeconds: 3, vstStepSeconds: 20 }
// The certifying budget of plan §13 answer 4.
export const BUDGET_SECONDS = 70 * 60
export const FALLBACK_VST_REPETITIONS = 10
const REFERENCE_PERIODS = 2

type Reference = { kind: "full-length"; seconds: number } | { kind: "per-state"; states: string[]; seconds: number }
export const referencePlan = (row: Row, steps: number, timings: Timings): Reference => row.periodSec === null
  ? { kind: "full-length", seconds: steps * (row.repeat === "vst-burst" ? timings.vstStepSeconds : timings.stepSeconds) }
  : { kind: "per-state", states: [...new Set(row.cycle.map((step) => step.state))], seconds: REFERENCE_PERIODS * row.periodSec }

// Launches in run order: each merged launch is a burst and then its no-edit reference of the burst's length, and the first launch
// of each latency class adds one no-edit duplicate (calibration) after them, because tolerance is calibrated once per class.
export type LaunchStep = { role: "burst" | "reference" | "calibration"; launch: number; latencyClass: LatencyClass }
export const launchPlan = (launches: readonly Row[][]): LaunchStep[] => {
  const calibrated = new Set<LatencyClass>()
  return launches.flatMap((launch, index) => {
    const latencyClass = launch[0]?.latencyClass
    if (latencyClass === undefined) return []
    // A launch judged on its own capture has no reference to compare with.
    const roles: LaunchStep["role"][] = burstOnly(launch) ? ["burst"] : calibrated.has(latencyClass) ? ["burst", "reference"] : ["burst", "reference", "calibration"]
    if (!burstOnly(launch)) calibrated.add(latencyClass)
    return roles.map((role) => ({ role, launch: index, latencyClass }))
  })
}

// A launch is its merged rows' bursts plus one reference launch (per state for periodic rows, one per state's seconds), and each
// latency class adds one calibration launch as long as its longest reference.
export const wallSeconds = (launches: readonly Row[][], repetitions: number, vstRepetitions: number, timings: Timings = assumedTimings) => {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const costs = launches.map((launch) => {
    const bursts = launch.map((row) => {
      const steps = burstSchedule(row, repetitionsFor(row, repetitions, vstRepetitions)).length
      return { steps, burst: steps * (row.repeat === "vst-burst" ? timings.vstStepSeconds : timings.stepSeconds), row }
    })
    const burst = sum(bursts.map((entry) => entry.burst))
    const first = bursts[0]
    const reference = first === undefined || burstOnly(launch) ? 0 : sum(bursts.map((entry) => {
      const plan = referencePlan(entry.row, entry.steps, timings)
      return plan.kind === "per-state" ? plan.states.length * plan.seconds : plan.seconds
    }))
    return { latencyClass: first?.row.latencyClass, burst, reference, launches: burstOnly(launch) ? 1 : 2 }
  })
  const longest = new Map<LatencyClass | undefined, number>()
  for (const cost of costs) if (cost.launches === 2) longest.set(cost.latencyClass, Math.max(longest.get(cost.latencyClass) ?? 0, cost.reference))
  return sum(costs.map((cost) => cost.launches * timings.launchSeconds + cost.burst + cost.reference))
    + sum([...longest.values()].map((reference) => timings.launchSeconds + reference))
}

// The certifying run keeps the requested VST repetitions unless the budget would exceed 70 min; then only the VST burst rows drop
// to 10 (the overnight run keeps its own count). Non-VST rows and aperiodic references are never shortened.
export const chooseVstRepetitions = (launches: readonly Row[][], repetitions: number, requested: number, timings: Timings) => {
  const minutes = (vstRepetitions: number) => wallSeconds(launches, repetitions, vstRepetitions, timings) / 60
  const requestedMinutes = minutes(requested)
  if (requestedMinutes <= BUDGET_SECONDS / 60 || requested <= FALLBACK_VST_REPETITIONS || !launches.some((launch) => launch.some((row) => row.repeat === "vst-burst")))
    return { vstRepetitions: requested, why: `${requested} VST repetitions: ${requestedMinutes.toFixed(1)} min fits ${BUDGET_SECONDS / 60} min or no VST burst row is selected` }
  return { vstRepetitions: FALLBACK_VST_REPETITIONS, why: `${requested} VST repetitions would take ${requestedMinutes.toFixed(1)} min, over ${BUDGET_SECONDS / 60} min: `
    + `the VST burst rows drop to ${FALLBACK_VST_REPETITIONS} (${minutes(FALLBACK_VST_REPETITIONS).toFixed(1)} min); the overnight run keeps ${requested}` }
}

// ---- Settling on host evidence ----
const hostEventSchema = z.object({ event: z.string(), cause: z.string().default(""), wallMs: z.number().default(0),
  revision: z.number().default(0), frame: z.number().default(0), publicationFrame: z.number().default(0), transportEpoch: z.number().default(0),
  idempotencyKey: z.string().default(""), open: z.boolean().optional() })
export type HostEvent = z.infer<typeof hostEventSchema>
export class SetupFailure extends Error {}

// A torn trailing line is a record still being written.
export const parseHostLines = (text: string) => text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean)
  .map((line) => hostEventSchema.parse(JSON.parse(line)))

// When the app received a commit: the main process logs control-commit-received with the commit's idempotency key
// (apps/desktop/ae08-evidence.ts) before the renderer sees it, so edit-to-publish excludes the CLI that sent the commit. The line is
// written before the commit's reply, so a returned commit has its line.
export const commitReceivedWallMs = async (out: string, idempotencyKey: string) => {
  const received = parseHostLines(await readFile(path.join(out, "host.jsonl"), "utf8"))
    .find((event) => event.event === "control-commit-received" && event.idempotencyKey === idempotencyKey)
  if (!received) throw new SetupFailure(`The app logged no control-commit-received line for commit ${idempotencyKey}`)
  return received.wallMs
}

// Publication-complete: the first in-place publication at or after the edit; for a raise also its latency-move-complete. `wallMs` is
// when it completed; `revision` and `publicationFrame` are the publication's own.
export type Settled = { wallMs: number; revision: number; publicationFrame: number }
// An edit that publishes no graph (a live parameter write: the built-in parameter mapper turns a Limiter lookahead change or a knob
// drag into one) settles on the line the host logs when the callback applies the parameter sequence while the transport runs; that
// line's `frame` stands for the publication frame (the transport frame it was logged at).
// A step that publishes no graph settles on another host line: the editor-open line, a plug-in fault line, or the applied sequence. It
// names no publication frame unless the host stamped one, and runBurst then takes the transport frame at its wall time.
const settledOn = (event: HostEvent | undefined): Settled | undefined => event && { wallMs: event.wallMs, revision: event.revision, publicationFrame: event.frame }
export const publicationComplete = (events: readonly HostEvent[], sinceWallMs: number, raise: boolean, settle?: Settle): Settled | undefined => {
  if (settle === "sequence") return settledOn(events.find((event) => event.event === "processor-sequence-applied" && event.frame > 0 && event.wallMs >= sinceWallMs))
  if (settle === "editor-open") return settledOn(events.find((event) => event.event === "vst-editor-state" && event.open === true && event.wallMs >= sinceWallMs))
  if (settle === "plugin-fault") return settledOn(events.find((event) => event.event === "attachment-fault-isolated" && event.cause === "plugin-fault" && event.wallMs >= sinceWallMs))
  // An import publishes its empty track first and the decoded asset after: the asset's publication is the first one an asset-install
  // since the edit precedes.
  const publish = events.find((event) => event.event === "graph-publish" && event.cause === "block-boundary"
    && event.publicationFrame > 0 && event.wallMs >= sinceWallMs
    && (settle !== "asset" || events.some((install) => install.event === "asset-install" && install.wallMs >= sinceWallMs && install.wallMs <= event.wallMs)))
  if (!publish) return undefined
  const { revision, publicationFrame } = publish
  if (!raise) return { wallMs: publish.wallMs, revision, publicationFrame }
  const complete = events.find((event) => event.event === "latency-move-complete" && event.revision === revision
    && event.transportEpoch === publish.transportEpoch && event.frame >= publicationFrame)
  return complete && { wallMs: complete.wallMs, revision, publicationFrame }
}

// The main process logs its own lines (an asset-install) to host.jsonl as it runs, the native host to native-<pid>.jsonl.
const nativeEvents = async (out: string) => (await Promise.all((await readdir(out)).filter((name) => name === "host.jsonl" || /^native-\d+\.jsonl$/.test(name))
  .map(async (name) => parseHostLines(await readFile(path.join(out, name), "utf8"))))).flat()

// The host appends native-<pid>.jsonl as it runs (native/acceptance-evidence.h), so this waits on file changes. The deadline only
// reports a missing line as a setup failure; it never counts as a pass.
export const awaitPublicationComplete = (out: string, sinceWallMs: number, raise: boolean, deadlineMs: number, settle?: Settle) =>
  new Promise<Settled>((resolve, reject) => {
    const watcher = watch(out, () => void check())
    const timer = setTimeout(() => finish(() => reject(new SetupFailure(`no publication-complete line within ${deadlineMs} ms of the edit`))), deadlineMs)
    let done = false
    const finish = (settle: () => void) => {
      if (done) return
      done = true
      watcher.close(); clearTimeout(timer)
      settle()
    }
    const check = async () => {
      try {
        const settled = publicationComplete(await nativeEvents(out), sinceWallMs, raise, settle)
        if (settled !== undefined) finish(() => resolve(settled))
      } catch (error) { finish(() => reject(error)) }
    }
    void check()
  })

// ---- Per-launch capture ----
export type LoggedEdit = { index: number; name: string; wallMs: number; settledWallMs: number | undefined;
  revision: number; publicationFrame: number; fromLatencyFrames: number; toLatencyFrames: number }
// `wallMs` is when the app received the edit's commit (its control-commit-received line), for an edit that goes through the control
// protocol. An edit made in the UI has none and counts from the start of its step.
export type Perform = (edit: string) => Promise<{ fromLatencyFrames: number; toLatencyFrames: number; wallMs?: number }>
// A VST edit waits for a worker to start (the plan assumes 20 s per insert), so its deadline is longer.
const settleDeadlineMs = (row: Row) => row.repeat === "vst-burst" ? 60_000 : 15_000

// After a publication the next edit waits until the transport has rendered this far past it: the 1 s oracle window that A needs
// between publications, plus a margin because native progress frames are lower bounds on what has been heard. That is more than
// one fade (round(0.006 * rate) = 288 frames at 48 kHz) and more than the 0.5 s plus 4096 frames that rightPathHoldsPinnedBudget
// needs between publications, for every rate from 8192 Hz up; the self-test states both.
const SPACING_MARGIN_MS = 250
export const publicationSpacingFrames = (sampleRate: number) => Math.round(sampleRate * (MIN_WINDOW_MS + SPACING_MARGIN_MS) / 1000)

// Runs one row's burst inside a launch. Each step's edits run together; the step settles once, when the host has logged the
// publication. Writes phase9-edits.json (the shape ae-08-latency-gates.ts reads) and latency-class.json into `directory`, the
// row's own folder under the run, even when a step fails. `out` is the launch capture the host appends its evidence to. After each
// settle, `afterSettle` records what the runner samples per publication, and `hold` waits until the transport has rendered a frame.
// A settle that is not a publication has no frame of its own, and `frameAt` gives the transport frame at its wall time.
export const runBurst = async (input: { out: string; directory: string; row: Row; repetitions: number; perform: Perform; deadlineMs?: number
  hold: (frame: number) => Promise<void>; afterSettle: (settled: Settled) => Promise<void>; sampleRate: number; frameAt: (wallMs: number) => number
  mark: (event: string, fields?: Record<string, string | number | boolean>) => Promise<void> }) => {
  const { out, directory, row, mark } = input
  const logged: LoggedEdit[] = []
  await mkdir(directory, { recursive: true })
  try {
    for (const step of burstSchedule(row, input.repetitions)) {
      const wallMs = Date.now()
      await mark("burst-edit-start", { row: row.name, index: step.index })
      const moves = []
      for (const edit of step.edits) moves.push({ name: edit, ...await input.perform(edit) })
      const raise = moves.some((move) => move.toLatencyFrames > move.fromLatencyFrames)
      // A refused commit publishes nothing: its step is settled when the refusal returns, and no frame is waited for.
      const settleOn = step.settle ?? row.settle
      const found = settleOn === "refused" ? { wallMs: Date.now(), revision: 0, publicationFrame: 0 }
        : await awaitPublicationComplete(out, wallMs, raise, input.deadlineMs ?? settleDeadlineMs(row), settleOn)
      const settled = found.publicationFrame > 0 || settleOn === "refused" ? found : { ...found, publicationFrame: input.frameAt(found.wallMs) }
      const { wallMs: settledWallMs, revision, publicationFrame } = settled
      await mark("burst-settled", { row: row.name, index: step.index, settledWallMs })
      for (const move of moves) logged.push({ ...move, index: step.index, wallMs: move.wallMs ?? wallMs, settledWallMs, revision, publicationFrame })
      await input.afterSettle(settled)
      await input.hold(publicationFrame + publicationSpacingFrames(input.sampleRate))
    }
  } finally {
    await writeFile(path.join(directory, "phase9-edits.json"), JSON.stringify({ phase: 9, row: row.name, edits: logged }, null, 2))
    await writeFile(path.join(directory, "latency-class.json"), JSON.stringify({ class: row.latencyClass }))
  }
  return logged
}

// ---- Judging ----
type BurstStep = { index: number; editWallMs: number; settledWallMs: number | undefined }
export type Window = { index: number; fromWallMs: number; toWallMs: number }
// A compare callback returns a failure description for the oracle window after one edit, or undefined when the window holds.
export type Compare = (window: Window) => string | undefined
export type BurstVerdict = { outcome: "pass" | "fail" | "setup"; editIndex?: number; detail?: string; judged: number }
// Plan §8 item 3: A needs 1 s before, between and after the edit.
export const MIN_WINDOW_MS = 1000

// The oracle window after edit k runs from its publication-complete line to the start of edit k+1 (or the capture end).
// The burst ends at the first bad edit and counts it once; later edits are never judged.
export const judgeBurst = (steps: readonly BurstStep[], captureEndWallMs: number, compare: Compare): BurstVerdict => {
  for (const [position, step] of steps.entries()) {
    const judged = position + 1
    if (step.settledWallMs === undefined)
      return { outcome: "setup", editIndex: step.index, detail: "no publication-complete line in host.jsonl", judged }
    const window = { index: step.index, fromWallMs: step.settledWallMs, toWallMs: steps[position + 1]?.editWallMs ?? captureEndWallMs }
    if (window.toWallMs - window.fromWallMs < MIN_WINDOW_MS)
      return { outcome: "setup", editIndex: step.index, detail: `oracle window ${window.toWallMs - window.fromWallMs} ms is under ${MIN_WINDOW_MS} ms`, judged }
    const failure = compare(window)
    if (failure !== undefined) return { outcome: "fail", editIndex: step.index, detail: failure, judged }
  }
  return { outcome: "pass", judged: steps.length }
}

// Each judged edit is one trial. A setup failure invalidates the launch and is never a trial. Zero failures use the rule of
// three (3/N, the plan's pooled bound); otherwise the Wilson 95 % upper bound.
export type Trial = { row: string; verdict: BurstVerdict }
export const pooled = (trials: readonly Trial[]) => {
  const setupFailures = trials.filter((trial) => trial.verdict.outcome === "setup").length
  const counted = trials.filter((trial) => trial.verdict.outcome !== "setup")
  const edits = counted.reduce((sum, trial) => sum + trial.verdict.judged, 0)
  const failures = counted.filter((trial) => trial.verdict.outcome === "fail").length
  const z = 1.96, p = failures / edits
  const upper = failures === 0 ? 3 / edits
    : (p + z * z / (2 * edits) + z * Math.sqrt(p * (1 - p) / edits + z * z / (4 * edits * edits))) / (1 + z * z / edits)
  return { edits, failures, setupFailures, upper, boundsBelowOnePercent: setupFailures === 0 && edits > 0 && upper < 0.01 }
}

// ---- Judging stored evidence (the runner's --judge-only) ----
const jsonl = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").filter(Boolean)
  .map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)))
const wallOf = (events: Awaited<ReturnType<typeof jsonl>>, name: string) => {
  const found = events.find((entry) => entry.event === name)
  return z.number().parse(found?.wallMs)
}
const planSchema = z.object({
  phase: z.number(), row: z.string().optional(), editStart: z.number().optional(),
  edits: z.array(z.object({ index: z.number().optional(), wallMs: z.number(), settledWallMs: z.number().optional(), fromLatencyFrames: z.number().default(0), toLatencyFrames: z.number().default(0) })).default([]),
  commits: z.array(z.object({ wallMs: z.number() })).default([]),
  effectState: z.object({ fromLatencyFrames: z.number(), toLatencyFrames: z.number() }).optional(),
})
const editFiles = ["phase4-edits.json", "phase5-edits.json", "phase8-edits.json", "phase9-edits.json"]

// The edits of one burst step share an index; the step starts at its first edit and raises if any of them does. A phase 9 step
// settles on the line its row names (graph publication, applied sequence, asset publication), which the runner stored.
const burstStepEdits = (edits: z.infer<typeof planSchema>["edits"]) => [...Map.groupBy(edits, (edit) => edit.index)].map(([, group]) => ({
  wallMs: Math.min(...group.map((edit) => edit.wallMs)), raise: group.some((edit) => edit.toLatencyFrames > edit.fromLatencyFrames), settledWallMs: group[0]?.settledWallMs }))

// A stored row is judged as a burst of its edits. Phase 4 logs each edit; phase 5 logs the commits that follow an edit start (the
// effect-state row logs the FFT click as an action); phase 8 logs one edit start; phase 9 logs every step's edits.
export const judgeStoredRow = async (directory: string, file: string) => {
  const plan = planSchema.parse(JSON.parse(await readFile(path.join(directory, file), "utf8")))
  // A launch that failed before its capture left a row directory with no host.jsonl: that row is a setup failure, not a crash.
  const hostFile = Bun.file(path.join(directory, "host.jsonl"))
  if (!(await hostFile.exists())) {
    const verdict: BurstVerdict = { outcome: "setup", detail: "no host.jsonl in the row directory (the launch failed before its capture)", judged: 0 }
    return { row: path.basename(directory), phase: plan.phase, edits: plan.edits.length, verdict }
  }
  const host = parseHostLines(await hostFile.text())
  const actions = await jsonl(path.join(directory, "actions.jsonl"))
  const end = wallOf(actions, "capture-end")
  const edits: { wallMs: number; raise: boolean; settledWallMs?: number }[] = plan.phase === 9 ? burstStepEdits(plan.edits)
    : plan.phase === 4 ? plan.edits.map((edit) => ({ wallMs: edit.wallMs, raise: edit.toLatencyFrames > edit.fromLatencyFrames }))
    : plan.effectState ? [{ wallMs: wallOf(actions, "effect-fft-edit"), raise: plan.effectState.toLatencyFrames > plan.effectState.fromLatencyFrames }]
      : plan.phase === 8 ? [{ wallMs: z.number().parse(plan.editStart), raise: false }]
        : [z.number().parse(plan.editStart), ...plan.commits.map((commit) => commit.wallMs)].slice(0, Math.max(1, plan.commits.length))
          .map((wallMs) => ({ wallMs, raise: false }))
  const steps = edits.map((edit, position) => ({ index: position + 1, editWallMs: edit.wallMs,
    settledWallMs: edit.settledWallMs ?? publicationComplete(host, edit.wallMs, edit.raise)?.wallMs }))
  return { row: path.basename(directory), phase: plan.phase, edits: steps.length, verdict: judgeBurst(steps, end, () => undefined) }
}

// Row directories are any directory holding a phase<N>-edits.json, at most one level under the given one.
export const judgeStored = async (directory: string) => {
  const candidates = [directory, ...(await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))]
  const found = (await Promise.all(candidates.map(async (candidate) => {
    const file = (await readdir(candidate)).find((name) => editFiles.includes(name))
    return file ? [{ directory: candidate, file }] : []
  }))).flat()
  return Promise.all(found.map((row) => judgeStoredRow(row.directory, row.file)))
}

// ---- Self-test ----
const steps = (count: number, settled: (index: number) => number | undefined = (index) => index * 4000 + 1500) =>
  Array.from({ length: count }, (_, position) => ({ index: position + 1, editWallMs: (position + 1) * 4000, settledWallMs: settled(position + 1) }))
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(`phase 9 matrix self-test: ${message}`) }

export const selfTest = async () => {
  // Fail-fast: edit 12 fails, and so would every edit after it (a corrupted slot).
  const corrupted = judgeBurst(steps(20), 100_000, (window) => window.index >= 12 ? "slot corrupted" : undefined)
  check(corrupted.outcome === "fail" && corrupted.editIndex === 12 && corrupted.judged === 12, `edit 12 reported once, got ${JSON.stringify(corrupted)}`)
  check(judgeBurst(steps(20), 100_000, () => undefined).outcome === "pass", "a clean burst passes")
  // A missing publication-complete line is a setup failure, never a pass and never a product failure.
  const missing = judgeBurst(steps(20, (index) => index === 5 ? undefined : index * 4000 + 1500), 100_000, () => undefined)
  check(missing.outcome === "setup" && missing.editIndex === 5, `missing line is a setup failure at edit 5, got ${JSON.stringify(missing)}`)
  check(judgeBurst(steps(3, (index) => index * 4000 + 3500), 100_000, () => undefined).outcome === "setup", "a window under 1 s is a setup failure")
  const host = (...lines: object[]) => parseHostLines(lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
  const publish = { event: "graph-publish", cause: "block-boundary", revision: 4, transportEpoch: 1, publicationFrame: 96256, wallMs: 1000 }
  const moved = { event: "latency-move-complete", revision: 4, transportEpoch: 1, frame: 98304, wallMs: 1100 }
  check(publicationComplete(host(publish), 900, false)?.wallMs === 1000, "a plain edit settles on its publication")
  check(publicationComplete(host(publish), 900, true) === undefined, "a raise is not settled before its latency-move-complete")
  check(publicationComplete(host(publish, moved), 900, true)?.wallMs === 1100, "a raise settles on latency-move-complete")
  check(publicationComplete(host(publish, moved), 900, true)?.revision === 4 && publicationComplete(host(publish, moved), 900, true)?.publicationFrame === 96256, "the settle names its publication's revision and frame")
  check(publicationComplete(host(publish, moved), 1001, false) === undefined, "a publication before the edit is not the edit's")
  check(publicationComplete(host({ ...publish, publicationFrame: 0 }), 900, false) === undefined, "a publication at frame 0 is startup, not an edit")
  check(parseHostLines(`${JSON.stringify(publish)}\n{"event":"gra`).length === 1, "a torn trailing line is ignored")
  // An edit that publishes no graph settles on its own applied-sequence line, not on a graph publication.
  const sequence = { event: "processor-sequence-applied", cause: "block-boundary", revision: 4, transportEpoch: 1, frame: 130000, wallMs: 1300 }
  check(publicationComplete(host(publish, sequence), 900, false, "sequence")?.wallMs === 1300, "a sequence row settles on the applied sequence, not on a graph publication")
  check(publicationComplete(host(publish), 900, false, "sequence") === undefined, "a graph publication does not settle a sequence row")
  check(publicationComplete(host(sequence), 1301, false, "sequence") === undefined, "a sequence applied before the edit is not the edit's")
  check(publicationComplete(host({ ...sequence, frame: 0 }), 900, false, "sequence") === undefined, "a sequence applied at frame 0 is startup, not an edit")
  check(publicationComplete(host(sequence), 900, false, "sequence")?.publicationFrame === 130000, "the applied line's frame stands for the publication frame")
  check(publicationComplete(host(sequence), 900, false) === undefined, "a sequence line does not settle a row that waits for a graph publication")
  // An import publishes its track first and the decoded asset after an asset-install; the step settles on the asset's publication.
  const install = { event: "asset-install", wallMs: 1150 }
  const early = { ...publish, wallMs: 1000, revision: 7, publicationFrame: 96256 }
  const withAsset = { ...publish, wallMs: 1200, revision: 8, publicationFrame: 120000 }
  check(publicationComplete(host(early, install, withAsset), 900, false, "asset")?.publicationFrame === 120000 && publicationComplete(host(early, install, withAsset), 900, false)?.publicationFrame === 96256,
    "an asset step settles on the publication after the asset-install, a plain step on the first")
  check(publicationComplete(host(early, withAsset), 900, false, "asset") === undefined && publicationComplete(host(install, withAsset), 1151, false, "asset") === undefined,
    "an asset step does not settle without an asset-install since its edit")
  // Steps that publish no graph settle on their own host line.
  const editorLine = (open: boolean, wallMs: number) => ({ event: "vst-editor-state", instanceId: "i-1", open, wallMs })
  check(publicationComplete(host(editorLine(true, 1000)), 900, false, "editor-open")?.wallMs === 1000, "the editor-open step settles on its vst-editor-state open line")
  check(publicationComplete(host(editorLine(false, 1000)), 900, false, "editor-open") === undefined && publicationComplete(host(editorLine(true, 800)), 900, false, "editor-open") === undefined,
    "a closed editor or an earlier line is not its settle")
  const fault = (cause: string) => ({ event: "attachment-fault-isolated", cause, wallMs: 1000, frame: 120000 })
  check(publicationComplete(host(fault("plugin-fault")), 900, false, "plugin-fault")?.publicationFrame === 120000 && publicationComplete(host(fault("host-defect")), 900, false, "plugin-fault") === undefined,
    "the fault step settles on a plug-in fault, never on a host defect")
  // Pooled statistics on a synthetic set: 18 rows of 20 clean edits, then one failing at edit 12.
  const clean = Array.from({ length: 18 }, (_, row): Trial => ({ row: `r${row}`, verdict: { outcome: "pass", judged: 20 } }))
  const allClean = pooled(clean)
  check(allClean.edits === 360 && Math.abs(allClean.upper - 3 / 360) < 1e-12 && allClean.boundsBelowOnePercent, "360 clean trials bound below 1 %")
  const oneFailure = pooled([...clean.slice(1), { row: "r0", verdict: { outcome: "fail", editIndex: 12, judged: 12 } }])
  check(oneFailure.edits === 352 && oneFailure.failures === 1 && oneFailure.upper > 0.0158 && oneFailure.upper < 0.0160 && !oneFailure.boundsBelowOnePercent,
    `1 failure in 352 edits has Wilson upper bound about 0.0159, got ${JSON.stringify(oneFailure)}`)
  const withSetup = pooled([...clean, { row: "s", verdict: { outcome: "setup", editIndex: 5, judged: 5 } }])
  check(withSetup.edits === 360 && withSetup.setupFailures === 1 && !withSetup.boundsBelowOnePercent, "a setup failure is no trial and blocks the bound")
  // Schedule, references, repetitions, merging.
  const find = (name: string) => {
    const row = phase9Matrix.find((candidate) => candidate.name === name)
    if (!row) throw new Error(`phase 9 matrix self-test: row ${name} missing`)
    return row
  }
  const attach = find("attach-remove-long-latency"), fft = find("fft-transition"), burst = find("raise-lower-burst")
  const schedule = burstSchedule(fft, 100)
  check(schedule.length === 100 && schedule[0]?.state === "spectral-4096" && schedule[1]?.state === "spectral-512" && schedule.at(-1)?.state === fft.start, "100 alternating edits end on the start state")
  check(burstSchedule(burst, 20).every((step) => step.edits.join() === "fft-4096,fft-512"), "a raise and a lower share one step")
  check(burstSchedule(find("undo-redo-burst"), 10).length === 12, "undo/redo rounds up to whole cycles")
  const periodic = { ...fft, periodSec: 1 }
  const shortReferences = referencePlan(periodic, 100, assumedTimings)
  check(shortReferences.kind === "per-state" && shortReferences.states.length === 2 && shortReferences.seconds === 2, "a periodic row gets two short per-state references")
  const fullReference = referencePlan(fft, 100, assumedTimings)
  check(fullReference.kind === "full-length" && fullReference.seconds === 300, "another row gets one full-length capture")
  check(find("vst-insert").repeat === "vst-burst" && find("open-editor").repeat === "single", "VST repeat classes")
  check(repetitionsFor(find("vst-insert"), 100, 20) === 20 && repetitionsFor(find("open-editor"), 100, 20) === 1
    && repetitionsFor(fft, 100, 20) === 100, "repetitions per class")
  check(mergeLaunches([attach, fft, burst]).length === 1, "rows that end where the next starts share a launch")
  check(mergeLaunches([attach, { ...fft, start: "spectral-4096" }]).length === 2, "a row whose start state is not the previous end does not merge")
  check(mergeLaunches([attach, { ...fft, fixture: "phase5:held-note" }]).length === 2, "different fixtures do not merge")
  check(mergeLaunches([attach, { ...fft, latencyClass: "plain" }]).length === 2, "different latency classes do not merge")
  check(mergeLaunches([attach, { ...fft, device: "iac-midi" }]).length === 2, "different devices do not merge")
  check(phase9Matrix.every((row) => (row.fixture === null) === (row.needs !== undefined)), "a row is missing exactly when it names what it needs")
  check(new Set(phase9Rows).size === phase9Rows.length, "row names are distinct")
  // Launch plan: every merged launch is a burst and a reference, and the first launch of each latency class adds the calibration duplicate.
  const built = phase9Matrix.filter((row) => row.fixture !== null && row.repeat !== "launch")
  const launches = mergeLaunches(built)
  const order = launchPlan(launches)
  const classes = new Set(launches.map((launch) => launch[0]?.latencyClass))
  check(order.length === 2 * launches.length + classes.size, `launch plan has ${order.length} launches for ${launches.length} merged launches and ${classes.size} classes`)
  check(order.filter((step) => step.role === "calibration").length === classes.size, "one calibration per latency class")
  check(order.every((step, position) => step.role !== "reference" || order[position - 1]?.role === "burst" && order[position - 1]?.launch === step.launch), "a reference follows its own burst")
  check(order[0]?.role === "burst" && order[1]?.role === "reference" && order[2]?.role === "calibration", "the first launch runs burst, reference, calibration")
  check(launchPlan([[attach], [fft]]).filter((step) => step.role === "calibration").length === 1, "a second launch of the same class is not calibrated again")
  check(launchPlan([]).length === 0, "no rows, no launches")
  // A row that repeats by launch is its own launch, once per repetition, judged on its own capture (no reference or calibration).
  const delete1 = find("delete-while-starting")
  check(mergeLaunches([delete1, { ...delete1, start: delete1.cycle.at(-1)?.state ?? "" }]).length === 2 && mergeLaunches([fft, delete1]).length === 2, "a launch-repeat row never merges")
  check(launchesFor([delete1], 5).length === 5 && launchesFor([fft], 5).length === 1, "a launch-repeat row gives one launch per repetition")
  check(launchPlan(launchesFor([delete1], 3)).map((step) => step.role).join() === "burst,burst,burst", "a launch judged on its own capture has no reference")
  check(wallSeconds(launchesFor([delete1], 3), 3, 20) === 3 * (assumedTimings.launchSeconds + assumedTimings.stepSeconds), "a launch-repeat row costs one launch and one edit each time")
  check(mergeLaunches([find("vst-insert"), { ...find("vst-remove-undo"), start: "vst-absent" }]).length === 2, "different preparation does not merge")
  // Budget rule: only over 70 min do the VST burst rows drop to 10, and the reason is printed.
  const withVst = launchesFor(phase9Matrix, 20)
  const slowVst = { ...assumedTimings, vstStepSeconds: 60 }
  const dropped = chooseVstRepetitions(withVst, 20, 20, slowVst)
  check(dropped.vstRepetitions === FALLBACK_VST_REPETITIONS && /over 70 min/.test(dropped.why), `a 60 s VST edit drops to 10, got ${JSON.stringify(dropped)}`)
  const fits = chooseVstRepetitions(withVst, 20, 20, { ...assumedTimings, vstStepSeconds: 1 })
  check(fits.vstRepetitions === 20 && /fits 70 min/.test(fits.why), `a 1 s VST edit keeps 20, got ${JSON.stringify(fits)}`)
  check(chooseVstRepetitions(mergeLaunches(built.filter((row) => row.repeat !== "vst-burst")), 20, 20, slowVst).vstRepetitions === 20, "no VST burst row selected, nothing to drop")
  check(chooseVstRepetitions(withVst, 20, 10, slowVst).vstRepetitions === 10, "a request at or under 10 is never raised or cut")
  check(wallSeconds(withVst, 20, 10, slowVst) < wallSeconds(withVst, 20, 20, slowVst), "fewer VST repetitions cost less wall time")
  // Measured timings replace the assumptions: a step is its edit-to-settle time plus the 1 s window.
  const measured = measuredTimings([{ vst: false, edits: [{ index: 1, wallMs: 0, settledWallMs: 1000 }, { index: 2, wallMs: 5000, settledWallMs: 7000 }] },
    { vst: true, edits: [{ index: 1, wallMs: 0, settledWallMs: 9000 }] }], [20, 30])
  check(measured.stepSeconds === 2.5 && measured.vstStepSeconds === 10 && measured.launchSeconds === 25, `measured timings, got ${JSON.stringify(measured)}`)
  check(measuredTimings([], []).stepSeconds === undefined, "no evidence measures nothing")
  // The burst runner against a fake performer that appends the host's publication line.
  const burstDirectory = await mkdtemp(path.join(tmpdir(), "ae08-phase9-burst-"))
  const held: number[] = [], inventoried: number[] = []
  const quiet = { sampleRate: 48000, frameAt: (wallMs: number) => wallMs, hold: async (frame: number) => { held.push(frame) }, afterSettle: async (settled: Settled) => { inventoried.push(settled.revision) } }
  try {
    const tempo = find("tempo-burst")
    const edits: string[] = []
    const logged = await runBurst({ out: burstDirectory, directory: path.join(burstDirectory, tempo.name), row: tempo, repetitions: 4, mark: async () => undefined, ...quiet,
      perform: async (edit) => {
        edits.push(edit)
        await appendFile(path.join(burstDirectory, "native-1.jsonl"), `${JSON.stringify({ ...publish, publicationFrame: 96000 + edits.length, wallMs: Date.now() })}\n`)
        return { fromLatencyFrames: 0, toLatencyFrames: 0 }
      } })
    check(edits.join() === "tempo-137,tempo-120,tempo-137,tempo-120" && logged.every((edit) => edit.settledWallMs !== undefined), `four edits in schedule order, settled: ${edits}`)
    const written = z.object({ phase: z.number(), edits: z.array(z.object({ index: z.number() })) }).parse(JSON.parse(await readFile(path.join(burstDirectory, tempo.name, "phase9-edits.json"), "utf8")))
    check(written.phase === 9 && written.edits.map((edit) => edit.index).join() === "1,2,3,4", "phase9-edits.json lists the edits by step")
    check(await readFile(path.join(burstDirectory, tempo.name, "latency-class.json"), "utf8") === `{"class":"plain"}`, "the row declares its class")
    // An editor step settles on the editor line, and its frame is the transport frame at that wall time.
    const opened = await runBurst({ out: burstDirectory, directory: path.join(burstDirectory, "editor"), repetitions: 1, mark: async () => undefined, ...quiet, afterSettle: async () => undefined,
      row: { ...tempo, name: "editor", start: "s", cycle: [{ edits: ["open"], state: "s", settle: "editor-open" }] },
      perform: async () => {
        await appendFile(path.join(burstDirectory, "native-1.jsonl"), `${JSON.stringify({ event: "vst-editor-state", open: true, wallMs: Date.now() })}\n`)
        return { fromLatencyFrames: 0, toLatencyFrames: 0 }
      } })
    check(opened[0]?.settledWallMs !== undefined && opened[0]?.publicationFrame === opened[0]?.settledWallMs, `the editor step settles on its line at the frame of that time: ${JSON.stringify(opened)}`)
    // Edits that share a step run in their declared order and settle once.
    const paired: string[] = []
    const pairedLogged = await runBurst({ out: burstDirectory, directory: path.join(burstDirectory, "paired"), repetitions: 2, mark: async () => undefined, ...quiet,
      row: { ...tempo, name: "paired", start: "s", cycle: [{ edits: ["first", "second"], state: "s" }] },
      perform: async (edit) => {
        paired.push(edit)
        await appendFile(path.join(burstDirectory, "native-1.jsonl"), `${JSON.stringify({ ...publish, publicationFrame: 97000 + paired.length, wallMs: Date.now() })}\n`)
        return { fromLatencyFrames: 0, toLatencyFrames: 0 }
      } })
    // Spacing: each step holds until its publication plus the one-fade minimum, 0.5 s and 4096 frames (rightPathHoldsPinnedBudget) and the margin.
    const spacing = publicationSpacingFrames(48000)
    check(spacing >= Math.round(48000 * 0.006) && spacing >= 48000 / 2 + 4096 && spacing >= 48000 && publicationSpacingFrames(44100) >= 44100 / 2 + 4096, `spacing ${spacing} frames covers a fade, 0.5 s + 4096 and the 1 s window`)
    check(held[0] === 96001 + spacing && held.slice(0, 4).every((frame) => frame > 96000 + spacing), `each step holds one spacing past its publication: ${held}`)
    check(inventoried.length >= 4 && inventoried.every((revision) => revision === 4), "an asset inventory is taken after each settled publication, with its revision")
    // An edit through the control protocol counts from its commit, not from the start of its step; a UI edit counts from the step.
    let stampedCount = 0
    const stamped = await runBurst({ out: burstDirectory, directory: path.join(burstDirectory, "stamped"), repetitions: 2, mark: async () => undefined, ...quiet,
      row: { ...tempo, name: "stamped", start: "s", cycle: [{ edits: ["committed", "ui"], state: "s" }] },
      perform: async (edit) => {
        await appendFile(path.join(burstDirectory, "native-1.jsonl"), `${JSON.stringify({ ...publish, publicationFrame: 98000 + (stampedCount += 1), wallMs: Date.now() })}\n`)
        return edit === "committed" ? { fromLatencyFrames: 0, toLatencyFrames: 0, wallMs: 12345 } : { fromLatencyFrames: 0, toLatencyFrames: 0 }
      } })
    check(stamped[0]?.wallMs === 12345 && (stamped[1]?.wallMs ?? 0) > 1_000_000, `a committed edit logs its commit time: ${stamped.map((edit) => edit.wallMs)}`)
    check(paired.join() === "first,second,first,second" && pairedLogged.length === 4 && new Set(pairedLogged.map((edit) => edit.settledWallMs)).size <= 2, `paired edits keep their order: ${paired}`)
    // A step without a publication fails the launch as a setup failure, and the evidence of the steps before it is still written.
    const failing = path.join(burstDirectory, "failing")
    const failure = await runBurst({ out: failing, directory: failing, row: { ...tempo, name: "failing" }, repetitions: 2, mark: async () => undefined, deadlineMs: 100, ...quiet,
      perform: async () => ({ fromLatencyFrames: 0, toLatencyFrames: 0 }) }).then(() => "resolved", (error) => error instanceof SetupFailure ? "setup" : "other")
    check(failure === "setup" && JSON.parse(await readFile(path.join(failing, "phase9-edits.json"), "utf8")).edits.length === 0, `a missing line is a setup failure with evidence kept, got ${failure}`)
    // A refused commit publishes nothing, so its step settles when the refusal returns, with no line to wait for.
    const refusedDirectory = path.join(burstDirectory, "refused")
    const refused = await runBurst({ out: refusedDirectory, directory: refusedDirectory, row: { ...tempo, name: "refused", settle: "refused" }, repetitions: 2, mark: async () => undefined, deadlineMs: 100, ...quiet,
      perform: async () => ({ fromLatencyFrames: 0, toLatencyFrames: 0 }) }).then((edits) => edits, () => [])
    check(refused.length === 2 && refused.every((edit) => edit.settledWallMs !== undefined && edit.publicationFrame === 0), `a refused step settles on its return: ${JSON.stringify(refused)}`)
  } finally { await rm(burstDirectory, { recursive: true }) }
  // The app's own commit stamp, written by the product helper and read back by the runner.
  const evidence = await mkdtemp(path.join(tmpdir(), "ae08-phase9-stamp-"))
  const previousEvidenceDir = process.env.DAW_AE08_EVIDENCE_DIR
  try {
    process.env.DAW_AE08_EVIDENCE_DIR = evidence
    const before = Date.now()
    ae08ControlCommitReceived({ operation: "control.preview", input: { idempotencyKey: "preview-key" } })
    ae08ControlCommitReceived({ operation: "control.commit", input: { version: "v1" } })
    ae08ControlCommitReceived({ operation: "control.commit", input: { idempotencyKey: "commit-key" } })
    const received = await commitReceivedWallMs(evidence, "commit-key")
    check(received >= before && received <= Date.now(), "the runner reads the wall time the app logged for its commit")
    check(parseHostLines(await readFile(path.join(evidence, "host.jsonl"), "utf8")).length === 1, "only a commit that carries a key is stamped")
    const absent = await commitReceivedWallMs(evidence, "other-key").then(() => "read", (error) => error instanceof SetupFailure ? "setup" : "other")
    check(absent === "setup", `a commit the app never logged is a setup failure, got ${absent}`)
  } finally {
    if (previousEvidenceDir === undefined) delete process.env.DAW_AE08_EVIDENCE_DIR
    else process.env.DAW_AE08_EVIDENCE_DIR = previousEvidenceDir
    await rm(evidence, { recursive: true })
  }
  // The live wait: a line appended later resolves it; no line is a SetupFailure when the deadline passes, never a pass.
  const directory = await mkdtemp(path.join(tmpdir(), "ae08-phase9-"))
  try {
    const waiting = awaitPublicationComplete(directory, 900, false, 5_000)
    await writeFile(path.join(directory, "native-1.jsonl"), `${JSON.stringify(publish)}\n`)
    check((await waiting).wallMs === 1000, "the live wait resolves on the appended publication")
    const none = await awaitPublicationComplete(directory, 2000, false, 200).then(() => "resolved", (error) => error instanceof SetupFailure ? "setup" : "other")
    check(none === "setup", `no line before the deadline is a SetupFailure, got ${none}`)
  } finally { await rm(directory, { recursive: true }) }
  console.log("ae-08 phase 9 matrix self-test: pass")
}

// What a real run measured: the runner writes this next to its evidence (phase9-timings.json). A step costs its edit-to-settle time
// plus the 1 s oracle window; a launch costs its launch-to-normal-quit time.
export const measuredEditsSchema = z.array(z.object({ index: z.number(), wallMs: z.number(), settledWallMs: z.number().optional() }))
type MeasuredEdit = z.infer<typeof measuredEditsSchema>[number]
export const measuredTimings = (rows: readonly { vst: boolean; edits: readonly MeasuredEdit[] }[], launchSeconds: readonly number[]) => {
  const mean = (values: number[]) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined
  const steps = (vst: boolean) => rows.filter((row) => row.vst === vst).flatMap((row) => [...Map.groupBy(row.edits, (edit) => edit.index).values()]
    .flatMap((group) => group[0]?.settledWallMs === undefined ? [] : [(group[0].settledWallMs - group[0].wallMs + MIN_WINDOW_MS) / 1000]))
  const stepSeconds = mean(steps(false)), vstStepSeconds = mean(steps(true)), launch = mean([...launchSeconds])
  return { ...(launch !== undefined && { launchSeconds: launch }), ...(stepSeconds !== undefined && { stepSeconds }), ...(vstStepSeconds !== undefined && { vstStepSeconds }) }
}
const timingsSchema = z.object({ launchSeconds: z.number().positive().optional(), stepSeconds: z.number().positive().optional(), vstStepSeconds: z.number().positive().optional() })
export const readTimings = async (file: string): Promise<Timings> => {
  const measured = timingsSchema.parse(JSON.parse(await readFile(file, "utf8")))
  return { launchSeconds: measured.launchSeconds ?? assumedTimings.launchSeconds, stepSeconds: measured.stepSeconds ?? assumedTimings.stepSeconds,
    vstStepSeconds: measured.vstStepSeconds ?? assumedTimings.vstStepSeconds }
}

const plan = async (args: string[]) => {
  const number = (flag: string, fallback: number) => args.includes(flag) ? Number(args[args.indexOf(flag) + 1]) : fallback
  const repetitions = number("--repetitions", 20), vstRepetitions = number("--vst-repetitions", 20)
  const timingsFile = args[args.indexOf("--timings") + 1]
  const timings = args.includes("--timings") && timingsFile ? await readTimings(timingsFile) : assumedTimings
  console.log(`timings: ${timings === assumedTimings ? "ASSUMED" : `measured, ${timingsFile}`} ${JSON.stringify(timings)}`)
  const built = phase9Matrix.filter((row) => row.fixture !== null)
  for (const row of phase9Matrix) {
    const steps = burstSchedule(row, repetitionsFor(row, repetitions, vstRepetitions)).length
    console.log(`${row.name.padEnd(28)} ${row.latencyClass.padEnd(10)} ${String(steps).padStart(4)} edits  ${row.fixture ?? `MISSING: ${row.needs}`}`)
  }
  const launches = launchesFor(built, repetitions)
  console.log(`built rows: ${built.length}/${phase9Matrix.length}, launches after merging: ${launches.length}`)
  console.log(`launch order: ${launchPlan(launches).map((step) => `${step.role}#${step.launch + 1}`).join(" ")}`)
  console.log(`wall time, built rows: ${(wallSeconds(launches, repetitions, vstRepetitions, timings) / 60).toFixed(1)} min`)
  // The VST rows are not built, so the rule is applied to the whole matrix: this is the budget the certifying run would face.
  const everything = launchesFor(phase9Matrix, repetitions)
  console.log(`wall time, all rows built: ${(wallSeconds(everything, repetitions, vstRepetitions, timings) / 60).toFixed(1)} min`)
  console.log(`certifying VST repetitions: ${chooseVstRepetitions(everything, repetitions, vstRepetitions, timings).why}`)
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") await selfTest()
  else if (Bun.argv[2] === "--plan") await plan(Bun.argv.slice(3))
  else throw new Error("Usage: ae-08-phase-9-matrix.ts --self-test | --plan [--repetitions N] [--vst-repetitions N] [--timings phase9-timings.json]")
}
