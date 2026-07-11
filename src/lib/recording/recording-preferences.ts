export type RecordingMonitorMode = "off" | "auto" | "on"

export type RecordingInputPreferences = {
  layout: "mono" | "stereo"
  inputChannel: number
  monitor: RecordingMonitorMode
  gainDb: number
  invertPolarity: boolean
}

export type RecordingCalibration = {
  inputDeviceId: string
  outputDeviceId: string
  sampleRate: number
  measuredRoundTripFrames: number
  recordingOffsetFrames: number
  confidence: number
  platformIdentity: string
  createdAtMs: number
}
