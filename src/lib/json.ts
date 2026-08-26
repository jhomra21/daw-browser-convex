import type { JsonValue } from '@daw-browser/shared'
import { z } from 'zod'

const jsonValueSchema: z.ZodType<JsonValue> = z.json()

export const serializeJsonValue = <Value>(value: Value): JsonValue => (
  jsonValueSchema.parse(JSON.parse(JSON.stringify(value)))
)
