import type { Track } from '@daw-browser/timeline-core/types'
import type { SectionAutomationFragment, SectionClipFragment } from '~/lib/timeline-section-edit'

export type TimelineSectionClipboard = {
  durationSec: number
  trackIds: Track['id'][]
  clips: SectionClipFragment[]
  automation: SectionAutomationFragment[]
}

export function createTimelineSectionClipboard() {
  let value: TimelineSectionClipboard | null = null
  return {
    read: () => value,
    write: (next: TimelineSectionClipboard) => {
      value = next
    },
    clear: () => {
      value = null
    },
  }
}
