export const pointStartPixelsPerSample = 4
export const pointFullPixelsPerSample = 6
export const waveformTierSelectionThreshold = 0.125

export type WaveformTier = {
  readonly framesPerInterval: number
  readonly sourceFramesPerBackingPixel: number
  readonly projectedIntervalWidth: number
}

export type WaveformTierSelectionInput = {
  readonly sourceFrameSpan: number
  readonly cssSegmentWidth: number
  readonly backingPixelsPerCssPixel: number
  readonly tiers: readonly number[]
}

const valid = (value: number) => Number.isFinite(value) && value > 0

export const selectWaveformTier = (input: WaveformTierSelectionInput): WaveformTier | null => {
  if (!valid(input.sourceFrameSpan)
    || !valid(input.cssSegmentWidth)
    || !valid(input.backingPixelsPerCssPixel)
    || input.tiers.length === 0) return null
  const tiers = [...new Set(input.tiers.filter((tier) => Number.isSafeInteger(tier) && tier > 0))].sort((a, b) => a - b)
  if (tiers.length === 0) return null
  const sourceFramesPerBackingPixel = input.sourceFrameSpan
    / (input.cssSegmentWidth * input.backingPixelsPerCssPixel)
  const projected = (tier: number) => tier / sourceFramesPerBackingPixel
  const requestedIndex = tiers.reduce((index, tier, candidateIndex) => (
    projected(tier) <= waveformTierSelectionThreshold ? candidateIndex : index
  ), 0)
  const framesPerInterval = tiers[requestedIndex] ?? tiers[0]!
  return {
    framesPerInterval,
    sourceFramesPerBackingPixel,
    projectedIntervalWidth: projected(framesPerInterval),
  }
}

export const pointRadiusForPixelsPerSample = (pixelsPerSample: number) => (
  !valid(pixelsPerSample) || pixelsPerSample <= pointStartPixelsPerSample
    ? 0
    : Math.min(1, (pixelsPerSample - pointStartPixelsPerSample)
      / (pointFullPixelsPerSample - pointStartPixelsPerSample))
)
