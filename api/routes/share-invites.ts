import { ConvexHttpClient } from 'convex/browser'
import { api as convexApi } from '../../convex/_generated/api'
import type { ApiContext, App } from '../app-types'

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readShareInviteCreateBody = (value: unknown) => {
  if (!isRecord(value) || typeof value.projectId !== 'string') return null
  return {
    projectId: value.projectId,
    role: value.role === 'editor' ? 'editor' as const : 'viewer' as const,
  }
}

const readShareInviteAcceptBody = (value: unknown) => {
  if (!isRecord(value) || typeof value.token !== 'string') return null
  return { token: value.token }
}

const requireShareInviteServiceToken = (c: ApiContext) => {
  if (!c.env.SHARE_INVITES_SERVICE_TOKEN) {
    throw new Error('Share invite service token is not configured.')
  }
  return c.env.SHARE_INVITES_SERVICE_TOKEN
}


export function registerShareInviteRoutes(app: App) {
  app.get('/api/projects/:projectId/members', async (c) => {
    try {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Unauthorized' }, 401)
      const projectId = c.req.param('projectId')
      const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
      const members = await convex.query(convexApi.shareInvites.listAcceptedAccess, {
        projectId,
        userId: user.id,
        serverSecret: requireShareInviteServiceToken(c),
      })
      return c.json({ members })
    } catch (error) {
      console.error('Project member list error:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to list project members.' }, 500)
    }
  })

  app.delete('/api/projects/:projectId/members/:targetUserId', async (c) => {
    try {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Unauthorized' }, 401)
      const projectId = c.req.param('projectId')
      const targetUserId = c.req.param('targetUserId')
      const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
      const result = await convex.mutation(convexApi.shareInvites.revokeAcceptedAccess, {
        projectId,
        userId: user.id,
        targetUserId,
        serverSecret: requireShareInviteServiceToken(c),
      })
      return c.json({ ...result, purgedProjectId: projectId })
    } catch (error) {
      console.error('Project member revoke error:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to revoke project member.' }, 500)
    }
  })

  app.post('/api/share-invites', async (c) => {
    try {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Unauthorized' }, 401)
      const body = readShareInviteCreateBody(await c.req.json().catch(() => null))
      if (!body) return c.json({ error: 'Invalid body' }, 400)
      const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
      const result = await convex.mutation(convexApi.shareInvites.create, {
        projectId: body.projectId,
        userId: user.id,
        role: body.role,
        serverSecret: requireShareInviteServiceToken(c),
      })
      return c.json(result)
    } catch (error) {
      console.error('Share invite create error:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to create share invite.' }, 500)
    }
  })

  app.post('/api/share-invites/accept', async (c) => {
    try {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Unauthorized' }, 401)
      const body = readShareInviteAcceptBody(await c.req.json().catch(() => null))
      if (!body) return c.json({ error: 'Invalid body' }, 400)
      const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
      const result = await convex.mutation(convexApi.shareInvites.accept, {
        token: body.token,
        userId: user.id,
        serverSecret: requireShareInviteServiceToken(c),
      })
      return c.json(result)
    } catch (error) {
      console.error('Share invite accept error:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to accept share invite.' }, 500)
    }
  })
}
