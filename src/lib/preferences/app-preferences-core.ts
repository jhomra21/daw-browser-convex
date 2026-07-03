import type { ConfigColorMode } from "@kobalte/core"
import { DEFAULT_DAW_THEME_ID, parseThemeId, type DawThemeId } from "~/lib/theme/theme-registry"

export const APP_PREFERENCES_STORAGE_KEY = "daw-browser.app-preferences.v1"
export const APP_PREFERENCES_VERSION = 1

export type AppTheme = ConfigColorMode
export type ResolvedAppTheme = "light" | "dark"

export type AppPreferences = {
  version: typeof APP_PREFERENCES_VERSION
  appearance: {
    theme: AppTheme
    themeId: DawThemeId
  }
  agent: {
    autoApply: boolean
  }
  sidebar: {
    open: boolean
  }
}

export const defaultAppPreferences: AppPreferences = {
  version: APP_PREFERENCES_VERSION,
  appearance: {
    theme: "system",
    themeId: DEFAULT_DAW_THEME_ID
  },
  agent: {
    autoApply: false
  },
  sidebar: {
    open: true
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isAppTheme = (value: unknown): value is AppTheme =>
  value === "system" || value === "light" || value === "dark"

export const parseAppTheme = (value: unknown): AppTheme =>
  isAppTheme(value) ? value : defaultAppPreferences.appearance.theme

const parseBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback

export const normalizeAppPreferences = (value: unknown): AppPreferences => {
  if (!isRecord(value)) return defaultAppPreferences
  if (value.version !== APP_PREFERENCES_VERSION) return defaultAppPreferences

  const appearance = isRecord(value.appearance) ? value.appearance : {}
  const agent = isRecord(value.agent) ? value.agent : {}
  const sidebar = isRecord(value.sidebar) ? value.sidebar : {}

  return {
    version: APP_PREFERENCES_VERSION,
    appearance: {
      theme: parseAppTheme(appearance.theme),
      themeId: parseThemeId(appearance.themeId)
    },
    agent: {
      autoApply: parseBoolean(agent.autoApply, defaultAppPreferences.agent.autoApply)
    },
    sidebar: {
      open: parseBoolean(sidebar.open, defaultAppPreferences.sidebar.open)
    }
  }
}