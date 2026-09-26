#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { browserCommand, waitForBrowserValue } from "../browser-harness"
import { cleanupSurvivors, createCleanupPlan, createPrivateRunDirectory, verifyElectronLaunchIdentity, electronRendererTarget, writePrivateArtifact } from "./electron"
import { projectSnapshotSchemaV2, type ProjectSnapshotV2 } from "@daw-browser/control"
import { desktopDiagnosticsSchemaV2, desktopTransportStatusSchemaV1 } from "@daw-browser/desktop-protocol"
import { z } from "zod"

const root = path.resolve(import.meta.dir, "../../..")
const archive = path.join(root, "tools/performance/fixtures/30-track-v3-native.dawproject")
const executable = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/MacOS/@daw-browser-desktop")
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export const parseBrowserProjectId = (output: string) => {
  const encoded = z.string().min(1).parse(JSON.parse(output))
  return z.string().regex(/^project:[A-Za-z0-9-]+$/).parse(JSON.parse(encoded))
}
const rows = async () => {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,command="], { stdout: "pipe" })
  const text = await new Response(child.stdout).text()
  return text.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), processGroupId: Number(match[3]), command: match[4]! }] : []
  })
}
export const countMidiNotes = (clips: readonly { midi?: { notes: readonly { beat: number }[] } }[]) =>
  clips.reduce((total, clip) => total + (clip.midi?.notes.length ?? 0), 0)

