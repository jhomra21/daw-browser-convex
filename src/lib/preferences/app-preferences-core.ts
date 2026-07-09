import type { ConfigColorMode } from "@kobalte/core"
import { DEFAULT_DAW_THEME_ID, parseThemeId, type DawThemeId } from "~/lib/theme/theme-registry"

export const APP_PREFERENCES_STORAGE_KEY = "daw-browser.app-preferences.v1"
export const APP_PREFERENCES_VERSION = 1
export const TIMELINE_DEFAULT_TRACK_COLOR = "timeline-surface"
export const TIMELINE_DEFAULT_GROUP_COLOR = "timeline-surface"
const LEGACY_DARK_TIMELINE_SURFACE_COLOR = "#181824"
const LEGACY_BRANCH_TRACK_ROW_COLOR = "#64748b"
const LEGACY_BRANCH_GROUP_ROW_COLOR = "#475569"

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
  timeline: {
    defaultTrackColor: string
    defaultGroupColor: string
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
  },
  timeline: {
    defaultTrackColor: TIMELINE_DEFAULT_TRACK_COLOR,
    defaultGroupColor: TIMELINE_DEFAULT_GROUP_COLOR
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

export const parseHexColor = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback

const isTimelineDefaultColorToken = (value: unknown): value is typeof TIMELINE_DEFAULT_TRACK_COLOR | typeof TIMELINE_DEFAULT_GROUP_COLOR =>
  value === TIMELINE_DEFAULT_TRACK_COLOR || value === TIMELINE_DEFAULT_GROUP_COLOR

const normalizeTimelineDefaultColor = (value: unknown, fallback: string, legacyBranchDefault: string): string => {
  if (isTimelineDefaultColorToken(value)) return value
  const color = parseHexColor(value, fallback)
  const normalized = color.toLowerCase()
  return normalized === legacyBranchDefault || normalized === LEGACY_DARK_TIMELINE_SURFACE_COLOR ? fallback : color
}

export const normalizeAppPreferences = (value: unknown): AppPreferences => {
  if (!isRecord(value)) return defaultAppPreferences
  if (value.version !== APP_PREFERENCES_VERSION) return defaultAppPreferences

  const appearance = isRecord(value.appearance) ? value.appearance : {}
  const agent = isRecord(value.agent) ? value.agent : {}
  const sidebar = isRecord(value.sidebar) ? value.sidebar : {}
  const timeline = isRecord(value.timeline) ? value.timeline : {}

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
    },
    timeline: {
      defaultTrackColor: normalizeTimelineDefaultColor(
        timeline.defaultTrackColor,
        defaultAppPreferences.timeline.defaultTrackColor,
        LEGACY_BRANCH_TRACK_ROW_COLOR,
      ),
      defaultGroupColor: normalizeTimelineDefaultColor(
        timeline.defaultGroupColor,
        defaultAppPreferences.timeline.defaultGroupColor,
        LEGACY_BRANCH_GROUP_ROW_COLOR,
      )
    }
  }
}
