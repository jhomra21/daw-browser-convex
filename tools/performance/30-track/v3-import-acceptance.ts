#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { browserCommand, waitForBrowserValue } from "../browser-harness"
import { cleanupOwnedRunDirectory, cleanupSurvivors, createCleanupPlan, createPrivateRunDirectory, verifyElectronLaunchIdentity, electronRendererTarget, writePrivateArtifact } from "./electron"
import { controlCommitResultSchemaV1, controlPreviewResultSchemaV1, projectSnapshotSchemaV2 } from "@daw-browser/control"
import { desktopDiagnosticsSchemaV2, desktopHostVstInstancesResultSchemaV1, desktopTransportStatusSchemaV1 } from "@daw-browser/desktop-protocol"
import { z } from "zod"
import { boundedRendererEvents, summarizeRendererMetrics } from "../../../apps/desktop/quiet-renderer-telemetry"
import {
  createNativeProcessCpuSampler,
  fullLoadFrameProbeResultScript,
  fullLoadFrameProbeScript,
  parseBrowserProjectId,
  pingProjectCdp,
  probeProjectCdp,
} from "./v3-import-process"
import {
  assertArchiveSnapshot,
  classifyQuietCapture,
  command,
  countMidiNotes,
  createLaterOffsetPagingRequest,
  deriveActiveClipProject,
  importedProjectTarget,
  playbackCountersValid,
  prepareFullDsp,
  quietCapture,
  recoverQuietTarget,
  runFullLoadUiStress,
  runZoomSweeps,
} from "./v3-import-workload"
export {
  fullLoadFrameProbeResultScript,
  fullLoadFrameProbeScript,
  matchesControlProjectUrl,
  parseBrowserProjectId,
  selectedProjectCdpTarget,
} from "./v3-import-process"
export {
  assertArchiveSnapshot,
  classifyQuietCapture,
  countMidiNotes,
  createLaterOffsetPagingRequest,
  importedProjectTarget,
  playbackCountersValid,
  quietCapture,
  recoverQuietTarget,
} from "./v3-import-workload"

const root = path.resolve(import.meta.dir, "../../..")
const archive = path.join(root, "tools/performance/fixtures/30-track-v3-native.dawproject")
const executable = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/MacOS/@daw-browser-desktop")
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export const parseControlMode = (option: string | undefined): "idle" | "playback" | "ui" | "paging" | "dsp" | "dsp-ui" | "dsp-soak" | "dsp-one" | "dsp-recording" | "dsp-ui-recording" | "zoom-profile" | "zoom-recording-profile" | "vst-reliability" | "media-recording" | "media-recording-probe" | "media-recording-portable" | "recording" | "acceptance" => {
  if (option === undefined) return "acceptance"
  if (option === "--idle-control") return "idle"
  if (option === "--playback-control") return "playback"
  if (option === "--ui-control") return "ui"
  if (option === "--paging-control") return "paging"
  if (option === "--dsp-control") return "dsp"
  if (option === "--dsp-ui-control") return "dsp-ui"
  if (option === "--dsp-soak") return "dsp-soak"
  if (option === "--dsp-one-control") return "dsp-one"
  if (option === "--dsp-recording") return "dsp-recording"
  if (option === "--dsp-ui-recording") return "dsp-ui-recording"
  if (option === "--zoom-profile") return "zoom-profile"
  if (option === "--zoom-recording-profile") return "zoom-recording-profile"
  if (option === "--vst-reliability") return "vst-reliability"
  if (option === "--media-recording") return "media-recording"
  if (option === "--media-recording-probe") return "media-recording-probe"
  if (option === "--media-recording-portable") return "media-recording-portable"
  if (option === "--quiet-recording") return "recording"
  throw new Error("Unknown packaged v3 control mode")
}
export const controlDurationMs = (mode: ReturnType<typeof parseControlMode>) =>
  mode === "dsp-soak" ? 300_000 : mode === "vst-reliability" ? 20_000 : 60_000
const isDspControlMode = (mode: ReturnType<typeof parseControlMode>) => mode === "dsp" || mode === "dsp-ui"
  || mode === "dsp-soak" || mode === "dsp-one" || mode === "zoom-profile" || mode === "vst-reliability"
const isUiStressMode = (mode: ReturnType<typeof parseControlMode>) => mode === "ui" || mode === "dsp-ui"
  || mode === "dsp-ui-recording"
