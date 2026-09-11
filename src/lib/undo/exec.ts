import { buildLocalClip } from '~/lib/clip-create'
import { isProjectControlError, isProjectControlRevisionConflict, type ProjectControlClient } from '~/lib/project-control-client'
import type { ControlActionV1, ControlCommitRequestV1 } from '@daw-browser/control'
import { flushMidiProjectWrites } from '~/lib/midi/editor-persistence'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import type { convexApi, convexClient } from '~/lib/convex'
import type { LocalMixPatch } from '~/lib/timeline-storage'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import {
  AUDIO_EFFECT_ORDER,
  assert,
  assertDefined,
  isJsonObject,
  isJsonString,
  trackCreationCollapsed,
  type AutomationEnvelope,
} from '@daw-browser/shared'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import { normalizeTrackRouting } from '@daw-browser/timeline-core/track-routing'
import { createLocalTrack } from '~/lib/tracks'
import type { Track, TrackRouting } from '@daw-browser/timeline-core/types'
import { applyTrackClipCreateEntry, applyTrackDeleteEntry } from './track-entry-executors'
import { flushSharedOutboxOperation, readQueuedClipDeletionRecoveryIds } from '~/lib/shared-outbox'

import { buildHistoryRefIndex, resolveClipId, resolveStoredTrackId, resolveTrackId, resolveTrackRoutingSnapshot } from './refs'
import type { EffectParamsByEffect, EffectType, HistoryEntry } from './types'
import {
  isLocalHistoryProject,
  persistHistoryEffectParams,
  persistHistoryAutomationEnvelope,
  persistHistoryClipAudioWarpOrThrow,
  persistHistoryClipFadesOrThrow,
  persistHistoryClipColorOrThrow,
  persistHistoryClipMovesOrThrow,
  persistHistoryClipTimingOrThrow,
  createHistoryClip,
  createHistoryTrack,
  persistHistoryTrackMix,
  persistHistoryTrackGroup,
  persistHistoryTrackColor,
  persistHistoryColorBatch,
  persistHistoryTrackReorder,
  persistHistoryUngroup,
  persistHistoryRestoreUngroup,
  persistHistoryTrackRouting,
  persistHistoryTrackVolume,
  rebaseTrackAutomationEnvelope,
  removeHistoryClipIdsOrThrow,
  removeHistoryTrackOrThrow,
  syncHistoryClipCreateEntryIds,
} from './history-persistence'
import type { createDrumRackBufferSync } from '~/lib/drum-rack-buffer-sync'

