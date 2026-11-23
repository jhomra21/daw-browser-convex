type Direction = -1 | 1

type NavigableTrack = {
  id: string
  collapsed?: boolean
  clips: readonly { id: string; startSec: number }[]
}

type LoopRegion = { startSec: number; endSec: number }

const byStart = <T extends { startSec: number }>(clips: readonly T[]) => clips.toSorted((a, b) => a.startSec - b.startSec)

// Moving a multi selection as a group keeps its spacing: the earliest clip decides how far left it may go.
export const clampNudgeDeltaSec = (startsSec: readonly number[], deltaSec: number) => (
  Math.max(deltaSec, 0 - Math.min(...startsSec))
)

// Collapsed tracks and clips outside the render window have no element, so they never hold the tab stop.
export const resolveClipTabStopId = (
  tracks: readonly NavigableTrack[],
  primaryClipId: string | null,
  isRendered: (clipId: string) => boolean = () => true,
) => {
  const visible = tracks.filter((track) => !track.collapsed)

  if (primaryClipId && isRendered(primaryClipId) && visible.some((track) => track.clips.some((clip) => clip.id === primaryClipId))) {
    return primaryClipId
  }

  for (const track of visible) {
    const first = byStart(track.clips).find((clip) => isRendered(clip.id))

    if (first) return first.id
  }

  return undefined
}

export const adjacentClipOnTrack = (track: NavigableTrack, clipId: string, direction: Direction) => {
  const ordered = byStart(track.clips)
  const index = ordered.findIndex((clip) => clip.id === clipId)

  return index < 0 ? undefined : ordered[index + direction]?.id
}

export const nearestClipOnAdjacentTrack = (
  tracks: readonly NavigableTrack[],
  clipId: string,
  direction: Direction,
) => {
  const trackIndex = tracks.findIndex((track) => track.clips.some((clip) => clip.id === clipId))
  const from = tracks[trackIndex]?.clips.find((clip) => clip.id === clipId)

  if (!from) return undefined

  for (let index = trackIndex + direction; index >= 0 && index < tracks.length; index += direction) {
    const track = tracks[index]

    if (track.collapsed) continue

    const nearest = byStart(track.clips).reduce<NavigableTrack['clips'][number] | undefined>(
      (best, clip) => (
        !best || Math.abs(clip.startSec - from.startSec) < Math.abs(best.startSec - from.startSec) ? clip : best
      ),
      undefined,
    )

    if (nearest) return { trackId: track.id, clipId: nearest.id }
  }

  return undefined
}

export const resolveClipNavigationTarget = (
  tracks: readonly NavigableTrack[],
  clipId: string,
  axis: 'time' | 'track',
  direction: Direction,
) => {
  if (axis === 'track') return nearestClipOnAdjacentTrack(tracks, clipId, direction)

  const track = tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId))
  const next = track && adjacentClipOnTrack(track, clipId, direction)

  return track && next ? { trackId: track.id, clipId: next } : undefined
}

export const nudgeLoopRegion = (
  region: LoopRegion,
  stepSec: number,
  direction: Direction,
  maxEndSec: number,
): LoopRegion => {
  const length = region.endSec - region.startSec
  const startSec = Math.max(0, Math.min(region.startSec + direction * stepSec, maxEndSec - length))

  return { startSec, endSec: startSec + length }
}

export const resizeLoopRegionEnd = (region: LoopRegion, stepSec: number, direction: Direction): LoopRegion => ({
  startSec: region.startSec,
  endSec: Math.max(region.startSec + stepSec, region.endSec + direction * stepSec),
})

export const stepPlayheadSec = (sec: number, stepSec: number, direction: Direction, durationSec: number) => (
  Math.max(0, Math.min(durationSec, sec + direction * stepSec))
)
