import type {
  App,
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from "electron"
import type { NativeHostRecordingBlock, NativeHostRecordingStatus } from "@daw-browser/audio-engine/native-host-wire"
import { benchmarkLoadFailure, benchmarkStartupStage } from "./benchmark-startup-stage"
import { classifyNavigationUrl } from "./quiet-renderer-telemetry"
import {
  createRecordingIpcDiagnostics,
  createRendererTrafficDiagnostics,
} from "./recording-ipc-diagnostics"

type AllowedBenchmarkEvent = (event: IpcMainEvent | IpcMainInvokeEvent) => boolean

export const installBenchmarkHeartbeat = (input: {
  app: App
  ipcMain: IpcMain
  allowed: AllowedBenchmarkEvent
}) => {
  if (process.env.DAW_BENCHMARK_HEARTBEAT !== "1") return
  input.ipcMain.handle("daw:benchmark:heartbeat", (event) => (
    input.allowed(event) ? { mainEpochMs: Date.now() } : null
  ))
  const pending = new Map<number, { senderId: number; startedAt: number }>()
  input.ipcMain.on("daw:benchmark:renderer-pong", (event, sequence) => {
    if (!input.allowed(event) || !Number.isSafeInteger(sequence)) return
    const request = pending.get(sequence)
    if (!request || request.senderId !== event.sender.id) return
    pending.delete(sequence)
    console.error(`[quiet-renderer-pong] sequence=${sequence} latencyMs=${Math.round(performance.now() - request.startedAt)}`)
  })
  input.app.on("browser-window-created", (_event, window) => {
    let sequence = 0
    const interval = setInterval(() => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      sequence += 1
      if (pending.size >= 8) pending.delete(pending.keys().next().value ?? -1)
      pending.set(sequence, { senderId: window.webContents.id, startedAt: performance.now() })
      console.error(`[quiet-renderer-ping] sequence=${sequence}`)
      window.webContents.send("daw:benchmark:renderer-ping", sequence)
    }, 5_000)
    window.on("closed", () => clearInterval(interval))
  })
}

export const installBenchmarkWindowTelemetry = (input: {
  app: App
  window: BrowserWindow
  getGeneration: () => number
  sameAppOrigin: (url: string) => boolean
}) => {
  const contents = input.window.webContents
  if (process.env.DAW_BENCHMARK_STARTUP_TRACE === "1") {
    contents.on("did-fail-load", (_event, code, _description, url) =>
      benchmarkLoadFailure(process.env.DAW_BENCHMARK_STARTUP_TRACE, code, url, console.error))
    contents.on("did-finish-load", () =>
      benchmarkStartupStage(
        process.env.DAW_BENCHMARK_STARTUP_TRACE,
        input.sameAppOrigin(contents.getURL()) ? "window-loaded" : "unexpected-window-loaded",
        console.error,
      ))
  }
  if (process.env.DAW_BENCHMARK_QUIET_CAPTURE !== "1") return
  contents.on("console-message", (_event, _level, message) => {
    if (message.startsWith("[quiet-renderer-block-cost] ") && message.length < 256) console.error(message)
  })
  const startedAt = performance.now()
  const health = (name: string, url = contents.getURL(), reason = "") =>
    console.error(`[quiet-renderer-health] ${JSON.stringify({
      elapsedMs: Math.round(performance.now() - startedAt),
      name,
      pid: contents.getOSProcessId(),
      urlClass: classifyNavigationUrl(url),
      reason: reason.slice(0, 48),
    })}`)
  contents.on("unresponsive", () => health("unresponsive"))
  contents.on("responsive", () => health("responsive"))
  contents.on("render-process-gone", (_event, details) => health("render-process-gone", "", details.reason))
  contents.on("destroyed", () => health("destroyed", ""))
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame) health("did-start-navigation", details.url)
  })
  contents.on("did-navigate", (_event, url) => health("did-navigate", url))
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) health("did-navigate-in-page", url)
  })
  const metricIntervalMs = process.env.DAW_BENCHMARK_ZOOM_PROFILE === "1" ? 250 : 1_000
  const metricTimer = setInterval(() => {
    for (const metric of input.app.getAppMetrics()) {
      console.error(`[quiet-renderer-metric] ${JSON.stringify({
        elapsedMs: Math.round(performance.now() - startedAt),
        pid: metric.pid,
        epochMs: Date.now(),
        type: metric.type,
        renderer: metric.pid === contents.getOSProcessId(),
        workingSetKiB: metric.memory.workingSetSize,
        peakWorkingSetKiB: metric.memory.peakWorkingSetSize,
        privateKiB: metric.memory.privateBytes ?? null,
        cpuPercent: metric.cpu.percentCPUUsage,
      })}`)
    }
  }, metricIntervalMs)
  contents.on("destroyed", () => clearInterval(metricTimer))
  const generation = () => input.getGeneration()
  console.error(`[quiet-capture-lifecycle] stage=created webContentsId=${contents.id} rendererPid=${contents.getOSProcessId()} generation=${generation()}`)
  contents.on("render-process-gone", (_event, details) =>
    console.error(`[quiet-capture-lifecycle] stage=renderer-gone reason=${details.reason} exitCode=${details.exitCode} generation=${generation()}`))
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame) console.error(`[quiet-capture-lifecycle] stage=load-failed code=${code} appOrigin=${input.sameAppOrigin(url)} generation=${generation()}`)
  })
  contents.on("did-finish-load", () =>
    console.error(`[quiet-capture-lifecycle] stage=loaded rendererPid=${contents.getOSProcessId()} appOrigin=${input.sameAppOrigin(contents.getURL())} generation=${generation()}`))
  input.window.on("closed", () => console.error(`[quiet-capture-lifecycle] stage=closed generation=${generation()}`))
}

