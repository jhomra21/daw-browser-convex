import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { expectationsSchema, expectationsFile, repoRoot, sameJson, type JsonValue } from "./expectations"
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
// A removed test may not be a killer: no arm may list it among the failures it expects.
export const killedRemovals = (manifest: RemovalManifest, exp: { mutations: { arms: { expect: { fails: string[] | null } }[] } }) => {
  const killers = new Set(exp.mutations.arms.flatMap((arm) => arm.expect.fails ?? []))
  return manifest.removed.filter((entry) => killers.has(entry.test)).map((entry) => `${entry.file}: removed test "${entry.test}" is a killer an arm expects to fail`)
}
// Manifest entries per file that a command runs: a test file named in argv, or one under a directory named there.
export const removableBy = (argv: string[], removed: RemovalManifest["removed"]) => {
  const targets = argv.includes("test") ? argv.map((value) => path.relative(repoRoot, path.resolve(repoRoot, value))) : []
  const run = removed.map((entry) => entry.file).filter((file) => targets.some((target) => file === target || file.startsWith(`${target}/`)))
  return Object.fromEntries([...new Set(run)].map((file) => [file, run.filter((other) => other === file).length]))
}
// Removable test counts by file for the job under judgement; a count drop beyond them is refused.
export type Removable = Record<string, number>

// B2: a test or defect count may not fall, a skip may not appear, and no verdict field (exit, failing set, status) may move.
// A fall is allowed only as a drop in `pass` of at most `allowed` (the removable tests this job runs) with skip and fail unchanged.
const lostWitnesses = (was: JsonValue | undefined, now: JsonValue | undefined, what: string, allowed = 0) => {
  const before = tally(was)
  const after = tally(now)
  if (!before) return []
  if (!after) return [`${what} counts disappeared`]
  const ruled = after.fail === before.fail && after.skip === before.skip && before.pass - after.pass <= allowed
  return [...(sum(after) < sum(before) && !ruled ? [`${what}: tests were removed (${sum(before)} -> ${sum(after)})`] : []), ...(after.skip > before.skip ? [`${what}: tests were skipped`] : [])]
}
export const weakened = (at: string[], old: JsonValue | undefined, next: JsonValue, role: string | undefined, removable: Removable = {}) => {
  const was = record.safeParse(old).data ?? {}
  const now = record.safeParse(next).data ?? {}
  const problems: string[] = []
  if (!sameJson(was.exit, now.exit)) problems.push("exit moved")
  if (was.kind === "tests" && !sameJson(was.fails, now.fails)) problems.push("failing tests moved")
  problems.push(...lostWitnesses(was.counts, now.counts, "counts", Object.values(removable).reduce((total, count) => total + count, 0)))
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
        problems.push(...lostWitnesses(counts, after[file], `engine file ${file}`, removable[file] ?? 0))
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
    ["B2 removal: a named removal within its count passes", weakened(["gates"], tests, { ...tests, counts: { pass: 8, skip: 0, fail: 1 } }, undefined, { "a.test.ts": 2 }).length === 0],
    ["B2 removal: a drop larger than the named count is refused", weakened(["gates"], tests, { ...tests, counts: { pass: 7, skip: 0, fail: 1 } }, undefined, { "a.test.ts": 2 }).length > 0],
    ["B2 removal: a drop in a job that runs no manifest file is refused", weakened(["gates"], tests, { ...tests, counts: { pass: 9, skip: 0, fail: 1 } }, undefined, {}).length > 0],
    ["B2 removal: a skip appearing is still refused", weakened(["gates"], tests, { ...tests, counts: { pass: 8, skip: 1, fail: 1 } }, undefined, { "a.test.ts": 2 }).length > 0],
    ["B2 removal: a moved failing set is still refused", weakened(["gates"], tests, { ...tests, counts: { pass: 8, skip: 0, fail: 1 }, fails: ["b"] }, undefined, { "a.test.ts": 2 }).length > 0],
    ["B2 removal: a fail count that moved with the drop is refused", weakened(["gates"], tests, { ...tests, counts: { pass: 9, skip: 0, fail: 0 } }, undefined, { "a.test.ts": 2 }).length > 0],
    ["B2 removal: an engine file drop is held to that file's own count", weakened(["gates"], { kind: "engine", exit: 0, files: { f: { pass: 3, skip: 0, fail: 0 }, g: { pass: 3, skip: 0, fail: 0 } } }, { kind: "engine", exit: 0, files: { f: { pass: 2, skip: 0, fail: 0 }, g: { pass: 2, skip: 0, fail: 0 } } }, undefined, { f: 1 }).length === 1],
    ["B2 removal: a named killer test refuses the bless", killedRemovals({ ruling: "r.md", removed: [{ file: "a.test.ts", test: "t1" }] }, { mutations: { arms: [{ expect: { fails: ["t1"] } }] } }).length > 0],
    ["B2 removal: a manifest with no killer passes", killedRemovals({ ruling: "r.md", removed: [{ file: "a.test.ts", test: "t1" }] }, { mutations: { arms: [{ expect: { fails: ["t2"] } }, { expect: { fails: null } }] } }).length === 0],
    ["B2 removal: only the files a command runs are removable", sameJson(removableBy(["bun", "test", `${repoRoot}/src/a.test.ts`, `${repoRoot}/lib`], [{ file: "src/a.test.ts", test: "x" }, { file: "src/a.test.ts", test: "y" }, { file: "lib/b.test.ts", test: "z" }, { file: "other/c.test.ts", test: "w" }]), { "src/a.test.ts": 2, "lib/b.test.ts": 1 })],
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
