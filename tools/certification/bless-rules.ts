import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { expectationsSchema, expectationsFile, failedTestsByFile, leafName, passedTests, perFileCounts, sameJson, testCounts, type JsonValue } from "./expectations"
import { measureArm } from "./measure"
import { seedRecord, type SeedRecord } from "./seed-judge"

// The rules a recorded change to expectations.json has to pass, shared by `fast-cert.ts --bless` and `--rebase … --revert` (rebase.ts).
// Run `bun tools/certification/bless-rules.ts` to prove each rule refuses; it exits 1 when one does not.
//   B1 no substituted measurements: measure.ts throws where evidence is absent (checked here against real arms).
//   B2 semantic non-regression: `weakened`.
//   B3 refuse a run that did not complete, did not pass, or whose source freeze failed: `unfinished`.
//   B4 bind evidence to its scope and provenance, and pair every live observation with a reverted one: `provenanceProblems`, `unpaired`.
export const provenance = z.object({ scope: z.array(z.string()), head: z.string(), gitStatusSha256: z.string(), expectationsSha256: z.string(), overlaySha256: z.string().nullable() })
export type Provenance = z.infer<typeof provenance>
export const measurement = z.object({
  reverting: z.boolean(), verdict: z.string(), failing: z.array(z.string()), provenance,
  hashes: z.record(z.string(), z.string().nullable()),
  jobs: z.array(z.object({ id: z.string(), reaches: z.boolean(), observed: z.array(z.object({ path: z.array(z.string()), value: z.json() })) })),
})
export type Measurement = z.infer<typeof measurement>
export const runResult = z.object({ verdict: z.string(), wallSeconds: z.number(), freeze: z.object({ filesUnchanged: z.boolean(), gitStatusUnchanged: z.boolean() }) })
export type RunResult = z.infer<typeof runResult>

const record = z.record(z.string(), z.json())
const strings = (value: JsonValue | undefined) => z.array(z.string()).safeParse(value).data ?? []
const tally = (value: JsonValue | undefined) => z.object({ pass: z.number(), skip: z.number(), fail: z.number() }).safeParse(value).data
type Tally = NonNullable<ReturnType<typeof tally>>
const sum = (counts: Tally) => counts.pass + counts.skip + counts.fail
const invariants = (fuzz: JsonValue | undefined) => ({ status: record.safeParse(fuzz).data?.status ?? null, failures: (z.array(record).safeParse(record.safeParse(fuzz).data?.failures).data ?? []).map((failure) => failure.invariant ?? null) })
const rejectionSeeds = (value: JsonValue | undefined) => z.array(z.array(z.number())).safeParse(value).data?.map(([seed]) => seed) ?? null
// Entries of `now` beyond what `was` holds, counting repeats (diagnostic lists are multisets).
const added = (was: string[], now: string[]) => {
  const left = [...was]
  return now.filter((entry) => {
    const at = left.indexOf(entry)
    if (at < 0) return true
    left.splice(at, 1)
    return false
  })
}

