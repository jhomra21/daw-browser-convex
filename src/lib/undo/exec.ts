import { buildLocalClip, createManyClips } from '~/lib/clip-create'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { buildSharedClipCreateManyOperation, publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import type { LocalMixPatch } from '~/lib/timeline-storage'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { normalizeReverbParams } from '@daw-browser/shared'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import { normalizeTrackRouting } from '@daw-browser/timeline-core/track-routing'
import { createLocalTrack } from '~/lib/tracks'
import type { Track, TrackRouting } from '@daw-browser/timeline-core/types'
import { applyTrackClipCreateEntry, applyTrackDeleteEntry } from './track-entry-executors'

import { buildHistoryRefIndex, resolveClipId, resolveStoredTrackId, resolveTrackId, resolveTrackRoutingSnapshot } from './refs'
import type { HistoryEntry } from './types'
import {
  isLocalHistoryProject,
  persistHistoryEffectParams,
  persistHistoryClipAudioWarpOrThrow,
  persistHistoryClipMovesOrThrow,
  persistHistoryClipTimingOrThrow,
  createHistoryClip,
  createHistoryTrack,
  persistHistoryTrackMix,
  persistHistoryTrackRouting,
  persistHistoryTrackVolume,
  removeHistoryClipIdsOrThrow,
  removeHistoryTrackOrThrow,
  syncHistoryClipCreateEntryIds,
} from './history-persistence'

export type Deps = {
  convexClient: typeof import('~/lib/convex').convexClient
  convexApi: typeof import('~/lib/convex').convexApi
  getTracks: () => Track[]
  getHistoryEntries: () => HistoryEntry[]
  projectId: string
  userId: string
  persistLocalMix: (projectId: string, trackId: Track['id'], patch: LocalMixPatch) => void
  audioEngine: AudioEngine
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>
  grantTrackWrite: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
  grantClipWrite: (clipId: string, scope?: OptimisticGrantScope | null) => void
  actions: {
    insertLocalTrack: (track: Track, index: number) => void
    removeLocalTrack: (trackId: Track['id']) => void
    insertLocalClip: (trackId: Track['id'], clip: Track['clips'][number]) => void
    removeLocalClips: (clipIds: Iterable<string>) => void
    commitClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
    commitClipTiming: (clipId: string, patch: Omit<Extract<HistoryEntry, { type: 'clip-timing' }>['data']['to'], 'audioWarp'>) => void
    commitClipAudioWarp: (clipId: string, audioWarp: Track['clips'][number]['audioWarp']) => void
    rescheduleChangedClips: (clipIds: string[]) => void
    cancelTrackVolumeWrite: (trackId: Track['id']) => void
    cancelTrackRoutingWrite: (trackId: Track['id']) => void
    cancelTrackMixWrite: (trackId: Track['id']) => void
    applyTrackVolume: (trackId: Track['id'], volume: number, scope?: 'local' | 'shared') => void
    applyTrackMixState: (trackId: Track['id'], patch: { muted?: boolean; soloed?: boolean }, scope?: 'local' | 'shared') => void
    applyTrackRouting: (trackId: Track['id'], routing: TrackRouting) => void
  }
}

type HistoryDirection = 'undo' | 'redo'

function pickDirectionalValue<T>(direction: HistoryDirection, from: T, to: T) {
  return direction === 'undo' ? from : to
}

function buildRefIndex(deps: Deps) {
  return buildHistoryRefIndex(deps.getHistoryEntries(), deps.getTracks())
}

function requireResolved<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message)
  }
  return value
}

async function applyTrackVolumeEntry(entry: Extract<HistoryEntry, { type: 'track-volume' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for track-volume history entry')
  const volume = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  deps.actions.cancelTrackVolumeWrite(trackId)
  await persistHistoryTrackVolume(deps, trackId, volume, entry.data.scope)
  deps.actions.applyTrackVolume(trackId, volume, entry.data.scope)
}

async function applyTrackBooleanEntry(
  entry: Extract<HistoryEntry, { type: 'track-mute' | 'track-solo' }>,
  deps: Deps,
  direction: HistoryDirection,
) {
  const index = buildRefIndex(deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), `Track not found for ${entry.type} history entry`)
  const value = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  const patch = entry.type === 'track-mute' ? { muted: value } : { soloed: value }
  deps.actions.cancelTrackMixWrite(trackId)
  await persistHistoryTrackMix(deps, trackId, patch, entry.data.scope)
  deps.actions.applyTrackMixState(trackId, patch, entry.data.scope)
}

