import { expect, test } from 'bun:test'
import { createDefaultSynthParams } from '@daw-browser/shared'
import { resolveLiveMixerGraph } from '@daw-browser/audio-engine/live-mixer-runtime'
import type { PortableFrameSchedule } from '@daw-browser/audio-engine/portable-frame-scheduling'
import type { PortableWasmControlMessage, PortableWasmStatusMessage } from '@daw-browser/audio-engine/portable-wasm-protocol'
import { audioCoreContractVersion } from '@daw-browser/audio-core-contract'
import { audioCoreWasmAbiVersion, audioCoreWasmArtifactVersion } from '@daw-browser/audio-core-wasm'
import type { PortableWasmBackendSelection } from '@daw-browser/audio-engine/wasm-audio-worklet-backend'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { LivePlaybackTransport } from '~/lib/live-playback-snapshot'
import { createPortableBrowserPlaybackController } from '~/lib/portable-browser-playback-controller'

const track: RuntimeTrack = {
  id: 'synth',
  kind: 'instrument',
  name: 'Synth',
  volume: 0.8,
  clips: [{
    id: 'clip',
    name: 'MIDI',
    color: '#fff',
    startSec: 0,
    duration: 1,
    midiOffsetBeats: 0,
    midi: {
      wave: 'sine',
      notes: [{ id: 'note', beat: 0, length: 1, pitch: 60, velocity: 0.8 }],
      cc: [],
      mappings: [],
    },
  }],
}

const compilation = () => {
  const mixer = resolveLiveMixerGraph([track], {})
  return {
    supported: true as const,
    snapshot: {
      revision: 1,
      bpm: 120,
      transport: {
        state: 'playing' as const,
        playheadSec: 0,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      },
      tracks: [track],
      assets: [],
      mixer: {
        graph: mixer,
        fx: {
          masterFxInstances: [],
          trackFx: {
            synth: {
              instances: [],
              instrument: {
                kind: 'synth' as const,
                instanceId: 'synth:1',
                params: createDefaultSynthParams(),
              },
            },
          },
        },
        automationEnvelopes: [],
        sidechainRoutes: [],
      },
    },
  }
}

const context = { sampleRate: 48_000 } as AudioContext

const selected: PortableWasmBackendSelection = {
  selected: true,
  capability: {
    available: true,
    artifact: {
      bytes: new ArrayBuffer(0),
      module: new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])),
      manifest: {
        version: audioCoreWasmArtifactVersion,
        abiVersion: audioCoreWasmAbiVersion,
        contractVersion: audioCoreContractVersion,
        contractHash: 'test',
        fixedMemory: true,
        memoryBytes: 1,
        sha256: 'test',
        wasmUrl: 'test',
      },
    },
    sharedQueue: 'available',
  },
}

