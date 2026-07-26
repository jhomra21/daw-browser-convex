import {
  loadAudioCoreWasmArtifact,
  type AudioCoreWasmArtifact,
} from '../../audio-core-wasm/src/index'
import { processorContractHash } from '../../audio-core-contract/src/generated/processor-contract-metadata'
import type { PlanarPcm } from '../../audio-core-contract/src/index'
import { resolveWorkletModuleUrl, resolvePortableWasmManifestUrl } from './worklet-manifest'
import {
  portableExportWorkerProtocolVersion,
  type PortableExportWorkerRequest,
  type PortableExportWorkerSnapshot,
} from './portable-export-worker-protocol'

export type PortableExportWorkerRenderRequest = {
  snapshot: PortableExportWorkerSnapshot
  sampleRateHz: number
  frameCount: number
  generation: number
  maxFramesPerBlock?: number
  signal?: AbortSignal
  onProgress?: (completedFrames: number, totalFrames: number) => void
  onChunk: (index: number, pcm: PlanarPcm) => void
}

export type PortableExportWorkerLike = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage: (message: PortableExportWorkerRequest, transfer: Transferable[]) => void
  terminate: () => void
}

const createPortableExportWorkerLike = (): PortableExportWorkerLike => {
  const worker = new Worker(resolveWorkletModuleUrl('audio-workers/daw-portable-export-worker-v1.js'), { type: 'module' })
  return {
    get onmessage() {
      return worker.onmessage
    },
    set onmessage(handler) {
      worker.onmessage = handler
    },
    get onerror() {
      return worker.onerror
    },
    set onerror(handler) {
      worker.onerror = handler
    },
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    terminate: () => worker.terminate(),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isChunk = (value: Record<string, unknown>): value is Record<string, unknown> & {
  type: 'chunk'
  jobId: number
  index: number
  pcm: PlanarPcm
} => value.type === 'chunk'
  && typeof value.jobId === 'number'
  && typeof value.index === 'number'
  && isRecord(value.pcm)
  && typeof value.pcm.frameCount === 'number'
  && Array.isArray(value.pcm.planes)
  && value.pcm.planes.every((plane) => plane instanceof Float32Array)

/**
 * Thin client boundary for the static dedicated Worker. It owns no export
 * policy: callers must pass a successfully compiled portable snapshot.
 */
export class PortableExportWorker {
  private readonly worker: PortableExportWorkerLike
  private nextJobId = 1
  private active:
    | {
      jobId: number
      request: PortableExportWorkerRenderRequest
      resolve: () => void
      reject: (error: Error) => void
    }
    | undefined

  constructor(
    worker: PortableExportWorkerLike = createPortableExportWorkerLike(),
    private readonly manifestUrl = resolvePortableWasmManifestUrl(),
    private readonly artifact?: AudioCoreWasmArtifact,
  ) {
    this.worker = worker
    worker.onmessage = (event) => this.onMessage(event.data)
    worker.onerror = () => this.fail(new Error('Portable export Worker failed.'))
  }

  private onMessage(value: unknown) {
    if (!isRecord(value) || value.version !== portableExportWorkerProtocolVersion || !this.active) return
    if (value.jobId !== this.active.jobId) return
    if (isChunk(value)) {
      this.active.request.onChunk(value.index, value.pcm)
      return
    }
    if (value.type === 'progress'
      && typeof value.completedFrames === 'number'
      && typeof value.totalFrames === 'number') {
      this.active.request.onProgress?.(value.completedFrames, value.totalFrames)
      return
    }
    if (value.type === 'complete') {
      const active = this.active
      this.active = undefined
      active.resolve()
      return
    }
    if (value.type === 'cancelled') {
      this.fail(new DOMException('Portable export was cancelled.', 'AbortError'))
      return
    }
    if (value.type === 'error' && typeof value.message === 'string') this.fail(new Error(value.message))
  }

  private fail(error: Error) {
    const active = this.active
    this.active = undefined
    active?.reject(error)
  }

  async render(request: PortableExportWorkerRenderRequest): Promise<void> {
    if (this.active) throw new Error('Portable export Worker already has an active render.')
    request.signal?.throwIfAborted()
    const artifact = this.artifact
      ? { available: true as const, artifact: this.artifact }
      : await loadAudioCoreWasmArtifact(this.manifestUrl)
    request.signal?.throwIfAborted()
    if (!artifact.available) throw new Error(artifact.message)
    const jobId = this.nextJobId
    this.nextJobId += 1
    const wasmBytes = artifact.artifact.bytes.slice(0)
    const message: PortableExportWorkerRequest = {
      version: portableExportWorkerProtocolVersion,
      type: 'render',
      jobId,
      sampleRateHz: request.sampleRateHz,
      frameCount: request.frameCount,
      maxFramesPerBlock: request.maxFramesPerBlock ?? 1024,
      generation: request.generation,
      contractHash: processorContractHash,
      wasmBytes,
      snapshot: request.snapshot,
    }
    const transfer = [
      wasmBytes,
      ...request.snapshot.assets.flatMap((entry) => entry.transferables),
    ]
    return new Promise<void>((resolve, reject) => {
      this.active = { jobId, request, resolve, reject }
      this.worker.postMessage(message, transfer)
    })
  }

  cancel() {
    if (!this.active) return
    this.worker.postMessage({
      version: portableExportWorkerProtocolVersion,
      type: 'cancel',
      jobId: this.active.jobId,
    }, [])
  }

  dispose() {
    this.worker.postMessage({ version: portableExportWorkerProtocolVersion, type: 'dispose' }, [])
    this.fail(new Error('Portable export Worker was disposed.'))
    this.worker.terminate()
  }
}