async function applyTrackRoutingEntry(entry: Extract<HistoryEntry, { type: 'track-routing' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for track-routing history entry')
  const tracks = deps.getTracks()
  const track = requireResolved(tracks.find((entryValue) => entryValue.id === trackId), 'Track not found for track-routing history entry')
  const routing = resolveTrackRoutingSnapshot(index, pickDirectionalValue(direction, entry.data.from, entry.data.to))
  const normalizedRouting = normalizeTrackRouting(track, routing, tracks)
  deps.actions.cancelTrackRoutingWrite(trackId)
  await persistHistoryTrackRouting(deps, trackId, normalizedRouting)
  deps.actions.applyTrackRouting(trackId, normalizedRouting)
}

type EffectParamsEntry = Extract<HistoryEntry, { type: 'effect-params' }>

function readEffectTrackId(entry: EffectParamsEntry, deps: Deps) {
  const index = buildRefIndex(deps)
  return requireResolved(resolveTrackId(index, entry.data.trackRef), `Track not found for ${entry.data.effect} history entry`)
}

function applyEffectParamsToEngine(entry: EffectParamsEntry, deps: Deps, targetId: string, direction: HistoryDirection) {
  try {
    switch (entry.data.effect) {
      case 'master-eq': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setMasterEq(params)
        return
      }
      case 'master-reverb': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setMasterReverb(normalizeReverbParams(params))
        return
      }
      case 'master-saturator': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setMasterSaturator(params)
        return
      }
      case 'master-delay': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setMasterDelay(params)
        return
      }
      case 'eq': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setTrackEq(targetId, params)
        return
      }
      case 'reverb': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setTrackReverb(targetId, normalizeReverbParams(params))
        return
      }
      case 'saturator': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setTrackSaturator(targetId, params)
        return
      }
      case 'delay': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setTrackDelay(targetId, params)
        return
      }
      case 'synth': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setTrackSynth(targetId, params)
        return
      }
      case 'arp': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setTrackArpeggiator(targetId, params)
        return
      }
    }
  } catch {}
}

async function applyEffectParamsEntry(entry: EffectParamsEntry, deps: Deps, direction: HistoryDirection) {
  const targetId = entry.data.effect === 'master-eq' || entry.data.effect === 'master-reverb' || entry.data.effect === 'master-saturator' || entry.data.effect === 'master-delay'
    ? 'master'
    : readEffectTrackId(entry, deps)
  await persistHistoryEffectParams(deps, entry, targetId, direction)
  applyEffectParamsToEngine(entry, deps, targetId, direction)
}

