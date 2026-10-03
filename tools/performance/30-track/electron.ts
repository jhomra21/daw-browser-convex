import { constants } from "node:fs"
import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises"
import path from "node:path"

export type ProcessMetric = {
  readonly pid: number
  readonly role: "main" | "child"
  readonly cpuPercent: number | null
  readonly rssBytes: number | null
}

export type NativeDiagnosticDelta = {
  readonly before: {
    readonly state: string
    readonly sampleRate: number | null
    readonly workletFaultCount: number
    readonly inferredApplicationStallCount: number
    readonly callbacks: number | null
    readonly rejectedBlocks: number | null
  }
  readonly after: {
    readonly state: string
    readonly sampleRate: number | null
    readonly workletFaultCount: number
    readonly inferredApplicationStallCount: number
    readonly callbacks: number | null
    readonly rejectedBlocks: number | null
  }
  readonly callbackIncrease: number | null
  readonly rejectedBlocksIncrease: number | null
}

export type ProcessIdentity = {
  readonly pid: number
  readonly parentPid: number
  readonly processGroupId: number
  readonly command: string
}

export type CleanupPlan = {
  readonly rootPid: number
  readonly processGroupId: number
  readonly recordedProcesses: readonly ProcessIdentity[]
}

type OwnedRunDirectoryCleanup = {
  readonly directory: string
  readonly profile: string
  readonly removed: boolean
  readonly bytesRemoved: number
  readonly error: string | null
}

type AbandonedRunDirectory = {
  readonly path: string
  readonly profile: string
  readonly createdAt: string
  readonly bytes: number
  readonly active: boolean
}

const runDirectoryPattern = /^daw-e-[0-9a-f]{24}$/

type LaunchIdentityInput = {
  readonly rootPid: number
  readonly executablePath: string
  readonly profilePath: string
  readonly port: number
  readonly listenerPids: readonly number[]
  readonly processes: readonly ProcessIdentity[]
  readonly websocketUrl: string
}

type LaunchIdentityResult =
  | { readonly verified: true; readonly processGroupId: number }
  | { readonly verified: false; readonly reason: string }

export const processMetricsAvailability = (
  metrics: readonly ProcessMetric[],
): { readonly available: true } | { readonly available: false; readonly reason: string } => (
  metrics.length > 0
    ? { available: true }
    : { available: false, reason: "runner-owned process metrics unavailable" }
)

const difference = (after: number | null, before: number | null) => (
  after === null || before === null ? null : Math.max(0, after - before)
)

export const createNativeDiagnosticDelta = (before: NativeDiagnosticDelta["before"], after: NativeDiagnosticDelta["after"]): NativeDiagnosticDelta => ({
  before,
  after,
  callbackIncrease: difference(after.callbacks, before.callbacks),
  rejectedBlocksIncrease: difference(after.rejectedBlocks, before.rejectedBlocks),
})

export const nativeCallbacksIncreased = (delta: NativeDiagnosticDelta | null): boolean => (
  delta?.callbackIncrease !== null && delta?.callbackIncrease !== undefined && delta.callbackIncrease > 0
)

export const descendantsOf = (
  processes: readonly { readonly pid: number; readonly parentPid: number }[],
  rootPid: number,
): number[] => {
  const children = new Map<number, number[]>()
  for (const process of processes) {
    const current = children.get(process.parentPid) ?? []
    current.push(process.pid)
    children.set(process.parentPid, current)
  }
  const result: number[] = []
  const pending = [rootPid]
  while (pending.length > 0) {
    const parent = pending.shift()
    if (parent === undefined) continue
    for (const child of children.get(parent) ?? []) {
      result.push(child)
      pending.push(child)
    }
  }
  return result
}

export const createPrivateRunDirectory = async (temporaryRoot: string): Promise<string> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const directory = path.join(temporaryRoot, `daw-e-${randomBytes(12).toString("hex")}`)
    try {
      await mkdir(directory, { mode: 0o700 })
      await chmod(directory, 0o700)
      await writePrivateArtifact(path.join(directory, "runner-owner.json"), JSON.stringify({
        version: 1,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }))
      return directory
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      if (code !== "EEXIST") throw error
    }
  }
  throw new Error("Could not create a private Electron benchmark directory.")
}

