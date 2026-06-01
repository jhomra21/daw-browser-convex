import type { Id } from './_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { v } from 'convex/values'

import { getClipOwnership, getClipWriteAccess } from './clipWrites'
import { getMergedTrack } from './mixerChannels'
import { getProjectRole, requireProjectAccess } from './projectAccess'
import { upsertSampleRow } from './sampleRows'
import { isClipKindCompatibleWithTrack } from './trackRouting'
import { getTrackWriteAccess } from './trackWrites'
import { normalizeClipStartSec, normalizeClipTimingPatch } from '../src/lib/clip-timing'
import { buildClipAudioSourceFields, normalizeAudioSourceMetadataPatch, sanitizePositiveNumber, type AudioSourceKind } from '../src/lib/audio-source-rules'

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
  midiOffsetBeats?: number
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
}

type ClipDbCtx = MutationCtx | QueryCtx

const canWriteProject = (role: string | null) => role === 'owner' || role === 'editor'

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
  midiOffsetBeats?: number
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
    midiOffsetBeats: item.midiOffsetBeats,
  }
  Object.assign(patch, buildClipAudioSourceFields(metadata))

  return patch
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

const createOwnedClip = async (
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
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, { projectId, userId }) => {
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
    userId: v.string(),
    name: v.optional(v.string()),
    sampleUrl: v.optional(v.string()),
    assetKey: v.optional(v.string()),
    sourceKind: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    channelCount: v.optional(v.number()),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    midiOffsetBeats: v.optional(v.number()),
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
  },
  handler: async (ctx, args) => {
    return await createOwnedClip(ctx, args)
  },
})

export const move = mutation({
  args: {
    clipId: v.id('clips'),
    userId: v.string(),
    startSec: v.number(),
    toTrackId: v.optional(v.id('tracks')),
  },
  handler: async (ctx, { clipId, userId, startSec, toTrackId }) => {
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
    await ctx.db.patch(clipId, {
      startSec: nextStartSec,
      trackId: nextTrackId,
    })
    return { status: 'applied' as const }
  },
})

export const moveMany = mutation({
  args: {
    moves: v.array(v.object({
      clipId: v.id('clips'),
      startSec: v.number(),
      toTrackId: v.optional(v.id('tracks')),
    })),
    userId: v.string(),
  },
  handler: async (ctx, { moves, userId }) => {
    const patches: Array<{ clipId: typeof moves[number]['clipId']; startSec: number; trackId: typeof moves[number]['toTrackId'] }> = []
    for (const move of moves) {
      const access = await getClipWriteAccess(ctx, move.clipId, userId)
      if (!access) return { status: 'rejected' as const }
      const clip = access.clip
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
      patches.push({
        clipId: move.clipId,
        startSec: normalizeClipStartSec(move.startSec),
        trackId: nextTrackId,
      })
    }
    for (const patch of patches) {
      await ctx.db.patch(patch.clipId, {
        startSec: patch.startSec,
        trackId: patch.trackId,
      })
    }
    return { status: 'applied' as const }
  },
})

export const remove = mutation({
  args: { clipId: v.id('clips'), userId: v.string() },
  handler: async (ctx, { clipId, userId }) => {
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return

    await ctx.db.delete(access.owner._id)
    await ctx.db.delete(clipId)
  },
})

export const setName = mutation({
  args: { clipId: v.id('clips'), userId: v.string(), name: v.string() },
  handler: async (ctx, { clipId, userId, name }) => {
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return
    await ctx.db.patch(clipId, { name })
  },
})

export const setTiming = mutation({
  args: {
    clipId: v.id('clips'),
    userId: v.string(),
    startSec: v.number(),
    duration: v.number(),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    midiOffsetBeats: v.optional(v.number()),
  },
  handler: async (ctx, { clipId, userId, startSec, duration, leftPadSec, bufferOffsetSec, midiOffsetBeats }) => {
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return { status: 'rejected' as const }
    if (await isTrackLockedByOther(ctx, access.clip.trackId, userId)) return { status: 'rejected' as const }

    const normalizedTiming = normalizeClipTimingPatch({
      startSec,
      duration,
      leftPadSec,
      bufferOffsetSec,
      midiOffsetBeats,
    })
    const patch: Record<string, unknown> = {
      startSec: normalizedTiming.startSec,
      duration: normalizedTiming.duration,
    }
    if (normalizedTiming.leftPadSec !== undefined) patch.leftPadSec = normalizedTiming.leftPadSec
    if (normalizedTiming.bufferOffsetSec !== undefined) patch.bufferOffsetSec = normalizedTiming.bufferOffsetSec
    if (normalizedTiming.midiOffsetBeats !== undefined) patch.midiOffsetBeats = normalizedTiming.midiOffsetBeats
    await ctx.db.patch(clipId, patch)
    return { status: 'applied' as const }
  },
})

export const setMidi = mutation({
  args: {
    clipId: v.id('clips'),
    userId: v.string(),
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
  handler: async (ctx, { clipId, midi, userId }) => {
    const access = await getClipWriteAccess(ctx, clipId, userId)
    if (!access) return

    const track = await getMergedTrack(ctx, access.clip.trackId)
    if (!track || !isClipKindCompatibleWithTrack(track, 'midi')) return

    await ctx.db.patch(clipId, { midi })
  },
})

export const createMany = mutation({
  args: {
    items: v.array(v.object({
      projectId: v.string(),
      trackId: v.id('tracks'),
      startSec: v.number(),
      duration: v.number(),
      userId: v.string(),
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
      midiOffsetBeats: v.optional(v.number()),
      clipKind: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { items }) => {
    const createdIds: Array<Id<'clips'> | null> = []
    for (const item of items) {
      const clipId = await createOwnedClip(ctx, item)
      createdIds.push(clipId ?? null)
    }
    return createdIds
  },
})

export const removeMany = mutation({
  args: { clipIds: v.array(v.id('clips')), userId: v.string() },
  returns: clipDeleteResult,
  handler: async (ctx, { clipIds, userId }) => {
    const removedClipIds: Id<'clips'>[] = []
    const skipped: Array<{ clipId: Id<'clips'>; reason: 'access-denied' | 'not-found' }> = []
    const ownerships = await Promise.all(clipIds.map(async (clipId) => ({
      clipId,
      ownership: await getClipOwnership(ctx, clipId),
    })))
    for (const { clipId, ownership } of ownerships) {
      if (!ownership) {
        skipped.push({ clipId, reason: 'not-found' })
        continue
      }
      if (ownership.owner.ownerUserId !== userId && !canWriteProject(await getProjectRole(ctx, ownership.clip.projectId, userId))) {
        skipped.push({ clipId, reason: 'access-denied' })
        continue
      }
      await ctx.db.delete(ownership.owner._id)
      await ctx.db.delete(clipId)
      removedClipIds.push(clipId)
    }
    return {
      removedClipIds,
      skippedClipIds: skipped.map((entry) => entry.clipId),
      skipped,
    }
  },
})
