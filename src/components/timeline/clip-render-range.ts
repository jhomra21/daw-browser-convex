import type { Track } from '@daw-browser/timeline-core/types'

export const isClipWithinRenderRange = (
  clip: Pick<Track['clips'][number], 'startSec' | 'duration'>,
  range: { startSec: number; endSec: number },
) => (
  clip.startSec < range.endSec
  && clip.startSec + clip.duration > range.startSec
)
