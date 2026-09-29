#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { browserCommand, waitForBrowserValue } from "../browser-harness"
import { cleanupSurvivors, createCleanupPlan, createPrivateRunDirectory, descendantsOf, verifyElectronLaunchIdentity, electronRendererTarget, writePrivateArtifact } from "./electron"
import { controlCapabilitiesSchemaV2, controlCommitResultSchemaV1, controlPreviewResultSchemaV1, projectSnapshotSchemaV2, type ProjectSnapshotV2 } from "@daw-browser/control"
import { desktopDiagnosticsSchemaV2, desktopHostVstInstancesResultSchemaV1, desktopHostVstParametersResultSchemaV1, desktopTransportStatusSchemaV1 } from "@daw-browser/desktop-protocol"
import { z } from "zod"
import { boundedRendererEvents, summarizeRendererMetrics } from "../../../apps/desktop/quiet-renderer-telemetry"

const root = path.resolve(import.meta.dir, "../../..")
const archive = path.join(root, "tools/performance/fixtures/30-track-v3-native.dawproject")
const executable = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/MacOS/@daw-browser-desktop")
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export const parseControlMode = (option: string | undefined): "idle" | "playback" | "ui" | "paging" | "dsp" | "dsp-soak" | "dsp-one" | "dsp-recording" | "media-recording" | "media-recording-probe" | "media-recording-probe-drop" | "media-recording-probe-drop-no-meters" | "media-recording-probe-metadata" | "media-recording-probe-batch4" | "media-recording-probe-batch8" | "media-recording-portable" | "recording" | "acceptance" => {
  if (option === undefined) return "acceptance"
  if (option === "--idle-control") return "idle"
  if (option === "--playback-control") return "playback"
  if (option === "--ui-control") return "ui"
  if (option === "--paging-control") return "paging"
  if (option === "--dsp-control") return "dsp"
  if (option === "--dsp-soak") return "dsp-soak"
  if (option === "--dsp-one-control") return "dsp-one"
  if (option === "--dsp-recording") return "dsp-recording"
  if (option === "--media-recording") return "media-recording"
  if (option === "--media-recording-probe") return "media-recording-probe"
  if (option === "--media-recording-probe-drop") return "media-recording-probe-drop"
  if (option === "--media-recording-probe-drop-no-meters") return "media-recording-probe-drop-no-meters"
  if (option === "--media-recording-probe-metadata") return "media-recording-probe-metadata"
  if (option === "--media-recording-probe-batch4") return "media-recording-probe-batch4"
  if (option === "--media-recording-probe-batch8") return "media-recording-probe-batch8"
  if (option === "--media-recording-portable") return "media-recording-portable"
  if (option === "--quiet-recording") return "recording"
  throw new Error("Unknown packaged v3 control mode")
}
export const controlDurationMs = (mode: ReturnType<typeof parseControlMode>) => mode === "dsp-soak" ? 300_000 : 60_000
const isDspControlMode = (mode: ReturnType<typeof parseControlMode>) => mode === "dsp" || mode === "dsp-soak" || mode === "dsp-one"
const isMediaRecordingMode = (mode: ReturnType<typeof parseControlMode>) => mode.startsWith("media-recording")
const recordingForwardMode = (mode: ReturnType<typeof parseControlMode>) =>
  mode.startsWith("media-recording-probe-drop") ? "drop"
    : mode === "media-recording-probe-metadata" ? "metadata"
      : mode === "media-recording-probe-batch4" ? "batch4"
        : mode === "media-recording-probe-batch8" ? "batch8" : "full"
