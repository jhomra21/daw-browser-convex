import type { Accessor } from 'solid-js'

import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { isLocalId } from '~/lib/local-ids'
import { ensureRoomShareLink } from '~/lib/timeline-share'
import { PPS } from '~/lib/timeline-utils'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { toLocalTimelineTrack } from '~/lib/timeline-repository/track-row-adapter'
import { createOptimisticTrack, createOptimisticTrackWithHistory, pushTrackCreateHistory } from '~/lib/tracks'
import type { TimelineTrackIndex } from '~/lib/timeline-track-index'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Track } from '~/types/timeline'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type TimelineTrackCreateOptions = {
  kind?: 'audio' | 'instrument'
  channelRole?: 'track' | 'return' | 'group'
}

type TimelineTrackCreateBehavior = {
  pushHistory?: boolean
  select?: boolean
}

type UseTimelineActionsOptions = {
  room: {
    projectId: Accessor<string>
    setProjectId: (projectId: string) => void
    userId: Accessor<string>
  }
  creation: {
    renderTracks: Accessor<Track[]>
    selection: TimelineSelectionController
    insertLocalTrack: (track: Track, index: number) => void
    grantTrackWrite: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
    pushHistory: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
    convexClient: typeof import('~/lib/convex').convexClient
    convexApi: typeof import('~/lib/convex').convexApi
  }
  transport: {
    isRecording: Accessor<boolean>
    handlePause: () => void
    handleStop: () => void
    stopRecording: () => Promise<void>
    toggleRecording: () => Promise<unknown>
  }
  navigation: {
    renderTracks: Accessor<Track[]>
    trackLookup: Accessor<TimelineTrackIndex>
    selection: TimelineSelectionController
    setPlayhead: (nextSec: number, tracks: Track[]) => void
    openMidiEditorFor: (clipId: string) => void
    ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
    getScrollElement: () => HTMLDivElement | undefined
  }
}

type UseTimelineActionsReturn = {
  createTimelineTrack: (options?: TimelineTrackCreateOptions, behavior?: TimelineTrackCreateBehavior) => Promise<Track | null>
  handleTransportPause: () => void
  handleTransportStop: () => void
  handleRecordToggle: () => Promise<void>
  handleShare: () => void
  jumpToClip: (trackId: Track['id'], clipId: string, startSec: number) => void
}

export function useTimelineActions(
  options: UseTimelineActionsOptions,
): UseTimelineActionsReturn {
  async function createTimelineTrack(
    trackOptions: TimelineTrackCreateOptions = {},
    behavior: TimelineTrackCreateBehavior = {},
  ): Promise<Track | null> {
    const projectId = options.room.projectId()
    if (!projectId) return null

    const channelRole = trackOptions.channelRole ?? 'track'
    const index = options.creation.renderTracks().length
    if (isLocalId('project', projectId)) {
      const row = await createLocalTimelineRepository(projectId).createTrack({
        index,
        kind: trackOptions.kind,
        channelRole,
      })
      const track = toLocalTimelineTrack(row)
      options.creation.insertLocalTrack(track, index)
      options.creation.grantTrackWrite(track.id, { projectId, userId: options.room.userId() })
      if (behavior.pushHistory !== false) {
        pushTrackCreateHistory(options.creation.pushHistory, projectId, options.creation.renderTracks(), track)
      }
      if (behavior.select !== false) {
        options.creation.selection.selectTrackTarget(track.id)
      }
      return track
    }

    const userId = options.room.userId()
    if (!userId) return null

    const track = behavior.pushHistory === false
      ? await createOptimisticTrack({
          convexClient: options.creation.convexClient,
          convexApi: options.creation.convexApi,
          projectId,
          userId,
          insertLocalTrack: options.creation.insertLocalTrack,
          index,
          grantWrite: options.creation.grantTrackWrite,
          grantScope: { projectId, userId },
          kind: trackOptions.kind,
          channelRole,
        })
      : await createOptimisticTrackWithHistory({
          convexClient: options.creation.convexClient,
          convexApi: options.creation.convexApi,
          projectId,
          userId,
          tracks: options.creation.renderTracks,
          insertLocalTrack: options.creation.insertLocalTrack,
          index,
          grantWrite: options.creation.grantTrackWrite,
          grantScope: { projectId, userId },
          kind: trackOptions.kind,
          channelRole,
          historyPush: options.creation.pushHistory,
        })
    if (!track) return null

    if (behavior.select !== false) {
      options.creation.selection.selectTrackTarget(track.id)
    }

    return track
  }

  function handleTransportPause(): void {
    if (options.transport.isRecording()) {
      void options.transport.stopRecording()
    }
    options.transport.handlePause()
  }

  function handleTransportStop(): void {
    if (options.transport.isRecording()) {
      void options.transport.stopRecording()
    }
    options.transport.handleStop()
  }

  async function handleRecordToggle(): Promise<void> {
    await options.transport.toggleRecording()
  }

  function handleShare(): void {
    ensureRoomShareLink(options.room.projectId(), options.room.setProjectId)
  }

  function jumpToClip(trackId: Track['id'], clipId: string, startSec: number): void {
    options.navigation.selection.selectPrimaryClip({ trackId, clipId })
    options.navigation.setPlayhead(Math.max(0, startSec), options.navigation.renderTracks())
    options.navigation.openMidiEditorFor(clipId)

    try {
      const match = options.navigation.trackLookup().clipEntryById.get(clipId)
      if (match && match.trackId === trackId && !match.clip.buffer) {
        void options.navigation.ensureClipBuffer(clipId, match.clip.sampleUrl)
      }
    } catch {}

    try {
      const scrollElement = options.navigation.getScrollElement()
      if (!scrollElement) return
      const centerLeft = Math.max(0, startSec * PPS - (scrollElement.clientWidth / 2))
      scrollElement.scrollLeft = Math.floor(centerLeft)
    } catch {}
  }

  return {
    createTimelineTrack,
    handleTransportPause,
    handleTransportStop,
    handleRecordToggle,
    handleShare,
    jumpToClip,
  }
}
