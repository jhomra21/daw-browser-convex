export type ExportRange =
  | { mode: 'whole' }
  | { mode: 'loop'; startSec: number; endSec: number }
  | { mode: 'custom'; startSec: number; endSec: number }

type ExportRangeTrack = {
  clips: readonly { startSec: number; duration: number }[]
}

type ExportRangeBounds = { startSec: number; endSec: number }

export const getExportRangeBounds = (
  tracks: readonly ExportRangeTrack[],
  range: ExportRange,
): ExportRangeBounds => {
  if (range.mode !== 'whole') {
    const startSec = Math.max(0, range.startSec)
    return {
      startSec,
      endSec: Math.max(startSec + 0.001, range.endSec),
    }
  }
  let endSec = 0.001
  for (const track of tracks) {
    for (const clip of track.clips) {
      endSec = Math.max(endSec, clip.startSec + clip.duration)
    }
  }
  return { startSec: 0, endSec }
}

export const getExportRangeDuration = (
  tracks: readonly ExportRangeTrack[],
  range: ExportRange,
): number => {
  const bounds = getExportRangeBounds(tracks, range)
  return bounds.endSec - bounds.startSec
}
