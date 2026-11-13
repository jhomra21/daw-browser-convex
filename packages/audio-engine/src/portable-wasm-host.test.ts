import { expect, test } from 'bun:test'
import type { PortableWasmControlMessage, PortableWasmStatusMessage } from './portable-wasm-protocol'
import { createDefaultUtilityParams } from '@daw-browser/shared'
import { encodeEqProcessorState, encodeLimiterProcessorState, encodeUtilityProcessorState, mixerParameterRegistry, type AudioCoreGraphSnapshot, type AudioCoreInstrumentState } from '@daw-browser/audio-core-contract'

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
const startPortableTracks = async (trackIds: readonly string[], graph: { revision: number } = portableTrackGraph(trackIds)) => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: 48_000,
    postMessage: (message: PortableWasmStatusMessage) => messages.push(message),
    close: () => undefined,
  })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'graph-prepared', requestId: 1, result: 'prepared' }))
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: graph.revision })
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
  | { version: number; type: 'publish-graph'; requestId: number; revision: number; requireContinuity: true; publicationFrame?: number; sources?: { epoch: number; ordinary: readonly object[]; prepared: readonly object[] } }
const adoptRevision = <Snapshot extends { revision: number }>(
  host: { handleMessage: (message: AdoptionMessage) => void },
  messages: readonly PortableWasmStatusMessage[],
  snapshot: Snapshot,
  events: readonly HostScheduleEvent[],
  publicationFrame?: number,
) => {
  const revision = snapshot.revision
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: revision * 10, snapshot })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'graph-prepared', requestId: revision * 10, result: 'prepared' }))
  const schedule: HostSchedule = { revision, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events }
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: revision * 10 + 1, schedule })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: revision * 10 + 2, revision, requireContinuity: true, publicationFrame })
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
// Per-frame ramps would need 128 events each (256 for the two) plus the set: 257, which silenced the block. The ramps write
// one value every 2 frames instead: each block must stay audible and within 2 frames of slope (0.0032) of the ideal sum, and
// the fades must land exactly.
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
  Math.max(...blocks.flatMap((block, index) => block.map((sample, frame) => Math.abs(sample - rampedSum(index * 128 + frame, cDropFrame))))) < 0.004,
  blocks.every((block) => Math.min(...block.map(Math.abs)) > 0.3),
  blocks.at(-1)?.every((sample) => Math.abs(sample - rampedSum(12 * 128, cDropFrame)) < 1e-5),
]

test('B6f5 phase 6i two overlapping gain ramps stay audible and land exactly on the built core', async () => {
  expect(rampsStayAudibleAndLand(await playRamps(rampEvents), Infinity)).toEqual([true, true, true])
})

test('B6f5 phase 6i two ramps and a gain set in one block (257 events) keep the block audible on the built core', async () => {
  expect(rampsStayAudibleAndLand(await playRamps([...rampEvents, gainSet(3 * 128, 3, 0.5, 'c')]), 3 * 128)).toEqual([true, true, true])
})

// One ramp has the block to itself, so it writes a value per frame: the worklet is sample-exact, as the ramp is.
const fadeThrough = async (fadeFrames: number, wave: (frame: number) => number) => {
  const { host, messages } = await startPortableTracks(['a'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [rampGain('a', 1, 0, fadeFrames, 1, 0)] } })
  const planes = [new Float32Array(48_000).map((_, frame) => wave(frame)), new Float32Array(48_000).map((_, frame) => wave(frame))]
  host.handleMessage({ version: 2, type: 'register-asset', requestId: 5, generation: 0,
    asset: { version: 1, assetId: 'fade-wave', frameCount: 48_000, sampleRateHz: 48_000, channelCount: 2 }, planes })
  host.handleMessage({ version: 2, type: 'schedule-sources', requestId: 6, revision: 1, epoch: 1, events: [{
    version: 1, epoch: 1, sequence: 1, sourceNodeId: 'a', assetId: 'fade-wave', startFrame: 0, stopFrame: 48_000, sourceOffsetFrame: 0,
    sourceFrameCount: 48_000, gain: 1, fadeInStartFrame: 0, fadeInEndFrame: 0, fadeOutStartFrame: 48_000, fadeOutEndFrame: 48_000 }] })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'sources-scheduled', requestId: 6, result: 'scheduled' }))
  const rendered = Array.from({ length: Math.ceil(fadeFrames / 128) }, () => renderLeft(host)).flat().slice(0, fadeFrames)
  return { rendered, dropped: droppedProcessorEvents(host, messages) }
}
const droppedProcessorEvents = (host: { handleMessage: (message: { version: 2, type: 'diagnostics' }) => void }, messages: readonly PortableWasmStatusMessage[]) => {
  host.handleMessage({ version: 2, type: 'diagnostics' })
  const health = messages.findLast((message) => message.type === 'health')
  return health?.type === 'health' ? health.droppedProcessorEvents : undefined
}

test('B6f5 phase 6i a single gain fade is sample-exact through the v2 host at 10 ms, 50 ms and 0.5 s on the built core', async () => {
  for (const fadeFrames of [480, 2_400, 24_000]) {
    const gain = (await fadeThrough(fadeFrames, () => 1)).rendered
    const sine = (await fadeThrough(fadeFrames, (frame) => Math.sin(0.05 * frame))).rendered
    const ideal = (frame: number) => 1 - frame / fadeFrames
    const rms = (values: readonly number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
    const errorDb = 20 * Math.log10(rms(sine.map((sample, frame) => Math.sin(0.05 * frame) * ideal(frame))) / rms(sine.map((sample, frame) => sample - Math.sin(0.05 * frame) * ideal(frame))))
    expect([fadeFrames, largestStep(gain) <= 1.01 / fadeFrames, errorDb >= 60]).toEqual([fadeFrames, true, true])
  }
})

test('B6f5 phase 6i four concurrent gain ramps and sets in one block render inside the event cap without dropping events on the built core', async () => {
  const sourceValues = [1, 0.9, 0.8, 0.7, 0.5]
  const trackIds = ['a', 'b', 'c', 'd', 'e']
  const { host, messages } = await startPortableTracks(trackIds)
  const setValues = [0.9, 0.8, 0.7, 0.6, 0.5, 0.25]
  const setFrame = (index: number) => 130 + 10 * index
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 },
    events: [
      ...trackIds.slice(0, 4).map((trackId, index) => rampGain(trackId, index + 1, 0, 1280, 1, 0)),
      ...setValues.map((value, index) => gainSet(setFrame(index), 5 + index, value, 'e')),
    ] } })
  playConstantSources(host, messages, 2, 1, trackIds.map((nodeId, index) => ({ nodeId, value: sourceValues[index] })))
  const blocks = Array.from({ length: 12 }, () => renderLeft(host))
  const eGain = (frame: number) => setValues[setValues.findLastIndex((_, index) => setFrame(index) <= frame)] ?? 1
  const ideal = (frame: number) => sourceValues.slice(0, 4).reduce((sum, value) => sum + value, 0) * (1 - Math.min(frame / 1280, 1)) + 0.5 * eGain(frame)
  const error = Math.max(...blocks.flatMap((block, index) => block.map((sample, frame) => Math.abs(sample - ideal(index * 128 + frame)))))
  expect([error < 0.01, blocks.at(-1)?.every((sample) => Math.abs(sample - 0.125) < 1e-5), droppedProcessorEvents(host, messages)]).toEqual([true, true, 0])
})

test('B6f5 the v2 host counts the processor events the core cannot take in a block and keeps rendering on the built core', async () => {
  const { host, messages } = await startPortableTracks(['a', 'b'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [
      ...Array.from({ length: 255 }, (_, index) => gainSet(index % 128, index + 1, 0.5, 'a')),
      rampGain('b', 256, 0, 64, 1, 0),
    ].toSorted((left, right) => left.frame - right.frame).map((event, index) => ({ ...event, sequence: index + 1 })) } })
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'a', value: 1 }, { nodeId: 'b', value: 0.5 }])
  const block = renderLeft(host)
  expect([droppedProcessorEvents(host, messages), Math.min(...block.map(Math.abs)) > 0]).toEqual([1, true])
})

test('B6f5 the v2 host adopts a latency change at a seam and keeps rendering on the built core', async () => {
  const { host, messages } = await startPortableTracks(['track'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [],
  } })
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'track', value: 0.5 }])
  renderLeft(host)
  const graph = portableTrackGraph(['track'])
  // A latency change continues the playing graph: the core moves the read heads instead of refusing the revision.
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
    blocks.map((block) => block.every(Number.isFinite))]).toEqual(['published', 'accepted', 2, [0, 0], [true, true]])
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

