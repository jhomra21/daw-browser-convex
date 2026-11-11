import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statfsSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import path from "node:path"
import { z } from "zod"
import {
  archivedPath, archivedRoot, canonicalJsonSha256, expectationsFile, expectationsSchema, failedTests, fuzzFailures, getAt, jobDirToken, leafName,
  lintSignature, oracleFailures, perFileCounts, repoRoot, runsTestFile, sameJson, sha256, testCounts, tscDiagnostics,
  type Arm, type Campaign, type Command, type Counts, type Gate, type Judge, type Observation,
} from "./expectations"
import { measureArm, measureGate, overlayIdentity, scopeOf } from "./measure"
import { judgeSeeds, seedArgv, seedRecords, seedRecordsFile, type HashJudge } from "./seed-judge"
import { gateTier, resolvesCommit, retiredArms, retiredCampaigns, selectTier, tierRank, testsReaching, asTier, changedSince, type Tier } from "./tiers"
import { failuresByFile, judgeTestShard, testBaseline, testBaselineFile, testShards } from "./test-baseline"

// FAST-CERT: RC7's re-certification as one parallel, tiered run, judged against tools/certification/expectations.json.
// Usage: bun tools/certification/fast-cert.ts [--plan] [--full] [--tier T0|T1|T2|T2n] [--base-commit <ref>] [--base <manifest.json>]
//        [--out <dir>] [--changed a,b [--changed-only]] [--seeds N] [--only <job id,…>] [--break <arm id>] [--overlay <spec.json>]
// The tier comes from the paths that differ from --base-commit (default HEAD) and from manifest drift (tiers.ts); --tier overrides
// it, --full runs every job. --changed adds simulated changed files; --only runs the named jobs (and what they depend on) from the
// full set; --break turns one mutant into a no-op overlay (every `to` = `from`), a self-test that must end in FAIL. --overlay
// simulates a product change in memory ({ id, changes: [{ file, from, to }] }, repository-relative files) through
// product-overlay.ts; its files count as changed.
const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
// --bless <name>: rebase.ts runs this file once in the requested scope and records what it moved (rebases/<name>.json), refusing
// anything bless-rules.ts refuses. --rebase <name> --revert <path=entryCopy>…: the same, after a run with --overlay reverting the
// listed files shows the expectations describe the entry bytes. The runs themselves write their observations with --measure.
if (option("--rebase") !== undefined || option("--bless") !== undefined) await import("./rebase")
const measureFile = option("--measure")
const measuring = measureFile !== undefined
const full = args.includes("--full")
const planOnly = args.includes("--plan")
const outDir = path.resolve(option("--out") ?? path.join("/tmp/fast-cert", new Date().toISOString().replaceAll(":", "-")))
const seedOverride = option("--seeds")
const only = new Set((option("--only") ?? "").split(",").filter((id) => id.length > 0))
const broken = option("--break")
const overlayFile = option("--overlay")
const productOverlay = overlayFile === undefined ? undefined : {
  spec: path.resolve(overlayFile),
  files: z.object({ changes: z.array(z.object({ file: z.string() })) }).parse(JSON.parse(readFileSync(path.resolve(overlayFile), "utf8"))).changes.map((change) => change.file),
}
const reverting = productOverlay !== undefined
const simulated = [...new Set([...(option("--changed") ?? "").split(",").filter((file) => file.length > 0), ...(productOverlay?.files ?? [])])]
const exp = expectationsSchema.parse(JSON.parse(readFileSync(expectationsFile, "utf8")))
const expectationsJson = z.json().parse(JSON.parse(readFileSync(expectationsFile, "utf8")))

// RC7 measured every duration serially. Ten jobs sharing this Mac's 6 performance and 6 efficiency cores run slower (the hook
// campaigns and seeds also spawn their own children); the estimate multiplies parallel-phase durations by this factor. Isolated
// jobs run alone and keep RC7's durations. Calibrated in BD/FAST-CERT-VALIDATION.md: measured parallel phase / simulated at x1
// was 2.00-2.11 in --full, 2.33 change-scoped and 2.49-2.52 in the default mode, where the estimate picks the seed count.
const parallelSlowdown = 2.5
const pool = Math.max(1, availableParallelism() - 2)
const compareSeconds = 5
const fixtures: ("controller" | "hook")[] = ["controller", "hook"]

// ---------- change scope ----------
const baseFile = option("--base")
const baseEntries = baseFile
  ? z.record(z.string(), z.string().nullable()).parse(JSON.parse(readFileSync(path.resolve(baseFile), "utf8")))
  : exp.manifest.entries
const watched = new Map<string, string | null>([...Object.entries(exp.fuzzSources.controller), ...Object.entries(exp.fuzzSources.hook), ...Object.entries(baseEntries)])
const liveSha = (file: string) => {
  const absolute = path.join(repoRoot, file)
  return existsSync(absolute) ? sha256(readFileSync(absolute)) : null
}
const hashWatched = () => new Map([...watched.keys()].sort().map((file) => [file, liveSha(file)]))
const digest = (hashes: Map<string, string | null>) => sha256(JSON.stringify([...hashes]))
const gitStatus = () => spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" }).stdout
const startHashes = hashWatched()
const startStatus = gitStatus()
const baseCommit = option("--base-commit") ?? "HEAD"
if (!resolvesCommit(baseCommit)) {
  console.error(`--base-commit ${baseCommit} is not a commit`)
  process.exit(2)
}
const drifted = [...watched].filter(([file, base]) => startHashes.get(file) !== base).map(([file]) => file)
// --changed-only simulates a change on a tree that is dirty: git is not asked, only --changed and the overlay count.
const changed = [...new Set([...drifted, ...(args.includes("--changed-only") ? [] : changedSince(baseCommit)), ...simulated])].sort()
const touches = (files: string[]) => files.some((file) => changed.some((entry) => entry === file || entry.startsWith(`${file}/`)))

// ---------- tier ----------
const forcedTier = asTier(option("--tier"))
if (option("--tier") !== undefined && forcedTier === undefined) {
  console.error(`--tier ${option("--tier")} is not one of T0, T1, T2, T2n`)
  process.exit(2)
}
const auto = selectTier(exp, changed)
const tier: Tier = forcedTier ?? auto.tier
const tierWhy = forcedTier ? `--tier ${forcedTier} (paths alone would pick ${auto.tier}: ${auto.reason})` : auto.reason
const everything = full || only.size > 0
// A job of tier T runs when the run is --full/--only or its tier is T or above.
const reaches = (needed: Tier) => everything || tierRank(tier) >= tierRank(needed)
const triggers = {
  fuzz: reaches("T2"),
  native: reaches("T2n"),
  product: reaches("T2") && changed.some((file) => /^(src|packages|public)\/|^tools\/acceptance\/device-control-cost/.test(file) && !/\.test\.tsx?$/.test(file)),
}
const selectedBy = (trigger: Gate["trigger"]) => everything || trigger === "always" || (trigger !== "full-only" && triggers[trigger])

const fixtureOf = (argv: string[]) => argv.includes("--fixture") ? argv[argv.indexOf("--fixture") + 1] : undefined
const armFiles = (arm: Arm) => {
  const fixture = fixtureOf(arm.command.argv)
  const sources = fixture === "hook" ? exp.fuzzSources.hook : fixture === "controller" ? exp.fuzzSources.controller : {}
  return [...arm.targets, ...arm.witnesses, ...Object.keys(sources)]
}
const rowKey = (arm: Arm) => `${arm.family === "search" ? "rc2" : arm.family}:${arm.row}`
const impact = new Map(changed.map((file) => [file, [...new Set(exp.mutations.arms.filter((arm) => armFiles(arm).some((entry) => file === entry || file.startsWith(`${entry}/`))).map(rowKey))].sort()]))
const impactedRows = new Set([...impact.values()].flat())
const retired = retiredArms(exp)
// Mutation arms run from T2 up; below it only the analyzer's rows (the analyzer is T0 and has its own self-test arms).
const selectedArms = exp.mutations.arms.filter((arm) => !retired.has(arm.id) && (everything || impactedRows.has(rowKey(arm)) && (reaches("T2") || arm.family === "analyzer")))
const armsById = new Map(exp.mutations.arms.map((arm) => [arm.id, arm]))