const createSession = (
  calls: string[],
  install: (schedule: PortableFrameSchedule) => Promise<void>,
  setTransport: (running: boolean, frame: number) => Promise<void> = async () => undefined,
) => {
  const record = (call: string) => calls.push(call)
  const faults = new Set<(error: Error) => void>()
  const allFaultListeners = new Set<(error: Error) => void>()
  let recordingStatus: ((message: Extract<PortableWasmStatusMessage, { type: `recording-${string}` }>) => void) | undefined
  let transportPosition: ((message: Extract<PortableWasmStatusMessage, { type: "transport-position" }>) => void) | undefined
  let recordingGeneration = 0
  let recordingSessionId = 0
  const transports: Array<{ running: boolean; frame: number }> = []
  return {
    transports,
    connectInput: () => {
      record('connect-input')
      return () => record('disconnect-input')
    },
    dispose: () => record('dispose'),
    markActive: () => record('mark-active'),
    onFault: (listener: (error: Error) => void) => {
      faults.add(listener)
      allFaultListeners.add(listener)
      return () => {
        return faults.delete(listener)
      }
    },
    onRecordingStatus: (listener: (message: Extract<PortableWasmStatusMessage, { type: `recording-${string}` }>) => void) => {
      recordingStatus = listener
      return () => {
        if (recordingStatus !== listener) return false
        recordingStatus = undefined
        return true
      }
    },
    onTransportPosition: (listener: (message: Extract<PortableWasmStatusMessage, { type: "transport-position" }>) => void) => {
      transportPosition = listener
      return () => {
        if (transportPosition === listener) transportPosition = undefined
        return true
      }
    },
    postRecordingControl: (message: Extract<PortableWasmControlMessage, { type: `recording-${string}` }>) => {
      record(message.type)
      if (message.type === 'recording-capture-configure') {
        recordingGeneration = message.generation
        recordingSessionId = message.sessionId
      }
      const action = message.type === 'recording-capture-configure'
        ? 'configured'
        : message.type === 'recording-capture-finalize'
          ? 'finalized'
          : message.type === 'recording-capture-cancel'
            ? 'cancelled'
            : null
      if (action) queueMicrotask(() => recordingStatus?.({
        version: 1,
        type: 'recording-capture-applied',
        generation: recordingGeneration,
        sessionId: recordingSessionId,
        action,
        frame: 120,
      }))
    },
    prepareGraph: async () => { record('prepare-graph') },
    publishGraph: async () => { record('publish-graph') },
    registerAsset: async () => ({ status: 'registered' as const, handle: { slot: 0, generation: 1 } }),
    installSchedule: async (schedule: PortableFrameSchedule) => {
      record(`install-schedule:${schedule.events.length}`)
      await install(schedule)
    },
    scheduleSources: async () => { record('schedule-sources') },
    setTransport: async (_epoch: number, running: boolean, frame: number) => {
      record(running ? 'start-transport' : 'stop-transport')
      transports.push({ running, frame })
      await setTransport(running, frame)
    },
    fail: (error: Error) => {
      for (const listener of allFaultListeners) listener(error)
    },
    emitPosition: (frame: number, sequence = 1, running = true) => transportPosition?.({
      version: 1,
      type: "transport-position",
      sessionId: 1,
      epoch: 1,
      sequence,
      running,
      frame,
    }),
    recordingStatus: (message: Extract<PortableWasmStatusMessage, { type: `recording-${string}` }>) => recordingStatus?.(message),
  }
}

test('installs an acknowledged MIDI schedule before starting portable output once', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const session = createSession(calls, async () => undefined)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
  })

  const result = await controller.start(compilation().snapshot.transport)
  expect(result, faults.join('\n')).toBe('started')
  expect(await controller.start(compilation().snapshot.transport)).toBe('started')
  expect(calls).toEqual([
    'prepare-graph',
    'publish-graph',
    'stop-transport',
    'install-schedule:2',
    'schedule-sources',
    'start-transport',
    'mark-active',
  ])
  expect(controller.isActive()).toBe(true)
})

