import { describe, expect, test } from "bun:test"
import {
  APP_PREFERENCES_VERSION,
  defaultAppPreferences,
  normalizeAppPreferences,
  parseAppTheme
} from "./app-preferences-core"
import { themeColorInputValue } from "./theme-color-input"
import { DEFAULT_DAW_THEME_ID } from "~/lib/theme/theme-registry"
import { resolveDawThemeById } from "~/lib/theme/theme-resolver"

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
    expect(
      normalizeAppPreferences({
        version: APP_PREFERENCES_VERSION,
        timeline: { defaultTrackColor: "#181824", defaultGroupColor: "#181824" }
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

  test("maps default timeline surface tokens to color input values", () => {
    expect(themeColorInputValue("timeline-surface", resolveDawThemeById(DEFAULT_DAW_THEME_ID, "light"), DEFAULT_DAW_THEME_ID, "light")).toBe("#e2e8f0")
    expect(themeColorInputValue("timeline-surface", resolveDawThemeById(DEFAULT_DAW_THEME_ID, "dark"), DEFAULT_DAW_THEME_ID, "dark")).toBe("#181824")
  })

  test("preserves custom hex colors and hex theme token values for color inputs", () => {
    expect(themeColorInputValue("#123456", resolveDawThemeById(DEFAULT_DAW_THEME_ID, "light"), DEFAULT_DAW_THEME_ID, "light")).toBe("#123456")
    expect(themeColorInputValue("timeline-surface", resolveDawThemeById("catppuccin", "light"), "catppuccin", "light")).toBe("#e2e8f0")
    expect(themeColorInputValue("red", resolveDawThemeById(DEFAULT_DAW_THEME_ID, "light"), DEFAULT_DAW_THEME_ID, "light")).toBe("#181824")
  })
})