// ---------- jobs ----------
type Run = { exit: number | null; signal: string | null; seconds: number; text: string; log: string }
type Outcome = {
  id: string; group: string; command: string; exit: number | null; signal: string | null; counts: Counts | null
  started: number; ended: number; seconds: number; verdict: "PASS" | "FAIL"; reasons: string[]; notes: string[]; log: string; hashJudge?: HashJudge
}
// `hashJudge` is what the byte-exact summary hash said about a seed batch: reported, never judged.
type Verdict = { reasons: string[]; notes: string[]; counts: Counts | null; hashJudge?: HashJudge }
// `reaches`: the product overlay reaches the job's programs (see withProductOverlay). `hard` lists what no rebase may record: the
// run itself did not work.
type Job = {
  id: string; group: string; isolated: boolean; deps: string[]; estimate: number; command: string; reaches: boolean; hard: (run: Run) => string[]
  execute: (dir: string) => Promise<Verdict & { run: Run; observed: Observation[] }>
}
const signalOf = (run: Run) => run.signal === null ? [] : [`signal ${run.signal}`]

const safeName = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, "_")
const jobDir = (id: string) => path.join(outDir, "jobs", safeName(id))
// Where a job's latest attempt ran: a rerun alone writes beside the first attempt, and what depends on the job reads the latest.
const latestDir = new Map<string, string>()
// Archived reference tooling is written into the run's own fixtures directory; every path naming it (in argv, env, specs and the
// archived files themselves) is relocated there.
const relocations = Object.keys(exp.references).map((file): [string, string] => [file, path.join(outDir, "fixtures", file.slice(archivedRoot.length))])
const relocate = (text: string) => relocations.reduce((value, [from, to]) => value.split(from).join(to), text)
const fill = (value: string, dir: string) => relocate(value.split(jobDirToken).join(dir))
const occurrences = (text: string, needle: string) => text.split(needle).length - 1
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index])
const countsText = (counts: Counts) => `${counts.pass}/${counts.skip}/${counts.fail}`
const total = (counts: Counts) => counts.pass + counts.skip + counts.fail
const leafFails = (text: string) => [...new Set(failedTests(text).map(leafName))].sort()
const quoted = (argv: string[]) => argv.map((value) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(" ")

const childEnv = (command: Command, dir: string) => {
  const inherited = Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !["DAW_INSTRUMENT_EVIDENCE", "DV01_OVERLAY_FILE", "DV01_B6F_PROBE"].includes(entry[0]))
  const env = Object.fromEntries([...inherited, ...Object.entries(exp.env), ...Object.entries(command.env).map(([key, value]) => [key, fill(value, dir)]),
    ...(productOverlay ? [["FAST_CERT_PRODUCT_OVERLAY", productOverlay.spec], ["FAST_CERT_PRODUCT_LOG", path.join(dir, "product-overlay.log")],
      ...(spawnsFuzzChildren(command.argv) ? [["BUN_OPTIONS", `--preload ${overlayPreload}`]] : [])] : [])])
  if (command.evidence) {
    mkdirSync(path.join(dir, "evidence"), { recursive: true })
    env.DAW_INSTRUMENT_EVIDENCE = path.join(dir, "evidence")
  }
  return env
}
const exitEvent = z.tuple([z.number().nullable(), z.string().nullable()])
// --overlay: product-overlay.ts is the first preload of the bun process a job starts. The fuzz runner also starts bun children
// (gate prefixes, minimization replays) that load the product, so a command running it gets the preload through BUN_OPTIONS and
// they have it too. Nothing else may take it that way: BUN_OPTIONS puts the flag before the subcommand, so a `bun test` child
// would run the package's `test` script, which runs `bun test` again, without end. `bun test` takes it after `test` and reaches
// that process only. `bun x` and `bun run` start other programs (tsc, oxlint, vite) that read files from disk, which no
// in-memory overlay reaches.
const bunSubcommand = (argv: string[]) => argv[0] === "bun" ? argv[argv.findIndex((value, index) => index > 0 && !value.startsWith("-"))] ?? "" : ""
const overlayReaches = (argv: string[]) => argv[0] === "bun" && !["x", "run"].includes(bunSubcommand(argv))
const spawnsFuzzChildren = (argv: string[]) => overlayReaches(argv) && bunSubcommand(argv) !== "test" && argv.some((value) => value.endsWith("/ae-08-processor-state-fuzz.ts"))
const overlayPreload = path.join(import.meta.dir, "product-overlay.ts")
const withProductOverlay = (argv: string[]) => {
  if (!productOverlay || !overlayReaches(argv) || spawnsFuzzChildren(argv)) return argv
  const subcommand = argv.findIndex((value, index) => index > 0 && !value.startsWith("-"))
  const at = argv[subcommand] === "test" ? subcommand + 1 : 1
  return [...argv.slice(0, at), "--preload", overlayPreload, ...argv.slice(at)]
}

// Every command runs under RC's Perl alarm, so a hung child ends without a timer in this process.
const runCommand = async (command: Command, dir: string, name: string): Promise<Run> => {
  const argv = ["perl", "-e", "alarm shift; exec @ARGV", String(command.alarmSeconds), ...withProductOverlay(command.argv.map((value) => fill(value, dir)))]
  const log = path.join(dir, `${name}.log`)
  const descriptor = openSync(log, "w")
  const started = performance.now()
  const child = spawn("perl", argv.slice(1), { cwd: repoRoot, env: childEnv(command, dir), stdio: ["ignore", descriptor, descriptor] })
  const [exit, signal] = exitEvent.parse(await once(child, "exit"))
  closeSync(descriptor)
  return { exit, signal, seconds: (performance.now() - started) / 1000, text: readFileSync(log, "utf8"), log }
}
const commandText = (command: Command) => quoted(command.argv)

