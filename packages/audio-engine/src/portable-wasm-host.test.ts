import { expect, test } from 'bun:test'
import type { PortableWasmControlMessage, PortableWasmStatusMessage } from './portable-wasm-protocol'
import { mixerParameterRegistry, type AudioCoreGraphSnapshot, type AudioCoreInstrumentState } from '@daw-browser/audio-core-contract'

const hostUrl = new URL('../../../public/audio-worklets/daw-portable-audio-core-host-v1.js', import.meta.url)
const hostV2Url = new URL('../../../public/audio-worklets/daw-portable-audio-core-host-v2.js', import.meta.url)
const wasmUrl = new URL('../../../native/build/audio-core-wasm/audio-core/daw-audio-core-wasm.wasm', import.meta.url)
type InstrumentHostStatus = Omit<Extract<PortableWasmStatusMessage, { type: 'instrument-events-applied' }>, 'version'> & { version: number }
type HostControl<Type extends PortableWasmControlMessage['type']> = Omit<Extract<PortableWasmControlMessage, { type: Type }>, 'version'> & { version: number }

test('both hosts preserve a full scheduled block and acknowledge live parameters only after rendering', async () => {
  for (const version of [1, 2]) {
    const { DawPortableAudioCoreHost } = await import(version === 1 ? hostUrl.href : hostV2Url.href)
    const messages: Array<PortableWasmStatusMessage | InstrumentHostStatus> = []
    const host = new DawPortableAudioCoreHost({
      sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined,
    })
    Object.assign(host, {
      ready: true, revision: 1, maxFramesPerBlock: 128, transportEpoch: 1,
      memory: { buffer: new ArrayBuffer(65536) }, malloc: () => 8, free: () => undefined,
      graphSetTransport: () => 0,
      inputPlanes: Array.from({ length: 128 }, () => new Float32Array(128)),
      leftOutput: new Float32Array(128), rightOutput: new Float32Array(128),
      eventOffset: 1,
      eventBufferView: new DataView(new ArrayBuffer(4)),
    })
    host.handleMessage({ version, type: 'instrument-parameters', requestId: 7, revision: 1, sequence: 1, epoch: 1,
      events: [{ nodeId: 'track', type: 'parameter', noteId: 1, sequence: 1, frameOffset: 0, channel: 0, note: 3, value: 913 }] })
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'instrument-events-applied' }))
    Object.assign(host, {
      schedule: { transportEpoch: 1, revision: 1 },
      scheduleEventView: new DataView(new ArrayBuffer(4 + 256 * 20)),
      scheduleInstrumentEventView: new DataView(new ArrayBuffer(4 + 256 * 48)),
      scheduleParameterStreams: [],
      scheduleInstrumentEvents: Array.from({ length: 512 }, (_, index) => ({
        frame: index < 256 ? 0 : 128, nodeId: 1n, noteId: BigInt(index + 1), sequence: BigInt(index + 1), type: 1, pitch: 60, value: 1,
      })),
    })
    const rendered: number[] = []
    let notes = 0
    host.coreProcess = () => {
      const view = host.scheduleInstrumentEventView
      for (let index = 0; index < view.getUint32(0, true); index += 1) {
        if (view.getUint32(4 + index * 48 + 32, true) === 5) rendered.push(view.getFloat32(4 + index * 48 + 44, true))
        else notes += 1
      }
      return 0
    }
    host.transportRunning = true
    host.process([], [[new Float32Array(128), new Float32Array(128)]])
    expect(notes).toBe(256)
    expect(rendered).toEqual([])
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'instrument-events-applied', result: 'applied' }))
    host.process([], [[new Float32Array(128), new Float32Array(128)]])
    expect(rendered).toEqual([913])
    host.process([], [[new Float32Array(128), new Float32Array(128)]])
    expect(notes).toBe(512)
    expect(rendered).toEqual([913])
    expect(host.framesProcessed).toBe(384)
    expect(messages).toContainEqual({ version, type: 'instrument-events-applied', requestId: 7, revision: 1, epoch: 1, sequence: 1, result: 'applied' })
  }
})

