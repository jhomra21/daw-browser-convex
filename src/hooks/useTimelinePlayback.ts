import type { TrackInstrumentParams } from "@daw-browser/shared"
import { replaceEqualDeep } from '@tanstack/solid-query'
import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js'

import { canFallbackToRepitchStretch, LIVE_SCHEDULE_HORIZON_SEC, type AudioEngine, type DeferredStretchWindow, type SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { createNativePlaybackController, nativePlaybackFaultText } from '~/lib/desktop/native-playback-controller'
import { createPortableBrowserPlaybackController } from '~/lib/portable-browser-playback-controller'
import type { LivePlaybackCompileContext, LivePlaybackSnapshot, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from '~/lib/live-playback-snapshot'
import {
  createDesktopAudioLifecycleReconciler,
  type DesktopAudioLifecycle,
} from '~/lib/desktop-audio-lifecycle'
import { createSpectrumFrameDelivery } from './spectrum-frame-delivery'
import { rejectedLiveProcessorControl } from '~/lib/live-processor-control'
import type { DesktopBridge } from '~/types/desktop-bridge'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'

type LoopOptions = {
  bpm?: Accessor<number>
  loopEnabled?: Accessor<boolean>
  loopStartSec?: Accessor<number>
  loopEndSec?: Accessor<number>
  getTracks?: Accessor<Track[]>
  hydrateLegacyAudio?: () => Promise<void>
  preflightPlayback?: () => Promise<boolean>
}

type NativePlaybackOptions = {
  requiresNativeAudio?: boolean
  enabled?: Accessor<boolean>
  projectId?: Accessor<string>
  projectGeneration?: Accessor<number>
  compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
  captureNativeVstStates?: (capture: { projectId: string; instanceIds: readonly string[] }) => Promise<void>
  reportFault?: Parameters<typeof createNativePlaybackController>[0]["reportFault"]
  instrumentBudget?: Parameters<typeof createNativePlaybackController>[0]['instrumentBudget']
  onInstrumentPreparation?: Parameters<typeof createNativePlaybackController>[0]['onInstrumentPreparation']
  resolveAudioSource?: AudioPcmSourceResolver
  keepLatencyNodeIds?: Accessor<ReadonlySet<string>>
  playbackInputs?: Accessor<object>
  getDesiredProcessorState?: Parameters<typeof createNativePlaybackController>[0]["getDesiredProcessorState"]
  getProcessorTarget?: Parameters<typeof createNativePlaybackController>[0]["getProcessorTarget"]
}

type PortableBrowserPlaybackOptions = {
  projectGeneration?: Accessor<number>
  compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
  reportFault?: (message: string) => void
  resolveAudioSource?: AudioPcmSourceResolver
}

export type TimelinePlaybackRebuildIntent = {
  resumePlayback: boolean
  playheadSec: number
  owner?: 'native' | 'portable-browser'
  projectId?: string
  projectGeneration?: number
  instrumentOverride?: LivePlaybackCompileContext["instrumentOverride"]
  externalProcessor?: LivePlaybackCompileContext["externalProcessor"]
}

type TimelineScheduleOptions = Partial<TimelinePlaybackRebuildIntent> & {
  rebuildBackend?: boolean
}

const LOOP_EPS = 1e-3

const PLAYHEAD_UI_UPDATE_INTERVAL_MS = 1000 / 30
const LIVE_SCHEDULE_REFRESH_MARGIN_SEC = 5

const audioBackendRolloutPolicy = {
  version: 2,
  browserDefaultBackend: 'portable-browser',
  browserCompatibilityBackend: 'legacy',
  selection: 'startup-only',
  preActivationFailure: 'compatibility-fallback',
  runtimeFailure: 'stop-and-mute',
  portableBrowserRequiresOptIn: false,
  nativeRequiresOptIn: true,
}

type ActiveAudioBackend = 'idle' | 'legacy' | 'portable-browser' | 'native'

type TimelinePlaybackAudioEngine = Pick<
  AudioEngine,
  | 'currentTimelineSec'
  | 'ensureAudio'
  | 'applyAutomationAtTimelineSec'
  | 'cancelAutomationSchedules'
  | 'onTransportPause'
  | 'onTransportSeek'
  | 'onTransportStart'
  | 'onTransportStop'
  | 'resume'
  | 'rescheduleClipsAtPlayhead'
  | 'scheduleAllClipsFromPlayhead'
  | 'scheduleAutomationFromPlayhead'
  | 'stopAllSources'
  | 'subscribeStretchRenderState'
> & {
  getAudioContext?: () => AudioContext | null
  getTrackSpectrum?: AudioEngine['getTrackSpectrum']
  getMasterSpectrum?: AudioEngine['getMasterSpectrum']
  subscribeTrackStereoLevels?: AudioEngine['subscribeTrackStereoLevels']
  subscribeMasterStereoLevels?: AudioEngine['subscribeMasterStereoLevels']
}

type RecoveryAttempt = {
  generation: number
  token: number
  cancelled: boolean
  promise?: Promise<void>
}

type DesktopAudioHostBridge = NonNullable<DesktopBridge["audioHost"]>
type NativePlaybackBridge = NonNullable<
  Parameters<typeof createNativePlaybackController>[0]["bridge"]
>

const supportsNativePlayback = (
  bridge: DesktopAudioHostBridge,
): bridge is DesktopAudioHostBridge & NativePlaybackBridge => (
  "configure" in bridge.session
  && typeof bridge.session.configure === "function"
  && "beginTransaction" in bridge.session
  && typeof bridge.session.beginTransaction === "function"
)

const readNowMs = () =>
  globalThis.performance?.now() ?? Date.now()

export function useTimelinePlayback(
  audioEngine: TimelinePlaybackAudioEngine,
  loopOptions?: LoopOptions,
  nativeOptions?: NativePlaybackOptions,
  portableBrowserOptions?: PortableBrowserPlaybackOptions,
) {
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [isRebuildingPlayback, setIsRebuildingPlayback] = createSignal(false)
  const [playheadSec, setPlayheadSec] = createSignal(0)
  const [activeBackend, setActiveBackend] = createSignal<ActiveAudioBackend>('idle')

  const [rafId, setRafId] = createSignal<number | null>(null)
  const [lastTracks, setLastTracks] = createSignal<Track[]>([])
  let lastPlayheadUiUpdateMs = 0
  let lastPublishedPlayheadSec = 0
  let scheduledUntilSec = 0
  let deferredStretchWindows: DeferredStretchWindow[] = []
  // Schedule a little ahead to avoid past-time starts under scheduling jitter.
  // This keeps metronome ticks and clip audio locked to the same transport timestamp.
  const SCHED_AHEAD_SEC = 0.02
  // Centralize loop state (start/end/active) so timing logic stays in sync across handlers
  const getLoopParams = () => {
    const enabled = loopOptions?.loopEnabled?.() ?? false
    const start = loopOptions?.loopStartSec?.() ?? 0
    const end = loopOptions?.loopEndSec?.() ?? 0
    const length = end - start
    const isActive = enabled && length > LOOP_EPS
    return { enabled, start, end, length, isActive }
  }

  const cancelRaf = () => {
    const id = rafId()
    if (id !== null) {
      cancelAnimationFrame(id)
      setRafId(null)
    }
  }

  const desktopAudioHostBridge = globalThis.window?.dawDesktop?.audioHost
  const audioHostBridge = desktopAudioHostBridge && supportsNativePlayback(desktopAudioHostBridge)
    ? desktopAudioHostBridge
    : undefined
  const requiresNativeAudio = nativeOptions?.requiresNativeAudio === true
  const externalNativeSession = globalThis.window?.dawDesktop?.acceptanceExternalNativeSession === true
  const hasAudioLifecycle = audioHostBridge !== undefined
    && audioHostBridge.onLifecycle !== undefined
    && audioHostBridge.getLifecycle !== undefined
  const [audioLifecycleState, setAudioLifecycleState] = createSignal<DesktopAudioLifecycle["state"]>(
    hasAudioLifecycle ? "recovering" : "ready",
  )
  let audioLifecycleGeneration = -1
  let recoveryAttempt: RecoveryAttempt | undefined
  let recoveryToken = 0
  let recoveryRetryPromise: Promise<unknown> | undefined
  let recoveryRetryGeneration: number | undefined
  let mounted = true
  let preparedBackendDisposePromise: Promise<void> | undefined
  let lastNativeFault: string | undefined
  let transportIntentToken = 0
  let nativeSeekSequence = 0
  let rebuildInProgress = false
  let rebuildStartingPlay = false
  let rebuildPromise: Promise<void> | undefined
  let rebuildRequestVersion = 0
  let pendingRebuildTracks: Track[] | undefined
  let pendingRebuildIntent: TimelinePlaybackRebuildIntent | undefined
  let pendingRebuildRequestVersion: number | undefined
  let pendingRebuildTransportIntentToken: number | undefined
  const lifecycleReadyWaiters = new Set<{
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const setLifecycleState = (state: DesktopAudioLifecycle["state"]) => {
    setAudioLifecycleState(state)
    if (state === "ready") {
      for (const waiter of lifecycleReadyWaiters) {
        clearTimeout(waiter.timer)
        waiter.resolve()
      }
      lifecycleReadyWaiters.clear()
    } else if (state === "failed") {
      for (const waiter of lifecycleReadyWaiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(lastNativeFault ?? "Native audio recovery failed."))
      }
      lifecycleReadyWaiters.clear()
    }
  }
  const waitForLifecycleReady = async () => {
    if (!hasAudioLifecycle || audioLifecycleState() === "ready") return
    if (audioLifecycleState() === "failed") {
      throw new Error(lastNativeFault ?? "Native audio recovery failed.")
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (!lifecycleReadyWaiters.delete(waiter)) return
          reject(new Error("Native audio recovery did not become ready before the rebuild deadline."))
        }, 10_000),
      }
      lifecycleReadyWaiters.add(waiter)
      if (untrack(() => audioLifecycleState()) === "ready") {
        lifecycleReadyWaiters.delete(waiter)
        clearTimeout(waiter.timer)
        resolve()
      }
    })
  }
  let playAttemptToken = 0
  let playAttempt: {
    token: number
    promise: Promise<void>
    waitingForRebuild: boolean
  } | undefined
  const [isPlayPending, setIsPlayPending] = createSignal(false)
  let playAttemptPhase: {
    token: number
    backend: 'native' | 'fallback'
    state: 'startup' | 'prepared' | 'active'
  } | undefined
  let pendingBackendPause: {
    ownerToken: number
    promise: Promise<void>
  } | undefined
  let pendingStop: Promise<void> | undefined
  let backendOwnerToken = 0
  const playbackPreparationWaiters = new Set<() => void>()

  const invalidatePlayAttempt = () => {
    playAttemptToken += 1
    playAttemptPhase = undefined
    for (const cancel of playbackPreparationWaiters) cancel()
    playbackPreparationWaiters.clear()
  }

  const isCurrentPlayAttempt = (token: number) => (
    mounted
    && token === playAttemptToken
    && audioLifecycleState() !== "suspended"
  )

  const reportNativeStopped = (message: string) => nativeOptions?.reportFault?.({ kind: "session-stopped", message })
  const nativePlayback = createNativePlaybackController({
    bridge: audioHostBridge,
    getProjectId: nativeOptions?.projectId,
    getProjectGeneration: nativeOptions?.projectGeneration,
    getKeepLatencyNodeIds: nativeOptions?.keepLatencyNodeIds,
    getDesiredProcessorState: nativeOptions?.getDesiredProcessorState,
    getProcessorTarget: nativeOptions?.getProcessorTarget,
    resolveSource: nativeOptions?.resolveAudioSource,
    reportUnavailable: requiresNativeAudio,
    externalSessionOwner: externalNativeSession,
    instrumentBudget: nativeOptions?.instrumentBudget,
    onInstrumentPreparation: nativeOptions?.onInstrumentPreparation,
    fingerprintSnapshot: loopOptions?.getTracks ? (snapshot) => readScheduleSnapshotFingerprint(snapshot) : undefined,
    createBuffer: (channels, frames, sampleRate) => (
      audioEngine.getAudioContext?.()?.createBuffer(channels, frames, sampleRate)
      ?? new AudioBuffer({ numberOfChannels: channels, length: frames, sampleRate })
    ),
    compileSnapshot: nativeOptions?.compileSnapshot ?? (async () => ({
      supported: false,
      reasons: ['Native playback is not configured.'],
    })),
    reportFault: (fault, options) => {
      const message = nativePlaybackFaultText(fault)
      lastNativeFault = message
      // Publication faults retain the active bank; reporting one must not
      // turn uninterrupted native playback into a stopped UI transport.
      if (options?.retainPlayback) {
        nativeOptions?.reportFault?.(fault, { retainPlayback: true })
        return
      }
      if (portableBrowserPlayback.isActive() && isPlaying()) {
        portableBrowserOptions?.reportFault?.(message)
        return
      }
      if (isRebuildingPlayback()) {
        setIsRebuildingPlayback(false)
        transportIntentToken += 1
        invalidatePlayAttempt()
      }
      setActiveBackend('idle')
      if (!isPlaying()) {
        if (requiresNativeAudio) nativeOptions?.reportFault?.(fault)
        return
      }
      setIsPlaying(false)
      cancelRaf()
      nativeOptions?.reportFault?.(fault)
    },
  })
  let removeRebuildHostLoss: (() => void) | undefined
  const clearRebuildHostLoss = () => {
    removeRebuildHostLoss?.()
    removeRebuildHostLoss = undefined
  }
  const subscribeRebuildHostLoss = () => {
    if (removeRebuildHostLoss || !audioHostBridge) return
    // A cold rebuild retires its schedule coordinator before replacement
    // preparation, so observe host loss while no coordinator owns the host.
    // This host event reads current state imperatively, not reactively.
    // eslint-disable-next-line solid/reactivity
    const remove = audioHostBridge.session.onLoss((message) => {
      if (!isRebuildingPlayback()) return
      setIsRebuildingPlayback(false)
      setIsPlaying(false)
      transportIntentToken += 1
      invalidatePlayAttempt()
      void nativePlayback.cancelPendingStart()
      cancelRaf()
      setActiveBackend('idle')
      reportNativeStopped(message ?? "Native playback host connection was lost.")
      clearRebuildHostLoss()
    })
    removeRebuildHostLoss = remove
  }
  createEffect(() => {
    nativeOptions?.keepLatencyNodeIds?.()
    untrack(() => {
      void nativePlayback.updateKeepLatency().then((result) => {
        if (result.handled || result.reason === "unprepared") return
        const message = result.error ?? "Native Keep Latency update failed."
        if (result.reason === "latency-unsupported") nativeOptions?.reportFault?.({ kind: "latency-unsupported", message })
        else reportNativeStopped(message)
      }).catch((error) => {
        reportNativeStopped(error instanceof Error ? error.message : "Native Keep Latency update failed.")
      })
    })
  })
  const capturePreparedNativeVstStates = async () => {
    if (!nativePlayback.isPrepared()) return
    const capture = nativePlayback.preparedVstCapture()
    if (capture) await nativeOptions?.captureNativeVstStates?.(capture)
  }
  const disposeNativeAfterCapture = async () => {
    let captureError: unknown
    let disposeError: unknown
    const pendingStart = nativePlayback.cancelPendingStart()
    await pendingStart.catch(() => undefined)
    try {
      await capturePreparedNativeVstStates()
    } catch (error) {
      captureError = error
    }
    try {
      await nativePlayback.dispose(undefined, "native-state-capture-complete")
    } catch (error) {
      disposeError = error
    }
    if (captureError !== undefined) throw captureError
    if (disposeError !== undefined) throw disposeError
  }
  const reportNativeStateCaptureFailure = (error: Error) => {
    reportNativeStopped(error.message || "Native VST state capture failed.")
  }
  const portableBrowserPlayback = createPortableBrowserPlaybackController({
    // The desired state each compile reads, so a portable start's commit can tell whether an edit landed meanwhile. A
    // warm resume compiles nothing: its commit takes what the last compile read, an adoption's included.
    compileSnapshot: async (transport, context) => {
      portableCompiledFingerprint = untrack(() => readDesiredScheduleFingerprint())
      return portableBrowserOptions
        ? portableBrowserOptions.compileSnapshot(transport, context)
        : { supported: false, reasons: ['Portable browser playback is not configured.'] }
    },
    fingerprintSnapshot: loopOptions?.getTracks ? (snapshot) => readScheduleSnapshotFingerprint(snapshot) : undefined,
    getAudioContext: () => audioEngine.getAudioContext?.() ?? null,
    getProjectGeneration: portableBrowserOptions?.projectGeneration,
    resolveSource: portableBrowserOptions?.resolveAudioSource,
    reportFault: (message) => {
      audioEngine.onTransportPause()
      setActiveBackend('idle')
      if (!isPlaying()) return
      setIsPlaying(false)
      cancelRaf()
      portableBrowserOptions?.reportFault?.(message)
    },
  })
  const disposePortableBrowserPlayback = () => {
    if (portableBrowserPlayback.isActive() || portableBrowserPlayback.isPrepared()) {
      audioEngine.onTransportPause()
    }
    return portableBrowserPlayback.dispose()
  }

  const subscribeTrackLevels = (listener: Parameters<AudioEngine["subscribeTrackStereoLevels"]>[0]) => {
    const unsubscribeNative = nativePlayback.subscribeTrackMeters((levels) => {
      if (nativePlayback.isPrepared()) listener(levels)
    })
    const unsubscribeBrowser = requiresNativeAudio
      ? () => undefined
      : audioEngine.subscribeTrackStereoLevels?.((levels) => {
        if (!nativePlayback.isPrepared()) listener(levels)
      }) ?? (() => undefined)
    return () => {
      unsubscribeNative()
      unsubscribeBrowser()
    }
  }

  const subscribeMasterLevels = (listener: Parameters<AudioEngine["subscribeMasterStereoLevels"]>[0]) => {
    const unsubscribeNative = nativePlayback.subscribeMasterMeter((levels) => {
      if (nativePlayback.isPrepared()) listener(levels)
    })
    const unsubscribeBrowser = requiresNativeAudio
      ? () => undefined
      : audioEngine.subscribeMasterStereoLevels?.((levels) => {
        if (!nativePlayback.isPrepared()) listener(levels)
      }) ?? (() => undefined)
    return () => {
      unsubscribeNative()
      unsubscribeBrowser()
    }
  }

  const subscribeSpectrum = (targetId: string, listener: (frame: SpectrumFrame | null) => void) => {
    return createSpectrumFrameDelivery({
      isNativePrepared: () => nativePlayback.isPrepared(),
      subscribeNative: (onFrame) => nativePlayback.subscribeSpectrum(targetId, onFrame),
      readBrowserFrame: requiresNativeAudio
        ? () => null
        : () => targetId === "master"
          ? audioEngine.getMasterSpectrum?.() ?? null
          : audioEngine.getTrackSpectrum?.(targetId) ?? null,
      scheduler: {
        request: (callback) => requestAnimationFrame(callback),
        cancel: (id) => cancelAnimationFrame(id),
      },
      deliver: listener,
    })
  }

  const resolveTracks = () => {
    const fromAccessor = loopOptions?.getTracks?.()
    if (Array.isArray(fromAccessor)) {
      setLastTracks(fromAccessor)
      return fromAccessor
    }
    return lastTracks()
  }

  const deferredStretchQueue = {
    clear: () => {
      deferredStretchWindows = []
    },
    add: (windows: DeferredStretchWindow[]) => {
      for (const window of windows) {
        const existingIndex = deferredStretchWindows.findIndex((deferred) => (
          deferred.clipId === window.clipId
          && deferred.startSec === window.startSec
          && deferred.endSec === window.endSec
        ))
        if (existingIndex === -1) {
          deferredStretchWindows = [...deferredStretchWindows, window]
          continue
        }
        if (!window.replaceExistingSource || deferredStretchWindows[existingIndex].replaceExistingSource) continue
        deferredStretchWindows = deferredStretchWindows.map((deferred, index) => (
          index === existingIndex ? { ...deferred, replaceExistingSource: true } : deferred
        ))
      }
    },
    replace: (windows: DeferredStretchWindow[]) => {
      deferredStretchWindows = []
      deferredStretchQueue.add(windows)
    },
    replaceForClipIds: (clipIds: string[], windows: DeferredStretchWindow[]) => {
      const ids = new Set(clipIds)
      deferredStretchWindows = deferredStretchWindows.filter((window) => !ids.has(window.clipId))
      deferredStretchQueue.add(windows)
    },
    read: () => deferredStretchWindows,
  }

  const scheduleAndTrackDeferred = (tracks: Track[], sec: number, opts?: Parameters<AudioEngine['scheduleAllClipsFromPlayhead']>[2]) => {
    const result = audioEngine.scheduleAllClipsFromPlayhead(tracks, sec, opts)
    deferredStretchQueue.add(result.deferredStretchWindows)
  }

  const rescheduleAndTrackDeferred = (tracks: Track[], sec: number, clipIds: string[], opts?: Parameters<AudioEngine['rescheduleClipsAtPlayhead']>[3]) => {
    const result = audioEngine.rescheduleClipsAtPlayhead(tracks, sec, clipIds, opts)
    deferredStretchQueue.replaceForClipIds(clipIds, result.deferredStretchWindows)
  }

  const applyLoopIfNeeded = (candidateSec: number) => {
    const { isActive, start, end } = getLoopParams()
    if (!isActive) return { sec: candidateSec, looped: false }
    if (candidateSec < start) return { sec: candidateSec, looped: false }
    if (candidateSec < end - LOOP_EPS) return { sec: candidateSec, looped: false }

    // Wrap cleanly to the start of the loop; schedule immediately with slight ahead offset
    const wrapped = start
    const tracks = resolveTracks()
    audioEngine.stopAllSources()
    deferredStretchQueue.clear()
    audioEngine.cancelAutomationSchedules()
    audioEngine.onTransportSeek(wrapped, SCHED_AHEAD_SEC)
    scheduledUntilSec = getScheduleHorizonEnd(wrapped, isActive ? end : undefined)
    scheduleAndTrackDeferred(tracks, wrapped, { endLimitSec: scheduledUntilSec })
    audioEngine.scheduleAutomationFromPlayhead(wrapped, {
      horizonSec: scheduledUntilSec - wrapped,
      tracks,
    })
    return { sec: wrapped, looped: true }
  }

  const resolveCurrentPlayhead = () => {
    return applyLoopIfNeeded(audioEngine.currentTimelineSec)
  }

  const publishPlayhead = (sec: number) => {
    lastPublishedPlayheadSec = sec
    lastPlayheadUiUpdateMs = readNowMs()
    setPlayheadSec(sec)
  }

  const getScheduleHorizonEnd = (sec: number, endLimitSec?: number) => Math.min(
    sec + LIVE_SCHEDULE_HORIZON_SEC,
    endLimitSec ?? Number.POSITIVE_INFINITY,
  )

  const refreshScheduleHorizon = (sec: number) => {
    const tracks = resolveTracks()
    if (tracks.length === 0) return
    const { isActive, end } = getLoopParams()
    const nextEnd = getScheduleHorizonEnd(sec, isActive ? end : undefined)
    if (nextEnd <= scheduledUntilSec) return
    if (scheduledUntilSec - sec > LIVE_SCHEDULE_REFRESH_MARGIN_SEC) return
    scheduleAndTrackDeferred(tracks, sec, {
      preserveExisting: true,
      startLimitSec: scheduledUntilSec,
      endLimitSec: nextEnd,
    })
    audioEngine.scheduleAutomationFromPlayhead(scheduledUntilSec, {
      horizonSec: nextEnd - scheduledUntilSec,
      tracks,
    })
    scheduledUntilSec = nextEnd
  }

  const retryDeferredStretchWindows = (sec: number, opts?: { includeNonImminent?: boolean }) => {
    const deferredWindows = deferredStretchQueue.read()
    if (deferredWindows.length === 0) return
    const tracks = resolveTracks()
    if (tracks.length === 0) return

    const retriedDeferred: DeferredStretchWindow[] = []
    for (const window of deferredWindows) {
      if (window.endSec <= sec) continue
      if (!opts?.includeNonImminent && !canFallbackToRepitchStretch({
        playheadSec: sec,
        timelineStartSec: window.startSec,
        timelineEndSec: window.endSec,
      })) {
        retriedDeferred.push(window)
        continue
      }
      if (!opts?.includeNonImminent && window.replaceExistingSource) {
        retriedDeferred.push(window)
        continue
      }
      const startLimitSec = Math.max(window.startSec, sec)
      const replaceExistingSource = opts?.includeNonImminent && window.replaceExistingSource
      const result = replaceExistingSource
        ? audioEngine.rescheduleClipsAtPlayhead(tracks, sec, [window.clipId], {
            startLimitSec,
            endLimitSec: window.endSec,
          })
        : audioEngine.scheduleAllClipsFromPlayhead(tracks, sec, {
            preserveExisting: true,
            startLimitSec,
            endLimitSec: window.endSec,
            clipIds: [window.clipId],
          })
      if (result.deferredStretchWindows.length > 0) {
        retriedDeferred.push(...result.deferredStretchWindows)
      }
    }
    deferredStretchQueue.replace(retriedDeferred)
  }

  const tick = () => {
    if (!isPlaying()) return
    if (nativePlayback.isActive() || portableBrowserPlayback.isActive()) {
      const sec = nativePlayback.isActive()
        ? nativePlayback.currentPositionSec() ?? lastPublishedPlayheadSec
        : portableBrowserPlayback.currentPositionSec() ?? lastPublishedPlayheadSec
      if (portableBrowserPlayback.isActive()) void portableBrowserPlayback.refreshSchedule()
      const nowMs = readNowMs()
      if (
        nowMs - lastPlayheadUiUpdateMs >= PLAYHEAD_UI_UPDATE_INTERVAL_MS
        || Math.abs(sec - lastPublishedPlayheadSec) >= 0.25
      ) publishPlayhead(sec)
      setRafId(requestAnimationFrame(tick))
      return
    }
    if (requiresNativeAudio) {
      setIsPlaying(false)
      cancelRaf()
      setActiveBackend("idle")
      reportNativeStopped("Native audio playback stopped because the native graph is no longer active.")
      return
    }
    const { sec, looped } = resolveCurrentPlayhead()
    if (!looped) refreshScheduleHorizon(sec)
    retryDeferredStretchWindows(sec)
    const nowMs = readNowMs()
    if (
      looped ||
      nowMs - lastPlayheadUiUpdateMs >= PLAYHEAD_UI_UPDATE_INTERVAL_MS ||
      Math.abs(sec - lastPublishedPlayheadSec) >= 0.25
    ) {
      publishPlayhead(sec)
    }
    setRafId(requestAnimationFrame(tick))
  }

  const reportNativePlaySkip = (reason: string) => {
    if (!requiresNativeAudio) return
    lastNativeFault = reason
    console.error("[native-vst3] native play skipped", { reason })
  }

  const handlePlayForIntent = async (
    tracks: Track[],
    compileContext?: LivePlaybackCompileContext,
    requestedIntentToken = transportIntentToken,
  ) => {
    const pendingAttempt = playAttempt
    if (pendingAttempt) {
      if (pendingAttempt.token === playAttemptToken) return pendingAttempt.promise
      await pendingAttempt.promise.catch(() => undefined)
      if (!mounted || requestedIntentToken !== transportIntentToken) return
      return handlePlayForIntent(tracks, compileContext, requestedIntentToken)
    }
    if (!mounted || requestedIntentToken !== transportIntentToken) {
      setIsPlayPending(false)
      return
    }

    const token = ++playAttemptToken
    setIsPlayPending(true)
    const attemptState = {
      waitingForRebuild: rebuildInProgress && !rebuildStartingPlay && rebuildPromise !== undefined,
    }
    let relocated = false
    const attempt = (async () => {
      const stop = pendingStop
      if (stop) await stop.catch(() => undefined)
      if (!isCurrentPlayAttempt(token)) return
      const pendingDispose = preparedBackendDisposePromise
      if (pendingDispose && preparedBackendDisposeHasPendingNativeStart) {
        await pendingDispose.catch(() => undefined)
      }
      if (!isCurrentPlayAttempt(token)) return
      if (rebuildInProgress && !rebuildStartingPlay && rebuildPromise) {
        if (playAttempt?.token === token) playAttempt.waitingForRebuild = true
        await rebuildPromise.catch(() => undefined)
        if (playAttempt?.token === token) playAttempt.waitingForRebuild = false
        attemptState.waitingForRebuild = false
        if (!isCurrentPlayAttempt(token)) return
      }
      const requestedProjectGeneration = nativeOptions?.projectGeneration?.()
        ?? portableBrowserOptions?.projectGeneration?.()
      const pendingPause = pendingBackendPause
      if (pendingPause) {
        await pendingPause.promise.catch(() => undefined)
        // A structural edit during Pause may still owe preview invalidation.
        // Do not compile a new start into the session that disposal is retiring.
        await pendingNativeDispose
      }
      if (!isCurrentPlayAttempt(token)) return
      if (
        requestedProjectGeneration !== undefined
        && requestedProjectGeneration !== (
          nativeOptions?.projectGeneration?.()
          ?? portableBrowserOptions?.projectGeneration?.()
        )
      ) return
      if (loopOptions?.preflightPlayback && !await loopOptions.preflightPlayback()) return
      if (!isCurrentPlayAttempt(token)) return
      // Backend selection is a startup-only rollout decision. Preference changes
      // cannot replace an active playback or recording backend in place.
      let lifecycleState = audioLifecycleState()
      let recoveryRetryAccepted = false
      if (lifecycleState === "suspended") return reportNativePlaySkip(
        "Native audio was suspended before playback could start.",
      )
      if (
        isPlaying()
        || nativePlayback.isRecording()
        || portableBrowserPlayback.isRecording()
      ) {
        reportNativePlaySkip(
          isPlaying()
            ? "Playback was already marked active before the native graph start."
            : "Native playback could not start while recording was active.",
        )
        return
      }
      if (
        lifecycleState === "failed"
        && audioHostBridge
        && recoveryRetryGeneration !== audioLifecycleGeneration
        && !recoveryRetryPromise
        && audioHostBridge.retryRecovery !== undefined
      ) {
        const retryGeneration = audioLifecycleGeneration
        const retry = Promise.resolve().then(() => audioHostBridge.retryRecovery())
        recoveryRetryPromise = retry
        try {
          const result = await retry
          if (result.accepted) {
            recoveryRetryGeneration = retryGeneration
            recoveryRetryAccepted = true
          }
          else recoveryRetryGeneration = undefined
        } catch {
          recoveryRetryGeneration = undefined
        } finally {
          if (recoveryRetryPromise === retry) recoveryRetryPromise = undefined
        }
        lifecycleState = audioLifecycleState()
      }
      const nativeLifecycleReady = !hasAudioLifecycle || lifecycleState === "ready"
      if (requiresNativeAudio && lifecycleState !== "ready") {
        if (!recoveryRetryAccepted) {
          reportNativeStopped(
            lifecycleState === "suspended"
              ? "Native audio is suspended. Playback remains stopped until the native host recovers."
              : lifecycleState === "recovering"
                ? "Native audio is recovering. Playback remains stopped until the native host is ready."
                : "Native audio is unavailable. Playback remains stopped.",
          )
        }
        reportNativePlaySkip(`Native audio lifecycle was ${lifecycleState} before playback could start.`)
        return
      }
      if (requiresNativeAudio && recoveryRetryAccepted) {
        reportNativePlaySkip("Native audio recovery was accepted but had not completed before playback restart.")
        return
      }
      if (!nativeLifecycleReady && nativePlayback.isPrepared()) {
        await disposeNativeAfterCapture()
        if (!isCurrentPlayAttempt(token)) {
          reportNativePlaySkip("Native playback preparation was superseded during disposal.")
          return
        }
        setActiveBackend("idle")
      }
      if (!isCurrentPlayAttempt(token)) {
        reportNativePlaySkip("Native playback start was superseded before graph preparation.")
        return
      }
      const { isActive, start, end } = getLoopParams()
      const transport = {
        state: 'playing' as const,
        playheadSec: playheadSec(),
        loopEnabled: isActive,
        loopStartSec: start,
        loopEndSec: end,
      }
      const seekSequence = nativeSeekSequence
      const commitPortableStart = (backend: Extract<ActiveAudioBackend, 'native' | 'portable-browser'>) => {
        backendOwnerToken += 1
        setActiveBackend(backend)
        previewProjectionBaseline = backend === 'portable-browser' ? portableCompiledFingerprint : readDesiredScheduleFingerprint()
        setIsPlaying(true)
        setLastTracks(tracks)
        lastPublishedPlayheadSec = playheadSec()
        lastPlayheadUiUpdateMs = 0
        if (backend === 'portable-browser') audioEngine.onTransportStart(playheadSec())
        setRafId(requestAnimationFrame(tick))
        // A locate made before the start committed had no graph to seek: apply it to the running one.
        if (seekSequence !== nativeSeekSequence) setPlayhead(playheadSec(), tracks)
      }
      const pendingNativePreview = nativePlayback.getPendingStart()
      if (
        !requiresNativeAudio
        && pendingNativePreview?.mode === 'preview'
        && !(activeBackend() === 'native' && nativePlayback.isPrepared())
      ) {
        await Promise.allSettled([
          disposeNativePreview(),
          pendingNativePreview.promise,
        ])
        if (!isCurrentPlayAttempt(token)) {
          reportNativePlaySkip("Native preview disposal was superseded before portable playback could start.")
          return
        }
      }
      const resumeNative = nativePlayback.isPrepared()
      const resumePortableBrowser = portableBrowserPlayback.isPrepared()
      if (requiresNativeAudio || resumeNative) {
        lastNativeFault = undefined
        playAttemptPhase = {
          token,
          backend: 'native',
          state: resumeNative ? 'prepared' : 'startup',
        }
        const nativeStart = await nativePlayback.start({
          ...transport,
        }, compileContext)
        if (!isCurrentPlayAttempt(token)) {
          reportNativePlaySkip("Native playback start completed after the request was invalidated.")
          await disposePreparedBackends(undefined, "play-attempt-superseded")
          return
        }
        if (nativeStart === 'started') {
          playAttemptPhase = { token, backend: 'native', state: 'active' }
          commitPortableStart('native')
          return
        }
        playAttemptPhase = undefined
        // A locate superseded this Play on the prepared graph. A locate never cancels Play: play again from it.
        if (seekSequence !== nativeSeekSequence && nativePlayback.isPrepared()) {
          relocated = true
          return
        }
        if (requiresNativeAudio) {
          if (lastNativeFault) return
          reportNativeStopped(
            nativeStart === "blocked"
              ? "Native audio playback is blocked for the current project."
              : "Native audio playback is unavailable.",
          )
          return
        }
        if (nativeStart === 'blocked') return
        if (resumeNative) return
      }
      if (requiresNativeAudio) return
      if (!isCurrentPlayAttempt(token)) return
      if (resumePortableBrowser) {
        playAttemptPhase = {
          token,
          backend: 'fallback',
          state: 'prepared',
        }
        // Creating/resuming the browser context emits no legacy sources. It is
        // required before a portable AudioWorklet can be selected and prepared.
        audioEngine.ensureAudio({ applyCachedTrackGains: false })
        await audioEngine.resume()
        if (!isCurrentPlayAttempt(token)) {
          await disposePreparedBackends(undefined, "play-attempt-superseded")
          return
        }
        const portableStart = await portableBrowserPlayback.start(transport, compileContext)
        if (!isCurrentPlayAttempt(token)) {
          await disposePreparedBackends(undefined, "play-attempt-superseded")
          return
        }
        if (portableStart === 'started') {
          playAttemptPhase = { token, backend: 'fallback', state: 'active' }
          commitPortableStart('portable-browser')
          return
        }
        playAttemptPhase = undefined
        return
      }
      if (!isCurrentPlayAttempt(token)) return
      if (portableBrowserOptions) {
        playAttemptPhase = {
          token,
          backend: 'fallback',
          state: 'startup',
        }
        audioEngine.ensureAudio({ applyCachedTrackGains: false })
        await audioEngine.resume()
        if (!isCurrentPlayAttempt(token)) {
          await disposePreparedBackends(undefined, "play-attempt-superseded")
          return
        }
        const portableStart = await portableBrowserPlayback.start(transport, compileContext)
        if (!isCurrentPlayAttempt(token)) {
          await disposePreparedBackends(undefined, "play-attempt-superseded")
          return
        }
        if (portableStart === 'started') {
          playAttemptPhase = { token, backend: 'fallback', state: 'active' }
          commitPortableStart('portable-browser')
          return
        }
        playAttemptPhase = undefined
      }
      if (!isCurrentPlayAttempt(token)) return
      if (nativeLifecycleReady && nativeOptions?.enabled?.()) {
        lastNativeFault = undefined
        playAttemptPhase = {
          token,
          backend: 'native',
          state: 'startup',
        }
        const nativeStart = await nativePlayback.start({
          ...transport,
        }, compileContext)
        if (!isCurrentPlayAttempt(token)) {
          reportNativePlaySkip("Native playback start completed after the request was invalidated.")
          await disposePreparedBackends(undefined, "play-attempt-superseded")
          return
        }
        if (nativeStart === 'started') {
          playAttemptPhase = { token, backend: 'native', state: 'active' }
          commitPortableStart('native')
          return
        }
        playAttemptPhase = undefined
        if (nativeStart === 'blocked') return
      }
      if (!isCurrentPlayAttempt(token)) return
      playAttemptPhase = { token, backend: 'fallback', state: 'startup' }
      audioEngine.ensureAudio({ applyCachedTrackGains: false })
      await audioEngine.resume()
      if (!isCurrentPlayAttempt(token)) {
        await disposePreparedBackends(undefined, "play-attempt-superseded")
        audioEngine.stopAllSources()
        return
      }
      await loopOptions?.hydrateLegacyAudio?.()
      if (!isCurrentPlayAttempt(token)) {
        await disposePreparedBackends(undefined, "play-attempt-superseded")
        audioEngine.stopAllSources()
        return
      }
      const readyTracks = loopOptions?.getTracks?.() ?? tracks
      backendOwnerToken += 1
      setActiveBackend('legacy')
      setIsPlaying(true)
      lastPublishedPlayheadSec = playheadSec()
      lastPlayheadUiUpdateMs = 0
      setLastTracks(tracks)
      deferredStretchQueue.clear()
      audioEngine.onTransportStart(playheadSec())
      audioEngine.onTransportSeek(playheadSec(), SCHED_AHEAD_SEC)
      scheduledUntilSec = getScheduleHorizonEnd(playheadSec(), isActive ? end : undefined)
      scheduleAndTrackDeferred(readyTracks, playheadSec(), { endLimitSec: scheduledUntilSec })
      audioEngine.scheduleAutomationFromPlayhead(playheadSec(), {
        horizonSec: scheduledUntilSec - playheadSec(),
        tracks: readyTracks,
      })
      setRafId(requestAnimationFrame(tick))
      playAttemptPhase = { token, backend: 'fallback', state: 'active' }
    })()
    playAttempt = { token, promise: attempt, ...attemptState }
    try {
      await attempt
    } finally {
      if (playAttempt?.promise === attempt) {
        playAttempt = undefined
        // The replay below keeps the Play pending.
        if (!relocated) setIsPlayPending(false)
        followPortableEdits()
      }
      if (playAttemptPhase?.token === token && !isPlaying()) playAttemptPhase = undefined
    }
    if (relocated) return handlePlayForIntent(tracks, compileContext, requestedIntentToken)
  }

  const handlePlay = (tracks: Track[], compileContext?: LivePlaybackCompileContext) => (
    handlePlayForIntent(tracks, compileContext, transportIntentToken)
  )

  // The portable counterpart of ensureLivePreview: the paused browser session stays live at the playhead. A browser
  // audio context exists only once a gesture created it, so before the first Play there is no session to keep.
  // Portable options exist only in the browser build, which has no native host to prepare or lifecycle to wait on.
  const ensureLivePortableSession = async (): Promise<void> => {
    const owned = () => mounted && portableBrowserOptions !== undefined && Boolean(audioEngine.getAudioContext?.())
      && !untrack(isPlaying) && playAttempt === undefined && !rebuildInProgress
    // A locate inside a Pause's round trip waits for the Pause, so the session ends at the locate, not the pause position.
    await pendingBackendPause?.promise.catch(() => undefined)
    if (!owned()) return
    await audioEngine.resume()
    if (!owned()) return
    const sec = untrack(playheadSec)
    const { isActive, start, end } = getLoopParams()
    const result = await portableBrowserPlayback.ensurePrepared({
      state: "paused", playheadSec: sec, loopEnabled: isActive, loopStartSec: start, loopEndSec: end,
    })
    if (result !== "started" || !owned()) return
    setActiveBackend("portable-browser")
    // A pending ensurePrepared answers a newer locate with the older position: seek again.
    if (untrack(playheadSec) !== sec) return ensureLivePortableSession()
  }

  // A cancelled start takes the paused graph this hook keeps live with it. Once the cancelled Play or rebuild and the
  // dispose settle, prepare it again where the transport now stands: Stop and Pause win over the resume, not the graph.
  const cancelStartKeepingGraph = (reason: string, after?: Promise<void>) => {
    const cancellation = after ? disposeNativePreview(undefined, reason, after) : disposePreparedBackends(undefined, reason)
    // A dispose already in flight cancelled only the start it saw; a Play started since then is cancelled here.
    void nativePlayback.cancelPendingStart()
    // A newer owner keeps its own graph: ensureLivePreview answers a live or pending start without replacing it.
    void Promise.allSettled([cancellation, playAttempt?.promise, rebuildPromise]).then(async () => {
      if (nativePreviewRequested && await nativePlayback.ensureLivePreview(untrack(playheadSec)) === "started") return
      return ensureLivePortableSession()
    }).catch(() => undefined)
    return cancellation
  }

  const handlePause = async () => {
    setIsRebuildingPlayback(false)
    transportIntentToken += 1
    const pendingPause = pendingBackendPause
    if (pendingPause) {
      await pendingPause.promise.catch(() => undefined)
      return
    }
    // A rebuild retires the graph it replaces and prepares none once superseded, so it is a start to cancel like a Play.
    const hadPendingPlay = playAttempt !== undefined || rebuildInProgress
    invalidatePlayAttempt()
    if (!isPlaying()) {
      if (hadPendingPlay) void cancelStartKeepingGraph("pause-cancelled-play").catch(reportNativeStateCaptureFailure)
      return
    }
    if (nativePlayback.isActive() || portableBrowserPlayback.isActive()) {
      const sec = nativePlayback.isActive()
        ? nativePlayback.currentPositionSec() ?? lastPublishedPlayheadSec
        : portableBrowserPlayback.currentPositionSec() ?? lastPublishedPlayheadSec
      publishPlayhead(sec)
      setIsPlaying(false)
      cancelRaf()
      const ownerToken = backendOwnerToken
      const pausePromise = requiresNativeAudio
        ? nativePlayback.pause(sec).then(() => undefined)
        : Promise.allSettled([
          nativePlayback.pause(sec),
          portableBrowserPlayback.pause(sec),
        ]).then(() => undefined)
      if (!requiresNativeAudio && portableBrowserPlayback.isActive()) {
        audioEngine.onTransportPause()
      }
      const trackedPause = { ownerToken, promise: pausePromise }
      pendingBackendPause = trackedPause
      // The paused-preview effect skips edits while a rebuild runs, and the rebuild this Pause supersedes keeps the
      // graph it was replacing or retires the one it started: replace it once the pause settles.
      if (rebuildInProgress) void cancelStartKeepingGraph("pause-superseded-rebuild", pausePromise).catch(reportNativeStateCaptureFailure)
      try {
        await pausePromise
      } finally {
        if (pendingBackendPause === trackedPause) {
          pendingBackendPause = undefined
          if (
            ownerToken === backendOwnerToken
            && !isPlaying()
            && !nativePlayback.isActive()
            && !portableBrowserPlayback.isActive()
          ) setActiveBackend('idle')
        }
      }
      return
    }
    if (requiresNativeAudio) {
      setIsPlaying(false)
      cancelRaf()
      setActiveBackend('idle')
      return
    }
    const { sec } = resolveCurrentPlayhead()
    publishPlayhead(sec)
    setIsPlaying(false)
    audioEngine.stopAllSources()
    audioEngine.cancelAutomationSchedules()
    deferredStretchQueue.clear()
    audioEngine.onTransportPause()
    cancelRaf()
    setActiveBackend('idle')
  }

  const handleStop = () => {
    transportIntentToken += 1
    clearRebuildHostLoss()
    const pendingStart = nativePlayback.getPendingStart()
    // The paused preview this hook keeps live stays live: Stop waits for it and returns it to the start. A Play, a
    // rebuild in progress, or a preview this hook does not keep is cancelled.
    const pendingPreview = requiresNativeAudio && nativePreviewRequested && playAttempt === undefined && !rebuildInProgress
      && pendingStart?.mode === "preview"
      ? pendingStart.promise
      : undefined
    const hadPendingPlay = playAttempt !== undefined || (pendingStart !== undefined && !pendingPreview) || rebuildInProgress
    invalidatePlayAttempt()
    if (pendingStop) return pendingStop
    const stopSeekSequence = ++nativeSeekSequence
    const stop = (async () => {
      const pause = handlePause()
      // Publish the Stop destination now. A ruler locate made while the host
      // settles is newer intent and must not be overwritten on completion.
      publishPlayhead(0)
      await pause
      if (pendingPreview) await pendingPreview.catch(() => undefined)
      if (hadPendingPlay) {
        void cancelStartKeepingGraph("transport-stop-cancelled-start").catch(reportNativeStateCaptureFailure)
      } else if (requiresNativeAudio && nativePlayback.isPrepared()) {
        if (stopSeekSequence === nativeSeekSequence) {
          const lifecycle = nativeLifecycleToken
          const result = await nativePlayback.seekPrepared(0)
          // A dispose or rebuild that retired the sought graph owns the next one, as for a superseded locate.
          const superseded = lifecycle !== nativeLifecycleToken || rebuildInProgress || preparedBackendDisposePromise !== undefined
          if (result !== "started" && !superseded) {
            reportNativeStopped("Native playback could not return to the start position.")
          }
        }
      } else {
        await disposePreparedBackends(undefined, "transport-stop")
        // Stop leaves the browser's paused session live at the start, as seekPrepared(0) does for native.
        await ensureLivePortableSession().catch(() => undefined)
      }
      if (!requiresNativeAudio && stopSeekSequence === nativeSeekSequence) {
        audioEngine.onTransportStop()
        audioEngine.cancelAutomationSchedules()
        audioEngine.applyAutomationAtTimelineSec(0)
      }
    })()
    pendingStop = stop
    void stop.finally(() => {
      if (pendingStop === stop) pendingStop = undefined
    }).catch(() => undefined)
    return stop
  }
  const updateNativeLoop = (
    loop: Pick<ReturnType<typeof getLoopParams>, "enabled" | "start" | "end" | "isActive"> = getLoopParams(),
  ) => nativePlayback.updateLoop({
    loopEnabled: loop.isActive,
    loopStartSec: loop.start,
    loopEndSec: loop.end,
  })

  const awaitPendingStop = async () => {
    const stop = pendingStop
    if (stop) await stop.catch(() => undefined)
  }

  const awaitPendingPauseAndStop = async () => {
    const pendingPause = pendingBackendPause
    if (pendingPause) await pendingPause.promise.catch(() => undefined)
    await awaitPendingStop()
  }

  const prepareLegacyPaused = () => {
    audioEngine.stopAllSources()
    audioEngine.cancelAutomationSchedules()
    deferredStretchQueue.clear()
    setActiveBackend("idle")
  }

  const acknowledgeRecovery = async (generation: number, result: "ready" | "failed") => {
    if (!audioHostBridge || audioHostBridge.completeRecovery === undefined) return true
    const acknowledgement = await audioHostBridge.completeRecovery(generation, result)
    if (!acknowledgement.accepted) throw new Error("Audio recovery acknowledgement was stale.")
    return true
  }

  const recoverPausedAudio = async (lifecycle: DesktopAudioLifecycle) => {
    if (lifecycle.state !== "recovering" || lifecycle.powerGeneration < audioLifecycleGeneration) return
    if (recoveryAttempt) {
      if (lifecycle.powerGeneration <= recoveryAttempt.generation) return
      recoveryAttempt.cancelled = true
      void recoveryAttempt.promise?.then(() => {
        if (
          untrack(() => mounted && audioLifecycleState() === "recovering")
          && audioLifecycleGeneration === lifecycle.powerGeneration
        ) {
          void recoverPausedAudio(lifecycle)
        }
      }, () => {
        if (
          untrack(() => mounted && audioLifecycleState() === "recovering")
          && audioLifecycleGeneration === lifecycle.powerGeneration
        ) {
          void recoverPausedAudio(lifecycle)
        }
      })
      return
    }
    setLifecycleState("recovering")
    audioLifecycleGeneration = lifecycle.powerGeneration
    const recoveryGeneration = lifecycle.powerGeneration
    const token = recoveryToken + 1
    recoveryToken = token
    const attempt: RecoveryAttempt = { generation: recoveryGeneration, token, cancelled: false }
    recoveryAttempt = attempt
    const isCurrent = () => (
      mounted
      && recoveryAttempt === attempt
      && token === recoveryToken
      && !attempt.cancelled
      && audioLifecycleState() === "recovering"
      && audioLifecycleGeneration === recoveryGeneration
    )
    const recovery = (async () => {
      if (externalNativeSession) {
        // The session's owner recovers it; this renderer has no native graph to rebuild.
        await acknowledgeRecovery(recoveryGeneration, "ready")
        if (!isCurrent()) return
        setLifecycleState("ready")
        return
      }
      const sec = lastPublishedPlayheadSec
      const preserveBrowserFallback = !requiresNativeAudio
        && isPlaying()
        && !nativePlayback.isActive()
        && !nativePlayback.isPrepared()
      if (preserveBrowserFallback) {
        await acknowledgeRecovery(recoveryGeneration, "ready")
        if (!isCurrent()) return
        setLifecycleState("ready")
        return
      }
      await disposePreparedBackends(undefined, "audio-recovery-start")
      if (!isCurrent()) return
      if (isPlaying() && !nativePlayback.isActive() && !nativePlayback.isPrepared()) {
        await acknowledgeRecovery(recoveryGeneration, "ready")
        if (!isCurrent()) return
        setLifecycleState("ready")
        return
      }
      setIsPlaying(false)
      cancelRaf()

      let prepared = false
      if (!requiresNativeAudio && portableBrowserOptions) {
        audioEngine.ensureAudio({ applyCachedTrackGains: false })
        await audioEngine.resume()
        if (!isCurrent()) {
          await disposePreparedBackends(undefined, "audio-recovery-superseded")
          return
        }
        const result = await portableBrowserPlayback.ensurePrepared({
          state: "paused",
          playheadSec: sec,
          loopEnabled: false,
          loopStartSec: 0,
          loopEndSec: 0,
        })
        if (!isCurrent()) {
          await disposePreparedBackends(undefined, "audio-recovery-superseded")
          return
        }
        prepared = result === "started"
        if (prepared) setActiveBackend("portable-browser")
      }
      if (!prepared && (requiresNativeAudio || nativeOptions?.enabled?.())) {
        const result = await nativePlayback.ensureLivePreview(sec)
        if (!isCurrent()) {
          await disposePreparedBackends(undefined, "audio-recovery-superseded")
          return
        }
        if (result === "blocked") throw new Error("Native audio recovery is unavailable for the current project.")
        prepared = result === "started"
        if (prepared) setActiveBackend("native")
      }
      if (!prepared && !requiresNativeAudio) prepareLegacyPaused()
      if (!prepared && requiresNativeAudio) {
        throw new Error("Native audio recovery did not prepare a native playback graph.")
      }
      if (!isCurrent()) return
      await acknowledgeRecovery(recoveryGeneration, "ready")
      if (!isCurrent()) return
      setLifecycleState("ready")
    })()
    attempt.promise = recovery
    try {
      await recovery
    } catch (error) {
      if (!isCurrent()) return
      await disposePreparedBackends(undefined, "audio-recovery-failed")
      if (!isCurrent()) return
      setLifecycleState("failed")
      await acknowledgeRecovery(recoveryGeneration, "failed").catch(() => undefined)
      if (!isCurrent()) return
      lastNativeFault = error instanceof Error ? error.message : "Audio recovery failed."
      reportNativeStopped(lastNativeFault)
    } finally {
      if (recoveryAttempt === attempt) recoveryAttempt = undefined
    }
  }

  const setPlayhead = (sec: number, tracks: Track[]) => {
    if (requiresNativeAudio && nativePlayback.isRecording()) return
    const seekSequence = ++nativeSeekSequence
    publishPlayhead(sec)
    setLastTracks(tracks)
    if (requiresNativeAudio) {
      const pendingStart = nativePlayback.getPendingStart()
      const pendingPreview = !nativePlayback.isPrepared() && pendingStart?.mode === "preview" ? pendingStart.promise : undefined
      if (nativePlayback.isPrepared() || rebuildInProgress || preparedBackendDisposePromise || pendingPreview) {
        const resumePlayback = isPlaying()
        const seekIntentToken = transportIntentToken
        const seekReconciliationToken = nativeLifecycleToken
        const seekPlayPhaseToken = playAttemptPhase?.token
        const reconcileSupersededSeek = () => {
          if (!mounted || seekSequence !== nativeSeekSequence || seekIntentToken !== transportIntentToken) return true
          // A native Play that reached its start after this seek starts from the playhead the seek published and owns
          // the graph from there.
          if (playAttemptPhase?.backend === 'native' && playAttemptPhase.token !== seekPlayPhaseToken) return true
          if (!rebuildInProgress && !preparedBackendDisposePromise) {
            if (seekReconciliationToken === nativeLifecycleToken) return false
            // The lifecycle this seek targeted ended and only a preview start owns the next one: it prepares at the
            // playhead this seek published, so a rebuild would prepare it again. A preview carries no resume intent.
            if (!resumePlayback && nativePlayback.getPendingStart()?.mode === "preview") return true
          }
          void restartTimelineSchedule(tracks, {
            rebuildBackend: true,
            resumePlayback,
            playheadSec: sec,
            owner: 'native',
            projectId: nativeOptions?.projectId?.(),
            projectGeneration: nativeOptions?.projectGeneration?.(),
          }).catch((cause: unknown) => {
            reportNativeStopped(
              cause instanceof Error
                ? cause.message
                : 'The native playback graph could not be rebuilt after a structural change.',
            )
          })
          return true
        }
        // A rebuild may already own this lifecycle token. Update its transport
        // intent instead of seeking the graph it is about to retire.
        if (reconcileSupersededSeek()) return
        const seek = () => void nativePlayback.seekPrepared(sec).then((result) => {
          if (reconcileSupersededSeek()) return
          if (result !== "started") {
            reportNativeStopped("The native playback graph could not seek.")
            setActiveBackend("idle")
          } else {
            setActiveBackend("native")
          }
        }).catch((cause: unknown) => {
          if (reconcileSupersededSeek()) return
          reportNativeStopped(
            cause instanceof Error
              ? cause.message
              : "The native playback graph could not seek.",
          )
          setActiveBackend("idle")
        })
        // A preview that has not committed has no graph to seek yet. Its own owner reports a failed start.
        if (!pendingPreview) seek()
        else void pendingPreview.then((result) => {
          if (result === "started" && !reconcileSupersededSeek()) seek()
        }, () => undefined)
      }
      return
    }
    if (isPlaying() && (nativePlayback.isActive() || portableBrowserPlayback.isActive())) {
      const owner = portableBrowserPlayback.isActive() ? 'portable-browser' : 'native'
      void restartTimelineSchedule(tracks, {
        rebuildBackend: true,
        resumePlayback: true,
        playheadSec: sec,
        owner,
        projectId: nativeOptions?.projectId?.(),
        projectGeneration: nativeOptions?.projectGeneration?.()
          ?? portableBrowserOptions?.projectGeneration?.(),
      }).catch((cause: unknown) => {
        portableBrowserOptions?.reportFault?.(
          cause instanceof Error ? cause.message : 'Playback could not seek while active.',
        )
      })
      return
    }
    if (!isPlaying()) {
      audioEngine.cancelAutomationSchedules()
      audioEngine.onTransportSeek(sec, SCHED_AHEAD_SEC)
      audioEngine.applyAutomationAtTimelineSec(sec)
      // A kept paused session follows a paused locate, so a warm start and its schedule begin at the playhead.
      if (portableBrowserPlayback.isPrepared()) void ensureLivePortableSession().catch(() => undefined)
      return
    }
    if (nativePlayback.isPrepared() || portableBrowserPlayback.isPrepared()) {
      setIsPlaying(false)
      cancelRaf()
      void disposePreparedBackends(undefined, "playhead-changed").catch(reportNativeStateCaptureFailure)
      disposePortableBrowserPlayback()
      setActiveBackend('idle')
      return
    }
    // IMPORTANT: Update transport epoch BEFORE scheduling, so MIDI events use the correct mapping
    audioEngine.cancelAutomationSchedules()
    audioEngine.onTransportSeek(sec, SCHED_AHEAD_SEC)
    deferredStretchQueue.clear()
    const { isActive, end } = getLoopParams()
    scheduledUntilSec = getScheduleHorizonEnd(sec, isActive ? end : undefined)
    scheduleAndTrackDeferred(tracks, sec, { endLimitSec: scheduledUntilSec })
    audioEngine.scheduleAutomationFromPlayhead(sec, {
      horizonSec: scheduledUntilSec - sec,
      tracks,
    })
  }
  const disposePreparedBackends = async (
    options?: { invalidateProjectArtifacts?: boolean; onStoppedPosition?: (seconds: number) => void },
    reason = "prepared-backend-dispose",
    invalidated = false,
  ) => {
    if (preparedBackendDisposePromise) return preparedBackendDisposePromise
    if (!invalidated) nativeLifecycleToken += 1
    preparedBackendDisposeHasPendingNativeStart = nativePlayback.getPendingStart() !== undefined
    const dispose = (async () => {
      const pendingStart = nativePlayback.cancelPendingStart()
      let captureError: unknown
      let disposalError: unknown
      try {
        await capturePreparedNativeVstStates()
      } catch (error) {
        captureError = error
      } finally {
        const disposal = requiresNativeAudio
          ? [nativePlayback.dispose(options, reason)]
          : [nativePlayback.dispose(options, reason), Promise.resolve(disposePortableBrowserPlayback())]
        const [nativeDisposal] = await Promise.allSettled([...disposal, pendingStart])
        if (options?.onStoppedPosition && nativeDisposal?.status === "rejected") disposalError = nativeDisposal.reason
      }
      if (!untrack(isPlaying)) setActiveBackend('idle')
      if (disposalError !== undefined) throw disposalError
      if (captureError !== undefined) throw captureError
    })()
    preparedBackendDisposePromise = dispose
    void dispose.finally(() => {
      if (preparedBackendDisposePromise === dispose) preparedBackendDisposePromise = undefined
      preparedBackendDisposeHasPendingNativeStart = false
    }).catch(() => undefined)
    return dispose
  }
  const handleAudioLifecycle = (lifecycle: DesktopAudioLifecycle) => {
    if (!mounted) return
    if (lifecycle.powerGeneration < audioLifecycleGeneration) return
    const lifecycleChanged = lifecycle.powerGeneration !== audioLifecycleGeneration
      || lifecycle.state !== audioLifecycleState()
    if (lifecycleChanged && isRebuildingPlayback()
      && (lifecycle.state === "suspended" || lifecycle.state === "failed")) {
      clearRebuildHostLoss()
      setIsRebuildingPlayback(false)
      transportIntentToken += 1
      invalidatePlayAttempt()
    }
    const nativePlaybackInProgress = playAttemptPhase?.backend === 'native'
      || nativePlayback.isActive()
      || nativePlayback.isPrepared()
    const shouldInvalidateNativePlayback = lifecycleChanged
      && lifecycle.state !== "ready"
      && nativePlaybackInProgress
    if (shouldInvalidateNativePlayback) {
      invalidatePlayAttempt()
      if (isPlaying()) {
        setIsPlaying(false)
        cancelRaf()
      }
      void disposePreparedBackends(undefined, "audio-lifecycle-change")
    }
    audioLifecycleGeneration = lifecycle.powerGeneration
    setLifecycleState(lifecycle.state)
    if (lifecycle.state === "suspended") {
      invalidatePlayAttempt()
      recoveryToken += 1
      if (recoveryAttempt) recoveryAttempt.cancelled = true
      cancelRaf()
      const frozenSec = nativePlayback.currentPositionSec()
        ?? (requiresNativeAudio ? undefined : portableBrowserPlayback.currentPositionSec())
        ?? (requiresNativeAudio ? undefined : audioEngine.currentTimelineSec)
        ?? lastPublishedPlayheadSec
      publishPlayhead(frozenSec)
      setIsPlaying(false)
      if (!requiresNativeAudio) {
        audioEngine.stopAllSources()
        audioEngine.cancelAutomationSchedules()
      }
      deferredStretchQueue.clear()
      void disposePreparedBackends(undefined, "audio-host-suspended")
      return
    }
    if (lifecycle.state === "recovering") {
      nativePlayback.resetNativeHostConnectionLoss()
      if (playAttemptPhase?.backend === 'fallback' && playAttemptPhase.state === 'startup') {
        void acknowledgeRecovery(lifecycle.powerGeneration, "ready")
          .then(() => {
            if (
              untrack(() => mounted && audioLifecycleState() === "recovering")
              && audioLifecycleGeneration === lifecycle.powerGeneration
            ) setLifecycleState("ready")
          })
          .catch(() => undefined)
        return
      }
      void recoverPausedAudio({
        state: lifecycle.state,
        powerGeneration: lifecycle.powerGeneration,
      })
      return
    }
    if (lifecycle.state === "failed" && (nativePlayback.isActive() || nativePlayback.isPrepared())) {
      recoveryToken += 1
      if (recoveryAttempt) recoveryAttempt.cancelled = true
      cancelRaf()
      setIsPlaying(false)
      void disposePreparedBackends(undefined, "audio-host-failed").catch(reportNativeStateCaptureFailure)
      setActiveBackend("idle")
    }
  }
  const removeAudioLifecycle = hasAudioLifecycle
    ? untrack(() => createDesktopAudioLifecycleReconciler(audioHostBridge, handleAudioLifecycle))
    : undefined
  let previewProjectionBaseline: string | undefined
  let portableCompiledFingerprint: string | undefined
  const restartTimelineSchedule = (
    tracks: Track[],
    options?: TimelineScheduleOptions,
  ): Promise<void> => requestTimelineSchedule(tracks, options, true)
  const requestTimelineSchedule = async (
    tracks: Track[],
    options?: TimelineScheduleOptions,
    explicit = false,
  ): Promise<void> => {
    if (!(nativePlayback.isActive() && audioHostBridge?.session.revisions && audioHostBridge.session.configureInstrumentStates
      && (!options?.owner || options.owner === "native")
      && (options?.resumePlayback === undefined || options.resumePlayback)
      && (options?.projectId === undefined || options.projectId === nativeOptions?.projectId?.())
      && (options?.projectGeneration === undefined || options.projectGeneration === nativeOptions?.projectGeneration?.()))) {
      // A playing portable session adopts what it carries live, as native does. Only followPortableEdits asks with no
      // transport intent of its own while one plays; a seek or structural rebuild names its intent and rebuilds.
      if (options || !portableBrowserPlayback.isActive() || !untrack(isPlaying)) return applyTimelineSchedule(tracks, options)
      const key = readDesiredScheduleFingerprint(tracks)
      const transportIntent = transportIntentToken
      const lifecycle = nativeLifecycleToken
      const outcome = await portableBrowserPlayback.adoptSchedule()
      if (!mounted || transportIntent !== transportIntentToken || lifecycle !== nativeLifecycleToken) return
      // A rebuild would end the take: while recording, the session keeps what it plays, as before adoption.
      if (outcome === "rebuild" && !portableBrowserPlayback.isRecording()) {
        await applyTimelineSchedule(tracks, { rebuildBackend: true })
      } else if (outcome === "adopted" || outcome === "unchanged") previewProjectionBaseline = key
      // The baseline stays behind, so the next follow compiles the newest state and stages it again.
      else if (outcome === "failed") console.warn("[portable-playback] instrument adoption failed; the playing graph is kept and staging retries on the next follow")
      return
    }
    const key = readDesiredScheduleFingerprint(tracks)
    const transportIntent = transportIntentToken
    const seekSequence = nativeSeekSequence
    const lifecycle = nativeLifecycleToken
    const projectId = nativeOptions?.projectId?.()
    const projectGeneration = nativeOptions?.projectGeneration?.()
    const { isActive, start, end } = getLoopParams()
    const outcome = await nativePlayback.adoptSchedule({
      key,
      schedule: JSON.stringify({ tracks: readNativePreviewTrackFingerprint(tracks), loop: getLoopParams(), bpm: loopOptions?.bpm?.() }),
      context: { instrumentOverride: options?.instrumentOverride, externalProcessor: options?.externalProcessor },
      loop: { loopEnabled: isActive, loopStartSec: start, loopEndSec: end },
    }, explicit)
    const current = () => mounted && transportIntent === transportIntentToken && seekSequence === nativeSeekSequence
      && lifecycle === nativeLifecycleToken && projectId === nativeOptions?.projectId?.()
      && projectGeneration === nativeOptions?.projectGeneration?.()
    if (!current()) return
    if (outcome.status === "rebuild") {
      await applyTimelineSchedule(tracks, { ...options, rebuildBackend: true })
      if (current()) previewProjectionBaseline = key
    } else if (outcome.status === "adopted" || outcome.status === "unchanged") previewProjectionBaseline = key
  }
  const applyTimelineSchedule = async (
    tracks: Track[],
    options?: TimelineScheduleOptions,
  ) => {
    if (options?.rebuildBackend) {
      nativeLifecycleToken += 1
      rebuildRequestVersion += 1
      const requestVersion = rebuildRequestVersion
      pendingRebuildTracks = tracks
      subscribeRebuildHostLoss()
      pendingRebuildTransportIntentToken = transportIntentToken
      pendingRebuildRequestVersion = requestVersion
      if (playAttempt && playAttemptPhase?.token !== playAttempt.token) {
        playAttempt.waitingForRebuild = true
      }
      const hasExplicitIntent = options.resumePlayback !== undefined
        || options.playheadSec !== undefined
        || options.owner !== undefined
        || options.projectId !== undefined
        || options.projectGeneration !== undefined
        || options.instrumentOverride !== undefined
        || options.externalProcessor !== undefined
      if (hasExplicitIntent) {
        pendingRebuildIntent = {
          resumePlayback: options.resumePlayback === true,
          playheadSec: options.playheadSec ?? lastPublishedPlayheadSec,
          owner: options.owner,
          projectId: options.projectId,
          projectGeneration: options.projectGeneration,
          instrumentOverride: options.instrumentOverride,
          externalProcessor: options.externalProcessor,
        }
      } else if (isPlaying() || nativePlayback.isActive() || portableBrowserPlayback.isActive()) {
        const owner = nativePlayback.isActive() ? 'native'
          : portableBrowserPlayback.isActive() ? 'portable-browser'
            : undefined
        pendingRebuildIntent = {
          resumePlayback: true,
          playheadSec: nativePlayback.isActive()
            ? nativePlayback.currentPositionSec() ?? lastPublishedPlayheadSec
            : portableBrowserPlayback.isActive()
              ? portableBrowserPlayback.currentPositionSec() ?? lastPublishedPlayheadSec
              : lastPublishedPlayheadSec,
          owner,
        }
      }
      // A rebuild past its last request check takes no more: this request starts the next one.
      if (rebuildPromise && rebuildInProgress) return rebuildPromise
      const rebuild = (async () => {
        rebuildInProgress = true
        // Let synchronous rebuild requests settle before starting an
        // irreversible backend start so queued structural changes coalesce.
        await Promise.resolve()
        try {
          while (pendingRebuildTracks) {
            const nextTracks = pendingRebuildTracks
            pendingRebuildTracks = undefined
            const nextIntent = pendingRebuildIntent
            pendingRebuildIntent = undefined
            const nextRequestVersion = pendingRebuildRequestVersion
            pendingRebuildRequestVersion = undefined
            const nextTransportIntentToken = pendingRebuildTransportIntentToken
            pendingRebuildTransportIntentToken = undefined
            try {
              await rebuildTimelineBackend(nextTracks, nextIntent, nextTransportIntentToken, nextRequestVersion)
            } catch (error: unknown) {
              if (pendingRebuildTracks) continue
              throw error
            }
          }
        } finally {
          clearRebuildHostLoss()
          setIsRebuildingPlayback(false)
          rebuildInProgress = false
          rebuildStartingPlay = false
          followPortableEdits()
        }
      })()
      rebuildPromise = rebuild
      void rebuild.finally(() => {
        if (rebuildPromise === rebuild) rebuildPromise = undefined
      }).catch(() => undefined)
      return rebuild
    }
    if (!isPlaying()) return
    if (nativePlayback.isActive() || portableBrowserPlayback.isActive()) {
      setIsPlaying(false)
      cancelRaf()
      void disposePreparedBackends(undefined, "timeline-schedule-replaced").catch(reportNativeStateCaptureFailure)
      if (!requiresNativeAudio) disposePortableBrowserPlayback()
      setActiveBackend('idle')
      return
    }
    if (requiresNativeAudio) return
    setLastTracks(tracks)
    const sec = audioEngine.currentTimelineSec
    audioEngine.stopAllSources()
    audioEngine.cancelAutomationSchedules()
    deferredStretchQueue.clear()
    audioEngine.onTransportSeek(sec, SCHED_AHEAD_SEC)
    const { isActive, end } = getLoopParams()
    scheduledUntilSec = getScheduleHorizonEnd(sec, isActive ? end : undefined)
    scheduleAndTrackDeferred(tracks, sec, { endLimitSec: scheduledUntilSec })
    audioEngine.scheduleAutomationFromPlayhead(sec, {
      horizonSec: scheduledUntilSec - sec,
      tracks,
    })
  }
  const rebuildTimelineBackend = async (
    tracks: Track[],
    requestedIntent?: TimelinePlaybackRebuildIntent,
    requestedTransportIntentToken = transportIntentToken,
    requestedRequestVersion = rebuildRequestVersion,
  ) => {
    const compileContext = requestedIntent?.instrumentOverride !== undefined
      || requestedIntent?.externalProcessor !== undefined
      ? {
        instrumentOverride: requestedIntent.instrumentOverride,
        externalProcessor: requestedIntent.externalProcessor,
      }
      : undefined
    const isSuperseded = () => (
      requestedTransportIntentToken !== transportIntentToken
      || requestedRequestVersion !== rebuildRequestVersion
    )
    if (isSuperseded()) return
    lastNativeFault = undefined
    const currentProjectId = nativeOptions?.projectId?.()
    const currentProjectGeneration = nativeOptions?.projectGeneration?.()
      ?? portableBrowserOptions?.projectGeneration?.()
    if (
      requestedIntent?.projectId !== undefined
      && requestedIntent.projectId !== currentProjectId
    ) return
    if (
      requestedIntent?.projectGeneration !== undefined
      && requestedIntent.projectGeneration !== currentProjectGeneration
    ) return
    const isCurrentRequestedProject = () => (
      (requestedIntent?.projectId === undefined
        || requestedIntent.projectId === (nativeOptions?.projectId?.()))
      && (requestedIntent?.projectGeneration === undefined
        || requestedIntent.projectGeneration === (
          nativeOptions?.projectGeneration?.()
          ?? portableBrowserOptions?.projectGeneration?.()
        ))
    )
    await awaitPendingPauseAndStop()
    if (isSuperseded()) return
    const pendingPlayWaitsForRebuild = playAttempt?.waitingForRebuild === true
    const pendingPlay = pendingPlayWaitsForRebuild ? undefined : playAttempt
    const pendingPlayIntent = pendingPlay !== undefined || rebuildStartingPlay
    // A Play still current when the rebuild starts is the newest transport intent: an edit never cancels it.
    const resumeIntent = rebuildStartingPlay || pendingPlay?.token === playAttemptToken
      || (requestedIntent !== undefined
        ? requestedIntent.resumePlayback
        : pendingPlayIntent)
    // A cold device rebuild temporarily halts callbacks, not the user's Play
    // intent. Keep host/UI transport status playing until resume or cancellation.
    setIsRebuildingPlayback(isRebuildingPlayback() || isPlaying())
    const requestedOwner = requestedIntent?.owner
      ?? (nativePlayback.isActive() || nativePlayback.isPrepared()
        ? 'native'
        : portableBrowserPlayback.isActive() || portableBrowserPlayback.isPrepared()
          ? 'portable-browser'
          : undefined)
    const pendingPreview = nativePlayback.getPendingStart()
    const pendingPreviewIntent = !pendingPlayIntent && pendingPreview?.mode === "preview"
    if (pendingPlay) {
      invalidatePlayAttempt()
      if (isPlaying()) {
        setIsPlaying(false)
        cancelRaf()
      }
      await pendingPlay.promise.catch(() => undefined)
      if (isSuperseded()) return
      await disposePreparedBackends(undefined, "timeline-rebuild-retirement")
    } else if (pendingPreview) {
      await disposePreparedBackends(undefined, "preview-retirement")
      await pendingPreview.promise.catch(() => undefined)
    }
    if (resumeIntent) {
      const intentToken = transportIntentToken
      if (requestedIntent?.resumePlayback === true) publishPlayhead(requestedIntent.playheadSec)
      if (
        !pendingPlay
        && !pendingPreview
        && (isPlaying() || nativePlayback.isActive() || portableBrowserPlayback.isActive())
      ) {
        setIsPlaying(false)
        cancelRaf()
        await disposePreparedBackends({
          onStoppedPosition: (seconds) => {
            if (!isSuperseded() && isCurrentRequestedProject()) publishPlayhead(seconds)
          },
        }, "timeline-rebuild-retirement")
      }
      rebuildStartingPlay = true
      await pendingNativeDispose
      await waitForLifecycleReady()
      if (
        isSuperseded()
        || intentToken !== transportIntentToken
        || !mounted
        || audioLifecycleState() === "suspended"
        || !isCurrentRequestedProject()
      ) return
      if (requestedOwner === 'native' && !nativePlayback.isPrepared()) {
        const nativePreview = await nativePlayback.ensureLivePreview(
          lastPublishedPlayheadSec,
          compileContext,
        )
        if (
          isSuperseded()
          || intentToken !== transportIntentToken
          || !mounted
          || !isCurrentRequestedProject()
        ) {
          await disposePreparedBackends(undefined, "timeline-rebuild-superseded")
          return
        }
        if (nativePreview !== 'started') {
          if (requiresNativeAudio) throw new Error("The native playback graph could not be prepared.")
          return
        }
      } else if (requestedOwner === 'portable-browser') {
        await disposePreparedBackends(undefined, "portable-backend-switch")
        await pendingNativeDispose
      }
      if (isSuperseded()) {
        await disposePreparedBackends(undefined, "timeline-rebuild-superseded")
        return
      }
      if (playAttempt?.waitingForRebuild) return
      await handlePlay(
        tracks,
        compileContext,
      )
      if (isSuperseded()) {
        await disposePreparedBackends(undefined, "timeline-rebuild-superseded")
        return
      }
      if (
        intentToken !== transportIntentToken
        || !mounted
        || audioLifecycleState() === "suspended"
        || !isCurrentRequestedProject()
      ) return
      if (!isPlaying()) {
        throw new Error(lastNativeFault
          ? `The active native playback graph could not be rebuilt after the insertion: ${lastNativeFault}`
          : "The active native playback graph could not be rebuilt after the insertion.")
      }
      return
    }
    if (!isPlaying()) {
      const pausedIntentToken = transportIntentToken
      const isCurrentPausedIntent = () => (
        !isSuperseded()
        &&
        pausedIntentToken === transportIntentToken
        && mounted
        && audioLifecycleState() !== "suspended"
        && isCurrentRequestedProject()
      )
      const sec = requestedIntent?.playheadSec
        ?? (nativePlayback.isPrepared()
          ? nativePlayback.currentPositionSec() ?? lastPublishedPlayheadSec
          : portableBrowserPlayback.isPrepared()
            ? portableBrowserPlayback.currentPositionSec() ?? lastPublishedPlayheadSec
            : lastPublishedPlayheadSec)
      publishPlayhead(sec)
      const transport = {
        state: "paused" as const,
        playheadSec: sec,
        loopEnabled: getLoopParams().isActive,
        loopStartSec: getLoopParams().start,
        loopEndSec: getLoopParams().end,
      }
      const preparePausedCompatibility = async () => {
        if (!isCurrentPausedIntent()) return
        const nativeLifecycleReady = !hasAudioLifecycle || audioLifecycleState() === "ready"
        if (nativeLifecycleReady && nativeOptions?.enabled?.()) {
          const result = await nativePlayback.ensureLivePreview(
            sec,
            compileContext,
          )
          if (!isCurrentPausedIntent()) {
            await disposePreparedBackends(undefined, "paused-preview-rebuild-superseded")
            return
          }
          if (result === "started") {
            setActiveBackend("native")
            return
          }
          if (result === "blocked") {
            setActiveBackend("idle")
            throw new Error("The native playback graph could not be prepared.")
          }
        }
        prepareLegacyPaused()
      }
      const nativeDispose = pendingNativeDispose
      await nativeDispose
      if (nativeDispose !== pendingNativeDispose) await pendingNativeDispose
      if (isSuperseded() || !isCurrentPausedIntent()) return
      if ((requestedOwner === 'native' || nativePlayback.isPrepared()) && nativePlayback.isPrepared()) {
        await disposePreparedBackends(undefined, "paused-preview-rebuild")
        const result = await nativePlayback.ensureLivePreview(sec, compileContext)
        if (!isCurrentPausedIntent()) {
          await disposePreparedBackends(undefined, "paused-preview-rebuild-superseded")
          return
        }
        if (result !== "started") {
          setActiveBackend("idle")
          throw new Error(lastNativeFault
            ? `The prepared native playback graph could not be rebuilt: ${lastNativeFault}`
            : "The prepared native playback graph could not be rebuilt.")
        }
        setActiveBackend("native")
      } else if (requestedOwner === 'native' || pendingPreviewIntent) {
        const result = await nativePlayback.ensureLivePreview(sec, compileContext)
        if (!isCurrentPausedIntent()) {
          await disposePreparedBackends(undefined, "paused-preview-rebuild-superseded")
          return
        }
        if (result !== "started") {
          setActiveBackend("idle")
          throw new Error(lastNativeFault
            ? `The prepared native playback graph could not be rebuilt: ${lastNativeFault}`
            : "The prepared native playback graph could not be rebuilt.")
        }
        setActiveBackend("native")
      } else if (requestedIntent && requiresNativeAudio) {
        const result = await nativePlayback.ensureLivePreview(sec, compileContext)
        if (!isCurrentPausedIntent()) {
          await disposePreparedBackends(undefined, "paused-preview-rebuild-superseded")
          return
        }
        if (result !== "started") {
          setActiveBackend("idle")
          throw new Error("The native playback graph could not be prepared.")
        }
        setActiveBackend("native")
      } else if (!requiresNativeAudio && portableBrowserPlayback.isPrepared()) {
        audioEngine.ensureAudio({ applyCachedTrackGains: false })
        await audioEngine.resume()
        if (!isCurrentPausedIntent()) {
          await disposePreparedBackends(undefined, "paused-preview-rebuild-superseded")
          return
        }
        const result = await portableBrowserPlayback.rebuildPrepared(transport, compileContext)
        if (!isCurrentPausedIntent()) {
          await disposePreparedBackends(undefined, "paused-preview-rebuild-superseded")
          return
        }
        if (result !== "started") {
          disposePortableBrowserPlayback()
          await preparePausedCompatibility()
        }
        else setActiveBackend("portable-browser")
      } else if (requestedIntent && portableBrowserOptions) {
        audioEngine.ensureAudio({ applyCachedTrackGains: false })
        await audioEngine.resume()
        if (!isCurrentPausedIntent()) {
          await disposePreparedBackends(undefined, "paused-preview-rebuild-superseded")
          return
        }
        const result = await portableBrowserPlayback.ensurePrepared(transport, compileContext)
        if (!isCurrentPausedIntent()) {
          await disposePreparedBackends(undefined, "paused-preview-rebuild-superseded")
          return
        }
        if (result !== "started") {
          disposePortableBrowserPlayback()
          await preparePausedCompatibility()
        }
        else setActiveBackend("portable-browser")
      }
      return
    }
    let sec = requestedIntent?.playheadSec
      ?? (nativePlayback.isActive() || portableBrowserPlayback.isActive()
        ? (nativePlayback.isActive()
          ? nativePlayback.currentPositionSec() ?? lastPublishedPlayheadSec
          : portableBrowserPlayback.currentPositionSec() ?? lastPublishedPlayheadSec)
        : requiresNativeAudio ? lastPublishedPlayheadSec : audioEngine.currentTimelineSec)
    publishPlayhead(sec)
    const intentToken = transportIntentToken
    rebuildStartingPlay = true
    setIsPlaying(false)
    cancelRaf()
    await disposePreparedBackends({
      onStoppedPosition: (seconds) => {
        if (isSuperseded() || !isCurrentRequestedProject()) return
        sec = seconds
        publishPlayhead(seconds)
      },
    }, "timeline-rebuild-retirement")
    await pendingNativeDispose
    await waitForLifecycleReady()
    if (
      isSuperseded()
      ||
      intentToken !== transportIntentToken
      || !mounted
      || audioLifecycleState() === "suspended"
      || !isCurrentRequestedProject()
    ) return
    if (requestedOwner === 'native') {
      const nativePreview = await nativePlayback.ensureLivePreview(sec, compileContext)
      if (
        isSuperseded()
        ||
        intentToken !== transportIntentToken
        || !mounted
        || audioLifecycleState() === "suspended"
        || !isCurrentRequestedProject()
      ) {
        await disposePreparedBackends(undefined, "timeline-rebuild-superseded")
        return
      }
      if (nativePreview !== 'started') {
        if (requiresNativeAudio) throw new Error("The native playback graph could not be prepared.")
        return
      }
    } else if (requestedOwner === 'portable-browser') {
      await disposePreparedBackends(undefined, "portable-backend-switch")
      await pendingNativeDispose
    }
    rebuildStartingPlay = true
    if (playAttempt?.waitingForRebuild) return
    await handlePlay(tracks, compileContext)
    rebuildStartingPlay = false
    if (
      intentToken !== transportIntentToken
      || !mounted
      || audioLifecycleState() === "suspended"
      || !isCurrentRequestedProject()
    ) return
    if (!isPlaying()) {
      throw new Error(lastNativeFault
        ? `The active native playback graph could not be rebuilt after the insertion: ${lastNativeFault}`
        : "The active native playback graph could not be rebuilt after the insertion.")
    }
  }
  const unsubscribeStretchRenderState = requiresNativeAudio
    ? () => undefined
    : audioEngine.subscribeStretchRenderState(() => {
      untrack(() => {
        if (isPlaying()) retryDeferredStretchWindows(audioEngine.currentTimelineSec, { includeNonImminent: true })
      })
    })

  let mountedProjectGeneration = nativeOptions?.projectGeneration?.()
    ?? portableBrowserOptions?.projectGeneration?.()
    ?? 0
  let mountedProjectId = nativeOptions?.projectId?.()
  let nativeLifecycleToken = 0
  let pendingNativeDispose: Promise<void> = Promise.resolve()
  let preparedBackendDisposeHasPendingNativeStart = false
  let nativePreviewRequested = false
  let nativePreviewTrackFingerprint: string | undefined
  const bufferFingerprints = new WeakMap<object, number>()
  let nextBufferFingerprint = 1
  const readBufferFingerprint = (buffer: AudioBuffer | null | undefined) => {
    if (!buffer) return null
    const existing = bufferFingerprints.get(buffer)
    if (existing !== undefined) return existing
    const fingerprint = nextBufferFingerprint++
    bufferFingerprints.set(buffer, fingerprint)
    return fingerprint
  }
  // A track's compiler inputs are the fields the playback compiles read: its mixer channel (createMixerChannel), its
  // frame schedule (compilePortableFrameSchedule), its clip projection (projectPortableClipEvents) and its native
  // instruments (compileLiveNativeProjection). A name reaches only the mixer channel's label and a colour no compile, so
  // neither changes what plays.
  const readNativePreviewTrackFingerprint = (tracks = loopOptions?.getTracks?.() ?? []) => JSON.stringify({
    bpm: loopOptions?.bpm?.(),
    tracks: tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId, clips }) => ({
      id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId,
      clips: clips.map((clip) => {
        const buffer = "buffer" in clip && globalThis.AudioBuffer && clip.buffer instanceof AudioBuffer
          ? clip.buffer
          : undefined
        // A clip's name, colour and waveform key reach no compile either (export, control and UI code read them). The
        // fields are named, as a track's are, because a persisted row and a projected create order them differently.
        const { id, historyRef, mediaStatus, startSec, duration, sourceAssetKey, sourceKind, sourceDurationSec, sourceSampleRate,
          sourceChannelCount, leftPadSec, bufferOffsetSec, audioWarp, gain, fades, sampleUrl, midi, midiOffsetBeats } = clip
        return { id, historyRef, mediaStatus, startSec, duration, sourceAssetKey, sourceKind, sourceDurationSec, sourceSampleRate,
          sourceChannelCount, leftPadSec, bufferOffsetSec, audioWarp, gain, fades, sampleUrl, midi, midiOffsetBeats,
          buffer: readBufferFingerprint(buffer) } satisfies Record<keyof Omit<Track['clips'][number], 'name' | 'color' | 'waveformAssetKey'> | 'buffer',
            Track['clips'][number][keyof Track['clips'][number]] | ReturnType<typeof readBufferFingerprint>>
      }),
    })),
  })
  // The caller's memo may hand out a new object for unchanged content, so the identity advances only when the content
  // differs from the last one seen.
  // `replaceEqualDeep` hands back its first argument when the two hold the same plain data, sharing any reference.
  let lastPlaybackInputs: { value: object; identity: number } | undefined
  const readPlaybackInputsIdentity = () => {
    const inputs = nativeOptions?.playbackInputs?.()
    if (!inputs) return undefined
    const previous = lastPlaybackInputs
    lastPlaybackInputs = { value: inputs, identity: (previous?.identity ?? 0)
      + (previous && replaceEqualDeep(previous.value, inputs) === previous.value ? 0 : 1) }
    return lastPlaybackInputs.identity
  }
  const readDesiredScheduleFingerprint = (tracks = loopOptions?.getTracks?.() ?? []) => JSON.stringify({
    tracks: readNativePreviewTrackFingerprint(tracks), inputs: readPlaybackInputsIdentity(), loop: getLoopParams(),
  })
  const readScheduleSnapshotFingerprint = (snapshot: LivePlaybackSnapshot) => JSON.stringify({
    ...snapshot,
    revision: undefined,
    processorStateSequence: undefined,
    transport: { ...snapshot.transport, playheadSec: undefined, state: undefined },
    tracks: readNativePreviewTrackFingerprint([...snapshot.tracks]),
    // The resolved mixer graph is compiled from the tracks and fx above (compileLivePlaybackSnapshot); it also carries
    // each channel's label.
    mixer: { ...snapshot.mixer, graph: undefined },
    assets: snapshot.assets.map((asset) => ({ ...asset, buffer: readBufferFingerprint(asset.buffer) })),
  })
  const hasPendingAudioClipHydration = () => (loopOptions?.getTracks?.() ?? []).some((track) =>
    track.clips.some((clip) => (
      !clip.midi
      && Boolean(clip.sourceAssetKey)
      && !("buffer" in clip && clip.buffer)
      && clip.mediaStatus !== "missing"
      && clip.mediaStatus !== "permission-denied"
    )),
  )
  const disposeNativePreview = (
    options?: { invalidateProjectArtifacts?: boolean },
    reason = "paused-preview-dispose",
    after?: Promise<void>,
  ) => {
    // The request is the lifecycle boundary: the effect that asked for this
    // dispose prepares its replacement under the new token.
    nativeLifecycleToken += 1
    // A fresh edit can arrive after the UI pauses but before native finishes
    // its publication/transport handoff. Dispose only after that owner exits.
    const request = pendingNativeDispose
      .then(() => after
        ? after.then(() => disposePreparedBackends(options, reason, true))
        : disposePreparedBackends(options, reason, true))
    pendingNativeDispose = request.catch(() => undefined)
    return request
  }
  // The playing portable session follows the newest desired state, as native adoption does: what it carries live is
  // adopted on the same core, anything else, or an edit that landed while its start was in flight, rebuilds it where
  // the transport stands.
  const followPortableEdits = () => {
    if (rebuildInProgress || playAttempt || !untrack(isPlaying) || !portableBrowserPlayback.isActive()
      || hasPendingAudioClipHydration()
      || untrack(() => readDesiredScheduleFingerprint()) === previewProjectionBaseline) return
    void untrack(() => requestTimelineSchedule(loopOptions?.getTracks?.() ?? [])).catch((cause: unknown) => {
      portableBrowserOptions?.reportFault?.(cause instanceof Error ? cause.message : 'Playback could not follow the edit.')
    })
  }
  createEffect(() => {
    if (!isPlaying() || activeBackend() !== "native") nativePlayback.dropAdoptionIntents()
  })

  createEffect(() => {
    const nextGeneration = nativeOptions?.projectGeneration?.()
      ?? portableBrowserOptions?.projectGeneration?.()
      ?? 0
    const nextProjectId = nativeOptions?.projectId?.()
    if (
      nextGeneration === mountedProjectGeneration
      && nextProjectId === mountedProjectId
    ) return
    mountedProjectGeneration = nextGeneration
    const projectChanged = nextProjectId !== mountedProjectId
    mountedProjectId = nextProjectId
    if (projectChanged) {
      setIsRebuildingPlayback(false)
      transportIntentToken += 1
      pendingRebuildTracks = undefined
      pendingRebuildIntent = undefined
      pendingRebuildTransportIntentToken = undefined
      publishPlayhead(0)
    }
    invalidatePlayAttempt()
    setIsPlaying(false)
    cancelRaf()
    nativePreviewRequested = false
    // The paused-preview effect re-runs on the generation only; when the project id moves after it and the tracks keep
    // their fingerprint, nothing else brings the browser's paused session back.
    void disposeNativePreview(
      { invalidateProjectArtifacts: projectChanged },
      projectChanged ? "project-switch" : "project-generation-changed",
    ).then(ensureLivePortableSession).catch(() => undefined)
    setActiveBackend('idle')
  })

  createEffect(() => {
    const enabled = nativeOptions?.enabled?.() ?? false
    const projectGeneration = nativeOptions?.projectGeneration?.() ?? 0
    const trackFingerprint = readDesiredScheduleFingerprint()
    const pendingAudioHydration = hasPendingAudioClipHydration()
    const tracksChanged = nativePreviewTrackFingerprint !== undefined
      && trackFingerprint !== nativePreviewTrackFingerprint
    nativePreviewTrackFingerprint = trackFingerprint
    // Paused-preview maintenance must not retire the active transport's graph.
    // Recording saves insert unhydrated clips before source release completes.
    if (rebuildInProgress) return
    if (isPlaying()) {
      if (enabled && tracksChanged && !pendingAudioHydration && nativePlayback.isActive()
        && audioHostBridge?.session.revisions && audioHostBridge.session.configureInstrumentStates)
        void untrack(() => requestTimelineSchedule(loopOptions?.getTracks?.() ?? []))
      followPortableEdits()
      return
    }
    const projectionChanged = tracksChanged
      || (previewProjectionBaseline !== undefined && trackFingerprint !== previewProjectionBaseline)
    // A pending browser Play keeps the portable session it starts from; followPortableEdits replaces it once committed.
    if (projectionChanged && nativePreviewRequested && (playAttempt === undefined || !portableBrowserOptions)) {
      if (!nativePlayback.hasLiveMidiTails()) {
        nativePreviewRequested = false
        void disposeNativePreview(undefined, "paused-preview-structural-change",
          tracksChanged ? pendingBackendPause?.promise : undefined)
      }
    }
    if (!enabled || (hasAudioLifecycle && audioLifecycleState() !== "ready")) {
      if (nativePreviewRequested) {
        nativePreviewRequested = false
        void disposeNativePreview(undefined, "native-playback-disabled")
      } else if (projectionChanged && playAttempt === undefined
        && (portableBrowserPlayback.isPrepared() || portableBrowserPlayback.isPreparing())) {
        // ensurePrepared keeps a paused session that stands at the playhead, so an edit replaces the one compiled before it.
        void disposeNativePreview(undefined, "paused-preview-structural-change")
      }
      const token = nativeLifecycleToken
      // Without a native preview, the portable session is the paused graph this hook keeps live.
      void pendingNativeDispose.then(ensureLivePortableSession).then(() => {
        // The paused session now carries this fingerprint, so a re-run without an edit keeps it.
        if (token === nativeLifecycleToken && portableBrowserPlayback.isPrepared() && !portableBrowserPlayback.isActive())
          previewProjectionBaseline = trackFingerprint
      }).catch(() => undefined)
      return
    }
    if (pendingAudioHydration) {
      if (nativePreviewRequested && !nativePlayback.hasLiveMidiTails()) {
        nativePreviewRequested = false
        void disposeNativePreview(undefined, "audio-source-hydration-pending")
      }
      return
    }
    nativePreviewRequested = true
    const token = nativeLifecycleToken
    void pendingNativeDispose
      .then(() => {
        if (
          rebuildInProgress
          ||
          token !== nativeLifecycleToken
          || !nativeOptions?.enabled?.()
          || projectGeneration !== (nativeOptions?.projectGeneration?.() ?? 0)
        ) return
        // A Stop or locate can land while the dispose this waits for runs: prepare at the playhead as it is now.
        return nativePlayback.ensureLivePreview(untrack(playheadSec)).then((result) => {
          if (result !== "started") return ensureLivePortableSession()
          if (token === nativeLifecycleToken && !nativePlayback.isActive()) previewProjectionBaseline = trackFingerprint
        })
      })
      .catch(() => undefined)
  })

  onCleanup(() => {
    mounted = false
    transportIntentToken += 1
    nativeLifecycleToken += 1
    invalidatePlayAttempt()
    recoveryToken += 1
    if (recoveryAttempt) recoveryAttempt.cancelled = true
    for (const waiter of lifecycleReadyWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    lifecycleReadyWaiters.clear()
    unsubscribeStretchRenderState()
    removeAudioLifecycle?.()
    clearRebuildHostLoss()
    cancelRaf()
    const destroy = pendingNativeDispose.then(() => nativePlayback.destroy())
    pendingNativeDispose = destroy.catch(() => undefined)
    void destroy.catch(() => undefined)
    if (!requiresNativeAudio) disposePortableBrowserPlayback()
    setActiveBackend('idle')
  })

  return {
    schedulerDiagnostics: nativePlayback.schedulerDiagnostics,
    isPlaying: () => isPlaying() || isRebuildingPlayback(),
    isPlayPending,
    isStructuralRebuildInProgress: () => rebuildInProgress,
    isPreparingPlayback: () => (playAttempt !== undefined && !isPlaying())
      || nativePlayback.getPendingStart() !== undefined
      || portableBrowserPlayback.isPreparing(),
    isNativePlaybackPreparationPending: () => nativePlayback.getPendingStart()?.mode === "preview",
    awaitPlaybackPreparation: async () => {
      // Instrument-ready notifications can be produced by the compile being
      // awaited here. They enqueue this continuation, never await it themselves.
      // Follow successor promises by completion, without timers or polling.
      const cancellation = Promise.withResolvers<void>()
      let cancelled = false
      const cancel = () => {
        cancelled = true
        cancellation.resolve()
      }
      playbackPreparationWaiters.add(cancel)
      try {
        let pending = rebuildPromise ?? playAttempt?.promise ?? nativePlayback.getPendingStart()?.promise
        while (pending && !cancelled) {
          await Promise.race([pending, cancellation.promise])
          pending = rebuildPromise ?? playAttempt?.promise ?? nativePlayback.getPendingStart()?.promise
        }
      } finally {
        playbackPreparationWaiters.delete(cancel)
      }
    },
    isNativePlayback: nativePlayback.isActive,
    isNativePlaybackPrepared: nativePlayback.isPrepared,
    preparedInstrumentIdentity: (targetId: string) => nativePlayback.isPrepared()
      ? nativePlayback.preparedInstrumentIdentity(targetId)
      : portableBrowserPlayback.isPrepared()
        ? portableBrowserPlayback.preparedInstrumentIdentity(targetId)
        : undefined,
    preparedInstrument: (targetId: string) => nativePlayback.isPrepared()
      ? nativePlayback.preparedInstrument(targetId)
      : portableBrowserPlayback.preparedInstrument(targetId),
    rememberInstrumentParameters: (targetId: string, instrument: TrackInstrumentParams) => {
      if (!nativePlayback.isPrepared()) portableBrowserPlayback.rememberInstrumentParameters(targetId, instrument)
    },
    deliverProcessor: nativePlayback.deliverProcessor,
    joinPublication: nativePlayback.joinPublication,
    liveProcessorControl: () => portableBrowserPlayback.isPrepared() || portableBrowserPlayback.isPreparing()
      ? portableBrowserPlayback.liveProcessorControl : undefined,
    reenableProcessorAutomation: (instanceId: string, parameterIds: readonly string[]) => {
      if (nativePlayback.isPrepared()) {
        return nativePlayback.reenableProcessorAutomation(instanceId, parameterIds)
      }
      if (portableBrowserPlayback.isPrepared()) {
        return portableBrowserPlayback.reenableProcessorAutomation(instanceId, parameterIds)
      }
      return Promise.resolve(rejectedLiveProcessorControl("unavailable"))
    },
    isPortableBrowserPlayback: portableBrowserPlayback.isActive,
    isPortableBrowserPlaybackPrepared: portableBrowserPlayback.isPrepared,
    usesLegacyAudioEngine: () => !requiresNativeAudio
      && !nativePlayback.isPrepared()
      && !portableBrowserPlayback.isPrepared(),
    backendDiagnostics: () => ({
      ...audioBackendRolloutPolicy,
      activeBackend: activeBackend(),
      requestedNative: nativeOptions?.enabled?.() ?? false,
      portableBrowserConfigured: portableBrowserOptions !== undefined,
    }),
    portableRecording: {
      start: portableBrowserPlayback.startRecording,
      // An edit the take held (requestTimelineSchedule) is followed once the take ends with the transport playing.
      stop: () => portableBrowserPlayback.stopRecording().finally(followPortableEdits),
      cancel: () => portableBrowserPlayback.cancelRecording().finally(followPortableEdits),
      isActive: portableBrowserPlayback.isActive,
    },
    nativeRecording: {
      start: nativePlayback.startRecording,
      stop: nativePlayback.stopRecording,
      cancel: nativePlayback.cancelRecording,
      isActive: nativePlayback.isActive,
      sampleRate: nativePlayback.sampleRate,
    },
    nativeLiveMidi: {
      isActive: () => audioLifecycleState() === "ready" && nativePlayback.canProcessLiveMidi(),
      isAvailable: () => audioLifecycleState() === "ready"
        && (nativeOptions?.enabled?.() ?? false)
        && nativePlayback.isAvailable(),
      start: (note: Parameters<typeof nativePlayback.startLiveMidiNote>[0]) => (
        nativePlayback.startLiveMidiNote({
          ...note,
          playheadSec: playheadSec(),
        })
      ),
      stop: nativePlayback.releaseLiveMidiNote,
      subscribeReset: nativePlayback.subscribeNativeLiveMidiReset,
    },
    subscribeTrackLevels,
    subscribeMasterLevels,
    subscribeSpectrum,
    playheadSec,
    handlePlay,
    handlePause,
    handleStop,
    updateNativeLoop,
    setPlayhead,
    rescheduleChangedClips: rescheduleAndTrackDeferred,
    restartTimelineSchedule,
    disposePreparedBackends,
  }
}