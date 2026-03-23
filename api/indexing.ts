import { toZeroBasedCommandIndex } from '../src/lib/agent-command-targets'

export const toZeroBased = (n: any): number | undefined => toZeroBasedCommandIndex(typeof n === 'number' ? n : Number(n))

export const asPositiveIndex = (n: any): number | undefined => {
  const idx = toZeroBased(n)
  return (typeof idx === 'number' && idx >= 0) ? idx : undefined
}

export function trackAtIndex<T>(list: readonly T[] | undefined, value: any): T | undefined {
  const idx = asPositiveIndex(value)
  return (typeof idx === 'number' && list) ? (list[idx] as T | undefined) : undefined
}

export function clipAtIndex<T>(clips: readonly T[], value: any): T | undefined {
  const idx = asPositiveIndex(value)
  return typeof idx === 'number' ? clips[idx] : undefined
}

export function clipsFromIndices<T>(clips: readonly T[], values: readonly any[] | undefined): T[] {
  if (!Array.isArray(values) || values.length === 0) return []
  return values.map(v => clipAtIndex(clips, v)).filter(Boolean) as T[]
}

export function sortClipsByStartSec<T extends { startSec?: number }>(clips: readonly T[]) {
  return [...clips].sort((left, right) => (left.startSec ?? 0) - (right.startSec ?? 0))
}

export function listSortedClipsForTrack<T extends { trackId?: unknown; startSec?: number }>(clips: readonly T[], trackId: unknown) {
  return sortClipsByStartSec(clips.filter((clip) => String(clip.trackId) === String(trackId)))
}

export function resolveTrackClip<T extends { startSec?: number }>(
  clips: readonly T[],
  input: { clipIndex?: number; clipAtOrAfterSec?: number },
) {
  const direct = clipAtIndex(clips, input.clipIndex)
  if (direct) return direct
  if (typeof input.clipAtOrAfterSec === 'number') {
    return clips.find((clip) => (clip.startSec ?? 0) >= input.clipAtOrAfterSec!)
  }
  return clips[0]
}

export function selectTrackClips<T extends { startSec?: number }>(
  clips: readonly T[],
  input: {
    clipIndices?: number[]
    rangeStartSec?: number
    rangeEndSec?: number
    clipAtOrAfterSec?: number
    count?: number
  },
) {
  const selectedFromIndices = clipsFromIndices(clips, input.clipIndices)
  if (selectedFromIndices.length > 0) return selectedFromIndices
  if (typeof input.rangeStartSec === 'number' && typeof input.rangeEndSec === 'number') {
    return clips.filter((clip) => (clip.startSec ?? 0) >= input.rangeStartSec! && (clip.startSec ?? 0) < input.rangeEndSec!)
  }
  if (typeof input.clipAtOrAfterSec === 'number') {
    const after = clips.filter((clip) => (clip.startSec ?? 0) >= input.clipAtOrAfterSec!)
    return typeof input.count === 'number' ? after.slice(0, input.count) : after
  }
  return typeof input.count === 'number' ? clips.slice(0, input.count) : [...clips]
}