export const createBenchmarkStartupReporter = () => (
  stage: Parameters<typeof benchmarkStartupStage>[1],
) => benchmarkStartupStage(process.env.DAW_BENCHMARK_STARTUP_TRACE, stage, console.error)

export const createBenchmarkRecordingTelemetry = (
  enabled = process.env.DAW_BENCHMARK_HEARTBEAT === "1",
) => {
  const recording = enabled ? createRecordingIpcDiagnostics(Date.now()) : null
  const traffic = enabled ? createRendererTrafficDiagnostics(Date.now()) : null
  let lastLogAt = 0
  let lastStatus: NativeHostRecordingStatus | null = null
  const reportStatus = () => lastStatus ? {
    generation: lastStatus.generation,
    sessionId: lastStatus.sessionId.toString(),
    timelineFrame: lastStatus.timelineFrame,
    capturedFrames: lastStatus.capturedFrames,
    droppedFrames: lastStatus.droppedFrames,
    droppedBlocks: lastStatus.droppedBlocks,
    availableBlocks: lastStatus.availableBlocks,
    queuedBlocks: lastStatus.queuedBlocks,
    rms: lastStatus.rms,
    peak: lastStatus.peak,
    fatal: lastStatus.fatal,
    active: lastStatus.active,
    configured: lastStatus.configured,
  } : null
  const emit = (now: number) => {
    if (!recording || !traffic) return
    lastLogAt = now
    console.error(`[quiet-recording-ipc] ${JSON.stringify({
      blocks: recording.report(now),
      traffic: traffic.report(now),
      status: reportStatus(),
    })}`)
  }
  return {
    sendBlock(block: NativeHostRecordingBlock, send: () => void) {
      if (!recording || !traffic) {
        send()
        return
      }
      const startedAt = performance.now()
      recording.recordBlock({
        frameCount: block.frameCount,
        channelCount: block.channelCount,
        payloadBytes: block.planarPcm.byteLength,
      })
      send()
      traffic.record("recording-block", block.planarPcm.byteLength + 64)
      recording.recordSend(performance.now() - startedAt)
      const now = Date.now()
      if (now - lastLogAt < 5_000) return
      emit(now)
    },
    recordStatus(status: NativeHostRecordingStatus) {
      if (!traffic) return
      traffic.record("recording-status", 96)
      lastStatus = status
      if (!status.active || status.fatal) emit(Date.now())
    },
    recordTraffic(channel: string, estimatedBytes: number) {
      traffic?.record(channel, estimatedBytes)
    },
  }
}
