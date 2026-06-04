import type { ApiContext, App } from '../app-types'
import { drainDueR2DeleteQueue } from '../r2-delete-queue'

const readBearerToken = (authorization: string | undefined): string | null => {
  if (!authorization) return null
  const [scheme, token, extra] = authorization.split(' ')
  return scheme === 'Bearer' && token && !extra ? token : null
}

const hasSameCredential = (actual: string, expected: string) => {
  if (actual.length !== expected.length) return false
  let mismatch = 0
  for (let index = 0; index < actual.length; index++) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return mismatch === 0
}

const hasMaintenanceAccess = (c: ApiContext) => {
  const configuredCredential = c.env.R2_DELETE_QUEUE_DRAIN_TOKEN
  const bearerCredential = readBearerToken(c.req.header('Authorization'))
  return Boolean(configuredCredential && bearerCredential && hasSameCredential(bearerCredential, configuredCredential))
}

export function registerMaintenanceRoutes(app: App) {
  app.post('/api/maintenance/r2-delete-queue/drain', async (c) => {
    if (!hasMaintenanceAccess(c)) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const result = await drainDueR2DeleteQueue({
        c,
        bucket: c.env.daw_audio_samples,
        limit: 100,
      })
      return c.json({ ok: true, result })
    } catch (err) {
      console.error('R2 delete queue drain error', err)
      return c.json({ error: 'Failed to drain R2 delete queue' }, 500)
    }
  })
}