// Review m1. A live gain value reaches a held note through the worklet's instrument-parameters message. The next
// published configuration decides what the note plays when it differs from the playing one in another field, so the
// renderer must put the live value in it: the configuration compiled from the project, which has not seen the drag
// yet, plays the stale gain.
test('B6f5 m1 a held Synth note keeps a live gain through a publication that differs elsewhere only when it carries the value on the built core', async () => {
  const liveGain = 0.1
  const synth = { ...heldSynth, parameterTargets: [{ id: 'synth.outputGain', target: 1 }] }
  const play = async (publishedGain: number) => {
    const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
    const messages: PortableWasmStatusMessage[] = []
    const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
    expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
    const base = portableTrackGraph(['track'])
    const graph = (revision: number, instrument: typeof heldSynth) => ({ ...base, revision, nodes: base.nodes.map((node) => node.id === 'track'
      ? { ...node, kind: 'instrument', instrument } : node) })
    const notes: HostScheduleEvent[] = [{ frame: 0, sequence: 1, type: 'note-on', target: { kind: 'instrument', trackId: 'track' }, noteId: 1, pitch: 72, velocity: 0.8 }]
    host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph(1, synth) })
    host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
    host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
    host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
      revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: notes } })
    for (let block = 0; block < 20; block += 1) renderLeft(host)
    // Target 1 is synth.outputGain.
    host.handleMessage({ version: 2, type: 'instrument-parameters', requestId: 100, revision: 1, sequence: 1, epoch: 1,
      events: [{ nodeId: 'track', type: 'parameter', noteId: 1, sequence: 1, frameOffset: 0, channel: 0, note: 1, value: liveGain }] })
    const live = Array.from({ length: 40 }, () => peakOf(renderLeft(host))).at(-1) ?? 0
    expect(adoptRevision(host, messages, graph(2, { ...synth, filterCutoffHz: 3000, outputGain: publishedGain }), notes))
      .toEqual({ installed: 'installed', published: 'published' })
    const after = Array.from({ length: 40 }, () => peakOf(renderLeft(host))).at(-1) ?? 0
    return { live, after }
  }
  const carried = await play(liveGain)
  const stale = await play(0.8)
  expect([carried.live > 0.01, Math.abs(carried.after - carried.live) < carried.live * 0.05, stale.after > stale.live * 3])
    .toEqual([true, true, true])
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
  paddingByte?: (configuration: number) => number,
) => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  if (paddingByte) {
    // Sets the padding of every state the host hands the core (a granular state's bytes 4..8 and 60..64, each sample zone's
    // last four) before each configuration: a heap's leftovers, or a clean heap.
    let configurations = 0
    const pad = (bytes: Uint8Array, offsets: readonly number[]) => {
      configurations += 1
      offsets.forEach((offset) => { bytes[offset] = paddingByte(configurations) })
    }
    const configureGranular = host.granularConfigure
    host.granularConfigure = (node: bigint, state: number) => {
      pad(new Uint8Array(host.memory.buffer, state, 64), [4, 5, 6, 7, 60, 61, 62, 63])
      return configureGranular(node, state)
    }
    const configureSampler = host.samplerConfigure
    host.samplerConfigure = (node: bigint, state: number, zones: number) => {
      const zoneCount = new DataView(host.memory.buffer).getUint32(state + 4, true)
      pad(new Uint8Array(host.memory.buffer, zones, zoneCount * 80), Array.from({ length: zoneCount * 4 }, (_, index) => Math.floor(index / 4) * 80 + 76 + index % 4))
      return configureSampler(node, state, zones)
    }
  }
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
type DragInstrument = (value: number, index?: number) => AudioCoreInstrumentState
const dragged = (values: readonly number[], instrument: DragInstrument) => {
  const publications = [...values, ...Array<number>(dragSettleBlocks / dragStepBlocks).fill(values[values.length - 1])]
  return playDragged(publications.map(instrument), [heldDragKey], dragStepBlocks)
}
const steady = (value: number, values: readonly number[], instrument: DragInstrument) =>
  playDragged([instrument(value)], [heldDragKey], dragStepBlocks * (values.length - 1) + dragSettleBlocks)
// Resonance 25 with the cutoff above the tone, so the peak never crosses it.
const cutoffSynth = (filterCutoffHz: number): typeof heldSynth => ({ ...heldSynth, filterEnabled: true, filterResonance: 25, filterCutoffHz })
const transposedSynth = (semitone: number): typeof heldSynth => ({
  ...heldSynth, oscillators: [
    { enabled: true, waveform: 0, level: 0.8, octave: 0, semitone, detuneCents: 0 },
    { enabled: false, waveform: 0, level: 0, octave: 0, semitone: 0, detuneCents: 0 },
  ] })

// The longest run of exact zeros: what a cloud that went quiet leaves.
const longestSilence = (signal: readonly number[]) => signal.reduce((state, sample) => {
  const run = sample === 0 ? state.run + 1 : 0
  return { run, longest: Math.max(state.longest, run) }
}, { run: 0, longest: 0 }).longest

const granularCloud = (grainWindow: 'hann' | 'tukey', position = 0.5, grainSizeMs = 20, assetId = 'held-sine'): AudioCoreInstrumentState => ({
  version: 1, kind: 'granular', voiceCapacity: 2, outputLayout: 'stereo', assetId, seed: 77, maxGrains: 16,
  'windowShape': grainWindow, freeze: false, grainSizeMs, densityHz: 100, position, spray: 0.3, pitchSemitones: 0,
  reverseProbability: 0, stereoSpread: 0.3,
})

test('B6f5 phase 6i a granular cloud configures through the host and keeps sounding through a non-live edit on the built core', async () => {
  const edited = await playHeldNotes([granularCloud('hann'), granularCloud('tukey')], [60], true)
  const reference = await playHeldNotes([granularCloud('hann'), granularCloud('tukey')], [60], false)
  expect([peakOf(edited) > 0.05, longestSilence(edited) <= longestSilence(reference)]).toEqual([true, true])
})

// The padding in a configuration (a 64-bit handle sits on an 8-byte boundary) is whatever the wasm heap held. A drag of one
// continuous value must keep its instrument and slew, as it does on a clean heap, when each publication's padding differs:
// a configuration compared by bytes would see a changed instrument, replace it and crossfade.
test('B6f5 phase 6i a granular or sampler drag keeps its instrument whatever bytes the heap held in the padding on the built core', async () => {
  const drags: ReadonlyArray<readonly [string, ReadonlyArray<AudioCoreInstrumentState>]> = [
    ['granular position', [0.2, 0.35, 0.5, 0.65, 0.8, 0.8, 0.8, 0.8, 0.8].map((position) => granularCloud('hann', position))],
    ['granular grain size', [20, 30, 40, 50, 60, 60, 60, 60, 60].map((size) => granularCloud('hann', 0.5, size))],
    ['sampler zone gain', [1, 0.8, 0.6, 0.4, 0.2, 0.2, 0.2, 0.2, 0.2].map((gain) => heldSampler('sampler', gain, 8))],
  ]
  for (const [name, states] of drags) {
    const key = states[0].kind === 'sampler' ? 52 : 60
    const dirty = await playDragged(states, [key], dragStepBlocks, [], (configuration) => 0xA5 ^ configuration)
    const clean = await playDragged(states, [key], dragStepBlocks, [], () => 0)
    expect([name, peakOf(clean) > 0.02, settledDeviation(dirty, clean, 0)]).toEqual([name, true, 0])
  }
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
  const live = (filterCutoffHz: number): typeof heldSynth => ({
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
  const replaced = (value: number, index = 0): typeof heldSynth => ({ ...transposedSynth(value), lfoWaveform: index === 3 ? 1 : 0 })
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

// AE-08 phase 8 step 1: failure-first witnesses for the frame-exact publication (M1) and the release of held notes at a
// locate (D4). Each is `test.failing` until its implementing step flips it to `test`.
const publishedResults = (messages: readonly PortableWasmStatusMessage[], revision: number) =>
  messages.flatMap((message) => message.type === 'graph-published' && message.requestId === revision * 10 + 2 ? [message.result] : [])
const renderBlocks = (host: Parameters<typeof renderLeft>[0], blocks: number) => Array.from({ length: blocks }, () => renderLeft(host)).flat()
const m1Playing = async () => {
  const { host, messages } = await startPortableTracks(['track'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  // A holds 1 until 200, then 0.5; its later events must still play up to the seam.
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [gainSet(200, 1, 0.5), gainSet(400, 2, 0.75)],
  } })
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'track', value: 1 }])
  return { host, messages }
}
// B takes over at frame 256: A plays every event before it and none from it on.
const m1Next = [gainSet(256, 1, 0.25), gainSet(600, 2, 0.125)]
// The core eases the gain from 0.5 to 0.25 over the 240 frames after the swap (the same with an immediate publish), so that
// stretch is bounded rather than exact.
const m1Expected = (frame: number) => frame < 200 ? 1 : frame < 256 ? 0.5 : frame < 600 ? 0.25 : 0.125

test('W-M1a a publication frame swaps the schedule exactly there: old events before it play, new events from it play', async () => {
  const { host, messages } = await m1Playing()
  const rendered = renderBlocks(host, 1)
  // The publish is handled while the transport stands at frame 128, ahead of the swap frame 256: it is held, and answered
  // by the block that applies it.
  const adoption = adoptRevision(host, messages, { ...portableTrackGraph(['track']), revision: 2 }, m1Next, 256)
  rendered.push(...renderBlocks(host, 6))
  expect({ installed: adoption.installed, published: publishedResults(messages, 2), answersCarryNoFrame: messages.every((message) => !('appliedFrame' in message)),
    seamless: rendered.slice(0, 700).every((sample, frame) => frame >= 256 && frame < 496 ? sample >= 0.25 - 1e-6 && sample <= 0.5 + 1e-6 : Math.abs(sample - m1Expected(frame)) < 1e-6) })
    .toEqual({ installed: 'installed', published: ['published'], answersCarryNoFrame: true, seamless: true })
})

