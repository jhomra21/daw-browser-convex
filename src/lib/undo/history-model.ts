import { cloneTimelineClip, cloneTimelineTrack } from '~/lib/timeline-clone'
import type { Clip, Track, TrackRouting } from '@daw-browser/timeline-core/types'

export const cloneHistoryTracks = (tracks: Track[]) => tracks.map(cloneTimelineTrack)

export const insertTrackIntoHistoryModel = (tracks: Track[], track: Track, index: number) => {
  const existingIndex = tracks.findIndex((entry) => entry.id === track.id)
  if (existingIndex >= 0) {
    tracks.splice(existingIndex, 1)
  }
  const insertIndex = Math.max(0, Math.min(index, tracks.length))
  tracks.splice(insertIndex, 0, cloneTimelineTrack(track))
}

export const removeTrackFromHistoryModel = (tracks: Track[], trackId: Track['id']) => {
  const index = tracks.findIndex((track) => track.id === trackId)
  if (index >= 0) {
    tracks.splice(index, 1)
  }
}

export const insertClipIntoHistoryModel = (tracks: Track[], trackId: string, clip: Track['clips'][number]) => {
  const track = tracks.find((entry) => entry.id === trackId)
  if (!track) return
  const nextClip = cloneTimelineClip(clip)
  const existingIndex = track.clips.findIndex((entry) => entry.id === nextClip.id)
  if (existingIndex >= 0) {
    track.clips.splice(existingIndex, 1, nextClip)
    return
  }
  track.clips.push(nextClip)
}

export const removeClipsFromHistoryModel = (tracks: Track[], clipIds: Iterable<string>) => {
  const removedIds = new Set(clipIds)
  if (removedIds.size === 0) return
  for (const track of tracks) {
    track.clips = track.clips.filter((clip) => !removedIds.has(clip.id))
  }
}

export const commitClipMovesInHistoryModel = (
  tracks: Track[],
  moves: Array<{ clipId: string; trackId: string; startSec: number }>,
) => {
  const moveByClipId = new Map(moves.map((move) => [move.clipId, move]))
  const movedClips = new Map<string, Track['clips'][number]>()

  for (const track of tracks) {
    const remaining: Track['clips'] = []
    for (const clip of track.clips) {
      const move = moveByClipId.get(clip.id)
      if (!move) {
        remaining.push(clip)
        continue
      }
      movedClips.set(clip.id, {
        ...cloneTimelineClip(clip),
        startSec: move.startSec,
      })
    }
    track.clips = remaining
  }

  const trackById = new Map(tracks.map((track) => [track.id, track]))
  for (const move of moves) {
    const track = trackById.get(move.trackId)
    const clip = movedClips.get(move.clipId)
    if (!track || !clip) continue
    track.clips.push(clip)
  }
}

export const commitClipTimingInHistoryModel = (
  tracks: Track[],
  clipId: string,
  patch: Pick<Clip, 'startSec' | 'duration' | 'leftPadSec' | 'bufferOffsetSec' | 'audioWarp' | 'midiOffsetBeats'>,
) => {
  for (const track of tracks) {
    const clip = track.clips.find((entry) => entry.id === clipId)
    if (!clip) continue
    clip.startSec = patch.startSec
    clip.duration = patch.duration
    clip.leftPadSec = patch.leftPadSec
    clip.bufferOffsetSec = patch.bufferOffsetSec
    clip.audioWarp = patch.audioWarp
    clip.midiOffsetBeats = patch.midiOffsetBeats
    return
  }
}

export const applyTrackVolumeInHistoryModel = (tracks: Track[], trackId: string, volume: number) => {
  const track = tracks.find((entry) => entry.id === trackId)
  if (track) {
    track.volume = volume
  }
}

export const applyTrackMixStateInHistoryModel = (
  tracks: Track[],
  trackId: string,
  patch: { muted?: boolean; soloed?: boolean },
) => {
  const track = tracks.find((entry) => entry.id === trackId)
  if (!track) return
  if (typeof patch.muted === 'boolean') {
    track.muted = patch.muted
  }
  if (typeof patch.soloed === 'boolean') {
    track.soloed = patch.soloed
  }
}

export const applyTrackRoutingInHistoryModel = (tracks: Track[], trackId: string, routing: TrackRouting) => {
  const track = tracks.find((entry) => entry.id === trackId)
  if (!track) return
  track.sends = routing.sends?.map((send) => ({ ...send })) ?? []
  track.outputTargetId = routing.outputTargetId
}
