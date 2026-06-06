import { isClipCompatibleWithTrack } from '@daw-browser/timeline-core/track-routing'
import { createTimelineTrackIndex, type TimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import {
  calcNonOverlapStart,
  calcNonOverlapStartGridAligned,
  quantizeSecToGrid,
  willOverlap,
} from '~/lib/timeline-utils'
import type { Track } from '@daw-browser/timeline-core/types'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'

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
  originalClip: RuntimeClip
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

export function canPlaceClipOnTrack(track: RuntimeTrack | undefined, clip: RuntimeClip | null | undefined): boolean {
  return !!track && !!clip && isClipCompatibleWithTrack(track, clip)
}

type MultiDragClipPlacement = {
  item: MultiDragSnapshot['items'][number]
  clip: RuntimeClip
  targetIndex: number
}

function resolveMultiDragClipPlacements(
  tracks: RuntimeTrack[],
  multi: MultiDragSnapshot,
  anchorTargetIdx: number,
  lookup = createTimelineTrackIndex(tracks),
): MultiDragClipPlacement[] | null {
  const deltaIdx = anchorTargetIdx - multi.anchorOrigTrackIdx
  const placements: MultiDragClipPlacement[] = []
  for (const item of multi.items) {
    const clip = lookup.clipById.get(item.clipId)
    if (!clip) return null
    const targetIndex = Math.max(0, Math.min(tracks.length - 1, item.origTrackIdx + deltaIdx))
    if (!canPlaceClipOnTrack(tracks[targetIndex], clip)) return null
    placements.push({ item, clip, targetIndex })
  }
  return placements
}

export function resolveNonDupTargetTrackId(
  tracks: RuntimeTrack[],
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
  tracks: RuntimeTrack[]
  lookup?: TimelineTrackIndex<AudioBuffer>
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
    const clipPlacements = resolveMultiDragClipPlacements(input.tracks, multi, targetIdx, lookup)
    if (!clipPlacements) {
      return { status: 'invalid' }
    }

    const selectedClipIds = new Set(multi.items.map((item) => item.clipId))
    const moves: PlannedClipMove[] = []
    const adds = new Map<number, RuntimeClip[]>()

    for (const { item, clip, targetIndex } of clipPlacements) {
      let nextStart = Math.max(0, input.desiredStart + (item.origStartSec - multi.anchorOrigStartSec))
      if (input.gridEnabled) {
        nextStart = quantizeSecToGrid(nextStart, input.bpm, input.gridDenominator, 'round')
      }
      const trackClips = [...input.tracks[targetIndex].clips.filter((trackClip) => !selectedClipIds.has(trackClip.id)), ...(adds.get(targetIndex) ?? [])]
      const overlap = willOverlap(trackClips, clip.id, nextStart, clip.duration)
      const safeStart = input.gridEnabled
        ? calcNonOverlapStartGridAligned(trackClips, clip.id, nextStart, clip.duration, input.bpm, input.gridDenominator)
        : (overlap ? calcNonOverlapStart(trackClips, clip.id, nextStart, clip.duration) : nextStart)
      const trackId = input.tracks[targetIndex].id
      moves.push({ clipId: item.clipId, trackId, startSec: safeStart })
      const existingAdds = adds.get(targetIndex) ?? []
      existingAdds.push({ ...clip, startSec: safeStart })
      adds.set(targetIndex, existingAdds)
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
  tracks: RuntimeTrack[]
  lookup?: TimelineTrackIndex<AudioBuffer>
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
  const pendingByTrackIndex = new Map<number, RuntimeClip[]>()
  const addPlacement = (originalClip: RuntimeClip, trackIndex: number, nextStart: number): void => {
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
    const clipPlacements = resolveMultiDragClipPlacements(input.tracks, multi, targetIndex, lookup)
    if (!clipPlacements) return null
    for (const { item, clip, targetIndex: trackIndex } of clipPlacements) {
      let nextStart = Math.max(0, input.desiredStart + (item.origStartSec - multi.anchorOrigStartSec))
      if (input.gridEnabled) {
        nextStart = quantizeSecToGrid(nextStart, input.bpm, input.gridDenominator, 'round')
      }
      addPlacement(clip, trackIndex, nextStart)
    }
    return placements
  }

  const originalClip = lookup.clipById.get(input.draggingIds.clipId)
  if (!originalClip) return null
  if (!canPlaceClipOnTrack(input.tracks[targetIndex], originalClip)) return null
  addPlacement(originalClip, targetIndex, input.desiredStart)
  return placements
}
