import type { AudioCoreGraphSnapshot, AudioCoreSampleSourceEventDto, PlanarPcm } from '../../audio-core-contract/src/index'
import type { PortableExportAsset } from './portable-export-snapshot'

export const portableExportWorkerProtocolVersion = 2
export const portableExportWorkerMaxFramesPerBlock = 8_192
export const portableExportWorkerMaxAssets = 64
export const portableExportWorkerMaxEvents = 256
export const portableExportWorkerMaxGraphNodes = 64
export const portableExportWorkerMaxGraphEdges = 256
export const portableExportWorkerMaxResidentPages = 128
export const portableExportWorkerPageFrames = 16_384

export type PortableExportWorkerSnapshot = {
  graph: AudioCoreGraphSnapshot
  assets: readonly PortableExportAsset[]
  events: readonly AudioCoreSampleSourceEventDto[]
}

export type PortableExportWorkerRequest =
  | {
    version: typeof portableExportWorkerProtocolVersion
    type: 'render'
    jobId: number
    sampleRateHz: number
    frameCount: number
    maxFramesPerBlock: number
    generation: number
    contractHash: string
    wasmBytes: ArrayBuffer
    snapshot: PortableExportWorkerSnapshot
  }
  | {
    version: typeof portableExportWorkerProtocolVersion
    type: 'page-response'
    jobId: number
    requestId: number
    assetId: string
    startFrame: number
    frameCount: number
    planes?: readonly Float32Array[]
    error?: string
  }
  | {
    version: typeof portableExportWorkerProtocolVersion
    type: 'chunk-consumed'
    jobId: number
    index: number
  }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'cancel'; jobId: number }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'dispose' }

export type PortableExportWorkerResponse =
  | { version: typeof portableExportWorkerProtocolVersion; type: 'progress'; jobId: number; completedFrames: number; totalFrames: number }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'page-request'; jobId: number; requestId: number; assetId: string; startFrame: number; frameCount: number }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'chunk'; jobId: number; index: number; startFrame: number; frameCount: number; pcm: PlanarPcm }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'complete'; jobId: number; frameCount: number; chunkCount: number }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'cancelled'; jobId: number }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'disposed' }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'error'; jobId: number; code: 'invalid-request' | 'unsupported-snapshot' | 'initialization-failed' | 'render-failed'; message: string }