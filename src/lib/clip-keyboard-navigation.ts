import type { Track } from '@daw-browser/timeline-core/types'

import { resolveClipNavigationTarget } from '~/lib/timeline-keyboard-navigation'
import type { TimelineSelectionController } from '~/lib/timeline-selection'

// Alt+arrow clip navigation: selects the target clip like a click and moves focus to it.
// A clip outside the render window has no element yet, so the viewport is scrolled to it instead.
export const createClipNavigator = (input: {
  tracks: () => readonly Track[]
  selection: Pick<TimelineSelectionController, 'selectedClip' | 'selectPrimaryClip'>
  revealTime: (startSec: number) => void
}) => (axis: 'time' | 'track', direction: -1 | 1) => {
  const anchor = input.selection.selectedClip()

  if (!anchor) return false
  const tracks = input.tracks()
  const target = resolveClipNavigationTarget(tracks, anchor.clipId, axis, direction)

  if (!target) return true
  input.selection.selectPrimaryClip(target)
  const element = document.querySelector(`[data-timeline-clip-id="${CSS.escape(target.clipId)}"]`)

  if (element instanceof HTMLElement) {
    element.focus()

    return true
  }

  const clip = tracks.find((track) => track.id === target.trackId)?.clips.find((candidate) => candidate.id === target.clipId)

  if (clip) input.revealTime(clip.startSec)

  return true
}
