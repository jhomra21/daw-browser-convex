import {
  selectPortableWasmAudioWorkletBackend,
  type PortableWasmCapability,
  type PortableWasmBackendSelection,
  type PortableWasmPlaybackSession,
  WasmAudioWorkletBackend,
} from "@daw-browser/audio-engine/wasm-audio-worklet-backend"
import type { PlanarPcm } from "@daw-browser/audio-core-contract"
import type {
  PreparedPortableSession,
  PortableAssetRegistryInput,
  PortablePreparedQualification,
} from "@daw-browser/audio-engine/portable-session-compiler"
import { portableWasmProtocolVersion, type PortableWasmStatusMessage } from "@daw-browser/audio-engine/portable-wasm-protocol"
import { RECORDER_BLOCK_FRAMES, RECORDER_MAX_QUEUED_BLOCKS } from "@daw-browser/audio-engine/recording-protocol"
import { compilePreparedPortableLiveSession } from "~/lib/portable-live-session"
import type { LivePlaybackSnapshot, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import { createPortableRecordingWriter } from "~/lib/recording/portable-recording-writer"

type PortableStartResult = "started" | "unavailable"

type PortableSession = Pick<
  PortableWasmPlaybackSession,
  "connectInput" | "dispose" | "installSchedule" | "markActive" | "onFault" | "onRecordingStatus" | "postRecordingControl" | "prepareGraph" | "publishGraph" | "registerAsset" | "scheduleSources" | "setTransport"
>

type PortableBackend = {
  createPlaybackSession: (
    context: BaseAudioContext,
    capability: Extract<PortableWasmCapability, { available: true }>,
    maxFramesPerBlock: number,
  ) => Promise<PortableSession>
}

const portableScheduleHorizonSec = 30
const portableRecordingControlTimeoutMs = 2_000

export type PortableRecordingDiagnostics = Extract<PortableWasmStatusMessage, { type: "recording-capture-diagnostics" }>

const deferred = <T>() => {
  let resolve = (_value: T) => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const boundedControl = <T>(promise: Promise<T>, message: string) => new Promise<T>((resolve, reject) => {
  // Control acknowledgements are bounded so a lost worklet cannot leave input
  // monitoring or MediaStream resources active indefinitely.
  const deadline = setTimeout(() => reject(new Error(message)), portableRecordingControlTimeoutMs)
  promise.then((value) => {
    clearTimeout(deadline)
    resolve(value)
  }, (error: unknown) => {
    clearTimeout(deadline)
    reject(error)
  })
})

const planarPcm = (buffer: AudioBuffer): PlanarPcm => ({
  frameCount: buffer.length,
  planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
})

const assetRegistry = (snapshot: LivePlaybackSnapshot, generation: number): PortableAssetRegistryInput => ({
  projectGeneration: generation,
  assets: snapshot.assets.map((asset, slot) => ({
    projectAssetId: asset.assetId,
    portableAssetId: asset.assetId,
    projectGeneration: generation,
    handle: { slot, generation },
    decoded: {
      sampleRateHz: asset.buffer.sampleRate,
      channelCount: asset.buffer.numberOfChannels,
      frameCount: asset.buffer.length,
    },
  })),
})

const preparedSession = (
  snapshot: LivePlaybackSnapshot,
  sampleRateHz: number,
  epoch: number,
): PreparedPortableSession => compilePreparedPortableLiveSession(snapshot, {
  assetRegistry: assetRegistry(snapshot, epoch),
  sampleRateHz,
  transportEpoch: epoch,
  timeOrigin: {
    timelineSec: snapshot.transport.playheadSec,
    frame: Math.round(snapshot.transport.playheadSec * sampleRateHz),
  },
  rangeEndSec: snapshot.transport.playheadSec + portableScheduleHorizonSec,
})

type PortableRecordingSession = {
  numericSessionId: number
  source: MediaStreamAudioSourceNode
  disconnectInput: () => void
  unsubscribeStatus: () => void
  unsubscribeTrack: () => void
  writer: ReturnType<typeof createPortableRecordingWriter>
  configured: ReturnType<typeof deferred<number>>
  finalized: ReturnType<typeof deferred<void>>
  cancelled: ReturnType<typeof deferred<void>>
  diagnostics?: PortableRecordingDiagnostics
  onFailure?: (error: Error) => void
  phase: "configuring" | "recording" | "finalizing" | "cancelling"
  configurationPending: boolean
  terminal: boolean
}

/**
 * Activates the browser portable renderer only after its immutable payload,
 * worklet, graph, assets, source schedule, and running transport are all
 * acknowledged. A failure before activation leaves the caller on legacy;
 * a fault after activation disconnects the portable node without fallback.
 */
export const createPortableBrowserPlaybackController = (input: {
  compileSnapshot: (transport: LivePlaybackTransport) => Promise<LivePlaybackSnapshotCompilation>
  getAudioContext: () => AudioContext | null
  getProjectGeneration?: () => number
  reportFault?: (message: string) => void
  backend?: PortableBackend
  select?: (project: PortablePreparedQualification) => Promise<PortableWasmBackendSelection>
  createRecordingWriter?: typeof createPortableRecordingWriter
}) => {
  const backend = input.backend ?? new WasmAudioWorkletBackend()
  const select = input.select ?? ((project) => selectPortableWasmAudioWorkletBackend(undefined, project))
  let active: PortableSession | undefined
  let activeProjectGeneration: number | undefined
  let playing = false
  let pendingStart: Promise<PortableStartResult> | undefined
  let lifecycleGeneration = 0
  let recording: PortableRecordingSession | undefined
  let epoch = 0
  let nextRecordingSessionId = 1
  let unsubscribeFault: (() => void) | undefined

  const clearRecording = (session: PortableRecordingSession) => {
    if (recording === session) recording = undefined
    session.unsubscribeStatus()
    session.unsubscribeTrack()
    try { session.disconnectInput() } catch {}
    try { session.source.disconnect() } catch {}
  }

  const failRecording = (session: PortableRecordingSession, error: Error) => {
    if (session.terminal) return
    session.terminal = true
    try {
      active?.postRecordingControl({ version: portableWasmProtocolVersion, type: "recording-capture-cancel" })
    } catch {}
    void session.writer.abort().catch(() => undefined)
    session.writer.terminate()
    if (session.phase === "configuring" && session.configurationPending) session.configured.reject(error)
    else if (session.phase === "finalizing") session.finalized.reject(error)
    else if (session.phase === "cancelling") session.cancelled.reject(error)
    if (session.phase !== "configuring") session.onFailure?.(error)
    clearRecording(session)
    input.reportFault?.(error.message)
  }

  const dispose = () => {
    lifecycleGeneration += 1
    const recordingSession = recording
    if (recordingSession) failRecording(recordingSession, new Error("Portable recording stopped with playback."))
    unsubscribeFault?.()
    unsubscribeFault = undefined
    const session = active
    active = undefined
    activeProjectGeneration = undefined
    playing = false
    session?.dispose()
  }

  const startAttempt = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
  ): Promise<PortableStartResult> => {
    const context = input.getAudioContext()
    if (!context) return "unavailable"
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
    if (active && activeProjectGeneration === projectGeneration) {
      try {
        await active.setTransport(epoch, true, Math.round(transport.playheadSec * context.sampleRate))
        if (cancelled()) {
          dispose()
          return "unavailable"
        }
        active.markActive()
        playing = true
        return "started"
      } catch (error) {
        if (!cancelled()) {
          input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not resume.")
        }
        dispose()
        return "unavailable"
      }
    }
    if (active) {
      unsubscribeFault?.()
      unsubscribeFault = undefined
      active.dispose()
      active = undefined
      activeProjectGeneration = undefined
      playing = false
    }
    const nextEpoch = epoch + 1
    let session: PortableSession | undefined
    let unsubscribeSessionFault: (() => void) | undefined
    try {
      const compilation = await input.compileSnapshot(transport)
      if (cancelled()) return "unavailable"
      if (!compilation.supported || compilation.snapshot.transport.loopEnabled) return "unavailable"
      const prepared = preparedSession(compilation.snapshot, context.sampleRate, nextEpoch)
      if (!prepared.supported) return "unavailable"
      const selection = await select(prepared.qualification)
      if (cancelled()) return "unavailable"
      if (!selection.selected) return "unavailable"
      const playbackSession = await backend.createPlaybackSession(context, selection.capability, 8_192)
      session = playbackSession
      if (cancelled()) {
        playbackSession.dispose()
        session = undefined
        return "unavailable"
      }
      let sessionFault: Error | undefined
      unsubscribeSessionFault = playbackSession.onFault((error: Error) => {
        if (active !== playbackSession) {
          sessionFault = error
          return
        }
        const recordingSession = recording
        if (recordingSession) failRecording(recordingSession, error)
        else input.reportFault?.(error.message)
        active = undefined
        activeProjectGeneration = undefined
        playing = false
        unsubscribeFault = undefined
      })
      await playbackSession.prepareGraph(prepared.graph)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      for (const asset of prepared.graph.assets) {
        const source = compilation.snapshot.assets.find((candidate) => candidate.assetId === asset.assetId)
        if (!source) throw new Error(`Portable audio asset "${asset.assetId}" is unavailable.`)
        const result = await playbackSession.registerAsset(asset, planarPcm(source.buffer), nextEpoch)
        if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
        if (result.status !== "registered") throw new Error(`Portable audio asset "${asset.assetId}" was rejected.`)
      }
      await playbackSession.publishGraph(prepared.graph.revision)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.setTransport(nextEpoch, false, prepared.schedule.timeOrigin.frame)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.installSchedule(prepared.schedule)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.scheduleSources(prepared.graph.revision, nextEpoch, prepared.sources)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.setTransport(nextEpoch, true, prepared.schedule.timeOrigin.frame)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      if (sessionFault) throw sessionFault
      active = playbackSession
      activeProjectGeneration = projectGeneration
      playing = true
      epoch = nextEpoch
      unsubscribeFault = unsubscribeSessionFault
      unsubscribeSessionFault = undefined
      playbackSession.markActive()
      return "started"
    } catch (error) {
      unsubscribeSessionFault?.()
      session?.dispose()
      if (!cancelled()) {
        input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not start.")
      }
      return "unavailable"
    }
  }

  const start = (transport: LivePlaybackTransport): Promise<PortableStartResult> => {
    if (playing) return Promise.resolve("started")
    if (pendingStart) return pendingStart
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = startAttempt(transport, generation, projectGeneration)
    pendingStart = request
    void request.finally(() => {
      if (pendingStart === request) pendingStart = undefined
    })
    return request
  }

  const pause = async (playheadSec: number) => {
    const session = active
    if (!session || !playing) return
    if (recording) throw new Error("Portable recording must stop before playback can pause.")
    const context = input.getAudioContext()
    if (!context) throw new Error("Portable audio context is unavailable.")
    try {
      await session.setTransport(epoch, false, Math.round(playheadSec * context.sampleRate))
      if (active === session) playing = false
    } catch (error) {
      if (active === session) {
        input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not pause.")
        dispose()
      }
      throw error
    }
  }

  const startRecording = async (recordingInput: {
    appSessionId: string
    stream: MediaStream
    layout: "mono" | "stereo"
    inputChannel: number
    gain: number
    polarity: 1 | -1
    monitoring: boolean
    punchStartFrame: number
    punchEndFrame?: number
    onDiagnostics?: (diagnostics: PortableRecordingDiagnostics) => void
    onFailure?: (error: Error) => void
  }) => {
    const playbackSession = active
    const context = input.getAudioContext()
    if (!playbackSession || !playing || !context || recording) throw new Error("Portable playback is not active for recording.")
    const track = recordingInput.stream.getAudioTracks()[0]
    if (!track || track.readyState === "ended") throw new Error("Portable recording input is unavailable.")
    const channelCount = recordingInput.layout === "stereo" ? 2 : 1
    const inputChannels = channelCount === 2
      ? [recordingInput.inputChannel, recordingInput.inputChannel + 1]
      : [recordingInput.inputChannel]
    const availableChannels = Math.min(track.getSettings().channelCount ?? 1, 2)
    if (inputChannels.some((channel) => channel < 0 || channel >= availableChannels)) {
      throw new Error("Selected portable recording input channels are unavailable.")
    }
    const numericSessionId = nextRecordingSessionId
    nextRecordingSessionId += 1
    let latestDiagnostics: PortableRecordingDiagnostics | undefined
    let writerQueuedFrames = 0
    let coreDrainPending = false
    let requestNextDrain = () => {}
    const writer = (input.createRecordingWriter ?? createPortableRecordingWriter)({
      generation: epoch,
      sessionId: recordingInput.appSessionId,
      sampleRate: context.sampleRate,
      channelCount,
      onQueuedFrames: (queuedFrames) => {
        writerQueuedFrames = queuedFrames
        recordingInput.onDiagnostics?.({
          version: portableWasmProtocolVersion,
          type: "recording-capture-diagnostics",
          generation: epoch,
          sessionId: numericSessionId,
          capturedFrames: latestDiagnostics?.capturedFrames ?? 0,
          droppedFrames: latestDiagnostics?.droppedFrames ?? 0,
          droppedBlocks: latestDiagnostics?.droppedBlocks ?? 0,
          availableBlocks: latestDiagnostics?.availableBlocks ?? 0,
          queuedBlocks: Math.ceil(queuedFrames / RECORDER_BLOCK_FRAMES),
          rms: latestDiagnostics?.rms ?? 0,
          peak: latestDiagnostics?.peak ?? 0,
          fatal: false,
          active: true,
        })
        requestNextDrain()
      },
    })
    const source = context.createMediaStreamSource(recordingInput.stream)
    const configured = deferred<number>()
    const finalized = deferred<void>()
    const cancelled = deferred<void>()
    const session: PortableRecordingSession = {
      numericSessionId,
      source,
      disconnectInput: () => undefined,
      unsubscribeStatus: () => undefined,
      unsubscribeTrack: () => undefined,
      writer,
      configured,
      finalized,
      cancelled,
      onFailure: recordingInput.onFailure,
      phase: "configuring",
      configurationPending: false,
      terminal: false,
    }
    requestNextDrain = () => {
      if (recording === session && session.phase !== "cancelling" && coreDrainPending
        && writerQueuedFrames < RECORDER_BLOCK_FRAMES * RECORDER_MAX_QUEUED_BLOCKS) {
        coreDrainPending = false
        playbackSession.postRecordingControl({ version: portableWasmProtocolVersion, type: "recording-capture-drain" })
      }
    }
    session.unsubscribeStatus = playbackSession.onRecordingStatus((message) => {
      if (!("generation" in message) || !("sessionId" in message)
        || message.generation !== epoch || message.sessionId !== numericSessionId) return
      if (message.type === "recording-capture-available") {
        coreDrainPending = true
        requestNextDrain()
        return
      }
      if (message.type === "recording-capture-block") {
        try {
          writer.write(message)
        } catch (error) {
          failRecording(session, error instanceof Error ? error : new Error("Portable recording writer failed."))
        }
        return
      }
      if (message.type === "recording-capture-diagnostics") {
        latestDiagnostics = message
        coreDrainPending = message.queuedBlocks > 0
        session.diagnostics = message
        recordingInput.onDiagnostics?.(message)
        if (message.fatal) failRecording(session, new Error("Portable recording capture overflowed."))
        else requestNextDrain()
        return
      }
      if (message.type !== "recording-capture-applied") return
      if (message.action === "configured") configured.resolve(message.frame)
      else if (message.action === "finalized") finalized.resolve()
      else cancelled.resolve()
    })
    const onEnded = () => failRecording(session, new Error("Portable recording device ended."))
    track.addEventListener("ended", onEnded, { once: true })
    session.unsubscribeTrack = () => track.removeEventListener("ended", onEnded)
    recording = session
    try {
      await writer.ready
      session.disconnectInput = playbackSession.connectInput(source)
      session.configurationPending = true
      playbackSession.postRecordingControl({
        version: portableWasmProtocolVersion,
        type: "recording-capture-configure",
        generation: epoch,
        sessionId: numericSessionId,
        channelCount,
        inputChannels,
        gain: recordingInput.gain,
        polarity: recordingInput.polarity,
        monitoring: recordingInput.monitoring,
        punchStartFrame: recordingInput.punchStartFrame,
        punchEndFrame: recordingInput.punchEndFrame ?? null,
      })
      const startFrame = await boundedControl(configured.promise, "Portable recording configuration timed out.")
      session.configurationPending = false
      session.phase = "recording"
      return { sampleRate: context.sampleRate, channelCount, startFrame }
    } catch (error) {
      session.configurationPending = false
      failRecording(session, error instanceof Error ? error : new Error("Portable recording could not start."))
      throw error
    }
  }

  const stopRecording = async () => {
    const session = recording
    const playbackSession = active
    if (!session || !playbackSession || session.terminal) throw new Error("Portable recording is not active.")
    session.terminal = true
    session.phase = "finalizing"
    playbackSession.postRecordingControl({
      version: portableWasmProtocolVersion,
      type: "recording-capture-finalize",
      stopFrame: null,
    })
    try {
      await boundedControl(session.finalized.promise, "Portable recording finalization timed out.")
      const capturedFrames = session.diagnostics?.capturedFrames ?? 0
      const result = await session.writer.finalize(capturedFrames)
      clearRecording(session)
      return result
    } catch (error) {
      session.terminal = false
      failRecording(session, error instanceof Error ? error : new Error("Portable recording finalization failed."))
      throw error
    }
  }

  const cancelRecording = async () => {
    const session = recording
    const playbackSession = active
    if (!session || !playbackSession || session.terminal) return
    session.terminal = true
    session.phase = "cancelling"
    playbackSession.postRecordingControl({ version: portableWasmProtocolVersion, type: "recording-capture-cancel" })
    try {
      await boundedControl(session.cancelled.promise, "Portable recording cancellation timed out.")
    } finally {
      void session.writer.abort().catch(() => undefined)
      session.writer.terminate()
      clearRecording(session)
    }
  }

  return {
    start,
    pause,
    dispose,
    startRecording,
    stopRecording,
    cancelRecording,
    isActive: () => playing,
    isPrepared: () => active !== undefined,
    isRecording: () => recording !== undefined,
  }
}
