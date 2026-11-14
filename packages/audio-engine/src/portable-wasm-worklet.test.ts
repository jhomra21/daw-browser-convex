import { expect, test } from 'bun:test'
import { portableAudioCoreWorklet } from './worklet-manifest'
import { PortableWasmPlaybackSession } from './backends/wasm-audio-worklet-backend'
import type { PortableWasmControlMessage } from './portable-wasm-protocol'

const publicRoot = new URL('../../../public/', import.meta.url)

test('instrument parameter delivery waits for an applied ack and rejects retirement', async () => {
  const posted: PortableWasmControlMessage[] = []
  const node: AudioWorkletNode = Object.assign(Object.create(null), {
    port: {
      onmessage: null,
      postMessage: (message: PortableWasmControlMessage) => posted.push(message),
      close: () => undefined,
    },
    disconnect: () => undefined,
    onprocessorerror: null,
  })
  const session = new PortableWasmPlaybackSession(node)
  const events = [{ nodeId: 'track', type: 'parameter', noteId: 1, sequence: 1, frameOffset: 0, channel: 0, note: 3, value: 913 }] satisfies Parameters<typeof session.queueInstrumentEvents>[1]
  let settled = false
  const delivery = session.queueInstrumentEvents(2, events,
    process.env.DAW_INSTRUMENT_R21_ACK_BASELINE === '1' ? undefined : { revision: 3, sequence: 4 })
    .then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(posted[0]).toEqual({ version: 2, type: 'instrument-parameters', requestId: 1, revision: 3, epoch: 2, sequence: 4, events })
  node.port.onmessage?.(new MessageEvent('message', { data: {
    version: 2, type: 'instrument-events-applied', requestId: 1, revision: 3, epoch: 2, sequence: 4, result: 'applied',
  } }))
  await delivery
  expect(settled).toBe(true)
  const retired = session.queueInstrumentEvents(2, events, { revision: 3, sequence: 5 })
  session.dispose()
  await expect(retired).rejects.toThrow('disposed')
})

type WorkletMessage = {
  type: string
  version?: number
  abiVersion?: number
  wasmModule?: object
  requestId?: number
  revision?: number
  epoch?: number
  sequence?: number
  result?: string
  events?: object[]
}
type AudioBlocks = Float32Array[][]
type RegisteredHost = {
  handleMessage: (message: WorkletMessage) => void
  process: (inputs: AudioBlocks, outputs: AudioBlocks) => boolean
}
type RegisteredProcessor = {
  host: RegisteredHost
  port: { onmessage: ((event: { data: WorkletMessage }) => void) | null; postMessage: () => void; close: () => void }
  process: (inputs: AudioBlocks, outputs: AudioBlocks) => boolean
}

// Runs `run` with the allocating entry points of the real-time thread counted.
// Object and array literals cannot be observed; constructors, array copies and pushes can.
const observeRealtimeAllocations = (run: () => void) => {
  const calls: string[] = []
  // Recording must not go through the Array methods being observed.
  const record = (call: string) => { calls[calls.length] = call }
  const restores: Array<() => void> = []
  const counted = (name: string, constructor: typeof Float32Array | typeof Uint32Array | typeof Uint8Array | typeof Map | typeof Set | typeof DataView) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    const proxy = new Proxy(constructor, {
      construct(target, args, newTarget) {
        record(`new ${name}`)
        return Reflect.construct(target, args, newTarget)
      },
    })
    Object.defineProperty(globalThis, name, { value: proxy, configurable: true, writable: true })
    if (original) restores[restores.length] = () => Object.defineProperty(globalThis, name, original)
  }
  counted('Float32Array', Float32Array)
  counted('Uint32Array', Uint32Array)
  counted('Uint8Array', Uint8Array)
  counted('Map', Map)
  counted('Set', Set)
  counted('DataView', DataView)
  for (const name of ['map', 'filter', 'push', 'slice', 'concat']) {
    const original = Object.getOwnPropertyDescriptor(Array.prototype, name)
    Object.defineProperty(Array.prototype, name, { value: () => { record(`.${name}()`); return [] }, configurable: true, writable: true })
    if (original) restores[restores.length] = () => Object.defineProperty(Array.prototype, name, original)
  }
  for (const name of ['log', 'warn', 'error']) {
    const original = Object.getOwnPropertyDescriptor(console, name)
    Object.defineProperty(console, name, { value: () => record(`console.${name}`), configurable: true, writable: true })
    if (original) restores[restores.length] = () => Object.defineProperty(console, name, original)
  }
  try {
    run()
  } finally {
    restores.reverse().forEach((restore) => restore())
  }
  return calls
}

