import {
  selectPortableWasmAudioWorkletBackend,
  type PortableWasmCapability,
  type PortableWasmBackendSelection,
  type PortableWasmPlaybackSession,
  WasmAudioWorkletBackend,
} from "@daw-browser/audio-engine/wasm-audio-worklet-backend"
import { LIVE_SCHEDULE_HORIZON_SEC } from "@daw-browser/audio-engine/audio-engine"
import type { AudioCoreGraphSnapshot, PlanarPcm } from "@daw-browser/audio-core-contract"
import type {
  PreparedPortableSession,
  PortableAssetRegistryInput,
  PortablePreparedQualification,
} from "@daw-browser/audio-engine/portable-session-compiler"
import {
  portableWasmMaxAssets,
  portableWasmProtocolVersion,
  type PortableWasmStatusMessage,
} from "@daw-browser/audio-engine/portable-wasm-protocol"
import {
  nativeAudioHostMaximumAssetFramesForChannels,
  nativeAudioHostMaximumStretchPreparationBytes,
} from "@daw-browser/desktop-protocol/native-audio-host"
import { RECORDER_BLOCK_FRAMES, RECORDER_MAX_QUEUED_BLOCKS } from "@daw-browser/audio-engine/recording-protocol"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import { compilePreparedPortableLiveSession } from "~/lib/portable-live-session"
import type { LivePlaybackCompileContext, LivePlaybackSnapshot, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import { createPortableRecordingWriter } from "~/lib/recording/portable-recording-writer"
import type {
  LiveProcessorControl,
  LiveProcessorControlRequest,
  LiveProcessorControlResult,
} from "~/lib/live-processor-control"
import {
  isPortableStretchClip,
  preparePortableStretchAssets,
  type PortablePreparedStretchAsset,
} from "@daw-browser/audio-engine/portable-stretch-preparation"
import type { AudioPcmSourceResolver } from "~/lib/audio-pcm-source-resolver"

type PortableStartResult = "started" | "unavailable"
type PortableScheduleRange = Extract<PreparedPortableSession, { supported: true }>["scheduleRange"]
type PortableSessionFault = {
  error?: Error
}

type PortableSession = Pick<
  PortableWasmPlaybackSession,
  | "connectInput" | "dispose" | "installSchedule" | "markActive" | "onFault" | "onRecordingStatus" | "postRecordingControl" | "prepareGraph" | "publishGraph" | "registerAsset" | "scheduleSources" | "setTransport"
> & {
  queueProcessorEvents?: PortableWasmPlaybackSession["queueProcessorEvents"]
  reenableProcessorAutomation?: PortableWasmPlaybackSession["reenableProcessorAutomation"]
  onTransportPosition?: PortableWasmPlaybackSession["onTransportPosition"]
  onGraphContinuity?: PortableWasmPlaybackSession["onGraphContinuity"]
}

type PortableBackend = {
  createPlaybackSession: (
    context: BaseAudioContext,
    capability: Extract<PortableWasmCapability, { available: true }>,
    maxFramesPerBlock: number,
  ) => Promise<PortableSession>
}

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
  }, (cause: unknown) => {
    clearTimeout(deadline)
    reject(cause)
  })
})

const planarPcm = (buffer: AudioBuffer): PlanarPcm => ({
  frameCount: buffer.length,
  planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
})

const instrumentAssetKeys = (snapshot: LivePlaybackSnapshot) => new Set(
  Object.values(snapshot.mixer.fx.trackFx ?? {}).flatMap((entry) => {
    if (entry.instrument?.kind === 'sampler') {
      return entry.instrument.params.zones.map((zone) => zone.sample.assetKey)
    }
    if (entry.instrument?.kind === 'drum-rack') {
      return entry.instrument.params.pads.flatMap((pad) => pad.sample ? [pad.sample.assetKey] : [])
    }
    if (entry.instrument?.kind === 'granular' && entry.instrument.params.zone) {
      return [entry.instrument.params.zone.sample.assetKey]
    }
    return []
  }),
)

