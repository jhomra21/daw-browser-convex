import {
  selectPortableWasmAudioWorkletBackend,
  portableWasmPagedPreparationCount,
  type PortableWasmCapability,
  type PortableWasmBackendSelection,
  WasmAudioWorkletBackend,
} from "@daw-browser/audio-engine/wasm-audio-worklet-backend"
import { LIVE_SCHEDULE_HORIZON_SEC } from "@daw-browser/audio-engine/audio-engine"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type {
  PreparedPortableSession,
  PortablePreparedQualification,
} from "@daw-browser/audio-engine/portable-session-compiler"
import {
  portableWasmPagedMaxChannels,
  portableWasmPagedPageFrames,
  portableWasmPagedSlotCount,
  portableWasmProtocolVersion,
  type PortableWasmStatusMessage,
  type PortableWasmInstrumentEvent,
} from "@daw-browser/audio-engine/portable-wasm-protocol"
import { RECORDER_BLOCK_FRAMES, RECORDER_MAX_QUEUED_BLOCKS } from "@daw-browser/audio-engine/recording-protocol"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import { arrangementFrameForLoop, effectiveLoopForStart, loopFramesForTransport, type LoopFrames } from "@daw-browser/audio-engine/loop-frame-schedule"
import type { LivePlaybackCompileContext, LivePlaybackSnapshot, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import { createPortableRecordingWriter } from "~/lib/recording/portable-recording-writer"
import type {
  LiveProcessorControl,
  LiveProcessorControlRequest,
  LiveProcessorControlResult,
} from "~/lib/live-processor-control"
import { preparePortablePagedStretchAssets } from "@daw-browser/audio-engine/portable-stretch-paging"
import {
  createPreparedStretchArtifactRepository,
  type PreparedStretchArtifactRepository,
} from "@daw-browser/audio-engine/prepared-stretch-store"
import type { AudioPcmSourceResolver } from "~/lib/audio-pcm-source-resolver"
/* oxlint-disable eslint/no-restricted-imports -- the live-parameter rules stay in the desktop mapper until the batch that owns the certification-pinned playback files moves it */
import { isLiveEventOnlyInstrumentChange, isLiveParameterChange, nativeBuiltInLiveStateCovered } from "~/lib/desktop/native-built-in-parameter-mapper"
/* oxlint-enable eslint/no-restricted-imports */
import {
  normalizeTrackInstrumentParams, parseJsonValue,
  type TrackInstrumentParams,
} from "@daw-browser/shared"
import { isPagedStretchAsset, resolveOrdinaryDescriptors, preparedSession } from "~/lib/portable-playback-assets"
import type { PortablePreparedStretch, PortableOrdinaryDescriptor } from "~/lib/portable-playback-assets"
import { withAcceptedLiveSynthValues, withLiveContentOf, hasStretchClips, withSeamContentOf, onSharedTracks, onKeptEffects, inSessionOrder, keepsInstrumentVoices, reconcileAtSeam } from "~/lib/portable-snapshot-reconcile"
import { requiredPagedPagePlan, pagedCapacityError, fitPortableStartupHorizon, registerGraphAsset, releasePreparations, preparePagedSources, withPreparations, ordinarySourcesOf, fitPagedWindow, replaceSourcesAtomically } from "~/lib/portable-paged-sources"
import type { PortableSession, PortablePagedPreparation, PortablePreparedSource } from "~/lib/portable-paged-sources"

type PortableStartResult = "started" | "unavailable"

// A locate the session cannot take without having failed (nothing was touched) is the caller's to rebuild.
type PortableSeekResult = PortableStartResult | "rebuild"

export type PortableAdoptionResult = "adopted" | "unchanged" | "failed" | "unavailable"

// Content the session cannot carry at a seam fails without a resubmit; callers see it as "failed".
type PortableAdoptionAttemptResult = PortableAdoptionResult | "unsupported"


type PortableScheduleRange = Extract<PreparedPortableSession, { supported: true }>["scheduleRange"]


type PortableSessionFault = {
  error?: Error
}



type PortableBackend = {
  createPlaybackSession: (
    context: BaseAudioContext,
    capability: Extract<PortableWasmCapability, { available: true }>,
    maxFramesPerBlock: number,
  ) => Promise<PortableSession>
}

const portableRecordingControlTimeoutMs = 2_000
const maxAdoptionResubmits = 8

// The native portable core reserves this fixed preparation table. It is not
// part of the wire capability payload, so the backend exposes the local
// default alongside the runtime paged capabilities.
const portablePagedPreparationCapacity = portableWasmPagedPreparationCount

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



// The transport counts raw frames straight on through a loop. A segment says how to read raw frames from `fromFrame` on
// as arrangement frames: the loop in raw frames, and how far raw runs ahead of the arrangement (an adopted loop edit
// moves the seam to an arrangement position that is not its raw frame).
type PositionSegment = { fromFrame: number; loop: LoopFrames | undefined; deltaFrames: number }

const positionSegmentIndex = (segments: readonly PositionSegment[], frame: number) =>
  Math.max(0, segments.findLastIndex((segment) => segment.fromFrame <= frame))

const arrangementFrameAt = (segments: readonly PositionSegment[], frame: number) => {
  const segment = segments[positionSegmentIndex(segments, frame)]

  return segment ? arrangementFrameForLoop(frame, segment.loop) - segment.deltaFrames : frame
}

const initialPositionSegments = (transport: LivePlaybackTransport, sampleRateHz: number): PositionSegment[] =>
  [{ fromFrame: 0, loop: loopFramesForTransport(transport, sampleRateHz), deltaFrames: 0 }]

type AdoptionLoop = Pick<LivePlaybackTransport, "loopEnabled" | "loopStartSec" | "loopEndSec">



// The worklet rejects a schedule with more events than this.
const maxScheduleEvents = 256

const scheduleLeadSec = (horizonSec: number) => Math.min(5, Math.max(0.05, horizonSec * 0.25))

// Rendered frames between the last position report and the seam an adoption publishes at. The playing position is up to a
// report interval past the last report (the worklet reports every sampleRate / 20 rendered frames); on top of that the seam
// covers the slowest recent round trip from choosing a seam to the publish reaching the worklet, and two render quanta for
// the message itself. A seam that is still too near answers late, and the resubmit chooses a later one.
const maxAdoptionSeamLeadSec = 0.25
const renderQuantumFrames = 128
const recentSeamRoundTripCount = 32

// What a session's first adoption assumes, as the native bound lead does (25 ms).
const coldSeamRoundTripMs = 25

const adoptionSeamLeadFrames = (sampleRate: number, roundTripsMs: readonly number[]) => {
  const slowest = [...roundTripsMs].sort((a, b) => a - b)[Math.ceil(0.99 * roundTripsMs.length) - 1] ?? coldSeamRoundTripMs

  return Math.min(
    Math.round(maxAdoptionSeamLeadSec * sampleRate),
    Math.floor(sampleRate / 20) + Math.ceil(slowest * sampleRate / 1000) + 2 * renderQuantumFrames,
  )
}

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
  // The content identity of a compiled snapshot, as native adoption compares it; without it nothing is adopted live.
  fingerprintSnapshot?: (snapshot: LivePlaybackSnapshot) => string
  getAudioContext: () => AudioContext | null
  scheduleHorizonSec?: number
  getProjectGeneration?: () => number
  resolveSource?: AudioPcmSourceResolver
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  reportFault?: (message: string) => void
  onGraphContinuity?: (message: Extract<PortableWasmStatusMessage, { type: "graph-continuity" }>) => void
  // A resubmitted adoption or seek ended without failing: the caller compares its baseline against what is now playing.
  onAdoptionResubmitted?: (result: PortableAdoptionResult | PortableStartResult) => void
  backend?: PortableBackend
  select?: (project: PortablePreparedQualification) => Promise<PortableWasmBackendSelection>
  createRecordingWriter?: typeof createPortableRecordingWriter
  createPreparedStretchRepository?: () => PreparedStretchArtifactRepository
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
  // Paged assets and their preparations belong to the session's creation epoch. The transport epoch moves on a locate and
  // must not: the worklet answers a paged call under any other generation as stale, or releases every asset.
  let assetGeneration = 0
  let positionFrame = 0
  // Oldest first; the segment in effect is the last one that starts at or before the reported raw frame.
  let positionSegments: readonly PositionSegment[] = []
  const arrangementFrame = () => arrangementFrameAt(positionSegments, positionFrame)
  let positionSequence = 0
  let activeSourceSequence = 0
  let refreshPromise: Promise<PortableStartResult> | undefined
  let transportIntent = 0
  let failedRefreshEndFrame: number | undefined
  let activeRevision: number | undefined
  let activeGraph: AudioCoreGraphSnapshot | undefined
  let activeSnapshot: LivePlaybackSnapshot | undefined
  let activeFrameSchedule: Extract<PreparedPortableSession, { supported: true }>["schedule"] | undefined
  let activePreparedStretchAssets: readonly PortablePreparedStretch[] = []
  let activeOrdinarySources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][] = []
  let activeOrdinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map()
  let activePreparedSources: readonly PortablePreparedSource[] = []
  let activePreparations: readonly PortablePagedPreparation[] = []

  // The preparations, registered assets and Stretch artifacts (with their leases) a failed adoption attempt made stay for
  // the resubmit of the same desired state, so a slow preparation converges instead of starting over. They go when
  // the desired state changes, when the resubmits run out, and with the session.
  type AdoptionCache = {
    fingerprint: string
    preparations: readonly PortablePagedPreparation[]
    assets: readonly string[]
    stretch: readonly PortablePreparedStretch[] | undefined
  }

  let adoptionCache: AdoptionCache | undefined
  // Assets and Stretch leases an adoption replaced: the old sources stop at the seam, so they go once the position has
  // reached it and the core no longer reads them.
  let retiredAssets: readonly { assetId: string; seamFrame: number }[] = []
  let retiredStretch: readonly { assets: readonly PortablePreparedStretch[]; seamFrame: number }[] = []
  let nextLiveProcessorSequence = 0
  let adopting = false
  let adoptionQueued: Promise<PortableAdoptionAttemptResult> | undefined
  // The newest loop an adoption was asked for: the waiting adoption compiles with it, and so does a resubmit.
  let latestLoop: AdoptionLoop = { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 }
  let adoptionTail: Promise<unknown> = Promise.resolve()
  let adoptionPublish: Promise<PortableAdoptionAttemptResult> | undefined
  // Milliseconds from choosing a seam to the publish being posted or refused, for the adoptions this session made recently.
  let seamRoundTripsMs: readonly number[] = []
  // Synth sends past the adoption barrier and not yet answered; an adoption folds the values they carry once they settle.
  const liveInstrumentSends = new Set<Promise<unknown>>()
  // Failed operations waiting for rendered-frame reports to run again: `wait` more reports, `resubmits` made so far.
  const retries = new Map<"adoption" | "seek", { resubmits: number; wait: number; run: (resubmits: number) => Promise<void> }>()
  // Locates run one after the other; the newest wins through `transportIntent`.
  let seekTail: Promise<unknown> = Promise.resolve()
  let pendingSeeks = 0
  let nextRecordingSessionId = 1
  let unsubscribeFault: (() => void) | undefined
  let startupAbortController: AbortController | undefined
  const stretchRepository = input.createPreparedStretchRepository?.() ?? createPreparedStretchArtifactRepository()
  let repositoryDisposed = false

  const releasePreparedStretchAssets = async (assets: readonly PortablePreparedStretch[]) => {
    const leases = new Set(assets.flatMap((asset) => isPagedStretchAsset(asset) ? [asset.lease] : []))
    await Promise.all([...leases].map((lease) => lease.release().catch(() => undefined)))
  }

  const prepareStretch = (snapshot: LivePlaybackSnapshot, projectGeneration: number, signal?: AbortSignal) => preparePortablePagedStretchAssets({
    tracks: snapshot.tracks,
    projectBpm: snapshot.bpm,
    projectGeneration: safeProjectGeneration(projectGeneration),
    repository: stretchRepository,
    resolveSource: input.resolveSource,
    signal,
  })

  const prepareCandidateStretch = async (snapshot: LivePlaybackSnapshot, projectGeneration: number) => {
    if (!hasStretchClips(snapshot)) return []
    const preparation = await prepareStretch(snapshot, projectGeneration)

    if (!preparation.supported) throw new Error(preparation.message)

    return preparation.assets
  }

  const disposeAdoptionCache = async (session: PortableSession | undefined) => {
    const cache = adoptionCache
    adoptionCache = undefined

    if (!cache) return

    if (session) {
      await releasePreparations(session, cache.preparations, assetGeneration)
      await Promise.all(cache.assets.map((assetId) => session.releaseAsset?.(assetId, assetGeneration).catch(() => undefined)))
    }

    await releasePreparedStretchAssets(cache.stretch ?? [])
  }

  const clearActiveSessionState = () => {
    const session = active
    const cleanup: Promise<unknown>[] = [disposeAdoptionCache(session)]
    active = undefined
    activeProjectGeneration = undefined
    activeTransport = undefined
    positionSegments = []
    seamRoundTripsMs = []
    activeScheduleRange = undefined
    activeRevision = undefined
    activeGraph = undefined
    activeSnapshot = undefined
    activeFrameSchedule = undefined
    retries.clear()

    if (session?.releaseAssetPreparation) {
      for (const preparation of activePreparations) {
        if (!preparation.released) {
          cleanup.push(session.releaseAssetPreparation(preparation.id, assetGeneration).then((result) => {
            if (result === "released") preparation.released = true
          }).catch(() => undefined))
        }
      }
    }

    activePreparations = []
    retiredAssets = []
    cleanup.push(releasePreparedStretchAssets(retiredStretch.flatMap((retired) => retired.assets)))
    retiredStretch = []
    activeOrdinarySources = []
    activeOrdinaryDescriptors = new Map()
    activePreparedSources = []
    cleanup.push(releasePreparedStretchAssets(activePreparedStretchAssets))
    activePreparedStretchAssets = []
    playing = false

    return Promise.all(cleanup)
  }

  // The session owns its graph revision: an adoption advances it past the Timeline's nativePlaybackRevision, so a
  // compile made while a session is active carries the revision that session publishes. That holds only for content the
  // session can carry, what it plays apart from what it takes live; any other content needs a rebuild. A refresh or
  // adoption never installs it on this session (the worklet rejects a schedule for nodes it lacks).
  const compileSnapshot = async (
    transport: LivePlaybackTransport,
    context?: LivePlaybackCompileContext,
  ): Promise<LivePlaybackSnapshotCompilation> => {
    const compilation = await input.compileSnapshot(transport, context)
    const fingerprint = input.fingerprintSnapshot

    if (!compilation.supported || activeRevision === undefined || !activeSnapshot || !fingerprint) return compilation
    const next = inSessionOrder(compilation.snapshot, activeSnapshot)

    // An adoption installs its schedule and sources at a seam, so it also takes tempo, loop, clip and track-set edits; a
    // refresh or a start does not: they extend the graph that plays.
    const [compared, installed] = context?.liveAdoption
      ? [onKeptEffects(onSharedTracks(withSeamContentOf(next, activeSnapshot), activeSnapshot), activeSnapshot),
        onKeptEffects(onSharedTracks(activeSnapshot, next), next)]
      : [next, activeSnapshot]

    if (fingerprint(withLiveContentOf(compared, activeSnapshot)) !== fingerprint(installed)) {
      return { supported: false, reasons: ["Portable playback requires a schedule rebuild."] }
    }

    return { ...compilation, snapshot: { ...next, revision: activeRevision } }
  }

  const releaseRuntime = async (runtime: PreparedRuntime | undefined) => {
    if (!runtime || runtime.released) return
    runtime.released = true
    const releases: Promise<unknown>[] = []

    for (const preparation of runtime.preparations) {
      if (!preparation.released) {
        const release = runtime.session.releaseAssetPreparation?.(preparation.id, runtime.assetGeneration)

        if (release) {
          releases.push(release.then((result) => {
            if (result === "released") preparation.released = true
          }).catch(() => undefined))
        }
      }
    }

    await Promise.all(releases)
    await releasePreparedStretchAssets(runtime.preparedStretchAssets)
    runtime.unsubscribeFault()
    runtime.session.dispose()
  }

  const releaseExpiredPreparations = async (session: PortableSession, frame: number) => {
    const expired = activePreparations.filter((preparation) => !preparation.released && preparation.stopFrame <= frame)

    if (session.releaseAssetPreparation && expired.length > 0) {
      const results = await Promise.all(expired.map(async (preparation) => ({
        preparation,
        result: await session.releaseAssetPreparation?.(preparation.id, assetGeneration),
      })))

      const released = new Set(
        results.filter((entry) => entry.result === "released").map((entry) => entry.preparation.id),
      )

      for (const preparation of expired) {
        if (released.has(preparation.id)) preparation.released = true
      }

      activePreparations = activePreparations.filter((preparation) => !released.has(preparation.id))
    }

    // After the preparations: a paged asset answers asset-in-use while one holds it, and a release that throws is still
    // owed. Both are asked again at the next report.
    const due = retiredAssets.filter((retired) => retired.seamFrame <= frame)
    retiredAssets = retiredAssets.filter((retired) => !due.includes(retired))

    const answers = await Promise.all(due.map(async (retired) => {
      try {
        return { retired, owed: (await session.releaseAsset?.(retired.assetId, assetGeneration))?.status === "asset-in-use" }
      } catch {
        return { retired, owed: true }
      }
    }))

    retiredAssets = [...retiredAssets, ...answers.filter((answer) => answer.owed).map((answer) => answer.retired)]
    // The leases go with the assets: nothing reads the old artifacts once the position is past the seam.
    const expiredStretch = retiredStretch.filter((retired) => retired.seamFrame <= frame)
    retiredStretch = retiredStretch.filter((retired) => !expiredStretch.includes(retired))
    await releasePreparedStretchAssets(expiredStretch.flatMap((retired) => retired.assets))
  }

  const teardownSession = () => {
    unsubscribeFault?.()
    unsubscribeFault = undefined
    const session = active
    const cleanup = clearActiveSessionState()
    session?.dispose()

    return cleanup
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
    startupAbortController?.abort()
    startupAbortController = undefined
    const recordingSession = recording

    if (recordingSession) failRecording(recordingSession, new Error("Portable recording stopped with playback."))
    const sessionCleanup = teardownSession()

    if (!repositoryDisposed) {
      repositoryDisposed = true
      void sessionCleanup
        .catch(() => undefined)
        .then(() => stretchRepository.dispose?.())
        .catch(() => undefined)
    }
  }

  type PreparedRuntime = {
    session: PortableSession
    prepared: Extract<PreparedPortableSession, { supported: true }>
    snapshot: LivePlaybackSnapshot
    projectGeneration: number
    epoch: number
    assetGeneration: number
    transport: LivePlaybackTransport
    requestedFrame: number
    unsubscribeFault: () => void
    sessionFault: PortableSessionFault
    preparedStretchAssets: readonly PortablePreparedStretch[]
    preparations: readonly PortablePagedPreparation[]
    ordinarySources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
    ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>
    preparedSources: readonly PortablePreparedSource[]
    released: boolean
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
    const preparationAbortController = new AbortController()

    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
      || preparationAbortController.signal.aborted

    const requestedFrame = Math.round(transport.playheadSec * context.sampleRate)
    let session: PortableSession | undefined
    let unsubscribeSessionFault: (() => void) | undefined
    let preparedStretchAssets: readonly PortablePreparedStretch[] = []
    let runtimePreparations: readonly PortablePagedPreparation[] = []
    const sessionFault: PortableSessionFault = {}
    let transferredStretchOwnership = false
    startupAbortController = preparationAbortController

    try {
      const compilation = await compileSnapshot(transport, compileContext)

      if (cancelled()) return undefined

      if (!compilation.supported) return undefined

      if (hasStretchClips(compilation.snapshot)) {
        const preparation = await prepareStretch(compilation.snapshot, projectGeneration, preparationAbortController.signal)

        if (!preparation.supported) {
          input.reportFault?.(preparation.message)

          return undefined
        }

        preparedStretchAssets = preparation.assets
      }

      if (cancelled()) return undefined

      const ordinaryDescriptors = await resolveOrdinaryDescriptors(
        compilation.snapshot,
        input.resolveSource,
        preparationAbortController.signal,
      )

      if (cancelled()) return undefined

      const prepared = preparedSession(
        compilation.snapshot,
        context.sampleRate,
        nextEpoch,
        safeProjectGeneration(projectGeneration),
        input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC,
        sourceFirstSequence,
        preparedStretchAssets,
        undefined,
        ordinaryDescriptors,
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
      const hasPagedAssets = preparedStretchAssets.some(isPagedStretchAsset) || ordinaryDescriptors.size > 0

      const startupPrepared = hasPagedAssets
        ? fitPortableStartupHorizon({
          snapshot: compilation.snapshot,
          sampleRateHz: context.sampleRate,
          epoch: nextEpoch,
          projectGeneration: safeProjectGeneration(projectGeneration),
          requestedHorizonSec: input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC,
          sourceFirstSequence,
          preparedStretchAssets,
          ordinaryDescriptors,
          pageSlotCapacity: playbackSession.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount,
          preparationCapacity: playbackSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
          signal: preparationAbortController.signal,
        })
        : prepared

      await playbackSession.prepareGraph(startupPrepared.graph)

      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")

      if (hasPagedAssets && (
        !playbackSession.registerPagedAsset
        || !playbackSession.writeAssetPage
        || !playbackSession.prepareAssetRange
        || !playbackSession.schedulePreparedSources
        || playbackSession.pagedCapabilities?.pageFrames !== portableWasmPagedPageFrames
        || playbackSession.pagedCapabilities?.maxChannels !== portableWasmPagedMaxChannels
      )) {
        throw new Error("Portable playback backend does not expose paged asset support.")
      }

      for (const asset of startupPrepared.graph.assets) {
        await registerGraphAsset(playbackSession, asset, compilation.snapshot, preparedStretchAssets, ordinaryDescriptors, nextEpoch)

        if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      }

      await playbackSession.publishGraph(startupPrepared.graph.revision)

      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.setTransport(nextEpoch, false, startupPrepared.schedule.timeOrigin.frame)

      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.installSchedule(startupPrepared.schedule)

      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")

      const paged = await preparePagedSources({
        session: playbackSession,
        sources: startupPrepared.sources,
        preparedStretchAssets,
        ordinaryDescriptors,
        repository: stretchRepository,
        generation: nextEpoch,
        preparationCapacity: playbackSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
        signal: preparationAbortController.signal,
      })

      const preparedSourceEvents = paged.events
      const preparations = paged.preparations
      runtimePreparations = preparations
      const ordinarySources = ordinarySourcesOf(startupPrepared.sources, preparedStretchAssets, ordinaryDescriptors)
      await replaceSourcesAtomically({
        session: playbackSession,
        revision: startupPrepared.graph.revision,
        epoch: nextEpoch,
        ordinary: ordinarySources,
        prepared: preparedSourceEvents,
      })

      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")

      if (runTransport) {
        if (
          !Number.isSafeInteger(requestedFrame)
          || requestedFrame < startupPrepared.scheduleRange.startFrame
          || requestedFrame >= startupPrepared.scheduleRange.endFrame
        ) throw new Error("Portable browser playback requested transport is outside its prepared schedule.")
        await playbackSession.setTransport(nextEpoch, true, requestedFrame)
      }

      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")

      if (sessionFault.error) throw sessionFault.error
      playbackSession.onTransportPosition?.((position) => {
        if (
          active !== playbackSession
          // The live epoch: a locate moves it on this session, and the replacement of a refresh is gated by `active`.
          || position.epoch !== epoch
          || position.sequence <= positionSequence
        ) return

        if (position.frame < positionFrame && position.running) return
        positionSequence = position.sequence
        positionFrame = position.frame
        void releaseExpiredPreparations(playbackSession, position.frame).catch(() => undefined)

        for (const [kind, retry] of retries) {
          if (--retry.wait > 0) continue
          retries.delete(kind)
          void retry.run(retry.resubmits).catch(() => undefined)
        }
      })
      playbackSession.onGraphContinuity?.((message) => input.onGraphContinuity?.(message))

      if (runTransport) playbackSession.markActive()

      const runtime = {
        session: playbackSession,
        prepared: startupPrepared,
        snapshot: compilation.snapshot,
        projectGeneration,
        epoch: nextEpoch,
        assetGeneration: nextEpoch,
        transport: { ...transport },
        requestedFrame,
        unsubscribeFault: unsubscribeSessionFault,
        sessionFault,
        preparedStretchAssets,
        ordinaryDescriptors,
        preparations,
        ordinarySources,
        preparedSources: withPreparations(preparedSourceEvents, preparations),
        released: false,
      }

      transferredStretchOwnership = true

      return runtime
    } catch (error) {
      unsubscribeSessionFault?.()
      await Promise.all(runtimePreparations.map(async (preparation) => {
        if (!preparation.released) {
          const result = await session?.releaseAssetPreparation?.(preparation.id, nextEpoch)

          if (result === "released") preparation.released = true
        }
      }))
      session?.dispose()

      if (!cancelled()) {
        input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not start.")
      }

      return undefined
    } finally {
      if (startupAbortController === preparationAbortController) {
        startupAbortController = undefined
      }

      if (!transferredStretchOwnership) await releasePreparedStretchAssets(preparedStretchAssets)
    }
  }

  const commitRuntime = (runtime: PreparedRuntime, runTransport: boolean) => {
    active = runtime.session
    activeProjectGeneration = runtime.projectGeneration
    activeTransport = runtime.transport
    positionSegments = initialPositionSegments(runtime.transport, runtime.prepared.schedule.sampleRateHz)
    activeScheduleRange = runtime.prepared.scheduleRange
    activeFrameSchedule = runtime.prepared.schedule
    activeRevision = runtime.prepared.graph.revision
    activeGraph = runtime.prepared.graph
    activeSnapshot = runtime.snapshot
    activeOrdinarySources = runtime.ordinarySources
    activeOrdinaryDescriptors = runtime.ordinaryDescriptors
    activePreparedSources = runtime.preparedSources
    activePreparedStretchAssets = runtime.preparedStretchAssets
    activePreparations = runtime.preparations
    playing = runTransport
    epoch = runtime.epoch
    assetGeneration = runtime.assetGeneration
    positionFrame = runTransport ? runtime.requestedFrame : runtime.prepared.schedule.timeOrigin.frame
    positionSequence = 0
    unsubscribeFault = runtime.unsubscribeFault
    activeSourceSequence = runtime.prepared.sources.length === 0
      ? 0
      : runtime.prepared.sources[runtime.prepared.sources.length - 1]?.sequence ?? 0
    failedRefreshEndFrame = undefined
  }

  const startAttempt = async (
    configuredTransport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
    compileContext?: LivePlaybackCompileContext,
  ): Promise<PortableStartResult> => {
    const context = input.getAudioContext()

    if (!context) return "unavailable"

    const transport = effectiveLoopForStart(
      configuredTransport,
      Math.round(configuredTransport.playheadSec * context.sampleRate),
      context.sampleRate,
    )

    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)

    // A kept session resumes where it stands, with the loop a start would run: a locate to the playhead, then the run.
    if (active && activeProjectGeneration === projectGeneration) {
      const resumed = await seek(configuredTransport.playheadSec, configuredTransport, runTransport)

      if (resumed !== "rebuild") {
        if (!cancelled()) return resumed
        void teardownSession()

        return "unavailable"
      }
    }

    if (active) {
      void teardownSession()
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

    if (!runtime || cancelled()) {
      if (runtime) await releaseRuntime(runtime)

      return "unavailable"
    }

    commitRuntime(runtime, runTransport)

    return "started"
  }

  const refreshSchedule = (): Promise<PortableStartResult> => {
    // An adoption in flight owns the session's revision and schedule; the next tick refreshes after it.
    if (!playing || !active || refreshPromise || adopting || pendingSeeks > 0) return refreshPromise ?? Promise.resolve<PortableStartResult>("started")
    const context = input.getAudioContext()

    if (!context) return Promise.resolve("started")
    const horizonSec = input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC
    const leadSec = scheduleLeadSec(horizonSec)
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
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const intent = transportIntent
    const arrangementNow = arrangementFrame()

    const transport: LivePlaybackTransport = {
      ...(activeTransport ?? {
        state: "playing",
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
      state: "playing",
      playheadSec: arrangementNow / context.sampleRate,
    }

    // The window plays the arrangement from here at the raw frame the session stands on, with the loop shifted by how far
    // raw runs ahead of the arrangement, as an adoption's schedule does.
    const runLoop = effectiveLoopForStart(transport, arrangementNow, context.sampleRate)
    const deltaSec = (currentFrame - arrangementNow) / context.sampleRate

    const windowTransport: LivePlaybackTransport = {
      ...transport,
      loopEnabled: runLoop.loopEnabled,
      loopStartSec: runLoop.loopStartSec + deltaSec,
      loopEndSec: runLoop.loopEndSec + deltaSec,
    }

    const refreshAbortController = new AbortController()
    startupAbortController = refreshAbortController

    const request: Promise<PortableStartResult> = (async (): Promise<PortableStartResult> => {
      const nextEpoch = epoch
      await releaseExpiredPreparations(previousSession, currentFrame)
      activeOrdinarySources = activeOrdinarySources.filter((source) => source.stopFrame > currentFrame)
      activePreparedSources = activePreparedSources.filter((source) => !source.preparation.released)
      const baselineOrdinarySources = activeOrdinarySources
      const baselinePreparedSources = activePreparedSources
      const baselineSchedule = activeFrameSchedule
      const baselineScheduleRange = activeScheduleRange
      const baselinePreparations = activePreparations
      const baselineEndFrame = activeScheduleRange?.endFrame ?? currentFrame
      const compilation = await compileSnapshot(transport)

      if (
        generation !== lifecycleGeneration
        || intent !== transportIntent
        || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
        || active !== previousSession
        || !playing
        || !compilation.supported
        || compilation.snapshot.revision !== activeRevision
      ) return "unavailable"
      const extensionStartFrame = baselineEndFrame
      const pageSec = portableWasmPagedPageFrames / context.sampleRate
      const requestedExtensionSec = horizonSec + (extensionStartFrame - currentFrame) / context.sampleRate
      // An adoption shortens the window its schedule covers, not the sources the session holds: those reach past
      // `extensionStartFrame`, and the compile from there lists them again.
      const held = new Set([...baselineOrdinarySources, ...baselinePreparedSources].map((source) => `${source.sourceNodeId}:${source.startFrame}`))

      const restoreBaseline = async () => {
        if (!baselineSchedule) throw new Error("Portable scheduler cannot roll back a failed refresh.")
        await replaceSourcesAtomically({
          session: previousSession,
          revision: baselineSchedule.revision,
          epoch: nextEpoch,
          ordinary: baselineOrdinarySources,
          prepared: baselinePreparedSources,
        })
        await previousSession.installSchedule(baselineSchedule)
      }

      let prepared: Extract<PreparedPortableSession, { supported: true }> | undefined
      let paged: Awaited<ReturnType<typeof preparePagedSources>> | undefined
      let extensionSources: Extract<PreparedPortableSession, { supported: true }>["sources"] = []

      try {
        const fit = await fitPagedWindow({
          horizonSec: requestedExtensionSec,
          pageSec,
          isNew: (source) => source.startFrame >= extensionStartFrame && !held.has(`${source.sourceNodeId}:${source.startFrame}`),
          compile: (candidateHorizonSec) => {
            const candidate = preparedSession(
              { ...compilation.snapshot, transport: windowTransport },
              context.sampleRate,
              nextEpoch,
              safeProjectGeneration(projectGeneration),
              candidateHorizonSec,
              activeSourceSequence + 1,
              activePreparedStretchAssets,
              undefined,
              activeOrdinaryDescriptors,
              currentFrame,
            )

            return candidate.supported
              && candidate.graph.revision === activeRevision
              && !candidate.graph.assets.some((asset) => !activeGraph?.assets.some((current) => current.assetId === asset.assetId))
              ? candidate : undefined
          },
          prepare: (sources) => preparePagedSources({
            session: previousSession,
            sources,
            preparedStretchAssets: activePreparedStretchAssets,
            ordinaryDescriptors: activeOrdinaryDescriptors,
            repository: stretchRepository,
            generation: assetGeneration,
            preparationCapacity: previousSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
            baselinePreparationCount: baselinePreparations.length,
            signal: refreshAbortController.signal,
            pinnedPageKeys: new Set(baselinePreparations.flatMap((preparation) => preparation.pageKeys)),
          }),
        })

        if (fit === "refused") return "unavailable"

        if (fit === "no-fit") throw new Error("Portable schedule refresh could not fit the pinned page horizon.")
        prepared = fit.candidate
        paged = fit.paged
        extensionSources = fit.sources
        const ordinarySources = ordinarySourcesOf(extensionSources, activePreparedStretchAssets, activeOrdinaryDescriptors)
        await replaceSourcesAtomically({
          session: previousSession,
          revision: prepared.graph.revision,
          epoch: nextEpoch,
          ordinary: [...baselineOrdinarySources, ...ordinarySources],
          prepared: [...baselinePreparedSources.map((source) => ({
            ...source,
            preparationId: source.preparation.id,
          })), ...paged.events],
        })
        await previousSession.installSchedule(prepared.schedule)

        if (
          generation !== lifecycleGeneration
          || intent !== transportIntent
          || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
          || active !== previousSession
          || !playing
        ) throw new Error("Portable schedule refresh was cancelled.")
        activeScheduleRange = prepared.scheduleRange
        activeFrameSchedule = prepared.schedule
        activePreparations = [...baselinePreparations, ...paged.preparations]
        activeOrdinarySources = [...baselineOrdinarySources, ...ordinarySources]
        activePreparedSources = [...baselinePreparedSources, ...withPreparations(paged.events, paged.preparations)]
        activeSourceSequence = extensionSources.length === 0
          ? activeSourceSequence
          : extensionSources[extensionSources.length - 1]?.sequence ?? activeSourceSequence
        activeTransport = { ...transport }

        return "started"
      } catch (error) {
        try {
          await restoreBaseline()
          activePreparations = baselinePreparations
          activeOrdinarySources = baselineOrdinarySources
          activePreparedSources = baselinePreparedSources
          activeScheduleRange = baselineScheduleRange
          activeFrameSchedule = baselineSchedule
        } catch (rollbackError) {
          void teardownSession()
          input.reportFault?.(rollbackError instanceof Error ? rollbackError.message : "Portable schedule refresh rollback failed.")

          return "unavailable"
        }

        if (paged) {
          await Promise.all(paged.preparations.map(async (preparation) => {
            if (!preparation.released) {
              const result = await previousSession.releaseAssetPreparation?.(preparation.id, assetGeneration)

              if (result === "released") preparation.released = true
            }
          }))
        }

        failedRefreshEndFrame = activeScheduleRange?.endFrame
        input.reportFault?.(error instanceof Error ? error.message : "Portable schedule refresh failed.")

        return "unavailable"
      }
    })().catch((cause: unknown): PortableStartResult => {
      failedRefreshEndFrame = activeScheduleRange?.endFrame
      input.reportFault?.(cause instanceof Error ? cause.message : "Portable schedule refresh failed.")

      return "unavailable"
    }).finally(() => {
      if (startupAbortController === refreshAbortController) {
        startupAbortController = undefined
      }
    })

    refreshPromise = request
    void request.finally(() => {
      if (refreshPromise === request) refreshPromise = undefined
    })

    return request
  }

  // Native adoption on the portable session: compile the newest desired state from a seam a quarter second ahead of the
  // rendered position, reconcile the notes sounding at the seam against the schedule they started in, then prepare,
  // install and publish at exactly that frame on the same core. A refused or late publication is retryable; content the
  // session cannot carry is unsupported. A paused session adopts the same way at the frame it stands on.
  const adoptLive = async (loop: AdoptionLoop): Promise<PortableAdoptionAttemptResult> => {
    // A locate rebuilds the schedule the adoption would reconcile against; the follow adopts again after it.
    if (pendingSeeks > 0) return "unavailable"

    while (refreshPromise) await refreshPromise
    const session = active
    const audioContext = input.getAudioContext()
    const previous = activeSnapshot
    const schedule = activeFrameSchedule
    const range = activeScheduleRange
    const transport = activeTransport
    const revision = activeRevision
    const fingerprint = input.fingerprintSnapshot

    if (!session || !audioContext || !previous || !schedule || !range || !transport || revision === undefined) return "unavailable"

    if (!fingerprint) {
      console.error("[portable-playback] defect: the controller has no fingerprintSnapshot, so no edit can be adopted")

      return "unavailable"
    }

    const generation = lifecycleGeneration
    const intent = transportIntent
    const wasPlaying = playing
    const current = () => active === session && playing === wasPlaying && generation === lifecycleGeneration && intent === transportIntent

    // A compile that throws has changed nothing, and an edit that cannot be installed leaves the old graph playing for
    // the next adoption to retry; a rebuild would end the take and gap the audio for an edit the user expects to hear
    // without either.
    const failed = (result: "failed" | "unsupported" = "failed"): PortableAdoptionAttemptResult =>
      current() ? result : "unavailable"

    const sampleRate = audioContext.sampleRate
    const projectGeneration = safeProjectGeneration(activeProjectGeneration ?? 0)
    const publishing = Promise.withResolvers<PortableAdoptionAttemptResult>()
    let attempt: AdoptionCache | undefined
    let committed = false
    adopting = true

    try {
      // A run keeps its loop off while the playhead is at or past the loop's end, as a start would. A take keeps the loop
      // it runs with: its refresh reads raw frames as arrangement frames and stops at a loop, so the follow adopts the
      // loop edit once the take has ended.
      const arrangementNow = arrangementFrame()

      const compilation = await compileSnapshot({
        ...transport, ...effectiveLoopForStart(recording ? previous.transport : loop, arrangementNow, sampleRate), state: wasPlaying ? "playing" : "paused", playheadSec: arrangementNow / sampleRate,
      }, { liveAdoption: true })

      if (!current()) return "unavailable"

      if (!compilation.supported) return failed("unsupported")
      const next = compilation.snapshot
      const desired = fingerprint(next)

      if (adoptionCache && adoptionCache.fingerprint !== desired) await disposeAdoptionCache(session)

      if (desired === fingerprint(previous)) return "unchanged"
      // This attempt owns what the failed one kept; a failed attempt hands it on again.
      const owned: AdoptionCache = { fingerprint: desired, preparations: adoptionCache?.preparations ?? [], assets: adoptionCache?.assets ?? [], stretch: adoptionCache?.stretch }
      adoptionCache = undefined
      attempt = owned
      // The candidate's Stretch artifacts are prepared at its tempo and placement, as native prepares them. The
      // seam is chosen after this, so a slow preparation spends none of its lead.
      owned.stretch ??= await prepareCandidateStretch(next, projectGeneration)

      if (!current()) return "unavailable"

      // The candidate's assets: the Stretch artifacts it prepared, and the session's own with what the edit added.
      const resources = {
        preparedStretchAssets: owned.stretch,
        ordinaryDescriptors: await resolveOrdinaryDescriptors(next, input.resolveSource, undefined, activeOrdinaryDescriptors),
      }

      if (!current()) return "unavailable"
      // From here live sends wait for the publish and so reach the revision that carries them; sends already in
      // flight settle first, so the candidate holds every live value the session accepted while the compile ran.
      adoptionPublish = publishing.promise
      await Promise.all(liveInstrumentSends)

      if (!current()) return "unavailable"
      const folded = withAcceptedLiveSynthValues(next, previous, activeSnapshot ?? previous)

      const compileFrom = (rawFrame: number, arrangementAt: number, scheduleLoop: AdoptionLoop, horizonFrames: number) => preparedSession(
        { ...folded, revision: revision + 1, transport: { ...folded.transport, ...scheduleLoop, playheadSec: arrangementAt / sampleRate } },
        sampleRate, epoch, projectGeneration, horizonFrames / sampleRate, 1, resources.preparedStretchAssets, undefined, resources.ordinaryDescriptors, rawFrame)

      // The graph does not depend on the origin, so it is prepared first and the seam is chosen after that round trip.
      const provisional = compileFrom(positionFrame, arrangementNow, folded.transport, range.endFrame - positionFrame)

      if (!provisional.supported) return failed("unsupported")
      await session.prepareGraph(provisional.graph)

      if (!current()) return "unavailable"
      // The worklet resolves instrument zones and sources by asset id when it publishes, so what the edit added is
      // registered before the seam is chosen: registering takes time the seam's lead must not lose. The old assets stay
      // registered while the old sources play, and are released after the seam (retiredAssets).
      const registered = new Set([...(activeGraph?.assets ?? []).map((asset) => asset.assetId), ...owned.assets])

      for (const asset of provisional.graph.assets) {
        if (registered.has(asset.assetId)) continue
        await registerGraphAsset(session, asset, next, resources.preparedStretchAssets, resources.ordinaryDescriptors, assetGeneration)
        owned.assets = [...owned.assets, asset.assetId]

        if (!current()) return "unavailable"
      }

      const leadFrames = Math.round(scheduleLeadSec(input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC) * sampleRate)
      // A stopped transport has no publish race: the seam is where it stands and the publish below is immediate.
      const seamLeadFrames = adoptionSeamLeadFrames(sampleRate, seamRoundTripsMs)
      const seamChosenAt = performance.now()
      const seamFrame = wasPlaying ? positionFrame + seamLeadFrames : positionFrame

      const recordSeamRoundTrip = () => {
        seamRoundTripsMs = [...seamRoundTripsMs, performance.now() - seamChosenAt].slice(-recentSeamRoundTripCount)
      }

      if (wasPlaying) console.debug(`[portable-playback] adoption seam ${seamLeadFrames} frames ahead of the last report (clamp ${Math.round(maxAdoptionSeamLeadSec * sampleRate)})`)

      const keepsVoices = (trackId: string) =>
        keepsInstrumentVoices(previous.mixer.fx.trackFx?.[trackId]?.instrument, folded.mixer.fx.trackFx?.[trackId]?.instrument)

      const candidateTrackIds = new Set(folded.tracks.map((track) => track.id))
      const hasTrack = (trackId: string) => candidateTrackIds.has(trackId)
      // Raw frames run on through a loop, so the seam's arrangement position is rarely its raw frame. The schedule is
      // compiled in raw frames: its loop is shifted by the difference, and the loop is off for the run when the
      // arrangement position at the seam is at or past the loop's end.
      const seamArrangement = arrangementFrameAt(positionSegments, seamFrame)
      const deltaFrames = seamFrame - seamArrangement
      const runLoop = effectiveLoopForStart(folded.transport, seamArrangement, sampleRate)

      const scheduleLoop: AdoptionLoop = {
        loopEnabled: runLoop.loopEnabled,
        loopStartSec: runLoop.loopStartSec + deltaFrames / sampleRate,
        loopEndSec: runLoop.loopEndSec + deltaFrames / sampleRate,
      }

      // The recording refresh reads raw frames as arrangement frames.
      if (recording && deltaFrames !== 0) return failed()
      // The window shrinks until the schedule fits what the worklet installs and its paged sources fit the pages and
      // preparations the session holds beside the active ones; the next refresh extends it. It starts at the old end, or
      // at a full horizon when the seam is within the lead of it: that is where an edit the refresh refused lands, and
      // no refresh can extend the schedule until this adoption has carried the edit. A graph that depends on the origin
      // leaves nothing to publish.
      const reusable = owned.preparations
      const oldWindowFrames = range.endFrame - seamFrame
      const startWindowFrames = oldWindowFrames > leadFrames ? oldWindowFrames : Math.round((input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC) * sampleRate)
      let unsupported = false

      const fitted = await (async () => {
        for (let horizonFrames = startWindowFrames; horizonFrames > leadFrames; horizonFrames = Math.floor(horizonFrames / 2)) {
          const compiled = compileFrom(seamFrame, seamArrangement, scheduleLoop, horizonFrames)

          if (!compiled.supported) {
            unsupported = true

            return undefined
          }

          if (JSON.stringify(compiled.graph) !== JSON.stringify(provisional.graph)) return undefined
          const reconciled = reconcileAtSeam({ previous: schedule, next: compiled.schedule, seamFrame, keepsVoices, hasTrack })

          if (reconciled.events.length > maxScheduleEvents) continue

          try {
            const paged = await preparePagedSources({
              session,
              sources: compiled.sources,
              ...resources,
              repository: stretchRepository,
              generation: assetGeneration,
              preparationCapacity: session.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
              baselinePreparationCount: activePreparations.length,
              pinnedPageKeys: new Set(activePreparations.flatMap((preparation) => preparation.pageKeys)),
              reusable,
            })

            return { candidate: compiled, adopted: reconciled, paged }
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("requires ")) throw error
          }
        }

        return undefined
      })()

      if (!fitted) return failed(unsupported ? "unsupported" : "failed")
      const { candidate, adopted, paged } = fitted
      owned.preparations = paged.preparations
      const reusedIds = new Set(paged.preparations.map((preparation) => preparation.id))
      await releasePreparations(session, reusable.filter((preparation) => !reusedIds.has(preparation.id)), assetGeneration)
      await session.installSchedule(adopted)

      if (!current()) return "unavailable"
      // Once posted, the publish decides which revision the worklet plays, whatever the transport did meanwhile.
      const graph = activeGraph
      activeRevision = candidate.graph.revision
      activeGraph = candidate.graph
      const ordinary = ordinarySourcesOf(candidate.sources, resources.preparedStretchAssets, resources.ordinaryDescriptors)
      // The sources travel with the publish: the worklet swaps them in with the graph, so no block plays one without the other.
      const sources = { epoch, ordinary, prepared: paged.events }
      recordSeamRoundTrip()

      const published = session.publishGraph(candidate.graph.revision, wasPlaying ? { requireContinuity: true, publicationFrame: seamFrame, sources } : { requireContinuity: true, sources }).then((): PortableAdoptionAttemptResult => {
        if (active !== session) return "unavailable"
        // The compiled schedule, not the installed one: it still holds the note-on of a voice that continues from before
        // the seam, which the next reconcile needs to know that voice sounds.
        activeFrameSchedule = candidate.schedule
        activeScheduleRange = candidate.scheduleRange
        activeSnapshot = {
          ...folded,
          revision: candidate.graph.revision,
          transport: { ...folded.transport, loopEnabled: runLoop.loopEnabled },
        }
        activeTransport = { ...transport, loopEnabled: runLoop.loopEnabled, loopStartSec: runLoop.loopStartSec, loopEndSec: runLoop.loopEndSec }
        positionSegments = [
          ...positionSegments.slice(positionSegmentIndex(positionSegments, positionFrame)),
          { fromFrame: seamFrame, loop: loopFramesForTransport(scheduleLoop, sampleRate), deltaFrames },
        ]
        // The old sources stop at the seam, so their preparations end there; the position reports release them once the
        // position reaches it, and a paused session is at it already.
        activePreparations = [
          ...activePreparations.map((preparation) => ({ ...preparation, stopFrame: Math.min(preparation.stopFrame, seamFrame) })),
          ...paged.preparations,
        ]
        const candidateAssets = new Set(candidate.graph.assets.map((asset) => asset.assetId))
        retiredAssets = [
          ...retiredAssets,
          ...(graph?.assets ?? []).filter((asset) => !candidateAssets.has(asset.assetId)).map((asset) => ({ assetId: asset.assetId, seamFrame })),
        ]
        activeOrdinarySources = ordinary
        activePreparedSources = withPreparations(paged.events, paged.preparations)
        activeSourceSequence = candidate.sources.at(-1)?.sequence ?? 0
        retiredStretch = [...retiredStretch, { assets: activePreparedStretchAssets, seamFrame }]
        activePreparedStretchAssets = resources.preparedStretchAssets
        activeOrdinaryDescriptors = resources.ordinaryDescriptors
        committed = true
        void releaseExpiredPreparations(session, positionFrame).catch(() => undefined)

        return "adopted"
      }, (): PortableAdoptionAttemptResult => {
        // A refusal, or a publication that came too late, leaves the worklet on the revision it plays; so does the session.
        // A late answer arrives after the seam: the time it took is what the seam had to cover, so the resubmit's seam
        // is chosen with it.
        recordSeamRoundTrip()

        if (active === session) {
          activeRevision = revision
          activeGraph = graph
        }

        return failed()
      })

      publishing.resolve(published)

      return await published
    } catch {
      return failed()
    } finally {
      if (attempt && !committed) {
        if (active === session) adoptionCache = attempt
        else void releasePreparedStretchAssets(attempt.stretch ?? [])
      }

      adopting = false
      publishing.resolve("unavailable")
      adoptionPublish = undefined
    }
  }

  // At most one adoption runs and one waits; the waiting one compiles when it starts, so it carries the newest edit.
  const adoptQueued = (loop: AdoptionLoop): Promise<PortableAdoptionAttemptResult> => {
    latestLoop = loop

    if (adoptionQueued) return adoptionQueued

    const run = adoptionTail.then(() => {
      adoptionQueued = undefined

      return adoptLive(latestLoop)
    })

    adoptionQueued = run
    adoptionTail = run.catch(() => undefined)

    return run
  }

  // A failed instrument staging keeps the playing graph and is resubmitted after min(2^r, 16(r+1)) rendered-frame
  // reports (the worklet's transport-position messages are the block boundary; no timer), up to 8 times. Exhaustion is a
  // defect: the edit stays in the project and the next adoption publishes it.
  const retryWaitReports = (resubmits: number) => Math.min(2 ** resubmits, 16 * (resubmits + 1))

  const settleAdoption = (result: PortableAdoptionAttemptResult, resubmits: number) => {
    retries.delete("adoption")

    if (result !== "failed") return

    if (resubmits >= maxAdoptionResubmits) {
      const message = `instrument adoption failed after ${maxAdoptionResubmits} resubmits; the edit applies on the next successful publication`
      console.error(`[portable-playback] defect: ${message}`)
      input.reportFault?.(`Playback could not apply an edit: ${message}`)
      void disposeAdoptionCache(active)

      return
    }

    console.warn(`[portable-playback] instrument adoption failed; resubmit ${resubmits + 1} of ${maxAdoptionResubmits} at a later block boundary`)
    retries.set("adoption", { resubmits, wait: retryWaitReports(resubmits), run: resubmitAdoption })
  }

  const adoptSchedule = async (loop: AdoptionLoop): Promise<PortableAdoptionResult> => {
    const result = await adoptQueued(loop)
    settleAdoption(result, 0)

    return result === "unsupported" ? "failed" : result
  }

  const resubmitAdoption = async (resubmits: number) => {
    const result = await adoptQueued(latestLoop)
    settleAdoption(result, resubmits + 1)

    if (result !== "failed" && result !== "unsupported") input.onAdoptionResubmitted?.(result)
  }

  // A locate in place, in native's order: stop at the new position and epoch (the core clears its sources there), free the
  // old pages and prepare the target's, install the schedule and its sources, then run. It compiles the snapshot the
  // session holds, not the project: an edit that landed meanwhile is adopted by the follow after the locate.
  // `resume` is a start on the paused session: it locates, then runs the transport at the target.
  const seekAttempt = async (sec: number, loop: AdoptionLoop, intent: number, resubmits: number, resume: boolean): Promise<PortableSeekResult> => {
    while (refreshPromise) await refreshPromise
    await adoptionTail
    const session = active
    const audioContext = input.getAudioContext()
    const snapshot = activeSnapshot
    const revision = activeRevision

    if (!session || !audioContext || !snapshot || revision === undefined
      || activeProjectGeneration !== (input.getProjectGeneration?.() ?? 0)) return "rebuild"
    const generation = lifecycleGeneration
    const superseded = () => active !== session || generation !== lifecycleGeneration
    const sampleRate = audioContext.sampleRate
    const frame = Math.round(sec * sampleRate)
    const nextEpoch = epoch + 1
    const running = playing
    const target = effectiveLoopForStart({ ...snapshot.transport, ...loop, playheadSec: sec }, frame, sampleRate)
    const horizonSec = Math.max(input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC, portableWasmPagedPageFrames / sampleRate)

    const compile = (windowSec: number) => {
      const candidate = preparedSession({ ...snapshot, transport: target }, sampleRate, nextEpoch, safeProjectGeneration(activeProjectGeneration ?? 0),
        windowSec, 1, activePreparedStretchAssets, undefined, activeOrdinaryDescriptors)

      return candidate.supported && candidate.graph.revision === revision ? candidate : undefined
    }

    if (!compile(horizonSec)) {
      console.warn("[portable-playback] seek refused: the active snapshot does not compile at the target")

      return "rebuild"
    }

    let paged: Awaited<ReturnType<typeof preparePagedSources>> | undefined

    try {
      await session.setTransport(nextEpoch, false, frame)

      if (superseded()) return "unavailable"
      epoch = nextEpoch
      positionFrame = frame
      positionSequence = 0
      positionSegments = initialPositionSegments(target, sampleRate)
      // The core cleared its sources at the epoch change, so every preparation has ended.
      await releaseExpiredPreparations(session, Number.POSITIVE_INFINITY)
      const held = activePreparations

      const fit = await fitPagedWindow({
        horizonSec,
        pageSec: portableWasmPagedPageFrames / sampleRate,
        compile,
        prepare: (sources) => preparePagedSources({
          session,
          sources,
          preparedStretchAssets: activePreparedStretchAssets,
          ordinaryDescriptors: activeOrdinaryDescriptors,
          repository: stretchRepository,
          generation: assetGeneration,
          preparationCapacity: session.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
          baselinePreparationCount: held.length,
          pinnedPageKeys: new Set(held.flatMap((preparation) => preparation.pageKeys)),
        }),
      })

      if (fit === "refused" || fit === "no-fit") throw new Error("Portable playback could not fit the window at the seek target.")
      paged = fit.paged
      await session.installSchedule(fit.candidate.schedule)
      const ordinary = ordinarySourcesOf(fit.sources, activePreparedStretchAssets, activeOrdinaryDescriptors)
      await replaceSourcesAtomically({ session, revision, epoch: nextEpoch, ordinary, prepared: fit.paged.events })

      if (superseded()) return "unavailable"
      activeFrameSchedule = fit.candidate.schedule
      activeScheduleRange = fit.candidate.scheduleRange
      activeOrdinarySources = ordinary
      activePreparations = [...held, ...fit.paged.preparations]
      activePreparedSources = withPreparations(fit.paged.events, fit.paged.preparations)
      activeSourceSequence = fit.sources.at(-1)?.sequence ?? 0
      activeTransport = { ...target, state: running || resume ? "playing" : "paused" }
      activeSnapshot = { ...snapshot, transport: { ...snapshot.transport, loopEnabled: target.loopEnabled, loopStartSec: target.loopStartSec, loopEndSec: target.loopEndSec } }
      failedRefreshEndFrame = undefined

      // A newer locate or a pause leaves the session stopped at the schedule this one installed.
      if ((running || resume) && intent === transportIntent) {
        await session.setTransport(nextEpoch, true, frame)
        session.markActive()
        playing = true
      }

      return "started"
    } catch (cause) {
      if (superseded()) return "unavailable"
      // A rejected first stop changed nothing: the old position keeps playing on its old schedule and the retry targets
      // the locate. Once the transport stands at the new epoch, the old schedule belongs to the old epoch and what was
      // installed may be partial: nothing may refresh, adopt or resume on it until a locate completes.
      const stopped = epoch === nextEpoch

      if (stopped) {
        activeScheduleRange = undefined
        activeFrameSchedule = undefined
      }

      if (paged) {
        activePreparations = [...new Set([...activePreparations, ...paged.preparations])]
        await releaseExpiredPreparations(session, Number.POSITIVE_INFINITY)
      }

      const failure = cause instanceof Error ? cause : new Error("Portable playback could not seek.")

      // Rendered-frame reports are the retry clock, so a running transport keeps running while it waits: after the stop,
      // it plays whatever of the target's content was installed.
      const waiting = running && resubmits < maxAdoptionResubmits
        && (!stopped || await session.setTransport(epoch, true, frame).then(() => true, () => false))

      if (waiting) {
        session.markActive()
        console.warn(`[portable-playback] seek failed; resubmit ${resubmits + 1} of ${maxAdoptionResubmits} at a later block boundary`)
        retries.set("seek", {
          resubmits,
          wait: retryWaitReports(resubmits),
          run: (done) => intent === transportIntent && generation === lifecycleGeneration
            ? queueSeek(stopped ? arrangementFrame() / sampleRate : sec, loop, intent, done + 1, false).then((result) => {
              if (result === "started") input.onAdoptionResubmitted?.(result)
            })
            : Promise.resolve(),
        })

        return "unavailable"
      }

      console.error(`[portable-playback] defect: seek failed${running ? ` after ${resubmits} resubmits` : ""}: ${failure.message}`)
      input.reportFault?.(failure.message)
      void teardownSession()

      return "unavailable"
    }
  }

  const queueSeek = (sec: number, loop: AdoptionLoop, intent: number, resubmits: number, resume: boolean): Promise<PortableSeekResult> => {
    pendingSeeks += 1

    const run = seekTail
      .then((): Promise<PortableSeekResult> | PortableSeekResult =>
        intent === transportIntent ? seekAttempt(sec, loop, intent, resubmits, resume) : active ? "started" : "unavailable")
      .finally(() => { pendingSeeks -= 1 })

    seekTail = run.catch(() => undefined)

    return run
  }

  const seek = async (sec: number, loop: AdoptionLoop, resume = false): Promise<PortableSeekResult> => {
    if (recording) throw new Error("Portable recording must stop before playback can seek.")
    retries.delete("seek")

    return queueSeek(sec, loop, ++transportIntent, 0, resume)
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
    // A paused session is prepared only where it stands: another playhead seeks it in place.
    const context = input.getAudioContext()
    const keptPaused = active && !playing && activeProjectGeneration === (input.getProjectGeneration?.() ?? 0) && context

    if (keptPaused && positionFrame === Math.round(transport.playheadSec * keptPaused.sampleRate)) {
      return Promise.resolve("started")
    }

    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0

    const request = keptPaused ? seek(transport.playheadSec, transport).then((result): PortableStartResult => result === "rebuild" ? "unavailable" : result)
      : startAttempt(transport, generation, projectGeneration, false, compileContext)

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
    lifecycleGeneration += 1
    transportIntent += 1
    pendingStart = undefined
    pendingStartMode = undefined
    refreshPromise = undefined
    startupAbortController?.abort()
    startupAbortController = undefined
    await teardownSession()

    return ensurePrepared(transport, compileContext)
  }

  const pause = async (playheadSec: number) => {
    transportIntent += 1
    startupAbortController?.abort()
    startupAbortController = undefined
    // A locate in flight finishes its burst without running; the pause then stops it at the epoch it left.
    await seekTail
    const session = active

    if (!session || !playing) return

    if (recording) throw new Error("Portable recording must stop before playback can pause.")
    const context = input.getAudioContext()

    if (!context) throw new Error("Portable audio context is unavailable.")

    try {
      await session.setTransport(epoch, false, Math.round(playheadSec * context.sampleRate))
      positionFrame = Math.round(playheadSec * context.sampleRate)
      // The transport now stands at the arrangement frame itself.
      positionSegments = []

      if (active === session) playing = false
    } catch (error) {
      if (active === session) {
        input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not pause.")
        await teardownSession()
      }

      throw error
    }
  }

  const ensureRecordingRefreshCapacity = async (playbackSession: PortableSession) => {
    if (activePreparations.length === 0) return
    const context = input.getAudioContext()
    const baselineSchedule = activeFrameSchedule
    const baselineScheduleRange = activeScheduleRange

    if (!context || !baselineSchedule || !baselineScheduleRange || activeRevision === undefined || !activeGraph) {
      throw new Error("Portable recording requires an active schedule.")
    }

    await releaseExpiredPreparations(playbackSession, positionFrame)
    const projectGeneration = input.getProjectGeneration?.() ?? 0

    const transport: LivePlaybackTransport = {
      ...(activeTransport ?? {
        state: "playing",
        playheadSec: positionFrame / context.sampleRate,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
      state: "playing",
      playheadSec: positionFrame / context.sampleRate,
    }

    const compilation = await compileSnapshot(transport)

    if (
      !compilation.supported
      || compilation.snapshot.transport.loopEnabled
      || compilation.snapshot.revision !== activeRevision
    ) {
      throw new Error("Portable recording is unavailable because playback requires a schedule rebuild.")
    }

    const pageFrames = portableWasmPagedPageFrames
    const extensionStartFrame = baselineScheduleRange.endFrame

    const minimum = preparedSession(
      compilation.snapshot,
      context.sampleRate,
      epoch,
      safeProjectGeneration(projectGeneration),
      (extensionStartFrame - positionFrame + pageFrames) / context.sampleRate,
      activeSourceSequence + 1,
      activePreparedStretchAssets,
      extensionStartFrame / context.sampleRate,
      activeOrdinaryDescriptors,
    )

    if (!minimum.supported) {
      throw new Error("Portable recording is unavailable because its minimum continuation horizon is unsupported.")
    }

    const continuationSources = minimum.sources.filter((source) => source.startFrame >= extensionStartFrame)

    const plan = requiredPagedPagePlan(
      continuationSources,
      activePreparedStretchAssets,
      activeOrdinaryDescriptors,
    )

    if (!plan) throw new Error("Portable recording is unavailable because a continuation source range is invalid.")

    const capacityError = pagedCapacityError({
      pageCount: new Set([
        ...activePreparations.flatMap((preparation) => preparation.pageKeys),
        ...plan.pageKeys,
      ]).size,
      pageCapacity: playbackSession.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount,
      preparationCount: plan.preparationCount,
      preparationCapacity: playbackSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
      baselinePreparationCount: activePreparations.length,
    })

    if (capacityError) {
      throw new Error(`Portable recording is unavailable: ${capacityError.message}`)
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

    await ensureRecordingRefreshCapacity(playbackSession)
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

  const rememberInstrumentParameters = (targetId: string, instrument: TrackInstrumentParams) => {
    if (!activeSnapshot) return
    const trackFx = activeSnapshot.mixer.fx.trackFx ?? {}
    activeSnapshot = { ...activeSnapshot, mixer: { ...activeSnapshot.mixer,
      fx: { ...activeSnapshot.mixer.fx, trackFx: { ...trackFx, [targetId]: { ...trackFx[targetId], instrument } } } } }
  }

  const queueLiveProcessorControl = async (
    request: LiveProcessorControlRequest,
  ): Promise<LiveProcessorControlResult> => {
    // A start in flight may have compiled before this edit: it reaches the session that start commits.
    if (!active && pendingStart) await pendingStart.catch(() => undefined)

    // An adoption publish decides which revision the worklet plays; a send waits for its answer.
    if (adoptionPublish) await adoptionPublish

    if (!active || activeRevision === undefined || activeGraph === undefined) {
      return { accepted: false, reason: "unprepared" }
    }

    if (request.revision !== undefined && request.revision !== activeRevision
      || request.epoch !== undefined && request.epoch !== epoch) {
      return { accepted: false, reason: "stale" }
    }

    const snapshot = activeSnapshot

    const instrumentEntry = Object.entries(snapshot?.mixer.fx.trackFx ?? {})
      .find(([, fx]) => fx.instrument?.instanceId === request.instanceId)

    if (snapshot && instrumentEntry) {
      const session = active
      const node = activeGraph.nodes.find((entry) => entry.id === instrumentEntry[0])

      if (node?.instrument?.kind !== "synth" || !session.queueInstrumentEvents) return { accepted: false, reason: "unsupported" }
      // The live events carry the eight live parameters; every other change to the instrument reaches the session
      // through the published configuration of the next adoption, so it stays out of the prepared snapshot until then.
      const prepared = instrumentEntry[1].instrument
      const edited = request.edit && normalizeTrackInstrumentParams(parseJsonValue(request.edit.content.params) ?? null)

      if (request.edit && !(prepared && edited
        && isLiveParameterChange({ targetId: node.id, effect: "instrument", from: prepared, to: edited }, snapshot.bpm))) {
        return { accepted: false, reason: "unsupported" }
      }

      if (request.values.length === 0) {
        const sequence = ++nextLiveProcessorSequence

        return { accepted: true, sequence, appliedSequence: sequence }
      }

      const targets = new Map(node.instrument.parameterTargets.map((entry) => [entry.id, entry.target]))

      const events = request.values.map((value) => {
        const target = targets.get(value.parameterId)

        return target === undefined || !Number.isFinite(value.value) ? undefined : {
          nodeId: node.id, type: "parameter", noteId: 1, sequence: ++nextLiveProcessorSequence,
          frameOffset: 0, channel: 0, note: target, value: value.value,
        } satisfies PortableWasmInstrumentEvent
      })

      if (events.some((event) => event === undefined)) return { accepted: false, reason: "unsupported" }
      const revision = activeRevision
      const deliveryEpoch = epoch
      const sequence = nextLiveProcessorSequence
      const settled = Promise.withResolvers<void>()
      liveInstrumentSends.add(settled.promise)

      try {
        const acceptedEvents = events.flatMap(event => event === undefined ? [] : [event])
        await session.queueInstrumentEvents(deliveryEpoch, acceptedEvents, { revision, sequence })

        if (active !== session || activeRevision !== revision || epoch !== deliveryEpoch) return { accepted: false, reason: "stale" }

        // The session now plays the edit; the prepared snapshot follows, so the release announce finds nothing to rebuild.
        if (edited && prepared && isLiveEventOnlyInstrumentChange(prepared, edited)) rememberInstrumentParameters(node.id, edited)

        return { accepted: true, sequence, appliedSequence: sequence }
      } catch (error) {
        return { accepted: false, reason: "bridge-error", error: String(error) }
      } finally {
        liveInstrumentSends.delete(settled.promise)
        settled.resolve()
      }
    }

    if (!active.queueProcessorEvents) return { accepted: false, reason: "unsupported" }
    const processor = resolveGraphProcessor(activeGraph, request.instanceId)

    if (!processor) return { accepted: false, reason: "unsupported" }

    if (request.edit) {
      const targetId = processor.node.id === activeGraph.masterNodeId ? "master" : processor.node.id

      const installed = (targetId === "master" ? activeSnapshot?.mixer.fx.masterFxInstances
        : activeSnapshot?.mixer.fx.trackFx?.[targetId]?.instances)?.find(instance => instance.id === request.instanceId)

      const timing = request.edit.content.timing
      const values = Object.fromEntries(request.values.map(value => [value.parameterId, value.value]))

      if (!installed || !timing || request.edit.target.nodeId !== targetId
        || request.edit.target.kindId !== processor.processor.kindId
        || !nativeBuiltInLiveStateCovered({ enabled: !processor.processor.bypassed, input: installed }, timing, values)) {
        return { accepted: false, reason: "unsupported" }
      }
    }

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
      if (adoptionPublish) await adoptionPublish

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
    if (adoptionPublish) await adoptionPublish

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
    preparedInstrumentIdentity: (targetId: string) => {
      if (!active || !activeGraph) return undefined
      const instrument = activeSnapshot?.mixer.fx.trackFx?.[targetId]?.instrument

      return instrument ? { kind: instrument.kind, instanceId: instrument.instanceId } : null
    },
    preparedInstrument: (targetId: string) => activeSnapshot?.mixer.fx.trackFx?.[targetId]?.instrument,
    rememberInstrumentParameters,
    isPreparing: () => pendingStart !== undefined,
    liveProcessorControl,
    reenableProcessorAutomation,
    isRecording: () => recording !== undefined,
    ensurePrepared,
    rebuildPrepared,
    refreshSchedule,
    adoptSchedule,
    seek,
    currentPositionSec: () => {
      const context = input.getAudioContext()

      return context
        ? arrangementFrame() / context.sampleRate
        : undefined
    },
  }
}
