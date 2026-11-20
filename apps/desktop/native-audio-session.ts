import { app, powerMonitor } from "electron"
import { randomUUID } from "node:crypto"
import { lifecycleChannel, lossChannel, meterBatchChannel, scheduleProgressChannel, spectrumFrameChannel, vstEditorCapturedStateChannel, vstEditorStateChannel, vstInstanceEventChannel, vstParameterEditChannel } from "@daw-browser/desktop-protocol/ipc-channels"
import { createNativeVst3SessionLedger } from "./native-vst3-coordinator"
import { createNativeVst3HostEventHandlers } from "./native-vst3-host-events"
import { createNativeAudioHostSupervisor } from "./audio-host"
import { createNativeVst3EditorSessionManager } from "./native-vst3-editor-session"
/* oxlint-disable eslint/no-restricted-imports -- desktop-audio-lifecycle needs the bridge types, which stay in src/types until the batch that owns the certification-pinned playback files moves it */
import type { DesktopAudioLifecycle } from "../../src/lib/desktop-audio-lifecycle"
/* oxlint-enable eslint/no-restricted-imports */
import type { NativeHostMeterBatch, NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"
import { nativeAudioHostScheduleProgressBytes } from "@daw-browser/desktop-protocol/native-audio-host"
import { createNativeVstProjectBindings } from "./native-vst-project-bindings"
import { createBenchmarkRecordingTelemetry } from "./benchmark-runtime"
import { sanitizeNativeVst3DiagnosticError } from "./native-vst3-diagnostic-error"
import type { createPluginCatalogOwner } from "./plugin-catalog-owner"
import type { createRecordingSessionOwner } from "./recording-session-owner"
import type { RendererSession } from "./renderer-session"
import type { createAe08Evidence } from "./ae08-evidence"
import type { NativeReleaseArtifactVerification } from "./native-artifacts"

/** The native audio host session: its supervisor, plug-in editor sessions, power lifecycle and what a project has attached to it. */
export const createNativeAudioSession = (options: {
  rendererSession: RendererSession
  recordingSessionOwner: ReturnType<typeof createRecordingSessionOwner>
  ae08Evidence: ReturnType<typeof createAe08Evidence>
  ae08WorkerEnvironment: NodeJS.ProcessEnv
}) => {
  const { rendererSession, recordingSessionOwner, ae08Evidence, ae08WorkerEnvironment } = options

  let audioHostPath: string | undefined
  let audioHostSupervisor: ReturnType<typeof createNativeAudioHostSupervisor> | undefined
  let nativeReleaseArtifactVerification: NativeReleaseArtifactVerification = { status: "disabled" }
  let nativeVst3EditorSessionManager: ReturnType<typeof createNativeVst3EditorSessionManager> | undefined
  let audioLifecycle: DesktopAudioLifecycle = { state: "ready", powerGeneration: 0 }
  let audioSuspendPromise: Promise<void> | undefined
  let audioRecoveryGeneration: number | undefined
  let removeAudioHostLossListener: (() => void) | undefined
  let removeAudioHostRecordingStatusListener: (() => void) | undefined
  let removeAudioHostMeterBatchListener: (() => void) | undefined
  let removeAudioHostSpectrumListener: (() => void) | undefined
  let removeAudioHostScheduleProgressListener: (() => void) | undefined
  let removeAudioHostWorkerNotificationListener: (() => void) | undefined
  const activeEditorProjectBindings = createNativeVstProjectBindings()
  const attachmentLedger = createNativeVst3SessionLedger()
  const activeRendererTransactions = new Map<string, { generation: number; senderId: number }>()

  const publishAudioLifecycle = () => {
    rendererSession.send(lifecycleChannel, audioLifecycle)
  }

  const recoverAudioHost = (recoveryGeneration: number) => {
    if (audioRecoveryGeneration === recoveryGeneration) return
    audioRecoveryGeneration = recoveryGeneration
    void (async () => {
      try {
        await audioSuspendPromise

        if (audioLifecycle.state !== "suspended" || audioLifecycle.powerGeneration !== recoveryGeneration) return
        await audioHostSupervisor?.resume()
        await audioHostSupervisor?.start()

        if (audioLifecycle.state !== "suspended" || audioLifecycle.powerGeneration !== recoveryGeneration) return
        audioLifecycle = { state: "recovering", powerGeneration: recoveryGeneration }
        publishAudioLifecycle()
      } catch {
        if (audioLifecycle.state !== "suspended" || audioLifecycle.powerGeneration !== recoveryGeneration) return
        audioLifecycle = { state: "failed", powerGeneration: recoveryGeneration }
        publishAudioLifecycle()
      } finally {
        if (audioRecoveryGeneration === recoveryGeneration) audioRecoveryGeneration = undefined
      }
    })()
  }

  const start = (startOptions: {
    hostPath: string | undefined
    verification: NativeReleaseArtifactVerification
    pluginCatalog: ReturnType<typeof createPluginCatalogOwner>
  }) => {
    const { pluginCatalog } = startOptions
    audioHostPath = startOptions.hostPath
    nativeReleaseArtifactVerification = startOptions.verification
    audioHostSupervisor = audioHostPath ? createNativeAudioHostSupervisor(audioHostPath, undefined, {
      evidence: ae08Evidence,
      hostEnvironment: ae08WorkerEnvironment,
    }) : undefined

    // Only a lost host ends the native session. One plug-in's fault, miss or restart is that instance's business.
    const publishNativeSessionLoss = (error: string) => {
      activeEditorProjectBindings.clear()
      rendererSession.send(lossChannel, error)
    }

    const sendVstParameterEdit = (input: {
      projectId: string
      source: "active-playback" | "editor-session"
      instanceId: string
      parameterId: number
      normalizedValue: number
    }) => {
      rendererSession.send(vstParameterEditChannel, input)
    }

    const hostEvents = createNativeVst3HostEventHandlers({
      sendInstanceEvent: (event) => { rendererSession.send(vstInstanceEventChannel, event) },
      sendParameterEdit: (input) => sendVstParameterEdit({ ...input, source: "active-playback" }),
      sendEditorState: (input) => { rendererSession.send(vstEditorStateChannel, input) },
      projectFor: (instanceId) => activeEditorProjectBindings.projectFor(instanceId),
      endSession: (error) => publishNativeSessionLoss(sanitizeNativeVst3DiagnosticError(error)),
    })

    removeAudioHostWorkerNotificationListener = audioHostSupervisor?.onWorkerNotification(hostEvents.onNotification)
    const editorHostPath = audioHostPath
    nativeVst3EditorSessionManager = editorHostPath && pluginCatalog.workerPath
      ? createNativeVst3EditorSessionManager({
        workerPath: pluginCatalog.workerPath,
        catalogStore: pluginCatalog.store,
        createSupervisor: () => createNativeAudioHostSupervisor(editorHostPath, undefined, {
          evidence: ae08Evidence,
          hostEnvironment: ae08WorkerEnvironment,
        }),
        playbackOwns: (instanceId) => activeEditorProjectBindings.projectFor(instanceId) !== undefined,
        onEditorInteraction: () => {
          const target = rendererSession.window()

          if (!target || target.isDestroyed() || rendererSession.finishingQuit()) return
          target.show()
          app.focus({ steal: true })
          target.focus()
        },
        onEditorOpenState: (input) => {
          rendererSession.send(vstEditorStateChannel, input)
        },
        onCapturedState: (input) => new Promise<void>((resolve, reject) => {
          const requestId = randomUUID()

          const timeout = setTimeout(() => {
            if (!rendererSession.editorStateAcks.delete(requestId)) return
            reject(new Error("Renderer editor state persistence timed out."))
          }, 10_000)

          rendererSession.editorStateAcks.set(requestId, {
            resolve: () => {
              clearTimeout(timeout)
              resolve()
            },
            reject: (error) => {
              clearTimeout(timeout)
              reject(error)
            },
          })

          if (!rendererSession.send(vstEditorCapturedStateChannel, { ...input, requestId })) {
            rendererSession.editorStateAcks.delete(requestId)
            clearTimeout(timeout)
            reject(new Error("Renderer unavailable."))
          }
        }),
        onParameterEdit: (input) => sendVstParameterEdit({
          projectId: input.projectId,
          source: "editor-session",
          instanceId: input.instanceId,
          parameterId: input.parameterId,
          normalizedValue: input.normalizedValue,
        }),
      })
      : undefined

    const handleSuspend = () => {
      if (rendererSession.finishingQuit() || (audioLifecycle.state === "suspended" && audioRecoveryGeneration === undefined)) return
      audioRecoveryGeneration = undefined
      audioLifecycle = { state: "suspended", powerGeneration: audioLifecycle.powerGeneration + 1 }
      publishAudioLifecycle()
      audioSuspendPromise = Promise.allSettled([
        audioHostSupervisor?.suspend(),
        nativeVst3EditorSessionManager?.suspendAll(),
      ]).then(() => undefined)
    }

    const handleResume = () => {
      if (rendererSession.finishingQuit() || audioLifecycle.state !== "suspended") return
      audioLifecycle = { state: "suspended", powerGeneration: audioLifecycle.powerGeneration + 1 }
      const recoveryGeneration = audioLifecycle.powerGeneration
      recoverAudioHost(recoveryGeneration)
    }

    powerMonitor.on("suspend", handleSuspend)
    powerMonitor.on("resume", handleResume)
    removeAudioHostLossListener = audioHostSupervisor?.onLoss(hostEvents.onLoss)
    const recordingBenchmark = createBenchmarkRecordingTelemetry()
    removeAudioHostRecordingStatusListener = audioHostSupervisor?.onRecordingStatus((status) => {
      recordingBenchmark.recordStatus(status)
      recordingSessionOwner.onStatus(status)
    })
    removeAudioHostMeterBatchListener = audioHostSupervisor?.onMeterBatch((batch: NativeHostMeterBatch) => {
      recordingBenchmark.recordTraffic("meter-batch", 32 + batch.entries.length * 24)
      rendererSession.send(meterBatchChannel, batch)
    })
    removeAudioHostSpectrumListener = audioHostSupervisor?.onSpectrumFrame((frame) => {
      recordingBenchmark.recordTraffic("spectrum-frame", 48 + frame.data.byteLength)
      rendererSession.send(spectrumFrameChannel, frame)
    })
    removeAudioHostScheduleProgressListener = audioHostSupervisor?.onScheduleProgress((progress: NativeScheduleProgress) => {
      recordingBenchmark.recordTraffic("schedule-progress", 16 + nativeAudioHostScheduleProgressBytes)
      rendererSession.send(scheduleProgressChannel, progress)
    })
  }

  const dispose = () => {
    powerMonitor.removeAllListeners("suspend")
    powerMonitor.removeAllListeners("resume")
    removeAudioHostLossListener?.()
    removeAudioHostRecordingStatusListener?.()
    removeAudioHostMeterBatchListener?.()
    removeAudioHostSpectrumListener?.()
    removeAudioHostScheduleProgressListener?.()
    removeAudioHostWorkerNotificationListener?.()
  }

  return {
    start,
    dispose,
    publishLifecycle: publishAudioLifecycle,
    recoverHost: recoverAudioHost,
    setLifecycle: (next: DesktopAudioLifecycle) => { audioLifecycle = next },
    get hostPath() { return audioHostPath },
    get supervisor() { return audioHostSupervisor },
    get editorSessions() { return nativeVst3EditorSessionManager },
    get lifecycle() { return audioLifecycle },
    get artifactVerification() { return nativeReleaseArtifactVerification },
    bindings: activeEditorProjectBindings,
    ledger: attachmentLedger,
    transactions: activeRendererTransactions,
  }
}

export type NativeAudioSession = ReturnType<typeof createNativeAudioSession>
