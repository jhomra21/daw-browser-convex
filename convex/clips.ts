import type { Doc, Id } from './_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { v } from 'convex/values'
import { z } from 'zod'

import { getClipOwnership, getClipWriteAccess } from './clipWrites'
import { getMergedTrack } from './mixerChannels'
import { canWriteProject, getProjectRole, requireAuthenticatedUserId, requireProjectAccess } from './projectAccess'
import { isClipKindCompatibleWithTrack } from './trackRouting'
import { getTrackWriteAccess } from './trackWrites'
import { findSampleRow } from './sampleRows'
import { audioWarpEqual, buildClipAudioSourceFields, isJsonString, normalizeAudioSourceMetadataPatch, normalizeAudioWarp, normalizeClipColor, normalizeClipGain, normalizeClipStartSec, normalizeClipTimingPatch, normalizeLegacyMidiClip, normalizeMidiClip, sanitizeAudioSourceKind, type AudioSourceKind, type AudioWarpPayload, type LegacyMidiClip } from '@daw-browser/shared'
import { runSharedOperationOnce } from './sharedOperationResults'
import { advanceProjectRevision } from './projectRows'
import {
  controlMidiEqual,
  effectiveControlClipName,
  effectiveControlTimingOffset,
} from './controlEffectiveValues'
import { audioWarpValidator } from './audioWarpValidator'
import { clipFadesValidator } from './clipFadesValidator'
import { normalizeClipFades, type ClipFades } from '@daw-browser/timeline-core/clip-fades'
import { midiValidator } from './midiValidator'
import { hashCanonicalJsonSyncV1 } from '@daw-browser/control'

type ClipKind = 'audio' | 'midi'
type ClipMidiInput = LegacyMidiClip

type AudioSourceMetadataInput = {
  assetKey?: string
  sourceKind?: AudioSourceKind
  durationSec?: number
  sampleRate?: number
  channelCount?: number
}

const clipDeleteSkipReason = v.union(
  v.literal('access-denied'),
  v.literal('not-found'),
)

const clipDeleteResult = v.object({
  removedClipIds: v.array(v.id('clips')),
  recoveries: v.array(v.object({
    sourceClipId: v.id('clips'),
    recoveryId: v.id('clipDeletionRecoveries'),
  })),
  skippedClipIds: v.array(v.id('clips')),
  skipped: v.array(v.object({
    clipId: v.id('clips'),
    reason: clipDeleteSkipReason,
  })),
})

type ClipDeleteResult = {
  removedClipIds: Id<'clips'>[]
  recoveries: Array<{ sourceClipId: Id<'clips'>; recoveryId: Id<'clipDeletionRecoveries'> }>
  skippedClipIds: Id<'clips'>[]
  skipped: Array<{ clipId: Id<'clips'>; reason: 'access-denied' | 'not-found' }>
}

type ClipOwnership = { clip: Doc<'clips'>; owner: Doc<'ownerships'> }

const clipDeleteResultSchema = z.object({
  removedClipIds: z.array(z.string()),
  recoveries: z.array(z.object({
    sourceClipId: z.string(),
    recoveryId: z.string(),
  })),
  skippedClipIds: z.array(z.string()),
  skipped: z.array(z.object({
    clipId: z.string(),
    reason: z.enum(['access-denied', 'not-found']),
  })),
})

const clipRestoreResult = v.union(
  v.object({ status: v.literal('applied'), clipId: v.string() }),
  v.object({ status: v.literal('noop'), clipId: v.string() }),
  v.object({ status: v.literal('rejected'), reason: v.optional(v.string()) }),
)

const clipDeletionRecoveryLifetimeMs = 7 * 24 * 60 * 60 * 1000
const maxClipDeletionRecoveriesPerProject = 1000
const maxClipDeletionRecoveriesPerActorProject = 128
const clipDeletionRecoveryReceiptLifetimeMs = 24 * 60 * 60 * 1000
const maxClipDeletionRecoveryReceiptsPerProject = 1000
const maxClipDeletionRecoveryReceiptsPerActorProject = 128

type ClipCreateInput = {
  projectId: string
  trackId: Id<'tracks'>
  startSec: number
  duration: number
  userId: string
  name?: string
  sampleUrl?: string
  assetKey?: string
  sourceKind?: string
  durationSec?: number
  sampleRate?: number
  channelCount?: number
  leftPadSec?: number
  bufferOffsetSec?: number
  audioWarp?: {
    enabled: boolean
    sourceBpm?: number
    sourceBeatOffset?: number
    markers?: Array<{ id: string; sourceBeat: number; timelineBeat: number }>
    mode: 'repitch' | 'stretch'
  }
  gain?: number
  fades?: Partial<ClipFades>
  midiOffsetBeats?: number
  color?: string
  midi?: ClipMidiInput
  clipKind?: string
  operationId?: string
}

type ClipDbCtx = MutationCtx | QueryCtx

export function requireSingleProjectId(
  items: ReadonlyArray<{ projectId: string }>,
) {
  const projectId = items[0]?.projectId;
  if (!projectId) return undefined;
  if (items.some((item) => item.projectId !== projectId)) {
    throw new Error("Batch clip writes must target one project.");
  }
  return projectId;
}

type ClipCreatePatch = {
  projectId: string
  trackId: Id<'tracks'>
  startSec: number
  duration: number
  name?: string
  sampleUrl?: string
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  sourceDurationSec?: number
  sourceSampleRate?: number
  sourceChannelCount?: number
  leftPadSec?: number
  midi?: ClipCreateInput['midi']
  bufferOffsetSec?: number
  audioWarp?: ClipCreateInput['audioWarp']
  gain?: number
  fades?: ClipFades
  midiOffsetBeats?: number
  color?: string
}

type ClipTimingRowPatch = {
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
  fades?: ClipFades
  audioWarp?: AudioWarpPayload
}

const sanitizeClipKind = (value: string | undefined): ClipKind => {
  if (value === 'midi') return 'midi'
  return 'audio'
}

const getCompatibleMergedTrack = async (
  ctx: ClipDbCtx,
  trackId: Id<'tracks'>,
  projectId: string,
  clipKind: ClipKind,
) => {
  const track = await getMergedTrack(ctx, trackId)
  if (!track || track.projectId !== projectId) return null
  if (!isClipKindCompatibleWithTrack(track, clipKind)) return null
  return track
}

const getWritableCompatibleMergedTrack = async (
  ctx: ClipDbCtx,
  trackId: Id<'tracks'>,
  userId: string,
  projectId: string,
  clipKind: ClipKind,
) => {
  const access = await getTrackWriteAccess(ctx, trackId, userId)
  if (!access) return null
  return await getCompatibleMergedTrack(ctx, trackId, projectId, clipKind)
}

const isMergedTrackLockedByOther = (
  track: { lockedBy?: string | null },
  userId: string,
) => !!track.lockedBy && track.lockedBy !== userId

const isTrackLockedByOther = async (
  ctx: ClipDbCtx,
  trackId: Id<'tracks'>,
  userId: string,
) => {
  const track = await getMergedTrack(ctx, trackId)
  if (!track) return true
  return isMergedTrackLockedByOther(track, userId)
}

