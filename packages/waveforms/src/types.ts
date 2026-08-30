export const peakAssetFormatVersion = 2

export type PeakChunkRecord = {
  chunkKey: string
  startSec: number
  endSec: number
  peakCount: number
}

export type PeakLevelRecord = {
  peaksPerSecond: number
  chunkDurationSec: number
  chunks: PeakChunkRecord[]
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
  durationSec?: number
  sampleRate?: number
  channelCount?: number
}

export type EnsureWaveformAssetOptions = {
  assetKey: string
  sourceIdentity?: WaveformSourceIdentity
  sampleUrl?: string
  buffer?: AudioBuffer | null
}

export type WaveformSliceRequest = EnsureWaveformAssetOptions & {
  sourceStartSec: number
  sourceEndSec: number
  bins: number
}

export type WaveformPeakChannelSlice = {
  channels: Uint8Array[]
  columns: number
}

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
}