test('W-M1e a publication frame inside a block caps the old schedule there and applies at the next block start', async () => {
  const { host, messages } = await m1Playing()
  const rendered = renderBlocks(host, 1)
  // Frame 200 lies inside the block 128..256. The old gain-set at 200 must not play, and the new one lands at frame 256.
  adoptRevision(host, messages, { ...portableTrackGraph(['track']), revision: 2 }, [gainSet(200, 1, 0.25), gainSet(600, 2, 0.125)], 200)
  rendered.push(...renderBlocks(host, 6))
  expect({ published: publishedResults(messages, 2), levels: [rendered[199], rendered[200], rendered[255], rendered[256], rendered[599], rendered[600]] })
    .toEqual({ published: ['published'], levels: [1, 1, 1, 0.25, 0.25, 0.125] })
})

// A publication the controller abandoned (its request timed out) is cancelled by revision, so the worklet never applies
// it when the context resumes; a cancel for another revision leaves the pending one alone.
test('W-R3 a cancelled pending publication is never applied and the old revision keeps playing', async () => {
  const { host, messages } = await m1Playing()
  renderBlocks(host, 1)
  adoptRevision(host, messages, { ...portableTrackGraph(['track']), revision: 2 }, m1Next, 4_096)
  host.handleMessage({ version: 2, type: 'cancel-publication', revision: 3 })
  const otherRevision = host.pendingPublication?.revision
  host.handleMessage({ version: 2, type: 'cancel-publication', revision: 2 })
  const after = renderBlocks(host, 40)
  expect({ otherRevision, pending: host.pendingPublication, revision: host.revision, published: publishedResults(messages, 2),
    oldScheduleKeepsPlaying: after.slice(-64).every((sample) => Math.abs(sample - 0.75) < 1e-6) })
    .toEqual({ otherRevision: 2, pending: null, revision: 1, published: ['rejected'], oldScheduleKeepsPlaying: true })
})

// R4: an apply that fails (here the prepared graph was replaced while the publish waited) keeps the old schedule, whose
// parameter events in [seam, block start) must still land at the block start instead of expiring behind it.
test('W-R4 a failed framed apply keeps the old schedule parameter events that fell between the seam and the block', async () => {
  const { host, messages } = await startPortableTracks(['track'])
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [gainSet(250, 1, 0.5)],
  } })
  playConstantSources(host, messages, 2, 1, [{ nodeId: 'track', value: 1 }])
  const rendered = renderBlocks(host, 1)
  adoptRevision(host, messages, { ...portableTrackGraph(['track']), revision: 2 }, [gainSet(300, 1, 0.25)], 250)
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 30, snapshot: { ...portableTrackGraph(['track']), revision: 3 } })
  rendered.push(...renderBlocks(host, 3))
  expect({ published: publishedResults(messages, 2), revision: host.revision, levels: [rendered[255], rendered[256], rendered[383]] })
    .toEqual({ published: ['rejected'], revision: 1, levels: [1, 0.5, 0.5] })
})

test('W-M1f a pending publication is rejected when the session is disposed', async () => {
  const { host, messages } = await m1Playing()
  renderBlocks(host, 1)
  adoptRevision(host, messages, { ...portableTrackGraph(['track']), revision: 2 }, m1Next, 4_096)
  host.handleMessage({ version: 2, type: 'dispose' })
  expect(publishedResults(messages, 2)).toEqual(['rejected'])
})

test('W-M1g a publication frame for a revision other than the staged one is rejected and leaves the old revision playing', async () => {
  const { host, messages } = await m1Playing()
  renderBlocks(host, 1)
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 20, snapshot: { ...portableTrackGraph(['track']), revision: 2 } })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 21, schedule: {
    revision: 2, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: m1Next } })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 32, revision: 3, requireContinuity: true, publicationFrame: 4_096 })
  expect({ results: publishedResults(messages, 3), revision: host.revision, pending: host.pendingPublication }).toEqual({ results: ['rejected'], revision: 1, pending: null })
})

test('W-M1b a publication frame already behind the transport is answered late and leaves the old revision playing', async () => {
  const { host, messages } = await m1Playing()
  renderBlocks(host, 2)
  const adoption = adoptRevision(host, messages, { ...portableTrackGraph(['track']), revision: 2 }, m1Next, 128)
  const after = renderBlocks(host, 4)
  expect({ adoption: String(adoption.published), revision: host.revision, laterEventsPlay: after.slice(0, 144).every((sample) => Math.abs(sample - 0.5) < 1e-6) })
    .toEqual({ adoption: 'late', revision: 1, laterEventsPlay: true })
})

test('W-M1c a transport message while a publication is pending rejects it and keeps the old revision playing', async () => {
  const { host, messages } = await m1Playing()
  renderBlocks(host, 1)
  adoptRevision(host, messages, { ...portableTrackGraph(['track']), revision: 2 }, m1Next, 4_096)
  host.handleMessage({ version: 2, type: 'transport', requestId: 30, epoch: 1, running: true, frame: 128 })
  expect({ results: publishedResults(messages, 2), revision: host.revision }).toEqual({ results: ['rejected'], revision: 1 })
})

test('W-M1d a note-off between an early publish and its swap frame still plays, so the note does not stick', async () => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  const base = portableTrackGraph(['track'])
  const graph = (revision: number) => ({ ...base, revision, nodes: base.nodes.map((node) => node.id === 'track' ? { ...node, kind: 'instrument', instrument: heldSynth } : node) })
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph(1) })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [
      { frame: 0, sequence: 1, type: 'note-on', target: { kind: 'instrument', trackId: 'track' }, noteId: 1, pitch: 72, velocity: 0.8 },
      { frame: 200, sequence: 2, type: 'note-off', target: { kind: 'instrument', trackId: 'track' }, noteId: 1, pitch: 72 }] } })
  renderBlocks(host, 1)
  // The next revision starts at frame 256 and carries nothing of the note: the old schedule must end it at 200.
  expect(adoptRevision(host, messages, graph(2), [], 256).installed).toBe('installed')
  renderBlocks(host, 6)
  expect(publishedResults(messages, 2)).toEqual(['published'])
  expect(peakOf(renderBlocks(host, 4))).toBeLessThan(1e-4)
})

// An adoption at a seam while note 1 sounds (pitch 52, held since frame 0): `events` is what the adopted schedule carries from
// the seam on. The seam sits 55 blocks in, where the sampler's sine is a whole number of periods from its start, so a second
// voice would add in phase. Returns the peak of the sounding note before the seam and the peaks of the next ten blocks.
const noteSeam = 7_040
const seamNoteOn = (frame: number, sequence: number): HostScheduleEvent => ({
  frame, sequence, type: 'note-on', target: { kind: 'instrument', trackId: 'track' }, noteId: 1, pitch: 52, velocity: 0.8,
})
const seamNoteOff = (frame: number, sequence: number): HostScheduleEvent => ({
  frame, sequence, type: 'note-off', target: { kind: 'instrument', trackId: 'track' }, noteId: 1, pitch: 52,
})
const playAcrossSeam = async (instrument: AudioCoreInstrumentState, events: readonly HostScheduleEvent[]) => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  const sine = new Float32Array(sineFrames).map((_, frame) => Math.sin(0.05 * frame))
  host.handleMessage({ version: 2, type: 'register-asset', requestId: 900, generation: 0,
    asset: { version: 1, assetId: 'held-sine', frameCount: sineFrames, sampleRateHz: 48_000, channelCount: 2 }, planes: [sine, sine] })
  const base = portableTrackGraph(['track'])
  const graph = (revision: number) => ({ ...base, revision, nodes: base.nodes.map((node) => node.id === 'track' ? { ...node, kind: 'instrument', instrument } : node) })
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph(1) })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [seamNoteOn(0, 1)] } })
  const before = peakOf(renderBlocks(host, noteSeam / 128).slice(-1280))
  expect(adoptRevision(host, messages, graph(2), events, noteSeam).installed).toBe('installed')
  return { before, after: Array.from({ length: 10 }, () => peakOf(renderLeft(host))), published: publishedResults(messages, 2) }
}
const seamInstruments = [['synth', heldSynth], ['sampler', heldSampler('sampler', 1, 8)]] as const

// A note that survives the edit keeps its voice: the reconciled schedule carries only its note-off. Repeating the note-on
// sticks a Synth (it then needs two note-offs) and layers a second Sampler voice.
test('W-E5-4 a kept held note is not re-triggered at the seam: one note-off silences a Synth and a Sampler plays one voice', async () => {
  for (const [name, instrument] of seamInstruments) {
    const kept = await playAcrossSeam(instrument, [seamNoteOff(noteSeam + 640, 1)])
    const repeated = await playAcrossSeam(instrument, [seamNoteOn(noteSeam, 1), seamNoteOff(noteSeam + 640, 2)])
    expect(kept.published).toEqual(['published'])
    // The note-off lands in block 5 after the seam.
    expect([name, kept.after.slice(0, 5).every((peak) => peak > kept.before * 0.9 && peak < kept.before * 1.1), kept.after[6] < 1e-3])
      .toEqual([name, true, true])
    expect([name, name === 'sampler' ? repeated.after[0] > repeated.before * 1.5 : repeated.after[6] > 0.02]).toEqual([name, true])
  }
})

