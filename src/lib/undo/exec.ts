import { buildClipCreatePayload, buildLocalClip, createManyClips } from '~/lib/clip-create'
import { buildClipMoveMutationInput, buildClipRemoveManyMutationInput } from '~/lib/clip-mutation-args'
import { buildTrackEffectMutationInput } from '~/lib/effect-track-args'
import { persistClipTiming } from '~/lib/clip-mutations'
import { setLocalEffect } from '~/lib/local-effects'
import { isLocalId } from '~/lib/local-ids'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { LocalMixPatch } from '~/lib/timeline-storage'
import { buildTrackRoutingMutationInput } from '~/lib/track-routing-state'
import { buildTrackCreateMutationInput, buildTrackDeleteMutationInput, buildTrackMixMutationInput, buildTrackVolumeMutationInput } from '~/lib/track-mutation-args'
import { normalizeTrackRouting } from '~/lib/track-routing'
import type { AudioEngine } from '~/lib/audio-engine'
import { createLocalTrack } from '~/lib/tracks'
import type { Track, TrackRouting } from '~/types/timeline'

import { buildHistoryRefIndex, resolveClipId, resolveStoredTrackId, resolveTrackId, resolveTrackRoutingSnapshot } from './refs'
import type { HistoryEntry } from './types'

type Deps = {
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
    commitClipTiming: (clipId: string, patch: { startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number }) => void
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

function syncTrackCreateEntryId(entries: HistoryEntry[], trackRef: string | undefined, trackId: Track['id']) {
  if (!trackRef) return
  for (const entry of entries) {
    if (entry.type === 'track-create' && entry.data.trackRef === trackRef) {
      entry.data.currentTrackId = trackId
    }
  }
}

function syncClipCreateEntryIds(entries: HistoryEntry[], clipIdsByRef: ReadonlyMap<string, string>) {
  if (clipIdsByRef.size === 0) return
  for (const entry of entries) {
    if (entry.type !== 'clip-create') continue
    const clipId = clipIdsByRef.get(entry.data.clip.clipRef)
    if (clipId) {
      entry.data.clip.currentId = clipId
    }
  }
}

function buildHistoryContext(deps: Deps) {
  const tracks = deps.getTracks()
  return {
    refIndex: buildHistoryRefIndex(deps.getHistoryEntries(), tracks),
    trackIdByClipId: buildTrackIdByClipId(tracks),
  }
}

function isLocalProject(deps: Deps) {
  return isLocalId('project', deps.projectId)
}

function toCreateClipInput(trackId: Track['id'], clip: Track['clips'][number]) {
  return {
    id: clip.id,
    historyRef: clip.historyRef,
    trackId,
    name: clip.name,
    startSec: clip.startSec,
    duration: clip.duration,
    color: clip.color,
    sourceAssetKey: clip.sourceAssetKey,
    sourceKind: clip.sourceKind,
    sourceDurationSec: clip.sourceDurationSec,
    sourceSampleRate: clip.sourceSampleRate,
    sourceChannelCount: clip.sourceChannelCount,
    leftPadSec: clip.leftPadSec,
    bufferOffsetSec: clip.bufferOffsetSec,
    sampleUrl: clip.sampleUrl,
    midi: clip.midi,
    midiOffsetBeats: clip.midiOffsetBeats,
  }
}

function requireResolved<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message)
  }
  return value
}

function buildTrackIdByClipId(tracks: Track[]) {
  const next = new Map<string, Track['id']>()
  for (const track of tracks) {
    for (const clip of track.clips) {
      next.set(clip.id, track.id)
    }
  }
  return next
}

async function removeClipIdsOrThrow(deps: Deps, clipIds: string[], message: string) {
  if (clipIds.length === 0) return
  if (isLocalProject(deps)) {
    const repo = createLocalTimelineRepository(deps.projectId)
    await repo.deleteClips(clipIds)
    return
  }
  const result = await deps.convexClient.mutation(
    deps.convexApi.clips.removeMany,
    buildClipRemoveManyMutationInput({ clipIds, userId: deps.userId }),
  )
  const removedIds = new Set(
    Array.isArray(result?.removedClipIds)
      ? result.removedClipIds.map((clipId: unknown) => String(clipId))
      : [],
  )
  if (clipIds.some((clipId) => !removedIds.has(String(clipId)))) {
    throw new Error(message)
  }
}

