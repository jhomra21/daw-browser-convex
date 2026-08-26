import { expect, test } from 'bun:test'
import type { PortableWasmStatusMessage } from './portable-wasm-protocol'

const hostUrl = new URL('../../../public/audio-worklets/daw-portable-audio-core-host-v1.js', import.meta.url)
const hostV2Url = new URL('../../../public/audio-worklets/daw-portable-audio-core-host-v2.js', import.meta.url)
const wasmUrl = new URL('../../../native/build/audio-core-wasm/audio-core/daw-audio-core-wasm.wasm', import.meta.url)

const createTransportHost = async (
  graphSetTransport: (epoch: number, running: number, frame: bigint) => number,
) => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: PortableWasmStatusMessage) => messages.push(message),
    close: () => undefined,
  })
  host.ready = true
  host.revision = 1
  host.maxFramesPerBlock = 8
  host.inputPlanes = Array.from({ length: 128 }, () => new Float32Array(8))
  host.leftOutput = new Float32Array(8)
  host.rightOutput = new Float32Array(8)
  host.eventOffset = 1
  host.eventBufferView = new DataView(new ArrayBuffer(4))
  host.graphSetTransport = graphSetTransport
  host.coreProcess = () => {
    host.leftOutput.fill(host.transportRunning ? 0.25 : 0)
    host.rightOutput.fill(host.transportRunning ? -0.125 : 0)
    return 0
  }
  return { host, messages }
}

test('the portable Wasm host exposes the same explicit API to worklet and Worker callers', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const statuses: PortableWasmStatusMessage[] = []
  const createHost = () => new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: PortableWasmStatusMessage) => statuses.push(message),
    close: () => {},
  })
  const workletHost = createHost()
  const workerHost = createHost()

  expect(workletHost.initialize).toBeInstanceOf(Function)
  expect(workerHost.initialize).toBeInstanceOf(Function)
  expect(workletHost.handleMessage).toBeInstanceOf(Function)
  expect(workerHost.process).toBeInstanceOf(Function)
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

test('v1 and v2 portable hosts pass curved fade values and defaults to Wasm', async () => {
  const event = {
    version: 1,
    epoch: 1,
    sequence: 1,
    sourceNodeId: 'source',
    assetId: 'asset',
    startFrame: 0,
    stopFrame: 8,
    sourceOffsetFrame: 0,
    sourceFrameCount: 8,
    gain: 1,
    fadeInStartFrame: 0,
    fadeInEndFrame: 4,
    fadeOutStartFrame: 4,
    fadeOutEndFrame: 8,
    fadeInCurve: 0.75,
    fadeInCurvePosition: 0.25,
    fadeOutCurve: -0.5,
    fadeOutCurvePosition: 0.8,
  }
  for (const hostUrlToUse of [hostUrl, hostV2Url]) {
    const { DawPortableAudioCoreHost } = await import(hostUrlToUse.href)
    const calls: unknown[][] = []
    const messages: PortableWasmStatusMessage[] = []
    const host = new DawPortableAudioCoreHost({
      sampleRate: 48_000,
      postMessage: (message: PortableWasmStatusMessage) => messages.push(message),
      close: () => undefined,
    })
    host.ready = true
    host.revision = 1
    host.transportEpoch = 1
    host.sourceSchedule = (...args: unknown[]) => {
      calls.push(args)
      return 0
    }
    host.assets = new Map([['asset', { handle: { value: 1n } }]])
    host.scheduleSources({
      version: 1,
      type: 'schedule-sources',
      requestId: 1,
      revision: 1,
      epoch: 1,
      events: [event],
    })
    expect(calls[0]?.slice(-5)).toEqual([0, 0.75, 0.25, -0.5, 0.8])
    expect(messages).toContainEqual(expect.objectContaining({ type: 'sources-scheduled', result: 'scheduled' }))
    calls.length = 0
    host.scheduleSources({
      version: 1,
      type: 'schedule-sources',
      requestId: 2,
      revision: 1,
      epoch: 1,
      events: [{ ...event, sequence: 2, fadeInCurve: undefined, fadeInCurvePosition: undefined, fadeOutCurve: undefined, fadeOutCurvePosition: undefined }],
    })
    expect(calls[0]?.slice(-5)).toEqual([0, 0, 0.5, 0, 0.5])
  }
})

