import { canFallbackToRepitchStretch, type AudioEngine, type DeferredStretchWindow } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'

type DeferredStretchEngine = Pick<AudioEngine, 'scheduleAllClipsFromPlayhead' | 'rescheduleClipsAtPlayhead'>

export const createDeferredStretch = (audioEngine: DeferredStretchEngine, resolveTracks: () => Track[]) => {
  let deferredStretchWindows: DeferredStretchWindow[] = []
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

  return { deferredStretchQueue, scheduleAndTrackDeferred, rescheduleAndTrackDeferred, retryDeferredStretchWindows }
}