test('both hosts replay pending and applied parameter values under a new epoch', async () => {
  for (const version of [1, 2]) {
    const { DawPortableAudioCoreHost } = await import(version === 1 ? hostUrl.href : hostV2Url.href)
    const messages: Array<PortableWasmStatusMessage | InstrumentHostStatus> = []
    const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
    Object.assign(host, { ready: true, revision: 1, maxFramesPerBlock: 128, transportEpoch: 1,
      memory: { buffer: new ArrayBuffer(65536) }, malloc: () => 8, free: () => undefined, graphSetTransport: () => 0 })
    host.handleMessage({ version, type: 'instrument-parameters', requestId: 8, revision: 1, sequence: 2, epoch: 1,
      events: [{ nodeId: 'track', type: 'parameter', noteId: 1, sequence: 2, frameOffset: 0, channel: 0, note: 3, value: 913 }] })
    host.handleMessage({ version, type: 'transport', requestId: 9, epoch: 2, running: true, frame: 0 })
    expect(host.instrumentEventView.getUint32(28, true)).toBe(2)
    expect(host.instrumentEventView.getFloat32(48, true)).toBe(913)
    expect(messages).toContainEqual({ version, type: 'instrument-events-applied', requestId: 8, revision: 1, epoch: 1, sequence: 2, result: 'rejected' })
    Object.assign(host, {
      eventOffset: 1, eventBufferView: new DataView(new ArrayBuffer(4)),
      inputPlanes: Array.from({ length: 128 }, () => new Float32Array(128)),
      leftOutput: new Float32Array(128), rightOutput: new Float32Array(128),
    })
    const epochs: number[] = []
    host.coreProcess = () => {
      if (host.instrumentEventByteCount > 4) {
        const deliveredEpoch = host.instrumentEventView.getUint32(28, true)
        if (deliveredEpoch !== host.transportEpoch) return 1
        epochs.push(deliveredEpoch)
      }
      return 0
    }
    host.process([], [[new Float32Array(128), new Float32Array(128)]])
    host.process([], [[new Float32Array(128), new Float32Array(128)]])
    host.handleMessage({ version, type: 'transport', requestId: 10, epoch: 3, running: true, frame: 256 })
    host.process([], [[new Float32Array(128), new Float32Array(128)]])
    expect(epochs).toEqual([2, 3])
    expect(host.instrumentEventByteCount).toBe(0)
  }
})

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
  const statuses: unknown[] = []
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
    const protocolVersion = hostUrlToUse === hostV2Url ? 2 : 1
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
      version: protocolVersion,
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
      version: protocolVersion,
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

  host.handleMessage({ version: 2, type: 'transport', requestId: 1, epoch: 1, running: false, frame: 2_048 })
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 1 }))

  const firstOutput = [[new Float32Array(8), new Float32Array(8)]]
  host.process([], firstOutput)
  expect(Array.from(firstOutput[0][0])).toEqual(Array.from(new Float32Array(8)))
  expect(Array.from(firstOutput[0][1])).toEqual(Array.from(new Float32Array(8)))
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 1 }))

  host.process([], [[new Float32Array(8), new Float32Array(8)]])
  expect(messages).toContainEqual({
    version: 2,
    type: 'transport-applied',
    requestId: 1,
    epoch: 1,
    result: 'applied',
  })

  messages.length = 0
  host.handleMessage({ version: 2, type: 'transport', requestId: 2, epoch: 1, running: true, frame: 2_048 })
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 2 }))

  const runningOutput = [[new Float32Array(8), new Float32Array(8)]]
  host.process([], runningOutput)
  expect(Array.from(runningOutput[0][0])).toEqual(Array.from(new Float32Array(8).fill(0.25)))
  expect(Array.from(runningOutput[0][1])).toEqual(Array.from(new Float32Array(8).fill(-0.125)))
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'transport-applied', requestId: 2 }))

  host.process([], [[new Float32Array(8), new Float32Array(8)]])
  expect(messages).toContainEqual({
    version: 2,
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

  host.handleMessage({ version: 2, type: 'transport', requestId: 1, epoch: 1, running: false, frame: 0 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 2, epoch: 1, running: true, frame: 128 })

  expect(calls).toEqual([[1, 0, 0n], [1, 1, 128n]])
  expect(messages).toContainEqual({
    version: 2,
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
    version: 2,
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

  host.handleMessage({ version: 2, type: 'transport', requestId: 1, epoch: 1, running: false, frame: 64 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 2, epoch: 2, running: true, frame: 256 })

  expect(messages).toContainEqual({
    version: 2,
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
    version: 2,
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

  expect(messages).toContainEqual(expect.objectContaining({
    version: 1,
    type: 'graph-prepared',
    requestId: 1,
    revision: 1,
    result: 'prepared',
  }))
  host.handleMessage({ version: 1, type: 'publish-graph', requestId: 2, revision: 1 })
  expect(messages).toContainEqual(expect.objectContaining({
    version: 1,
    type: 'graph-published',
    requestId: 2,
    revision: 1,
    result: 'published',
  }))
  expect(messages).toContainEqual(expect.objectContaining({
    version: 1,
    type: 'graph-continuity',
    revision: 1,
    result: 'accepted',
  }))
  host.handleMessage({ version: 1, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  playConstantSources(host, messages, 1, 1, [{ nodeId: 'track', value: 1 }])
  const outputLeft = new Float32Array(1)
  const outputRight = new Float32Array(1)
  host.process([], [[outputLeft, outputRight]])
  expect(outputLeft[0]).toBeCloseTo(1.995, 3)
  expect(outputRight[0]).toBeCloseTo(1.995, 3)
})

const portableMixerTargets = [
  { id: 'mixer.gain', target: 26, minValue: 0, maxValue: 4 },
  { id: 'mixer.pan', target: 27, minValue: -1, maxValue: 1 },
  { id: 'mixer.mute', target: 28, minValue: 0, maxValue: 1 },
  { id: 'mixer.solo', target: 29, minValue: 0, maxValue: 1 },
]
const portableTrackGraph = (trackIds: readonly string[]) => ({
  version: 1,
  revision: 1,
  masterNodeId: 'master',
  assets: [],
  nodes: [
    ...trackIds.map((id, index) => ({
      id, kind: 'source', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: [],
      mixer: { instanceId: 100 + index, gain: 1, pan: 0, muted: false, soloed: false, parameterTargets: portableMixerTargets },
    })),
    {
      id: 'master', kind: 'master', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: [],
      mixer: { instanceId: 900, gain: 1, pan: 0, muted: false, soloed: false, parameterTargets: portableMixerTargets },
    },
  ],
  edges: trackIds.map((id) => ({
    version: 1, id: `${id}-master`, fromNodeId: id, toNodeId: 'master', gain: 1, tap: 'post-fader', sidechain: false, pdcDelayFrames: 0,
  })),
})
const startPortableTracks = async (trackIds: readonly string[]) => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: PortableWasmStatusMessage) => messages.push(message),
    close: () => undefined,
  })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: portableTrackGraph(trackIds) })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'graph-prepared', requestId: 1, result: 'prepared' }))
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'graph-published', requestId: 2, result: 'published' }))
  return { host, messages }
}
// Plays a constant on each listed source through a registered PCM asset and a
// scheduled sample source, as the product feeds clips: portable sources never
// read the worklet's live input.
const playConstantSources = (
  host: { handleMessage: (message: HostControl<'register-asset'> | HostControl<'schedule-sources'>) => void },
  messages: readonly PortableWasmStatusMessage[],
  version: number,
  revision: number,
  sources: ReadonlyArray<{ nodeId: string, value: number }>,
) => {
  const frames = 48_000
  const requestId = 1_000 + revision
  for (const { value } of sources) host.handleMessage({
    version, type: 'register-asset', requestId, generation: 0,
    asset: { version: 1, assetId: `constant-${value}`, frameCount: frames, sampleRateHz: 48_000, channelCount: 2 },
    planes: [new Float32Array(frames).fill(value), new Float32Array(frames).fill(value)],
  })
  host.handleMessage({ version, type: 'schedule-sources', requestId, revision, epoch: 1, events: sources.map(({ nodeId, value }, index) => ({
    version: 1, epoch: 1, sequence: index + 1, sourceNodeId: nodeId, assetId: `constant-${value}`,
    startFrame: 0, stopFrame: frames, sourceOffsetFrame: 0, sourceFrameCount: frames, gain: 1,
    fadeInStartFrame: 0, fadeInEndFrame: 0, fadeOutStartFrame: frames, fadeOutEndFrame: frames,
  })) })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'sources-scheduled', requestId, result: 'scheduled' }))
}

