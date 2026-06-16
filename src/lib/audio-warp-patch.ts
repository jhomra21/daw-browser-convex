import { createDefaultAudioWarp, normalizeAudioWarp } from '@daw-browser/shared'
import type { AudioWarp, Clip } from '@daw-browser/timeline-core/types'

export const buildNextAudioWarp = (
  projectBpm: number,
  current: Clip['audioWarp'],
  patch: Partial<AudioWarp>,
) => normalizeAudioWarp({
  ...createDefaultAudioWarp(projectBpm),
  ...current,
  ...patch,
})