// A ruled test removal (`--allow-removal <manifest>`): the parent ruled these tests out in `ruling`, and the bless may record the
// count drop they cause.
export const removalManifest = z.object({ ruling: z.string(), removed: z.array(z.object({ file: z.string(), test: z.string() })) })
export type RemovalManifest = z.infer<typeof removalManifest>
// The evidence is identity, not a count: the paired runs' logs (reverted before, live after) are diffed test by test, and every passing
// test the live log lost must be a manifest entry of that file. The command line decides nothing.
const removedKey = (entry: RemovalManifest["removed"][number]) => `${entry.file}\t${entry.test}`
// A manifest name is a qualified name (`suite > test`) or a bare one; a bare name matches a log identity by its leaf.
const named = (identity: string, test: string) => identity === test || (!test.includes(" > ") && leafName(identity) === test)
type KillerSource = { mutations: { arms: { expect: { fails: string[] | null } }[] }, gates: { judge: { kind: string, fails?: string[] } }[] }
// Refused outright, whatever the scope: a duplicate entry, a file that no longer exists (a deleted test file is not admissible, per
// PARENT-RULING-ALLOW-REMOVAL-V2.md: a whole-file deletion is proven by a direct audit instead), or a removed test that is a killer (an
// arm's `expect.fails` or a gate's `judge.fails` names it). Killers and entries are compared by leaf name, as failures are measured.
export const manifestProblems = (manifest: RemovalManifest, exp: KillerSource, exists: (file: string) => boolean) => {
  const killers = new Set([...exp.mutations.arms.flatMap((arm) => arm.expect.fails ?? []), ...exp.gates.flatMap((gate) => gate.judge.fails ?? [])].map(leafName))
  return manifest.removed.flatMap((entry, index) => [
    ...(manifest.removed.findIndex((other) => removedKey(other) === removedKey(entry)) < index ? [`${entry.file}: "${entry.test}" is listed twice`] : []),
    ...(exists(entry.file) ? [] : [`${entry.file}: the removed test file does not exist; a deleted test file is not admissible through --allow-removal (PARENT-RULING-ALLOW-REMOVAL-V2.md)`]),
    ...(killers.has(leafName(entry.test)) ? [`${entry.file}: removed test "${entry.test}" is a killer a gate or arm expects to fail`] : []),
  ])
}
// The identity diff of one paired job: the passing tests the live log (`after`) lost from the reverted log (`before`). A lost test is
// claimed by one manifest entry of its file, and `claimed` counts the claimed tests by file. `problems` refuse the job: a lost test no
// entry names, a lost test whose leaf is new in another file (a move, which is not admissible), a bare name that matches several lost
// tests in one file, and a log whose `(pass)` lines do not reconcile with its measured pass count. Leaves are matched only to diagnose a
// move, never to claim a loss.
export type Removal = { claimed: Record<string, number>, problems: string[] }
const reconciles = (label: string, log: string, tests: Map<string, string[]>) => {
  const parsed = [...tests.values()].reduce((total, names) => total + names.length, 0)
  const measured = testCounts(log).pass
  return parsed === measured ? [] : [`${label} log parse does not reconcile: ${parsed} passing tests parsed, ${measured} measured`]
}
export const removalOf = (before: string, after: string, removed: RemovalManifest["removed"]): Removal => {
  const was = passedTests(before)
  const now = passedTests(after)
  const failing = failedTestsByFile(after)
  // A pass that became a fail is a stronger kill, not a removal: the test still exists.
  const lost = [...was].flatMap(([file, names]) => added(now.get(file) ?? [], names).filter((identity) => !(failing.get(file) ?? []).includes(identity)).map((identity) => ({ file, identity })))
  const gained = [...now].flatMap(([file, names]) => added(was.get(file) ?? [], names).map((identity) => ({ file, identity })))
  const unclaimed = [...removed]
  const claimed: Record<string, number> = {}
  const problems = [...reconciles("reverted", before, was), ...reconciles("live", after, now)]
  for (const { file, identity } of lost) {
    const moved = gained.find((next) => next.file !== file && leafName(next.identity) === leafName(identity))
    const at = unclaimed.findIndex((entry) => entry.file === file && named(identity, entry.test))
    if (moved) problems.push(`test moved from ${file} to ${moved.file}; moves are not admissible, record them separately: "${identity}"`)
    else if (at < 0) problems.push(`${file}: "${identity}" was lost and the manifest does not name it`)
    else {
      unclaimed.splice(at, 1)
      claimed[file] = (claimed[file] ?? 0) + 1
    }
  }
  const ambiguous = removed.flatMap((entry) => {
    const matches = lost.filter((next) => next.file === entry.file && named(next.identity, entry.test))
    return !entry.test.includes(" > ") && matches.length > 1
      ? [`${entry.file}: "${entry.test}" is ambiguous: it names ${matches.length} lost tests (${matches.map((next) => `"${next.identity}"`).join(", ")}); name it qualified`]
      : []
  })
  return { claimed, problems: [...problems, ...ambiguous] }
}
const withinRemoval = (removal: Removal) => Object.values(removal.claimed).reduce((total, count) => total + count, 0)

