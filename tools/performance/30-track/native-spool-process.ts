import { rows } from "./v3-import-process"
import { createCleanupPlan, type ProcessIdentity } from "./electron"

// Termination is deliberately separate from profile cleanup: a failed take
// must retain its native source, manifests, receipt and browser asset storage.
export const stopOwnedSpoolProcesses = async (input: {
  directory: string; rootPid: number; executable: string;
  inspect?: () => Promise<ProcessIdentity[]>;
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  wait?: () => Promise<void>;
}) => {
  const inspect = input.inspect ?? rows
  const signal = input.signal ?? ((pid, signal) => process.kill(pid, signal))
  // Bounded OS-exit grace period; no recording/native Finish cancellation timer.
  const wait = input.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1000)))
  const processes = await inspect()
  const owned = processes.find((row) => row.pid === input.rootPid
    && row.command.startsWith(`${input.executable} `)
    && row.command.split(" ").includes(`--user-data-dir=${input.directory}/profile`))
  if (!owned) return !processes.some((row) => row.pid === input.rootPid)
  const plan = createCleanupPlan(processes, input.rootPid)
  if (!plan || plan.processGroupId !== owned.processGroupId || plan.processGroupId === process.pid) return false
  const recorded = new Map(plan.recordedProcesses.map((row) => [row.pid, row]))
  if (processes.some((row) => row.processGroupId === plan.processGroupId && !recorded.has(row.pid))) return false
  signal(-plan.processGroupId, "SIGTERM")
  await wait()
  for (const row of await inspect()) {
    const original = recorded.get(row.pid)
    if (original && row.command === original.command && row.processGroupId === original.processGroupId)
      signal(row.pid, "SIGKILL")
  }
  return !(await inspect()).some((row) => {
    const original = recorded.get(row.pid)
    return original && row.command === original.command && row.processGroupId === original.processGroupId
  })
}
