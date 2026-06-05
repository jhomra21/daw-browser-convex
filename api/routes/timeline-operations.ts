import { api as convexApi } from '../../convex/_generated/api'
import type { App } from '../app-types'
import { parseJsonBody } from '../json-body'
import { requireProjectRoleContextForApi } from '../project-access'
import { sharedTimelineOperationSchema } from '@daw-browser/shared'
import { executeTimelineOperation, TimelineOperationTargetError } from '../timeline-operation-executor'

export function registerTimelineOperationRoutes(app: App) {
  app.get('/api/projects/:projectId/timeline/full-view', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const access = await requireProjectRoleContextForApi(c, projectId, ['owner', 'editor', 'viewer'])
      if (!access) return c.json({ error: 'Forbidden' }, 403)
      const result = await access.convex.query(convexApi.timeline.fullViewAuthed, {
        projectId,
      })
      return c.json(result)
    } catch (error) {
      console.error('Timeline full-view error', error)
      return c.json({ error: 'Timeline full-view failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/timeline/operations', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const access = await requireProjectRoleContextForApi(c, projectId, ['owner', 'editor'])
      if (!access) return c.json({ error: 'Forbidden' }, 403)
      const operation = await parseJsonBody(c, sharedTimelineOperationSchema)
      if (!operation) return c.json({ error: 'Invalid timeline operation' }, 400)

      const result = await executeTimelineOperation({ convex: access.convex, projectId }, operation)
      return c.json(result)
    } catch (error) {
      console.error('Timeline operation error', error)
      if (error instanceof TimelineOperationTargetError) {
        return c.json({ error: error.message }, 400)
      }
      return c.json({ error: 'Timeline operation failed' }, 500)
    }
  })
}
