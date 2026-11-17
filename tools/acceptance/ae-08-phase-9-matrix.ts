#!/usr/bin/env bun
import { watch } from "node:fs"
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { ae08ControlCommitReceived, createAe08Evidence } from "../../apps/desktop/ae08-evidence"
import { ae08RendererMarks } from "@daw-browser/desktop-protocol/acceptance-marks"
import { prepareSplit, splitLine, type PrepareSplit } from "./ae-08-prepare-split"
import { phase9Presets, phase9Rows, presetNamed, type Preset, type Row, type Settle } from "./ae-08-phase-9-rows"

// AE-08 phase 9 matrix (plan §8 steps 1-2): one packaged launch per row class carries N alternating edits. This file owns
// the burst schedule, settling on host evidence, publication spacing, fail-fast judging, pooled statistics,
// launch merging and the wall-time budget; the rows are declared in ae-08-phase-9-rows.ts. PCM comparison per oracle window is
// the `compare` callback: ae-08-phase-9-launch.ts builds it from the analyzer's judgeBurst. The runner (ae-08-live-graph.ts
// --phase 9) calls these; there is no second runner protocol.
//
//   bun tools/acceptance/ae-08-phase-9-matrix.ts --self-test
//   bun tools/acceptance/ae-08-phase-9-matrix.ts --plan [--matrix cert|extended|full] [--repetitions N] [--vst-repetitions N]

// What a run asks for: the preset names the rows' repetitions, and a flag overrides them for the rows it covers.
export type Requested = { preset: Preset; repetitions?: number; vstRepetitions?: number }
const defaultRepetitions = {
  burst: { cert: 30, extended: 100 }, "vst-burst": { cert: 20, extended: 100 }, launch: { cert: 15, extended: 100 } } satisfies Record<"burst" | "vst-burst" | "launch", Record<Preset, number>>
// A single row is one pass whatever is asked.
const requestedCount = (row: Row, requested: Requested) => row.repeat === "single" ? 1
  : (row.repeat === "vst-burst" ? requested.vstRepetitions : requested.repetitions) ?? row.repetitions?.[requested.preset] ?? defaultRepetitions[row.repeat][requested.preset]
// The edits of one launch of the row: a row that repeats by launch has one cycle per launch.
export const repetitionsFor = (row: Row, requested: Requested) => row.repeat === "burst" || row.repeat === "vst-burst" ? requestedCount(row, requested) : 1

// A burst always ends on the row's start state: it is rounded up to whole cycles.
export const burstSchedule = (row: Row, repetitions: number) =>
  Array.from({ length: Math.ceil(repetitions / row.cycle.length) }).flatMap((_, round) =>
    row.cycle.map((step, position) => ({ index: round * row.cycle.length + position + 1, ...step })))

// Rows share a launch only where one fixture, class, preparation and device build both, and the state after one row's burst is the
// next row's start. A row that repeats by launch is its own launch.
export const mergeLaunches = (rows: readonly Row[]) => rows.reduce<Row[][]>((launches, row) => {
  const last = launches.at(-1), tail = last?.at(-1)
  const joins = last && tail && tail.fixture !== null && tail.fixture === row.fixture && tail.latencyClass === row.latencyClass
    && tail.repeat === row.repeat && row.repeat !== "launch" && tail.transport === undefined && row.transport === undefined && tail.periodSec === row.periodSec && tail.cycle.at(-1)?.state === row.start
    && String(tail.prepare) === String(row.prepare) && tail.device === row.device
  return joins ? [...launches.slice(0, -1), [...last, row]] : [...launches, [row]]
}, [])

// The launches of a run: a row that repeats by launch gives one launch per repetition.
export const launchesFor = (rows: readonly Row[], requested: Requested) => mergeLaunches(rows)
  .flatMap((launch) => {
    const [row] = launch
    return row?.repeat === "launch" ? Array.from({ length: requestedCount(row, requested) }, () => launch) : [launch]
  })

// Seconds per launch, per edit, per VST edit and per offline state export. The defaults were measured on the stored phase 9 campaigns
// of the C2 rounds (/tmp/c2, c2gaps, ae08-cal, ae08-rec, ae08-jr and others: capturedSeconds against seconds per launch, and rows of 2,
// 10 and 20 edits per step cost); they are tabled in /tmp/ae08-phase9-budget-plan.md section 1 and accepted in addendum 36 of
// PARENT-RULING-C2-FAIL-ITEMS.md. `--timings <evidence dir>` replaces them with what a real phase 9 run measured (`measuredTimings`).
export type Timings = { launchSeconds: number; stepSeconds: number; vstStepSeconds: number; exportSeconds: number }
export const defaultTimings: Timings = { launchSeconds: 6.9, stepSeconds: 1.45, vstStepSeconds: 1.67, exportSeconds: 10 }
// A row that repeats by launch runs one edit per launch, and its launch costs what the stored runs took in all.
const launchRowSeconds = new Map([["delete-while-starting", 7.7], ["record-target-guard", 10.9], ["unaffected-input", 11.0], ["record-target-reroute", 11.4]])
// The certifying budget of plan §13 answer 4.
export const BUDGET_SECONDS = 70 * 60

