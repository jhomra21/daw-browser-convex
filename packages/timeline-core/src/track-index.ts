import type { Clip, Track, TrackId } from './types'

export type TimelineClipEntry<TBuffer = never> = {
  trackId: TrackId
  trackIndex: number
  track: Track<TBuffer>
  clip: Clip<TBuffer>
}

export type TimelineTrackIndex<TBuffer = never> = {
  trackById: Map<TrackId, Track<TBuffer>>
  trackIndexById: Map<TrackId, number>
  clipById: Map<string, Clip<TBuffer>>
  clipTrackIdById: Map<string, TrackId>
  clipEntryById: Map<string, TimelineClipEntry<TBuffer>>
  clipIdsByTrackId: Map<TrackId, string[]>
}

export function createTimelineTrackIndex<TBuffer = never>(tracks: Track<TBuffer>[]): TimelineTrackIndex<TBuffer> {
  const trackById = new Map<TrackId, Track<TBuffer>>()
  const trackIndexById = new Map<TrackId, number>()
  const clipById = new Map<string, Clip<TBuffer>>()
  const clipTrackIdById = new Map<string, TrackId>()
  const clipEntryById = new Map<string, TimelineClipEntry<TBuffer>>()
  const clipIdsByTrackId = new Map<TrackId, string[]>()

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
