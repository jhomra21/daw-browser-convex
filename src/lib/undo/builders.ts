import { buildClipHistorySnapshot } from '~/lib/clip-create'
import type { Track, TrackRouting } from '~/types/timeline'

import { buildTrackRoutingHistorySnapshot, getClipHistoryRef, getTrackHistoryRef } from './refs'
import type { HistoryEntry, HistoryScope } from './types'

export function buildTrackCreateHistoryEntry(input: {
  roomId: string
  trackId: string
  index: number
  kind?: 'audio' | 'instrument'
  channelRole?: Track['channelRole']
}): Extract<HistoryEntry, { type: 'track-create' }> {
  return {
    type: 'track-create',
    roomId: input.roomId,
    data: {
      trackRef: input.trackId,
      currentTrackId: input.trackId,
      index: input.index,
      kind: input.kind,
      channelRole: input.channelRole,
    },
  }
}

export function buildTrackDeleteHistoryEntry(input: {
  roomId: string
  track: Track
  tracks: Track[]
  effects?: { eq?: any; reverb?: any; synth?: any; arp?: any }
}): Extract<HistoryEntry, { type: 'track-delete' }> {
  const { roomId, track, tracks, effects } = input
  const trackRef = getTrackHistoryRef(track)
  const trackIndex = tracks.findIndex((entry) => entry.id === track.id)
  const inboundRouting = tracks
    .filter((entry) => entry.id !== track.id)
    .flatMap((entry) => {
      const sends = (entry.sends ?? []).filter((send) => send.targetId === track.id)
      const outputTargetId = entry.outputTargetId === track.id ? track.id : undefined
      if (sends.length === 0 && !outputTargetId) return []
      return [{
        sourceTrackRef: getTrackHistoryRef(entry),
        ...buildTrackRoutingHistorySnapshot({ sends, outputTargetId }, tracks),
      }]
    })

  return {
    type: 'track-delete',
    roomId,
    data: {
      track: {
        trackRef,
        index: trackIndex,
        name: track.name,
        volume: track.volume,
        muted: track.muted,
        soloed: track.soloed,
        kind: track.kind,
        channelRole: track.channelRole,
        routing: buildTrackRoutingHistorySnapshot(track, tracks),
      },
      clips: track.clips.map((clip) => buildClipHistorySnapshot(clip)),
      effects,
      inboundRouting,
    },
  }
}

export function buildTrackVolumeHistoryEntry(input: {
  roomId: string
  track: Track
  scope: HistoryScope
  from: number
  to: number
}): Extract<HistoryEntry, { type: 'track-volume' }> {
  return {
    type: 'track-volume',
    roomId: input.roomId,
    data: {
      trackRef: getTrackHistoryRef(input.track),
      scope: input.scope,
      from: input.from,
      to: input.to,
    },
  }
}

export function buildTrackBooleanHistoryEntry(input: {
  type: 'track-mute' | 'track-solo'
  roomId: string
  track: Track
  scope: HistoryScope
  from: boolean
  to: boolean
}): Extract<HistoryEntry, { type: 'track-mute' | 'track-solo' }> {
  return {
    type: input.type,
    roomId: input.roomId,
    data: {
      trackRef: getTrackHistoryRef(input.track),
      scope: input.scope,
      from: input.from,
      to: input.to,
    },
  }
}

export function buildTrackRoutingHistoryEntry(input: {
  roomId: string
  track: Track
  tracks: Track[]
  from: TrackRouting
  to: TrackRouting
}): Extract<HistoryEntry, { type: 'track-routing' }> {
  return {
    type: 'track-routing',
    roomId: input.roomId,
    data: {
      trackRef: getTrackHistoryRef(input.track),
      from: buildTrackRoutingHistorySnapshot(input.from, input.tracks),
      to: buildTrackRoutingHistorySnapshot(input.to, input.tracks),
    },
  }
}

export function buildEffectParamsHistoryEntry(input: {
  roomId: string
  effect: Extract<HistoryEntry, { type: 'effect-params' }>['data']['effect']
  targetId: string
  tracks: Track[]
  from: unknown
  to: unknown
}): Extract<HistoryEntry, { type: 'effect-params' }> {
  const track = input.tracks.find((entry) => entry.id === input.targetId)
  return {
    type: 'effect-params',
    roomId: input.roomId,
    data: {
      effect: input.effect,
      trackRef: track ? getTrackHistoryRef(track) : undefined,
      from: input.from,
      to: input.to,
    },
  }
}

export function buildClipDeleteHistoryEntry(input: {
  roomId: string
  tracks: Track[]
  clipIds: Iterable<string>
}): Extract<HistoryEntry, { type: 'clip-delete' }> {
  const selectedIds = new Set(input.clipIds)
  return {
    type: 'clip-delete',
    roomId: input.roomId,
    data: {
      items: input.tracks.flatMap((track) => track.clips
        .filter((clip) => selectedIds.has(clip.id))
        .map((clip) => ({
          trackRef: getTrackHistoryRef(track),
          clip: buildClipHistorySnapshot(clip),
        }))),
    },
  }
}

export function buildClipsMoveHistoryEntry(input: {
  roomId: string
  tracks: Track[]
  moves: Array<{
    clipId: string
    from: { trackId: string; startSec: number }
    to: { trackId: string; startSec: number }
  }>
}): Extract<HistoryEntry, { type: 'clips-move' }> {
  const trackById = new Map(input.tracks.map((track) => [track.id, track]))
  const clipById = new Map(input.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)))
  return {
    type: 'clips-move',
    roomId: input.roomId,
    data: {
      moves: input.moves.map((move) => ({
        clipRef: getClipHistoryRef(clipById.get(move.clipId)),
        from: {
          trackRef: getTrackHistoryRef(trackById.get(move.from.trackId)),
          startSec: move.from.startSec,
        },
        to: {
          trackRef: getTrackHistoryRef(trackById.get(move.to.trackId)),
          startSec: move.to.startSec,
        },
      })),
    },
  }
}

export function buildClipTimingHistoryEntry(input: {
  roomId: string
  clip: Track['clips'][number]
  from: Extract<HistoryEntry, { type: 'clip-timing' }>['data']['from']
  to: Extract<HistoryEntry, { type: 'clip-timing' }>['data']['to']
}): Extract<HistoryEntry, { type: 'clip-timing' }> {
  return {
    type: 'clip-timing',
    roomId: input.roomId,
    data: {
      clipRef: getClipHistoryRef(input.clip),
      from: input.from,
      to: input.to,
    },
  }
}
