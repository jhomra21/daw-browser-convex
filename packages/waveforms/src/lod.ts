export const pointStartPixelsPerSample = 4
export const pointFullPixelsPerSample = 6

export type WaveformTier = {
  readonly framesPerInterval: number
  readonly sourceFramesPerBackingPixel: number
  readonly projectedIntervalWidth: number
  readonly showPoints: boolean
}

export type WaveformTierSelectionInput = {
  readonly sourceFrameSpan: number
  readonly cssSegmentWidth: number
  readonly backingPixelsPerCssPixel: number
  readonly tiers: readonly number[]
  readonly previousFramesPerInterval?: number
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
    projected(tier) <= 0.75 ? candidateIndex : index
  ), 0)
  let index = requestedIndex
  const previousIndex = input.previousFramesPerInterval === undefined
    ? -1
    : Math.max(0, tiers.indexOf(input.previousFramesPerInterval))
  if (previousIndex >= 0) {
    const previousWidth = projected(tiers[previousIndex] ?? tiers[0]!)
    if (index > previousIndex && previousWidth <= 0.875) index = previousIndex
    if (index < previousIndex && previousWidth > 0.625) index = previousIndex
  }
  const framesPerInterval = tiers[index] ?? tiers[0]!
  const pixelsPerSample = 1 / sourceFramesPerBackingPixel
  return {
    framesPerInterval,
    sourceFramesPerBackingPixel,
    projectedIntervalWidth: projected(framesPerInterval),
    showPoints: pixelsPerSample >= pointStartPixelsPerSample,
  }
}

export const pointRadiusForPixelsPerSample = (pixelsPerSample: number) => (
  !valid(pixelsPerSample) || pixelsPerSample <= pointStartPixelsPerSample
    ? 0
    : Math.min(1, (pixelsPerSample - pointStartPixelsPerSample)
      / (pointFullPixelsPerSample - pointStartPixelsPerSample))
)
