import { buildLocalClip } from '~/lib/clip-create'
import { normalizeTrackRouting } from '@daw-browser/timeline-core/track-routing'
import { createLocalTrack } from '~/lib/tracks'
import type { Track, TrackRouting } from '@daw-browser/timeline-core/types'

import { buildHistoryRefIndex, resolveStoredTrackId, resolveTrackId, resolveTrackRoutingSnapshot } from './refs'
import type { Deps } from './exec'
import type { HistoryEntry } from './types'
import {
  createHistoryClip,
  createHistoryTrack,
  isLocalHistoryProject,
  persistHistoryTrackEffects,
  persistHistoryTrackMixState,
  persistHistoryTrackRouting,
  persistHistoryTrackVolume,
  removeHistoryTrackOrThrow,
  syncHistoryClipCreateEntryIds,
  syncHistoryTrackCreateEntryId,
} from './history-persistence'

type HistoryDirection = 'undo' | 'redo'
type HistoryContext = {
  refIndex: ReturnType<typeof buildHistoryRefIndex>
}

function requireResolved<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message)
  }
  return value
}

function readCurrentTrackRouting(track: Pick<Track, 'sends' | 'outputTargetId'> | null | undefined): TrackRouting {
  return {
    sends: track?.sends ?? [],
    outputTargetId: track?.outputTargetId,
  }
}

function mergeTrackRouting(base: TrackRouting, next: TrackRouting): TrackRouting {
  const sendsByTargetId = new Map<string, NonNullable<TrackRouting['sends']>[number]>()
  for (const send of base.sends ?? []) sendsByTargetId.set(send.targetId, send)
  for (const send of next.sends ?? []) sendsByTargetId.set(send.targetId, send)
  return {
    sends: Array.from(sendsByTargetId.values()).sort((left, right) => left.targetId.localeCompare(right.targetId)),
    outputTargetId: next.outputTargetId ?? base.outputTargetId,
  }
}

export async function applyTrackClipCreateEntry(
  entry: Extract<HistoryEntry, { type: 'track-clip-create' }>,
  deps: Deps,
  direction: HistoryDirection,
  historyContext: HistoryContext,
) {
  const { projectId, userId } = deps
  const grantScope = { projectId, userId }

  if (direction === 'undo') {
    const trackId = requireResolved(
      resolveTrackId(historyContext.refIndex, entry.data.track.trackRef) ?? resolveStoredTrackId(deps.getTracks(), entry.data.track.currentTrackId),
      'Track not found for track-clip-create undo',
    )
    await removeHistoryTrackOrThrow(deps, trackId, 'Failed to remove track during track-clip-create undo')
    deps.actions.removeLocalTrack(trackId)
    entry.data.track.currentTrackId = undefined
    entry.data.clip.currentId = undefined
    return
  }

  let trackId = resolveStoredTrackId(deps.getTracks(), entry.data.track.currentTrackId)
  let createdTrack = false
  if (!trackId) {
    trackId = await createHistoryTrack(deps, {
      trackRef: entry.data.track.trackRef,
      index: entry.data.track.index,
      kind: entry.data.track.kind,
      channelRole: entry.data.track.channelRole,
    })
    createdTrack = true
  }
  if (!trackId) throw new Error('Failed to recreate track')
  entry.data.track.currentTrackId = trackId
  deps.grantTrackWrite(trackId, grantScope)
  deps.actions.insertLocalTrack(createLocalTrack({
    id: trackId,
    historyRef: entry.data.track.trackRef,
    index: entry.data.track.index,
    kind: entry.data.track.kind ?? 'audio',
    channelRole: entry.data.track.channelRole ?? 'track',
  }), entry.data.track.index)

  try {
    const clipSnapshot = entry.data.clip
    const clipId = entry.data.clip.currentId || await createHistoryClip(deps, trackId, clipSnapshot)
    if (!clipId) throw new Error('Failed to recreate clip')
    entry.data.clip.currentId = clipId
    deps.grantClipWrite(clipId, grantScope)
    if (clipSnapshot.sampleUrl) {
      await deps.ensureClipBuffer?.(clipId, clipSnapshot.sampleUrl)
    }
    deps.actions.insertLocalClip(trackId, buildLocalClip({ id: clipId, clip: clipSnapshot }))
    deps.actions.rescheduleChangedClips([clipId])
  } catch (error) {
    if (createdTrack) {
      await removeHistoryTrackOrThrow(deps, trackId, 'Failed to roll back track during track-clip-create redo')
      deps.actions.removeLocalTrack(trackId)
      entry.data.track.currentTrackId = undefined
    }
    throw error
  }
}

