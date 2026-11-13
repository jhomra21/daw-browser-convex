#!/usr/bin/env bun
import { watch } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"

// AE-08 phase 9 matrix (plan §8 steps 1-2): one packaged launch per row class carries N alternating edits. This file owns
// the row table, the burst schedule, settling on host evidence, the reference rule, fail-fast judging, pooled statistics,
// launch merging and the wall-time budget. PCM comparison per oracle window belongs to the analyzer (§8 step 4); here it is
// the `compare` callback. The runner (ae-08-live-graph.ts --phase 9) calls these; there is no second runner protocol.
//
//   bun tools/acceptance/ae-08-phase-9-matrix.ts --self-test
//   bun tools/acceptance/ae-08-phase-9-matrix.ts --plan [--repetitions N] [--vst-repetitions N]

// The class each row declares for ae-08-latency-gates.ts (its latency-class.json).
export type LatencyClass = "plain" | "raise" | "asset" | "vst-insert"
type Step = { edits: string[]; state: string }
export type Row = {
  name: string
  latencyClass: LatencyClass
  // burst: --repetitions edits. vst-burst: --vst-repetitions edits. single: one pass of the cycle.
  repeat: "burst" | "vst-burst" | "single"
  // Loop-periodic rows (output in a state repeats every periodSec) get short per-state references; others get one full-length one.
  periodSec: number | null
  // The existing runner fixture whose setup builds the start state, or null when no current fixture can.
  fixture: string | null
  start: string
  cycle: Step[]
  // What a launch of this row needs that no current fixture provides.
  needs?: string
}

