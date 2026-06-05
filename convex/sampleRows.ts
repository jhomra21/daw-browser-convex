import {
  sanitizeAudioAssetKey as sanitizeAssetKey,
  sanitizeAudioSourceKind as sanitizeSourceKind,
  sanitizePositiveInt,
  sanitizePositiveNumber,
} from '@daw-browser/shared'

export type { AudioSourceKind } from '@daw-browser/shared'

export type UpsertSampleRowInput = {
  projectId: string
  url?: string
  assetKey?: string
  sourceKind?: string
  ownerUserId: string
  name?: string
  duration?: number
  sampleRate?: number
  channelCount?: number
}

const numbersDiffer = (left: number | undefined, right: number | undefined, epsilon = 1e-6) => {
  if (left === undefined || right === undefined) return left !== right
  return Math.abs(left - right) > epsilon
}

export async function findSampleRow(ctx: any, input: { projectId: string; assetKey?: string }) {
  const assetKey = sanitizeAssetKey(input.assetKey)
  if (!assetKey) return null
  const rows = await ctx.db
    .query('samples')
    .withIndex('by_room_assetKey', (q: any) => q.eq('projectId', input.projectId).eq('assetKey', assetKey))
    .collect()
  return rows[0] ?? null
}

export async function upsertSampleRow(ctx: any, input: UpsertSampleRowInput) {
  const url = typeof input.url === 'string' ? input.url : undefined
  if (!url) return null

  const assetKey = sanitizeAssetKey(input.assetKey)
  const sourceKind = sanitizeSourceKind(input.sourceKind)
  const duration = sanitizePositiveNumber(input.duration)
  const sampleRate = sanitizePositiveInt(input.sampleRate)
  const channelCount = sanitizePositiveInt(input.channelCount)
  if (!assetKey || !sourceKind || duration === undefined || sampleRate === undefined || channelCount === undefined) return null

  const existingRow = await findSampleRow(ctx, { projectId: input.projectId, assetKey })
  if (existingRow) {
    const patch: Record<string, unknown> = {}
    if (existingRow.url !== url) patch.url = url
    if (!existingRow.name && input.name) patch.name = input.name
    const currentDuration = sanitizePositiveNumber(existingRow.duration)
    if (currentDuration === undefined || numbersDiffer(currentDuration, duration)) {
      patch.duration = duration
    }
    if (existingRow.sampleRate !== sampleRate) patch.sampleRate = sampleRate
    if (existingRow.channelCount !== channelCount) patch.channelCount = channelCount
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(existingRow._id, patch)
    }
    return existingRow._id
  }

  return await ctx.db.insert('samples', {
    projectId: input.projectId,
    url,
    assetKey,
    sourceKind,
    name: input.name,
    duration,
    sampleRate,
    channelCount,
    ownerUserId: input.ownerUserId,
    createdAt: Date.now(),
  })
}
