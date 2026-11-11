import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Action } from "./ae-08-processor-state-fuzz-host"
import { classifyFailure } from "./ae-08-processor-state-fuzz-classes"
import { a2cScenarios } from "./ae-08-processor-state-fuzz-hook-scenarios-a2c"
import { step5GuardScenarios, step5LiveScenarios } from "./ae-08-processor-state-fuzz-hook-scenarios"
import type { Failure } from "./ae-08-processor-state-fuzz-oracle"
import type { Trace } from "./ae-08-processor-state-fuzz-trace"

const signature = (failures: readonly Failure[]) =>
  [...new Set(failures.map(classifyFailure).map((failure) => `${failure.invariant}:${failure.class ?? failure.detail}`))].sort().join("|")

const summarySchema = z.object({ seeds: z.array(z.object({ status: z.string(), failures: z.array(z.object({
  invariant: z.string(), detail: z.string(), domain: z.string(), class: z.string().optional(),
})) })) })
export default function minimizeHookWitness(seed: number, scenario: string, actions: readonly Action[], failures: readonly Failure[], directory: string, mutation: string | undefined, trace: Trace) {
  const root = path.resolve(import.meta.dir, "../..")
  const probe = path.join(directory, "minimization-probe")
  mkdirSync(probe, { recursive: true })
  const input = path.join(probe, "candidate.json")
  const required = scenario === "prefix-1" ? ["clip-timing", "project-identical", "freeze"]
    : scenario === "prefix-6" ? ["gain", "preview", "persist-fail", "external-adoption", "cancel"]
      : scenario === "prefix-8" ? ["block-asset", "clip-timing", "capture-retry", "cheap-ack"]
        : scenario === "prefix-9" ? ["external-adoption", "tempo", "meter", "loop"]
          : scenario === "stale-compile" ? ["capture-stale-compile", "tempo"]
            : scenario === "identity-same" || scenario === "identity-changed" ? ["preview", "identity-baseline", "commit"]
              : scenario.startsWith("late-") || ["domain-timeout", "pause-latency", "prefix-10", "patch-install", "explicit-retry", "capacity-reopen", "retained-candidate", "progress-only", "explicit-context", "intent-aba", "edits-during-compile", "retained-seek", "pending-attempt", "parked-latency", "parked-page-hold", ...a2cScenarios, ...step5LiveScenarios, ...step5GuardScenarios].includes(scenario) ? [] : ["starvation-begin", "starvation-end"]
  const checks = actions.filter((action) => action.kind === "check" && action.mode !== "terminal").map((action) => action.mode)
  const expected = signature(failures)
  const attempts = 2
  const run = (candidate: readonly Action[]) => {
    if (candidate.length > 10_000 || required.some((kind) => !candidate.some((action) => action.kind === kind))
      || checks.some((mode) => !candidate.some((action) => action.kind === "check" && action.mode === mode))
      || scenario === "prefix-8" && candidate.filter((action) => action.kind === "cheap-ack").length !== 25
      || scenario === "stale-compile" && candidate.filter((action) => action.kind === "clip-timing").length !== 2) return false
    // Product IDB connection caches change initialization task IDs on a second
    // mount of the same project. Fresh processes keep exact dependency replay
    // honest, without resetting or modifying product module state.
    writeFileSync(input, JSON.stringify({ seed, mutation, actions: candidate }))
    writeFileSync(path.join(probe, "summary.json"), JSON.stringify({ seeds: [{ status: "harness-error", failures: [] }] }))
    // The replay inherits this process's runtime flags, so a preloaded in-memory mutation reaches it too.
    const result = spawnSync("perl", ["-e", "alarm shift; exec @ARGV", "30", "bun", ...process.execArgv,
      path.join(root, "tools/acceptance/ae-08-processor-state-fuzz.ts"),
      "--fixture", "hook", "--replay", input, "--trace", trace === "all" ? "all" : "none", "--out", probe], { cwd: root, encoding: "utf8" })
    if (result.error || result.signal || result.status !== 0 && result.status !== 1) return false
    const summary = summarySchema.parse(JSON.parse(readFileSync(path.join(probe, "summary.json"), "utf8")))
    return summary.seeds.length === 1 && summary.seeds[0]?.status !== "harness-error"
      && signature(summary.seeds.flatMap((seed) => seed.failures)) === expected
  }
  // Strip teardown only, never evidence before the final semantic check. Exact
  // IDs remain dependencies: removals that change them must fail replay.
  const lastCheck = actions.findLastIndex((action) => action.kind === "check" && action.mode !== "terminal")
  const best = actions.slice(0, lastCheck + 1)
  if (!run(best)) throw new Error(`Semantic witness cannot replay: ${scenario}`)
  if (!run(best)) throw new Error(`Reduced witness failed verification: ${scenario}`)
  // Probe runs only feed the verdict; their traces are kept only for `--trace all`.
  if (trace !== "all") rmSync(probe, { recursive: true })
  // The planted mutation is part of the witness: replaying without it reproduces nothing.
  return { status: "verified-teardown-only-reduction", seed, fixture: "hook", scenario, mutation,
    attempts, originalActions: actions.length, minimizedActions: best.length,
    failureSignature: expected, actions: best }
}
