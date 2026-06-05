import { api as convexApi } from '../convex/_generated/api'
import type { ProjectRole } from '@daw-browser/shared'
import type { ApiContext } from './app-types'
import { createAuthenticatedConvexClient } from './convex-auth'

export async function requireAuthenticatedConvexForApi(c: ApiContext) {
  const user = c.get('user')
  if (!user) return null
  return {
    user,
    convex: await createAuthenticatedConvexClient(c, user),
  }
}

export async function requireProjectRoleForApi(
  c: ApiContext,
  projectId: string,
  roles: ProjectRole[],
) {
  const access = await requireProjectRoleContextForApi(c, projectId, roles)
  return access?.user ?? null
}

export async function requireProjectRoleContextForApi(
  c: ApiContext,
  projectId: string,
  roles: ProjectRole[],
) {
  const access = await requireAuthenticatedConvexForApi(c)
  if (!access) return null
  const { user, convex } = access
  const role = await convex.query(convexApi.projectAccess.roleForUser, { projectId })
  return role && roles.includes(role) ? { user, convex } : null
}

export async function requireProjectDeleteOwnerContextForApi(
  c: ApiContext,
  projectId: string,
) {
  const access = await requireAuthenticatedConvexForApi(c)
  if (!access) return null
  return await access.convex.query(convexApi.projects.canDeleteAsOwner, { projectId }) ? access : null
}
