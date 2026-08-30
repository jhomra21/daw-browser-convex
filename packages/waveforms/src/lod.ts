export const maximumCachedPeaksPerSecond = 400
export const samplePointMinimumPixelsPerSample = 5

export type WaveformLod =
  | {
    mode: 'cached-peaks'
    requestedColumnsPerSecond: number
    samplesPerPixel: number
  }
  | {
    mode: 'pcm-envelope'
    requestedColumnsPerSecond: number
    samplesPerPixel: number
  }
  | {
    mode: 'pcm-line'
    requestedColumnsPerSecond: number
    samplesPerPixel: number
    pixelsPerSample: number
    showPoints: boolean
  }

type SelectWaveformLodInput = {
  sampleRate: number
  sourceStartSec: number
  sourceEndSec: number
  widthPx: number
}

export function selectWaveformLod(input: SelectWaveformLodInput): WaveformLod | null {
  const durationSec = input.sourceEndSec - input.sourceStartSec
  if (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0
    || !Number.isFinite(input.sourceStartSec) || input.sourceStartSec < 0
    || !Number.isFinite(input.sourceEndSec)
    || !Number.isFinite(durationSec) || durationSec <= 0
    || !Number.isFinite(input.widthPx) || input.widthPx <= 0) return null

  const requestedColumnsPerSecond = input.widthPx / durationSec
  const samplesPerPixel = input.sampleRate / requestedColumnsPerSecond
  if (requestedColumnsPerSecond <= maximumCachedPeaksPerSecond) {
    return { mode: 'cached-peaks', requestedColumnsPerSecond, samplesPerPixel }
  }
  if (samplesPerPixel >= 1) {
    return { mode: 'pcm-envelope', requestedColumnsPerSecond, samplesPerPixel }
  }

  const pixelsPerSample = 1 / samplesPerPixel
  return {
    mode: 'pcm-line',
    requestedColumnsPerSecond,
    samplesPerPixel,
    pixelsPerSample,
    showPoints: pixelsPerSample >= samplePointMinimumPixelsPerSample,
  }
}