// ---------- judges ----------
const judgeGate = (judge: Judge, run: Run, dir: string): Verdict => {
  const reasons: string[] = []
  const text = run.text
  if (run.signal !== null) reasons.push(`signal ${run.signal}`)
  if (run.exit !== judge.exit) reasons.push(`exit ${run.exit}, expected ${judge.exit}`)
  if (judge.kind === "tests") {
    // The failing set must equal the recorded known-red set by name; counts are notes, so adding a test never fails the gate.
    const counts = testCounts(text)
    const fails = leafFails(text)
    const notes: string[] = []
    const unexpected = fails.filter((name) => !judge.fails.includes(name))
    const missing = judge.fails.filter((name) => !fails.includes(name))
    if (unexpected.length > 0) reasons.push(`failing tests outside the known-red set: ${unexpected.join(" | ")}`)
    if (missing.length > 0) reasons.push(`known-red tests that did not fail: ${missing.join(" | ")}`)
    if (total(counts) === 0) reasons.push("no tests ran")
    if (countsText(counts) !== countsText(judge.counts)) notes.push(`counts ${countsText(counts)}, recorded ${countsText(judge.counts)}`)
    if (judge.appended !== null && occurrences(text, "DV01-B6F-PROBE-APPENDED") !== judge.appended) reasons.push("probe was not appended as in RC7")
    return { reasons, notes, counts }
  }
  if (judge.kind === "lint") {
    const found = /^Found .*$/m.exec(text)?.[0] ?? ""
    const got = lintSignature(text).map(([diagnostic, where]) => `${diagnostic}\t${where}`).sort()
    const want = judge.signature.map(([diagnostic, where]) => `${diagnostic}\t${where}`).sort()
    if (found !== judge.found) reasons.push(`"${found}", expected "${judge.found}"`)
    if (!sameList(got, want)) reasons.push(`diagnostic multiset differs: +[${got.filter((entry) => !want.includes(entry)).join(" | ")}] -[${want.filter((entry) => !got.includes(entry)).join(" | ")}]`)
  }
  if (judge.kind === "oxlint-clean" && !text.includes("Found 0 warnings and 0 errors.")) reasons.push("oxlint is not 0/0")
  if (judge.kind === "tsc" && !sameList(tscDiagnostics(text), judge.diagnostics)) reasons.push(`tsc diagnostics [${tscDiagnostics(text).join(" ")}] differ from RC7's ${judge.diagnostics.length}`)
  if (judge.kind === "selftest") {
    const rejected = occurrences(text, '"rejected": true')
    const dragMissed = /"drag-missed": \{\s*"rejected": true,\s*"intended": "gainChanged"/.test(text)
    if (rejected !== judge.rejected || occurrences(text, '"rejected": false') > 0 || !dragMissed) reasons.push(`self-test rejected ${rejected} of ${judge.rejected}, drag-missed ${dragMissed}`)
  }
  if (judge.kind === "ctest") {
    const passedLines = [...text.matchAll(new RegExp(`^\\s*\\d+/${judge.total} Test\\s+#\\d+: \\S+ \\.+\\s+Passed`, "gm"))].length
    if (!new RegExp(`^100% tests passed out of ${judge.total}$`, "m").test(text) || passedLines !== judge.total) reasons.push(`ctest ${passedLines} of ${judge.total} passed`)
  }
  if (judge.kind === "engine") {
    // Every recorded file must still run and fail exactly as many tests as recorded; other count moves are notes.
    const got = perFileCounts(text)
    const want = Object.entries(judge.files)
    const missing = want.filter(([file]) => !got.has(file)).map(([file]) => file)
    const failing = want.filter(([file, counts]) => got.has(file) && got.get(file)?.fail !== counts.fail).map(([file]) => file)
    const moved = want.filter(([file, counts]) => got.has(file) && countsText(got.get(file) ?? counts) !== countsText(counts)).length
    if (missing.length > 0) reasons.push(`recorded files that did not run: ${missing.slice(0, 10).join(", ")}`)
    if (failing.length > 0) reasons.push(`failing counts differ from the record in: ${failing.slice(0, 10).join(", ")}`)
    return { reasons, notes: moved > 0 || got.size !== want.length ? [`${moved} recorded files moved their counts; ${got.size} files ran, ${want.length} recorded`] : [], counts: testCounts(text) }
  }
  if (judge.kind === "stdout") {
    const value = text.trim().split("\n").at(-1) ?? ""
    if (value !== judge.value) reasons.push(`printed ${value}, expected ${judge.value}`)
    for (const [file, hash] of Object.entries(judge.files)) if (liveSha(file) !== hash) reasons.push(`${file} is not ${hash.slice(0, 12)}…`)
  }
  if (judge.kind === "dp" || judge.kind === "campaign") {
    const out = path.join(dir, "out")
    const files = judge.kind === "dp" ? Object.entries(judge.files) : [["log", judge.logSha256], ["gate.json", judge.gateSha256]]
    for (const [file, hash] of files) {
      const absolute = file === "log" ? run.log : path.join(out, file)
      const got = !existsSync(absolute) ? "missing" : file === "log" || judge.kind === "dp" ? sha256(readFileSync(absolute))
        : canonicalJsonSha256(readFileSync(absolute, "utf8"), out, true)
      if (got !== hash) reasons.push(`${file} ${got.slice(0, 12)}…, RC7 ${hash.slice(0, 12)}…`)
    }
  }
  return { reasons, notes: [], counts: null }
}

// Each family keeps its RC runner's harness check: RC2's matrix runner flagged these log lines; the diagnostics and the ledger/C0
// runners judged only the anchor and module load (their other outcomes are compared field by field below).
const harness = (arm: Arm) => arm.family === "rc2"
  ? /SyntaxError|Cannot find module|Overlay requires one exact anchor|Missing child preload anchor|ReferenceError|Unhandled error between tests|harness-error|Gate prefix execution failed/
  : /Overlay requires one exact anchor|Cannot find module/
const rejectionViolations = z.object({ rejectionViolations: z.array(z.object({ seed: z.number(), id: z.number() })) })

// An arm holds its RC7 observation. A control (or a diagnostic case) keeps RC7's failing set exactly; its counts may move only when
// one of its witness files changed. A mutant keeps every recorded failure (more is "stronger", a note) and its total moves only
// by its control's delta, the RC rule for tests added after a row was recorded.
const judgeArm = (arm: Arm, run: Run, dir: string, controlCounts: Counts | null, rejection: [number, number][] | null): Verdict => {
  const reasons: string[] = []
  const notes: string[] = []
  const expect = arm.expect
  const text = run.text
  if (run.signal !== null) reasons.push(`signal ${run.signal}`)
  if (harness(arm).test(text)) reasons.push("harness error in the log")
  if (run.exit !== expect.exit) reasons.push(`exit ${run.exit}, RC7 ${expect.exit}`)
  if (arm.marker.length > 0 && occurrences(text, arm.marker) !== expect.applied) reasons.push(`applied ${occurrences(text, arm.marker)}, RC7 ${expect.applied}`)
  if (expect.matches !== null && text.split("\n").filter((line) => line.length > 0).length !== expect.matches) reasons.push(`search matched differently from RC7's ${expect.matches}`)
  if (expect.tsErrors !== null) {
    const codes = [...text.matchAll(/error (TS\d+):/g)].map((match) => match[1] ?? "")
    if (!sameList(codes, expect.tsErrors)) reasons.push(`TS errors [${codes.join(" ")}], RC7 [${expect.tsErrors.join(" ")}]`)
  }
  if (expect.fuzz !== null) {
    const summary = path.join(dir, "out", `seed-${expect.fuzz.seed}`, "summary.json")
    const got = existsSync(summary) ? fuzzFailures(readFileSync(summary, "utf8")) : undefined
    if (!got) reasons.push("no seed summary")
    else if (got.status !== expect.fuzz.status || JSON.stringify(got.failures) !== JSON.stringify(expect.fuzz.failures))
      reasons.push(`fuzz ${got.status} [${got.failures.map((failure) => failure.invariant).join(",")}], RC7 ${expect.fuzz.status} [${expect.fuzz.failures.map((failure) => failure.invariant).join(",")}]`)
  }
  if (expect.rejection !== null && JSON.stringify(rejection) !== JSON.stringify(expect.rejection))
    reasons.push(`rejection records ${JSON.stringify(rejection)}, RC7 ${JSON.stringify(expect.rejection)}`)
  if (expect.oracle !== null) {
    const recorded = expect.oracle
    const failure = oracleFailures(text).find((entry) => entry.message === recorded.message)
    const lost = recorded.unrejected.filter((name) => !failure?.unrejected.includes(name))
    const extra = (failure?.unrejected ?? []).filter((name) => !recorded.unrejected.includes(name))
    if (!failure) reasons.push(`"${recorded.message}" did not fail`)
    else if (lost.length > 0) reasons.push(`recorded unrejected defects are now rejected: ${lost.join(", ")}`)
    if (extra.length > 0) notes.push(`stronger, also unrejected: ${extra.join(", ")}`)
  }
  if (expect.counts === null || expect.fails === null) return { reasons, notes, counts: null }
  const counts = testCounts(text)
  const fails = leafFails(text)
  const recorded = expect.fails
  if (arm.role === "mutant") {
    const lost = recorded.filter((name) => !fails.includes(name))
    const extra = fails.filter((name) => !recorded.includes(name))
    if (lost.length > 0) reasons.push(`recorded failures no longer fail: ${lost.join(" | ")}`)
    if (extra.length > 0) notes.push(`stronger, also fails: ${extra.join(" | ")}`)
    const control = arm.control === null ? undefined : armsById.get(arm.control)
    const delta = control?.expect.counts && controlCounts ? total(controlCounts) - total(control.expect.counts) : 0
    if (total(counts) - total(expect.counts) !== delta) reasons.push(`counts ${countsText(counts)}, RC7 ${countsText(expect.counts)} with control delta ${delta}`)
    return { reasons, notes, counts }
  }
  if (!sameList(fails, expect.fails)) reasons.push(`failing tests [${fails.join(" | ")}], RC7 [${expect.fails.join(" | ")}]`)
  if (countsText(counts) !== countsText(expect.counts))
    (touches(arm.witnesses) ? notes : reasons).push(`counts ${countsText(counts)}, RC7 ${countsText(expect.counts)}`)
  return { reasons, notes, counts }
}

const applyEdit = (contents: string, from: string, to: string, label: string) => {
  if (contents.split(from).length !== 2) throw new Error(`${label}: anchor does not occur exactly once`)
  return contents.replace(from, () => to)
}

const gateJob = (gate: Gate): Job => ({
  id: `gate:${gate.name}`, group: gate.group, isolated: gate.isolated, deps: [], estimate: gate.command.rc7Seconds, command: commandText(gate.command),
  reaches: overlayReaches(gate.command.argv), hard: signalOf,
  execute: async (dir) => {
    const run = await runCommand(gate.command, dir, "run")
    return { run, ...judgeGate(gate.judge, run, dir), observed: [{ path: ["gates", `name=${gate.name}`, "judge"], value: measureGate(gate.judge, run, dir) }] }
  },
})
const records = existsSync(seedRecordsFile) ? seedRecords.parse(JSON.parse(readFileSync(seedRecordsFile, "utf8"))) : undefined
// A traced campaign is also the judge of seeds 1-100: they are judged by invariants, and the summary hash is a diagnostic.
// Outside --full the traced pair runs seeds 1-20 (the determinism check needs a sample, not the whole range); seeds 21 up are the
// shards'. The log and gate.json byte pins describe the 100-seed run, and both runners' B6 gate fails a campaign of fewer than 100
// seeds on that alone (`completeCampaign`), so a 20-seed pair is judged on what the gate found (no violation, no rejection
// violation, no failing prefix), its seeds' invariants and the a = b comparison, and records no observation. At B6 every class is
// green, so any prefix failure is a gate failure in both runners.
const pairSeeds = 20
const pairGate = z.object({
  violations: z.array(z.json()), rejectionViolations: z.array(z.json()),
  prefixes: z.array(z.object({ scenario: z.string(), failures: z.array(z.json()).optional(), seeds: z.array(z.object({ status: z.string(), failures: z.array(z.json()) })).optional() })),
})
const pairGateReasons = (dir: string) => {
  const file = path.join(dir, "out", "gate.json")
  const gate = pairGate.safeParse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined)
  if (!gate.success) return ["gate.json was not written"]
  const failing = gate.data.prefixes.filter((prefix) => (prefix.failures?.length ?? 0) > 0 || (prefix.seeds ?? []).some((seed) => seed.status !== "pass" || seed.failures.length > 0)).map((prefix) => prefix.scenario)
  return [...(gate.data.violations.length > 0 ? [`${gate.data.violations.length} gate violations`] : []), ...(gate.data.rejectionViolations.length > 0 ? [`${gate.data.rejectionViolations.length} rejection violations`] : []),
    ...(failing.length > 0 ? [`gate prefixes fail: ${failing.join(", ")}`] : [])]
}
const campaignJob = (campaign: Campaign): Job => {
  const quick = !full && campaign.trace === "all"
  const command: Command = quick
    ? { ...campaign.command, argv: campaign.command.argv.map((value, index, argv) => argv[index - 1] === "--seeds" ? String(pairSeeds) : value), rc7Seconds: campaign.command.rc7Seconds * pairSeeds / 100 }
    : campaign.command
  return {
    id: `campaign:${campaign.name}`, group: campaign.trace === "all" ? "traces" : "campaigns", isolated: false, deps: [],
    estimate: command.rc7Seconds, command: commandText(command), reaches: overlayReaches(command.argv), hard: signalOf,
    execute: async (dir) => {
      const run = await runCommand(command, dir, "run")
      const verdict = quick ? { reasons: [...signalOf(run), ...(run.exit === 0 || run.exit === 1 ? pairGateReasons(dir) : [`exit ${run.exit}`])], notes: [], counts: null } : judgeGate(campaign.judge, run, dir)
      const seeds = judgeSeeds(exp, records, campaign.fixture, path.join(dir, "out"), 1, Number(command.argv[command.argv.indexOf("--seeds") + 1]))
      return { run, ...verdict, reasons: [...verdict.reasons, ...seeds.reasons], hashJudge: seeds.hashJudge,
        observed: quick ? [] : [{ path: ["campaigns", `name=${campaign.name}`, "judge"], value: measureGate(campaign.judge, run, dir) }, ...seeds.recorded] }
    },
  }
}

