import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createRoot, createSignal } from 'solid-js'
import { isServer } from 'solid-js/web'

import { useTimelinePlayback } from './useTimelinePlayback'
import type { DeferredStretchWindow } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { createDefaultDrumRackParams } from '@daw-browser/shared'
import { compileLivePlaybackSnapshot } from '~/lib/live-playback-snapshot'
import type { NativeScheduleProgress } from '@daw-browser/audio-engine/native-host-wire'
import type { DesktopAudioLifecycle } from '~/lib/desktop-audio-lifecycle'

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

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 4 / 48_000
  readonly length = 4
  readonly numberOfChannels = 1
  readonly sampleRate = 48_000
  private readonly channel = new Float32Array(4)
  copyFromChannel(destination: Float32Array, _channelNumber: number, _bufferOffset?: number) {
    destination.set(this.channel.subarray(0, destination.length))
  }
  copyToChannel(source: Float32Array, _channelNumber: number, _bufferOffset?: number) {
    this.channel.set(source.subarray(0, this.channel.length))
  }
  getChannelData(_channel: number) {
    return this.channel
  }
}

const audioTrack = (buffer: AudioBuffer | null): Track<AudioBuffer> => ({
  id: "track-audio",
  name: "Audio",
  volume: 1,
  clips: [{
    id: "clip-audio",
    name: "Audio clip",
    startSec: 0,
    duration: 1,
    color: "#fff",
    sourceAssetKey: "asset-audio",
    buffer,
  }],
})

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

const withPortableAudioWorklet = async (run: () => Promise<void>) => {
  const previousAudioContext = globalThis.AudioContext
  const previousAudioWorkletNode = globalThis.AudioWorkletNode
  const previousFetch = globalThis.fetch
  const hadAudioContext = "AudioContext" in globalThis
  const hadAudioWorkletNode = "AudioWorkletNode" in globalThis
  class FakeAudioContext {
    readonly sampleRate = 48_000
    readonly destination = {}
    readonly audioWorklet = { addModule: async () => undefined }
  }
  type FakePort = {
    onmessage: ((event: { data: unknown }) => void) | null
    postMessage: (message: Record<string, unknown>) => void
    close: () => void
  }
  class FakeAudioWorkletNode {
    readonly port: FakePort
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message: Record<string, unknown>) => {
          const requestId = message.requestId
          const response = message.type === "initialize"
            ? { version: 1, type: "ready", revision: 1 }
            : message.type === "prepare-graph"
              ? { version: 1, type: "graph-prepared", requestId, revision: message.snapshot && typeof message.snapshot === "object" && "revision" in message.snapshot ? message.snapshot.revision : 1, result: "prepared" }
              : message.type === "publish-graph"
                ? { version: 1, type: "graph-published", requestId, revision: message.revision, result: "published" }
                : message.type === "transport"
                  ? { version: 1, type: "transport-applied", requestId, epoch: message.epoch, result: "applied" }
                  : message.type === "install-schedule"
                    ? { version: 1, type: "schedule-installed", requestId, revision: message.revision, epoch: message.epoch, result: "installed" }
                    : message.type === "schedule-sources"
                      ? { version: 1, type: "sources-scheduled", requestId, revision: message.revision, epoch: message.epoch, result: "scheduled" }
                      : message.type === "register-asset"
                        ? { version: 1, type: "asset-registered", requestId, generation: message.generation, assetId: message.asset && typeof message.asset === "object" && "assetId" in message.asset ? message.asset.assetId : "", result: "registered", handle: { slot: 0, generation: 1 } }
                        : undefined
          if (response) queueMicrotask(() => this.port.onmessage?.({ data: response }))
        },
        close: () => {},
      }
    }
    onprocessorerror: (() => {}) | null = null
    connect = () => {}
    disconnect = () => {}
  }
  const manifest = await readFile(new URL("../../public/audio-core/daw-audio-core.manifest.json", import.meta.url), "utf8")
  const wasm = await readFile(new URL("../../public/audio-core/daw-audio-core.wasm", import.meta.url))
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FakeAudioContext })
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: FakeAudioWorkletNode })
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL) => (
      String(input).endsWith(".manifest.json")
        ? new Response(manifest, { status: 200 })
        : new Response(wasm, { status: 200 })
    ),
  })
  try {
    await run()
  } finally {
    if (hadAudioContext) Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: previousAudioContext })
    else Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: undefined })
    if (hadAudioWorkletNode) Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: previousAudioWorkletNode })
    else Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: undefined })
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch })
  }
}

test('keeps browser startup portable-first and runtime faults stop without fallback', async () => {
  const source = await readFile(new URL('./useTimelinePlayback.ts', import.meta.url), 'utf8')
  const timelineSource = await readFile(new URL('../components/Timeline.tsx', import.meta.url), 'utf8')
  expect(source).toContain("version: 2")
  expect(source).toContain("browserDefaultBackend: 'portable-browser'")
  expect(source).toContain("runtimeFailure: 'stop-and-mute'")
  expect(source).toContain("portableBrowserConfigured: portableBrowserOptions !== undefined")
  const portableStartup = source.indexOf('if (portableBrowserOptions) {')
  const nativeFallback = source.indexOf('if (nativeLifecycleReady && nativeOptions?.enabled?.())', portableStartup)
  const legacyStartup = source.indexOf("setActiveBackend('legacy')", nativeFallback)
  expect(portableStartup).toBeGreaterThan(-1)
  expect(nativeFallback).toBeGreaterThan(portableStartup)
  expect(legacyStartup).toBeGreaterThan(nativeFallback)
  expect(source).toContain('portableBrowserOptions?.reportFault?.(message)')
  expect(source).toContain('isPreparingPlayback: () => (playAttempt !== undefined && !isPlaying())')
  expect(source).toContain('portableBrowserPlayback.isPreparing()')
  expect(timelineSource).toContain('&& !isPreparingPlayback()) return;')
})

