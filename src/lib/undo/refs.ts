import type { Clip, Track, TrackRouting } from '~/types/timeline'

import type { ClipRef, HistoryEntry, TrackRef, TrackRoutingHistorySnapshot } from './types'

type HistoryRefIndex = {
  trackIdByRef: Map<TrackRef, Track['id']>
  clipIdByRef: Map<ClipRef, string>
}

export function getTrackHistoryRef(track: Pick<Track, 'id' | 'historyRef'> | null | undefined): TrackRef {
  if (!track) return ''
  return String(track.historyRef ?? track.id)
}

export function getClipHistoryRef(clip: Pick<Clip, 'id' | 'historyRef'> | null | undefined): ClipRef {
  if (!clip) return ''
  return String(clip.historyRef ?? clip.id)
}

export function buildTrackRoutingHistorySnapshot(routing: TrackRouting | undefined, tracks: Track[]): TrackRoutingHistorySnapshot {
  const trackRefById = new Map(tracks.map((track) => [track.id, getTrackHistoryRef(track)]))
  return {
    sends: (routing?.sends ?? [])
      .map((send) => ({
        targetTrackRef: trackRefById.get(send.targetId) ?? send.targetId,
        amount: send.amount,
      }))
      .filter((send) => send.targetTrackRef),
    outputTargetRef: routing?.outputTargetId ? (trackRefById.get(routing.outputTargetId) ?? routing.outputTargetId) : undefined,
  }
}

export function resolveTrackRoutingSnapshot(index: HistoryRefIndex, snapshot: TrackRoutingHistorySnapshot): TrackRouting {
  const hasTargetId = (send: { targetId?: Track['id']; amount: number }): send is { targetId: Track['id']; amount: number } => {
    return send.targetId !== undefined
  }

  return {
    sends: (snapshot.sends ?? [])
      .map((send) => ({
        targetId: index.trackIdByRef.get(send.targetTrackRef),
        amount: send.amount,
      }))
      .filter(hasTargetId),
    outputTargetId: snapshot.outputTargetRef ? index.trackIdByRef.get(snapshot.outputTargetRef) : undefined,
  }
}

export function resolveTrackId(index: HistoryRefIndex, trackRef: TrackRef | undefined): Track['id'] | undefined {
  if (!trackRef) return undefined
  return index.trackIdByRef.get(trackRef)
}

export function resolveStoredTrackId(tracks: Track[], trackId: string | undefined): Track['id'] | undefined {
  if (!trackId) return undefined
  return tracks.find((track) => track.id === trackId)?.id
}

function resolveStoredClipId(tracks: Track[], clipId: string | undefined): string | undefined {
  if (!clipId) return undefined
  for (const track of tracks) {
    const currentClipId = track.clips.find((clip) => clip.id === clipId)?.id
    if (currentClipId) return currentClipId
  }
  return undefined
}

export function resolveClipId(index: HistoryRefIndex, clipRef: ClipRef | undefined): string | undefined {
  if (!clipRef) return undefined
  return index.clipIdByRef.get(clipRef)
}

export function buildHistoryRefIndex(entries: HistoryEntry[] | undefined, tracks: Track[] = []): HistoryRefIndex {
  const trackIdByRef = new Map<TrackRef, Track['id']>()
  const clipIdByRef = new Map<ClipRef, string>()

  for (const track of tracks) {
    trackIdByRef.set(getTrackHistoryRef(track), track.id)
    for (const clip of track.clips) {
      clipIdByRef.set(getClipHistoryRef(clip), clip.id)
    }
  }

  for (const entry of entries ?? []) {
    switch (entry.type) {
      case 'track-create':
        {
          const trackId = resolveStoredTrackId(tracks, entry.data.currentTrackId)
          if (trackId) trackIdByRef.set(entry.data.trackRef, trackId)
        }
        break
      case 'track-delete':
        {
          const recreatedTrackId = resolveStoredTrackId(tracks, entry.data.recreatedTrackId)
          if (entry.data.track.trackRef && recreatedTrackId) {
            trackIdByRef.set(entry.data.track.trackRef, recreatedTrackId)
          }
        }
        for (const recreated of entry.data.recreatedClips ?? []) {
          const clipId = resolveStoredClipId(tracks, recreated.clipId)
          if (clipId) clipIdByRef.set(recreated.clipRef, clipId)
        }
        break
      case 'clip-create':
        {
          const clipId = resolveStoredClipId(tracks, entry.data.clip.currentId)
          if (clipId) {
            clipIdByRef.set(entry.data.clip.clipRef, clipId)
          }
        }
        break
      case 'clip-delete':
        for (const recreated of entry.data.recreatedClips ?? []) {
          const clipId = resolveStoredClipId(tracks, recreated.clipId)
          if (clipId) clipIdByRef.set(recreated.clipRef, clipId)
        }
        break
    }
  }

  return { trackIdByRef, clipIdByRef }
}
