const protocolVersion = 1

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const waitFor = (messages, predicate, label) => new Promise((resolve, reject) => {
  const existing = messages.find(predicate)
  if (existing) {
    resolve(existing)
    return
  }
  const timeout = setTimeout(() => {
    reject(new Error(`Timed out waiting for ${label}.`))
  }, 20_000)
  const observer = () => {
    const next = messages.find(predicate)
    if (!next) return
    clearTimeout(timeout)
    window.removeEventListener('portable-wasm-status', observer)
    resolve(next)
  }
  window.addEventListener('portable-wasm-status', observer)
})

const sourceNode = (id, bus) => ({
  id,
  kind: 'source',
  inputLayout: 'stereo',
  outputLayout: 'stereo',
  latencyFrames: 0,
  processorOrder: [],
  bus,
})


const graphSnapshot = {
  version: 1,
  revision: 1,
  contractHash: 'electron-worklet-fixture',
  masterNodeId: 'master',
  assets: [],
  nodes: [
    sourceNode('source-a', 0),
    {
      id: 'master',
      kind: 'master',
      inputLayout: 'stereo',
      outputLayout: 'stereo',
      latencyFrames: 0,
      processorOrder: [],
    },
  ],
  edges: [
    {
      version: 1,
      id: 'source-a-to-master',
      fromNodeId: 'source-a',
      toNodeId: 'master',
      gain: 1,
      kind: 'output',
      tap: 'post-fader',
      sidechain: false,
      pdcDelayFrames: 0,
    },
  ],
}

window.runPortableWasmWorkletFixture = (async () => {
  const manifest = await (await fetch('./audio-core/daw-audio-core.manifest.json')).json()
  const wasm = await (await fetch(manifest.wasmUrl)).arrayBuffer()
  const wasmModule = await WebAssembly.compile(wasm)
  const context = new AudioContext({ sampleRate: 48_000 })
  await context.audioWorklet.addModule('./audio-worklets/daw-portable-audio-core-processor-v1.js')
  const node = new AudioWorkletNode(context, 'daw-portable-audio-core-processor-v1', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { wasmModule },
  })
  const messages = []
  node.port.onmessage = (event) => {
    messages.push(event.data)
    window.dispatchEvent(new Event('portable-wasm-status'))
  }
  node.onprocessorerror = () => {
    throw new Error('The AudioWorklet processor crashed.')
  }
  const analyser = context.createAnalyser()
  analyser.fftSize = 128
  node.connect(analyser)
  analyser.connect(context.destination)

  await context.resume()
  node.port.postMessage({
    version: protocolVersion,
    type: 'initialize',
    abiVersion: 1,
    contractHash: manifest.contractHash,
    maxFramesPerBlock: 256,
  })
  const initialization = await waitFor(messages, (message) => message.type === 'ready' || message.type === 'fault', 'AudioWorklet initialization')
  assert(initialization.type === 'ready', `The AudioWorklet initialization faulted with ${initialization.code}.`)
  node.port.postMessage({ version: protocolVersion, type: 'prepare-graph', requestId: 1, snapshot: graphSnapshot })
  const prepared = await waitFor(messages, (message) => message.type === 'graph-prepared' && message.requestId === 1, 'graph preparation')
  assert(prepared.result === 'prepared', 'The portable graph was rejected.')
  node.port.postMessage({ version: protocolVersion, type: 'publish-graph', requestId: 2, revision: 1 })
  const published = await waitFor(messages, (message) => message.type === 'graph-published' && message.requestId === 2, 'graph publication')
  assert(published.result === 'published', 'The portable graph was not published.')
  node.port.postMessage({
    version: protocolVersion,
    type: 'register-asset',
    requestId: 3,
    generation: 1,
    asset: { version: 1, assetId: 'clip-a', frameCount: 48_000, sampleRateHz: 48_000, channelCount: 2 },
    planes: [new Float32Array(48_000).fill(0.25), new Float32Array(48_000).fill(0.25)],
  })
  const registered = await waitFor(messages, (message) => message.type === 'asset-registered' && message.requestId === 3, 'asset registration')
  assert(registered.result === 'registered', 'The portable clip asset was rejected.')
  node.port.postMessage({
    version: protocolVersion,
    type: 'transport',
    requestId: 4,
    epoch: 1,
    running: false,
    frame: 0,
  })
  const stopped = await waitFor(messages, (message) => message.type === 'transport-applied' && message.requestId === 4, 'transport stop')
  assert(stopped.result === 'applied', 'The portable transport did not stop.')
  node.port.postMessage({
    version: protocolVersion,
    type: 'schedule-sources',
    requestId: 5,
    revision: 1,
    epoch: 1,
    events: [{
      version: 1,
      epoch: 1,
      sequence: 1,
      sourceNodeId: 'source-a',
      assetId: 'clip-a',
      startFrame: 0,
      stopFrame: 48_000,
      sourceOffsetFrame: 0,
      sourceFrameCount: 48_000,
      gain: 1,
      fadeInStartFrame: 0,
      fadeInEndFrame: 0,
      fadeOutStartFrame: 48_000,
      fadeOutEndFrame: 48_000,
    }],
  })
  const scheduled = await waitFor(messages, (message) => message.type === 'sources-scheduled' && message.requestId === 5, 'clip scheduling')
  assert(scheduled.result === 'scheduled', 'The portable clip was rejected.')
  node.port.postMessage({
    version: protocolVersion,
    type: 'transport',
    requestId: 6,
    epoch: 1,
    running: true,
    frame: 0,
  })
  const started = await waitFor(messages, (message) => message.type === 'transport-applied' && message.requestId === 6, 'transport start')
  assert(started.result === 'applied', 'The portable transport did not start.')
  await new Promise((resolve) => setTimeout(resolve, 100))
  node.port.postMessage({ version: protocolVersion, type: 'diagnostics' })
  const health = await waitFor(messages, (message) => message.type === 'health', 'AudioWorklet diagnostics')
  const output = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(output)

  const fault = messages.find((message) => message.type === 'fault')
  assert(!fault, `The worklet reported a fault: ${fault && fault.code}.`)
  assert(health.framesProcessed >= output.length, 'The worklet did not process the rendered frames.')
  assert(output.every(Number.isFinite), 'The worklet emitted non-finite audio.')
  const maximumAbsoluteSample = Math.max(...output.map(Math.abs))
  assert(Math.abs(maximumAbsoluteSample - 0.25) < 0.0001, 'The portable clip did not produce the expected output.')

  node.port.postMessage({ version: protocolVersion, type: 'dispose' })
  node.disconnect(analyser)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const disconnectedOutput = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(disconnectedOutput)
  await context.close()
  return {
    framesProcessed: health.framesProcessed,
    maximumAbsoluteSample,
    maximumAbsoluteSampleAfterDisconnect: Math.max(...disconnectedOutput.map(Math.abs)),
    memoryBytes: health.memoryBytes,
    graphPrepare: health.graphPrepare,
  }
})()
