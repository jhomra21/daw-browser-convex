import { batch, type Setter } from 'solid-js'

import type { SelectedClip, Track } from '@daw-browser/timeline-core/types'
import { isTimelineRangeSelectionEqual, type TimelineRangeSelection } from '~/lib/timeline-range-selection'

type TimelineSelectionSetters = {
  setSelectedTrackId: Setter<Track['id'] | ''>
  setSelectedClip: Setter<SelectedClip>
  setSelectedClipIds: Setter<Set<string>>
  setSelectedFXTarget: Setter<Track['id'] | 'master'>
  setRangeSelection: Setter<TimelineRangeSelection | null>
}

export type TimelineSelectionState = {
  selectedTrackId: Track['id'] | ''
  selectedClip: SelectedClip
  selectedClipIds: Set<string>
  selectedFXTarget: Track['id'] | 'master'
  rangeSelection: TimelineRangeSelection | null
}

const findFirstSelectedClip = (tracks: Track[], selectedClipIds: Set<string>): SelectedClip => {
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (selectedClipIds.has(clip.id)) {
        return { trackId: track.id, clipId: clip.id }
      }
    }
  }
  return null
}

const setsEqual = (left: Set<string>, right: Set<string>) => {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

export function isTimelineSelectionEqual(
  left: TimelineSelectionState,
  right: TimelineSelectionState,
) {
  return (
    left.selectedTrackId === right.selectedTrackId
    && left.selectedFXTarget === right.selectedFXTarget
    && left.selectedClip?.trackId === right.selectedClip?.trackId
    && left.selectedClip?.clipId === right.selectedClip?.clipId
    && isTimelineRangeSelectionEqual(left.rangeSelection, right.rangeSelection)
    && setsEqual(left.selectedClipIds, right.selectedClipIds)
  )
}

export function reconcileTimelineSelection(
  tracks: Track[],
  selection: TimelineSelectionState,
): TimelineSelectionState {
  const trackIds = new Set(tracks.map((track) => track.id))
  const clipTrackIds = new Map<string, Track['id']>()
  for (const track of tracks) {
    for (const clip of track.clips) {
      clipTrackIds.set(clip.id, track.id)
    }
  }

  const nextSelectedClipIds = new Set(
    Array.from(selection.selectedClipIds).filter((clipId) => clipTrackIds.has(clipId)),
  )

  const currentSelectedClip = selection.selectedClip
  const currentSelectedClipTrackId = currentSelectedClip
    ? clipTrackIds.get(currentSelectedClip.clipId)
    : undefined
  const nextSelectedClip = currentSelectedClip && currentSelectedClipTrackId === currentSelectedClip.trackId
    ? currentSelectedClip
    : findFirstSelectedClip(tracks, nextSelectedClipIds)

  if (nextSelectedClip) {
    nextSelectedClipIds.add(nextSelectedClip.clipId)
  }

  const nextSelectedTrackId = nextSelectedClip?.trackId
    ?? (selection.selectedTrackId && trackIds.has(selection.selectedTrackId) ? selection.selectedTrackId : '')
  const nextSelectedFXTarget = selection.selectedFXTarget === 'master'
    ? 'master'
    : trackIds.has(selection.selectedFXTarget)
      ? selection.selectedFXTarget
      : nextSelectedTrackId || 'master'
  const nextRangeTrackIds = selection.rangeSelection?.trackIds.filter((trackId) => trackIds.has(trackId)) ?? []
  const nextRangeSelection = selection.rangeSelection && nextRangeTrackIds.length > 0
    ? {
        ...selection.rangeSelection,
        trackIds: nextRangeTrackIds,
        primaryTrackId: selection.rangeSelection.primaryTrackId && trackIds.has(selection.rangeSelection.primaryTrackId)
          ? selection.rangeSelection.primaryTrackId
          : nextRangeTrackIds[0] ?? null,
      }
    : null

  return {
    selectedTrackId: nextSelectedTrackId,
    selectedClip: nextSelectedClip,
    selectedClipIds: nextSelectedClipIds,
    selectedFXTarget: nextSelectedFXTarget,
    rangeSelection: nextRangeSelection,
  }
}

export function selectPrimaryClip(
  setters: TimelineSelectionSetters,
  input: { trackId: Track['id']; clipId: string },
  options?: { preserveClipIds?: boolean },
) {
  batch(() => {
    setters.setSelectedTrackId(input.trackId)
    setters.setSelectedClip(input)
    setters.setRangeSelection(null)
    if (!options?.preserveClipIds) {
      setters.setSelectedClipIds(new Set([input.clipId]))
    }
    setters.setSelectedFXTarget(input.trackId)
  })
}

export function appendClipToSelection(
  setters: TimelineSelectionSetters,
  input: { trackId: Track['id']; clipId: string },
) {
  batch(() => {
    setters.setSelectedTrackId(input.trackId)
    setters.setSelectedClip(input)
    setters.setRangeSelection(null)
    setters.setSelectedClipIds((prev) => {
      const next = new Set(prev)
      next.add(input.clipId)
      return next
    })
    setters.setSelectedFXTarget(input.trackId)
  })
}

export function selectClipGroup(
  setters: TimelineSelectionSetters,
  input: { trackId: Track['id']; clipIds: string[]; primaryClipId?: string },
) {
  const primaryClipId = input.primaryClipId ?? input.clipIds[input.clipIds.length - 1]
  batch(() => {
    setters.setSelectedTrackId(input.trackId)
    setters.setSelectedClip(primaryClipId ? { trackId: input.trackId, clipId: primaryClipId } : null)
    setters.setRangeSelection(null)
    setters.setSelectedClipIds(new Set(input.clipIds))
    setters.setSelectedFXTarget(input.trackId)
  })
}

export function selectTrackTarget(
  setters: TimelineSelectionSetters,
  trackId: Track['id'],
  options?: { clearClipSelection?: boolean; clearPrimaryClip?: boolean },
) {
  batch(() => {
    setters.setSelectedTrackId(trackId)
    setters.setSelectedFXTarget(trackId)
    setters.setRangeSelection(null)
    if (options?.clearClipSelection) {
      setters.setSelectedClip(null)
      setters.setSelectedClipIds(new Set<string>())
      return
    }
    if (options?.clearPrimaryClip) {
      setters.setSelectedClip(null)
    }
  })
}

export function selectMasterTarget(setters: TimelineSelectionSetters) {
  batch(() => {
    setters.setSelectedTrackId('')
    setters.setSelectedFXTarget('master')
    setters.setSelectedClip(null)
    setters.setSelectedClipIds(new Set<string>())
    setters.setRangeSelection(null)
  })
}

export function selectTimeRange(
  setters: TimelineSelectionSetters,
  selection: TimelineRangeSelection,
) {
  batch(() => {
    setters.setRangeSelection(selection)
    setters.setSelectedClip(null)
    setters.setSelectedClipIds(new Set<string>())
    setters.setSelectedTrackId(selection.primaryTrackId ?? selection.trackIds[0] ?? '')
    setters.setSelectedFXTarget(selection.primaryTrackId ?? selection.trackIds[0] ?? 'master')
  })
}