test('the v2 host prepares and renders one source per audio track on the built core', async () => {
  for (const trackCount of [1, 2, 3, 8]) {
    const trackIds = Array.from({ length: trackCount }, (_, index) => `track-${index}`)
    const { host, messages } = await startPortableTracks(trackIds)
    host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
    playConstantSources(host, messages, 2, 1, [{ nodeId: trackIds[trackCount - 1], value: 0.5 }])
    const left = new Float32Array(1)
    const right = new Float32Array(1)
    host.process([], [[left, right]])
    expect([trackCount, left[0], right[0]]).toEqual([trackCount, 0.5, 0.5])
  }
})

test('the v2 host hears the recording input once, only when monitoring, and still captures it on the built core', async () => {
  const heard: unknown[] = []
  for (const trackCount of [1, 3]) {
    for (const monitoring of [false, true]) {
      const trackIds = Array.from({ length: trackCount }, (_, index) => `track-${index}`)
      const { host, messages } = await startPortableTracks(trackIds)
      host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
      playConstantSources(host, messages, 2, 1, [{ nodeId: trackIds[trackCount - 1], value: 0.5 }])
      host.handleMessage({
        version: 2, type: 'recording-capture-configure', generation: 1, sessionId: 7, channelCount: 1, inputChannels: [0],
        gain: 1, polarity: 1, monitoring, punchStartFrame: 0, punchEndFrame: null,
      })
      expect(messages).toContainEqual(expect.objectContaining({ type: 'recording-capture-applied', action: 'configured' }))
      const left = new Float32Array(8)
      const right = new Float32Array(8)
      // The worklet node has one input, which carries the microphone; a mono capture monitors on the left.
      host.process([[new Float32Array(8).fill(0.25)]], [[left, right]])
      heard.push([trackCount, monitoring, [...new Set(left)], [...new Set(right)]])
      host.handleMessage({ version: 2, type: 'recording-capture-finalize', stopFrame: 8 })
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'recording-capture-block', sessionId: 7, frameCount: 8, planes: [new Float32Array(8).fill(0.25)],
      }))
    }
  }
  expect(heard).toEqual([
    [1, false, [0.5], [0.5]], [1, true, [0.75], [0.5]],
    [3, false, [0.5], [0.5]], [3, true, [0.75], [0.5]],
  ])
})

test('the v2 host holds a scheduled mixer set-point across blocks on the built core', async () => {
  const { host, messages } = await startPortableTracks(['track'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    version: 1, revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 },
    events: [{ frame: 2, sequence: 1, type: 'parameter-set', target: { kind: 'parameter', scope: 'track', trackId: 'track', parameterId: 'mixer.gain' }, value: 0.25 }],
  } })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'schedule-installed', result: 'installed' }))
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'track', value: 1 }])
  const render = () => {
    const left = new Float32Array(8)
    host.process([], [[left, new Float32Array(8)]])
    return Array.from(left)
  }
  expect(render()).toEqual([1, 1, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25])
  expect(render()).toEqual(Array.from({ length: 8 }, () => 0.25))
  expect(render()).toEqual(Array.from({ length: 8 }, () => 0.25))
})

test('the v2 host ramps a product mute, unmute and solo flip published while playing on the built core', async () => {
  const trackIds = ['track-0', 'track-1']
  const { host, messages } = await startPortableTracks(trackIds)
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  let revision = 1
  const installSchedule = () => {
    host.handleMessage({ version: 2, type: 'install-schedule', requestId: revision * 2 + 2, schedule: {
      version: 1, revision, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [],
    } })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'schedule-installed', revision, result: 'installed' }))
  }
  installSchedule()
  playConstantSources(host, messages, 2, 1, trackIds.map((nodeId) => ({ nodeId, value: 1 })))
  const fade = 240
  const composite = (2 * fade - 1) / (fade * fade)
  let previous = 2
  const render = () => {
    const left = new Float32Array(128)
    host.process([], [[left, new Float32Array(128)]])
    return Array.from(left)
  }
  // Each track as the product compiles it (resolve-routing.ts): a mute zeroes the
  // fader and the output edge; a solo elsewhere zeroes only the output edge.
  const publish = (tracks: ReadonlyArray<{ gain: number, muted: boolean, edgeGain: number }>, target: number, bound: number) => {
    revision += 1
    const graph = portableTrackGraph(trackIds)
    const snapshot = {
      ...graph,
      revision,
      nodes: graph.nodes.map((node, index) => index < tracks.length
        ? { ...node, mixer: { ...node.mixer, gain: tracks[index].gain, muted: tracks[index].muted } } : node),
      edges: graph.edges.map((edge, index) => ({ ...edge, gain: tracks[index].edgeGain })),
    }
    host.handleMessage({ version: 2, type: 'prepare-graph', requestId: revision * 2, snapshot })
    host.handleMessage({ version: 2, type: 'publish-graph', requestId: revision * 2 + 1, revision })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'graph-published', revision, result: 'published' }))
    installSchedule()
    const samples = [...render(), ...render()]
    let step = 0
    for (const sample of samples) {
      step = Math.max(step, Math.abs(sample - previous))
      previous = sample
    }
    expect([revision, step <= bound + 1e-6 ? 'within bound' : step, samples[fade - 1], samples.at(-1)])
      .toEqual([revision, 'within bound', target, target])
    expect(render()).toEqual(Array.from({ length: 128 }, () => target))
  }
  expect(render()).toEqual(Array.from({ length: 128 }, () => 2))
  const open = { gain: 1, muted: false, edgeGain: 1 }
  publish([{ gain: 0, muted: true, edgeGain: 0 }, open], 1, composite)
  publish([open, open], 2, composite)
  publish([open, { ...open, edgeGain: 0 }], 1, 1 / fade)
  publish([open, open], 2, 1 / fade)
  publish([open, { ...open, edgeGain: 0.5 }], 1.5, 0.5 / fade)
  publish([open, { ...open, edgeGain: 0.25 }], 1.25, 0.25 / fade)
})

test('the v2 host keeps rendering a published revision whose schedule has not arrived on the built core', async () => {
  const { host, messages } = await startPortableTracks(['track'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    version: 1, revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [],
  } })
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 5, snapshot: { ...portableTrackGraph(['track']), revision: 2 } })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 6, revision: 2 })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'graph-published', revision: 2, result: 'published' }))
  playConstantSources(host, messages, 2, 2, [{ nodeId: 'track', value: 0.5 }])
  const results: number[] = []
  const coreProcess = host.coreProcess
  host.coreProcess = (...args: unknown[]) => {
    const result = coreProcess(...args)
    results.push(result)
    return result
  }
  const render = () => {
    const left = new Float32Array(128)
    host.process([], [[left, new Float32Array(128)]])
    return Array.from(left)
  }
  const blocks = [render(), render(), render()]
  expect([results, blocks.map((block) => block.filter((sample) => sample === 0.5).length)]).toEqual([[0, 0, 0], [128, 128, 128]])
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