test('refreshes the portable schedule before its installed range ends', async () => {
  const calls: string[] = []
  const sessions = [
    createSession(calls, async () => undefined),
    createSession(calls, async () => undefined),
  ]
  let sessionIndex = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        const session = sessions[sessionIndex]
        sessionIndex += 1
        if (!session) throw new Error("Unexpected extra portable session.")
        return session
      },
    },
    select: async () => selected,
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  sessions[0]?.emitPosition(80_000)
  const firstRefresh = controller.refreshSchedule()
  expect(controller.refreshSchedule()).toBe(firstRefresh)
  await expect(firstRefresh).resolves.toBe("started")

  expect(sessionIndex).toBe(2)
  expect(calls.filter((call) => call === "mark-active")).toHaveLength(2)
  expect(calls.filter((call) => call === "dispose")).toHaveLength(1)
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('refreshes from the latest old-session position without overlapping sessions', async () => {
  const calls: string[] = []
  const replacementInstalling = Promise.withResolvers<void>()
  const releaseReplacement = Promise.withResolvers<void>()
  const sessions = [
    createSession(calls, async () => undefined),
    createSession(calls, async () => {
      replacementInstalling.resolve()
      await releaseReplacement.promise
    }),
    createSession(calls, async () => undefined),
  ]
  let sessionIndex = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        const session = sessions[sessionIndex]
        sessionIndex += 1
        if (!session) throw new Error("Unexpected extra portable session.")
        return session
      },
    },
    select: async () => selected,
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  sessions[0]?.emitPosition(80_000)
  const refresh = controller.refreshSchedule()
  await replacementInstalling.promise
  sessions[0]?.emitPosition(90_000, 2)
  releaseReplacement.resolve()

  await expect(refresh).resolves.toBe("started")
  expect(sessions[2]?.transports).toEqual([
    { running: false, frame: 90_000 },
    { running: true, frame: 90_000 },
  ])
  expect(calls.lastIndexOf("dispose")).toBeLessThan(calls.lastIndexOf("start-transport"))
  expect(calls.lastIndexOf("dispose")).toBeLessThan(calls.lastIndexOf("mark-active"))
  expect(controller.currentPositionSec()).toBe(90_000 / context.sampleRate)
  sessions[0]?.fail(new Error("stale old-session fault"))
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('keeps the current portable session active when a rolling refresh fails', async () => {
  const calls: string[] = []
  let sessionIndex = 0
  let activeSession: ReturnType<typeof createSession> | undefined
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        sessionIndex += 1
        const session = createSession(calls, async () => {
          if (sessionIndex === 2) throw new Error("replacement rejected")
        })
        if (sessionIndex === 1) activeSession = session
        return session
      },
    },
    select: async () => selected,
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  expect(controller.isActive()).toBeTrue()
  activeSession?.emitPosition(80_000)
  await expect(controller.refreshSchedule()).resolves.toBe("unavailable")
  expect(sessionIndex).toBe(2)
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('keeps the old session and retries once when the replacement range is stale', async () => {
  const calls: string[] = []
  const sessions = [
    createSession(calls, async () => undefined),
    createSession(calls, async () => undefined),
    createSession(calls, async () => undefined),
  ]
  let sessionIndex = 0
  let compileCalls = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      compileCalls += 1
      const base = compilation()
      const snapshotTransport = compileCalls > 1
        ? { ...transport, playheadSec: 0 }
        : transport
      return { ...base, snapshot: { ...base.snapshot, transport: snapshotTransport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        const session = sessions[sessionIndex]
        sessionIndex += 1
        if (!session) throw new Error("Unexpected extra portable session.")
        return session
      },
    },
    select: async () => selected,
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  sessions[0]?.emitPosition(80_000)
  await expect(controller.refreshSchedule()).resolves.toBe("unavailable")

  expect(compileCalls).toBe(3)
  expect(sessionIndex).toBe(3)
  expect(controller.isActive()).toBeTrue()
  expect(calls.filter((call) => call === "dispose")).toHaveLength(2)
  controller.dispose()
})

test('stops truthfully when a prepared replacement cannot start after old disposal', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const sessions = [
    createSession(calls, async () => undefined),
    createSession(calls, async () => undefined, async (running) => {
      if (running) throw new Error("replacement start rejected")
    }),
  ]
  let sessionIndex = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        const session = sessions[sessionIndex]
        sessionIndex += 1
        if (!session) throw new Error("Unexpected extra portable session.")
        return session
      },
    },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  sessions[0]?.emitPosition(80_000)
  await expect(controller.refreshSchedule()).resolves.toBe("unavailable")

  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeFalse()
  expect(faults).toContain("replacement start rejected")
  expect(calls.indexOf("dispose")).toBeLessThan(calls.lastIndexOf("start-transport"))
  controller.dispose()
})

test('prepares a fresh portable session while keeping transport paused', async () => {
  const calls: string[] = []
  const session = createSession(calls, async () => undefined)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
  })

  expect(await controller.ensurePrepared(compilation().snapshot.transport)).toBe('started')
  expect(calls).toEqual([
    'prepare-graph',
    'publish-graph',
    'stop-transport',
    'install-schedule:2',
    'schedule-sources',
  ])
  expect(controller.isActive()).toBe(false)
  expect(controller.isPrepared()).toBe(true)
  controller.dispose()
})

test('rebuilds a paused portable session from its authoritative transport position', async () => {
  const calls: string[] = []
  let sessionCount = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        sessionCount += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const transport = {
    ...compilation().snapshot.transport,
    state: 'paused' as const,
    playheadSec: 3,
  }

  expect(await controller.ensurePrepared(transport)).toBe('started')
  expect(await controller.rebuildPrepared(transport)).toBe('started')
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(sessionCount).toBe(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls.filter((call) => call === 'prepare-graph')).toHaveLength(2)
  controller.dispose()
})

