import type { Clip, Track } from '~/types/timeline'

// Timeline constants
export const PPS = 100 // pixels per second
export const RULER_HEIGHT = 32 // px
export const LANE_HEIGHT = 96 // px per track lane
// Shared Effects panel layout constants
export const FX_PANEL_HEIGHT_PX = 360
export const FX_PANEL_GAP_PX = 8
export const FX_OFFSET_PX = FX_PANEL_HEIGHT_PX + FX_PANEL_GAP_PX

export function timelineDurationSec(tracks: Track[]) {
  let maxEnd = 0
  for (const t of tracks) {
    for (const c of t.clips) maxEnd = Math.max(maxEnd, c.startSec + c.duration)
  }
  return Math.max(30, maxEnd + 5)
}

export function clientXToSec(clientX: number, scrollRef: HTMLDivElement) {
  const rect = scrollRef.getBoundingClientRect()
  const x = clientX - rect.left + (scrollRef.scrollLeft || 0)
  return Math.max(0, x / PPS)
}

export function yToLaneIndex(clientY: number, scrollRef: HTMLDivElement) {
  const rect = scrollRef.getBoundingClientRect()
  const y = clientY - rect.top + (scrollRef.scrollTop || 0)
  return Math.floor((y - RULER_HEIGHT) / LANE_HEIGHT)
}

export function willOverlap(clips: Clip[], excludeId: string | null, start: number, duration: number) {
  const end = start + duration
  for (const c of clips) {
    if (excludeId && c.id === excludeId) continue
    const cEnd = c.startSec + c.duration
    if (end > c.startSec && start < cEnd) return true
  }
  return false
}

export function calcNonOverlapStart(clips: Clip[], excludeId: string | null, desiredStart: number, duration: number) {
  let start = Math.max(0, desiredStart)
  const sorted = clips.filter(c => !excludeId || c.id !== excludeId).slice().sort((a, b) => a.startSec - b.startSec)
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]
    if (start < c.startSec + c.duration && start + duration > c.startSec) {
      // Move start to be exactly flush with the blocking clip's right edge.
      // No epsilon here so clips can sit perfectly adjacent without micro-gaps.
      start = c.startSec + c.duration
      i = -1 // restart scan
    }
  }
  return start
}

// --- Grid / snapping helpers ---
export function quantizeSecToGrid(
  sec: number,
  bpm: number,
  denom: number,
  mode: 'round' | 'floor' | 'ceil' = 'round',
): number {
  const safeBpm = Math.max(1e-6, bpm || 0)
  const step = (60 / safeBpm) * (4 / Math.max(1, denom || 4))
  if (!Number.isFinite(step) || step <= 0) return Math.max(0, sec)
  const idx = sec / step
  let snappedIdx = idx
  if (mode === 'floor') snappedIdx = Math.floor(idx)
  else if (mode === 'ceil') snappedIdx = Math.ceil(idx)
  else snappedIdx = Math.round(idx)
  return Math.max(0, snappedIdx * step)
}

export function calcNonOverlapStartGridAligned(
  clips: Clip[],
  excludeId: string | null,
  desiredStart: number,
  duration: number,
  bpm: number,
  denom: number,
  mode: 'round' | 'floor' | 'ceil' = 'round',
): number {
  const safeBpm = Math.max(1e-6, bpm || 0)
  const step = (60 / safeBpm) * (4 / Math.max(1, denom || 4))
  if (!Number.isFinite(step) || step <= 0) {
    return calcNonOverlapStart(clips, excludeId, desiredStart, duration)
  }
  let start = quantizeSecToGrid(Math.max(0, desiredStart), bpm, denom, mode)
  const sorted = clips
    .filter(c => !excludeId || c.id !== excludeId)
    .slice()
    .sort((a, b) => a.startSec - b.startSec)
  // Align exactly to neighbors without leaving tiny gaps.

  // Pass 1: gap snapping when there is no overlap
  if (sorted.length > 0) {
    let prevEnd = -Infinity
    let nextStart = Infinity
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]
      const cEnd = c.startSec + c.duration
      if (cEnd <= start) prevEnd = Math.max(prevEnd, cEnd)
      if (c.startSec >= start) { nextStart = Math.min(nextStart, c.startSec); break }
    }
    // Inside a valid gap: only magnet to an edge when close to it; otherwise respect snapped grid position.
    const leftEdge = Number.isFinite(prevEnd) ? prevEnd : -Infinity
    const rightEdge = Number.isFinite(nextStart) ? (nextStart as number) - duration : Infinity
    if (start > leftEdge && start < rightEdge) {
      const threshold = step * 0.5
      const nearLeft = Number.isFinite(leftEdge) && Math.abs(start - (leftEdge as number)) <= threshold + 1e-7
      const nearRight = Number.isFinite(rightEdge) && Math.abs((rightEdge as number) - start) <= threshold + 1e-7
      if (nearLeft) start = leftEdge as number
      else if (nearRight) start = rightEdge as number
    } else {
      // If snapped just outside the gap, allow snapping to the nearest edge within one grid step
      if (Number.isFinite(rightEdge) && start >= rightEdge && (start - rightEdge) <= step + 1e-7) {
        start = rightEdge
      } else if (Number.isFinite(leftEdge) && start <= leftEdge && (leftEdge - start) <= step + 1e-7) {
        start = leftEdge
      }
    }

  }
  // Pass 2: if overlap remains, move forward by the smaller of (a) flush to edge, (b) next grid
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]
    if (start < c.startSec + c.duration && start + duration > c.startSec) {
      const edge = c.startSec + c.duration
      const snappedNext = quantizeSecToGrid(edge, bpm, denom, 'ceil')
      const candidateEdge = edge
      const candidateGrid = Math.max(start + step, snappedNext)
      const distEdge = Math.max(0, candidateEdge - start)
      const distGrid = Math.max(0, candidateGrid - start)
      start = distEdge <= distGrid ? candidateEdge : candidateGrid
      i = -1
    }
  }
  return start
}