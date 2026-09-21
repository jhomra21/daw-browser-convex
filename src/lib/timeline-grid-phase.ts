export const timelineGridPhasePx = (
  visibleStartSec: number,
  pixelsPerSecond: number,
  stepSec: number,
) => {
  if (
    !Number.isFinite(visibleStartSec)
    || !Number.isFinite(pixelsPerSecond)
    || pixelsPerSecond <= 0
    || !Number.isFinite(stepSec)
    || stepSec <= 0
  ) return 0

  const remainderSec = Math.max(0, visibleStartSec) % stepSec
  const phasePx = remainderSec * pixelsPerSecond
  return Number.isFinite(phasePx) ? -phasePx : 0
}
