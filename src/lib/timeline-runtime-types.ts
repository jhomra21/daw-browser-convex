import type { Clip, Track } from '@daw-browser/timeline-core/types'

export type RuntimeClip = Clip<AudioBuffer | null>
export type RuntimeTrack = Track<AudioBuffer | null>
