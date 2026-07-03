import { describe, expect, test } from "bun:test"
import {
  defaultAppPreferences,
  normalizeAppPreferences,
  parseAppTheme,
  parseAppThemeSelectValue
} from "./app-preferences-core"

describe("normalizeAppPreferences", () => {
  test("falls back to defaults for malformed data", () => {
    expect(normalizeAppPreferences(null)).toEqual(defaultAppPreferences)
    expect(normalizeAppPreferences({ appearance: { theme: "blue" }, sidebar: { open: "yes" } })).toEqual({
      ...defaultAppPreferences,
      appearance: { theme: "system", themeId: "default" },
      sidebar: { open: true }
    })
    expect(normalizeAppPreferences({ version: 99, appearance: { theme: "dark" } })).toEqual(defaultAppPreferences)
  })

  test("preserves valid preference fields", () => {
    expect(
      normalizeAppPreferences({
        version: 1,
        appearance: { theme: "dark", themeId: "catppuccin" },
        agent: { autoApply: true },
        sidebar: { open: false }
      })
    ).toEqual({
      version: 1,
      appearance: { theme: "dark", themeId: "catppuccin" },
      agent: { autoApply: true },
      sidebar: { open: false }
    })
  })

  test("normalizes missing and unknown theme ids without dropping valid fields", () => {
    expect(
      normalizeAppPreferences({
        version: 1,
        appearance: { theme: "light" },
        agent: { autoApply: true },
        sidebar: { open: false }
      })
    ).toEqual({
      version: 1,
      appearance: { theme: "light", themeId: "default" },
      agent: { autoApply: true },
      sidebar: { open: false }
    })

    expect(
      normalizeAppPreferences({
        version: 1,
        appearance: { theme: "dark", themeId: "unknown" },
        agent: { autoApply: true },
        sidebar: { open: false }
      })
    ).toEqual({
      version: 1,
      appearance: { theme: "dark", themeId: "default" },
      agent: { autoApply: true },
      sidebar: { open: false }
    })
  })
})

describe("theme helpers", () => {
  test("parses stored themes with fallback", () => {
    expect(parseAppTheme("system")).toBe("system")
    expect(parseAppTheme("light")).toBe("light")
    expect(parseAppTheme("dark")).toBe("dark")
    expect(parseAppTheme("blue")).toBe("system")
  })

  test("parses select values without fallback mutation", () => {
    expect(parseAppThemeSelectValue("system")).toBe("system")
    expect(parseAppThemeSelectValue("light")).toBe("light")
    expect(parseAppThemeSelectValue("dark")).toBe("dark")
    expect(parseAppThemeSelectValue("blue")).toBeNull()
  })
})
