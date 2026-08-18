import { z } from 'zod'

export type JsonPrimitive = null | boolean | number | string

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject

export type JsonObject = { readonly [key: string]: JsonValue }

const jsonValueSchema: z.ZodType<JsonValue> = z.json()

export type JsonValueInput = z.input<typeof jsonValueSchema>

export const parseJsonValue = (value: JsonValueInput): JsonValue | undefined => {
  const result = jsonValueSchema.safeParse(value)
  return result.success ? result.data : undefined
}

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

export const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string'

export const isJsonNumber = (value: JsonValue | undefined): value is number => typeof value === 'number'

export const isJsonBoolean = (value: JsonValue | undefined): value is boolean => typeof value === 'boolean'
