import type { ProjectRole } from '@daw-browser/shared'
import type { ApiContext } from './app-types'
import { requireProjectRoleForApi } from './project-access'
import { createR2ObjectResponse } from './r2-object-response'

export const streamProjectR2Object = async (
  c: ApiContext,
  input: {
    projectId: string
    key: string | undefined
    keyPrefix: string
    roles: ProjectRole[]
    cacheControl: string
    bucket: R2Bucket
  },
) => {
  if (!input.key) return c.json({ error: 'Missing key query parameter' }, 400)
  if (!input.key.startsWith(input.keyPrefix)) return c.json({ error: 'Invalid key' }, 400)
  if (!await requireProjectRoleForApi(c, input.projectId, input.roles)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const object = await input.bucket.get(input.key)
  if (!object) return c.json({ error: 'Not found' }, 404)

  return createR2ObjectResponse(object, input.key, input.cacheControl)
}
