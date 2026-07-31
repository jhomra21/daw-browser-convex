import type { ConfigColorMode } from "@kobalte/core"
import { parseHexColor } from "~/lib/color"
import { normalizeMidiSelectedInputIds } from "~/lib/midi/midi-input"
import type { RecordingCalibration, RecordingInputPreferences } from "~/lib/recording/recording-preferences"
import { DEFAULT_DAW_THEME_ID, parseThemeId, type DawThemeId } from "~/lib/theme/theme-registry"

export { parseHexColor } from "~/lib/color"

export const APP_PREFERENCES_STORAGE_KEY = "daw-browser.app-preferences.v1"
export const APP_PREFERENCES_VERSION = 8
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
  nativePlaybackEnabled: boolean
  portableBrowserPlaybackEnabled: boolean
}
export type RecordingPreferences = RecordingInputPreferences & {
  portableEnabled: boolean
  manualOffsetFrames: number
  calibrations: RecordingCalibration[]
}

export type AppPreferences = {
  version: typeof APP_PREFERENCES_VERSION
  appearance: {
    theme: AppTheme
    themeId: DawThemeId
  }
  sidebar: {
    open: boolean
  }
  timeline: {
    defaultTrackColor: string
    defaultGroupColor: string
  }
  audio: AudioPreferences
  recording: RecordingPreferences
  midi: {
    selectedInputIds: string[]
  }
}