test('rejects unsupported prepared sources before creating or activating a worklet session', async () => {
  const calls: string[] = []
  let createdSessions = 0
  const unsupportedSource: RuntimeTrack = {
    id: 'audio',
    kind: 'audio',
    name: 'Audio',
    volume: 1,
    clips: [{
      id: 'missing-source',
      name: 'Missing source',
      color: '#fff',
      startSec: 0,
      duration: 1,
      sourceAssetKey: 'missing',
    }],
  }
  const sourceCompilation = compilation()
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => ({
      ...sourceCompilation,
      snapshot: {
        ...sourceCompilation.snapshot,
        tracks: [unsupportedSource],
      },
    }),
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })

  expect(await controller.start(sourceCompilation.snapshot.transport)).toBe('unavailable')
  expect(createdSessions).toBe(0)
  expect(calls).toEqual([])
  expect(controller.isActive()).toBeFalse()
})

test('shares one in-flight portable playback startup across concurrent callers', async () => {
  const calls: string[] = []
  const compile = Promise.withResolvers<ReturnType<typeof compilation>>()
  const session = createSession(calls, async () => undefined)
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: () => compile.promise,
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return session
      },
    },
    select: async () => selected,
  })

  const first = controller.start(compilation().snapshot.transport)
  const second = controller.start(compilation().snapshot.transport)
  expect(second).toBe(first)
  compile.resolve(compilation())

  await expect(Promise.all([first, second])).resolves.toEqual(['started', 'started'])
  expect(createdSessions).toBe(1)
  expect(calls.filter((call) => call === 'mark-active')).toHaveLength(1)
})