async function removeTrackOrThrow(deps: Deps, trackId: Track['id'], message: string) {
  if (isLocalProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).deleteTrack(trackId)
    return
  }
  const result = await deps.convexClient.mutation(
    deps.convexApi.tracks.remove,
    buildTrackDeleteMutationInput({ trackId, userId: deps.userId }),
  )
  if (result?.status !== 'deleted') {
    throw new Error(message)
  }
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

async function persistTrackRouting(
  convexClient: Deps['convexClient'],
  convexApi: Deps['convexApi'],
  userId: string,
  trackId: Track['id'],
  routing: TrackRouting,
) {
  await convexClient.mutation(
    convexApi.tracks.setRouting,
    buildTrackRoutingMutationInput({ trackId, userId, routing: { sends: routing.sends ?? [], outputTargetId: routing.outputTargetId } }),
  )
}

async function persistTrackMixState(
  convexClient: Deps['convexClient'],
  convexApi: Deps['convexApi'],
  userId: string,
  trackId: Track['id'],
  mix: { muted?: boolean; soloed?: boolean },
) {
  if (typeof mix.muted !== 'boolean' && typeof mix.soloed !== 'boolean') return
  await convexClient.mutation(convexApi.tracks.setMix, buildTrackMixMutationInput({
    trackId,
    userId,
    muted: mix.muted,
    soloed: mix.soloed,
  }))
}

