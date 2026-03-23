import { batch, type Setter } from 'solid-js'

import type { SelectedClip } from '~/types/timeline'

export type TimelineSelectionSetters = {
  setSelectedTrackId: Setter<string>
  setSelectedClip: Setter<SelectedClip>
  setSelectedClipIds: Setter<Set<string>>
  setSelectedFXTarget: Setter<string>
}

export function selectPrimaryClip(
  setters: TimelineSelectionSetters,
  input: { trackId: string; clipId: string },
  options?: { preserveClipIds?: boolean },
) {
  batch(() => {
    setters.setSelectedTrackId(input.trackId)
    setters.setSelectedClip(input)
    if (!options?.preserveClipIds) {
      setters.setSelectedClipIds(new Set([input.clipId]))
    }
    setters.setSelectedFXTarget(input.trackId)
  })
}

export function appendClipToSelection(
  setters: TimelineSelectionSetters,
  input: { trackId: string; clipId: string },
) {
  batch(() => {
    setters.setSelectedTrackId(input.trackId)
    setters.setSelectedClip(input)
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
  input: { trackId: string; clipIds: string[]; primaryClipId?: string },
) {
  const primaryClipId = input.primaryClipId ?? input.clipIds[input.clipIds.length - 1]
  batch(() => {
    setters.setSelectedTrackId(input.trackId)
    setters.setSelectedClip(primaryClipId ? { trackId: input.trackId, clipId: primaryClipId } : null)
    setters.setSelectedClipIds(new Set(input.clipIds))
    setters.setSelectedFXTarget(input.trackId)
  })
}

export function selectTrackTarget(
  setters: TimelineSelectionSetters,
  trackId: string,
  options?: { clearClipSelection?: boolean; clearPrimaryClip?: boolean },
) {
  batch(() => {
    setters.setSelectedTrackId(trackId)
    setters.setSelectedFXTarget(trackId)
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
  })
}
