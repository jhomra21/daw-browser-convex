#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { watch, type FSWatcher } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { browserCommand } from "../browser-harness"
import { createPrivateRunDirectory, electronRendererTarget, writePrivateArtifact } from "./electron"
import { ownedV3CdpEndpoint } from "./v3-import-acceptance"
import { stopOwnedSpoolProcesses } from "./native-spool-process"
import { controlCapabilitiesSchemaV2, projectCurrentResultSchema, projectSnapshotSchemaV2 } from "@daw-browser/control"
import { desktopDiagnosticsSchemaV2 } from "@daw-browser/desktop-protocol"
import { extractFile } from "@electron/asar"
import {
  recordingStartDiagnosticEventSchema,
  type RecordingStartDiagnosticEvent,
} from "../../../apps/desktop/recording-start-diagnostic"

const root = path.resolve(import.meta.dir, "../../..")
const executable = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/MacOS/@daw-browser-desktop")
const traceDirectory = path.join(root, "acceptance-reports/native-spool-configure-trace-2026-10-12")
const diagnosticPrefix = "[recording-start-diagnostic] "
const command = async (profile: string, args: string[]) => {
  const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile },
    signal: AbortSignal.timeout(15_000), stdout: "pipe", stderr: "ignore",
  })
  const output = await new Response(child.stdout).text()
  if (await child.exited !== 0) throw new Error("Public control request failed.")
  return JSON.parse(output).data
}
const nested = (text: string): z.infer<ReturnType<typeof z.json>> => {
  let value = z.json().parse(JSON.parse(text))
  for (let count = 0; count < 3; count++) {
    const encoded = z.string().safeParse(value)
    if (!encoded.success) break
    try { value = z.json().parse(JSON.parse(encoded.data)) } catch { break }
  }
  return value
}
const verifyPackagedInhibitor = () => {
  const source = extractFile(path.join(executable, "../../Resources/app.asar"), ".vite/build/main.js").toString()
  // Verify the executable guard structure, not merely diagnostic string presence.
  const factory = source.match(/(\w+) = \((\w+), \w+\) => \{\s*let \w+ = 0;\s*const \w+ = \(\w+\) => \{[\s\S]*?start\((\w+)\) \{\s*return (\w+) \? \(\w+\(\{ kind: "native-start-blocked" \}\), Promise.resolve\(\{ ok: !1, error: "diagnostic-capture-blocked" \}\)\) : (\w+)\(\);/)
  const binding = source.match(/const (\w+) = (\w+)\(\s*process.env.DAW_RECORDING_START_DIAGNOSTIC === "1",/)
  const guardedCall = source.match(/return await (\w+)\.start\(async \(\) => \(await \w+\.startRecording\(\), \{ ok: !0 \}\)\)/)
  if (!factory || !binding || !guardedCall || factory[2] !== factory[4]
    || factory[3] !== factory[5] || factory[1] !== binding[2] || binding[1] !== guardedCall[1]
    || (source.match(/await \w+\.startRecording\(\)/g) ?? []).length !== 1)
    throw new Error("Packaged native-start inhibitor could not be verified.")
}
const waitForEndpoint = (profile: string, appPid: number) => new Promise<string>((resolve, reject) => {
  let watcher: FSWatcher | undefined
  let settled = false
  const finish = (endpoint: string | undefined) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    watcher?.close()
    if (endpoint) resolve(endpoint)
    else reject(new Error("Owned packaged renderer endpoint unavailable."))
  }
  const check = async () => {
    try {
      const owned = await ownedV3CdpEndpoint(profile, appPid, executable)
      finish(owned.endpoint)
    } catch { /* Wait for the profile's DevToolsActivePort creation/update event. */ }
  }
  const timeout = setTimeout(() => finish(undefined), 30_000)
  try {
    watcher = watch(profile, { persistent: false }, () => { void check() })
    void check()
  } catch {
    finish(undefined)
  }
})

const createTraceWaiter = (events: RecordingStartDiagnosticEvent[], timeoutMs: number) => {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  // This is a bounded diagnostic-observation deadline, not a native drain deadline.
  const timeout = setTimeout(() => resolve(), timeoutMs)
  const notify = () => {
    if (!events.some((event) => event.kind === "native-start-blocked"
      || (event.kind === "configure-result" && event.outcome === "rejected"))) return
    clearTimeout(timeout)
    resolve()
  }
  return { promise, notify, close: () => clearTimeout(timeout) }
}

const main = async () => {
  await mkdir(traceDirectory, { recursive: true, mode: 0o700 })
  const runDirectory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(runDirectory, "profile")
  await mkdir(profile, { mode: 0o700 })
  const session = `daw-30-track-electron-diagnostic-${crypto.randomUUID()}`
  const events: RecordingStartDiagnosticEvent[] = []
  verifyPackagedInhibitor()
  let traceWaiter: ReturnType<typeof createTraceWaiter> | undefined
  let partial = ""
  let attached = false
  let endpoint = ""
  let blockProven = false
  let cleanupFailed = false
  let stage = "launch"
  let failureCategory = "none"
  let mountedMatchingProject = false
  let postClick: z.infer<ReturnType<typeof z.json>> = null
  let runtime: { nativeStatus: z.infer<typeof desktopDiagnosticsSchemaV2>["recording"]["lastNativeStatus"] } | null = null
  const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`],
    { cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_RECORDING_START_DIAGNOSTIC: "1" },
      detached: true, stdio: ["ignore", "pipe", "ignore"] })
  const appPid = app.pid
  if (!appPid) throw new Error("Owned diagnostic app PID unavailable.")
  const onOutput = (chunk: Buffer) => {
    const lines = (partial + chunk.toString()).split(/\r?\n/)
    partial = (lines.pop() ?? "").slice(0, 4096)
    for (const line of lines) {
      if (!line.startsWith(diagnosticPrefix)) continue
      try {
        const parsed = recordingStartDiagnosticEventSchema.safeParse(JSON.parse(line.slice(diagnosticPrefix.length)))
        if (parsed.success && events.length < 64) {
          events.push(parsed.data)
          traceWaiter?.notify()
        }
      } catch { /* Discard malformed diagnostic lines without retaining their content. */ }
    }
  }
  app.stdout?.on("data", onOutput)
  try {
    endpoint = await waitForEndpoint(profile, appPid)
    stage = "renderer-connect"
    await browserCommand(session, ["connect", endpoint])
    attached = true
    const target = electronRendererTarget(await browserCommand(session, ["tab"]))?.targetId
    if (!target) throw new Error("Packaged renderer unavailable.")
    await browserCommand(session, ["tab", target])
    stage = "host-status"
    const host = z.object({ ready: z.boolean() }).passthrough().parse(await command(profile, ["host", "status"]))
    if (!host.ready) throw new Error("Native host is not ready.")
    stage = "new-project"
    await browserCommand(session, ["eval", `(async()=>await new Promise((resolve,reject)=>{
      let observer;let timer;
      const finish=(ready)=>{clearTimeout(timer);observer?.disconnect();ready?resolve(true):reject(new Error("Dashboard deadline"));};
      const check=()=>{if([...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='New project'))finish(true);};
      observer=new MutationObserver(check);observer.observe(document.body,{childList:true,subtree:true});
      // One bounded event-driven dashboard wait, cleaned up on success or timeout.
      timer=setTimeout(()=>finish(false),30000);check();
    }))()`])
    await browserCommand(session, ["find", "role", "button", "click", "--name", "New project"])
    // DOM mutations signal completion of UI mount; no polling of project control.
    const projectId = z.string().parse(nested(await browserCommand(session, ["eval",
      `(async()=>await new Promise((resolve,reject)=>{
        let observer;let timer;
        const finish=(id)=>{clearTimeout(timer);observer?.disconnect();id?resolve(id):reject(new Error("UI mount deadline"));};
        const check=()=>{const id=new URL(location.href).searchParams.get("projectId");
          if(id&&document.querySelector('[data-timeline-ruler="1"]')&&document.querySelector('button[aria-label="Arm track 1 for recording"]'))finish(id);};
        observer=new MutationObserver(check);observer.observe(document.body,{childList:true,subtree:true,attributes:true});
        // Bounded mount observation; both terminal paths disconnect and clear the timer.
        timer=setTimeout(()=>finish(null),30000);check();
      }))()`])))
    stage = "project-capabilities"
    controlCapabilitiesSchemaV2.parse(await command(profile, ["capabilities-v2", "--target", "host"]))
    stage = "project-current"
    const current = projectCurrentResultSchema.parse(await command(profile, ["project", "current", "--target", "host"]))
    if (current.status !== "present" || current.project.projectId !== projectId)
      throw new Error("Canonical mounted project does not match UI.")
    stage = "project-snapshot"
    const snapshot = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", current.project.projectId, "--target", "host"]))
    if (snapshot.project.id !== projectId) throw new Error("Canonical snapshot mismatch.")
    mountedMatchingProject = true
    stage = "arm-track"
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Arm track 1 for recording"])
    stage = "start-click"
    traceWaiter = createTraceWaiter(events, 15_000)
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Start recording"])
    stage = "await-native-start-block"
    await traceWaiter.promise
    blockProven = events.some((event) => event.kind === "native-start-blocked")
    postClick = nested(await browserCommand(session, ["eval",
      "JSON.stringify({startPresent:!!document.querySelector('button[aria-label=\"Start recording\"]'),stopPresent:!!document.querySelector('button[aria-label=\"Stop recording\"]'),dialogPresent:!!document.querySelector('[role=\"dialog\"]')})"]))
    const diagnostics = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    runtime = { nativeStatus: diagnostics.recording.lastNativeStatus }
    if (!blockProven && !events.some((event) => event.kind === "configure-result" && event.outcome === "rejected"))
      failureCategory = "observation-deadline-no-terminal-event"
  } catch (error) {
    failureCategory = error instanceof Error && error.message.includes("The requested project is not mounted.")
      ? "project-not-mounted"
      : stage
  } finally {
    traceWaiter?.close()
    if (attached) await browserCommand(session, ["close"]).catch(() => undefined)
    if (app.exitCode === null && app.signalCode === null) {
      const stopped = await stopOwnedSpoolProcesses({ directory: runDirectory, rootPid: appPid, executable })
      cleanupFailed = !stopped
    }
    const trace = {
      schemaVersion: 1,
      status: blockProven ? "start-blocked"
        : events.some((event) => event.kind === "configure-result" && event.outcome === "rejected")
          ? "configure-rejected" : "inconclusive",
      stage,
      failureCategory,
      events,
      nativeStartBlocked: blockProven,
      packagedInhibitorVerified: true,
      mountedMatchingProject,
      postClick,
      runtime,
      recordingCapturePerformed: runtime?.nativeStatus?.active === false
        && runtime.nativeStatus.capturedFrames === 0 ? false : null,
      cleanupFailed,
      note: blockProven
        ? "Main-process start-recording handler returned before native supervisor start."
        : "No native start-block event observed; no capture acceptance was run.",
    }
    const artifact = path.join(traceDirectory, `trace-${new Date().toISOString().replaceAll(":", "-")}.json`)
    await writePrivateArtifact(artifact, JSON.stringify(trace, null, 2))
    console.log(`${trace.status}; ${artifact}`)
    if (failureCategory !== "none" || cleanupFailed) process.exitCode = 1
  }
}

if (import.meta.main) await main()
