import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'

export const peakAssetFormatVersion = 4
export const waveformIntervalsPerChunk = 1024

export type WaveformIntervalMetadata = {
  readonly sampleRate: number
  readonly sourceFrameCount: number
  readonly firstFrame: number
  readonly framesPerInterval: number
  readonly intervalCount: number
}

export type WaveformByteIntervals = WaveformIntervalMetadata & {
  readonly kind: 'intervals'
  readonly encoding: 'signed-u8'
  readonly channels: readonly Uint8Array[]
}

export type WaveformFloatIntervals = WaveformIntervalMetadata & {
  readonly kind: 'intervals'
  readonly encoding: 'float32'
  readonly channels: readonly Float32Array[]
}

export type WaveformSamples = {
  readonly kind: 'samples'
  readonly channels: readonly Float32Array[]
  readonly firstFrame: number
  readonly sampleRate: number
  readonly sourceFrameCount: number
}

export type WaveformSourceData = WaveformByteIntervals | WaveformFloatIntervals | WaveformSamples

export type PeakChunkRecord = {
  readonly chunkKey: string
  readonly generationId: string
  readonly framesPerInterval: number
  readonly chunkIndex: number
  readonly intervalStart: number
  readonly intervalCount: number
  readonly channelCount: number
}

export type PeakLevelRecord = {
  readonly framesPerInterval: number
  readonly intervalCount: number
  readonly intervalsPerChunk: typeof waveformIntervalsPerChunk
  readonly chunkCount: number
}

export type PeakAssetRecord = {
  readonly formatVersion: typeof peakAssetFormatVersion
  readonly assetKey: string
  readonly generationId: string
  readonly frameCount: number
  readonly durationSec: number
  readonly sampleRate: number
  readonly channelCount: number
  readonly sourceIdentity?: WaveformSourceIdentity
  readonly levels: readonly PeakLevelRecord[]
}

export type WaveformSourceIdentity = {
  readonly assetKey: string
  readonly identity?: string
  readonly durationSec?: number
  readonly frameCount?: number
  readonly sampleRate?: number
  readonly channelCount?: number
}

export type EnsureWaveformAssetOptions = {
  readonly assetKey: string
  readonly sourceIdentity?: WaveformSourceIdentity
  readonly source?: AudioPcmSourceDescriptor
  readonly buffer?: AudioBuffer | null
  readonly signal?: AbortSignal
  readonly forceRegenerate?: boolean
}

export type WaveformSourceRequest = EnsureWaveformAssetOptions & {
  readonly sourceStartFrame: number
  readonly sourceEndFrame: number
  readonly framesPerInterval: number
  readonly priority?: number
}

export type WaveformChunkData = readonly Uint8Array[]

export type WaveformDrawStyle = {
  readonly fillStyle?: string
  readonly maxHeightFraction?: number
  readonly pointRadius?: number
  readonly minimumThicknessCssPx?: number
  readonly backingScaleY?: number
}

export type WaveformPainterContext = Pick<
  CanvasRenderingContext2D,
  'fillStyle' | 'beginPath' | 'moveTo' | 'lineTo' | 'fill' | 'arc'
>

export type WaveformPaintSegment = {
  readonly data: WaveformSourceData
  readonly sourceStartFrame: number
  readonly sourceEndFrame: number
  readonly startPx: number
  readonly endPx: number
  readonly topY: number
  readonly contentH: number
  readonly channelCount: number
  readonly style?: WaveformDrawStyle
  readonly fadeScaleAtSourceFrame?: (frame: number) => number
}
