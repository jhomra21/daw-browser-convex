import { nativeRecordingSpoolImportVersion } from "@daw-browser/desktop-protocol/native-audio-host"
import { nativeGraphNodeId } from "@daw-browser/audio-engine/native-host-wire"
import type { NativeHostRecordingStatus } from "@daw-browser/audio-engine/native-host-wire"
import { importNativeRecordingSpool } from "~/lib/recording/native-spool-importer"
import type { RecordingTerminationCause } from "~/lib/recording/recording-diagnostics"
import type { DesktopBridge } from "~/types/desktop-bridge"
import { assertReply } from "./native-publication-transaction"

type NativeAudioHost = NonNullable<DesktopBridge["audioHost"]>

export type NativeRecordingBridge = Pick<NativeAudioHost, "resolveInputDevice" | "recordingSpool"> & {
  session: Pick<
    NativeAudioHost["session"],
    | "configureRecording"
    | "startRecording"
    | "stopRecording"
    | "cancelRecording"
    | "onLoss"
    | "onRecordingStatus"
    | "onRecordingFailure"
  >
}

export type NativeRecordingDiagnostics = Pick<
  NativeHostRecordingStatus,
  "active" | "capturedFrames" | "droppedFrames" | "droppedBlocks" | "availableBlocks" | "queuedBlocks" | "rms" | "peak" | "fatal"
>

type NativeRecordingSession = {
  appSessionId: string
  numericSessionId: bigint
  generation: number
  scope: { projectId: string; projectGeneration: number }
  isCurrent: () => boolean
  takeId?: string
  sampleRate: number
  channelCount: number
  unsubscribeStatus: () => void
  unsubscribeFailure: () => void
  unsubscribeLoss: () => void
  terminal: boolean
  latestStatus?: NativeHostRecordingStatus
  finish?: Promise<Awaited<ReturnType<typeof importNativeRecordingSpool>>>
  waiters: Set<{ predicate: (status: NativeHostRecordingStatus) => boolean;
    resolve: (status: NativeHostRecordingStatus) => void; reject: (error: Error) => void }>
  onDiagnostics?: (diagnostics: NativeRecordingDiagnostics) => void
  onFailure?: (error: Error, cause: RecordingTerminationCause) => void
}

export type NativeRecordingHost = {
  bridge: NativeRecordingBridge | undefined
  importRecordingSpool: typeof importNativeRecordingSpool | undefined
  // The controller's facts as they stand now.
  state: () => { active: boolean; destroyed: boolean; sampleRate: number; projectId: string | undefined; projectGeneration: number }
}

