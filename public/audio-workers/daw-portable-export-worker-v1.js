import { DawPortableAudioCoreHost } from '../audio-worklets/daw-portable-audio-core-host-v1.js'

import { portableWasmCapabilityMatrix } from './daw-portable-capability-metadata-v1.js'

const VERSION = 1
const MAX_FRAMES_PER_BLOCK = 8192
const MAX_CHUNKS = 4096
const MAX_FRAMES = MAX_FRAMES_PER_BLOCK * MAX_CHUNKS
const MAX_ASSETS = 64
const MAX_EVENTS = 256
const SUPPORTED_SAMPLE_RATES = new Set(portableWasmCapabilityMatrix.sampleRatesHz)
const SUPPORTED_PROCESSOR_KINDS = new Set(portableWasmCapabilityMatrix.processorKinds)

let currentJob = null
let disposed = false

const error = (jobId, code, message) => self.postMessage({ version: VERSION, type: 'error', jobId, code, message })
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0

const supportsSnapshot = (request) => {
  const { snapshot } = request
  if (!SUPPORTED_SAMPLE_RATES.has(request.sampleRateHz)) return 'The portable core does not support this sample rate.'
  if (!positiveInteger(request.frameCount) || request.frameCount > MAX_FRAMES) return 'The render frame count exceeds the portable Worker bound.'
  if (!positiveInteger(request.maxFramesPerBlock) || request.maxFramesPerBlock > MAX_FRAMES_PER_BLOCK) return 'The render block size exceeds the portable Worker bound.'
  if (!snapshot || !snapshot.graph || !Array.isArray(snapshot.assets) || !Array.isArray(snapshot.events)) return 'The export snapshot is malformed.'
  if (snapshot.assets.length > MAX_ASSETS || snapshot.events.length > MAX_EVENTS) return 'The export snapshot exceeds the portable core capacity.'
  const graph = snapshot.graph
  if (graph.version !== 1 || !positiveInteger(graph.revision) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || graph.nodes.length > 64 || graph.edges.length > 256 || !Array.isArray(graph.assets)) return 'The graph snapshot is outside the portable capability matrix.'
  if (!graph.nodes.every((node) => node && (node.kind === 'source' || node.kind === 'mixer' || node.kind === 'return' || node.kind === 'group' || node.kind === 'master')
    && Array.isArray(node.processorOrder) && node.processorOrder.every((processor) => processor && SUPPORTED_PROCESSOR_KINDS.has(processor.kind)))) {
    return 'The export snapshot contains a processor or instrument unsupported by the portable core.'
  }
  const assets = new Map(snapshot.assets.map((entry) => [entry && entry.asset && entry.asset.assetId, entry]))
  if (assets.size !== snapshot.assets.length || !snapshot.assets.every((entry) => entry && entry.asset && entry.pcm
    && entry.asset.frameCount === entry.pcm.frameCount
    && Array.isArray(entry.pcm.planes)
    && entry.pcm.planes.length === entry.asset.channelCount
    && entry.pcm.planes.every((plane) => plane instanceof Float32Array && plane.length === entry.asset.frameCount))) {
    return 'The export snapshot contains invalid planar audio.'
  }
  if (!snapshot.events.every((event) => event && assets.has(event.assetId))) return 'The export snapshot references an unregistered asset.'
  return null
}

const cleanUp = (job) => {
  if (!job) return
  job.host.handleMessage({ version: VERSION, type: 'dispose' })
  currentJob = null
}

const finishCancelled = (job) => {
  cleanUp(job)
  self.postMessage({ version: VERSION, type: 'cancelled', jobId: job.request.jobId })
}

const pump = () => {
  const job = currentJob
  if (!job) return
  if (job.cancelled || disposed) {
    finishCancelled(job)
    return
  }
  const remaining = job.request.frameCount - job.completedFrames
  if (remaining <= 0) {
    cleanUp(job)
    self.postMessage({ version: VERSION, type: 'complete', jobId: job.request.jobId, frameCount: job.request.frameCount, chunkCount: job.chunkIndex })
    return
  }
  const frameCount = Math.min(remaining, job.request.maxFramesPerBlock)
  const left = new Float32Array(frameCount)
  const right = new Float32Array(frameCount)
  job.host.process([], [[left, right]])
  const pcm = { frameCount, planes: [left, right] }
  self.postMessage({
    version: VERSION,
    type: 'chunk',
    jobId: job.request.jobId,
    index: job.chunkIndex,
    frameCount,
    pcm,
  }, [left.buffer, right.buffer])
  job.completedFrames += frameCount
  job.chunkIndex += 1
  self.postMessage({
    version: VERSION,
    type: 'progress',
    jobId: job.request.jobId,
    completedFrames: job.completedFrames,
    totalFrames: job.request.frameCount,
  })
  // Yield between bounded blocks so a queued cancel/dispose message is observed.
  setTimeout(pump, 0)
}