const isMediaRecordingMode = (mode: ReturnType<typeof parseControlMode>) => mode.startsWith("media-recording")
const performanceQuantilesSchema = z.object({
  p50: z.number().finite().nullable(),
  p95: z.number().finite().nullable(),
  p99: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
}).strict()
const performanceThresholdsSchema = z.object({
  over8_33Ms: z.number().int().nonnegative(),
  over16_67Ms: z.number().int().nonnegative(),
  over33_3Ms: z.number().int().nonnegative(),
  over50Ms: z.number().int().nonnegative(),
}).strict()
const fullLoadFramePerformanceSchema = z.object({
  display: z.object({
    refreshRateHz: z.number().finite().positive().nullable(),
    viewportWidth: z.number().int().positive(),
    viewportHeight: z.number().int().positive(),
    devicePixelRatio: z.number().finite().positive(),
  }).strict(),
  raf: z.object({
    sampleCount: z.number().int().nonnegative(),
    intervalsMs: performanceQuantilesSchema,
  }).strict(),
  applicationWork: z.object({
    sampleCount: z.number().int().nonnegative(),
    durationMs: performanceQuantilesSchema,
    thresholds: performanceThresholdsSchema,
  }).strict(),
  longTasks: z.object({
    supported: z.boolean(),
    count: z.number().int().nonnegative().nullable(),
    totalDurationMs: z.number().finite().nonnegative().nullable(),
    maxDurationMs: z.number().finite().nonnegative().nullable(),
  }).strict(),
  droppedSamples: z.object({
    raf: z.number().int().nonnegative(),
    applicationWork: z.number().int().nonnegative(),
    longTasks: z.number().int().nonnegative(),
  }).strict(),
  attribution: z.object({
    phases: z.array(z.object({
      name: z.string().min(1).max(80),
      startTime: z.number().finite(),
      endTime: z.number().finite().nullable(),
    }).strict()).max(256),
    longFrames: z.array(z.object({
      startTime: z.number().finite(),
      duration: z.number().finite().nonnegative(),
      phase: z.string().min(1).max(80),
      owner: z.string().min(1).max(80),
      scriptDuration: z.number().finite().nonnegative().nullable(),
      renderDuration: z.number().finite().nonnegative().nullable(),
      styleAndLayoutDuration: z.number().finite().nonnegative().nullable(),
      forcedStyleAndLayoutDuration: z.number().finite().nonnegative().nullable(),
      source: z.string().max(160).nullable(),
      functionName: z.string().max(120).nullable(),
    }).strict()).max(256),
    counters: z.record(z.string(), z.number().finite().nonnegative()),
    durations: z.record(z.string(), z.object({
      count: z.number().int().nonnegative(),
      totalMs: z.number().finite().nonnegative(),
      p95Ms: z.number().finite().nonnegative().nullable(),
      maxMs: z.number().finite().nonnegative().nullable(),
    }).strict()),
    droppedLongFrames: z.number().int().nonnegative(),
  }).strict(),
}).strict()

