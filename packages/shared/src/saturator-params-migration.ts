import { createDefaultSaturatorParams, SATURATOR_COLOR_DB_MAX, SATURATOR_COLOR_DB_MIN } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 had one Color control: a peaking boost of Amount x 12 dB at Frequency (Q 0.8) ahead of the curve only,
// four curves and no Hi-Quality or Post Clip. What carries over:
// - Enabled, Drive, Curve, Output, Dry/Wet, Color on/off and Frequency keep their value and meaning;
// - Amount x 12 dB becomes Amt Hi (a high shelf of that gain at Frequency, mirrored after the curve) and Amt Lo starts at 0; Width
//   starts at the value whose Q is the old 0.8. A shelf lifts everything above Frequency where the peak lifted a band, and the
//   new post-EQ undoes the boost after the curve: the colour is audibly different from before, as Live's Color is;
// - Hi-Quality starts on (the new default), Post Clip off;
// - the four curves keep their names and now pass a quiet signal at unity: Soft, Medium, Hard and Clip used to add +5.1, +3.5,
//   +9.6 and +1.7 dB to it, so a migrated device is quieter by that much at low level, and its curves are slightly softer at the knee.

const finite = (value: JsonValue | undefined, fallback: number) => isJsonNumber(value) && Number.isFinite(value) ? value : fallback

const retiredKeys: ReadonlySet<string> = new Set(['colorAmount'])

const OLD_COLOR_RANGE_DB = 12

export const migrateSaturatorParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const defaults = createDefaultSaturatorParams()
  const amount = Math.min(1, Math.max(0, finite(params.colorAmount, 0)))
  const kept = Object.fromEntries(Object.entries(params).filter(([key]) => !retiredKeys.has(key)))

  return {
    ...defaults,
    ...kept,
    colorHighDb: Math.min(SATURATOR_COLOR_DB_MAX, Math.max(SATURATOR_COLOR_DB_MIN, amount * OLD_COLOR_RANGE_DB)),
  }
}
