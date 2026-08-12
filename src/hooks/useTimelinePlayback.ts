import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js'

import { canFallbackToRepitchStretch, LIVE_SCHEDULE_HORIZON_SEC, type AudioEngine, type DeferredStretchWindow, type SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { createNativePlaybackController } from '~/lib/desktop/native-playback-controller'
import { createPortableBrowserPlaybackController } from '~/lib/portable-browser-playback-controller'
import type { LivePlaybackSnapshotCompilation, LivePlaybackTransport } from '~/lib/live-playback-snapshot'
import {
  createDesktopAudioLifecycleReconciler,
  type DesktopAudioLifecycle,
} from '~/lib/desktop-audio-lifecycle'
import { createSpectrumFrameDelivery } from './spectrum-frame-delivery'
import { rejectedLiveProcessorControl } from '~/lib/live-processor-control'

type LoopOptions = {
  loopEnabled?: Accessor<boolean>
  loopStartSec?: Accessor<number>
  loopEndSec?: Accessor<number>
  getTracks?: Accessor<Track[]>
}

type NativePlaybackOptions = {
  requiresNativeAudio?: boolean
  enabled?: Accessor<boolean>
  projectId?: Accessor<string>
  projectGeneration?: Accessor<number>
  compileSnapshot: (transport: LivePlaybackTransport) => Promise<LivePlaybackSnapshotCompilation>
  reportFault?: (message: string) => void
}

type PortableBrowserPlaybackOptions = {
  projectGeneration?: Accessor<number>
  compileSnapshot: (transport: LivePlaybackTransport) => Promise<LivePlaybackSnapshotCompilation>
  reportFault?: (message: string) => void
}

export type TimelinePlaybackRebuildIntent = {
  resumePlayback: boolean
  playheadSec: number
  owner?: 'native' | 'portable-browser'
  projectId?: string
  projectGeneration?: number
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

const readNowMs = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

export function useTimelinePlayback(
  audioEngine: TimelinePlaybackAudioEngine,
  loopOptions?: LoopOptions,
  nativeOptions?: NativePlaybackOptions,
  portableBrowserOptions?: PortableBrowserPlaybackOptions,
) {
  const [isPlaying, setIsPlaying] = createSignal(false)
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

  const audioHostBridge = typeof window === 'undefined' ? undefined : window.dawDesktop?.audioHost
  const requiresNativeAudio = nativeOptions?.requiresNativeAudio === true
  const hasAudioLifecycle = typeof audioHostBridge?.onLifecycle === 'function'
    && typeof audioHostBridge.getLifecycle === 'function'
  const [audioLifecycleState, setAudioLifecycleState] = createSignal<DesktopAudioLifecycle["state"]>(
    hasAudioLifecycle ? "recovering" : "ready",
  )
  let audioLifecycleGeneration = -1
  let recoveryAttempt: {
    generation: number
    token: number
    cancelled: boolean
    promise?: Promise<void>
  } | undefined
  let recoveryToken = 0
  let recoveryRetryPromise: Promise<unknown> | undefined
  let recoveryRetryGeneration: number | undefined
  let mounted = true
  let preparedBackendDisposePromise: Promise<void> | undefined
  let lastNativeFault: string | undefined
  let transportIntentToken = 0
  let rebuildInProgress = false
  let rebuildStartingPlay = false
  let rebuildPromise: Promise<void> | undefined
  let pendingRebuildTracks: Track[] | undefined
  let pendingRebuildIntent: TimelinePlaybackRebuildIntent | undefined
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
  } | undefined
  let playAttemptPhase: {
    token: number
    backend: 'native' | 'fallback'
    state: 'startup' | 'prepared' | 'active'
  } | undefined
  let pendingBackendPause: {
    ownerToken: number
    promise: Promise<void>
  } | undefined
  let backendOwnerToken = 0

  const invalidatePlayAttempt = () => {
    playAttemptToken += 1
    playAttemptPhase = undefined
  }

  const isCurrentPlayAttempt = (token: number) => (
    mounted
    && token === playAttemptToken
    && audioLifecycleState() !== "suspended"
  )

  const nativePlayback = createNativePlaybackController({
    bridge: audioHostBridge,
    getProjectId: nativeOptions?.projectId,
    getProjectGeneration: nativeOptions?.projectGeneration,
    reportUnavailable: import.meta.env.VITE_DESKTOP === "true",
    createBuffer: (channels, frames, sampleRate) => (
      audioEngine.getAudioContext?.()?.createBuffer(channels, frames, sampleRate)
      ?? new AudioBuffer({ numberOfChannels: channels, length: frames, sampleRate })
    ),
    compileSnapshot: nativeOptions?.compileSnapshot ?? (async () => ({
      supported: false,
      reasons: ['Native playback is not configured.'],
    })),
    reportFault: (message) => {
      lastNativeFault = message
      if (portableBrowserPlayback.isActive() && isPlaying()) {
        portableBrowserOptions?.reportFault?.(message)
        return
      }
      setActiveBackend('idle')
      if (!isPlaying()) {
        if (requiresNativeAudio) nativeOptions?.reportFault?.(message)
        return
      }
      setIsPlaying(false)
      cancelRaf()
      nativeOptions?.reportFault?.(message)
    },
  })
  const portableBrowserPlayback = createPortableBrowserPlaybackController({
    compileSnapshot: portableBrowserOptions?.compileSnapshot ?? (async () => ({
      supported: false,
      reasons: ['Portable browser playback is not configured.'],
    })),
    getAudioContext: () => audioEngine.getAudioContext?.() ?? null,
    getProjectGeneration: portableBrowserOptions?.projectGeneration,
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
      nativeOptions?.reportFault?.("Native audio playback stopped because the native graph is no longer active.")
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

  const handlePlay = async (tracks: Track[]) => {
    if (rebuildInProgress && !rebuildStartingPlay && rebuildPromise) {
      await rebuildPromise.catch(() => undefined)
      if (!mounted || audioLifecycleState() === "suspended") {
        reportNativePlaySkip("The structural rebuild finished after playback became unavailable.")
        return
      }
    }
    const requestedProjectGeneration = nativeOptions?.projectGeneration?.()
      ?? portableBrowserOptions?.projectGeneration?.()
    const pendingPause = pendingBackendPause
    if (pendingPause) await pendingPause.promise.catch(() => undefined)
    if (
      requestedProjectGeneration !== undefined
      && requestedProjectGeneration !== (
        nativeOptions?.projectGeneration?.()
        ?? portableBrowserOptions?.projectGeneration?.()
      )
    ) {
      reportNativePlaySkip("The project generation changed before native playback could start.")
      return
    }
    const pendingAttempt = playAttempt
    if (pendingAttempt) {
      if (pendingAttempt.token === playAttemptToken) {
        await pendingAttempt.promise.catch(() => undefined)
        reportNativePlaySkip("A matching native playback start was already in progress.")
        return
      }
      await pendingAttempt.promise.catch(() => undefined)
      const replacementAttempt = playAttempt
      if (replacementAttempt && replacementAttempt.token === playAttemptToken) {
        await replacementAttempt.promise.catch(() => undefined)
        reportNativePlaySkip("A replacement native playback start superseded this request.")
        return
      }
    }

    const token = ++playAttemptToken
    const attempt = (async () => {
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
        && typeof audioHostBridge?.retryRecovery === "function"
        && recoveryRetryGeneration !== audioLifecycleGeneration
        && !recoveryRetryPromise
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
          nativeOptions?.reportFault?.(
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
        await nativePlayback.dispose()
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
      const commitPortableStart = (backend: Extract<ActiveAudioBackend, 'native' | 'portable-browser'>) => {
        backendOwnerToken += 1
        setActiveBackend(backend)
        setIsPlaying(true)
        setLastTracks(tracks)
        lastPublishedPlayheadSec = playheadSec()
        lastPlayheadUiUpdateMs = 0
        if (backend === 'portable-browser') audioEngine.onTransportStart(playheadSec())
        setRafId(requestAnimationFrame(tick))
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
        })
        if (!isCurrentPlayAttempt(token)) {
          reportNativePlaySkip("Native playback start completed after the request was invalidated.")
          await disposePreparedBackends()
          return
        }
        if (nativeStart === 'started') {
          playAttemptPhase = { token, backend: 'native', state: 'active' }
          commitPortableStart('native')
          return
        }
        playAttemptPhase = undefined
        if (requiresNativeAudio) {
          if (lastNativeFault) return
          nativeOptions?.reportFault?.(
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
          await disposePreparedBackends()
          return
        }
        const portableStart = await portableBrowserPlayback.start(transport)
        if (!isCurrentPlayAttempt(token)) {
          await disposePreparedBackends()
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
          await disposePreparedBackends()
          return
        }
        const portableStart = await portableBrowserPlayback.start(transport)
        if (!isCurrentPlayAttempt(token)) {
          await disposePreparedBackends()
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
        })
        if (!isCurrentPlayAttempt(token)) {
          reportNativePlaySkip("Native playback start completed after the request was invalidated.")
          await disposePreparedBackends()
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
        await disposePreparedBackends()
        audioEngine.stopAllSources()
        return
      }
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
      scheduleAndTrackDeferred(tracks, playheadSec(), { endLimitSec: scheduledUntilSec })
      audioEngine.scheduleAutomationFromPlayhead(playheadSec(), {
        horizonSec: scheduledUntilSec - playheadSec(),
        tracks,
      })
      setRafId(requestAnimationFrame(tick))
      playAttemptPhase = { token, backend: 'fallback', state: 'active' }
    })()
    playAttempt = { token, promise: attempt }
    try {
      await attempt
    } finally {
      if (playAttempt?.promise === attempt) playAttempt = undefined
      if (playAttemptPhase?.token === token && !isPlaying()) playAttemptPhase = undefined
    }
  }

  const handlePause = async () => {
    transportIntentToken += 1
    const pendingPause = pendingBackendPause
    if (pendingPause) {
      await pendingPause.promise.catch(() => undefined)
      return
    }
    const hadPendingPlay = playAttempt !== undefined
    invalidatePlayAttempt()
    if (!isPlaying()) {
      if (hadPendingPlay) await disposePreparedBackends()
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

  const handleStop = async () => {
    transportIntentToken += 1
    invalidatePlayAttempt()
    await handlePause()
    await disposePreparedBackends()
    lastPublishedPlayheadSec = 0
    lastPlayheadUiUpdateMs = 0
    setPlayheadSec(0)
    if (!requiresNativeAudio) {
      audioEngine.onTransportStop()
      audioEngine.cancelAutomationSchedules()
      audioEngine.applyAutomationAtTimelineSec(0)
    }
  }

  const prepareLegacyPaused = () => {
    audioEngine.stopAllSources()
    audioEngine.cancelAutomationSchedules()
    deferredStretchQueue.clear()
    setActiveBackend("idle")
  }

  const acknowledgeRecovery = async (generation: number, result: "ready" | "failed") => {
    if (!audioHostBridge || typeof audioHostBridge.completeRecovery !== "function") return true
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
    const attempt: {
      generation: number
      token: number
      cancelled: boolean
      promise?: Promise<void>
    } = { generation: recoveryGeneration, token, cancelled: false }
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
      await disposePreparedBackends()
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
          await disposePreparedBackends()
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
          await disposePreparedBackends()
          return
        }
        prepared = result === "started"
        if (prepared) setActiveBackend("portable-browser")
      }
      if (!prepared && (requiresNativeAudio || nativeOptions?.enabled?.())) {
        const result = await nativePlayback.ensureLivePreview(sec)
        if (!isCurrent()) {
          await disposePreparedBackends()
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
      await disposePreparedBackends()
      if (!isCurrent()) return
      setLifecycleState("failed")
      await acknowledgeRecovery(recoveryGeneration, "failed").catch(() => undefined)
      if (!isCurrent()) return
      lastNativeFault = error instanceof Error ? error.message : "Audio recovery failed."
      nativeOptions?.reportFault?.(lastNativeFault)
    } finally {
      if (recoveryAttempt === attempt) recoveryAttempt = undefined
    }
  }

  const setPlayhead = (sec: number, tracks: Track[]) => {
    publishPlayhead(sec)
    setLastTracks(tracks)
    if (requiresNativeAudio) {
      if (isPlaying()) {
        setIsPlaying(false)
        cancelRaf()
        void nativePlayback.dispose()
        setActiveBackend('idle')
      } else if (nativePlayback.isPrepared()) {
        void nativePlayback.seekPrepared(sec).then((result) => {
          if (result !== "started") {
            nativeOptions?.reportFault?.("The native playback graph could not seek while paused.")
            setActiveBackend("idle")
          } else {
            setActiveBackend("native")
          }
        }).catch((error: unknown) => {
          nativeOptions?.reportFault?.(
            error instanceof Error
              ? error.message
              : "The native playback graph could not seek while paused.",
          )
          setActiveBackend("idle")
        })
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
      }).catch((error: unknown) => {
        portableBrowserOptions?.reportFault?.(
          error instanceof Error ? error.message : 'Playback could not seek while active.',
        )
      })
      return
    }
    if (!isPlaying()) {
      audioEngine.cancelAutomationSchedules()
      audioEngine.onTransportSeek(sec, SCHED_AHEAD_SEC)
      audioEngine.applyAutomationAtTimelineSec(sec)
      return
    }
    if (nativePlayback.isPrepared() || portableBrowserPlayback.isPrepared()) {
      setIsPlaying(false)
      cancelRaf()
      void nativePlayback.dispose()
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
  const disposePreparedBackends = async () => {
    if (preparedBackendDisposePromise) return preparedBackendDisposePromise
    const dispose = (requiresNativeAudio
      ? Promise.allSettled([nativePlayback.dispose()])
      : Promise.allSettled([
        nativePlayback.dispose(),
        Promise.resolve(disposePortableBrowserPlayback()),
      ])).then(() => {
      if (!untrack(isPlaying)) setActiveBackend('idle')
    })
    preparedBackendDisposePromise = dispose
    void dispose.finally(() => {
      if (preparedBackendDisposePromise === dispose) preparedBackendDisposePromise = undefined
    })
    return dispose
  }
  const handleAudioLifecycle = (lifecycle: DesktopAudioLifecycle) => {
    if (!mounted) return
    if (lifecycle.powerGeneration < audioLifecycleGeneration) return
    const lifecycleChanged = lifecycle.powerGeneration !== audioLifecycleGeneration
      || lifecycle.state !== audioLifecycleState()
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
      void disposePreparedBackends()
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
      void disposePreparedBackends()
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
      void nativePlayback.dispose()
      setActiveBackend("idle")
    }
  }
  const removeAudioLifecycle = hasAudioLifecycle
    ? untrack(() => createDesktopAudioLifecycleReconciler(audioHostBridge, handleAudioLifecycle))
    : undefined
  const restartTimelineSchedule = async (
    tracks: Track[],
    options?: {
      rebuildBackend?: boolean
      resumePlayback?: boolean
      playheadSec?: number
      projectId?: string
      projectGeneration?: number
      owner?: 'native' | 'portable-browser'
    },
  ) => {
    if (options?.rebuildBackend) {
      pendingRebuildTracks = tracks
      pendingRebuildTransportIntentToken = transportIntentToken
      const hasExplicitIntent = options.resumePlayback !== undefined
        || options.playheadSec !== undefined
        || options.owner !== undefined
        || options.projectId !== undefined
        || options.projectGeneration !== undefined
      if (hasExplicitIntent) {
        pendingRebuildIntent = {
          resumePlayback: options.resumePlayback === true,
          playheadSec: options.playheadSec ?? lastPublishedPlayheadSec,
          owner: options.owner,
          projectId: options.projectId,
          projectGeneration: options.projectGeneration,
        }
      }
      if (rebuildPromise) return rebuildPromise
      const rebuild = (async () => {
        rebuildInProgress = true
        try {
          if (hasExplicitIntent) await Promise.resolve()
          while (pendingRebuildTracks) {
            const nextTracks = pendingRebuildTracks
            pendingRebuildTracks = undefined
            const nextIntent = pendingRebuildIntent
            pendingRebuildIntent = undefined
            const nextTransportIntentToken = pendingRebuildTransportIntentToken
            pendingRebuildTransportIntentToken = undefined
            await rebuildTimelineBackend(nextTracks, nextIntent, nextTransportIntentToken)
          }
        } finally {
          rebuildInProgress = false
          rebuildStartingPlay = false
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
      void nativePlayback.dispose()
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
  ) => {
    if (requestedTransportIntentToken !== transportIntentToken) return
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
    const pendingPause = pendingBackendPause
    if (pendingPause) await pendingPause.promise.catch(() => undefined)
    const pendingPlay = playAttempt
    const pendingPlayIntent = pendingPlay !== undefined || rebuildStartingPlay
    const resumeIntent = requestedIntent !== undefined
      ? requestedIntent.resumePlayback
      : pendingPlayIntent
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
      await disposePreparedBackends()
    } else if (pendingPreview) {
      await disposePreparedBackends()
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
        await disposePreparedBackends()
      }
      rebuildStartingPlay = true
      await pendingNativeDispose
      await waitForLifecycleReady()
      if (
        intentToken !== transportIntentToken
        || !mounted
        || audioLifecycleState() === "suspended"
        || !isCurrentRequestedProject()
      ) return
      if (requestedOwner === 'native' && !nativePlayback.isPrepared()) {
        const nativePreview = await nativePlayback.ensureLivePreview(
          requestedIntent?.playheadSec ?? lastPublishedPlayheadSec,
        )
        if (
          intentToken !== transportIntentToken
          || !mounted
          || !isCurrentRequestedProject()
        ) return
        if (nativePreview !== 'started') {
          if (requiresNativeAudio) throw new Error("The native playback graph could not be prepared.")
          return
        }
      } else if (requestedOwner === 'portable-browser') {
        await nativePlayback.dispose()
        await pendingNativeDispose
      }
      await handlePlay(tracks)
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
        pausedIntentToken === transportIntentToken
        && mounted
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
          const result = await nativePlayback.ensureLivePreview(sec)
          if (!isCurrentPausedIntent()) {
            await disposePreparedBackends()
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
      if (requestedOwner === 'native' || nativePlayback.isPrepared()) {
        const result = await nativePlayback.rebuildPrepared(sec)
        if (result !== "started") {
          setActiveBackend("idle")
          throw new Error("The prepared native playback graph could not be rebuilt.")
        }
        setActiveBackend("native")
      } else if (pendingPreviewIntent) {
        const result = await nativePlayback.ensureLivePreview(sec)
        if (result !== "started") {
          setActiveBackend("idle")
          throw new Error("The prepared native playback graph could not be rebuilt.")
        }
        setActiveBackend("native")
      } else if (requestedIntent && requiresNativeAudio) {
        const result = await nativePlayback.ensureLivePreview(sec)
        if (result !== "started") {
          setActiveBackend("idle")
          throw new Error("The native playback graph could not be prepared.")
        }
        setActiveBackend("native")
      } else if (!requiresNativeAudio && portableBrowserPlayback.isPrepared()) {
        audioEngine.ensureAudio({ applyCachedTrackGains: false })
        await audioEngine.resume()
        const result = await portableBrowserPlayback.rebuildPrepared(transport)
        if (result !== "started") {
          disposePortableBrowserPlayback()
          await preparePausedCompatibility()
        }
        else setActiveBackend("portable-browser")
      } else if (requestedIntent && portableBrowserOptions) {
        audioEngine.ensureAudio({ applyCachedTrackGains: false })
        await audioEngine.resume()
        const result = await portableBrowserPlayback.ensurePrepared(transport)
        if (result !== "started") {
          disposePortableBrowserPlayback()
          await preparePausedCompatibility()
        }
        else setActiveBackend("portable-browser")
      }
      return
    }
    const sec = requestedIntent?.playheadSec
      ?? (nativePlayback.isActive() || portableBrowserPlayback.isActive()
        ? (nativePlayback.isActive()
          ? nativePlayback.currentPositionSec() ?? lastPublishedPlayheadSec
          : portableBrowserPlayback.currentPositionSec() ?? lastPublishedPlayheadSec)
        : requiresNativeAudio ? lastPublishedPlayheadSec : audioEngine.currentTimelineSec)
    publishPlayhead(sec)
    const intentToken = transportIntentToken
    setIsPlaying(false)
    cancelRaf()
    await disposePreparedBackends()
    await pendingNativeDispose
    await waitForLifecycleReady()
    if (
      intentToken !== transportIntentToken
      || !mounted
      || audioLifecycleState() === "suspended"
      || !isCurrentRequestedProject()
    ) return
    if (requestedOwner === 'native') {
      const nativePreview = await nativePlayback.ensureLivePreview(sec)
      if (
        intentToken !== transportIntentToken
        || !mounted
        || !isCurrentRequestedProject()
      ) return
      if (nativePreview !== 'started') {
        if (requiresNativeAudio) throw new Error("The native playback graph could not be prepared.")
        return
      }
    } else if (requestedOwner === 'portable-browser') {
      await nativePlayback.dispose()
      await pendingNativeDispose
    }
    rebuildStartingPlay = true
    await handlePlay(tracks)
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
  let nativePreviewRequested = false
  let nativePreviewTrackFingerprint: string | undefined
  const bufferFingerprints = new WeakMap<object, number>()
  let nextBufferFingerprint = 1
  const readBufferFingerprint = (buffer: unknown) => {
    if (!buffer || typeof buffer !== "object") return null
    const existing = bufferFingerprints.get(buffer)
    if (existing !== undefined) return existing
    const fingerprint = nextBufferFingerprint++
    bufferFingerprints.set(buffer, fingerprint)
    return fingerprint
  }
  const readNativePreviewTrackFingerprint = () => JSON.stringify(
    (loopOptions?.getTracks?.() ?? []).map((track) => {
      const { clips, ...trackCompilerInputs } = track
      return {
        ...trackCompilerInputs,
        clips: clips.map((clip) => {
          const buffer = "buffer" in clip ? clip.buffer : undefined
          return {
            ...clip,
            buffer: readBufferFingerprint(buffer),
          }
        }),
      }
    }),
  )
  const hasPendingAudioClipHydration = () => (loopOptions?.getTracks?.() ?? []).some((track) =>
    track.clips.some((clip) => (
      !clip.midi
      && Boolean(clip.sourceAssetKey)
      && !("buffer" in clip && clip.buffer)
      && clip.mediaStatus !== "missing"
      && clip.mediaStatus !== "permission-denied"
    )),
  )
  const disposeNativePreview = () => {
    nativeLifecycleToken += 1
    const request = pendingNativeDispose.then(() => nativePlayback.dispose())
    pendingNativeDispose = request.catch(() => undefined)
    return request
  }
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
      transportIntentToken += 1
      pendingRebuildTracks = undefined
      pendingRebuildIntent = undefined
      pendingRebuildTransportIntentToken = undefined
    }
    invalidatePlayAttempt()
    setIsPlaying(false)
    cancelRaf()
    nativePreviewRequested = false
    void disposeNativePreview()
    if (!requiresNativeAudio) disposePortableBrowserPlayback()
    setActiveBackend('idle')
  })

  createEffect(() => {
    const enabled = nativeOptions?.enabled?.() ?? false
    const projectGeneration = nativeOptions?.projectGeneration?.() ?? 0
    const trackFingerprint = readNativePreviewTrackFingerprint()
    const pendingAudioHydration = hasPendingAudioClipHydration()
    const tracksChanged = nativePreviewTrackFingerprint !== undefined
      && trackFingerprint !== nativePreviewTrackFingerprint
    nativePreviewTrackFingerprint = trackFingerprint
    if (tracksChanged && nativePreviewRequested && !isPlaying()) {
      if (!nativePlayback.hasLiveMidiTails()) {
        nativePreviewRequested = false
        void disposeNativePreview()
      }
    }
    if (!enabled || (hasAudioLifecycle && audioLifecycleState() !== "ready")) {
      if (nativePreviewRequested) {
        nativePreviewRequested = false
        void disposeNativePreview()
      }
      return
    }
    if (pendingAudioHydration) {
      if (nativePreviewRequested && !nativePlayback.hasLiveMidiTails()) {
        nativePreviewRequested = false
        void disposeNativePreview()
      }
      return
    }
    nativePreviewRequested = true
    const token = nativeLifecycleToken
    const playhead = untrack(playheadSec)
    void pendingNativeDispose
      .then(() => {
        if (
          token !== nativeLifecycleToken
          || !nativeOptions?.enabled?.()
          || projectGeneration !== (nativeOptions?.projectGeneration?.() ?? 0)
        ) return
        return nativePlayback.ensureLivePreview(playhead)
      })
      .catch(() => undefined)
  })

  onCleanup(() => {
    mounted = false
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
    cancelRaf()
    void disposeNativePreview()
    if (!requiresNativeAudio) disposePortableBrowserPlayback()
    setActiveBackend('idle')
  })

  return {
    isPlaying,
    isNativePlayback: nativePlayback.isActive,
    isNativePlaybackPrepared: nativePlayback.isPrepared,
    queueNativeBuiltInParameterEvents: nativePlayback.queueBuiltInParameterEvents,
    queueNativeBuiltInStatePatch: nativePlayback.queueBuiltInStatePatch,
    liveProcessorControl: () => nativePlayback.isPrepared()
      ? nativePlayback.liveProcessorControl
      : portableBrowserPlayback.isPrepared()
        ? portableBrowserPlayback.liveProcessorControl
        : undefined,
    reenableProcessorAutomation: (instanceId: string, parameterIds: readonly string[]) => {
      if (nativePlayback.isPrepared()) {
        return nativePlayback.reenableProcessorAutomation(instanceId, parameterIds)
      }
      if (portableBrowserPlayback.isPrepared()) {
        return portableBrowserPlayback.reenableProcessorAutomation(instanceId, parameterIds)
      }
      return Promise.resolve(rejectedLiveProcessorControl("unavailable"))
    },
    queueLiveProcessorParameters: (request: { instanceId: string; values: readonly { parameterId: string; value: number }[] }) => {
      const control = nativePlayback.isPrepared()
        ? nativePlayback.liveProcessorControl
        : portableBrowserPlayback.isPrepared()
          ? portableBrowserPlayback.liveProcessorControl
          : undefined
      return control?.preview(request) ?? Promise.resolve(rejectedLiveProcessorControl("unavailable"))
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
      stop: portableBrowserPlayback.stopRecording,
      cancel: portableBrowserPlayback.cancelRecording,
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
    setPlayhead,
    rescheduleChangedClips: rescheduleAndTrackDeferred,
    restartTimelineSchedule,
    disposePreparedBackends,
  }
}