test('portable Wasm hosts enforce the 24-parameter contract in every parameter validation path', async () => {
  const v1 = await Bun.file(hostUrl).text()
  const v2 = await Bun.file(hostV2Url).text()
  expect(v1).toContain('const MAX_PROCESSOR_PARAMETERS = 24')
  expect(v1).toContain('block.parameterTargets.length <= MAX_PROCESSOR_PARAMETERS')
  expect(v2).toContain('const MAX_PROCESSOR_PARAMETERS = 24')
  expect(v2).toContain('block.parameterTargets.length <= MAX_PROCESSOR_PARAMETERS')
  expect(v2).toContain('message.parameterTargets.length > MAX_PROCESSOR_PARAMETERS')
})

test('the v2 host acknowledges transport only after its rendered quantum reaches the output', async () => {
  const { host, messages } = await createTransportHost(() => 0)

  host.handleMessage({ version: 1, type: 'transport', requestId: 1, epoch: 1, running: false, frame: 2_048 })
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 1 }))

  const firstOutput = [[new Float32Array(8), new Float32Array(8)]]
  host.process([], firstOutput)
  expect(Array.from(firstOutput[0][0])).toEqual(Array.from(new Float32Array(8)))
  expect(Array.from(firstOutput[0][1])).toEqual(Array.from(new Float32Array(8)))
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 1 }))

  host.process([], [[new Float32Array(8), new Float32Array(8)]])
  expect(messages).toContainEqual({
    version: 1,
    type: 'transport-applied',
    requestId: 1,
    epoch: 1,
    result: 'applied',
  })

  messages.length = 0
  host.handleMessage({ version: 1, type: 'transport', requestId: 2, epoch: 1, running: true, frame: 2_048 })
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 2 }))

  const runningOutput = [[new Float32Array(8), new Float32Array(8)]]
  host.process([], runningOutput)
  expect(Array.from(runningOutput[0][0])).toEqual(Array.from(new Float32Array(8).fill(0.25)))
  expect(Array.from(runningOutput[0][1])).toEqual(Array.from(new Float32Array(8).fill(-0.125)))
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 2 }))

  host.process([], [[new Float32Array(8), new Float32Array(8)]])
  expect(messages).toContainEqual({
    version: 1,
    type: 'transport-applied',
    requestId: 2,
    epoch: 1,
    result: 'applied',
  })
})

test('the v2 host lets the latest successful transport command supersede a pending acknowledgement', async () => {
  const calls: [number, number, bigint][] = []
  const { host, messages } = await createTransportHost((epoch, running, frame) => {
    calls.push([epoch, running, frame])
    return 0
  })

  host.handleMessage({ version: 1, type: 'transport', requestId: 1, epoch: 1, running: false, frame: 0 })
  host.handleMessage({ version: 1, type: 'transport', requestId: 2, epoch: 1, running: true, frame: 128 })

  expect(calls).toEqual([[1, 0, 0n], [1, 1, 128n]])
  expect(messages).toContainEqual({
    version: 1,
    type: 'transport-applied',
    requestId: 1,
    epoch: 1,
    result: 'rejected',
  })
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 2 }))
  expect(host.transportEpoch).toBe(1)
  expect(host.transportRunning).toBe(true)
  expect(host.transportFrame).toBe(128)
  expect(host.pendingTransportRequestId).toBe(2)

  host.process([], [[new Float32Array(8), new Float32Array(8)]])
  host.process([], [[new Float32Array(8), new Float32Array(8)]])
  expect(messages).toContainEqual({
    version: 1,
    type: 'transport-applied',
    requestId: 2,
    epoch: 1,
    result: 'applied',
  })
})

test('the v2 host preserves a pending transport when a newer core command fails', async () => {
  let callCount = 0
  const { host, messages } = await createTransportHost(() => {
    callCount += 1
    return callCount === 1 ? 0 : 1
  })

  host.handleMessage({ version: 1, type: 'transport', requestId: 1, epoch: 1, running: false, frame: 64 })
  host.handleMessage({ version: 1, type: 'transport', requestId: 2, epoch: 2, running: true, frame: 256 })

  expect(messages).toContainEqual({
    version: 1,
    type: 'transport-applied',
    requestId: 2,
    epoch: 2,
    result: 'rejected',
  })
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 1 }))
  expect(host.transportEpoch).toBe(1)
  expect(host.transportRunning).toBe(false)
  expect(host.transportFrame).toBe(64)
  expect(host.pendingTransportRequestId).toBe(1)
  expect(host.pendingTransportEpoch).toBe(1)

  host.process([], [[new Float32Array(8), new Float32Array(8)]])
  host.process([], [[new Float32Array(8), new Float32Array(8)]])
  expect(messages).toContainEqual({
    version: 1,
    type: 'transport-applied',
    requestId: 1,
    epoch: 1,
    result: 'applied',
  })
})

