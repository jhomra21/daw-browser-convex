import type { Accessor } from "solid-js"
import { isLocalId } from "@daw-browser/shared"
import { getRecordingDiagnostics } from "~/lib/recording/recording-diagnostics"
import { flushLocalProjectPendingWrites } from "~/lib/local-project-pending-writes"
import { resetAudioEngine } from "~/lib/audio-engine-singleton"
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine"
import type { DesktopOperationMapV1, DesktopOperationV1 } from "@daw-browser/desktop-protocol"

type HostRequest = {
  id: string
  operation: DesktopOperationV1
  input: unknown
  signal: AbortSignal
}

type HostResponse = {
  id: string
  result?: unknown
  error?: { version: "v1"; code: "invalid-request" | "unavailable" | "cancelled" | "deadline-exceeded" | "internal"; message: string }
}

type TimelineHostController = {
  request: (request: HostRequest) => Promise<HostResponse>
  prepareToClose: () => Promise<boolean>
}

type DesktopBridge = {
  setRequestHandler: (handler: ((request: HostRequest) => Promise<HostResponse>) | undefined) => void
  onPrepareToClose: (handler: (() => Promise<{ flushed: boolean }>) | undefined) => void
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires declaration merging.
  interface Window {
    dawDesktop?: DesktopBridge
  }
}

const unavailable = (id: string): HostResponse => ({
  id,
  error: { version: "v1", code: "unavailable", message: "The timeline controller is not ready." },
})

const cancelled = (id: string): HostResponse => ({
  id,
  error: { version: "v1", code: "cancelled", message: "The request was cancelled." },
})

let activeController: TimelineHostController | undefined

export const registerAttachedHostController = (controller: TimelineHostController) => {
  if (activeController) throw new Error("Only one timeline host controller may be attached.")
  activeController = controller
  window.dawDesktop?.setRequestHandler(controller.request)
  window.dawDesktop?.onPrepareToClose(async () => ({ flushed: await controller.prepareToClose() }))
  return () => {
    if (activeController !== controller) return
    activeController = undefined
    window.dawDesktop?.setRequestHandler(undefined)
    window.dawDesktop?.onPrepareToClose(undefined)
  }
}

export const createAttachedHostController = (input: {
  projectId: Accessor<string>
  isPlaying: Accessor<boolean>
  playheadSec: Accessor<number>
  tracks: Accessor<{ clips: unknown[] }[]>
  audioEngine: AudioEngine
  requestPlay: () => Promise<void>
  pause: () => Promise<void>
  stop: () => Promise<void>
  finishRecording: () => Promise<void>
  setPlayhead: (seconds: number) => void
}): TimelineHostController => {
  const transport = () => ({
    state: input.isPlaying() ? "playing" as const : input.playheadSec() === 0 ? "stopped" as const : "paused" as const,
    playheadSec: Math.max(0, input.playheadSec()),
  })
  const status = () => {
    const projectId = input.projectId()
    return {
      project: projectId ? { id: projectId, kind: isLocalId("project", projectId) ? "local" as const : "cloud" as const } : null,
      ready: Boolean(activeController),
      transport: transport().state,
      capabilities: { playback: true, diagnostics: true },
    }
  }
  const request = async (request_: HostRequest): Promise<HostResponse> => {
    if (activeController === undefined) return unavailable(request_.id)
    if (request_.signal.aborted) return cancelled(request_.id)
    try {
      let result: DesktopOperationMapV1[DesktopOperationV1]["result"]
      if (request_.operation === "host.status") result = status()
      else if (request_.operation === "transport.status") result = transport()
      else if (request_.operation === "transport.play") {
        if (request_.signal.aborted) return cancelled(request_.id)
        await input.requestPlay()
        result = transport()
      } else if (request_.operation === "transport.pause") {
        if (request_.signal.aborted) return cancelled(request_.id)
        await input.pause()
        result = transport()
      } else if (request_.operation === "transport.stop") {
        if (request_.signal.aborted) return cancelled(request_.id)
        await input.stop()
        result = transport()
      } else if (request_.operation === "transport.seek") {
        const seconds = typeof request_.input === "object" && request_.input !== null && "seconds" in request_.input ? request_.input.seconds : undefined
        if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
          return { id: request_.id, error: { version: "v1", code: "invalid-request", message: "Invalid seek position." } }
        }
        if (request_.signal.aborted) return cancelled(request_.id)
        input.setPlayhead(seconds)
        result = transport()
      } else {
        const runtime = input.audioEngine.getRuntimeSnapshot()
        const recording = getRecordingDiagnostics()
        result = {
          audio: { state: runtime.state, sampleRate: runtime.sampleRate ?? null },
          recording: { transport: recording.transport, capturedFrames: recording.capturedFrames, droppedFrames: recording.droppedFrames, deviceLost: recording.deviceLost },
          counts: { tracks: input.tracks().length, clips: input.tracks().reduce((total, track) => total + track.clips.length, 0) },
        }
      }
      return { id: request_.id, result }
    } catch {
      return { id: request_.id, error: { version: "v1", code: "internal", message: "The timeline operation failed." } }
    }
  }
  const prepareToClose = async () => {
    try {
      await input.stop()
      await input.finishRecording()
      const projectId = input.projectId()
      if (isLocalId("project", projectId)) await flushLocalProjectPendingWrites(projectId)
      input.audioEngine.close()
      resetAudioEngine()
      return true
    } catch {
      return false
    }
  }
  return { request, prepareToClose }
}
