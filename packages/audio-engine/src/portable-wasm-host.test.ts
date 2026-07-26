import { expect, test } from 'bun:test'

const hostUrl = new URL('../../../public/audio-worklets/daw-portable-audio-core-host-v1.js', import.meta.url)
const wasmUrl = new URL('../../../native/build/audio-core-wasm/audio-core/daw-audio-core-wasm.wasm', import.meta.url)

test('the portable Wasm host exposes the same explicit API to worklet and Worker callers', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const statuses: unknown[] = []
  const createHost = () => new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: unknown) => statuses.push(message),
    close: () => {},
  })
  const workletHost = createHost()
  const workerHost = createHost()

  expect(typeof workletHost.initialize).toBe('function')
  expect(typeof workerHost.initialize).toBe('function')
  expect(typeof(workletHost.handleMessage)).toBe('function')
  expect(typeof(workerHost.process)).toBe('function')
  expect(await workerHost.initialize({
    wasmBytes: new ArrayBuffer(0),
    contractHash: 'test-contract',
    maxFramesPerBlock: 128,
  })).toBe(false)
  expect(statuses).toContainEqual({ version: 1, type: 'fault', code: 'initialization-failed' })
})

test('the shared portable Wasm host has no AudioWorklet-only dependency', async () => {
  const source = await Bun.file(hostUrl).text()

  expect(source).not.toContain('AudioWorkletProcessor')
  expect(source).not.toContain('registerProcessor')
  expect(source).not.toContain('.port')
  expect(source).toContain('constructor({ sampleRate, postMessage, close })')
  expect(source).toContain('initialize({ wasmBytes, wasmModule, contractHash, maxFramesPerBlock })')
  expect(source).toContain('wasmModule instanceof WebAssembly.Module')
})

