import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { repoRoot } from "./expectations"

// Self-test: a probe appended to a reverted file must compose with the revert. x-matrix and x-probe160 append their probe to
// useTimelinePlayback.test.ts; under a revert of that file they must still run the probe tests (exit 0, append marker in the log), not
// report "no tests ran". Usage: bun tools/certification/selftest-revert-append.ts [--jobs N]
const file = "src/hooks/useTimelinePlayback.test.ts"
const jobs = ["gate:x-matrix", "gate:x-probe160"]
const out = path.join("/tmp/fast-cert", `selftest-revert-append-${new Date().toISOString().replaceAll(":", "-")}`)
mkdirSync(out, { recursive: true })
const entryCopy = path.join(out, "entry-copy.test.ts")
writeFileSync(entryCopy, spawnSync("git", ["show", `HEAD:${file}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 }).stdout)
const spec = path.join(out, "revert-overlay.json")
writeFileSync(spec, JSON.stringify({ id: "selftest-revert-append", changes: [{ file, contentsFile: entryCopy }] }))
const run = spawnSync("bun", [path.join(import.meta.dir, "fast-cert.ts"), "--only", jobs.join(","), "--overlay", spec, "--out", path.join(out, "run"), ...process.argv.slice(2)],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 })
// The jobs' judges already fail a run whose log lacks the append marker, or whose probe tests did not run.
const problems = run.status === 0 ? [] : [`fast-cert exit ${run.status}`]
console.log(run.stdout.split("\n").slice(-12).join("\n"))
console.log(problems.length === 0 ? `SELFTEST PASS (${out})` : `SELFTEST FAIL: ${problems.join("; ")} (${out})`)
process.exit(problems.length === 0 ? 0 : 1)
