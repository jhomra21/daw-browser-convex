import { AUTO_FILTER_LFO_DIVISIONS, AUTO_FILTER_MAX_Q, AUTO_FILTER_MIN_Q, type AutoFilterParams } from '@daw-browser/shared'
import { formatDeviceHertz } from '~/lib/device-value-format'

// The graph is the draggable device graph's 180 x 58 viewBox.
const WIDTH = 180
const HEIGHT = 58
const MIN_HZ = 20
const MAX_HZ = 20_000
const FLOOR_DB = -48
const CEILING_DB = 18
const PATH_POINTS = 96

// The cutoff handle rides a track: full resonance at the top, none at the bottom.
const RESONANCE_TOP = 12
const RESONANCE_BOTTOM = 52

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const octaves = Math.log(MAX_HZ / MIN_HZ)

export const autoFilterFrequencyX = (hz: number) => Math.log(clamp(hz, MIN_HZ, MAX_HZ) / MIN_HZ) / octaves * WIDTH
export const autoFilterXFrequency = (x: number) => MIN_HZ * Math.exp(clamp(x / WIDTH, 0, 1) * octaves)
export const autoFilterResonanceY = (resonance: number) => RESONANCE_BOTTOM - clamp(resonance, 0, 1) * (RESONANCE_BOTTOM - RESONANCE_TOP)
export const autoFilterYResonance = (y: number) => clamp((RESONANCE_BOTTOM - y) / (RESONANCE_BOTTOM - RESONANCE_TOP), 0, 1)

type ResponseSettings = Pick<AutoFilterParams, 'mode' | 'slope' | 'frequencyHz' | 'resonance'>

// The analogue prototype of the core's state-variable stage; 24 dB is the same stage twice at Q = sqrt(Q).
export const autoFilterResponseDb = (settings: ResponseSettings, hz: number) => {
  const q = AUTO_FILTER_MIN_Q * (AUTO_FILTER_MAX_Q / AUTO_FILTER_MIN_Q) ** settings.resonance
  const stageQ = settings.slope === 24 ? Math.sqrt(q) : q
  const x = hz / settings.frequencyHz
  const real = 1 - x * x
  const imaginary = x / stageQ
  const denominator = Math.hypot(real, imaginary)

  const numerator = settings.mode === 'lowpass' ? 1
    : settings.mode === 'highpass' ? x * x
    : settings.mode === 'bandpass' ? imaginary
    : settings.mode === 'notch' ? Math.abs(real)
    : 1 + x * x

  const stages = settings.slope === 24 ? 2 : 1

  return stages * 20 * Math.log10(Math.max(numerator / denominator, 1e-6))
}

export const autoFilterResponsePath = (settings: ResponseSettings) => {
  const points = Array.from({ length: PATH_POINTS }, (_, index) => {
    const x = index / (PATH_POINTS - 1) * WIDTH
    const db = clamp(autoFilterResponseDb(settings, autoFilterXFrequency(x)), FLOOR_DB, CEILING_DB)
    const y = (CEILING_DB - db) / (CEILING_DB - FLOOR_DB) * HEIGHT

    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  })

  return points.join(' ')
}

export const autoFilterLfoRateLabel = (lfo: Pick<AutoFilterParams['lfo'], 'sync' | 'rateHz' | 'division'>) =>
  lfo.sync ? AUTO_FILTER_LFO_DIVISIONS[lfo.division] ?? '' : formatDeviceHertz(lfo.rateHz, 2)
