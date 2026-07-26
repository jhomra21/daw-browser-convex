import type { AudioCoreGraphSnapshot, AudioCoreSampleSourceEventDto, PlanarPcm } from '../../audio-core-contract/src/index'
import type { PortableExportAsset } from './portable-export-snapshot'

export const portableExportWorkerProtocolVersion = 1
export const portableExportWorkerMaxFramesPerBlock = 8_192
export const portableExportWorkerMaxChunks = 4_096
export const portableExportWorkerMaxFrames = portableExportWorkerMaxFramesPerBlock * portableExportWorkerMaxChunks
export const portableExportWorkerMaxAssets = 64
export const portableExportWorkerMaxEvents = 256
export const portableExportWorkerMaxGraphNodes = 64
export const portableExportWorkerMaxGraphEdges = 256

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
  | { version: typeof portableExportWorkerProtocolVersion; type: 'cancel'; jobId: number }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'dispose' }

export type PortableExportWorkerResponse =
  | { version: typeof portableExportWorkerProtocolVersion; type: 'progress'; jobId: number; completedFrames: number; totalFrames: number }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'chunk'; jobId: number; index: number; frameCount: number; pcm: PlanarPcm }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'complete'; jobId: number; frameCount: number; chunkCount: number }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'cancelled'; jobId: number }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'disposed' }
  | { version: typeof portableExportWorkerProtocolVersion; type: 'error'; jobId: number; code: 'invalid-request' | 'unsupported-snapshot' | 'initialization-failed' | 'render-failed'; message: string }