export type Deps = {
  convexClient: typeof convexClient
  convexApi: typeof convexApi
  getTracks: () => Track[]
  getHistoryEntries: () => HistoryEntry[]
  projectId: string
  userId: string
  persistLocalMix: (projectId: string, trackId: Track['id'], patch: LocalMixPatch) => void
  audioEngine: AudioEngine
  isCurrentScope?: () => boolean
  replayInstanceEffectParams?: <Effect extends EffectType>(payload: {
    targetId: string
    effect: Effect
    instanceId: string
    params: EffectParamsByEffect[Effect]
  }) => boolean
  drumRackBufferSync?: ReturnType<typeof createDrumRackBufferSync>
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>
  grantTrackWrite: (trackId: Track['id'], scope?: OptimisticGrantScope | null) => void
  grantClipWrite: (clipId: string, scope?: OptimisticGrantScope | null) => void
  persistHistory?: () => void
  controlClient?: ProjectControlClient
  actions: {
    insertLocalTrack: (track: Track, index: number) => void
    removeLocalTrack: (trackId: Track['id']) => void
    insertLocalClip: (trackId: Track['id'], clip: Track['clips'][number]) => void
    replaceLocalClip: (trackId: Track['id'], clip: Track['clips'][number]) => void
    removeLocalClips: (clipIds: Iterable<string>) => void
    commitClipMoves: (moves: Array<{ clipId: string; trackId: Track['id']; startSec: number }>) => void
    commitClipTiming: (clipId: string, patch: Omit<Extract<HistoryEntry, { type: 'clip-timing' }>['data']['to'], 'audioWarp'>) => void
    commitClipAudioWarp: (clipId: string, audioWarp: Track['clips'][number]['audioWarp']) => void
    commitClipFades: (clipId: string, fades: NonNullable<Track['clips'][number]['fades']>) => void
    rescheduleChangedClips: (clipIds: string[]) => void
    rescheduleTimeline?: () => void
    refreshLocalTimeline?: () => Promise<void>
    cancelTrackVolumeWrite: (trackId: Track['id']) => void
    cancelTrackRoutingWrite: (trackId: Track['id']) => void
    cancelTrackMixWrite: (trackId: Track['id']) => void
    applyTrackVolume: (trackId: Track['id'], volume: number, scope?: 'local' | 'shared') => void
    applyTrackMixState: (trackId: Track['id'], patch: { muted?: boolean; soloed?: boolean }, scope?: 'local' | 'shared') => void
    applyTrackRouting: (trackId: Track['id'], routing: TrackRouting) => void
    applyTrackPatch: (trackId: Track['id'], patch: Partial<Pick<Track, 'groupId' | 'outputTargetId' | 'color'>> & { index?: number }) => void
    applyAutomationEnvelope: (envelope: AutomationEnvelope | undefined, targetKey: string) => void
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
  return assertDefined(value, message)
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

async function applyTrackGroupEntry(entry: Extract<HistoryEntry, { type: 'track-group' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  if (direction === 'undo') {
    const groupTrackId = requireResolved(
      resolveTrackId(index, entry.data.groupTrackRef) ?? resolveStoredTrackId(deps.getTracks(), entry.data.currentGroupTrackId),
      'Group track not found for track-group undo',
    )
    for (const child of entry.data.childUpdates) {
      const trackId = requireResolved(resolveTrackId(index, child.trackRef), 'Child track not found for track-group undo')
      const previousGroupId = resolveTrackId(index, child.previousGroupRef)
      const previousOutputTargetId = resolveTrackId(index, child.previousOutputTargetRef)
      await persistHistoryTrackGroup(deps, trackId, previousGroupId, previousOutputTargetId)
      deps.actions.applyTrackPatch(trackId, { groupId: previousGroupId, outputTargetId: previousOutputTargetId })
    }
    await removeHistoryTrackOrThrow(deps, groupTrackId, 'Failed to remove group track during track-group undo')
    deps.actions.removeLocalTrack(groupTrackId)
    entry.data.currentGroupTrackId = undefined
    return
  }

  let groupTrackId = resolveTrackId(index, entry.data.groupTrackRef) ?? resolveStoredTrackId(deps.getTracks(), entry.data.currentGroupTrackId)
  let groupTrackIndex = entry.data.groupTrack.index
  if (!groupTrackId) {
    const createdTrack = await createHistoryTrack(deps, {
      trackRef: entry.data.groupTrackRef,
      index: entry.data.groupTrack.index,
      name: entry.data.groupTrack.name,
      channelRole: 'group',
      color: entry.data.groupTrack.color,
    })
    groupTrackId = createdTrack.trackId
    groupTrackIndex = createdTrack.index
  }
  groupTrackId = assertDefined(groupTrackId, 'Failed to recreate group track')
  entry.data.currentGroupTrackId = groupTrackId
  deps.grantTrackWrite(groupTrackId, { projectId: deps.projectId, userId: deps.userId })
  deps.actions.insertLocalTrack(createLocalTrack({
    id: groupTrackId,
    historyRef: entry.data.groupTrackRef,
    index: groupTrackIndex,
    name: entry.data.groupTrack.name,
    channelRole: 'group',
    color: entry.data.groupTrack.color,
  }), groupTrackIndex)
  const childRefIndex = buildRefIndex(deps)
  for (const child of entry.data.childUpdates) {
    const trackId = requireResolved(resolveTrackId(childRefIndex, child.trackRef), 'Child track not found for track-group redo')
    const outputTargetId = resolveTrackId(childRefIndex, child.nextOutputTargetRef) ?? groupTrackId
    await persistHistoryTrackGroup(deps, trackId, groupTrackId, outputTargetId)
    deps.actions.applyTrackPatch(trackId, { groupId: groupTrackId, outputTargetId })
  }
}

async function applyTrackUngroupEntry(entry: Extract<HistoryEntry, { type: 'track-ungroup' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  if (direction === 'undo') {
    const groupSnapshot = requireResolved(entry.data.groupTrack, 'Cannot restore legacy track-ungroup history entry')
    const sourceGroupTrackId = requireResolved(entry.data.sourceGroupTrackId, 'Cannot restore legacy track-ungroup history entry')
    const parentGroupId = resolveTrackId(index, groupSnapshot.groupRef)
    const routing = resolveTrackRoutingSnapshot(index, groupSnapshot.routing)
    const children = entry.data.childSnapshots.map((child) => ({
      trackId: requireResolved(resolveTrackId(index, child.trackRef), 'Child track not found for track-ungroup undo'),
      outputTargetId: resolveTrackId(index, child.previousOutputTargetRef),
      outputToGroup: child.previousOutputTargetRef === entry.data.groupTrackRef,
    }))
    const sidechainRoutes = (entry.data.sidechainRoutes ?? []).flatMap((route) => {
      const sourceTrackId = route.sourceTrackRef === entry.data.groupTrackRef
        ? undefined
        : resolveTrackId(index, route.sourceTrackRef)
      const targetTrackId = route.targetTrackRef === entry.data.groupTrackRef
        ? undefined
        : resolveTrackId(index, route.targetTrackRef)
      if (
        (route.sourceTrackRef !== entry.data.groupTrackRef && !sourceTrackId)
        || (route.targetTrackRef !== entry.data.groupTrackRef && !targetTrackId)
      ) return []
      return [{ sourceTrackId, targetTrackId, effectInstanceId: route.effectInstanceId }]
    })
    const groupTrackId = await persistHistoryRestoreUngroup(deps, {
      groupId: sourceGroupTrackId,
      operationId: entry.data.restoreOperationId,
      group: {
        trackRef: groupSnapshot.trackRef,
        name: groupSnapshot.name,
        index: groupSnapshot.index,
        volume: groupSnapshot.volume,
        muted: groupSnapshot.muted,
        soloed: groupSnapshot.soloed,
        kind: groupSnapshot.kind,
        channelRole: groupSnapshot.channelRole,
        parentGroupId,
        collapsed: groupSnapshot.collapsed,
        color: groupSnapshot.color,
        routing: { outputTargetId: routing.outputTargetId, sends: routing.sends ?? [] },
      },
      children,
      effects: entry.data.effects,
      automation: entry.data.automation,
      sidechainRoutes,
    })
    entry.data.currentGroupTrackId = groupTrackId
    deps.grantTrackWrite(groupTrackId, { projectId: deps.projectId, userId: deps.userId })
    deps.actions.insertLocalTrack(createLocalTrack({
      id: groupTrackId,
      historyRef: entry.data.groupTrackRef,
      index: groupSnapshot.index,
      name: groupSnapshot.name,
      volume: groupSnapshot.volume,
      muted: groupSnapshot.muted,
      soloed: groupSnapshot.soloed,
      kind: groupSnapshot.kind,
      channelRole: 'group',
      groupId: parentGroupId,
      collapsed: groupSnapshot.collapsed,
      color: groupSnapshot.color,
      sends: routing.sends,
      outputTargetId: routing.outputTargetId,
    }), groupSnapshot.index)
    for (const child of children) {
      deps.actions.applyTrackPatch(child.trackId, {
        groupId: groupTrackId,
        outputTargetId: child.outputToGroup ? groupTrackId : child.outputTargetId,
      })
    }
    for (const envelope of entry.data.automation ?? []) {
      const rebased = rebaseTrackAutomationEnvelope(envelope, groupTrackId)
      deps.actions.applyAutomationEnvelope(rebased, rebased.targetKey)
    }
    return
  }

  const groupTrackId = requireResolved(
    resolveTrackId(index, entry.data.groupTrackRef) ?? resolveStoredTrackId(deps.getTracks(), entry.data.currentGroupTrackId),
    'Group track not found for track-ungroup redo',
  )
  await persistHistoryUngroup(deps, groupTrackId)
  entry.data.restoreOperationId = crypto.randomUUID()
  for (const envelope of entry.data.automation ?? []) {
    const rebased = rebaseTrackAutomationEnvelope(envelope, groupTrackId)
    deps.actions.applyAutomationEnvelope(undefined, rebased.targetKey)
  }
  const parentGroupId = resolveTrackId(index, entry.data.groupTrack?.groupRef)
  for (const child of entry.data.childSnapshots) {
    const trackId = requireResolved(resolveTrackId(index, child.trackRef), 'Child track not found for track-ungroup redo')
    const outputTargetId = resolveTrackId(index, child.nextOutputTargetRef)
    deps.actions.applyTrackPatch(trackId, { groupId: parentGroupId, outputTargetId })
  }
  deps.actions.removeLocalTrack(groupTrackId)
  entry.data.currentGroupTrackId = undefined
}

async function applyTrackColorEntry(entry: Extract<HistoryEntry, { type: 'track-color' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for track-color history entry')
  const color = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  await persistHistoryTrackColor(deps, trackId, color)
  deps.actions.applyTrackPatch(trackId, { color })
}

async function applyTrackColorCascadeEntry(entry: Extract<HistoryEntry, { type: 'track-color-cascade' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const tracks = entry.data.tracks.map((update) => ({
    trackId: requireResolved(resolveTrackId(index, update.trackRef), 'Track not found for track-color-cascade history entry'),
    color: pickDirectionalValue(direction, update.from, update.to),
  }))
  const clips = entry.data.clips.map((update) => ({
    clipId: requireResolved(resolveClipId(index, update.clipRef), 'Clip not found for track-color-cascade history entry'),
    color: requireResolved(pickDirectionalValue(direction, update.from, update.to), 'Missing clip color for track-color-cascade history entry'),
  }))
  await persistHistoryColorBatch(deps, { tracks, clips })
  const trackIndex = createTimelineTrackIndex(deps.getTracks())
  for (const update of tracks) {
    deps.actions.applyTrackPatch(update.trackId, { color: update.color })
  }
  for (const update of clips) {
    const entry = trackIndex.clipEntryById.get(update.clipId)
    if (entry) deps.actions.replaceLocalClip(entry.trackId, { ...entry.clip, color: update.color })
  }
}

async function applyTrackReorderEntry(entry: Extract<HistoryEntry, { type: 'track-reorder' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const currentTracks = deps.getTracks()
  const patches = entry.data.patches.map((patch) => {
    const trackId = requireResolved(resolveTrackId(index, patch.trackRef), 'Track not found for track-reorder history entry')
    return {
      trackId,
      index: pickDirectionalValue(direction, patch.fromIndex, patch.toIndex),
      groupId: resolveTrackId(index, pickDirectionalValue(direction, patch.fromGroupRef, patch.toGroupRef)) ?? null,
      outputTargetId: resolveTrackId(index, pickDirectionalValue(direction, patch.fromOutputTargetRef, patch.toOutputTargetRef)) ?? null,
    }
  })
  const patchById = new Map(patches.map((patch) => [patch.trackId, patch]))
  const updates = currentTracks.map((track, trackIndex) => {
    const patch = patchById.get(track.id)
    return {
      trackId: track.id,
      index: patch?.index ?? trackIndex,
      groupId: patch ? patch.groupId : track.groupId ?? null,
      outputTargetId: patch ? patch.outputTargetId : track.outputTargetId ?? null,
    }
  })
  await persistHistoryTrackReorder(deps, updates)
  for (const patch of patches) {
    deps.actions.applyTrackPatch(patch.trackId, {
      index: patch.index,
      groupId: patch.groupId ?? undefined,
      outputTargetId: patch.outputTargetId ?? undefined,
    })
  }
}

type EffectParamsEntry = Extract<HistoryEntry, { type: 'effect-params' }>

function readEffectTrackId(entry: EffectParamsEntry, deps: Deps) {
  const index = buildRefIndex(deps)
  return requireResolved(resolveTrackId(index, entry.data.trackRef), `Track not found for ${entry.data.effect} history entry`)
}

function applyEffectParamsToEngine(entry: EffectParamsEntry, deps: Deps, targetId: string, direction: HistoryDirection) {
  if (deps.isCurrentScope && !deps.isCurrentScope()) return
  try {
    const replayParams = pickDirectionalValue(direction, entry.data.from, entry.data.to)
    if (entry.data.instanceId && deps.replayInstanceEffectParams?.({
      targetId,
      effect: entry.data.effect,
      instanceId: entry.data.instanceId,
      params: replayParams,
    })) return
    switch (entry.data.effect) {
      case 'master-eq':
      case 'master-reverb':
      case 'master-compressor':
      case 'master-saturator':
      case 'master-delay':
      case 'master-spectral':
      case 'eq':
      case 'reverb':
      case 'compressor':
      case 'saturator':
      case 'delay':
      case 'spectral': {
        const instanceId = entry.data.instanceId
        if (!instanceId) throw new Error(`Missing effect instance ID for ${entry.data.effect} history entry.`)
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        if (!deps.replayInstanceEffectParams?.({ targetId, effect: entry.data.effect, instanceId, params })) {
          throw new Error(`Unable to replay effect instance ${instanceId}.`)
        }
        return
      }
      case 'synth': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        deps.audioEngine.setTrackSynth(targetId, params)
        return
      }
      case 'instrument': {
        const params = pickDirectionalValue(direction, entry.data.from, entry.data.to)
        if (params.kind === 'synth') deps.audioEngine.setTrackInstrument(targetId, { instrument: params })
        else if (params.kind === 'drum-rack' && deps.drumRackBufferSync && deps.isCurrentScope?.() !== false) deps.drumRackBufferSync.syncTrack(deps.audioEngine, targetId, params.params, params.instanceId)
        else if (params.kind === 'drum-rack') deps.audioEngine.setTrackInstrument(targetId, { instrument: params })
        else if (params.kind === 'sampler') deps.audioEngine.setTrackSampler(targetId, params.params, undefined, params.instanceId)
        else void deps.audioEngine.setTrackGranular(targetId, params.params, undefined, params.instanceId)
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

const MASTER_EFFECT_TYPES: ReadonlySet<EffectType> = new Set(
  AUDIO_EFFECT_ORDER.map((effect): EffectType => `master-${effect}`),
)

async function applyEffectParamsEntry(entry: EffectParamsEntry, deps: Deps, direction: HistoryDirection) {
  const targetId = MASTER_EFFECT_TYPES.has(entry.data.effect)
    ? 'master'
    : readEffectTrackId(entry, deps)
  await persistHistoryEffectParams(deps, entry, targetId, direction)
  applyEffectParamsToEngine(entry, deps, targetId, direction)
}

async function applyAutomationEnvelopeEntry(entry: Extract<HistoryEntry, { type: 'automation-envelope-change' }>, deps: Deps, direction: HistoryDirection) {
  await persistHistoryAutomationEnvelope(deps, entry, direction)
  const envelope = pickDirectionalValue(direction, entry.data.before, entry.data.after)
  const targetKey = envelope?.targetKey ?? entry.data.before?.targetKey ?? entry.data.after?.targetKey
  if (targetKey) deps.actions.applyAutomationEnvelope(envelope ?? undefined, targetKey)
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

async function applyClipFadesEntry(entry: Extract<HistoryEntry, { type: 'clip-fades' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const clipId = requireResolved(resolveClipId(index, entry.data.clipRef), 'Clip not found for clip-fades history entry')
  const fades = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  await persistHistoryClipFadesOrThrow(deps, clipId, fades, 'Failed to apply clip fades during history replay')
  deps.actions.commitClipFades(clipId, fades)
  deps.actions.rescheduleChangedClips([clipId])
}

async function applyClipColorEntry(entry: Extract<HistoryEntry, { type: 'clip-color' }>, deps: Deps, direction: HistoryDirection) {
  const index = buildRefIndex(deps)
  const clipId = requireResolved(resolveClipId(index, entry.data.clipRef), 'Clip not found for clip-color history entry')
  const color = pickDirectionalValue(direction, entry.data.from, entry.data.to)
  await persistHistoryClipColorOrThrow(deps, clipId, color, 'Failed to apply clip color during history replay')
  const track = deps.getTracks().find((track) => track.clips.some((clip) => clip.id === clipId))
  const clip = track?.clips.find((clip) => clip.id === clipId)
  if (track && clip && color) deps.actions.replaceLocalClip(track.id, { ...clip, color })
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
  if (!isLocalHistoryProject(deps)) {
    const persistedRecoveryIdsByOperation = new Map<string, Map<string, string>>()
    for (const item of items) {
      const { recoveryId, recoveryOperationId, recoverySourceClipId } = item.clip
      if (recoveryId || !recoveryOperationId || !recoverySourceClipId) continue
      let recoveryIds = persistedRecoveryIdsByOperation.get(recoveryOperationId)
      if (!recoveryIds) {
        recoveryIds = readQueuedClipDeletionRecoveryIds(deps.projectId, deps.userId, recoveryOperationId)
        persistedRecoveryIdsByOperation.set(recoveryOperationId, recoveryIds)
      }
      const persistedRecoveryId = recoveryIds.get(recoverySourceClipId)
      if (persistedRecoveryId) item.clip.recoveryId = persistedRecoveryId
    }
    const pendingOperationIds = new Set(
      items.flatMap((item) => item.clip.recoveryId || !item.clip.recoveryOperationId ? [] : [item.clip.recoveryOperationId]),
    )
    for (const operationId of pendingOperationIds) {
      const flushed = await flushSharedOutboxOperation(deps.projectId, deps.userId, operationId)
      if (flushed.status !== 'applied') {
        throw new Error('Cloud clip deletion recovery is still pending.')
      }
      const recoveryIds = readQueuedClipDeletionRecoveryIds(deps.projectId, deps.userId, operationId)
      if (isJsonObject(flushed.result) && Array.isArray(flushed.result.recoveries)) {
        for (const recovery of flushed.result.recoveries) {
          if (
            isJsonObject(recovery)
            && isJsonString(recovery.sourceClipId)
            && isJsonString(recovery.recoveryId)
          ) recoveryIds.set(recovery.sourceClipId, recovery.recoveryId)
        }
      }
      for (const item of items) {
        if (item.clip.recoveryOperationId !== operationId || !item.clip.recoverySourceClipId) continue
        const recoveryId = recoveryIds.get(item.clip.recoverySourceClipId)
        if (!recoveryId) throw new Error('Cloud clip deletion recovery is still pending.')
        item.clip.recoveryId = recoveryId
      }
    }
  }

  const recreatedClipIdsByRef = new Map((entry.data.recreatedClips ?? []).map((item) => [item.clipRef, item.clipId]))
  const pendingItems = items.filter((item) => !recreatedClipIdsByRef.has(item.clip.clipRef))
  if (pendingItems.length > 0) {
    if (isLocalHistoryProject(deps)) {
      for (const item of pendingItems) {
        const clipId = assertDefined(
          await createHistoryClip(deps, item.trackId, item.clip),
          'Failed to recreate clip',
        )
        recreatedClipIdsByRef.set(item.clip.clipRef, clipId)
      }
    } else {
      for (const item of pendingItems) {
        if (!item.clip.recoveryId) {
          if (!entry.data.legacyRecreate) {
            throw new Error('Cloud clip deletion history is missing its recovery descriptor.')
          }
          const clipId = assertDefined(
            await createHistoryClip(deps, item.trackId, item.clip),
            'Failed to recreate legacy cloud clip',
          )
          recreatedClipIdsByRef.set(item.clip.clipRef, clipId)
          continue
        }
        const result = await deps.convexClient.mutation(deps.convexApi.clips.restoreDeleted, {
          recoveryId: item.clip.recoveryId,
        })
        if (
          (result.status !== 'applied' && result.status !== 'noop')
          || !isJsonString(result.clipId)
        ) {
          throw new Error('Failed to restore deleted cloud clip.')
        }
        recreatedClipIdsByRef.set(item.clip.clipRef, result.clipId)
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

async function applyControlRangeDeleteEntry(
  entry: Extract<HistoryEntry, { type: 'control-range-delete' }>,
  deps: Deps,
  direction: HistoryDirection,
) {
  const control = requireResolved(deps.controlClient, 'Control client is unavailable for range deletion history.')
  await flushMidiProjectWrites(deps.projectId)
  if (direction === 'undo') {
    if (entry.data.restoreOperationId === undefined || entry.data.restoreExpectedRevision === undefined) {
      const snapshot = await control.snapshotV2()
      entry.data.restoreOperationId = crypto.randomUUID()
      entry.data.restoreExpectedRevision = snapshot.project.revision
      deps.persistHistory?.()
    }
    const restoreRequest = (): ControlCommitRequestV1 => ({
      version: 'v1',
      projectId: deps.projectId,
      expectedRevision: entry.data.restoreExpectedRevision,
      idempotencyKey: entry.data.restoreOperationId!,
      actions: [{ kind: 'recovery.restore', recovery: { id: entry.data.recoveryId } }],
    })
    let restored
    try {
      restored = await control.commitV1(restoreRequest())
    } catch (error) {
      if (isProjectControlRevisionConflict(error)) {
        entry.data.restoreOperationId = undefined
        entry.data.restoreExpectedRevision = undefined
        const snapshot = await control.snapshotV2()
        entry.data.restoreOperationId = crypto.randomUUID()
        entry.data.restoreExpectedRevision = snapshot.project.revision
        deps.persistHistory?.()
        try {
          restored = await control.commitV1(restoreRequest())
        } catch (retryError) {
          if (isProjectControlRevisionConflict(retryError)) {
            entry.data.restoreOperationId = undefined
            entry.data.restoreExpectedRevision = undefined
            deps.persistHistory?.()
          }
          throw retryError
        }
      } else if (isProjectControlError(error)) {
        throw error
      } else {
        restored = await control.commitV1(restoreRequest())
      }
    }
    if (!restored.applied) throw new Error('Range deletion undo did not restore the project.')
    entry.data.restoreOperationId = undefined
    entry.data.restoreExpectedRevision = undefined
    deps.persistHistory?.()
    if (isLocalHistoryProject(deps)) await deps.actions.refreshLocalTimeline?.()
    deps.actions.rescheduleTimeline?.()
    return
  }

  const index = buildRefIndex(deps)
  const trackIds = entry.data.trackRefs.map((trackRef) => (
    requireResolved(resolveTrackId(index, trackRef), 'Track not found for range deletion history')
  ))
  const action: Extract<ControlActionV1, { kind: 'timeline.range.delete' }> = {
    kind: 'timeline.range.delete',
    tracks: trackIds.map((id) => ({ source: 'persisted', id })),
    startSec: entry.data.startSec,
    endSec: entry.data.endSec,
  }
  if (
    entry.data.deleteOperationId === undefined
    || entry.data.deleteExpectedRevision === undefined
    || entry.data.deleteApprovalToken === undefined
  ) {
    const snapshot = await control.snapshotV2()
    const preview = await control.previewV1({
      version: 'v1',
      projectId: deps.projectId,
      expectedRevision: snapshot.project.revision,
      actions: [action],
    })
    if (!preview.applied) throw new Error('Range deletion redo did not change the project.')
    const approval = await control.requestApprovalV1({
      version: 'v1',
      projectId: deps.projectId,
      expectedRevision: snapshot.project.revision,
      actions: [action],
    })
    entry.data.deleteOperationId = crypto.randomUUID()
    entry.data.deleteExpectedRevision = snapshot.project.revision
    entry.data.deleteApprovalToken = approval.approvalToken
    deps.persistHistory?.()
  }
  const commitRequest = (): ControlCommitRequestV1 => ({
    version: 'v1',
    projectId: deps.projectId,
    expectedRevision: entry.data.deleteExpectedRevision,
    idempotencyKey: entry.data.deleteOperationId!,
    approvalToken: entry.data.deleteApprovalToken,
    actions: [action],
  })
  let committed
  try {
    committed = await control.commitV1(commitRequest())
  } catch (error) {
    if (isProjectControlRevisionConflict(error)) {
      entry.data.deleteOperationId = undefined
      entry.data.deleteExpectedRevision = undefined
      entry.data.deleteApprovalToken = undefined
      deps.persistHistory?.()
      return await applyControlRangeDeleteEntry(entry, deps, direction)
    }
    if (isProjectControlError(error)) throw error
    committed = await control.commitV1(commitRequest())
  }
  const recovery = committed.recoveries.find((candidate) => (
    candidate.actionIndex === 0 && candidate.kind === 'timeline.range.delete'
  ))
  if (!recovery) throw new Error('Range deletion redo did not return a recovery descriptor.')
  entry.data.recoveryId = recovery.id
  entry.data.restoreOperationId = undefined
  entry.data.restoreExpectedRevision = undefined
  entry.data.deleteOperationId = undefined
  entry.data.deleteExpectedRevision = undefined
  entry.data.deleteApprovalToken = undefined
  deps.persistHistory?.()
  if (isLocalHistoryProject(deps)) await deps.actions.refreshLocalTimeline?.()
  deps.actions.rescheduleTimeline?.()
}

async function execHistoryEntry(entry: HistoryEntry, deps: Deps, direction: HistoryDirection) {
  assert(entry.projectId === deps.projectId, `History entry room mismatch: expected ${deps.projectId}, received ${entry.projectId}`)
  const { projectId, userId } = deps
  const grantScope = { projectId, userId }

  switch (entry.type) {
    case 'section-edit': {
      const entries = direction === 'undo' ? [...entry.data.entries].reverse() : entry.data.entries
      const trackDeleteContext = direction === 'redo'
        ? { refIndex: buildRefIndex(deps), deletedTrackIds: new Set<Track['id']>() }
        : null
      const completed: HistoryEntry[] = []
      try {
        for (const child of entries) {
          if (trackDeleteContext && child.type === 'track-delete') {
            await applyTrackDeleteEntry(child, deps, direction, trackDeleteContext)
          } else {
            await execHistoryEntry(child, deps, direction)
          }
          completed.push(child)
        }
      } catch (error) {
        const compensationErrors: unknown[] = []
        const inverseDirection = direction === 'undo' ? 'redo' : 'undo'
        for (const child of completed.reverse()) {
          try {
            await execHistoryEntry(child, deps, inverseDirection)
          } catch (compensationError) {
            compensationErrors.push(compensationError)
          }
        }
        if (compensationErrors.length > 0) {
          throw new AggregateError(
            [error, ...compensationErrors],
            'Section history replay failed and compensation was incomplete.',
          )
        }
        throw error
      }
      return
    }

    case 'control-range-delete':
      await applyControlRangeDeleteEntry(entry, deps, direction)
      return

    case 'clip-create': {
      const index = buildRefIndex(deps)
      if (direction === 'undo') {
        const clipId = requireResolved(resolveClipId(index, entry.data.clip.clipRef) ?? entry.data.clip.currentId, 'Clip not found for clip-create undo')
        const trackIdByClipId = createTimelineTrackIndex(deps.getTracks()).clipTrackIdById
        requireResolved(trackIdByClipId.get(clipId) ?? resolveTrackId(index, entry.data.trackRef), 'Track not found for clip-create undo')
        const deleteOperationId = entry.data.clip.deleteOperationId ?? crypto.randomUUID()
        entry.data.clip.deleteOperationId = deleteOperationId
        await removeHistoryClipIdsOrThrow(
          deps,
          [clipId],
          deleteOperationId,
          'Failed to remove clip during clip-create undo',
        )
        deps.actions.removeLocalClips([clipId])
        entry.data.clip.currentId = undefined
        entry.data.clip.deleteOperationId = undefined
        return
      }

      const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for clip-create redo')
      const existingId = entry.data.clip.currentId
      const clipSnapshot = entry.data.clip
      const newId = existingId || await createHistoryClip(deps, trackId, clipSnapshot)
      const resolvedNewId = assertDefined(newId, 'Failed to recreate clip')
      entry.data.clip.currentId = resolvedNewId
      deps.grantClipWrite(resolvedNewId, grantScope)
      if (clipSnapshot.sampleUrl) {
        await deps.ensureClipBuffer?.(resolvedNewId, clipSnapshot.sampleUrl)
      }
      deps.actions.insertLocalClip(trackId, buildLocalClip({ id: resolvedNewId, clip: clipSnapshot }))
      deps.actions.rescheduleChangedClips([resolvedNewId])
      return
    }

    case 'clip-delete': {
      if (direction === 'undo') {
        await recreateDeletedClips(entry, deps)
        return
      }
      const ids = (entry.data.recreatedClips ?? []).map((item) => item.clipId)
      if (ids.length === 0) return
      const deleteOperationId = entry.data.deleteOperationId ?? crypto.randomUUID()
      entry.data.deleteOperationId = deleteOperationId
      const recoveryIdsByClipId = await removeHistoryClipIdsOrThrow(
        deps,
        ids,
        deleteOperationId,
        'Failed to remove clips during clip-delete redo',
      )
      deps.actions.removeLocalClips(ids)
      for (const item of entry.data.items) {
        const recreated = (entry.data.recreatedClips ?? []).find((entry) => entry.clipRef === item.clip.clipRef)
        if (!recreated) continue
        const recoveryId = recoveryIdsByClipId.get(recreated.clipId)
        if (recoveryId) item.clip.recoveryId = recoveryId
      }
      entry.data.recreatedClips = []
      entry.data.deleteOperationId = undefined
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

    case 'clip-fades':
      await applyClipFadesEntry(entry, deps, direction)
      return

    case 'clip-color':
      await applyClipColorEntry(entry, deps, direction)
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
      const collapsed = trackCreationCollapsed(entry.data.channelRole, entry.data.collapsed)
      let index = entry.data.index
      if (!newId) {
        const createdTrack = await createHistoryTrack(deps, {
          trackRef: entry.data.trackRef,
          name: entry.data.name,
          index: entry.data.index,
          kind: entry.data.kind,
          channelRole: entry.data.channelRole,
          collapsed,
          color: entry.data.color,
        })
        newId = createdTrack.trackId
        index = createdTrack.index
      }
      const resolvedNewId = assertDefined(newId, 'Failed to recreate track')
      entry.data.currentTrackId = resolvedNewId
      deps.grantTrackWrite(resolvedNewId, grantScope)
      deps.actions.insertLocalTrack(createLocalTrack({
        id: resolvedNewId,
        historyRef: entry.data.trackRef,
        index,
        name: entry.data.name,
        kind: entry.data.kind ?? 'audio',
        channelRole: entry.data.channelRole ?? 'track',
        collapsed,
        color: entry.data.color,
      }), index)
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

    case 'track-group':
      await applyTrackGroupEntry(entry, deps, direction)
      return

    case 'track-ungroup':
      await applyTrackUngroupEntry(entry, deps, direction)
      return

    case 'track-color':
      await applyTrackColorEntry(entry, deps, direction)
      return

    case 'track-color-cascade':
      await applyTrackColorCascadeEntry(entry, deps, direction)
      return

    case 'track-reorder':
      await applyTrackReorderEntry(entry, deps, direction)
      return

    case 'effect-params':
      await applyEffectParamsEntry(entry, deps, direction)
      return

    case 'automation-envelope-change':
      await applyAutomationEnvelopeEntry(entry, deps, direction)
      return
  }
}

export function execUndo(entry: HistoryEntry, deps: Deps) {
  return execHistoryEntry(entry, deps, 'undo')
}

export function execRedo(entry: HistoryEntry, deps: Deps) {
  return execHistoryEntry(entry, deps, 'redo')
}