export async function applyTrackDeleteEntry(
  entry: Extract<HistoryEntry, { type: 'track-delete' }>,
  deps: Deps,
  direction: HistoryDirection,
  historyContext: HistoryContext,
) {
  const { projectId, userId } = deps
  const grantScope = { projectId, userId }

  if (direction === 'redo') {
    const trackId = requireResolved(
      resolveTrackId(historyContext.refIndex, entry.data.track.trackRef) ?? resolveStoredTrackId(deps.getTracks(), entry.data.recreatedTrackId),
      'Track not found for track-delete redo',
    )
    await removeHistoryTrackOrThrow(deps, trackId, 'Failed to remove track during track-delete redo')
    deps.actions.removeLocalTrack(trackId)
    entry.data.recreatedTrackId = undefined
    entry.data.recreatedClips = []
    return
  }

  let newTrackId = resolveStoredTrackId(deps.getTracks(), entry.data.recreatedTrackId)
  let createdTrack = false
  if (!newTrackId) {
    newTrackId = await createHistoryTrack(deps, {
      trackRef: entry.data.track.trackRef,
      name: entry.data.track.name,
      index: entry.data.track.index,
      volume: entry.data.track.volume,
      muted: entry.data.track.muted,
      soloed: entry.data.track.soloed,
      kind: entry.data.track.kind,
      channelRole: entry.data.track.channelRole,
      sends: [],
    })
    createdTrack = true
  }
  if (!newTrackId) throw new Error('Failed to recreate deleted track')
  entry.data.recreatedTrackId = newTrackId
  deps.grantTrackWrite(newTrackId, grantScope)
  syncHistoryTrackCreateEntryId(deps.getHistoryEntries(), entry.data.track.trackRef, newTrackId)

  if (entry.data.track.volume !== undefined) {
    await persistHistoryTrackVolume(deps, newTrackId, entry.data.track.volume)
  }
  if (!isLocalHistoryProject(deps)) {
    await persistHistoryTrackMixState(deps, newTrackId, { muted: entry.data.track.muted, soloed: entry.data.track.soloed })
  }

  deps.actions.insertLocalTrack(createLocalTrack({
    id: newTrackId,
    historyRef: entry.data.track.trackRef,
    index: entry.data.track.index,
    name: entry.data.track.name,
    volume: entry.data.track.volume,
    clips: [],
    muted: entry.data.track.muted ?? false,
    soloed: entry.data.track.soloed ?? false,
    kind: entry.data.track.kind ?? 'audio',
    channelRole: entry.data.track.channelRole ?? 'track',
    sends: [],
    outputTargetId: undefined,
  }), entry.data.track.index)

  try {
    await persistHistoryTrackEffects(deps, newTrackId, entry.data.effects)

    const recreatedClipIdsByRef = new Map((entry.data.recreatedClips ?? []).map((item) => [item.clipRef, item.clipId]))
    const restoredClipIds: string[] = []
    for (const clip of entry.data.clips) {
      const clipRef = requireResolved(clip.clipRef, 'Missing clip reference for track-delete history entry')
      const clipSnapshot = clip
      const newId = recreatedClipIdsByRef.get(clipRef) || await createHistoryClip(deps, newTrackId, clipSnapshot)
      if (!newId) throw new Error('Failed to recreate deleted track clip')
      recreatedClipIdsByRef.set(clipRef, newId)
      deps.grantClipWrite(newId, grantScope)
      if (clipSnapshot.sampleUrl) {
        await deps.ensureClipBuffer?.(newId, clipSnapshot.sampleUrl)
      }
      deps.actions.insertLocalClip(newTrackId, buildLocalClip({ id: newId, clip: clipSnapshot }))
      restoredClipIds.push(newId)
    }
    if (restoredClipIds.length > 0) {
      deps.actions.rescheduleChangedClips(restoredClipIds)
    }
    entry.data.recreatedClips = Array.from(recreatedClipIdsByRef.entries()).map(([clipRef, clipId]) => ({ clipRef, clipId }))
    syncHistoryClipCreateEntryIds(deps.getHistoryEntries(), recreatedClipIdsByRef)

    const refreshedIndex = buildHistoryRefIndex(deps.getHistoryEntries(), deps.getTracks())
    const restoredTrack = deps.getTracks().find((track) => track.id === newTrackId)
    if (restoredTrack) {
      const ownRouting = normalizeTrackRouting(restoredTrack, resolveTrackRoutingSnapshot(refreshedIndex, entry.data.track.routing), deps.getTracks())
      await persistHistoryTrackRouting(deps, newTrackId, ownRouting)
      deps.actions.applyTrackRouting(newTrackId, ownRouting)
    }

    for (const inbound of entry.data.inboundRouting ?? []) {
      const sourceTrackId = resolveTrackId(refreshedIndex, inbound.sourceTrackRef)
      if (!sourceTrackId) continue
      const sourceTrack = deps.getTracks().find((track) => track.id === sourceTrackId)
      if (!sourceTrack) continue
      const merged = mergeTrackRouting(
        readCurrentTrackRouting(sourceTrack),
        resolveTrackRoutingSnapshot(refreshedIndex, inbound),
      )
      const normalized = normalizeTrackRouting(sourceTrack, merged, deps.getTracks())
      await persistHistoryTrackRouting(deps, sourceTrackId, normalized)
      deps.actions.applyTrackRouting(sourceTrackId, normalized)
    }
  } catch (error) {
    if (createdTrack) {
      await removeHistoryTrackOrThrow(deps, newTrackId, 'Failed to roll back track during track-delete undo')
      deps.actions.removeLocalTrack(newTrackId)
      entry.data.recreatedTrackId = undefined
      entry.data.recreatedClips = []
    }
    throw error
  }
}