// A note deleted while it sounds is released by a note-off at the seam; without one the voice hangs.
test('W-E5-3 a removed held note is released by the note-off at the seam and hangs without it', async () => {
  for (const [name, instrument] of seamInstruments) {
    const released = await playAcrossSeam(instrument, [seamNoteOff(noteSeam, 1)])
    const forgotten = await playAcrossSeam(instrument, [])
    expect([name, released.before > 0.02, released.after[2] < 1e-3, forgotten.after[9] > 0.02]).toEqual([name, true, true, true])
  }
})

// D4: a locate while playing releases held notes with their tails, as native does.
test('W-E3-3 a note held across a transport epoch change decays through its release tail instead of cutting', async () => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRateHz: 48_000, sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  const synth = { ...heldSynth, ampReleaseMs: 500 }
  const base = portableTrackGraph(['track'])
  const graph = { ...base, nodes: base.nodes.map((node) => node.id === 'track' ? { ...node, kind: 'instrument', instrument: synth } : node) }
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 },
    events: [{ frame: 0, sequence: 1, type: 'note-on', target: { kind: 'instrument', trackId: 'track' }, noteId: 1, pitch: 72, velocity: 0.8 }] } })
  const level = peakOf(renderBlocks(host, 20))
  host.handleMessage({ version: 2, type: 'transport', requestId: 5, epoch: 2, running: true, frame: 96_000 })
  const tail = [peakOf(renderLeft(host)), peakOf(renderLeft(host)), peakOf(renderLeft(host))]
  expect({ audible: level > 0.1, tailStartsNearLevel: tail[0] > level * 0.5, decaying: tail[2] < tail[0] && tail[2] > 0 }).toEqual({ audible: true, tailStartsNearLevel: true, decaying: true })
})

// AE-08 phase 8 step 9a: the sources of a published revision travel with its (framed) publish. The worklet holds them
// with the pending publication and applies them right after the graph swap, inside the one block that publishes, so no
// block plays the new graph with the old table or the old graph with the new table. The playing table ends at 512; an
// unchanged clip continues past it only through the swapped-in table.
const rampFrames = 4_096
const rampAsset = new Float32Array(rampFrames).map((_, frame) => Math.fround(frame * 1e-4))
const rampSource = (sequence: number, startFrame: number, stopFrame: number, gain = 1, sourceNodeId = 'track') => ({
  version: 1, epoch: 1, sequence, sourceNodeId, assetId: 'ramp', startFrame, stopFrame, sourceOffsetFrame: startFrame,
  sourceFrameCount: stopFrame - startFrame, gain, fadeInStartFrame: startFrame, fadeInEndFrame: startFrame,
  fadeOutStartFrame: stopFrame, fadeOutEndFrame: stopFrame,
})
const playRamp = async (trackIds: readonly string[] = ['track'], running = true, oldTable: readonly ReturnType<typeof rampSource>[] = [rampSource(1, 0, 512)]) => {
  const { host, messages } = await startPortableTracks(trackIds)
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running, frame: 0 })
  host.handleMessage({ version: 2, type: 'register-asset', requestId: 5, generation: 0,
    asset: { version: 1, assetId: 'ramp', frameCount: rampFrames, sampleRateHz: 48_000, channelCount: 2 }, planes: [rampAsset, rampAsset] })
  host.handleMessage({ version: 2, type: 'schedule-sources', requestId: 6, revision: 1, epoch: 1, events: oldTable })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'sources-scheduled', requestId: 6, result: 'scheduled' }))
  return { host, messages }
}
const publishWithSources = (
  host: { handleMessage: (message: AdoptionMessage) => void },
  trackIds: readonly string[],
  sources: readonly ReturnType<typeof rampSource>[],
  publicationFrame?: number,
  prepared: readonly ReturnType<typeof pagedRampSource>[] = [],
) => {
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 20, snapshot: { ...portableTrackGraph(trackIds), revision: 2 } })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 21, schedule: {
    revision: 2, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [] } })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 22, revision: 2, requireContinuity: true, publicationFrame,
    sources: { epoch: 1, ordinary: sources, prepared } })
}
// A prepared (paged) source plays a range of a paged asset, as the controller ships a Stretch artifact.
const pagedRampSource = (sequence: number, preparationId: number, startFrame: number, stopFrame: number) => ({
  version: 1, epoch: 1, sequence, preparationId, sourceNodeId: 'track', startFrame, stopFrame, sourceOffsetFrame: startFrame,
  sourceFrameCount: stopFrame - startFrame, gain: 1, fadeInStartFrame: startFrame, fadeInEndFrame: startFrame,
  fadeOutStartFrame: stopFrame, fadeOutEndFrame: stopFrame,
})
// A framed publish is answered by the block that applies it.
const sourcePublication = (messages: readonly PortableWasmStatusMessage[]) =>
  messages.flatMap((message) => message.type === 'graph-published' && message.requestId === 22 ? [message.result] : [])
const rampLevel = (frame: number, gain = 1) => Math.fround(rampAsset[frame] * gain)
const matchesRamp = (rendered: readonly number[], expected: (frame: number) => number) =>
  rendered.every((sample, frame) => Math.abs(sample - expected(frame)) < 1e-6)

// The swap is not a cut: a source the new table does not retain fades out over 6 ms (288 frames at 48 kHz) from the
// block that publishes, and the sources that replace it fade in over the same span, so the sum is a linear crossfade.
const blendFrames = 288
const crossfade = (seamFrame: number, oldGain: number, newGain: number) => (frame: number) => {
  const entered = Math.min(1, Math.max(0, (frame - seamFrame) / blendFrames))
  return rampLevel(frame, oldGain * (1 - entered) + newGain * entered)
}

test('W-C9-clip-3a a framed swap of an unchanged spanning clip is sample-exact across the swap', async () => {
  const { host, messages } = await playRamp(['track'], true, [rampSource(1, 0, 1_024)])
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track'], [rampSource(1, 384, 1_024)], 384)
  rendered.push(...renderBlocks(host, 7))
  expect({ published: sourcePublication(messages), continuous: matchesRamp(rendered, rampLevel), revision: host.revision })
    .toEqual({ published: ['published'], continuous: true, revision: 2 })
})

test('W-C9-clip-3b a framed swap of a changed clip crossfades to the new table over 6 ms from its frame', async () => {
  const { host, messages } = await playRamp(['track'], true, [rampSource(1, 0, 1_024)])
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track'], [rampSource(1, 384, 1_024, 0.5)], 384)
  rendered.push(...renderBlocks(host, 7))
  expect({ published: sourcePublication(messages), crossfaded: matchesRamp(rendered, crossfade(384, 1, 0.5)), noStep: Math.abs(rendered[384] - rendered[383]) < 2e-4 })
    .toEqual({ published: ['published'], crossfaded: true, noStep: true })
})

test('W-C9-clip-3h an old source the new table lacks fades out over 6 ms and is silent after', async () => {
  const { host, messages } = await playRamp(['track'], true, [rampSource(1, 0, 1_024)])
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track'], [], 384)
  rendered.push(...renderBlocks(host, 7))
  expect({ published: sourcePublication(messages), faded: matchesRamp(rendered, crossfade(384, 1, 0)), noStep: Math.abs(rendered[384] - rendered[383]) < 2e-4, silent: rendered.slice(384 + blendFrames).every((sample) => sample === 0) })
    .toEqual({ published: ['published'], faded: true, noStep: true, silent: true })
})

test('W-C9-clip-3i the slot table holds every old tail beside a full table of new sources', async () => {
  const table = (gain: number, startFrame: number) => Array.from({ length: 256 }, (_, index) => rampSource(index + 1, startFrame, 1_024, gain))
  const { host, messages } = await playRamp(['track'], true, table(0.001, 0))
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track'], table(0.002, 384), 384)
  rendered.push(...renderBlocks(host, 7))
  expect({ published: sourcePublication(messages), faulted: messages.some((message) => message.type === 'fault'), crossfaded: rendered.every((sample, frame) => Math.abs(sample - crossfade(384, 0.256, 0.512)(frame)) < 1e-5) })
    .toEqual({ published: ['published'], faulted: false, crossfaded: true })
})

// 9b: a clip moved from frame 0 to frame 800 plays where it was until the seam, fades out over 6 ms, is silent until its
// new start, and from there plays its own start (the asset from frame 0), with no entry fade (it begins after the seam).
test('W-C9-clip-3j a clip moved at the seam plays the new position once the 6 ms crossfade has run', async () => {
  const { host, messages } = await playRamp(['track'], true, [rampSource(1, 0, 1_024)])
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track'], [{ ...rampSource(1, 800, 1_700), sourceOffsetFrame: 0 }], 384)
  rendered.push(...renderBlocks(host, 7))
  const expected = (frame: number) => frame < 384 + blendFrames ? crossfade(384, 1, 0)(frame) : frame < 800 ? 0 : rampLevel(frame - 800)
  expect({ published: sourcePublication(messages), played: matchesRamp(rendered, expected), gap: rendered.slice(384 + blendFrames, 800).every((sample) => sample === 0),
    arrived: rendered[1_000] === rampLevel(200) })
    .toEqual({ published: ['published'], played: true, gap: true, arrived: true })
})

