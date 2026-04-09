import type { Clip, Track } from '~/types/timeline'

export type TimelineClipEntry = {
  trackId: Track['id']
  trackIndex: number
  track: Track
  clip: Clip
}

export type TimelineTrackIndex = {
  trackById: Map<Track['id'], Track>
  trackIndexById: Map<Track['id'], number>
  clipById: Map<string, Clip>
  clipTrackIdById: Map<string, Track['id']>
  clipEntryById: Map<string, TimelineClipEntry>
  clipIdsByTrackId: Map<Track['id'], string[]>
}

export function createTimelineTrackIndex(tracks: Track[]): TimelineTrackIndex {
  const trackById = new Map<Track['id'], Track>()
  const trackIndexById = new Map<Track['id'], number>()
  const clipById = new Map<string, Clip>()
  const clipTrackIdById = new Map<string, Track['id']>()
  const clipEntryById = new Map<string, TimelineClipEntry>()
  const clipIdsByTrackId = new Map<Track['id'], string[]>()

  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex]
    trackById.set(track.id, track)
    trackIndexById.set(track.id, trackIndex)

    const clipIds: string[] = []
    for (const clip of track.clips) {
      clipById.set(clip.id, clip)
      clipTrackIdById.set(clip.id, track.id)
      clipEntryById.set(clip.id, { trackId: track.id, trackIndex, track, clip })
      clipIds.push(clip.id)
    }
    clipIdsByTrackId.set(track.id, clipIds)
  }

  return {
    trackById,
    trackIndexById,
    clipById,
    clipTrackIdById,
    clipEntryById,
    clipIdsByTrackId,
  }
}