test('the portable host captures bounded planar PCM only when explicitly configured', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: PortableWasmStatusMessage) => messages.push(message),
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

test('the actual portable Wasm host renders built-in effects without native hooks', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: PortableWasmStatusMessage) => messages.push(message),
    close: () => undefined,
  })
  const wasmBytes = await Bun.file(wasmUrl).arrayBuffer()
  expect(await host.initialize({ wasmBytes, contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)

  const utilityState = new Uint8Array(40)
  const utilityView = new DataView(utilityState.buffer)
  utilityView.setUint32(0, 1, true)
  utilityView.setFloat32(4, 6, true)
  utilityView.setFloat32(24, 1, true)
  host.handleMessage({
    version: 1,
    type: 'prepare-graph',
    requestId: 1,
    snapshot: {
      version: 1,
      revision: 1,
      masterNodeId: 'master',
      nodes: [
        {
          id: 'track',
          kind: 'source',
          inputLayout: 'stereo',
          outputLayout: 'stereo',
          latencyFrames: 0,
          processorOrder: [{
            id: 'track-terminal',
            instanceId: 31,
            kind: 'utility',
            kindId: 1,
            stateVersion: 1,
            state: utilityState,
            parameterTargets: [],
            bypassed: false,
            latencyFrames: 0,
            tailFrames: 0,
          }],
          mixer: { instanceId: 1, gain: 1, pan: 0, muted: false, soloed: false },
        },
        {
          id: 'master',
          kind: 'master',
          inputLayout: 'stereo',
          outputLayout: 'stereo',
          latencyFrames: 0,
          processorOrder: [],
          mixer: { instanceId: 2, gain: 1, pan: 0, muted: false, soloed: false },
        },
      ],
      edges: [{
        version: 1,
        id: 'track-master',
        fromNodeId: 'track',
        toNodeId: 'master',
        gain: 1,
        tap: 'post-fader',
        sidechain: false,
        pdcDelayFrames: 0,
      }],
      assets: [],
    },
  })

  expect(messages).toContainEqual({
    version: 1,
    type: 'graph-prepared',
    requestId: 1,
    revision: 1,
    result: 'prepared',
  })
  host.handleMessage({ version: 1, type: 'publish-graph', requestId: 2, revision: 1 })
  expect(messages).toContainEqual({
    version: 1,
    type: 'graph-published',
    requestId: 2,
    revision: 1,
    result: 'published',
  })
  expect(messages).toContainEqual({
    version: 1,
    type: 'graph-continuity',
    revision: 1,
    result: 'accepted',
  })
  const left = new Float32Array([1])
  const right = new Float32Array([1])
  const outputLeft = new Float32Array(1)
  const outputRight = new Float32Array(1)
  host.process([[left, right]], [[outputLeft, outputRight]])
  expect(outputLeft[0]).toBeCloseTo(1.995, 3)
  expect(outputRight[0]).toBeCloseTo(1.995, 3)
})

test('the portable host drains one block per acknowledgement before finalizing', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: PortableWasmStatusMessage) => messages.push(message),
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
  expect(messages.filter((message) => message.type === 'recording-capture-block')).toHaveLength(1)
  expect(messages).not.toContainEqual(expect.objectContaining({
    type: 'recording-capture-applied',
    action: 'finalized',
  }))

  host.handleMessage({ version: 1, type: 'recording-capture-drain' })
  expect(messages.filter((message) => message.type === 'recording-capture-block')).toHaveLength(2)
  expect(messages).toContainEqual(expect.objectContaining({
    type: 'recording-capture-applied',
    action: 'finalized',
  }))
})

test('installed schedules advance bounded cursors across half-open blocks and seeks', async () => {
  const { DawPortableAudioCoreHost } = await import(hostUrl.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: PortableWasmStatusMessage) => messages.push(message),
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