const buildClipCreatePatch = (
  item: ClipCreateInput,
  metadata: AudioSourceMetadataInput,
  normalizeMidi: (midi: ClipMidiInput) => ClipMidiInput = normalizeMidiClip,
) => {
  const patch: ClipCreatePatch = {
    projectId: item.projectId,
    trackId: item.trackId,
    startSec: item.startSec,
    duration: item.duration,
    name: item.name,
    sampleUrl: item.sampleUrl,
    leftPadSec: item.leftPadSec,
    midi: item.midi === undefined ? undefined : normalizeMidi(item.midi),
    bufferOffsetSec: item.bufferOffsetSec,
    audioWarp: normalizeAudioWarp(item.audioWarp),
    gain: item.gain,
    fades: item.fades ? normalizeClipFades(item.fades, item.duration) : undefined,
    midiOffsetBeats: item.midiOffsetBeats,
    color: normalizeClipColor(item.color),
  }
  Object.assign(patch, buildClipAudioSourceFields(metadata))

  return patch
}

const buildClipTimingPatch = (input: {
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
}) => {
  const normalizedTiming = normalizeClipTimingPatch(input)
  const patch: ClipTimingRowPatch = {
    startSec: normalizedTiming.startSec,
    duration: normalizedTiming.duration,
  }
  if (normalizedTiming.leftPadSec !== undefined) patch.leftPadSec = normalizedTiming.leftPadSec
  if (normalizedTiming.bufferOffsetSec !== undefined) patch.bufferOffsetSec = normalizedTiming.bufferOffsetSec
  if (normalizedTiming.midiOffsetBeats !== undefined) patch.midiOffsetBeats = normalizedTiming.midiOffsetBeats
  return patch
}

type ClipTimingMutationInput = {
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
  audioWarp?: AudioWarpPayload
  fades?: Partial<ClipFades>
}

const applyClipTimingPatch = async (
  ctx: MutationCtx,
  clipId: Id<'clips'>,
  input: ClipTimingMutationInput,
) => {
  const userId = await requireAuthenticatedUserId(ctx)
  const access = await getClipWriteAccess(ctx, clipId, userId)
  if (!access) return { status: 'rejected' as const }
  if (await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: 'rejected' as const }

  const patch = buildClipTimingPatch(input)
  if (input.fades && !access.clip.midi) patch.fades = normalizeClipFades(input.fades, input.duration)
  else if (access.clip.fades) patch.fades = normalizeClipFades(access.clip.fades, input.duration)
  if (input.audioWarp !== undefined) patch.audioWarp = normalizeAudioWarp(input.audioWarp)
  const result = await setClipTimingRow(ctx, {
    projectId: access.clip.projectId,
    clipId,
    patch,
  })
  if (!result.changed) return { status: 'noop' as const }
  if (result.snapshotChanged) await advanceProjectRevision(ctx, access.clip.projectId)
  return { status: 'applied' as const }
}

const insertOwnedClipRow = async (
  ctx: MutationCtx,
  clip: ClipCreatePatch,
  ownerUserId: string,
) => {
  const clipId = await ctx.db.insert('clips', clip)
  await ctx.db.insert('ownerships', {
    projectId: clip.projectId,
    ownerUserId,
    clipId,
  })
  return clipId
}

const getProjectClip = async (
  ctx: MutationCtx,
  projectId: string,
  clipId: Id<'clips'>,
): Promise<Doc<'clips'> | null> => {
  const clip = await ctx.db.get(clipId)
  return clip?.projectId === projectId ? clip : null
}

export const createMidiClipRow = async (
  ctx: MutationCtx,
  input: ClipCreatePatch & {
    ownerUserId: string
    midi: NonNullable<ClipCreateInput['midi']>
  },
) => {
  const track = await getCompatibleMergedTrack(ctx, input.trackId, input.projectId, 'midi')
  if (!track) return { changed: false, value: null }
  const { ownerUserId, ...clip } = input
  return {
    changed: true,
    value: await insertOwnedClipRow(ctx, clip, ownerUserId),
  }
}

export const createAudioClipRow = async (
  ctx: MutationCtx,
  input: ClipCreatePatch & { ownerUserId: string },
) => {
  const track = await getCompatibleMergedTrack(ctx, input.trackId, input.projectId, 'audio')
  if (!track) return { changed: false, value: null }
  const { ownerUserId, ...clip } = input
  return { changed: true, value: await insertOwnedClipRow(ctx, clip, ownerUserId) }
}

export const setClipMidiRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    clipId: Id<'clips'>
    midi: NonNullable<ClipCreateInput['midi']>
  },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip) return { changed: false }
  const track = await getCompatibleMergedTrack(ctx, clip.trackId, input.projectId, 'midi')
  const midi = normalizeMidiClip(input.midi)
  if (!track || controlMidiEqual(clip.midi, midi)) return { changed: false }
  await ctx.db.patch(input.clipId, { midi })
  return { changed: true }
}

export const setClipLegacyMidiRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    clipId: Id<'clips'>
    midi: NonNullable<ClipCreateInput['midi']>
  },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip) return { changed: false }
  const track = await getCompatibleMergedTrack(ctx, clip.trackId, input.projectId, 'midi')
  const midi = normalizeLegacyMidiClip(input.midi)
  if (!track || controlMidiEqual(clip.midi, midi)) return { changed: false }
  await ctx.db.patch(input.clipId, { midi })
  return { changed: true }
}

export const moveClipRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    clipId: Id<'clips'>
    trackId: Id<'tracks'>
    startSec: number
  },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip) return { changed: false }
  const targetTrack = await getCompatibleMergedTrack(
    ctx,
    input.trackId,
    input.projectId,
    sanitizeClipKind(clip.midi ? 'midi' : 'audio'),
  )
  if (!targetTrack || clip.trackId === input.trackId && clip.startSec === input.startSec) {
    return { changed: false }
  }
  await ctx.db.patch(input.clipId, {
    startSec: input.startSec,
    trackId: input.trackId,
  })
  return { changed: true }
}

export const setClipTimingRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    clipId: Id<'clips'>
    patch: ClipTimingRowPatch
  },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip) return { changed: false, snapshotChanged: false }
  const snapshotChanged = (
    clip.startSec !== input.patch.startSec
    || clip.duration !== input.patch.duration
    || ('leftPadSec' in input.patch && effectiveControlTimingOffset(clip.leftPadSec) !== input.patch.leftPadSec)
    || ('bufferOffsetSec' in input.patch && effectiveControlTimingOffset(clip.bufferOffsetSec) !== input.patch.bufferOffsetSec)
    || ('midiOffsetBeats' in input.patch && effectiveControlTimingOffset(clip.midiOffsetBeats) !== input.patch.midiOffsetBeats)
    || ('fades' in input.patch && JSON.stringify(clip.fades) !== JSON.stringify(input.patch.fades))
  )
  const changed = snapshotChanged
    || ('audioWarp' in input.patch && !audioWarpEqual(clip.audioWarp, input.patch.audioWarp))
  if (!changed) return { changed: false, snapshotChanged: false }
  await ctx.db.patch(input.clipId, input.patch)
  return { changed: true, snapshotChanged }
}

export const setClipNameRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    clipId: Id<'clips'>
    name: string
  },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip || effectiveControlClipName(clip.name) === effectiveControlClipName(input.name)) {
    return { changed: false }
  }
  await ctx.db.patch(input.clipId, { name: input.name })
  return { changed: true }
}

