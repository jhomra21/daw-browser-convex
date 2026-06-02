import { api as convexApi } from '../../convex/_generated/api'
import type { App } from '../app-types'
import { parseJsonBody } from '../json-body'
import { requireAuthenticatedConvexForApi, requireProjectRoleContextForApi } from '../project-access'
import { z } from 'zod'

const shareInviteCreateBodySchema = z.object({
  projectId: z.string(),
  role: z.enum(['editor', 'viewer']),
})

const shareInviteAcceptBodySchema = z.object({
  token: z.string(),
})

export function registerShareInviteRoutes(app: App) {
  app.get('/api/projects/:projectId/members', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const access = await requireProjectRoleContextForApi(c, projectId, ['owner', 'editor', 'viewer'])
      if (!access) return c.json({ error: 'Forbidden' }, 403)
      const members = await access.convex.query(convexApi.shareInvites.listAcceptedAccess, {
        projectId,
      })
      return c.json({ members })
    } catch (error) {
      console.error('Project member list error:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to list project members.' }, 500)
    }
  })

  app.delete('/api/projects/:projectId/members/:targetUserId', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const access = await requireProjectRoleContextForApi(c, projectId, ['owner'])
      if (!access) return c.json({ error: 'Forbidden' }, 403)
      const targetUserId = c.req.param('targetUserId')
      const result = await access.convex.mutation(convexApi.shareInvites.revokeAcceptedAccess, {
        projectId,
        targetUserId,
      })
      return c.json({ ...result, purgedProjectId: projectId })
    } catch (error) {
      console.error('Project member revoke error:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to revoke project member.' }, 500)
    }
  })

  app.post('/api/share-invites', async (c) => {
    try {
      const body = await parseJsonBody(c, shareInviteCreateBodySchema)
      if (!body) return c.json({ error: 'Invalid body' }, 400)
      const access = await requireProjectRoleContextForApi(c, body.projectId, ['owner'])
      if (!access) return c.json({ error: 'Forbidden' }, 403)
      const result = await access.convex.mutation(convexApi.shareInvites.create, {
        projectId: body.projectId,
        role: body.role,
      })
      return c.json(result)
    } catch (error) {
      console.error('Share invite create error:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to create share invite.' }, 500)
    }
  })

  app.post('/api/share-invites/accept', async (c) => {
    try {
      const access = await requireAuthenticatedConvexForApi(c)
      if (!access) return c.json({ error: 'Unauthorized' }, 401)
      const body = await parseJsonBody(c, shareInviteAcceptBodySchema)
      if (!body) return c.json({ error: 'Invalid body' }, 400)
      const result = await access.convex.mutation(convexApi.shareInvites.accept, {
        token: body.token,
      })
      return c.json(result)
    } catch (error) {
      console.error('Share invite accept error:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to accept share invite.' }, 500)
    }
  })
}
