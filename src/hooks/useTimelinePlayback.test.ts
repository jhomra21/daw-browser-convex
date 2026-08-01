import { describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'

import { useTimelinePlayback } from './useTimelinePlayback'
import type { DeferredStretchWindow } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { compileLivePlaybackSnapshot } from '~/lib/live-playback-snapshot'
import type { NativeScheduleProgress } from '@daw-browser/audio-engine/native-host-wire'

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

const flushMicrotasks = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

const createNativeHookBridge = (failure?: string) => {
  const calls: string[] = []
  const reply = (name: string) => async () => {
    calls.push(name)
    if (name === failure) return { ok: false as const, error: 'failed' }
    return { ok: true as const }
  }
  let progressListener = (_progress: NativeScheduleProgress) => {}
  let lossListener = () => {}
  let progressSequence = 0n
  const deviceId: `coreaudio:${string}` = 'coreaudio:default'
  return {
    calls,
    emitLoss: () => lossListener(),
    audioHost: {
      resolveOutputDevice: async () => ({
        ok: true as const,
        device: {
          deviceId,
          name: 'Default',
          nominalSampleRateHz: 48_000,
          outputChannelCount: 2,
          maximumFramesPerBlock: 512,
          available: true,
        },
      }),
      resolveInputDevice: async () => ({ ok: true as const, device: null }),
      session: {
        configure: reply('configure'),
        beginTransaction: reply('begin'),
        commitTransaction: reply('commit'),
        rollbackTransaction: reply('rollback'),
        installAsset: reply('install'),
        releaseAsset: reply('release'),
        publishGraph: reply('graph'),
        queueParameterEvents: reply('parameter'),
        queueInstrumentEvents: reply('instrument'),
        queueSourceEvents: reply('source'),
        queueScheduleWindow: reply('schedule'),
        setTransport: async (transport: { epoch: number; frame: number; running: boolean; transitionId?: bigint }) => {
          calls.push('transport')
          progressSequence += 1n
          queueMicrotask(() => progressListener({
            revision: 1,
            epoch: transport.epoch,
            progressSequence,
            renderedThroughFrame: BigInt(transport.frame),
            acceptedThroughFrame: BigInt(transport.frame + 1),
            lastAcceptedWindowId: 1n,
            appliedTransportTransitionId: transport.transitionId ?? progressSequence,
            appliedUrgentSequence: 0n,
            running: transport.running,
            scheduleComplete: true,
            instrumentCredits: 256,
            sourceCredits: 256,
            automationCredits: 256,
          }))
          return { ok: true as const }
        },
        configureRecording: reply('recording-configure'),
        startRecording: reply('recording-start'),
        stopRecording: reply('recording-stop'),
        cancelRecording: reply('recording-cancel'),
        start: reply('start'),
        stop: reply('stop'),
        teardown: reply('teardown'),
        onLoss: (listener: () => void) => {
          lossListener = listener
          return () => { lossListener = () => {} }
        },
        onRecordingBlock: () => () => {},
        onRecordingStatus: () => () => {},
        onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
          progressListener = listener
          return () => { progressListener = () => {} }
        },
      },
    },
  }
}

const createFakeEngine = (deferredWindow: DeferredStretchWindow) => {
  let currentTimelineSec = 0
  let stretchListener = () => {}
  const scheduleCalls: ScheduleCall[] = []
  const transportEvents: string[] = []
  const engine = {
    get currentTimelineSec() {
      return currentTimelineSec
    },
    ensureAudio: () => {},
    applyAutomationAtTimelineSec: () => {},
    cancelAutomationSchedules: () => {
      transportEvents.push('cancelAutomationSchedules')
    },
    onTransportPause: () => {},
    onTransportSeek: () => {
      transportEvents.push('onTransportSeek')
    },
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
    scheduleAutomationFromPlayhead: () => {},
    stopAllSources: () => {},
    subscribeStretchRenderState: (listener) => {
      stretchListener = listener
      return () => true
    },
  } satisfies Parameters<typeof useTimelinePlayback>[0]

  return {
    engine,
    scheduleCalls,
    transportEvents,
    setCurrentTimelineSec: (sec: number) => {
      currentTimelineSec = sec
    },
    notifyStretchReady: () => stretchListener(),
  }
}

