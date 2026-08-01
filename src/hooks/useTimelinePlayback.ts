import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js'

import { canFallbackToRepitchStretch, LIVE_SCHEDULE_HORIZON_SEC, type AudioEngine, type DeferredStretchWindow, type SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { createNativePlaybackController } from '~/lib/desktop/native-playback-controller'
import { createPortableBrowserPlaybackController } from '~/lib/portable-browser-playback-controller'
import type { LivePlaybackSnapshotCompilation, LivePlaybackTransport } from '~/lib/live-playback-snapshot'

type LoopOptions = {
  loopEnabled?: Accessor<boolean>
  loopStartSec?: Accessor<number>
  loopEndSec?: Accessor<number>
  getTracks?: Accessor<Track[]>
}

type NativePlaybackOptions = {
  enabled?: Accessor<boolean>
  projectId?: Accessor<string>
  projectGeneration?: Accessor<number>
  compileSnapshot: (transport: LivePlaybackTransport) => Promise<LivePlaybackSnapshotCompilation>
  reportFault?: (message: string) => void
}

type PortableBrowserPlaybackOptions = {
  enabled?: Accessor<boolean>
  projectGeneration?: Accessor<number>
  compileSnapshot: (transport: LivePlaybackTransport) => Promise<LivePlaybackSnapshotCompilation>
  reportFault?: (message: string) => void
}

const LOOP_EPS = 1e-3
const PLAYHEAD_UI_UPDATE_INTERVAL_MS = 1000 / 30
const LIVE_SCHEDULE_REFRESH_MARGIN_SEC = 5

const audioBackendRolloutPolicy = {
  version: 1,
  defaultBackend: 'legacy',
  selection: 'startup-only',
  runtimeFailure: 'stop-and-mute',
  portableBrowserRequiresOptIn: true,
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
  let nativeStartedAtMs = 0
  let nativeStartedAtSec = 0
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

  const nativePlayback = createNativePlaybackController({
    bridge: typeof window === 'undefined' ? undefined : window.dawDesktop?.audioHost,
    getProjectId: nativeOptions?.projectId,
    getProjectGeneration: nativeOptions?.projectGeneration,
    compileSnapshot: nativeOptions?.compileSnapshot ?? (async () => ({
      supported: false,
      reasons: ['Native playback is not configured.'],
    })),
    reportFault: (message) => {
      setActiveBackend('idle')
      if (!isPlaying()) return
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
      setActiveBackend('idle')
      if (!isPlaying()) return
      setIsPlaying(false)
      cancelRaf()
      portableBrowserOptions?.reportFault?.(message)
    },
  })

  const subscribeTrackLevels = (listener: Parameters<AudioEngine["subscribeTrackStereoLevels"]>[0]) => {
    const unsubscribeNative = nativePlayback.subscribeTrackMeters((levels) => {
      if (nativePlayback.isPrepared()) listener(levels)
    })
    const unsubscribeBrowser = audioEngine.subscribeTrackStereoLevels?.((levels) => {
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
    const unsubscribeBrowser = audioEngine.subscribeMasterStereoLevels?.((levels) => {
      if (!nativePlayback.isPrepared()) listener(levels)
    }) ?? (() => undefined)
    return () => {
      unsubscribeNative()
      unsubscribeBrowser()
    }
  }

  const subscribeSpectrum = (targetId: string, listener: (frame: SpectrumFrame | null) => void) => {
    let browserFrame: number | undefined
    let released = false
    const sampleBrowser = () => {
      if (released || nativePlayback.isPrepared()) return
      try {
        listener(targetId === "master"
          ? audioEngine.getMasterSpectrum?.() ?? null
          : audioEngine.getTrackSpectrum?.(targetId) ?? null)
      } catch {
        listener(null)
      }
      if (!released && !nativePlayback.isPrepared()) browserFrame = requestAnimationFrame(sampleBrowser)
    }
    const unsubscribeNative = nativePlayback.subscribeSpectrum(targetId, (frame) => {
      if (released) return
      if (nativePlayback.isPrepared() && frame) {
        if (browserFrame !== undefined) cancelAnimationFrame(browserFrame)
        browserFrame = undefined
        listener(frame)
        return
      }
      if (!nativePlayback.isPrepared()) sampleBrowser()
    })
    if (!nativePlayback.isPrepared()) sampleBrowser()
    return () => {
      released = true
      unsubscribeNative()
      if (browserFrame !== undefined) cancelAnimationFrame(browserFrame)
    }
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
      const sec = nativeStartedAtSec + (readNowMs() - nativeStartedAtMs) / 1000
      const nowMs = readNowMs()
      if (
        nowMs - lastPlayheadUiUpdateMs >= PLAYHEAD_UI_UPDATE_INTERVAL_MS
        || Math.abs(sec - lastPublishedPlayheadSec) >= 0.25
      ) publishPlayhead(sec)
      setRafId(requestAnimationFrame(tick))
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

  const handlePlay = async (tracks: Track[]) => {
    // Backend selection is a startup-only rollout decision. Preference changes
    // cannot replace an active playback or recording backend in place.
    if (isPlaying() || nativePlayback.isRecording() || portableBrowserPlayback.isRecording()) return
    const { isActive, start, end } = getLoopParams()
    const transport = {
      state: 'playing' as const,
      playheadSec: playheadSec(),
      loopEnabled: isActive,
      loopStartSec: start,
      loopEndSec: end,
    }
    const commitPortableStart = (backend: Extract<ActiveAudioBackend, 'native' | 'portable-browser'>) => {
      setActiveBackend(backend)
      setIsPlaying(true)
      setLastTracks(tracks)
      nativeStartedAtSec = playheadSec()
      nativeStartedAtMs = readNowMs()
      lastPublishedPlayheadSec = nativeStartedAtSec
      lastPlayheadUiUpdateMs = 0
      setRafId(requestAnimationFrame(tick))
    }
    const resumeNative = nativePlayback.isPrepared()
    if (resumeNative || nativeOptions?.enabled?.()) {
      const nativeStart = await nativePlayback.start({
        ...transport,
      })
      if (nativeStart === 'started') {
        commitPortableStart('native')
        return
      }
      if (nativeStart === 'blocked') return
      if (resumeNative) return
    }
    const resumePortableBrowser = portableBrowserPlayback.isPrepared()
    if (resumePortableBrowser || portableBrowserOptions?.enabled?.()) {
      // Creating/resuming the browser context emits no legacy sources. It is
      // required before a portable AudioWorklet can be selected and prepared.
      audioEngine.ensureAudio({ applyCachedTrackGains: false })
      await audioEngine.resume()
      const portableStart = await portableBrowserPlayback.start(transport)
      if (portableStart === 'started') {
        commitPortableStart('portable-browser')
        return
      }
      if (resumePortableBrowser) return
    }
    audioEngine.ensureAudio({ applyCachedTrackGains: false })
    await audioEngine.resume()
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
  }

  const handlePause = async () => {
    if (!isPlaying()) return
    if (nativePlayback.isActive() || portableBrowserPlayback.isActive()) {
      const sec = nativeStartedAtSec + (readNowMs() - nativeStartedAtMs) / 1000
      publishPlayhead(sec)
      setIsPlaying(false)
      cancelRaf()
      await Promise.allSettled([
        nativePlayback.pause(sec),
        portableBrowserPlayback.pause(sec),
      ])
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
    await handlePause()
    await nativePlayback.dispose()
    portableBrowserPlayback.dispose()
    lastPublishedPlayheadSec = 0
    lastPlayheadUiUpdateMs = 0
    setPlayheadSec(0)
    audioEngine.onTransportStop()
    audioEngine.cancelAutomationSchedules()
    audioEngine.applyAutomationAtTimelineSec(0)
  }

  const setPlayhead = (sec: number, tracks: Track[]) => {
    publishPlayhead(sec)
    setLastTracks(tracks)
    if (nativePlayback.isPrepared() || portableBrowserPlayback.isPrepared()) {
      setIsPlaying(false)
      cancelRaf()
      void nativePlayback.dispose()
      portableBrowserPlayback.dispose()
      setActiveBackend('idle')
      return
    }
    if (isPlaying()) {
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
    } else {
      audioEngine.cancelAutomationSchedules()
      audioEngine.onTransportSeek(sec, SCHED_AHEAD_SEC)
      audioEngine.applyAutomationAtTimelineSec(sec)
    }
  }
  const disposePreparedBackends = async () => {
    await Promise.allSettled([
      nativePlayback.dispose(),
      Promise.resolve(portableBrowserPlayback.dispose()),
    ])
    setActiveBackend('idle')
  }
  const restartTimelineSchedule = async (
    tracks: Track[],
    options?: { rebuildBackend?: boolean },
  ) => {
    if (options?.rebuildBackend) {
      if (!isPlaying()) {
        await disposePreparedBackends()
        return
      }
      const sec = nativePlayback.isActive() || portableBrowserPlayback.isActive()
        ? nativeStartedAtSec + (readNowMs() - nativeStartedAtMs) / 1000
        : audioEngine.currentTimelineSec
      publishPlayhead(sec)
      setIsPlaying(false)
      cancelRaf()
      await disposePreparedBackends()
      await handlePlay(tracks)
      return
    }
    if (!isPlaying()) return
    if (nativePlayback.isActive() || portableBrowserPlayback.isActive()) {
      setIsPlaying(false)
      cancelRaf()
      void nativePlayback.dispose()
      portableBrowserPlayback.dispose()
      setActiveBackend('idle')
      return
    }
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
  const unsubscribeStretchRenderState = audioEngine.subscribeStretchRenderState(() => {
    untrack(() => {
      if (isPlaying()) retryDeferredStretchWindows(audioEngine.currentTimelineSec, { includeNonImminent: true })
    })
  })

  let mountedProjectGeneration = nativeOptions?.projectGeneration?.()
    ?? portableBrowserOptions?.projectGeneration?.()
    ?? 0
  let nativeLifecycleToken = 0
  let pendingNativeDispose: Promise<void> = Promise.resolve()
  let nativePreviewRequested = false
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
    if (nextGeneration === mountedProjectGeneration) return
    mountedProjectGeneration = nextGeneration
    setIsPlaying(false)
    cancelRaf()
    nativePreviewRequested = false
    void disposeNativePreview()
    portableBrowserPlayback.dispose()
    setActiveBackend('idle')
  })

  createEffect(() => {
    const enabled = nativeOptions?.enabled?.() ?? false
    const projectGeneration = nativeOptions?.projectGeneration?.() ?? 0
    if (!enabled) {
      if (nativePreviewRequested) {
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
    unsubscribeStretchRenderState()
    cancelRaf()
    void disposeNativePreview()
    portableBrowserPlayback.dispose()
    setActiveBackend('idle')
  })

  return {
    isPlaying,
    isNativePlayback: nativePlayback.isActive,
    isNativePlaybackPrepared: nativePlayback.isPrepared,
    isPortableBrowserPlayback: portableBrowserPlayback.isActive,
    backendDiagnostics: () => ({
      ...audioBackendRolloutPolicy,
      activeBackend: activeBackend(),
      requestedNative: nativeOptions?.enabled?.() ?? false,
      requestedPortableBrowser: portableBrowserOptions?.enabled?.() ?? false,
    }),
    portableRecording: {
      start: portableBrowserPlayback.startRecording,
      stop: portableBrowserPlayback.stopRecording,
      cancel: portableBrowserPlayback.cancelRecording,
      isActive: portableBrowserPlayback.isRecording,
    },
    nativeRecording: {
      start: nativePlayback.startRecording,
      stop: nativePlayback.stopRecording,
      cancel: nativePlayback.cancelRecording,
      isActive: nativePlayback.isRecording,
      sampleRate: nativePlayback.sampleRate,
    },
    nativeLiveMidi: {
      isActive: nativePlayback.canProcessLiveMidi,
      isAvailable: () => (nativeOptions?.enabled?.() ?? false) && nativePlayback.isAvailable(),
      start: (note: Parameters<typeof nativePlayback.startLiveMidiNote>[0]) => (
        nativePlayback.startLiveMidiNote({
          ...note,
          playheadSec: playheadSec(),
        })
      ),
      stop: nativePlayback.releaseLiveMidiNote,
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
  }
}