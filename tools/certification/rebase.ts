import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { killedRemovals, measurement, provenanceProblems, removableBy, removalManifest, runResult, seedRecordProblems, unfinished, unpaired, weakened, type Provenance } from "./bless-rules"
import { applyChanges, applyRebase, diffJson, expectationsFile, expectationsSchema, getAt, rebasesDir, repoRoot, sameJson, sha256, type JsonValue, type Rebase } from "./expectations"
import { overlayIdentity, scopeOf } from "./measure"
import { formatSeedRecords, seedRecords, seedRecordsFile, seedRecordsKey } from "./seed-judge"

// FAST-CERT --bless <name>  and  --rebase <name> --revert <path=entryCopy>…  (loaded by fast-cert.ts; never returns)
// --bless runs the requested scope once with --measure and records what the run moved against expectations.json.
// --rebase … --revert first runs the scope with the listed files replaced by their entry copies (product overlay): every
//   observation must equal the current expectations, or the expectations do not describe the entry bytes and nothing changes.
// Either way the live observations are diffed against the expectations, and the diff is refused where bless-rules.ts refuses it
// (B1 substituted measurements, B2 a lost verdict or witness, B3 a run that did not finish and pass with its freeze intact, B4 evidence
// that is not bound to this scope, overlay, bytes and expectations, or a live observation with no reverted one). The accepted diff
// is saved as rebases/<name>.json, listing every changed field old -> new, and applied to expectations.json in place (the base; RC7's
// records plus rebases 1-3 and the 511 re-anchor, whose raw scratch no longer exists).
const args = process.argv.slice(2)
const option = (flag: string) => args[args.indexOf(flag) + 1]
const blessing = args.includes("--bless")
const name = option(blessing ? "--bless" : "--rebase") ?? ""
const reverts = args.flatMap((value, index) => args[index - 1] === "--revert" ? [value.split("=")] : [])
  .map(([file = "", entryCopy = ""]) => ({ file, entryCopy: path.resolve(entryCopy) }))
const out = path.resolve(args.includes("--out") ? option("--out") ?? "" : path.join("/tmp/fast-cert", `${blessing ? "bless" : "rebase"}-${name}-${new Date().toISOString().replaceAll(":", "-")}`))
const fail = (message: string, detail?: JsonValue): never => {
  console.error(`${blessing ? "BLESS" : "REBASE"} ${name} FAILED: ${message}`)
  if (detail !== undefined) writeFileSync(path.join(out, "rebase-failed.json"), `${JSON.stringify({ message, detail }, null, 1)}\n`)
  return process.exit(1)
}

if (!/^[\w-]+$/.test(name) || (blessing ? reverts.length > 0 || args.includes("--rebase") : reverts.length === 0) || reverts.some((entry) => entry.file === "" || !existsSync(entry.entryCopy))) {
  console.error("usage: fast-cert.ts --bless <name> [scope flags] [--allow-rise <native count field>…] [--allow-rejection <fixture>:<seed>:<class>…] [--allow-removal <manifest.json>] [--reuse] [--out dir]\n       fast-cert.ts --rebase <name> --revert <repo-relative path>=<entry copy> [--revert …] [scope flags] [--reuse] [--out dir]")
  process.exit(2)
}
mkdirSync(out, { recursive: true })
const allowRise = args.flatMap((value, index) => args[index - 1] === "--allow-rise" ? [value] : [])
// `--allow-rejection <fixture>:<seed>:<class>`; the class holds no colon, so the first two colons split it.
const allowRejection = args.flatMap((value, index) => args[index - 1] === "--allow-rejection" ? [value] : [])
  .map((spec) => ({ spec, match: /^(controller|hook):(\d+):(.+)$/.exec(spec) }))
const rejectionNamesFor = (seedPath: string[]) => allowRejection.flatMap(({ match }) =>
  match && match[1] === seedPath[1] && `#${Number(match[2]) - 1}` === seedPath[2] ? [match[3] ?? ""] : [])
