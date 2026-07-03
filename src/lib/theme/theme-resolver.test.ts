import { describe, expect, test } from "bun:test"
import { getTheme, parseThemeId, themeIds, themeOptions } from "./theme-registry"
import { resolveDawTheme, resolveDawThemeById, themeTokensToCss } from "./theme-resolver"

describe("theme registry", () => {
  test("parses known ids and falls back to default", () => {
    expect(parseThemeId("default")).toBe("default")
    expect(parseThemeId("catppuccin")).toBe("catppuccin")
    expect(parseThemeId("missing")).toBe("default")
  })

  test("exposes options for each built-in theme", () => {
    expect(themeOptions.map((option) => option.id)).toEqual([...themeIds])
  })
})

describe("theme resolver", () => {
  test("resolves built-in themes to concrete app tokens", () => {
    for (const id of themeIds) {
      const light = resolveDawThemeById(id, "light")
      const dark = resolveDawThemeById(id, "dark")

      expect(light.background.length).toBeGreaterThan(0)
      expect(dark.background.length).toBeGreaterThan(0)
      expect(light["timeline-grid-minor"]).not.toContain("var(")
      expect(dark["device-graph-grid"]).not.toContain("color-mix")
    }
  })

  test("applies DAW token overrides", () => {
    const base = getTheme("default")
    const tokens = resolveDawTheme(
      {
        id: "override-test",
        name: "Override Test",
        light: {
          palette: base.light.palette,
          overrides: {
            "timeline-background": "#123456"
          }
        },
        dark: base.dark
      },
      "light"
    )

    expect(tokens["timeline-background"]).toBe("#123456")
  })

  test("serializes resolved tokens to CSS custom properties", () => {
    const css = themeTokensToCss(resolveDawThemeById("catppuccin", "dark"))

    expect(css).toContain("--background:")
    expect(css).toContain("--timeline-background:")
    expect(css).not.toContain("var(")
  })
})