const copyTree = (from: string, to: string, replacements: [string, string][]) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target, replacements)
    else writeFileSync(target, replacements.reduce((text, [a, b]) => text.split(a).join(b), readFileSync(source, "utf8")))
  }
}
const traceReport = z.object({ pass: z.boolean(), files: z.number(), mismatchCount: z.number(), normalizedTreeSha256: z.object({ a: z.string(), b: z.string() }) })
// Determinism (a = b) and the reference tree. A tree that differs from RC7's is re-hashed with the live source hashes and HEAD
// mapped back to RC7's (RC7's "substitution only" attribution); equal then means only recorded hashes moved.
const traceJob = (fixture: "controller" | "hook"): Job => {
  const reference = exp.traces[fixture]
  const a = `campaign:trace-${fixture}-a`
  const b = `campaign:trace-${fixture}-b`
  const compare: Command = { argv: ["bun", "--conditions=browser", `${jobDirToken}/compare-b6-traces.ts`], alarmSeconds: 600, env: {}, evidence: false, rc7Seconds: compareSeconds }
  const compareTrees = async (dir: string, rootA: string, rootB: string, name: string) => {
    const run = await runCommand({ ...compare, argv: [...compare.argv, rootA, rootB] }, dir, name)
    const report = path.join(dir, `trace-compare-${path.basename(rootA)}-vs-${path.basename(rootB)}.json`)
    return { run, report: existsSync(report) ? traceReport.parse(JSON.parse(readFileSync(report, "utf8"))) : undefined }
  }
  return {
    id: `trace:${fixture}`, group: "traces", isolated: false, deps: [a, b], estimate: compareSeconds, command: `compare-b6-traces ${reference.a} ${reference.b}`,
    reaches: true, hard: signalOf,
    execute: async (dir) => {
      const source = readFileSync(relocate(exp.traces.compareScript), "utf8")
      const relocated = exp.traces.reportPathLine.replace(`${exp.source.scratch}/`, `${dir}/`)
      writeFileSync(path.join(dir, "compare-b6-traces.ts"), applyEdit(source, exp.traces.reportPathLine, relocated, "compare-b6-traces report path"))
      const rootA = path.join(latestDir.get(a) ?? jobDir(a), "out")
      const rootB = path.join(latestDir.get(b) ?? jobDir(b), "out")
      const live = await compareTrees(dir, rootA, rootB, "compare-live")
      const reasons: string[] = []
      const notes: string[] = []
      if (!live.report || !live.report.pass || live.report.mismatchCount > 0) {
        if (measuring) throw new Error("traced pair is not deterministic")
        return { run: live.run, reasons: ["traced pair is not deterministic"], notes, counts: null, observed: [] }
      }
      // The reference tree is the 100-seed tree; the 20-seed pair proves determinism only.
      if (!full) return { run: live.run, reasons, notes: [`${pairSeeds}-seed pair: a = b held over ${live.report.files} files; the reference tree is checked by --full`], counts: null, observed: [] }
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim()
      const headMap: [string, string][] = head !== exp.head ? [[head, exp.head]] : []
      const sourceMaps = Object.entries(exp.fuzzSources[fixture]).flatMap(([file, hash]): [string, string][] => {
        const now = startHashes.get(file)
        return now && now !== hash ? [[now, hash]] : []
      })
      const substitute = async (mapped: [string, string][]) => {
        copyTree(rootA, path.join(dir, "subst-a"), [[rootA, path.join(dir, "subst-a")], ...mapped])
        copyTree(rootB, path.join(dir, "subst-b"), [[rootB, path.join(dir, "subst-b")], ...mapped])
        return compareTrees(dir, path.join(dir, "subst-a"), path.join(dir, "subst-b"), "compare-substituted")
      }
      // A rebase records the tree with HEAD mapped back to RC7's (it is not a source) and the fuzz sources as they are: the live
      // run keeps its own hashes, which the rebase also records; the reverted run maps them back to the hashes it is judged against.
      if (measuring) {
        const mapped = reverting ? [...sourceMaps, ...headMap] : headMap
        const tree = mapped.length === 0 ? live : await substitute(mapped)
        if (!tree.report) throw new Error("trace comparison wrote no report")
        return { run: tree.run, reasons, notes, counts: null, observed: [
          { path: ["traces", fixture, "treeSha256"], value: tree.report.normalizedTreeSha256.a }, { path: ["traces", fixture, "files"], value: tree.report.files }] }
      }
      if (live.report.files !== reference.files) reasons.push(`${live.report.files} trace files, RC7 ${reference.files}`)
      if (live.report.normalizedTreeSha256.a === reference.treeSha256) return { run: live.run, reasons, notes, counts: null, observed: [] }
      const mapped = [...sourceMaps, ...headMap]
      if (mapped.length === 0) return { run: live.run, reasons: [...reasons, `tree ${live.report.normalizedTreeSha256.a.slice(0, 12)}…, RC7 ${reference.treeSha256.slice(0, 12)}…, with no recorded hash to attribute`], notes, counts: null, observed: [] }
      const substituted = await substitute(mapped)
      if (substituted.report?.normalizedTreeSha256.a !== reference.treeSha256)
        return { run: substituted.run, reasons: [...reasons, "trace differs from RC7 beyond recorded source hashes: attribute it by an in-memory revert"], notes, counts: null, observed: [] }
      notes.push(`differs from RC7 only in recorded source hashes (${mapped.length} mapped); new reference ${live.report.normalizedTreeSha256.a}`)
      return { run: substituted.run, reasons, notes, counts: null, observed: [] }
    },
  }
}