// An adoption publish (requireContinuity) on the same playing core, as the portable controller sends it: prepare the
// next revision, stage its schedule, then publish. Nothing renders between the three messages.
type HostSchedule = HostControl<'install-schedule'>['schedule']
type HostScheduleEvent = HostSchedule['events'][number]
type AdoptionMessage =
  | { version: number; type: 'prepare-graph'; requestId: number; snapshot: { revision: number } }
  | { version: number; type: 'install-schedule'; requestId: number; schedule: HostSchedule }
  | { version: number; type: 'publish-graph'; requestId: number; revision: number; requireContinuity: true }
const adoptRevision = <Snapshot extends { revision: number }>(
  host: { handleMessage: (message: AdoptionMessage) => void },
  messages: readonly PortableWasmStatusMessage[],
  snapshot: Snapshot,
  events: readonly HostScheduleEvent[],
) => {
  const revision = snapshot.revision
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: revision * 10, snapshot })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'graph-prepared', requestId: revision * 10, result: 'prepared' }))
  const schedule: HostSchedule = { revision, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events }
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: revision * 10 + 1, schedule })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: revision * 10 + 2, revision, requireContinuity: true })
  return {
    installed: messages.flatMap((message) => message.type === 'schedule-installed' && message.requestId === revision * 10 + 1 ? [message.result] : [])[0],
    published: messages.flatMap((message) => message.type === 'graph-published' && message.requestId === revision * 10 + 2 ? [message.result] : [])[0],
  }
}
const renderLeft = (host: { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean }, frames = 128) => {
  const left = new Float32Array(frames)
  host.process([], [[left, new Float32Array(frames)]])
  return Array.from(left)
}
const gainSet = (frame: number, sequence: number, value: number, trackId = 'track'): HostScheduleEvent => ({
  frame, sequence, type: 'parameter-set', target: { kind: 'parameter', scope: 'track', trackId, parameterId: 'mixer.gain' }, value,
})

test('B6f5 the v2 host swaps a schedule staged for the prepared revision in at an adoption publish on the built core', async () => {
  const { host, messages } = await startPortableTracks(['track'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [gainSet(256, 1, 0.5)],
  } })
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'track', value: 1 }])
  const first = renderLeft(host)
  const adoption = adoptRevision(host, messages, { ...portableTrackGraph(['track']), revision: 2 }, [gainSet(256, 1, 0.25)])
  // The old schedule never plays under the new revision and the new one lands at its frame.
  expect([adoption, new Set(first), new Set(renderLeft(host)), new Set(renderLeft(host))])
    .toEqual([{ installed: 'installed', published: 'published' }, new Set([1]), new Set([1]), new Set([0.25])])
})

// Two tracks fade in opposite directions while a third drops its gain, all through the one 256-event block the core takes.
// Per-frame ramps would need 128 events each (256 for the two) plus the set: 257, which silenced the block. Each block must
// stay audible and within one block's slope of the ideal sum, and the fades must land exactly.
const rampGain = (trackId: string, sequence: number, startFrame: number, endFrame: number, startValue: number, endValue: number): HostScheduleEvent => ({
  frame: startFrame, sequence, type: 'parameter-ramp', target: { kind: 'parameter', scope: 'track', trackId, parameterId: 'mixer.gain' },
  startFrame, endFrame, interpolation: 'linear', startValue, endValue,
})
const playRamps = async (events: readonly HostScheduleEvent[]) => {
  const { host, messages } = await startPortableTracks(['a', 'b', 'c'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events } })
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'a', value: 1 }, { nodeId: 'b', value: 0.5 }, { nodeId: 'c', value: 0.25 }])
  return Array.from({ length: 12 }, () => renderLeft(host))
}
// The sources hold 1, 0.5 and 0.25. a's gain falls from 1 to 0 over ten blocks and b's rises from 0 to 1 over five; c's holds 1
// until `cDropFrame` and is 0.5 from there.
const rampedSum = (frame: number, cDropFrame: number) =>
  (1 - Math.min(frame / 1280, 1)) + 0.5 * Math.min(frame / 640, 1) + 0.25 * (frame < cDropFrame ? 1 : 0.5)
const rampEvents = [rampGain('a', 1, 0, 1280, 1, 0), rampGain('b', 2, 0, 640, 0, 1)]
const rampsStayAudibleAndLand = (blocks: readonly number[][], cDropFrame: number) => [
  Math.max(...blocks.flatMap((block, index) => block.map((sample, frame) => Math.abs(sample - rampedSum(index * 128 + frame, cDropFrame))))) < 0.21,
  blocks.every((block) => Math.min(...block.map(Math.abs)) > 0.3),
  blocks.at(-1)?.every((sample) => Math.abs(sample - rampedSum(12 * 128, cDropFrame)) < 1e-5),
]

test('B6f5 phase 6i two overlapping gain ramps stay audible and land exactly on the built core', async () => {
  expect(rampsStayAudibleAndLand(await playRamps(rampEvents), Infinity)).toEqual([true, true, true])
})

test('B6f5 phase 6i two ramps and a gain set in one block (257 events) keep the block audible on the built core', async () => {
  expect(rampsStayAudibleAndLand(await playRamps([...rampEvents, gainSet(3 * 128, 3, 0.5, 'c')]), 3 * 128)).toEqual([true, true, true])
})

test('B6f5 the v2 host refuses an adoption publish the core cannot continue and keeps rendering on the built core', async () => {
  const { host, messages } = await startPortableTracks(['track'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [],
  } })
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'track', value: 0.5 }])
  renderLeft(host)
  const graph = portableTrackGraph(['track'])
  // A latency change is a revision the core reports as `fallback`: it cannot continue the playing graph.
  const adoption = adoptRevision(host, messages, { ...graph, revision: 2, nodes: graph.nodes.map((node) => node.id === 'track' ? { ...node, latencyFrames: 64 } : node) }, [])
  const results: number[] = []
  const coreProcess = host.coreProcess
  host.coreProcess = (...args: number[]) => {
    const result = coreProcess(...args)
    results.push(result)
    return result
  }
  const blocks = [renderLeft(host), renderLeft(host)]
  expect([adoption.published, messages.findLast((message) => message.type === 'graph-continuity')?.result, host.revision, results,
    blocks.map((block) => block.every((sample) => sample === 0.5))]).toEqual(['rejected', 'fallback', 1, [0, 0], [true, true]])
})

