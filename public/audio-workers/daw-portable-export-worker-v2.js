import { DawPortableAudioCoreHost } from '../audio-worklets/daw-portable-audio-core-host-v2.js'
import { portableWasmCapabilityMatrix } from './daw-portable-capability-metadata-v1.js'

const VERSION = 2
const MAX_BLOCK = 8192
const MAX_ASSETS = 64
const MAX_EVENTS = 256
const MAX_NODES = 64
const MAX_EDGES = 256
const MAX_PAGES = 128
const MAX_PREPARATIONS = 64
const PAGE_FRAMES = 16384
const SUPPORTED_RATES = new Set(portableWasmCapabilityMatrix.sampleRatesHz)
const SUPPORTED_PROCESSORS = new Set(portableWasmCapabilityMatrix.processorKinds)

let currentJob = null
let disposed = false

const positive = (value) => Number.isSafeInteger(value) && value > 0
const nonNegative = (value) => Number.isSafeInteger(value) && value >= 0
const fail = (jobId, code, message) => self.postMessage({ version: VERSION, type: 'error', jobId, code, message })
const last = (statuses, type) => {
  for (let index = statuses.length - 1; index >= 0; index -= 1) {
    if (statuses[index]?.type === type) return statuses[index]
  }
  return undefined
}

const validateSnapshot = (request) => {
  if (!SUPPORTED_RATES.has(request.sampleRateHz)) return 'The portable core does not support this sample rate.'
  if (!positive(request.frameCount) || !positive(request.maxFramesPerBlock) || request.maxFramesPerBlock > MAX_BLOCK) return 'The render request bounds are invalid.'
  if (!request.snapshot || !request.snapshot.graph || !Array.isArray(request.snapshot.assets) || !Array.isArray(request.snapshot.events)) return 'The export snapshot is malformed.'
  if (request.snapshot.assets.length > MAX_ASSETS || request.snapshot.events.length > MAX_EVENTS) return 'The export snapshot exceeds the portable asset or event bound.'
  const graph = request.snapshot.graph
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > MAX_NODES || graph.edges.length > MAX_EDGES) return 'The graph snapshot is outside the portable capability matrix.'
  if (!graph.nodes.every((node) => node
    && (node.kind === 'source' || node.kind === 'mixer' || node.kind === 'return' || node.kind === 'group' || node.kind === 'master')
    && Array.isArray(node.processorOrder)
    && node.processorOrder.every((processor) => SUPPORTED_PROCESSORS.has(processor.kind)))) return 'The export snapshot contains a processor or instrument unsupported by the portable core.'
  const assets = new Map()
  for (const entry of request.snapshot.assets) {
    if (!entry?.asset?.assetId || assets.has(entry.asset.assetId)) return 'The export snapshot contains duplicate assets.'
    if (!positive(entry.asset.frameCount) || !positive(entry.asset.sampleRateHz) || !positive(entry.asset.channelCount) || entry.asset.channelCount > 2) return 'The export snapshot contains invalid asset metadata.'
    if (entry.pcm && (entry.pcm.frameCount !== entry.asset.frameCount || entry.pcm.planes.length !== entry.asset.channelCount || entry.pcm.planes.some((plane) => !(plane instanceof Float32Array) || plane.length !== entry.asset.frameCount))) return 'The export snapshot contains invalid eager PCM.'
    if (!entry.pcm && (!positive(entry.pageFrames ?? PAGE_FRAMES) || entry.pageFrames > PAGE_FRAMES)) return 'The export snapshot contains invalid paged asset metadata.'
    assets.set(entry.asset.assetId, entry)
  }
  if (!request.snapshot.events.every((event) => event && assets.has(event.assetId) && positive(event.sequence) && nonNegative(event.startFrame) && positive(event.stopFrame) && event.stopFrame > event.startFrame && nonNegative(event.sourceOffsetFrame) && positive(event.sourceFrameCount))) return 'The export snapshot contains an invalid source event.'
  return null
}

const statusForRequest = (job, type, requestId) => {
  for (let index = job.statuses.length - 1; index >= 0; index -= 1) {
    const status = job.statuses[index]
    if (status?.type === type && status.requestId === requestId) return status
  }
  return undefined
}