test('W-C9-clip-3c a source of a node the new graph adds plays from the seam, so the apply follows the publish', async () => {
  const { host, messages } = await playRamp()
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track', 'extra'], [rampSource(1, 384, 1_024), rampSource(2, 384, 1_024, 1, 'extra')], 384)
  rendered.push(...renderBlocks(host, 7))
  const published = sourcePublication(messages)
  expect({ published, before: matchesRamp(rendered.slice(0, 384), rampLevel), after: rendered[1_000] > rampLevel(1_000) * 1.9 })
    .toEqual({ published: ['published'], before: true, after: true })
})

test('W-C9-clip-3d a late framed publish applies nothing: the old table keeps playing', async () => {
  const { host, messages } = await playRamp()
  const rendered = renderBlocks(host, 3)
  publishWithSources(host, ['track'], [rampSource(1, 128, 1_024, 0.5)], 128)
  rendered.push(...renderBlocks(host, 5))
  const published = sourcePublication(messages)
  expect({ published, revision: host.revision, oldTable: matchesRamp(rendered, (frame) => frame < 512 ? rampLevel(frame) : 0) })
    .toEqual({ published: ['late'], revision: 1, oldTable: true })
})

test('W-C9-clip-3e sources for a node the prepared graph lacks are refused with the publish and nothing is applied', async () => {
  const { host, messages } = await playRamp()
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track'], [rampSource(1, 384, 1_024), rampSource(2, 384, 1_024, 1, 'ghost')], 384)
  rendered.push(...renderBlocks(host, 7))
  const published = sourcePublication(messages)
  expect({ published, revision: host.revision, pending: host.pendingPublication, oldTable: matchesRamp(rendered, (frame) => frame < 512 ? rampLevel(frame) : 0) })
    .toEqual({ published: ['rejected'], revision: 1, pending: null, oldTable: true })
})

test('W-C9-clip-3f a cancelled or transport-rejected pending publication drops its sources, which no later publish applies', async () => {
  for (const drop of ['cancel', 'transport'] as const) {
    const { host, messages } = await playRamp()
    const rendered = renderBlocks(host, 1)
    publishWithSources(host, ['track'], [rampSource(1, 384, 1_024, 0.5)], 4_096)
    expect(sourcePublication(messages)).toEqual([])
    host.handleMessage(drop === 'cancel'
      ? { version: 2, type: 'cancel-publication', revision: 2 }
      : { version: 2, type: 'transport', requestId: 30, epoch: 1, running: true, frame: 128 })
    host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 31, snapshot: { ...portableTrackGraph(['track']), revision: 3 } })
    host.handleMessage({ version: 2, type: 'publish-graph', requestId: 32, revision: 3, requireContinuity: true })
    rendered.push(...renderBlocks(host, 7))
    expect([drop, sourcePublication(messages), host.pendingPublication, host.revision, matchesRamp(rendered.slice(0, 128), rampLevel), rendered[600] === 0])
      .toEqual([drop, ['rejected'], null, 3, true, true])
  }
})

test('W-C9-clip-3g a publish while paused applies its sources at once, in the order publish then apply', async () => {
  const { host, messages } = await playRamp(['track'], false)
  publishWithSources(host, ['track'], [rampSource(1, 0, 1_024, 0.5)])
  const published = sourcePublication(messages)
  host.handleMessage({ version: 2, type: 'transport', requestId: 40, epoch: 1, running: true, frame: 0 })
  const rendered = renderBlocks(host, 8)
  expect({ published, table: matchesRamp(rendered, (frame) => frame < 1_024 ? rampLevel(frame, 0.5) : 0) }).toEqual({ published: ['published'], table: true })
})

// AE-08 phase 8 step 9c: an asset swap at a seam. The new asset is registered before the publish, the old one is
// released once nothing plays from it, and `release-asset` says so while something still does.
const releaseAnswer = (host: { handleMessage: (message: { version: number; type: 'release-asset'; requestId: number; generation: number; assetId: string }) => void }, messages: readonly PortableWasmStatusMessage[], requestId: number, assetId: string) => {
  host.handleMessage({ version: 2, type: 'release-asset', requestId, generation: 0, assetId })
  return messages.flatMap((message) => message.type === 'asset-released' && message.requestId === requestId ? [message.result] : [])[0]
}

test('W-C9-asset-5 a clip asset swapped at the seam crossfades to the new audio, and the old asset is in use until its tail has ended', async () => {
  const { host, messages } = await playRamp(['track'], true, [rampSource(1, 0, 1_024)])
  const doubled = rampAsset.map((value) => Math.fround(value * 2))
  host.handleMessage({ version: 2, type: 'register-asset', requestId: 7, generation: 0,
    asset: { version: 1, assetId: 'ramp-doubled', frameCount: rampFrames, sampleRateHz: 48_000, channelCount: 2 }, planes: [doubled, doubled] })
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track'], [{ ...rampSource(1, 384, 1_024), assetId: 'ramp-doubled' }], 384)
  rendered.push(...renderBlocks(host, 3))
  const duringTail = releaseAnswer(host, messages, 50, 'ramp')
  rendered.push(...renderBlocks(host, 4))
  const afterTail = releaseAnswer(host, messages, 51, 'ramp')
  expect({ published: sourcePublication(messages),
    crossfaded: matchesRamp(rendered, (frame) => {
      const entered = Math.min(1, Math.max(0, (frame - 384) / blendFrames))
      return rampLevel(frame, 1 - entered + 2 * entered)
    }), duringTail, afterTail })
    .toEqual({ published: ['published'], crossfaded: true, duringTail: 'asset-in-use', afterTail: 'released' })
})

// The Sampler's zones name the asset, so the publish reconfigures the instrument from the registry: the new sample is
// registered first. The held note is released by the note-off at the seam and the spanning note-on starts the new sample.
const zeroCrossings = (signal: readonly number[]) => signal.slice(1).filter((sample, index) => (signal[index] < 0) !== (sample < 0)).length
test('W-C9-asset-6 a Sampler zone sample swapped at the seam releases the old voice and starts the new sample on the spanning note-on', async () => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  const register = (requestId: number, assetId: string, step: number) => {
    const plane = new Float32Array(sineFrames).map((_, frame) => Math.sin(step * frame))
    host.handleMessage({ version: 2, type: 'register-asset', requestId, generation: 0,
      asset: { version: 1, assetId, frameCount: sineFrames, sampleRateHz: 48_000, channelCount: 2 }, planes: [plane, plane] })
  }
  register(900, 'held-sine', 0.05)
  const sampler = (assetId: string): AudioCoreInstrumentState => {
    const state = heldSampler('sampler', 1, 8)
    return state.kind === 'sampler' ? { ...state, zones: state.zones.map((zone) => ({ ...zone, assetId })) } : state
  }
  const base = portableTrackGraph(['track'])
  const graph = (revision: number, assetId: string) => ({ ...base, revision,
    nodes: base.nodes.map((node) => node.id === 'track' ? { ...node, kind: 'instrument', instrument: sampler(assetId) } : node) })
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph(1, 'held-sine') })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [seamNoteOn(0, 1)] } })
  const before = renderBlocks(host, noteSeam / 128).slice(-1280)
  register(901, 'held-sine-fast', 0.1)
  const seamEvents = [{ ...seamNoteOff(noteSeam, 1) }, seamNoteOn(noteSeam, 2)]
  expect(adoptRevision(host, messages, graph(2, 'held-sine-fast'), seamEvents, noteSeam).installed).toBe('installed')
  const first = renderBlocks(host, 1)
  const duringBlend = releaseAnswer(host, messages, 52, 'held-sine')
  const after = renderBlocks(host, 12).slice(-1280)
  const afterBlend = releaseAnswer(host, messages, 53, 'held-sine')
  expect({ published: publishedResults(messages, 2), oldRate: zeroCrossings(before), newRate: zeroCrossings(after), sounding: peakOf(first) > 0.02, duringBlend, afterBlend })
    .toEqual({ published: ['published'], oldRate: expect.any(Number), newRate: expect.any(Number), sounding: true, duringBlend: 'asset-in-use', afterBlend: 'released' })
  expect(zeroCrossings(before)).toBeLessThan(26)
  expect(zeroCrossings(after)).toBeGreaterThan(36)
})