test('B6f5 the v2 host keeps a pending live acknowledgement across an adoption publish on the built core', async () => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  const utilityState = new Uint8Array(40)
  const utilityView = new DataView(utilityState.buffer)
  utilityView.setUint32(0, 1, true)
  utilityView.setFloat32(24, 1, true)
  const base = portableTrackGraph(['track'])
  const graph = (revision: number) => ({ ...base, revision, nodes: base.nodes.map((node) => node.id === 'track' ? { ...node, processorOrder: [{
    id: 'track-utility', instanceId: 31, kind: 'utility', kindId: 1, stateVersion: 1, state: utilityState,
    parameterTargets: [{ id: 'gainDb', target: 1 }], bypassed: false, latencyFrames: 0, tailFrames: 0,
  }] } : node) })
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph(1) })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [],
  } })
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'track', value: 1 }])
  renderLeft(host)
  // A knob edit posted before the adoption, acknowledged only once a block renders it.
  host.handleMessage({ version: 2, type: 'processor-events', requestId: 9, revision: 1, epoch: 1, sequence: 1,
    events: [{ processorInstanceId: 31, parameterTarget: 1, frameOffset: 0, value: -6 }] })
  const adoption = adoptRevision(host, messages, graph(2), [])
  const acknowledgedBeforeRender = messages.filter((message) => message.type === 'processor-events-applied').map((message) => message.result)
  const blocks = [renderLeft(host), renderLeft(host), renderLeft(host)]
  expect([adoption.published, acknowledgedBeforeRender,
    messages.filter((message) => message.type === 'processor-events-applied').map((message) => message.result)])
    .toEqual(['published', [], ['applied']])
  expect(blocks[2].at(-1)).toBeCloseTo(10 ** (-6 / 20), 3)
})

test('B6f5 the v2 host seeds a held automation value at an adoption publish on the built core', async () => {
  const { host, messages } = await startPortableTracks(['track'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [gainSet(0, 1, 0.25)],
  } })
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'track', value: 1 }])
  const held = [renderLeft(host), renderLeft(host)]
  // The same envelope compiled at the same time origin: its hold point is in the past when the swap happens.
  const adoption = adoptRevision(host, messages, { ...portableTrackGraph(['track']), revision: 2 }, [gainSet(0, 1, 0.25)])
  const after = [renderLeft(host), renderLeft(host), renderLeft(host)]
  expect([adoption, held.map((block) => [...new Set(block)]), after.map((block) => [...new Set(block)])])
    .toEqual([{ installed: 'installed', published: 'published' }, [[0.25], [0.25]], [[0.25], [0.25], [0.25]]])
})

test('B6f5 a sounding Synth note survives an adoption publish and ends at its note-off on the built core', async () => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  const synth = heldSynth
  const base = portableTrackGraph(['track'])
  const graph = (revision: number) => ({ ...base, revision, nodes: base.nodes.map((node) => node.id === 'track'
    ? { ...node, kind: 'instrument', instrument: synth } : node) })
  // Note-on before the adoption, note-off after it, as the schedule compiled at the active time origin carries them.
  const notes: HostScheduleEvent[] = [
    { frame: 0, sequence: 1, type: 'note-on', target: { kind: 'instrument', trackId: 'track' }, noteId: 1, pitch: 72, velocity: 0.8 },
    { frame: 2048, sequence: 2, type: 'note-off', target: { kind: 'instrument', trackId: 'track' }, noteId: 1, pitch: 72 },
  ]
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph(1) })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: notes,
  } })
  const peak = (block: number[]) => Math.max(...block.map(Math.abs))
  const before = Array.from({ length: 4 }, () => peak(renderLeft(host)))
  const adoption = adoptRevision(host, messages, graph(2), notes)
  const sounding = Array.from({ length: 11 }, () => peak(renderLeft(host)))
  const released = Array.from({ length: 4 }, () => peak(renderLeft(host)))
  const level = before.at(-1) ?? 0
  expect([adoption, level > 0.1, sounding.every((value) => Math.abs(value - level) < level * 0.25), released.at(-1)])
    .toEqual([{ installed: 'installed', published: 'published' }, true, true, 0])
})

