export type ProjectRole = "owner" | "editor" | "viewer"

export const isProjectRole = (value: unknown): value is ProjectRole => (
  value === "owner" || value === "editor" || value === "viewer"
)
