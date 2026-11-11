#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { cp, mkdir, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { controlCapabilitiesSchemaV2, projectCurrentResultSchema, projectSnapshotSchemaV2 } from "@daw-browser/control"
import { desktopDiagnosticsSchemaV2, desktopHostStatusSchemaV1, desktopTransportStatusSchemaV1 } from "@daw-browser/desktop-protocol"
import { browserCommand } from "../browser-harness"
import { createPrivateRunDirectory, writePrivateArtifact } from "./electron"
import { ownedV3CdpEndpoint } from "./v3-import-acceptance"
import { stopOwnedSpoolProcesses } from "./native-spool-process"
import { assessSpoolNativeIntegrity } from "./native-spool-evidence"

// Public requests are one-shot: a failed precondition is evidence, not a retry trigger.
const command = async (profile: string, args: string[]) => {
  const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile },
    signal: AbortSignal.timeout(15_000), stdout: "pipe", stderr: "ignore",
  })
  const output = await new Response(child.stdout).text()
  if (await child.exited !== 0) throw new Error("Public control request failed.")
  return JSON.parse(output).data
}

const waitForRenderer = async (endpoint: string) => {
  return new Promise<string>((resolve, reject) => {
    // ownedV3CdpEndpoint returns the verified browser WebSocket, not an HTTP origin.
    const socket = new WebSocket(endpoint)
    let settled = false
    const finish = (error?: Error, targetId?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else if (targetId) resolve(targetId)
      else reject(new Error("Renderer target identity unavailable."))
    }
    // CDP discovery emits existing targets and later creation/navigation events.
    // One bounded observation deadline, cleared on every terminal path.
    const timer = setTimeout(() => finish(new Error("Packaged renderer navigation deadline.")), 30_000)
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      id: 1, method: "Target.setDiscoverTargets", params: { discover: true },
    })))
    socket.addEventListener("message", (event) => {
      const message = z.object({ method: z.string().optional(), params: z.object({
        targetInfo: z.object({ targetId: z.string(), type: z.string(), url: z.string() }).optional(),
      }).optional() }).safeParse(JSON.parse(String(event.data)))
      if (!message.success) return
      const target = message.data.params?.targetInfo
      if (target?.type === "page" && target.url.startsWith("daw://app/")) finish(undefined, target.targetId)
    })
    socket.addEventListener("error", () => finish(new Error("Renderer discovery socket failed.")))
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("Renderer discovery socket closed."))
    })
  })
}

