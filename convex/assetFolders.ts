import { mutation, query, type QueryCtx } from './_generated/server'
import { v } from 'convex/values'

import { requireAuthenticatedUserId, requireProjectAccess, requireProjectRole } from './projectAccess'

const normalizeFolderName = (name: string) => name.trim() || 'Folder'

const findFolder = async (ctx: { db: QueryCtx['db'] }, input: { projectId: string; folderId: string }) => {
  const rows = await ctx.db
    .query('assetFolders')
    .withIndex('by_project', q => q.eq('projectId', input.projectId))
    .collect()
  return rows.find((row) => String(row._id) === input.folderId) ?? null
}

export const listByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    await requireProjectAccess(ctx, projectId, userId)
    const rows = await ctx.db
      .query('assetFolders')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .collect()
    return rows.sort((left, right) => left.name.localeCompare(right.name))
  },
})

export const create = mutation({
  args: {
    projectId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, { projectId, name }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    await requireProjectRole(ctx, projectId, userId, ['owner', 'editor'])
    const now = Date.now()
    return await ctx.db.insert('assetFolders', {
      projectId,
      name: normalizeFolderName(name),
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const rename = mutation({
  args: {
    projectId: v.string(),
    folderId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, { projectId, folderId, name }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    await requireProjectRole(ctx, projectId, userId, ['owner', 'editor'])
    const folder = await findFolder(ctx, { projectId, folderId })
    if (!folder) return null
    await ctx.db.patch(folder._id, {
      name: normalizeFolderName(name),
      updatedAt: Date.now(),
    })
    return folder._id
  },
})

export const deleteEmpty = mutation({
  args: {
    projectId: v.string(),
    folderId: v.string(),
  },
  handler: async (ctx, { projectId, folderId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    await requireProjectRole(ctx, projectId, userId, ['owner', 'editor'])
    const folder = await findFolder(ctx, { projectId, folderId })
    if (!folder) return false
    const samples = await ctx.db
      .query('samples')
      .withIndex('by_room', q => q.eq('projectId', projectId))
      .collect()
    if (samples.some((sample) => sample.folderId === folderId)) return false
    await ctx.db.delete(folder._id)
    return true
  },
})
