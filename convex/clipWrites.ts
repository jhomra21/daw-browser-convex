export async function getClipOwnership(ctx: any, clipId: any) {
  const clip = await ctx.db.get(clipId)
  if (!clip) return null
  const owners = await ctx.db
    .query('ownerships')
    .withIndex('by_clip', (q: any) => q.eq('clipId', clipId))
    .collect()
  const owner = owners[0] ?? null
  if (!owner) return null
  return { clip, owner }
}

export async function getClipWriteAccess(ctx: any, clipId: any, userId: string) {
  const access = await getClipOwnership(ctx, clipId)
  if (!access || access.owner.ownerUserId !== userId) return null
  return access
}
