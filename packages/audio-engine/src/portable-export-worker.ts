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

type PortableWorkerFailure = Error | DOMException | string

export type PortableExportWorkerRenderRequest = {
  snapshot: PortableExportWorkerSnapshot
  sampleRateHz: number
  frameCount: number
  generation: number
  maxFramesPerBlock?: number
  signal?: AbortSignal
  onProgress?: (completedFrames: number, totalFrames: number) => void
  onChunk: (index: number, startFrame: number, pcm: PlanarPcm) => Promise<void> | void
  readPage?: (input: {
    assetId: string
    startFrame: number
    frameCount: number
    signal?: AbortSignal
  }) => Promise<readonly Float32Array[]>
}

export type PortableExportWorkerLike = {
  onmessage: ((event: MessageEvent<PortableExportWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage: (message: PortableExportWorkerRequest, transfer: Transferable[]) => void
  terminate: () => void
}

const createPortableExportWorkerLike = (): PortableExportWorkerLike => {
  const worker = new Worker(resolveWorkletModuleUrl('audio-workers/daw-portable-export-worker-v2.js'), { type: 'module' })
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
      nextChunkIndex: number
      nextChunkStartFrame: number
      pagePending: boolean
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
    if (value.type === 'page-request') {
      const active = this.active
      if (active.pagePending || !active.request.readPage) {
        this.worker.postMessage({
          version: portableExportWorkerProtocolVersion,
          type: 'page-response',
          jobId: value.jobId,
          requestId: value.requestId,
          assetId: value.assetId,
          startFrame: value.startFrame,
          frameCount: value.frameCount,
          error: active.request.readPage ? 'Only one page request may be outstanding.' : 'No page provider was supplied.',
        }, [])
        return
      }
      active.pagePending = true
      void active.request.readPage({
        assetId: value.assetId,
        startFrame: value.startFrame,
        frameCount: value.frameCount,
        signal: active.request.signal,
      }).then((planes) => {
        if (this.active !== active) return
        const transfer = planes.map((plane) => plane.buffer)
        this.worker.postMessage({
          version: portableExportWorkerProtocolVersion,
          type: 'page-response',
          jobId: value.jobId,
          requestId: value.requestId,
          assetId: value.assetId,
          startFrame: value.startFrame,
          frameCount: value.frameCount,
          planes,
        }, transfer)
      }).catch((error: PortableWorkerFailure) => {
        if (this.active !== active) return
        this.worker.postMessage({
          version: portableExportWorkerProtocolVersion,
          type: 'page-response',
          jobId: value.jobId,
          requestId: value.requestId,
          assetId: value.assetId,
          startFrame: value.startFrame,
          frameCount: value.frameCount,
          error: error instanceof Error ? error.message : String(error),
        }, [])
      }).finally(() => {
        if (this.active === active) active.pagePending = false
      })
      return
    }
    if (value.type === 'chunk') {
      if (value.index !== this.active.nextChunkIndex
        || value.startFrame !== this.active.nextChunkStartFrame
        || value.frameCount !== value.pcm.frameCount) {
        this.fail(new Error('Portable export Worker returned a nonsequential chunk.'))
        return
      }
      this.active.nextChunkIndex += 1
      this.active.nextChunkStartFrame += value.frameCount
      Promise.resolve(this.active.request.onChunk(value.index, value.startFrame, value.pcm)).then(() => {
        if (!this.active || this.active.jobId !== value.jobId) return
        this.worker.postMessage({
          version: portableExportWorkerProtocolVersion,
          type: 'chunk-consumed',
          jobId: value.jobId,
          index: value.index,
        }, [])
      }).catch((error: PortableWorkerFailure) => this.fail(error instanceof Error ? error : new Error(String(error))))
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
    if (!active) return
    this.worker.postMessage({
      version: portableExportWorkerProtocolVersion,
      type: 'cancel',
      jobId: active.jobId,
    }, [])
    active.reject(error)
    this.worker.terminate()
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
      this.active = {
        jobId,
        request,
        nextChunkIndex: 0,
        nextChunkStartFrame: 0,
        pagePending: false,
        resolve,
        reject,
      }
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
