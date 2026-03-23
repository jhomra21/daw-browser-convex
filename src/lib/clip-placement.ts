type ClipPlacementLike = {
  id?: string
  startSec: number
  duration: number
}

export function willClipsOverlap(
  clips: readonly ClipPlacementLike[],
  excludeId: string | null,
  startSec: number,
  duration: number,
) {
  const endSec = startSec + duration
  for (const clip of clips) {
    if (excludeId && clip.id === excludeId) continue
    const clipEndSec = clip.startSec + clip.duration
    if (endSec > clip.startSec && startSec < clipEndSec) return true
  }
  return false
}

export function calcNonOverlappingStart(
  clips: readonly ClipPlacementLike[],
  excludeId: string | null,
  desiredStartSec: number,
  duration: number,
) {
  let startSec = Math.max(0, desiredStartSec)
  const sorted = clips
    .filter((clip) => !excludeId || clip.id !== excludeId)
    .slice()
    .sort((left, right) => left.startSec - right.startSec)

  for (let index = 0; index < sorted.length; index++) {
    const clip = sorted[index]
    if (startSec < clip.startSec + clip.duration && startSec + duration > clip.startSec) {
      startSec = clip.startSec + clip.duration
      index = -1
    }
  }

  return startSec
}
