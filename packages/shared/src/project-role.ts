import type { JsonValueInput } from './json-value'

export type ProjectRole = "owner" | "editor" | "viewer"

export const isProjectRole = (value: JsonValueInput): value is ProjectRole => (
  value === "owner" || value === "editor" || value === "viewer"
)
