import { createEffect, createSignal, type Accessor } from 'solid-js'

import { createLatestSignal } from '~/lib/create-latest-signal'

import {
  appendClipToSelection,
  isTimelineSelectionEqual,
  reconcileTimelineSelection,
  selectClipGroup,
  selectMasterTarget,
  selectPrimaryClip,
  selectTimeRange,
  selectTrackTarget,
  type TimelineSelectionController,
  type TimelineSelectionState,
} from '~/lib/timeline-selection'
import type { SelectedClip, Track } from '@daw-browser/timeline-core/types'
import { isTimelineRangeSelectionEqual, type TimelineRangeSelection } from '~/lib/timeline-range-selection'

type UseTimelineSelectionStateOptions = {
  projectId: Accessor<string>
  tracks: Accessor<Track[]>
  effectsPanel?: {
    isOpen: Accessor<boolean>
    setOpen: (value: boolean) => void
  }
}

export function useTimelineSelectionState(
  options: UseTimelineSelectionStateOptions,
): TimelineSelectionController {
  const [selectedTrackId, setSelectedTrackId] = createLatestSignal<Track['id'] | ''>('')
  const [selectedClip, setSelectedClip] = createLatestSignal<SelectedClip>(null)
  const [selectedClipIds, setSelectedClipIds] = createSignal<Set<string>>(new Set<string>(), { equals: false })
  const [selectedFXTarget, setSelectedFXTarget] = createLatestSignal<Track['id'] | 'master'>('master')
  const [rangeSelection, setRangeSelection] = createLatestSignal<TimelineRangeSelection | null>(null)

  const setters = { setSelectedTrackId, setSelectedClip, setSelectedClipIds, setSelectedFXTarget, setRangeSelection }

  createEffect(
    options.projectId,
    () => {
      selectMasterTarget(setters)
    },
  )

  createEffect(() => {
    const currentSelection: TimelineSelectionState = {
      selectedTrackId: selectedTrackId(),
      selectedClip: selectedClip(),
      selectedClipIds: selectedClipIds(),
      selectedFXTarget: selectedFXTarget(),
      rangeSelection: rangeSelection(),
    }

    return { nextTracks: options.tracks(), currentSelection }
  }, ({ nextTracks, currentSelection }) => {
    const reconciledSelection = reconcileTimelineSelection(nextTracks, currentSelection)

    const nextSelection = !reconciledSelection.selectedTrackId && reconciledSelection.selectedFXTarget !== 'master' && nextTracks.length > 0
      ? { ...reconciledSelection, selectedTrackId: nextTracks[0].id }
      : reconciledSelection

    if (isTimelineSelectionEqual(currentSelection, nextSelection)) return
    setSelectedTrackId(nextSelection.selectedTrackId)
    setSelectedClip(nextSelection.selectedClip)
    setSelectedClipIds(nextSelection.selectedClipIds)
    setSelectedFXTarget(nextSelection.selectedFXTarget)
    setRangeSelection(nextSelection.rangeSelection)
  })

  let lastFxTargetForPanel: string | null = null
  createEffect(() => {
    const panel = options.effectsPanel

    if (!panel) return undefined

    return { panel, fx: selectedFXTarget(), currentSelectedClip: selectedClip(), isOpen: panel.isOpen() }
  }, (state) => {
    if (!state) return
    const { panel, fx, currentSelectedClip, isOpen } = state
    const changed = fx !== lastFxTargetForPanel
    lastFxTargetForPanel = fx

    if (isOpen || !changed) return

    if (!fx || fx === 'master') return

    if (!currentSelectedClip) return

    if (currentSelectedClip.trackId === fx) {
      panel.setOpen(true)
    }
  })

  return {
    selectedTrackId,
    selectedClip,
    selectedClipIds,
    selectedFXTarget,
    rangeSelection,
    selectPrimaryClip: (input, selectOptions) => selectPrimaryClip(setters, input, selectOptions),
    appendClipToSelection: (input) => appendClipToSelection(setters, input),
    selectClipGroup: (input) => selectClipGroup(setters, input),
    selectTrackTarget: (trackId, selectOptions) => selectTrackTarget(setters, trackId, selectOptions),
    selectMasterTarget: () => selectMasterTarget(setters),
    selectTimeRange: (nextSelection) => {
      if (isTimelineRangeSelectionEqual(rangeSelection(), nextSelection)) return
      selectTimeRange(setters, nextSelection)
    },
    clearTimeRange: () => setRangeSelection(null),
    setSelectedClipIds,
    setSelectedClip,
    setSelectedTrackId,
    setSelectedFXTarget,
  }
}