async function applyClipTimingEntry(entry: Extract<HistoryEntry, { type: 'clip-timing' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const clipId = requireResolved(resolveClipId(index, entry.data.clipRef), 'Clip not found for clip-timing history entry')
  const timing = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  await persistHistoryClipTimingOrThrow(deps, clipId, timing, 'Failed to apply clip timing during history replay')
  deps.actions.commitClipTiming(clipId, timing)
  if (timing.audioWarp) deps.actions.commitClipAudioWarp(clipId, timing.audioWarp)
  deps.actions.rescheduleChangedClips([clipId])
}

async function applyClipAudioWarpEntry(entry: Extract<HistoryEntry, { type: 'clip-audio-warp' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const clipId = requireResolved(resolveClipId(index, entry.data.clipRef), 'Clip not found for clip-audio-warp history entry')
  const snapshot = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  await persistHistoryClipAudioWarpOrThrow(deps, clipId, snapshot.audioWarp, 'Failed to apply clip warp during history replay')
  deps.actions.commitClipAudioWarp(clipId, snapshot.audioWarp)
  deps.actions.rescheduleChangedClips([clipId])
}

async function recreateDeletedClips(entry: Extract<HistoryEntry, { type: 'clip-delete' }>, deps: Deps) {
  const grantScope = { projectId: deps.projectId, userId: deps.userId }
  const index = buildRefIndex(deps)
  const sourceItems = entry.data.items ?? []
  if (sourceItems.length === 0) return
  const items = sourceItems.map(({ trackRef, clip }) => {
    const trackId = requireResolved(resolveTrackId(index, trackRef), 'Track not found for clip-delete history entry')
    return {
      trackId,
      clip,
    }
  })

  const recreatedClipIdsByRef = new Map((entry.data.recreatedClips ?? []).map((item) => [item.clipRef, item.clipId]))
  const pendingItems = items.filter((item) => !recreatedClipIdsByRef.has(item.clip.clipRef))
  if (pendingItems.length > 0) {
    if (isLocalHistoryProject(deps)) {
      for (const item of pendingItems) {
        const clipId = await createHistoryClip(deps, item.trackId, item.clip)
        if (!clipId) throw new Error('Failed to recreate clip')
        recreatedClipIdsByRef.set(item.clip.clipRef, clipId)
      }
    } else {
      const created = await createManyClips({
        projectId: deps.projectId,
        items: pendingItems,
        createMany: async (clipPayloads, operationId) => {
          const result = await publishSharedTimelineOperation(
            deps.projectId,
            buildSharedClipCreateManyOperation({ items: clipPayloads }, operationId),
          )
          return Array.isArray(result) ? result.map((item) => typeof item === 'string' ? item : null) : []
        },
      })
      for (let indexValue = 0; indexValue < created.length; indexValue++) {
        recreatedClipIdsByRef.set(pendingItems[indexValue].clip.clipRef, created[indexValue].clipId)
      }
    }
  }

  const perTrackAdds = new Map<Track['id'], Track['clips']>()
  for (const item of items) {
    const clipId = requireResolved(recreatedClipIdsByRef.get(item.clip.clipRef), 'Missing recreated clip id')
    deps.grantClipWrite(clipId, grantScope)
    if (item.clip.sampleUrl) {
      await deps.ensureClipBuffer?.(clipId, item.clip.sampleUrl)
    }
    const adds = perTrackAdds.get(item.trackId) ?? []
    adds.push(buildLocalClip({ id: clipId, clip: item.clip }))
    perTrackAdds.set(item.trackId, adds)
  }

  for (const [trackId, adds] of perTrackAdds) {
    for (const clip of adds) {
      deps.actions.insertLocalClip(trackId, clip)
    }
  }
  const recreatedClipIds = Array.from(recreatedClipIdsByRef.values())
  if (recreatedClipIds.length > 0) {
    deps.actions.rescheduleChangedClips(recreatedClipIds)
  }
  entry.data.recreatedClips = Array.from(recreatedClipIdsByRef.entries()).map(([clipRef, clipId]) => ({ clipRef, clipId }))
  syncHistoryClipCreateEntryIds(deps.getHistoryEntries(), recreatedClipIdsByRef)
}

async function execHistoryEntry(entry: HistoryEntry, deps: Deps, direction: HistoryDirection) {
  if (entry.projectId !== deps.projectId) {
    throw new Error(`History entry room mismatch: expected ${deps.projectId}, received ${entry.projectId}`)
  }
  const { projectId, userId } = deps
  const grantScope = { projectId, userId }

  switch (entry.type) {
    case 'clip-create': {
      const index = buildRefIndex(deps)
      if (direction === 'undo') {
        const clipId = requireResolved(resolveClipId(index, entry.data.clip.clipRef) ?? entry.data.clip.currentId, 'Clip not found for clip-create undo')
        const trackIdByClipId = createTimelineTrackIndex(deps.getTracks()).clipTrackIdById
        requireResolved(trackIdByClipId.get(clipId) ?? resolveTrackId(index, entry.data.trackRef), 'Track not found for clip-create undo')
        await removeHistoryClipIdsOrThrow(deps, [clipId], 'Failed to remove clip during clip-create undo')
        deps.actions.removeLocalClips([clipId])
        entry.data.clip.currentId = undefined
        return
      }

      const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for clip-create redo')
      const existingId = entry.data.clip.currentId
      const clipSnapshot = entry.data.clip
      const newId = existingId || await createHistoryClip(deps, trackId, clipSnapshot)
      if (!newId) throw new Error('Failed to recreate clip')
      entry.data.clip.currentId = newId
      deps.grantClipWrite(newId, grantScope)
      if (clipSnapshot.sampleUrl) {
        await deps.ensureClipBuffer?.(newId, clipSnapshot.sampleUrl)
      }
      deps.actions.insertLocalClip(trackId, buildLocalClip({ id: newId, clip: clipSnapshot }))
      deps.actions.rescheduleChangedClips([newId])
      return
    }

    case 'clip-delete': {
      if (direction === 'undo') {
        await recreateDeletedClips(entry, deps)
        return
      }
      const ids = (entry.data.recreatedClips ?? []).map((item) => item.clipId)
      if (ids.length === 0) return
      await removeHistoryClipIdsOrThrow(deps, ids, 'Failed to remove clips during clip-delete redo')
      deps.actions.removeLocalClips(ids)
      entry.data.recreatedClips = []
      return
    }

    case 'clips-move': {
      const index = buildRefIndex(deps)
      const moves = entry.data.moves.map((move) => {
        const clipId = requireResolved(resolveClipId(index, move.clipRef), 'Clip not found for clips-move history entry')
        const target = pickDirectionalValue(direction, move.from, move.to)
        const toTrackId = requireResolved(resolveTrackId(index, target.trackRef), 'Target track not found for clips-move history entry')
        return { clipId, trackId: toTrackId, startSec: target.startSec }
      })
      await persistHistoryClipMovesOrThrow(deps, moves, 'Failed to move clip during history replay')
      deps.actions.commitClipMoves(moves)
      deps.actions.rescheduleChangedClips(moves.map((move) => move.clipId))
      return
    }

    case 'clip-timing':
      await applyClipTimingEntry(entry, deps, direction)
      return

    case 'clip-audio-warp':
      await applyClipAudioWarpEntry(entry, deps, direction)
      return

    case 'track-create': {
      if (direction === 'undo') {
        const index = buildRefIndex(deps)
        const trackId = requireResolved(
          resolveTrackId(index, entry.data.trackRef) ?? resolveStoredTrackId(deps.getTracks(), entry.data.currentTrackId),
          'Track not found for track-create undo',
        )
        await removeHistoryTrackOrThrow(deps, trackId, 'Failed to remove track during track-create undo')
        deps.actions.removeLocalTrack(trackId)
        entry.data.currentTrackId = undefined
        return
      }

      let newId = resolveStoredTrackId(deps.getTracks(), entry.data.currentTrackId)
      if (!newId) {
        newId = await createHistoryTrack(deps, {
          trackRef: entry.data.trackRef,
          index: entry.data.index,
          kind: entry.data.kind,
          channelRole: entry.data.channelRole,
        })
      }
      if (!newId) throw new Error('Failed to recreate track')
      entry.data.currentTrackId = newId
      deps.grantTrackWrite(newId, grantScope)
      deps.actions.insertLocalTrack(createLocalTrack({
        id: newId,
        historyRef: entry.data.trackRef,
        index: entry.data.index,
        kind: entry.data.kind ?? 'audio',
        channelRole: entry.data.channelRole ?? 'track',
      }), entry.data.index)
      return
    }

    case 'track-clip-create': {
      const historyContext = { refIndex: buildRefIndex(deps) }
      await applyTrackClipCreateEntry(entry, deps, direction, historyContext)
      return
    }

    case 'track-delete': {
      const historyContext = { refIndex: buildRefIndex(deps) }
      await applyTrackDeleteEntry(entry, deps, direction, historyContext)
      return
    }

    case 'track-volume':
      await applyTrackVolumeEntry(entry, deps, direction)
      return

    case 'track-mute':
    case 'track-solo':
      await applyTrackBooleanEntry(entry, deps, direction)
      return

    case 'track-routing':
      await applyTrackRoutingEntry(entry, deps, direction)
      return

    case 'effect-params':
      await applyEffectParamsEntry(entry, deps, direction)
      return
  }
}

export function execUndo(entry: HistoryEntry, deps: Deps) {
  return execHistoryEntry(entry, deps, 'undo')
}

export function execRedo(entry: HistoryEntry, deps: Deps) {
  return execHistoryEntry(entry, deps, 'redo')
}
