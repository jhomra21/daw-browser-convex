import { createEffect, createMemo, type Accessor } from 'solid-js'
import type { FunctionReturnType } from 'convex/server'

import type { ClipMediaCache } from '~/lib/clip-buffer-cache'
import { convexApi } from '~/lib/convex'
import {
  resolveTimelineTracks,
  type ClipTimelinePatch,
  type PendingTrackEntry,
} from '~/lib/resolve-timeline-tracks'
import type { TimelineSnapshot } from '~/lib/timeline-repository/types'
import { createTimelineTrackIndex, type TimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { PendingTrackMixState } from '~/lib/timeline-mixer-pending'
import type { LocalMixMap } from '~/lib/timeline-storage'
import type { Clip, Track, TrackRouting, TrackSend } from '@daw-browser/timeline-core/types'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'

type FullTimelineView = FunctionReturnType<typeof convexApi.timeline.fullView>
type PendingClipCreate = { trackId: Track['id']; clip: RuntimeClip }
type ServerTrackState = {
  serverVolumes: Map<Track['id'], number>
  serverMuted: Map<Track['id'], boolean>
  serverSoloed: Map<Track['id'], boolean>
  serverRouting: Map<Track['id'], TrackRouting & { sends: TrackSend[] }>
} | null

type UseTimelineResolvedModelOptions = {
  projectId: Accessor<string | undefined>
  fullViewData: Accessor<FullTimelineView | undefined>
  localSnapshot: Accessor<TimelineSnapshot | null>
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
    previewClipsByTrackId: Accessor<Map<Track['id'], RuntimeClip[]>>
  }
  identity: {
    trackHistoryRefsById: Accessor<Map<Track['id'], string>>
    trackNamesByHistoryRef: Accessor<Map<string, string>>
    clipHistoryRefsById: Accessor<Map<string, string>>
    rememberTrackProjection: (track: Pick<Track, 'id' | 'historyRef' | 'name'> | null | undefined) => void
    rememberClipHistoryRef: (clip: Pick<Track['clips'][number], 'id' | 'historyRef'> | null | undefined) => void
  }
  buffers: ClipMediaCache
  bufferVersion: Accessor<number>
}

type UseTimelineResolvedModelReturn = {
  resolvedTracks: Accessor<RuntimeTrack[]>
  placementTracks: Accessor<RuntimeTrack[]>
  renderTracks: Accessor<RuntimeTrack[]>
  trackLookup: Accessor<TimelineTrackIndex<AudioBuffer>>
}

export function useTimelineResolvedModel(
  options: UseTimelineResolvedModelOptions,
): UseTimelineResolvedModelReturn {
  const emptyDraftClipEditsById = new Map<string, ClipTimelinePatch>()
  const emptyPreviewClipsByTrackId = new Map<Track['id'], RuntimeClip[]>()

  function resolveTracks(input: {
    draftClipEditsById: Map<string, ClipTimelinePatch>
    previewClipsByTrackId: Map<Track['id'], RuntimeClip[]>
  }): RuntimeTrack[] {
    options.bufferVersion()
    return resolveTimelineTracks({
      projectId: options.projectId(),
      server: {
        data: options.fullViewData(),
        localSnapshot: options.localSnapshot(),
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
      buffers: options.buffers,
    })
  }

  const resolvedTracks = createMemo(() => {
    return resolveTracks({
      draftClipEditsById: emptyDraftClipEditsById,
      previewClipsByTrackId: emptyPreviewClipsByTrackId,
    })
  })

  const placementTracks = createMemo(() => {
    const draftClipEditsById = options.projection.draftClipEditsById()
    if (draftClipEditsById.size === 0) return resolvedTracks()
    return resolveTracks({
      draftClipEditsById,
      previewClipsByTrackId: emptyPreviewClipsByTrackId,
    })
  })

  const renderTracks = createMemo(() => {
    const previewClipsByTrackId = options.projection.previewClipsByTrackId()
    if (previewClipsByTrackId.size === 0) return placementTracks()
    return resolveTracks({
      draftClipEditsById: options.projection.draftClipEditsById(),
      previewClipsByTrackId,
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