const b6Argv = (fixture: "controller" | "hook") => exp.campaigns.find((campaign) => campaign.name === `${fixture}-b6`)?.command.argv ?? []
// Seeds run without --gate: a seed's summary is written before the gate's prefix block runs and does not depend on it, and the
// prefixes run once in the traced pair, which also judges the seeds it covers (see seedShards).
const seedJob = (fixture: "controller" | "hook", first: number, count: number): Job => {
  const command: Command = { argv: seedArgv(b6Argv(fixture), first, count), alarmSeconds: 900, env: {}, evidence: false, rc7Seconds: exp.seeds.processSeconds + count * exp.seeds[fixture].secondsPerSeed }
  return {
    id: `seeds:${fixture}:${first}-${first + count - 1}`, group: `seeds-${fixture}`, isolated: false, deps: [], estimate: command.rc7Seconds, command: commandText(command),
    reaches: true, hard: (run) => [...signalOf(run), ...(run.exit === 0 ? [] : [`exit ${run.exit}`])],
    execute: async (dir) => {
      const run = await runCommand(command, dir, "run")
      const reasons: string[] = []
      if (run.signal !== null || run.exit !== 0) reasons.push(`exit ${run.exit} signal ${run.signal}`)
      const out = path.join(dir, "out")
      const judged = judgeSeeds(exp, records, fixture, out, first, count)
      reasons.push(...judged.reasons)
      const observed = [...judged.observed, ...judged.recorded]
      const pinned = exp.seeds.hook206
      if (fixture === "hook" && first <= pinned.seed && pinned.seed < first + count) {
        const entries = z.object({ rejections: z.array(z.object({ id: z.number(), name: z.string().optional(), classification: z.string().optional() })) })
          .safeParse(JSON.parse(readFileSync(path.join(out, `seed-${pinned.seed}`, "summary.json"), "utf8")))
        const ids = entries.success ? entries.data.rejections.filter((entry) => entry.name === "flush" && entry.classification === "cancelled").map((entry) => entry.id) : []
        if (ids.length !== pinned.ids.length) reasons.push(`seed 206 has ${ids.length} flush/cancelled rejections, recorded ${pinned.ids.length}`)
        observed.push({ path: ["seeds", "hook206", "ids"], value: ids })
      }
      return { run, reasons, notes: [], counts: null, observed, hashJudge: judged.hashJudge }
    },
  }
}

const armJob = (arm: Arm): Job => ({
  id: `arm:${arm.id}`, group: `mutations-${arm.family}`,
  isolated: runsTestFile(arm.command, exp.isolatedTests), deps: arm.control === null ? [] : [`arm:${arm.control}`],
  estimate: arm.command.rc7Seconds, command: commandText(arm.command), reaches: overlayReaches(arm.command.argv),
  hard: (run) => [...signalOf(run), ...(harness(arm).test(run.text) ? ["harness error in the log"] : [])],
  execute: async (dir) => {
    for (const file of arm.materialize) {
      const contents = file.edits.reduce((text, edit, index) => applyEdit(text, edit.from, edit.to, `${arm.id} materialize edit ${index}`),
        readFileSync(path.join(repoRoot, file.source), "utf8"))
      writeFileSync(path.join(dir, file.file), contents)
    }
    const spec = arm.spec !== null && arm.id === broken ? { ...arm.spec, changes: arm.spec.changes.map((change) => ({ ...change, to: change.from })) } : arm.spec
    if (spec !== null) writeFileSync(path.join(dir, "spec.json"), fill(`${JSON.stringify(spec, null, 1)}\n`, dir))
    // product-overlay.ts applies this arm's spec on top of a simulated product change, and prints its overlay's marker.
    const run = await runCommand({ ...arm.command, env: { ...arm.command.env, FAST_CERT_ARM_MARKER: arm.marker } }, dir, "run")
    let rejection: [number, number][] | null = null
    if (arm.rejectionGate && arm.expect.fuzz !== null) {
      const gateRun = await runCommand({ argv: ["bun", "--conditions=browser", exp.mutations.rejectionGateScript,
        `${jobDirToken}/out/seed-${arm.expect.fuzz.seed}/summary.json`, "B6"], alarmSeconds: 60, env: {}, evidence: true, rc7Seconds: 0.5 }, dir, "rejection-gate")
      const line = gateRun.text.split("\n").filter((entry) => entry.startsWith("{")).at(-1)
      const parsed = line ? rejectionViolations.safeParse(JSON.parse(line)) : undefined
      rejection = parsed?.success ? parsed.data.rejectionViolations.map((entry): [number, number] => [entry.seed, entry.id]) : null
    }
    const control = arm.control === null ? undefined : results.get(`arm:${arm.control}`)
    return { run, ...judgeArm(arm, run, dir, control?.counts ?? null, rejection), observed: [{ path: ["mutations", "arms", `id=${arm.id}`, "expect"], value: measureArm(arm, run, dir, rejection) }] }
  },
})

const lintableChanged = changed.filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && existsSync(path.join(repoRoot, file)))
// Scoped oxlint on the changed files: every diagnostic must be one root lint already carries (RC7's known reds).
const scopedLintJob = (): Job => {
  const command: Command = { argv: ["bun", "x", "oxlint", "--deny-warnings", "--report-unused-disable-directives", ...lintableChanged.map((file) => path.join(repoRoot, file))],
    alarmSeconds: 180, env: {}, evidence: false, rc7Seconds: 1 }
  const known = exp.gates.find((gate) => gate.name === "g-lint")?.judge
  const allowed = known?.kind === "lint" ? known.signature.map(([diagnostic, where]) => `${diagnostic}\t${where}`) : []
  return {
    id: "gate:scoped-oxlint-changed", group: "scoped-lint", isolated: false, deps: [], estimate: 1, command: commandText(command), reaches: false, hard: signalOf,
    execute: async (dir) => {
      const run = await runCommand(command, dir, "run")
      const remaining = [...allowed]
      const unknown = lintSignature(run.text).map(([diagnostic, where]) => `${diagnostic}\t${where}`).filter((entry) => {
        const index = remaining.indexOf(entry)
        if (index >= 0) remaining.splice(index, 1)
        return index < 0
      })
      return { run, observed: [], reasons: [...(run.signal === null ? [] : [`signal ${run.signal}`]), ...unknown.map((entry) => `new diagnostic: ${entry}`)], notes: [], counts: null }
    },
  }
}

