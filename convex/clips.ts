import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

import { getClipOwnership, getClipWriteAccess } from './clipWrites'
import { getMergedTrack } from './mixerChannels'
import { upsertSampleRow } from './sampleRows'
import { isClipKindCompatibleWithTrack } from './trackRouting'
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
  roomId: string
  trackId: any
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

const sanitizeClipKind = (value: string | undefined): ClipKind => {
  if (value === 'midi') return 'midi'
  return 'audio'
}

const canCreateClipOnTrack = (track: any, clipKind: ClipKind) =>
  isClipKindCompatibleWithTrack(track as any, clipKind)

const getCompatibleMergedTrack = async (
  ctx: any,
  trackId: any,
  roomId: string,
  clipKind: ClipKind,
) => {
  const track = await getMergedTrack(ctx, trackId)
  if (!track || track.roomId !== roomId) return null
  if (!canCreateClipOnTrack(track, clipKind)) return null
  return track
}

const buildClipCreatePatch = (
  item: ClipCreateInput,
  metadata: AudioSourceMetadataInput,
) => {
  const patch: Record<string, unknown> = {
    roomId: item.roomId,
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
  ctx: any,
  clip: {
    roomId: string
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
    roomId: clip.roomId,
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
  ctx: any,
  item: ClipCreateInput,
) => {
  const clipKind = sanitizeClipKind(item.clipKind ?? (item.midi ? 'midi' : 'audio'))
  const track = await getCompatibleMergedTrack(ctx, item.trackId, item.roomId, clipKind)
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
    roomId: item.roomId,
    ownerUserId: item.userId,
    clipId,
  })

  await upsertSampleRowForClip(
    ctx,
    {
      roomId: item.roomId,
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
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    return await ctx.db
      .query('clips')
      .withIndex('by_room', q => q.eq('roomId', roomId))
      .collect()
  },
})

export const create = mutation({
  args: {
    roomId: v.string(),
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
    if (!access) return
    const clip = access.clip
    if (toTrackId) {
      const targetTrack = await getCompatibleMergedTrack(
        ctx,
        toTrackId,
        clip.roomId,
        sanitizeClipKind((clip as any).midi ? 'midi' : 'audio'),
      )
      if (!targetTrack) return
    }
    await ctx.db.patch(clipId, {
      startSec,
      trackId: toTrackId ?? clip.trackId,
    })
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
    if (!access) return
    const safeStart = Math.max(0, startSec)
    const safeDuration = Math.max(0, duration)
    const safePad = typeof leftPadSec === 'number' && isFinite(leftPadSec) ? Math.max(0, leftPadSec) : undefined
    const safeBuf = typeof bufferOffsetSec === 'number' && isFinite(bufferOffsetSec) ? Math.max(0, bufferOffsetSec) : undefined
    const safeMidiOff = typeof midiOffsetBeats === 'number' && isFinite(midiOffsetBeats) ? Math.max(0, midiOffsetBeats) : undefined
    const patch: Record<string, unknown> = { startSec: safeStart, duration: safeDuration }
    if (safePad !== undefined) patch.leftPadSec = safePad
    if (safeBuf !== undefined) patch.bufferOffsetSec = safeBuf
    if (safeMidiOff !== undefined) patch.midiOffsetBeats = safeMidiOff
    await ctx.db.patch(clipId, patch)
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
    if (!track || !isClipKindCompatibleWithTrack(track as any, 'midi')) return

    await ctx.db.patch(clipId, { midi })
  },
})

export const createMany = mutation({
  args: {
    items: v.array(v.object({
      roomId: v.string(),
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
    const createdIds: any[] = []
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
    const removedClipIds: any[] = []
    const skipped: Array<{ clipId: any; reason: 'access-denied' | 'not-found' }> = []
    for (const clipId of clipIds) {
      const ownership = await getClipOwnership(ctx, clipId)
      if (!ownership) {
        skipped.push({ clipId, reason: 'not-found' })
        continue
      }
      if (ownership.owner.ownerUserId !== userId) {
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
