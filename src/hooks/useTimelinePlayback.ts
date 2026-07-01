import { createSignal, onCleanup, type Accessor } from 'solid-js'

import { canFallbackToRepitchStretch, LIVE_SCHEDULE_HORIZON_SEC, type AudioEngine, type DeferredStretchWindow } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'

type LoopOptions = {
  loopEnabled?: Accessor<boolean>
  loopStartSec?: Accessor<number>
  loopEndSec?: Accessor<number>
  getTracks?: Accessor<Track[]>
}

const LOOP_EPS = 1e-3
const PLAYHEAD_UI_UPDATE_INTERVAL_MS = 1000 / 30
const LIVE_SCHEDULE_REFRESH_MARGIN_SEC = 5

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
>

const readNowMs = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

export function useTimelinePlayback(audioEngine: TimelinePlaybackAudioEngine, loopOptions?: LoopOptions) {
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [playheadSec, setPlayheadSec] = createSignal(0)

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
    audioEngine.scheduleAutomationFromPlayhead(wrapped, { horizonSec: scheduledUntilSec - wrapped })
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
    audioEngine.scheduleAutomationFromPlayhead(scheduledUntilSec, { horizonSec: nextEnd - scheduledUntilSec })
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
    audioEngine.ensureAudio({ applyCachedTrackGains: false })
    await audioEngine.resume()
    setIsPlaying(true)
    lastPublishedPlayheadSec = playheadSec()
    lastPlayheadUiUpdateMs = 0
    setLastTracks(tracks)
    deferredStretchQueue.clear()
    audioEngine.onTransportStart(playheadSec())
    audioEngine.onTransportSeek(playheadSec(), SCHED_AHEAD_SEC)
    const { isActive, end } = getLoopParams()
    scheduledUntilSec = getScheduleHorizonEnd(playheadSec(), isActive ? end : undefined)
    scheduleAndTrackDeferred(tracks, playheadSec(), { endLimitSec: scheduledUntilSec })
    audioEngine.scheduleAutomationFromPlayhead(playheadSec(), { horizonSec: scheduledUntilSec - playheadSec() })
    setRafId(requestAnimationFrame(tick))
  }

  const handlePause = () => {
    if (!isPlaying()) return
    const { sec } = resolveCurrentPlayhead()
    publishPlayhead(sec)
    setIsPlaying(false)
    audioEngine.stopAllSources()
    audioEngine.cancelAutomationSchedules()
    deferredStretchQueue.clear()
    audioEngine.onTransportPause()
    cancelRaf()
  }

  const handleStop = () => {
    handlePause()
    lastPublishedPlayheadSec = 0
    lastPlayheadUiUpdateMs = 0
    setPlayheadSec(0)
    audioEngine.onTransportStop()
    audioEngine.applyAutomationAtTimelineSec(0)
  }

  const setPlayhead = (sec: number, tracks: Track[]) => {
    publishPlayhead(sec)
    setLastTracks(tracks)
    if (isPlaying()) {
      // IMPORTANT: Update transport epoch BEFORE scheduling, so MIDI events use the correct mapping
      audioEngine.cancelAutomationSchedules()
      audioEngine.onTransportSeek(sec, SCHED_AHEAD_SEC)
      deferredStretchQueue.clear()
      const { isActive, end } = getLoopParams()
      scheduledUntilSec = getScheduleHorizonEnd(sec, isActive ? end : undefined)
      scheduleAndTrackDeferred(tracks, sec, { endLimitSec: scheduledUntilSec })
      audioEngine.scheduleAutomationFromPlayhead(sec, { horizonSec: scheduledUntilSec - sec })
    } else {
      audioEngine.applyAutomationAtTimelineSec(sec)
    }
  }

  const unsubscribeStretchRenderState = audioEngine.subscribeStretchRenderState(() => {
    if (isPlaying()) retryDeferredStretchWindows(audioEngine.currentTimelineSec, { includeNonImminent: true })
  })

  onCleanup(() => {
    unsubscribeStretchRenderState()
    cancelRaf()
  })

  return {
    isPlaying,
    playheadSec,
    handlePlay,
    handlePause,
    handleStop,
    setPlayhead,
    rescheduleChangedClips: rescheduleAndTrackDeferred,
  }
}