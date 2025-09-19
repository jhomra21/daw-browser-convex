import type { Clip, Track } from '~/types/timeline'

// Timeline constants
export const PPS = 100 // pixels per second
export const RULER_HEIGHT = 32 // px
export const LANE_HEIGHT = 96 // px per track lane

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
  const y = clientY - rect.top
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
      start = c.startSec + c.duration + 0.0001
      i = -1 // restart scan
    }
  }
  return start
}