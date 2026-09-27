#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { browserCommand, waitForBrowserValue } from "../browser-harness"
import { cleanupSurvivors, createCleanupPlan, createPrivateRunDirectory, electronRendererTarget, verifyElectronLaunchIdentity, writePrivateArtifact, type CleanupPlan, type ProcessIdentity } from "./electron"
import { desktopDiagnosticsSchemaV2, desktopHostStatusSchemaV1 } from "@daw-browser/desktop-protocol"
import { projectSnapshotSchemaV2, type ProjectSnapshotV2 } from "@daw-browser/control"
import { z } from "zod"

type Recording = { capturedFrames: number | null; activeSampleRate: number | null; droppedFrames: number; overrunFrames: number; lastFailurePresent: boolean }
type Clip = { id: string; trackId: string; duration: number; source?: { sourceKind: string } }
type Timing = { append: { count: number; startDelayMs: { total: number; max: number }; durationMs: { total: number; max: number } }; storage: { headerWriteMs: { count: number; total: number; max: number }; channelWriteMs: { count: number; total: number; max: number } } | null }
export const recordingTimingResult = (recording: { writerTiming?: Timing | null }): Timing | null => recording.writerTiming ?? null

export const assessRecording = (before: Recording, after: Recording, earlyActive: boolean, lateActive: boolean, elapsedMs: number): string | null => {
  if (!earlyActive || !lateActive) return "recording ended before explicit stop"
  if (elapsedMs < 15_000) return "recording interval shorter than 15 seconds"
  if (after.capturedFrames === null || after.capturedFrames <= (before.capturedFrames ?? 0)) return "captured frames did not increase"
  if (!after.activeSampleRate || after.droppedFrames !== 0 || after.overrunFrames !== 0 || after.lastFailurePresent) return "recording diagnostics reported a failure"
  return null
}

export const recordedAudioClip = (before: readonly Clip[], after: readonly Clip[], trackId: string): string => {
  const existing = new Set(before.map((clip) => clip.id))
  const clips = after.filter((clip) => !existing.has(clip.id) && clip.trackId === trackId && clip.source?.sourceKind === "recording" && clip.duration > 0)
  if (clips.length !== 1 || !clips[0]) throw new Error("Exactly one new persisted audio recording clip was not found.")
  return clips[0].id
}

export const verifyReopenedRecording = (
  before: Pick<ProjectSnapshotV2, "clips" | "assets">,
  after: Pick<ProjectSnapshotV2, "clips" | "assets">,
  clipId: string,
): void => {
  const clip = before.clips.find((item) => item.id === clipId)
  const reopened = after.clips.find((item) => item.id === clipId)
  const asset = before.assets.find((item) => item.id === clip?.source?.assetId)
  const restoredAsset = after.assets.find((item) => item.id === asset?.id)
  if (!clip || clip.source?.sourceKind !== "recording" || !asset || asset.sourceKind !== "recording"
    || !asset.sizeBytes || !asset.contentSha256 || !reopened || !restoredAsset
    || JSON.stringify(reopened) !== JSON.stringify(clip)
    || JSON.stringify(restoredAsset) !== JSON.stringify(asset)) {
    throw new Error("Recorded clip or recording asset missing or changed after cold relaunch.")
  }
}

export const rendererAttachmentState = (tabs: string): { kind: "waiting" } | { kind: "ready"; targetId: string } => {
  const target = electronRendererTarget(tabs)
  return target ? { kind: "ready", targetId: target.targetId } : { kind: "waiting" }
}

const rows = async (): Promise<ProcessIdentity[]> => {
  const process = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,command="], { stdout: "pipe" })
  const text = await new Response(process.stdout).text()
  if (await process.exited !== 0) throw new Error("Process identity inspection failed.")
  return text.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), processGroupId: Number(match[3]), command: match[4]! }] : []
  })
}