export const defaultAppPreferences: AppPreferences = {
  version: APP_PREFERENCES_VERSION,
  appearance: {
    theme: "system",
    themeId: DEFAULT_DAW_THEME_ID
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
    autoGainControl: false,
    nativePlaybackEnabled: true,
    portableBrowserPlaybackEnabled: false
  },
  recording: {
    portableEnabled: false,
    layout: "mono",
    inputChannel: 0,
    monitor: "off",
    gainDb: 0,
    invertPolarity: false,
    manualOffsetFrames: 0,
    calibrations: []
  },
  midi: {
    selectedInputIds: []
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
const parseFiniteInteger = (value: unknown, minimum: number, maximum: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback
const parseFiniteNumber = (value: unknown, minimum: number, maximum: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
export const parseAudioSampleRate = (value: unknown): AudioSampleRatePreference =>
  value === 44100 || value === 48000 || value === 96000 ? value : "default"
export const parseAudioLatencyMode = (value: unknown): AudioLatencyMode =>
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

export const normalizeRecordingCalibration = (value: unknown): RecordingCalibration | null => {
  if (!isRecord(value)) return null
  const unstableDeviceIds = new Set(["default", "communications"])
  if (
    typeof value.inputDeviceId !== "string" || value.inputDeviceId.length === 0 ||
    typeof value.outputDeviceId !== "string" || value.outputDeviceId.length === 0 ||
    typeof value.platformIdentity !== "string" || value.platformIdentity.length === 0 ||
    value.platformIdentity === "unknown" ||
    unstableDeviceIds.has(value.inputDeviceId) || unstableDeviceIds.has(value.outputDeviceId)
  ) return null

  if (
    typeof value.sampleRate !== "number" || !Number.isInteger(value.sampleRate) ||
    value.sampleRate < 8000 || value.sampleRate > 384000 ||
    typeof value.measuredRoundTripFrames !== "number" || !Number.isInteger(value.measuredRoundTripFrames) ||
    value.measuredRoundTripFrames < 0 || value.measuredRoundTripFrames > 1_920_000 ||
    typeof value.recordingOffsetFrames !== "number" || !Number.isInteger(value.recordingOffsetFrames) ||
    value.recordingOffsetFrames < -1_920_000 || value.recordingOffsetFrames > 1_920_000 ||
    typeof value.confidence !== "number" || !Number.isFinite(value.confidence) ||
    value.confidence < 0 || value.confidence > 1 ||
    typeof value.createdAtMs !== "number" || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0
  ) return null

  return {
    inputDeviceId: value.inputDeviceId,
    outputDeviceId: value.outputDeviceId,
    sampleRate: value.sampleRate,
    measuredRoundTripFrames: value.measuredRoundTripFrames,
    recordingOffsetFrames: value.recordingOffsetFrames,
    confidence: value.confidence,
    platformIdentity: value.platformIdentity,
    createdAtMs: value.createdAtMs
  }
}

export const normalizeRecordingCalibrations = (value: unknown): RecordingCalibration[] => {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeRecordingCalibration)
    .filter((calibration) => calibration !== null)
    .sort((left, right) => right.createdAtMs - left.createdAtMs)
    .slice(0, 32)
}

export const normalizeRecordingInputPreferences = (
  value: RecordingInputPreferences,
): RecordingInputPreferences => ({
  layout: value.layout === "stereo" ? "stereo" : "mono",
  inputChannel: parseFiniteInteger(value.inputChannel, 0, 31, defaultAppPreferences.recording.inputChannel),
  monitor: value.monitor === "auto" || value.monitor === "on" ? value.monitor : "off",
  gainDb: parseFiniteNumber(value.gainDb, -60, 24, defaultAppPreferences.recording.gainDb),
  invertPolarity: parseBoolean(value.invertPolarity, defaultAppPreferences.recording.invertPolarity)
})

export const normalizeRecordingManualOffsetFrames = (value: number): number =>
  parseFiniteInteger(value, -1_920_000, 1_920_000, defaultAppPreferences.recording.manualOffsetFrames)

export const updateRecordingInputPreferences = (
  current: RecordingPreferences,
  input: RecordingInputPreferences,
): RecordingPreferences => ({
  ...current,
  ...normalizeRecordingInputPreferences(input)
})

export const updateRecordingCalibrations = (
  current: RecordingPreferences,
  calibrations: RecordingCalibration[],
): RecordingPreferences => ({
  ...current,
  calibrations: normalizeRecordingCalibrations(calibrations)
})

export const normalizeAppPreferences = (value: unknown): AppPreferences => {
  if (!isRecord(value)) return defaultAppPreferences
  if (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4 && value.version !== 5 && value.version !== 6 && value.version !== 7 && value.version !== APP_PREFERENCES_VERSION) return defaultAppPreferences

  const appearance = isRecord(value.appearance) ? value.appearance : {}
  const sidebar = isRecord(value.sidebar) ? value.sidebar : {}
  const timeline = isRecord(value.timeline) ? value.timeline : {}
  const audio = value.version !== 1 && isRecord(value.audio) ? value.audio : {}
  const recording = (value.version === 3 || value.version === 4 || value.version === 5 || value.version === 6 || value.version === APP_PREFERENCES_VERSION) && isRecord(value.recording) ? value.recording : {}
  const midi = (value.version === 4 || value.version === 5 || value.version === 6 || value.version === APP_PREFERENCES_VERSION) && isRecord(value.midi) ? value.midi : {}

  return {
    version: APP_PREFERENCES_VERSION,
    appearance: {
      theme: parseAppTheme(appearance.theme),
      themeId: parseThemeId(appearance.themeId)
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
      sampleRate: parseAudioSampleRate(audio.sampleRate),
      latencyMode: parseAudioLatencyMode(audio.latencyMode),
      echoCancellation: parseBoolean(audio.echoCancellation, defaultAppPreferences.audio.echoCancellation),
      noiseSuppression: parseBoolean(audio.noiseSuppression, defaultAppPreferences.audio.noiseSuppression),
      autoGainControl: parseBoolean(audio.autoGainControl, defaultAppPreferences.audio.autoGainControl),
      nativePlaybackEnabled: (value.version === 5 || value.version === 6 || value.version === 7 || value.version === APP_PREFERENCES_VERSION)
        ? parseBoolean(audio.nativePlaybackEnabled, value.version === APP_PREFERENCES_VERSION
          ? defaultAppPreferences.audio.nativePlaybackEnabled
          : false)
        : defaultAppPreferences.audio.nativePlaybackEnabled,
      portableBrowserPlaybackEnabled: (value.version === 6 || value.version === 7 || value.version === APP_PREFERENCES_VERSION)
        ? parseBoolean(audio.portableBrowserPlaybackEnabled, defaultAppPreferences.audio.portableBrowserPlaybackEnabled)
        : defaultAppPreferences.audio.portableBrowserPlaybackEnabled
    },
    recording: {
      portableEnabled: value.version === APP_PREFERENCES_VERSION
        ? parseBoolean(recording.portableEnabled, defaultAppPreferences.recording.portableEnabled)
        : defaultAppPreferences.recording.portableEnabled,
      layout: recording.layout === "stereo" ? "stereo" : "mono",
      inputChannel: parseFiniteInteger(recording.inputChannel, 0, 31, defaultAppPreferences.recording.inputChannel),
      monitor: recording.monitor === "auto" || recording.monitor === "on" ? recording.monitor : "off",
      gainDb: parseFiniteNumber(recording.gainDb, -60, 24, defaultAppPreferences.recording.gainDb),
      invertPolarity: parseBoolean(recording.invertPolarity, defaultAppPreferences.recording.invertPolarity),
      manualOffsetFrames: normalizeRecordingManualOffsetFrames(
        typeof recording.manualOffsetFrames === "number"
          ? recording.manualOffsetFrames
          : defaultAppPreferences.recording.manualOffsetFrames,
      ),
      calibrations: normalizeRecordingCalibrations(recording.calibrations)
    },
    midi: {
      selectedInputIds: normalizeMidiSelectedInputIds(midi.selectedInputIds)
    }
  }
}