test('the portable host captures bounded planar PCM only when explicitly configured', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const messages: unknown[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: unknown) => messages.push(message),
    close: () => undefined,
  })
  const wasmBytes = await Bun.file(wasmUrl).arrayBuffer()
  expect(await host.initialize({ wasmBytes, contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  host.handleMessage({
    version: 1,
    type: 'recording-capture-configure',
    generation: 4,
    sessionId: 9,
    channelCount: 1,
    inputChannels: [0],
    gain: 2,
    polarity: -1,
    monitoring: true,
    punchStartFrame: 1,
    punchEndFrame: null,
  })
  host.process([[new Float32Array([0.25, -0.5])]], [[new Float32Array(2), new Float32Array(2)]])
  expect(messages).toContainEqual(expect.objectContaining({
    type: 'recording-capture-applied',
    action: 'configured',
  }))
  host.handleMessage({ version: 1, type: 'recording-capture-finalize', stopFrame: 2 })
  expect(messages).toContainEqual(expect.objectContaining({
    type: 'recording-capture-block',
    generation: 4,
    sessionId: 9,
    frameCount: 1,
    planes: [Float32Array.from([1])],
  }))
  expect(messages).toContainEqual(expect.objectContaining({
    type: 'recording-capture-diagnostics',
    capturedFrames: 1,
    active: false,
    fatal: false,
  }))
})

test('the portable host drains one block per acknowledgement before finalizing', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const messages: unknown[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: unknown) => messages.push(message),
    close: () => undefined,
  })
  const wasmBytes = await Bun.file(wasmUrl).arrayBuffer()
  expect(await host.initialize({ wasmBytes, contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  host.handleMessage({
    version: 1,
    type: 'recording-capture-configure',
    generation: 5,
    sessionId: 10,
    channelCount: 1,
    inputChannels: [0],
    gain: 1,
    polarity: 1,
    monitoring: false,
    punchStartFrame: 0,
    punchEndFrame: null,
  })
  for (let block = 0; block < 17; block += 1) {
    host.process([[new Float32Array(128)]], [[new Float32Array(128), new Float32Array(128)]])
  }
  host.handleMessage({ version: 1, type: 'recording-capture-finalize', stopFrame: 128 })
  expect(messages.filter((message) => typeof message === 'object' && message !== null
    && 'type' in message && message.type === 'recording-capture-block')).toHaveLength(1)
  expect(messages).not.toContainEqual(expect.objectContaining({
    type: 'recording-capture-applied',
    action: 'finalized',
  }))

  host.handleMessage({ version: 1, type: 'recording-capture-drain' })
  expect(messages.filter((message) => typeof message === 'object' && message !== null
    && 'type' in message && message.type === 'recording-capture-block')).toHaveLength(2)
  expect(messages).toContainEqual(expect.objectContaining({
    type: 'recording-capture-applied',
    action: 'finalized',
  }))
})

test('installed schedules advance bounded cursors across half-open blocks and seeks', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const messages: unknown[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: unknown) => messages.push(message),
    close: () => undefined,
  })
  host.ready = true
  host.revision = 1
  host.transportEpoch = 1
  host.transportRunning = true
  host.maxFramesPerBlock = 128
  host.scheduleEventView = new DataView(new ArrayBuffer(4 + 256 * 20))
  host.scheduleInstrumentEventView = new DataView(new ArrayBuffer(4 + 256 * 48))
  host.preparedSnapshot = {
    revision: 1,
    masterNodeId: 'master',
    nodes: [
      {
        id: 'track',
        kind: 'source',
        mixer: {
          instanceId: 10,
          parameterTargets: [{ id: 'gain', target: 1 }],
        },
        processorOrder: [],
      },
      {
        id: 'instrument',
        kind: 'instrument',
        mixer: null,
        processorOrder: [],
      },
    ],
  }
  host.handleMessage({
    version: 1,
    type: 'install-schedule',
    requestId: 7,
    schedule: {
      revision: 1,
      transportEpoch: 1,
      events: [
        {
          frame: 0,
          sequence: 1,
          type: 'parameter-ramp',
          target: { kind: 'parameter', scope: 'track', trackId: 'track', parameterId: 'gain' },
          startFrame: 0,
          endFrame: 6,
          interpolation: 'linear',
          startValue: 0,
          endValue: 1,
        },
        {
          frame: 4,
          sequence: 2,
          type: 'note-on',
          target: { kind: 'instrument', trackId: 'instrument' },
          noteId: 9,
          pitch: 60,
          velocity: 0.75,
        },
        {
          frame: 6,
          sequence: 3,
          type: 'parameter-set',
          target: { kind: 'parameter', scope: 'track', trackId: 'track', parameterId: 'gain' },
          value: 0.25,
        },
      ],
    },
  })
  expect(messages).toContainEqual(expect.objectContaining({
    type: 'schedule-installed',
    result: 'installed',
  }))

  const materialize = (startFrame: number, frameCount: number) => {
    expect(host.materializeSchedule(startFrame, frameCount)).toBe(true)
    const parameterEvents = Array.from(
      { length: host.scheduleEventView.getUint32(0, true) },
      (_, index) => {
        const offset = 4 + index * 20
        return [
          startFrame + host.scheduleEventView.getUint32(offset + 12, true),
          host.scheduleEventView.getFloat32(offset + 16, true),
        ]
      },
    )
    return {
      parameterEvents,
      instrumentCount: host.scheduleInstrumentEventView.getUint32(0, true),
    }
  }

  const first = materialize(0, 3)
  const second = materialize(3, 3)
  const boundary = materialize(6, 1)
  expect(first.parameterEvents.map(([frame]) => frame)).toEqual([0, 1, 2])
  expect(second.parameterEvents.map(([frame]) => frame)).toEqual([3, 4, 5])
  expect(second.instrumentCount).toBe(1)
  expect(boundary.parameterEvents).toEqual([[6, 0.25]])

  host.resetScheduleCursors(0)
  const whole = materialize(0, 7)
  expect(whole.parameterEvents).toEqual([
    ...first.parameterEvents,
    ...second.parameterEvents,
    ...boundary.parameterEvents,
  ])
  host.resetScheduleCursors(4)
  const seeked = materialize(4, 2)
  expect(seeked.parameterEvents.map(([frame]) => frame)).toEqual([4, 5])
  expect(seeked.instrumentCount).toBe(1)
})

test('process stages only live buses, clears removed buses, and preserves recording channel mapping', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: () => undefined,
    close: () => undefined,
  })
  host.ready = true
  host.maxFramesPerBlock = 8
  host.inputPlanes = Array.from({ length: 128 }, () => new Float32Array(8))
  host.leftOutput = new Float32Array(8)
  host.rightOutput = new Float32Array(8)
  host.recordingMonitorPlanes = [new Float32Array(8), new Float32Array(8)]
  const inputBusCounts: number[] = []
  const recordingPlaneCounts: number[] = []
  host.coreProcess = (_frames: number, inputBusCount: number) => {
    inputBusCounts.push(inputBusCount)
    return 0
  }
  host.liveInputBusCount = 2
  const output = [[new Float32Array(2), new Float32Array(2)]]
  host.process([
    [Float32Array.from([1, 2])],
    [Float32Array.from([3, 4])],
  ], output)
  expect(Array.from(host.inputPlanes[2].slice(0, 2))).toEqual([3, 4])

  host.liveInputBusCount = 1
  host.process([[Float32Array.from([5, 6])]], output)
  expect(inputBusCounts).toEqual([2, 1])
  expect(Array.from(host.inputPlanes[2].slice(0, 2))).toEqual([0, 0])

  host.recordingCaptureActive = true
  host.recordingInputBusCount = 2
  host.recordingCaptureProcessMonitor = (_inputOffset: number, planeCount: number) => {
    recordingPlaneCounts.push(planeCount)
    return 0
  }
  host.process([[Float32Array.from([7, 8])]], output)
  expect(inputBusCounts.at(-1)).toBe(2)
  expect(recordingPlaneCounts).toEqual([4])
})
