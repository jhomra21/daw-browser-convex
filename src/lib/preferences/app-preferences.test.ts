import { describe, expect, test } from "bun:test"
import {
  APP_PREFERENCES_VERSION,
  defaultAppPreferences,
  normalizeAppPreferences,
  parseAppTheme
} from "./app-preferences-core"

describe("normalizeAppPreferences", () => {
  test("falls back to defaults for malformed data", () => {
    expect(normalizeAppPreferences(null)).toEqual(defaultAppPreferences)
    expect(normalizeAppPreferences({ appearance: { theme: "blue" }, sidebar: { open: "yes" } })).toEqual({
      ...defaultAppPreferences,
      appearance: { theme: "system", themeId: "default" },
      sidebar: { open: true },
      timeline: defaultAppPreferences.timeline
    })
    expect(normalizeAppPreferences({ version: 99, appearance: { theme: "dark" } })).toEqual(defaultAppPreferences)
  })

  test("preserves valid preference fields", () => {
    expect(
      normalizeAppPreferences({
        version: 1,
        appearance: { theme: "dark", themeId: "catppuccin" },
        agent: { autoApply: true },
        sidebar: { open: false },
        timeline: { defaultTrackColor: "#123456", defaultGroupColor: "#abcdef" }
      })
    ).toEqual({
      version: 1,
      appearance: { theme: "dark", themeId: "catppuccin" },
      agent: { autoApply: true },
      sidebar: { open: false },
      timeline: { defaultTrackColor: "#123456", defaultGroupColor: "#abcdef" }
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
      sidebar: { open: false },
      timeline: defaultAppPreferences.timeline
    })

    expect(
      normalizeAppPreferences({
        version: 1,
        appearance: { theme: "dark", themeId: "unknown" },
        agent: { autoApply: true },
        sidebar: { open: false },
        timeline: { defaultTrackColor: "red", defaultGroupColor: "#fedcba" }
      })
    ).toEqual({
      version: 1,
      appearance: { theme: "dark", themeId: "default" },
      agent: { autoApply: true },
      sidebar: { open: false },
      timeline: { defaultTrackColor: defaultAppPreferences.timeline.defaultTrackColor, defaultGroupColor: "#fedcba" }
    })
  })

  test("normalizes branch-introduced row color defaults back to timeline surface", () => {
    expect(
      normalizeAppPreferences({
        version: APP_PREFERENCES_VERSION,
        timeline: { defaultTrackColor: "#64748b", defaultGroupColor: "#475569" }
      }).timeline
    ).toEqual(defaultAppPreferences.timeline)
  })
})

describe("theme helpers", () => {
  test("parses stored themes with fallback", () => {
    expect(parseAppTheme("system")).toBe("system")
    expect(parseAppTheme("light")).toBe("light")
    expect(parseAppTheme("dark")).toBe("dark")
    expect(parseAppTheme("blue")).toBe("system")
  })

})