const createNativeHookBridge = (
  failure?: string | (() => string | undefined),
  lifecycle?: {
    initial: { state: "suspended" | "recovering" | "ready" | "failed"; powerGeneration: number }
    completeRecovery: (generation: number, result: "ready" | "failed") => Promise<{ accepted: boolean }>
    retryRecovery: () => Promise<{ accepted: boolean }>
  },
  initialBeginGate?: Promise<{ ok: true } | { ok: false; error: string }>,
  transportGate?: Promise<{ ok: true } | { ok: false; error: string }>,
) => {
  const calls: string[] = []
  const transportStates: boolean[] = []
  const transportFrames: number[] = []
  let beginGate = initialBeginGate
  const reply = (name: string) => async () => {
    calls.push(name)
    const failureName = typeof failure === "function" ? failure() : failure
    if (name === failureName) return { ok: false as const, error: 'failed' }
    if (name === "begin" && beginGate) return beginGate
    return { ok: true as const }
  }
  let progressListener = (_progress: NativeScheduleProgress) => {}
  let lossListener = () => {}
  let progressSequence = 0n
  let lifecycleListener: ((value: DesktopAudioLifecycle) => void) | undefined
  let transportGateArmed = false
  const deviceId: `coreaudio:${string}` = 'coreaudio:default'
  return {
    calls,
    transportStates,
    transportFrames,
    emitLoss: () => lossListener(),
    armTransportGate: () => { transportGateArmed = true },
    setBeginGate: (gate: Promise<{ ok: true } | { ok: false; error: string }> | undefined) => {
      beginGate = gate
    },
    emitLifecycle: (value: DesktopAudioLifecycle) => lifecycleListener?.(value),
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
        coordinateVstAttachments: reply('coordinate'),
        queueParameterEvents: reply('parameter'),
        queueInstrumentEvents: reply('instrument'),
        queueSourceEvents: reply('source'),
        queueScheduleWindow: reply('schedule'),
        setTransport: async (transport: { epoch: number; frame: number; running: boolean; transitionId?: bigint }) => {
          calls.push('transport')
          transportStates.push(transport.running)
          transportFrames.push(transport.frame)
          if (
            !transport.running
            && transportGate
            && transportGateArmed
          ) await transportGate
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
  appliedProcessorSequence: 0n,
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
      ...(lifecycle ? {
        getLifecycle: async () => lifecycle.initial,
        completeRecovery: lifecycle.completeRecovery,
        retryRecovery: lifecycle.retryRecovery,
        onLifecycle: (listener: (value: DesktopAudioLifecycle) => void) => {
          lifecycleListener = listener
          return () => { lifecycleListener = undefined }
        },
      } : {}),
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
    onTransportPause: () => {
      transportEvents.push('onTransportPause')
    },
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

const nativeRequiredSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => {
  const result = compileLivePlaybackSnapshot({
    revision: 1,
    bpm: 120,
    transport,
    tracks: [track],
    renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
    sidechainRoutes: [],
  })
  if (!result.supported) return result
  return {
    supported: true as const,
    snapshot: {
      ...result.snapshot,
      nativeExternalAttachmentPlan: { version: 1 as const, attachments: [] },
      requiresNativePlayback: true,
    },
  }
}

test('keeps lifecycle state reactive while limiting it to native backend selection', async () => {
  const source = await readFile(new URL("./useTimelinePlayback.ts", import.meta.url), "utf8")
  expect(source).toContain("const [audioLifecycleState, setAudioLifecycleState] = createSignal")
  expect(source).toContain("audioLifecycleState() === \"ready\"")
  expect(source).toContain("if (lifecycleState === \"suspended\") return")
  expect(source).not.toContain("if (audioLifecycleState === \"failed\")")
})

test('fingerprints all playback-relevant audio clip compiler fields for paused preview', async () => {
  const source = await readFile(new URL("./useTimelinePlayback.ts", import.meta.url), "utf8")
  const fingerprint = source.slice(
    source.indexOf("const readNativePreviewTrackFingerprint"),
    source.indexOf("  const disposeNativePreview", source.indexOf("const readNativePreviewTrackFingerprint")),
  )
  expect(fingerprint).toContain("const { clips, ...trackCompilerInputs } = track")
  expect(fingerprint).toContain("clips.map((clip)")
  expect(fingerprint).toContain("buffer: readBufferFingerprint(buffer)")
  expect(fingerprint).not.toContain("clip.id")
})

test('waits for audio clip hydration before native paused preview and retries after hydration', async () => {
  const previousWindow = globalThis.window
  const [tracks, setTracks] = createSignal([audioTrack(null)])
  const hydratedTrack = audioTrack(new TestAudioBuffer())
  const fixture = createNativeHookBridge()
  const faults: string[] = []
  const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]["transport"]) => (
    compileLivePlaybackSnapshot({
      revision: 1,
      bpm: 120,
      transport,
      tracks: tracks(),
      renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
      sidechainRoutes: [],
    })
  )
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    let dispose = () => {}
    const playback = createRoot((cleanup) => {
      dispose = cleanup
      return useTimelinePlayback(
        createFakeEngine({ clipId: "clip-audio", startSec: 0, endSec: 1 }).engine,
        { getTracks: () => tracks() },
        {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot,
          reportFault: (message) => faults.push(message),
        },
      )
    })
    await flushMicrotasks()
    expect(fixture.calls).not.toContain("begin")
    expect(faults).toEqual([])
    expect(playback.isNativePlaybackPrepared()).toBeFalse()

    if (!isServer) {
      setTracks(() => [hydratedTrack])
      await flushMicrotasks()
      expect(tracks()).toEqual([hydratedTrack])
      expect(fixture.calls).toContain("begin")
      expect(faults).toEqual([])
      expect(playback.isNativePlaybackPrepared()).toBeTrue()
    }
    dispose()
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('reports unhydrated native audio when playback is explicitly requested', async () => {
  const previousWindow = globalThis.window
  const unhydratedTracks = [audioTrack(null)]
  const fixture = createNativeHookBridge()
  const faults: string[] = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(
        createFakeEngine({ clipId: "clip-audio", startSec: 0, endSec: 1 }).engine,
        { getTracks: () => unhydratedTracks },
        {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: unhydratedTracks,
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
          reportFault: (message) => faults.push(message),
        },
      )
      await flushMicrotasks()
      expect(faults).toEqual([])

      await playback.handlePlay(unhydratedTracks)
      expect(fixture.calls).not.toContain("begin")
      expect(faults).toEqual(['Audio clip "clip-audio" is not hydrated.'])
      expect(playback.isPlaying()).toBeFalse()
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

describe('useTimelinePlayback deferred stretch retries', () => {
  test('playing seek cancels automation before updating transport seek', async () => {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await flushMicrotasks()
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
        await flushMicrotasks()
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

test('does not acknowledge stale recovery after suspend or unmount', async () => {
  const previousWindow = globalThis.window
  const gate = Promise.withResolvers<{ ok: true }>()
  const acknowledgements: Array<{ generation: number; result: "ready" | "failed" }> = []
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "suspended", powerGeneration: 1 },
    completeRecovery: async (generation, result) => {
      acknowledgements.push({ generation, result })
      return { accepted: true }
    },
    retryRecovery: async () => ({ accepted: false }),
  }, gate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
      })
      fixture.emitLifecycle({ state: "recovering", powerGeneration: 1 })
      await flushMicrotasks()
      fixture.emitLifecycle({ state: "suspended", powerGeneration: 2 })
      dispose()
      gate.resolve({ ok: true })
      await flushMicrotasks()
      expect(acknowledgements).toEqual([])
      expect(playback.isPlaying()).toBeFalse()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('keeps legacy recovery inert until explicit play', async () => {
  const previousWindow = globalThis.window
  const acknowledgements: Array<{ generation: number; result: "ready" | "failed" }> = []
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "suspended", powerGeneration: 1 },
    completeRecovery: async (generation, result) => {
      acknowledgements.push({ generation, result })
      return { accepted: true }
    },
    retryRecovery: async () => ({ accepted: false }),
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(fake.engine)
      fixture.emitLifecycle({ state: "recovering", powerGeneration: 2 })
      await flushMicrotasks()
      expect(acknowledgements).toEqual([{ generation: 2, result: "ready" }])
      expect(fake.scheduleCalls).toEqual([])
      expect(playback.isPlaying()).toBeFalse()
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('plays through legacy Web Audio while lifecycle is recovering', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "recovering", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: true }),
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        fixture.emitLifecycle({ state: "recovering", powerGeneration: 2 })
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(fixture.calls).not.toContain("begin")
        expect(fake.scheduleCalls.length).toBeGreaterThan(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('plays through legacy Web Audio and retries native recovery while lifecycle is failed', async () => {
  const previousWindow = globalThis.window
  let retries = 0
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      return { accepted: true }
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        fixture.emitLifecycle({ state: "failed", powerGeneration: 1 })
        await flushMicrotasks()
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(retries).toBe(1)
        expect(fixture.calls).not.toContain("begin")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('native-required play retries failed recovery and stays stopped while recovery runs', async () => {
  const previousWindow = globalThis.window
  let retries = 0
  const acknowledgements: Array<{ generation: number; result: "ready" | "failed" }> = []
  const lifecycleEmitter: { emit: (value: DesktopAudioLifecycle) => void } = {
    emit: () => {},
  }
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async (generation, result) => {
      acknowledgements.push({ generation, result })
      return { accepted: true }
    },
    retryRecovery: async () => {
      retries += 1
      lifecycleEmitter.emit({ state: "recovering", powerGeneration: 2 })
      return { accepted: true }
    },
  })
  lifecycleEmitter.emit = fixture.emitLifecycle
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const faults: string[] = []
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
        reportFault: (message) => faults.push(message),
      })
      await flushMicrotasks()
      await playback.handlePlay([track])
      await flushMicrotasks()
      expect(retries).toBe(1)
      expect(playback.isPlaying()).toBeFalse()
      expect(faults).toEqual([])
      expect(acknowledgements).toContainEqual({ generation: 2, result: "ready" })
      expect(playback.isNativePlaybackPrepared()).toBeTrue()
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('native-required play reports rejected recovery and retries it on a later play', async () => {
  const previousWindow = globalThis.window
  let retries = 0
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      return { accepted: false }
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const faults: string[] = []
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
        reportFault: (message) => faults.push(message),
      })
      await flushMicrotasks()
      await playback.handlePlay([track])
      await playback.handlePlay([track])
      expect(retries).toBe(2)
      expect(playback.isPlaying()).toBeFalse()
      expect(faults).toHaveLength(2)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('coalesces concurrent native-required recovery retries', async () => {
  const previousWindow = globalThis.window
  const retryGate = Promise.withResolvers<{ accepted: boolean }>()
  let retries = 0
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      return retryGate.promise
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const faults: string[] = []
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
        reportFault: (message) => faults.push(message),
      })
      await flushMicrotasks()
      const first = playback.handlePlay([track])
      const second = playback.handlePlay([track])
      await flushMicrotasks()
      expect(retries).toBe(1)
      retryGate.resolve({ accepted: false })
      await Promise.all([first, second])
      expect(playback.isPlaying()).toBeFalse()
      expect(faults).toHaveLength(1)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('allows a rejected recovery retry to be attempted again in the same generation', async () => {
  const previousWindow = globalThis.window
  let retries = 0
  let rejectRetry = true
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      if (rejectRetry) {
        rejectRetry = false
        throw new Error("retry failed")
      }
      return { accepted: true }
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await flushMicrotasks()
        await playback.handlePlay([track])
        await flushMicrotasks()
        await playback.handlePause()
        await playback.handlePlay([track])
        await flushMicrotasks()
        expect(retries).toBe(2)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('coalesces concurrent recovery retries', async () => {
  const previousWindow = globalThis.window
  const retryGate = Promise.withResolvers<{ accepted: boolean }>()
  let retries = 0
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      return retryGate.promise
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await flushMicrotasks()
        const first = playback.handlePlay([track])
        const second = playback.handlePlay([track])
        await flushMicrotasks()
        expect(retries).toBe(1)
        retryGate.resolve({ accepted: false })
        await Promise.all([first, second])
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('serializes three rapid play calls into one legacy startup', async () => {
  await withFakeRaf(async () => {
    const resumeGate = Promise.withResolvers<void>()
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    let resumeCalls = 0
    let stopAllSourcesCalls = 0
    const engine = {
      ...fake.engine,
      resume: () => {
        resumeCalls += 1
        return resumeGate.promise
      },
      stopAllSources: () => {
        stopAllSourcesCalls += 1
      },
    }
    await createRoot(async (dispose) => {
      const first = useTimelinePlayback(engine)
      const second = first.handlePlay([track])
      const third = first.handlePlay([track])
      await flushMicrotasks()
      expect(resumeCalls).toBe(1)
      resumeGate.resolve()
      await Promise.all([second, third])
      expect(resumeCalls).toBe(1)
      expect(fake.scheduleCalls).toHaveLength(1)
      expect(stopAllSourcesCalls).toBe(0)
      expect(first.isPlaying()).toBeTrue()
      expect(first.backendDiagnostics().activeBackend).toBe("legacy")
      dispose()
    })
  })
})

test('cancels delayed legacy resume before it schedules playback', async () => {
  await withFakeRaf(async () => {
    const resumeGate = Promise.withResolvers<void>()
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    const engine = {
      ...fake.engine,
      resume: () => resumeGate.promise,
    }
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(engine)
      const play = playback.handlePlay([track])
      await flushMicrotasks()
      await playback.handlePause()
      resumeGate.resolve()
      await play
      expect(playback.isPlaying()).toBeFalse()
      expect(fake.scheduleCalls).toEqual([])
      dispose()
    })
  })
})

test('waits for a cancelled play attempt before starting a fresh play', async () => {
  await withFakeRaf(async () => {
    const resumeGates = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ]
    let resumeCalls = 0
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    const engine = {
      ...fake.engine,
      resume: () => {
        const gate = resumeGates[resumeCalls]
        resumeCalls += 1
        if (!gate) throw new Error("Unexpected extra resume.")
        return gate.promise
      },
    }
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(engine)
      const first = playback.handlePlay([track])
      await flushMicrotasks()
      await playback.handlePause()
      const second = playback.handlePlay([track])
      const third = playback.handlePlay([track])
      await flushMicrotasks()

      expect(resumeCalls).toBe(1)
      resumeGates[0]?.resolve()
      await flushMicrotasks()
      expect(resumeCalls).toBe(2)
      resumeGates[1]?.resolve()
      await Promise.all([first, second, third])

      expect(fake.scheduleCalls).toHaveLength(1)
      expect(playback.isPlaying()).toBeTrue()
      dispose()
    })
  })
})

test('cancels delayed portable resume before it can start the portable backend', async () => {
  await withFakeRaf(async () => {
    const resumeGate = Promise.withResolvers<void>()
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    const engine = {
      ...fake.engine,
      resume: () => resumeGate.promise,
    }
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(
        engine,
        undefined,
        undefined,
        {
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        },
      )
      const play = playback.handlePlay([track])
      await flushMicrotasks()
      await playback.handlePause()
      resumeGate.resolve()
      await play
      expect(playback.isPlaying()).toBeFalse()
      expect(playback.backendDiagnostics().activeBackend).toBe("idle")
      expect(fake.scheduleCalls).toEqual([])
      dispose()
    })
  })
})

test('cancels delayed native startup and disposes the late backend', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  const nativeEnabled = true
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => nativeEnabled,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls).toContain("begin")
        await playback.handlePause()
        beginGate.resolve({ ok: true })
        await play
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe("idle")
        expect(fake.scheduleCalls).toEqual([])
        expect(fixture.calls).toContain("teardown")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('cancels an in-flight native preview before selecting portable playback', async () => {
  await withPortableAudioWorklet(async () => {
    const previousWindow = globalThis.window
    const beginGate = Promise.withResolvers<{ ok: true }>()
    const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { dawDesktop: { audioHost: fixture.audioHost } },
    })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
        const engine = {
          ...fake.engine,
          getAudioContext: () => new AudioContext(),
        }
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(
            engine,
            undefined,
            {
              enabled: () => true,
              projectId: () => "project",
              compileSnapshot: compileSnapshot,
            },
            { compileSnapshot },
          )
          const note = playback.nativeLiveMidi.start({ trackId: track.id, pitch: 60, velocity: 0.5 })
          await flushMicrotasks()
          expect(fixture.calls).toContain("begin")

          const play = playback.handlePlay([track])
          await flushMicrotasks()
          expect(fixture.calls).toContain("stop")
          expect(fixture.calls).toContain("teardown")

          beginGate.resolve({ ok: true })
          await play

          expect(playback.isPlaying()).toBeTrue()
          expect(playback.isPortableBrowserPlayback()).toBeTrue()
          expect(playback.isPortableBrowserPlaybackPrepared()).toBeTrue()
          expect(playback.isNativePlaybackPrepared()).toBeFalse()
          expect(playback.backendDiagnostics().activeBackend).toBe("portable-browser")
          if (note) playback.nativeLiveMidi.stop(note)
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
    }
  })
})

test('rebuilds from the persisted generation when native insertion races delayed startup', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  const [nativeEnabled, setNativeEnabled] = createSignal(false)
  let projectGeneration = 1
  let insertionOrder = ['old']
  const compiled: Array<{ generation: number; order: string[] }> = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: nativeEnabled,
          projectId: () => "project",
          projectGeneration: () => projectGeneration,
          compileSnapshot: async (transport) => {
            compiled.push({ generation: projectGeneration, order: [...insertionOrder] })
            return compileLivePlaybackSnapshot({
              revision: 1,
              bpm: 120,
              transport,
              tracks: [track],
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
              sidechainRoutes: [],
            })
          },
        })
        setNativeEnabled(true)
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)

        insertionOrder = ["new"]
        projectGeneration = 2
        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        await flushMicrotasks()
        expect(playback.isPlaying()).toBeFalse()

        beginGate.resolve({ ok: true })
        await expect(rebuild).resolves.toBeUndefined()
        await play

        expect(compiled.at(-1)).toEqual({ generation: 2, order: ["new"] })
        expect(compiled.some((entry) => entry.generation === 1)).toBeTrue()
        expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("native")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('keeps a paused portable session compatible when enabling a loop', async () => {
  await withPortableAudioWorklet(async () => {
    const [loopEnabled, setLoopEnabled] = createSignal(false)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        getAudioContext: () => new AudioContext(),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          engine,
          {
            loopEnabled,
            loopStartSec: () => 0,
            loopEndSec: () => 2,
            getTracks: () => [track],
          },
          undefined,
          { compileSnapshot },
        )
        await playback.handlePlay([track])
        await playback.handlePause()
        expect(playback.isPortableBrowserPlaybackPrepared()).toBeTrue()

        setLoopEnabled(true)
        await expect(playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: false,
          playheadSec: 0,
        })).resolves.toBeUndefined()

        expect(loopEnabled()).toBeTrue()
        expect(playback.isPortableBrowserPlaybackPrepared()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe("idle")

        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.usesLegacyAudioEngine()).toBeTrue()
        expect(loopEnabled()).toBeTrue()
        dispose()
      })
    })
  })
})

