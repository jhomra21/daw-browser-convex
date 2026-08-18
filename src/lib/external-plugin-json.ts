import type { ExternalPluginJsonValue } from '@daw-browser/external-plugins'
import type { JsonValue } from '@daw-browser/shared'
import { z } from 'zod'

const jsonValueSchema: z.ZodType<JsonValue> = z.json()
const jsonPrimitiveSchema = z.union([z.null(), z.boolean(), z.number(), z.string()])
const jsonArraySchema = z.array(jsonValueSchema)
const jsonObjectSchema = z.record(z.string(), jsonValueSchema)

const mutableExternalPluginJsonValue = (value: JsonValue): ExternalPluginJsonValue => {
  const primitive = jsonPrimitiveSchema.safeParse(value)
  if (primitive.success) return primitive.data
  const array = jsonArraySchema.safeParse(value)
  if (array.success) return array.data.map(mutableExternalPluginJsonValue)
  const object = jsonObjectSchema.parse(value)
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, mutableExternalPluginJsonValue(entry)]),
  )
}

export const parseExternalPluginJsonValue = <Value>(value: Value): ExternalPluginJsonValue => (
  mutableExternalPluginJsonValue(jsonValueSchema.parse(value))
)
