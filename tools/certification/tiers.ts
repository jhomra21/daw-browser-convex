import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { repoRoot, type Expectations } from "./expectations"

// Risk-based tiers (REVIEW-TEST-POLICY-FABLE52 §5.1). A tier runs everything the lower tiers run.
//   T0 static: docs, reports, tools/ and the analyzer. Typecheck, lint, the analyzer self-test.
//   T1 product: any other src/, packages/, api/, convex/ or apps/ file. T0 plus the test files that import a changed file.
//   T2 core: the playback core and the fuzz tooling. T1 plus its mutation arms, the traced pair (seeds 1-100) and named seeds.
//   T2n native: native/**, the WASM artefacts and worklets. T2 plus the ctest and WASM gates.
export const tiers = ["T0", "T1", "T2", "T2n"] as const
export type Tier = (typeof tiers)[number]
export const tierRank = (tier: Tier) => tiers.indexOf(tier)
export const asTier = (value: string | undefined) => tiers.find((tier) => tier === value)

const gitLines = (args: string[]) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout.split("\n").filter((line) => line.length > 0)
export const resolvesCommit = (ref: string) => spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repoRoot }).status === 0
// Every path that differs from the base commit: committed, staged, modified, deleted (both sides of a rename) and untracked.
export const changedSince = (base: string) =>
  [...new Set([...gitLines(["diff", "--name-only", "--no-renames", base]), ...gitLines(["ls-files", "--others", "--exclude-standard"])])]

// The core is what a mutation arm targets or is witnessed by, plus the files the fuzz fixtures hash into every trace.
const corePaths = (exp: Expectations) => new Set([
  ...Object.keys(exp.fuzzSources.controller), ...Object.keys(exp.fuzzSources.hook),
  ...exp.mutations.arms.flatMap((arm) => [...arm.targets, ...arm.witnesses]),
])
const tierOfFile = (file: string, core: Set<string>): Tier =>
  /^native\/|^public\/audio-(core|worklets)\/|^packages\/audio-engine\/src\/(portable-wasm|backends\/wasm)/.test(file) ? "T2n"
    : core.has(file) || /^tools\/acceptance\/(ae-08-processor-state-fuzz|device-control-cost)/.test(file) ? "T2"
      : /^(src|packages|api|convex|apps|public)\/|^(package\.json|bun\.lock|tsconfig[^/]*|vite[^/]*|index\.html)$/.test(file) ? "T1"
        : "T0"

export const selectTier = (exp: Expectations, changed: string[]) => {
  const core = corePaths(exp)
  const byTier = new Map<Tier, string[]>(tiers.map((tier) => [tier, []]))
  for (const file of changed) byTier.get(tierOfFile(file, core))?.push(file)
  const tier = [...tiers].reverse().find((entry) => (byTier.get(entry)?.length ?? 0) > 0) ?? "T0"
  const counts = tiers.map((entry) => `${entry} ${byTier.get(entry)?.length ?? 0}`).join(", ")
  const deciding = (byTier.get(tier) ?? []).slice(0, 3).join(", ")
  return { tier, reason: changed.length === 0 ? "no changed path" : `${counts} of ${changed.length} changed paths${deciding ? `; ${tier} because of ${deciding}` : ""}` }
}

// The lowest tier that runs a gate.
const staticGates = new Set(["g-typecheck", "g-lint", "g-tools-typecheck", "g-analyzer-selftest", "g-c0fg-oxlint", "g-c0-oxlint", "x-b6f5-scoped-lint", "rc1-i9-scoped-lint"])
export const gateTier = (name: string): Tier =>
  staticGates.has(name) ? "T0" : /^(x-test-native|x-host-ctest|x-rtguard|x-wasm-|x-portable-wasm|x-validate-wasm|x-backends)/.test(name) ? "T2n" : "T2"

// Campaigns whose command repeats a traced pair's: same fixture, seeds 1-100, steps and bounds. They differ only in `--gate <step>`
// and `--trace`. A gate step's green set contains every earlier step's (gateSteps order; `gated` and gateViolations keep a class
// only when its greenAfter <= step), so a seed set that passes B6 passes B4b, B5a and B5b, and the traced pair is itself a B6 run.
export const retiredCampaigns = new Set(["controller-b6", "hook-b6", "controller-b5b", "hook-b5b", "controller-b4b", "controller-b5a", "hook-b4b"])