const replaceSources = (job, ordinary, prepared) => {
  const requestId = job.nextHostRequestId++
  job.host.handleMessage({
    version: 2,
    type: 'replace-sources',
    requestId,
    revision: job.request.snapshot.graph.revision,
    epoch: job.request.snapshot.events[0]?.epoch ?? 1,
    ordinary,
    prepared,
  })
  const status = statusForRequest(job, 'sources-replaced', requestId)
  if (status?.result !== 'replaced') throw new Error('Portable export source window was rejected.')
}

const releasePreparation = (job, preparationId) => {
  const requestId = job.nextHostRequestId++
  job.host.handleMessage({
    version: 2,
    type: 'release-asset-preparation',
    requestId,
    generation: job.request.generation,
    preparationId,
  })
  const status = statusForRequest(job, 'asset-preparation-released', requestId)
  if (status?.result !== 'released') {
    throw new Error(`Portable export preparation ${preparationId} could not be released.`)
  }
}

const trimAsset = (job, asset) => {
  const requestId = job.nextHostRequestId++
  job.host.handleMessage({
    version: 2,
    type: 'trim-asset-pages',
    requestId,
    generation: job.request.generation,
    assetId: asset.asset.assetId,
    firstPage: 0,
    pageCount: 0xffffffff,
  })
  const status = statusForRequest(job, 'asset-pages-trimmed', requestId)
  if (status?.result !== 'trimmed') {
    throw new Error(`Portable export pages for "${asset.asset.assetId}" could not be trimmed.`)
  }
}

const releaseAsset = (job, asset) => {
  const requestId = job.nextHostRequestId++
  job.host.handleMessage({
    version: 2,
    type: 'release-asset',
    requestId,
    generation: job.request.generation,
    assetId: asset.asset.assetId,
  })
  const status = statusForRequest(job, 'asset-released', requestId)
  if (status?.result !== 'released') {
    throw new Error(`Portable export asset "${asset.asset.assetId}" could not be released.`)
  }
}

const deactivateSources = (job) => {
  if (job.sourcesActive) replaceSources(job, [], [])
  job.sourcesActive = false
  const preparations = [...job.preparations]
  job.preparations.clear()
  for (const preparationId of preparations) releasePreparation(job, preparationId)
}

const cleanupJob = (job) => {
  if (!job || job.cleaned) return
  job.cleaned = true
  let cleanupError
  try {
    if (job.sourcesActive) replaceSources(job, [], [])
    job.sourcesActive = false
  } catch (error) {
    cleanupError = error
  }
  for (const preparationId of job.preparations) {
    try {
      releasePreparation(job, preparationId)
    } catch (error) {
      cleanupError ||= error
    }
  }
  job.preparations.clear()
  for (const asset of job.request.snapshot.assets) {
    if (asset.pcm) continue
    try {
      trimAsset(job, asset)
    } catch (error) {
      cleanupError ||= error
    }
  }
  for (const asset of job.request.snapshot.assets) {
    try {
      releaseAsset(job, asset)
    } catch (error) {
      cleanupError ||= error
    }
  }
  job.host.handleMessage({ version: 2, type: 'dispose' })
  if (job.waiting) job.waiting.reject(new Error('Portable export job ended.'))
  if (job.pageWaiter) job.pageWaiter.reject(new Error('Portable export job ended.'))
  currentJob = null
  if (cleanupError) throw cleanupError
}

const cancelJob = (job) => {
  if (!job) return
  job.cancelled = true
  if (job.waiting) job.waiting.reject(new DOMException('Portable export was cancelled.', 'AbortError'))
  if (job.pageWaiter) job.pageWaiter.reject(new DOMException('Portable export was cancelled.', 'AbortError'))
}

const waitForChunk = (job, index) => new Promise((resolve, reject) => {
  job.waiting = { index, resolve, reject }
})

const requiredPageRange = (asset, event) => {
  const pageFrames = asset.pageFrames ?? PAGE_FRAMES
  const startFrame = Math.max(0, event.sourceOffsetFrame - 1)
  const endFrame = Math.min(asset.asset.frameCount, event.sourceOffsetFrame + event.sourceFrameCount + 1)
  const firstPage = Math.floor(startFrame / pageFrames)
  const lastPage = Math.floor((endFrame - 1) / pageFrames)
  return {
    pageFrames,
    firstPage,
    lastPage,
    sourceOffsetFrame: firstPage * pageFrames,
    sourceFrameCount: Math.min(asset.asset.frameCount, (lastPage + 1) * pageFrames) - firstPage * pageFrames,
  }
}

