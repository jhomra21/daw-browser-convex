#!/usr/bin/env bun
import { writePrivateArtifact, abandonedRunDirectories, cleanupOwnedRunDirectory, type ProcessIdentity } from "./electron"
import path from "node:path"
import { z } from "zod"

const processRows = async (): Promise<ProcessIdentity[]> => {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,command="], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(child.stdout).text()
  if (await child.exited !== 0) throw new Error("Could not inspect benchmark processes.")
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      command: match[4] ?? "",
    }] : []
  })
}

const main = async () => {
  const mode = z.enum(["--preview", "--apply"]).parse(Bun.argv[2] ?? "--preview")
  const reportPath = Bun.argv[3]
  if (reportPath && !path.isAbsolute(reportPath)) {
    throw new Error("Cleanup report path must be absolute.")
  }
  const temporaryRoot = "/private/tmp"
  const processes = await processRows()
  const candidates = await abandonedRunDirectories(temporaryRoot, processes)
  const results = mode === "--apply"
    ? await Promise.all(candidates.map(async (candidate) => (
      candidate.active
        ? { directory: candidate.path, profile: candidate.profile, removed: false, bytesRemoved: 0,
          error: "Runner profile is still in use." }
        : cleanupOwnedRunDirectory(candidate.path, processes)
    )))
    : []
  const report = {
    version: 1,
    mode,
    temporaryRoot,
    timezone: "America/Chicago",
    retention: "Keep today's runner profiles; recover only inactive profiles created before today's Chicago midnight.",
    candidates,
    results,
    bytesEligible: candidates.filter((candidate) => !candidate.active)
      .reduce((total, candidate) => total + candidate.bytes, 0),
    bytesRemoved: results.reduce((total, result) => total + result.bytesRemoved, 0),
  }
  if (reportPath) await writePrivateArtifact(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (results.some((result) => result.error && result.error !== "Runner profile is still in use.")) {
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