test('promotes a pending portable preview without recompiling at the requested transport', async () => {
  const calls: string[] = []
  const compile = Promise.withResolvers<ReturnType<typeof compilation>>()
  const session = createSession(calls, async () => undefined)
  let createdSessions = 0
  let compileCalls = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: () => {
      compileCalls += 1
      return compile.promise
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return session
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const playTransport = {
    ...compilation().snapshot.transport,
    playheadSec: 0,
  }

  const preview = controller.ensurePrepared(previewTransport)
  const started = controller.start(playTransport)
  expect(started).not.toBe(preview)
  compile.resolve(compilation())

  await expect(preview).resolves.toBe('started')
  await expect(started).resolves.toBe('started')
  expect(compileCalls).toBe(1)
  expect(createdSessions).toBe(1)
  expect(session.transports).toEqual([
    { running: false, frame: 0 },
    { running: true, frame: 0 },
  ])
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('rebuilds a portable preview when the requested playhead is outside its schedule', async () => {
  const calls: string[] = []
  const compileCalls: LivePlaybackTransport[] = []
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      compileCalls.push(transport)
      const base = compilation()
      return {
        ...base,
        snapshot: { ...base.snapshot, transport },
      }
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const requestedTransport = { ...compilation().snapshot.transport, playheadSec: 31 }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  await expect(controller.start(requestedTransport)).resolves.toBe('started')

  expect(compileCalls).toEqual([previewTransport, requestedTransport])
  expect(createdSessions).toBe(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls.filter((call) => call === 'mark-active')).toHaveLength(1)
  controller.dispose()
})

test('requires the full live schedule horizon before promoting a portable preview', async () => {
  const calls: string[] = []
  const compileCalls: LivePlaybackTransport[] = []
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      compileCalls.push(transport)
      const base = compilation()
      return {
        ...base,
        snapshot: { ...base.snapshot, transport },
      }
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const, playheadSec: 0 }
  const originalStartTransport = { ...compilation().snapshot.transport, playheadSec: 0 }
  const nearEndTransport = { ...compilation().snapshot.transport, playheadSec: 29 }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  await expect(controller.start(originalStartTransport)).resolves.toBe('started')
  await controller.pause(0)
  await expect(controller.start(nearEndTransport)).resolves.toBe('started')

  expect(compileCalls).toEqual([previewTransport, nearEndTransport])
  expect(createdSessions).toBe(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  controller.dispose()
})

test('rebuilds instead of promoting a portable preview when loop semantics change', async () => {
  const calls: string[] = []
  const compileCalls: LivePlaybackTransport[] = []
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      compileCalls.push(transport)
      const base = compilation()
      return {
        ...base,
        snapshot: { ...base.snapshot, transport },
      }
    },
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => createSession(calls, async () => undefined) },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const loopTransport = {
    ...compilation().snapshot.transport,
    loopEnabled: true,
    loopStartSec: 1,
    loopEndSec: 4,
  }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  await expect(controller.start(loopTransport)).resolves.toBe('unavailable')

  expect(compileCalls).toEqual([previewTransport, loopTransport])
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(controller.isPrepared()).toBeFalse()
})

test('shares one rebuild for concurrent incompatible portable starts', async () => {
  const calls: string[] = []
  const rebuild = Promise.withResolvers<ReturnType<typeof compilation>>()
  let compileCalls = 0
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: (transport) => {
      compileCalls += 1
      if (compileCalls === 1) {
        const base = compilation()
        return Promise.resolve({
          ...base,
          snapshot: { ...base.snapshot, transport },
        })
      }
      return rebuild.promise
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const firstTransport = { ...compilation().snapshot.transport, playheadSec: 31 }
  const secondTransport = { ...compilation().snapshot.transport, playheadSec: 32 }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  const first = controller.start(firstTransport)
  const second = controller.start(secondTransport)
  expect(second).toBe(first)

  const base = compilation()
  rebuild.resolve({ ...base, snapshot: { ...base.snapshot, transport: firstTransport } })
  await expect(Promise.all([first, second])).resolves.toEqual(['started', 'started'])
  expect(compileCalls).toBe(2)
  expect(createdSessions).toBe(2)
  controller.dispose()
})

test('disposal during an incompatible portable rebuild prevents activation', async () => {
  const calls: string[] = []
  const rebuild = Promise.withResolvers<ReturnType<typeof compilation>>()
  let compileCalls = 0
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: () => {
      compileCalls += 1
      return compileCalls === 1 ? Promise.resolve(compilation()) : rebuild.promise
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const requestedTransport = { ...compilation().snapshot.transport, playheadSec: 31 }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  const started = controller.start(requestedTransport)
  controller.dispose()
  rebuild.resolve(compilation())

  await expect(started).resolves.toBe('unavailable')
  expect(createdSessions).toBe(1)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls).not.toContain('mark-active')
  expect(controller.isActive()).toBeFalse()
})

test('shares concurrent portable starts during preview promotion', async () => {
  const calls: string[] = []
  const promotion = Promise.withResolvers<void>()
  const session = createSession(calls, async () => undefined, async (running) => {
    if (running) await promotion.promise
  })
  let compileCalls = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => {
      compileCalls += 1
      return compilation()
    },
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
  })
  const transport = { ...compilation().snapshot.transport, playheadSec: 0 }

  await expect(controller.ensurePrepared({ ...transport, state: 'paused' as const })).resolves.toBe('started')
  const first = controller.start(transport)
  const second = controller.start({ ...transport, playheadSec: 1.5 })
  expect(second).toBe(first)
  expect(session.transports).toEqual([
    { running: false, frame: 0 },
    { running: true, frame: 0 },
  ])

  promotion.resolve()
  await expect(Promise.all([first, second])).resolves.toEqual(['started', 'started'])
  expect(compileCalls).toBe(1)
  expect(session.transports).toHaveLength(2)
  controller.dispose()
})

test('does not promote an unavailable portable preview', async () => {
  const calls: string[] = []
  const selection = Promise.withResolvers<PortableWasmBackendSelection>()
  const session = createSession(calls, async () => undefined)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: () => selection.promise,
  })
  const transport = compilation().snapshot.transport

  const preview = controller.ensurePrepared({ ...transport, state: 'paused' as const })
  const started = controller.start(transport)
  selection.resolve({ selected: false, reason: 'not available' })

  await expect(preview).resolves.toBe('unavailable')
  await expect(started).resolves.toBe('unavailable')
  expect(calls).toEqual([])
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeFalse()
})

