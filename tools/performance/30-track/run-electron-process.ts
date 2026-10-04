import { readFile } from "node:fs/promises"
import type { ChildProcess } from "node:child_process"
import path from "node:path"
import { $ } from "bun"
import {
  cleanupSurvivors,
  createCleanupPlan,
  descendantsOf,
  electronRendererTarget,
  verifyElectronLaunchIdentity,
  type CleanupPlan,
  type ProcessMetric,
} from "./electron"

type ProcessRow = {
  readonly pid: number
  readonly parentPid: number
  readonly processGroupId: number
  readonly command: string
  readonly cpu: number
  readonly rss: number
}

const processRows = async (): Promise<ProcessRow[]> => {
  const output = await $`ps -axo pid=,ppid=,pgid=,pcpu=,rss=,command=`.text()
  const rows = output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
    if (!match) return []
    const [, pidField, parentPidField, processGroupField, cpuField, rssField, command] = match
    if (!pidField || !parentPidField || !processGroupField || !cpuField || !rssField || !command) return []
    const processPid = Number(pidField)
    const parentPid = Number(parentPidField)
    const processGroupId = Number(processGroupField)
    const cpu = Number(cpuField)
    const rss = Number(rssField)
    return Number.isInteger(processPid) && Number.isInteger(parentPid) && Number.isInteger(processGroupId)
      && Number.isFinite(cpu) && Number.isFinite(rss)
      ? [{ pid: processPid, parentPid, processGroupId, cpu, rss, command }]
      : []
  })
  return rows
}

export const processMetrics = async (pid: number): Promise<ProcessMetric[]> => {
  const rows = await processRows()
  const ownedPids = new Set([pid, ...descendantsOf(rows, pid)])
  return rows.filter((row) => ownedPids.has(row.pid)).map((row) => ({
    pid: row.pid,
    role: row.pid === pid ? "main" : "child",
    cpuPercent: row.cpu,
    rssBytes: row.rss * 1024,
  }))
}

const listenerPids = async (port: number): Promise<number[]> => {
  const process = Bun.spawn(["lsof", "-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-t"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(process.stdout).text()
  const exitCode = await process.exited
  if (exitCode !== 0 && exitCode !== 1) throw new Error("Could not inspect the Electron debugging listener.")
  return output.split(/\s+/).flatMap((field) => {
    const pid = Number(field)
    return Number.isInteger(pid) && pid > 0 ? [pid] : []
  })
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForCleanup = async (plan: CleanupPlan, timeoutMs: number): Promise<number[]> => {
  const deadline = Date.now() + timeoutMs
  let survivors: number[] = []
  do {
    survivors = cleanupSurvivors(plan, await processRows())
    if (survivors.length === 0) return []
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  return survivors
}

export const terminate = async (child: ChildProcess | undefined, establishedPlan: CleanupPlan | undefined) => {
  if (!child?.pid) return
  const rootAlive = processExists(child.pid)
  const plan = rootAlive
    ? createCleanupPlan(await processRows(), child.pid)
    : establishedPlan
  if (!plan) {
    if (!rootAlive) return
    throw new Error("Refusing to terminate an Electron process without runner-owned process-group identity.")
  }
  if (rootAlive) process.kill(-plan.processGroupId, "SIGTERM")
  const survivors = await waitForCleanup(plan, 5_000)
  if (survivors.length > 0) {
    for (const pid of survivors) process.kill(pid, "SIGKILL")
  }
  const finalSurvivors = await waitForCleanup(plan, 2_000)
  if (finalSurvivors.length > 0) {
    throw new Error(`Runner-owned Electron cleanup failed for ${finalSurvivors.length} process(es).`)
  }
}

type CdpEndpoint = {
  readonly websocketUrl: string
}

const assertCdpIdentity = async (
  profile: string,
  rootPid: number,
  executablePath: string,
  port: number,
  websocketUrl: string,
): Promise<void> => {
  const identity = verifyElectronLaunchIdentity({
    rootPid,
    executablePath,
    profilePath: profile,
    port,
    listenerPids: await listenerPids(port),
    processes: await processRows(),
    websocketUrl,
  })
  if (!identity.verified) throw new Error(identity.reason)
}

export const waitForCdp = async (
  profile: string,
  rootPid: number,
  executablePath: string,
): Promise<CdpEndpoint> => {
  let lastError = "CDP did not become available."
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const fields = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
      const port = Number(fields[0])
      const browserPath = fields[1]
      if (!Number.isInteger(port) || port < 1 || port > 65_535 || !browserPath) {
        throw new Error("Electron debugging capability file is invalid.")
      }
      const websocketUrl = `ws://127.0.0.1:${port}${browserPath}`
      await assertCdpIdentity(profile, rootPid, executablePath, port, websocketUrl)
      return { websocketUrl }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error(lastError)
}

export const selectElectronRenderer = async (
  browserCommand: (session: string, args: readonly string[]) => Promise<string>,
  session: string,
  getAppOutput: () => string,
) => {
  let lastError = "Electron renderer target did not become available."
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const tabs = await browserCommand(session, ["tab"])
      const target = electronRendererTarget(tabs)
      if (target) {
        await browserCommand(session, ["tab", target.targetId])
        const url = await browserCommand(session, ["get", "url"])
        if (url !== target.url) throw new Error("Electron renderer identity changed during attachment.")
        return
      }
      lastError = `Electron renderer target not listed: ${tabs}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error(`${lastError}; packaged app output: ${getAppOutput().slice(-4_000)}`)
}
