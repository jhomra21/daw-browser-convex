import { batch, createEffect, createSignal, on, type Accessor } from 'solid-js'

import {
  appendClipToSelection,
  isTimelineSelectionEqual,
  reconcileTimelineSelection,
  selectClipGroup,
  selectMasterTarget,
  selectPrimaryClip,
  selectTrackTarget,
  type TimelineSelectionState,
} from '~/lib/timeline-selection'
import type { SelectedClip, Track } from '~/types/timeline'

export type TimelineSelectionController = {
  selectedTrackId: Accessor<Track['id'] | ''>
  selectedClip: Accessor<SelectedClip>
  selectedClipIds: Accessor<Set<string>>
  selectedFXTarget: Accessor<Track['id'] | 'master'>
  selectPrimaryClip: (input: { trackId: Track['id']; clipId: string }, options?: { preserveClipIds?: boolean }) => void
  appendClipToSelection: (input: { trackId: Track['id']; clipId: string }) => void
  selectClipGroup: (input: { trackId: Track['id']; clipIds: string[]; primaryClipId?: string }) => void
  selectTrackTarget: (trackId: Track['id'], options?: { clearClipSelection?: boolean; clearPrimaryClip?: boolean }) => void
  selectMasterTarget: () => void
  setSelectedClipIds: (value: Set<string> | ((current: Set<string>) => Set<string>)) => void
  setSelectedClip: (value: SelectedClip | ((current: SelectedClip) => SelectedClip)) => void
  setSelectedTrackId: (value: Track['id'] | '' | ((current: Track['id'] | '') => Track['id'] | '')) => void
  setSelectedFXTarget: (value: Track['id'] | 'master' | ((current: Track['id'] | 'master') => Track['id'] | 'master')) => void
}

type UseTimelineSelectionStateOptions = {
  roomId: Accessor<string>
  tracks: Accessor<Track[]>
  effectsPanel?: {
    isOpen: Accessor<boolean>
    setOpen: (value: boolean) => void
  }
}

export function useTimelineSelectionState(
  options: UseTimelineSelectionStateOptions,
): TimelineSelectionController {
  const [selectedTrackId, setSelectedTrackId] = createSignal<Track['id'] | ''>('')
  const [selectedClip, setSelectedClip] = createSignal<SelectedClip>(null)
  const [selectedClipIds, setSelectedClipIds] = createSignal<Set<string>>(new Set<string>(), { equals: false })
  const [selectedFXTarget, setSelectedFXTarget] = createSignal<Track['id'] | 'master'>('master')

  const setters = { setSelectedTrackId, setSelectedClip, setSelectedClipIds, setSelectedFXTarget }

  createEffect(on(options.roomId, () => {
    selectMasterTarget(setters)
  }))

  createEffect(() => {
    const nextTracks = options.tracks()
    const currentSelection: TimelineSelectionState = {
      selectedTrackId: selectedTrackId(),
      selectedClip: selectedClip(),
      selectedClipIds: selectedClipIds(),
      selectedFXTarget: selectedFXTarget(),
    }
    const reconciledSelection = reconcileTimelineSelection(nextTracks, currentSelection)
    const nextSelection = !reconciledSelection.selectedTrackId && nextTracks.length > 0
      ? { ...reconciledSelection, selectedTrackId: nextTracks[0].id }
      : reconciledSelection
    if (isTimelineSelectionEqual(currentSelection, nextSelection)) return
    batch(() => {
      setSelectedTrackId(nextSelection.selectedTrackId)
      setSelectedClip(nextSelection.selectedClip)
      setSelectedClipIds(nextSelection.selectedClipIds)
      setSelectedFXTarget(nextSelection.selectedFXTarget)
    })
  })

  let lastFxTargetForPanel: string | null = null
  createEffect(() => {
    const panel = options.effectsPanel
    if (!panel) return
    const fx = selectedFXTarget()
    const currentSelectedClip = selectedClip()
    const changed = fx !== lastFxTargetForPanel
    lastFxTargetForPanel = fx
    if (panel.isOpen() || !changed) return
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
    selectPrimaryClip: (input, selectOptions) => selectPrimaryClip(setters, input, selectOptions),
    appendClipToSelection: (input) => appendClipToSelection(setters, input),
    selectClipGroup: (input) => selectClipGroup(setters, input),
    selectTrackTarget: (trackId, selectOptions) => selectTrackTarget(setters, trackId, selectOptions),
    selectMasterTarget: () => selectMasterTarget(setters),
    setSelectedClipIds,
    setSelectedClip,
    setSelectedTrackId,
    setSelectedFXTarget,
  }
}