async function applyTrackVolumeEntry(entry: Extract<HistoryEntry, { type: 'track-volume' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for track-volume history entry')
  const volume = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  deps.actions.cancelTrackVolumeWrite(trackId)
  if (isLocalProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({ trackId, volume })
  } else if (entry.data.scope === 'local') {
    deps.persistLocalMix(deps.projectId, trackId, { volume })
  } else {
    await deps.convexClient.mutation(
      deps.convexApi.tracks.setVolume,
      buildTrackVolumeMutationInput({ trackId, volume, userId: deps.userId }),
    )
  }
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
  if (isLocalProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({ trackId, ...patch })
  } else if (entry.data.scope !== 'local') {
    await persistTrackMixState(deps.convexClient, deps.convexApi, deps.userId, trackId, patch)
  } else {
    deps.persistLocalMix(deps.projectId, trackId, patch)
  }
  deps.actions.applyTrackMixState(trackId, patch, entry.data.scope)
}

async function applyTrackRoutingEntry(entry: Extract<HistoryEntry, { type: 'track-routing' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for track-routing history entry')
  const track = deps.getTracks().find((entryValue) => entryValue.id === trackId)
  const routing = resolveTrackRoutingSnapshot(index, pickDirectionalValue(direction, entry.data.from, entry.data.to))
  const normalizedRouting = track ? normalizeTrackRouting(track, routing, deps.getTracks()) : routing
  deps.actions.cancelTrackRoutingWrite(trackId)
  if (isLocalProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({
      trackId,
      outputTargetId: normalizedRouting.outputTargetId ?? null,
      sends: normalizedRouting.sends ?? [],
    })
  } else {
    await persistTrackRouting(deps.convexClient, deps.convexApi, deps.userId, trackId, normalizedRouting)
  }
  deps.actions.applyTrackRouting(trackId, normalizedRouting)
}

type EffectParamsEntry = Extract<HistoryEntry, { type: 'effect-params' }>

function readEffectTrackId(entry: EffectParamsEntry, deps: Deps) {
  const index = buildRefIndex(deps)
  return requireResolved(resolveTrackId(index, entry.data.trackRef), `Track not found for ${entry.data.effect} history entry`)
}

async function persistLocalEffectParams(entry: EffectParamsEntry, deps: Deps, direction: HistoryDirection) {
  const targetId = entry.data.effect === 'master-eq' || entry.data.effect === 'master-reverb'
    ? 'master'
    : readEffectTrackId(entry, deps)
  switch (entry.data.effect) {
    case 'master-eq': {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await setLocalEffect(deps.projectId, targetId, entry.data.effect, params)
      try { deps.audioEngine.setMasterEq(params) } catch {}
      return
    }
    case 'master-reverb': {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await setLocalEffect(deps.projectId, targetId, entry.data.effect, params)
      try { deps.audioEngine.setMasterReverb(params) } catch {}
      return
    }
    case 'eq': {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await setLocalEffect(deps.projectId, targetId, entry.data.effect, params)
      try { deps.audioEngine.setTrackEq(targetId, params) } catch {}
      return
    }
    case 'reverb': {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await setLocalEffect(deps.projectId, targetId, entry.data.effect, params)
      try { deps.audioEngine.setTrackReverb(targetId, params) } catch {}
      return
    }
    case 'synth': {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await setLocalEffect(deps.projectId, targetId, entry.data.effect, params)
      try { deps.audioEngine.setTrackSynth(targetId, params) } catch {}
      return
    }
    case 'arp': {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await setLocalEffect(deps.projectId, targetId, entry.data.effect, params)
      try { deps.audioEngine.setTrackArpeggiator(targetId, params) } catch {}
      return
    }
  }
}

async function applyEffectParamsEntry(entry: EffectParamsEntry, deps: Deps, direction: HistoryDirection) {
  if (isLocalProject(deps)) {
    await persistLocalEffectParams(entry, deps, direction)
    return
  }
  switch (entry.data.effect) {
    case 'master-eq': {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await deps.convexClient.mutation(deps.convexApi.effects.setMasterEqParams, { projectId: deps.projectId, userId: deps.userId, params })
      try { deps.audioEngine.setMasterEq(params) } catch {}
      return
    }
    case 'master-reverb': {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await deps.convexClient.mutation(deps.convexApi.effects.setMasterReverbParams, { projectId: deps.projectId, userId: deps.userId, params })
      try { deps.audioEngine.setMasterReverb(params) } catch {}
      return
    }
    case 'eq': {
      const trackId = readEffectTrackId(entry, deps)
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await deps.convexClient.mutation(
        deps.convexApi.effects.setEqParams,
        buildTrackEffectMutationInput({ projectId: deps.projectId, trackId, userId: deps.userId, params }),
      )
      try { deps.audioEngine.setTrackEq(trackId, params) } catch {}
      return
    }
    case 'reverb': {
      const trackId = readEffectTrackId(entry, deps)
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await deps.convexClient.mutation(
        deps.convexApi.effects.setReverbParams,
        buildTrackEffectMutationInput({ projectId: deps.projectId, trackId, userId: deps.userId, params }),
      )
      try { deps.audioEngine.setTrackReverb(trackId, params) } catch {}
      return
    }
    case 'synth': {
      const trackId = readEffectTrackId(entry, deps)
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await deps.convexClient.mutation(
        deps.convexApi.effects.setSynthParams,
        buildTrackEffectMutationInput({ projectId: deps.projectId, trackId, userId: deps.userId, params }),
      )
      try { deps.audioEngine.setTrackSynth(trackId, params) } catch {}
      return
    }
    case 'arp': {
      const trackId = readEffectTrackId(entry, deps)
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
      await deps.convexClient.mutation(
        deps.convexApi.effects.setArpeggiatorParams,
        buildTrackEffectMutationInput({ projectId: deps.projectId, trackId, userId: deps.userId, params }),
      )
      try { deps.audioEngine.setTrackArpeggiator(trackId, params) } catch {}
      return
    }
  }
}

async function applyClipTimingEntry(entry: Extract<HistoryEntry, { type: 'clip-timing' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const clipId = requireResolved(resolveClipId(index, entry.data.clipRef), 'Clip not found for clip-timing history entry')
  const timing = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  if (isLocalProject(deps)) {
    const applied = await createLocalTimelineRepository(deps.projectId).updateClip({
      clipId,
      startSec: timing.startSec,
      duration: timing.duration,
      leftPadSec: timing.leftPadSec,
      bufferOffsetSec: timing.bufferOffsetSec,
      midiOffsetBeats: timing.midiOffsetBeats,
    })
    if (!applied) throw new Error('Failed to apply local clip timing during history replay')
    deps.actions.commitClipTiming(clipId, timing)
    deps.actions.rescheduleChangedClips([clipId])
    return
  }
  const applied = await persistClipTiming(deps.convexClient, deps.convexApi, deps.userId, {
    clipId,
    startSec: timing.startSec,
    duration: timing.duration,
    leftPadSec: timing.leftPadSec ?? 0,
    bufferOffsetSec: timing.bufferOffsetSec ?? 0,
    midiOffsetBeats: timing.midiOffsetBeats ?? 0,
  })
  if (!applied) {
    throw new Error('Failed to apply clip timing during history replay')
  }
  deps.actions.commitClipTiming(clipId, timing)
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
  const pendingItems = items.filter((item) => !recreatedClipIdsByRef.has(item.clip.clipRef!))
  if (pendingItems.length > 0) {
    if (isLocalProject(deps)) {
      const repo = createLocalTimelineRepository(deps.projectId)
      for (const item of pendingItems) {
        const row = await repo.createClip(toCreateClipInput(item.trackId, buildLocalClip({ id: item.clip.clipRef!, clip: item.clip })))
        recreatedClipIdsByRef.set(item.clip.clipRef!, row.id)
      }
    } else {
      const created = await createManyClips({
        projectId: deps.projectId,
        userId: deps.userId,
        items: pendingItems,
        createMany: async (clipPayloads) => await deps.convexClient.mutation(deps.convexApi.clips.createMany, { items: clipPayloads }),
      })
      for (let indexValue = 0; indexValue < created.length; indexValue++) {
        recreatedClipIdsByRef.set(pendingItems[indexValue].clip.clipRef!, created[indexValue].clipId)
      }
    }
  }

  const perTrackAdds = new Map<Track['id'], Track['clips']>()
  for (const item of items) {
    const clipId = requireResolved(recreatedClipIdsByRef.get(item.clip.clipRef!), 'Missing recreated clip id')
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
  syncClipCreateEntryIds(deps.getHistoryEntries(), recreatedClipIdsByRef)
}

async function execHistoryEntry(entry: HistoryEntry, deps: Deps, direction: HistoryDirection) {
  if (entry.projectId !== deps.projectId) {
    throw new Error(`History entry room mismatch: expected ${deps.projectId}, received ${entry.projectId}`)
  }
  const { convexClient, convexApi, projectId, userId } = deps
  const grantScope = { projectId, userId }
  const historyContext = buildHistoryContext(deps)

  switch (entry.type) {
    case 'clip-create': {
      const index = historyContext.refIndex
      if (direction === 'undo') {
        const clipId = requireResolved(resolveClipId(index, entry.data.clip.clipRef) ?? entry.data.clip.currentId, 'Clip not found for clip-create undo')
        requireResolved(historyContext.trackIdByClipId.get(clipId) ?? resolveTrackId(index, entry.data.trackRef), 'Track not found for clip-create undo')
        await removeClipIdsOrThrow(deps, [clipId], 'Failed to remove clip during clip-create undo')
        deps.actions.removeLocalClips([clipId])
        entry.data.clip.currentId = undefined
        return
      }

      const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for clip-create redo')
      const existingId = entry.data.clip.currentId
      const clipSnapshot = entry.data.clip
      const newId = existingId || (isLocalProject(deps)
        ? (await createLocalTimelineRepository(projectId).createClip(toCreateClipInput(trackId, buildLocalClip({ id: clipSnapshot.clipRef!, clip: clipSnapshot })))).id
        : await convexClient.mutation(convexApi.clips.create, buildClipCreatePayload({ projectId, userId, trackId, clip: clipSnapshot })))
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
      await removeClipIdsOrThrow(deps, ids, 'Failed to remove clips during clip-delete redo')
      deps.actions.removeLocalClips(ids)
      entry.data.recreatedClips = []
      return
    }

    case 'clips-move': {
      const index = buildRefIndex(deps)
      const movedClipIds: string[] = []
      for (const move of entry.data.moves) {
        const clipId = requireResolved(resolveClipId(index, move.clipRef), 'Clip not found for clips-move history entry')
        const target = pickDirectionalValue(direction, move.from, move.to)
        const toTrackId = requireResolved(resolveTrackId(index, target.trackRef), 'Target track not found for clips-move history entry')
        if (isLocalProject(deps)) {
          const updated = await createLocalTimelineRepository(projectId).updateClip({ clipId, trackId: toTrackId, startSec: target.startSec })
          if (!updated) throw new Error('Failed to move local clip during history replay')
        } else {
          const result = await convexClient.mutation(
            convexApi.clips.move,
            buildClipMoveMutationInput({ clipId, userId, startSec: target.startSec, toTrackId }),
          )
          if (result?.status !== 'applied') {
            throw new Error('Failed to move clip during history replay')
          }
        }
        deps.actions.commitClipMoves([{ clipId, trackId: toTrackId, startSec: target.startSec }])
        movedClipIds.push(clipId)
      }
      deps.actions.rescheduleChangedClips(movedClipIds)
      return
    }

    case 'clip-timing':
      await applyClipTimingEntry(entry, deps, direction)
      return

    case 'track-create': {
      if (direction === 'undo') {
        const trackId = requireResolved(
          resolveTrackId(historyContext.refIndex, entry.data.trackRef) ?? resolveStoredTrackId(deps.getTracks(), entry.data.currentTrackId),
          'Track not found for track-create undo',
        )
        await removeTrackOrThrow(deps, trackId, 'Failed to remove track during track-create undo')
        deps.actions.removeLocalTrack(trackId)
        entry.data.currentTrackId = undefined
        return
      }

      let newId = resolveStoredTrackId(deps.getTracks(), entry.data.currentTrackId)
      if (!newId) {
        if (isLocalProject(deps)) {
          newId = (await createLocalTimelineRepository(projectId).createTrack({
            id: entry.data.trackRef,
            historyRef: entry.data.trackRef,
            index: entry.data.index,
            kind: entry.data.kind,
            channelRole: entry.data.channelRole,
          })).id as Track['id']
        } else {
          newId = await convexClient.mutation(
            convexApi.tracks.create,
            buildTrackCreateMutationInput({
              projectId,
              userId,
              index: entry.data.index,
              kind: entry.data.kind,
              channelRole: entry.data.channelRole,
            }),
          )
        }
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

    case 'track-delete': {
      if (direction === 'redo') {
        const trackId = requireResolved(
          resolveTrackId(historyContext.refIndex, entry.data.track.trackRef) ?? resolveStoredTrackId(deps.getTracks(), entry.data.recreatedTrackId),
          'Track not found for track-delete redo',
        )
        await removeTrackOrThrow(deps, trackId, 'Failed to remove track during track-delete redo')
        deps.actions.removeLocalTrack(trackId)
        entry.data.recreatedTrackId = undefined
        entry.data.recreatedClips = []
        return
      }

      let newTrackId = resolveStoredTrackId(deps.getTracks(), entry.data.recreatedTrackId)
      if (!newTrackId) {
        if (isLocalProject(deps)) {
          newTrackId = (await createLocalTimelineRepository(projectId).createTrack({
            id: entry.data.track.trackRef,
            historyRef: entry.data.track.trackRef,
            name: entry.data.track.name,
            index: entry.data.track.index,
            volume: entry.data.track.volume,
            muted: entry.data.track.muted,
            soloed: entry.data.track.soloed,
            kind: entry.data.track.kind,
            channelRole: entry.data.track.channelRole,
            sends: [],
          })).id as Track['id']
        } else {
          newTrackId = await convexClient.mutation(
            convexApi.tracks.create,
            buildTrackCreateMutationInput({
              projectId,
              userId,
              index: entry.data.track.index,
              kind: entry.data.track.kind,
              channelRole: entry.data.track.channelRole,
            }),
          )
        }
      }
      if (!newTrackId) throw new Error('Failed to recreate deleted track')
      entry.data.recreatedTrackId = newTrackId
      deps.grantTrackWrite(newTrackId, grantScope)
      syncTrackCreateEntryId(deps.getHistoryEntries(), entry.data.track.trackRef, newTrackId)
      if (!isLocalProject(deps)) {
        await convexClient.mutation(convexApi.tracks.setVolume, buildTrackVolumeMutationInput({ trackId: newTrackId, volume: entry.data.track.volume, userId }))
        await persistTrackMixState(convexClient, convexApi, userId, newTrackId, { muted: entry.data.track.muted, soloed: entry.data.track.soloed })
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

      if (!isLocalProject(deps)) {
        if (entry.data.effects?.eq) await convexClient.mutation(convexApi.effects.setEqParams, buildTrackEffectMutationInput({ projectId, trackId: newTrackId, userId, params: entry.data.effects.eq }))
        if (entry.data.effects?.reverb) await convexClient.mutation(convexApi.effects.setReverbParams, buildTrackEffectMutationInput({ projectId, trackId: newTrackId, userId, params: entry.data.effects.reverb }))
        if (entry.data.effects?.synth) await convexClient.mutation(convexApi.effects.setSynthParams, buildTrackEffectMutationInput({ projectId, trackId: newTrackId, userId, params: entry.data.effects.synth }))
        if (entry.data.effects?.arp) await convexClient.mutation(convexApi.effects.setArpeggiatorParams, buildTrackEffectMutationInput({ projectId, trackId: newTrackId, userId, params: entry.data.effects.arp }))
      } else {
        if (entry.data.effects?.eq) await setLocalEffect(projectId, newTrackId, 'eq', entry.data.effects.eq)
        if (entry.data.effects?.reverb) await setLocalEffect(projectId, newTrackId, 'reverb', entry.data.effects.reverb)
        if (entry.data.effects?.synth) await setLocalEffect(projectId, newTrackId, 'synth', entry.data.effects.synth)
        if (entry.data.effects?.arp) await setLocalEffect(projectId, newTrackId, 'arp', entry.data.effects.arp)
      }

      const recreatedClipIdsByRef = new Map((entry.data.recreatedClips ?? []).map((item) => [item.clipRef, item.clipId]))
      const restoredClipIds: string[] = []
      for (const clip of entry.data.clips) {
        const clipRef = requireResolved(clip.clipRef, 'Missing clip reference for track-delete history entry')
        const clipSnapshot = clip
        const newId = recreatedClipIdsByRef.get(clipRef) || (isLocalProject(deps)
          ? (await createLocalTimelineRepository(projectId).createClip(toCreateClipInput(newTrackId, buildLocalClip({ id: clipRef, clip: clipSnapshot })))).id
          : await convexClient.mutation(convexApi.clips.create, buildClipCreatePayload({ projectId, userId, trackId: newTrackId, clip: clipSnapshot })))
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
      syncClipCreateEntryIds(deps.getHistoryEntries(), recreatedClipIdsByRef)

      const refreshedIndex = buildRefIndex(deps)
      const restoredTrack = deps.getTracks().find((track) => track.id === newTrackId)
      if (restoredTrack) {
        const ownRouting = normalizeTrackRouting(restoredTrack, resolveTrackRoutingSnapshot(refreshedIndex, entry.data.track.routing), deps.getTracks())
        if (isLocalProject(deps)) {
          await createLocalTimelineRepository(projectId).updateTrack({ trackId: newTrackId, outputTargetId: ownRouting.outputTargetId ?? null, sends: ownRouting.sends ?? [] })
        } else {
          await persistTrackRouting(convexClient, convexApi, userId, newTrackId, ownRouting)
        }
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
        if (isLocalProject(deps)) {
          await createLocalTimelineRepository(projectId).updateTrack({ trackId: sourceTrackId, outputTargetId: normalized.outputTargetId ?? null, sends: normalized.sends ?? [] })
        } else {
          await persistTrackRouting(convexClient, convexApi, userId, sourceTrackId, normalized)
        }
        deps.actions.applyTrackRouting(sourceTrackId, normalized)
      }
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
