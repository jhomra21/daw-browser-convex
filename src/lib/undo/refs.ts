import type { Clip, Track, TrackRouting } from '~/types/timeline'

import type { ClipRef, HistoryEntry, TrackRef, TrackRoutingHistorySnapshot } from './types'

export type HistoryRefIndex = {
  trackIdByRef: Map<TrackRef, string>
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
  return {
    sends: (snapshot.sends ?? [])
      .map((send) => ({
        targetId: index.trackIdByRef.get(send.targetTrackRef) ?? send.targetTrackRef,
        amount: send.amount,
      }))
      .filter((send) => Boolean(send.targetId)),
    outputTargetId: snapshot.outputTargetRef ? (index.trackIdByRef.get(snapshot.outputTargetRef) ?? snapshot.outputTargetRef) : undefined,
  }
}

export function resolveTrackId(index: HistoryRefIndex, trackRef: TrackRef | undefined): string | undefined {
  if (!trackRef) return undefined
  return index.trackIdByRef.get(trackRef)
}

export function resolveClipId(index: HistoryRefIndex, clipRef: ClipRef | undefined): string | undefined {
  if (!clipRef) return undefined
  return index.clipIdByRef.get(clipRef)
}

export function buildHistoryRefIndex(entries: HistoryEntry[] | undefined, tracks: Track[] = []): HistoryRefIndex {
  const trackIdByRef = new Map<TrackRef, string>()
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
        if (entry.data.currentTrackId) trackIdByRef.set(entry.data.trackRef, entry.data.currentTrackId)
        break
      case 'track-delete':
        if (entry.data.track.trackRef && entry.data.recreatedTrackId) {
          trackIdByRef.set(entry.data.track.trackRef, entry.data.recreatedTrackId)
        }
        for (const recreated of entry.data.recreatedClips ?? []) {
          clipIdByRef.set(recreated.clipRef, recreated.clipId)
        }
        break
      case 'clip-create':
        if (entry.data.clip.currentId) {
          clipIdByRef.set(entry.data.clip.clipRef, entry.data.clip.currentId)
        }
        break
      case 'clip-delete':
        for (const recreated of entry.data.recreatedClips ?? []) {
          clipIdByRef.set(recreated.clipRef, recreated.clipId)
        }
        break
    }
  }

  return { trackIdByRef, clipIdByRef }
}
