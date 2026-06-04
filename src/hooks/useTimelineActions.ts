import type { Accessor } from 'solid-js'

import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { isLocalId } from '~/lib/local-ids'
import { ensureRoomShareLink, getInviteShareUrl } from '~/lib/timeline-share'
import { PPS } from '~/lib/timeline-utils'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { toLocalTimelineTrack } from '~/lib/timeline-repository/track-row-adapter'
import { createOptimisticTrack, pushTrackCreateHistory } from '~/lib/tracks'
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
  tracks: Accessor<Track[]>
  room: {
    projectId: Accessor<string>
    setProjectId: (projectId: string) => void
    userId: Accessor<string>
  }
  creation: {
    selection: TimelineSelectionController
    insertLocalTrack: (track: Track, index: number) => void
    removeCloudTrack: (track: Track) => Promise<void>
    grantTrackWrite: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
    pushHistory: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  }
  navigation: {
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
  handleShare: () => Promise<string | undefined>
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
    const index = options.tracks().length
    if (isLocalId('project', projectId)) {
      const row = await createLocalTimelineRepository(projectId).createTrack({
        index,
        kind: trackOptions.kind,
        channelRole,
      })
      if (options.room.projectId() !== projectId) {
        await createLocalTimelineRepository(projectId).deleteTrack(row.id)
        return null
      }
      const track = toLocalTimelineTrack(row)
      options.creation.insertLocalTrack(track, index)
      options.creation.grantTrackWrite(track.id, { projectId, userId: options.room.userId() })
      if (behavior.pushHistory !== false) {
        pushTrackCreateHistory(options.creation.pushHistory, projectId, options.tracks(), track)
      }
      if (behavior.select !== false) {
        options.creation.selection.selectTrackTarget(track.id)
      }
      return track
    }

    const userId = options.room.userId()
    if (!userId) return null

    let inserted = false
    const track = await createOptimisticTrack({
      projectId,
      insertLocalTrack: (createdTrack, trackIndex) => {
        if (options.room.projectId() !== projectId) return
        inserted = true
        options.creation.insertLocalTrack(createdTrack, trackIndex)
      },
      index,
      grantWrite: (trackId, scope) => {
        if (options.room.projectId() === projectId) options.creation.grantTrackWrite(trackId, scope)
      },
      grantScope: { projectId, userId },
      kind: trackOptions.kind,
      channelRole,
    })
    if (!track) return null
    if (!inserted) {
      await options.creation.removeCloudTrack(track)
      return null
    }

    if (behavior.pushHistory !== false) {
      pushTrackCreateHistory(options.creation.pushHistory, projectId, options.tracks(), track)
    }
    if (behavior.select !== false) {
      options.creation.selection.selectTrackTarget(track.id)
    }

    return track
  }

  async function handleShare(): Promise<string | undefined> {
    const currentProjectId = options.room.projectId()
    if (isLocalId('project', currentProjectId)) return undefined
    const projectId = ensureRoomShareLink(currentProjectId, options.room.setProjectId)
    const userId = options.room.userId()
    if (!projectId || !userId) return undefined
    const response = await fetch('/api/share-invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, role: 'viewer' }),
    })
    if (!response.ok) throw new Error('Failed to create share invite.')
    const result = await response.json()
    return typeof result?.token === 'string' ? getInviteShareUrl(projectId, result.token) : undefined
  }

  function jumpToClip(trackId: Track['id'], clipId: string, startSec: number): void {
    options.navigation.selection.selectPrimaryClip({ trackId, clipId })
    options.navigation.setPlayhead(Math.max(0, startSec), options.tracks())
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
    handleShare,
    jumpToClip,
  }
}
