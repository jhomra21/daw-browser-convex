export const formatDeviceFrequency = (value: number, precision: number) => {
  const hz = Math.round(value)

  return hz >= 1000 ? `${(value / 1000).toFixed(precision)} kHz` : `${hz} Hz`
}

export const formatDeviceHertz = (value: number, precision: number) => `${value.toFixed(precision)} Hz`

export const formatDeviceDb = (value: number, precision: number, explicitPlus = false) => (
  `${explicitPlus && value > 0 ? '+' : ''}${value.toFixed(precision)} dB`
)

export const formatDeviceMilliseconds = (value: number, precision: number) => (
  `${value.toFixed(precision)} ms`
)

/** A processing delay in milliseconds at the engine's real sample rate; just the frame count while the engine has none. */
export const formatDeviceLatency = (frames: number, sampleRate: number | null) => (
  sampleRate === null ? `${frames} samples` : `${formatDeviceMilliseconds(frames / sampleRate * 1000, 1)} @ ${sampleRate / 1000} kHz`
)

export const formatDevicePercent = (value: number) => `${Math.round(value * 100)}%`
