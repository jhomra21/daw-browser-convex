import type { DawTheme, DawThemeId } from "./theme-types"
export type { DawThemeId } from "./theme-types"

export type DawThemeOption = {
  id: DawThemeId
  name: string
}

export const DEFAULT_DAW_THEME_ID: DawThemeId = "default"

const builtInThemes: readonly DawTheme[] = [
  {
    id: "default",
    name: "Default",
    light: {
      palette: { neutral: "#f8fafc", ink: "#111827", primary: "#2563eb", success: "#16a34a", warning: "#d97706", error: "#dc2626", info: "#0284c7", accent: "#7c3aed", interactive: "#2563eb" },
      overrides: {
        background: "oklch(1 0 0)",
        foreground: "oklch(0.141 0.005 285.823)",
        card: "oklch(1 0 0)",
        "card-foreground": "oklch(0.141 0.005 285.823)",
        popover: "oklch(1 0 0)",
        "popover-foreground": "oklch(0.141 0.005 285.823)",
        primary: "oklch(0.21 0.006 285.885)",
        "primary-foreground": "oklch(0.985 0 0)",
        secondary: "oklch(0.967 0.001 286.375)",
        "secondary-foreground": "oklch(0.21 0.006 285.885)",
        muted: "oklch(0.967 0.001 286.375)",
        "muted-foreground": "oklch(0.552 0.016 285.938)",
        accent: "oklch(0.967 0.001 286.375)",
        "accent-foreground": "oklch(0.21 0.006 285.885)",
        destructive: "oklch(0.577 0.245 27.325)",
        "destructive-foreground": "oklch(0.985 0 0)",
        info: "oklch(0.94 0.045 230)",
        "info-foreground": "oklch(0.48 0.17 250)",
        success: "oklch(0.93 0.07 160)",
        "success-foreground": "oklch(0.45 0.15 160)",
        warning: "oklch(0.94 0.09 90)",
        "warning-foreground": "oklch(0.55 0.16 55)",
        error: "oklch(0.94 0.06 25)",
        "error-foreground": "oklch(0.55 0.22 27)",
        border: "oklch(0.92 0.004 286.32)",
        input: "oklch(0.92 0.004 286.32)",
        ring: "oklch(0.871 0.006 286.286)",
        "app-surface": "oklch(0.985 0.001 286)",
        "app-surface-muted": "oklch(0.96 0.002 286)",
        "timeline-background": "oklch(0.975 0.001 286)",
        "timeline-surface": "oklch(0.94 0.002 286)",
        "timeline-surface-muted": "oklch(0.90 0.004 286)",
        "timeline-grid-minor": "oklch(0.35 0.005 286 / 0.10)",
        "timeline-grid-major": "oklch(0.35 0.005 286 / 0.20)",
        "timeline-playhead": "oklch(0.58 0.22 27)",
        "clip-audio": "oklch(0.64 0.15 160)",
        "clip-audio-foreground": "oklch(0.985 0 0)",
        "clip-midi": "oklch(0.62 0.18 250)",
        "clip-midi-foreground": "oklch(0.985 0 0)",
        "clip-selected": "oklch(0.72 0.16 85)",
        "clip-selected-foreground": "oklch(0.16 0.005 286)",
        "clip-recording": "oklch(0.64 0.22 27)",
        "meter-safe": "oklch(0.64 0.15 160)",
        "meter-warning": "oklch(0.78 0.16 85)",
        "meter-clipping": "oklch(0.64 0.22 27)",
        "device-graph-background": "oklch(0.985 0.001 286)",
        "device-graph-grid": "oklch(0.35 0.005 286 / 0.16)",
        "device-graph-accent": "oklch(0.75 0.13 210)",
        recording: "oklch(0.64 0.22 27)",
        automation: "oklch(0.64 0.21 35)",
        sidebar: "oklch(0.970 0 0)",
        "sidebar-foreground": "oklch(0.141 0.005 285.823)",
        "sidebar-primary": "oklch(0.21 0.006 285.885)",
        "sidebar-primary-foreground": "oklch(0.985 0 0)",
        "sidebar-accent": "oklch(0.967 0.001 286.375)",
        "sidebar-accent-foreground": "oklch(0.21 0.006 285.885)",
        "sidebar-border": "oklch(0.92 0.004 286.32)",
        "sidebar-ring": "oklch(0.871 0.006 286.286)"
      }
    },
    dark: {
      palette: { neutral: "#111827", ink: "#f9fafb", primary: "#93c5fd", success: "#4ade80", warning: "#facc15", error: "#f87171", info: "#38bdf8", accent: "#c4b5fd", interactive: "#93c5fd" },
      overrides: {
        background: "oklch(0.141 0.005 285.823)",
        foreground: "oklch(0.985 0 0)",
        card: "oklch(0.141 0.005 285.823)",
        "card-foreground": "oklch(0.985 0 0)",
        popover: "oklch(0.141 0.005 285.823)",
        "popover-foreground": "oklch(0.985 0 0)",
        primary: "oklch(0.985 0 0)",
        "primary-foreground": "oklch(0.21 0.006 285.885)",
        secondary: "oklch(0.274 0.006 286.033)",
        "secondary-foreground": "oklch(0.985 0 0)",
        muted: "oklch(0.274 0.006 286.033)",
        "muted-foreground": "oklch(0.705 0.015 286.067)",
        accent: "oklch(0.274 0.006 286.033)",
        "accent-foreground": "oklch(0.985 0 0)",
        destructive: "oklch(0.396 0.141 25.723)",
        "destructive-foreground": "oklch(0.985 0 0)",
        info: "oklch(0.30 0.08 240)",
        "info-foreground": "oklch(0.78 0.11 230)",
        success: "oklch(0.30 0.08 160)",
        "success-foreground": "oklch(0.80 0.13 160)",
        warning: "oklch(0.34 0.08 80)",
        "warning-foreground": "oklch(0.85 0.15 85)",
        error: "oklch(0.32 0.09 27)",
        "error-foreground": "oklch(0.78 0.17 27)",
        border: "oklch(0.274 0.006 286.033)",
        input: "oklch(0.274 0.006 286.033)",
        ring: "oklch(0.442 0.017 285.786)",
        "app-surface": "oklch(0.16 0.005 286)",
        "app-surface-muted": "oklch(0.20 0.006 286)",
        "timeline-background": "oklch(0.11 0.003 286)",
        "timeline-surface": "oklch(0.16 0.005 286)",
        "timeline-surface-muted": "oklch(0.22 0.006 286)",
        "timeline-grid-minor": "oklch(1 0 0 / 0.08)",
        "timeline-grid-major": "oklch(1 0 0 / 0.16)",
        "timeline-playhead": "oklch(0.70 0.20 27)",
        "clip-audio": "oklch(0.64 0.15 160)",
        "clip-audio-foreground": "oklch(0.985 0 0)",
        "clip-midi": "oklch(0.62 0.18 250)",
        "clip-midi-foreground": "oklch(0.985 0 0)",
        "clip-selected": "oklch(0.78 0.16 85)",
        "clip-selected-foreground": "oklch(0.16 0.005 286)",
        "clip-recording": "oklch(0.64 0.22 27)",
        "meter-safe": "oklch(0.64 0.15 160)",
        "meter-warning": "oklch(0.78 0.16 85)",
        "meter-clipping": "oklch(0.64 0.22 27)",
        "device-graph-background": "oklch(0.11 0.003 286)",
        "device-graph-grid": "oklch(1 0 0 / 0.16)",
        "device-graph-accent": "oklch(0.75 0.13 210)",
        recording: "oklch(0.64 0.22 27)",
        automation: "oklch(0.70 0.20 35)",
        sidebar: "oklch(0.21 0.006 285.885)",
        "sidebar-foreground": "oklch(0.985 0 0)",
        "sidebar-primary": "oklch(0.488 0.243 264.376)",
        "sidebar-primary-foreground": "oklch(0.985 0 0)",
        "sidebar-accent": "oklch(0.274 0.006 286.033)",
        "sidebar-accent-foreground": "oklch(0.985 0 0)",
        "sidebar-border": "oklch(0.274 0.006 286.033)",
        "sidebar-ring": "oklch(0.442 0.017 285.786)"
      }
    }
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    light: { palette: { neutral: "#eff1f5", ink: "#4c4f69", primary: "#1e66f5", success: "#40a02b", warning: "#df8e1d", error: "#d20f39", info: "#209fb5", accent: "#8839ef", interactive: "#1e66f5" } },
    dark: { palette: { neutral: "#1e1e2e", ink: "#cdd6f4", primary: "#89b4fa", success: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8", info: "#89dceb", accent: "#cba6f7", interactive: "#89b4fa" } }
  },
  {
    id: "tokyonight",
    name: "Tokyo Night",
    light: { palette: { neutral: "#d5d6db", ink: "#343b58", primary: "#34548a", success: "#485e30", warning: "#8f5e15", error: "#8c4351", info: "#0f4b6e", accent: "#5a4a78", interactive: "#34548a" } },
    dark: { palette: { neutral: "#1a1b26", ink: "#c0caf5", primary: "#7aa2f7", success: "#9ece6a", warning: "#e0af68", error: "#f7768e", info: "#7dcfff", accent: "#bb9af7", interactive: "#7aa2f7" } }
  }
]

export const themeOptions: readonly DawThemeOption[] = [
  ...builtInThemes.map((theme) => ({ id: theme.id, name: theme.name }))
]

const isThemeId = (value: unknown): value is DawThemeId =>
  builtInThemes.some((theme) => theme.id === value)

export const parseThemeId = (value: unknown): DawThemeId =>
  isThemeId(value) ? value : DEFAULT_DAW_THEME_ID

export const getTheme = (id: DawThemeId): DawTheme =>
  builtInThemes.find((theme) => theme.id === id) ?? builtInThemes[0]
