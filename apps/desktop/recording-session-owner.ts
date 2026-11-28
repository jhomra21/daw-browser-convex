import { nativeRecordingSpoolImportVersion } from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeHostRecordingConfiguration } from "@daw-browser/audio-engine/native-host-wire"
import { NativeAudioHostCommandError, NativeRecordingConfigureError, type nativeDeliveryFailureKind, type NativeAudioHostSupervisor, type NativeMainRecordingStatus } from "./audio-host"
import { prepareRecordingSpool, type createRecordingSpoolRegistry } from "./recording-spool"
import type { createRecordingStartDiagnostic } from "./recording-start-diagnostic"

type RecordingSpoolRegistry = ReturnType<typeof createRecordingSpoolRegistry>
type RecordingSupervisor = Pick<NativeAudioHostSupervisor,
  "configureRecording" | "startRecording" | "stopRecording" | "waitForRecordingOutcome" | "recordingAdmissionAvailable">
type Failure = { ok: false; kind: ReturnType<typeof nativeDeliveryFailureKind>; error: string }
type RendererRecordingMessage =
  | Omit<NativeMainRecordingStatus, "fileDevice" | "fileInode">
  | { generation: number; sessionId: bigint; message: string }
type Binding = {
  take: Awaited<ReturnType<typeof prepareRecordingSpool>>; takeId: string
  rendererGeneration: number; projectId: string; projectGeneration: number
  captureGeneration: number; sessionId: bigint; ready: boolean; completion?: Promise<void>
}

export type RecordingConfigureRequest = {
  configuration: NativeHostRecordingConfiguration; projectId: string; projectGeneration: number; spoolImportVersion?: number
}
export type RecordingStartRequest = { projectId: string; projectGeneration: number; generation: number; sessionId: bigint }
type RendererCall = {
  rendererGeneration: number
  senderAllowed: () => boolean
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the argument is a catch-clause value, classified by the failure projection
  fail: (thrown?: unknown) => Failure
}

