import { createDefaultSaturatorParams, isSaturatorCurve, SATURATOR_COLOR_DB_MAX, SATURATOR_COLOR_DB_MIN, SATURATOR_DRIVE_DB_MAX, SATURATOR_DRIVE_DB_MIN, SATURATOR_OUTPUT_DB_MAX, SATURATOR_OUTPUT_DB_MIN, type SaturatorCurve } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 had one Color control: a peaking boost of Amount x 12 dB at Frequency (Q 0.8) ahead of the curve only,
// four curves and no Hi-Quality or Post Clip. What carries over:
// - Enabled, Curve, Dry/Wet, Color on/off and Frequency keep their value and meaning;
// - Drive and Output keep the level of the sound. The new curves have a slope of one at the origin, so each old curve is the new one
//   at a higher Drive: old(x) = new(k x) for Soft (k = 1.8), Medium (1.5) and Clip (1 / 0.82) exactly, and for Hard (atan(4 x) / atan(4))
//   with k = 8 / pi and a post gain of (pi / 2) / atan(4). Drive gains 20 log10(k) dB and Hard's Output gains 1.47 dB, so the migrated
//   device sounds as the old one at small and large levels alike (Medium's old curve jumped at 0.666 and its new one is smooth);
//   a Drive that would pass the 36 dB range stops at 36 dB, and the loudness of that setting falls short;
// - Amount x 12 dB becomes Amt Hi (a high shelf of that gain at Frequency, mirrored after the curve) and Amt Lo starts at 0; Width
//   starts at the value whose Q is the old 0.8. The new post-EQ undoes the boost after the curve, so the small-signal response is
//   flat where the old peak stayed in the output: a device with Color on keeps the colour of the distortion, not the level boost.
//   (The old filter was also designed at the base rate and run at four times it, so its peak sat at four times Frequency.)
// - Hi-Quality starts on (the new default), Post Clip off.

const finite = (value: JsonValue | undefined, fallback: number) => isJsonNumber(value) && Number.isFinite(value) ? value : fallback

const retiredKeys: ReadonlySet<string> = new Set(['colorAmount'])

const OLD_COLOR_RANGE_DB = 12

const HARD_DRIVE_SCALE = 8 / Math.PI
const HARD_OUTPUT_SCALE = (Math.PI / 2) / Math.atan(4)

/** Linear Drive factor k and Output factor of each old curve, so that old(x) = outputScale * new(driveScale * x). */
const legacyCurveScales: Readonly<Record<'soft' | 'medium' | 'hard' | 'clip', { drive: number; output: number }>> = {
  soft: { drive: 1.8, output: 1 },
  medium: { drive: 1.5, output: 1 },
  hard: { drive: HARD_DRIVE_SCALE, output: HARD_OUTPUT_SCALE },
  clip: { drive: 1 / 0.82, output: 1 },
}

const scalesFor = (curve: SaturatorCurve) => curve === 'soft' || curve === 'medium' || curve === 'hard' || curve === 'clip' ? legacyCurveScales[curve] : legacyCurveScales.soft

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const migrateSaturatorParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const defaults = createDefaultSaturatorParams()
  const amount = clamp(finite(params.colorAmount, 0), 0, 1)
  const kept = Object.fromEntries(Object.entries(params).filter(([key]) => !retiredKeys.has(key)))
  const curve = isSaturatorCurve(params.curve) ? params.curve : defaults.curve
  const scales = scalesFor(curve)
  const driveDb = clamp(finite(params.driveDb, defaults.driveDb), SATURATOR_DRIVE_DB_MIN, SATURATOR_DRIVE_DB_MAX)
  const outputDb = clamp(finite(params.outputDb, defaults.outputDb), SATURATOR_OUTPUT_DB_MIN, SATURATOR_OUTPUT_DB_MAX)

  return {
    ...defaults,
    ...kept,
    driveDb: clamp(driveDb + 20 * Math.log10(scales.drive), SATURATOR_DRIVE_DB_MIN, SATURATOR_DRIVE_DB_MAX),
    outputDb: clamp(outputDb + 20 * Math.log10(scales.output), SATURATOR_OUTPUT_DB_MIN, SATURATOR_OUTPUT_DB_MAX),
    colorHighDb: clamp(amount * OLD_COLOR_RANGE_DB, SATURATOR_COLOR_DB_MIN, SATURATOR_COLOR_DB_MAX),
  }
}
