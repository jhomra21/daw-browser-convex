import { getTheme, type DawThemeId } from "./theme-registry"
import { dawThemeTokenNames, type DawTheme, type DawThemeTokenName, type DawThemeVariant } from "./theme-types"

export type ResolvedThemeTokens = Record<DawThemeTokenName, string>

const withAlpha = (color: string, alpha: string) => `${color}${alpha}`

const resolveVariantTokens = (variant: DawThemeVariant, mode: "light" | "dark") => {
  const palette = variant.palette
  const dark = mode === "dark"
  const neutral = palette.neutral
  const ink = palette.ink
  const primary = palette.primary
  const accent = palette.accent ?? palette.primary
  const interactive = palette.interactive ?? palette.primary

  const tokens = {
    background: neutral,
    foreground: ink,
    card: dark ? "#181824" : "#ffffff",
    "card-foreground": ink,
    popover: dark ? "#181824" : "#ffffff",
    "popover-foreground": ink,
    primary: interactive,
    "primary-foreground": dark ? "#111827" : "#ffffff",
    secondary: dark ? "#242638" : "#eef2f7",
    "secondary-foreground": ink,
    muted: dark ? "#242638" : "#eef2f7",
    "muted-foreground": dark ? "#a6adc8" : "#64748b",
    accent,
    "accent-foreground": dark ? "#111827" : "#ffffff",
    destructive: palette.error,
    "destructive-foreground": dark ? "#111827" : "#ffffff",
    info: palette.info,
    "info-foreground": dark ? "#111827" : "#ffffff",
    success: palette.success,
    "success-foreground": dark ? "#111827" : "#ffffff",
    warning: palette.warning,
    "warning-foreground": dark ? "#111827" : "#ffffff",
    error: palette.error,
    "error-foreground": dark ? "#111827" : "#ffffff",
    border: dark ? "#313244" : "#d9e0ee",
    input: dark ? "#313244" : "#d9e0ee",
    ring: primary,
    "app-surface": dark ? "#181824" : "#f8fafc",
    "app-surface-muted": dark ? "#242638" : "#eef2f7",
    "timeline-background": dark ? "#11111b" : "#f1f5f9",
    "timeline-surface": dark ? "#181824" : "#e2e8f0",
    "timeline-surface-muted": dark ? "#242638" : "#cbd5e1",
    "timeline-grid-minor": dark ? withAlpha("#ffffff", "14") : withAlpha("#111827", "1a"),
    "timeline-grid-major": dark ? withAlpha("#ffffff", "29") : withAlpha("#111827", "33"),
    "timeline-playhead": palette.error,
    "clip-audio": palette.success,
    "clip-audio-foreground": dark ? "#111827" : "#ffffff",
    "clip-midi": primary,
    "clip-midi-foreground": dark ? "#111827" : "#ffffff",
    "clip-selected": palette.warning,
    "clip-selected-foreground": "#111827",
    "clip-recording": palette.error,
    "meter-safe": palette.success,
    "meter-warning": palette.warning,
    "meter-clipping": palette.error,
    "device-graph-background": dark ? "#11111b" : "#f8fafc",
    "device-graph-grid": dark ? withAlpha("#ffffff", "29") : withAlpha("#111827", "29"),
    "device-graph-accent": palette.info,
    recording: palette.error,
    automation: accent,
    sidebar: dark ? "#181824" : "#f8fafc",
    "sidebar-foreground": ink,
    "sidebar-primary": primary,
    "sidebar-primary-foreground": dark ? "#111827" : "#ffffff",
    "sidebar-accent": dark ? "#242638" : "#eef2f7",
    "sidebar-accent-foreground": ink,
    "sidebar-border": dark ? "#313244" : "#d9e0ee",
    "sidebar-ring": primary
  } satisfies ResolvedThemeTokens

  if (!variant.overrides) return tokens

  for (const name of dawThemeTokenNames) {
    const value = variant.overrides[name]
    if (value) tokens[name] = value
  }
  return tokens
}

export const resolveDawTheme = (theme: DawTheme, mode: "light" | "dark"): ResolvedThemeTokens =>
  resolveVariantTokens(mode === "dark" ? theme.dark : theme.light, mode)

export const resolveDawThemeById = (themeId: DawThemeId, mode: "light" | "dark"): ResolvedThemeTokens =>
  resolveDawTheme(getTheme(themeId), mode)

export const themeTokensToCss = (tokens: ResolvedThemeTokens): string =>
  dawThemeTokenNames
    .map((name) => `  --${name}: ${tokens[name]};`)
    .join("\n")

const ensureThemeStyleElement = (document: Document): HTMLStyleElement => {
  const existing = document.getElementById("daw-theme")
  if (existing instanceof HTMLStyleElement) return existing
  const element = document.createElement("style")
  element.id = "daw-theme"
  document.head.appendChild(element)
  return element
}

type ApplyDawThemeResult = {
  changed: boolean
  tokens: ResolvedThemeTokens
}

export const applyDawTheme = (themeId: DawThemeId, mode: "light" | "dark"): ApplyDawThemeResult => {
  const tokens = resolveDawThemeById(themeId, mode)
  const document = globalThis.document
  if (!document) return { changed: false, tokens }
  const css = `:root {\n${themeTokensToCss(tokens)}\n}`
  const element = ensureThemeStyleElement(document)
  const changed = element.textContent !== css || document.documentElement.dataset.dawTheme !== themeId
  if (!changed) return { changed, tokens }
  element.textContent = css
  document.documentElement.dataset.dawTheme = themeId
  return { changed, tokens }
}