const command = async (root: string, profile: string, args: string[]) => {
  const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") },
    stdout: "pipe", stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (await child.exited !== 0) throw new Error(`Control command failed: ${err.slice(0, 300)}`)
  return JSON.parse(out)
}
const data = <T>(schema: z.ZodType<T>, response: ReturnType<typeof JSON.parse>): T =>
  schema.parse(z.object({ data: z.json() }).parse(response).data)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const main = async () => {
  const out = Bun.argv[2]
  if (!out || !path.isAbsolute(out) || Bun.argv.length !== 3) throw new Error("Usage: bun recording-isolation.ts <absolute-private-result-path>")
  const root = path.resolve(import.meta.dir, "../../..")
  const executable = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/MacOS/@daw-browser-desktop")
  await stat(path.join(path.dirname(path.dirname(executable)), "Resources/app.asar"))
  const directory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(directory, "profile")
  // The shared browser harness must use its Electron attachment path, not its
  // standalone Playwright executable fallback for browser benchmarks.
  let session = ""
  let stage = "launch"
  let app: ReturnType<typeof spawn> | undefined
  let plan: CleanupPlan | undefined
  let attached = false
  let failure = false
  let appOutput = ""
  const launch = async (): Promise<{ session: string; app: ReturnType<typeof spawn>; plan: CleanupPlan }> => {
    const instance = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
      cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile }, stdio: ["ignore", "pipe", "pipe"], detached: true,
    })
    instance.stdout?.on("data", (chunk: Buffer) => { appOutput = (appOutput + chunk.toString()).slice(-2_000) })
    instance.stderr?.on("data", (chunk: Buffer) => { appOutput = (appOutput + chunk.toString()).slice(-2_000) })
    if (!instance.pid) throw new Error("Packaged launch returned no PID.")
    app = instance
    let endpoint: string | undefined
    let ownership: CleanupPlan | undefined
    for (let i = 0; i < 30 && !endpoint; i++) {
      try {
        const [portText, browserPath] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
        const port = Number(portText)
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath) throw new Error("Invalid CDP capability.")
        const listener = Bun.spawn(["lsof", "-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe" })
        const listenerPids = (await new Response(listener.stdout).text()).trim().split(/\s+/).map(Number)
        const url = `ws://127.0.0.1:${port}${browserPath}`
        const processes = await rows()
        const identity = verifyElectronLaunchIdentity({ rootPid: instance.pid, executablePath: executable, profilePath: profile, port, listenerPids, processes, websocketUrl: url })
        if (!identity.verified) throw new Error(identity.reason)
        ownership = createCleanupPlan(processes, instance.pid)
        if (!ownership) throw new Error("Runner process ownership unavailable.")
        endpoint = url
      } catch { await delay(1_000) }
    }
    if (!endpoint || !ownership) throw new Error("Owned Electron CDP endpoint unavailable.")
    plan = ownership
    const currentSession = `daw-30-track-electron-recording-${crypto.randomUUID()}`
    await browserCommand(currentSession, ["connect", endpoint])
    attached = true
    let target: string | undefined
    for (let i = 0; i < 30 && !target; i++) {
      const state = rendererAttachmentState(await browserCommand(currentSession, ["tab"]))
      if (state.kind === "ready") target = state.targetId
      if (!target) await delay(1_000)
    }
    if (!target) throw new Error("Packaged renderer unavailable.")
    await browserCommand(currentSession, ["tab", target])
    if (await browserCommand(currentSession, ["get", "url"]) !== "daw://app/") throw new Error("Renderer identity mismatch.")
    return { session: currentSession, app: instance, plan: ownership }
  }
  const stop = async () => {
    if (attached) {
      await browserCommand(session, ["close"]).catch(() => undefined)
      attached = false
    }
    if (!app?.pid || !plan) throw new Error("Cannot stop Electron without verified ownership.")
    const owned = (await rows()).find((row) => row.pid === app?.pid && row.processGroupId === plan?.processGroupId
      && row.command.includes(executable) && row.command.includes(`--user-data-dir=${profile}`))
    if (!owned || plan.processGroupId === process.pid) throw new Error("Refusing cleanup without verified runner-owned process group.")
    process.kill(-plan.processGroupId, "SIGTERM")
    for (let i = 0; i < 20 && (await rows()).some((row) => row.pid === app?.pid && row.command === owned.command); i++) await delay(250)
    for (const pid of cleanupSurvivors(plan, await rows())) process.kill(pid, "SIGKILL")
    if ((await rows()).some((row) => row.pid === app?.pid && row.command === owned.command)) throw new Error("Electron root survived shutdown.")
    app = undefined
    plan = undefined
  }
  try {
    await mkdir(profile, { mode: 0o700 })
    stage = "attach"
    session = (await launch()).session
    stage = "create-project"
    const host = data(desktopHostStatusSchemaV1, await command(root, profile, ["host", "status"]))
    if (!host.ready) throw new Error("Desktop host not ready.")
    await waitForBrowserValue(session, "[...document.querySelectorAll('button')].some((button)=>button.textContent?.trim()==='New project') ? true : null", 30_000)
    await browserCommand(session, ["eval", "(()=>{const button=[...document.querySelectorAll('button')].find((element)=>element.textContent?.trim()==='New project');if(!(button instanceof HTMLButtonElement))throw new Error('New project unavailable');button.click();return true})()"])
    await waitForBrowserValue(session, "location.search.includes('projectId=') && document.querySelector('[data-timeline-ruler=\"1\"]') ? true : null", 60_000)
    const projectId = new URL(await browserCommand(session, ["get", "url"])).searchParams.get("projectId")
    if (!projectId) throw new Error("Local project ID missing.")
    const snapshot = () => command(root, profile, ["snapshot-v2", projectId, "--target", "host"]).then((value) => data(projectSnapshotSchemaV2, value))
    stage = "arm"
    const initial = await snapshot()
    const audio = initial.tracks.filter((track) => track.kind === "audio")
    if (audio.length !== 1 || !audio[0]) throw new Error("Starter project does not have exactly one audio track.")
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Arm track 1 for recording"])
    const before = data(desktopDiagnosticsSchemaV2, await command(root, profile, ["host", "diagnostics-v2"]))
    stage = "record"
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Start recording"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Stop recording\"]') ? true : null", 10_000)
    const started = performance.now()
    await delay(5_000)
    const earlyActive = (await browserCommand(session, ["eval", "document.querySelector('button[aria-label=\"Stop recording\"]') !== null"])).trim() === "true"
    const early = data(desktopDiagnosticsSchemaV2, await command(root, profile, ["host", "diagnostics-v2"]))
    await delay(Math.max(0, 15_000 - (performance.now() - started)))
    const lateActive = (await browserCommand(session, ["eval", "document.querySelector('button[aria-label=\"Stop recording\"]') !== null"])).trim() === "true"
    const during = data(desktopDiagnosticsSchemaV2, await command(root, profile, ["host", "diagnostics-v2"]))
    const elapsedMs = performance.now() - started
    const issue = assessRecording(before.recording, during.recording, earlyActive, lateActive, elapsedMs)
    if (issue || (early.recording.capturedFrames ?? 0) <= (before.recording.capturedFrames ?? 0) || (during.recording.capturedFrames ?? 0) <= (early.recording.capturedFrames ?? 0)) {
      throw new Error(issue ?? "Captured frames did not grow across both observations.")
    }
    stage = "stop"
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop recording"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Start recording\"]') ? true : null", 30_000)
    const clipId = recordedAudioClip(initial.clips, (await snapshot()).clips, audio[0].id)
    const completed = data(desktopDiagnosticsSchemaV2, await command(root, profile, ["host", "diagnostics-v2"]))
    const persisted = await snapshot()
    stage = "cold-relaunch"
    await stop()
    // A previous browser capability cannot establish the identity of a new process.
    await rm(path.join(profile, "DevToolsActivePort"), { force: true })
    session = (await launch()).session
    const reopenedHost = data(desktopHostStatusSchemaV1, await command(root, profile, ["host", "status"]))
    if (!reopenedHost.ready) throw new Error("Reopened desktop host not ready.")
    await waitForBrowserValue(session, "[...document.querySelectorAll('button')].some((button)=>button.textContent?.trim()==='New project') ? true : null", 30_000)
    await browserCommand(session, ["eval", `(()=>{const button=[...document.querySelectorAll('article button')].find((element)=>element.textContent?.trim().startsWith('Untitled'));if(!(button instanceof HTMLButtonElement))throw new Error('Recorded project unavailable in dashboard');button.click();return true})()`])
    await waitForBrowserValue(session, `new URL(location.href).searchParams.get('projectId') === ${JSON.stringify(projectId)} && document.querySelector('[data-timeline-ruler="1"]') ? true : null`, 60_000)
    const reopened = await snapshot()
    verifyReopenedRecording(persisted, reopened, clipId)
    const beforePlayback = data(desktopDiagnosticsSchemaV2, await command(root, profile, ["host", "diagnostics-v2"]))
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Pause\"]') ? true : null", 10_000)
    await delay(2_000)
    const afterPlayback = data(desktopDiagnosticsSchemaV2, await command(root, profile, ["host", "diagnostics-v2"]))
    if (afterPlayback.native.status !== "available"
      || afterPlayback.native.diagnostics.callbacks <= (beforePlayback.native.status === "available"
        ? beforePlayback.native.diagnostics.callbacks : 0)
      || afterPlayback.native.diagnostics.rejectedBlocks !== 0) {
      throw new Error("Cold-reopened recording did not play through the native host.")
    }
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop"])
    await mkdir(path.dirname(out), { recursive: true, mode: 0o700 })
    await writePrivateArtifact(out, JSON.stringify({
      status: "complete", projectId, clipId, elapsedMs,
      frames: [before.recording.capturedFrames, early.recording.capturedFrames, during.recording.capturedFrames],
      peakWriterOutstandingBuffers: completed.recording.peakWriterOutstandingBuffers,
      writerReturnMaxMs: completed.recording.writerReturnMaxMs,
      writerTiming: recordingTimingResult(completed.recording),
      reopenedPlaybackCallbacks: afterPlayback.native.diagnostics.callbacks,
    }, null, 2))
  } catch (error) {
    failure = true
    if (attached) {
      const active = await browserCommand(session, ["eval", "document.querySelector('button[aria-label=\"Stop recording\"]') !== null"]).catch(() => "false")
      if (active.trim() === "true") await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop recording"]).catch(() => undefined)
    }
    const evidence = path.join(directory, "failure.json")
    await writePrivateArtifact(evidence, JSON.stringify({
      stage, error: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
      diagnostics: await command(root, profile, ["host", "diagnostics-v2"]).catch(() => null),
      dialog: attached ? await browserCommand(session, ["eval", "document.querySelector('[role=\"dialog\"]')?.textContent?.slice(-600) ?? ''"]).catch(() => null) : null,
    }, null, 2))
    console.error(`Recording acceptance failed at ${stage}; private evidence: ${evidence}`)
    process.exitCode = 1
  } finally {
    if (attached) await browserCommand(session, ["close"]).catch(() => undefined)
    if (app?.pid) {
      const current = await rows()
      const owned = current.find((row) => row.pid === app.pid && row.command.includes(executable) && row.command.includes(`--user-data-dir=${profile}`))
      if (owned && plan?.processGroupId === owned.processGroupId && plan.processGroupId !== process.pid) {
        process.kill(-plan.processGroupId, "SIGTERM")
        await delay(1_000)
        for (const pid of cleanupSurvivors(plan, await rows())) process.kill(pid, "SIGKILL")
      } else if (owned) {
        console.error("Refusing cleanup without verified runner-owned process group.")
        failure = true
      }
    }
    if (!failure || !app?.pid || !(await rows()).some((row) => row.pid === app?.pid)) await rm(profile, { recursive: true, force: true })
    if (!failure) await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