// AE-08 phase 8 step 9d: a Stretch artifact is a paged asset. A tempo edit swaps the clip to the artifact prepared at the
// new tempo (here the same ramp at twice the level): it crossfades in over 6 ms from the seam and plays alone after it, and
// the old artifact is released once its preparation is, as the controller releases them after the seam.
test('W-C9-warp-7 a warped clip swapped to the new-tempo artifact at the seam crossfades to it and the old artifact is released after its tail', async () => {
  const { host, messages } = await playRamp(['track'], true, [])
  const pageFrames = 16_384
  const answers = (type: 'paged-asset-registered' | 'asset-range-prepared', requestId: number) => messages.flatMap((message) => message.type === type && message.requestId === requestId ? [message] : [])[0]
  const pagedArtifact = (assetId: string, scale: number, requestId: number) => {
    const plane = new Float32Array(pageFrames).map((_, frame) => Math.fround(frame * 1e-4 * scale))
    host.handleMessage({ version: 2, type: 'register-paged-asset', requestId, generation: 0,
      asset: { version: 1, assetId, frameCount: pageFrames, sampleRateHz: 48_000, channelCount: 2 } })
    host.handleMessage({ version: 2, type: 'write-asset-page', requestId: requestId + 1, generation: 0, assetId, pageIndex: 0, validFrames: pageFrames, planes: [plane, plane] })
    host.handleMessage({ version: 2, type: 'prepare-asset-range', requestId: requestId + 2, generation: 0, assetId, sourceOffsetFrame: 0, sourceFrameCount: pageFrames, interpolationGuardFrames: 0 })
    const prepared = answers('asset-range-prepared', requestId + 2)
    return { registered: answers('paged-asset-registered', requestId)?.result, preparationId: prepared?.result === 'prepared' ? prepared.preparationId : undefined }
  }
  const old = pagedArtifact('stretch-old', 1, 100)
  const fresh = pagedArtifact('stretch-new', 2, 110)
  if (old.preparationId === undefined || fresh.preparationId === undefined) throw new Error('the paged artifacts were not prepared')
  host.handleMessage({ version: 2, type: 'schedule-prepared-sources', requestId: 120, revision: 1, epoch: 1, events: [pagedRampSource(1, old.preparationId, 0, 1_024)] })
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track'], [], 384, [pagedRampSource(1, fresh.preparationId, 384, 1_024)])
  rendered.push(...renderBlocks(host, 3))
  host.handleMessage({ version: 2, type: 'release-asset-preparation', requestId: 130, generation: 0, preparationId: old.preparationId })
  const duringTail = releaseAnswer(host, messages, 131, 'stretch-old')
  rendered.push(...renderBlocks(host, 4))
  host.handleMessage({ version: 2, type: 'release-asset-preparation', requestId: 132, generation: 0, preparationId: old.preparationId })
  const afterTail = releaseAnswer(host, messages, 133, 'stretch-old')
  expect({ registered: [old.registered, fresh.registered], published: sourcePublication(messages),
    crossfaded: matchesRamp(rendered, (frame) => {
      const entered = Math.min(1, Math.max(0, (frame - 384) / blendFrames))
      return rampLevel(frame, 1 - entered + 2 * entered)
    }), duringTail, afterTail })
    .toEqual({ registered: ['registered', 'registered'], published: ['published'], crossfaded: true, duringTail: 'asset-in-use', afterTail: 'released' })
})

// AE-08 phase 8 step 9e: tracks added and deleted at a seam. A deleted track's node becomes a ghost the core fades over
// 5 ms (D-3, shared with native); the sources it played fade with it and end with it, and a voice held on it ends with it.
// The tracks that remain are untouched. A track added plays its clip from the seam: W-C9-clip-3c.
const ghostFrames = 240
test('W-C9-track-8 a deleted track fades out over its 5 ms ghost with no step while the remaining track plays on exactly', async () => {
  const { host, messages } = await playRamp(['track', 'gone'], true, [rampSource(1, 0, 1_024), rampSource(2, 0, 1_024, 1, 'gone')])
  const rendered = renderBlocks(host, 1)
  publishWithSources(host, ['track'], [rampSource(1, 384, 1_024)], 384)
  rendered.push(...renderBlocks(host, 7))
  const share = (frame: number) => (rendered[frame] - rampLevel(frame)) / rampLevel(frame)
  const fading = Array.from({ length: ghostFrames + 1 }, (_, index) => share(384 + index))
  expect({ published: sourcePublication(messages), before: matchesRamp(rendered.slice(0, 384), (frame) => rampLevel(frame, 2)),
    startsWhole: share(384) > 0.99, noStep: fading.every((value, index) => index === 0 || (value <= fading[index - 1] && fading[index - 1] - value < 0.01)),
    ended: rendered.slice(384 + ghostFrames).every((sample, index) => sample === rampLevel(384 + ghostFrames + index)) })
    .toEqual({ published: ['published'], before: true, startsWhole: true, noStep: true, ended: true })
})

const playHeldOnGone = async () => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  const base = portableTrackGraph(['keep', 'gone'])
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: { ...base, nodes: base.nodes.map((node) => node.id === 'gone' ? { ...node, kind: 'instrument', instrument: heldSynth } : node) } })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 },
    events: [{ frame: 0, sequence: 1, type: 'note-on', target: { kind: 'instrument', trackId: 'gone' }, noteId: 1, pitch: 72, velocity: 0.8 }] } })
  return { host, messages, held: peakOf(renderBlocks(host, 10).slice(-1280)) }
}

// The controller sends no note-off for the deleted track: its node is not in the candidate graph, so the staged schedule
// would be rejected, and the ghost ends the voice without one.
test('W-C9-track-9 a note held on a deleted track ends with its ghost and without a note-off, which the candidate graph would reject', async () => {
  const silent = await playHeldOnGone()
  expect(adoptRevision(silent.host, silent.messages, { ...portableTrackGraph(['keep']), revision: 2 }, [], 1_280).installed).toBe('installed')
  const fading = peakOf(renderBlocks(silent.host, 2))
  const after = peakOf(renderBlocks(silent.host, 20))
  const released = await playHeldOnGone()
  const rejected = adoptRevision(released.host, released.messages, { ...portableTrackGraph(['keep']), revision: 2 }, [
    { frame: 1_280, sequence: 1, type: 'note-off', target: { kind: 'instrument', trackId: 'gone' }, noteId: 1, pitch: 72 }], 1_280).installed
  expect({ held: silent.held > 0.02, published: publishedResults(silent.messages, 2), fading: fading > 0.001, after: after < 1e-6, rejected })
    .toEqual({ held: true, published: ['published'], fading: true, after: true, rejected: 'rejected' })
})

// A track added or deleted where a latency-bearing node delays routes moves the other tracks' delays; the core
// continues each by moving their read heads (step 9h).
test('W-C9-track-10 a track added or deleted where a latency-bearing node delays routes is continued by the core', async () => {
  const withLatency = (trackIds: readonly string[], revision: number) => {
    const base = portableTrackGraph(trackIds)
    const nodes = base.nodes.map((node) => node.id === 'a' ? { ...node, latencyFrames: 64 } : node)
    // Convergence at the master: each route waits for the slowest path, as resolveMixerTiming gives it.
    const edges = base.edges.map((edge) => ({ ...edge, pdcDelayFrames: edge.fromNodeId === 'a' || !trackIds.includes('a') ? 0 : 64 }))
    return { ...base, revision, nodes, edges }
  }
  const attempt = async (before: readonly string[], after: readonly string[]) => {
    const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
    const messages: PortableWasmStatusMessage[] = []
    const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
    expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
    host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 40, snapshot: withLatency(before, 5) })
    host.handleMessage({ version: 2, type: 'publish-graph', requestId: 41, revision: 5 })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'graph-published', requestId: 41, result: 'published' }))
    host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 60, snapshot: withLatency(after, 6) })
    host.handleMessage({ version: 2, type: 'publish-graph', requestId: 61, revision: 6, requireContinuity: true })
    return messages.flatMap((message) => message.type === 'graph-continuity' && message.revision === 6 ? [message.result] : [])[0] === 'accepted'
  }
  const results = {
    deleteLatencyFree: await attempt(['a', 'b'], ['a']),
    deleteLatencyBearing: await attempt(['a', 'b'], ['b']),
    addLatencyFree: await attempt(['a'], ['a', 'b']),
    addLatencyFreeWithoutLatencyElsewhere: await attempt(['b'], ['b', 'c']),
  }
  expect(results).toEqual({ deleteLatencyFree: true, deleteLatencyBearing: true, addLatencyFree: true, addLatencyFreeWithoutLatencyElsewhere: true })
})

// AE-08 phase 8 step 9f: effects inserted, removed and reordered at a seam on the built core (class 4a). Survivors keep
// their history by instance id (CORE:7640-7654); a removed one is a ghost that fades over 5 ms (CORE:7806, 7929-7976;
// D-3); a node whose stages were reordered dips for 5 ms (CORE:5452-5459, 8311-8335). The same shared core code renders on
// native (nothing in these ranges is under DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS).
const fxProcessor = (id: string, instanceId: number, kind: string, kindId: number, state: Uint8Array, latencyFrames = 0) => ({
  id, instanceId, kind, kindId, stateVersion: 1, state, parameterTargets: [], bypassed: false, latencyFrames, tailFrames: 0,
})
const fxUtility = (id: string, instanceId: number, gainDb: number, latencyFrames = 0) =>
  fxProcessor(id, instanceId, 'utility', 1, encodeUtilityProcessorState({ ...createDefaultUtilityParams(), gainDb }), latencyFrames)