// Phase 6i. An instrument edit that is not live replaces the instrument at an adoption publish. Each case runs the edit
// against a reference that played the edited configuration from the start, with the same notes held from frame 0, and the
// output must equal it once the 5 ms replacement crossfade (two 128-frame blocks) is over. 1e-4 is the tolerance the core
// witnesses settle to; the portable path has no shared parity constant. Granular is held to a looser rule (the cloud keeps
// sounding), since its grains are scattered.
const heldNoteKeys = [48, 49, 50, 51, 52, 53, 54, 55]
const sineFrames = 48_000
const heldSynth: Extract<AudioCoreInstrumentState, { kind: 'synth' }> = {
  version: 1, kind: 'synth', voiceCapacity: 8, outputLayout: 'stereo', parameterTargets: [],
  oscillators: [
    { enabled: true, waveform: 0, level: 0.8, octave: 0, semitone: 0, detuneCents: 0 },
    { enabled: false, waveform: 0, level: 0, octave: 0, semitone: 0, detuneCents: 0 },
  ],
  noiseEnabled: false, noiseLevel: 0, filterEnabled: false, filterMode: 0, filterCutoffHz: 4000, filterResonance: 0.7,
  filterKeyTracking: 0, filterEnvelopeAmountOctaves: 0, filterAttackMs: 0, filterDecayMs: 0, filterSustain: 1, filterReleaseMs: 0,
  ampAttackMs: 0, ampDecayMs: 0, ampSustain: 0.8, ampReleaseMs: 1, lfoEnabled: false, lfoWaveform: 0, lfoRateHz: 1,
  lfoPitchCents: 0, lfoFilterOctaves: 0, lfoAmplitude: 0, lfoPan: 0, outputGain: 0.8, outputPan: 0,
}
const heldSampler = (
  kind: 'sampler' | 'drum-rack', zoneGain: number, voiceCapacity: number, filterCutoffHz = 8000, filterMode: 'lowpass' | 'highpass' = 'lowpass',
): AudioCoreInstrumentState => ({
  version: 1, kind, voiceCapacity, outputLayout: 'stereo', ampAttackMs: 0, ampDecayMs: 0, ampSustain: 1, ampReleaseMs: 1,
  filterEnabled: false, filterMode, filterCutoffHz, filterResonance: 0.7, filterEnvelopeAmount: 0,
  filterAttackMs: 0, filterDecayMs: 0, filterSustain: 1, filterReleaseMs: 0, lfoEnabled: false, lfoRateHz: 1,
  lfoPitchCents: 0, lfoFilterHz: 0, lfoAmplitude: 0, lfoPan: 0, retrigger: false,
  zones: heldNoteKeys.map((key) => ({
    assetId: 'held-sine', keyLow: key, keyHigh: key, velocityLow: 1, velocityHigh: 127, rootNote: key, tuneCents: 0, gain: zoneGain, pan: 0,
    roundRobinGroup: 0, roundRobinIndex: 0, playbackMode: 'forward-loop', startFrame: 0, endFrame: sineFrames,
    loopStartFrame: 0, loopEndFrame: sineFrames, crossfadeFrameCount: 0, chokeGroup: 0,
  })),
})
// Renders 20 blocks of the first configuration, adopts each later one in turn rendering `blocksPerState` blocks after each
// (a lone configuration renders `blocksPerState` more), with `keys` held from frame 0. Returns the left channel from the first
// publication frame on.
const playDragged = async (
  states: readonly AudioCoreInstrumentState[],
  keys: readonly number[],
  blocksPerState: number,
  liveCutoffs: readonly number[] = [],
) => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  const sine = new Float32Array(sineFrames).map((_, frame) => Math.sin(0.05 * frame))
  host.handleMessage({ version: 2, type: 'register-asset', requestId: 900, generation: 0,
    asset: { version: 1, assetId: 'held-sine', frameCount: sineFrames, sampleRateHz: 48_000, channelCount: 2 }, planes: [sine, sine] })
  const base = portableTrackGraph(['track'])
  const graph = (revision: number, instrument: AudioCoreInstrumentState) => ({ ...base, revision,
    nodes: base.nodes.map((node) => node.id === 'track' ? { ...node, kind: 'instrument', instrument } : node) })
  const notes: HostScheduleEvent[] = keys.map((pitch, index) => ({
    frame: 0, sequence: index + 1, type: 'note-on', target: { kind: 'instrument', trackId: 'track' }, noteId: index + 1, pitch, velocity: 0.8 }))
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph(1, states[0]) })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  expect([states[0].kind, messages.findLast((message) => message.type === 'graph-published')?.result]).toEqual([states[0].kind, 'published'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: notes } })
  for (let block = 0; block < 20; block += 1) renderLeft(host)
  const rendered: number[][] = []
  const renderBlocks = () => { for (let block = 0; block < blocksPerState; block += 1) rendered.push(renderLeft(host)) }
  if (states.length === 1 && liveCutoffs.length === 0) renderBlocks()
  states.slice(1).forEach((state, index) => {
    expect(adoptRevision(host, messages, graph(index + 2, state), notes)).toEqual({ installed: 'installed', published: 'published' })
    renderBlocks()
  })
  // The cutoff is a live target (3): each value is an event at the head of the block, as a knob drag delivers it.
  liveCutoffs.forEach((value, index) => {
    host.handleMessage({ version: 2, type: 'instrument-parameters', requestId: 100 + index, revision: 1, sequence: index + 1, epoch: 1,
      events: [{ nodeId: 'track', type: 'parameter', noteId: 1, sequence: index + 1, frameOffset: 0, channel: 0, note: 3, value }] })
    renderBlocks()
  })
  return rendered.flat()
}
const playHeldNotes = (
  states: readonly [AudioCoreInstrumentState, AudioCoreInstrumentState],
  keys: readonly number[],
  adopt: boolean,
  blocks = 12,
) => playDragged(adopt ? states : [states[0]], keys, blocks)
const settledDeviation = (edited: readonly number[], reference: readonly number[], from = 2 * 128) =>
  Math.max(...edited.slice(from).map((sample, index) => Math.abs(sample - reference[index + from])))
const peakOf = (signal: readonly number[]) => Math.max(...signal.map(Math.abs))

// Discrete edits (a waveform or filter mode no knob can slew) replace the instrument; the values that move in a knob drag
// do not, and have their own cases below.
const heldEditCases: ReadonlyArray<readonly [string, AudioCoreInstrumentState, AudioCoreInstrumentState]> = [
  ['synth', heldSynth, { ...heldSynth, lfoWaveform: 1 }],
  ['sampler', heldSampler('sampler', 1, 8), heldSampler('sampler', 1, 8, 8000, 'highpass')],
  ['drum rack', heldSampler('drum-rack', 1, 8), heldSampler('drum-rack', 1, 8, 8000, 'highpass')],
]

test('B6f5 phase 6i a held note keeps sounding at its phase through an instrument edit that is not live on the built core', async () => {
  for (const [name, before, after] of heldEditCases) {
    const edited = await playHeldNotes([before, after], [52], true)
    const reference = await playHeldNotes([before, after], [52], false)
    expect([name, peakOf(reference) > 0.02, settledDeviation(edited, reference) < 1e-4]).toEqual([name, true, true])
  }
})

test('B6f5 phase 6i polyphony 8 to 2 leaves the two newest voices of the chord on the built core', async () => {
  for (const kind of ['synth', 'sampler', 'drum-rack'] as const) {
    const at = (voiceCapacity: number): AudioCoreInstrumentState => kind === 'synth' ? { ...heldSynth, voiceCapacity } : heldSampler(kind, 1, voiceCapacity)
    const edited = await playHeldNotes([at(8), at(2)], heldNoteKeys, true)
    const newest = await playHeldNotes([at(2), at(2)], heldNoteKeys.slice(-2), false)
    const chord = await playHeldNotes([at(8), at(8)], heldNoteKeys, false)
    expect([kind, settledDeviation(chord, newest) > 0.05, settledDeviation(edited, newest) < 1e-4]).toEqual([kind, true, true])
  }
})

