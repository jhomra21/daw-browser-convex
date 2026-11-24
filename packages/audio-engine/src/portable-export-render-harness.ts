import type { PortableExportSnapshot } from './portable-export-snapshot'
import {
  portableExportWorkerProtocolVersion,
  type PortableExportWorkerRequest,
  type PortableExportWorkerResponse,
} from './portable-export-worker-protocol'

type Supported = Extract<PortableExportSnapshot, { supported: true }>

const workerUrl = new URL('../../../public/audio-workers/daw-portable-export-worker-v2.js', import.meta.url)
const wasmUrl = new URL('../../../public/audio-core/daw-audio-core.wasm', import.meta.url)

let nextJobId = 1

type WorkerHarness = {
  onmessage: ((event: MessageEvent<PortableExportWorkerRequest>) => void) | null
  postMessage: (message: PortableExportWorkerResponse) => void
  listen: (listener: (message: PortableExportWorkerResponse) => void) => void
}

let installed: WorkerHarness | undefined

/**
 * The Worker script binds its message handler to `self` once per process (ES modules are cached by path), so every
 * test in the process shares this one harness and swaps who listens to its responses.
 */
export const installPortableExportWorker = async (): Promise<WorkerHarness> => {
  if (installed) return installed
  let listener: (message: PortableExportWorkerResponse) => void = () => undefined

  const harness: WorkerHarness = {
    onmessage: null,
    postMessage: (message) => listener(message),
    listen: (next) => {
      listener = next
    },
  }

  Object.defineProperty(globalThis, 'self', { configurable: true, value: harness, writable: true })
  await import(workerUrl.href)
  installed = harness

  return harness
}

/**
 * Runs the shipped export Worker against the production Wasm artifact the way
 * the browser client does, and returns the stereo PCM it streams back.
 * `frameCount` includes the graph latency pre-roll, as in a real export.
 */
export const renderThroughExportWorker = async (
  snapshot: Supported,
  input: { sampleRateHz: number; frameCount: number; maxFramesPerBlock?: number },
): Promise<{ planes: readonly [Float32Array, Float32Array]; failures: readonly PortableExportWorkerResponse[] }> => {
  const finished = Promise.withResolvers<void>()
  const jobId = nextJobId
  nextJobId += 1
  const left = new Float32Array(input.frameCount)
  const right = new Float32Array(input.frameCount)
  const failures: PortableExportWorkerResponse[] = []

  const worker = await installPortableExportWorker()

  worker.listen((message) => {
    if (message.type === 'disposed' || message.jobId !== jobId) return

    if (message.type === 'chunk') {
      left.set(message.pcm.planes[0] ?? [], message.startFrame)
      right.set(message.pcm.planes[1] ?? [], message.startFrame)
      worker.onmessage?.(new MessageEvent('message', {
        data: { version: portableExportWorkerProtocolVersion, type: 'chunk-consumed', jobId, index: message.index },
      }))
    } else if (message.type === 'complete') {
      finished.resolve()
    } else if (message.type === 'error' || message.type === 'cancelled') {
      failures.push(message)
      finished.resolve()
    }
  })

  worker.onmessage?.(new MessageEvent('message', {
    data: {
      version: portableExportWorkerProtocolVersion,
      type: 'render',
      jobId,
      sampleRateHz: input.sampleRateHz,
      frameCount: input.frameCount,
      maxFramesPerBlock: input.maxFramesPerBlock ?? 1024,
      generation: 1,
      contractHash: 'fixture',
      wasmBytes: await Bun.file(wasmUrl).arrayBuffer(),
      snapshot: { graph: snapshot.graph, assets: snapshot.assets, events: snapshot.events, automation: snapshot.automation },
    },
  }))

  await finished.promise

  return { planes: [left, right], failures }
}
