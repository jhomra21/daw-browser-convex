export type AppPreferencesVersionRow = {
  audio: boolean
  recording: boolean
  midi: boolean
  /** "legacy-off": a stored value is read and a missing one means off; "ignored": always the current default. */
  nativePlayback: "ignored" | "legacy-off" | "stored"
  portableRecording: boolean
}

/** One row per readable persisted version; a version not listed here is discarded. Sections a version did not persist load as defaults. */
export const APP_PREFERENCES_VERSION_ROWS: ReadonlyMap<number, AppPreferencesVersionRow> = new Map([
  [1, { audio: false, recording: false, midi: false, nativePlayback: "ignored", portableRecording: false }],
  [2, { audio: true, recording: false, midi: false, nativePlayback: "ignored", portableRecording: false }],
  [3, { audio: true, recording: true, midi: false, nativePlayback: "ignored", portableRecording: false }],
  [4, { audio: true, recording: true, midi: true, nativePlayback: "ignored", portableRecording: false }],
  [5, { audio: true, recording: true, midi: true, nativePlayback: "legacy-off", portableRecording: false }],
  [6, { audio: true, recording: true, midi: true, nativePlayback: "legacy-off", portableRecording: false }],
  [7, { audio: true, recording: false, midi: false, nativePlayback: "legacy-off", portableRecording: false }],
  [8, { audio: true, recording: true, midi: true, nativePlayback: "legacy-off", portableRecording: false }],
  [9, { audio: true, recording: true, midi: true, nativePlayback: "stored", portableRecording: true }],
])