const directoryBytes = async (directory: string): Promise<number> => {
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) bytes += await directoryBytes(entryPath)
    else if (entry.isFile()) bytes += (await lstat(entryPath)).size
  }
  return bytes
}

export const cleanupOwnedRunDirectory = async (
  directory: string,
  processes: readonly ProcessIdentity[],
): Promise<OwnedRunDirectoryCleanup> => {
  const profile = path.join(directory, "profile")
  if (!runDirectoryPattern.test(path.basename(directory))) {
    return { directory, profile, removed: false, bytesRemoved: 0, error: "Runner directory name is not owned." }
  }
  if (processes.some((process) => commandContainsArgument(process.command, `--user-data-dir=${profile}`))) {
    return { directory, profile, removed: false, bytesRemoved: 0, error: "Runner profile is still in use." }
  }
  try {
    const bytesRemoved = await directoryBytes(directory)
    await rm(directory, { recursive: true })
    return { directory, profile, removed: true, bytesRemoved, error: null }
  } catch (error) {
    return {
      directory,
      profile,
      removed: false,
      bytesRemoved: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const chicagoStartOfToday = (now = new Date()): Date => {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
  const utcMidnight = new Date(`${date}T00:00:00Z`)
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    timeZoneName: "longOffset",
  }).formatToParts(utcMidnight).find((part) => part.type === "timeZoneName")?.value
  const offset = /^GMT([+-]\d{2}):(\d{2})$/.exec(offsetName ?? "")
  if (!offset) throw new Error("Could not resolve America/Chicago offset.")
  const sign = offset[1].startsWith("-") ? -1 : 1
  const offsetMinutes = sign * (Number(offset[1].slice(1)) * 60 + Number(offset[2]))
  return new Date(utcMidnight.getTime() - offsetMinutes * 60_000)
}

export const abandonedRunDirectories = async (
  temporaryRoot: string,
  processes: readonly ProcessIdentity[],
  now = new Date(),
): Promise<AbandonedRunDirectory[]> => {
  const cutoff = chicagoStartOfToday(now).getTime()
  const entries = await readdir(temporaryRoot, { withFileTypes: true })
  const candidates: AbandonedRunDirectory[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !runDirectoryPattern.test(entry.name)) continue
    const directory = path.join(temporaryRoot, entry.name)
    const profile = path.join(directory, "profile")
    const created = await lstat(directory)
    if (created.birthtimeMs >= cutoff) continue
    candidates.push({
      path: directory,
      profile,
      createdAt: created.birthtime.toISOString(),
      bytes: await directoryBytes(directory),
      active: processes.some((process) => commandContainsArgument(process.command, `--user-data-dir=${profile}`)),
    })
  }
  return candidates.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export const writePrivateArtifact = async (filePath: string, contents: string): Promise<void> => {
  const file = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(contents, "utf8")
    await file.chmod(0o600)
  } finally {
    await file.close()
  }
}
export const desktopDiagnosticsBoundaryLines = (output: string): string[] => (
  output.split(/\r?\n/).flatMap((line) => {
    const marker = line.indexOf("[diagnostics-v2-boundary]")
    if (marker < 0) return []
    const value = line.slice(marker).trim()
    return /^\[diagnostics-v2-boundary\] operation=diagnostics\.snapshot\.v2 stage=[a-z-]+ elapsedMs=\d+$/.test(value) ? [value] : []
  }).slice(-64)
)
export const desktopDiagnosticsValidationLines = (output: string): string[] => (
  output.split(/\r?\n/).flatMap((line) => {
    const marker = line.indexOf("[diagnostics-v2-validation]")
    if (marker < 0) return []
    const value = line.slice(marker).trim()
    return /^\[diagnostics-v2-validation\] paths=(?:result|audio|recording|native|scheduler|counts|workerAutomation|sequence|transportEpoch|renderEpoch|lastRejectedCallback|lastRejectedRenderEpoch|tracks|other)(?:[.,](?:result|audio|recording|native|scheduler|counts|workerAutomation|sequence|transportEpoch|renderEpoch|lastRejectedCallback|lastRejectedRenderEpoch|tracks|other))*$/.test(value) ? [value] : []
  }).slice(-8)
)

