/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'

import { useTimelinePlayback } from './useTimelinePlayback'
import type { DeferredStretchWindow } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'

type ScheduleCall = {
  playheadSec: number
  opts: Parameters<Parameters<typeof useTimelinePlayback>[0]['scheduleAllClipsFromPlayhead']>[2]
}

const track: Track = {
  id: 'track-1',
  name: 'Track 1',
  volume: 1,
  clips: [],
}

const withFakeRaf = async (run: (flushRaf: () => void) => Promise<void>) => {
  const callbacks: FrameRequestCallback[] = []
  const previousRequest = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (callback) => {
    callbacks.push(callback)
    return callbacks.length
  }
  globalThis.cancelAnimationFrame = () => {}
  try {
    await run(() => {
      const callback = callbacks.shift()
      if (callback) callback(0)
    })
  } finally {
    globalThis.requestAnimationFrame = previousRequest
    globalThis.cancelAnimationFrame = previousCancel
  }
}

const createFakeEngine = (deferredWindow: DeferredStretchWindow) => {
  let currentTimelineSec = 0
  let stretchListener = () => {}
  const scheduleCalls: ScheduleCall[] = []
  const engine = {
    get currentTimelineSec() {
      return currentTimelineSec
    },
    ensureAudio: () => {},
    onTransportPause: () => {},
    onTransportSeek: () => {},
    onTransportStart: () => {},
    onTransportStop: () => {},
    resume: async () => {},
    rescheduleClipsAtPlayhead: (_tracks, playheadSec, clipIds, opts) => {
      scheduleCalls.push({ playheadSec, opts: { ...opts, clipIds } })
      return { deferredStretchWindows: [deferredWindow] }
    },
    scheduleAllClipsFromPlayhead: (_tracks, playheadSec, opts) => {
      scheduleCalls.push({ playheadSec, opts })
      return scheduleCalls.length === 1
        ? { deferredStretchWindows: [deferredWindow] }
        : { deferredStretchWindows: [] }
    },
    stopAllSources: () => {},
    subscribeStretchRenderState: (listener) => {
      stretchListener = listener
      return () => true
    },
  } satisfies Parameters<typeof useTimelinePlayback>[0]

  return {
    engine,
    scheduleCalls,
    setCurrentTimelineSec: (sec: number) => {
      currentTimelineSec = sec
    },
    notifyStretchReady: () => stretchListener(),
  }
}

describe('useTimelinePlayback deferred stretch retries', () => {
  test('RAF does not retry deferred stretch windows before they become imminent', async () => {
    await withFakeRaf(async (flushRaf) => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(10)
        flushRaf()

        expect(fake.scheduleCalls).toHaveLength(1)
        dispose()
      })
    })
  })

  test('stretch readiness retries non-imminent deferred stretch windows', async () => {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(10)
        fake.notifyStretchReady()

        expect(fake.scheduleCalls).toHaveLength(2)
        expect(fake.scheduleCalls[1]).toEqual({
          playheadSec: 10,
          opts: {
            preserveExisting: true,
            startLimitSec: 12,
            endLimitSec: 16,
            clipIds: ['clip-1'],
          },
        })
        dispose()
      })
    })
  })

  test('RAF retries deferred stretch windows once they become imminent', async () => {
    await withFakeRaf(async (flushRaf) => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(11)
        flushRaf()

        expect(fake.scheduleCalls).toHaveLength(2)
        expect(fake.scheduleCalls[1]?.opts?.startLimitSec).toBe(12)
        dispose()
      })
    })
  })

  test('live reschedule tracks deferred stretch windows for readiness retry', async () => {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(10)
        playback.rescheduleChangedClips([track], 10, ['clip-1'], { endLimitSec: 16 })
        fake.notifyStretchReady()

        expect(fake.scheduleCalls.at(-1)).toEqual({
          playheadSec: 10,
          opts: {
            preserveExisting: true,
            startLimitSec: 12,
            endLimitSec: 16,
            clipIds: ['clip-1'],
          },
        })
        dispose()
      })
    })
  })

  test('RAF keeps fallback stretch windows queued for render readiness replacement', async () => {
    await withFakeRaf(async (flushRaf) => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 11, endSec: 15, replaceExistingSource: true })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(11)
        flushRaf()
        fake.notifyStretchReady()

        expect(fake.scheduleCalls).toHaveLength(2)
        expect(fake.scheduleCalls[1]).toEqual({
          playheadSec: 11,
          opts: {
            startLimitSec: 11,
            endLimitSec: 15,
            clipIds: ['clip-1'],
          },
        })
        dispose()
      })
    })
  })

  test('deferred queue upgrades matching windows to replace existing fallback sources', async () => {
    await withFakeRaf(async () => {
      let currentTimelineSec = 0
      let stretchListener = () => {}
      const scheduleCalls: ScheduleCall[] = []
      const engine = {
        get currentTimelineSec() {
          return currentTimelineSec
        },
        ensureAudio: () => {},
        onTransportPause: () => {},
        onTransportSeek: () => {},
        onTransportStart: () => {},
        onTransportStop: () => {},
        resume: async () => {},
        rescheduleClipsAtPlayhead: (_tracks, playheadSec, clipIds, opts) => {
          scheduleCalls.push({ playheadSec, opts: { ...opts, clipIds } })
          return scheduleCalls.length === 2
            ? { deferredStretchWindows: [{ clipId: 'clip-1', startSec: 12, endSec: 16, replaceExistingSource: true }] }
            : { deferredStretchWindows: [] }
        },
        scheduleAllClipsFromPlayhead: (_tracks, playheadSec, opts) => {
          scheduleCalls.push({ playheadSec, opts })
          return { deferredStretchWindows: [{ clipId: 'clip-1', startSec: 12, endSec: 16 }] }
        },
        stopAllSources: () => {},
        subscribeStretchRenderState: (listener) => {
          stretchListener = listener
          return () => true
        },
      } satisfies Parameters<typeof useTimelinePlayback>[0]

      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine)
        await playback.handlePlay([track])

        currentTimelineSec = 11
        playback.rescheduleChangedClips([track], 11, ['clip-1'], { endLimitSec: 16 })
        stretchListener()

        expect(scheduleCalls.at(-1)).toEqual({
          playheadSec: 11,
          opts: {
            startLimitSec: 12,
            endLimitSec: 16,
            clipIds: ['clip-1'],
          },
        })
        dispose()
      })
    })
  })
})