// ---------- test files that reach the change (T1) ----------
// A gate that runs a whole test file (no -t filter) already judges it; the rest of what imports a changed file runs in shards
// judged against test-baseline.json. Isolated test files (wall-clock budgets) run alone in the tail.
const baseline = existsSync(testBaselineFile) ? testBaseline.parse(JSON.parse(readFileSync(testBaselineFile, "utf8"))) : { knownRed: {} }
const testShardJobs = (gates: Gate[]): Job[] => {
  if (full || !reaches("T1")) return []
  const covered = gates.filter((gate) => gate.command.argv.includes("test") && !gate.command.argv.includes("-t"))
    .flatMap((gate) => gate.command.argv.filter((value) => value.startsWith(repoRoot)).map((value) => path.relative(repoRoot, value)))
  const reached = testsReaching(changed).tests.filter((file) => !covered.some((entry) => file === entry || file.startsWith(`${entry}/`)))
  const shardJob = (files: string[], id: string, isolated: boolean): Job => {
    const command: Command = { argv: ["bun", "--conditions=browser", "test", "--timeout", "30000", ...files.map((file) => path.join(repoRoot, file))], alarmSeconds: 900, env: {}, evidence: false, rc7Seconds: 5 + files.length * 0.6 }
    return {
      id, group: isolated ? "tests-t1-isolated" : "tests-t1", isolated, deps: [], estimate: command.rc7Seconds, command: commandText(command), reaches: true, hard: signalOf,
      execute: async (dir) => {
        const run = await runCommand(command, dir, "run")
        const reasons = judgeTestShard(files, run, baseline)
        // Files share one process, so one file's leftovers (the fixture Convex client's late websocket reply, mock state) can fail
        // another. A file that fails in the shard is rerun alone and judged by that run.
        const suspects = isolated ? [] : files.filter((file) => failuresByFile(run.text).has(file))
        const notes = [`${files.length} test files`]
        if (reasons.length > 0 && suspects.length > 0) {
          const alone = await Promise.all(suspects.map(async (file, index) => judgeTestShard([file], await runCommand({ ...command, argv: [...command.argv.slice(0, 5), path.join(repoRoot, file)] }, dir, `alone-${index}`), baseline)))
          notes.push(`rerun alone: ${suspects.join(", ")}`)
          return { run, reasons: [...signalOf(run), ...reasons.filter((reason) => !suspects.some((file) => reason.startsWith(`${file}:`))), ...alone.flat()], notes, counts: testCounts(run.text), observed: [] }
        }
        return { run, reasons: [...signalOf(run), ...reasons], notes, counts: testCounts(run.text), observed: [] }
      },
    }
  }
  const isolatedFiles = reached.filter((file) => exp.isolatedTests.includes(file))
  return [...testShards(reached.filter((file) => !exp.isolatedTests.includes(file)), 40).map((files, index) => shardJob(files, `tests:changed-${index + 1}`, false)),
    ...isolatedFiles.map((file) => shardJob([file], `tests:isolated-${file}`, true))]
}

// ---------- seed sample ----------
// The traced pair covers seeds 1-100 (--full) or 1-20. Shards start after it, in ten-seed blocks aligned to RC7's batches. Every
// block holding a named seed is kept (RC's named seeds, seed 206 and the 8 accepted extra hook seeds); more blocks are spread
// evenly until `seeds` seeds per fixture are covered in all. Adjacent blocks merge into shards up to the fixture's cap.
const seedShards = (fixture: "controller" | "hook", seeds: number) => {
  const firstBlock = full ? 10 : pairSeeds / 10
  const available = 100 - firstBlock
  const blocks = new Set(exp.seeds[fixture].named.map((seed) => Math.floor((seed - 1) / 10)).filter((block) => block >= firstBlock))
  const wanted = Math.max(blocks.size, Math.round(seeds / 10) - firstBlock)
  for (let step = 0; blocks.size < wanted && step < available; step++) blocks.add(firstBlock + Math.floor(step * available / wanted))
  for (let block = firstBlock; blocks.size < wanted && block < 100; block++) blocks.add(block)
  const sorted = [...blocks].sort((x, y) => x - y)
  const cap = exp.seeds[fixture].shardCap
  const shards: [number, number][] = []
  for (const block of sorted) {
    const last = shards.at(-1)
    if (last && last[0] + last[1] === block * 10 + 1 && last[1] + 10 <= cap) last[1] += 10
    else shards.push([block * 10 + 1, 10])
  }
  return shards
}
const seedsPerFixture = seedOverride ? Number(seedOverride) : everything ? 1000 : 100

const simulate = (jobs: Job[]) => {
  const pending = [...jobs].sort((x, y) => y.estimate - x.estimate)
  const done = new Map<string, number>()
  const free = Array.from({ length: pool }, () => 0)
  let end = 0
  while (pending.length > 0) {
    free.sort((x, y) => x - y)
    const now = free[0] ?? 0
    const readyAt = (job: Job) => Math.max(now, ...job.deps.map((dep) => done.get(dep) ?? Number.POSITIVE_INFINITY))
    let best = 0
    pending.forEach((job, index) => { if (readyAt(job) < readyAt(pending[best] ?? job)) best = index })
    const [job] = pending.splice(best, 1)
    if (!job) break
    const finish = readyAt(job) + job.estimate * parallelSlowdown
    done.set(job.id, finish)
    free[0] = finish
    end = Math.max(end, finish)
  }
  return end
}

const buildJobs = () => {
  const gates = exp.gates.filter((gate) => selectedBy(gate.trigger) && reaches(gateTier(gate.name)))
  const jobs = [
    ...gates.map(gateJob),
    ...exp.campaigns.filter((campaign) => !retiredCampaigns.has(campaign.name) && selectedBy(campaign.trigger)).map(campaignJob),
    ...(triggers.fuzz ? fixtures : []).map(traceJob),
    ...selectedArms.map(armJob),
    ...(triggers.fuzz ? fixtures.flatMap((fixture) => seedShards(fixture, seedsPerFixture).map(([first, count]) => seedJob(fixture, first, count))) : []),
    ...testShardJobs(gates),
    ...(!full && lintableChanged.length > 0 ? [scopedLintJob()] : []),
  ]
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const keep = new Set<string>()
  const include = (id: string) => {
    if (keep.has(id)) return
    keep.add(id)
    for (const dep of byId.get(id)?.deps ?? []) include(dep)
  }
  for (const id of only) include(id)
  const kept = only.size > 0 ? jobs.filter((job) => keep.has(job.id)) : jobs
  // RC order for the isolated tail: native ctest, DP, then the engine and buffer suites last. Isolated arms go first, each
  // control before its mutant (the sort is stable and expectations list a control first).
  const tailOrder = ["x", "dp", "g2", "last", "tests-t1-isolated"]
  const tail = kept.filter((job) => job.isolated).sort((x, y) => tailOrder.indexOf(x.group) - tailOrder.indexOf(y.group))
  const unordered = tail.filter((job, index) => job.deps.some((dep) => !tail.slice(0, index).some((entry) => entry.id === dep) && !kept.some((entry) => entry.id === dep && !entry.isolated)))
  if (unordered.length > 0) throw new Error(`Isolated jobs before their dependencies: ${unordered.map((job) => job.id).join(", ")}`)
  const parallel = kept.filter((job) => !job.isolated)
  const parallelSeconds = simulate(parallel)
  const tailSeconds = tail.reduce((sum, job) => sum + job.estimate, 0)
  return { parallel, tail, parallelSeconds, tailSeconds, wallSeconds: parallelSeconds + tailSeconds }
}
const plan = buildJobs()

// ---------- plan output ----------
const referenceProblems = Object.entries(exp.references).filter(([file, hash]) => !existsSync(archivedPath(file)) || sha256(readFileSync(archivedPath(file))) !== hash)
  .map(([file]) => archivedPath(file))