// A zone gain is a value a knob drags: the edit slews onto the held note (about 5 ms per time constant), so it has landed
// once 40 blocks have passed, where a replacement would have settled in two.
test('B6f5 phase 6i a sampler zone gain edit reaches a held note on the built core', async () => {
  const settled = 40 * 128
  for (const kind of ['sampler', 'drum-rack'] as const) {
    const edited = await playHeldNotes([heldSampler(kind, 1, 8), heldSampler(kind, 0.5, 8)], [52], true, 60)
    const reference = await playHeldNotes([heldSampler(kind, 0.5, 8), heldSampler(kind, 0.5, 8)], [52], false, 60)
    const unedited = await playHeldNotes([heldSampler(kind, 1, 8), heldSampler(kind, 1, 8)], [52], false, 60)
    expect([kind, settledDeviation(unedited, reference, settled) > 0.05, settledDeviation(edited, reference, settled) < 1e-4])
      .toEqual([kind, true, true])
  }
})

// Phase 6i, Mechanism B. A drag is a run of publications of one value, a few blocks apart (640 frames, the fastest a pointer
// delivers them). Held to what a steady instrument at any of the dragged values plays: the output may not step by more than
// the steepest slope any of them has, and a gliding pitch may not change its period by more than 2.5% between cycles.
const dragStepBlocks = 5
const dragSettleBlocks = 40
const heldDragKey = 84
const largestStep = (signal: readonly number[]) => Math.max(...signal.slice(1).map((sample, index) => Math.abs(sample - signal[index])))
// The widest ratio between neighbouring cycles, from interpolated upward zero crossings.
const widestPeriodStep = (signal: readonly number[]) => {
  let lastCross = -1
  let lastPeriod = 0
  let widest = 1
  for (let index = 1; index < signal.length; index += 1) {
    if (!(signal[index - 1] < 0 && signal[index] >= 0)) continue
    const cross = index - 1 + -signal[index - 1] / (signal[index] - signal[index - 1])
    if (lastCross >= 0) {
      const period = cross - lastCross
      if (lastPeriod > 0) widest = Math.max(widest, period / lastPeriod, lastPeriod / period)
      lastPeriod = period
    }
    lastCross = cross
  }
  return widest
}
// The values published one after another (the last held for the settle blocks), and what each steady instrument plays over the same span.
// The mean cycle length over the last 20 blocks (a glide has changed the phase, so only the pitch it arrived at is comparable).
const arrivedPeriod = (signal: readonly number[]) => {
  const crosses = signal.flatMap((sample, index) => index >= signal.length - 20 * 128 && signal[index - 1] < 0 && sample >= 0
    ? [index - 1 + -signal[index - 1] / (sample - signal[index - 1])] : [])
  return (crosses[crosses.length - 1] - crosses[0]) / (crosses.length - 1)
}
const dragged = (values: readonly number[], instrument: (value: number) => AudioCoreInstrumentState) => {
  const publications = [...values, ...Array<number>(dragSettleBlocks / dragStepBlocks).fill(values[values.length - 1])]
  return playDragged(publications.map(instrument), [heldDragKey], dragStepBlocks)
}
const steady = (value: number, values: readonly number[], instrument: (value: number) => AudioCoreInstrumentState) =>
  playDragged([instrument(value)], [heldDragKey], dragStepBlocks * (values.length - 1) + dragSettleBlocks)
// Resonance 25 with the cutoff above the tone, so the peak never crosses it.
const cutoffSynth = (filterCutoffHz: number): AudioCoreInstrumentState => ({ ...heldSynth, filterEnabled: true, filterResonance: 25, filterCutoffHz })
const transposedSynth = (semitone: number): AudioCoreInstrumentState => ({
  ...heldSynth, oscillators: [{ ...heldSynth.oscillators[0], semitone }, heldSynth.oscillators[1]] })

// The longest run of exact zeros: what a cloud that went quiet leaves.
const longestSilence = (signal: readonly number[]) => signal.reduce((state, sample) => {
  const run = sample === 0 ? state.run + 1 : 0
  return { run, longest: Math.max(state.longest, run) }
}, { run: 0, longest: 0 }).longest

test('B6f5 phase 6i a granular cloud configures through the host and keeps sounding through a non-live edit on the built core', async () => {
  const granular = (grainWindow: 'hann' | 'tukey'): AudioCoreInstrumentState => ({
    version: 1, kind: 'granular', voiceCapacity: 2, outputLayout: 'stereo', assetId: 'held-sine', seed: 77, maxGrains: 16,
    'windowShape': grainWindow, freeze: false, grainSizeMs: 20, densityHz: 100, position: 0.5, spray: 0.3, pitchSemitones: 0,
    reverseProbability: 0, stereoSpread: 0.3,
  })
  const edited = await playHeldNotes([granular('hann'), granular('tukey')], [60], true)
  const reference = await playHeldNotes([granular('hann'), granular('tukey')], [60], false)
  expect([peakOf(edited) > 0.05, longestSilence(edited) <= longestSilence(reference)]).toEqual([true, true])
})

test('B6f5 phase 6i a cutoff drag through repeated publications does not step beyond the steady instruments on the built core', async () => {
  const cutoffs = [12000, 6000, 3000, 1800]
  const drag = await dragged(cutoffs, cutoffSynth)
  const steepest = Math.max(...await Promise.all(cutoffs.map(async (cutoff) => largestStep(await steady(cutoff, cutoffs, cutoffSynth)))))
  const arrived = await steady(1800, cutoffs, cutoffSynth)
  expect([steepest > 0.01, largestStep(drag) < 1.25 * steepest, settledDeviation(drag, arrived, drag.length - 20 * 128) < 1e-3])
    .toEqual([true, true, true])
})

test('B6f5 phase 6i a cutoff drag through live events does not step beyond the steady instruments on the built core', async () => {
  const cutoffs = [12000, 6000, 3000, 1800]
  const live = (filterCutoffHz: number): AudioCoreInstrumentState => ({
    ...cutoffSynth(filterCutoffHz), parameterTargets: [{ id: 'synth.filterCutoffHz', target: 3 }] })
  const events = [...cutoffs.slice(1), ...Array<number>(dragSettleBlocks / dragStepBlocks).fill(1800)]
  const drag = await playDragged([live(cutoffs[0])], [heldDragKey], dragStepBlocks, events)
  const steepest = Math.max(...await Promise.all(cutoffs.map(async (cutoff) => largestStep(await steady(cutoff, cutoffs, live)))))
  const arrived = await steady(1800, cutoffs, live)
  expect([steepest > 0.01, largestStep(drag) < 1.25 * steepest, settledDeviation(drag, arrived, drag.length - 20 * 128) < 1e-3])
    .toEqual([true, true, true])
})

