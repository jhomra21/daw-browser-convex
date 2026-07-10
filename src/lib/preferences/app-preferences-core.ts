import type { ConfigColorMode } from "@kobalte/core"
import { parseHexColor } from "~/lib/color"
import { DEFAULT_DAW_THEME_ID, parseThemeId, type DawThemeId } from "~/lib/theme/theme-registry"

export { parseHexColor } from "~/lib/color"

export const APP_PREFERENCES_STORAGE_KEY = "daw-browser.app-preferences.v1"
export const APP_PREFERENCES_VERSION = 2
export const TIMELINE_DEFAULT_TRACK_COLOR = "timeline-surface"
export const TIMELINE_DEFAULT_GROUP_COLOR = "timeline-surface"
const LEGACY_DARK_TIMELINE_SURFACE_COLOR = "#181824"
const LEGACY_BRANCH_TRACK_ROW_COLOR = "#64748b"
const LEGACY_BRANCH_GROUP_ROW_COLOR = "#475569"

export type AppTheme = ConfigColorMode
export type ResolvedAppTheme = "light" | "dark"
export type AudioSampleRatePreference = "default" | 44100 | 48000 | 96000
export type AudioLatencyMode = "interactive" | "balanced" | "playback"
export type AudioPreferences = {
  inputDeviceId: string
  outputDeviceId: string
  sampleRate: AudioSampleRatePreference
  latencyMode: AudioLatencyMode
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

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
  audio: AudioPreferences
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
  },
  audio: {
    inputDeviceId: "",
    outputDeviceId: "",
    sampleRate: "default",
    latencyMode: "interactive",
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
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
const parseDeviceId = (value: unknown): string => typeof value === "string" ? value : ""
const parseSampleRate = (value: unknown): AudioSampleRatePreference =>
  value === 44100 || value === 48000 || value === 96000 ? value : "default"
const parseLatencyMode = (value: unknown): AudioLatencyMode =>
  value === "balanced" || value === "playback" ? value : "interactive"

const isTimelineDefaultColorToken = (value: unknown): value is typeof TIMELINE_DEFAULT_TRACK_COLOR | typeof TIMELINE_DEFAULT_GROUP_COLOR =>
  value === TIMELINE_DEFAULT_TRACK_COLOR || value === TIMELINE_DEFAULT_GROUP_COLOR

export const timelineDefaultCreateColor = (color: string): string | undefined =>
  isTimelineDefaultColorToken(color) ? undefined : color

const normalizeTimelineDefaultColor = (value: unknown, fallback: string, legacyBranchDefault: string): string => {
  if (isTimelineDefaultColorToken(value)) return value
  const color = parseHexColor(value, fallback)
  const normalized = color.toLowerCase()
  return normalized === legacyBranchDefault || normalized === LEGACY_DARK_TIMELINE_SURFACE_COLOR ? fallback : color
}

export const normalizeAppPreferences = (value: unknown): AppPreferences => {
  if (!isRecord(value)) return defaultAppPreferences
  if (value.version !== 1 && value.version !== APP_PREFERENCES_VERSION) return defaultAppPreferences

  const appearance = isRecord(value.appearance) ? value.appearance : {}
  const agent = isRecord(value.agent) ? value.agent : {}
  const sidebar = isRecord(value.sidebar) ? value.sidebar : {}
  const timeline = isRecord(value.timeline) ? value.timeline : {}
  const audio = value.version === APP_PREFERENCES_VERSION && isRecord(value.audio) ? value.audio : {}

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
    },
    audio: {
      inputDeviceId: parseDeviceId(audio.inputDeviceId),
      outputDeviceId: parseDeviceId(audio.outputDeviceId),
      sampleRate: parseSampleRate(audio.sampleRate),
      latencyMode: parseLatencyMode(audio.latencyMode),
      echoCancellation: parseBoolean(audio.echoCancellation, defaultAppPreferences.audio.echoCancellation),
      noiseSuppression: parseBoolean(audio.noiseSuppression, defaultAppPreferences.audio.noiseSuppression),
      autoGainControl: parseBoolean(audio.autoGainControl, defaultAppPreferences.audio.autoGainControl)
    }
  }
}
