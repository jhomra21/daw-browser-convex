import type { Id } from './_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { v } from 'convex/values'

import { getClipOwnership, getClipWriteAccess } from './clipWrites'
import { getMergedTrack } from './mixerChannels'
import { canWriteProject, getProjectRole, requireAuthenticatedUserId, requireProjectAccess } from './projectAccess'
import { upsertSampleRow } from './sampleRows'
import { isClipKindCompatibleWithTrack } from './trackRouting'
import { getTrackWriteAccess } from './trackWrites'
import { buildClipAudioSourceFields, normalizeAudioSourceMetadataPatch, normalizeClipColor, normalizeClipGain, normalizeClipStartSec, normalizeClipTimingPatch, sanitizePositiveNumber, type AudioSourceKind, type AudioWarpPayload } from '@daw-browser/shared'
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

type ClipKind = 'audio' | 'midi'

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
  skippedClipIds: v.array(v.id('clips')),
  skipped: v.array(v.object({
    clipId: v.id('clips'),
    reason: clipDeleteSkipReason,
  })),
})

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
  midi?: {
    wave: string
    gain?: number
    notes: Array<{
      beat: number
      length: number
      pitch: number
      velocity?: number
    }>
  }
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
) => {
  const patch: ClipCreatePatch = {
    projectId: item.projectId,
    trackId: item.trackId,
    startSec: item.startSec,
    duration: item.duration,
    name: item.name,
    sampleUrl: item.sampleUrl,
    leftPadSec: item.leftPadSec,
    midi: item.midi,
    bufferOffsetSec: item.bufferOffsetSec,
    audioWarp: item.audioWarp,
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
  const patch: Record<string, unknown> = {
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
  if (input.audioWarp !== undefined) patch.audioWarp = input.audioWarp
  const snapshotChanged = (
    access.clip.startSec !== patch.startSec
    || access.clip.duration !== patch.duration
    || ('leftPadSec' in patch && effectiveControlTimingOffset(access.clip.leftPadSec) !== patch.leftPadSec)
    || ('bufferOffsetSec' in patch && effectiveControlTimingOffset(access.clip.bufferOffsetSec) !== patch.bufferOffsetSec)
    || ('midiOffsetBeats' in patch && effectiveControlTimingOffset(access.clip.midiOffsetBeats) !== patch.midiOffsetBeats)
    || ('fades' in patch && JSON.stringify(access.clip.fades) !== JSON.stringify(patch.fades))
  )
  const changed = snapshotChanged
    || ('audioWarp' in patch && JSON.stringify(access.clip.audioWarp) !== JSON.stringify(patch.audioWarp))
  if (!changed) return { status: 'noop' as const }
  await ctx.db.patch(clipId, patch)
  if (snapshotChanged) await advanceProjectRevision(ctx, access.clip.projectId)
  return { status: 'applied' as const }
}

const upsertSampleRowForClip = async (
  ctx: MutationCtx,
  clip: {
    projectId: string
    name?: string
    sampleUrl?: string
    sourceAssetKey?: string
    sourceKind?: string
    sourceDurationSec?: number
    sourceSampleRate?: number
    sourceChannelCount?: number
  },
  ownerUserId: string,
) => {
  const duration = sanitizePositiveNumber(clip.sourceDurationSec)
  await upsertSampleRow(ctx, {
    projectId: clip.projectId,
    url: clip.sampleUrl,
    assetKey: clip.sourceAssetKey,
    sourceKind: clip.sourceKind,
    ownerUserId,
    name: clip.name,
    duration,
    sampleRate: clip.sourceSampleRate,
    channelCount: clip.sourceChannelCount,
  })
}

export const createOwnedClip = async (
  ctx: MutationCtx,
  item: ClipCreateInput,
): Promise<Id<'clips'> | null> => {
  const clipKind = sanitizeClipKind(item.clipKind ?? (item.midi ? 'midi' : 'audio'))
  const track = await getWritableCompatibleMergedTrack(ctx, item.trackId, item.userId, item.projectId, clipKind)
  if (!track) return null

  const sourceMetadata = normalizeAudioSourceMetadataPatch(item)
  if (
    clipKind === 'audio'
    && (
      item.sampleUrl === undefined
      || sourceMetadata.assetKey === undefined
      || sourceMetadata.sourceKind === undefined
      || sourceMetadata.durationSec === undefined
      || sourceMetadata.sampleRate === undefined
      || sourceMetadata.channelCount === undefined
    )
  ) {
    throw new Error('Audio clips require complete source metadata')
  }
  const clipPatch = buildClipCreatePatch(item, sourceMetadata)
  const clipId = await ctx.db.insert('clips', clipPatch)

  await ctx.db.insert('ownerships', {
    projectId: item.projectId,
    ownerUserId: item.userId,
    clipId,
  })

  await upsertSampleRowForClip(
    ctx,
    {
      projectId: item.projectId,
      name: item.name,
      sampleUrl: item.sampleUrl,
      sourceAssetKey: sourceMetadata.assetKey,
      sourceKind: sourceMetadata.sourceKind,
      sourceDurationSec: sourceMetadata.durationSec,
      sourceSampleRate: sourceMetadata.sampleRate,
      sourceChannelCount: sourceMetadata.channelCount,
    },
    item.userId,
  )

  return clipId
}

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
    midi: v.optional(v.object({
      wave: v.string(),
      gain: v.optional(v.number()),
      notes: v.array(v.object({
        beat: v.number(),
        length: v.number(),
        pitch: v.number(),
        velocity: v.optional(v.number()),
      })),
    })),
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
    midi: v.optional(v.object({
      wave: v.string(),
      gain: v.optional(v.number()),
      notes: v.array(v.object({
        beat: v.number(),
        length: v.number(),
        pitch: v.number(),
        velocity: v.optional(v.number()),
      })),
    })),
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
    if (clip.trackId === nextTrackId && clip.startSec === nextStartSec) return { status: 'noop' as const }
    await ctx.db.patch(clipId, {
      startSec: nextStartSec,
      trackId: nextTrackId,
    })
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
    const patches: Array<{ clipId: typeof moves[number]['clipId']; startSec: number; trackId: typeof moves[number]['toTrackId'] }> = []
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
    for (const patch of patches) {
      await ctx.db.patch(patch.clipId, {
        startSec: patch.startSec,
        trackId: patch.trackId,
      })
    }
    if (patches.length === 0) return { status: 'noop' as const }
    if (!projectId) return { status: 'rejected' as const }
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

    await ctx.db.delete(access.owner._id)
    await ctx.db.delete(clipId)
    await advanceProjectRevision(ctx, access.clip.projectId)
  },
})