// One owner for a take's admission, renderer binding, Complete proof and release.
// A request that failed IPC parsing arrives as `undefined` so the diagnostic and
// the rejection answer stay in the order the renderer and the runners observe.
export const createRecordingSessionOwner = (input: {
  diagnostic: ReturnType<typeof createRecordingStartDiagnostic>
  captureInhibited: boolean
  currentRendererGeneration: () => number
  userData: () => string
  verifyDirectory: Parameters<typeof prepareRecordingSpool>[0]["verifyDirectory"]
  sendToRenderer: (channel: string, message: RendererRecordingMessage) => void
  statusChannel: string
  failureChannel: string
}) => {
  const { diagnostic } = input
  let registry: RecordingSpoolRegistry | undefined
  let admissionPending = false
  let binding: Binding | undefined

  const reject = (call: RendererCall, error?: string) => {
    diagnostic.observe({ kind: "configure-result", outcome: "rejected", category: "admission-failed" })
    return error === undefined ? call.fail() : { ok: false as const, error }
  }
  const ownsStatus = (current: Binding | undefined, status: NativeMainRecordingStatus) => (
    current !== undefined && status.generation === current.captureGeneration && status.sessionId === current.sessionId
  )

  return {
    attachRegistry(next: RecordingSpoolRegistry | undefined) { registry = next },
    spool() {
      if (!registry) throw new Error("Recording spool is unavailable.")
      return registry
    },
    invalidateRenderer() { registry?.invalidate() },
    async waitForSettlement() { await registry?.waitForSettlement() },

    async configure(
      call: RendererCall & { hostGeneration: number },
      supervisor: RecordingSupervisor | undefined,
      request: RecordingConfigureRequest | undefined,
    ) {
      const startedAt = performance.now()
      diagnostic.observe({ kind: "configure-request" })
      if (!supervisor || !request) return reject(call)
      diagnostic.observe({ kind: "backend", backend: "native" })
      // Admission requires the real bounded OPFS importer, not legacy PCM delivery.
      if (request.spoolImportVersion !== nativeRecordingSpoolImportVersion) return reject(call, "Native recording import is not ready.")
      if (!registry) return reject(call, "Native recording storage is unavailable. Sources remain retained; check the desktop log.")
      if (admissionPending || !supervisor.recordingAdmissionAvailable()) return reject(call)
      admissionPending = true
      const { rendererGeneration } = call
      const { configuration, projectId, projectGeneration } = request
      const stillBound = () => input.currentRendererGeneration() === rendererGeneration && call.senderAllowed()
      let stage: "spool-admission" | "native-configure" | "confirm-ready" | "binding-ready" = "spool-admission"
      const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt))
      try {
        const take = await prepareRecordingSpool({ userData: input.userData(),
          projectId: projectId, rendererGeneration,
          projectGeneration: projectGeneration,
          hostGeneration: call.hostGeneration, generation: configuration.generation,
          sessionId: configuration.sessionId, channelCount: configuration.channelCount,
          verifyDirectory: input.verifyDirectory })
        if (!stillBound()) throw new Error("Recording renderer binding changed.")
        const scope = { projectId: projectId, projectGeneration: projectGeneration, rendererGeneration }
        if (!registry) throw new Error("Recording spool registry is unavailable.")
        registry.bind(scope)
        const takeId = registry.admit(take, scope)
        const next: Binding = { take, takeId, rendererGeneration, projectId: projectId,
          projectGeneration: projectGeneration, captureGeneration: configuration.generation,
          sessionId: configuration.sessionId, ready: false }
        binding = next
        stage = "native-configure"
        const ready = await supervisor.configureRecording(configuration, { rootPath: take.rootPath,
          rootDevice: take.root.device, rootInode: take.root.inode, token: take.token })
        stage = "confirm-ready"
        diagnostic.observe({
          kind: "readiness", configured: ready.configured, active: ready.active,
          sampleRateHz: ready.spool?.sampleRateHz, channelCount: ready.spool?.channelCount, spool: ready.spool,
        })
        if (!stillBound() || !ready.spool) throw new Error("Recording renderer binding changed.")
        diagnostic.observe({
          kind: "readiness", configured: true, active: ready.active,
          sampleRateHz: ready.spool.sampleRateHz, channelCount: ready.spool.channelCount,
          spool: { state: ready.spool.state, error: ready.spool.error, systemError: ready.spool.systemError },
        })
        await take.confirmReady({ generation: ready.generation, sessionId: ready.sessionId,
          channelCount: ready.spool.channelCount, sampleRateHz: ready.spool.sampleRateHz })
        stage = "binding-ready"
        if (input.currentRendererGeneration() !== rendererGeneration || binding?.take !== take) throw new Error("Recording binding changed.")
        binding.ready = true
        diagnostic.observe({
          kind: "configure-result", outcome: "ready", category: "success",
          sampleRateHz: ready.spool.sampleRateHz, channelCount: ready.spool.channelCount, elapsedMs: elapsedMs(),
        })
        return { ok: true as const, takeId, sampleRateHz: ready.spool.sampleRateHz, channelCount: ready.spool.channelCount }
      } catch (error) {
        const commandError = error instanceof NativeRecordingConfigureError ? error.cause : error
        diagnostic.observe({
          kind: "configure-result",
          outcome: "rejected",
          category: commandError instanceof NativeAudioHostCommandError ? "command-rejected"
            : stage === "spool-admission" ? "admission-failed"
              : stage === "native-configure" ? "native-configure-failed"
                : stage === "confirm-ready" ? "readiness-validation-failed" : "binding-changed",
          phase: error instanceof NativeRecordingConfigureError ? error.phase : undefined,
          elapsedMs: elapsedMs(),
        })
        // Ambiguous configure/admission and all durable sources remain retained.
        return call.fail(commandError)
      } finally { admissionPending = false }
    },

    async start(
      call: Pick<RendererCall, "rendererGeneration" | "fail">,
      supervisor: RecordingSupervisor | undefined,
      request: RecordingStartRequest | undefined,
    ) {
      if (!supervisor || !binding?.ready || binding.rendererGeneration !== call.rendererGeneration
        || !registry?.isCurrent({ rendererGeneration: call.rendererGeneration,
          projectId: binding.projectId, projectGeneration: binding.projectGeneration })
        || !request
        || request.projectId !== binding.projectId
        || request.projectGeneration !== binding.projectGeneration
        || request.generation !== binding.captureGeneration
        || request.sessionId !== binding.sessionId) return call.fail()
      if (input.captureInhibited) {
        diagnostic.observeCaptureBlocked()
        return { ok: false as const, error: "diagnostic-capture-blocked" }
      }
      try {
        await supervisor.startRecording()
        const result = { ok: true as const }
        diagnostic.observeStart(result)
        return result
      } catch {
        const result = call.fail()
        diagnostic.observeStart(result)
        return result
      }
    },

    async stop(
      call: Pick<RendererCall, "fail">,
      supervisor: RecordingSupervisor | undefined,
      request: { endFrame: number | undefined } | undefined,
    ) {
      if (!supervisor || !request) return call.fail()
      try {
        const current = binding
        if (!current?.completion) {
          await supervisor.stopRecording(request.endFrame)
          await supervisor.waitForRecordingOutcome()
        }
        if (!current?.completion) throw new Error("Native recording Complete proof is unavailable.")
        await current.completion
        return { ok: true as const }
      } catch (error) {
        return call.fail(error)
      }
    },

    onStatus(status: NativeMainRecordingStatus) {
      // Native identities stay in main. Never spread the private decoder result.
      const { fileDevice: _fileDevice, fileInode: _fileInode, ...rendererStatus } = status
      const current = binding
      if (current && ownsStatus(current, status)) {
        diagnostic.observe({
          kind: "readiness",
          configured: status.configured,
          active: status.active,
          sampleRateHz: status.spool?.sampleRateHz,
          channelCount: status.spool?.channelCount,
          spool: status.spool,
        })
      }
      if (current && ownsStatus(current, status) && status.spool?.state === 2 && registry) {
        current.completion ??= registry.complete(current.takeId, status)
        void current.completion.then(() => {
          input.sendToRenderer(input.statusChannel, rendererStatus)
        }).catch(() => {
          // Native source remains retained; no renderer-readable capability is
          // granted when main cannot persist and independently verify Complete.
          input.sendToRenderer(input.failureChannel, { generation: current.captureGeneration,
            sessionId: current.sessionId, message: "Native recording source verification failed; native source retained." })
        })
      } else {
        input.sendToRenderer(input.statusChannel, rendererStatus)
        if (current && ownsStatus(current, status) && (status.spool?.state === 3 || status.spool?.state === 4) && registry) {
          void registry.resolveTerminal(current.takeId, status).catch((error) => {
            console.warn("[recording-spool] terminal source remains unresolved", error)
          })
        }
      }
    },
  }
}
