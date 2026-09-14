export const maximumCachedPeaksPerSecond = 400
export const samplePointMinimumPixelsPerSample = 5
export const lineBlendStartSamplesPerPixel = 1.5
export const lineBlendEndSamplesPerPixel = 2 / 3
export const pointBlendStartPixelsPerSample = 4
export const pointBlendEndPixelsPerSample = 6

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
  }

export type WaveformVisualMix = {
  envelopeOpacity: number
  lineOpacity: number
  pointOpacity: number
  pointRadius: number
}

export type SelectWaveformLodInput = {
  sampleRate: number
  sourceStartSec: number
  sourceEndSec: number
  widthPx: number
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const smoothstep = (value: number) => {
  const clamped = clamp01(value)
  return clamped * clamped * (3 - 2 * clamped)
}

export const waveformVisualMixFor = (input: {
  samplesPerPixel: number
  pixelsPerSample?: number
}): WaveformVisualMix => {
  const samplesPerPixel = Number.isFinite(input.samplesPerPixel) && input.samplesPerPixel > 0
    ? input.samplesPerPixel
    : 1
  const pixelsPerSample = Number.isFinite(input.pixelsPerSample) && (input.pixelsPerSample ?? 0) > 0
    ? input.pixelsPerSample ?? 1 / samplesPerPixel
    : 1 / samplesPerPixel
  const lineOpacity = smoothstep(
    (lineBlendStartSamplesPerPixel - samplesPerPixel)
      / (lineBlendStartSamplesPerPixel - lineBlendEndSamplesPerPixel),
  )
  const pointOpacity = smoothstep(
    (pixelsPerSample - pointBlendStartPixelsPerSample)
      / (pointBlendEndPixelsPerSample - pointBlendStartPixelsPerSample),
  )
  return {
    envelopeOpacity: 1 - lineOpacity,
    lineOpacity,
    pointOpacity,
    pointRadius: pointOpacity,
  }
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

  return {
    mode: 'pcm-line',
    requestedColumnsPerSecond,
    samplesPerPixel,
    pixelsPerSample: 1 / samplesPerPixel,
  }
}