export const matchesControlProjectUrl = (url: string, projectId: string) => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "daw:" && parsed.hostname === "app"
      && parsed.searchParams.get("projectId") === projectId
  } catch { return false }
}
type CdpTarget = { id: string; type: string; url: string; webSocketDebuggerUrl?: string }
export const selectedProjectCdpTarget = (targets: readonly CdpTarget[], projectId: string) => {
  const matches = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl
    && matchesControlProjectUrl(target.url, projectId))
  return matches.length === 1 ? matches[0] ?? null : null
}
const probeProjectCdp = async (port: string, projectId: string): Promise<"responsive" | "target-absent" | "endpoint-mismatch" | "deadline" | "evaluation-failed"> => {
  const targets = z.array(z.object({ id: z.string(), type: z.string(), url: z.string(),
    webSocketDebuggerUrl: z.string().optional() }).passthrough()).max(64)
    .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json())
  const target = selectedProjectCdpTarget(targets, projectId)
  if (!target?.webSocketDebuggerUrl) return "target-absent"
  const url = new URL(target.webSocketDebuggerUrl)
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== port) return "endpoint-mismatch"
  return new Promise((resolve) => {
    const socket = new WebSocket(url)
    const deadline = setTimeout(() => { socket.close(); resolve("deadline") }, 3_000)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
      params: { expression: "location.href", returnByValue: true } }))
    socket.onmessage = (event) => {
      try {
        const message = z.object({ id: z.number().optional(), result: z.object({
          result: z.object({ value: z.string().optional() }).passthrough(),
        }).passthrough().optional() }).passthrough().parse(JSON.parse(String(event.data)))
        if (message.id !== 1) return
        clearTimeout(deadline)
        socket.close()
        resolve(matchesControlProjectUrl(message.result?.result.value ?? "", projectId) ? "responsive" : "evaluation-failed")
      } catch { clearTimeout(deadline); socket.close(); resolve("evaluation-failed") }
    }
    socket.onerror = () => { clearTimeout(deadline); socket.close(); resolve("evaluation-failed") }
  })
}
const pingProjectCdp = async (port: string, projectId: string) =>
  (await probeProjectCdp(port, projectId)) === "responsive"
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
export const playbackCountersValid = (
  before: { callbacks: number; rejectedBlocks: number } | null,
  after: { callbacks: number; rejectedBlocks: number },
) => after.callbacks > (before?.callbacks ?? 0) && after.rejectedBlocks === (before?.rejectedBlocks ?? 0)

export const createLaterOffsetPagingRequest = (snapshot: {
  project: { id: string; revision: number }
  assets: readonly { id: string; durationSec?: number }[]
  clips: readonly { id: string; trackId: string; source?: { assetId: string } }[]
}) => {
  const longAssets = snapshot.assets.filter((asset) => asset.durationSec === 600)
  if (longAssets.length !== 1 || !longAssets[0]) throw new Error("Unique 600-second paging source unavailable.")
  const longClips = snapshot.clips.filter((clip) => clip.source?.assetId === longAssets[0]!.id)
  if (longClips.length !== 1 || !longClips[0]) throw new Error("Unique long-media clip unavailable.")
  const clip = longClips[0]
  return {
    version: "v1" as const,
    projectId: snapshot.project.id,
    expectedRevision: snapshot.project.revision,
    actions: [
      {
        kind: "clip.move" as const,
        clip: { source: "persisted" as const, id: clip.id },
        track: { source: "persisted" as const, id: clip.trackId },
        startSec: 540,
      },
      {
        kind: "clip.timing.set" as const,
        clip: { source: "persisted" as const, id: clip.id },
        duration: 60,
        bufferOffsetSec: 540,
      },
    ],
  }
}