const badRejectionFlag = allowRejection.find(({ match }) => !match)
if (badRejectionFlag) fail(`--allow-rejection ${badRejectionFlag.spec} is not <controller|hook>:<seed>:<class>`)
// `--allow-removal <manifest.json>`: tests the parent ruled out (see removalManifest in bless-rules.ts). A removed test that is a killer refuses the whole bless.
const removalPath = args.includes("--allow-removal") ? option("--allow-removal") ?? "" : undefined
const removalText = removalPath === undefined ? undefined : existsSync(path.resolve(removalPath)) ? readFileSync(path.resolve(removalPath), "utf8") : fail(`--allow-removal ${removalPath} names no file`)
const removals = removalText === undefined ? undefined : removalManifest.safeParse(JSON.parse(removalText))
if (removals && !removals.success) fail(`--allow-removal ${removalPath} is not { ruling, removed: [{ file, test }] }`)
const removed = removals?.success ? removals.data.removed : []
const killed = removals?.success ? killedRemovals(removals.data, expectationsSchema.parse(JSON.parse(readFileSync(expectationsFile, "utf8")))) : []
if (killed.length > 0) fail(`a killer may not be removed: ${killed.join("; ")}`, killed)
if (removals?.success && !existsSync(path.join(repoRoot, removals.data.ruling))) fail(`the ruling ${removals.data.ruling} does not exist`)
// The expectations with seed-records.json beside them under `seedRecords`, so seed records are observed, diffed and refused like any other field.
const seedBaseline = z.json().parse(JSON.parse(readFileSync(seedRecordsFile, "utf8")))
const baselineText = readFileSync(expectationsFile, "utf8")
const baselineSha256 = sha256(baselineText)
const baseline = { ...z.record(z.string(), z.json()).parse(JSON.parse(baselineText)), [seedRecordsKey]: seedBaseline }
const revertedFiles = reverts.map((entry) => ({ ...entry, entrySha256: sha256(readFileSync(entry.entryCopy)), liveSha256: sha256(readFileSync(path.join(repoRoot, entry.file))) }))
const specFile = path.join(out, "revert-overlay.json")
writeFileSync(specFile, `${JSON.stringify({ id: `revert-${name}`, changes: revertedFiles.map((entry) => ({ file: entry.file, contentsFile: entry.entryCopy })) }, null, 1)}\n`)

const scope = scopeOf(args)
const currentHash = (file: string) => existsSync(path.join(repoRoot, file)) ? sha256(readFileSync(path.join(repoRoot, file))) : null
const git = (...gitArgs: string[]) => spawnSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" }).stdout
const wanted = (reverting: boolean): Provenance => ({
  scope, head: git("rev-parse", "HEAD").trim(), gitStatusSha256: sha256(git("status", "--porcelain=v1", "--untracked-files=all")),
  expectationsSha256: sha256(readFileSync(expectationsFile)), overlaySha256: reverting ? overlayIdentity(specFile) : null,
})
const pass = (label: "revert" | "live") => {
  const dir = path.join(out, label)
  const measureFile = path.join(out, `${label}-measure.json`)
  const started = performance.now()
  // --reuse: a run already measured in --out (a refused diff does not make the measurement wrong) stands if its provenance is this
  // scope, overlay, source snapshot and expectations; the checks below are the same as for a fresh run.
  const reused = args.includes("--reuse") && existsSync(measureFile)
  if (!reused) rmSync(measureFile, { force: true })
  const child = reused ? undefined : spawnSync(process.execPath, [path.join(import.meta.dir, "fast-cert.ts"), ...scope, "--out", dir, "--measure", measureFile,
    ...(label === "revert" ? ["--overlay", specFile] : [])], { cwd: repoRoot, stdio: "inherit" })
  const measured = measurement.safeParse(existsSync(measureFile) ? JSON.parse(readFileSync(measureFile, "utf8")) : undefined)
  if (!measured.success) return fail(`the ${label} run wrote no valid measurement (exit ${child?.status})`)
  const result = runResult.safeParse(existsSync(path.join(dir, "result.json")) ? JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) : undefined)
  if (!result.success) return fail(`the ${label} run wrote no result.json`)
  const problems = [...unfinished(label, child?.status, measured.data, result.data), ...provenanceProblems(label, measured.data, wanted(label === "revert"), label === "revert", currentHash)]
  if (problems.length > 0) return fail(problems.join("; "), problems)
  return { dir, seconds: reused ? result.data.wallSeconds : (performance.now() - started) / 1000, resultSha256: sha256(readFileSync(path.join(dir, "result.json"))), ...measured.data }
}
const observations = (run: ReturnType<typeof pass>) => run.jobs.flatMap((job) => job.observed.map((entry) => ({ ...entry, job: job.id, reaches: job.reaches })))

