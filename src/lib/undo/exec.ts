import { buildClipCreatePayload, buildLocalClip, createManyClips } from '~/lib/clip-create'
import { persistClipTiming } from '~/lib/clip-mutations'
import { buildTrackRoutingMutationInput } from '~/lib/track-routing-state'
import { normalizeTrackRouting } from '~/lib/track-routing'
import { createLocalTrack } from '~/lib/tracks'
import type { TrackRouting } from '~/types/timeline'

import { buildHistoryRefIndex, resolveClipId, resolveTrackId, resolveTrackRoutingSnapshot } from './refs'
import type { HistoryEntry, ClipTiming } from './types'

type Deps = {
  convexClient: typeof import('~/lib/convex').convexClient
  convexApi: typeof import('~/lib/convex').convexApi
  setTracks: (updater: any) => void
  getTracks: () => any[]
  getHistoryEntries?: () => HistoryEntry[]
  roomId: string
  userId: string
  persistLocalMix: (roomId: string, trackId: string, patch: { volume?: number; muted?: boolean; soloed?: boolean }) => void
  audioEngine?: any
  grantTrackWrite?: (trackId: string) => void
  grantClipWrite?: (clipId: string) => void
}

type HistoryDirection = 'undo' | 'redo'

function pickDirectionalValue<T>(direction: HistoryDirection, from: T, to: T) {
  return direction === 'undo' ? from : to
}

function buildRefIndex(entry: HistoryEntry, deps: Deps) {
  return buildHistoryRefIndex(deps.getHistoryEntries?.() ?? [entry], deps.getTracks())
}

function requireResolved<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message)
  }
  return value
}

function findTrackIdForClip(clipId: string | undefined, tracks: any[]) {
  if (!clipId) return undefined
  for (const track of tracks) {
    if (track.clips.some((clip: any) => clip.id === clipId)) return track.id as string
  }
  return undefined
}

async function removeClipIdsOrThrow(deps: Deps, clipIds: string[], message: string) {
  if (clipIds.length === 0) return
  const result = await deps.convexClient.mutation((deps.convexApi as any).clips.removeMany, {
    clipIds: clipIds as any,
    userId: deps.userId as any,
  }) as any
  const removedIds = new Set(
    Array.isArray(result?.removedClipIds)
      ? result.removedClipIds.map((clipId: unknown) => String(clipId))
      : [],
  )
  if (clipIds.some((clipId) => !removedIds.has(String(clipId)))) {
    throw new Error(message)
  }
}

async function removeTrackOrThrow(deps: Deps, trackId: string, message: string) {
  const result = await deps.convexClient.mutation((deps.convexApi as any).tracks.remove, {
    trackId: trackId as any,
    userId: deps.userId,
  }) as any
  if (result?.status !== 'deleted') {
    throw new Error(message)
  }
}