const clipEventToWindow = (event, start, end) => {
  const clippedStart = Math.max(event.startFrame, start)
  const clippedStop = Math.min(event.stopFrame, end)
  if (clippedStop <= clippedStart) return null
  const timelineFrames = event.stopFrame - event.startFrame
  const sourceStart = event.sourceOffsetFrame
    + (event.sourceOffsetFraction ?? 0)
    + event.sourceFrameCount * (clippedStart - event.startFrame) / timelineFrames
  const sourceEnd = event.sourceOffsetFrame
    + (event.sourceOffsetFraction ?? 0)
    + event.sourceFrameCount * (clippedStop - event.startFrame) / timelineFrames
  const sourceOffsetFrame = Math.floor(sourceStart)
  return {
    ...event,
    startFrame: clippedStart,
    stopFrame: clippedStop,
    sourceOffsetFrame,
    sourceOffsetFraction: sourceStart - sourceOffsetFrame,
    sourceFrameCount: Math.ceil(sourceEnd - sourceStart),
  }
}

const requestPage = (job, asset, pageIndex) => {
  if (job.pageWaiter) throw new Error('Portable export Worker issued more than one page request.')
  const pageFrames = asset.pageFrames ?? PAGE_FRAMES
  const startFrame = pageIndex * pageFrames
  const frameCount = Math.min(pageFrames, asset.asset.frameCount - startFrame)
  if (!positive(frameCount)) throw new Error('Portable export Worker requested a page outside the asset.')
  const requestId = job.nextPageRequestId
  job.nextPageRequestId += 1
  return new Promise((resolve, reject) => {
    job.pageWaiter = { requestId, assetId: asset.asset.assetId, startFrame, frameCount, resolve, reject }
    self.postMessage({ version: VERSION, type: 'page-request', jobId: job.request.jobId, requestId, assetId: asset.asset.assetId, startFrame, frameCount })
  })
}

const ensurePrepared = async (job, asset, range) => {
  const prepared = () => {
    const statuses = job.statuses
    job.host.handleMessage({
      version: 2,
      type: 'prepare-asset-range',
      requestId: job.nextHostRequestId++,
      generation: job.request.generation,
      assetId: asset.asset.assetId,
      sourceOffsetFrame: range.sourceOffsetFrame,
      sourceFrameCount: range.sourceFrameCount,
      interpolationGuardFrames: 0,
    })
    return last(statuses, 'asset-range-prepared')
  }
  for (;;) {
    if (job.cancelled || disposed) throw new DOMException('Portable export was cancelled.', 'AbortError')
    const status = prepared()
    if (status?.result === 'prepared') {
      job.preparations.add(status.preparationId)
      return status.preparationId
    }
    if (status?.result !== 'missing-page' || !nonNegative(status.firstMissingPage)) throw new Error('A portable export source range could not be prepared.')
    await requestPage(job, asset, status.firstMissingPage)
    job.pageWaiter = null
    const page = job.lastPage
    if (!page) throw new Error('Portable export page response was lost.')
    const writeRequestId = job.nextHostRequestId++
    job.host.handleMessage({ version: 2, type: 'write-asset-page', requestId: writeRequestId, generation: job.request.generation, assetId: asset.asset.assetId, pageIndex: page.pageIndex, validFrames: page.frameCount, planes: page.planes })
    const written = last(job.statuses, 'asset-page-written')
    job.lastPage = null
    if (written?.result === 'asset-in-use') {
      deactivateSources(job)
      job.host.handleMessage({ version: 2, type: 'write-asset-page', requestId: writeRequestId, generation: job.request.generation, assetId: asset.asset.assetId, pageIndex: page.pageIndex, validFrames: page.frameCount, planes: page.planes })
      const retried = statusForRequest(job, 'asset-page-written', writeRequestId)
      if (retried?.result !== 'written') throw new Error('A portable export source page was rejected.')
    } else if (written?.result !== 'written') {
      throw new Error('A portable export source page was rejected.')
    }
  }
}