const isInstalledSnapshotAsset = (
  snapshot: LivePlaybackSnapshot,
  assetId: string,
  instrumentKeys: ReadonlySet<string>,
) => {
  const usedByStretch = snapshot.tracks.some((track) => track.clips.some((clip) => (
    clip.sourceAssetKey === assetId
    && clip.audioWarp?.enabled === true
    && clip.audioWarp.mode === 'stretch'
  )))
  const usedByInstalledSource = snapshot.tracks.some((track) => track.clips.some((clip) => (
    clip.sourceAssetKey === assetId
    && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch')
  )))
  return !usedByStretch || usedByInstalledSource || instrumentKeys.has(assetId)
}

const assetRegistry = (
  snapshot: LivePlaybackSnapshot,
  generation: number,
  preparedStretchAssets: readonly PortablePreparedStretchAsset[] = [],
): PortableAssetRegistryInput => ({
  projectGeneration: generation,
  assets: [
    ...(() => {
      const instrumentKeys = instrumentAssetKeys(snapshot)
      return snapshot.assets.flatMap((asset) => {
        const buffer = asset.buffer
        if (!buffer || !isInstalledSnapshotAsset(snapshot, asset.assetId, instrumentKeys)) return []
        return [{
          projectAssetId: asset.assetId,
          portableAssetId: asset.assetId,
          projectGeneration: generation,
          handle: { slot: 0, generation },
          decoded: {
            sampleRateHz: buffer.sampleRate,
            channelCount: buffer.numberOfChannels,
            frameCount: buffer.length,
          },
        }]
      }).map((entry, slot) => ({ ...entry, handle: { ...entry.handle, slot } }))
    })(),
    ...preparedStretchAssets.map((prepared, slot) => ({
      projectAssetId: prepared.projectAssetId,
      portableAssetId: prepared.portableAssetId,
      projectGeneration: generation,
      handle: { slot: installedSnapshotAssetCount(snapshot) + slot, generation },
      decoded: {
        sampleRateHz: prepared.asset.sampleRateHz,
        channelCount: prepared.asset.channelCount,
        frameCount: prepared.asset.frameCount,
      },
    })),
  ],
})

const installedSnapshotAssetCount = (snapshot: LivePlaybackSnapshot) => {
  const instrumentKeys = instrumentAssetKeys(snapshot)
  return snapshot.assets.reduce((count, asset) => {
    if (!asset.buffer) return count
    return count + (isInstalledSnapshotAsset(snapshot, asset.assetId, instrumentKeys) ? 1 : 0)
  }, 0)
}