export const assertArchiveSnapshot = (value: ProjectSnapshotV2) => {
  if (value.tracks.length !== 30 || value.clips.length !== 30 || value.assets.length !== 24 ||
    countMidiNotes(value.clips) !== 96)
    throw new Error(`V3 semantic mismatch: ${value.tracks.length} tracks, ${value.clips.length} clips, ${value.assets.length} assets, ${countMidiNotes(value.clips)} MIDI notes`)
  return value
}
const command = async (profile: string, args: string[]) => {
  const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") }, stdout: "pipe", stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (await child.exited !== 0) throw new Error(`Control command failed: ${err.slice(0, 500)}`)
  return JSON.parse(out).data
}
const main = async () => {
  const output = Bun.argv[2]
  if (!output || !path.isAbsolute(output)) throw new Error("Usage: bun v3-import-acceptance.ts <absolute-result-path>")
  if ((await stat(archive)).size < 773_000_000) throw new Error("Unexpected v3 archive size")
  await stat(path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/Resources/app.asar"))
  const directory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(directory, "profile")
  await mkdir(profile, { mode: 0o700 })
  const session = `daw-30-track-electron-v3-${crypto.randomUUID()}`
  let stage = "launch"
  let attached = false
  const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_BENCHMARK_STARTUP_TRACE: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let appOutput = ""
  app.stdout?.on("data", (chunk: Buffer) => { appOutput = (appOutput + chunk.toString()).slice(-3000) })
  app.stderr?.on("data", (chunk: Buffer) => { appOutput = (appOutput + chunk.toString()).slice(-3000) })
  if (!app.pid) throw new Error("No Electron PID")
  let plan: ReturnType<typeof createCleanupPlan>
  try {
    let endpoint = ""
    for (let i = 0; i < 30 && !endpoint; i++) {
      try {
        const [portText, capability] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
        const port = Number(portText)
        const listener = Bun.spawn(["lsof", "-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe" })
        const pids = (await new Response(listener.stdout).text()).trim().split(/\s+/).map(Number)
        const url = `ws://127.0.0.1:${port}${capability}`
        const processes = await rows()
        const identity = verifyElectronLaunchIdentity({ rootPid: app.pid, executablePath: executable, profilePath: profile, port, listenerPids: pids, processes, websocketUrl: url })
        if (!identity.verified) throw new Error(identity.reason)
        plan = createCleanupPlan(processes, app.pid)
        if (!plan) throw new Error("No owned process group")
        endpoint = url
      } catch { await delay(1000) }
    }
    if (!endpoint || !plan) throw new Error("Owned CDP endpoint unavailable")
    await browserCommand(session, ["connect", endpoint])
    attached = true
    let target: string | undefined
    let lastTabs = ""
    for (let i = 0; i < 30 && !target; i++) {
      lastTabs = await browserCommand(session, ["tab"])
      target = electronRendererTarget(lastTabs)?.targetId
      if (!target) await delay(1000)
    }
    if (!target) throw new Error(`Renderer unavailable: ${lastTabs.slice(0, 1000)}; app: ${appOutput}`)
    await browserCommand(session, ["tab", target])
    if ((await browserCommand(session, ["get", "url"])) !== (electronRendererTarget(await browserCommand(session, ["tab"]))?.url)) {
      throw new Error("Renderer identity mismatch")
    }
    stage = "upload"
    await waitForBrowserValue(session, "document.querySelector(\"input[accept='.dawproject,application/vnd.dawproject,application/zip']\") ? true : null", 30000)
    await browserCommand(session, ["upload", "input[accept='.dawproject,application/vnd.dawproject,application/zip']", archive])
    stage = "import"
    const projectId = parseBrowserProjectId(await waitForBrowserValue(session, "new URL(location.href).searchParams.get('projectId') && document.querySelector('[data-timeline-ruler=\"1\"]') ? new URL(location.href).searchParams.get('projectId') : null", 180000))
    await waitForBrowserValue(session, "document.querySelectorAll('[aria-label^=\"Select track \"]').length === 30 ? true : null", 60_000)
    const snapshot = assertArchiveSnapshot(projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"])))
    stage = "playback"
    await browserCommand(session, ["reload"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Play\"]') && !document.querySelector('[role=\"dialog\"]') ? true : null", 60_000)
    const before = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Pause\"]') ? true : null", 30000)
    await delay(4000)
    const playing = desktopTransportStatusSchemaV1.parse(await command(profile, ["host", "transport-status"]))
    const after = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    if (playing.state !== "playing" || before.native.status !== "available" || after.native.status !== "available" ||
      after.native.diagnostics.callbacks <= before.native.diagnostics.callbacks ||
      after.native.diagnostics.rejectedBlocks !== before.native.diagnostics.rejectedBlocks)
      throw new Error("Playback callbacks missing or native blocks rejected")
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop"])
    await mkdir(path.dirname(output), { recursive: true })
    await writePrivateArtifact(output, JSON.stringify({ status: "complete", archive, projectId: snapshot.project.id, tracks: snapshot.tracks.length, clips: snapshot.clips.length, assets: snapshot.assets.length, midiNotes: countMidiNotes(snapshot.clips), nativeCallbacksBefore: before.native.diagnostics.callbacks, nativeCallbacksAfter: after.native.diagnostics.callbacks, rejectedBlocks: after.native.diagnostics.rejectedBlocks - before.native.diagnostics.rejectedBlocks }, null, 2))
  } catch (error) {
    await mkdir(path.dirname(output), { recursive: true })
    await writePrivateArtifact(output, JSON.stringify({
      status: "failed", stage, error: String(error),
      host: await command(profile, ["host", "status"]).catch(() => null),
      rendererProjectId: attached ? await browserCommand(session, ["eval", "new URL(location.href).searchParams.get('projectId')"]).catch(() => null) : null,
      rendererSnapshot: attached ? (await browserCommand(session, ["snapshot", "-c"]).catch(() => "")).slice(0, 6000) : null,
      dialogHtml: attached ? (await browserCommand(session, ["eval", "document.querySelector('[role=\"dialog\"]')?.outerHTML.slice(0, 5000) ?? null"]).catch(() => "")).slice(0, 5500) : null,
    }, null, 2))
    throw error
  } finally {
    if (attached) await browserCommand(session, ["close"]).catch(() => undefined)
    const owned = (await rows()).find((row) => row.pid === app.pid && row.command.includes(executable) && row.command.includes(`--user-data-dir=${profile}`))
    if (owned && plan?.processGroupId === owned.processGroupId && plan.processGroupId !== process.pid) {
      process.kill(-plan.processGroupId, "SIGTERM")
      await delay(1000)
      for (const pid of cleanupSurvivors(plan, await rows())) process.kill(pid, "SIGKILL")
    }
  }
}
if (import.meta.main) await main()
