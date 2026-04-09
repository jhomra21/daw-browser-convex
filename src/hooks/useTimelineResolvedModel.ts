import { createEffect, createMemo, type Accessor } from 'solid-js'
import type { FunctionReturnType } from 'convex/server'

import { convexApi } from '~/lib/convex'
import {
  resolveTimelineTracks,
  type ClipTimelinePatch,
  type PendingTrackEntry,
} from '~/lib/resolve-timeline-tracks'
import { createTimelineTrackIndex, type TimelineTrackIndex } from '~/lib/timeline-track-index'
import type { PendingTrackMixState } from '~/lib/timeline-mixer-pending'
import type { LocalMixMap } from '~/lib/timeline-storage'
import type { Clip, Track, TrackRouting, TrackSend } from '~/types/timeline'

type FullTimelineView = FunctionReturnType<typeof convexApi.timeline.fullView>
type PendingClipCreate = { trackId: Track['id']; clip: Clip }
type ServerTrackState = {
  serverVolumes: Map<Track['id'], number>
  serverMuted: Map<Track['id'], boolean>
  serverSoloed: Map<Track['id'], boolean>
  serverRouting: Map<Track['id'], TrackRouting & { sends: TrackSend[] }>
} | null

type UseTimelineResolvedModelOptions = {
  fullViewData: Accessor<FullTimelineView | undefined>
  syncMix: Accessor<boolean>
  writableTrackIds: Accessor<Set<Track['id']>>
  serverTrackState: Accessor<ServerTrackState>
  localMixByTrackId: Accessor<LocalMixMap>
  pendingSharedTrackVolumes: Accessor<Map<Track['id'], number>>
  pendingSharedTrackRouting: Accessor<Map<Track['id'], TrackRouting & { sends: TrackSend[] }>>
  pendingSharedTrackMix: Accessor<Map<Track['id'], PendingTrackMixState>>
  projection: {
    pendingTrackEntriesById: Accessor<Map<Track['id'], PendingTrackEntry>>
    removedTrackIds: Accessor<Set<Track['id']>>
    pendingTrackLocksById: Accessor<Map<Track['id'], string | null>>
    pendingClipCreatesById: Accessor<Map<string, PendingClipCreate>>
    removedClipIds: Accessor<Set<string>>
    committedClipEditsById: Accessor<Map<string, ClipTimelinePatch>>
    draftClipEditsById: Accessor<Map<string, ClipTimelinePatch>>
    previewClipsByTrackId: Accessor<Map<Track['id'], Track['clips']>>
  }
  identity: {
    trackHistoryRefsById: Accessor<Map<Track['id'], string>>
    trackNamesByHistoryRef: Accessor<Map<string, string>>
    clipHistoryRefsById: Accessor<Map<string, string>>
    rememberTrackProjection: (track: Pick<Track, 'id' | 'historyRef' | 'name'> | null | undefined) => void
    rememberClipHistoryRef: (clip: Pick<Track['clips'][number], 'id' | 'historyRef'> | null | undefined) => void
  }
  audioBufferCache: Map<string, AudioBuffer>
  bufferVersion: Accessor<number>
}

type UseTimelineResolvedModelReturn = {
  resolvedTracks: Accessor<Track[]>
  placementTracks: Accessor<Track[]>
  renderTracks: Accessor<Track[]>
  trackLookup: Accessor<TimelineTrackIndex>
}

export function useTimelineResolvedModel(
  options: UseTimelineResolvedModelOptions,
): UseTimelineResolvedModelReturn {
  function resolveTracks(input: {
    draftClipEditsById: Map<string, ClipTimelinePatch>
    previewClipsByTrackId: Map<Track['id'], Track['clips']>
  }): Track[] {
    options.bufferVersion()
    return resolveTimelineTracks({
      server: {
        data: options.fullViewData(),
        trackState: options.serverTrackState(),
      },
      client: {
        mix: {
          syncMix: options.syncMix(),
          writableTrackIds: options.writableTrackIds(),
          localByTrackId: options.localMixByTrackId(),
          pendingSharedTrackVolumes: options.pendingSharedTrackVolumes(),
          pendingSharedTrackRouting: options.pendingSharedTrackRouting(),
          pendingSharedMixByTrackId: options.pendingSharedTrackMix(),
        },
        tracks: {
          pendingEntriesById: options.projection.pendingTrackEntriesById(),
          removedIds: options.projection.removedTrackIds(),
          pendingLocksById: options.projection.pendingTrackLocksById(),
          historyRefsById: options.identity.trackHistoryRefsById(),
          namesByHistoryRef: options.identity.trackNamesByHistoryRef(),
        },
        clips: {
          pendingCreatesById: options.projection.pendingClipCreatesById(),
          removedIds: options.projection.removedClipIds(),
          committedEditsById: options.projection.committedClipEditsById(),
          draftEditsById: input.draftClipEditsById,
          previewByTrackId: input.previewClipsByTrackId,
          historyRefsById: options.identity.clipHistoryRefsById(),
        },
      },
      buffers: {
        audioBufferCache: options.audioBufferCache,
      },
    })
  }

  const resolvedTracks = createMemo(() => {
    return resolveTracks({
      draftClipEditsById: new Map<string, ClipTimelinePatch>(),
      previewClipsByTrackId: new Map(),
    })
  })

  const placementTracks = createMemo(() => {
    return resolveTracks({
      draftClipEditsById: options.projection.draftClipEditsById(),
      previewClipsByTrackId: new Map(),
    })
  })

  const renderTracks = createMemo(() => {
    return resolveTracks({
      draftClipEditsById: options.projection.draftClipEditsById(),
      previewClipsByTrackId: options.projection.previewClipsByTrackId(),
    })
  })

  const trackLookup = createMemo(() => createTimelineTrackIndex(renderTracks()))

  createEffect(() => {
    for (const track of resolvedTracks()) {
      options.identity.rememberTrackProjection(track)
      for (const clip of track.clips) {
        options.identity.rememberClipHistoryRef(clip)
      }
    }
  })

  return {
    resolvedTracks,
    placementTracks,
    renderTracks,
    trackLookup,
  }
}
