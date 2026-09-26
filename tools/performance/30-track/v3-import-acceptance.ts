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
export const quietCapture = async (steps: {
  start: () => Promise<void>
  wait: () => Promise<void>
  stop: () => Promise<void>
  observe: () => Promise<void>
}) => {
  await steps.start()
  await steps.wait()
  await steps.stop()
  await steps.observe()
}
export const recoverQuietTarget = async (steps: {
  original: () => Promise<string>
  reconnect: () => Promise<string>
}, expectedProjectId?: string) => {
  const matches = (url: string) => {
    try {
      const page = new URL(url)
      return page.protocol === "daw:" && page.hostname === "app"
        && (expectedProjectId === undefined || page.searchParams.get("projectId") === expectedProjectId)
    } catch { return false }
  }
  try {
    const url = await steps.original()
    if (matches(url)) return { recovered: false, url }
  } catch { /* A disconnected browser session is expected during recovery. */ }
  const url = await steps.reconnect()
  if (!matches(url)) throw new Error("Verified app target unavailable")
  return { recovered: true, url }
}
export const importedProjectTarget = (tabs: string, projectId: string): string | null => {
  const matches = [...tabs.matchAll(/\[(t[0-9]+)\][^\n]*\s(daw:\/\/app\/[^\s]*)/g)]
    .filter(([, , url]) => {
      try { return new URL(url).searchParams.get("projectId") === projectId } catch { return false }
    })
  return matches.length === 1 ? matches[0]?.[1] ?? null : null
}
export const classifyQuietCapture = (state: {
  mainAlive: boolean
  rendererAlive: boolean
  targetFound: boolean
  stopPresent: boolean | null
  stopSucceeded: boolean
  rendererFailure: boolean
}) => {
  if (!state.mainAlive) return "electron-main-exited"
  if (!state.rendererAlive || state.rendererFailure) return "renderer-gone"
  if (!state.targetFound || state.stopPresent === null) return "renderer-unresponsive"
  if (!state.stopPresent) return "recording-ended-before-stop"
  return state.stopSucceeded ? "explicit-stop-completed" : "stop-control-failed"
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
  const quietRecording = Bun.argv[3] === "--quiet-recording" && Bun.argv.length === 4
  if (!output || !path.isAbsolute(output) || (Bun.argv.length !== 3 && !quietRecording))
    throw new Error("Usage: bun v3-import-acceptance.ts <absolute-result-path> [--quiet-recording]")
  if ((await stat(archive)).size < 773_000_000) throw new Error("Unexpected v3 archive size")
  await stat(path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/Resources/app.asar"))
  const directory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(directory, "profile")
  await mkdir(profile, { mode: 0o700 })
  const session = `daw-30-track-electron-v3-${crypto.randomUUID()}`
  let stage = "launch"
  let attached = false
  let endpoint = ""
  let originalTarget = ""
  let quietStartedAt = 0
  let quietElapsedMs = 0
  let beforeCaptureProcesses: Awaited<ReturnType<typeof rows>> = []
  let afterCaptureProcesses: Awaited<ReturnType<typeof rows>> = []
  let originalTargetAlive: boolean | null = null
  let reconnectSucceeded = false
  let stopPresent: boolean | null = null
  let stopSucceeded = false
  let lifecycle = ""
  let rendererPid = 0
  let cdpError: string | null = null
  let targetsAfter: { type: string; urlClass: string; original: boolean }[] = []
  const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_BENCHMARK_SAB_RECORDING: quietRecording ? "1" : "0",
      DAW_BENCHMARK_QUIET_CAPTURE: quietRecording ? "1" : "0" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let appOutput = ""
  const collectOutput = (chunk: Buffer) => {
    const text = chunk.toString()
    appOutput = (appOutput + text).slice(-3000)
    lifecycle = (lifecycle + text.split(/\r?\n/).filter((line) =>
      line.includes("[quiet-capture-lifecycle]") || line.includes("[quiet-capture-native]")
        || line.includes("native audio host closed")).join("\n") + "\n").slice(-4000)
  }
  app.stdout?.on("data", collectOutput)
  app.stderr?.on("data", collectOutput)
  if (!app.pid) throw new Error("No Electron PID")
  let plan: ReturnType<typeof createCleanupPlan>
  try {
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
    originalTarget = target
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
      throw new Error(`Playback callbacks missing or native blocks rejected: ${JSON.stringify({
        state: playing.state, before: before.native.status === "available" ? before.native.diagnostics.callbacks : null,
        after: after.native.status === "available" ? after.native.diagnostics.callbacks : null,
        rejected: after.native.status === "available" ? after.native.diagnostics.rejectedBlocks : null,
      })}`)
    let recordingResult: object | null = null
    if (quietRecording) {
      const audioTrack = snapshot.tracks.find((track) => track.kind === "audio")
      if (!audioTrack) throw new Error("No audio track to record.")
      const audioIndex = snapshot.tracks.filter((track) => track.kind === "audio").findIndex((track) => track.id === audioTrack.id) + 1
      stage = "quiet-recording"
      await browserCommand(session, ["find", "role", "button", "click", "--name", `Arm track ${audioIndex} for recording`])
      const recordingBefore = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
      const started = performance.now()
      beforeCaptureProcesses = await rows()
      rendererPid = Number(/stage=loaded rendererPid=(\d+)/.exec(lifecycle)?.[1] ?? 0)
      await writePrivateArtifact(path.join(directory, "quiet-identity.json"), JSON.stringify({
        mainPid: app.pid, rendererPid, processGroupId: plan.processGroupId,
        webContentsId: Number(/stage=created webContentsId=(\d+)/.exec(lifecycle)?.[1] ?? 0),
        targetId: originalTarget, profile, port: new URL(endpoint).port,
        owned: beforeCaptureProcesses.filter((row) => plan.recordedProcesses.some((entry) => entry.pid === row.pid))
          .map(({ pid, parentPid }) => ({ pid, parentPid })),
      }))
      await quietCapture({
        start: async () => {
          stage = "quiet-start"
          await browserCommand(session, ["find", "role", "button", "click", "--name", "Start recording"])
          quietStartedAt = Date.now()
          stage = "quiet-wait"
        },
        wait: () => delay(61_000),
        stop: async () => {
          stage = "quiet-stop"
          quietElapsedMs = Date.now() - quietStartedAt
          afterCaptureProcesses = await rows()
          const port = new URL(endpoint).port
          try {
            const targets = z.array(z.object({ id: z.string(), type: z.string(), url: z.string() }).passthrough()).max(64)
              .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json())
            originalTargetAlive = targets.some((item) => item.id === originalTarget && item.url.startsWith("daw://app/"))
            targetsAfter = targets.slice(0, 16).map((item) => ({
              type: item.type,
              urlClass: item.url.startsWith("daw://app/") ? "app" : "other",
              original: item.id === originalTarget,
            }))
          } catch (error) { originalTargetAlive = false; cdpError = error instanceof Error ? error.name : "unknown" }
          await writePrivateArtifact(path.join(directory, "quiet-after-wait.json"), JSON.stringify({
            elapsedMs: quietElapsedMs,
            mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
            rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
            originalTargetAlive, cdpError, targetsAfter,
            lifecycle: lifecycle.slice(-2000),
          }))
          const activeSession = await recoverQuietTarget({
            original: () => browserCommand(session, ["get", "url"]),
            reconnect: async () => {
              await browserCommand(session, ["connect", endpoint])
              const candidate = importedProjectTarget(await browserCommand(session, ["tab"]), projectId)
              if (!candidate) throw new Error("Verified app target unavailable")
              await browserCommand(session, ["tab", candidate])
              return browserCommand(session, ["get", "url"])
            },
          }, projectId)
          reconnectSucceeded = activeSession.recovered
          stopPresent = (await browserCommand(session, ["eval", "document.querySelector('button[aria-label=\"Stop recording\"]') !== null"])).trim() === "true"
          if (!stopPresent) throw new Error("Stop recording absent after quiet interval.")
          await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop recording"])
          stopSucceeded = true
          stage = "quiet-observe"
        },
        observe: async () => {
          const completed = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
          const persisted = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
          const newClips = persisted.clips.filter((clip) => !snapshot.clips.some((previous) => previous.id === clip.id)
            && clip.trackId === audioTrack.id && clip.source?.sourceKind === "recording")
          const capturedFrames = (completed.recording.capturedFrames ?? 0) - (recordingBefore.recording.capturedFrames ?? 0)
          if (performance.now() - started < 60_000 || capturedFrames < 60 * (completed.recording.activeSampleRate ?? 0)
            || !completed.recording.activeSampleRate || completed.recording.droppedFrames !== 0
            || completed.recording.overrunFrames !== 0 || completed.recording.lastFailurePresent
            || completed.recording.peakSabWriterOccupancy > 8 || newClips.length !== 1) {
            throw new Error(`Quiet capture failed: ${JSON.stringify({
              capturedFrames, sampleRate: completed.recording.activeSampleRate,
              droppedFrames: completed.recording.droppedFrames,
              peakOccupancy: completed.recording.peakSabWriterOccupancy,
              failure: completed.recording.lastFailurePresent, newClips: newClips.length,
            })}`)
          }
          recordingResult = { capturedFrames, sampleRate: completed.recording.activeSampleRate,
            droppedFrames: completed.recording.droppedFrames, peakOccupancy: completed.recording.peakSabWriterOccupancy,
            clipId: newClips[0]?.id, writerTiming: completed.recording.writerTiming }
        },
      })
    }
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop"])
    await mkdir(path.dirname(output), { recursive: true })
    await writePrivateArtifact(output, JSON.stringify({ status: "complete", archive, projectId: snapshot.project.id, tracks: snapshot.tracks.length, clips: snapshot.clips.length, assets: snapshot.assets.length, midiNotes: countMidiNotes(snapshot.clips), nativeCallbacksBefore: before.native.diagnostics.callbacks, nativeCallbacksAfter: after.native.diagnostics.callbacks, rejectedBlocks: after.native.diagnostics.rejectedBlocks - before.native.diagnostics.rejectedBlocks, recording: recordingResult }, null, 2))
  } catch (error) {
    await mkdir(path.dirname(output), { recursive: true })
    let samplePath: string | null = null
    if (quietElapsedMs >= 60_000 && rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid)) {
      const sample = Bun.spawn(["sample", String(rendererPid), "5", "-file", path.join(directory, "quiet-renderer-sample.txt")], {
        stdout: "ignore", stderr: "pipe",
      })
      await Promise.race([sample.exited, delay(8_000)])
      if (sample.exitCode === null) sample.kill()
      if (sample.exitCode === 0) samplePath = path.join(directory, "quiet-renderer-sample.txt")
    }
    await writePrivateArtifact(output, JSON.stringify({
      status: "failed", stage, error: String(error),
      quietCaptureStarted: quietStartedAt > 0, quietCaptureElapsedMs: quietElapsedMs,
      processesBefore: beforeCaptureProcesses.filter((row) => plan?.recordedProcesses.some((entry) => entry.pid === row.pid)).map(({ pid, parentPid, processGroupId }) => ({ pid, parentPid, processGroupId })),
      processesAfter: afterCaptureProcesses.filter((row) => plan?.recordedProcesses.some((entry) => entry.pid === row.pid)).map(({ pid, parentPid, processGroupId }) => ({ pid, parentPid, processGroupId })),
      mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
      rendererPid, rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
      originalTargetAlive, cdpError, targetsAfter, reconnectSucceeded, stopPresent, stopSucceeded,
      classification: classifyQuietCapture({
        mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
        rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
        targetFound: targetsAfter.some((target) => target.urlClass === "app"),
        stopPresent, stopSucceeded, rendererFailure: lifecycle.includes("stage=renderer-gone"),
      }),
      lifecycle: lifecycle.slice(-3000),
      samplePath,
      postmortem: await command(profile, ["host", "diagnostics-v2"]).catch(() => null),
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