const fxEq = (id: string, instanceId: number, type: 'peaking' | 'highshelf' = 'peaking') => fxProcessor(id, instanceId, 'eq', 3, encodeEqProcessorState({
  enabled: true, channelMode: 'stereo',
  bands: Array.from({ length: 8 }, (_, index) => ({ enabled: index === 0, type, frequency: 1_000, gainDb: 12, q: 1 })),
}))
type FxProcessor = ReturnType<typeof fxUtility>
const fxGraph = (revision: number, chains: Record<string, readonly FxProcessor[]>) => {
  const base = portableTrackGraph(Object.keys(chains))
  return { ...base, revision, nodes: base.nodes.map((node) => ({ ...node, processorOrder: chains[node.id] ?? [] })) }
}
const fxSine = new Float32Array(48_000).map((_, frame) => Math.fround(Math.sin(2 * Math.PI * 1_000 * frame / 48_000)))
const playSineThrough = async (chains: Record<string, readonly FxProcessor[]>) => {
  const { host, messages } = await startPortableTracks(Object.keys(chains), fxGraph(1, chains))
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'register-asset', requestId: 5, generation: 0,
    asset: { version: 1, assetId: 'sine', frameCount: 48_000, sampleRateHz: 48_000, channelCount: 2 }, planes: [fxSine, fxSine] })
  host.handleMessage({ version: 2, type: 'schedule-sources', requestId: 6, revision: 1, epoch: 1,
    events: Object.keys(chains).map((nodeId, index) => ({ ...rampSource(index + 1, 0, 48_000, 1, nodeId), assetId: 'sine' })) })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'sources-scheduled', requestId: 6, result: 'scheduled' }))
  return { host, messages }
}
const fxSeam = 1_664
// `before` plays 12 blocks, then the adoption of `after` publishes at frame 1664 and 8 more blocks render.
const adoptEffects = async (before: readonly FxProcessor[], after: readonly FxProcessor[]) => {
  const { host, messages } = await playSineThrough({ track: before })
  const rendered = renderBlocks(host, 12)
  const { installed } = adoptRevision(host, messages, fxGraph(2, { track: after }), [], fxSeam)
  rendered.push(...renderBlocks(host, 8))
  // A framed publish is answered by the block that applies it.
  return { rendered, adoption: { installed, published: publishedResults(messages, 2) } }
}
const referenceThrough = async (chain: readonly FxProcessor[]) => renderBlocks((await playSineThrough({ track: chain })).host, 20)
// How much of `signal`'s departure from `base` the `rendered` signal has over `[from, from + length)`: 1 is `signal`, 0 is `base`.
const weightOf = (rendered: readonly number[], base: readonly number[], signal: readonly number[], from: number, length = 48) => {
  let along = 0
  let power = 0
  for (let frame = from; frame < from + length; frame += 1) {
    along += (rendered[frame] - base[frame]) * (signal[frame] - base[frame])
    power += (signal[frame] - base[frame]) ** 2
  }
  return along / power
}
const largestDifference = (left: readonly number[], right: readonly number[], from: number, to: number) =>
  Math.max(...left.slice(from, to).map((sample, index) => Math.abs(sample - right[from + index])))
const adopted: ReturnType<typeof adoptRevision> = { installed: 'installed', published: 'published' }
const adoptedAtSeam: Awaited<ReturnType<typeof adoptEffects>>['adoption'] = { installed: 'installed', published: ['published'] }

test('W-C9-fx-2 a removed EQ fades out over its 5 ms ghost from the seam, with no step, and is gone after it', async () => {
  const eq = fxEq('eq-a', 31)
  const { rendered, adoption } = await adoptEffects([eq], [])
  const withEq = await referenceThrough([eq])
  const dry = await referenceThrough([])
  const weights = Array.from({ length: 5 }, (_, window) => weightOf(rendered, dry, withEq, fxSeam + 48 * window))
  expect({ adoption, untouchedBefore: largestDifference(rendered, withEq, 0, fxSeam) < 1e-6,
    boosted: Math.max(...withEq.slice(fxSeam - 96, fxSeam).map(Math.abs)) > 3.5,
    falling: weights.every((weight, index) => index === 0 || weight < weights[index - 1]), starts: weights[0] > 0.85, ends: weights[4] < 0.25,
    noStep: Math.abs(rendered[fxSeam] - withEq[fxSeam]) < 0.05,
    goneAfter: largestDifference(rendered, dry, fxSeam + 240, 20 * 128) < 1e-6 })
    .toEqual({ adoption: adoptedAtSeam, untouchedBefore: true, boosted: true, falling: true, starts: true, ends: true, noStep: true, goneAfter: true })
})

test('W-C9-fx-3 an inserted effect fades in from the seam and settles on the reference chain after its entry', async () => {
  const half = fxUtility('util-a', 41, -6)
  const { rendered, adoption } = await adoptEffects([], [half])
  const processed = await referenceThrough([half])
  const dry = await referenceThrough([])
  const weights = Array.from({ length: 10 }, (_, window) => weightOf(rendered, dry, processed, fxSeam + 48 * window))
  expect({ adoption, untouchedBefore: largestDifference(rendered, dry, 0, fxSeam) < 1e-6, startsDry: weights[0] < 0.1,
    risesToProcessed: weights.every((weight, index) => index === 0 || weight > weights[index - 1]) && weights[9] > 0.9,
    settledAfter: largestDifference(rendered, processed, fxSeam + 600, 20 * 128) < 5e-3 })
    .toEqual({ adoption: adoptedAtSeam, untouchedBefore: true, startsDry: true, risesToProcessed: true, settledAfter: true })
})

test('W-C9-fx-4 a reorder dips the node to nothing and back over 5 ms around the seam and keeps its history, so the steady output is the same', async () => {
  const half = fxUtility('util-a', 41, -6)
  const eq = fxEq('eq-a', 31)
  const { rendered, adoption } = await adoptEffects([half, eq], [eq, half])
  const reference = await referenceThrough([half, eq])
  const gains = Array.from({ length: 10 }, (_, window) => weightOf(rendered, reference.map(() => 0), reference, fxSeam + 24 * window, 24))
  expect({ adoption, untouchedBefore: largestDifference(rendered, reference, 0, fxSeam) < 1e-6, startsNearFull: gains[0] > 0.85,
    dipsToNothing: Math.min(...gains) < 0.1, backNearFull: gains[9] > 0.8,
    steadyAfter: largestDifference(rendered, reference, fxSeam + 600, 20 * 128) < 5e-3 })
    .toEqual({ adoption: adoptedAtSeam, untouchedBefore: true, startsNearFull: true, dipsToNothing: true, backNearFull: true, steadyAfter: true })
})

// AE-08 phase 8 step 9h: a delaying effect inserted or removed at a seam. The node's latency is its processors' sum, as
// graph-contract gives it, and a route that meets the delayed one waits for it. Track `a` carries the effect, track
// `b` plays the sine: the core moves b's read head, so b's output is its own signal delayed by the effect's latency.
const fxLimiter = (id: string, instanceId: number) => fxProcessor(id, instanceId, 'limiter', 12, encodeLimiterProcessorState(
  { enabled: true, ceilingDbtp: -1, releaseMs: 100, lookaheadMs: 5, link: 1, detectorOversampling: 4 }), 240)
const adoptDelaying = async (before: readonly FxProcessor[], after: readonly FxProcessor[]) => {
  const withLatency = (revision: number, chain: readonly FxProcessor[]) => {
    const graph = fxGraph(revision, { a: chain, b: [] })
    const latencyFrames = chain.reduce((sum, processor) => sum + processor.latencyFrames, 0)
    return { ...graph, nodes: graph.nodes.map((node) => node.id === 'a' ? { ...node, latencyFrames } : node),
      edges: graph.edges.map((edge) => ({ ...edge, pdcDelayFrames: edge.fromNodeId === 'b' ? latencyFrames : 0 })) }
  }
  const { host, messages } = await startPortableTracks(['a', 'b'], withLatency(1, before))
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'register-asset', requestId: 5, generation: 0,
    asset: { version: 1, assetId: 'sine', frameCount: 48_000, sampleRateHz: 48_000, channelCount: 2 }, planes: [fxSine, fxSine] })
  host.handleMessage({ version: 2, type: 'schedule-sources', requestId: 6, revision: 1, epoch: 1,
    events: [{ ...rampSource(1, 0, 48_000, 1, 'b'), assetId: 'sine' }] })
  const rendered = renderBlocks(host, 12)
  const { installed } = adoptRevision(host, messages, withLatency(2, after), [], fxSeam)
  rendered.push(...renderBlocks(host, 20))
  return { rendered, adoption: { installed, published: publishedResults(messages, 2) },
    continuity: messages.findLast((message) => message.type === 'graph-continuity')?.result }
}
// How closely `rendered` is the sine delayed by `delay` frames over `[from, to)`.
const delayedSineError = (rendered: readonly number[], delay: number, from: number, to: number) =>
  Math.max(...rendered.slice(from, to).map((sample, index) => Math.abs(sample - fxSine[from + index - delay])))

test('W-C9-fx-8 a limiter inserted at the seam is adopted and the other track is delayed to stay aligned with it', async () => {
  const { rendered, adoption, continuity } = await adoptDelaying([], [fxLimiter('lim-a', 51)])
  expect({ adoption, continuity, undelayedBefore: delayedSineError(rendered, 0, 240, fxSeam) < 1e-6,
    delayedAfter: delayedSineError(rendered, 240, fxSeam + 1_200, rendered.length) < 1e-4 })
    .toEqual({ adoption: adoptedAtSeam, continuity: 'accepted', undelayedBefore: true, delayedAfter: true })
})

test('W-C9-fx-9 a limiter removed at the seam is adopted and the other track keeps its delay, with no step', async () => {
  const { rendered, adoption, continuity } = await adoptDelaying([fxLimiter('lim-a', 51)], [])
  expect({ adoption, continuity, delayedThroughout: delayedSineError(rendered, 240, 480, rendered.length) < 1e-4 })
    .toEqual({ adoption: adoptedAtSeam, continuity: 'accepted', delayedThroughout: true })
})

