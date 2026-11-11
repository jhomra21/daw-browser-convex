import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import {
  canonicalJsonSha256, failedTests, fuzzFailures, leafName, lintSignature, oracleFailures, perFileCounts, repoRoot, sha256, testCounts, tscDiagnostics,
  type Arm, type Judge,
} from "./expectations"

// What a run measured, in the shape of the expectation it is judged against. The judges in fast-cert.ts say whether a run
// matches; these say what it produced, so a bless can record exactly the fields a change moved.
// A measurement is evidence the run produced. Where the evidence is absent (no seed summary, no oracle message, no artifact) the
// measurement throws: the job fails as a runner error and the bless refuses. It never falls back to the recorded value.
export type Measured = { exit: number | null; text: string; log: string }
const occurrences = (text: string, needle: string) => text.split(needle).length - 1
const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`measurement incomplete: ${what}`)
  return value
}
const liveSha = (file: string) => existsSync(path.join(repoRoot, file)) ? sha256(readFileSync(path.join(repoRoot, file))) : undefined
const leaves = (text: string) => failedTests(text).map(leafName).sort()

// The flags that say where and how a run was started, not what it ran: the scope a measurement is bound to (B4).
const runFlags = new Set(["--out", "--measure", "--overlay", "--rebase", "--bless", "--revert"])
export const scopeOf = (argv: string[]) => argv.filter((value, index) => !runFlags.has(value) && !runFlags.has(argv[index - 1] ?? "") && value !== "--reuse")

// An overlay's identity is its edits, with each replacement file by content: the same spec over other entry copies is another overlay.
const overlaySpec = z.object({ changes: z.array(z.object({ file: z.string(), from: z.string().optional(), to: z.string().optional(), contentsFile: z.string().optional() })) })
export const overlayIdentity = (specFile: string) => sha256(JSON.stringify(overlaySpec.parse(JSON.parse(readFileSync(specFile, "utf8"))).changes
  .map((change) => [change.file, change.from ?? null, change.to ?? null, change.contentsFile ? sha256(readFileSync(change.contentsFile)) : null])))

export const measureGate = (judge: Judge, run: Measured, dir: string): Judge => {
  const exit = run.exit ?? -1
  const text = run.text
  if (judge.kind === "tests") {
    const appended = occurrences(text, "DV01-B6F-PROBE-APPENDED")
    const counts = testCounts(text)
    need(counts.pass + counts.skip + counts.fail > 0 ? counts : undefined, "no tests ran")
    return { kind: "tests", exit, counts, fails: leaves(text), appended: appended > 0 ? appended : null }
  }
  if (judge.kind === "lint") return { kind: "lint", exit, found: need(/^Found .*$/m.exec(text)?.[0], "oxlint summary line"), signature: lintSignature(text) }
  if (judge.kind === "tsc") return { kind: "tsc", exit, diagnostics: tscDiagnostics(text) }
  if (judge.kind === "selftest") return { kind: "selftest", exit, rejected: occurrences(text, '"rejected": true') }
  if (judge.kind === "ctest") return { kind: "ctest", exit, total: Number(need(/^100% tests passed out of (\d+)$/m.exec(text)?.[1], "ctest summary line")) }
  if (judge.kind === "engine") {
    const files = perFileCounts(text)
    need(files.size > 0 ? files : undefined, "no engine test file ran")
    return { kind: "engine", exit, files: Object.fromEntries(files) }
  }
  if (judge.kind === "stdout")
    return { kind: "stdout", exit, value: text.trim().split("\n").at(-1) ?? "", files: Object.fromEntries(Object.keys(judge.files).map((file) => [file, need(liveSha(file), `${file} is missing`)])) }
  const out = path.join(dir, "out")
  const hash = (file: string) => need(existsSync(path.join(out, file)) ? sha256(readFileSync(path.join(out, file))) : undefined, `${file} was not written`)
  const canonical = (file: string) => need(existsSync(path.join(out, file)) ? canonicalJsonSha256(readFileSync(path.join(out, file), "utf8"), out, true) : undefined, `${file} was not written`)
  if (judge.kind === "dp") return { kind: "dp", exit, files: Object.fromEntries(Object.keys(judge.files).map((file) => [file, hash(file)])) }
  if (judge.kind === "campaign")
    return { kind: "campaign", exit, logSha256: sha256(readFileSync(run.log)), gateSha256: canonical("gate.json"), summarySha256: canonical("summary.json") }
  return { kind: judge.kind, exit }
}

export const measureArm = (arm: Arm, run: Measured, dir: string, rejection: [number, number][] | null): Arm["expect"] => {
  const expect = arm.expect
  const text = run.text
  const summary = expect.fuzz ? path.join(dir, "out", `seed-${expect.fuzz.seed}`, "summary.json") : ""
  return {
    exit: run.exit ?? -1,
    applied: arm.marker.length > 0 ? occurrences(text, arm.marker) : expect.applied,
    counts: expect.counts === null ? null : testCounts(text),
    fails: expect.fails === null ? null : leaves(text),
    fuzz: expect.fuzz === null ? null : { seed: expect.fuzz.seed, ...fuzzFailures(readFileSync(need(existsSync(summary) ? summary : undefined, `seed ${expect.fuzz.seed} summary`), "utf8")) },
    rejection: expect.rejection === null ? null : need(rejection ?? undefined, "rejection-gate record"),
    tsErrors: expect.tsErrors === null ? null : [...text.matchAll(/error (TS\d+):/g)].map((match) => match[1] ?? ""),
    matches: expect.matches === null ? null : text.split("\n").filter((line) => line.length > 0).length,
    oracle: expect.oracle === null ? null : need(oracleFailures(text).find((entry) => entry.message === expect.oracle?.message), `oracle failure "${expect.oracle.message}"`),
  }
}
