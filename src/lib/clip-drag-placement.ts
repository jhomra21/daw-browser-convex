import { isClipCompatibleWithTrack } from '@daw-browser/timeline-core/track-routing'
import { createTimelineTrackIndex, type TimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import {
  calcNonOverlapStart,
  calcNonOverlapStartGridAligned,
  quantizeSecToGrid,
  willOverlap,
} from '~/lib/timeline-utils'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

export type MultiDragSnapshot = {
  anchorClipId: string
  anchorOrigTrackIdx: number
  anchorOrigStartSec: number
  items: Array<{ clipId: string; origTrackIdx: number; origStartSec: number }>
}

type PlannedClipMove = {
  clipId: string
  trackId: Track['id']
  startSec: number
}

export type DuplicatedClipPlacement = {
  trackId: Track['id']
  originalClip: Clip
  startSec: number
}

type NonDupPlacementResolution =
  | { status: 'needs-track' }
  | { status: 'invalid' }
  | {
      status: 'ready'
      targetTrackId: Track['id']
      moves: PlannedClipMove[]
      selection: { trackId: Track['id']; clipId: string; preserveClipIds?: boolean }
    }

function findClipIn(lookup: TimelineTrackIndex, id: string): Clip | null {
  return lookup.clipById.get(id) ?? null
}

export function canPlaceClipOnTrack(track: Track | undefined, clip: Clip | null | undefined): boolean {
  return !!track && !!clip && isClipCompatibleWithTrack(track, clip)
}

function canPlaceMultiDrag(
  tracks: Track[],
  multi: MultiDragSnapshot,
  anchorTargetIdx: number,
  lookup = createTimelineTrackIndex(tracks),
): boolean {
  const deltaIdx = anchorTargetIdx - multi.anchorOrigTrackIdx
  for (const item of multi.items) {
    const clip = findClipIn(lookup, item.clipId)
    if (!clip) return false
    const targetIndex = Math.max(0, Math.min(tracks.length - 1, item.origTrackIdx + deltaIdx))
    if (!canPlaceClipOnTrack(tracks[targetIndex], clip)) return false
  }
  return true
}

export function resolveNonDupTargetTrackId(
  tracks: Track[],
  laneIdx: number,
  addedTrackDuringDrag: Track['id'] | null,
): Track['id'] | null | undefined {
  if (laneIdx >= tracks.length) {
    return addedTrackDuringDrag
  }
  const boundedLaneIdx = Math.max(0, Math.min(laneIdx, tracks.length - 1))
  return tracks[boundedLaneIdx]?.id
}

export function resolveNonDupClipDragPlacement(input: {
  tracks: Track[]
  lookup?: TimelineTrackIndex
  draggingIds: { trackId: Track['id']; clipId: string }
  multiDragging: MultiDragSnapshot | null
  addedTrackDuringDrag: Track['id'] | null
  userId: string
  desiredStart: number
  laneIdx: number
  gridEnabled: boolean
  bpm: number
  gridDenominator: number
}): NonDupPlacementResolution {
  if (input.laneIdx >= input.tracks.length && !input.addedTrackDuringDrag) {
    return { status: 'needs-track' }
  }

  const lookup = input.lookup ?? createTimelineTrackIndex(input.tracks)
  const targetTrackId = resolveNonDupTargetTrackId(input.tracks, input.laneIdx, input.addedTrackDuringDrag)
  if (!targetTrackId) {
    return { status: 'invalid' }
  }

  const targetTrack = lookup.trackById.get(targetTrackId)
  if (!targetTrack) {
    return { status: 'invalid' }
  }
  if (targetTrack.lockedBy && targetTrack.lockedBy !== input.userId) {
    return { status: 'invalid' }
  }

  if (input.multiDragging) {
    const multi = input.multiDragging
    const targetIdx = lookup.trackIndexById.get(targetTrackId) ?? -1
    if (targetIdx < 0) {
      return { status: 'invalid' }
    }
    if (!canPlaceMultiDrag(input.tracks, multi, targetIdx, lookup)) {
      return { status: 'invalid' }
    }

    const deltaIdx = targetIdx - multi.anchorOrigTrackIdx
    const selectedClipIds = new Set(multi.items.map((item) => item.clipId))
    const moves: PlannedClipMove[] = []
    const adds = new Map<number, Clip[]>()

    for (const item of multi.items) {
      const originalClip = lookup.clipById.get(item.clipId)
      if (!originalClip) continue
      const nextIndex = Math.max(0, Math.min(input.tracks.length - 1, item.origTrackIdx + deltaIdx))
      let nextStart = Math.max(0, input.desiredStart + (item.origStartSec - multi.anchorOrigStartSec))
      if (input.gridEnabled) {
        nextStart = quantizeSecToGrid(nextStart, input.bpm, input.gridDenominator, 'round')
      }
      const trackClips = [...input.tracks[nextIndex].clips.filter((clip) => !selectedClipIds.has(clip.id)), ...(adds.get(nextIndex) ?? [])]
      const overlap = willOverlap(trackClips, originalClip.id, nextStart, originalClip.duration)
      const safeStart = input.gridEnabled
        ? calcNonOverlapStartGridAligned(trackClips, originalClip.id, nextStart, originalClip.duration, input.bpm, input.gridDenominator)
        : (overlap ? calcNonOverlapStart(trackClips, originalClip.id, nextStart, originalClip.duration) : nextStart)
      const trackId = input.tracks[nextIndex].id
      moves.push({ clipId: item.clipId, trackId, startSec: safeStart })
      const existingAdds = adds.get(nextIndex) ?? []
      existingAdds.push({ ...originalClip, startSec: safeStart })
      adds.set(nextIndex, existingAdds)
    }

    const anchorMove = moves.find((move) => move.clipId === multi.anchorClipId)
    if (!anchorMove) {
      return { status: 'invalid' }
    }

    return {
      status: 'ready',
      targetTrackId,
      moves,
      selection: {
        trackId: anchorMove.trackId,
        clipId: multi.anchorClipId,
        preserveClipIds: true,
      },
    }
  }

  const clipId = input.draggingIds.clipId
  const movingClip = lookup.clipById.get(clipId)
  const sourceTrackIndex = lookup.trackIndexById.get(input.draggingIds.trackId) ?? -1
  const targetTrackIndex = lookup.trackIndexById.get(targetTrackId) ?? -1
  if (!movingClip || sourceTrackIndex < 0 || targetTrackIndex < 0) {
    return { status: 'invalid' }
  }
  if (!canPlaceClipOnTrack(targetTrack, movingClip)) {
    return { status: 'invalid' }
  }

  const destinationClips = targetTrack.clips.filter((clip) => clip.id !== clipId)
  const overlap = willOverlap(destinationClips, sourceTrackIndex === targetTrackIndex ? clipId : null, input.desiredStart, movingClip.duration)
  const safeStart = input.gridEnabled
    ? calcNonOverlapStartGridAligned(destinationClips, sourceTrackIndex === targetTrackIndex ? clipId : null, input.desiredStart, movingClip.duration, input.bpm, input.gridDenominator)
    : (overlap ? calcNonOverlapStart(destinationClips, sourceTrackIndex === targetTrackIndex ? clipId : null, input.desiredStart, movingClip.duration) : input.desiredStart)

  return {
    status: 'ready',
    targetTrackId,
    moves: [{ clipId, trackId: targetTrackId, startSec: safeStart }],
    selection: { trackId: targetTrackId, clipId },
  }
}

export function planDuplicatedClipPlacements(input: {
  tracks: Track[]
  lookup?: TimelineTrackIndex
  draggingIds: { trackId: Track['id']; clipId: string }
  multiDragging: MultiDragSnapshot | null
  targetTrackId: Track['id']
  desiredStart: number
  gridEnabled: boolean
  bpm: number
  gridDenominator: number
}): DuplicatedClipPlacement[] | null {
  const lookup = input.lookup ?? createTimelineTrackIndex(input.tracks)
  const targetIndex = lookup.trackIndexById.get(input.targetTrackId) ?? -1
  if (targetIndex < 0) return null

  const placements: DuplicatedClipPlacement[] = []
  const pendingByTrackIndex = new Map<number, Clip[]>()
  const addPlacement = (originalClip: Clip, trackIndex: number, nextStart: number): void => {
    const existingClips = input.tracks[trackIndex].clips
    const pendingClips = pendingByTrackIndex.get(trackIndex) ?? []
    const trackClips = [...existingClips, ...pendingClips]
    const overlap = willOverlap(trackClips, null, nextStart, originalClip.duration)
    const safeStart = input.gridEnabled
      ? calcNonOverlapStartGridAligned(trackClips, null, nextStart, originalClip.duration, input.bpm, input.gridDenominator)
      : (overlap ? calcNonOverlapStart(trackClips, null, nextStart, originalClip.duration) : nextStart)
    const placedClip = { ...originalClip, startSec: safeStart }
    const nextPending = pendingByTrackIndex.get(trackIndex) ?? []
    nextPending.push(placedClip)
    pendingByTrackIndex.set(trackIndex, nextPending)
    placements.push({
      trackId: input.tracks[trackIndex].id,
      originalClip,
      startSec: safeStart,
    })
  }

  if (input.multiDragging) {
    const multi = input.multiDragging
    if (!canPlaceMultiDrag(input.tracks, multi, targetIndex, lookup)) return null
    const deltaIndex = targetIndex - multi.anchorOrigTrackIdx
    for (const item of multi.items) {
      const originalClip = findClipIn(lookup, item.clipId)
      if (!originalClip) continue
      const trackIndex = Math.max(0, Math.min(input.tracks.length - 1, item.origTrackIdx + deltaIndex))
      let nextStart = Math.max(0, input.desiredStart + (item.origStartSec - multi.anchorOrigStartSec))
      if (input.gridEnabled) {
        nextStart = quantizeSecToGrid(nextStart, input.bpm, input.gridDenominator, 'round')
      }
      addPlacement(originalClip, trackIndex, nextStart)
    }
    return placements
  }

  const originalClip = findClipIn(lookup, input.draggingIds.clipId)
  if (!originalClip) return null
  if (!canPlaceClipOnTrack(input.tracks[targetIndex], originalClip)) return null
  addPlacement(originalClip, targetIndex, input.desiredStart)
  return placements
}
