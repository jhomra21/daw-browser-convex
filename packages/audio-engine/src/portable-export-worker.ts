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
  type PortableExportWorkerResponse,
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
  onmessage: ((event: MessageEvent<PortableExportWorkerResponse>) => void) | null
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

  private onMessage(value: PortableExportWorkerResponse) {
    if (value.version !== portableExportWorkerProtocolVersion || value.type === 'disposed' || !this.active) return
    if (value.jobId !== this.active.jobId) return
    if (value.type === 'chunk') {
      this.active.request.onChunk(value.index, value.pcm)
      return
    }
    if (value.type === 'progress') {
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
    if (value.type === 'error') this.fail(new Error(value.message))
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