test('B6f5 phase 6i a pitch drag through repeated publications glides without stepping on the built core', async () => {
  const semitones = [0, 2, 4, 6]
  const drag = await dragged(semitones, transposedSynth)
  const arrived = await steady(6, semitones, transposedSynth)
  expect([widestPeriodStep(drag) < 1.025, Math.abs(arrivedPeriod(drag) / arrivedPeriod(arrived) - 1) < 0.002]).toEqual([true, true])
})

// A discrete edit published while the drag is paused replaces the instrument mid-glide; the replacement carries the values
// already applied, so the glide goes on from where it was and does not jump to the value it is gliding to.
test('B6f5 phase 6i a pitch drag carried across an instrument replacement keeps gliding on the built core', async () => {
  const semitones = [0, 2, 4, 4, 6]
  const replaced = (value: number, index: number): AudioCoreInstrumentState => ({ ...transposedSynth(value), lfoWaveform: index === 3 ? 1 : 0 })
  const drag = await dragged(semitones, replaced)
  const arrived = await steady(6, semitones, transposedSynth)
  expect([widestPeriodStep(drag) < 1.025, Math.abs(arrivedPeriod(drag) / arrivedPeriod(arrived) - 1) < 0.002]).toEqual([true, true])
})

// R1: prepare, install and publish run on the AudioWorklet rendering thread. The gate is measured at the core's maximum
// graph (64 nodes, 483 processors, 243 edges) with the envelope encoded off that thread, as the backend posts it.
test('B6f5 R1 an adoption at the core maximum graph stays inside the audio-thread budget on the built core', async () => {
  const { encodePortableGraphEnvelope } = await import('./native-host-wire')
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 44_100, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  const utilityState = new Uint8Array(40)
  new DataView(utilityState.buffer).setUint32(0, 1, true)
  new DataView(utilityState.buffer).setFloat32(24, 1, true)
  type GraphNode = AudioCoreGraphSnapshot['nodes'][number]
  type GraphEdge = AudioCoreGraphSnapshot['edges'][number]
  const maximumGraph = (revision: number): AudioCoreGraphSnapshot => {
    let instanceId = 1000
    const utility = (id: string): GraphNode['processorOrder'][number] => ({ id, instanceId: instanceId++, kind: 'utility', kindId: 1, stateVersion: 1,
      state: utilityState, parameterTargets: [{ id: 'gainDb', target: 1 }], bypassed: false, latencyFrames: 0, tailFrames: 0 })
    const node = (id: string, kind: GraphNode['kind'], fx: number, mixerId: number, gain: number): GraphNode => ({ id, kind,
      inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: Array.from({ length: fx }, (_, index) => utility(`${id}-fx${index}`)),
      mixer: { instanceId: mixerId, gain, pan: 0, muted: false, soloed: false, parameterTargets: mixerParameterRegistry } })
    const edge = (from: string, to: string, kind: GraphEdge['kind'], gain: number): GraphEdge => ({ version: 1, id: `${from}>${to}`, fromNodeId: from,
      toNodeId: to, gain, kind, tap: 'post-fader', sidechain: false, pdcDelayFrames: 0 })
    const tracks = Array.from({ length: 60 }, (_, index) => node(`t${index}`, 'source', 8, 100 + index, (revision + index) % 2 ? 1 : 0.5))
    const groups = Array.from({ length: 3 }, (_, index) => node(`group${index}`, 'group', 1, 500 + index, 1))
    return { version: 1, revision, contractHash: 'test-contract', masterNodeId: 'master', assets: [],
      nodes: [...tracks, ...groups, node('master', 'master', 0, 900, 1)],
      edges: [...tracks.flatMap((track) => [edge(track.id, 'master', 'output', 1), ...groups.map((group) => edge(track.id, group.id, 'send', 0.3))]),
        ...groups.map((group) => edge(group.id, 'master', 'output', 1))] }
  }
  const prepare = (revision: number) => {
    const snapshot = maximumGraph(revision)
    const envelope = encodePortableGraphEnvelope(snapshot)
    const started = performance.now()
    host.handleMessage({ version: 2, type: 'prepare-graph', requestId: revision * 10, snapshot, envelope })
    return performance.now() - started
  }
  const largest = maximumGraph(1)
  prepare(1)
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  const schedule = (revision: number): HostSchedule => ({ revision, transportEpoch: 1, sampleRateHz: 44_100, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 },
    events: Array.from({ length: 256 }, (_, index) => gainSet(index * 64, index + 1, 0.25 + (index % 3) * 0.2, `t${index % 60}`)) })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: schedule(1) })
  for (let block = 0; block < 8; block += 1) renderLeft(host)
  const timings = { prepare: new Array<number>(), install: new Array<number>(), publish: new Array<number>(), adoption: new Array<number>() }
  for (let revision = 2; revision < 42; revision += 1) {
    const prepareMs = prepare(revision)
    let started = performance.now()
    host.handleMessage({ version: 2, type: 'install-schedule', requestId: revision * 10 + 1, schedule: schedule(revision) })
    const installMs = performance.now() - started
    started = performance.now()
    host.handleMessage({ version: 2, type: 'publish-graph', requestId: revision * 10 + 2, revision, requireContinuity: true })
    const publishMs = performance.now() - started
    expect(messages.findLast((message) => message.type === 'graph-published')).toMatchObject({ revision, result: 'published' })
    timings.prepare.push(prepareMs)
    timings.install.push(installMs)
    timings.publish.push(publishMs)
    timings.adoption.push(prepareMs + installMs + publishMs)
    renderLeft(host)
    renderLeft(host)
  }
  const quantile = (values: number[], q: number) => [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.floor(q * values.length))] ?? Infinity
  const summary = Object.fromEntries(Object.entries(timings).map(([name, values]) => [name,
    { p50: +quantile(values, 0.5).toFixed(3), p95: +quantile(values, 0.95).toFixed(3), max: +quantile(values, 1).toFixed(3) }]))
  console.log('B6F5-R1-TIMING', JSON.stringify({ nodes: largest.nodes.length, processors: largest.nodes.reduce((count, node) => count + node.processorOrder.length, 0),
    edges: largest.edges.length, budgetMs: +(128 / 44_100 * 1000).toFixed(3), ...summary }))
  expect([largest.nodes.length, largest.nodes.reduce((count, node) => count + node.processorOrder.length, 0), largest.edges.length]).toEqual([64, 483, 243])
  expect(quantile(timings.prepare, 0.95)).toBeLessThan(1.5)
  expect(quantile(timings.adoption, 0.95)).toBeLessThan(2)
})
