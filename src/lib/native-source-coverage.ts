export const nativeMappedSourceCoverage = (
  sourceStart: number,
  sourceFrameCount: number,
  totalFrames: number,
) => {
  if (
    !Number.isFinite(sourceStart)
    || sourceStart < 0
    || !Number.isSafeInteger(sourceFrameCount)
    || sourceFrameCount < 0
    || !Number.isSafeInteger(totalFrames)
    || totalFrames <= 0
  ) return undefined
  if (sourceFrameCount === 0) {
    if (sourceStart > totalFrames) return undefined
    return {
      startFrame: Math.min(totalFrames, Math.floor(sourceStart)),
      frameCount: 0,
    }
  }
  const lastSamplePosition = sourceStart + sourceFrameCount - 1
  if (
    !Number.isFinite(lastSamplePosition)
    || lastSamplePosition >= totalFrames
  ) return undefined
  const startFrame = Math.floor(sourceStart)
  const endFrame = Math.min(totalFrames, Math.floor(lastSamplePosition) + 2)
  if (endFrame <= startFrame) return undefined
  return { startFrame, frameCount: endFrame - startFrame }
}
