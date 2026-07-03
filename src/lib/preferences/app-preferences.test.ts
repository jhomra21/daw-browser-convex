import { describe, expect, test } from "bun:test"
import {
  defaultAppPreferences,
  normalizeAppPreferences
} from "./app-preferences-core"

describe("normalizeAppPreferences", () => {
  test("falls back to defaults for malformed data", () => {
    expect(normalizeAppPreferences(null)).toEqual(defaultAppPreferences)
    expect(normalizeAppPreferences({ appearance: { theme: "blue" }, sidebar: { open: "yes" } })).toEqual({
      ...defaultAppPreferences,
      appearance: { theme: "system" },
      sidebar: { open: true }
    })
    expect(normalizeAppPreferences({ version: 99, appearance: { theme: "dark" } })).toEqual(defaultAppPreferences)
  })

  test("preserves valid preference fields", () => {
    expect(
      normalizeAppPreferences({
        version: 1,
        appearance: { theme: "dark" },
        agent: { autoApply: true },
        sidebar: { open: false }
      })
    ).toEqual({
      version: 1,
      appearance: { theme: "dark" },
      agent: { autoApply: true },
      sidebar: { open: false }
    })
  })
})