export const setClipGainRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    clipId: Id<'clips'>
    gain: number
  },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip || clip.gain === input.gain) return { changed: false }
  await ctx.db.patch(input.clipId, { gain: input.gain })
  return { changed: true }
}

export const setClipFadesRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    clipId: Id<'clips'>
    fades: ClipFades
  },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip || clip.midi || JSON.stringify(clip.fades) === JSON.stringify(input.fades)) {
    return { changed: false }
  }
  await ctx.db.patch(input.clipId, { fades: input.fades })
  return { changed: true }
}

export const setClipAudioWarpRow = async (
  ctx: MutationCtx,
  input: { projectId: string; clipId: Id<'clips'>; audioWarp: AudioWarpPayload | undefined },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  const audioWarp = normalizeAudioWarp(input.audioWarp)
  if (!clip || clip.midi || audioWarpEqual(clip.audioWarp, audioWarp)) return { changed: false }
  await ctx.db.patch(input.clipId, { audioWarp })
  return { changed: true }
}

export const setClipColorRow = async (
  ctx: MutationCtx,
  input: { projectId: string; clipId: Id<'clips'>; color?: string },
) => {
  const color = input.color === undefined ? undefined : normalizeClipColor(input.color)
  if (input.color !== undefined && !color) return { changed: false }
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip || clip.color === color) return { changed: false }
  await ctx.db.patch(input.clipId, { color })
  return { changed: true }
}

export const setClipSourceRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string; clipId: Id<'clips'>; assetKey: string; sourceKind: AudioSourceKind;
    durationSec: number; sampleRate: number; channelCount: number;
  },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip || clip.midi) return { changed: false }
  const asset = await findSampleRow(ctx, {
    projectId: input.projectId,
    assetKey: input.assetKey,
  })
  if (!asset) throw new Error('Audio clips require an authoritative project asset')
  const sourceKind = sanitizeAudioSourceKind(asset.sourceKind)
  if (sourceKind === undefined
    || asset.duration === undefined
    || asset.sampleRate === undefined
    || asset.channelCount === undefined) {
    throw new Error('Audio assets require authoritative duration, sample rate, and channel count')
  }
  const source = buildClipAudioSourceFields({
    assetKey: asset.assetKey,
    sourceKind,
    durationSec: asset.duration,
    sampleRate: asset.sampleRate,
    channelCount: asset.channelCount,
  })
  const sourceChanged = !(
    clip.sourceAssetKey === source.sourceAssetKey && clip.sourceKind === source.sourceKind
    && clip.sourceDurationSec === source.sourceDurationSec && clip.sourceSampleRate === source.sourceSampleRate
    && clip.sourceChannelCount === source.sourceChannelCount
  )
  if (!sourceChanged) return { changed: false }
  await ctx.db.patch(input.clipId, { ...source, sampleUrl: undefined })
  return { changed: true }
}

const clipDeletionRecoveryPayload = (
  clip: Doc<'clips'>,
  ownership: Doc<'ownerships'>,
  trackHistoryRef: string | undefined,
) => ({
  clip: {
    projectId: clip.projectId,
    trackId: String(clip.trackId),
    trackHistoryRef,
    startSec: clip.startSec,
    duration: clip.duration,
    sourceAssetKey: clip.sourceAssetKey,
    sourceKind: clip.sourceKind,
    sourceDurationSec: clip.sourceDurationSec,
    sourceSampleRate: clip.sourceSampleRate,
    sourceChannelCount: clip.sourceChannelCount,
    leftPadSec: clip.leftPadSec,
    bufferOffsetSec: clip.bufferOffsetSec,
    audioWarp: clip.audioWarp,
    gain: clip.gain,
    fades: clip.fades,
    color: clip.color,
    name: clip.name,
    sampleUrl: clip.sampleUrl,
    midi: clip.midi,
    midiOffsetBeats: clip.midiOffsetBeats,
  },
  ownership: {
    projectId: ownership.projectId,
    ownerUserId: ownership.ownerUserId,
    role: ownership.role,
  },
})

const pruneClipDeletionRecoveries = async (
  ctx: MutationCtx,
  input: { projectId: string; actorUserId: string; reserve: number },
) => {
  const now = Date.now()
  const projectRows = await ctx.db.query('clipDeletionRecoveries')
    .withIndex('by_project_createdAt', (q) => q.eq('projectId', input.projectId))
    .order('asc')
    .collect()
  const actorRows = projectRows.filter((row) => row.actorUserId === input.actorUserId)
  const expired = projectRows.filter((row) => row.expiresAt <= now || row.consumedAt !== undefined)
  for (const row of expired) await ctx.db.delete(row._id)
  const activeProject = projectRows.filter((row) => !expired.includes(row))
  const activeActor = actorRows.filter((row) => !expired.includes(row))
  if (
    activeProject.length + input.reserve > maxClipDeletionRecoveriesPerProject
    || activeActor.length + input.reserve > maxClipDeletionRecoveriesPerActorProject
  ) {
    throw new Error('Clip deletion recovery limit exceeded.')
  }
}

const pruneClipDeletionRecoveryReceipts = async (
  ctx: MutationCtx,
  input: { projectId: string; actorUserId: string },
) => {
  const now = Date.now()
  const rows = await ctx.db.query('clipDeletionRecoveryReceipts')
    .withIndex('by_project_createdAt', (q) => q.eq('projectId', input.projectId))
    .order('asc')
    .collect()
  const actorRows = rows.filter((row) => row.actorUserId === input.actorUserId)
  const expired = rows.filter((row) => row.expiresAt <= now)
  for (const row of expired) await ctx.db.delete(row._id)
  const activeProject = rows.filter((row) => !expired.includes(row))
  const activeActor = actorRows.filter((row) => !expired.includes(row))
  const projectOverflow = Math.max(0, activeProject.length + 1 - maxClipDeletionRecoveryReceiptsPerProject)
  const actorOverflow = Math.max(0, activeActor.length + 1 - maxClipDeletionRecoveryReceiptsPerActorProject)
  const removed = new Set<string>()
  for (const row of [...activeProject.slice(0, projectOverflow), ...activeActor.slice(0, actorOverflow)]) {
    if (removed.has(String(row._id))) continue
    removed.add(String(row._id))
    await ctx.db.delete(row._id)
  }
}

export const deleteClipRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    clipId: Id<'clips'>
    ownershipId: Id<'ownerships'>
    recovery?: { actorUserId: string; deleteOperationId: string }
  },
) => {
  const clip = await getProjectClip(ctx, input.projectId, input.clipId)
  if (!clip) return { changed: false }
  const ownership = await ctx.db.get(input.ownershipId)
  if (
    !ownership
    || ownership.projectId !== input.projectId
    || ownership.clipId !== input.clipId
  ) return { changed: false }
  const track = await ctx.db.get(clip.trackId)
  const recoveryPayload = clipDeletionRecoveryPayload(
    clip,
    ownership,
    track?.projectId === input.projectId ? track.historyRef : undefined,
  )
  const recoveryId = input.recovery
    ? await ctx.db.insert('clipDeletionRecoveries', {
      projectId: clip.projectId,
      actorUserId: input.recovery.actorUserId,
      sourceClipId: String(input.clipId),
      deleteOperationId: input.recovery.deleteOperationId,
      payload: recoveryPayload,
      payloadDigest: hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify(recoveryPayload))),
      createdAt: Date.now(),
      expiresAt: Date.now() + clipDeletionRecoveryLifetimeMs,
    })
    : undefined
  await ctx.db.delete(input.ownershipId)
  await ctx.db.delete(input.clipId)
  return { changed: true, recoveryId }
}