const commandContainsArgument = (command: string, argument: string): boolean => (
  command.split(/\s+/).includes(argument)
)

export const verifyElectronLaunchIdentity = (input: LaunchIdentityInput): LaunchIdentityResult => {
  const root = input.processes.find((process) => process.pid === input.rootPid)
  if (!root) return { verified: false, reason: "Electron root process exited before attachment." }
  if (root.processGroupId !== input.rootPid) {
    return { verified: false, reason: "Electron process group is not runner-owned." }
  }
  const executableBasename = path.basename(input.executablePath)
  if (!root.command.startsWith(input.executablePath)
    && !root.command.startsWith(`${executableBasename} `)
    && root.command !== executableBasename) {
    return { verified: false, reason: "Electron root executable identity does not match." }
  }
  if (!commandContainsArgument(root.command, `--user-data-dir=${input.profilePath}`)) {
    return { verified: false, reason: "Electron profile identity does not match." }
  }
  if (!commandContainsArgument(root.command, "--remote-debugging-port=0")
    || !commandContainsArgument(root.command, "--remote-debugging-address=127.0.0.1")) {
    return { verified: false, reason: "Electron debugging endpoint identity does not match." }
  }
  if (input.listenerPids.length === 0) {
    return { verified: false, reason: "Electron debugging endpoint has no listener." }
  }
  const ownedPids = new Set([
    input.rootPid,
    ...descendantsOf(input.processes, input.rootPid),
  ])
  if (input.listenerPids.some((pid) => !ownedPids.has(pid))) {
    return { verified: false, reason: "Electron debugging endpoint is owned by another process." }
  }
  let websocket: URL
  try {
    websocket = new URL(input.websocketUrl)
  } catch {
    return { verified: false, reason: "Electron debugging endpoint returned an invalid browser target." }
  }
  if (websocket.protocol !== "ws:" || websocket.hostname !== "127.0.0.1"
    || websocket.port !== String(input.port)
    || !/^\/devtools\/browser\/[a-zA-Z0-9-]{32,}$/.test(websocket.pathname)) {
    return { verified: false, reason: "Electron browser target capability is invalid." }
  }
  return { verified: true, processGroupId: root.processGroupId }
}

export const electronRendererTarget = (
  tabs: string,
): { readonly targetId: string; readonly url: string } | undefined => {
  const targets = [...tabs.matchAll(/\[(t[0-9]+)\][^\n]*\s(daw:\/\/app\/[^\s]*)/g)]
  if (targets.length !== 1 || !/^daw:\/\/app\/(?:\?dashboard=general)?$/.test(targets[0]?.[2] ?? "")) return undefined
  const targetId = targets[0]?.[1]
  return targetId ? { targetId, url: targets[0]![2]! } : undefined
}

export const createCleanupPlan = (
  processes: readonly ProcessIdentity[],
  rootPid: number,
): CleanupPlan | undefined => {
  const root = processes.find((process) => process.pid === rootPid)
  if (!root || root.processGroupId !== rootPid) return undefined
  const ownedPids = new Set([rootPid, ...descendantsOf(processes, rootPid)])
  return {
    rootPid,
    processGroupId: root.processGroupId,
    recordedProcesses: processes.filter((process) => ownedPids.has(process.pid)),
  }
}

export const cleanupSurvivors = (
  plan: CleanupPlan,
  processes: readonly ProcessIdentity[],
): number[] => {
  const recordedProcesses = new Map(plan.recordedProcesses.map((process) => [process.pid, process]))
  return processes
    .filter((process) => {
      const recorded = recordedProcesses.get(process.pid)
      return recorded !== undefined
        && process.command === recorded.command
    })
    .map((process) => process.pid)
}
