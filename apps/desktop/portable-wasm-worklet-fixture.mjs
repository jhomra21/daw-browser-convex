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

const utilityProcessor = {
  id: 'utility-a',
  kind: 'utility',
  kindId: 1,
  instanceId: 1,
  stateVersion: 1,
  state: (() => {
    const state = new Uint8Array(40)
    const view = new DataView(state.buffer)
    view.setUint32(0, 1, true)
    view.setFloat32(4, 0, true)
    view.setUint32(12, 0, true)
    view.setFloat32(24, 1, true)
    return state
  })(),
  parameterTargets: [{ id: 'utility.gainDb', target: 1 }],
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
}


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

const synthGraphSnapshot = {
  version: 1,
  revision: 2,
  contractHash: 'electron-worklet-fixture',
  masterNodeId: 'master',
  assets: [],
  nodes: [
    {
      id: 'instrument-a',
      kind: 'instrument',
      inputLayout: 'stereo',
      outputLayout: 'stereo',
      processorOrder: [utilityProcessor],
      instrument: {
        version: 1,
        kind: 'synth',
        voiceCapacity: 8,
        outputLayout: 'stereo',
        parameterTargets: [],
        oscillators: [
          { enabled: true, waveform: 0, level: 0.8, octave: 0, semitone: 0, detuneCents: 0 },
          { enabled: false, waveform: 0, level: 0, octave: 0, semitone: 0, detuneCents: 0 },
        ],
        noiseEnabled: false,
        noiseLevel: 0,
        filterEnabled: false,
        filterMode: 0,
        filterCutoffHz: 4000,
        filterResonance: 0.7,
        filterKeyTracking: 0,
        filterEnvelopeAmountOctaves: 0,
        filterAttackMs: 0,
        filterDecayMs: 0,
        filterSustain: 1,
        filterReleaseMs: 0,
        ampAttackMs: 0,
        ampDecayMs: 0,
        ampSustain: 0.8,
        ampReleaseMs: 500,
        lfoEnabled: false,
        lfoWaveform: 0,
        lfoRateHz: 1,
        lfoPitchCents: 0,
        lfoFilterOctaves: 0,
        lfoAmplitude: 0,
        lfoPan: 0,
        outputGain: 0.8,
        outputPan: 0,
      },
    },
    {
      id: 'master',
      kind: 'master',
      inputLayout: 'stereo',
      outputLayout: 'stereo',
      processorOrder: [],
    },
  ],
  edges: [
    {
      version: 1,
      id: 'instrument-a-to-master',
      fromNodeId: 'instrument-a',
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
  await context.audioWorklet.addModule('./audio-worklets/daw-portable-audio-core-processor-v2.js')
  const node = new AudioWorkletNode(context, 'daw-portable-audio-core-processor-v2', {
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
  node.onprocessorerror = (event) => {
    const details = {
      type: event?.type,
      message: event?.message,
      filename: event?.filename,
      lineno: event?.lineno,
      colno: event?.colno,
      error: event?.error ? {
        name: event.error.name,
        message: event.error.message,
        stack: event.error.stack,
      } : undefined,
    }
    console.error(`portable AudioWorklet processorerror ${JSON.stringify(details)}`)
    throw new Error(`The AudioWorklet processor crashed: ${JSON.stringify(details)}`)
  }
  const analyser = context.createAnalyser()
  analyser.fftSize = 128
  node.connect(analyser)
  analyser.connect(context.destination)

  await context.resume()
  node.port.postMessage({
    version: protocolVersion,
    type: 'initialize',
    abiVersion: 2,
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
      stopFrame: 480_000,
      sourceOffsetFrame: 0,
      sourceFrameCount: 48_000,
      gain: 1,
      fadeInStartFrame: 0,
      fadeInEndFrame: 0,
      fadeOutStartFrame: 480_000,
      fadeOutEndFrame: 480_000,
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
  await new Promise((resolve) => setTimeout(resolve, 50))
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

  node.port.postMessage({ version: protocolVersion, type: 'prepare-graph', requestId: 7, snapshot: synthGraphSnapshot })
  const synthPrepared = await waitFor(messages, (message) => message.type === 'graph-prepared' && message.requestId === 7, 'synth graph preparation')
  assert(synthPrepared.result === 'prepared', 'The portable synth graph was rejected.')
  node.port.postMessage({ version: protocolVersion, type: 'publish-graph', requestId: 8, revision: 2 })
  const synthPublished = await waitFor(messages, (message) => message.type === 'graph-published' && message.requestId === 8, 'synth graph publication')
  assert(synthPublished.result === 'published', 'The portable synth graph was not published.')
  node.port.postMessage({ version: protocolVersion, type: 'transport', requestId: 9, epoch: 2, running: false, frame: 0 })
  const synthStopped = await waitFor(messages, (message) => message.type === 'transport-applied' && message.requestId === 9, 'synth transport stop')
  assert(synthStopped.result === 'applied', 'The portable synth transport did not stop.')
  node.port.postMessage({
    version: protocolVersion,
    type: 'install-schedule',
    requestId: 10,
    schedule: {
      revision: 2,
      transportEpoch: 2,
      sampleRateHz: 48_000,
      bpm: 120,
      timeOrigin: { timelineSec: 0, frame: 0 },
      events: [
        { frame: 0, sequence: 1, type: 'note-on', target: { kind: 'instrument', trackId: 'instrument-a' }, noteId: 1, pitch: 60, velocity: 0.8 },
        { frame: 480_000, sequence: 2, type: 'note-off', target: { kind: 'instrument', trackId: 'instrument-a' }, noteId: 1, pitch: 60 },
      ],
    },
  })
  const synthInstalled = await waitFor(messages, (message) => message.type === 'schedule-installed' && message.requestId === 10, 'synth schedule installation')
  assert(synthInstalled.result === 'installed', 'The portable synth schedule was rejected.')
  node.port.postMessage({ version: protocolVersion, type: 'transport', requestId: 11, epoch: 2, running: true, frame: 0 })
  const synthStarted = await waitFor(messages, (message) => message.type === 'transport-applied' && message.requestId === 11, 'synth transport start')
  assert(synthStarted.result === 'applied', 'The portable synth transport did not start.')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const liveBefore = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(liveBefore)
  const maximumAbsoluteLiveBefore = Math.max(...liveBefore.map(Math.abs))
  node.port.postMessage({
    version: protocolVersion,
    type: 'processor-events',
    requestId: 12,
    revision: 2,
    epoch: 2,
    sequence: 1,
    events: [{
      processorInstanceId: 1,
      parameterTarget: 1,
      frameOffset: 0,
      value: -12,
    }],
  })
  const liveApplied = await waitFor(messages, (message) => message.type === 'processor-events-applied' && message.requestId === 12, 'live processor update')
  assert(liveApplied.result === 'applied', `The portable live processor update was not applied: ${liveApplied.result}.`)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const liveAfter = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(liveAfter)
  const maximumAbsoluteLiveAfter = Math.max(...liveAfter.map(Math.abs))
  assert(maximumAbsoluteLiveBefore > 0.1, `The portable live-control signal was not active before the update: ${maximumAbsoluteLiveBefore}.`)
  assert(maximumAbsoluteLiveAfter > 0.01 && maximumAbsoluteLiveAfter < maximumAbsoluteLiveBefore * 0.5, `The portable live processor update did not change the ongoing signal: before=${maximumAbsoluteLiveBefore}, after=${maximumAbsoluteLiveAfter}.`)
  const synthOutput = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(synthOutput)
  const maximumAbsoluteSynthTailSample = Math.max(...synthOutput.map(Math.abs))

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
    maximumAbsoluteLiveBefore,
    maximumAbsoluteLiveAfter,
    maximumAbsoluteSynthTailSample,
    memoryBytes: health.memoryBytes,
    graphPrepare: health.graphPrepare,
  }
})()