const createWindows = (job) => {
  const events = job.request.snapshot.events
  const assets = new Map(job.request.snapshot.assets.map((entry) => [entry.asset.assetId, entry]))
  const windows = []
  let start = 0
  while (start < job.request.frameCount) {
    const end = Math.min(job.request.frameCount, start + job.request.maxFramesPerBlock * 16)
    const selected = events
      .filter((event) => event.startFrame < end && event.stopFrame > start)
      .map((event) => clipEventToWindow(event, start, end))
      .filter(Boolean)
    const rangesByAsset = new Map()
    for (const event of selected) {
      const asset = assets.get(event.assetId)
      if (!asset || asset.pcm) continue
      const range = requiredPageRange(asset, event)
      const existing = rangesByAsset.get(asset.asset.assetId)
      rangesByAsset.set(asset.asset.assetId, existing
        ? {
          firstPage: Math.min(existing.firstPage, range.firstPage),
          lastPage: Math.max(existing.lastPage, range.lastPage),
        }
        : range)
    }
    const pageCount = [...rangesByAsset.values()].reduce(
      (total, range) => total + range.lastPage - range.firstPage + 1,
      0,
    )
    if (pageCount > MAX_PAGES || rangesByAsset.size > MAX_PREPARATIONS) {
      if (end - start <= job.request.maxFramesPerBlock) throw new Error('Portable export source window exceeds resident page capacity.')
      windows.push({ start, end: start + Math.floor((end - start) / 2) })
      start += Math.floor((end - start) / 2)
      continue
    }
    windows.push({ start, end })
    start = end
  }
  return windows
}

const renderWindow = async (job, window, assets) => {
  deactivateSources(job)
  const selected = job.request.snapshot.events
    .filter((event) => event.startFrame < window.end && event.stopFrame > window.start)
    .map((event) => clipEventToWindow(event, window.start, window.end))
    .filter(Boolean)
  const ordinary = []
  const prepared = []
  const pagedEventsByAsset = new Map()
  for (const event of selected) {
    const asset = assets.get(event.assetId)
    if (!asset) throw new Error('Portable export event asset is missing.')
    if (asset.pcm) ordinary.push(event)
    else {
      const range = requiredPageRange(asset, event)
      const existing = pagedEventsByAsset.get(asset.asset.assetId)
      if (existing) {
        existing.events.push(event)
        existing.range.firstPage = Math.min(existing.range.firstPage, range.firstPage)
        existing.range.lastPage = Math.max(existing.range.lastPage, range.lastPage)
      } else {
        pagedEventsByAsset.set(asset.asset.assetId, { asset, events: [event], range })
      }
    }
  }
  if (pagedEventsByAsset.size > MAX_PREPARATIONS) {
    throw new Error('Portable export source window exceeds preparation capacity.')
  }
  for (const entry of pagedEventsByAsset.values()) {
    const pageFrames = entry.range.pageFrames
    const sourceOffsetFrame = entry.range.firstPage * pageFrames
    const preparationId = await ensurePrepared(job, entry.asset, {
      ...entry.range,
      sourceOffsetFrame,
      sourceFrameCount: Math.min(
        entry.asset.asset.frameCount,
        (entry.range.lastPage + 1) * pageFrames,
      ) - sourceOffsetFrame,
    })
    for (const event of entry.events) {
      prepared.push({ ...event, preparationId })
    }
  }
  const epoch = job.request.snapshot.events[0]?.epoch ?? 1
  job.host.handleMessage({ version: 2, type: 'transport', requestId: job.nextHostRequestId++, epoch, running: true, frame: window.start })
  replaceSources(job, ordinary, prepared)
  job.sourcesActive = true
  let frame = window.start
  while (frame < window.end) {
    if (job.cancelled || disposed) throw new DOMException('Portable export was cancelled.', 'AbortError')
    const frameCount = Math.min(job.request.maxFramesPerBlock, window.end - frame)
    const left = new Float32Array(frameCount)
    const right = new Float32Array(frameCount)
    job.host.process([], [[left, right]])
    const index = job.chunkIndex
    job.chunkIndex += 1
    const consumed = waitForChunk(job, index)
    self.postMessage({ version: VERSION, type: 'chunk', jobId: job.request.jobId, index, startFrame: frame, frameCount, pcm: { frameCount, planes: [left, right] } }, [left.buffer, right.buffer])
    await consumed
    frame += frameCount
    job.completedFrames = frame
    self.postMessage({ version: VERSION, type: 'progress', jobId: job.request.jobId, completedFrames: frame, totalFrames: job.request.frameCount })
  }
}