test('cancellation during portable preview prevents late promotion', async () => {
  for (const invalidation of ['dispose', 'project-generation'] as const) {
    const calls: string[] = []
    const installing = Promise.withResolvers<void>()
    const releaseInstall = Promise.withResolvers<void>()
    const session = createSession(calls, async () => {
      installing.resolve()
      await releaseInstall.promise
    })
    let projectGeneration = 1
    const controller = createPortableBrowserPlaybackController({
      compileSnapshot: async () => compilation(),
      getAudioContext: () => context,
      getProjectGeneration: () => projectGeneration,
      backend: { createPlaybackSession: async () => session },
      select: async () => selected,
    })
    const transport = {
      ...compilation().snapshot.transport,
      playheadSec: 0.5,
    }

    const preview = controller.ensurePrepared({ ...transport, state: 'paused' as const })
    await installing.promise
    const started = controller.start(transport)
    if (invalidation === 'dispose') controller.dispose()
    else projectGeneration += 1
    releaseInstall.resolve()

    await expect(preview).resolves.toBe('unavailable')
    await expect(started).resolves.toBe('unavailable')
    expect(calls).not.toContain('start-transport')
    expect(calls).not.toContain('mark-active')
    expect(controller.isActive()).toBeFalse()
  }
})

test('pause and resume retain the prepared portable graph and session', async () => {
  const calls: string[] = []
  const session = createSession(calls, async () => undefined)
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return session
      },
    },
    select: async () => selected,
  })

  expect(await controller.start(compilation().snapshot.transport)).toBe('started')
  await controller.pause(0)
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(await controller.start({ ...compilation().snapshot.transport, playheadSec: 0 })).toBe('started')

  expect(createdSessions).toBe(1)
  expect(calls.filter((call) => call === 'prepare-graph')).toHaveLength(1)
  expect(calls.filter((call) => call === 'publish-graph')).toHaveLength(1)
  expect(calls.filter((call) => call === 'start-transport')).toHaveLength(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(0)
})

test('project generation changes dispose the retained portable session before rebuilding', async () => {
  const calls: string[] = []
  let projectGeneration = 1
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    getProjectGeneration: () => projectGeneration,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })

  await controller.start(compilation().snapshot.transport)
  await controller.pause(0.25)
  projectGeneration += 1
  await controller.start({ ...compilation().snapshot.transport, playheadSec: 0.25 })

  expect(createdSessions).toBe(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls.filter((call) => call === 'prepare-graph')).toHaveLength(2)
})

test('dispose invalidates pending portable playback startup before late activation', async () => {
  const calls: string[] = []
  const installing = Promise.withResolvers<void>()
  const releaseInstall = Promise.withResolvers<void>()
  const session = createSession(calls, async () => {
    installing.resolve()
    await releaseInstall.promise
  })
  const faults: string[] = []
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
  })

  const starting = controller.start(compilation().snapshot.transport)
  await installing.promise
  controller.dispose()
  releaseInstall.resolve()

  await expect(starting).resolves.toBe('unavailable')
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls).not.toContain('mark-active')
  expect(controller.isActive()).toBeFalse()
  expect(faults).toEqual([])
})

test('rolls back rejected or timed out schedule installation before activation', async () => {
  for (const message of ['schedule rejected', 'Portable playback control request timed out.']) {
    const calls: string[] = []
    const session = createSession(calls, async () => { throw new Error(message) })
    const controller = createPortableBrowserPlaybackController({
      compileSnapshot: async () => compilation(),
      getAudioContext: () => context,
      backend: { createPlaybackSession: async () => session },
      select: async () => selected,
    })

    expect(await controller.start(compilation().snapshot.transport)).toBe('unavailable')
    expect(calls).toEqual([
      'prepare-graph',
      'publish-graph',
      'stop-transport',
      'install-schedule:2',
      'dispose',
    ])
    expect(controller.isActive()).toBe(false)
  }
})

test('stops portable playback when its active worklet faults', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const session = createSession(calls, async () => undefined)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
  })

  await controller.start(compilation().snapshot.transport)
  session.fail(new Error('AudioWorklet processor fault.'))

  expect(controller.isActive()).toBe(false)
  expect(faults).toEqual(['AudioWorklet processor fault.'])
})