export const createOwnedClip = async (
  ctx: MutationCtx,
  item: ClipCreateInput,
): Promise<Id<'clips'> | null> => {
  if (item.color !== undefined && !normalizeClipColor(item.color)) {
    throw new Error('Invalid clip color')
  }
  const clipKind = sanitizeClipKind(item.clipKind ?? (item.midi ? 'midi' : 'audio'))
  const track = await getWritableCompatibleMergedTrack(ctx, item.trackId, item.userId, item.projectId, clipKind)
  if (!track) return null

  const sourceMetadata = normalizeAudioSourceMetadataPatch(item)
  if (clipKind === 'audio' && sourceMetadata.assetKey === undefined) {
    throw new Error('Audio clips require an asset key')
  }
  const asset = clipKind === 'audio' && sourceMetadata.assetKey
    ? await findSampleRow(ctx, { projectId: item.projectId, assetKey: sourceMetadata.assetKey })
    : null
  if (clipKind === 'audio' && sourceMetadata.assetKey && !asset) {
    throw new Error('Audio clips require an authoritative project asset')
  }
  const canonicalMetadata = asset
    ? {
      assetKey: asset.assetKey,
      sourceKind: sanitizeAudioSourceKind(asset.sourceKind),
      durationSec: asset.duration,
      sampleRate: asset.sampleRate,
      channelCount: asset.channelCount,
    }
    : sourceMetadata
  if (clipKind === 'audio' && (
    canonicalMetadata.sourceKind === undefined
    ||
    canonicalMetadata.durationSec === undefined
    || canonicalMetadata.sampleRate === undefined
    || canonicalMetadata.channelCount === undefined
  )) {
    throw new Error('Audio assets require authoritative duration, sample rate, and channel count')
  }
  const clipPatch = buildClipCreatePatch(item, canonicalMetadata)
  if (asset) clipPatch.sampleUrl = `/api/samples/${encodeURIComponent(item.projectId)}/${encodeURIComponent(asset.assetKey)}`
  if (clipKind === 'midi' && clipPatch.midi) {
    return (await createMidiClipRow(ctx, {
      ...clipPatch,
      ownerUserId: item.userId,
      midi: clipPatch.midi,
    })).value
  }
  return await insertOwnedClipRow(ctx, clipPatch, item.userId)
}

export const restoreLegacyHistory = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    startSec: v.number(),
    duration: v.number(),
    name: v.optional(v.string()),
    sampleUrl: v.optional(v.string()),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    audioWarp: v.optional(audioWarpValidator),
    gain: v.optional(v.number()),
    fades: v.optional(clipFadesValidator),
    midiOffsetBeats: v.optional(v.number()),
    color: v.optional(v.string()),
    midi: v.optional(midiValidator),
    clipKind: v.optional(v.string()),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await runSharedOperationOnce(ctx, {
      projectId: args.projectId,
      userId,
      operationId: args.operationId,
      isResult: (value): value is string | null => typeof value === 'string' || value === null,
      run: async () => {
        const trackId = ctx.db.normalizeId('tracks', args.trackId)
        if (!trackId || (args.color !== undefined && !normalizeClipColor(args.color))) return null
        const clipKind = sanitizeClipKind(args.clipKind ?? (args.midi ? 'midi' : 'audio'))
        const track = await getWritableCompatibleMergedTrack(ctx, trackId, userId, args.projectId, clipKind)
        if (!track) return null
        const patch = buildClipCreatePatch(
          { ...args, trackId, userId },
          normalizeAudioSourceMetadataPatch({}),
          normalizeLegacyMidiClip,
        )
        const clipId = await insertOwnedClipRow(ctx, patch, userId)
        await advanceProjectRevision(ctx, args.projectId)
        return String(clipId)
      },
    })
  },
})

export const listByRoom = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    await requireProjectAccess(ctx, projectId, userId)
    return await ctx.db
      .query('clips')
      .withIndex('by_room', q => q.eq('projectId', projectId))
      .collect()
  },
})

export const create = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id('tracks'),
    startSec: v.number(),
    duration: v.number(),
    name: v.optional(v.string()),
    sampleUrl: v.optional(v.string()),
    assetKey: v.optional(v.string()),
    sourceKind: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    channelCount: v.optional(v.number()),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    audioWarp: v.optional(audioWarpValidator),
    gain: v.optional(v.number()),
    fades: v.optional(clipFadesValidator),
    midiOffsetBeats: v.optional(v.number()),
    color: v.optional(v.string()),
    midi: v.optional(midiValidator),
    clipKind: v.optional(v.string()),
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await runSharedOperationOnce(ctx, {
      projectId: args.projectId,
      userId,
      operationId: args.operationId,
      isResult: (value): value is string | null => typeof value === 'string' || value === null,
      run: async () => {
        const clipId = await createOwnedClip(ctx, { ...args, userId })
        if (clipId) await advanceProjectRevision(ctx, args.projectId)
        return clipId
      },
    })
  },
})

export const serverCreate = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    startSec: v.number(),
    duration: v.number(),
    name: v.optional(v.string()),
    sampleUrl: v.optional(v.string()),
    assetKey: v.optional(v.string()),
    sourceKind: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    channelCount: v.optional(v.number()),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    audioWarp: v.optional(audioWarpValidator),
    gain: v.optional(v.number()),
    fades: v.optional(clipFadesValidator),
    midiOffsetBeats: v.optional(v.number()),
    color: v.optional(v.string()),
    midi: v.optional(midiValidator),
    clipKind: v.optional(v.string()),
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await runSharedOperationOnce(ctx, {
      projectId: args.projectId,
      userId,
      operationId: args.operationId,
      isResult: (value): value is string | null => typeof value === 'string' || value === null,
      run: async () => {
        const trackId = ctx.db.normalizeId('tracks', args.trackId)
        if (!trackId) return null
        const clipId = await createOwnedClip(ctx, { ...args, trackId, userId })
        if (clipId) await advanceProjectRevision(ctx, args.projectId)
        return clipId
      },
    })
  },
})