const render = async (request) => {
  if (disposed) {
    error(request.jobId, 'invalid-request', 'The portable export Worker has been disposed.')
    return
  }
  const unsupported = supportsSnapshot(request)
  if (unsupported) {
    error(request.jobId, 'unsupported-snapshot', unsupported)
    return
  }
  if (currentJob) {
    error(request.jobId, 'invalid-request', 'The portable export Worker already has an active render.')
    return
  }
  const statuses = []
  const host = new DawPortableAudioCoreHost({
    sampleRate: request.sampleRateHz,
    postMessage: (message) => statuses.push(message),
    close: () => {},
  })
  const initialized = await host.initialize({
    wasmBytes: request.wasmBytes,
    contractHash: request.contractHash,
    maxFramesPerBlock: request.maxFramesPerBlock,
  })
  if (!initialized || !statuses.some((message) => message.type === 'ready')) {
    error(request.jobId, 'initialization-failed', 'The portable audio-core Wasm artifact could not be initialized.')
    return
  }
  const requestId = 1
  for (const entry of request.snapshot.assets) {
    host.handleMessage({
      version: VERSION,
      type: 'register-asset',
      requestId,
      generation: request.generation,
      asset: entry.asset,
      planes: entry.pcm.planes,
    })
    const status = statuses.at(-1)
    if (!status || status.type !== 'asset-registered' || status.result !== 'registered') {
      host.handleMessage({ version: VERSION, type: 'dispose' })
      error(request.jobId, 'render-failed', 'A portable export asset could not be registered.')
      return
    }
  }
  host.handleMessage({ version: VERSION, type: 'prepare-graph', requestId, snapshot: request.snapshot.graph })
  if (statuses.at(-1)?.result !== 'prepared') {
    host.handleMessage({ version: VERSION, type: 'dispose' })
    error(request.jobId, 'render-failed', 'The portable export graph was rejected.')
    return
  }
  host.handleMessage({ version: VERSION, type: 'publish-graph', requestId, revision: request.snapshot.graph.revision })
  if (statuses.at(-1)?.result !== 'published') {
    host.handleMessage({ version: VERSION, type: 'dispose' })
    error(request.jobId, 'render-failed', 'The portable export graph could not be published.')
    return
  }
  host.handleMessage({ version: VERSION, type: 'transport', requestId, epoch: request.snapshot.events[0]?.epoch ?? 1, running: false, frame: 0 })
  const epoch = request.snapshot.events[0]?.epoch ?? 1
  if (statuses.at(-1)?.result !== 'applied') {
    host.handleMessage({ version: VERSION, type: 'dispose' })
    error(request.jobId, 'render-failed', 'The portable export transport was rejected.')
    return
  }
  host.handleMessage({
    version: VERSION,
    type: 'schedule-sources',
    requestId,
    revision: request.snapshot.graph.revision,
    epoch,
    events: request.snapshot.events,
  })
  if (statuses.at(-1)?.result !== 'scheduled') {
    host.handleMessage({ version: VERSION, type: 'dispose' })
    error(request.jobId, 'render-failed', 'The portable export events were rejected.')
    return
  }
  host.handleMessage({ version: VERSION, type: 'transport', requestId, epoch, running: true, frame: 0 })
  if (statuses.at(-1)?.result !== 'applied') {
    host.handleMessage({ version: VERSION, type: 'dispose' })
    error(request.jobId, 'render-failed', 'The portable export transport could not start.')
    return
  }
  currentJob = { request, host, completedFrames: 0, chunkIndex: 0, cancelled: false }
  pump()
}

self.onmessage = (event) => {
  const request = event.data
  if (!request || request.version !== VERSION || String(request.type) !== request.type) return
  if (request.type === 'cancel' && positiveInteger(request.jobId)) {
    if (currentJob && currentJob.request.jobId === request.jobId) currentJob.cancelled = true
    return
  }
  if (request.type === 'dispose') {
    disposed = true
    cleanUp(currentJob)
    self.postMessage({ version: VERSION, type: 'disposed' })
    return
  }
  if (request.type === 'render'
    && positiveInteger(request.jobId)
    && positiveInteger(request.sampleRateHz)
    && positiveInteger(request.frameCount)
    && positiveInteger(request.maxFramesPerBlock)
    && positiveInteger(request.generation)
    && String(request.contractHash) === request.contractHash
    && request.wasmBytes instanceof ArrayBuffer) {
    void render(request)
  } else if (request.type === 'render') {
    error(positiveInteger(request.jobId) ? request.jobId : 0, 'invalid-request', 'The portable export Worker request is malformed.')
  }
}