const effectState = "phase5:effect-state"
export const phase9Matrix: Row[] = [
  { name: "attach-remove-long-latency", latencyClass: "raise", repeat: "burst", periodSec: null, fixture: effectState, start: "spectral-512",
    cycle: [{ edits: ["spectral-remove"], state: "spectral-absent" }, { edits: ["spectral-attach"], state: "spectral-512" }] },
  { name: "fft-transition", latencyClass: "raise", repeat: "burst", periodSec: null, fixture: effectState, start: "spectral-512",
    cycle: [{ edits: ["fft-4096"], state: "spectral-4096" }, { edits: ["fft-512"], state: "spectral-512" }] },
  { name: "raise-lower-burst", latencyClass: "raise", repeat: "burst", periodSec: null, fixture: effectState, start: "spectral-512",
    cycle: [{ edits: ["fft-4096", "fft-512"], state: "spectral-512" }] },
  { name: "lookahead-transition", latencyClass: "raise", repeat: "burst", periodSec: null, fixture: null, start: "limiter-lookahead-0",
    cycle: [{ edits: ["lookahead-5ms"], state: "limiter-lookahead-5" }, { edits: ["lookahead-0ms"], state: "limiter-lookahead-0" }],
    needs: "effect-state variant with a Limiter (lookaheadMs 0 and 5) in place of Spectral; the setup builds only Spectral and Utility" },
  { name: "undo-redo-burst", latencyClass: "plain", repeat: "burst", periodSec: null, fixture: "phase5:remove-readd-track", start: "restored",
    cycle: [{ edits: ["track-delete"], state: "deleted" }, { edits: ["undo"], state: "restored" },
      { edits: ["redo"], state: "deleted" }, { edits: ["undo"], state: "restored" }] },
  { name: "delete-while-starting", latencyClass: "plain", repeat: "burst", periodSec: null, fixture: "phase5:delete-clip", start: "clip-restored-stopped",
    cycle: [{ edits: ["play", "clip-delete"], state: "clip-deleted-playing" }, { edits: ["stop", "undo"], state: "clip-restored-stopped" }] },
  { name: "paged-playback", latencyClass: "asset", repeat: "burst", periodSec: null, fixture: "phase5:add-paged-asset", start: "paged-asset-absent",
    cycle: [{ edits: ["asset-import"], state: "paged-asset-present" }, { edits: ["asset-clip-delete"], state: "paged-asset-absent" }] },
  { name: "held-note-unrelated-edit", latencyClass: "plain", repeat: "burst", periodSec: null, fixture: "phase5:held-note", start: "base",
    cycle: [{ edits: ["track-create"], state: "extra-track" }, { edits: ["track-delete"], state: "base" }] },
  { name: "tempo-burst", latencyClass: "plain", repeat: "burst", periodSec: null, fixture: "phase5:raw-tempo", start: "tempo-120",
    cycle: [{ edits: ["tempo-137"], state: "tempo-137" }, { edits: ["tempo-120"], state: "tempo-120" }] },
  { name: "manual-automation-override", latencyClass: "plain", repeat: "burst", periodSec: null, fixture: null, start: "lane-armed",
    cycle: [{ edits: ["knob-drag"], state: "lane-overridden" }, { edits: ["lane-rearm"], state: "lane-armed" }],
    needs: "an automation lane on the Utility gain plus a UI knob drag during playback; effect-state has the drag but no lane" },
  { name: "sustained-live-midi", latencyClass: "plain", repeat: "burst", periodSec: null, fixture: null, start: "base",
    cycle: [{ edits: ["track-create"], state: "extra-track" }, { edits: ["track-delete"], state: "base" }],
    needs: "a live MIDI input source (virtual port or device) holding a note on an instrument track; no fixture drives MIDI input" },
  { name: "record-target-guard", latencyClass: "plain", repeat: "burst", periodSec: null, fixture: null, start: "armed",
    cycle: [{ edits: ["target-edit"], state: "armed" }],
    needs: "an input device and a take that is actually recording (11c: effect-state arms a track for monitoring only)" },
  { name: "unaffected-input", latencyClass: "plain", repeat: "burst", periodSec: null, fixture: null, start: "recording",
    cycle: [{ edits: ["unrelated-edit"], state: "recording" }],
    needs: "recording + unrelated edit (11c): input device, an open take, and independent take verification" },
  { name: "vst-insert", latencyClass: "vst-insert", repeat: "vst-burst", periodSec: null, fixture: null, start: "vst-absent",
    cycle: [{ edits: ["vst-insert"], state: "vst-present" }, { edits: ["vst-remove"], state: "vst-absent" }],
    needs: "VST insert row in the phase 5 fixture shape; the trusted Valhalla flow exists only in run() for phases 1-4 (11c)" },
  { name: "vst-remove-undo", latencyClass: "plain", repeat: "vst-burst", periodSec: null, fixture: null, start: "vst-present",
    cycle: [{ edits: ["vst-remove"], state: "vst-absent" }, { edits: ["undo"], state: "vst-present" }],
    needs: "the same VST insert fixture, started with the plug-in present" },
  { name: "vst-latency-switch", latencyClass: "raise", repeat: "vst-burst", periodSec: null, fixture: null, start: "latency-low",
    cycle: [{ edits: ["latency-high"], state: "latency-high" }, { edits: ["latency-low"], state: "latency-low" }],
    needs: "the phase 6 test plug-in with a latency switch, reached through the packaged runner (also covers live latency notification)" },
  { name: "open-editor", latencyClass: "vst-insert", repeat: "single", periodSec: null, fixture: null, start: "vst-present",
    cycle: [{ edits: ["editor-open"], state: "editor-open" }],
    needs: "the VST insert fixture plus a UI step that opens the plug-in editor" },
  { name: "faulty-plugin", latencyClass: "vst-insert", repeat: "single", periodSec: null, fixture: null, start: "vst-absent",
    cycle: [{ edits: ["faulty-insert"], state: "vst-failed" }],
    needs: "the phase 6 test plug-in with its fault switch; the packaged runner has only the Valhalla path" },
  { name: "trust-negative", latencyClass: "vst-insert", repeat: "single", periodSec: null, fixture: null, start: "vst-absent",
    cycle: [{ edits: ["untrusted-insert"], state: "vst-rejected" }],
    needs: "an untrusted or fingerprint-changed plug-in in the packaged profile" },
]
export const phase9Rows = phase9Matrix.map((row) => row.name)

export const repetitionsFor = (row: Row, repetitions: number, vstRepetitions: number) =>
  row.repeat === "single" ? 1 : row.repeat === "vst-burst" ? vstRepetitions : repetitions

// A burst always ends on the row's start state: it is rounded up to whole cycles.
export const burstSchedule = (row: Row, repetitions: number) =>
  Array.from({ length: Math.ceil(repetitions / row.cycle.length) }).flatMap((_, round) =>
    row.cycle.map((step, position) => ({ index: round * row.cycle.length + position + 1, ...step })))

