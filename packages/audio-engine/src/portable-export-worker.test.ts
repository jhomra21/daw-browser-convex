import { afterEach, expect, test } from 'bun:test'
import type { PortableExportWorkerLike } from './portable-export-worker'
import { PortableExportWorker } from './portable-export-worker'
import {
  audioCoreContractVersion,
  type AudioCoreSampleSourceEventDto,
} from '../../audio-core-contract/src'
import {
  audioCoreWasmAbiVersion,
  audioCoreWasmArtifactVersion,
  audioCoreWasmPagedAbiVersion,
  type AudioCoreWasmArtifact,
} from '../../audio-core-wasm/src'
import {
  portableExportWorkerProtocolVersion,
  type PortableExportWorkerRequest,
  type PortableExportWorkerResponse,
} from './portable-export-worker-protocol'
import type { PortableExportAsset } from './portable-export-snapshot'
import { portableWasmCapabilityMatrix } from './backends/portable-wasm-capabilities'
import { portableWasmCapabilityMatrix as emittedPortableWasmCapabilityMatrix } from '../../../public/audio-workers/daw-portable-capability-metadata-v1.js'

const workerUrl = new URL('../../../public/audio-workers/daw-portable-export-worker-v2.js', import.meta.url)

class MockWorker implements PortableExportWorkerLike {
  onmessage: ((event: MessageEvent<PortableExportWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly messages: PortableExportWorkerRequest[] = []
  readonly transfers: Transferable[][] = []
  terminated = false

  postMessage(message: PortableExportWorkerRequest, transfer: Transferable[]) {
    this.messages.push(message)
    this.transfers.push(transfer)
  }

  terminate() {
    this.terminated = true
  }
}

const originalSelf = globalThis.self

afterEach(() => {
  Object.defineProperty(globalThis, 'self', { configurable: true, value: originalSelf, writable: true })
})

test('the dedicated Worker defines only bounded render lifecycle messages', async () => {
  const source = await Bun.file(workerUrl).text()

  expect(source).toContain("type: 'progress'")
  expect(source).toContain("type: 'chunk'")
  expect(source).toContain("type: 'complete'")
  expect(source).toContain("type: 'cancelled'")
  expect(source).toContain("type: 'dispose'")
  expect(source).toContain("type: 'page-request'")
  expect(source).toContain('chunk-consumed')
})

test('the dedicated Worker consumes the emitted fixture-derived capability metadata', () => {
  expect(emittedPortableWasmCapabilityMatrix).toEqual(portableWasmCapabilityMatrix)
})

test('the Worker-compatible client sends cancellation and disposal to its active job', () => {
  const worker = new MockWorker()
  const client = new PortableExportWorker(worker, '/missing-manifest.json')

  client.cancel()
  expect(worker.messages).toEqual([])
  client.dispose()
  expect(worker.messages).toEqual([
    { version: portableExportWorkerProtocolVersion, type: 'dispose' },
  ])
  expect(worker.terminated).toBe(true)
})

test('the Worker-compatible client honors cancellation before loading an artifact', async () => {
  const worker = new MockWorker()
  const controller = new AbortController()
  controller.abort()
  const client = new PortableExportWorker(worker, '/missing-manifest.json')

  await expect(client.render({
    snapshot: {
      graph: {
        version: 1,
        revision: 1,
        contractHash: 'fixture',
        nodes: [],
        edges: [],
        masterNodeId: 'master',
        assets: [],
      },
      assets: [],
      events: [],
    },
    sampleRateHz: 48_000,
    frameCount: 1,
    generation: 1,
    signal: controller.signal,
    onChunk: () => {},
  })).rejects.toMatchObject({ name: 'AbortError' })
  expect(worker.messages).toEqual([])
})

test('the Worker transfers a copy without detaching the cached Wasm artifact', async () => {
  const worker = new MockWorker()
  const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer
  const artifact: AudioCoreWasmArtifact = {
    bytes,
    module: new WebAssembly.Module(bytes),
    manifest: {
      version: audioCoreWasmArtifactVersion,
      abiVersion: audioCoreWasmAbiVersion,
      pagedAbi: audioCoreWasmPagedAbiVersion,
      contractVersion: audioCoreContractVersion,
      contractHash: 'fixture',
      fixedMemory: true,
      memoryBytes: 65_536,
      sha256: '0'.repeat(64),
      wasmUrl: '/fixture.wasm',
    },
  }
  const client = new PortableExportWorker(worker, '/missing-manifest.json', artifact)
  const rendering = client.render({
    snapshot: {
      graph: {
        version: 1,
        revision: 1,
        contractHash: 'fixture',
        nodes: [],
        edges: [],
        masterNodeId: 'master',
        assets: [],
      },
      assets: [],
      events: [],
    },
    sampleRateHz: 48_000,
    frameCount: 1,
    generation: 1,
    onChunk: () => undefined,
  })

  const message = worker.messages[0]
  if (!message || message.type !== 'render') throw new Error('Expected portable export render message.')
  expect(message.wasmBytes).not.toBe(bytes)
  expect(message.wasmBytes.byteLength).toBe(bytes.byteLength)
  expect(worker.transfers[0]).toContain(message.wasmBytes)
  expect(artifact.bytes.byteLength).toBe(bytes.byteLength)

  worker.onmessage?.(new MessageEvent('message', {
    data: {
      version: portableExportWorkerProtocolVersion,
      type: 'complete',
      jobId: message.jobId,
      frameCount: 1,
      chunkCount: 0,
    },
  }))
  await rendering
})

test('the Worker rejects unsupported snapshots and renders the production Wasm artifact in bounded transferable chunks', async () => {
  type WorkerHarness = {
    onmessage: ((event: MessageEvent<object>) => void) | null
    postMessage: (message: PortableExportWorkerResponse) => void
  }
  const responses: PortableExportWorkerResponse[] = []
  const pageRequests: Extract<PortableExportWorkerResponse, { type: 'page-request' }>[] = []
  const cancellation = { jobId: 0 }
  const harness: WorkerHarness = {
    onmessage: null,
    postMessage: (message) => {
      responses.push(message)
      if (message.type === 'page-request') {
        pageRequests.push(message)
        queueMicrotask(() => {
          harness.onmessage?.(new MessageEvent('message', {
            data: {
              version: portableExportWorkerProtocolVersion,
              type: 'page-response',
              jobId: message.jobId,
              requestId: message.requestId,
              assetId: message.assetId,
              startFrame: message.startFrame,
              frameCount: message.frameCount,
              planes: [new Float32Array(message.frameCount), new Float32Array(message.frameCount)],
            },
          }))
        })
      } else if (cancellation.jobId > 0
        && message.type === 'chunk'
        && message.jobId === cancellation.jobId) {
        harness.onmessage?.(new MessageEvent('message', {
          data: { version: portableExportWorkerProtocolVersion, type: 'cancel', jobId: cancellation.jobId },
        }))
      } else if (message.type === 'chunk') {
        harness.onmessage?.(new MessageEvent('message', {
          data: { version: portableExportWorkerProtocolVersion, type: 'chunk-consumed', jobId: message.jobId, index: message.index },
        }))
      }
    },
  }
  const wasmUrl = new URL('../../../public/audio-core/daw-audio-core.wasm', import.meta.url)
  Object.defineProperty(globalThis, 'self', { configurable: true, value: harness, writable: true })
  await import(`${workerUrl.href}?render=${Date.now()}`)
  if (!harness.onmessage) throw new Error('Worker did not install its message handler.')

  harness.onmessage(new MessageEvent('message', {
    data: {
      version: portableExportWorkerProtocolVersion,
      type: 'render',
      jobId: 1,
      sampleRateHz: 48_000,
      frameCount: 1,
      maxFramesPerBlock: 1,
      generation: 1,
      contractHash: 'fixture',
      wasmBytes: new ArrayBuffer(0),
      snapshot: {
        graph: { version: 1, revision: 1, nodes: [{ kind: 'instrument', processorOrder: [] }], edges: [], assets: [] },
        assets: [],
        events: [],
      },
    },
  }))
  expect(responses).toEqual([{
    version: portableExportWorkerProtocolVersion,
    type: 'error',
    jobId: 1,
    code: 'unsupported-snapshot',
    message: 'The export snapshot contains a processor or instrument unsupported by the portable core.',
  }])

  const renderRequest: Extract<PortableExportWorkerRequest, { type: 'render' }> = {
      version: portableExportWorkerProtocolVersion,
      type: 'render',
      jobId: 2,
      sampleRateHz: 48_000,
      frameCount: 4,
      maxFramesPerBlock: 4,
      generation: 1,
      contractHash: 'fixture',
      wasmBytes: await Bun.file(wasmUrl).arrayBuffer(),
      snapshot: {
        graph: {
          version: 1,
          revision: 1,
          contractHash: 'fixture',
          nodes: [
            { id: 'source', kind: 'source', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: [] },
            { id: 'master', kind: 'master', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: [] },
          ],
          edges: [{ version: 1, id: 'source-master', fromNodeId: 'source', toNodeId: 'master', gain: 1, kind: 'output', tap: 'post-fader', sidechain: false, pdcDelayFrames: 0 }],
          masterNodeId: 'master',
          assets: [{ version: 1, assetId: 'fixture', frameCount: 4, sampleRateHz: 48_000, channelCount: 2 }],
        },
        assets: [{
          asset: { version: 1, assetId: 'fixture', frameCount: 4, sampleRateHz: 48_000, channelCount: 2 },
          pcm: { frameCount: 4, planes: [new Float32Array([0, 0.25, -0.5, 1]), new Float32Array([1, -0.5, 0.25, 0])] },
          transferables: [],
        }],
        events: [{
          version: 1,
          epoch: 1,
          sequence: 1,
          sourceNodeId: 'source',
          assetId: 'fixture',
          startFrame: 0,
          stopFrame: 4,
          sourceOffsetFrame: 0,
          sourceFrameCount: 4,
          gain: 1,
          fadeInStartFrame: 0,
          fadeInEndFrame: 0,
          fadeOutStartFrame: 4,
          fadeOutEndFrame: 4,
        }],
      },
  }
  harness.onmessage(new MessageEvent('message', { data: renderRequest }))

  for (let attempt = 0; attempt < 50 && !responses.some((response) => (
    response.type === 'complete'
  )); attempt += 1) await Bun.sleep(10)
  const chunk = responses.find((
    response,
  ): response is Extract<PortableExportWorkerResponse, { type: 'chunk' }> => response.type === 'chunk')
  if (!chunk) throw new Error(`Worker did not return PCM: ${JSON.stringify(responses)}`)
  expect(chunk.pcm.planes).toEqual([
    new Float32Array([0, 0.25, -0.5, 1]),
    new Float32Array([1, -0.5, 0.25, 0]),
  ])
  expect(chunk.startFrame).toBe(0)
  expect(responses).toContainEqual({
    version: portableExportWorkerProtocolVersion,
    type: 'complete',
    jobId: 2,
    frameCount: 4,
    chunkCount: 1,
  })

  cancellation.jobId = 3
  harness.onmessage(new MessageEvent('message', {
    data: {
      ...renderRequest,
      jobId: 3,
      frameCount: 8,
      wasmBytes: renderRequest.wasmBytes.slice(0),
    },
  }))
  for (let attempt = 0; attempt < 50 && !responses.some((response) => (
    response.type === 'cancelled' && response.jobId === 3
  )); attempt += 1) await Bun.sleep(10)
  expect(responses).toContainEqual({
    version: portableExportWorkerProtocolVersion,
    type: 'cancelled',
    jobId: 3,
  })
  expect(responses.some((response) => (
    response.type === 'complete' && response.jobId === 3
  ))).toBe(false)

  const pagedAsset: PortableExportAsset = {
    asset: {
      version: 1,
      assetId: 'paged-fixture',
      frameCount: 128 * 16_384,
      sampleRateHz: 48_000,
      channelCount: 2,
    },
    pageFrames: 16_384,
    transferables: [],
  }
  const pagedEvent = (
    sequence: number,
    assetId: string,
    sourceOffsetFrame: number,
  ): AudioCoreSampleSourceEventDto => ({
    version: 1,
    epoch: 1,
    sequence,
    sourceNodeId: 'source',
    assetId,
    startFrame: 0,
    stopFrame: 1,
    sourceOffsetFrame,
    sourceFrameCount: 1,
    gain: 1,
    fadeInStartFrame: 0,
    fadeInEndFrame: 0,
    fadeOutStartFrame: 1,
    fadeOutEndFrame: 1,
  })
  const pagedRequest = (
    jobId: number,
    assets: typeof pagedAsset[],
    events: ReturnType<typeof pagedEvent>[],
  ): Extract<PortableExportWorkerRequest, { type: 'render' }> => ({
    ...renderRequest,
    jobId,
    frameCount: 1,
    maxFramesPerBlock: 1,
    wasmBytes: renderRequest.wasmBytes.slice(0),
    snapshot: {
      ...renderRequest.snapshot,
      graph: {
        ...renderRequest.snapshot.graph,
        assets: assets.map((entry) => entry.asset),
      },
      assets,
      events,
    },
  })
  const waitForTerminalResponse = async (jobId: number) => {
    for (let attempt = 0; attempt < 200 && !responses.some((response) => (
      response.type !== 'disposed'
      && response.jobId === jobId
      && (response.type === 'complete' || response.type === 'error')
    )); attempt += 1) await Bun.sleep(10)
  }

  const unionJobId = 4
  harness.onmessage(new MessageEvent('message', {
    data: pagedRequest(
      unionJobId,
      [pagedAsset],
      Array.from({ length: 65 }, (_, index) => pagedEvent(index + 1, pagedAsset.asset.assetId, index * 16_384)),
    ),
  }))
  await waitForTerminalResponse(unionJobId)

  const distinctAssetJobId = 5
  const distinctAssets = Array.from({ length: 65 }, (_, index) => ({
    ...pagedAsset,
    asset: { ...pagedAsset.asset, assetId: `paged-fixture-${index}` },
  }))
  harness.onmessage(new MessageEvent('message', {
    data: pagedRequest(
      distinctAssetJobId,
      distinctAssets,
      distinctAssets.map((asset, index) => pagedEvent(index + 1, asset.asset.assetId, 0)),
    ),
  }))
  await waitForTerminalResponse(distinctAssetJobId)
  expect(responses).toContainEqual({
    version: portableExportWorkerProtocolVersion,
    type: 'error',
    jobId: distinctAssetJobId,
    code: 'unsupported-snapshot',
    message: 'The export snapshot exceeds the portable asset or event bound.',
  })
  expect(pageRequests.some((request) => request.jobId === distinctAssetJobId)).toBe(false)

  const sharedRangeJobId = 6
  harness.onmessage(new MessageEvent('message', {
    data: pagedRequest(
      sharedRangeJobId,
      [pagedAsset],
      Array.from({ length: 256 }, (_, index) => pagedEvent(index + 1, pagedAsset.asset.assetId, 0)),
    ),
  }))
  await waitForTerminalResponse(sharedRangeJobId)

  expect(responses).toContainEqual({
    version: portableExportWorkerProtocolVersion,
    type: 'complete',
    jobId: unionJobId,
    frameCount: 1,
    chunkCount: 1,
  })
  expect(pageRequests.filter((request) => request.jobId === unionJobId)).toHaveLength(65)
  expect(responses).toContainEqual({
    version: portableExportWorkerProtocolVersion,
    type: 'complete',
    jobId: sharedRangeJobId,
    frameCount: 1,
    chunkCount: 1,
  })
  expect(pageRequests.filter((request) => request.jobId === sharedRangeJobId)).toHaveLength(1)
})