const reverted = blessing ? undefined : pass("revert")
if (reverted) {
  const mismatched = observations(reverted).filter((entry) => !sameJson(getAt(baseline, entry.path), entry.value))
  if (mismatched.length > 0) {
    console.error(mismatched.slice(0, 30).map((entry) => `  ${entry.job}: ${entry.path.join(" / ")}`).join("\n"))
    fail(`the reverted run differs from the expectations in ${mismatched.length} fields (first: ${mismatched[0]?.job}); the revert does not reproduce the entry state`,
      mismatched.map((entry) => ({ job: entry.job, path: entry.path, expected: getAt(baseline, entry.path) ?? null, measured: entry.value })))
  }
}
const live = pass("live")

const arms = getAt(baseline, ["mutations", "arms"])
const changes: Rebase["changes"] = []
const seedRecordChanges: Rebase["changes"] = []
const refused: { job: string; path: string[]; reasons: string[] }[] = []
const liveObserved = observations(live)
if (reverted) {
  const liveJobs = new Set(live.jobs.map((job) => job.id))
  const revertedJobs = new Set(reverted.jobs.map((job) => job.id))
  const apart = [...liveJobs].filter((id) => !revertedJobs.has(id)).concat([...revertedJobs].filter((id) => !liveJobs.has(id)))
  if (apart.length > 0) fail(`the reverted and live runs ran different jobs: ${apart.slice(0, 10).join(", ")}`)
  const lonely = unpaired(liveObserved, observations(reverted))
  if (lonely.length > 0) fail(`${lonely.length} live observations have no reverted observation, so nothing reproduced them: ${lonely.slice(0, 5).join(" | ")}`, lonely)
}
// The argv of the gate or arm an observed path belongs to (its judge or expect sits one level below).
const commandArgv = (observed: string[]) => z.array(z.string()).safeParse(getAt(baseline, [...observed.slice(0, -1), "command", "argv"])).data ?? []
for (const entry of liveObserved) {
  const old = getAt(baseline, entry.path)
  const moved = diffJson(old, entry.value, entry.path)
  if (moved.length === 0) continue
  const seedRecord = entry.path[0] === seedRecordsKey
  const reasons = [
    ...(old === undefined ? ["the expectations hold no such field"] : []),
    ...(reverted && !entry.reaches ? ["the overlay cannot reach this job, so its change is not attributed by the revert"] : []),
    ...(seedRecord ? seedRecordProblems(old, entry.value, allowRise, rejectionNamesFor(entry.path)) : weakened(entry.path, old, entry.value, z.string().safeParse(getAt(arms, [entry.path[2] ?? "", "role"])).data, removableBy(commandArgv(entry.path), removed))),
  ]
  if (reasons.length > 0) refused.push({ job: entry.job, path: entry.path, reasons })
  // A seed record's changes are paths into seed-records.json, so they leave the `seedRecords` segment behind.
  if (seedRecord) seedRecordChanges.push(...moved.map((change) => ({ ...change, path: change.path.slice(1) })))
  else changes.push(...moved)
}
if (refused.length > 0) {
  console.error(refused.slice(0, 30).map((entry) => `  ${entry.job}: ${entry.reasons.join("; ")}`).join("\n"))
  fail(`${refused.length} measurements may not be recorded`, refused)
}

// Watched hashes: a rebase may move only its reverted files, each from the base its entry copy holds. A bless moves every watched
// file that differs, but only on --full: a hash is a claim about every job that reads the file, and a narrower run has not measured them.
const baseHash = (file: string) => [["manifest", "entries", file], ["fuzzSources", "controller", file], ["fuzzSources", "hook", file]]
  .flatMap((at) => z.string().safeParse(getAt(baseline, at)).data ?? []).at(0)
const drifted = Object.entries(live.hashes).filter(([file, hash]) => baseHash(file) !== undefined && baseHash(file) !== hash).map(([file]) => file)
if (blessing && drifted.length > 0 && !args.includes("--full"))
  fail(`watched files differ from the expectations (${drifted.slice(0, 5).join(", ")}${drifted.length > 5 ? " …" : ""}); a bless moves their hashes only on --full`)
