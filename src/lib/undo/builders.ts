import { buildClipHistorySnapshot } from '~/lib/clip-create'
import type { ClipCreateSnapshot } from '@daw-browser/shared'
import type { AutomationEnvelope } from '@daw-browser/shared'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { Track, TrackRouting } from '@daw-browser/timeline-core/types'

import { buildTrackRoutingHistorySnapshot, getClipHistoryRef, getTrackHistoryRef } from './refs'
import type {
  EffectParamsCommitPayload,
  EffectParamsHistoryEntry,
  HistoryEntry,
  HistoryScope,
  TrackAutomationSnapshot,
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
  automation?: TrackAutomationSnapshot
}): Extract<HistoryEntry, { type: 'track-delete' }> {
  const { projectId, track, tracks, effects, automation } = input
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
        groupRef: track.groupId ? getTrackHistoryRef(tracks.find((entry) => entry.id === track.groupId)) : undefined,
        collapsed: track.collapsed,
        color: track.color,
        routing: buildTrackRoutingHistorySnapshot(track, tracks),
      },
      clips: track.clips.map((clip) => buildClipHistorySnapshot(clip)),
      effects,
      automation,
      inboundRouting,
    },
  }
}

export function buildTrackGroupHistoryEntry(input: {
  projectId: string
  tracks: Track[]
  groupTrack: Track
  groupTrackIndex: number
  childTrackIds: Track['id'][]
  nextOutputTargetIdsByTrackId?: ReadonlyMap<Track['id'], Track['id'] | undefined>
}): Extract<HistoryEntry, { type: 'track-group' }> {
  const childIds = new Set(input.childTrackIds)
  const trackRefById = new Map(input.tracks.map((track) => [track.id, getTrackHistoryRef(track)]))
  trackRefById.set(input.groupTrack.id, getTrackHistoryRef(input.groupTrack))
  return {
    type: 'track-group',
    projectId: input.projectId,
    data: {
      groupTrackRef: getTrackHistoryRef(input.groupTrack),
      currentGroupTrackId: input.groupTrack.id,
      groupTrack: {
        index: input.groupTrackIndex,
        name: input.groupTrack.name,
        color: input.groupTrack.color,
      },
      childUpdates: input.tracks
        .filter((track) => childIds.has(track.id))
        .map((track) => {
          const nextOutputTargetId = input.nextOutputTargetIdsByTrackId?.has(track.id)
            ? input.nextOutputTargetIdsByTrackId.get(track.id)
            : input.groupTrack.id
          return {
            trackRef: getTrackHistoryRef(track),
            previousGroupRef: track.groupId ? trackRefById.get(track.groupId) : undefined,
            previousOutputTargetRef: track.outputTargetId ? trackRefById.get(track.outputTargetId) : undefined,
            nextOutputTargetRef: nextOutputTargetId ? trackRefById.get(nextOutputTargetId) : undefined,
          }
        }),
    },
  }
}

export function buildTrackUngroupHistoryEntry(input: {
  projectId: string
  tracks: Track[]
  groupTrack: Track
  childTrackIds: Track['id'][]
  nextOutputTargetIdsByTrackId?: ReadonlyMap<Track['id'], Track['id'] | undefined>
}): Extract<HistoryEntry, { type: 'track-ungroup' }> {
  const childIds = new Set(input.childTrackIds)
  const trackRefById = new Map(input.tracks.map((track) => [track.id, getTrackHistoryRef(track)]))
  return {
    type: 'track-ungroup',
    projectId: input.projectId,
    data: {
      groupTrackRef: getTrackHistoryRef(input.groupTrack),
      childSnapshots: input.tracks
        .filter((track) => childIds.has(track.id))
        .map((track) => {
          const nextOutputTargetId = input.nextOutputTargetIdsByTrackId?.get(track.id)
          return {
            trackRef: getTrackHistoryRef(track),
            previousGroupRef: getTrackHistoryRef(input.groupTrack),
            previousOutputTargetRef: track.outputTargetId ? trackRefById.get(track.outputTargetId) : undefined,
            nextOutputTargetRef: nextOutputTargetId ? trackRefById.get(nextOutputTargetId) : undefined,
          }
        }),
    },
  }
}

export function buildTrackColorHistoryEntry(input: {
  projectId: string
  track: Track
  from: string | undefined
  to: string | undefined
}): Extract<HistoryEntry, { type: 'track-color' }> {
  return {
    type: 'track-color',
    projectId: input.projectId,
    data: {
      trackRef: getTrackHistoryRef(input.track),
      from: input.from,
      to: input.to,
    },
  }
}

export function buildClipColorHistoryEntry(input: {
  projectId: string
  clip: Track['clips'][number]
  from: string | undefined
  to: string | undefined
}): Extract<HistoryEntry, { type: 'clip-color' }> {
  return {
    type: 'clip-color',
    projectId: input.projectId,
    data: {
      clipRef: getClipHistoryRef(input.clip),
      from: input.from,
      to: input.to,
    },
  }
}

export function buildTrackReorderHistoryEntry(input: {
  projectId: string
  tracks: Track[]
  patches: Array<{ trackId: Track['id']; index: number; groupId: Track['id'] | undefined; outputTargetId: Track['id'] | undefined }>
}): Extract<HistoryEntry, { type: 'track-reorder' }> {
  const trackById = new Map(input.tracks.map((track, index) => [track.id, { track, index }]))
  return {
    type: 'track-reorder',
    projectId: input.projectId,
    data: {
      patches: input.patches.flatMap((patch) => {
        const entry = trackById.get(patch.trackId)
        if (!entry) return []
        return [{
          trackRef: getTrackHistoryRef(entry.track),
          fromIndex: entry.index,
          toIndex: patch.index,
          fromGroupRef: entry.track.groupId ? getTrackHistoryRef(trackById.get(entry.track.groupId)?.track) : undefined,
          toGroupRef: patch.groupId ? getTrackHistoryRef(trackById.get(patch.groupId)?.track) : undefined,
          fromOutputTargetRef: entry.track.outputTargetId ? getTrackHistoryRef(trackById.get(entry.track.outputTargetId)?.track) : undefined,
          toOutputTargetRef: patch.outputTargetId ? getTrackHistoryRef(trackById.get(patch.outputTargetId)?.track) : undefined,
        }]
      }),
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
  const { targetId: _targetId, ...data } = input.payload
  return {
    type: 'effect-params',
    projectId: input.projectId,
    data: {
      ...data,
      trackRef,
    },
  }
}

export function buildAutomationEnvelopeHistoryEntry(input: {
  projectId: string
  before: AutomationEnvelope | null
  after: AutomationEnvelope | null
}): Extract<HistoryEntry, { type: 'automation-envelope-change' }> {
  return {
    type: 'automation-envelope-change',
    projectId: input.projectId,
    data: {
      before: input.before,
      after: input.after,
    },
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
