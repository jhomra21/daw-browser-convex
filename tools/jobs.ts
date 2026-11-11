import { spawnSync } from "node:child_process"
import { availableParallelism } from "node:os"

// The one limit for parallel test and build tooling. Ten workers spilled onto the efficiency cores and onto each other's oxlint
// threads (load near 20), so the default is the performance-core count: DAW_JOBS, else `hw.perflevel0.logicalcpu` on macOS, else
// half of availableParallelism. Shell build scripts get it from `bun tools/jobs.ts`.
const positiveInteger = (value: string | undefined) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
const performanceCores = () => positiveInteger(spawnSync("sysctl", ["-n", "hw.perflevel0.logicalcpu"], { encoding: "utf8" }).stdout.trim())

export const jobLimit = () => positiveInteger(process.env.DAW_JOBS) ?? performanceCores() ?? Math.max(1, Math.floor(availableParallelism() / 2))

if (import.meta.main) console.log(jobLimit())