const root = path.resolve(import.meta.dir, "../../..")
const navigatePackagedPage = (endpoint: string, targetId: string, url: string) => new Promise<void>((resolve, reject) => {
  const socket = new WebSocket(endpoint)
  let sessionId: string | undefined
  let settled = false
  let navigationSent = false
  let acknowledged = false
  let loaded = false
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.close()
    if (error) reject(error)
    else resolve()
  }
  // agent-browser open failed with ERR_NAME_NOT_RESOLVED for this custom scheme.
  // CDP navigates the exact owned target and observes load without polling.
  const timer = setTimeout(() => finish(new Error("Packaged navigation deadline.")), 25000)
  socket.addEventListener("open", () => socket.send(JSON.stringify({
    id: 1, method: "Target.attachToTarget", params: { targetId, flatten: true },
  })))
  socket.addEventListener("message", (event) => {
    const message = z.object({
      id: z.number().optional(), method: z.string().optional(), sessionId: z.string().optional(),
      error: z.unknown().optional(),
      result: z.object({ sessionId: z.string().optional(), errorText: z.string().optional() }).passthrough().optional(),
    }).passthrough().parse(JSON.parse(String(event.data)))
    if (message.error || message.result?.errorText) return finish(new Error("Packaged CDP navigation failed."))
    if (message.id === 1) {
      sessionId = message.result?.sessionId
      if (!sessionId) return finish(new Error("Packaged CDP session unavailable."))
      socket.send(JSON.stringify({ id: 2, method: "Page.enable", params: {}, sessionId }))
    } else if (message.id === 2) {
      navigationSent = true
      socket.send(JSON.stringify({ id: 3, method: "Page.navigate", params: { url }, sessionId }))
    } else if (message.id === 3) acknowledged = true
    if (navigationSent && message.sessionId === sessionId && message.method === "Page.loadEventFired") loaded = true
    if (acknowledged && loaded) finish()
  })
  socket.addEventListener("error", () => finish(new Error("Packaged navigation socket failed.")))
  socket.addEventListener("close", () => {
    if (!settled) finish(new Error("Packaged navigation socket closed."))
  })
})
const executable = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/MacOS/@daw-browser-desktop")
const reportDirectory = path.join(root, "acceptance-reports/native-spool-reload-integrity-diagnosis-2026-10-12")
const nested = (text: string) => {
  let value = JSON.parse(text)
  for (let count = 0; count < 3; count++) {
    const encoded = z.string().safeParse(value)
    if (!encoded.success) break
    try { value = JSON.parse(encoded.data) } catch { break }
  }
  return value
}
const observeButton = async (session: string, selector: string) => browserCommand(session, ["eval", `(async()=>await new Promise((resolve,reject)=>{
  let observer;let timer;
  const finish=(ready)=>{clearTimeout(timer);observer?.disconnect();ready?resolve(true):reject(new Error("UI readiness deadline"));};
  const check=()=>{if(document.querySelector(${JSON.stringify(selector)}))finish(true);};
  // Document exists even when navigation has not inserted a body yet.
  observer=new MutationObserver(check);observer.observe(document,{childList:true,subtree:true,attributes:true});
  timer=setTimeout(()=>finish(false),25000);check();
}))()`])
const main = async () => {
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
  const runDirectory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(runDirectory, "profile")
  const sourceProfile = Bun.argv[2]
  if (!sourceProfile || !path.isAbsolute(sourceProfile)) throw new Error("An absolute retained source profile is required.")
  // Copy only persisted browser project/media state, never live lock/socket/host registration files.
  await mkdir(profile, { mode: 0o700 })
  for (const entry of ["IndexedDB", "File System", "Local Storage"])
    await cp(path.join(sourceProfile, entry), path.join(profile, entry), { recursive: true, errorOnExist: true, force: false })
  const asarSha256 = createHash("sha256").update(await readFile(path.join(executable, "../../Resources/app.asar"))).digest("hex")
  const nativeSha256 = createHash("sha256").update(await readFile(path.join(executable, "../../Resources/daw-audio-host-macos"))).digest("hex")
  if (asarSha256 !== "bb8da8e4de99dfd3bbedc5fa4ce365f245a4908f88ed8fa8ac7e1c6a1a80445c"
    || nativeSha256 !== "bdcdced079a3cc50d5539dfc4e15ba90a5130f3854d9a0e06204b4bd6857b488")
    throw new Error("Retained acceptance package identity mismatch.")
  // Use the established attached-Electron harness path, which does not inject
  // a standalone headless browser executable into the CDP session.
  const session = `daw-30-track-electron-${crypto.randomUUID()}`
  const artifact = path.join(reportDirectory, `no-capture-${new Date().toISOString().replaceAll(":", "-")}.json`)
  const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`],
    { cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile }, detached: true, stdio: ["ignore", "ignore", "ignore"] })
  const appPid = app.pid
  if (!appPid) throw new Error("Owned packaged app PID unavailable.")
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    app.once("exit", (code, signal) => resolve({ code, signal })))
  let attached = false
  let cleanupFailed = false
  let stage = "launch"
  const phases: { phase: string; audioState: string; recordingTransport: string | null; recordingFrames: number | null;
    nativeStatus: string; artifactVerification: string | null; nativeState: string | null; callbacks: number | null;
    rejectedBlocks: number | null; vstFaults: string | null; vstWatchdogMisses: string | null; vstRestarts: string | null }[] = []
  let error: string | undefined
  let projectDiscovered = false
  let capabilitiesDiscovered = false
  let savedAssetVerified = false
  let reloadedAssetVerified = false
  let playbackState: string | undefined
  let stopState: string | undefined
  let captureFree: boolean | null = null
  let normalQuit: { code: number | null; signal: string | null } | null = null
  const nativeSamples: z.infer<typeof desktopDiagnosticsSchemaV2>["native"][] = []
  const nativeDetails: z.infer<ReturnType<typeof z.json>>[] = []
  const record = async (phase: string) => {
    const diagnostics = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    const native = diagnostics.native
    nativeSamples.push(native)
    nativeDetails.push({ phase, status: native.status,
      observedAtEpochMs: Date.now(),
      errorCode: native.status === "failed" ? native.errorCode : null,
      activeRevision: native.status === "available" ? native.diagnostics.activeRevision : null,
      preparedRevision: native.status === "available" ? native.diagnostics.preparedRevision : null,
      retiredRevision: native.status === "available" ? native.diagnostics.retiredRevision : null,
      transportEpoch: native.status === "available" ? native.diagnostics.transportEpoch : null,
      renderEpoch: native.status === "available" ? native.diagnostics.renderEpoch : null,
      transportFrame: native.status === "available" ? native.diagnostics.transportFrame ?? null : null,
      installedAssets: native.status === "available" ? native.diagnostics.installedAssets : null,
      realtimePerformance: native.status === "available" ? native.diagnostics.realtimePerformance ?? null : null,
      lastRejectedReason: native.status === "available" ? native.diagnostics.lastRejectedReason : null,
      lastRejectedCallback: native.status === "available" ? native.diagnostics.lastRejectedCallback : null,
      lastRejectedRenderEpoch: native.status === "available" ? native.diagnostics.lastRejectedRenderEpoch : null,
      lastRejectedTransportEpoch: native.status === "available" ? native.diagnostics.lastRejectedTransportEpoch : null,
      lastRejectedCoreResult: native.status === "available" ? native.diagnostics.lastRejectedCoreResult : null,
      lastRejectedFrameCount: native.status === "available" ? native.diagnostics.lastRejectedFrameCount : null,
      lastRejectedChannelCount: native.status === "available" ? native.diagnostics.lastRejectedChannelCount : null,
      lastRejectedProcessorEventCount: native.status === "available" ? native.diagnostics.lastRejectedProcessorEventCount : null,
      lastRejectedInstrumentEventCount: native.status === "available" ? native.diagnostics.lastRejectedInstrumentEventCount : null,
      lastRejectedGraphRevision: native.status === "available" ? native.diagnostics.lastRejectedGraphRevision : null,
      vst: native.status === "available" ? native.diagnostics.vstWorkerPerformance ?? null : null,
      recordingActive: diagnostics.recording.lastNativeStatus?.active ?? null,
      nativeCapturedFrames: diagnostics.recording.lastNativeStatus?.capturedFrames ?? null,
    })
    phases.push({
      phase,
      audioState: diagnostics.audio.state,
      recordingTransport: diagnostics.recording.transport,
      recordingFrames: diagnostics.recording.capturedFrames,
      nativeStatus: native.status,
      artifactVerification: native.status === "unavailable" ? null : native.artifactVerification.status,
      nativeState: native.status === "available" ? native.diagnostics.state : null,
      callbacks: native.status === "available" ? native.diagnostics.callbacks : null,
      rejectedBlocks: native.status === "available" ? native.diagnostics.rejectedBlocks : null,
      vstFaults: native.status === "available" ? native.diagnostics.vstWorkerPerformance?.faults ?? null : null,
      vstWatchdogMisses: native.status === "available" ? native.diagnostics.vstWorkerPerformance?.watchdogMisses ?? null : null,
      vstRestarts: native.status === "available" ? native.diagnostics.vstWorkerPerformance?.restarts ?? null : null,
    })
    await writePrivateArtifact(artifact, JSON.stringify({ schemaVersion: 2, stage, phases, nativeDetails,
      projectDiscovered, capabilitiesDiscovered, savedAssetVerified, reloadedAssetVerified, asarSha256, nativeSha256 }, null, 2))
    if (diagnostics.recording.transport === "native-spool"
      || (diagnostics.recording.capturedFrames !== null && diagnostics.recording.capturedFrames !== 0)
      || diagnostics.recording.lastNativeStatus?.active === true) throw new Error("Unexpected recording activity in no-capture diagnostic.")
    return diagnostics
  }
  try {
    const endpoint = await ownedV3CdpEndpoint(profile, appPid, executable).then((value) => value.endpoint)
      .catch(async () => {
        // The endpoint is created by Electron after launch; this is a bounded, event-driven wait.
        const { watch } = await import("node:fs")
        return new Promise<string>((resolve, reject) => {
          let settled = false
          const finish = (value?: string) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            watcher?.close()
            if (value) resolve(value)
            else reject(new Error("Owned DevTools endpoint deadline"))
          }
          const check = async () => {
            try { finish((await ownedV3CdpEndpoint(profile, appPid, executable)).endpoint) } catch { /* await profile filesystem event */ }
          }
          const timer = setTimeout(() => finish(), 30000)
          const watcher = watch(profile, { persistent: false }, () => { void check() })
          void check()
        })
      })
    stage = "renderer-ready"
    const target = await waitForRenderer(endpoint)
    await browserCommand(session, ["connect", endpoint]); attached = true
    // Select the discovered CDP identity explicitly; connect can select another
    // page. agent-browser tab accepts CDP target IDs without text-list parsing.
    await browserCommand(session, ["tab", target])
    const packagedPage = z.boolean().parse(nested(await browserCommand(session, ["eval",
      "location.protocol === 'daw:' && location.hostname === 'app'"])))
    if (!packagedPage) throw new Error("Attached page is not the packaged renderer.")
    const host = desktopHostStatusSchemaV1.parse(await command(profile, ["host", "status"]))
    if (!host.ready) throw new Error("Desktop host not ready.")
    await navigatePackagedPage(endpoint, target, "daw://app/?dashboard=projects")
    await browserCommand(session, ["eval", `(async()=>await new Promise((resolve,reject)=>{
      let observer;let timer;
      const finish=(ready)=>{clearTimeout(timer);observer?.disconnect();ready?resolve(true):reject(new Error("Dashboard deadline"));};
      const check=()=>{if([...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='New project'))finish(true);};
      // Navigation can leave body absent when CDP evaluates; Document is stable
      // and observes the eventual body insertion without polling.
      observer=new MutationObserver(check);observer.observe(document,{childList:true,subtree:true});
      timer=setTimeout(()=>finish(false),25000);check();
    }))()`])
    stage = "discover-retained-project"
    // Local public project.list is bound to the mounted project, not the
    // dashboard's persisted catalog. Reopen the existing UI entry first.
    await observeButton(session, "article > button")
    const retainedEntryCount = z.number().parse(nested(await browserCommand(session, ["eval",
      "document.querySelectorAll('article > button').length"])))
    if (retainedEntryCount !== 1) throw new Error("Expected one retained dashboard project entry.")
    await browserCommand(session, ["click", "article > button"])
    stage = "retained-project-mount"
    const projectId = z.string().parse(nested(await browserCommand(session, ["eval", `(async()=>await new Promise((resolve,reject)=>{
      let observer;let timer;
      const finish=(id)=>{clearTimeout(timer);observer?.disconnect();id?resolve(id):reject(new Error("Project mount deadline"));};
      const check=()=>{const id=new URL(location.href).searchParams.get('projectId');
        if(id&&document.querySelector('[data-timeline-ruler="1"]')&&document.querySelector('button[aria-label="Play"]'))finish(id);};
      observer=new MutationObserver(check);observer.observe(document,{childList:true,subtree:true,attributes:true});
      timer=setTimeout(()=>finish(null),25000);check();
    }))()`])))
    stage = "canonical-project-reads"
    const capabilities = controlCapabilitiesSchemaV2.parse(await command(profile, ["capabilities-v2", "--target", "host"]))
    capabilitiesDiscovered = capabilities.actionKinds.length > 0
    const projects = z.object({ projects: z.array(z.object({ projectId: z.string() }).passthrough()) }).passthrough()
      .parse(await command(profile, ["project", "list", "--target", "host"]))
    projectDiscovered = projects.projects.some((project) => project.projectId === projectId)
    const snapshot = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
    if (!projectDiscovered || snapshot.project.id !== projectId) throw new Error("Canonical disposable project observation mismatch.")
    const current = projectCurrentResultSchema.parse(await command(profile, ["project", "current", "--target", "host"]))
    if (current.status !== "present" || current.project.projectId !== projectId) throw new Error("Canonical mounted project mismatch.")
    if (snapshot.clips.length !== 1 || snapshot.assets.length !== 1
      || snapshot.assets[0]?.contentSha256 !== "57d9f7da30d4eb884bbd488ace0e5d0d47ead59f38e8dab1c73ca6773523fd57")
      throw new Error("Retained saved mono take mismatch.")
    savedAssetVerified = true
    await record("before-play")
    stage = "playback"
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
    await observeButton(session, 'button[aria-label="Pause"]')
    playbackState = desktopTransportStatusSchemaV1.parse(await command(profile, ["host", "transport-status"])).state
    if (playbackState !== "playing") throw new Error("UI Play did not reach playing transport state.")
    const playing = await record("native-playing")
    if (playing.native.status !== "available" || playing.native.diagnostics.state !== "running"
      || playing.native.diagnostics.installedAssets < 1) throw new Error("Actual native graph playback not established.")
    const progress = await record("native-playing-progress")
    if (progress.native.status !== "available" || progress.native.diagnostics.state !== "running"
      // renderEpoch advances per callback; transportEpoch identifies continuity.
      || progress.native.diagnostics.transportEpoch !== playing.native.diagnostics.transportEpoch
      || progress.native.diagnostics.activeRevision !== playing.native.diagnostics.activeRevision
      || progress.native.diagnostics.callbacks <= playing.native.diagnostics.callbacks)
      throw new Error("Same-active-graph callback progress not established.")
    stage = "stop"
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop"])
    await observeButton(session, 'button[aria-label="Play"]')
    stopState = desktopTransportStatusSchemaV1.parse(await command(profile, ["host", "transport-status"])).state
    if (stopState !== "stopped") throw new Error("UI Stop did not reach stopped transport state.")
    await record("stopped")
    stage = "reload"
    await browserCommand(session, ["reload"])
    await observeButton(session, 'button[aria-label="Play"]')
    const reopened = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
    if (reopened.project.id !== projectId
      || JSON.stringify(reopened.clips) !== JSON.stringify(snapshot.clips)
      || JSON.stringify(reopened.assets) !== JSON.stringify(snapshot.assets))
      throw new Error("Saved project clip or asset not restored after renderer reload.")
    reloadedAssetVerified = true
    const afterReload = await record("after-reload")
    captureFree = afterReload.recording.capturedFrames === null ? null
      : afterReload.recording.transport !== "native-spool" && afterReload.recording.capturedFrames === 0
    stage = "reactivated-playback"
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
    await observeButton(session, 'button[aria-label="Pause"]')
    const reactivated = await record("native-reactivated-playing")
    if (reactivated.native.status !== "available" || reactivated.native.diagnostics.state !== "running"
      || reactivated.native.diagnostics.installedAssets < 1)
      throw new Error("Reactivated native graph playback not established.")
    const reactivatedProgress = await record("native-reactivated-progress")
    if (reactivatedProgress.native.status !== "available"
      || reactivatedProgress.native.diagnostics.state !== "running"
      || reactivatedProgress.native.diagnostics.transportEpoch !== reactivated.native.diagnostics.transportEpoch
      || reactivatedProgress.native.diagnostics.activeRevision !== reactivated.native.diagnostics.activeRevision
      || reactivatedProgress.native.diagnostics.callbacks <= reactivated.native.diagnostics.callbacks)
      throw new Error("Reactivated same-active-graph callback progress not established.")
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop"])
    await observeButton(session, 'button[aria-label="Play"]')
    await record("reactivated-stopped")
    stage = "normal-window-close"
    // Electron window.close() requests the actual BrowserWindow close event, not CDP tab detachment.
    await browserCommand(session, ["eval", "window.close()"]).catch(() => undefined)
    let quitTimer: ReturnType<typeof setTimeout> | undefined
    try {
      // Bounded normal-quit evidence deadline; owned force cleanup is never quit proof.
      normalQuit = await Promise.race([exited, new Promise<null>((resolve) => {
        quitTimer = setTimeout(() => resolve(null), 15000)
      })])
    } finally { clearTimeout(quitTimer) }
    if (!normalQuit || normalQuit.code !== 0 || normalQuit.signal !== null) throw new Error("Normal window-close did not exit cleanly.")
  } catch (cause) {
    error = (cause instanceof Error ? cause.message : String(cause)).replace(/(?:\/Users\/|\/private\/|\/tmp\/)[^\s;,]*/g, "<private-path>").slice(0, 256)
  } finally {
    if (attached && app.exitCode === null && app.signalCode === null && normalQuit === null) {
      // A diagnostic failure still gets a real window-close attempt, not a
      // forced cleanup masquerading as a normal exit.
      await browserCommand(session, ["eval", "window.close()"]).catch(() => undefined)
      let quitTimer: ReturnType<typeof setTimeout> | undefined
      try {
        normalQuit = await Promise.race([exited, new Promise<null>((resolve) => {
          quitTimer = setTimeout(() => resolve(null), 15000)
        })])
      } finally { clearTimeout(quitTimer) }
    }
    if (attached) await browserCommand(session, ["close"]).catch(() => undefined)
    if (app.exitCode === null && app.signalCode === null)
      cleanupFailed = !await stopOwnedSpoolProcesses({ directory: runDirectory, rootPid: appPid, executable })
    await writePrivateArtifact(artifact, JSON.stringify({
      schemaVersion: 2, status: error ? "inconclusive" : "complete", stage, projectDiscovered,
      capabilitiesDiscovered, savedAssetVerified, reloadedAssetVerified, playbackState, stopState, captureFree, phases, nativeDetails,
      // This diagnostic does not collect worker-incident logs; do not certify that gate.
      nativeSampleIntegrityIssues: nativeSamples.length
        ? assessSpoolNativeIntegrity(nativeSamples, 0).filter((issue) => issue !== "native-worker-incident") : null,
      workerIncidentGateObserved: false,
      asarSha256, nativeSha256, normalQuit, cleanupFailed, error,
    }, null, 2))
    console.log(`${error ? "inconclusive" : "complete"}; ${artifact}`)
    if (error || cleanupFailed) process.exitCode = 1
  }
}

if (import.meta.main) await main()