// B2: a test or defect count may not fall, a skip may not appear, and no verdict field (exit, failing set, status) may move.
// A fall in `pass` is allowed only as far as `claimed` (the lost passing tests the manifest names, see removalOf), with skip and fail unchanged.
// A mutant arm may also gain fails (a stronger kill): `pass` may then fall by the fails gained as well.
const lostWitnesses = (was: JsonValue | undefined, now: JsonValue | undefined, what: string, claimed = 0, mutant = false) => {
  const before = tally(was)
  const after = tally(now)
  if (!before) return []
  if (!after) return [`${what} counts disappeared`]
  const gained = mutant ? Math.max(0, after.fail - before.fail) : 0
  const ruled = before.pass - after.pass <= claimed + gained && (mutant ? after.fail >= before.fail : after.fail === before.fail) && after.skip === before.skip
  return [...(sum(after) < sum(before) && !ruled ? [`${what}: tests were removed (${sum(before)} -> ${sum(after)})`] : []), ...(after.skip > before.skip ? [`${what}: tests were skipped`] : [])]
}
export const weakened = (at: string[], old: JsonValue | undefined, next: JsonValue, role: string | undefined, removal?: Removal) => {
  const was = record.safeParse(old).data ?? {}
  const now = record.safeParse(next).data ?? {}
  const problems: string[] = []
  if (!sameJson(was.exit, now.exit)) problems.push("exit moved")
  // A mutant arm's failing set may grow and never shrink; every other observation's failing set may not move.
  if (was.kind === "tests" && role !== "mutant" && !sameJson(was.fails, now.fails)) problems.push("failing tests moved")
  problems.push(...lostWitnesses(was.counts, now.counts, "counts", removal && withinRemoval(removal), role === "mutant"))
  const floor = (field: string) => ({ was: z.number().safeParse(was[field]).data, now: z.number().safeParse(now[field]).data })
  const rejected = floor("rejected")
  if (rejected.was !== undefined && !(rejected.now !== undefined && rejected.now >= rejected.was)) problems.push("fewer rejected defects")
  const total = floor("total")
  if (total.was !== undefined && !(total.now !== undefined && total.now >= total.was)) problems.push("fewer native tests")
  if (was.kind === "lint" || was.kind === "tsc") {
    const key = was.kind === "lint" ? "signature" : "diagnostics"
    const flat = (value: JsonValue | undefined) => (Array.isArray(value) ? value : []).map((entry) => JSON.stringify(entry))
    if (added(flat(was[key]), flat(now[key])).length > 0) problems.push(`new ${was.kind} diagnostics`)
  }
  if (was.kind === "engine") {
    const before = record.safeParse(was.files).data ?? {}
    const after = record.safeParse(now.files).data ?? {}
    for (const [file, counts] of Object.entries(before)) {
      if (!(file in after)) problems.push(`engine file ${file} no longer runs`)
      else {
        if (tally(counts)?.fail !== tally(after[file])?.fail) problems.push(`engine file ${file} failing count moved`)
        problems.push(...lostWitnesses(counts, after[file], `engine file ${file}`, removal?.claimed[file]))
      }
    }
  }
  if (at[0] !== "mutations") return problems
  for (const key of ["applied", "tsErrors"]) if (!sameJson(was[key], now[key])) problems.push(`${key} moved`)
  // A rejection record is a position in the event stream: its seeds and its count may not move, its ids follow the stream.
  if (!sameJson(rejectionSeeds(was.rejection), rejectionSeeds(now.rejection))) problems.push("rejection seeds or count moved")
  if (!sameJson(invariants(was.fuzz), invariants(now.fuzz))) problems.push("fuzz status or invariants moved")
  const lost = strings(was.fails).filter((test) => !strings(now.fails).includes(test))
  if (role === "mutant" ? lost.length > 0 : !sameJson(was.fails, now.fails)) problems.push("recorded failures moved")
  const oracle = record.safeParse(was.oracle).data
  if (oracle && (record.safeParse(now.oracle).data?.message !== oracle.message || strings(oracle.unrejected).some((defect) => !strings(record.safeParse(now.oracle).data?.unrejected).includes(defect))))
    problems.push("oracle moved or rejects a recorded defect")
  return problems
}

// Seed records (seed-records.json) under B2: status, failures and rejections never move and an exercised invariant is never lost; a
// ceiling may fall, and a rise is listed field by field in the rebase. Native dispatch and publication counts keep their DV-01 cost
// contract: a rise needs the bless to name the field (`--allow-rise <field>`). `compileCount` is not one: it counts renderer-side
// schedule compiles, which cross no native boundary and cost no Inspect, dispatch or publication, so a rise is ruled by being listed.
// Every other ceiling (`candidate:<status>` and any native count a fuzzer adds later) is held to the contract.
const rendererCosts = new Set(["compileCount"])
// A rejection may be added or removed only when the bless names it (`--allow-rejection <fixture>:<seed>:<name|classification|domain>`;
// `allowRejection` holds this seed's named entries), the seed passes with no failure before and after, and the rejection is one
// the fuzz gate never counts: a `cancelled` settlement carries no failure class (the hooks' checkRejections record it with
// `class: undefined`), so no class of the gate table (classes, gateViolations at B6) applies to it. Every other classification
// (lost-edit, applied-but-rejected, stale-ending-domain) carries a class that is a violation at B6.
const rejectionProblems = (was: SeedRecord, now: SeedRecord, allowRejection: string[]) =>
  [...added(was.rejections, now.rejections), ...added(now.rejections, was.rejections)].flatMap((entry) => {
    if (!allowRejection.includes(entry)) return [`rejection ${entry} moved; it needs --allow-rejection`]
    return [
      ...(was.status === "pass" && now.status === "pass" && was.failures.length === 0 && now.failures.length === 0 ? [] : [`rejection ${entry} moved on a seed that does not pass cleanly`]),
      ...(entry.split("|")[1] === "cancelled" ? [] : [`rejection ${entry} is not a cancelled settlement; its class is a violation at B6`]),
    ]
  })
export const seedRecordProblems = (old: JsonValue | undefined, next: JsonValue, allowRise: string[], allowRejection: string[] = []) => {
  const was = seedRecord.safeParse(old).data
  const now = seedRecord.safeParse(next).data
  if (!was || !now) return ["seed record is missing or malformed"]
  return [
    ...(was.status === now.status ? [] : [`status moved ${was.status} -> ${now.status}`]),
    ...(sameJson(was.failures, now.failures) ? [] : ["failures moved"]),
    ...rejectionProblems(was, now, allowRejection),
    ...was.exercised.filter((invariant) => !now.exercised.includes(invariant)).map((invariant) => `${invariant} is no longer exercised`),
    ...Object.entries(now.ceilings).filter(([field, count]) => count > (was.ceilings[field] ?? 0) && !rendererCosts.has(field) && !allowRise.includes(field))
      .map(([field, count]) => `${field} rose ${was.ceilings[field] ?? 0} -> ${count}; a native activity count needs --allow-rise ${field}`),
  ]
}