// Rows share a launch only where one fixture and class build both, and the state after one row's burst is the next row's start.
export const mergeLaunches = (rows: readonly Row[]) => rows.reduce<Row[][]>((launches, row) => {
  const last = launches.at(-1), tail = last?.at(-1)
  const joins = last && tail && tail.fixture !== null && tail.fixture === row.fixture && tail.latencyClass === row.latencyClass
    && tail.repeat === row.repeat && tail.periodSec === row.periodSec && tail.cycle.at(-1)?.state === row.start
  return joins ? [...launches.slice(0, -1), [...last, row]] : [...launches, [row]]
}, [])

// Timing assumptions of plan §8 (about 2 s to settle plus the 1 s oracle window per edit; 20 s per VST insert, measured in phase 6
// first) and the phase 8 smoke (about 10 s per launch plus import and reload). Replace them with C2 timings.
export const LAUNCH_SECONDS = 25
export const STEP_SECONDS = 3
export const VST_STEP_SECONDS = 20
const REFERENCE_PERIODS = 2

type Reference = { kind: "full-length"; seconds: number } | { kind: "per-state"; states: string[]; seconds: number }
export const referencePlan = (row: Row, steps: number): Reference => row.periodSec === null
  ? { kind: "full-length", seconds: steps * (row.repeat === "vst-burst" ? VST_STEP_SECONDS : STEP_SECONDS) }
  : { kind: "per-state", states: [...new Set(row.cycle.map((step) => step.state))], seconds: REFERENCE_PERIODS * row.periodSec }

// A launch is its merged rows' bursts plus one reference launch (per state for periodic rows, one per state's seconds), and each
// latency class adds one calibration launch as long as its longest reference.
export const wallSeconds = (launches: readonly Row[][], repetitions: number, vstRepetitions: number) => {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const costs = launches.map((launch) => {
    const bursts = launch.map((row) => {
      const steps = burstSchedule(row, repetitionsFor(row, repetitions, vstRepetitions)).length
      return { steps, burst: steps * (row.repeat === "vst-burst" ? VST_STEP_SECONDS : STEP_SECONDS), row }
    })
    const burst = sum(bursts.map((entry) => entry.burst))
    const first = bursts[0]
    const reference = first === undefined ? 0 : sum(bursts.map((entry) => {
      const plan = referencePlan(entry.row, entry.steps)
      return plan.kind === "per-state" ? plan.states.length * plan.seconds : plan.seconds
    }))
    return { latencyClass: first?.row.latencyClass, burst, reference }
  })
  const longest = new Map<LatencyClass | undefined, number>()
  for (const cost of costs) longest.set(cost.latencyClass, Math.max(longest.get(cost.latencyClass) ?? 0, cost.reference))
  return sum(costs.map((cost) => 2 * LAUNCH_SECONDS + cost.burst + cost.reference)) + sum([...longest.values()].map((reference) => LAUNCH_SECONDS + reference))
}

// ---- Settling on host evidence ----
const hostEventSchema = z.object({ event: z.string(), cause: z.string().default(""), wallMs: z.number().default(0),
  revision: z.number().default(0), frame: z.number().default(0), publicationFrame: z.number().default(0), transportEpoch: z.number().default(0) })
export type HostEvent = z.infer<typeof hostEventSchema>
export class SetupFailure extends Error {}

// A torn trailing line is a record still being written.
export const parseHostLines = (text: string) => text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean)
  .map((line) => hostEventSchema.parse(JSON.parse(line)))

// Publication-complete: the first in-place publication at or after the edit; for a raise also its latency-move-complete.
export const publicationComplete = (events: readonly HostEvent[], sinceWallMs: number, raise: boolean) => {
  const publish = events.find((event) => event.event === "graph-publish" && event.cause === "block-boundary"
    && event.publicationFrame > 0 && event.wallMs >= sinceWallMs)
  if (!publish || !raise) return publish?.wallMs
  return events.find((event) => event.event === "latency-move-complete" && event.revision === publish.revision
    && event.transportEpoch === publish.transportEpoch && event.frame >= publish.publicationFrame)?.wallMs
}

const nativeEvents = async (out: string) => (await Promise.all((await readdir(out)).filter((name) => /^native-\d+\.jsonl$/.test(name))
  .map(async (name) => parseHostLines(await readFile(path.join(out, name), "utf8"))))).flat()