// The 6 removed effects of three nodes fade as ghosts (96 of the 128 the core holds); a second removal of 64 inside the same
// 5 ms needs 160 and its prepare is refused (CORE:7958-7960). Native refuses it the same way (HOST:2968-2981). The UD 8
// retry waits one position report, which is at least 2400 frames (WK:2462), against the 240 frame fade: it prepares.
test('W-C9-fx-7 a removal of more than 128 effects inside one ghost fade is refused at its prepare and the retry one position report later succeeds', async () => {
  const chains = (kept: readonly string[]) => Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id, node) => [id,
    kept.includes(id) ? Array.from({ length: 32 }, (_, index) => fxUtility(`${id}-${index}`, 1_000 + node * 32 + index, -1)) : []]))
  const { host, messages } = await playSineThrough(chains(['a', 'b', 'c', 'd', 'e']))
  renderBlocks(host, 12)
  const first = adoptRevision(host, messages, fxGraph(2, chains(['d', 'e'])), [])
  renderBlocks(host, 1)
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 30, snapshot: fxGraph(3, chains([])) })
  const refused = messages.flatMap((message) => message.type === 'graph-prepared' && message.requestId === 30 ? [message.result] : [])
  renderBlocks(host, 19)
  const retried = adoptRevision(host, messages, fxGraph(4, chains([])), [])
  const frames = messages.flatMap((message) => message.type === 'transport-position' ? [message.frame] : [])
  expect({ first, refused, retried, cadence: Math.min(...frames.slice(1).map((frame, index) => frame - frames[index])) >= 2_400 })
    .toEqual({ first: adopted, refused: ['rejected'], retried: adopted, cadence: true })
})

// AE-08 phase 8 step 9g: instrument replacement, a non-live effect edit and a Granular sample change at a seam on the built
// core (class 5). The replaced node's old slot keeps rendering and crossfades out (CORE:8162-8194, 8297-8305, 5385-5417);
// the held note is released by the note-off at the seam and the spanning note-on starts the new instrument (D-5).
const startInstrumentHost = async (first: AudioCoreInstrumentState, noteOnFrame: number) => {
  const { DawPortableAudioCoreHost } = await import(hostV2Url.href)
  const messages: PortableWasmStatusMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: PortableWasmStatusMessage) => messages.push(message), close: () => undefined })
  expect(await host.initialize({ wasmBytes: await Bun.file(wasmUrl).arrayBuffer(), contractHash: 'test-contract', maxFramesPerBlock: 128 })).toBe(true)
  for (const [requestId, assetId, step] of [[900, 'held-sine', 0.05], [901, 'held-sine-fast', 0.1]] as const) {
    const plane = new Float32Array(sineFrames).map((_, frame) => Math.sin(step * frame))
    host.handleMessage({ version: 2, type: 'register-asset', requestId, generation: 0,
      asset: { version: 1, assetId, frameCount: sineFrames, sampleRateHz: 48_000, channelCount: 2 }, planes: [plane, plane] })
  }
  const base = portableTrackGraph(['track'])
  const graph = (revision: number, instrument: AudioCoreInstrumentState) => ({ ...base, revision,
    nodes: base.nodes.map((node) => node.id === 'track' ? { ...node, kind: 'instrument', instrument } : node) })
  host.handleMessage({ version: 2, type: 'prepare-graph', requestId: 1, snapshot: graph(1, first) })
  host.handleMessage({ version: 2, type: 'publish-graph', requestId: 2, revision: 1 })
  host.handleMessage({ version: 2, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({ version: 2, type: 'install-schedule', requestId: 4, schedule: {
    revision: 1, transportEpoch: 1, sampleRateHz: 48_000, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: [seamNoteOn(noteOnFrame, 1)] } })
  return { host, messages, graph }
}
// The output of `first` playing the note from `noteOnFrame`, or of `first` replaced by `replacement` at the seam, from frame 0.
const playInstrumentRun = async (first: AudioCoreInstrumentState, noteOnFrame: number, replacement?: AudioCoreInstrumentState) => {
  const { host, messages, graph } = await startInstrumentHost(first, noteOnFrame)
  const rendered = renderBlocks(host, noteSeam / 128)
  const adoption = replacement ? adoptRevision(host, messages, graph(2, replacement), [seamNoteOff(noteSeam, 1), seamNoteOn(noteSeam, 2)], noteSeam) : undefined
  rendered.push(...renderBlocks(host, 14))
  // A framed publish is answered by the block that applies it.
  return { rendered, adoption: adoption && { installed: adoption.installed, published: publishedResults(messages, 2) } }
}
const replacedInstrumentWeights = (replaced: readonly number[], old: readonly number[], fresh: readonly number[]) =>
  Array.from({ length: 6 }, (_, window) => weightOf(replaced, old, fresh, noteSeam + 48 * window))

test('W-C9-inst-3 a Synth replaced by a Sampler at the seam keeps rendering as it crossfades out and the Sampler sounds alone after the blend', async () => {
  const sampler = heldSampler('sampler', 1, 8)
  const { rendered, adoption } = await playInstrumentRun(heldSynth, 0, sampler)
  const old = (await playInstrumentRun(heldSynth, 0)).rendered
  const fresh = (await playInstrumentRun(sampler, noteSeam)).rendered
  const weights = replacedInstrumentWeights(rendered, old, fresh)
  expect({ adoption, untouchedBefore: largestDifference(rendered, old, 0, noteSeam) < 1e-6, startsOld: weights[0] < 0.2,
    risesToNew: weights.every((weight, index) => index === 0 || weight > weights[index - 1]) && weights[5] > 0.8,
    noStep: largestStep(rendered.slice(noteSeam - 8, noteSeam + blendFrames)) < 0.1,
    newAloneAfter: largestDifference(rendered, fresh, noteSeam + blendFrames + 128, 20 * 128) < 1e-4 })
    .toEqual({ adoption: adoptedAtSeam, untouchedBefore: true, startsOld: true, risesToNew: true, noStep: true, newAloneAfter: true })
})

test('W-C9-asset-7 a Granular cloud whose sample changes at the seam plays the new sample from the spanning note-on', async () => {
  const { rendered, adoption } = await playInstrumentRun(granularCloud('hann'), 0, granularCloud('hann', 0.5, 20, 'held-sine-fast'))
  const before = rendered.slice(noteSeam - 1280, noteSeam)
  const after = rendered.slice(-1280)
  expect({ adoption, audible: peakOf(rendered.slice(noteSeam + blendFrames, noteSeam + blendFrames + 1280)) > 0.02, faster: zeroCrossings(after) > 1.5 * zeroCrossings(before) })
    .toEqual({ adoption: adoptedAtSeam, audible: true, faster: true })
})

// A parameter the live path does not take replaces the effect's slot (CORE:7542-7609, 8713-8717): the history starts again,
// as it does on native through the same core call. The bypass position is handed over (CORE:8276-8289), so the output has
// no step at the seam, and it settles on what the edited effect plays from the start.
test('W-C9-proc-3 a non-live EQ band type edit at the seam is continuous and settles on the edited chain', async () => {
  const before = fxEq('eq-a', 31)
  const after = fxEq('eq-a', 31, 'highshelf')
  const { rendered, adoption } = await adoptEffects([before], [after])
  const reference = await referenceThrough([before])
  const edited = await referenceThrough([after])
  expect({ adoption, untouchedBefore: largestDifference(rendered, reference, 0, fxSeam) < 1e-6,
    differentChains: largestDifference(reference, edited, 600, 20 * 128) > 0.5,
    noStep: largestStep(rendered.slice(fxSeam - 8, fxSeam + 240)) < 2 * Math.max(largestStep(reference.slice(fxSeam - 8, fxSeam + 240)), largestStep(edited.slice(fxSeam - 8, fxSeam + 240))),
    settledAfter: largestDifference(rendered, edited, fxSeam + 1_200, 20 * 128) < 5e-3 })
    .toEqual({ adoption: adoptedAtSeam, untouchedBefore: true, differentChains: true, noStep: true, settledAfter: true })
})

// A node carries at most kMaximumNodeBlends = 8 unfinished replacements (CORE:64, 8297-8305). The instruments are configured
// from the registry when the revision publishes (WK:1162-1182), which is where the ninth replacement is refused: the publish
// is rejected and the playing graph stays. Native configures through the same core call and fails the same way.
test('W-C9-inst-5 a ninth replacement inside one blend window has its publish rejected and publishes once the blends have run', async () => {
  const { host, messages, graph } = await startInstrumentHost(heldSynth, noteSeam)
  const replaced = (revision: number): AudioCoreInstrumentState => ({ ...heldSynth, oscillators: [{ enabled: true, waveform: revision % 2 === 0 ? 1 : 2, level: 0.8, octave: 0, semitone: 0, detuneCents: 0 }, ...heldSynth.oscillators?.slice(1) ?? []] })
  // Replacements 16 frames apart: the first eight are all inside the 288 frame blend of the first.
  const adoptAfter = (revision: number, frames: number) => {
    adoptRevision(host, messages, graph(revision, replaced(revision)), [])
    renderLeft(host, frames)
    return publishedResults(messages, revision)
  }
  const first8 = Array.from({ length: 8 }, (_, index) => adoptAfter(index + 2, 16))
  const ninth = adoptAfter(10, 16)
  renderBlocks(host, 4)
  expect({ first8, ninth, retried: adoptAfter(11, 128) })
    .toEqual({ first8: Array.from({ length: 8 }, () => ['published']), ninth: ['rejected'], retried: ['published'] })
})
