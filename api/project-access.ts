import { ConvexHttpClient } from 'convex/browser'
import { api as convexApi } from '../convex/_generated/api'
import type { ProjectRole } from '../convex/projectAccess'
import type { ApiContext } from './app-types'

export async function requireProjectRoleForApi(
  c: ApiContext,
  projectId: string,
  roles: ProjectRole[],
) {
  const user = c.get('user')
  if (!user) return null
  const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
  const role = await convex.query(convexApi.projectAccess.roleForUser, { projectId, userId: user.id })
  return role && roles.includes(role) ? user : null
}

export async function requireProjectDeleteOwnerForApi(
  c: ApiContext,
  projectId: string,
) {
  const user = c.get('user')
  if (!user) return null
  const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
  return await convex.query(convexApi.projects.canDeleteAsOwner, { projectId, userId: user.id }) ? user : null
}
