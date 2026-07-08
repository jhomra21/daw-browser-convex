import type { Accessor } from 'solid-js'

import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { isLocalId } from '@daw-browser/shared'
import { ensureRoomShareLink, getInviteShareUrl } from '~/lib/timeline-share'
import { PPS } from '~/lib/timeline-utils'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { toLocalTimelineTrack } from '~/lib/timeline-repository/track-row-adapter'
import { createOptimisticTrack, pushTrackCreateHistory } from '~/lib/tracks'
import { planGroupTracks, planMoveTrackToGroup, planSetTrackColor, planTrackReorder, planUngroupTracks } from '~/lib/track-group-ops'
import { assertAppliedSharedTimelineOperationResult, publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import { runWithConcurrency } from '~/lib/run-with-concurrency'
import { buildClipColorHistoryEntry, buildTrackColorHistoryEntry, buildTrackGroupHistoryEntry, buildTrackReorderHistoryEntry, buildTrackUngroupHistoryEntry } from '~/lib/undo/builders'
import type { TimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Track } from '@daw-browser/timeline-core/types'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type TimelineTrackCreateOptions = {
  kind?: 'audio' | 'instrument'
  channelRole?: 'track' | 'return' | 'group'
  color?: string
  index?: number
}

type TimelineTrackCreateBehavior = {
  pushHistory?: boolean
  select?: boolean
}

type UseTimelineActionsOptions = {
  tracks: Accessor<RuntimeTrack[]>
  room: {
    projectId: Accessor<string>
    setProjectId: (projectId: string) => void
    userId: Accessor<string>
  }
  creation: {
    selection: TimelineSelectionController
    insertLocalTrack: (track: Track, index: number) => void
    replaceLocalClip: (trackId: Track['id'], clip: Track['clips'][number]) => void
    updateLocalTrack: (track: Track, index: number, patch: Partial<Pick<Track, 'groupId' | 'outputTargetId' | 'collapsed' | 'color'>> & { index?: number }) => void
    removeCloudTrack: (track: Track) => Promise<void>
    grantTrackWrite: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
    pushHistory: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  }
  navigation: {
    trackLookup: Accessor<TimelineTrackIndex<AudioBuffer>>
    selection: TimelineSelectionController
    setPlayhead: (nextSec: number, tracks: RuntimeTrack[]) => void
    openMidiEditorFor: (clipId: string) => void
    ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
    getScrollElement: () => HTMLDivElement | undefined
  }
}

type UseTimelineActionsReturn = {
  createTimelineTrack: (options?: TimelineTrackCreateOptions, behavior?: TimelineTrackCreateBehavior) => Promise<Track | null>
  handleShare: () => Promise<string | undefined>
  jumpToClip: (trackId: Track['id'], clipId: string, startSec: number) => void
  groupSelectedTracks: (trackIds: Track['id'][]) => Promise<void>
  ungroupTrack: (groupId: Track['id']) => Promise<void>
  moveTrackToGroup: (trackId: Track['id'], groupId: Track['id'] | undefined) => Promise<void>
  reorderTracks: (moveRootIds: Track['id'][], target: Parameters<typeof planTrackReorder>[0]['target']) => Promise<void>
  toggleTrackCollapsed: (trackId: Track['id']) => Promise<void>
  setTracksCollapsed: (updates: Array<{ trackId: Track['id']; collapsed: boolean }>) => Promise<void>
  setTrackColor: (trackId: Track['id'], color: string | undefined) => Promise<void>
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
    const index = trackOptions.index ?? options.tracks().length
    if (isLocalId('project', projectId)) {
      const row = await createLocalTimelineRepository(projectId).createTrack({
        index,
        kind: trackOptions.kind,
        channelRole,
        color: trackOptions.color,
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
      color: trackOptions.color,
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

  const persistTrackPatch = async (
    projectId: string,
    trackId: Track['id'],
    patch: Pick<Track, 'groupId' | 'outputTargetId' | 'collapsed' | 'color'>,
    currentSends: Track['sends'] = [],
  ) => {
    const hasGroup = Object.hasOwn(patch, 'groupId')
    const hasOutput = Object.hasOwn(patch, 'outputTargetId')
    const hasCollapsed = Object.hasOwn(patch, 'collapsed')
    const hasColor = Object.hasOwn(patch, 'color')
    if (isLocalId('project', projectId)) {
      await createLocalTimelineRepository(projectId).updateTrack({
        trackId,
        groupId: hasGroup ? patch.groupId ?? null : undefined,
        outputTargetId: hasOutput ? patch.outputTargetId ?? null : undefined,
        collapsed: hasCollapsed ? patch.collapsed : undefined,
        color: hasColor ? patch.color ?? null : undefined,
      })
      return
    }
    if (hasGroup) {
      await publishSharedTimelineOperation(projectId, { kind: 'tracks.setGroup', payload: { trackId, groupId: patch.groupId ?? null } })
    }
    if (hasOutput) {
      await publishSharedTimelineOperation(projectId, { kind: 'tracks.setRouting', payload: { trackId, routing: { outputTargetId: patch.outputTargetId, sends: currentSends ?? [] } } })
    }
    if (hasCollapsed && patch.collapsed !== undefined) {
      await publishSharedTimelineOperation(projectId, { kind: 'tracks.setCollapsed', payload: { trackId, collapsed: patch.collapsed } })
    }
    if (hasColor) {
      await publishSharedTimelineOperation(projectId, { kind: 'tracks.setColor', payload: { trackId, color: patch.color } })
    }
  }

  const applyTrackPatch = (track: Track, patch: Pick<Track, 'groupId' | 'outputTargetId' | 'collapsed' | 'color'>) => {
    const index = options.tracks().findIndex((entry) => entry.id === track.id)
    if (index < 0) return
    options.creation.updateLocalTrack(track, index, patch)
  }

  async function reorderTracks(moveRootIds: Track['id'][], target: Parameters<typeof planTrackReorder>[0]['target']): Promise<void> {
    const projectId = options.room.projectId()
    const tracks = options.tracks()
    if (!projectId) return
    const tracksForReorder = tracks.map((track, index) => ({ ...track, index }))
    const plan = planTrackReorder({ tracks: tracksForReorder, moveRootIds, target })
    if (!plan) return
    const trackById = new Map(tracks.map((track) => [track.id, track]))
    const patchByTrackId = new Map(plan.patches.map((patch) => [patch.trackId, patch]))
    const updates = tracksForReorder.map((track) => {
      const patch = patchByTrackId.get(track.id)
      return {
        trackId: track.id,
        index: patch?.index ?? track.index,
        groupId: (patch ? patch.groupId : track.groupId) ?? null,
        outputTargetId: (patch ? patch.outputTargetId : track.outputTargetId) ?? null,
      }
    })
    if (isLocalId('project', projectId)) {
      await createLocalTimelineRepository(projectId).reorderAndGroup(updates)
    } else {
      const result = await publishSharedTimelineOperation(projectId, {
        kind: 'tracks.reorderAndGroup',
        payload: { updates },
      })
      assertAppliedSharedTimelineOperationResult(result)
    }
    for (const patch of plan.patches) {
      const track = trackById.get(patch.trackId)
      if (!track) continue
      options.creation.updateLocalTrack(track, tracks.findIndex((entry) => entry.id === track.id), patch)
    }
    if (plan.patches.length > 0) {
      options.creation.pushHistory(buildTrackReorderHistoryEntry({ projectId, tracks, patches: plan.patches }))
    }
    for (const groupId of plan.expandGroupIds) {
      const track = trackById.get(groupId)
      if (!track) continue
      await persistTrackPatch(projectId, groupId, { collapsed: false })
      options.creation.updateLocalTrack(track, tracks.findIndex((entry) => entry.id === groupId), { collapsed: false })
    }
  }

  async function groupSelectedTracks(trackIds: Track['id'][]): Promise<void> {
    const projectId = options.room.projectId()
    if (!projectId) return
    const tracks = options.tracks()
    const pendingGroupTrackId = '__pending_group_track__'
    const plan = planGroupTracks({ tracks, selectedTrackIds: trackIds, groupTrackId: pendingGroupTrackId })
    if (!plan) return
    const groupTrack = await createTimelineTrack({
      channelRole: 'group',
      color: plan.groupTrack.color,
      index: plan.groupTrack.index,
    }, { pushHistory: false, select: false })
    if (!groupTrack) return
    const trackById = new Map(tracks.map((track) => [track.id, track]))
    const childUpdateByTrackId = new Map(plan.childUpdates.map((update) => [update.trackId, update]))
    const reorderUpdates = [
      {
        trackId: groupTrack.id,
        index: plan.groupTrack.index,
        groupId: groupTrack.groupId ?? null,
        outputTargetId: groupTrack.outputTargetId ?? null,
      },
      ...tracks.map((track, index) => {
        const update = childUpdateByTrackId.get(track.id)
        const outputTargetId = update?.outputTargetId === pendingGroupTrackId
          ? groupTrack.id
          : update?.outputTargetId ?? track.outputTargetId
        return {
          trackId: track.id,
          index: index >= plan.groupTrack.index ? index + 1 : index,
          groupId: update ? groupTrack.id : track.groupId ?? null,
          outputTargetId: outputTargetId ?? null,
        }
      }),
    ]
    if (isLocalId('project', projectId)) {
      await createLocalTimelineRepository(projectId).reorderAndGroup(reorderUpdates)
    } else {
      const result = await publishSharedTimelineOperation(projectId, {
        kind: 'tracks.reorderAndGroup',
        payload: { updates: reorderUpdates },
      })
      assertAppliedSharedTimelineOperationResult(result)
    }
    for (const update of plan.childUpdates) {
      const track = trackById.get(update.trackId)
      const outputTargetId = update.outputTargetId === pendingGroupTrackId ? groupTrack.id : update.outputTargetId
      if (!track) continue
      applyTrackPatch(track, { groupId: groupTrack.id, outputTargetId })
    }
    const nextOutputTargetIdsByTrackId = new Map(plan.childUpdates.map((update) => [
      update.trackId,
      update.outputTargetId === pendingGroupTrackId ? groupTrack.id : update.outputTargetId,
    ]))
    options.creation.pushHistory(buildTrackGroupHistoryEntry({
      projectId,
      tracks,
      groupTrack,
      groupTrackIndex: plan.groupTrack.index,
      childTrackIds: plan.childUpdates.map((update) => update.trackId),
      nextOutputTargetIdsByTrackId,
    }))
  }

  async function ungroupTrack(groupId: Track['id']): Promise<void> {
    const projectId = options.room.projectId()
    if (!projectId) return
    const tracks = options.tracks()
    const groupTrack = tracks.find((track) => track.id === groupId)
    if (!groupTrack) return
    const plan = planUngroupTracks({ tracks, groupId })
    if (plan.childUpdates.length === 0) return
    const trackById = new Map(tracks.map((track) => [track.id, track]))
    const childUpdateByTrackId = new Map(plan.childUpdates.map((update) => [update.trackId, update]))
    const updates = tracks.map((track, index) => {
      const update = childUpdateByTrackId.get(track.id)
      return {
        trackId: track.id,
        index,
        groupId: update ? null : track.groupId ?? null,
        outputTargetId: (update ? update.outputTargetId : track.outputTargetId) ?? null,
      }
    })
    if (isLocalId('project', projectId)) {
      await createLocalTimelineRepository(projectId).reorderAndGroup(updates)
    } else {
      const result = await publishSharedTimelineOperation(projectId, {
        kind: 'tracks.reorderAndGroup',
        payload: { updates },
      })
      assertAppliedSharedTimelineOperationResult(result)
    }
    options.creation.pushHistory(buildTrackUngroupHistoryEntry({
      projectId,
      tracks,
      groupTrack,
      childTrackIds: plan.childUpdates.map((update) => update.trackId),
      nextOutputTargetIdsByTrackId: new Map(plan.childUpdates.map((update) => [update.trackId, update.outputTargetId])),
    }))
    for (const update of plan.childUpdates) {
      const track = trackById.get(update.trackId)
      if (!track) continue
      applyTrackPatch(track, { groupId: undefined, outputTargetId: update.outputTargetId })
    }
  }

  async function moveTrackToGroup(trackId: Track['id'], groupId: Track['id'] | undefined): Promise<void> {
    const projectId = options.room.projectId()
    if (!projectId) return
    const tracks = options.tracks()
    const plan = planMoveTrackToGroup({ tracks, trackId, groupId })
    const track = tracks.find((entry) => entry.id === trackId)
    if (!plan || !track) return
    await persistTrackPatch(projectId, trackId, { groupId: plan.groupId, outputTargetId: plan.outputTargetId }, track.sends)
    applyTrackPatch(track, { groupId: plan.groupId, outputTargetId: plan.outputTargetId })
  }

  async function toggleTrackCollapsed(trackId: Track['id']): Promise<void> {
    const projectId = options.room.projectId()
    const track = options.tracks().find((entry) => entry.id === trackId)
    if (!projectId || !track) return
    const collapsed = track.collapsed !== true
    await persistTrackPatch(projectId, trackId, { collapsed })
    applyTrackPatch(track, { collapsed })
  }

  async function setTracksCollapsed(updates: Array<{ trackId: Track['id']; collapsed: boolean }>): Promise<void> {
    const projectId = options.room.projectId()
    if (!projectId || updates.length === 0) return
    const tracks = options.tracks()
    const trackById = new Map(tracks.map((track) => [track.id, track]))
    const changed = updates.flatMap((update) => {
      const track = trackById.get(update.trackId)
      return track && track.collapsed !== update.collapsed
        ? [{ track, collapsed: update.collapsed }]
        : []
    })
    if (changed.length === 0) return
    await runWithConcurrency(changed, 8, async (update) => {
      await persistTrackPatch(projectId, update.track.id, { collapsed: update.collapsed })
    })
    for (const update of changed) {
      applyTrackPatch(update.track, { collapsed: update.collapsed })
    }
  }

  async function setTrackColor(trackId: Track['id'], color: string | undefined): Promise<void> {
    const projectId = options.room.projectId()
    if (!projectId) return
    const tracks = options.tracks()
    const plan = planSetTrackColor(tracks, trackId, color)
    if (!plan || (plan.trackUpdates.length === 0 && plan.clipUpdates.length === 0)) return
    const trackById = new Map(tracks.map((track) => [track.id, track]))
    const localTimelineRepository = isLocalId('project', projectId)
      ? createLocalTimelineRepository(projectId)
      : null
    await runWithConcurrency([
      ...plan.trackUpdates.map((update) => ({ kind: 'track' as const, update })),
      ...plan.clipUpdates.map((update) => ({ kind: 'clip' as const, update })),
    ], 8, async (item) => {
      if (item.kind === 'track') {
        await persistTrackPatch(projectId, item.update.trackId, { color: item.update.to })
        return
      }
      if (localTimelineRepository) {
        await localTimelineRepository.updateClip({ clipId: item.update.clipId, color: item.update.to })
        return
      }
      await publishSharedTimelineOperation(projectId, { kind: 'clips.setColor', payload: { clipId: item.update.clipId, color: item.update.to } })
    })
    for (const update of plan.trackUpdates) {
      const track = trackById.get(update.trackId)
      if (track) applyTrackPatch(track, { color: update.to })
    }
    for (const update of plan.clipUpdates) {
      const track = trackById.get(update.trackId)
      const clip = track?.clips.find((clip) => clip.id === update.clipId)
      if (track && clip) options.creation.replaceLocalClip(track.id, { ...clip, color: update.to })
    }
    if (plan.trackUpdates.length === 1 && plan.clipUpdates.length === 0) {
      const update = plan.trackUpdates[0]
      const track = trackById.get(update.trackId)
      if (track) options.creation.pushHistory(buildTrackColorHistoryEntry({ projectId, track, from: update.from, to: update.to }))
      return
    }
    options.creation.pushHistory({
      type: 'section-edit',
      projectId,
      data: {
        entries: [
          ...plan.trackUpdates.flatMap((update) => {
            const track = trackById.get(update.trackId)
            return track ? [buildTrackColorHistoryEntry({ projectId, track, from: update.from, to: update.to })] : []
          }),
          ...plan.clipUpdates.flatMap((update) => {
            const track = trackById.get(update.trackId)
            const clip = track?.clips.find((clip) => clip.id === update.clipId)
            return clip ? [buildClipColorHistoryEntry({ projectId, clip, from: update.from, to: update.to })] : []
          }),
        ],
      },
    })
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
    groupSelectedTracks,
    ungroupTrack,
    moveTrackToGroup,
    reorderTracks,
    toggleTrackCollapsed,
    setTracksCollapsed,
    setTrackColor,
  }
}