export const assertArchiveSnapshot = (value: ProjectSnapshotV2) => {
  if (value.tracks.length !== 30 || value.clips.length !== 30 || value.assets.length !== 24 ||
    countMidiNotes(value.clips) !== 96)
    throw new Error(`V3 semantic mismatch: ${value.tracks.length} tracks, ${value.clips.length} clips, ${value.assets.length} assets, ${countMidiNotes(value.clips)} MIDI notes`)
  return value
}
const prepareFullDsp = async (session: string, profile: string, projectId: string, audioTrackNames: readonly string[], instanceCount: number) => {
  await browserCommand(session, ["eval", "(()=>{const url=new URL(location.href);url.searchParams.set('dashboard','plugins');history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));return true})()"])
  await waitForBrowserValue(session, "document.body.textContent?.includes('VST3 Plug-ins') ? true : null", 30_000)
  await browserCommand(session, ["eval", "(()=>{const input=document.querySelector('input[type=checkbox]');if(!(input instanceof HTMLInputElement))throw new Error('VST3 trust acknowledgement UI unavailable.');input.click();return true})()"])
  await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[role=\"dialog\"] *')].find((e)=>e.textContent?.trim()==='Catalog scan');return row?.parentElement?.textContent?.match(/[1-9]\\d* VST3 bundles? discovered/) ? true : null})()", 60_000)
  await browserCommand(session, ["press", "Escape"])
  await waitForBrowserValue(session, "document.querySelector('[data-timeline-left-browser=\"1\"]') !== null ? true : null", 30_000)
  for (const trackName of audioTrackNames.slice(0, instanceCount)) {
    await browserCommand(session, ["eval", `(()=>{const button=document.querySelector(${JSON.stringify(`button[aria-label="Select track ${audioTrackNames.indexOf(trackName) + 1}: ${trackName}"]`)});if(!(button instanceof HTMLButtonElement))throw new Error('Audio track selection unavailable.');button.click();return true})()`])
    await browserCommand(session, ["eval", "(()=>{const tab=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((button)=>button.textContent?.trim()==='Effects');if(!(tab instanceof HTMLButtonElement))throw new Error('Effects browser tab unavailable.');tab.click();return true})()"])
    for (const name of ["Saturator", "Utility"]) {
      await browserCommand(session, ["fill", "[data-timeline-left-browser='1'] input[type='search']", name])
      await browserCommand(session, ["find", "role", "button", "click", "--name", name])
    }
    await browserCommand(session, ["fill", "[data-timeline-left-browser='1'] input[type='search']", "ValhallaSupermassive"])
    await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((b)=>b.textContent?.trim()==='ValhallaSupermassive');return row && !row.disabled ? true : null})()", 60_000)
    await browserCommand(session, ["find", "role", "button", "click", "--name", "ValhallaSupermassive"])
    await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((b)=>b.textContent?.trim()==='ValhallaSupermassive');return row?.getAttribute('aria-description')?.includes('Enabled · Preflight passed') ? true : null})()", 60_000)
  }
  const snapshot = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
  const processors = snapshot.processors.filter((entry) => entry.processor.kind === "external-vst3"
    && entry.processor.params.identity.name === "ValhallaSupermassive")
  if (processors.length !== instanceCount) throw new Error(`Expected ${instanceCount} trusted VST processors, found ${processors.length}.`)
  const builtInEffects = snapshot.processors.filter((entry) => entry.processor.kind !== "external-vst3")
  if (builtInEffects.length < instanceCount * 2) throw new Error("Built-in DSP effects were not persisted.")
  const first = processors[0]
  if (!first || !("trackId" in first.target)) throw new Error("First VST audio track is missing.")
  const instances = desktopHostVstInstancesResultSchemaV1.parse(await command(profile, ["host", "vst-instances", projectId]))
  const instance = instances.instances.find((item) => item.targetId === first.target.trackId
    && item.identity.classId === first.processor.params.identity.classId)
  if (!instance || instance.health.state !== "ready") throw new Error("First trusted VST worker is not ready.")
  const parameters = desktopHostVstParametersResultSchemaV1.parse(await command(profile, ["host", "vst-parameters", projectId, instance.instanceId]))
  const mix = parameters.parameters.filter((item) => item.title.toLowerCase() === "mix" && !item.readOnly && !item.hidden)
  if (mix.length !== 1 || !mix[0]) throw new Error("Unique writable Mix parameter unavailable.")
  const capabilities = controlCapabilitiesSchemaV2.parse(await command(profile, ["capabilities-v2", "--target", "host"]))
  if (!capabilities.actionKinds.includes("automation.set")) throw new Error("Local automation action not advertised.")
  const request = {
    version: "v1", projectId, expectedRevision: snapshot.project.revision,
    actions: [{ kind: "automation.set",
      target: { kind: "track", track: { source: "persisted", id: first.target.trackId } },
      effect: { source: "persisted", id: first.id },
      parameterId: `vst3:${instance.instanceId}:${mix[0].id}`, enabled: true,
      points: [{ id: "v3-dsp-mix-0", timeSec: 0, value: 0.25, interpolation: "linear" },
        { id: "v3-dsp-mix-4", timeSec: 4, value: 0.75, interpolation: "linear" },
        { id: "v3-dsp-mix-8", timeSec: 8, value: 0.25, interpolation: "linear" }],
    }],
  }
  const preview = controlPreviewResultSchemaV1.parse(await command(profile, ["preview", "--request", "-", "--target", "host"], JSON.stringify(request)))
  if (preview.approval?.required) throw new Error("VST automation unexpectedly requires approval.")
  controlCommitResultSchemaV1.parse(await command(profile, ["commit", "--request", "-", "--target", "host"],
    JSON.stringify({ ...request, idempotencyKey: `v3-dsp-${crypto.randomUUID()}` })))
  const persisted = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
  if (!persisted.automation.some((entry) => entry.effectInstanceId === instance.instanceId
    && entry.parameterId === `vst3:${instance.instanceId}:${mix[0].id}` && entry.enabled && entry.points.length === 3))
    throw new Error("VST Mix automation did not persist.")
  return { processors: processors.length, builtInEffects: builtInEffects.length,
    automatedInstanceId: instance.instanceId, mixParameterId: mix[0].id }
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
const command = async (profile: string, args: string[], input?: string) => {
  const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") }, stdout: "pipe", stderr: "pipe",
    stdin: input === undefined ? "ignore" : "pipe",
  })
  if (input !== undefined && child.stdin) { child.stdin.write(input); child.stdin.end() }
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (await child.exited !== 0) throw new Error(`Control command failed: ${err.slice(0, 500)}`)
  return JSON.parse(out).data
}
const main = async () => {
  const output = Bun.argv[2]
  const mode = parseControlMode(Bun.argv[3])
  const quietRecording = mode === "recording" || mode === "dsp-recording" || isMediaRecordingMode(mode)
  if (!output || !path.isAbsolute(output) || Bun.argv.length > 4)
    throw new Error("Usage: bun v3-import-acceptance.ts <absolute-result-path> [--quiet-recording|--idle-control|--playback-control|--ui-control|--paging-control|--dsp-control|--dsp-soak|--dsp-recording]")
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
  let targetsAfter: { type: string; urlClass: string; original: boolean }[] = []
  const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_BENCHMARK_SAB_RECORDING: quietRecording && mode !== "media-recording-portable" ? "1" : "0",
      DAW_BENCHMARK_QUIET_CAPTURE: mode !== "acceptance" ? "1" : "0",
      DAW_BENCHMARK_HEARTBEAT: mode.includes("media-recording-probe") ? "1" : "0",
      DAW_BENCHMARK_RECORDING_FORWARD_MODE: recordingForwardMode(mode),
      DAW_BENCHMARK_RECORDING_SUPPRESS_CHANNEL: mode === "media-recording-probe-drop-no-meters" ? "meter-batch" : "" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let appOutput = ""
  const collectOutput = (chunk: Buffer) => {
    const text = chunk.toString()
    appOutput = (appOutput + text).slice(-3000)
    const lines = (outputLine + text).split(/\r?\n/)
    outputLine = (lines.pop() ?? "").slice(-512)
    for (const line of lines) {
      if (line.includes("[quiet-capture-lifecycle]") || line.includes("[quiet-capture-native]")
        || line.includes("[quiet-renderer-ping]") || line.includes("[quiet-renderer-pong]")
        || line.includes("[quiet-renderer-block-cost]")
        || line.includes("[quiet-block-sent]") || line.includes("[quiet-block-transit]")
        || line.includes("[quiet-recording-ipc]")
        || line.includes("native audio host closed"))
        lifecycle = (lifecycle + line.slice(0, line.includes("[quiet-recording-ipc]") ? 2048 : 512) + "\n")
          .slice(mode.includes("media-recording-probe") ? -32000 : -4000)
      if (line.startsWith("[quiet-renderer-metric]"))
        metricOutput = (metricOutput + line.slice(0, 512) + "\n").slice(-128_000)
      if (line.startsWith("[quiet-renderer-health]"))
        healthOutput = (healthOutput + line.slice(0, 512) + "\n").slice(-16_000)
    }
  }
  app.stdout?.on("data", collectOutput)
  app.stderr?.on("data", collectOutput)
  if (!app.pid) throw new Error("No Electron PID")
  let plan: ReturnType<typeof createCleanupPlan>
  const telemetry = () => {
    const metrics = metricOutput.split("\n").flatMap((line) => {
      try {
        return [z.object({ elapsedMs: z.number(), epochMs: z.number(), pid: z.number(), renderer: z.boolean(),
          workingSetKiB: z.number(), peakWorkingSetKiB: z.number(), cpuPercent: z.number() })
          .parse(JSON.parse(line.slice("[quiet-renderer-metric] ".length)))]
      } catch { return [] }
    }).filter((metric) => metric.renderer)
    const events = healthOutput.split("\n").flatMap((line) => {
      try {
        return [z.object({ elapsedMs: z.number(), name: z.string(), pid: z.number(),
          urlClass: z.string(), reason: z.string() })
          .parse(JSON.parse(line.slice("[quiet-renderer-health] ".length)))]
      } catch { return [] }
    })
    const startAtMs = metrics.find((metric) => metric.epochMs >= controlStartedAtMs)?.elapsedMs ?? 0
    return { rendererMetrics: summarizeRendererMetrics(metrics, metrics.at(-1)?.pid ?? 0, startAtMs),
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
    if (isDspControlMode(mode) || mode === "dsp-recording") {
      stage = "dsp-setup"
      dspSetup = await prepareFullDsp(session, profile, projectId, snapshot.tracks.filter((track) => track.kind === "audio").map((track) => track.name), mode === "dsp-one" ? 1 : 8)
    }
    const nativeWorkers = async () => {
      const processes = await rows()
      const owned = new Set([app.pid!, ...descendantsOf(processes, app.pid!)])
      return processes.filter((process) => owned.has(process.pid)
        && process.command.includes("/daw-vst3-worker"))
        .map(({ pid, parentPid }) => ({ pid, parentPid }))
    }
    if (mode === "idle") {
      stage = "idle-control"
      controlStartedAtMs = Date.now()
      await delay(60_000)
      stage = "idle-verify"
      const responsive = await pingProjectCdp(new URL(endpoint).port, projectId)
      if (!responsive) throw new Error("Idle project renderer URL changed.")
      await writePrivateArtifact(output, JSON.stringify({ status: "complete", mode, responsive, projectId, lifecycle, tracks: snapshot.tracks.length, ...telemetry() }, null, 2))
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
    await delay(4000)
    const playing = desktopTransportStatusSchemaV1.parse(await command(profile, ["host", "transport-status"]))
    const after = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    if (!isDspControlMode(mode) && mode !== "dsp-recording" && (playing.state !== "playing" || after.native.status !== "available" ||
      !playbackCountersValid(before.native.status === "available" ? before.native.diagnostics : null, after.native.diagnostics)))
      throw new Error(`Playback callbacks missing or native blocks rejected: ${JSON.stringify({
        state: playing.state, before: before.native.status === "available" ? before.native.diagnostics.callbacks : null,
        after: after.native.status === "available" ? after.native.diagnostics.callbacks : null,
        rejected: after.native.status === "available" ? after.native.diagnostics.rejectedBlocks : null,
      })}`)
    if (mode === "playback" || mode === "ui" || mode === "paging" || isDspControlMode(mode)) {
      stage = `${mode}-control`
      controlStartedAtMs = Date.now()
      if (mode === "ui") {
        const uiStress = async () => {
          for (let index = 0; index < 6; index++) {
            const changed = await browserCommand(session, ["eval", `(()=>{const ruler=document.querySelector('[data-timeline-ruler="1"]');const timeline=ruler?.closest('[data-timeline-scroll-container]')??ruler?.parentElement;if(!timeline)return false;timeline.scrollLeft+=${index % 2 === 0 ? 600 : -600};timeline.dispatchEvent(new Event('scroll'));return true})()`])
            if (!changed.includes("true")) throw new Error("Timeline UI stress surface unavailable.")
            await delay(5_000)
          }
        }
        await uiStress()
      }
      await delay(mode === "ui" ? 30_000 : controlDurationMs(mode))
      stage = "playback-verify"
      const responsive = await pingProjectCdp(new URL(endpoint).port, projectId)
      if (!responsive) throw new Error("Playback project renderer URL changed.")
      const vst = isDspControlMode(mode)
        ? desktopHostVstInstancesResultSchemaV1.parse(await command(profile, ["host", "vst-instances", projectId])) : null
      const workerPids = vst ? await nativeWorkers() : []
      let finalNativeCallbacks = after.native.status === "available" ? after.native.diagnostics.callbacks : null
      if (isDspControlMode(mode)) {
        const finalNative = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
        if (finalNative.native.status !== "available"
          || finalNative.native.diagnostics.callbacks <= (before.native.status === "available" ? before.native.diagnostics.callbacks : 0)
          || finalNative.native.diagnostics.rejectedBlocks !== (before.native.status === "available" ? before.native.diagnostics.rejectedBlocks : 0)) {
          throw new Error(`Full DSP playback native health failed: ${JSON.stringify({
            status: finalNative.native.status,
            callbacks: finalNative.native.status === "available" ? finalNative.native.diagnostics.callbacks : null,
          })}`)
        }
        finalNativeCallbacks = finalNative.native.diagnostics.callbacks
      }
      if (vst && vst.instances.filter((instance) => instance.health.state === "ready").length !== dspSetup?.processors)
        throw new Error("Expected live VST instances were not available after measured playback.")
      await writePrivateArtifact(output, JSON.stringify({ status: "complete", mode, responsive, projectId, lifecycle, ...telemetry(), dspSetup, pagingSetup,
        pagingSeek, playing,
        vstInstances: vst?.instances.length ?? 0, workerPids,
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
          controlStartedAtMs = quietStartedAt
          stage = "quiet-wait"
        },
        wait: async () => {
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
          await writePrivateArtifact(path.join(directory, "diagnostic-cdp-latencies.json"), JSON.stringify(probeResults))
        },
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
    await writePrivateArtifact(output, JSON.stringify({ status: "complete", archive, projectId: snapshot.project.id, tracks: snapshot.tracks.length, clips: snapshot.clips.length, assets: snapshot.assets.length, midiNotes: countMidiNotes(snapshot.clips), nativeCallbacksBefore: before.native.status === "available" ? before.native.diagnostics.callbacks : null, nativeCallbacksAfter: after.native.diagnostics.callbacks, rejectedBlocks: after.native.diagnostics.rejectedBlocks - (before.native.status === "available" ? before.native.diagnostics.rejectedBlocks : 0), recording: recordingResult }, null, 2))
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
      originalTargetAlive, cdpError, targetsAfter, reconnectSucceeded, directCdpResponsive, stopPresent, stopSucceeded,
      classification: classifyQuietCapture({
        mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
        rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
        targetFound: targetsAfter.some((target) => target.urlClass === "app"),
        stopPresent, stopSucceeded, rendererFailure: lifecycle.includes("stage=renderer-gone"),
      }),
      lifecycle: lifecycle.slice(mode.includes("media-recording-probe") ? -32000 : -3000),
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