export const move = mutation({
  args: {
    clipId: v.id('clips'),
    startSec: v.number(),
    toTrackId: v.optional(v.id('tracks')),
  },
  handler: async (ctx, { clipId, startSec, toTrackId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return { status: 'rejected' as const }
    const clip = access.clip
    const nextStartSec = normalizeClipStartSec(startSec)
    const nextTrackId = toTrackId ?? clip.trackId
    if (await isTrackLockedByOther(ctx, clip.trackId, userId)) return { status: 'rejected' as const }
    if (toTrackId) {
      const targetTrack = await getCompatibleMergedTrack(
        ctx,
        toTrackId,
        clip.projectId,
        sanitizeClipKind(clip.midi ? 'midi' : 'audio'),
      )
      if (!targetTrack) return { status: 'rejected' as const }
      if (isMergedTrackLockedByOther(targetTrack, userId)) return { status: 'rejected' as const }
    }
    const result = await moveClipRow(ctx, {
      projectId: clip.projectId,
      clipId,
      startSec: nextStartSec,
      trackId: nextTrackId,
    })
    if (!result.changed) return { status: 'noop' as const }
    await advanceProjectRevision(ctx, clip.projectId)
    return { status: 'applied' as const }
  },
})

type ClipMoveManyInput = Array<{
  clipId: Id<'clips'>
  startSec: number
  toTrackId?: Id<'tracks'>
}>

const moveManyForUser = async (
  ctx: MutationCtx,
  moves: ClipMoveManyInput,
  userId: string,
) => {
    const patches: Array<{ clipId: Id<'clips'>; startSec: number; trackId: Id<'tracks'> }> = []
    let projectId: string | undefined
    for (const move of moves) {
      const access = await getClipWriteAccess(ctx, move.clipId, userId)
      if (!access) return { status: 'rejected' as const }
      const clip = access.clip
      if (projectId === undefined) projectId = clip.projectId
      else if (projectId !== clip.projectId) return { status: 'rejected' as const }
      const nextTrackId = move.toTrackId ?? clip.trackId
      if (await isTrackLockedByOther(ctx, clip.trackId, userId)) return { status: 'rejected' as const }
      if (move.toTrackId) {
        const targetTrack = await getCompatibleMergedTrack(
          ctx,
          move.toTrackId,
          clip.projectId,
          sanitizeClipKind(clip.midi ? 'midi' : 'audio'),
        )
        if (!targetTrack) return { status: 'rejected' as const }
        if (isMergedTrackLockedByOther(targetTrack, userId)) return { status: 'rejected' as const }
      }
      const nextStartSec = normalizeClipStartSec(move.startSec)
      if (clip.trackId === nextTrackId && clip.startSec === nextStartSec) continue
      patches.push({
        clipId: move.clipId,
        startSec: nextStartSec,
        trackId: nextTrackId,
      })
    }
    if (patches.length === 0) return { status: 'noop' as const }
    if (!projectId) return { status: 'rejected' as const }
    for (const patch of patches) {
      await moveClipRow(ctx, {
        projectId,
        clipId: patch.clipId,
        startSec: patch.startSec,
        trackId: patch.trackId,
      })
    }
    await advanceProjectRevision(ctx, projectId)
    return { status: 'applied' as const }
}

export const moveMany = mutation({
  args: {
    moves: v.array(v.object({
      clipId: v.id('clips'),
      startSec: v.number(),
      toTrackId: v.optional(v.id('tracks')),
    })),
  },
  handler: async (ctx, { moves }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await moveManyForUser(ctx, moves, userId)
  },
})

export const serverMoveMany = mutation({
  args: {
    moves: v.array(v.object({
      clipId: v.string(),
      startSec: v.number(),
      toTrackId: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { moves }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedMoves = moves.flatMap((move) => {
      const clipId = ctx.db.normalizeId('clips', move.clipId)
      if (!clipId) return []
      if (move.toTrackId === undefined) return [{ clipId, startSec: move.startSec }]
      const toTrackId = ctx.db.normalizeId('tracks', move.toTrackId)
      if (!toTrackId) return []
      return [{ clipId, startSec: move.startSec, toTrackId }]
    })
    if (normalizedMoves.length !== moves.length) return { status: 'rejected' as const }
    return await moveManyForUser(ctx, normalizedMoves, userId)
  },
})

export const remove = mutation({
  args: { clipId: v.id('clips') },
  handler: async (ctx, { clipId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return

    await pruneClipDeletionRecoveries(ctx, {
      projectId: access.clip.projectId,
      actorUserId: userId,
      reserve: 1,
    })
    const result = await deleteClipRow(ctx, {
      projectId: access.clip.projectId,
      clipId,
      ownershipId: access.owner._id,
      recovery: { actorUserId: userId, deleteOperationId: `clip:${String(clipId)}` },
    })
    await advanceProjectRevision(ctx, access.clip.projectId)
    return result.recoveryId ?? null
  },
})

export const setName = mutation({
  args: { clipId: v.id('clips'), name: v.string() },
  handler: async (ctx, { clipId, name }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return
    const result = await setClipNameRow(ctx, {
      projectId: access.clip.projectId,
      clipId,
      name,
    })
    if (!result.changed) return
    await advanceProjectRevision(ctx, access.clip.projectId)
  },
})

export const serverSetName = mutation({
  args: { clipId: v.string(), name: v.string() },
  handler: async (ctx, { clipId, name }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedClipId = ctx.db.normalizeId('clips', clipId)
    if (!normalizedClipId) return { status: 'rejected' as const }
    const access = await getClipWriteAccess(ctx, normalizedClipId, userId)
    if (!access) return { status: 'rejected' as const }
    const result = await setClipNameRow(ctx, {
      projectId: access.clip.projectId,
      clipId: normalizedClipId,
      name,
    })
    if (!result.changed) return { status: 'noop' as const }
    await advanceProjectRevision(ctx, access.clip.projectId)
    return { status: 'applied' as const }
  },
})

export const setTiming = mutation({
  args: {
    clipId: v.id('clips'),
    startSec: v.number(),
    duration: v.number(),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    midiOffsetBeats: v.optional(v.number()),
    fades: v.optional(clipFadesValidator),
  },
  handler: async (ctx, { clipId, startSec, duration, leftPadSec, bufferOffsetSec, midiOffsetBeats, fades }) => {
    return await applyClipTimingPatch(ctx, clipId, {
      startSec,
      duration,
      leftPadSec,
      bufferOffsetSec,
      midiOffsetBeats,
      fades,
    })
  },
})

export const setAudioWarp = mutation({
  args: {
    clipId: v.id('clips'),
    audioWarp: audioWarpValidator,
  },
  handler: async (ctx, { clipId, audioWarp }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return { status: 'rejected' as const }
    if (await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: 'rejected' as const }
    const result = await setClipAudioWarpRow(ctx, {
      projectId: access.clip.projectId,
      clipId,
      audioWarp,
    })
    if (!result.changed) return { status: 'noop' as const }
    await advanceProjectRevision(ctx, access.clip.projectId)
    return { status: 'applied' as const }
  },
})

export const setFades = mutation({
  args: { clipId: v.id('clips'), fades: clipFadesValidator },
  handler: async (ctx, { clipId, fades }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access || access.clip.midi) return { status: 'rejected' as const }
    if (await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: 'rejected' as const }
    const nextFades = normalizeClipFades(fades, access.clip.duration)
    const result = await setClipFadesRow(ctx, {
      projectId: access.clip.projectId,
      clipId,
      fades: nextFades,
    })
    if (!result.changed) return { status: 'noop' as const }
    await advanceProjectRevision(ctx, access.clip.projectId)
    return { status: 'applied' as const }
  },
})

export const setTimingAndAudioWarp = mutation({
  args: {
    clipId: v.id('clips'),
    startSec: v.number(),
    duration: v.number(),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    midiOffsetBeats: v.optional(v.number()),
    audioWarp: v.optional(audioWarpValidator),
    fades: v.optional(clipFadesValidator),
  },
  handler: async (ctx, { clipId, startSec, duration, leftPadSec, bufferOffsetSec, midiOffsetBeats, audioWarp, fades }) => {
    return await applyClipTimingPatch(ctx, clipId, {
      startSec,
      duration,
      leftPadSec,
      bufferOffsetSec,
      midiOffsetBeats,
      audioWarp,
      fades,
    })
  },
})

export const serverSetAudioWarp = mutation({
  args: {
    clipId: v.string(),
    audioWarp: audioWarpValidator,
  },
  handler: async (ctx, { clipId, audioWarp }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedClipId = ctx.db.normalizeId('clips', clipId)
    if (!normalizedClipId) return { status: 'rejected' as const }
    const access = await getClipWriteAccess(ctx, normalizedClipId, userId)
    if (!access) return { status: 'rejected' as const }
    if (await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: 'rejected' as const }
    const result = await setClipAudioWarpRow(ctx, {
      projectId: access.clip.projectId,
      clipId: normalizedClipId,
      audioWarp,
    })
    if (!result.changed) return { status: 'noop' as const }
    await advanceProjectRevision(ctx, access.clip.projectId)
    return { status: 'applied' as const }
  },
})

export const serverSetGain = mutation({
  args: {
    clipId: v.string(),
    gain: v.number(),
  },
  handler: async (ctx, { clipId, gain }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedClipId = ctx.db.normalizeId('clips', clipId)
    if (!normalizedClipId) return { status: 'rejected' as const }
    const access = await getClipWriteAccess(ctx, normalizedClipId, userId)
    if (!access) return { status: 'rejected' as const }
    if (await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: 'rejected' as const }
    const nextGain = normalizeClipGain(gain)
    const result = await setClipGainRow(ctx, {
      projectId: access.clip.projectId,
      clipId: normalizedClipId,
      gain: nextGain,
    })
    if (!result.changed) return { status: 'noop' as const }
    await advanceProjectRevision(ctx, access.clip.projectId)
    return { status: 'applied' as const }
  },
})

export const serverSetFades = mutation({
  args: { clipId: v.string(), fades: clipFadesValidator },
  handler: async (ctx, { clipId, fades }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedClipId = ctx.db.normalizeId('clips', clipId)
    if (!normalizedClipId) return { status: 'rejected' as const }
    const access = await getClipWriteAccess(ctx, normalizedClipId, userId)
    if (!access || access.clip.midi) return { status: 'rejected' as const }
    if (await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: 'rejected' as const }
    const nextFades = normalizeClipFades(fades, access.clip.duration)
    const result = await setClipFadesRow(ctx, {
      projectId: access.clip.projectId,
      clipId: normalizedClipId,
      fades: nextFades,
    })
    if (!result.changed) return { status: 'noop' as const }
    await advanceProjectRevision(ctx, access.clip.projectId)
    return { status: 'applied' as const }
  },
})

export const serverSetColor = mutation({
  args: {
    clipId: v.string(),
    color: v.string(),
  },
  handler: async (ctx, { clipId, color }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedClipId = ctx.db.normalizeId('clips', clipId)
    if (!normalizedClipId) return { status: 'rejected' as const }
    const access = await getClipWriteAccess(ctx, normalizedClipId, userId)
    if (!access) return { status: 'rejected' as const }
    if (await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: 'rejected' as const }
    const normalizedColor = normalizeClipColor(color)
    if (!normalizedColor) return { status: 'rejected' as const }
    if (access.clip.color === normalizedColor) return { status: 'noop' as const }
    await ctx.db.patch(normalizedClipId, { color: normalizedColor })
    await advanceProjectRevision(ctx, access.clip.projectId)
    return { status: 'applied' as const }
  },
})

export const serverSetTiming = mutation({
  args: {
    clipId: v.string(),
    startSec: v.number(),
    duration: v.number(),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    midiOffsetBeats: v.optional(v.number()),
    fades: v.optional(clipFadesValidator),
  },
  handler: async (ctx, { clipId, startSec, duration, leftPadSec, bufferOffsetSec, midiOffsetBeats, fades }) => {
    const normalizedClipId = ctx.db.normalizeId('clips', clipId)
    if (!normalizedClipId) return { status: 'rejected' as const }
    return await applyClipTimingPatch(ctx, normalizedClipId, {
      startSec,
      duration,
      leftPadSec,
      bufferOffsetSec,
      midiOffsetBeats,
      fades,
    })
  },
})

export const serverSetTimingAndAudioWarp = mutation({
  args: {
    clipId: v.string(),
    startSec: v.number(),
    duration: v.number(),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    midiOffsetBeats: v.optional(v.number()),
    audioWarp: v.optional(audioWarpValidator),
    fades: v.optional(clipFadesValidator),
  },
  handler: async (ctx, { clipId, startSec, duration, leftPadSec, bufferOffsetSec, midiOffsetBeats, audioWarp, fades }) => {
    const normalizedClipId = ctx.db.normalizeId('clips', clipId)
    if (!normalizedClipId) return { status: 'rejected' as const }
    return await applyClipTimingPatch(ctx, normalizedClipId, {
      startSec,
      duration,
      leftPadSec,
      bufferOffsetSec,
      midiOffsetBeats,
      audioWarp,
      fades,
    })
  },
})

export const setMidi = mutation({
  args: {
    clipId: v.id('clips'),
    midi: midiValidator,
  },
  handler: async (ctx, { clipId, midi }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return

    const track = await getMergedTrack(ctx, access.clip.trackId)
    if (!track || !isClipKindCompatibleWithTrack(track, 'midi')) return

    const result = await setClipMidiRow(ctx, {
      projectId: access.clip.projectId,
      clipId,
      midi,
    })
    if (!result.changed) return
    await advanceProjectRevision(ctx, access.clip.projectId)
  },
})

export const serverSetMidi = mutation({
  args: {
    projectId: v.string(),
    clipId: v.string(),
    midi: midiValidator,
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, clipId, midi, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedClipId = ctx.db.normalizeId("clips", clipId)
    if (!normalizedClipId) return { status: "rejected" as const }
    return await runSharedOperationOnce(ctx, {
      projectId, userId, operationId,
      isResult: (value): value is { status: "applied" | "noop" | "rejected" } => (
        typeof value === "object" && value !== null && "status" in value
        && ((value.status === "applied") || (value.status === "noop") || (value.status === "rejected"))
      ),
      run: async () => {
        const access = await getClipWriteAccess(ctx, normalizedClipId, userId)
        if (!access || access.clip.projectId !== projectId || !access.clip.midi || await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: "rejected" as const }
        const result = await setClipMidiRow(ctx, { projectId, clipId: normalizedClipId, midi })
        if (!result.changed) return { status: "noop" as const }
        await advanceProjectRevision(ctx, projectId)
        return { status: "applied" as const }
      },
    })
  },
})

export const serverSetMidiAndTiming = mutation({
  args: {
    projectId: v.string(),
    clipId: v.string(),
    startSec: v.number(),
    duration: v.number(),
    midi: midiValidator,
    operationId: v.string(),
  },
  handler: async (ctx, { projectId, clipId, startSec, duration, midi, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedClipId = ctx.db.normalizeId('clips', clipId)
    if (!normalizedClipId) return { status: 'rejected' as const }
    return await runSharedOperationOnce(ctx, {
      projectId, userId, operationId,
      isResult: (value): value is { status: 'applied' | 'noop' | 'rejected' } => (
        typeof value === 'object' && value !== null && 'status' in value
        && (value.status === 'applied' || value.status === 'noop' || value.status === 'rejected')
      ),
      run: async () => {
        const access = await getClipWriteAccess(ctx, normalizedClipId, userId)
        if (!access || access.clip.projectId !== projectId || !access.clip.midi || await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: 'rejected' as const }
        const timing = buildClipTimingPatch({ startSec, duration })
        if (access.clip.fades) timing.fades = normalizeClipFades(access.clip.fades, duration)
        const normalizedMidi = normalizeMidiClip(midi)
        const timingChanged = access.clip.startSec !== timing.startSec
          || access.clip.duration !== timing.duration
          || access.clip.leftPadSec !== timing.leftPadSec
          || access.clip.bufferOffsetSec !== timing.bufferOffsetSec
          || access.clip.midiOffsetBeats !== timing.midiOffsetBeats
        const midiChanged = !controlMidiEqual(access.clip.midi, normalizedMidi)
        if (!timingChanged && !midiChanged) return { status: 'noop' as const }
        await ctx.db.patch(normalizedClipId, { ...timing, midi: normalizedMidi })
        await advanceProjectRevision(ctx, projectId)
        return { status: 'applied' as const }
      },
    })
  },
})

export const createMany = mutation({
  args: {
    items: v.array(v.object({
      projectId: v.string(),
      trackId: v.id('tracks'),
      startSec: v.number(),
      duration: v.number(),
      name: v.optional(v.string()),
      sampleUrl: v.optional(v.string()),
      assetKey: v.optional(v.string()),
      sourceKind: v.optional(v.string()),
      durationSec: v.optional(v.number()),
      sampleRate: v.optional(v.number()),
      channelCount: v.optional(v.number()),
      leftPadSec: v.optional(v.number()),
      midi: v.optional(midiValidator),
      bufferOffsetSec: v.optional(v.number()),
      audioWarp: v.optional(audioWarpValidator),
      gain: v.optional(v.number()),
      fades: v.optional(clipFadesValidator),
      midiOffsetBeats: v.optional(v.number()),
      color: v.optional(v.string()),
      clipKind: v.optional(v.string()),
    })),
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, { items, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const projectId = requireSingleProjectId(items)
    return await runSharedOperationOnce(ctx, {
      projectId,
      userId,
      operationId,
      isResult: (value): value is Array<Id<'clips'> | null> => Array.isArray(value),
      run: async () => {
        const createdIds: Array<Id<'clips'> | null> = []
        for (const item of items) {
          const clipId = await createOwnedClip(ctx, { ...item, userId })
          createdIds.push(clipId ?? null)
        }
        if (createdIds.some(Boolean) && projectId) await advanceProjectRevision(ctx, projectId)
        return createdIds
      },
    })
  },
})

export const serverCreateMany = mutation({
  args: {
    items: v.array(v.object({
      projectId: v.string(),
      trackId: v.string(),
      startSec: v.number(),
      duration: v.number(),
      name: v.optional(v.string()),
      sampleUrl: v.optional(v.string()),
      assetKey: v.optional(v.string()),
      sourceKind: v.optional(v.string()),
      durationSec: v.optional(v.number()),
      sampleRate: v.optional(v.number()),
      channelCount: v.optional(v.number()),
      leftPadSec: v.optional(v.number()),
      midi: v.optional(midiValidator),
      bufferOffsetSec: v.optional(v.number()),
      audioWarp: v.optional(audioWarpValidator),
      gain: v.optional(v.number()),
      fades: v.optional(clipFadesValidator),
      midiOffsetBeats: v.optional(v.number()),
      color: v.optional(v.string()),
      clipKind: v.optional(v.string()),
    })),
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, { items, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const projectId = requireSingleProjectId(items)
    return await runSharedOperationOnce(ctx, {
      projectId,
      userId,
      operationId,
      isResult: (value): value is Array<Id<'clips'> | null> => Array.isArray(value),
      run: async () => {
        const createdIds: Array<Id<'clips'> | null> = []
        for (const item of items) {
          const trackId = ctx.db.normalizeId('tracks', item.trackId)
          if (!trackId) {
            createdIds.push(null)
            continue
          }
          const clipId = await createOwnedClip(ctx, { ...item, trackId, userId })
          createdIds.push(clipId ?? null)
        }
        if (createdIds.some(Boolean) && projectId) await advanceProjectRevision(ctx, projectId)
        return createdIds
      },
    })
  },
})

const removeManyForUser = async (
  ctx: MutationCtx,
  clipIds: Id<'clips'>[],
  userId: string,
  projectId: string,
  deleteOperationId: string,
) => {
  if (clipIds.length === 0) throw new Error('Clip deletion requires at least one clip.')
  const clipIdTexts = new Set<string>()
  for (const clipId of clipIds) {
    const clipIdText = String(clipId)
    if (clipIdTexts.has(clipIdText)) throw new Error('Clip deletion cannot contain duplicate clip IDs.')
    clipIdTexts.add(clipIdText)
  }
  const ownerships = await Promise.all(clipIds.map(async (clipId) => ({
    clipId,
    ownership: await getClipOwnership(ctx, clipId),
  })))
  const projectCanWrite = new Map<string, boolean>()
  const deletable: Array<{ clipId: Id<'clips'>; ownership: ClipOwnership }> = []
  for (const { clipId, ownership } of ownerships) {
    if (!ownership) {
      throw new Error(`Clip deletion target was not found: ${String(clipId)}.`)
    }
    if (ownership.clip.projectId !== projectId) {
      throw new Error('Clip deletion targets must belong to the requested project.')
    }
    if (ownership.owner.ownerUserId !== userId) {
      let canWrite = projectCanWrite.get(ownership.clip.projectId)
      if (canWrite === undefined) {
        canWrite = canWriteProject(await getProjectRole(ctx, ownership.clip.projectId, userId))
        projectCanWrite.set(ownership.clip.projectId, canWrite)
      }
      if (!canWrite) {
        throw new Error('Actor cannot delete one or more clips.')
      }
    }
    deletable.push({ clipId, ownership })
  }
  for (const { ownership } of deletable) {
    if (await isTrackLockedByOther(ctx, ownership.clip.trackId, userId)) {
      throw new Error('Actor cannot delete clips on a locked track.')
    }
  }
  const recoveryCountByProject = new Map<string, number>()
  for (const { ownership } of deletable) {
    recoveryCountByProject.set(
      ownership.clip.projectId,
      (recoveryCountByProject.get(ownership.clip.projectId) ?? 0) + 1,
    )
  }
  for (const [projectId, reserve] of recoveryCountByProject) {
    await pruneClipDeletionRecoveries(ctx, { projectId, actorUserId: userId, reserve })
  }
  const removedClipIds: Id<'clips'>[] = []
  const recoveries: Array<{ sourceClipId: Id<'clips'>; recoveryId: Id<'clipDeletionRecoveries'> }> = []
  for (const { clipId, ownership } of deletable) {
    const deleted = await deleteClipRow(ctx, {
      projectId: ownership.clip.projectId,
      clipId,
      ownershipId: ownership.owner._id,
      recovery: { actorUserId: userId, deleteOperationId },
    })
    if (!deleted.changed || !deleted.recoveryId) throw new Error('Clip deletion target changed during deletion.')
    recoveries.push({ sourceClipId: clipId, recoveryId: deleted.recoveryId })
    removedClipIds.push(clipId)
  }
  await advanceProjectRevision(ctx, projectId)
  return {
    removedClipIds,
    recoveries,
    skippedClipIds: [],
    skipped: [],
  }
}

export const removeMany = mutation({
  args: { projectId: v.string(), clipIds: v.array(v.id('clips')), operationId: v.string() },
  returns: clipDeleteResult,
  handler: async (ctx, { projectId, clipIds, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await runSharedOperationOnce(ctx, {
      projectId,
      userId,
      operationId,
      isResult: (value): value is ClipDeleteResult => clipDeleteResultSchema.safeParse(value).success,
      run: () => removeManyForUser(ctx, clipIds, userId, projectId, operationId),
    })
  },
})

export const serverRemoveMany = mutation({
  args: { projectId: v.string(), clipIds: v.array(v.string()), operationId: v.string() },
  returns: clipDeleteResult,
  handler: async (ctx, { projectId, clipIds, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await runSharedOperationOnce(ctx, {
      projectId,
      userId,
      operationId,
      isResult: (value): value is ClipDeleteResult => clipDeleteResultSchema.safeParse(value).success,
      run: async () => {
        if (clipIds.length === 0) throw new Error('Clip deletion requires at least one clip.')
        const normalizedClipIds: Id<'clips'>[] = []
        for (const clipId of clipIds) {
          const normalized = ctx.db.normalizeId('clips', clipId)
          if (!normalized) throw new Error(`Invalid clip deletion ID: ${clipId}.`)
          normalizedClipIds.push(normalized)
        }
        return await removeManyForUser(ctx, normalizedClipIds, userId, projectId, operationId)
      },
    })
  },
})

export const restoreDeleted = mutation({
  args: { recoveryId: v.string() },
  returns: clipRestoreResult,
  handler: async (ctx, { recoveryId: recoveryIdText }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const recoveryId = ctx.db.normalizeId('clipDeletionRecoveries', recoveryIdText)
    if (!recoveryId) {
      const receipt = await ctx.db.query('clipDeletionRecoveryReceipts')
        .withIndex('by_recovery', (q) => q.eq('recoveryId', recoveryIdText))
        .first()
      if (
        receipt
        && receipt.actorUserId === userId
        && receipt.expiresAt > Date.now()
        && canWriteProject(await getProjectRole(ctx, receipt.projectId, userId))
      ) return { status: 'noop' as const, clipId: receipt.restoredClipId }
      return { status: 'rejected' as const }
    }
    const recovery = await ctx.db.get(recoveryId)
    if (!recovery || recovery.actorUserId !== userId || recovery.expiresAt <= Date.now()) {
      const receipt = await ctx.db.query('clipDeletionRecoveryReceipts')
        .withIndex('by_recovery', (q) => q.eq('recoveryId', recoveryIdText))
        .first()
      if (
        receipt
        && receipt.actorUserId === userId
        && receipt.expiresAt > Date.now()
        && canWriteProject(await getProjectRole(ctx, receipt.projectId, userId))
      ) return { status: 'noop' as const, clipId: receipt.restoredClipId }
      return { status: 'rejected' as const }
    }
    if (!canWriteProject(await getProjectRole(ctx, recovery.projectId, userId))) {
      return { status: 'rejected' as const }
    }
    if (hashCanonicalJsonSyncV1(recovery.payload) !== recovery.payloadDigest) {
      return { status: 'rejected' as const }
    }
    const payload = recovery.payload
    const clip = payload?.clip
    const ownership = payload?.ownership
    if (
      !clip || !ownership || clip.projectId !== recovery.projectId
      || ownership.projectId !== recovery.projectId || !isJsonString(clip.trackId)
      || !isJsonString(ownership.ownerUserId)
    ) return { status: 'rejected' as const }
    const originalTrackId = ctx.db.normalizeId('tracks', clip.trackId)
    const originalTrack = originalTrackId
      ? await getCompatibleMergedTrack(ctx, originalTrackId, recovery.projectId, clip.midi ? 'midi' : 'audio')
      : null
    const replacementTracks = !originalTrack && isJsonString(clip.trackHistoryRef)
      ? (await ctx.db.query('tracks').withIndex('by_room', (q) => q.eq('projectId', recovery.projectId)).collect())
        .filter((candidate) => candidate.historyRef === clip.trackHistoryRef)
      : []
    if (replacementTracks.length > 1) return { status: 'rejected' as const }
    const track = originalTrack ?? (replacementTracks[0]
      ? await getCompatibleMergedTrack(ctx, replacementTracks[0]._id, recovery.projectId, clip.midi ? 'midi' : 'audio')
      : null)
    if (!track) return { status: 'rejected' as const }
    if (isMergedTrackLockedByOther(track, userId)) return { status: 'rejected' as const }
    const trackId = track._id
    const audioSource = clip.midi ? undefined : normalizeAudioSourceMetadataPatch({
      assetKey: clip.sourceAssetKey,
      sourceKind: clip.sourceKind,
      durationSec: clip.sourceDurationSec,
      sampleRate: clip.sourceSampleRate,
      channelCount: clip.sourceChannelCount,
    })
    if (
      !clip.midi && clip.sourceAssetKey !== undefined
      && (
        audioSource?.assetKey === undefined
        || audioSource.sourceKind === undefined
        || audioSource.durationSec === undefined
        || audioSource.sampleRate === undefined
        || audioSource.channelCount === undefined
      )
    ) return { status: 'rejected' as const, reason: 'invalid-audio-source' }
    const asset = clip.sourceAssetKey === undefined
      ? undefined
      : audioSource?.assetKey
      ? await findSampleRow(ctx, { projectId: recovery.projectId, assetKey: audioSource.assetKey })
      : undefined
    if (!clip.midi && clip.sourceAssetKey !== undefined && !asset) return { status: 'rejected' as const, reason: 'missing-audio-asset' }
    const audioSourceFields = audioSource === undefined ? {} : buildClipAudioSourceFields(audioSource)
    const restoredId = await insertOwnedClipRow(ctx, {
      projectId: clip.projectId,
      trackId,
      startSec: clip.startSec,
      duration: clip.duration,
      ...audioSourceFields,
      leftPadSec: clip.leftPadSec,
      bufferOffsetSec: clip.bufferOffsetSec,
      audioWarp: clip.audioWarp,
      gain: clip.gain,
      fades: clip.fades,
      color: clip.color,
      name: clip.name,
      ...(asset
        ? { sampleUrl: `/api/samples/${encodeURIComponent(recovery.projectId)}/${encodeURIComponent(asset.assetKey)}` }
        : isJsonString(clip.sampleUrl) ? { sampleUrl: clip.sampleUrl } : {}),
      midi: clip.midi === undefined ? undefined : normalizeLegacyMidiClip(clip.midi),
      midiOffsetBeats: clip.midiOffsetBeats,
    }, ownership.ownerUserId)
    await pruneClipDeletionRecoveryReceipts(ctx, {
      projectId: recovery.projectId,
      actorUserId: userId,
    })
    const createdAt = Date.now()
    await ctx.db.insert('clipDeletionRecoveryReceipts', {
      projectId: recovery.projectId,
      actorUserId: userId,
      recoveryId: recoveryIdText,
      restoredClipId: String(restoredId),
      createdAt,
      expiresAt: createdAt + clipDeletionRecoveryReceiptLifetimeMs,
    })
    await ctx.db.delete(recoveryId)
    await advanceProjectRevision(ctx, recovery.projectId)
    return { status: 'applied' as const, clipId: String(restoredId) }
  },
})