describe('useTimelinePlayback deferred stretch retries', () => {
  test('playing seek cancels automation before updating transport seek', async () => {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.transportEvents.length = 0
        playback.setPlayhead(4, [track])

        expect(fake.transportEvents).toEqual(['cancelAutomationSchedules', 'onTransportSeek'])
        dispose()
      })
    })
  })

  test('paused seek updates the transport epoch before applying destination automation', async () => {
    const transportEvents: string[] = []
    const engine = {
      ...createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 }).engine,
      onTransportSeek: () => transportEvents.push('onTransportSeek'),
      applyAutomationAtTimelineSec: () => transportEvents.push('applyAutomationAtTimelineSec'),
    }
    await createRoot((dispose) => {
      const playback = useTimelinePlayback(engine)
      playback.setPlayhead(4, [track])
      expect(transportEvents).toEqual(['onTransportSeek', 'applyAutomationAtTimelineSec'])
      dispose()
    })
  })

  test('loop wrap cancels automation before updating transport seek', async () => {
    await withFakeRaf(async (flushRaf) => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, {
          loopEnabled: () => true,
          loopStartSec: () => 2,
          loopEndSec: () => 6,
          getTracks: () => [track],
        })
        await playback.handlePlay([track])

        fake.transportEvents.length = 0
        fake.setCurrentTimelineSec(6.1)
        flushRaf()

        expect(fake.transportEvents).toEqual(['cancelAutomationSchedules', 'onTransportSeek'])
        dispose()
      })
    })
  })

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

  test('restarts active playback from the current transport position', async () => {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])
        fake.setCurrentTimelineSec(4)
        fake.transportEvents.length = 0

        playback.restartTimelineSchedule([track])

        expect(fake.transportEvents).toEqual(['cancelAutomationSchedules', 'onTransportSeek'])
        expect(fake.scheduleCalls.at(-1)?.playheadSec).toBe(4)
        dispose()
      })
    })
  })

  test('live reschedule clears stale deferred stretch windows when a clip no longer needs stretching', async () => {
    await withFakeRaf(async () => {
      let currentTimelineSec = 0
      let stretchListener = () => {}
      const scheduleCalls: ScheduleCall[] = []
      const engine = {
        get currentTimelineSec() {
          return currentTimelineSec
        },
        ensureAudio: () => {},
        applyAutomationAtTimelineSec: () => {},
        cancelAutomationSchedules: () => {},
        onTransportPause: () => {},
        onTransportSeek: () => {},
        onTransportStart: () => {},
        onTransportStop: () => {},
        resume: async () => {},
        rescheduleClipsAtPlayhead: (_tracks, playheadSec, clipIds, opts) => {
          scheduleCalls.push({ playheadSec, opts: { ...opts, clipIds } })
          return { deferredStretchWindows: [] }
        },
        scheduleAllClipsFromPlayhead: (_tracks, playheadSec, opts) => {
          scheduleCalls.push({ playheadSec, opts })
          return scheduleCalls.length === 1
            ? { deferredStretchWindows: [{ clipId: 'clip-1', startSec: 12, endSec: 16 }] }
            : { deferredStretchWindows: [] }
        },
        scheduleAutomationFromPlayhead: () => {},
        stopAllSources: () => {},
        subscribeStretchRenderState: (listener) => {
          stretchListener = listener
          return () => true
        },
      } satisfies Parameters<typeof useTimelinePlayback>[0]

      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine)
        await playback.handlePlay([track])

        currentTimelineSec = 10
        playback.rescheduleChangedClips([track], 10, ['clip-1'], { endLimitSec: 16 })
        stretchListener()

        expect(scheduleCalls).toHaveLength(2)
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
        applyAutomationAtTimelineSec: () => {},
        cancelAutomationSchedules: () => {},
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
        scheduleAutomationFromPlayhead: () => {},
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

test('does not prepare native audio when disabled and keeps browser playback available', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      let webEnsures = 0
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        ensureAudio: () => { webEnsures += 1 },
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => false,
          projectGeneration: () => 1,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })

        expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(0)
        expect(playback.nativeLiveMidi.isAvailable()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        await playback.handlePlay([track])
        expect(webEnsures).toBe(1)
        expect(playback.isPlaying()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('suppresses native faults while preparing an idle preview', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge('begin')
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(engine, undefined, {
        enabled: () => true,
        compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
          revision: 1,
          bpm: 120,
          transport,
          tracks: [track],
          renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
          sidechainRoutes: [],
        }),
        reportFault: (message) => faults.push(message),
      })

      playback.nativeLiveMidi.start({ trackId: 'track-1', pitch: 60, velocity: 0.5 })
      await flushMicrotasks()
      expect(fixture.calls).toContain('begin')
      expect(faults).toEqual([])
      expect(playback.backendDiagnostics().activeBackend).toBe('idle')
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('reports native faults and stops active playback', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
          reportFault: (message) => faults.push(message),
        })

        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()

        fixture.emitLoss()
        await flushMicrotasks()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe('idle')
        expect(faults).toEqual(['Native playback host connection was lost.'])
        expect(fixture.calls).toContain('stop')
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('uses the committed native backend without scheduling Web Audio', async () => {
  const previousWindow = globalThis.window
  const calls: string[] = []
  const reply = (name: string) => async () => {
    calls.push(name)
    return { ok: true as const }
  }
  let progressListener = (_progress: NativeScheduleProgress) => {}
  let progressSequence = 0n
  const deviceId: `coreaudio:${string}` = 'coreaudio:default'
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dawDesktop: {
        audioHost: {
          resolveOutputDevice: async () => ({
            ok: true,
            device: {
              deviceId,
              name: 'Default',
              nominalSampleRateHz: 48_000,
              outputChannelCount: 2,
              maximumFramesPerBlock: 512,
              available: true,
            },
          }),
          session: {
            configure: reply('configure'),
            beginTransaction: reply('begin'),
            commitTransaction: reply('commit'),
            rollbackTransaction: reply('rollback'),
            installAsset: reply('install'),
            releaseAsset: reply('release'),
            publishGraph: reply('graph'),
            queueParameterEvents: reply('parameter'),
            queueInstrumentEvents: reply('instrument'),
            queueSourceEvents: reply('source'),
            queueScheduleWindow: reply('schedule'),
            reenableVstScheduleAutomation: reply('automation-enable'),
            setTransport: async (transport: { epoch: number; frame: number; running: boolean; transitionId?: bigint }) => {
              calls.push('transport')
              progressSequence += 1n
              queueMicrotask(() => progressListener({
                revision: 1,
                epoch: transport.epoch,
                progressSequence,
                renderedThroughFrame: BigInt(transport.frame),
                acceptedThroughFrame: BigInt(transport.frame + 1),
                lastAcceptedWindowId: 1n,
                appliedTransportTransitionId: transport.transitionId ?? progressSequence,
                appliedUrgentSequence: 0n,
                running: transport.running,
                scheduleComplete: true,
                instrumentCredits: 256,
                sourceCredits: 256,
                automationCredits: 256,
              }))
              return { ok: true as const }
            },
            start: reply('start'),
            stop: reply('stop'),
            teardown: reply('teardown'),
            onLoss: () => () => {},
            onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
              progressListener = listener
              return () => { progressListener = () => {} }
            },
          },
        },
      },
    },
  })
  try {
    await withFakeRaf(async () => {
      let nativeEnabled = true
      let webSchedules = 0
      let webEnsures = 0
      const engine = {
        ...createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine,
        ensureAudio: () => { webEnsures += 1 },
        scheduleAllClipsFromPlayhead: () => {
          webSchedules += 1
          return { deferredStretchWindows: [] }
        },
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => nativeEnabled,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })
        await playback.handlePlay([track])
        expect(webEnsures).toBe(0)
        expect(webSchedules).toBe(0)
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.nativeLiveMidi.isAvailable()).toBeTrue()
        const initialCalls = [...calls]
        await playback.restartTimelineSchedule([track], { rebuildBackend: true })
        expect(playback.backendDiagnostics().activeBackend).toBe('native')
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
        expect(calls.filter((call) => call === 'graph')).toHaveLength(2)
        expect(calls.slice(0, initialCalls.length)).toEqual(initialCalls)
        expect(playback.backendDiagnostics()).toEqual({
          version: 1,
          defaultBackend: 'legacy',
          selection: 'startup-only',
          runtimeFailure: 'stop-and-mute',
          portableBrowserRequiresOptIn: true,
          nativeRequiresOptIn: true,
          activeBackend: 'native',
          requestedNative: true,
          requestedPortableBrowser: false,
        })
        await playback.handlePlay([track])
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
        await playback.handlePause()
        expect(playback.backendDiagnostics().activeBackend).toBe('idle')
        expect(playback.nativeLiveMidi.isActive()).toBeTrue()
        nativeEnabled = false
        expect(playback.nativeLiveMidi.isAvailable()).toBeFalse()
        await playback.handlePlay([track])
        expect(playback.backendDiagnostics().activeBackend).toBe('native')
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
        expect(calls.filter((call) => call === 'start')).toHaveLength(2)
        expect(calls).not.toContain('release')
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('preserves a prepared native preview across an idle seek', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const transportEvents: string[] = []
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        applyAutomationAtTimelineSec: () => transportEvents.push('applyAutomationAtTimelineSec'),
        cancelAutomationSchedules: () => transportEvents.push('cancelAutomationSchedules'),
        onTransportSeek: () => transportEvents.push('onTransportSeek'),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })

        await playback.handlePlay([track])
        await playback.handlePause()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        const beforeCounts = {
          begin: fixture.calls.filter((call) => call === 'begin').length,
          release: fixture.calls.filter((call) => call === 'release').length,
          stop: fixture.calls.filter((call) => call === 'stop').length,
          teardown: fixture.calls.filter((call) => call === 'teardown').length,
        }

        transportEvents.length = 0
        playback.setPlayhead(4, [track])
        await flushMicrotasks()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.nativeLiveMidi.isAvailable()).toBeTrue()
        expect(transportEvents).toEqual([
          'cancelAutomationSchedules',
          'onTransportSeek',
          'applyAutomationAtTimelineSec',
        ])
        expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(beforeCounts.begin)
        expect(fixture.calls.filter((call) => call === 'release')).toHaveLength(beforeCounts.release)
        expect(fixture.calls.filter((call) => call === 'stop')).toHaveLength(beforeCounts.stop)
        expect(fixture.calls.filter((call) => call === 'teardown')).toHaveLength(beforeCounts.teardown)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('rebuilds a prepared native backend before the next play', async () => {
  const previousWindow = globalThis.window
  const calls: string[] = []
  const reply = (name: string): (() => Promise<{ ok: true }>) => async () => {
    calls.push(name)
    return { ok: true }
  }
  let progressListener = (_progress: NativeScheduleProgress) => {}
  let progressSequence = 0n
  const deviceId: `coreaudio:${string}` = 'coreaudio:default'
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dawDesktop: {
        audioHost: {
          resolveOutputDevice: async () => ({
            ok: true,
            device: {
              deviceId,
              name: 'Default',
              nominalSampleRateHz: 48_000,
              outputChannelCount: 2,
              maximumFramesPerBlock: 512,
              available: true,
            },
          }),
          session: {
            configure: reply('configure'),
            beginTransaction: reply('begin'),
            commitTransaction: reply('commit'),
            rollbackTransaction: reply('rollback'),
            installAsset: reply('install'),
            releaseAsset: reply('release'),
            publishGraph: reply('graph'),
            queueParameterEvents: reply('parameter'),
            queueInstrumentEvents: reply('instrument'),
            queueSourceEvents: reply('source'),
            queueScheduleWindow: reply('schedule'),
            reenableVstScheduleAutomation: reply('automation-enable'),
            setTransport: async (transport: { epoch: number; frame: number; running: boolean; transitionId?: bigint }) => {
              calls.push('transport')
              progressSequence += 1n
              queueMicrotask(() => progressListener({
                revision: 1,
                epoch: transport.epoch,
                progressSequence,
                renderedThroughFrame: BigInt(transport.frame),
                acceptedThroughFrame: BigInt(transport.frame + 1),
                lastAcceptedWindowId: 1n,
                appliedTransportTransitionId: transport.transitionId ?? progressSequence,
                appliedUrgentSequence: 0n,
                running: transport.running,
                scheduleComplete: true,
                instrumentCredits: 256,
                sourceCredits: 256,
                automationCredits: 256,
              }))
              return { ok: true as const }
            },
            start: reply('start'),
            stop: reply('stop'),
            teardown: reply('teardown'),
            onLoss: () => () => {},
            onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
              progressListener = listener
              return () => { progressListener = () => {} }
            },
          },
        },
      },
    },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })

        await playback.handlePlay([track])
        await playback.handlePause()
        expect(playback.backendDiagnostics().activeBackend).toBe('idle')
        expect(calls.filter((call) => call === 'begin')).toHaveLength(1)

        await playback.restartTimelineSchedule([track], { rebuildBackend: true })
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe('idle')
        expect(calls.filter((call) => call === 'begin')).toHaveLength(1)
        expect(calls).toContain('teardown')

        await playback.handlePlay([track])
        expect(playback.backendDiagnostics().activeBackend).toBe('native')
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
        expect(calls.filter((call) => call === 'graph')).toHaveLength(2)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
