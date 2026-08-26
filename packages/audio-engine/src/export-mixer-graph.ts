import type { Track } from '@daw-browser/timeline-core/types'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import type { ResolvedMixerGraph } from './mixer/types'
import type { ExportFx } from './export-types'

export const resolveExportMixerGraph = (input: {
  tracks: Track<AudioBuffer>[]
  fx?: ExportFx
}): ResolvedMixerGraph => {
  const { tracks, fx } = input
  return resolveMixerGraph({
    channels: createMixerChannels(tracks),
    sourceChannelCounts: Object.fromEntries(tracks.map((track) => [
      track.id,
      track.clips.flatMap((clip) => clip.buffer ? [clip.buffer.numberOfChannels] : []),
    ])),
    masterVolume: fx?.masterVolume,
    masterFxInstances: fx?.masterFxInstances ?? [],
    trackFx: fx?.trackFx,
  })
}