// Mutant arms recorded as expected survivors (exit 0, nothing failing, no oracle or compile error, no rejection record) verify
// nothing: they pin a known gap, listed in test-debt.md. A MISMATCH row that carries a ruling (169) keeps its recorded arms; the
// others are governed by PARENT-RULING-TEST-TIERS-ACCEPTED.md: the surviving arms retire, and rows 418 and 419, where no arm
// discriminates (the mutant fails what its control fails), retire whole. A control only exists to qualify its mutants, so one
// whose every dependant retired goes with them.
const noWitnessRows = new Set(["rc2:418", "rc2:419"])
export const retiredArms = (exp: Expectations) => {
  const ruled = new Set(exp.mutations.rows.filter((row) => row.disposition === "MISMATCH" && row.ruling !== null).map((row) => `${row.family}:${row.row}`))
  const retired = new Set(exp.mutations.arms.filter((arm) => noWitnessRows.has(`${arm.family}:${arm.row}`) || arm.role === "mutant" && !ruled.has(`${arm.family}:${arm.row}`) && arm.expect.exit === 0
    && (arm.expect.fails ?? []).length === 0 && (arm.expect.fuzz?.failures.length ?? 0) === 0 && (arm.expect.fuzz?.status ?? "pass") === "pass"
    && arm.expect.oracle === null && (arm.expect.tsErrors ?? []).length === 0 && (arm.expect.rejection ?? []).length === 0).map((arm) => arm.id))
  for (const arm of exp.mutations.arms.filter((entry) => entry.role === "control")) {
    const dependants = exp.mutations.arms.filter((entry) => entry.control === arm.id)
    if (dependants.length > 0 && dependants.every((entry) => retired.has(entry.id))) retired.add(arm.id)
  }
  return retired
}

// Test files that reach a changed file through imports, resolved the way Bun resolves them (tsconfig paths, workspace packages).
// `bun test --changed` would do the same walk, but it also selects the archived copies of tests under acceptance-reports/ and
// cannot be told to skip them; in-repo resolution does not depend on `--conditions=browser` (no package.json here defines a
// "browser" export) and neither walk enters node_modules.
const pinned = ["tools/acceptance/device-control-cost.browser.test.ts", "src/lib/instrument-buffer-sync.test.ts"]
const sourceFiles = () => [...new Bun.Glob("{src,packages,apps,api,convex,tools,native,public}/**/*.{ts,tsx,js,mjs}").scanSync({ cwd: repoRoot })]
  .filter((file) => !/(^|\/)(node_modules|dist|build)\/|^tools\/certification\/fixtures\//.test(file))
export const allTestFiles = () => sourceFiles().filter((file) => /\.test\.tsx?$/.test(file)).sort()
export const testsReaching = (changed: string[]) => {
  const files = sourceFiles()
  const importers = new Map<string, Set<string>>()
  let unresolved = 0
  for (const file of files) {
    const absolute = path.join(repoRoot, file)
    const transpiler = new Bun.Transpiler({ loader: file.endsWith("x") ? "tsx" : file.endsWith(".ts") ? "ts" : "js" })
    const specifiers = (() => {
      try { return transpiler.scanImports(readFileSync(absolute, "utf8")).map((entry) => entry.path) } catch { return [] }
    })()
    for (const specifier of specifiers) {
      const resolved = (() => {
        try { return Bun.resolveSync(specifier, path.dirname(absolute)) } catch { return undefined }
      })()
      if (resolved === undefined) unresolved += /^(\.|~)/.test(specifier) ? 1 : 0
      else if (!resolved.includes("/node_modules/")) importers.set(resolved, (importers.get(resolved) ?? new Set()).add(absolute))
    }
  }
  const reached = new Set(changed.map((file) => path.join(repoRoot, file)))
  for (const file of reached) for (const importer of importers.get(file) ?? []) reached.add(importer)
  const scanned = new Set(files)
  const tests = new Set([...reached].map((file) => path.relative(repoRoot, file)).filter((file) => /\.test\.tsx?$/.test(file) && scanned.has(file)))
  if (changed.some((file) => tierOfFile(file, new Set()) !== "T0")) for (const file of pinned) tests.add(file)
  return { tests: [...tests].sort(), scanned: files.length, unresolved }
}
