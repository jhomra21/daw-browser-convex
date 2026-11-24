import { AUTO_FILTER_MAX_Q, AUTO_FILTER_MIN_Q } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 had no Hi-Quality, slope, output, clip, envelope link/hold, LFO sync or spin; its resonance
// was Q = 0.5 + 19.5 r, its drive added its full gain to quiet signals, its band-pass peaked at Q, and its envelope was
// the linear peak. Everything below keeps those sounds where the new design can reproduce them.

const DRIVE_REFERENCE_PEAK = 0.25 // -12 dBFS
const ENVELOPE_AMOUNT_SCALE = 0.25118864 / 0.8 // old excursion at -12 dBFS (10^(-12/20)) over the new law's 48/60

const finite = (value: JsonValue | undefined, fallback: number) => isJsonNumber(value) && Number.isFinite(value) ? value : fallback

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// The new knob that gives the old Q, clamped to what the new law can reach (Q 0.707 to 8).
const resonanceForOldQ = (q: number) => clamp(Math.log(Math.max(q, AUTO_FILTER_MIN_Q) / AUTO_FILTER_MIN_Q) / Math.log(AUTO_FILTER_MAX_Q / AUTO_FILTER_MIN_Q), 0, 1)

export const migrateAutoFilterParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const wrapped = isJsonObject(params.state)
  const old = wrapped && isJsonObject(params.state) ? params.state : params
  const envelope = isJsonObject(old.envelope) ? old.envelope : {}
  const lfo = isJsonObject(old.lfo) ? old.lfo : {}
  const oldQ = 0.5 + 19.5 * clamp(finite(old.resonance, 0.25), 0, 1)
  const driveDb = clamp(finite(old.driveDb, 0), 0, 24)
  // Old drive was tanh(gain * x) and the new one leaves quiet signals alone, so the loudness it added at -12 dBFS moves
  // to Output. Old band-pass peaked at Q; the new one is unity.
  const driveLoudnessDb = driveDb === 0 ? 0 : 20 * Math.log10(Math.tanh(DRIVE_REFERENCE_PEAK * 10 ** (driveDb / 20)) / DRIVE_REFERENCE_PEAK)
  const outputDb = clamp(driveLoudnessDb + (old.mode === 'bandpass' ? 20 * Math.log10(oldQ) : 0), -24, 24)
  const kept = Object.fromEntries(Object.entries(old).filter(([key]) => key !== 'quality'))

  const state: JsonValue = {
    ...kept,
    slope: 12,
    hiQuality: false,
    resonance: resonanceForOldQ(oldQ),
    driveDb,
    outputDb,
    clip: false,
    envelope: {
      ...envelope,
      amountOctaves: clamp(finite(envelope.amountOctaves, 0) * ENVELOPE_AMOUNT_SCALE, -6, 6),
      hold: false,
      link: false,
    },
    lfo: { ...lfo, sync: false, division: 5, stereoMode: 'phase' },
  }

  return wrapped ? { ...params, state } : state
}