const minutes = (seconds: number) => `${Math.round(seconds)} s (${(seconds / 60).toFixed(1)} min)`
// A named job that is not in the plan would let the run pass on nothing.
const unknownIds = [...only, ...(broken ? [`arm:${broken}`] : [])].filter((id) => !plan.parallel.some((job) => job.id === id) && !plan.tail.some((job) => job.id === id))
const printPlan = () => {
  const lines: string[] = []
  lines.push(`FAST-CERT plan: ${full ? "--full" : `tier ${tier}`}${only.size > 0 ? `, --only ${[...only].join(",")}` : ""}${broken ? `, --break ${broken} (self-test: must FAIL)` : ""}`)
  if (unknownIds.length > 0) lines.push(`UNKNOWN JOB IDS: ${unknownIds.join(", ")}`)
  lines.push(`pool ${pool} = availableParallelism ${availableParallelism()} - 2; parallel slowdown x${parallelSlowdown}`)
  lines.push(`tier ${everything ? "all (--full or --only)" : tier}: ${everything ? "every job" : tierWhy}`)
  for (const note of exp.notes ?? []) lines.push(`note (${note.topic}, since ${note.since}, drop after ${note.dropAfter}): ${note.text}`)
  lines.push(`${productOverlay ? `product overlay ${productOverlay.spec} (in memory): ${productOverlay.files.join(", ")}\n` : ""}base ${baseFile ?? exp.manifest.path}${
    exp.rebase && !baseFile ? ` (${Object.entries(exp.rebase.replaced).map(([file, hashes]) => `${file} ${hashes.from.slice(0, 8)}… -> ${hashes.to.slice(0, 8)}…`).join(", ")})` : ""}; base commit ${baseCommit}; watched ${watched.size} files (manifest + fuzz sources); expectations from ${exp.source.rc} (${exp.source.scratch})`)
  lines.push(`changed (${changed.length}): ${changed.length > 40 ? `${changed.slice(0, 40).join(", ")} …` : changed.join(", ") || "none"}${simulated.length > 0 ? `   [simulated: ${simulated.join(", ")}]` : ""}`)
  lines.push(`retired: ${retiredCampaigns.size} campaigns (a traced pair is each fixture's B6 run), ${retired.size} arms (expected survivors and their orphaned controls, tools/certification/test-debt.md)`)
  lines.push(`triggers: fuzz (traced pair, named seeds) ${triggers.fuzz ? "yes" : "no"}, native ${triggers.native ? "yes" : "no"}, product (DP) ${triggers.product ? "yes" : "no"}`)
  lines.push(`reference tooling: ${referenceProblems.length === 0 ? `${Object.keys(exp.references).length} files archived at RC7 hashes` : `MISSING OR CHANGED: ${referenceProblems.join(", ")}`}`)
  lines.push("", "impact map (changed file -> mutation rows):")
  for (const [file, rows] of [...impact].filter(([, rows]) => rows.length > 0)) lines.push(`  ${file}: ${rows.length} rows (${rows.slice(0, 40).join(" ")}${rows.length > 40 ? " …" : ""})`)
  lines.push(`  (${[...impact.values()].filter((rows) => rows.length === 0).length} of ${impact.size} changed files select no row)`)
  const groups = new Map<string, Job[]>()
  for (const job of [...plan.parallel, ...plan.tail]) groups.set(job.group, [...(groups.get(job.group) ?? []), job])
  lines.push("", "group                 jobs   RC7 serial s   phase")
  for (const [group, jobs] of [...groups].sort()) {
    lines.push(`  ${group.padEnd(20)}${String(jobs.length).padStart(5)}${jobs.reduce((sum, job) => sum + job.estimate, 0).toFixed(1).padStart(15)}   ${jobs.every((job) => job.isolated) ? "isolated tail" : "parallel"}`)
  }
  lines.push("", "gates:")
  for (const job of [...plan.parallel, ...plan.tail].filter((entry) => entry.id.startsWith("gate:") || entry.id.startsWith("campaign:") || entry.id.startsWith("trace:")))
    lines.push(`  ${job.isolated ? "[tail]" : "      "} ${job.id.padEnd(44)} ${job.estimate.toFixed(1).padStart(7)} s`)
  lines.push("", `seeds per fixture: ${triggers.fuzz ? `${seedsPerFixture} (1-${full ? 100 : pairSeeds} from the traced pair)` : "none (below T2)"}`)
  for (const fixture of triggers.fuzz ? fixtures : []) {
    const shards = seedShards(fixture, seedsPerFixture)
    lines.push(`  ${fixture} shards (${shards.length}, ${shards.reduce((sum, shard) => sum + shard[1], 0)} seeds): ${shards.map(([first, count]) => `${first}-${first + count - 1}`).join(" ")}`)
  }
  lines.push("", `isolated tail: ${plan.tail.map((job) => `${job.id} ${job.estimate.toFixed(1)} s`).join(", ") || "none"}`)
  lines.push(`estimate: parallel phase ${minutes(plan.parallelSeconds)} (LPT over ${pool} workers, x${parallelSlowdown}) + isolated tail ${minutes(plan.tailSeconds)} = ${minutes(plan.wallSeconds)}`)
  console.log(lines.join("\n"))
}
printPlan()
if (planOnly) process.exit(0)
if (unknownIds.length > 0) process.exit(2)

