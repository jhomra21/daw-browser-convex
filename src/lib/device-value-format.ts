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

export const formatDevicePercent = (value: number) => `${Math.round(value * 100)}%`