const stubWebAssembly = (calls: string[], names: Array<'instantiate' | 'compile'>) => {
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(WebAssembly, name))
  for (const name of names) {
    Object.defineProperty(WebAssembly, name, { value: () => { calls[calls.length] = `WebAssembly.${name}`; return new Promise(() => undefined) }, configurable: true, writable: true })
  }
  return () => names.forEach((name, index) => {
    const original = originals[index]
    if (original) Object.defineProperty(WebAssembly, name, original)
  })
}

const readyPortableHost = async (version: 1 | 2) => {
  const { DawPortableAudioCoreHost } = await import(new URL(`audio-worklets/daw-portable-audio-core-host-v${version}.js`, publicRoot).href)
  const messages: WorkletMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: 48_000, postMessage: (message: WorkletMessage) => { messages[messages.length] = message }, close: () => undefined })
  Object.assign(host, {
    ready: true, revision: 1, maxFramesPerBlock: 128, transportEpoch: 1,
    memory: { buffer: new ArrayBuffer(65536) }, malloc: () => 8, free: () => undefined, graphSetTransport: () => 0,
    inputPlanes: Array.from({ length: 128 }, () => new Float32Array(128)),
    leftOutput: new Float32Array(128), rightOutput: new Float32Array(128),
    eventOffset: 1, eventBufferView: new DataView(new ArrayBuffer(4)),
  })
  return { host, messages }
}

test('portable Wasm worklet defers initialization and keeps process allocation-free', async () => {
  let registered: (new (options: { processorOptions: { wasmModule: object } }) => RegisteredProcessor) | undefined
  const scope = {
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: () => undefined, close: () => undefined } },
    registerProcessor: (_name: string, processor: typeof registered) => { registered = processor },
    sampleRate: 48_000,
  }
  const previous = Object.fromEntries(Object.keys(scope).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, scope)
  // Construction compiles nothing: Wasm is instantiated only when the main thread sends `initialize`.
  const wasmModule = { compiled: true }
  const compiles: string[] = []
  let processor: RegisteredProcessor
  const restoreWasm = stubWebAssembly(compiles, ['instantiate'])
  try {
    await import(new URL(portableAudioCoreWorklet.modulePath, publicRoot).href)
    if (!registered) throw new Error('The portable worklet did not register its processor.')
    processor = new registered({ processorOptions: { wasmModule } })
  } finally {
    restoreWasm()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  expect(compiles).toEqual([])

  const received: WorkletMessage[] = []
  processor.host.handleMessage = (message) => { received.push(message) }
  processor.port.onmessage?.({ data: { type: 'initialize', abiVersion: 1 } })
  processor.port.onmessage?.({ data: { type: 'transport', epoch: 2 } })
  expect(received).toEqual([{ type: 'initialize', abiVersion: 1, wasmModule }, { type: 'transport', epoch: 2 }])

  const inputs = [[new Float32Array(1)]]
  const outputs = [[new Float32Array(1)]]
  const processed: AudioBlocks[][] = []
  processor.host.process = (...args) => { processed.push(args); return false }
  expect(processor.process(inputs, outputs)).toBe(false)
  expect(processed).toEqual([[inputs, outputs]])

  // A running host renders through the core for the output block size without compiling, allocating or logging.
  const { host } = await readyPortableHost(2)
  const rendered: number[] = []
  host.coreProcess = (frames: number) => { rendered[rendered.length] = frames; return 0 }
  const block = [[new Float32Array(128), new Float32Array(128)]]
  const touched: string[] = []
  const restoreCompile = stubWebAssembly(touched, ['instantiate', 'compile'])
  try {
    touched.push(...observeRealtimeAllocations(() => { host.process([], block) }))
  } finally {
    restoreCompile()
  }
  expect(rendered).toEqual([128])
  expect(touched).toEqual([])
})

test('portable worklet writes the native graph v3 node layout and bounded installed schedules', async () => {
  const source = await Bun.file(new URL('audio-worklets/daw-portable-audio-core-host-v2.js', publicRoot)).text()
  const graphEnvelopeSource = await Bun.file(new URL('audio-worklets/daw-portable-graph-envelope-v3.js', publicRoot)).text()
  const materializeStart = source.indexOf('  materializeSchedule(startFrame, frameCount)')
  const materializeBody = source.slice(materializeStart, source.indexOf('\n  process(inputs, outputs)', materializeStart))
  expect(source).toContain('SUPPORTED_GRAPH_ENVELOPE_VERSIONS')
  expect(source).toContain("from './daw-portable-graph-envelope-v3.js'")
  expect(graphEnvelopeSource).toContain('view.setBigUint64(mixerOffset, BigInt(mixer ? mixer.instanceId : 0), true)')
  expect(source).toContain('nodes.length * (envelopeView.getUint32')
  expect(source).toContain("message.type === 'install-schedule'")
  expect(source).toContain("type: 'schedule-installed'")
  expect(source).toContain('this.scheduleEventOffset = exports.malloc(4 + 256 * 20)')
  expect(source).toContain('this.scheduleInstrumentEventOffset = exports.malloc(4 + 256 * 48)')
  expect(materializeBody).not.toContain('this.schedule.events')
  expect(materializeBody).not.toContain('stableId(')
  expect(materializeBody).not.toContain('BigInt(')
  expect(materializeBody).toContain('stream.cursor')
  expect(materializeBody).toContain('this.scheduleInstrumentCursor')
  expect(source).toContain('const busesToWrite = Math.max(stagedInputBusCount, this.stagedInputBusCount)')
  expect(source).not.toContain('for (let bus = 0; bus < MAX_INPUT_BUSES; bus += 1)')
})