// B3: the child finished (`child` is its exit status, undefined for a reused run), reported PASS, ran no failing job, and its
// source freeze held: no watched file and no git status moved while it ran.
export const unfinished = (label: string, child: number | null | undefined, measured: Measurement, result: RunResult) => [
  ...(child === undefined || child === 0 ? [] : [`the ${label} run exited ${child}`]),
  ...(measured.verdict === "PASS" && result.verdict === "PASS" ? [] : [`the ${label} run's verdict is ${measured.verdict} (result ${result.verdict})`]),
  ...(measured.failing.length === 0 ? [] : [`the ${label} run broke: ${measured.failing.join(", ")}`]),
  ...(result.freeze.filesUnchanged && result.freeze.gitStatusUnchanged ? [] : [`the ${label} run's source freeze broke (files ${result.freeze.filesUnchanged}, git status ${result.freeze.gitStatusUnchanged})`]),
]

const provenanceFields: (keyof Provenance)[] = ["scope", "head", "gitStatusSha256", "expectationsSha256", "overlaySha256"]
// B4: a measurement stands only for the scope, bytes, overlay and expectations it was taken on.
export const provenanceProblems = (label: string, measured: Measurement, want: Provenance, reverting: boolean, current: (file: string) => string | null) => [
  ...(measured.reverting === reverting ? [] : [`the ${label} measurement is ${measured.reverting ? "" : "not "}a reverted run`]),
  ...provenanceFields.filter((key) => !sameJson(measured.provenance[key], want[key])).map((key) => `the ${label} measurement was taken on another ${key}`),
  ...Object.entries(measured.hashes).filter(([file, hash]) => current(file) !== hash).map(([file]) => `the ${label} measurement was taken on other bytes of ${file}`),
]
type Observed = { job: string; path: string[] }
const key = (entry: Observed) => `${entry.job}\t${entry.path.join(" / ")}`
// Every live observation needs a reverted one at the same job and path; an absent one is not a reproduction.
export const unpaired = (live: Observed[], reverted: Observed[]) => {
  const paired = new Set(reverted.map(key))
  return live.filter((entry) => !paired.has(key(entry))).map(key)
}