// The host appends native-<pid>.jsonl as it runs (native/acceptance-evidence.h), so this waits on file changes. The deadline only
// reports a missing line as a setup failure; it never counts as a pass.
export const awaitPublicationComplete = (out: string, sinceWallMs: number, raise: boolean, deadlineMs: number) =>
  new Promise<number>((resolve, reject) => {
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
        const wallMs = publicationComplete(await nativeEvents(out), sinceWallMs, raise)
        if (wallMs !== undefined) finish(() => resolve(wallMs))
      } catch (error) { finish(() => reject(error)) }
    }
    void check()
  })

// ---- Per-launch capture ----
export type LoggedEdit = { index: number; name: string; wallMs: number; settledWallMs: number | undefined;
  fromLatencyFrames: number; toLatencyFrames: number }
export type Perform = (edit: string) => Promise<{ fromLatencyFrames: number; toLatencyFrames: number }>
const SETTLE_DEADLINE_MS = 15_000

// Runs one row's burst inside a launch. Each step's edits run together; the step settles once, when the host has logged the
// publication. Writes phase9-edits.json (the shape ae-08-latency-gates.ts reads) and latency-class.json even when a step fails.
export const runBurst = async (input: { out: string; row: Row; repetitions: number; perform: Perform
  mark: (event: string, fields?: Record<string, string | number | boolean>) => Promise<void> }) => {
  const { out, row, mark } = input
  const logged: LoggedEdit[] = []
  try {
    for (const step of burstSchedule(row, input.repetitions)) {
      const wallMs = Date.now()
      await mark("burst-edit-start", { row: row.name, index: step.index })
      const moves = []
      for (const edit of step.edits) moves.push({ name: edit, ...await input.perform(edit) })
      const raise = moves.some((move) => move.toLatencyFrames > move.fromLatencyFrames)
      const settledWallMs = await awaitPublicationComplete(out, wallMs, raise, SETTLE_DEADLINE_MS)
      await mark("burst-settled", { row: row.name, index: step.index, settledWallMs })
      for (const move of moves) logged.push({ index: step.index, wallMs, settledWallMs, ...move })
    }
  } finally {
    await writeFile(path.join(out, "phase9-edits.json"), JSON.stringify({ phase: 9, row: row.name, edits: logged }, null, 2))
    await writeFile(path.join(out, "latency-class.json"), JSON.stringify({ class: row.latencyClass }))
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
  edits: z.array(z.object({ wallMs: z.number(), fromLatencyFrames: z.number().default(0), toLatencyFrames: z.number().default(0) })).default([]),
  commits: z.array(z.object({ wallMs: z.number() })).default([]),
  effectState: z.object({ fromLatencyFrames: z.number(), toLatencyFrames: z.number() }).optional(),
})
const editFiles = ["phase4-edits.json", "phase5-edits.json", "phase8-edits.json"]

