import { expect, test } from 'bun:test'
import { createDefaultSynthParams } from '@daw-browser/shared'
import { resolveLiveMixerGraph } from '@daw-browser/audio-engine/live-mixer-runtime'
import type { PortableFrameSchedule } from '@daw-browser/audio-engine/portable-frame-scheduling'
import type { PortableWasmControlMessage, PortableWasmStatusMessage } from '@daw-browser/audio-engine/portable-wasm-protocol'
import { audioCoreContractVersion } from '@daw-browser/audio-core-contract'
import { audioCoreWasmAbiVersion, audioCoreWasmArtifactVersion } from '@daw-browser/audio-core-wasm'
import type { PortableWasmBackendSelection } from '@daw-browser/audio-engine/wasm-audio-worklet-backend'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
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

const createSession = (calls: string[], install: (schedule: PortableFrameSchedule) => Promise<void>) => {
  let fault: ((error: Error) => void) | undefined
  let recordingStatus: ((message: Extract<PortableWasmStatusMessage, { type: `recording-${string}` }>) => void) | undefined
  let recordingGeneration = 0
  let recordingSessionId = 0
  return {
    connectInput: () => {
      calls.push('connect-input')
      return () => calls.push('disconnect-input')
    },
    dispose: () => calls.push('dispose'),
    markActive: () => calls.push('mark-active'),
    onFault: (listener: (error: Error) => void) => {
      fault = listener
      return () => {
        if (fault !== listener) return false
        fault = undefined
        return true
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
    postRecordingControl: (message: Extract<PortableWasmControlMessage, { type: `recording-${string}` }>) => {
      calls.push(message.type)
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
    prepareGraph: async () => { calls.push('prepare-graph') },
    publishGraph: async () => { calls.push('publish-graph') },
    registerAsset: async () => ({ status: 'registered' as const, handle: { slot: 0, generation: 1 } }),
    installSchedule: async (schedule: PortableFrameSchedule) => {
      calls.push(`install-schedule:${schedule.events.length}`)
      await install(schedule)
    },
    scheduleSources: async () => { calls.push('schedule-sources') },
    setTransport: async (_epoch: number, running: boolean) => { calls.push(running ? 'start-transport' : 'stop-transport') },
    fail: (error: Error) => fault?.(error),
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
  await controller.pause(0.5)
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(await controller.start({ ...compilation().snapshot.transport, playheadSec: 0.5 })).toBe('started')

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
  expect(faults).toContain('Portable recording device ended.')
  expect(failures).toEqual(['Portable recording device ended.'])
})

test('preserves caller-owned recording streams when portable writer startup fails', async () => {
  const calls: string[] = []
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

  expect(calls).not.toContain('track-stop')
  expect(calls).toContain('source-disconnect')
  expect(writerTerminations).toBe(1)
  expect(controller.isRecording()).toBeFalse()
})
