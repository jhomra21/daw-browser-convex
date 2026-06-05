import { buildClipHistorySnapshot, type ClipCreateSnapshot } from '~/lib/clip-create'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { Track, TrackRouting } from '@daw-browser/timeline-core/types'

import { buildTrackRoutingHistorySnapshot, getClipHistoryRef, getTrackHistoryRef } from './refs'
import type {
  EffectParamsCommitPayload,
  EffectParamsHistoryEntry,
  HistoryEntry,
  HistoryScope,
  TrackEffectSnapshot,
} from './types'

export function buildTrackCreateHistoryEntry(input: {
  projectId: string
  trackId: Track['id']
  index: number
  kind?: 'audio' | 'instrument'
  channelRole?: Track['channelRole']
}): Extract<HistoryEntry, { type: 'track-create' }> {
  return {
    type: 'track-create',
    projectId: input.projectId,
    data: {
      trackRef: input.trackId,
      currentTrackId: input.trackId,
      index: input.index,
      kind: input.kind,
      channelRole: input.channelRole,
    },
  }
}

export function buildTrackClipCreateHistoryEntry(input: {
  projectId: string
  track: Track
  tracks: Track[]
  clipId: string
  clip: ClipCreateSnapshot
}): Extract<HistoryEntry, { type: 'track-clip-create' }> {
  const trackRef = getTrackHistoryRef(input.track)
  return {
    type: 'track-clip-create',
    projectId: input.projectId,
    data: {
      track: {
        trackRef,
        currentTrackId: input.track.id,
        index: input.tracks.findIndex((entry) => entry.id === input.track.id),
        kind: input.track.kind,
        channelRole: input.track.channelRole,
      },
      clip: {
        trackRef,
        clipRef: input.clipId,
        currentId: input.clipId,
        ...input.clip,
      },
    },
  }
}

export function buildTrackDeleteHistoryEntry(input: {
  projectId: string
  track: Track
  tracks: Track[]
  effects?: TrackEffectSnapshot
}): Extract<HistoryEntry, { type: 'track-delete' }> {
  const { projectId, track, tracks, effects } = input
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
    projectId,
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
  projectId: string
  track: Track
  scope: HistoryScope
  from: number
  to: number
}): Extract<HistoryEntry, { type: 'track-volume' }> {
  return {
    type: 'track-volume',
    projectId: input.projectId,
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
  projectId: string
  track: Track
  scope: HistoryScope
  from: boolean
  to: boolean
}): Extract<HistoryEntry, { type: 'track-mute' | 'track-solo' }> {
  return {
    type: input.type,
    projectId: input.projectId,
    data: {
      trackRef: getTrackHistoryRef(input.track),
      scope: input.scope,
      from: input.from,
      to: input.to,
    },
  }
}

export function buildTrackRoutingHistoryEntry(input: {
  projectId: string
  track: Track
  tracks: Track[]
  from: TrackRouting
  to: TrackRouting
}): Extract<HistoryEntry, { type: 'track-routing' }> {
  return {
    type: 'track-routing',
    projectId: input.projectId,
    data: {
      trackRef: getTrackHistoryRef(input.track),
      from: buildTrackRoutingHistorySnapshot(input.from, input.tracks),
      to: buildTrackRoutingHistorySnapshot(input.to, input.tracks),
    },
  }
}

type EffectParamsHistoryEntryInput = {
  projectId: string
  tracks: Track[]
  payload: EffectParamsCommitPayload
}

export function buildEffectParamsHistoryEntry(input: EffectParamsHistoryEntryInput): EffectParamsHistoryEntry {
  const track = input.tracks.find((entry) => entry.id === input.payload.targetId)
  const trackRef = track ? getTrackHistoryRef(track) : undefined
  switch (input.payload.effect) {
    case 'eq':
      return {
        type: 'effect-params',
        projectId: input.projectId,
        data: {
          effect: input.payload.effect,
          trackRef,
          from: input.payload.from,
          to: input.payload.to,
        },
      }
    case 'reverb':
      return {
        type: 'effect-params',
        projectId: input.projectId,
        data: {
          effect: input.payload.effect,
          trackRef,
          from: input.payload.from,
          to: input.payload.to,
        },
      }
    case 'synth':
      return {
        type: 'effect-params',
        projectId: input.projectId,
        data: {
          effect: input.payload.effect,
          trackRef,
          from: input.payload.from,
          to: input.payload.to,
        },
      }
    case 'arp':
      return {
        type: 'effect-params',
        projectId: input.projectId,
        data: {
          effect: input.payload.effect,
          trackRef,
          from: input.payload.from,
          to: input.payload.to,
        },
      }
    case 'master-eq':
      return {
        type: 'effect-params',
        projectId: input.projectId,
        data: {
          effect: input.payload.effect,
          trackRef,
          from: input.payload.from,
          to: input.payload.to,
        },
      }
    case 'master-reverb':
      return {
        type: 'effect-params',
        projectId: input.projectId,
        data: {
          effect: input.payload.effect,
          trackRef,
          from: input.payload.from,
          to: input.payload.to,
        },
      }
  }
}

export function buildClipDeleteHistoryEntry(input: {
  projectId: string
  tracks: Track[]
  clipIds: Iterable<string>
}): Extract<HistoryEntry, { type: 'clip-delete' }> {
  const selectedIds = new Set(input.clipIds)
  return {
    type: 'clip-delete',
    projectId: input.projectId,
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
  projectId: string
  tracks: Track[]
  moves: Array<{
    clipId: string
    from: { trackId: Track['id']; startSec: number }
    to: { trackId: Track['id']; startSec: number }
  }>
}): Extract<HistoryEntry, { type: 'clips-move' }> {
  const trackIndex = createTimelineTrackIndex(input.tracks)
  return {
    type: 'clips-move',
    projectId: input.projectId,
    data: {
      moves: input.moves.map((move) => ({
        clipRef: getClipHistoryRef(trackIndex.clipById.get(move.clipId)),
        from: {
          trackRef: getTrackHistoryRef(trackIndex.trackById.get(move.from.trackId)),
          startSec: move.from.startSec,
        },
        to: {
          trackRef: getTrackHistoryRef(trackIndex.trackById.get(move.to.trackId)),
          startSec: move.to.startSec,
        },
      })),
    },
  }
}

export function buildClipTimingHistoryEntry(input: {
  projectId: string
  clip: Track['clips'][number]
  from: Extract<HistoryEntry, { type: 'clip-timing' }>['data']['from']
  to: Extract<HistoryEntry, { type: 'clip-timing' }>['data']['to']
}): Extract<HistoryEntry, { type: 'clip-timing' }> {
  return {
    type: 'clip-timing',
    projectId: input.projectId,
    data: {
      clipRef: getClipHistoryRef(input.clip),
      from: input.from,
      to: input.to,
    },
  }
}
