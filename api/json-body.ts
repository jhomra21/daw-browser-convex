import type { ZodType } from 'zod'
import type { ApiContext } from './app-types'

export const parseJsonBody = async <T>(c: ApiContext, schema: ZodType<T>): Promise<T | null> => {
  const value = await c.req.json().catch(() => null)
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}