// ---------- run ----------
if (referenceProblems.length > 0) {
  console.error(`Reference tooling missing or changed: ${referenceProblems.join(", ")}`)
  process.exit(2)
}
if (existsSync(outDir) && readdirSync(outDir).length > 0) {
  console.error(`Output directory is not empty: ${outDir}`)
  process.exit(2)
}
mkdirSync(path.join(outDir, "jobs"), { recursive: true })
for (const [file, target] of relocations) {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, relocate(readFileSync(archivedPath(file), "utf8")))
}
const disk = statfsSync(outDir)
if (disk.bavail * disk.bsize < 20 * 2 ** 30) {
  console.error(`Less than 20 GiB free under ${outDir}`)
  process.exit(2)
}
const results = new Map<string, Outcome>()
const runStarted = performance.now()
const allJobs = [...plan.parallel, ...plan.tail]
const faulted: Outcome[] = []
const observations = new Map<string, { reaches: boolean; observed: Observation[] }>()
const execute = async (job: Job, firstAttempt?: Outcome) => {
  const dir = firstAttempt ? `${jobDir(job.id)}-rerun` : jobDir(job.id)
  mkdirSync(dir, { recursive: true })
  latestDir.set(job.id, dir)
  const started = (performance.now() - runStarted) / 1000
  const verdict = await job.execute(dir).catch((error: Error): Verdict & { run: Run; observed: Observation[] } => ({
    run: { exit: null, signal: null, seconds: 0, text: "", log: "" }, reasons: [`runner error: ${error.message}`], notes: [], counts: null, observed: [],
  }))
  const ended = (performance.now() - runStarted) / 1000
  // A bless run judges nothing against the expectations (what it measured is compared afterwards); it fails only when the run broke
  // or a seed wrote no summary.
  const reasons = measuring ? [...job.hard(verdict.run), ...verdict.reasons.filter((reason) => reason.startsWith("runner error") || reason.endsWith(": no summary"))] : verdict.reasons
  const outcome: Outcome = { id: job.id, group: job.group, command: job.command, exit: verdict.run.exit, signal: verdict.run.signal, counts: verdict.counts,
    started, ended, seconds: ended - started, verdict: reasons.length > 0 ? "FAIL" : "PASS", reasons, notes: verdict.notes, log: verdict.run.log, hashJudge: verdict.hashJudge }
  observations.set(job.id, { reaches: job.reaches, observed: verdict.observed })
  // SIGKILL is the OS reclaiming memory from a parallel job (a starved-drain fuzz mutant, killed at 23 s in a ten-job phase, passes
  // alone in 11 s); it is rerun alone like the recorded faults.
  // A process or fork limit (EAGAIN) shared with whatever else the machine runs is the same kind of fault.
  const starved = { signature: "SIGKILL or EAGAIN", evidence: "the operating system refused or killed a process; a rerun alone decides" }
  const fault = !job.isolated && !firstAttempt && verdict.reasons.length > 0
    ? exp.environmentalFaults.find((entry) => verdict.run.text.includes(entry.signature))
      ?? (verdict.run.signal === "SIGKILL" || verdict.reasons.some((reason) => /EAGAIN|not deterministic/.test(reason)) || /EAGAIN: resource temporarily unavailable|Script not found "x"/.test(verdict.run.text) ? starved : undefined)
    : undefined
  if (fault) {
    outcome.notes.push(`known environmental fault "${fault.signature}" (${fault.evidence}): rerun alone after the parallel phase`)
    faulted.push(outcome)
  }
  if (firstAttempt) outcome.notes.push(`rerun alone; first attempt ${firstAttempt.verdict}${firstAttempt.reasons.length > 0 ? `: ${firstAttempt.reasons.join("; ")}` : ""} (log ${firstAttempt.log})`)
  results.set(job.id, outcome)
  console.log(`[${results.size}/${allJobs.length}] ${outcome.verdict} ${job.id} ${outcome.seconds.toFixed(1)} s${outcome.reasons.length > 0 ? `: ${outcome.reasons.join("; ")}` : ""}`)
  return verdict.reasons.length > 0 || verdict.observed.some((entry) => !sameJson(getAt(expectationsJson, entry.path), entry.value))
}
// A bounded pool: start ready jobs (longest first) until `pool` run, then wait for any child to exit. Dependants (a mutant after
// its control, a trace comparison after its pair) start only once their dependencies have finished.
const pending = [...plan.parallel].sort((x, y) => y.estimate - x.estimate)
const running = new Map<string, Promise<void>>()
const ready = (job: Job) => job.deps.every((dep) => results.has(dep))
while (pending.length > 0 || running.size > 0) {
  for (let index = pending.findIndex(ready); running.size < pool && index >= 0; index = pending.findIndex(ready)) {
    const [job] = pending.splice(index, 1)
    if (job) running.set(job.id, execute(job).then(() => { running.delete(job.id) }))
  }
  if (running.size === 0) throw new Error(`Jobs wait on dependencies that never run: ${pending.map((job) => job.id).join(", ")}`)
  await Promise.race(running.values())
}
// A job that hit a known environmental fault runs again alone, then any dependant that already ran on its first attempt.
for (const first of faulted) {
  // Its dependencies run again first (a trace comparison whose pair was disturbed), then it, then the dependants that already ran.
  const own = allJobs.find((entry) => entry.id === first.id)
  const rerun = [...allJobs.filter((entry) => own?.deps.includes(entry.id)), ...allJobs.filter((entry) => entry.id === first.id || entry.deps.includes(first.id) && results.has(entry.id))]
  for (const job of rerun) await execute(job, results.get(job.id))
}
// Isolated jobs: load-sensitive suites (the audio-engine ramp test, instrument buffers), the native ctest with its real-time host
// test, and DP, one at a time with nothing else running, as every RC since STEP7C ran them.
// A rebase measures what the run produced, so a suite whose measurement differs from the expectation (a wall-clock budget missed
// on a machine shared with other work) gets two more attempts; the last one stands.
for (const job of plan.tail) {
  let failed = await execute(job)
  for (let retry = 0; failed && measuring && retry < 2; retry++) failed = await execute(job, results.get(job.id))
}

const endHashes = hashWatched()
const endStatus = gitStatus()
const wallSeconds = (performance.now() - runStarted) / 1000
const freeze = { startDigest: digest(startHashes), endDigest: digest(endHashes), filesUnchanged: digest(startHashes) === digest(endHashes), gitStatusUnchanged: startStatus === endStatus }
const outcomes = [...results.values()]
const failing = outcomes.filter((outcome) => outcome.verdict === "FAIL")
const hashJudge = {
  gating: false,
  compared: outcomes.reduce((sum, outcome) => sum + (outcome.hashJudge?.compared ?? 0), 0),
  differing: outcomes.reduce((sum, outcome) => sum + (outcome.hashJudge?.differing.length ?? 0), 0),
  jobs: outcomes.flatMap((outcome) => outcome.hashJudge && outcome.hashJudge.differing.length > 0 ? [{ id: outcome.id, seeds: outcome.hashJudge.differing }] : []),
}
const verdict = failing.length === 0 && freeze.filesUnchanged && freeze.gitStatusUnchanged ? "PASS" : "FAIL"
writeFileSync(path.join(outDir, "result.json"), `${JSON.stringify({
  tool: "tools/certification/fast-cert.ts", mode: full ? "full" : "tiered", verdict, outDir, wallSeconds, estimateSeconds: plan.wallSeconds, pool,
  expectations: { file: expectationsFile, sha256: sha256(readFileSync(expectationsFile)), rc: exp.source.rc },
  base: baseFile ?? exp.manifest.path, overlay: productOverlay ?? null, changed, simulated, triggers, seedsPerFixture: triggers.fuzz ? seedsPerFixture : 0, tier: everything ? "all" : tier, tierWhy, baseCommit,
  head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim(), hashJudge, freeze,
  failing: failing.map((outcome) => outcome.id), gates: outcomes,
}, null, 1)}\n`)
if (measuring) writeFileSync(path.resolve(measureFile), `${JSON.stringify({ reverting, verdict, failing: failing.map((outcome) => outcome.id), hashes: Object.fromEntries(startHashes),
  provenance: { scope: scopeOf(args), head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim(), gitStatusSha256: sha256(startStatus),
    expectationsSha256: sha256(readFileSync(expectationsFile)), overlaySha256: productOverlay ? overlayIdentity(productOverlay.spec) : null },
  jobs: [...observations].map(([id, entry]) => ({ id, ...entry })) })}\n`)
const groupLines = [...new Set(outcomes.map((outcome) => outcome.group))].sort().map((group) => {
  const members = outcomes.filter((outcome) => outcome.group === group)
  const first = Math.min(...members.map((outcome) => outcome.started))
  const last = Math.max(...members.map((outcome) => outcome.ended))
  return `  ${group.padEnd(20)} ${String(members.length).padStart(5)} jobs  wall ${(last - first).toFixed(1).padStart(7)} s  (${first.toFixed(0)}-${last.toFixed(0)} s)  serial ${members.reduce((sum, outcome) => sum + outcome.seconds, 0).toFixed(1)} s  fail ${members.filter((outcome) => outcome.verdict === "FAIL").length}`
})
const summary = [
  `FAST-CERT ${full ? "--full" : `tier ${tier}`}: ${verdict}`,
  `wall ${minutes(wallSeconds)}, estimate ${minutes(plan.wallSeconds)}, pool ${pool}, ${outcomes.length} jobs, out ${outDir}`,
  `changed: ${changed.join(", ") || "none"}`,
  `freeze: ${freeze.filesUnchanged && freeze.gitStatusUnchanged ? `held (${freeze.startDigest.slice(0, 16)}…)` : `BROKEN (files ${freeze.filesUnchanged}, git status ${freeze.gitStatusUnchanged})`}`,
  `tier: ${everything ? "all" : tier} (${everything ? "--full or --only" : tierWhy}); base commit ${baseCommit}`,
  `hashJudge (diagnostic, does not gate): ${hashJudge.differing} of ${hashJudge.compared} seed summaries differ from the recorded hash`,
  `failing (${failing.length}):`, ...failing.map((outcome) => `  ${outcome.id}: ${outcome.reasons.join("; ")}`),
  `notes:`, ...outcomes.filter((outcome) => outcome.notes.length > 0).map((outcome) => `  ${outcome.id}: ${outcome.notes.join("; ")}`),
  `per-group wall times:`, ...groupLines,
  `slowest jobs:`, ...[...outcomes].sort((x, y) => y.seconds - x.seconds).slice(0, 20).map((outcome) => `  ${outcome.seconds.toFixed(1).padStart(7)} s  ${outcome.id}`),
].join("\n")
writeFileSync(path.join(outDir, "summary.txt"), `${summary}\n`)
console.log(`\n${summary}`)
process.exit(verdict === "PASS" ? 0 : 1)