const preparedSession = (
  snapshot: LivePlaybackSnapshot,
  sampleRateHz: number,
  epoch: number,
  projectGeneration: number,
  horizonSec: number,
  sourceFirstSequence = 1,
  preparedStretchAssets: readonly PortablePreparedStretchAsset[] = [],
): PreparedPortableSession => compilePreparedPortableLiveSession(snapshot, {
  assetRegistry: assetRegistry(snapshot, projectGeneration, preparedStretchAssets),
  preparedStretchAssets: new Map(preparedStretchAssets.map((asset) => [asset.clipId, asset])),
  sampleRateHz,
  transportEpoch: epoch,
  timeOrigin: {
    timelineSec: snapshot.transport.playheadSec,
    frame: Math.round(snapshot.transport.playheadSec * sampleRateHz),
  },
  rangeEndSec: snapshot.transport.playheadSec + horizonSec,
  clipSpanningNoteOn: true,
  sourceFirstSequence,
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
  compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
  getAudioContext: () => AudioContext | null
  scheduleHorizonSec?: number
  getProjectGeneration?: () => number
  resolveSource?: AudioPcmSourceResolver
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  reportFault?: (message: string) => void
  onGraphContinuity?: (message: Extract<PortableWasmStatusMessage, { type: "graph-continuity" }>) => void
  backend?: PortableBackend
  select?: (project: PortablePreparedQualification) => Promise<PortableWasmBackendSelection>
  createRecordingWriter?: typeof createPortableRecordingWriter
}) => {
  const backend = input.backend ?? new WasmAudioWorkletBackend()
  const select = input.select ?? ((project) => selectPortableWasmAudioWorkletBackend(undefined, project))
  const safeProjectGeneration = (generation: number) =>
    Number.isSafeInteger(generation) && generation > 0 ? generation : 1
  let active: PortableSession | undefined
  let activeProjectGeneration: number | undefined
  let activeTransport: LivePlaybackTransport | undefined
  let activeScheduleRange: PortableScheduleRange | undefined
  let playing = false
  let pendingStart: Promise<PortableStartResult> | undefined
  let pendingStartMode: "play" | "preview" | undefined
  let lifecycleGeneration = 0
  let recording: PortableRecordingSession | undefined
  let epoch = 0
  let positionFrame = 0
  let positionSequence = 0
  let activeSourceSequence = 0
  let refreshPromise: Promise<PortableStartResult> | undefined
  let transportIntent = 0
  let failedRefreshEndFrame: number | undefined
  let activeRevision: number | undefined
  let activeGraph: AudioCoreGraphSnapshot | undefined
  let activePreparedStretchAssets: readonly PortablePreparedStretchAsset[] = []
  let nextLiveProcessorSequence = 0
  let nextRecordingSessionId = 1
  let unsubscribeFault: (() => void) | undefined
  let stretchPreparationAbortController: AbortController | undefined

  const clearActiveSessionState = () => {
    active = undefined
    activeProjectGeneration = undefined
    activeTransport = undefined
    activeScheduleRange = undefined
    activeRevision = undefined
    activeGraph = undefined
    activePreparedStretchAssets = []
    playing = false
  }

  const invalidateActiveSession = () => {
    unsubscribeFault?.()
    unsubscribeFault = undefined
    const session = active
    clearActiveSessionState()
    session?.dispose()
  }

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
  }

  const dispose = () => {
    lifecycleGeneration += 1
    transportIntent += 1
    pendingStart = undefined
    pendingStartMode = undefined
    refreshPromise = undefined
    stretchPreparationAbortController?.abort()
    stretchPreparationAbortController = undefined
    const recordingSession = recording
    if (recordingSession) failRecording(recordingSession, new Error("Portable recording stopped with playback."))
    invalidateActiveSession()
  }

  type PreparedRuntime = {
    session: PortableSession
    prepared: Extract<PreparedPortableSession, { supported: true }>
    projectGeneration: number
    epoch: number
    transport: LivePlaybackTransport
    requestedFrame: number
    unsubscribeFault: () => void
    sessionFault: PortableSessionFault
    preparedStretchAssets: readonly PortablePreparedStretchAsset[]
  }

  const prepareRuntime = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
    nextEpoch: number,
    sourceFirstSequence: number,
    compileContext?: LivePlaybackCompileContext,
  ): Promise<PreparedRuntime | undefined> => {
    const context = input.getAudioContext()
    if (!context) return undefined
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
    const requestedFrame = Math.round(transport.playheadSec * context.sampleRate)
    let session: PortableSession | undefined
    let unsubscribeSessionFault: (() => void) | undefined
    const sessionFault: PortableSessionFault = {}
    try {
      const compilation = await input.compileSnapshot(transport, compileContext)
      if (cancelled()) return undefined
      if (!compilation.supported || compilation.snapshot.transport.loopEnabled) return undefined
      const preparationAbortController = new AbortController()
      stretchPreparationAbortController = preparationAbortController
      let preparedStretchAssets: readonly PortablePreparedStretchAsset[] = []
      try {
        if (compilation.snapshot.tracks.some((track) => track.clips.some(isPortableStretchClip))) {
          const preparation = await preparePortableStretchAssets({
            tracks: compilation.snapshot.tracks,
            projectBpm: compilation.snapshot.bpm,
            projectGeneration: safeProjectGeneration(projectGeneration),
            createBuffer: input.createBuffer ?? ((channels, frames, sampleRate) => new AudioBuffer({
              numberOfChannels: channels,
              length: frames,
              sampleRate,
            })),
            resolveSource: input.resolveSource,
            maximumAssetCount: portableWasmMaxAssets,
            existingAssetCount: installedSnapshotAssetCount(compilation.snapshot),
            maximumFrameCount: nativeAudioHostMaximumAssetFramesForChannels,
            maximumPreparationBytes: nativeAudioHostMaximumStretchPreparationBytes,
            signal: preparationAbortController.signal,
          })
          if (!preparation.supported) {
            input.reportFault?.(preparation.diagnostics.map((diagnostic) => diagnostic.message).join(" "))
            return undefined
          }
          preparedStretchAssets = preparation.assets
        }
      } finally {
        if (stretchPreparationAbortController === preparationAbortController) {
          stretchPreparationAbortController = undefined
        }
      }
      if (cancelled()) return undefined
      const prepared = preparedSession(
        compilation.snapshot,
        context.sampleRate,
        nextEpoch,
        safeProjectGeneration(projectGeneration),
        input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC,
        sourceFirstSequence,
        preparedStretchAssets,
      )
      if (!prepared.supported) return undefined
      const selection = await select(prepared.qualification)
      if (cancelled()) return undefined
      if (!selection.selected) return undefined
      const playbackSession = await backend.createPlaybackSession(context, selection.capability, 8_192)
      session = playbackSession
      unsubscribeSessionFault = playbackSession.onFault((error: Error) => {
        if (active !== playbackSession) {
          sessionFault.error = error
          return
        }
        const recordingSession = recording
        if (recordingSession) failRecording(recordingSession, error)
        input.reportFault?.(error.message)
        unsubscribeFault = undefined
        clearActiveSessionState()
      })
      await playbackSession.prepareGraph(prepared.graph)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      for (const asset of prepared.graph.assets) {
        const source = compilation.snapshot.assets.find((candidate) => candidate.assetId === asset.assetId)
        const preparedSource = preparedStretchAssets.find((candidate) => candidate.asset.assetId === asset.assetId)
        const pcm = preparedSource?.pcm ?? (source?.buffer ? planarPcm(source.buffer) : undefined)
        if (!pcm) throw new Error(`Portable playback asset "${asset.assetId}" is not hydrated.`)
        const result = await playbackSession.registerAsset(asset, pcm, nextEpoch)
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
      if (runTransport) {
        if (
          !Number.isSafeInteger(requestedFrame)
          || requestedFrame < prepared.scheduleRange.startFrame
          || requestedFrame >= prepared.scheduleRange.endFrame
        ) throw new Error("Portable browser playback requested transport is outside its prepared schedule.")
        await playbackSession.setTransport(nextEpoch, true, requestedFrame)
      }
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      if (sessionFault.error) throw sessionFault.error
      playbackSession.onTransportPosition?.((position) => {
        if (
          active !== playbackSession
          || position.epoch !== nextEpoch
          || position.sequence <= positionSequence
        ) return
        if (position.frame < positionFrame && position.running) return
        positionSequence = position.sequence
        positionFrame = position.frame
      })
      playbackSession.onGraphContinuity?.((message) => input.onGraphContinuity?.(message))
      if (runTransport) playbackSession.markActive()
      return {
        session: playbackSession,
        prepared,
        projectGeneration,
        epoch: nextEpoch,
        transport: { ...transport },
        requestedFrame,
        unsubscribeFault: unsubscribeSessionFault,
        sessionFault,
        preparedStretchAssets,
      }
    } catch (error) {
      unsubscribeSessionFault?.()
      session?.dispose()
      if (!cancelled()) {
        input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not start.")
      }
      return undefined
    }
  }

  const commitRuntime = (runtime: PreparedRuntime, runTransport: boolean) => {
    active = runtime.session
    activeProjectGeneration = runtime.projectGeneration
    activeTransport = runtime.transport
    activeScheduleRange = runtime.prepared.scheduleRange
    activeRevision = runtime.prepared.graph.revision
    activeGraph = runtime.prepared.graph
    activePreparedStretchAssets = runtime.preparedStretchAssets
    playing = runTransport
    epoch = runtime.epoch
    positionFrame = runTransport ? runtime.requestedFrame : runtime.prepared.schedule.timeOrigin.frame
    positionSequence = 0
    unsubscribeFault = runtime.unsubscribeFault
    activeSourceSequence = runtime.prepared.sources.length === 0
      ? 0
      : runtime.prepared.sources[runtime.prepared.sources.length - 1]?.sequence ?? 0
    failedRefreshEndFrame = undefined
  }

  const startAttempt = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
    compileContext?: LivePlaybackCompileContext,
  ): Promise<PortableStartResult> => {
    const context = input.getAudioContext()
    if (!context) return "unavailable"
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
    const requestedFrame = Math.round(transport.playheadSec * context.sampleRate)
    const horizonSec = input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC
    const requestedScheduleEndFrame = requestedFrame
      + Math.round(horizonSec * context.sampleRate)
    // Portable schedules currently have no loop-reset semantics, so an
    // enabled loop must never promote an existing schedule.
    const compatibleWithActiveSchedule = activeTransport !== undefined
      && activeScheduleRange !== undefined
      && !activeTransport.loopEnabled
      && !transport.loopEnabled
      && Number.isSafeInteger(requestedFrame)
      && requestedFrame >= activeScheduleRange.startFrame
      && Number.isSafeInteger(requestedScheduleEndFrame)
      && requestedScheduleEndFrame <= activeScheduleRange.endFrame
    if (active && activeProjectGeneration === projectGeneration && compatibleWithActiveSchedule) {
      try {
        await active.setTransport(epoch, runTransport, requestedFrame)
        positionFrame = requestedFrame
        if (cancelled()) {
          dispose()
          return "unavailable"
        }
        if (runTransport) active.markActive()
        playing = runTransport
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
      invalidateActiveSession()
    }
    const nextEpoch = epoch + 1
    const runtime = await prepareRuntime(
      transport,
      generation,
      projectGeneration,
      runTransport,
      nextEpoch,
      1,
      compileContext,
    )
    if (!runtime || cancelled()) return "unavailable"
    commitRuntime(runtime, runTransport)
    return "started"
  }

  const refreshSchedule = (): Promise<PortableStartResult> => {
    if (!playing || !active || refreshPromise) return refreshPromise ?? Promise.resolve<PortableStartResult>("started")
    const context = input.getAudioContext()
    if (!context || activeTransport?.loopEnabled) return Promise.resolve("started")
    const horizonSec = input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC
    const leadSec = Math.min(5, Math.max(0.05, horizonSec * 0.25))
    const currentFrame = positionFrame
    const endFrame = activeScheduleRange?.endFrame
    if (failedRefreshEndFrame !== undefined && currentFrame >= failedRefreshEndFrame) {
      const session = active
      playing = false
      failedRefreshEndFrame = undefined
      activeTransport = activeTransport ? { ...activeTransport, state: "paused" } : undefined
      void session?.setTransport(epoch, false, currentFrame).catch(() => undefined)
      input.reportFault?.("Portable playback reached the end of its active schedule after refresh failed.")
      return Promise.resolve("unavailable")
    }
    if (endFrame === undefined || endFrame - currentFrame > Math.round(leadSec * context.sampleRate)) {
      return Promise.resolve("started")
    }
    const previousSession = active
    const previousUnsubscribeFault = unsubscribeFault
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const intent = transportIntent
    const transport: LivePlaybackTransport = {
      ...(activeTransport ?? {
        state: "playing",
        playheadSec: currentFrame / context.sampleRate,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
      state: "playing",
      playheadSec: currentFrame / context.sampleRate,
    }
    const request: Promise<PortableStartResult> = (async (): Promise<PortableStartResult> => {
      if (recording) {
        const nextEpoch = epoch
        const compilation = await input.compileSnapshot(transport)
        if (
          generation !== lifecycleGeneration
          || intent !== transportIntent
          || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
          || active !== previousSession
          || !playing
          || !compilation.supported
          || compilation.snapshot.transport.loopEnabled
          || compilation.snapshot.revision !== activeRevision
        ) return "unavailable"
        const prepared = preparedSession(
          compilation.snapshot,
          context.sampleRate,
          nextEpoch,
          safeProjectGeneration(projectGeneration),
          horizonSec,
          activeSourceSequence + 1,
          activePreparedStretchAssets,
        )
        if (
          !prepared.supported
          || prepared.graph.revision !== activeRevision
          || prepared.graph.assets.some((asset) => !activeGraph?.assets.some((current) => current.assetId === asset.assetId))
        ) return "unavailable"
        try {
          const extensionStartFrame = activeScheduleRange?.endFrame ?? currentFrame
          const extensionSources = prepared.sources.filter((source) => source.startFrame >= extensionStartFrame)
          await previousSession.scheduleSources(prepared.graph.revision, nextEpoch, extensionSources)
          await previousSession.installSchedule(prepared.schedule)
          if (
            generation !== lifecycleGeneration
            || intent !== transportIntent
            || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
            || active !== previousSession
            || !playing
          ) return "unavailable"
          activeScheduleRange = prepared.scheduleRange
          activeSourceSequence = extensionSources.length === 0
            ? activeSourceSequence
            : extensionSources[extensionSources.length - 1]?.sequence ?? activeSourceSequence
          activeTransport = { ...transport }
          return "started"
        } catch (error) {
          failedRefreshEndFrame = activeScheduleRange?.endFrame
          input.reportFault?.(error instanceof Error ? error.message : "Portable schedule refresh failed.")
          return "unavailable"
        }
      }

      const stillCurrent = () => generation === lifecycleGeneration
        && intent === transportIntent
        && projectGeneration === (input.getProjectGeneration?.() ?? 0)
      const preservesActiveGraph = (runtime: PreparedRuntime | undefined) => runtime !== undefined
        && runtime.prepared.graph.revision === activeRevision
        && runtime.prepared.graph.assets.length === (activeGraph?.assets.length ?? 0)
        && runtime.prepared.graph.assets.every((asset) => (
          activeGraph?.assets.some((current) => current.assetId === asset.assetId)
        ))
      const hasContinuationCoverage = (runtime: PreparedRuntime, frame: number) => {
        const requiredEndFrame = frame + Math.round(horizonSec * context.sampleRate)
        return Number.isSafeInteger(frame)
          && frame >= runtime.prepared.scheduleRange.startFrame
          && frame < runtime.prepared.scheduleRange.endFrame
          && Number.isSafeInteger(requiredEndFrame)
          && requiredEndFrame <= runtime.prepared.scheduleRange.endFrame
      }
      const replacementTransport = (frame: number): LivePlaybackTransport => ({
        ...transport,
        playheadSec: frame / context.sampleRate,
      })

      let runtime = await prepareRuntime(
        transport,
        generation,
        projectGeneration,
        false,
        epoch + 1,
        1,
      )
      let latestFrame = positionFrame
      let valid = runtime !== undefined
        && preservesActiveGraph(runtime)
        && runtime.sessionFault.error === undefined
        && stillCurrent()
        && active === previousSession
        && playing
      if (valid && runtime && !hasContinuationCoverage(runtime, latestFrame)) {
        runtime.session.dispose()
        runtime = await prepareRuntime(
          replacementTransport(positionFrame),
          generation,
          projectGeneration,
          false,
          epoch + 1,
          1,
        )
        latestFrame = positionFrame
        valid = runtime !== undefined
          && preservesActiveGraph(runtime)
          && runtime.sessionFault.error === undefined
          && stillCurrent()
          && active === previousSession
          && playing
          && runtime !== undefined
          && hasContinuationCoverage(runtime, latestFrame)
      }
      if (!valid || !runtime) {
        if (runtime && !preservesActiveGraph(runtime)) {
          input.reportFault?.("Portable schedule refresh changed the active graph.")
        }
        if (runtime?.sessionFault.error) {
          input.reportFault?.(runtime.sessionFault.error.message)
        }
        if (
          (!runtime
            || !preservesActiveGraph(runtime)
            || runtime.sessionFault.error !== undefined
            || !hasContinuationCoverage(runtime, latestFrame))
          && stillCurrent()
          && active === previousSession
          && playing
        ) failedRefreshEndFrame = activeScheduleRange?.endFrame
        runtime?.session.dispose()
        return "unavailable"
      }

      // The old session remains audible during preparation. Once all checks
      // pass, make the handoff a hard boundary before starting the prepared
      // replacement so two sessions can never run at once.
      latestFrame = positionFrame
      if (!hasContinuationCoverage(runtime, latestFrame) || runtime.sessionFault.error !== undefined || !stillCurrent()
        || active !== previousSession || !playing) {
        runtime.session.dispose()
        if (stillCurrent() && active === previousSession && playing) {
          failedRefreshEndFrame = activeScheduleRange?.endFrame
        }
        return "unavailable"
      }
      previousUnsubscribeFault?.()
      unsubscribeFault = undefined
      clearActiveSessionState()
      try {
        previousSession.dispose()
      } catch (error) {
        runtime.unsubscribeFault()
        runtime.session.dispose()
        if (stillCurrent()) {
          input.reportFault?.(error instanceof Error ? error.message : "Portable schedule refresh could not dispose the old session.")
        }
        return "unavailable"
      }
      try {
        await runtime.session.setTransport(runtime.epoch, true, latestFrame)
        if (!stillCurrent() || runtime.sessionFault.error) {
          throw runtime.sessionFault.error ?? new Error("Portable schedule refresh was cancelled.")
        }
        runtime.session.markActive()
        if (!stillCurrent() || runtime.sessionFault.error) {
          throw runtime.sessionFault.error ?? new Error("Portable schedule refresh was cancelled.")
        }
        commitRuntime(runtime, true)
        positionFrame = latestFrame
        activeTransport = {
          ...runtime.transport,
          state: "playing",
          playheadSec: latestFrame / context.sampleRate,
        }
        return "started"
      } catch (error) {
        runtime.unsubscribeFault()
        runtime.session.dispose()
        if (stillCurrent()) {
          input.reportFault?.(
            error instanceof Error && error.message !== "Portable schedule refresh was cancelled."
              ? error.message
              : "Portable schedule refresh could not start the replacement.",
          )
        }
        return "unavailable"
      }
    })().catch((cause: unknown) => {
      failedRefreshEndFrame = activeScheduleRange?.endFrame
      input.reportFault?.(cause instanceof Error ? cause.message : "Portable schedule refresh failed.")
      return "unavailable"
    })
    refreshPromise = request
    void request.finally(() => {
      if (refreshPromise === request) refreshPromise = undefined
    })
    return request
  }

  const start = (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<PortableStartResult> => {
    if (playing) return Promise.resolve("started")
    if (pendingStart) {
      if (pendingStartMode === "play") return pendingStart
      const previewRequest = pendingStart
      const generation = lifecycleGeneration
      const projectGeneration = input.getProjectGeneration?.() ?? 0
      const request = previewRequest.then((result) => result === "started"
        ? startAttempt(transport, generation, projectGeneration, true, compileContext)
        : result)
      pendingStart = request
      pendingStartMode = "play"
      void request.finally(() => {
        if (pendingStart === request) {
          pendingStart = undefined
          pendingStartMode = undefined
        }
      })
      return request
    }
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = startAttempt(transport, generation, projectGeneration, true, compileContext)
    pendingStart = request
    pendingStartMode = "play"
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
      }
    })
    return request
  }

  const ensurePrepared = (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<PortableStartResult> => {
    if (pendingStart) return pendingStart
    if (active && !playing && activeProjectGeneration === (input.getProjectGeneration?.() ?? 0)) {
      return Promise.resolve("started")
    }
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = startAttempt(transport, generation, projectGeneration, false, compileContext)
    pendingStart = request
    pendingStartMode = "preview"
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
      }
    })
    return request
  }

  const rebuildPrepared = async (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<PortableStartResult> => {
    if (!active) return "unavailable"
    dispose()
    return ensurePrepared(transport, compileContext)
  }

  const pause = async (playheadSec: number) => {
    transportIntent += 1
    const session = active
    if (!session || !playing) return
    if (recording) throw new Error("Portable recording must stop before playback can pause.")
    const context = input.getAudioContext()
    if (!context) throw new Error("Portable audio context is unavailable.")
    try {
      await session.setTransport(epoch, false, Math.round(playheadSec * context.sampleRate))
      positionFrame = Math.round(playheadSec * context.sampleRate)
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

  const queueLiveProcessorControl = async (
    request: LiveProcessorControlRequest,
  ): Promise<LiveProcessorControlResult> => {
    if (!active || !active.queueProcessorEvents || activeRevision === undefined || activeGraph === undefined) {
      return { accepted: false, reason: "unprepared" }
    }
    if (request.revision !== undefined && request.revision !== activeRevision
      || request.epoch !== undefined && request.epoch !== epoch) {
      return { accepted: false, reason: "stale" }
    }
    const processor = resolveGraphProcessor(activeGraph, request.instanceId)
    if (!processor) return { accepted: false, reason: "unsupported" }
    const events = request.values.map((value) => {
      const target = processor.parameterTargets.get(value.parameterId)
      return target === undefined || !Number.isFinite(value.value)
        ? undefined
        : {
            processorInstanceId: processor.processor.instanceId,
            parameterTarget: target,
            frameOffset: 0,
            value: value.value,
          }
    })
    if (events.some((event) => event === undefined)) return { accepted: false, reason: "unsupported" }
    const sequence = Math.max(nextLiveProcessorSequence + 1, request.sequence ?? 0)
    nextLiveProcessorSequence = sequence
    try {
      await active.queueProcessorEvents(
        activeRevision,
        epoch,
        sequence,
        events.flatMap((event) => event === undefined ? [] : [event]),
      )
      return { accepted: true, sequence, appliedSequence: sequence }
    } catch (error) {
      return { accepted: false, reason: "bridge-error", error: error instanceof Error ? error.message : String(error) }
    }
  }

  const liveProcessorControl: LiveProcessorControl = {
    preview: queueLiveProcessorControl,
    flush: queueLiveProcessorControl,
    reenableAutomation: async (instanceId, parameterIds, revision, transportEpoch) => {
      if (revision !== activeRevision || transportEpoch !== epoch) return { accepted: false, reason: "stale" }
      if (!active || !active.reenableProcessorAutomation) return { accepted: false, reason: "unsupported" }
      const processor = activeGraph === undefined ? undefined : resolveGraphProcessor(activeGraph, instanceId)
      if (!processor || parameterIds.some((parameterId) => !processor.parameterTargets.has(parameterId))) {
        return { accepted: false, reason: "unsupported" }
      }
      const targets = parameterIds.map((parameterId) => processor.parameterTargets.get(parameterId))
        .filter((target): target is number => target !== undefined)
      const sequence = ++nextLiveProcessorSequence
      try {
        await active.reenableProcessorAutomation(revision, transportEpoch, processor.processor.instanceId, targets)
        return { accepted: true, sequence, appliedSequence: sequence }
      } catch (error) {
        return { accepted: false, reason: "bridge-error", error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
  const reenableProcessorAutomation = async (
    instanceId: string,
    parameterIds: readonly string[],
  ): Promise<LiveProcessorControlResult> => {
    if (activeRevision === undefined || activeGraph === undefined) {
      return { accepted: false, reason: "unprepared" }
    }
    return liveProcessorControl.reenableAutomation(instanceId, parameterIds, activeRevision, epoch)
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
    isPreparing: () => pendingStart !== undefined,
    liveProcessorControl,
    reenableProcessorAutomation,
    isRecording: () => recording !== undefined,
    ensurePrepared,
    rebuildPrepared,
    refreshSchedule,
    currentPositionSec: () => {
      const context = input.getAudioContext()
      return context ? positionFrame / context.sampleRate : undefined
    },
  }
}