if (import.meta.main) {
  const clean: Measurement = { reverting: false, verdict: "PASS", failing: [], provenance: { scope: ["--full"], head: "h", gitStatusSha256: "g", expectationsSha256: "e", overlaySha256: null }, hashes: { "a.ts": "x" }, jobs: [] }
  const finished: RunResult = { verdict: "PASS", wallSeconds: 1, freeze: { filesUnchanged: true, gitStatusUnchanged: true } }
  const same = clean.provenance
  const current = (file: string) => file === "a.ts" ? "x" : null
  const exp = expectationsSchema.parse(JSON.parse(readFileSync(expectationsFile, "utf8")))
  const dir = mkdtempSync(path.join(tmpdir(), "bless-rules-"))
  const throws = (call: () => void) => { try { call() } catch { return true } return false }
  const fuzzArm = exp.mutations.arms.find((arm) => arm.expect.fuzz !== null)
  const oracleArm = exp.mutations.arms.find((arm) => arm.expect.oracle !== null)
  const seed = { status: "pass", failures: [], rejections: [], exercised: ["I1", "I2"], ceilings: { compileCount: 17, "candidate:accepted": 2 } }
  const cancelled = "latency|cancelled|ending-transport-domain"
  const violation = "latency|stale-ending-domain|ending-transport-domain"
  const tests = { kind: "tests", exit: 0, counts: { pass: 10, skip: 0, fail: 1 }, fails: ["a"] }
  // A `bun test` log: a header per file, a `(pass)` line per test, then the summary the counts are read from.
  const fixture = (files: Record<string, string[]>) => `${Object.entries(files).map(([file, names]) => `${file}:\n${names.map((name) => `(pass) ${name} [0.10ms]`).join("\n")}\n`).join("\n")}\n ${Object.values(files).flat().length} pass\n 0 fail\n`
  const entry = (file: string, test: string) => ({ file, test })
  const judged = (before: string, after: string, removed: RemovalManifest["removed"]) => {
    const removal = removalOf(before, after, removed)
    return [...removal.problems, ...weakened(["gates"], { kind: "tests", exit: 0, counts: testCounts(before), fails: [] }, { kind: "tests", exit: 0, counts: testCounts(after), fails: [] }, undefined, removal)]
  }
  const killers = (arms: string[], gates: string[]) => ({ mutations: { arms: arms.map((fail) => ({ expect: { fails: [fail] } })) }, gates: gates.map((fail) => ({ judge: { kind: "tests", fails: [fail] } })) })
  const problemsOf = (before: string, after: string, removed: RemovalManifest["removed"]) => removalOf(before, after, removed).problems
  // Real `bun test` output (bun 1.4.2): a `(pass)` line may carry no duration, a `(fail)` line follows its error, and the summary is last.
  const bunLog = ["bun test v1.4.2 (744846f84)", "", "a.test.ts:", "(pass) t1 [0.01ms]", "(pass) suite > t2", "(skip) suite > t3", "", "sub/b.test.ts:", "(pass) u1",
    "error: expect(received).toBe(expected)", "", "Expected: 1", "Received: 2", "", "(fail) t1 [0.07ms]", "", " 3 pass", " 1 skip", " 1 fail", " 4 expect() calls", "Ran 5 tests across 2 files. [2.00ms]"].join("\n")
  const cases: [string, boolean][] = [
    ["B1 a missing seed summary is not measured", fuzzArm !== undefined && throws(() => { measureArm(fuzzArm, { exit: 1, text: "", log: "" }, dir, null) })],
    ["B1 a missing oracle failure is not measured", oracleArm !== undefined && throws(() => { measureArm(oracleArm, { exit: 1, text: "", log: "" }, dir, null) })],
    ["B2 fewer rejected defects", weakened(["gates"], { kind: "selftest", exit: 0, rejected: 30 }, { kind: "selftest", exit: 0, rejected: 29 }, undefined).length > 0],
    ["B2 removed tests", weakened(["gates"], tests, { ...tests, counts: { pass: 9, skip: 0, fail: 1 } }, undefined).length > 0],
    ["B2 skipped tests", weakened(["gates"], tests, { ...tests, counts: { pass: 10, skip: 1, fail: 1 } }, undefined).length > 0],
    ["B2 a moved verdict", weakened(["gates"], tests, { ...tests, exit: 1 }, undefined).length > 0],
    ["B2 a lost witness file", weakened(["gates"], { kind: "engine", exit: 0, files: { f: { pass: 3, skip: 0, fail: 0 } } }, { kind: "engine", exit: 0, files: {} }, undefined).length > 0],
    ["B2 a lost failure in a mutant arm", weakened(["mutations", "arms", "id=m", "expect"], { exit: 1, fails: ["t"] }, { exit: 1, fails: [] }, "mutant").length > 0],
    ["B2 allows additive tests", weakened(["gates"], tests, { ...tests, counts: { pass: 12, skip: 0, fail: 1 } }, undefined).length === 0],
    ["B2 removal: an exact named removal with matching logs passes", judged(fixture({ "a.test.ts": ["t1", "t2", "t3"] }), fixture({ "a.test.ts": ["t1", "t2"] }), [entry("a.test.ts", "t3")]).length === 0],
    ["B2 removal: a qualified name matches its qualified log identity", judged(fixture({ "a.test.ts": ["s > t1", "s > t2"] }), fixture({ "a.test.ts": ["s > t1"] }), [entry("a.test.ts", "s > t2")]).length === 0],
    ["B2 removal: an unrelated test lost from another file is refused", judged(fixture({ "a.test.ts": ["t1", "t2"], "b.test.ts": ["u1", "u2"] }), fixture({ "a.test.ts": ["t1", "t2"], "b.test.ts": ["u1"] }), [entry("a.test.ts", "t3")]).length > 0],
    ["B2 removal: a test lost through a -t filter is refused", judged(fixture({ "a.test.ts": ["t1", "t2", "t3"] }), fixture({ "a.test.ts": ["t1"] }), [entry("a.test.ts", "t3")]).length > 0],
    ["B2 removal: a file that stops registering is refused", judged(fixture({ "a.test.ts": ["t1"], "b.test.ts": ["u1"] }), fixture({ "a.test.ts": ["t1"] }), [entry("a.test.ts", "t1")]).length > 0],
    ["B2 removal: the same name in another file is refused", judged(fixture({ "a.test.ts": ["t1", "t2"], "b.test.ts": ["t3"] }), fixture({ "a.test.ts": ["t1", "t2"] }), [entry("a.test.ts", "t3")]).length > 0],
    ["B2 removal: a skip appearing is still refused", weakened(["gates"], tests, { ...tests, counts: { pass: 8, skip: 1, fail: 1 } }, undefined, removalOf(fixture({ "a.test.ts": ["t1", "t2", "t3"] }), fixture({ "a.test.ts": ["t1"] }), [entry("a.test.ts", "t2"), entry("a.test.ts", "t3")])).length > 0],
    ["B2 removal: a moved failing set is still refused", weakened(["gates"], tests, { ...tests, counts: { pass: 9, skip: 0, fail: 1 }, fails: ["b"] }, undefined, removalOf(fixture({ "a.test.ts": ["t1", "t2"] }), fixture({ "a.test.ts": ["t1"] }), [entry("a.test.ts", "t2")])).length > 0],
    ["B2 removal: an engine file drop is held to that file's own identities", weakened(["gates"], { kind: "engine", exit: 0, files: { "f.test.ts": { pass: 2, skip: 0, fail: 0 }, "g.test.ts": { pass: 2, skip: 0, fail: 0 } } }, { kind: "engine", exit: 0, files: { "f.test.ts": { pass: 1, skip: 0, fail: 0 }, "g.test.ts": { pass: 1, skip: 0, fail: 0 } } }, undefined,
      removalOf(fixture({ "f.test.ts": ["x", "y"], "g.test.ts": ["z", "w"] }), fixture({ "f.test.ts": ["x"], "g.test.ts": ["z"] }), [entry("f.test.ts", "y")])).length === 1],
    ["B2 removal: a qualified manifest name that is a killer by its leaf is refused", manifestProblems({ ruling: "r.md", removed: [entry("a.test.ts", "suite > t1")] }, killers(["t1"], []), () => true).length > 0],
    ["B2 removal: a bare manifest name that is a killer by its leaf is refused", manifestProblems({ ruling: "r.md", removed: [entry("a.test.ts", "t1")] }, killers(["suite > t1"], []), () => true).length > 0],
    ["B2 removal: a gate judge.fails killer is refused", manifestProblems({ ruling: "r.md", removed: [entry("a.test.ts", "t1")] }, killers([], ["t1"]), () => true).length > 0],
    ["B2 removal: a duplicate manifest entry is refused", manifestProblems({ ruling: "r.md", removed: [entry("a.test.ts", "t1"), entry("a.test.ts", "t1")] }, killers([], []), () => true).length > 0],
    ["B2 removal: a manifest with no killer and no duplicate passes", manifestProblems({ ruling: "r.md", removed: [entry("a.test.ts", "t1"), entry("b.test.ts", "t1")] }, killers(["t2"], ["t3"]), () => true).length === 0],
    ["B2 removal: a lost test the manifest does not name is refused when another test is added", problemsOf(fixture({ "a.test.ts": ["a", "b", "c"] }), fixture({ "a.test.ts": ["a", "new", "new2"] }), [entry("a.test.ts", "b")]).some((problem) => problem.includes('"c"'))],
    ["B2 removal: an unnamed loss is refused when the count rises", problemsOf(fixture({ "a.test.ts": ["a", "b", "c"] }), fixture({ "a.test.ts": ["a", "new", "new2", "new3"] }), [entry("a.test.ts", "b")]).some((problem) => problem.includes('"c"'))],
    ["B2 removal: every lost test named, with additions, has no problems", problemsOf(fixture({ "a.test.ts": ["a", "b", "c"] }), fixture({ "a.test.ts": ["a", "new", "new2"] }), [entry("a.test.ts", "b"), entry("a.test.ts", "c")]).length === 0],
    ["B2 removal: a test moved to another file is refused with a diagnostic", problemsOf(fixture({ "a.test.ts": ["keep", "remove"] }), fixture({ "b.test.ts": ["keep"] }), [entry("a.test.ts", "remove")]).some((problem) => problem.includes("test moved from a.test.ts to b.test.ts; moves are not admissible, record them separately"))],
    ["B2 removal: a lost leaf already present in another file is not a move", problemsOf(fixture({ "a.test.ts": ["keep", "remove"], "b.test.ts": ["keep"] }), fixture({ "a.test.ts": ["keep"], "b.test.ts": ["keep"] }), [entry("a.test.ts", "remove")]).length === 0],
    ["B2 removal: a bare name matching two lost tests in one file is ambiguous", problemsOf(fixture({ "a.test.ts": ["s1 > t", "s2 > t"] }), fixture({ "a.test.ts": [] }), [entry("a.test.ts", "t")]).some((problem) => problem.includes("ambiguous"))],
    ["B2 removal: a bare name matching one lost test is not ambiguous", problemsOf(fixture({ "a.test.ts": ["s1 > t", "s2 > t"] }), fixture({ "a.test.ts": ["s2 > t"] }), [entry("a.test.ts", "t")]).length === 0],
    ["B2 removal: a qualified name of one of two same-leaf tests is accepted", problemsOf(fixture({ "a.test.ts": ["s1 > t", "s2 > t"] }), fixture({ "a.test.ts": ["s2 > t"] }), [entry("a.test.ts", "s1 > t")]).length === 0],
    ["B2 removal: a manifest file that no longer exists is refused and cites the ruling", manifestProblems({ ruling: "r.md", removed: [entry("gone.test.ts", "t1")] }, killers([], []), () => false).some((problem) => problem.includes("gone.test.ts") && problem.includes("PARENT-RULING-ALLOW-REMOVAL-V2"))],
    ["B2 removal: a manifest whose files all exist passes the file check", manifestProblems({ ruling: "r.md", removed: [entry("a.test.ts", "t1")] }, killers([], []), () => true).length === 0],
    ["B2 log: a parse that does not reconcile with the measured pass count is refused", problemsOf("a.test.ts:\n(pass) t1 [0.10ms]\n(pass) t2 [0.10ms]\n 3 pass\n 0 fail\n", fixture({ "a.test.ts": ["t1", "t2"] }), []).some((problem) => problem.includes("log parse does not reconcile"))],
    ["B2 log: a ./ header keys the same file as a bare header", perFileCounts("./a.test.ts:\n(pass) t1 [0.10ms]\n").get("a.test.ts")?.pass === 1],
    ["B2 log: a repeated file header appends its tests", JSON.stringify([...passedTests("a.test.ts:\n(pass) t1\na.test.ts:\n(pass) t2\n")]) === JSON.stringify([["a.test.ts", ["t1", "t2"]]])],
    ["B2 log: a repeated file header appends its counts", perFileCounts("a.test.ts:\n(pass) t1\na.test.ts:\n(pass) t2\n").get("a.test.ts")?.pass === 2],
    ["B2 log: real bun output parses to its passing identities and reconciles", JSON.stringify([...passedTests(bunLog)]) === JSON.stringify([["a.test.ts", ["t1", "suite > t2"]], ["sub/b.test.ts", ["u1"]]]) && problemsOf(bunLog, bunLog, []).length === 0],
    ["B2 stronger kill: a pass that becomes a fail is not a lost test", problemsOf(fixture({ "a.test.ts": ["t1", "t2"] }), "a.test.ts:\n(pass) t1 [0.10ms]\n(fail) t2 [0.10ms]\n 1 pass\n 1 fail\n", []).length === 0],
    ["B2 stronger kill: a test absent from the after log is still lost", problemsOf(fixture({ "a.test.ts": ["t1", "t2"] }), "a.test.ts:\n(pass) t1 [0.10ms]\n 1 pass\n 0 fail\n", []).some((problem) => problem.includes('"t2"'))],
    ["B2 stronger kill: a mutant arm gaining a fail is recorded", weakened(["mutations", "arms", "id=m", "expect"], { kind: "tests", exit: 1, counts: { pass: 9, skip: 0, fail: 1 }, fails: ["a"] }, { kind: "tests", exit: 1, counts: { pass: 8, skip: 0, fail: 2 }, fails: ["a", "b"] }, "mutant").length === 0],
    ["B2 stronger kill: a mutant arm gaining a fail beside a ruled removal is recorded", weakened(["mutations", "arms", "id=m", "expect"], { kind: "tests", exit: 1, counts: { pass: 9, skip: 0, fail: 1 }, fails: ["a"] }, { kind: "tests", exit: 1, counts: { pass: 7, skip: 0, fail: 2 }, fails: ["a", "b"] }, "mutant", { claimed: { "a.test.ts": 1 }, problems: [] }).length === 0],
    ["B2 stronger kill: a control arm gaining a fail is refused", weakened(["mutations", "arms", "id=c", "expect"], { kind: "tests", exit: 1, counts: { pass: 9, skip: 0, fail: 1 }, fails: ["a"] }, { kind: "tests", exit: 1, counts: { pass: 8, skip: 0, fail: 2 }, fails: ["a", "b"] }, "control").length > 0],
    ["B2 stronger kill: a gate gaining a fail is refused", weakened(["gates"], { kind: "tests", exit: 1, counts: { pass: 9, skip: 0, fail: 1 }, fails: ["a"] }, { kind: "tests", exit: 1, counts: { pass: 8, skip: 0, fail: 2 }, fails: ["a", "b"] }, undefined).length > 0],
    ["B2 stronger kill: a mutant arm losing a fail is refused", weakened(["mutations", "arms", "id=m", "expect"], { kind: "tests", exit: 1, counts: { pass: 8, skip: 0, fail: 2 }, fails: ["a", "b"] }, { kind: "tests", exit: 1, counts: { pass: 9, skip: 0, fail: 1 }, fails: ["a"] }, "mutant").length > 0],
    ["B2 stronger kill: a mutant arm whose exit goes to zero is refused", weakened(["mutations", "arms", "id=m", "expect"], { kind: "tests", exit: 1, counts: { pass: 9, skip: 0, fail: 1 }, fails: ["a"] }, { kind: "tests", exit: 0, counts: { pass: 8, skip: 0, fail: 2 }, fails: ["a", "b"] }, "mutant").length > 0],
    ["B2 log: a run directory is not part of a test's file identity",
      JSON.stringify([...passedTests("../../../../private/tmp/fast-cert/r1/revert/fixtures/rc5/b/x.test.ts:\n(pass) t1\n")]) === JSON.stringify([...passedTests("../../../../private/tmp/fast-cert/r1/live/fixtures/rc5/b/x.test.ts:\n(pass) t1\n")])
        && problemsOf("/tmp/fast-cert/r1/revert/fixtures/b/x.test.ts:\n(pass) t1\n 1 pass\n", "/tmp/fast-cert/r1/live/fixtures/b/x.test.ts:\n(pass) t1\n 1 pass\n", []).length === 0],
    ["B2 log: a job's own directory is not part of a test's file identity", JSON.stringify([...passedTests("/tmp/fast-cert/r1/jobs/arm_x/fixtures/x.test.ts:\n(pass) t1\n")]) === JSON.stringify([["fixtures/x.test.ts", ["t1"]]])],
    ["B2 log: a repository path named live stays", JSON.stringify([...passedTests("src/live/x.test.ts:\n(pass) t1\n")]) === JSON.stringify([["src/live/x.test.ts", ["t1"]]])],
    ["B2 seed record: a moved status", seedRecordProblems(seed, { ...seed, status: "fail" }, []).length > 0],
    ["B2 seed record: a moved failure", seedRecordProblems(seed, { ...seed, failures: ["I1|x|y"] }, []).length > 0],
    ["B2 seed record: a moved rejection", seedRecordProblems(seed, { ...seed, rejections: ["r|c|d"] }, []).length > 0],
    ["B2 seed record: a named cancelled rejection move passes", seedRecordProblems(seed, { ...seed, rejections: [cancelled] }, [], [cancelled]).length === 0],
    ["B2 seed record: a named cancelled rejection removal passes", seedRecordProblems({ ...seed, rejections: [cancelled] }, seed, [], [cancelled]).length === 0],
    ["B2 seed record: an unnamed rejection move is refused", seedRecordProblems(seed, { ...seed, rejections: [cancelled] }, [], []).length > 0],
    ["B2 seed record: another rejection than the named one is refused", seedRecordProblems(seed, { ...seed, rejections: [cancelled, "flush|cancelled|live"] }, [], [cancelled]).length > 0],
    ["B2 seed record: a named move on a failing seed is refused", seedRecordProblems({ ...seed, status: "fail", failures: ["I1|x|y"] }, { ...seed, status: "fail", failures: ["I1|x|y"], rejections: [cancelled] }, [], [cancelled]).length > 0],
    ["B2 seed record: a named move of a violation class is refused", seedRecordProblems(seed, { ...seed, rejections: [violation] }, [], [violation]).length > 0],
    ["B2 seed record: a lost exercised invariant", seedRecordProblems(seed, { ...seed, exercised: ["I1"] }, []).length > 0],
    ["B2 seed record: a missing record", seedRecordProblems(undefined, seed, []).length > 0],
    ["B2 seed record: a native count rise without --allow-rise", seedRecordProblems(seed, { ...seed, ceilings: { ...seed.ceilings, "candidate:accepted": 3 } }, []).length > 0],
    ["B2 seed record: a new native count above zero without --allow-rise", seedRecordProblems(seed, { ...seed, ceilings: { ...seed.ceilings, "native:publish": 1 } }, []).length > 0],
    ["B2 seed record: a rise another field names does not allow this one", seedRecordProblems(seed, { ...seed, ceilings: { ...seed.ceilings, "candidate:accepted": 3 } }, ["compileCount"]).length > 0],
    ["B2 seed record allows a named native count rise", seedRecordProblems(seed, { ...seed, ceilings: { ...seed.ceilings, "candidate:accepted": 3 } }, ["candidate:accepted"]).length === 0],
    ["B2 seed record allows a renderer compileCount rise", seedRecordProblems(seed, { ...seed, ceilings: { ...seed.ceilings, compileCount: 18 } }, []).length === 0],
    ["B2 seed record allows a ceiling fall", seedRecordProblems(seed, { ...seed, ceilings: { ...seed.ceilings, "candidate:accepted": 1, compileCount: 16 } }, []).length === 0],
    ["B2 a repeated tsc diagnostic is new", weakened(["gates"], { kind: "tsc", exit: 2, diagnostics: ["f|TS1|m"] }, { kind: "tsc", exit: 2, diagnostics: ["f|TS1|m", "f|TS1|m"] }, undefined).length > 0],
    ["B2 an identical tsc diagnostic list passes", weakened(["gates"], { kind: "tsc", exit: 2, diagnostics: ["f|TS1|m"] }, { kind: "tsc", exit: 2, diagnostics: ["f|TS1|m"] }, undefined).length === 0],
    ["B3 a child exit", unfinished("live", 1, clean, finished).length > 0],
    ["B3 a FAIL verdict", unfinished("live", 0, { ...clean, verdict: "FAIL" }, finished).length > 0],
    ["B3 a failing job", unfinished("live", 0, { ...clean, failing: ["gate:x"] }, finished).length > 0],
    ["B3 a broken freeze", unfinished("live", 0, clean, { ...finished, freeze: { filesUnchanged: false, gitStatusUnchanged: true } }).length > 0],
    ["B3 passes a finished run", unfinished("live", 0, clean, finished).length === 0],
    ["B4 another scope", provenanceProblems("live", clean, { ...same, scope: ["--tier", "T2"] }, false, current).length > 0],
    ["B4 another overlay", provenanceProblems("revert", { ...clean, reverting: true, provenance: { ...same, overlaySha256: "o1" } }, { ...same, overlaySha256: "o2" }, true, current).length > 0],
    ["B4 other bytes", provenanceProblems("live", clean, same, false, () => "y").length > 0],
    ["B4 an unpaired live observation", unpaired([{ job: "j", path: ["a"] }], [{ job: "j", path: ["b"] }]).length > 0],
    ["B4 passes bound evidence", provenanceProblems("live", clean, same, false, current).length === 0 && unpaired([{ job: "j", path: ["a"] }], [{ job: "j", path: ["a"] }]).length === 0],
  ]
  for (const [name, ok] of cases) console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
  process.exit(cases.every(([, ok]) => ok) ? 0 : 1)
}