function readCurrentTrackRouting(track: any): TrackRouting {
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

function applyLocalDeleteClip(setTracks: Deps['setTracks'], trackId: string, clipId: string) {
  setTracks((ts: any[]) => ts.map((track) => track.id !== trackId ? track : ({ ...track, clips: track.clips.filter((clip: any) => clip.id !== clipId) })))
}

function applyLocalAddClip(setTracks: Deps['setTracks'], trackId: string, clip: any) {
  setTracks((ts: any[]) => ts.map((track) => {
    if (track.id !== trackId) return track
    const existingIndex = track.clips.findIndex((entry: any) => entry.id === clip.id)
    const clips = existingIndex >= 0
      ? track.clips.map((entry: any, index: number) => index === existingIndex ? clip : entry)
      : [...track.clips, clip]
    clips.sort((left: any, right: any) => (left.startSec ?? 0) - (right.startSec ?? 0))
    return { ...track, clips }
  }))
}

function applyLocalMoveClip(setTracks: Deps['setTracks'], clipId: string, toTrackId: string, startSec: number) {
  setTracks((ts: any[]) => {
    let moving: any | null = null
    const pruned = ts.map((track) => {
      if (track.clips.some((clip: any) => clip.id === clipId)) {
        const found = track.clips.find((clip: any) => clip.id === clipId)
        moving = found ? { ...found } : null
        return { ...track, clips: track.clips.filter((clip: any) => clip.id !== clipId) }
      }
      return track
    })
    if (!moving) return ts
    moving.startSec = startSec
    return pruned.map((track) => {
      if (track.id !== toTrackId) return track
      const clips = [...track.clips, moving].sort((left: any, right: any) => (left.startSec ?? 0) - (right.startSec ?? 0))
      return { ...track, clips }
    })
  })
}

function applyLocalSetTiming(setTracks: Deps['setTracks'], clipId: string, timing: ClipTiming) {
  setTracks((ts: any[]) => ts.map((track) => ({
    ...track,
    clips: track.clips.map((clip: any) => clip.id !== clipId ? clip : ({
      ...clip,
      startSec: timing.startSec,
      duration: timing.duration,
      leftPadSec: timing.leftPadSec ?? clip.leftPadSec,
      bufferOffsetSec: timing.bufferOffsetSec ?? clip.bufferOffsetSec,
      midiOffsetBeats: timing.midiOffsetBeats ?? clip.midiOffsetBeats,
    })),
  })))
}

function applyLocalRemoveTrack(setTracks: Deps['setTracks'], trackId: string) {
  setTracks((ts: any[]) => ts
    .filter((track) => track.id !== trackId)
    .map((track) => ({
      ...track,
      outputTargetId: track.outputTargetId === trackId ? undefined : track.outputTargetId,
      sends: Array.isArray(track.sends) ? track.sends.filter((send: any) => send.targetId !== trackId) : track.sends,
    })))
}

function applyLocalTrackRouting(setTracks: Deps['setTracks'], trackId: string, routing: TrackRouting) {
  setTracks((ts: any[]) => ts.map((track) => track.id !== trackId ? track : ({ ...track, sends: routing.sends, outputTargetId: routing.outputTargetId })))
}

async function persistTrackRouting(
  convexClient: Deps['convexClient'],
  convexApi: Deps['convexApi'],
  userId: string,
  trackId: string,
  routing: TrackRouting,
) {
  await convexClient.mutation(
    (convexApi as any).tracks.setRouting,
    buildTrackRoutingMutationInput({ trackId, userId, routing: { sends: routing.sends ?? [], outputTargetId: routing.outputTargetId } }) as any,
  )
}

async function persistTrackMixState(
  convexClient: Deps['convexClient'],
  convexApi: Deps['convexApi'],
  userId: string,
  trackId: string,
  mix: { muted?: boolean; soloed?: boolean },
) {
  const payload: Record<string, unknown> = { trackId: trackId as any, userId }
  if (typeof mix.muted === 'boolean') payload.muted = mix.muted
  if (typeof mix.soloed === 'boolean') payload.soloed = mix.soloed
  if (!('muted' in payload) && !('soloed' in payload)) return
  await convexClient.mutation((convexApi as any).tracks.setMix, payload as any)
}

async function applyTrackVolumeEntry(entry: Extract<HistoryEntry, { type: 'track-volume' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(entry, deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for track-volume history entry')
  const volume = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  if (entry.data.scope === 'local') {
    deps.persistLocalMix(deps.roomId, trackId, { volume })
  } else {
    await deps.convexClient.mutation((deps.convexApi as any).tracks.setVolume, { trackId: trackId as any, volume, userId: deps.userId } as any)
  }
  deps.setTracks((ts: any[]) => ts.map((track) => track.id !== trackId ? track : ({ ...track, volume })))
}

async function applyTrackBooleanEntry(
  entry: Extract<HistoryEntry, { type: 'track-mute' | 'track-solo' }>,
  deps: Deps,
  direction: HistoryDirection,
) {
  const index = buildRefIndex(entry, deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), `Track not found for ${entry.type} history entry`)
  const value = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  if (entry.data.scope === 'local') {
    deps.persistLocalMix(deps.roomId, trackId, entry.type === 'track-mute' ? { muted: value } : { soloed: value })
  } else if (entry.type === 'track-mute') {
    await persistTrackMixState(deps.convexClient, deps.convexApi, deps.userId, trackId, { muted: value })
  } else {
    await persistTrackMixState(deps.convexClient, deps.convexApi, deps.userId, trackId, { soloed: value })
  }
  deps.setTracks((ts: any[]) => ts.map((track) => track.id !== trackId ? track : ({
    ...track,
    ...(entry.type === 'track-mute' ? { muted: value } : { soloed: value }),
  })))
}

async function applyTrackRoutingEntry(entry: Extract<HistoryEntry, { type: 'track-routing' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(entry, deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for track-routing history entry')
  const routing = resolveTrackRoutingSnapshot(index, pickDirectionalValue(direction, entry.data.from, entry.data.to))
  await persistTrackRouting(deps.convexClient, deps.convexApi, deps.userId, trackId, routing)
  applyLocalTrackRouting(deps.setTracks, trackId, routing)
}

type EffectParamsEntry = Extract<HistoryEntry, { type: 'effect-params' }>

type EffectParamsHandler = {
  persist: (deps: Deps, targetId: string, params: unknown) => Promise<unknown>
  apply: (deps: Deps, targetId: string, params: unknown) => void
}

const effectParamsHandlers: Record<EffectParamsEntry['data']['effect'], EffectParamsHandler> = {
  'master-eq': {
    persist: (deps, _targetId, params) => deps.convexClient.mutation((deps.convexApi as any).effects.setMasterEqParams, { roomId: deps.roomId, userId: deps.userId, params }),
    apply: (deps, _targetId, params) => { deps.audioEngine?.setMasterEq?.(params) },
  },
  'master-reverb': {
    persist: (deps, _targetId, params) => deps.convexClient.mutation((deps.convexApi as any).effects.setMasterReverbParams, { roomId: deps.roomId, userId: deps.userId, params }),
    apply: (deps, _targetId, params) => { deps.audioEngine?.setMasterReverb?.(params) },
  },
  eq: {
    persist: (deps, targetId, params) => deps.convexClient.mutation((deps.convexApi as any).effects.setEqParams, { roomId: deps.roomId, trackId: targetId as any, userId: deps.userId, params }),
    apply: (deps, targetId, params) => { deps.audioEngine?.setTrackEq?.(targetId, params) },
  },
  reverb: {
    persist: (deps, targetId, params) => deps.convexClient.mutation((deps.convexApi as any).effects.setReverbParams, { roomId: deps.roomId, trackId: targetId as any, userId: deps.userId, params }),
    apply: (deps, targetId, params) => { deps.audioEngine?.setTrackReverb?.(targetId, params) },
  },
  synth: {
    persist: (deps, targetId, params) => deps.convexClient.mutation((deps.convexApi as any).effects.setSynthParams, { roomId: deps.roomId, trackId: targetId as any, userId: deps.userId, params }),
    apply: (deps, targetId, params) => { deps.audioEngine?.setTrackSynth?.(targetId, params) },
  },
  arp: {
    persist: (deps, targetId, params) => deps.convexClient.mutation((deps.convexApi as any).effects.setArpeggiatorParams, { roomId: deps.roomId, trackId: targetId as any, userId: deps.userId, params }),
    apply: (deps, targetId, params) => { deps.audioEngine?.setTrackArpeggiator?.(targetId, params) },
  },
}

async function applyEffectParamsEntry(entry: EffectParamsEntry, deps: Deps, direction: HistoryDirection) {
  const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  const handler = effectParamsHandlers[entry.data.effect]
  if (entry.data.effect === 'master-eq' || entry.data.effect === 'master-reverb') {
    await handler.persist(deps, '', params)
    try { handler.apply(deps, '', params) } catch {}
    return
  }

  const index = buildRefIndex(entry, deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), `Track not found for ${entry.data.effect} history entry`)
  await handler.persist(deps, trackId, params)
  try { handler.apply(deps, trackId, params) } catch {}
}

async function applyClipTimingEntry(entry: Extract<HistoryEntry, { type: 'clip-timing' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(entry, deps)
  const clipId = requireResolved(resolveClipId(index, entry.data.clipRef), 'Clip not found for clip-timing history entry')
  const timing = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  await persistClipTiming(deps.convexClient, deps.convexApi, deps.userId, {
    clipId,
    startSec: timing.startSec,
    duration: timing.duration,
    leftPadSec: timing.leftPadSec ?? 0,
    bufferOffsetSec: timing.bufferOffsetSec ?? 0,
    midiOffsetBeats: timing.midiOffsetBeats ?? 0,
  })
  applyLocalSetTiming(deps.setTracks, clipId, timing)
  try { deps.audioEngine?.rescheduleClipsAtPlayhead?.(undefined, undefined, [clipId]) } catch {}
}

async function recreateDeletedClips(entry: Extract<HistoryEntry, { type: 'clip-delete' }>, deps: Deps) {
  const index = buildRefIndex(entry, deps)
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
    const created = await createManyClips({
      roomId: deps.roomId,
      userId: deps.userId,
      items: pendingItems,
      createMany: async (clipPayloads) => await deps.convexClient.mutation((deps.convexApi as any).clips.createMany, { items: clipPayloads }) as any as string[],
    })
    for (let indexValue = 0; indexValue < created.length; indexValue++) {
      recreatedClipIdsByRef.set(pendingItems[indexValue].clip.clipRef!, created[indexValue].clipId)
    }
  }

  const perTrackAdds = new Map<string, any[]>()
  for (const item of items) {
    const clipId = requireResolved(recreatedClipIdsByRef.get(item.clip.clipRef!), 'Missing recreated clip id')
    deps.grantClipWrite?.(clipId)
    const adds = perTrackAdds.get(item.trackId) ?? []
    adds.push(buildLocalClip({ id: clipId, clip: item.clip }))
    perTrackAdds.set(item.trackId, adds)
  }

  deps.setTracks((ts: any[]) => ts.map((track) => {
    const adds = perTrackAdds.get(track.id)
    if (!adds || adds.length === 0) return track
    const merged = [...track.clips, ...adds].sort((left: any, right: any) => (left.startSec ?? 0) - (right.startSec ?? 0))
    return { ...track, clips: merged }
  }))
  entry.data.recreatedClips = Array.from(recreatedClipIdsByRef.entries()).map(([clipRef, clipId]) => ({ clipRef, clipId }))
}

async function execHistoryEntry(entry: HistoryEntry, deps: Deps, direction: HistoryDirection) {
  const { convexClient, convexApi, setTracks, roomId, userId, audioEngine } = deps

  switch (entry.type) {
    case 'clip-create': {
      const index = buildRefIndex(entry, deps)
      if (direction === 'undo') {
        const clipId = requireResolved(entry.data.clip.currentId || resolveClipId(index, entry.data.clip.clipRef), 'Clip not found for clip-create undo')
        const trackId = requireResolved(findTrackIdForClip(clipId, deps.getTracks()) ?? resolveTrackId(index, entry.data.trackRef), 'Track not found for clip-create undo')
        await removeClipIdsOrThrow(deps, [clipId], 'Failed to remove clip during clip-create undo')
        if (trackId) applyLocalDeleteClip(setTracks, trackId, clipId)
        entry.data.clip.currentId = undefined
        return
      }

      const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for clip-create redo')
      const existingId = entry.data.clip.currentId
      const newId = existingId || await convexClient.mutation((convexApi as any).clips.create, buildClipCreatePayload({ roomId, userId, trackId, clip: entry.data.clip }) as any) as any as string
      if (!newId) throw new Error('Failed to recreate clip')
      entry.data.clip.currentId = newId
      deps.grantClipWrite?.(newId)
      applyLocalAddClip(setTracks, trackId, buildLocalClip({ id: newId, clip: entry.data.clip }))
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
      setTracks((ts: any[]) => ts.map((track) => ({ ...track, clips: track.clips.filter((clip: any) => !ids.includes(clip.id)) })))
      entry.data.recreatedClips = []
      return
    }

    case 'clips-move': {
      const index = buildRefIndex(entry, deps)
      const movedClipIds: string[] = []
      for (const move of entry.data.moves) {
        const clipId = requireResolved(resolveClipId(index, move.clipRef), 'Clip not found for clips-move history entry')
        const target = pickDirectionalValue(direction, move.from, move.to)
        const toTrackId = requireResolved(resolveTrackId(index, target.trackRef), 'Target track not found for clips-move history entry')
        await convexClient.mutation((convexApi as any).clips.move, { clipId: clipId as any, userId, startSec: target.startSec, toTrackId: toTrackId as any })
        applyLocalMoveClip(setTracks, clipId, toTrackId, target.startSec)
        movedClipIds.push(clipId)
      }
      try { audioEngine?.rescheduleClipsAtPlayhead?.(undefined, undefined, movedClipIds) } catch {}
      return
    }

    case 'clip-timing':
      await applyClipTimingEntry(entry, deps, direction)
      return

    case 'track-create': {
      if (direction === 'undo') {
        const trackId = requireResolved(entry.data.currentTrackId, 'Track not found for track-create undo')
        await removeTrackOrThrow(deps, trackId, 'Failed to remove track during track-create undo')
        applyLocalRemoveTrack(setTracks, trackId)
        entry.data.currentTrackId = undefined
        return
      }

      const newId = entry.data.currentTrackId || await convexClient.mutation((convexApi as any).tracks.create, { roomId, userId, index: entry.data.index, kind: entry.data.kind, channelRole: entry.data.channelRole } as any) as any as string
      if (!newId) throw new Error('Failed to recreate track')
      entry.data.currentTrackId = newId
      deps.grantTrackWrite?.(newId)
      setTracks((ts: any[]) => {
        if (ts.some((track) => track.id === newId)) return ts
        const track = createLocalTrack({
            id: newId,
            historyRef: entry.data.trackRef,
            index: entry.data.index,
            kind: entry.data.kind ?? 'audio',
            channelRole: entry.data.channelRole ?? 'track',
          })
        if (entry.data.index >= ts.length) return [...ts, track]
        return [...ts.slice(0, entry.data.index), track, ...ts.slice(entry.data.index)]
      })
      return
    }

    case 'track-delete': {
      if (direction === 'redo') {
        const trackId = requireResolved(entry.data.recreatedTrackId, 'Track not found for track-delete redo')
        await removeTrackOrThrow(deps, trackId, 'Failed to remove track during track-delete redo')
        applyLocalRemoveTrack(setTracks, trackId)
        entry.data.recreatedTrackId = undefined
        entry.data.recreatedClips = []
        return
      }

      const newTrackId = entry.data.recreatedTrackId || await convexClient.mutation((convexApi as any).tracks.create, { roomId, userId, index: entry.data.track.index, kind: entry.data.track.kind, channelRole: entry.data.track.channelRole } as any) as any as string
      if (!newTrackId) throw new Error('Failed to recreate deleted track')
      entry.data.recreatedTrackId = newTrackId
      deps.grantTrackWrite?.(newTrackId)
      await convexClient.mutation((convexApi as any).tracks.setVolume, { trackId: newTrackId as any, volume: entry.data.track.volume, userId } as any)
      await persistTrackMixState(convexClient, convexApi, userId, newTrackId, { muted: entry.data.track.muted, soloed: entry.data.track.soloed })

      setTracks((ts: any[]) => {
        if (ts.some((track) => track.id === newTrackId)) return ts
        const track = createLocalTrack({
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
          })
        if (entry.data.track.index >= ts.length) return [...ts, track]
        return [...ts.slice(0, entry.data.track.index), track, ...ts.slice(entry.data.track.index)]
      })

      if (entry.data.effects?.eq) await convexClient.mutation((convexApi as any).effects.setEqParams, { roomId, trackId: newTrackId as any, userId, params: entry.data.effects.eq })
      if (entry.data.effects?.reverb) await convexClient.mutation((convexApi as any).effects.setReverbParams, { roomId, trackId: newTrackId as any, userId, params: entry.data.effects.reverb })
      if (entry.data.effects?.synth) await convexClient.mutation((convexApi as any).effects.setSynthParams, { roomId, trackId: newTrackId as any, userId, params: entry.data.effects.synth })
      if (entry.data.effects?.arp) await convexClient.mutation((convexApi as any).effects.setArpeggiatorParams, { roomId, trackId: newTrackId as any, userId, params: entry.data.effects.arp })

      const recreatedClipIdsByRef = new Map((entry.data.recreatedClips ?? []).map((item) => [item.clipRef, item.clipId]))
      for (const clip of entry.data.clips) {
        const clipRef = requireResolved(clip.clipRef, 'Missing clip reference for track-delete history entry')
        const newId = recreatedClipIdsByRef.get(clipRef) || await convexClient.mutation((convexApi as any).clips.create, buildClipCreatePayload({ roomId, userId, trackId: newTrackId, clip }) as any) as any as string
        if (!newId) throw new Error('Failed to recreate deleted track clip')
        recreatedClipIdsByRef.set(clipRef, newId)
        deps.grantClipWrite?.(newId)
        applyLocalAddClip(setTracks, newTrackId, buildLocalClip({ id: newId, clip }))
      }
      entry.data.recreatedClips = Array.from(recreatedClipIdsByRef.entries()).map(([clipRef, clipId]) => ({ clipRef, clipId }))

      const refreshedIndex = buildRefIndex(entry, deps)
      const restoredTrack = deps.getTracks().find((track) => track.id === newTrackId)
      if (restoredTrack) {
        const ownRouting = normalizeTrackRouting(restoredTrack, resolveTrackRoutingSnapshot(refreshedIndex, entry.data.track.routing), deps.getTracks())
        await persistTrackRouting(convexClient, convexApi, userId, newTrackId, ownRouting)
        applyLocalTrackRouting(setTracks, newTrackId, ownRouting)
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
        await persistTrackRouting(convexClient, convexApi, userId, sourceTrackId, normalized)
        applyLocalTrackRouting(setTracks, sourceTrackId, normalized)
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