// What each row of a run costs. A launch is its fixed cost (charged to its first row), the steps of its merged rows, and one offline
// export of the states of each row the analyzer compares; a row that repeats by launch costs its measured launch each time.
export type PlannedRow = { row: string; repetitions: number; stepsPerLaunch: number; seconds: number }
export const planRows = (launches: readonly Row[][], requested: Requested, timings: Timings = defaultTimings) => {
  const planned = new Map<string, PlannedRow>()
  for (const launch of launches) for (const [position, row] of launch.entries()) {
    const stepsPerLaunch = burstSchedule(row, repetitionsFor(row, requested)).length
    const steps = stepsPerLaunch * (row.repeat === "vst-burst" ? timings.vstStepSeconds : timings.stepSeconds) + (row.judge === "states" ? timings.exportSeconds : 0)
    const seconds = (row.repeat === "launch" ? launchRowSeconds.get(row.name) : undefined) ?? (position === 0 ? timings.launchSeconds : 0) + steps
    const before = planned.get(row.name)
    planned.set(row.name, { row: row.name, repetitions: requestedCount(row, requested), stepsPerLaunch, seconds: (before?.seconds ?? 0) + seconds })
  }
  return [...planned.values()]
}
export const wallSeconds = (launches: readonly Row[][], requested: Requested, timings: Timings = defaultTimings) =>
  planRows(launches, requested, timings).reduce((total, entry) => total + entry.seconds, 0)

// ---- Settling on host evidence ----
const hostEventSchema = z.object({ event: z.string(), cause: z.string().default(""), wallMs: z.number().default(0),
  revision: z.number().default(0), frame: z.number().default(0), publicationFrame: z.number().default(0), transportEpoch: z.number().default(0),
  idempotencyKey: z.string().default(""), key: z.string().default(""), open: z.boolean().optional(), pid: z.number().default(0), requestedRevision: z.number().default(0),
  processorAutomationEvents: z.number().default(0), stepsUs: z.string().default(""), step: z.string().default(""), durationMs: z.number().default(0),
  queueDepth: z.number().default(0), queuedMs: z.number().default(0), rendererSends: z.number().default(0) })
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
// The automation lane events in the schedule windows the main process sent for a publication's revision since the edit
// (apps/desktop/audio-host.ts logs one schedule-window line per window).
const laneEventsOf = (events: readonly HostEvent[], publish: HostEvent, sinceWallMs: number) =>
  events.filter((window) => window.event === "schedule-window" && window.revision === publish.revision && window.wallMs >= sinceWallMs && window.wallMs <= publish.wallMs)
    .map((window) => window.processorAutomationEvents)
export const publicationComplete = (events: readonly HostEvent[], sinceWallMs: number, raise: boolean, settle?: Settle): Settled | undefined => {
  if (settle === "sequence") return settledOn(events.find((event) => event.event === "processor-sequence-applied" && event.frame > 0 && event.wallMs >= sinceWallMs))
  if (settle === "editor-open") return settledOn(events.find((event) => event.event === "vst-editor-state" && event.open === true && event.wallMs >= sinceWallMs))
  if (settle === "state-capture") return settledOn(events.find((event) => event.event === "vst-state-get" && event.wallMs >= sinceWallMs))
  if (settle === "plugin-fault") return settledOn(events.find((event) => event.event === "attachment-fault-isolated" && event.cause === "plugin-fault" && event.wallMs >= sinceWallMs))
  // An import publishes its empty track first and the decoded asset after: the asset's publication is the first one an asset-install
  // since the edit precedes.
  const publish = events.find((event) => event.event === "graph-publish" && event.cause === "block-boundary"
    && event.publicationFrame > 0 && event.wallMs >= sinceWallMs
    && (settle !== "asset" || events.some((install) => install.event === "asset-install" && install.wallMs >= sinceWallMs && install.wallMs <= event.wallMs))
    && (settle !== "lane" || laneEventsOf(events, event, sinceWallMs).some((count) => count > 0))
    && (settle !== "lane-free" || laneEventsOf(events, event, sinceWallMs).length > 0 && laneEventsOf(events, event, sinceWallMs).every((count) => count === 0)))
  if (!publish) return undefined
  const { revision, publicationFrame } = publish
  if (!raise) return { wallMs: publish.wallMs, revision, publicationFrame }
  const complete = events.find((event) => event.event === "latency-move-complete" && event.revision === revision
    && event.transportEpoch === publish.transportEpoch && event.frame >= publicationFrame)
  return complete && { wallMs: complete.wallMs, revision, publicationFrame }
}

