import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import path from "node:path"
import { z } from "zod"
import createHookFixture from "./ae-08-processor-state-fuzz-hook"
import type { Action } from "./ae-08-processor-state-fuzz-host"
import { hookClassTable, mutationSchema } from "./ae-08-processor-state-fuzz-hook-classes"
import { classifyFailure, gateSteps, gateViolations } from "./ae-08-processor-state-fuzz-classes"
import runHookScenario, { step5GuardScenarios, step5LiveScenarios } from "./ae-08-processor-state-fuzz-hook-scenarios"
import { a2cScenarios } from "./ae-08-processor-state-fuzz-hook-scenarios-a2c"
import minimizeHookWitness from "./ae-08-processor-state-fuzz-hook-minimize"
import createSeedTrace, { traceSchema, type Trace } from "./ae-08-processor-state-fuzz-trace"

const actionSchema = z.object({ kind: z.string(), id: z.number().optional(), scope: z.number().optional(),
  value: z.number().optional(), sequence: z.number().optional(), mode: z.string().optional() })
const replaySchema = z.object({ seed: z.number(), mutation: mutationSchema.optional(), actions: z.array(actionSchema) })
const replacer = <Value>(_key: string, field: Value) => {
  const parsed = z.bigint().safeParse(field)
  return parsed.success ? parsed.data.toString() : field
}
const json = <Value>(value: Value) => JSON.stringify(value, replacer, 2)
const write = <Value>(file: string, value: Value) => writeFileSync(file, `${json(value)}\n`)
const randomFor = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value)
    return ((value ^ value >>> 14) >>> 0) / 0x100000000
  }
}
export default async function runHookCampaign(argv = process.argv) {
  const root = path.resolve(import.meta.dir, "../..")
  const sources = ["src/hooks/useTimelinePlayback.ts", "src/components/timeline/create-effects-panel-audio-effects-state.ts",
    "src/lib/desktop/native-playback-controller.ts", "src/lib/local-effects.ts",
    "src/lib/desktop/native-processor-state-owner.ts", "src/lib/desktop/native-built-in-parameter-mapper.ts",
    "src/lib/live-processor-control.ts", "src/components/timeline/create-processor-edit-registry.ts",
    "src/components/timeline/create-timeline-effect-commit.ts",
    ...["", "-fixture", "-host", "-oracle", "-hook", "-hook-runner", "-virtual-time", "-hook-classes", "-hook-scenarios", "-hook-scenarios-a2c", "-hook-minimize", "-classes",
      "-hook-history", "-hook-checks", "-trace",
      "-hook-bridge", "-hook-edits", "-hook-waiters", "-hook-bank-checks", "-hook-buffer", "-edit", "-witness"]
      .map((suffix) => `tools/acceptance/ae-08-processor-state-fuzz${suffix}.ts`)]
  const sourceHashes = Object.fromEntries(sources.map((file) =>
    [file, createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex")]))
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const options = { seed: 1, seeds: 100, steps: 2000, drainSteps: 1000,
    out: path.resolve("acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/a2a-p2"),
    replay: "", mutation: "", scenario: "", gate: "" }
  let trace: Trace = "failures"
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]
    if (key === "--starve-refill") { options.scenario = "starve-refill"; index--; continue }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing ${key}`)
    if (key === "--fixture" && value === "hook") continue
    if (key === "--out") options.out = path.resolve(value)
    else if (key === "--replay") options.replay = path.resolve(value)
    else if (key === "--plant") options.mutation = value
    else if (key === "--gate") options.gate = value
    else if (key === "--trace") trace = traceSchema.parse(value)
      else if (key === "--scenario") options.scenario = z.enum(["lifecycle-deadline", "control-watchdog", "revision-deadline",
        "prefix-1", "prefix-6", "prefix-8", "prefix-9", "identity-same", "identity-changed", "stale-compile", "starve-refill", "late-cancel", "late-pause", "late-seek", "late-loop", "domain-timeout", "pause-latency", "prefix-10", "patch-install", "explicit-retry", "capacity-reopen", "retained-candidate", "progress-only", "explicit-context", "intent-aba", "edits-during-compile", "retained-seek", "pending-attempt", "parked-latency", "parked-page-hold", "seek-claimed-publication", ...a2cScenarios, ...step5LiveScenarios, ...step5GuardScenarios]).parse(value)
    else if (["--seed", "--seeds", "--steps", "--drain-steps"].includes(key ?? "")) {
      const number = z.coerce.number().int().positive().parse(value)
      if (key === "--seed") options.seed = number
      if (key === "--seeds") options.seeds = number
      if (key === "--steps") options.steps = number
      if (key === "--drain-steps") options.drainSteps = number
    } else throw new Error(`Unknown hook argument ${key}`)
  }
  if (options.gate && !gateSteps.includes(options.gate)) throw new Error(`Unknown gate ${options.gate}`)
  const mutation = options.mutation ? mutationSchema.parse(options.mutation) : undefined
  const replay = options.replay ? replaySchema.parse(JSON.parse(readFileSync(options.replay, "utf8"))) : undefined
  const summaries = []
  const started = performance.now()
  mkdirSync(options.out, { recursive: true })
  write(path.join(options.out, "classes.json"), hookClassTable)
  for (let offset = 0; offset < (replay ? 1 : options.seeds); offset++) {
    const seed = replay?.seed ?? options.seed + offset
    const planted = replay?.mutation ?? mutation
    const directory = path.join(options.out, `seed-${seed}`)
    mkdirSync(directory, { recursive: true })
    const seedTrace = createSeedTrace(trace, directory, (value) => `${json(value)}\n`)
    seedTrace.seed({ seed, fixture: "hook", generatorVersion: "hook-a2a-p2-v1",
      head, sourceHashes, mutation: planted, scenario: options.scenario,
      bounds: { steps: options.steps, drainSteps: options.drainSteps, checkpointTurns: 100 } })
    let step = 0
    const actions: Action[] = []
    let adoptionOutstanding = false
    let sawClaimedTransportRefusal = false
    const record = <Value>(event: Value) => {
      const observed = z.object({ event: z.string() }).safeParse(event)
      if (observed.success && observed.data.event === "adoption-waiting") adoptionOutstanding = true
      if (observed.success && observed.data.event === "adoption-prepared") adoptionOutstanding = false
      if (observed.success && observed.data.event === "transport-refused") sawClaimedTransportRefusal = true
      seedTrace.record(`${JSON.stringify({ step, event }, replacer)}\n`)
    }
    const fixture = await createHookFixture(record, seed, planted,
      options.scenario === "instrument-urgent" || replay?.actions.some((action) => action.kind.startsWith("synth-")) === true)
    const act = async (action: Action) => {
      // A drain that ran out of budget with an adoption still waiting is not drained, even when native and desired agree.
      if (action.kind === "check" && action.mode === "drained" && adoptionOutstanding)
        throw new Error("Drain ended with an adoption still outstanding")
      if (action.kind === "loss" || action.kind === "dispose") beforeCleanup ??= structuredClone(fixture.state())
      actions.push(action); step++
      if (action.kind === "check") fixture.check(action.mode)
      else await fixture.act(action)
      if (action.kind === "loss" || action.kind === "dispose") adoptionOutstanding = false
    }
    let turn = 0
    const nextFair = () => {
      const enabled = fixture.enabled()
      const immediate = enabled.find((entry) => ["control-wake", "deliver-reply", "resolve-compile",
        "publication-acknowledge", "idb-task", "lifecycle-ready"].includes(entry.kind))
      if (immediate) return immediate
      if (fixture.needsReclaim()) return { kind: "reclaim" }
      const panelFrame = fixture.time.enabled().find((entry) => entry.kind === "raf-tick" && entry.site.includes("parameter-gesture-owner"))
      if (panelFrame) return { kind: panelFrame.kind, id: panelFrame.id }
      // Fair native callbacks beat timeout fault injection.
      const kind = turn++ % 2 ? "deliver-progress" : "render-block"
      const next = enabled.find((entry) => entry.kind === kind)
      return next ?? enabled.find((entry) => entry.kind === "raf-tick")
        ?? enabled.find((entry) => entry.kind === "render-block")
        ?? enabled.find((entry) => entry.kind === "deliver-progress")
        ?? enabled.find((entry) => entry.kind === "fire-timer")
    }
    const drain = async () => {
      for (let index = 0; index < options.drainSteps; index++) {
        if (fixture.idle() && !adoptionOutstanding) break
        const action = nextFair()
        if (!action) break
        await act(action)
      }
    }
    let error: unknown
    let beforeCleanup: ReturnType<typeof fixture.state> | undefined
    try {
      if (replay) {
        for (const action of replay.actions) await act(action)
      } else {
        // Exercise the hook-owned lifecycle wait before releasing readiness.
        await act({ kind: "start" })
        await act({ kind: "lifecycle-ready" })
        await drain()
        await act({ kind: "start" })
        await drain()
        if (!fixture.state().activeRevision || !fixture.state().playing || fixture.state().preparing)
          throw new Error("Hook did not start playback after fair initialization")
        if (options.scenario === "seek-claimed-publication") {
          const random = randomFor(seed)
          for (let index = 0; index < options.steps && actions.length < 154; index += 1) {
            const choice = random()
            const enabled = fixture.enabled().filter((entry) => entry.kind !== "fire-timer")
            if (choice < 0.02) await act({ kind: "gain", value: -1 - Math.floor(random() * 23) })
            else if (choice < 0.03) await act({ kind: random() < 0.5 ? "preview" : "flush", value: -1 - Math.floor(random() * 23) })
            else if (choice < 0.034) await act({ kind: "cancel" })
            else if (choice < 0.04 && fixture.idle()) await act({ kind: "latency", value: random() < 0.5 ? 512 : 2048 })
            else if (choice < 0.043 && fixture.idle()) await act({ kind: "membership", value: random() < 0.5 ? 0 : 1 })
            else if (choice < 0.046 && fixture.idle()) await act({ kind: "clip-timing", value: random() < 0.5 ? 0 : 0.25 })
            else if (choice < 0.049) await act({ kind: "pause" })
            else if (choice < 0.052) await act({ kind: "seek", value: random() < 0.5 ? 0 : 0.25 })
            else if (choice < 0.055) await act({ kind: "loop" })
            else if (choice < 0.06) await act({ kind: "start" })
            else {
              const selected = enabled[Math.floor(random() * enabled.length)]
              if (selected) await act(selected)
            }
          }
          if (actions.length !== 154) throw new Error(`Seek witness ended after ${actions.length} prefix actions`)
          await drain()
          if (!sawClaimedTransportRefusal) throw new Error("Seek prefix did not reach a claimed-publication transport refusal")
          if (fixture.failures.some((failure) => failure.invariant === "I9")
            || (fixture.state().counts.stop ?? 0) !== 0 || (fixture.state().counts.teardown ?? 0) !== 0)
            throw new Error("Seek handoff produced I9 or stopped/rebuilt playback")
        } else if (options.scenario && !["lifecycle-deadline", "control-watchdog", "revision-deadline"].includes(options.scenario)) {
          await runHookScenario(options.scenario, { fixture, act, drain, nextFair, bound: options.drainSteps, seed })
        } else if (options.scenario) {
          if (options.scenario === "lifecycle-deadline") {
            await act({ kind: "seek" })
            await act({ kind: "clip-timing" })
            await act({ kind: "lifecycle-suspend" })
          } else if (options.scenario === "revision-deadline") await act({ kind: "clip-timing" })
          else await act({ kind: "gain", value: -9 })
          const matches = (site: string) => options.scenario === "lifecycle-deadline" ? site.startsWith("setTimeout(10000)")
            : site.includes(`supervisor ${options.scenario}`)
          let found = false
          for (let count = 0; count < options.drainSteps; count++) {
            const timer = fixture.time.enabled().find((entry) => entry.kind === "fire-timer" && matches(entry.site))
            if (timer) { await act({ kind: timer.kind, id: timer.id }); found = true; break }
            const next = nextFair()
            if (!next) break
            await act(next)
          }
          if (!found) throw new Error(`Did not reach ${options.scenario}`)
          await drain()
        } else if (planted === "real-timer") {
          await act({ kind: "mutation-probe" })
          for (let count = 0; count < options.drainSteps && !fixture.time.hasEscaped(); count++) {
            const action = nextFair()
            if (!action) break
            await act(action)
          }
          if (!fixture.time.hasEscaped()) throw new Error("Real product timer mutation did not reach processor waiter")
          await act({ kind: "unowned-timer-wait" })
        }
        else if (planted === "native-rollback") {
          await act({ kind: "preview", value: -9 })
          await drain()
          await act({ kind: "mutation-probe" })
          await drain()
        } else if (planted) {
          if (planted === "underfill") {
            await runHookScenario("underfill", { fixture, act, drain, nextFair, bound: options.drainSteps, seed })
          } else if (planted === "force-rebuild") {
            await act({ kind: "mutation-probe" }); await drain()
          } else if (planted === "early-release") {
            await act({ kind: "clip-timing", value: 0.25 }); await drain()
            await act({ kind: "mutation-probe" }); await drain()
          } else if (["false-receipt", "swallow-waiter", "noop-churn"].includes(planted)) {
            await act({ kind: "freeze" })
            await act({ kind: "mutation-probe" }); await drain()
            if (planted === "noop-churn") await act({ kind: "check", mode: "quiescent" })
          } else if (planted === "never-wake-latency") {
            await act({ kind: "latency", value: 2048 }); await drain()
            await act({ kind: "pause" }); await drain()
            await act({ kind: "check", mode: "terminal" })
          } else {
            await act({ kind: "mutation-probe", value: -17,
              mode: planted === "stale-overwrite" ? "flush" : undefined }); await drain()
            if (planted === "stale-overwrite") {
              await act({ kind: "mutation-probe", value: -17, mode: "flush" }); await drain()
              await act({ kind: "mutation-probe", value: -17, mode: "resend" }); await drain()
            }
          }
          await act({ kind: "check", mode: "drained" })
        } else {
          const random = randomFor(seed)
          for (let index = 0; index < options.steps; index++) {
            const choice = random()
            const enabled = fixture.enabled().filter((entry) => entry.kind !== "fire-timer")
            if (choice < 0.02) await act({ kind: "gain", value: -1 - Math.floor(random() * 23) })
            else if (choice < 0.03) await act({ kind: random() < 0.5 ? "preview" : "flush", value: -1 - Math.floor(random() * 23) })
            else if (choice < 0.034) await act({ kind: "cancel" })
            else if (choice < 0.04 && fixture.idle()) await act({ kind: "latency", value: random() < 0.5 ? 512 : 2048 })
            else if (choice < 0.043 && fixture.idle()) await act({ kind: "membership", value: random() < 0.5 ? 0 : 1 })
            else if (choice < 0.046 && fixture.idle()) await act({ kind: "clip-timing", value: random() < 0.5 ? 0 : 0.25 })
            else if (choice < 0.049) await act({ kind: "pause" })
            else if (choice < 0.052) await act({ kind: "seek", value: random() < 0.5 ? 0 : 0.25 })
            else if (choice < 0.055) await act({ kind: "loop" })
            else if (choice < 0.06) await act({ kind: "start" })
            else {
              const selected = enabled[Math.floor(random() * enabled.length)]
              if (selected) await act(selected)
            }
          }
          await act({ kind: "flush", value: fixture.state().desired.gain })
          await act({ kind: "settle-panel" })
          await drain()
          await act({ kind: "check", mode: "drained" })
          await act({ kind: "freeze" })
          for (let count = 0; count < 25; count++) {
            const progress = fixture.enabled().find((entry) => entry.kind === "deliver-progress")
            if (progress) await act(progress)
          }
          await act({ kind: "check", mode: "quiescent" })
        }
        beforeCleanup = structuredClone(fixture.state())
        await act({ kind: "loss" })
        await act({ kind: "check", mode: "terminal" })
        await act({ kind: "dispose" })
      }
    } catch (cause) { error = String(cause) }
    finally { beforeCleanup ??= structuredClone(fixture.state()); await fixture.cleanup() }
    for (let index = 0; index < fixture.failures.length; index++) {
      const failure = fixture.failures[index]
      if (failure) fixture.failures[index] = classifyFailure(failure)
    }
    const status = error ? "harness-error" : fixture.failures.length ? "fail" : "pass"
    seedTrace.replayable(status, "full-replay.json", { seed, fixture: "hook", mutation: planted, actions })
    if (options.scenario && !error && !["lifecycle-deadline", "control-watchdog", "revision-deadline", "seek-claimed-publication"].includes(options.scenario))
      seedTrace.replayable(status, "minimized.json", minimizeHookWitness(seed, options.scenario, actions, fixture.failures, directory, planted, trace))
    seedTrace.bulky(status, "inventory.json", fixture.time.inventory())
    seedTrace.bulky(status, "final-state-diff.json", { failures: fixture.failures, beforeCleanup, state: fixture.state() })
    const summary = { seed, status,
      error, failures: fixture.failures, checks: fixture.state().checks, logicalSteps: actions.length,
      rejections: fixture.state().rejections, metrics: fixture.state().metrics }
    summaries.push(summary)
    write(path.join(directory, "summary.json"), summary)
    seedTrace.finish(status)
    process.stdout.write(`hook seed ${seed}: ${summary.status} ${fixture.failures.map((failure) => failure.invariant).join(",")} ${error ?? ""}\n`)
  }
  write(path.join(options.out, "summary.json"), { fixture: "hook", generatorVersion: "hook-a2a-p2-v1",
    elapsedMs: replay ? undefined : performance.now() - started, seeds: summaries })
  if (summaries.some((summary) => summary.status !== "pass")) process.exitCode = 1
  if (options.gate) {
    const violations = summaries.flatMap((summary) => summary.error
      ? [{ seed: summary.seed, invariant: "harness", detail: summary.error }]
      : gateViolations(summary.failures, options.gate).map((failure) => ({ seed: summary.seed, ...failure })))
    const rejectionViolations = summaries.flatMap((summary) => summary.rejections
      .filter((entry) => entry.classification !== "cancelled"
        && gateViolations([{ invariant: "rejection", detail: entry.classification, domain: entry.domain, class: entry.class }], options.gate).length > 0)
      .map((entry) => ({ seed: summary.seed, ...entry })))
    const prefixes = []
    for (const prefix of hookClassTable.prefixes) {
      const out = path.join(options.out, "gate-prefixes", prefix.scenario)
      const execution = spawnSync("perl", ["-e", "alarm shift; exec @ARGV", String(120 + 5 * prefix.cells), "bun", "--conditions=browser",
        path.join(root, "tools/acceptance/ae-08-processor-state-fuzz.ts"), "--fixture", "hook",
        "--seeds", String(prefix.cells), "--seed", String(prefix.seed), "--scenario", prefix.scenario, "--trace", trace, "--out", out],
      { cwd: root, encoding: "utf8" })
      write(path.join(options.out, `gate-${prefix.scenario}-execution.json`), {
        status: execution.status, signal: execution.signal, error: execution.error?.message,
      })
      if (execution.error || execution.signal || execution.status !== 0 && execution.status !== 1)
        throw new Error(`Gate prefix execution failed: ${prefix.scenario}`)
      const result = z.object({ seeds: z.array(z.object({ status: z.string(), failures: z.array(z.object({
        invariant: z.string(), detail: z.string(), domain: z.string(), class: z.string().optional(),
      })) })) }).parse(JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8")))
      const requiredGreen = gateSteps.indexOf(prefix.greenAfter) <= gateSteps.indexOf(options.gate)
      prefixes.push({ ...prefix, requiredGreen, seeds: result.seeds })
    }
    const completeCampaign = summaries.length === 100 && !replay && !mutation && !options.scenario
    const pass = completeCampaign && !violations.length && !rejectionViolations.length && !prefixes.some((prefix) =>
      prefix.seeds.some((seed) => seed.status === "harness-error"
        || gateViolations(seed.failures, options.gate).length > 0
        || prefix.requiredGreen && seed.status !== "pass"))
    write(path.join(options.out, "gate.json"), { step: options.gate, pass, completeCampaign, violations, rejectionViolations, prefixes })
    process.exitCode = pass ? 0 : 1
  }
}
