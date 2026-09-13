import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'

export const peakAssetFormatVersion = 3

export type PeakChunkRecord = {
  chunkKey: string
  chunkIndex: number
  startSec: number
  endSec: number
  peakCount: number
  channelCount: number
}

export type PeakLevelRecord = {
  peaksPerSecond: number
  chunkDurationSec: number
  chunkCount: number
}

export type PeakAssetRecord = {
  formatVersion: typeof peakAssetFormatVersion
  assetKey: string
  durationSec: number
  sampleRate: number
  channelCount: number
  sourceIdentity?: WaveformSourceIdentity
  levels: PeakLevelRecord[]
}

export type WaveformSourceIdentity = {
  assetKey: string
  identity?: string
  durationSec?: number
  sampleRate?: number
  channelCount?: number
}

export type WaveformPeakChannelSlice = {
  readonly mode: 'pcm-envelope'
  readonly channels: readonly Uint8Array[]
  readonly columns: number
  readonly sourceStartSec: number
  readonly sourceEndSec: number
}

export type WaveformSampleChannelSlice = {
  readonly mode: 'pcm-line'
  readonly channels: readonly Float32Array[]
  readonly firstFrame: number
  readonly sampleRate: number
  readonly sourceStartSec: number
  readonly sourceEndSec: number
}

export type WaveformPcmResult = WaveformPeakChannelSlice | WaveformSampleChannelSlice

export type EnsureWaveformAssetOptions = {
  assetKey: string
  sourceIdentity?: WaveformSourceIdentity
  source?: AudioPcmSourceDescriptor
  buffer?: AudioBuffer | null
  signal?: AbortSignal
}

export type WaveformSliceRequest = EnsureWaveformAssetOptions & {
  sourceStartSec: number
  sourceEndSec: number
  bins: number
}

export type WaveformPeakChunkData = readonly Uint8Array[]

export type WaveformDrawOptions = {
  ctx: Pick<
    CanvasRenderingContext2D,
    'fillStyle' | 'strokeStyle' | 'lineWidth' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'fillRect'
  >
  peaks: Uint8Array
  drawCols: number
  padPx: number
  topY: number
  contentH: number
  cssW: number
  cssH: number
  fillStyle?: string
  boundaryStyle?: string
  maxHeightFraction?: number
  amplitudeScaleAtColumn?: (column: number) => number
  xOffsetPx?: number
  drawBoundary?: boolean
}
