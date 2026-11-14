import { spawnSync } from "node:child_process"
import { availableParallelism } from "node:os"

// The one limit for parallel test and build tooling. Ten workers spilled onto the efficiency cores and onto each other's oxlint
// threads (load near 20), so the default leaves one performance core free: DAW_JOBS, else `hw.perflevel0.logicalcpu` minus 1 on macOS,
// else half of availableParallelism minus 1, never below 1. Shell build scripts get it from `bun tools/jobs.ts`.
const positiveInteger = (value: string | undefined) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
const performanceCores = () => positiveInteger(spawnSync("sysctl", ["-n", "hw.perflevel0.logicalcpu"], { encoding: "utf8" }).stdout.trim())

export const jobLimit = () => positiveInteger(process.env.DAW_JOBS) ?? Math.max(1, (performanceCores() ?? Math.floor(availableParallelism() / 2)) - 1)

if (import.meta.main) console.log(jobLimit())
