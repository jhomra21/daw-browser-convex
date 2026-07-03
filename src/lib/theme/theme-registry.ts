import type { DawTheme, DawThemeId } from "./theme-types"
export type { DawThemeId } from "./theme-types"

export type DawThemeOption = {
  id: DawThemeId
  name: string
}

export const builtInThemes: readonly DawTheme[] = [
  {
    id: "default",
    name: "Default",
    light: { palette: { neutral: "#f8fafc", ink: "#111827", primary: "#2563eb", success: "#16a34a", warning: "#d97706", error: "#dc2626", info: "#0284c7", accent: "#7c3aed", interactive: "#2563eb" } },
    dark: { palette: { neutral: "#111827", ink: "#f9fafb", primary: "#93c5fd", success: "#4ade80", warning: "#facc15", error: "#f87171", info: "#38bdf8", accent: "#c4b5fd", interactive: "#93c5fd" } }
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

export const isThemeId = (value: unknown): value is DawThemeId =>
  builtInThemes.some((theme) => theme.id === value)

export const parseThemeId = (value: unknown): DawThemeId =>
  isThemeId(value) ? value : "default"

export const getTheme = (id: DawThemeId): DawTheme => builtInThemes.find((theme) => theme.id === id) ?? builtInThemes[0]