test('starts and finalizes portable recording through acknowledged bounded adapters', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const failures: string[] = []
  const session = createSession(calls, async () => undefined)
  let endedListener: (() => void) | undefined
  const mediaTrack: MediaStreamTrack = Object.assign(Object.create(null), {
    readyState: 'live',
    getSettings: () => ({ channelCount: 1 }),
    addEventListener: (_type: string, listener: () => void) => {
      endedListener = listener
    },
    removeEventListener: (_type: string, listener: () => void) => {
      if (endedListener === listener) endedListener = undefined
    },
    stop: (): void => { calls.push('track-stop') },
  })
  const stream: MediaStream = Object.assign(Object.create(null), {
    getTracks: () => [mediaTrack],
    getAudioTracks: () => [mediaTrack],
  })
  const source: MediaStreamAudioSourceNode = Object.assign(Object.create(null), {
    disconnect: (): void => { calls.push('source-disconnect') },
  })
  const recordingContext: AudioContext = Object.assign(Object.create(context), {
    sampleRate: 48_000,
    createMediaStreamSource: () => source,
  })
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => recordingContext,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
    createRecordingWriter: () => ({
        ready: Promise.resolve(),
        write: () => undefined,
        finalize: async () => {
          calls.push('writer-finalize')
          return { capturedFrames: 0 }
        },
        abort: async () => {
          calls.push('writer-abort')
        },
        terminate: () => calls.push('writer-terminate'),
      }),
  })

  expect(await controller.start(compilation().snapshot.transport)).toBe('started')
  expect(await controller.startRecording({
    appSessionId: 'take-1',
    stream,
    layout: 'mono',
    inputChannel: 0,
    gain: 1,
    polarity: 1,
    monitoring: true,
    punchStartFrame: 120,
  })).toEqual({ sampleRate: 48_000, channelCount: 1, startFrame: 120 })
  expect(controller.isRecording()).toBeTrue()
  expect(calls).toContain('connect-input')
  expect(calls).toContain('recording-capture-configure')

  expect(await controller.stopRecording()).toEqual({ capturedFrames: 0 })
  expect(controller.isRecording()).toBeFalse()
  expect(calls).toContain('recording-capture-finalize')
  expect(calls).toContain('writer-finalize')
  expect(calls).toContain('disconnect-input')
  expect(calls).toContain('source-disconnect')

  await controller.startRecording({
    appSessionId: 'take-2',
    stream,
    layout: 'mono',
    inputChannel: 0,
    gain: 1,
    polarity: 1,
    monitoring: false,
    punchStartFrame: 240,
    onFailure: (error) => failures.push(error.message),
  })
  endedListener?.()
  await Promise.resolve()
  expect(controller.isRecording()).toBeFalse()
  expect(calls).toContain('recording-capture-cancel')
  expect(calls).toContain('writer-abort')
  expect(faults).toEqual([])
  expect(failures).toEqual(['Portable recording device ended.'])
})

test('preserves caller-owned recording streams when portable writer startup fails', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const session = createSession(calls, async () => undefined)
  const mediaTrack: MediaStreamTrack = Object.assign(Object.create(null), {
    readyState: 'live',
    getSettings: () => ({ channelCount: 1 }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    stop: () => calls.push('track-stop'),
  })
  const stream: MediaStream = Object.assign(Object.create(null), {
    getTracks: () => [mediaTrack],
    getAudioTracks: () => [mediaTrack],
  })
  const source: MediaStreamAudioSourceNode = Object.assign(Object.create(null), {
    disconnect: () => calls.push('source-disconnect'),
  })
  const recordingContext: AudioContext = Object.assign(Object.create(context), {
    sampleRate: 48_000,
    createMediaStreamSource: () => source,
  })
  let writerTerminations = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => recordingContext,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
    createRecordingWriter: () => ({
      ready: Promise.reject(new Error('writer startup failed')),
      write: () => undefined,
      finalize: async () => ({ capturedFrames: 0 }),
      abort: () => new Promise<void>(() => undefined),
      terminate: () => {
        writerTerminations += 1
      },
    }),
  })

  await controller.start(compilation().snapshot.transport)
  await expect(controller.startRecording({
    appSessionId: 'fallback-take',
    stream,
    layout: 'mono',
    inputChannel: 0,
    gain: 1,
    polarity: 1,
    monitoring: false,
    punchStartFrame: 0,
  })).rejects.toThrow('writer startup failed')

  expect(controller.isActive()).toBeTrue()
  expect(faults).toEqual([])
  expect(calls).not.toContain('track-stop')
  expect(calls).toContain('source-disconnect')
  expect(writerTerminations).toBe(1)
  expect(controller.isRecording()).toBeFalse()
})