// The main process logs its own lines (an asset-install) to host.jsonl as it runs, the native host to native-<pid>.jsonl.
export const nativeEvents = async (out: string) => (await Promise.all((await readdir(out)).filter((name) => name === "host.jsonl" || /^native-\d+\.jsonl$/.test(name))
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
  revision: number; publicationFrame: number; fromLatencyFrames: number; toLatencyFrames: number; startSec?: number }
// `wallMs` is when the app received the edit's commit (its control-commit-received line), for an edit that goes through the control
// protocol. An edit made in the UI has none and counts from the start of its step.
export type Perform = (edit: string) => Promise<{ fromLatencyFrames: number; toLatencyFrames: number; wallMs?: number; startSec?: number }>
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
      const publishesNothing = settleOn === "refused" || settleOn === "returned"
      const found = publishesNothing ? { wallMs: Date.now(), revision: 0, publicationFrame: 0 }
        : await awaitPublicationComplete(out, wallMs, raise, input.deadlineMs ?? settleDeadlineMs(row), settleOn)
      const settled = found.publicationFrame > 0 || publishesNothing ? found : { ...found, publicationFrame: input.frameAt(found.wallMs) }
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
// A row with no audio to compare (host evidence only) needs no 1 s window and passes 0.
export const judgeBurst = (steps: readonly BurstStep[], captureEndWallMs: number, compare: Compare, minWindowMs = MIN_WINDOW_MS): BurstVerdict => {
  for (const [position, step] of steps.entries()) {
    const judged = position + 1
    if (step.settledWallMs === undefined)
      return { outcome: "setup", editIndex: step.index, detail: "no publication-complete line in host.jsonl", judged }
    const window = { index: step.index, fromWallMs: step.settledWallMs, toWallMs: steps[position + 1]?.editWallMs ?? captureEndWallMs }
    if (window.toWallMs - window.fromWallMs < minWindowMs)
      return { outcome: "setup", editIndex: step.index, detail: `oracle window ${window.toWallMs - window.fromWallMs} ms is under ${minWindowMs} ms`, judged }
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
const storedRows = async (directory: string) => {
  const candidates = [directory, ...(await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))]
  return (await Promise.all(candidates.map(async (candidate) => {
    const file = (await readdir(candidate)).find((name) => editFiles.includes(name))
    return file ? [{ directory: candidate, file }] : []
  }))).flat()
}
export const judgeStored = async (directory: string) => Promise.all((await storedRows(directory)).map((row) => judgeStoredRow(row.directory, row.file)))

// ---- Edit-to-publish breakdown (the runner's --breakdown) ----
// Where the time from an edit to its publication goes, by the lines the app and the host log: the app's receipt of the commit, the
// host's graph-prepare, graph-publish-request and graph-publish of the revision the edit's publication carries. The span from the
// commit to graph-prepare is split by the renderer marks (packages/desktop-protocol ae08RendererMarks), logged when the app runs with
// DAW_AE08_EVIDENCE_DIR: the control handler's marks carry the commit's idempotency key, the compile and lane marks the key of the
// adoption whose prepare-sent is the last before that graph-prepare. A mark the evidence lacks is skipped, so its span is merged.
// An edit made in the app window has no commit line: it is timed from the first ui-* mark the app logged between the step start and the
// publication (ae-08-latency-gates.ts does the same), and from the step start only when the evidence has no such mark.
const commitMarkNames = ae08RendererMarks.options.filter((name) => name.startsWith("control-"))
// An asset publication hydrates between graph-prepare and graph-publish-request: its marks (asset-*) are logged under the adoption key, after prepare-sent.
const hydrationMarkNames = ae08RendererMarks.options.filter((name) => name.startsWith("asset-"))
// The reply and bind marks lie after graph-prepare, and the refill compile marks carry a window key, not an adoption key: ae-08-prepare-split.ts reads them.
const splitMarkNames = ["prepare-reply-received", "bind-states-configured", "bind-progress-reply", "bind-progress-read", "bind-request-sent",
  "armed-cover-end", "armed-stage-returned", "armed-prime-start", "armed-prime-end", "refill-compile-start", "refill-compile-end"]
const adoptionMarkNames = ae08RendererMarks.options.filter((name) => !name.startsWith("control-") && !name.startsWith("ui-") && !hydrationMarkNames.includes(name) && !splitMarkNames.includes(name))
export type EditSpan = { from: string; to: string; ms: number }
// `origin` is where the edit is timed from: the app's commit line, the UI mark it logged, or the step start. `hydration` runs from
// graph-prepare through the asset marks to graph-publish-request, and is empty when the publication hydrated nothing.
// `split` divides graph-prepare to graph-publish-request into host, reply, hops and renderer work; it is absent when the evidence lacks a mark or host line it needs.
export type EditBreakdown = { index: number; name: string; origin: string; toPrepareMs: number; toRequestMs: number; toPublishMs: number; spans: EditSpan[]; hydration: EditSpan[]; split: PrepareSplit | undefined }
const spansBetween = (points: readonly { name: string; wallMs: number }[]): EditSpan[] =>
  points.slice(1).map((point, at) => ({ from: points[at]?.name ?? "", to: point.name, ms: point.wallMs - (points[at]?.wallMs ?? point.wallMs) }))
export const editBreakdowns = (events: readonly HostEvent[], edits: readonly { index: number; name: string; wallMs: number }[]): (EditBreakdown | { index: number; name: string; missing: string })[] =>
  edits.map((edit) => {
    const publishAt = events.findIndex((event) => event.event === "graph-publish" && event.cause === "block-boundary" && event.publicationFrame > 0 && event.wallMs >= edit.wallMs)
    const publish = events[publishAt]
    if (!publish) return { index: edit.index, name: edit.name, missing: "no graph-publish after the edit" }
    const prepare = events.slice(0, publishAt).findLast((event) => event.event === "graph-prepare" && event.pid === publish.pid && event.requestedRevision === publish.revision)
    const request = prepare && events.slice(events.indexOf(prepare) + 1, publishAt)
      .find((event) => event.event === "graph-publish-request" && event.pid === publish.pid && event.requestedRevision === publish.revision)
    if (!prepare || !request) return { index: edit.index, name: edit.name, missing: `revision ${publish.revision} has no ${prepare ? "graph-publish-request" : "graph-prepare"} before its publication` }
    const received = events.find((event) => event.event === "control-commit-received" && event.wallMs === edit.wallMs)
    const ui = received ? undefined : events.find((event) => event.event.startsWith("ui-") && event.wallMs >= edit.wallMs && event.wallMs <= publish.wallMs)
    const sent = events.findLast((event) => event.event === "prepare-sent" && event.wallMs >= edit.wallMs && event.wallMs <= prepare.wallMs)
    const startMs = ui?.wallMs ?? edit.wallMs
    const origin = received ? "commit-received" : ui?.event ?? "edit-start"
    const points = [
      { name: origin, wallMs: startMs },
      ...(received ? commitMarkNames.flatMap((name) => events.find((event) => event.event === name && event.key === received.idempotencyKey) ?? []) : [])
        .map((event) => ({ name: event.event, wallMs: event.wallMs })),
      ...(sent ? adoptionMarkNames.flatMap((name) => events.findLast((event) => event.event === name && event.key === sent.key && event.wallMs <= sent.wallMs) ?? []) : [])
        .map((event) => ({ name: event.event, wallMs: event.wallMs })),
      { name: "graph-prepare", wallMs: prepare.wallMs },
    ]
    const hydrated = sent ? events.filter((event) => hydrationMarkNames.some((name) => name === event.event) && event.key === sent.key
      && event.wallMs >= prepare.wallMs && event.wallMs <= request.wallMs).map((event) => ({ name: event.event, wallMs: event.wallMs })) : []
    return { index: edit.index, name: edit.name, origin,
      toPrepareMs: prepare.wallMs - startMs, toRequestMs: request.wallMs - startMs, toPublishMs: publish.wallMs - startMs,
      spans: spansBetween(points),
      hydration: hydrated.length ? spansBetween([{ name: "graph-prepare", wallMs: prepare.wallMs }, ...hydrated, { name: "graph-publish-request", wallMs: request.wallMs }]) : [],
      split: prepareSplit(events, prepare, request) }
  })

const breakdownEdits = z.object({ edits: z.array(z.object({ index: z.number(), name: z.string(), wallMs: z.number() })) })
export const breakdownStored = async (directory: string) => Promise.all((await storedRows(directory)).filter((row) => row.file === "phase9-edits.json").map(async (row) => {
  const host = Bun.file(path.join(row.directory, "host.jsonl"))
  const name = path.basename(row.directory)
  if (!(await host.exists())) return { row: name, breakdowns: undefined }
  const { edits } = breakdownEdits.parse(JSON.parse(await readFile(path.join(row.directory, row.file), "utf8")))
  return { row: name, breakdowns: editBreakdowns(parseHostLines(await host.text()), edits) }
}))
export const breakdownLine = (entry: Awaited<ReturnType<typeof breakdownStored>>[number]) => entry.breakdowns === undefined ? [`${entry.row}: no host.jsonl (setup failure)`]
  : entry.breakdowns.map((found) => "missing" in found ? `${entry.row} edit ${found.index} ${found.name}: ${found.missing}`
    : `${entry.row} edit ${found.index} ${found.name}: +${found.toPrepareMs} ms graph-prepare (${found.spans.length > 1 ? found.spans.map((span) => `${span.from} -> ${span.to} ${span.ms} ms`).join(", ") : "no renderer marks in host.jsonl"}), +${found.toRequestMs} ms graph-publish-request${found.hydration.length ? ` (asset hydration: ${found.hydration.map((span) => `${span.from} -> ${span.to} ${span.ms} ms`).join(", ")})` : ""}${found.split ? ` (prepare split: ${splitLine(found.split)})` : ""}, +${found.toPublishMs} ms graph-publish${found.origin === "edit-start" ? " (counted from the step start: the edit has no control-commit-received line and no ui-* mark)" : ` (counted from ${found.origin})`}`)

// ---- Self-test ----
const steps = (count: number, settled: (index: number) => number | undefined = (index) => index * 4000 + 1500) =>
  Array.from({ length: count }, (_, position) => ({ index: position + 1, editWallMs: (position + 1) * 4000, settledWallMs: settled(position + 1) }))
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(`phase 9 matrix self-test: ${message}`) }
const near = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9

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
  // A lane step settles on the publication whose schedule windows carry the lane, not on one without it.
  const laneWindow = (revision: number, wallMs: number, processorAutomationEvents: number) => ({ event: "schedule-window", revision, wallMs, processorAutomationEvents })
  check(publicationComplete(host(laneWindow(4, 1000, 0), publish), 900, false, "lane") === undefined, "a publication without the lane does not settle a lane step")
  check(publicationComplete(host(laneWindow(4, 1000, 2), publish), 900, false, "lane")?.revision === 4, "a publication whose windows carry the lane settles a lane step")
  check(publicationComplete(host(laneWindow(3, 1000, 2), publish), 900, false, "lane") === undefined, "another revision's lane windows are not the publication's")
  check(publicationComplete(host(laneWindow(4, 1000, 0), publish), 900, false, "lane-free")?.revision === 4, "a publication whose windows carry no lane settles a lane-free step")
  check(publicationComplete(host(laneWindow(4, 1000, 2), publish), 900, false, "lane-free") === undefined && publicationComplete(host(publish), 900, false, "lane-free") === undefined,
    "a publication with a lane, or with no windows at all, does not settle a lane-free step")
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
  const stateGet = (wallMs: number) => ({ event: "vst-state-get", wallMs })
  check(publicationComplete(host(stateGet(1000)), 900, false, "state-capture")?.wallMs === 1000 && publicationComplete(host(stateGet(800)), 900, false, "state-capture") === undefined,
    "the state-capture step settles on a vst-state-get line at or after the close")
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
  // Schedule, repetitions, merging.
  const find = (name: string) => {
    const row = phase9Presets.extended.find((candidate) => candidate.name === name)
    if (!row) throw new Error(`phase 9 matrix self-test: row ${name} missing`)
    return row
  }
  const attach = find("attach-remove-long-latency"), fft = find("fft-transition"), burst = find("raise-lower-burst")
  const schedule = burstSchedule(fft, 100)
  check(schedule.length === 100 && schedule[0]?.state === "spectral-4096" && schedule[1]?.state === "spectral-512" && schedule.at(-1)?.state === fft.start, "100 alternating edits end on the start state")
  check(burstSchedule(burst, 20).every((step) => step.edits.join() === "fft-4096,fft-512"), "a raise and a lower share one step")
  check(burstSchedule(find("undo-redo-burst"), 10).length === 12, "undo/redo rounds up to whole cycles")
  check(find("vst-insert").repeat === "vst-burst" && find("open-editor").repeat === "single", "VST repeat classes")
  const cert: Requested = { preset: "cert" }, extended: Requested = { preset: "extended" }
  const flagged: Requested = { preset: "cert", repetitions: 100, vstRepetitions: 20 }
  check(repetitionsFor(find("vst-insert"), flagged) === 20 && repetitionsFor(find("open-editor"), flagged) === 1 && repetitionsFor(fft, flagged) === 100, "flags override repetitions per class")
  check(repetitionsFor(fft, cert) === 30 && repetitionsFor(fft, extended) === 100 && repetitionsFor(find("vst-remove-undo"), cert) === 40 && repetitionsFor(find("vst-remove-undo"), extended) === 100
    && repetitionsFor(find("vst-latency-switch"), cert) === 20 && repetitionsFor(find("open-editor"), extended) === 1, "a preset gives each row its own repetitions: burst 30/100, vst-remove-undo 40/100, vst-latency-switch 20/100, single 1/1")
  check(launchesFor([find("record-target-guard")], cert).length === 15 && launchesFor([find("record-target-guard")], extended).length === 100 && launchesFor([find("open-editor")], extended).length === 1, "launch rows run 15 / 100 launches, single rows one")
  check(phase9Presets.extended.length === phase9Presets.cert.length + 4 && phase9Presets.cert.every((row) => row.tier === undefined && row.calibration === undefined)
    && phase9Presets.extended.filter((row) => row.tier === "extended").map((row) => row.name).join() === "vst-insert", "the certifying preset leaves out vst-insert and the calibration rows")
  check(mergeLaunches([attach, fft, burst]).length === 1, "rows that end where the next starts share a launch")
  check(mergeLaunches([attach, { ...fft, start: "spectral-4096" }]).length === 2, "a row whose start state is not the previous end does not merge")
  check(mergeLaunches([attach, { ...fft, fixture: "phase5:held-note" }]).length === 2, "different fixtures do not merge")
  check(mergeLaunches([attach, { ...fft, latencyClass: "plain" }]).length === 2, "different latency classes do not merge")
  check(mergeLaunches([attach, { ...fft, device: "iac-midi" }]).length === 2, "different devices do not merge")
  check(phase9Presets.extended.every((row) => (row.fixture === null) === (row.needs !== undefined)), "a row is missing exactly when it names what it needs")
  check(new Set(phase9Rows).size === phase9Rows.length, "row names are distinct")
  // The size calibration rows run when named or in the extended preset, and their swaps are the performers' (5 copies and back, or 1 and back twice).
  const calibration = phase9Presets.extended.filter((row) => row.calibration)
  check(calibration.length === 3 && calibration.every((row) => phase9Rows.includes(row.name) && !phase9Presets.cert.includes(row)), "calibration rows are named and in the extended preset only")
  check(calibration.every((row) => launchesFor([row], cert).length === 1), "a calibration row is one burst launch")
  check(calibration.map((row) => repetitionsFor(row, extended)).join() === "10,10,4", `calibration rows take their own edit counts: ${calibration.map((row) => repetitionsFor(row, extended))}`)
  const [small, large] = [calibration.find((row) => row.name === "asset-swap-calibration-100"), calibration.find((row) => row.name === "asset-swap-calibration-300")]
  check(small !== undefined && small.fixture === "phase5:held-swap:100:5" && burstSchedule(small, 10).map((step) => step.edits[0]).join() === "sampler-swap-asset-1,sampler-swap-back,sampler-swap-asset-2,sampler-swap-back,sampler-swap-asset-3,sampler-swap-back,sampler-swap-asset-4,sampler-swap-back,sampler-swap-asset-5,sampler-swap-back",
    "the 100 MiB row swaps to five copies, each followed by a swap back")
  check(large !== undefined && large.fixture === "phase5:held-swap:300:1" && burstSchedule(large, 4).map((step) => step.edits[0]).join() === "sampler-swap-asset-1,sampler-swap-back,sampler-swap-asset-1,sampler-swap-back", "the 300 MiB row swaps to its one copy and back twice")
  // Launch plan: each merged launch is one burst launch, so a run costs one fixed launch cost per launch and the steps of its rows.
  const built = phase9Presets.cert.filter((row) => row.fixture !== null && row.repeat !== "launch" && row.transport === undefined)
  const launches = mergeLaunches(built)
  check(launches.length > 0 && launches.length < built.length, `${built.length} rows merge into ${launches.length} launches`)
  const ten: Requested = { preset: "cert", repetitions: 10 }
  check(near(wallSeconds([[attach], [fft]], ten), 2 * defaultTimings.launchSeconds + 20 * defaultTimings.stepSeconds), "two launches of ten alternating edits cost two launches and twenty steps")
  check(wallSeconds([], ten) === 0, "no rows, no launches")
  // A row that repeats by launch is its own launch, once per repetition, judged on its own capture.
  const delete1 = find("delete-while-starting")
  check(mergeLaunches([delete1, { ...delete1, start: delete1.cycle.at(-1)?.state ?? "" }]).length === 2 && mergeLaunches([fft, delete1]).length === 2, "a launch-repeat row never merges")
  const five: Requested = { preset: "cert", repetitions: 5 }
  check(launchesFor([delete1], five).length === 5 && launchesFor([fft], five).length === 1, "a launch-repeat row gives one launch per repetition")
  check(near(wallSeconds(launchesFor([delete1], five), five), 5 * 7.7), "a launch-repeat row costs its measured launch each time")
  // A row whose edits drive the transport is one launch of its own, whatever the repetitions.
  const driven = [find("host-failure-during-play"), find("pause-stop-during-play-start")]
  check(driven.every((row) => row.transport === "driven" && row.settle === "returned"), "the transport rows are driven and settle when their edits return")
  check(mergeLaunches(driven).length === 2 && mergeLaunches([...driven, fft]).length === 3, "a driven row never merges")
  check(launchesFor(driven, flagged).length === 2, "a driven row is one launch however many repetitions")
  // Its steps settle when the edit returns: no host evidence is awaited, and hold is asked for the spacing only.
  const drivenDirectory = await mkdtemp(path.join(tmpdir(), "ae08-phase9-driven-"))
  try {
    const performed: string[] = []
    const logged = await runBurst({ out: drivenDirectory, directory: drivenDirectory, row: find("pause-stop-during-play-start"), repetitions: 1, sampleRate: 48000, frameAt: () => 0,
      perform: async (edit) => { performed.push(edit); return { fromLatencyFrames: 0, toLatencyFrames: 0 } }, mark: async () => undefined,
      hold: async () => undefined, afterSettle: async () => undefined, deadlineMs: 1 })
    check(performed.join() === "session-pause,play-then-pause,play-resume,session-pause,play-then-stop,play-resume" && logged.every((edit) => edit.settledWallMs !== undefined),
      `the six cancelled-start edits run in order and settle without host evidence: ${performed}`)
  } finally { await rm(drivenDirectory, { recursive: true }) }
  check(mergeLaunches([find("vst-insert"), { ...find("vst-remove-undo"), start: "vst-absent" }]).length === 2, "different preparation does not merge")
  // The measured defaults: the certifying preset fits the budget with the 1.3x margin, fewer VST repetitions cost less, and a launch of a
  // `states` row adds its offline exports.
  const certLaunches = launchesFor(phase9Presets.cert, cert)
  const certMinutes = wallSeconds(certLaunches, cert) / 60
  check(certMinutes > 25 && certMinutes * 1.3 < BUDGET_SECONDS / 60, `the certifying preset models ${certMinutes} min`)
  check(wallSeconds(certLaunches, { preset: "cert", vstRepetitions: 10 }) < wallSeconds(certLaunches, cert), "fewer VST repetitions cost less wall time")
  check(near(wallSeconds([[find("tempo-burst")]], ten), defaultTimings.launchSeconds + 10 * defaultTimings.stepSeconds + defaultTimings.exportSeconds), "a states row adds one export pass to its launch")
  const plannedRows = planRows(certLaunches, cert)
  check(plannedRows.length === phase9Presets.cert.length && plannedRows.find((entry) => entry.row === "record-target-guard")?.repetitions === 15, "the plan lists every row of the preset with its repetitions")
  // Measured timings replace the defaults: a step is its edit-to-settle time plus the 1 s window.
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
    const evidenceObserver = createAe08Evidence(evidence)
    ae08ControlCommitReceived(evidenceObserver, { operation: "control.preview", input: { idempotencyKey: "preview-key" } })
    ae08ControlCommitReceived(evidenceObserver, { operation: "control.commit", input: { version: "v1" } })
    ae08ControlCommitReceived(evidenceObserver, { operation: "control.commit", input: { idempotencyKey: "commit-key" } })
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
  // The breakdown: a commit received at 1000 reaches graph-prepare at 1040, the request at 1060 and the publication at 1100; a second edit
  // has no prepare for its publication; a third has no publication.
  const line = (event: string, wallMs: number, fields: Partial<HostEvent> = {}) => ({ event, wallMs, pid: 7, ...fields })
  const lines = host(line("control-commit-received", 1000, { idempotencyKey: "commit-a" }), line("graph-prepare", 1040, { requestedRevision: 5 }), line("graph-publish-request", 1060, { requestedRevision: 5 }),
    line("graph-publish", 1100, { cause: "block-boundary", revision: 5, publicationFrame: 96256 }),
    line("graph-publish", 3100, { cause: "block-boundary", revision: 6, publicationFrame: 192256 }))
  const [timed, unprepared, unpublished] = editBreakdowns(lines, [{ index: 1, name: "tempo-137", wallMs: 1000 }, { index: 2, name: "tempo-120", wallMs: 3000 }, { index: 3, name: "tempo-137", wallMs: 4000 }])
  check(timed !== undefined && "toPublishMs" in timed && timed.toPrepareMs === 40 && timed.toRequestMs === 60 && timed.toPublishMs === 100 && timed.origin === "commit-received", `breakdown stages: ${JSON.stringify(timed)}`)
  // A UI edit has no commit line: it is timed from its ui-* mark (here 60 ms after the step start), and from the step start when the
  // evidence has no mark. A control commit ignores a ui-* mark inside its window.
  const uiLines = (...extra: object[]) => host(...extra, line("graph-prepare", 1090, { requestedRevision: 5 }), line("graph-publish-request", 1100, { requestedRevision: 5 }),
    line("graph-publish", 1130, { cause: "block-boundary", revision: 5, publicationFrame: 96256 }))
  const uiEdit = [{ index: 1, name: "undo", wallMs: 1000 }]
  const [markedUi] = editBreakdowns(uiLines(line("ui-undo", 1060, { key: "scope" })), uiEdit)
  check(markedUi !== undefined && "origin" in markedUi && markedUi.origin === "ui-undo" && markedUi.toPublishMs === 70 && markedUi.toPrepareMs === 30, `a UI edit is timed from its ui mark: ${JSON.stringify(markedUi)}`)
  const [unmarkedUi] = editBreakdowns(uiLines(), uiEdit)
  check(unmarkedUi !== undefined && "origin" in unmarkedUi && unmarkedUi.origin === "edit-start" && unmarkedUi.toPublishMs === 130, `evidence with no ui mark falls back to the step start: ${JSON.stringify(unmarkedUi)}`)
  const [controlUi] = editBreakdowns(uiLines(line("control-commit-received", 1000, { idempotencyKey: "c" }), line("ui-undo", 1060, { key: "scope" })), uiEdit)
  check(controlUi !== undefined && "origin" in controlUi && controlUi.origin === "commit-received" && controlUi.toPublishMs === 130, `a control commit is not re-timed by a ui mark: ${JSON.stringify(controlUi)}`)
  check(unprepared !== undefined && "missing" in unprepared && /no graph-prepare/.test(unprepared.missing), `a publication with no prepare line is reported: ${JSON.stringify(unprepared)}`)
  check(unpublished !== undefined && "missing" in unpublished && /no graph-publish/.test(unpublished.missing), `an edit with no publication is reported: ${JSON.stringify(unpublished)}`)
  check(timed !== undefined && "spans" in timed && timed.spans.length === 1 && timed.spans[0]?.from === "commit-received" && timed.spans[0].to === "graph-prepare" && timed.spans[0].ms === 40, `without marks the one span is commit to prepare: ${JSON.stringify(timed)}`)
  check(breakdownLine({ row: "r", breakdowns: [timed ?? { index: 0, name: "", missing: "" }] })[0]?.includes("no renderer marks in host.jsonl") === true, "the report says when the evidence has no renderer marks")
  // With marks: the commit's own marks, then the adoption whose prepare-sent is the last before graph-prepare (an earlier adoption's marks
  // under another key are ignored), then graph-prepare. Each span runs from one mark to the next.
  const mark = (event: string, wallMs: number, key: string) => line(event, wallMs, { key })
  const marked = host(line("control-commit-received", 1000, { idempotencyKey: "commit-a" }), mark("control-handler-entry", 1004, "commit-a"), mark("control-reload-before-done", 1020, "commit-a"),
    mark("control-commit-done", 1035, "commit-a"), mark("control-store-emitted", 1060, "commit-a"),
    mark("compile-start", 800, "old"), mark("prepare-sent", 900, "old"),
    mark("compile-start", 1061, "new"), mark("compile-instruments-ready", 1065, "new"), mark("compile-render-state-ready", 1070, "new"), mark("compile-processors-ready", 1072, "new"),
    mark("compile-end", 1073, "new"), mark("lane-admitted", 1080, "new"), mark("fence-open", 1081, "new"), mark("prepare-sent", 1082, "new"),
    line("graph-prepare", 1090, { requestedRevision: 5 }), line("graph-publish-request", 1100, { requestedRevision: 5 }),
    line("graph-publish", 1130, { cause: "block-boundary", revision: 5, publicationFrame: 96256 }))
  const [spanned] = editBreakdowns(marked, [{ index: 1, name: "tempo-137", wallMs: 1000 }])
  const names = spanned !== undefined && "spans" in spanned ? spanned.spans.map((span) => `${span.from}>${span.to}:${span.ms}`) : []
  check(names.join(" ") === "commit-received>control-handler-entry:4 control-handler-entry>control-reload-before-done:16 control-reload-before-done>control-commit-done:15 "
    + "control-commit-done>control-store-emitted:25 control-store-emitted>compile-start:1 compile-start>compile-instruments-ready:4 compile-instruments-ready>compile-render-state-ready:5 "
    + "compile-render-state-ready>compile-processors-ready:2 compile-processors-ready>compile-end:1 compile-end>lane-admitted:7 lane-admitted>fence-open:1 fence-open>prepare-sent:1 prepare-sent>graph-prepare:8", `marked spans: ${names.join(" ")}`)
  check(breakdownLine({ row: "r", breakdowns: spanned ? [spanned] : [] })[0]?.includes("compile-end -> lane-admitted 7 ms") === true, "the report lists every span")
  // An asset publication hydrates between graph-prepare and graph-publish-request; only the marks of the adoption that sent the prepare count.
  const hydrating = host(mark("prepare-sent", 1082, "new"), mark("asset-create-request", 1000, "old"), line("graph-prepare", 1090, { requestedRevision: 5 }),
    mark("asset-create-request", 1091, "new"), mark("asset-create-reply", 1093, "new"), mark("asset-candidate-pages-start", 1094, "new"),
    mark("asset-page-write-request", 1095, "new"), mark("asset-page-write-reply", 1107, "new"), mark("asset-range-request", 1108, "new"), mark("asset-range-reply", 1110, "new"),
    mark("asset-candidate-pages-end", 1111, "new"), line("graph-publish-request", 1175, { requestedRevision: 5 }),
    line("graph-publish", 1210, { cause: "block-boundary", revision: 5, publicationFrame: 96256 }))
  const [assetPublication] = editBreakdowns(hydrating, [{ index: 1, name: "swap", wallMs: 1000 }])
  const hydration = assetPublication !== undefined && "hydration" in assetPublication ? assetPublication.hydration.map((span) => `${span.from}>${span.to}:${span.ms}`) : []
  check(hydration.join(" ") === "graph-prepare>asset-create-request:1 asset-create-request>asset-create-reply:2 asset-create-reply>asset-candidate-pages-start:1 "
    + "asset-candidate-pages-start>asset-page-write-request:1 asset-page-write-request>asset-page-write-reply:12 asset-page-write-reply>asset-range-request:1 "
    + "asset-range-request>asset-range-reply:2 asset-range-reply>asset-candidate-pages-end:1 asset-candidate-pages-end>graph-publish-request:64", `hydration spans: ${hydration.join(" ")}`)
  check(breakdownLine({ row: "r", breakdowns: assetPublication ? [assetPublication] : [] })[0]?.includes("asset-page-write-request -> asset-page-write-reply 12 ms") === true, "the report lists the hydration spans")
  check(spanned !== undefined && "hydration" in spanned && spanned.hydration.length === 0, "a publication with no asset marks has no hydration spans")
  // The prepare split: the reply and bind marks of the adoption that sent the prepare (an earlier adoption's are ignored) join the host's
  // prepare-profile and prepare-step lines. The reply and bind marks are not adoption spans before graph-prepare.
  const splitting = host(mark("prepare-reply-received", 900, "old"), mark("prepare-sent", 1082, "new"), line("graph-prepare", 1090, { requestedRevision: 5 }),
    line("prepare-profile", 1094, { requestedRevision: 5, stepsUs: "vst-control=100;host-pre=200;core=3000;host-post=700;" }), line("prepare-step", 1095, { step: "graph-prepare-reply", durationMs: 0.5 }),
    mark("prepare-reply-received", 1100, "new"), mark("bind-request-sent", 1103, "new"), line("graph-publish-request", 1105, { requestedRevision: 5 }),
    line("graph-publish", 1130, { cause: "block-boundary", revision: 5, publicationFrame: 96256 }))
  const [splitPublication] = editBreakdowns(splitting, [{ index: 1, name: "swap", wallMs: 1000 }])
  const splitText = splitPublication !== undefined && "split" in splitPublication && splitPublication.split ? splitLine(splitPublication.split) : ""
  check(splitText === "host prepare 4 ms, reply write 0.5 ms, host to renderer 5.5 ms, renderer work 3 ms, renderer to host bind 2 ms", `prepare split: ${splitText}`)
  check(splitPublication !== undefined && "spans" in splitPublication && !splitPublication.spans.some((span) => span.from.includes("reply") || span.to.includes("bind")), "the split marks are not spans before graph-prepare")
  check(breakdownLine({ row: "r", breakdowns: splitPublication ? [splitPublication] : [] })[0]?.includes("(prepare split: host prepare 4 ms") === true, "the report prints the prepare split")
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
// A run measures launches and steps; the offline export cost stays the default's.
export const readTimings = async (file: string): Promise<Timings> => {
  const measured = timingsSchema.parse(JSON.parse(await readFile(file, "utf8")))
  return { launchSeconds: measured.launchSeconds ?? defaultTimings.launchSeconds, stepSeconds: measured.stepSeconds ?? defaultTimings.stepSeconds,
    vstStepSeconds: measured.vstStepSeconds ?? defaultTimings.vstStepSeconds, exportSeconds: defaultTimings.exportSeconds }
}

const usage = "Usage: ae-08-phase-9-matrix.ts --self-test | --plan [--matrix cert|extended|full] [--repetitions N] [--vst-repetitions N] [--timings phase9-timings.json]"
const plan = async (args: string[]) => {
  const flag = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  const preset = presetNamed.get(flag("--matrix") ?? "cert")
  if (!preset) throw new Error(usage)
  const [repetitions, vstRepetitions] = [flag("--repetitions"), flag("--vst-repetitions")]
  const requested: Requested = { preset, ...(repetitions && { repetitions: Number(repetitions) }), ...(vstRepetitions && { vstRepetitions: Number(vstRepetitions) }) }
  const timingsFile = flag("--timings")
  const timings = timingsFile ? await readTimings(timingsFile) : defaultTimings
  console.log(`preset: ${preset}, timings: ${timings === defaultTimings ? "default (measured, plan section 1)" : `measured, ${timingsFile}`} ${JSON.stringify(timings)}`)
  const rows = phase9Presets[preset]
  const launches = launchesFor(rows.filter((row) => row.fixture !== null), requested)
  for (const entry of planRows(launches, requested, timings))
    console.log(`${entry.row.padEnd(34)} ${String(entry.repetitions).padStart(4)} repetitions ${String(entry.stepsPerLaunch).padStart(4)} steps per launch ${(entry.seconds / 60).toFixed(1).padStart(5)} min`)
  for (const row of rows.filter((entry) => entry.fixture === null)) console.log(`${row.name.padEnd(34)} MISSING: ${row.needs}`)
  const minutes = wallSeconds(launches, requested, timings) / 60
  console.log(`rows: ${rows.length}, launches after merging: ${launches.length}, modeled wall time ${minutes.toFixed(1)} min (${(minutes * 1.3).toFixed(1)} with a 1.3x margin) against ${BUDGET_SECONDS / 60}`)
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") await selfTest()
  else if (Bun.argv[2] === "--plan") await plan(Bun.argv.slice(3))
  else throw new Error(usage)
}