const main = async () => {
  const output = Bun.argv[2]
  const mode = parseControlMode(Bun.argv[3])
  const profileScale = Bun.argv[4] === undefined ? undefined : z.coerce.number().int().parse(Bun.argv[4])
  const zoomVisibleClipLimit = mode === "vst-reliability"
    ? 30
    : profileScale === undefined ? 30 : z.number().int().min(10).max(30).parse(profileScale)
  const reliabilityVstCount = mode === "vst-reliability"
    ? z.number().int().min(0).max(8).parse(profileScale ?? 8)
    : 8
  const reliabilityStress = mode === "vst-reliability" && Bun.argv[5] === "zoom"
  const quietRecording = mode === "recording" || mode === "dsp-recording" || mode === "dsp-ui-recording"
    || mode === "zoom-recording-profile"
    || isMediaRecordingMode(mode)
  if (!output || !path.isAbsolute(output) || Bun.argv.length > (mode === "vst-reliability" ? 6 : 5))
    throw new Error("Usage: bun v3-import-acceptance.ts <absolute-result-path> [--quiet-recording|--idle-control|--playback-control|--ui-control|--paging-control|--dsp-control|--dsp-ui-control|--dsp-soak|--dsp-recording|--dsp-ui-recording]")
  if ((await stat(archive)).size < 773_000_000) throw new Error("Unexpected v3 archive size")
  await stat(path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/Resources/app.asar"))
  const directory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(directory, "profile")
  const diagnosticDirectory = `${output}.diagnostics`
  await mkdir(diagnosticDirectory, { recursive: true, mode: 0o700 })
  await mkdir(profile, { mode: 0o700 })
  const session = `daw-30-track-electron-v3-${crypto.randomUUID()}`
  let stage = "launch"
  let attached = false
  let endpoint = ""
  let originalTarget = ""
  let quietStartedAt = 0
  let quietElapsedMs = 0
  let recordingZoomProfile: Awaited<ReturnType<typeof runZoomSweeps>> | null = null
  let beforeCaptureProcesses: Awaited<ReturnType<typeof rows>> = []
  let afterCaptureProcesses: Awaited<ReturnType<typeof rows>> = []
  let originalTargetAlive: boolean | null = null
  let reconnectSucceeded = false
  let directCdpResponsive: boolean | null = null
  let stopPresent: boolean | null = null
  let stopSucceeded = false
  let lifecycle = ""
  let metricOutput = ""
  let healthOutput = ""
  let outputLine = ""
  let controlStartedAtMs = 0
  let rendererPid = 0
  let cdpError: string | null = null
  let interruptedSignal: NodeJS.Signals | null = null
  let targetsAfter: { type: string; urlClass: string; original: boolean }[] = []
  let nativeProcessCpuSampler: Awaited<ReturnType<typeof createNativeProcessCpuSampler>> | null = null
  const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_BENCHMARK_SAB_RECORDING: quietRecording && mode !== "media-recording-portable" ? "1" : "0",
      DAW_BENCHMARK_QUIET_CAPTURE: mode !== "acceptance" ? "1" : "0",
      DAW_BENCHMARK_ZOOM_PROFILE: mode === "zoom-profile" || mode === "zoom-recording-profile" ? "1" : "0",
      DAW_BENCHMARK_HEARTBEAT: mode.includes("media-recording-probe") ? "1" : "0",
}, detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let appOutput = ""
  const collectOutput = (chunk: Buffer) => {
    const text = chunk.toString()
    appOutput = (appOutput + text).slice(-3000)
    const lines = (outputLine + text).split(/\r?\n/)
    outputLine = (lines.pop() ?? "").slice(-512)
    for (const line of lines) {
      if (line.includes("[quiet-capture-lifecycle]") || line.includes("[quiet-capture-native]")
        || line.includes("[native-vst3] native audio host lost")
        || line.includes("[quiet-renderer-ping]") || line.includes("[quiet-renderer-pong]")
        || line.includes("[quiet-renderer-block-cost]")
        || line.includes("[quiet-recording-ipc]")
        || line.includes("native audio host closed"))
        lifecycle = (lifecycle + line.slice(0, line.includes("[quiet-recording-ipc]") ? 2048 : 512) + "\n")
          .slice(-32000)
      if (line.startsWith("[quiet-renderer-metric]"))
        metricOutput = (metricOutput + line.slice(0, 512) + "\n").slice(-128_000)
      if (line.startsWith("[quiet-renderer-health]"))
        healthOutput = (healthOutput + line.slice(0, 512) + "\n").slice(-16_000)
    }
  }
  app.stdout?.on("data", collectOutput)
  app.stderr?.on("data", collectOutput)
  app.on("exit", (code, signal) => {
    lifecycle = (lifecycle + `[quiet-capture-lifecycle] stage=main-exit code=${code ?? "null"} signal=${signal ?? "null"}\n`).slice(-32_000)
  })
  if (!app.pid) throw new Error("No Electron PID")
  let plan: ReturnType<typeof createCleanupPlan> | undefined
  let cleanupPromise: Promise<Awaited<ReturnType<typeof cleanupOwnedRunDirectory>>> | null = null
  const cleanupRun = () => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      if (attached) await browserCommand(session, ["close"]).catch(() => undefined)
      const current = await rows()
      const owned = current.find((row) => row.pid === app.pid && row.command.includes(executable)
        && row.command.includes(`--user-data-dir=${profile}`))
      const ownedPlan = plan ?? (owned ? createCleanupPlan(current, app.pid) : undefined)
      if (owned && ownedPlan?.processGroupId === owned.processGroupId && ownedPlan.processGroupId !== process.pid) {
        process.kill(-ownedPlan.processGroupId, "SIGTERM")
        await delay(1000)
        for (const pid of cleanupSurvivors(ownedPlan, await rows())) process.kill(pid, "SIGKILL")
      }
      return cleanupOwnedRunDirectory(directory, await rows())
    })()
    return cleanupPromise
  }
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedSignal = signal
    void cleanupRun().then((cleanup) => {
      if (!cleanup.removed) {
        const cleanupPath = `${output}.cleanup.json`
        return writePrivateArtifact(cleanupPath, JSON.stringify({ cleanup, interruptedSignal }, null, 2))
      }
    }).finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)))
  }
  const interruptSigint = () => interrupt("SIGINT")
  const interruptSigterm = () => interrupt("SIGTERM")
  process.once("SIGINT", interruptSigint)
  process.once("SIGTERM", interruptSigterm)
  const telemetry = () => {
    const metrics = metricOutput.split("\n").flatMap((line) => {
      try {
        return [z.object({ elapsedMs: z.number(), epochMs: z.number(), pid: z.number(), renderer: z.boolean(),
          type: z.string(),
          workingSetKiB: z.number(), peakWorkingSetKiB: z.number(),
          privateKiB: z.number().nullable(), cpuPercent: z.number() })
          .parse(JSON.parse(line.slice("[quiet-renderer-metric] ".length)))]
      } catch { return [] }
    })
    const rendererMetrics = metrics.filter((metric) => metric.renderer)
    const events = healthOutput.split("\n").flatMap((line) => {
      try {
        return [z.object({ elapsedMs: z.number(), name: z.string(), pid: z.number(),
          urlClass: z.string(), reason: z.string() })
          .parse(JSON.parse(line.slice("[quiet-renderer-health] ".length)))]
      } catch { return [] }
    })
    const startAtMs = rendererMetrics.find((metric) => metric.epochMs >= controlStartedAtMs)?.elapsedMs ?? 0
    return { rendererMetrics: summarizeRendererMetrics(rendererMetrics, rendererMetrics.at(-1)?.pid ?? 0, startAtMs),
      rendererEvents: boundedRendererEvents(events), rendererSamples: metrics.slice(-120) }
  }
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
    if (process.env.DAW_BENCHMARK_FORCE_FAILURE === "after-launch") {
      throw new Error("Forced benchmark failure after verified launch.")
    }
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
    let snapshot = assertArchiveSnapshot(projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"])))
    if (mode === "zoom-profile" || mode === "zoom-recording-profile") {
      snapshot = await deriveActiveClipProject(profile, snapshot, zoomVisibleClipLimit)
    }
    const recoverRendererTarget = async () => {
      await browserCommand(session, ["connect", endpoint])
      const candidate = importedProjectTarget(await browserCommand(session, ["tab"]), projectId)
      if (!candidate) throw new Error("Verified app target unavailable after renderer recovery.")
      await browserCommand(session, ["tab", candidate])
      await waitForBrowserValue(session,
        `new URL(location.href).searchParams.get("projectId")===${JSON.stringify(projectId)}`,
        30_000)
      await waitForBrowserValue(session, "document.readyState==='complete'", 30_000)
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const diagnostics = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
        if (diagnostics.native.status === "available") {
          await delay(250)
          const stable = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
          if (stable.native.status === "available") break
        }
        if (attempt === 119) throw new Error("Native audio host did not recover after renderer recovery.")
        await delay(250)
      }
      await browserCommand(session, ["eval", fullLoadFrameProbeScript()])
      await waitForBrowserValue(session, "Boolean(window.__dawFullLoadFrameProbe)", 30_000)
      originalTarget = candidate
    }
    let pagingSetup: { clipId: string; timelineStartSec: number; sourceOffsetSec: number; durationSec: number } | null = null
    if (mode === "paging") {
      stage = "paging-setup"
      const request = createLaterOffsetPagingRequest(snapshot)
      const preview = controlPreviewResultSchemaV1.parse(await command(
        profile,
        ["preview", "--request", "-", "--target", "host"],
        JSON.stringify(request),
      ))
      if (preview.approval?.required) throw new Error("Later-offset paging setup unexpectedly requires approval.")
      controlCommitResultSchemaV1.parse(await command(
        profile,
        ["commit", "--request", "-", "--target", "host"],
        JSON.stringify({ ...request, idempotencyKey: `v3-paging-${crypto.randomUUID()}` }),
      ))
      const moved = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
      const clipId = request.actions[0].clip.id
      const clip = moved.clips.find((entry) => entry.id === clipId)
      if (!clip || clip.startSec !== 540 || clip.bufferOffsetSec !== 540 || clip.duration !== 60) {
        throw new Error("Later-offset paging clip did not persist.")
      }
      pagingSetup = { clipId, timelineStartSec: 540, sourceOffsetSec: 540, durationSec: 60 }
    }
    if (isMediaRecordingMode(mode)) {
      stage = "media-only-setup"
      for (let index = 25; index <= 30; index++) {
        await browserCommand(session, ["eval", `(()=>{const button=document.querySelector('button[aria-label="Deactivate track ${index}"]');if(!(button instanceof HTMLButtonElement))throw new Error('MIDI track mute control unavailable.');button.click();return true})()`])
      }
      const muted = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
      if (muted.tracks.filter((track) => track.kind === "instrument" && track.muted).length !== 6)
        throw new Error("Six MIDI tracks were not muted for media-only recording.")
    }
    let dspSetup: Awaited<ReturnType<typeof prepareFullDsp>> | null = null
    if (mode === "idle" || isDspControlMode(mode) || mode === "dsp-recording" || mode === "dsp-ui-recording"
      || mode === "zoom-recording-profile") {
      stage = "dsp-setup"
      const instanceCount = mode === "dsp-one" ? 1 : mode === "vst-reliability" ? reliabilityVstCount : 8
      if (instanceCount > 0) {
        dspSetup = await prepareFullDsp(session, profile, projectId,
          snapshot.tracks.filter((track) => track.kind === "audio").map((track) => track.name), instanceCount,
          mode !== "vst-reliability" || process.env.DAW_BENCHMARK_VST_AUTOMATION === "1")
      }
    }
    if (mode === "idle") {
      stage = "idle-control"
      controlStartedAtMs = Date.now()
      nativeProcessCpuSampler = await createNativeProcessCpuSampler(app.pid, 60_000, false)
      await delay(60_000)
      stage = "idle-verify"
      const responsive = await pingProjectCdp(new URL(endpoint).port, projectId)
      if (!responsive) throw new Error("Idle project renderer URL changed.")
      const diagnostics = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
      const nativeProcessCpu = await nativeProcessCpuSampler.stop()
      await writePrivateArtifact(output, JSON.stringify({
        status: "complete", mode, responsive, projectId, lifecycle, tracks: snapshot.tracks.length,
        dspSetup, workerPids: nativeProcessCpu.workers, nativeProcessCpu,
        realtimePerformance: diagnostics.native.status === "available"
          ? diagnostics.native.diagnostics.realtimePerformance ?? null : null,
        vstWorkerPerformance: diagnostics.native.status === "available"
          ? diagnostics.native.diagnostics.vstWorkerPerformance ?? null : null,
        ...telemetry(),
      }, null, 2))
      return
    }
    stage = "playback"
    await browserCommand(session, ["reload"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Play\"]') && !document.querySelector('[role=\"dialog\"]') ? true : null", 60_000)
    const pagingSeek = mode === "paging"
      ? desktopTransportStatusSchemaV1.parse(await command(profile, ["host", "seek", "540"]))
      : null
    if (pagingSeek && pagingSeek.playheadSec !== 540) throw new Error("Later-offset transport seek was not applied.")
    const before = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Pause\"]') ? true : null", 30000)
    await delay(mode === "vst-reliability" ? 500 : 4000)
    const playing = desktopTransportStatusSchemaV1.parse(await command(profile, ["host", "transport-status"]))
    const after = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    if (!isDspControlMode(mode) && mode !== "dsp-recording" && mode !== "dsp-ui-recording"
      && mode !== "zoom-recording-profile"
      && (playing.state !== "playing" || after.native.status !== "available" ||
      !playbackCountersValid(before.native.status === "available" ? before.native.diagnostics : null, after.native.diagnostics)))
      throw new Error(`Playback callbacks missing or native blocks rejected: ${JSON.stringify({
        state: playing.state, before: before.native.status === "available" ? before.native.diagnostics.callbacks : null,
        after: after.native.status === "available" ? after.native.diagnostics.callbacks : null,
        rejected: after.native.status === "available" ? after.native.diagnostics.rejectedBlocks : null,
      })}`)
    if (mode === "playback" || mode === "ui" || mode === "paging" || isDspControlMode(mode)) {
      stage = `${mode}-control`
      let framePerformance: z.infer<typeof fullLoadFramePerformanceSchema> | null = null
      let zoomProfile: Awaited<ReturnType<typeof runZoomSweeps>> | null = null
      const transportDrift: { elapsedMs: number; transportFrame: string; expectedFrame: string; errorFrames: string }[] = []
      const transportBaseline = mode === "dsp-soak"
        ? desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"])) : null
      if (isUiStressMode(mode) || mode === "zoom-profile" || reliabilityStress) {
        await browserCommand(session, ["eval", fullLoadFrameProbeScript()])
        if (reliabilityStress) zoomProfile = await runZoomSweeps(session, snapshot.clips.length, recoverRendererTarget)
        else await runFullLoadUiStress(session, snapshot, dspSetup)
        if (isDspControlMode(mode)) {
          for (let attempt = 0; attempt < 60; attempt++) {
            const recovered = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
            if (recovered.native.status === "available"
              && BigInt(recovered.native.diagnostics.realtimePerformance?.observationCount ?? "0") > 0n) break
            if (attempt === 59) throw new Error("Native playback did not recover after UI interactions.")
            await delay(250)
          }
        }
      }
      nativeProcessCpuSampler = await createNativeProcessCpuSampler(
        app.pid,
        controlDurationMs(mode),
        true,
        (timestamp) => { controlStartedAtMs = timestamp },
      )
      if (mode === "zoom-profile") {
        await browserCommand(session, ["eval", fullLoadFrameProbeScript()])
        zoomProfile = await runZoomSweeps(session, snapshot.clips.length, recoverRendererTarget)
      }
      if (mode === "dsp-soak" && transportBaseline?.native.status === "available"
        && transportBaseline.native.diagnostics.transportFrame !== undefined) {
        const startFrame = BigInt(transportBaseline.native.diagnostics.transportFrame)
        for (const targetMs of [10_000, 60_000, 300_000]) {
          const remainingMs = targetMs - (Date.now() - controlStartedAtMs)
          if (remainingMs > 0) await delay(remainingMs)
          const checkpoint = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
          if (checkpoint.native.status !== "available"
            || checkpoint.native.diagnostics.transportFrame === undefined) {
            throw new Error("Native transport drift checkpoint unavailable.")
          }
          const elapsedMs = Date.now() - controlStartedAtMs
          const transportFrame = BigInt(checkpoint.native.diagnostics.transportFrame)
          const sampleRate = BigInt(checkpoint.native.diagnostics.realtimePerformance?.sampleRateHz ?? 0)
          const expectedFrame = startFrame + BigInt(Math.round(elapsedMs)) * sampleRate / 1_000n
          transportDrift.push({
            elapsedMs,
            transportFrame: transportFrame.toString(),
            expectedFrame: expectedFrame.toString(),
            errorFrames: (transportFrame - expectedFrame).toString(),
          })
        }
      } else {
        const remainingMs = controlDurationMs(mode) - (Date.now() - controlStartedAtMs)
        if (remainingMs > 0) await delay(remainingMs)
      }
      if (isUiStressMode(mode) || mode === "zoom-profile" || reliabilityStress) {
        framePerformance = fullLoadFramePerformanceSchema.parse(
          JSON.parse(JSON.parse(await browserCommand(session, ["eval", `JSON.stringify(${fullLoadFrameProbeResultScript()})`]))),
        )
      }
      stage = "playback-verify"
      const nativeProcessCpu = await nativeProcessCpuSampler.stop()
      const responsive = await pingProjectCdp(new URL(endpoint).port, projectId)
      if (!responsive) throw new Error("Playback project renderer URL changed.")
      const vst = isDspControlMode(mode)
        ? desktopHostVstInstancesResultSchemaV1.parse(await command(profile, ["host", "vst-instances", projectId])) : null
      const workerPids = nativeProcessCpu.workers
      let finalNativeCallbacks = after.native.status === "available" ? after.native.diagnostics.callbacks : null
      let realtimePerformance = after.native.status === "available"
        ? after.native.diagnostics.realtimePerformance ?? null : null
      let vstWorkerPerformance = after.native.status === "available"
        ? after.native.diagnostics.vstWorkerPerformance ?? null : null
      let transportFrame = after.native.status === "available"
        ? after.native.diagnostics.transportFrame ?? null : null
      if (isDspControlMode(mode)) {
        let finalNative = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
        for (let attempt = 0; finalNative.native.status !== "available" && attempt < 20; attempt += 1) {
          await delay(250)
          finalNative = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
        }
        if (finalNative.native.status !== "available"
          || BigInt(finalNative.native.diagnostics.realtimePerformance?.observationCount ?? "0") === 0n
          || finalNative.native.diagnostics.rejectedBlocks !== 0) {
          throw new Error(`Full DSP playback native health failed: ${JSON.stringify({
            status: finalNative.native.status,
            callbacks: finalNative.native.status === "available" ? finalNative.native.diagnostics.callbacks : null,
          })}`)
        }
        finalNativeCallbacks = finalNative.native.diagnostics.callbacks
        realtimePerformance = finalNative.native.diagnostics.realtimePerformance ?? null
        vstWorkerPerformance = finalNative.native.diagnostics.vstWorkerPerformance ?? null
        transportFrame = finalNative.native.diagnostics.transportFrame ?? null
        if (!realtimePerformance || !vstWorkerPerformance
          || BigInt(realtimePerformance.deadlineMisses) !== 0n
          || BigInt(vstWorkerPerformance.deadlineMisses) !== 0n
          || BigInt(vstWorkerPerformance.watchdogMisses) !== 0n
          || BigInt(vstWorkerPerformance.faults) !== 0n
          || BigInt(vstWorkerPerformance.restarts) !== 0n) {
          throw new Error("Full DSP realtime deadline health failed.")
        }
      }
      if (nativeProcessCpu.status === "available" && nativeProcessCpu.generations.length > 1
        && (!vstWorkerPerformance
          || BigInt(vstWorkerPerformance.faults) !== 0n
          || BigInt(vstWorkerPerformance.restarts) !== 0n)) {
        nativeProcessCpu.status = "blocked"
        nativeProcessCpu.reason = "Native process generations changed while worker fault or restart counters were nonzero."
      }
      const expectedReadyVstWorkers = mode === "vst-reliability" ? reliabilityVstCount : dspSetup?.processors
      if (vst && vst.instances.filter((instance) => instance.health.state === "ready").length !== expectedReadyVstWorkers)
        throw new Error("Expected live VST instances were not available after measured playback.")
      await writePrivateArtifact(output, JSON.stringify({ status: "complete", mode, responsive, projectId, lifecycle,
        ...telemetry(), dspSetup, pagingSetup,
        framePerformance,
        zoomSweeps: zoomProfile?.gestures ?? [],
        zoomMemoryCheckpoints: zoomProfile?.memoryCheckpoints ?? [],
        transportDrift,
        pagingSeek, playing,
        transportFrame, realtimePerformance, vstWorkerPerformance,
        vstInstances: vst?.instances.length ?? 0, workerPids, nativeProcessCpu,
        rejectedBlocks: after.native.status === "available" ? after.native.diagnostics.rejectedBlocks
          - (before.native.status === "available" ? before.native.diagnostics.rejectedBlocks : 0) : null,
        nativeCallbacksBefore: before.native.status === "available" ? before.native.diagnostics.callbacks : null,
        nativeCallbacksAfter: finalNativeCallbacks }, null, 2))
      return
    }
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
      await writePrivateArtifact(path.join(diagnosticDirectory, "quiet-identity.json"), JSON.stringify({
        mainPid: app.pid, rendererPid, processGroupId: plan.processGroupId,
        webContentsId: Number(/stage=created webContentsId=(\d+)/.exec(lifecycle)?.[1] ?? 0),
        targetId: originalTarget, profile, port: new URL(endpoint).port,
        owned: beforeCaptureProcesses.filter((row) => plan.recordedProcesses.some((entry) => entry.pid === row.pid))
          .map(({ pid, parentPid }) => ({ pid, parentPid })),
      }))
      if (mode === "dsp-ui-recording" || mode === "zoom-recording-profile") {
        await command(profile, ["host", "stop"])
        await command(profile, ["host", "seek", "0"])
      }
      await quietCapture({
        start: async () => {
          stage = "quiet-start"
          await browserCommand(session, ["eval", "window.__dawPerformancePhase?.('recording-start',true)??true"])
          await browserCommand(session, ["find", "role", "button", "click", "--name", "Start recording"])
          await browserCommand(session, ["eval", "window.__dawPerformancePhase?.('recording-start',false)??true"])
          quietStartedAt = Date.now()
          controlStartedAtMs = quietStartedAt
          stage = "quiet-wait"
        },
        wait: async () => {
          if (mode === "dsp-ui-recording" || mode === "zoom-recording-profile") {
            await browserCommand(session, ["eval", fullLoadFrameProbeScript()])
            if (mode === "zoom-recording-profile") recordingZoomProfile = await runZoomSweeps(session, snapshot.clips.length)
            else await runFullLoadUiStress(session, snapshot, dspSetup, true)
            const remainingMs = 61_000 - (Date.now() - quietStartedAt)
            if (remainingMs > 0) await delay(remainingMs)
            return
          }
          if (!mode.includes("media-recording-probe")) return delay(61_000)
          const probeResults: { elapsedMs: number; result: string; latencyMs: number }[] = []
          for (let index = 0; index < 12; index++) {
            await delay(5_000)
            const started = performance.now()
            let result: string
            try { result = await probeProjectCdp(new URL(endpoint).port, projectId) }
            catch { result = "evaluation-failed" }
            probeResults.push({ elapsedMs: Date.now() - quietStartedAt, result,
              latencyMs: Math.round(performance.now() - started) })
          }
          await writePrivateArtifact(path.join(diagnosticDirectory, "diagnostic-cdp-latencies.json"), JSON.stringify(probeResults))
        },
        stop: async () => {
          stage = "quiet-stop"
          await browserCommand(session, ["eval", "window.__dawPerformancePhase?.('recording-stop',true)??true"])
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
          await writePrivateArtifact(path.join(diagnosticDirectory, "quiet-after-wait.json"), JSON.stringify({
            elapsedMs: quietElapsedMs,
            mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
            rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
            originalTargetAlive, cdpError, targetsAfter,
            lifecycle: lifecycle.slice(-2000),
          }))
          let directProbe: Awaited<ReturnType<typeof probeProjectCdp>>
          try { directProbe = await probeProjectCdp(port, projectId) }
          catch { directProbe = "evaluation-failed" }
          directCdpResponsive = directProbe === "responsive"
          cdpError = directProbe === "responsive" ? null : directProbe
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
          await browserCommand(session, ["eval", "window.__dawPerformancePhase?.('recording-stop',false)??true"])
          stage = "quiet-observe"
        },
        observe: async () => {
          const completed = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
          let persisted = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
          // The recording clip commit follows writer finalization asynchronously; bound observation to ten seconds.
          for (let attempt = 0; attempt < 40 && persisted.clips.length === snapshot.clips.length; attempt++) {
            await delay(250)
            persisted = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
          }
          const newClips = persisted.clips.filter((clip) => !snapshot.clips.some((previous) => previous.id === clip.id)
            && clip.trackId === audioTrack.id && clip.source?.sourceKind === "recording")
          const capturedFrames = (completed.recording.capturedFrames ?? 0) - (recordingBefore.recording.capturedFrames ?? 0)
          const realtimePerformance = completed.native.status === "available"
            ? completed.native.diagnostics.realtimePerformance ?? null : null
          const vstWorkerPerformance = completed.native.status === "available"
            ? completed.native.diagnostics.vstWorkerPerformance ?? null : null
          if (performance.now() - started < 60_000 || capturedFrames < 58 * (completed.recording.activeSampleRate ?? 0)
            || !completed.recording.activeSampleRate || completed.recording.droppedFrames !== 0
            || completed.recording.overrunFrames !== 0 || completed.recording.lastFailurePresent
            || ((mode === "dsp-ui-recording" || mode === "zoom-recording-profile")
              && (!realtimePerformance || !vstWorkerPerformance
              || BigInt(realtimePerformance.deadlineMisses) !== 0n
              || BigInt(vstWorkerPerformance.deadlineMisses) !== 0n
              || BigInt(vstWorkerPerformance.watchdogMisses) !== 0n
              || BigInt(vstWorkerPerformance.faults) !== 0n || BigInt(vstWorkerPerformance.restarts) !== 0n))
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
            clipId: newClips[0]?.id, writerTiming: completed.recording.writerTiming,
            transportFrame: completed.native.status === "available"
              ? completed.native.diagnostics.transportFrame ?? null : null,
            realtimePerformance, vstWorkerPerformance,
            zoomSweeps: recordingZoomProfile?.gestures ?? [],
            zoomMemoryCheckpoints: recordingZoomProfile?.memoryCheckpoints ?? [],
            framePerformance: mode === "dsp-ui-recording" || mode === "zoom-recording-profile"
              ? fullLoadFramePerformanceSchema.parse(JSON.parse(JSON.parse(await browserCommand(
                session,
                ["eval", `JSON.stringify(${fullLoadFrameProbeResultScript()})`],
              )))) : null }
        },
      })
    }
    await command(profile, ["host", "stop"])
    await mkdir(path.dirname(output), { recursive: true })
    await writePrivateArtifact(output, JSON.stringify({ status: "complete", archive, projectId: snapshot.project.id, tracks: snapshot.tracks.length, clips: snapshot.clips.length, assets: snapshot.assets.length, midiNotes: countMidiNotes(snapshot.clips), nativeCallbacksBefore: before.native.status === "available" ? before.native.diagnostics.callbacks : null, nativeCallbacksAfter: after.native.status === "available" ? after.native.diagnostics.callbacks : null, rejectedBlocks: after.native.status === "available" ? after.native.diagnostics.rejectedBlocks - (before.native.status === "available" ? before.native.diagnostics.rejectedBlocks : 0) : null, recording: recordingResult }, null, 2))
  } catch (error) {
    await mkdir(path.dirname(output), { recursive: true })
    let samplePath: string | null = null
    if (quietElapsedMs >= 60_000 && rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid)) {
      const sample = Bun.spawn(["sample", String(rendererPid), "5", "-file", path.join(diagnosticDirectory, "quiet-renderer-sample.txt")], {
        stdout: "ignore", stderr: "pipe",
      })
      await Promise.race([sample.exited, delay(8_000)])
      if (sample.exitCode === null) sample.kill()
      if (sample.exitCode === 0) samplePath = path.join(diagnosticDirectory, "quiet-renderer-sample.txt")
    }
    await writePrivateArtifact(output, JSON.stringify({
      status: "failed", stage, error: String(error),
      quietCaptureStarted: quietStartedAt > 0, quietCaptureElapsedMs: quietElapsedMs,
      processesBefore: beforeCaptureProcesses.filter((row) => plan?.recordedProcesses.some((entry) => entry.pid === row.pid)).map(({ pid, parentPid, processGroupId }) => ({ pid, parentPid, processGroupId })),
      processesAfter: afterCaptureProcesses.filter((row) => plan?.recordedProcesses.some((entry) => entry.pid === row.pid)).map(({ pid, parentPid, processGroupId }) => ({ pid, parentPid, processGroupId })),
      mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
      rendererPid, rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
      originalTargetAlive, cdpError, targetsAfter, reconnectSucceeded, directCdpResponsive, stopPresent, stopSucceeded,
      classification: classifyQuietCapture({
        mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
        rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
        targetFound: targetsAfter.some((target) => target.urlClass === "app"),
        stopPresent, stopSucceeded, rendererFailure: lifecycle.includes("stage=renderer-gone"),
      }),
      lifecycle: lifecycle.slice(-32000),
      zoomSweeps: recordingZoomProfile?.gestures ?? [],
      zoomMemoryCheckpoints: recordingZoomProfile?.memoryCheckpoints ?? [],
      ...telemetry(),
      samplePath,
      postmortem: await command(profile, ["host", "diagnostics-v2"]).catch(() => null),
      host: await command(profile, ["host", "status"]).catch(() => null),
      rendererProjectId: attached ? await browserCommand(session, ["eval", "new URL(location.href).searchParams.get('projectId')"]).catch(() => null) : null,
      rendererSnapshot: attached ? (await browserCommand(session, ["snapshot", "-c"]).catch(() => "")).slice(0, 6000) : null,
      dialogHtml: attached ? (await browserCommand(session, ["eval", "document.querySelector('[role=\"dialog\"]')?.outerHTML.slice(0, 5000) ?? null"]).catch(() => "")).slice(0, 5500) : null,
    }, null, 2))
    throw error
  } finally {
    process.off("SIGINT", interruptSigint)
    process.off("SIGTERM", interruptSigterm)
    const cleanup = await cleanupRun()
    if (!cleanup.removed) {
      const cleanupPath = `${output}.cleanup.json`
      await writePrivateArtifact(cleanupPath, JSON.stringify({ cleanup, interruptedSignal }, null, 2)).catch(() => undefined)
      console.error(`Benchmark profile cleanup failed; diagnostic: ${cleanupPath}`)
      process.exitCode = 1
    }
    if (interruptedSignal) process.exitCode = 128 + (interruptedSignal === "SIGINT" ? 2 : 15)
  }
}
if (import.meta.main) await main()