test('portable live processor overrides stay within the core event envelope without faulting on overflow', async () => {
  const source = await Bun.file(new URL('audio-worklets/daw-portable-audio-core-host-v2.js', publicRoot)).text()
  expect(source).toContain('const MAX_PROCESSOR_OVERRIDE_TARGETS = 256')
  expect(source).not.toContain('const MAX_PROCESSOR_OVERRIDE_TARGETS = 512')
  expect(source).toContain('if (newKeys.size > availableSlots)')
  expect(source).toContain("if (count >= MAX_PROCESSOR_EVENTS) break")
  expect(source).toContain("if (count >= MAX_PROCESSOR_EVENTS) continue")
})

test('both hosts keep live instrument merging and acknowledgement allocation-free', async () => {
  for (const version of [1, 2] as const) {
    const { host, messages } = await readyPortableHost(version)
    host.handleMessage({ version, type: 'instrument-parameters', requestId: 7, revision: 1, sequence: 1, epoch: 1,
      events: [{ nodeId: 'track', type: 'parameter', noteId: 1, sequence: 1, frameOffset: 0, channel: 0, note: 3, value: 913 }] })
    Object.assign(host, {
      schedule: { transportEpoch: 1, revision: 1 },
      scheduleEventView: new DataView(new ArrayBuffer(4 + 256 * 20)),
      scheduleInstrumentEventView: new DataView(new ArrayBuffer(4 + 256 * 48)),
      scheduleParameterStreams: [],
      scheduleInstrumentEvents: [{ frame: 0, nodeId: 1n, noteId: 1n, sequence: 1n, type: 1, pitch: 60, value: 1 }],
    })

    let materialized = false
    expect(observeRealtimeAllocations(() => { materialized = host.materializeSchedule(0, 128) })).toEqual([])
    expect(materialized).toBe(true)
    // The live parameter is merged after the scheduled note and both reach the core block.
    expect(host.materializedLiveInstrumentCount).toBe(1)
    expect(host.scheduleInstrumentEventCount).toBe(2)

    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'instrument-events-applied' }))
    expect(observeRealtimeAllocations(() => { host.flushInstrumentAcks('applied') })).toEqual([])
    expect(messages).toContainEqual({ version, type: 'instrument-events-applied', requestId: 7, revision: 1, epoch: 1, sequence: 1, result: 'applied' })
  }
})

test('B6f5 the portable worklet stages schedules, refuses discontinuous adoptions and leaves encoding off its thread', async () => {
  const source = await Bun.file(new URL('audio-worklets/daw-portable-audio-core-host-v2.js', publicRoot)).text()
  const publishStart = source.indexOf("if (message.type === 'publish-graph'")
  const prepareStart = source.indexOf("if (message.type === 'prepare-graph')")
  const publishBody = source.slice(publishStart, source.indexOf("if (message.type === 'prepare-graph')", publishStart))
  const prepareBody = source.slice(prepareStart, source.indexOf("if (message.type === 'utility-state'", prepareStart))
  // R1: the main thread encodes the envelope; prepare hashes and copies nothing for diagnostics.
  expect(prepareBody).toContain('let envelope = message.envelope')
  expect(prepareBody).toContain('if (!(envelope instanceof Uint8Array))')
  expect(prepareBody).not.toContain('byteHash(')
  expect(prepareBody).not.toContain('Array.from(')
  expect(prepareBody).not.toContain('.reduce(')
  // An adoption is refused before any instrument of the playing graph is reconfigured, and swaps its staged schedule in.
  expect(publishBody).toContain('message.requireContinuity === true')
  expect(publishBody.indexOf('const refused')).toBeLessThan(publishBody.indexOf('this.publishPrepared('))
  expect(publishBody).not.toContain('this.configureInstruments(')
  expect(source).toContain('this.commitSchedule(staged, true, seam)')
  expect(source).toContain('if (staged) this.stagedSchedule = built')
  // The source-bus counters left unused when portable sources stopped reading live buses.
  expect(source).not.toContain('liveInputBusCount')
  expect(source).not.toContain('preparedInputBusCount')
})