const stray = blessing ? [] : drifted.filter((file) => !reverts.some((entry) => entry.file === file))
if (stray.length > 0) fail(`watched files changed that are not reverted: ${stray.join(", ")}`)
const unfit = revertedFiles.filter((entry) => baseHash(entry.file) !== undefined && baseHash(entry.file) !== entry.entrySha256)
if (unfit.length > 0) fail(`entry copies are not the bytes the expectations hold: ${unfit.map((entry) => entry.file).join(", ")}`)
const watched = drifted.map((file) => ({ file, from: baseHash(file) ?? "", to: live.hashes[file] ?? "" }))

const rebase: Rebase = {
  name, sequence: (existsSync(rebasesDir) ? readdirSync(rebasesDir).filter((file) => file.endsWith(".json")).length : 0) + 1, createdAt: new Date().toISOString(),
  revert: revertedFiles, watched, changes, seedRecordChanges,
  evidence: {
    mode: blessing ? "bless" : "rebase",
    // A rejection moved only because the parent ruled it legitimate; the record cites that ruling.
    allowedRejections: allowRejection.map(({ spec }) => spec),
    rejectionRuling: allowRejection.length > 0 ? "acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-SEED-274.md" : null,
    allowedRemovals: removals?.success && removalPath !== undefined ? { manifest: path.relative(repoRoot, path.resolve(removalPath)), manifestSha256: sha256(removalText ?? ""), ruling: removals.data.ruling, tests: removed.length } : null,
    scope: scope.join(" ") || "default",
    provenance: live.provenance,
    expectationsSha256: baselineSha256,
    revertRun: reverted ? { dir: reverted.dir, resultSha256: reverted.resultSha256, seconds: reverted.seconds, observationsEqualToExpectations: observations(reverted).length } : null,
    liveRun: { dir: live.dir, resultSha256: live.resultSha256, seconds: live.seconds, observations: liveObserved.length },
    unreachedByOverlay: reverted ? live.jobs.filter((job) => !job.reaches).map((job) => job.id) : [],
  },
}
mkdirSync(rebasesDir, { recursive: true })
const file = path.join(rebasesDir, `${name}.json`)
if (existsSync(file)) fail(`${file} exists; a rebase is never overwritten`)
// expectations.json is the base: it is moved by applying each record to it in turn, never rebuilt. The record was measured against
// the bytes this run read, so a file that has changed since is a stale base.
const onDisk = readFileSync(expectationsFile, "utf8")
if (sha256(onDisk) !== baselineSha256) fail(`${expectationsFile} changed while the run was measuring; the rebase was measured against ${baselineSha256}, the file is ${sha256(onDisk)}`)
const rebuilt = z.json().parse(expectationsSchema.parse(applyRebase(z.json().parse(JSON.parse(onDisk)), rebase)))
const missing = changes.filter((change) => !sameJson(getAt(rebuilt, change.path), change.new))
if (missing.length > 0) fail(`${missing.length} recorded changes are not in the rebased expectations`)
const rebasedSeedRecords = seedRecordChanges.length > 0 ? formatSeedRecords(seedRecords.parse(applyChanges(seedBaseline, seedRecordChanges, `rebase ${name}`))) : undefined
writeFileSync(file, `${JSON.stringify(rebase, null, 1)}\n`)
writeFileSync(expectationsFile, `${JSON.stringify(rebuilt, null, 1)}\n`)
if (rebasedSeedRecords !== undefined) writeFileSync(seedRecordsFile, rebasedSeedRecords)
for (const change of [...changes.slice(0, 200), ...seedRecordChanges.map((entry) => ({ ...entry, path: [seedRecordsKey, ...entry.path] }))]) console.log(`  ${change.path.join(" / ")}: ${JSON.stringify(change.old)} -> ${JSON.stringify(change.new)}`.slice(0, 300))
console.log(`${blessing ? "BLESS" : "REBASE"} ${name}: ${changes.length} fields moved, ${seedRecordChanges.length} seed record fields moved, ${watched.length} watched hashes, ${reverted ? `revert ${reverted.seconds.toFixed(0)} s, ` : ""}live ${live.seconds.toFixed(0)} s, ${file}`)
process.exit(0)