test('rebuilds active portable playback into compatibility playback for a loop', async () => {
  await withPortableAudioWorklet(async () => {
    const [loopEnabled, setLoopEnabled] = createSignal(false)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        getAudioContext: () => new AudioContext(),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          engine,
          {
            loopEnabled,
            loopStartSec: () => 0,
            loopEndSec: () => 2,
            getTracks: () => [track],
          },
          undefined,
          { compileSnapshot },
        )
        await playback.handlePlay([track])
        expect(playback.isPortableBrowserPlayback()).toBeTrue()

        setLoopEnabled(true)
        await expect(playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: true,
          playheadSec: 0,
          owner: "portable-browser",
        })).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeTrue()
        expect(playback.usesLegacyAudioEngine()).toBeTrue()
        expect(loopEnabled()).toBeTrue()
        dispose()
      })
    })
  })
})

test('preserves an explicitly captured native owner across queued generation rebuilds', async () => {
  await withPortableAudioWorklet(async () => {
    const previousWindow = globalThis.window
    const fixture = createNativeHookBridge()
    const [projectGeneration, setProjectGeneration] = createSignal(1)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { dawDesktop: { audioHost: fixture.audioHost } },
    })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
        const engine = {
          ...fake.engine,
          getAudioContext: () => new AudioContext(),
        }
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(
            engine,
            undefined,
            {
              enabled: () => true,
              projectId: () => "project",
              projectGeneration,
              compileSnapshot,
            },
            {
              projectGeneration,
              compileSnapshot,
            },
          )
          await flushMicrotasks()
          await playback.handlePlay([track])
          expect(playback.backendDiagnostics().activeBackend).toBe("portable-browser")

          setProjectGeneration(2)
          await flushMicrotasks()
          const first = playback.restartTimelineSchedule([track], {
            rebuildBackend: true,
            resumePlayback: true,
            playheadSec: 1,
            owner: "native",
            projectId: "project",
            projectGeneration: 2,
          })
          const second = playback.restartTimelineSchedule([track], {
            rebuildBackend: true,
            resumePlayback: true,
            playheadSec: 2,
            owner: "native",
            projectId: "project",
            projectGeneration: 2,
          })
          await Promise.all([first, second])

          expect(playback.isPlaying()).toBeTrue()
          expect(playback.backendDiagnostics().activeBackend).toBe("native")
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          expect(playback.isPortableBrowserPlaybackPrepared()).toBeFalse()
          expect(fixture.transportStates.filter((running) => running)).toHaveLength(1)
          expect(fixture.transportFrames.at(-1)).toBe(96_000)
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
    }
  })
})