export const setName = mutation({
  args: { clipId: v.id('clips'), name: v.string() },
  handler: async (ctx, { clipId, name }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access || effectiveControlClipName(access.clip.name) === effectiveControlClipName(name)) return
    await ctx.db.patch(clipId, { name })
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
    if (effectiveControlClipName(access.clip.name) === effectiveControlClipName(name)) return { status: 'noop' as const }
    await ctx.db.patch(normalizedClipId, { name })
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
    if (JSON.stringify(access.clip.audioWarp) === JSON.stringify(audioWarp)) return { status: 'noop' as const }
    await ctx.db.patch(clipId, { audioWarp })
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
    if (JSON.stringify(access.clip.fades) === JSON.stringify(nextFades)) return { status: 'noop' as const }
    await ctx.db.patch(clipId, { fades: nextFades })
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
    if (JSON.stringify(access.clip.audioWarp) === JSON.stringify(audioWarp)) return { status: 'noop' as const }
    await ctx.db.patch(normalizedClipId, { audioWarp })
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
    if (access.clip.gain === nextGain) return { status: 'noop' as const }
    await ctx.db.patch(normalizedClipId, { gain: nextGain })
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
    if (JSON.stringify(access.clip.fades) === JSON.stringify(nextFades)) return { status: 'noop' as const }
    await ctx.db.patch(normalizedClipId, { fades: nextFades })
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
    await ctx.db.patch(normalizedClipId, { color: normalizedColor })
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
    midi: v.object({
      wave: v.string(),
      gain: v.optional(v.number()),
      notes: v.array(v.object({
        beat: v.number(),
        length: v.number(),
        pitch: v.number(),
        velocity: v.optional(v.number()),
      })),
    }),
  },
  handler: async (ctx, { clipId, midi }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return

    const track = await getMergedTrack(ctx, access.clip.trackId)
    if (!track || !isClipKindCompatibleWithTrack(track, 'midi')) return

    if (controlMidiEqual(access.clip.midi, midi)) return
    await ctx.db.patch(clipId, { midi })
    await advanceProjectRevision(ctx, access.clip.projectId)
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
      midi: v.optional(v.object({
        wave: v.string(),
        gain: v.optional(v.number()),
        notes: v.array(v.object({
          beat: v.number(),
          length: v.number(),
          pitch: v.number(),
          velocity: v.optional(v.number()),
        })),
      })),
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
      midi: v.optional(v.object({
        wave: v.string(),
        gain: v.optional(v.number()),
        notes: v.array(v.object({
          beat: v.number(),
          length: v.number(),
          pitch: v.number(),
          velocity: v.optional(v.number()),
        })),
      })),
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
) => {
    const removedClipIds: Id<'clips'>[] = []
    const skipped: Array<{ clipId: Id<'clips'>; reason: 'access-denied' | 'not-found' }> = []
  const changedProjectIds = new Set<string>()
    const ownerships = await Promise.all(clipIds.map(async (clipId) => ({
      clipId,
      ownership: await getClipOwnership(ctx, clipId),
    })))
    const projectCanWrite = new Map<string, boolean>()
    for (const { clipId, ownership } of ownerships) {
      if (!ownership) {
        skipped.push({ clipId, reason: 'not-found' })
        continue
      }
      if (ownership.owner.ownerUserId !== userId) {
        let canWrite = projectCanWrite.get(ownership.clip.projectId)
        if (canWrite === undefined) {
          canWrite = canWriteProject(await getProjectRole(ctx, ownership.clip.projectId, userId))
          projectCanWrite.set(ownership.clip.projectId, canWrite)
        }
        if (!canWrite) {
          skipped.push({ clipId, reason: 'access-denied' })
          continue
        }
      }
      await ctx.db.delete(ownership.owner._id)
      await ctx.db.delete(clipId)
      removedClipIds.push(clipId)
      changedProjectIds.add(ownership.clip.projectId)
    }
    for (const projectId of changedProjectIds) await advanceProjectRevision(ctx, projectId)
    return {
      removedClipIds,
      skippedClipIds: skipped.map((entry) => entry.clipId),
      skipped,
    }
}

export const removeMany = mutation({
  args: { clipIds: v.array(v.id('clips')) },
  returns: clipDeleteResult,
  handler: async (ctx, { clipIds }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await removeManyForUser(ctx, clipIds, userId)
  },
})

export const serverRemoveMany = mutation({
  args: { clipIds: v.array(v.string()) },
  returns: clipDeleteResult,
  handler: async (ctx, { clipIds }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedClipIds = clipIds.flatMap((clipId) => {
      const normalized = ctx.db.normalizeId('clips', clipId)
      return normalized ? [normalized] : []
    })
    return await removeManyForUser(ctx, normalizedClipIds, userId)
  },
})