// The one native recording session: capture through the host, then import the spool it left once native proves it complete.
export const createNativeRecording = (host: NativeRecordingHost) => {
  let recording: NativeRecordingSession | undefined
  let nextRecordingSessionId = 1n
  let recordingGeneration = 1

  const clearRecording = (session: NativeRecordingSession) => {
    session.unsubscribeStatus()
    session.unsubscribeFailure()
    session.unsubscribeLoss()
    for (const waiter of session.waiters) waiter.reject(new Error("Native recording session ended."))
    session.waiters.clear()
    if (recording === session) recording = undefined
  }

  const waitForStatus = (session: NativeRecordingSession, predicate: (status: NativeHostRecordingStatus) => boolean) => {
    if (session.latestStatus && predicate(session.latestStatus)) return Promise.resolve(session.latestStatus)
    if (session.terminal) return Promise.reject(new Error("Native recording was interrupted."))
    return new Promise<NativeHostRecordingStatus>((resolve, reject) => {
      session.waiters.add({ predicate, resolve, reject })
    })
  }

  const startRecording = async (recordingInput: {
    appSessionId: string
    projectId?: string
    projectGeneration?: number
    isCurrent?: () => boolean
    // The track the take records onto: native keeps its node and routing fixed while the take runs.
    targetTrackId: string
    // `coreaudio:<uid>` of the saved microphone; omitted records from the system default input.
    inputDeviceId?: string
    layout: "mono" | "stereo"
    inputChannel: number
    gain: number
    polarity: 1 | -1
    monitoring: boolean
    punchStartFrame: number
    punchEndFrame?: number
    onDiagnostics?: (diagnostics: NativeRecordingDiagnostics) => void
    onFailure?: (error: Error, cause: RecordingTerminationCause) => void
  }) => {
    const bridge = host.bridge
    const { active, sampleRate, projectGeneration, ...current } = host.state()
    if (!active || !bridge || recording || sampleRate === 0) throw new Error("Native playback is not active for recording.")
    const projectId = recordingInput.projectId ?? current.projectId
    if (!projectId) throw new Error("Native recording requires a declared project intent.")
    const scope = { projectId, projectGeneration: recordingInput.projectGeneration ?? projectGeneration }
    const channelCount = recordingInput.layout === "stereo" ? 2 : 1
    const inputChannels = channelCount === 2
      ? [recordingInput.inputChannel, recordingInput.inputChannel + 1] : [recordingInput.inputChannel]
    const numericSessionId = nextRecordingSessionId++
    const generation = recordingGeneration++
    const session: NativeRecordingSession = {
      appSessionId: recordingInput.appSessionId, numericSessionId, generation, scope,
      sampleRate, channelCount, terminal: false, waiters: new Set(),
      isCurrent: () => {
        const now = host.state()
        return recording === session && !session.terminal && !now.destroyed && (recordingInput.isCurrent?.() ?? true)
          && (now.projectId ?? projectId) === projectId && now.projectGeneration === projectGeneration
      },
      unsubscribeStatus: () => undefined, unsubscribeFailure: () => undefined, unsubscribeLoss: () => undefined,
      onDiagnostics: recordingInput.onDiagnostics, onFailure: recordingInput.onFailure,
    }
    const rejectSession = (error: Error, cause: RecordingTerminationCause, proofFailure = false) => {
      if (session.terminal || (!proofFailure && session.latestStatus?.spool?.state === 2)) return
      session.terminal = true
      for (const waiter of session.waiters) waiter.reject(error)
      session.waiters.clear()
      // Main sends this only after native Complete. Auto-punch may have
      // finished before renderer Stop, so retire the local session before its
      // failure callback can request cleanup; never send Cancel to that owner.
      if (proofFailure && !session.finish) clearRecording(session)
      session.onFailure?.(error, cause)
      // Never cancel an accepted Finish. Its native owner resolves truthfully;
      // all published sources outlive this controller regardless of failure.
      if (!session.finish && !proofFailure) void cancelRecording().catch(() => undefined)
    }
    session.unsubscribeStatus = bridge.session.onRecordingStatus((status) => {
      if (status.generation !== generation || status.sessionId !== numericSessionId) return
      session.latestStatus = status
      session.onDiagnostics?.(status)
      if (status.fatal || status.spool?.state === 3 || status.spool?.state === 4) {
        rejectSession(new Error("Native recording was interrupted; retained sources remain available."), "native-fatal")
        return
      }
      for (const waiter of session.waiters) {
        if (!waiter.predicate(status)) continue
        session.waiters.delete(waiter)
        waiter.resolve(status)
      }
    })
    session.unsubscribeFailure = bridge.session.onRecordingFailure?.((failure) => {
      if (failure.generation !== generation || failure.sessionId !== numericSessionId) return
      rejectSession(new Error(failure.message), "writer-failure", true)
    }) ?? (() => undefined)
    session.unsubscribeLoss = bridge.session.onLoss((message) => {
      rejectSession(new Error(message ?? "Native recording host connection was lost."), "controller-cleanup")
    })
    recording = session
    try {
      const inputDeviceReply = await bridge.resolveInputDevice(recordingInput.inputDeviceId)
      const inputDevice = inputDeviceReply.ok ? inputDeviceReply.device : null
      if (recordingInput.inputDeviceId && inputDeviceReply.ok && !inputDevice?.available)
        throw new Error("Saved microphone (unavailable)")
      if (!inputDevice?.available || inputChannels.some((channel) => channel >= inputDevice.inputChannelCount))
        throw new Error("No compatible native recording input device is available.")
      if (!session.isCurrent()) throw new Error("Recording scope changed.")
      const ready = await bridge.session.configureRecording({ ...scope, spoolImportVersion: nativeRecordingSpoolImportVersion,
        deviceUid: inputDevice.deviceId, generation, sessionId: numericSessionId, channelCount, inputChannels,
        gain: recordingInput.gain, polarity: recordingInput.polarity, punchStartFrame: recordingInput.punchStartFrame,
        punchEndFrame: recordingInput.punchEndFrame ?? null, monitoring: recordingInput.monitoring,
        targetNodeId: nativeGraphNodeId(recordingInput.targetTrackId) })
      assertReply(ready)
      if (!ready.takeId || ready.sampleRateHz !== sampleRate || ready.channelCount !== channelCount)
        throw new Error("Native recording verified readiness or sample rate mismatch.")
      session.takeId = ready.takeId
      session.sampleRate = ready.sampleRateHz
      if (!session.isCurrent()) throw new Error("Recording scope changed.")
      const started = waitForStatus(session, (status) => status.active)
      // Observe rejection immediately if Start itself rejects before the status.
      void started.catch(() => undefined)
      assertReply(await bridge.session.startRecording({ ...scope, generation, sessionId: numericSessionId }))
      const status = await started
      if (!session.isCurrent()) throw new Error("Recording scope changed.")
      return { sampleRate: session.sampleRate, channelCount, startFrame: status.timelineFrame }
    } catch (error) {
      if (!session.terminal) await bridge.session.cancelRecording().catch(() => undefined)
      clearRecording(session)
      throw error
    }
  }

  const stopRecording = () => {
    const bridge = host.bridge
    const session = recording
    if (!bridge || !session) return Promise.reject(new Error("Native recording is not active."))
    if (session.finish) return session.finish
    if (session.terminal) return Promise.reject(new Error("Native recording was interrupted."))
    // Install the promise before any asynchronous stop/control traffic. There is
    // intentionally no drain deadline: slow fsync is not evidence of lost data.
    session.finish = Promise.resolve().then(async () => {
      try {
        const complete = waitForStatus(session, (status) => status.spool?.state === 2)
        void complete.catch(() => undefined)
        assertReply(await bridge.session.stopRecording())
        const status = await complete
        if (!session.isCurrent()) throw new Error("Recording import scope changed; native source retained.")
        if (!session.takeId || !status.spool) throw new Error("Native recording Complete proof is unavailable.")
        let cursor: string | undefined
        do {
          const page = await bridge.recordingSpool.list(session.scope, cursor)
          if (!session.isCurrent()) throw new Error("Recording import scope changed; native source retained.")
          const take = page.takes.find((candidate) => candidate.takeId === session.takeId)
          if (take) {
            if (take.frames !== status.capturedFrames || take.frames !== status.spool.writtenFrames
              || take.bytes !== status.spool.writtenBytes || take.blocks !== status.spool.writtenBlocks
              || take.sampleRateHz !== session.sampleRate || take.channelCount !== session.channelCount)
              throw new Error("Native recording registry and Complete proof disagree.")
            return await (host.importRecordingSpool ?? importNativeRecordingSpool)({ bridge: bridge.recordingSpool,
              scope: session.scope, take, sessionId: session.appSessionId,
              expectedSampleRateHz: session.sampleRate, isCurrent: session.isCurrent })
          }
          cursor = page.nextCursor ?? undefined
        } while (cursor)
        throw new Error("Native recording retained take is unavailable.")
      } finally { clearRecording(session) }
    })
    return session.finish
  }

  async function cancelRecording() {
    const bridge = host.bridge
    const session = recording
    if (!bridge || !session) return
    if (session.finish) { await session.finish.catch(() => undefined); return }
    session.terminal = true
    try { assertReply(await bridge.session.cancelRecording()) }
    finally { clearRecording(session) }
  }

  return {
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
    isRecording: () => recording !== undefined,
    // The host connection is gone: a take whose native Complete proof has not arrived fails and is dropped without a Cancel.
    loseHost: (message: () => string) => {
      if (!recording || recording.latestStatus?.spool?.state === 2) return
      recording.terminal = true
      recording.onFailure?.(new Error(message()), "controller-cleanup")
      const lostRecording = recording
      const error = new Error(message())
      for (const waiter of lostRecording.waiters) waiter.reject(error)
      lostRecording.waiters.clear()
      lostRecording.unsubscribeStatus()
      lostRecording.unsubscribeFailure()
      lostRecording.unsubscribeLoss()
      recording = undefined
    },
  }
}