test('pauses Web Audio transport before disposing portable playback on project generation change', async () => {
  await withPortableAudioWorklet(async () => {
    const [projectGeneration, setProjectGeneration] = createSignal(1)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        getAudioContext: () => new AudioContext(),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, undefined, {
          projectGeneration,
          compileSnapshot,
        })
        await playback.handlePlay([track])
        expect(playback.isPortableBrowserPlayback()).toBeTrue()

        fake.transportEvents.length = 0
        setProjectGeneration(2)
        await flushMicrotasks()
        await playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: "portable-browser",
          projectGeneration: 2,
        })

        expect(fake.transportEvents).toContain("onTransportPause")
        dispose()
      })
    })
  })
})

test('pauses Web Audio transport before disposing active portable playback on cleanup', async () => {
  await withPortableAudioWorklet(async () => {
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        getAudioContext: () => new AudioContext(),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, undefined, { compileSnapshot })
        await playback.handlePlay([track])
        expect(playback.isPortableBrowserPlayback()).toBeTrue()

        fake.transportEvents.length = 0
        dispose()

        expect(fake.transportEvents).toContain("onTransportPause")
        expect(playback.isPortableBrowserPlaybackPrepared()).toBeFalse()
      })
    })
  })
})

test('waits for lifecycle recovery before restarting an active native graph', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "ready", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: true }),
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => false,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()

        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        fixture.emitLifecycle({ state: "recovering", powerGeneration: 2 })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeTrue()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(2)
        expect(playback.backendDiagnostics().activeBackend).toBe("native")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('resolves a pending rebuild when intentional teardown cancels lifecycle readiness', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "suspended", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: false }),
  })
  const faults: string[] = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    let dispose = () => {}
    const playback = createRoot((cleanup) => {
      dispose = cleanup
      return useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
        reportFault: (message) => faults.push(message),
      })
    })
    await flushMicrotasks()

    const rebuild = playback.restartTimelineSchedule([track], {
      rebuildBackend: true,
      resumePlayback: true,
      playheadSec: 0,
      owner: "native",
      projectId: "project",
    })
    await flushMicrotasks()
    dispose()

    await expect(rebuild).resolves.toBeUndefined()
    expect(faults).toEqual([])
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('resumes an explicitly captured structural rebuild after project generation invalidation', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  let projectGeneration = 1
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      let dispose = () => {}
      const playback = createRoot((cleanup) => {
        dispose = cleanup
        return useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          projectGeneration: () => projectGeneration,
          compileSnapshot: nativeRequiredSnapshot,
        })
      })
      await flushMicrotasks()
      await playback.handlePlay([track])
      expect(playback.isPlaying()).toBeTrue()

      const intent = {
        resumePlayback: true,
        playheadSec: 3,
        projectId: "project",
      }
      projectGeneration = 2
      await playback.handlePause()
      expect(playback.isPlaying()).toBeFalse()

      await playback.restartTimelineSchedule([track], {
        rebuildBackend: true,
        ...intent,
      })

      expect(playback.isPlaying()).toBeTrue()
      expect(fixture.transportStates.filter((running) => running)).toHaveLength(2)
      expect(fixture.transportFrames.at(-1)).toBe(144000)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('resumes after the generation effect disposes playback before structural rebuild', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const [projectGeneration, setProjectGeneration] = createSignal(1)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          projectGeneration,
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        fake.setCurrentTimelineSec(3)
        const intent = {
          resumePlayback: playback.isPlaying(),
          playheadSec: 3,
          projectId: "project",
        }

        setProjectGeneration(2)
        // Bun resolves Solid's createEffect through its server entry point, so
        // model the generation effect's disposal explicitly in this hook test.
        await playback.handlePause()
        expect(playback.isPlaying()).toBeFalse()

        fixture.calls.length = 0
        fixture.transportStates.length = 0
        await playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          ...intent,
        })

        expect(playback.isPlaying()).toBeTrue()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(1)
        expect(fixture.transportFrames.at(-1)).toBe(144000)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('coalesces queued structural rebuilds and resumes once', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      let dispose = () => {}
      const playback = createRoot((cleanup) => {
        dispose = cleanup
        return useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
      })
      await flushMicrotasks()
      await playback.handlePlay([track])
      fixture.transportStates.length = 0

      const first = playback.restartTimelineSchedule([track], {
        rebuildBackend: true,
        resumePlayback: true,
        playheadSec: 1,
        projectId: "project",
      })
      const second = playback.restartTimelineSchedule([track], {
        rebuildBackend: true,
        resumePlayback: true,
        playheadSec: 2,
        projectId: "project",
      })
      await first
      await second

      expect(fixture.transportStates.filter((running) => running)).toHaveLength(1)
      expect(fixture.transportFrames.at(-1)).toBe(96000)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('preserves the latest instrument override across an active structural rebuild', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge()
  const compileContexts: Array<unknown> = []
  const instrumentA = {
    kind: 'drum-rack' as const,
    instanceId: 'instrument-a',
    params: createDefaultDrumRackParams(),
  }
  const instrumentB = {
    kind: 'drum-rack' as const,
    instanceId: 'instrument-b',
    params: createDefaultDrumRackParams(),
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: async (transport, context) => {
            compileContexts.push(context)
            return nativeRequiredSnapshot(transport)
          },
        })
        await playback.handlePlay([track])
        fixture.calls.length = 0
        fixture.setBeginGate(beginGate.promise)

        const first = playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: "native",
          projectId: "project",
          instrumentOverride: { targetId: track.id, instrument: instrumentA },
        })
        await flushMicrotasks()
        expect(playback.isStructuralRebuildInProgress()).toBeTrue()
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeFalse()

        const second = playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: "native",
          projectId: "project",
          instrumentOverride: { targetId: track.id, instrument: instrumentB },
        })
        await flushMicrotasks()
        beginGate.resolve({ ok: true })
        await Promise.all([first, second])

        expect(compileContexts).toContainEqual({ instrumentOverride: { targetId: track.id, instrument: instrumentA } })
        expect(compileContexts.at(-1)).toEqual({
          instrumentOverride: { targetId: track.id, instrument: instrumentB },
        })
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.isPlaying()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('does not restart after pause wins an active native rebuild', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        fixture.setBeginGate(beginGate.promise)
        fixture.calls.length = 0
        fixture.transportStates.length = 0

        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        await flushMicrotasks()
        await playback.handlePause()
        beginGate.resolve({ ok: true })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeFalse()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(0)
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('does not resume a structural rebuild after stop wins', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        fixture.calls.length = 0
        fixture.transportStates.length = 0
        fixture.setBeginGate(beginGate.promise)

        const rebuild = playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: true,
          playheadSec: 2,
          projectId: "project",
        })
        await flushMicrotasks()
        await playback.handleStop()
        beginGate.resolve({ ok: true })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('does not resume a structural rebuild after switching projects', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge()
  let projectId = "project"
  let projectGeneration = 1
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => projectId,
          projectGeneration: () => projectGeneration,
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        fixture.calls.length = 0
        fixture.transportStates.length = 0
        fixture.setBeginGate(beginGate.promise)

        const rebuild = playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: true,
          playheadSec: 2,
          projectId: "project",
        })
        await flushMicrotasks()
        projectId = "other-project"
        projectGeneration = 2
        beginGate.resolve({ ok: true })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(0)
        expect(fixture.calls.filter((call) => call === "teardown").length).toBeGreaterThan(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('rebuilds a delayed paused native preview without committing play intent', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        const note = playback.nativeLiveMidi.start({ trackId: track.id, pitch: 60, velocity: 0.5 })
        await flushMicrotasks()
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)

        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        beginGate.resolve({ ok: true })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
        expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)
        expect(fixture.transportStates).not.toContain(true)
        if (note) playback.nativeLiveMidi.stop(note)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('fails safely when the fresh native graph cannot start after insertion', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  let failFreshBegin = false
  const fixture = createNativeHookBridge(() => {
    return failFreshBegin ? "begin" : undefined
  }, undefined, beginGate.promise)
  const [nativeEnabled, setNativeEnabled] = createSignal(false)
  let projectGeneration = 1
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: nativeEnabled,
          projectId: () => "project",
          projectGeneration: () => projectGeneration,
          compileSnapshot: nativeRequiredSnapshot,
        })
        setNativeEnabled(true)
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        projectGeneration = 2
        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        beginGate.resolve({ ok: true })
        failFreshBegin = true

        const rebuildError = await rebuild.catch((error: unknown) => error)
        expect(rebuildError).toBeInstanceOf(Error)
        if (rebuildError instanceof Error) expect(rebuildError.message).toContain("failed")
        await play
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe("idle")
        expect(fixture.calls.filter((call) => call === "start")).toHaveLength(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('serializes a delayed native pause before immediate play', async () => {
  const previousWindow = globalThis.window
  const pauseGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, pauseGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await playback.handlePlay([track])
        fixture.armTransportGate()
        fixture.calls.length = 0
        fixture.transportStates.length = 0

        const pause = playback.handlePause()
        await flushMicrotasks()
        expect(playback.isPlaying()).toBeFalse()

        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls.filter((call) => call === "transport")).toHaveLength(1)

        pauseGate.resolve({ ok: true })
        await Promise.all([pause, play])

        expect(fixture.transportStates.filter((running) => running)).toHaveLength(1)
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("native")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('serializes play behind an in-flight stop teardown', async () => {
  const previousWindow = globalThis.window
  const stopGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, stopGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await playback.handlePlay([track])
        fixture.armTransportGate()
        fixture.calls.length = 0
        fake.transportEvents.length = 0

        const stop = playback.handleStop()
        await flushMicrotasks()
        const play = playback.handlePlay([track])
        await flushMicrotasks()

        expect(fixture.calls.filter((call) => call === "transport")).toHaveLength(1)
        expect(fixture.calls).not.toContain("begin")
        expect(playback.isPlaying()).toBeFalse()

        stopGate.resolve({ ok: true })
        await Promise.all([stop, play])

        const teardownIndex = fixture.calls.lastIndexOf("teardown")
        const beginIndex = fixture.calls.lastIndexOf("begin")
        expect(teardownIndex).toBeGreaterThan(-1)
        expect(beginIndex).toBeGreaterThan(teardownIndex)
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.isNativePlayback()).toBeTrue()
        expect(fake.transportEvents).not.toContain("onTransportStop")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('keeps fallback startup alive across a failed native retry', async () => {
  const previousWindow = globalThis.window
  let emitLifecycle = (_lifecycle: DesktopAudioLifecycle) => {}
  const resumeGate = Promise.withResolvers<void>()
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      emitLifecycle({ state: "recovering", powerGeneration: 2 })
      emitLifecycle({ state: "failed", powerGeneration: 2 })
      return { accepted: true }
    },
  })
  emitLifecycle = fixture.emitLifecycle
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        resume: () => resumeGate.promise,
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(playback.backendDiagnostics().activeBackend).toBe("idle")
        resumeGate.resolve()
        await play
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(fake.scheduleCalls).toHaveLength(1)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('preserves active legacy playback across a failed native retry', async () => {
  const previousWindow = globalThis.window
  let emitLifecycle = (_lifecycle: DesktopAudioLifecycle) => {}
  const retryGate = Promise.withResolvers<{ accepted: boolean }>()
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      await retryGate.promise
      emitLifecycle({ state: "recovering", powerGeneration: 2 })
      emitLifecycle({ state: "failed", powerGeneration: 2 })
      return { accepted: true }
    },
  })
  emitLifecycle = fixture.emitLifecycle
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        retryGate.resolve({ accepted: true })
        await flushMicrotasks()
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(fixture.calls).not.toContain("begin")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('suspension cancels delayed native startup before it can commit playback', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "recovering", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: true }),
  }, beginGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        fixture.emitLifecycle({ state: "ready", powerGeneration: 2 })
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls).toContain("begin")
        fixture.emitLifecycle({ state: "suspended", powerGeneration: 3 })
        beginGate.resolve({ ok: true })
        await play
        expect(playback.isPlaying()).toBeFalse()
        expect(fake.scheduleCalls).toEqual([])
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('failed lifecycle transition cancels delayed native startup', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "ready", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: true }),
  }, beginGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls).toContain("begin")
        fixture.emitLifecycle({ state: "failed", powerGeneration: 2 })
        beginGate.resolve({ ok: true })
        await play
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe("idle")
        expect(fake.scheduleCalls).toEqual([])
        expect(fixture.calls).toContain("teardown")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('native live MIDI availability includes a recoverable native preview', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })
        expect(playback.nativeLiveMidi.isAvailable()).toBeTrue()
        expect(playback.nativeLiveMidi.isActive()).toBeFalse()
        await playback.handlePlay([track])
        await playback.handlePause()
        expect(playback.nativeLiveMidi.isAvailable()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('retries failed recovery only after explicit play and stays paused until ready', async () => {
  const previousWindow = globalThis.window
  let failed = true
  let emitLifecycle = (_lifecycle: DesktopAudioLifecycle) => {}
  const acknowledgements: Array<{ generation: number; result: "ready" | "failed" }> = []
  const fixture = createNativeHookBridge(
    () => failed ? "begin" : undefined,
    {
      initial: { state: "suspended", powerGeneration: 1 },
      completeRecovery: async (generation, result) => {
        acknowledgements.push({ generation, result })
        emitLifecycle({ state: result, powerGeneration: generation })
        return { accepted: true }
      },
      retryRecovery: async () => {
        emitLifecycle({ state: "recovering", powerGeneration: 3 })
        return { accepted: true }
      },
    },
  )
  emitLifecycle = fixture.emitLifecycle
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        fixture.emitLifecycle({ state: "recovering", powerGeneration: 2 })
        for (let index = 0; index < 100; index += 1) await Promise.resolve()
        expect(acknowledgements).toContainEqual({ generation: 2, result: "failed" })
        failed = false
        await playback.handlePlay([track])
        await flushMicrotasks()
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(acknowledgements).toContainEqual({ generation: 3, result: "ready" })
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        await playback.handlePause()
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
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
  appliedProcessorSequence: 0n,
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
          version: 2,
          browserDefaultBackend: 'portable-browser',
          browserCompatibilityBackend: 'legacy',
          selection: 'startup-only',
          preActivationFailure: 'compatibility-fallback',
          runtimeFailure: 'stop-and-mute',
          portableBrowserRequiresOptIn: false,
          nativeRequiresOptIn: true,
          activeBackend: 'native',
          requestedNative: true,
          portableBrowserConfigured: false,
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

test('native-required playback does not fall back when native startup fails', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge('begin')
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
    let webEnsures = 0
    const engine = {
      ...fake.engine,
      ensureAudio: () => { webEnsures += 1 },
    }
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        compileSnapshot: async (transport) => nativeRequiredSnapshot(transport),
        reportFault: (message) => faults.push(message),
      })
      await playback.handlePlay([track])
      expect(playback.isPlaying()).toBeFalse()
      expect(webEnsures).toBe(0)
      expect(faults.length).toBeGreaterThan(0)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('preserves a prepared native preview across a paused native seek', async () => {
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
          requiresNativeAudio: true,
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
        expect(transportEvents).toEqual([])
        expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(beforeCounts.begin)
        expect(fixture.calls.filter((call) => call === 'release')).toHaveLength(beforeCounts.release)
        expect(fixture.calls.filter((call) => call === 'stop')).toHaveLength(beforeCounts.stop)
        expect(fixture.calls.filter((call) => call === 'teardown')).toHaveLength(beforeCounts.teardown)
        expect(fixture.transportFrames.at(-1)).toBe(192_000)
        expect(fixture.transportStates.at(-1)).toBeFalse()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('reconciles a paused seek superseded by native preview fingerprint disposal', async () => {
  const previousWindow = globalThis.window
  const transportGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, transportGate.promise)
  const [tracks, setTracks] = createSignal([track])
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const changedTrack: Track = {
        ...track,
        kind: 'instrument',
      }
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          fake.engine,
          { getTracks: () => tracks() },
          {
            requiresNativeAudio: true,
            enabled: () => true,
            compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
              revision: 1,
              bpm: 120,
              transport,
              tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
              sidechainRoutes: [],
            }),
            reportFault: (message) => faults.push(message),
          },
        )

        await playback.handlePlay(tracks())
        await playback.handlePause()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()

        fixture.armTransportGate()
        playback.setPlayhead(4, tracks())
        await flushMicrotasks()

        setTracks([changedTrack])
        await flushMicrotasks()
        transportGate.resolve({ ok: true })
        await flushMicrotasks()

        expect(faults).toEqual([])
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(fixture.transportFrames.at(-1)).toBe(192_000)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('rebuilds a prepared native backend while paused', async () => {
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
  appliedProcessorSequence: 0n,
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
        expect(playback.backendDiagnostics().activeBackend).toBe('native')
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
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

test('re-establishes paused native preview after structural fingerprint disposal', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const [tracks, setTracks] = createSignal([track])
  const instrument: Track = { ...track, kind: 'instrument' }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          engine,
          { getTracks: () => tracks() },
          {
            requiresNativeAudio: true,
            enabled: () => true,
            projectId: () => 'project',
            compileSnapshot: async (transport, context) => compileLivePlaybackSnapshot({
              revision: 1,
              bpm: 120,
              transport,
              tracks: tracks(),
              renderState: {
                fx: {
                  masterVolume: 1,
                  masterFxInstances: [],
                  trackFx: context?.instrumentOverride
                    ? {
                        [context.instrumentOverride.targetId]: {
                          instances: [],
                          instrument: context.instrumentOverride.instrument,
                        },
                      }
                    : {},
                },
                automationEnvelopes: [],
              },
              sidechainRoutes: [],
            }),
          },
        )
        await playback.handlePlay(tracks())
        await playback.handlePause()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        const beginsBefore = fixture.calls.filter((call) => call === 'begin').length

        setTracks([instrument])
        const rebuild = playback.restartTimelineSchedule([instrument], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: 'native',
          instrumentOverride: {
            targetId: instrument.id,
            instrument: {
              kind: 'drum-rack',
              instanceId: 'instrument-instance',
              params: createDefaultDrumRackParams(),
            },
          },
        })
        await expect(rebuild).resolves.toBeUndefined()
        await flushMicrotasks()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(fixture.calls.filter((call) => call === 'begin').length).toBeGreaterThan(beginsBefore)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('structural rebuild owns paused preview while reactive tracks change', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge()
  const [tracks, setTracks] = createSignal([track])
  const instrument: Track = { ...track, kind: 'instrument' }
  const compileContexts: Array<unknown> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          engine,
          { getTracks: () => tracks() },
          {
            requiresNativeAudio: true,
            enabled: () => true,
            projectId: () => 'project',
            compileSnapshot: async (transport, context) => {
              compileContexts.push(context)
              return nativeRequiredSnapshot(transport)
            },
          },
        )
        await playback.handlePlay(tracks())
        await playback.handlePause()
        fixture.calls.length = 0
        fixture.setBeginGate(beginGate.promise)

        setTracks([instrument])
        const rebuild = playback.restartTimelineSchedule([instrument], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: 'native',
          projectId: 'project',
          instrumentOverride: {
            targetId: instrument.id,
            instrument: {
              kind: 'drum-rack',
              instanceId: 'instrument-instance',
              params: createDefaultDrumRackParams(),
            },
          },
        })
        await flushMicrotasks()
        beginGate.resolve({ ok: true })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(compileContexts.at(-1)).toEqual({
          instrumentOverride: {
            targetId: instrument.id,
            instrument: {
              kind: 'drum-rack',
              instanceId: 'instrument-instance',
              params: createDefaultDrumRackParams(),
            },
          },
        })
        expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(1)
        expect(fixture.calls.slice(fixture.calls.lastIndexOf('begin') + 1)).not.toContain('teardown')
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('serializes stop teardown before a paused structural insertion', async () => {
  const previousWindow = globalThis.window
  const stopGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, stopGate.promise)
  const faults: string[] = []
  const instrument: Track = { ...track, kind: 'instrument' }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => 'project',
          compileSnapshot: nativeRequiredSnapshot,
          reportFault: (message) => faults.push(message),
        })
        await playback.handlePlay([track])
        fixture.armTransportGate()
        fixture.calls.length = 0

        const stop = playback.handleStop()
        await flushMicrotasks()
        const rebuild = playback.restartTimelineSchedule([instrument], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: 'native',
          projectId: 'project',
          instrumentOverride: {
            targetId: instrument.id,
            instrument: {
              kind: 'drum-rack',
              instanceId: 'instrument-instance',
              params: createDefaultDrumRackParams(),
            },
          },
        })
        await flushMicrotasks()
        stopGate.resolve({ ok: true })
        await Promise.all([stop, rebuild])

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(faults).toEqual([])
        expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(1)
        const teardownIndex = fixture.calls.lastIndexOf('teardown')
        const beginIndex = fixture.calls.lastIndexOf('begin')
        expect(teardownIndex).toBeGreaterThan(-1)
        expect(beginIndex).toBeGreaterThan(teardownIndex)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