const render = async (request) => {
  if (disposed) return fail(request.jobId, 'invalid-request', 'The portable export Worker has been disposed.')
  const invalid = validateSnapshot(request)
  if (invalid) return fail(request.jobId, 'unsupported-snapshot', invalid)
  if (currentJob) return fail(request.jobId, 'invalid-request', 'The portable export Worker already has an active render.')
  const statuses = []
  const host = new DawPortableAudioCoreHost({ sampleRate: request.sampleRateHz, postMessage: (message) => statuses.push(message), close: () => {} })
  const initialized = await host.initialize({ wasmBytes: request.wasmBytes, contractHash: request.contractHash, maxFramesPerBlock: request.maxFramesPerBlock })
  if (!initialized || !last(statuses, 'ready')) return fail(request.jobId, 'initialization-failed', 'The portable audio-core Wasm artifact could not be initialized.')
  const job = { request, host, statuses, completedFrames: 0, chunkIndex: 0, nextHostRequestId: 1, nextPageRequestId: 1, waiting: null, pageWaiter: null, lastPage: null, cancelled: false, preparations: new Set(), sourcesActive: false, cleaned: false }
  currentJob = job
  try {
    for (const entry of request.snapshot.assets) {
      const message = entry.pcm
        ? { version: 2, type: 'register-asset', requestId: job.nextHostRequestId++, generation: request.generation, asset: entry.asset, planes: entry.pcm.planes }
        : { version: 2, type: 'register-paged-asset', requestId: job.nextHostRequestId++, generation: request.generation, asset: entry.asset }
      host.handleMessage(message)
      const status = last(statuses, entry.pcm ? 'asset-registered' : 'paged-asset-registered')
      if (status?.result !== 'registered') throw new Error('A portable export asset could not be registered.')
    }
    host.handleMessage({ version: 2, type: 'prepare-graph', requestId: job.nextHostRequestId++, snapshot: request.snapshot.graph })
    if (last(statuses, 'graph-prepared')?.result !== 'prepared') throw new Error('The portable export graph was rejected.')
    host.handleMessage({ version: 2, type: 'publish-graph', requestId: job.nextHostRequestId++, revision: request.snapshot.graph.revision })
    if (last(statuses, 'graph-published')?.result !== 'published') throw new Error('The portable export graph could not be published.')
    const assets = new Map(request.snapshot.assets.map((entry) => [entry.asset.assetId, entry]))
    for (const window of createWindows(job)) await renderWindow(job, window, assets)
    cleanupJob(job)
    self.postMessage({ version: VERSION, type: 'complete', jobId: request.jobId, frameCount: request.frameCount, chunkCount: job.chunkIndex })
  } catch (error) {
    let finalError = error
    try {
      cleanupJob(job)
    } catch (cleanupError) {
      finalError = cleanupError
    }
    if (finalError instanceof DOMException && finalError.name === 'AbortError') self.postMessage({ version: VERSION, type: 'cancelled', jobId: request.jobId })
    else fail(request.jobId, 'render-failed', finalError instanceof Error ? finalError.message : String(finalError))
  }
}

self.onmessage = (event) => {
  const message = event.data
  if (!message || message.version !== VERSION) return
  if (message.type === 'cancel' && currentJob?.request.jobId === message.jobId) return cancelJob(currentJob)
  if (message.type === 'dispose') {
    disposed = true
    cancelJob(currentJob)
    try {
      cleanupJob(currentJob)
    } catch {}
    self.postMessage({ version: VERSION, type: 'disposed' })
    return
  }
  if (message.type === 'chunk-consumed' && currentJob?.waiting
    && currentJob.request.jobId === message.jobId
    && currentJob.waiting.index === message.index) {
    const waiter = currentJob.waiting
    currentJob.waiting = null
    waiter.resolve()
    return
  }
  if (message.type === 'page-response' && currentJob?.pageWaiter
    && currentJob.request.jobId === message.jobId) {
    const waiter = currentJob.pageWaiter
    if (message.requestId !== waiter.requestId || message.assetId !== waiter.assetId || message.startFrame !== waiter.startFrame || message.frameCount !== waiter.frameCount) {
      waiter.reject(new Error('Portable export page response is stale or malformed.'))
      return
    }
    currentJob.pageWaiter = null
    if (message.error || !Array.isArray(message.planes) || message.planes.length === 0 || message.planes.some((plane) => !(plane instanceof Float32Array) || plane.length !== waiter.frameCount)) {
      waiter.reject(new Error(message.error ?? 'Portable export page response is invalid.'))
      return
    }
    currentJob.lastPage = { pageIndex: Math.floor(waiter.startFrame / (currentJob.request.snapshot.assets.find((entry) => entry.asset.assetId === waiter.assetId)?.pageFrames ?? PAGE_FRAMES)), frameCount: waiter.frameCount, planes: message.planes }
    waiter.resolve()
    return
  }
  if (message.type === 'render') void render(message)
}