// A stored row is judged as a burst of its edits. Phase 4 logs each edit; phase 5 logs the commits that follow an edit start (the
// effect-state row logs the FFT click as an action); phase 8 logs one edit start.
export const judgeStoredRow = async (directory: string, file: string) => {
  const plan = planSchema.parse(JSON.parse(await readFile(path.join(directory, file), "utf8")))
  const host = parseHostLines(await readFile(path.join(directory, "host.jsonl"), "utf8"))
  const actions = await jsonl(path.join(directory, "actions.jsonl"))
  const end = wallOf(actions, "capture-end")
  const edits = plan.phase === 4 ? plan.edits.map((edit) => ({ wallMs: edit.wallMs, raise: edit.toLatencyFrames > edit.fromLatencyFrames }))
    : plan.effectState ? [{ wallMs: wallOf(actions, "effect-fft-edit"), raise: plan.effectState.toLatencyFrames > plan.effectState.fromLatencyFrames }]
      : plan.phase === 8 ? [{ wallMs: z.number().parse(plan.editStart), raise: false }]
        : [z.number().parse(plan.editStart), ...plan.commits.map((commit) => commit.wallMs)].slice(0, Math.max(1, plan.commits.length))
          .map((wallMs) => ({ wallMs, raise: false }))
  const steps = edits.map((edit, position) => ({ index: position + 1, editWallMs: edit.wallMs,
    settledWallMs: publicationComplete(host, edit.wallMs, edit.raise) }))
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
  check(publicationComplete(host(publish), 900, false) === 1000, "a plain edit settles on its publication")
  check(publicationComplete(host(publish), 900, true) === undefined, "a raise is not settled before its latency-move-complete")
  check(publicationComplete(host(publish, moved), 900, true) === 1100, "a raise settles on latency-move-complete")
  check(publicationComplete(host(publish, moved), 1001, false) === undefined, "a publication before the edit is not the edit's")
  check(publicationComplete(host({ ...publish, publicationFrame: 0 }), 900, false) === undefined, "a publication at frame 0 is startup, not an edit")
  check(parseHostLines(`${JSON.stringify(publish)}\n{"event":"gra`).length === 1, "a torn trailing line is ignored")
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
  const shortReferences = referencePlan(periodic, 100)
  check(shortReferences.kind === "per-state" && shortReferences.states.length === 2 && shortReferences.seconds === 2, "a periodic row gets two short per-state references")
  const fullReference = referencePlan(fft, 100)
  check(fullReference.kind === "full-length" && fullReference.seconds === 300, "another row gets one full-length capture")
  check(find("vst-insert").repeat === "vst-burst" && find("open-editor").repeat === "single", "VST repeat classes")
  check(repetitionsFor(find("vst-insert"), 100, 20) === 20 && repetitionsFor(find("open-editor"), 100, 20) === 1
    && repetitionsFor(fft, 100, 20) === 100, "repetitions per class")
  check(mergeLaunches([attach, fft, burst]).length === 1, "rows that end where the next starts share a launch")
  check(mergeLaunches([attach, { ...fft, start: "spectral-4096" }]).length === 2, "a row whose start state is not the previous end does not merge")
  check(mergeLaunches([attach, { ...fft, fixture: "phase5:held-note" }]).length === 2, "different fixtures do not merge")
  check(mergeLaunches([attach, { ...fft, latencyClass: "plain" }]).length === 2, "different latency classes do not merge")
  check(phase9Matrix.every((row) => (row.fixture === null) === (row.needs !== undefined)), "a row is missing exactly when it names what it needs")
  check(new Set(phase9Rows).size === phase9Rows.length, "row names are distinct")
  // The live wait: a line appended later resolves it; no line is a SetupFailure when the deadline passes, never a pass.
  const directory = await mkdtemp(path.join(tmpdir(), "ae08-phase9-"))
  try {
    const waiting = awaitPublicationComplete(directory, 900, false, 5_000)
    await writeFile(path.join(directory, "native-1.jsonl"), `${JSON.stringify(publish)}\n`)
    check(await waiting === 1000, "the live wait resolves on the appended publication")
    const none = await awaitPublicationComplete(directory, 2000, false, 200).then(() => "resolved", (error) => error instanceof SetupFailure ? "setup" : "other")
    check(none === "setup", `no line before the deadline is a SetupFailure, got ${none}`)
  } finally { await rm(directory, { recursive: true }) }
  console.log("ae-08 phase 9 matrix self-test: pass")
}

const plan = (args: string[]) => {
  const number = (flag: string, fallback: number) => Number(args[args.indexOf(flag) + 1] ?? fallback)
  const repetitions = number("--repetitions", 20), vstRepetitions = number("--vst-repetitions", 20)
  const built = phase9Matrix.filter((row) => row.fixture !== null)
  for (const row of phase9Matrix) {
    const steps = burstSchedule(row, repetitionsFor(row, repetitions, vstRepetitions)).length
    console.log(`${row.name.padEnd(28)} ${row.latencyClass.padEnd(10)} ${String(steps).padStart(4)} edits  ${row.fixture ?? `MISSING: ${row.needs}`}`)
  }
  const launches = mergeLaunches(built)
  console.log(`built rows: ${built.length}/${phase9Matrix.length}, launches after merging: ${launches.length}`)
  console.log(`wall time, built rows: ${(wallSeconds(launches, repetitions, vstRepetitions) / 60).toFixed(1)} min; all rows built: ${(wallSeconds(mergeLaunches(phase9Matrix), repetitions, vstRepetitions) / 60).toFixed(1)} min`)
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") await selfTest()
  else if (Bun.argv[2] === "--plan") plan(Bun.argv.slice(3))
  else throw new Error("Usage: ae-08-phase-9-matrix.ts --self-test | --plan [--repetitions N] [--vst-repetitions N]")
}
