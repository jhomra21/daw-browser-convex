import { createDefaultDelayParams, DELAY_FILTER_HZ_MAX, DELAY_FILTER_HZ_MIN, DELAY_FILTER_WIDTH_MAX, DELAY_FILTER_WIDTH_MIN } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 had one time (a free time or one division, by Mode), a high-pass and a low-pass pair as the filter,
// a 3 s line and no Freeze, Link, offsets or time smoothing. What carries over:
// - Mode sync becomes both channels synced to that division (straight); Mode time keeps the free time on both channels, linked;
// - the filter pair becomes the band-pass whose -3 dB edges are the old cuts: Frequency their geometric mean, Width their distance in
//   octaves (the old 12 dB/octave edges are steeper than the band-pass's 6 dB/octave skirts, so the migrated filter is wider at the foot);
// - time smoothing starts at Repitch (the new default), Freeze and the offsets off.

const finite = (value: JsonValue | undefined, fallback: number) => isJsonNumber(value) && Number.isFinite(value) ? value : fallback

const retiredKeys: ReadonlySet<string> = new Set(['mode', 'syncDivision', 'timeMs', 'lowCutHz', 'highCutHz'])

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const migrateDelayParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const defaults = createDefaultDelayParams()
  const lowCutHz = clamp(finite(params.lowCutHz, 120), DELAY_FILTER_HZ_MIN, DELAY_FILTER_HZ_MAX)
  const highCutHz = clamp(finite(params.highCutHz, 8000), lowCutHz, DELAY_FILTER_HZ_MAX)
  const synced = params.mode !== 'time'
  const division = params.syncDivision ?? defaults.divisionLeft
  const timeMs = finite(params.timeMs, defaults.timeLeftMs)
  const kept = Object.fromEntries(Object.entries(params).filter(([key]) => !retiredKeys.has(key)))

  return {
    ...defaults,
    ...kept,
    syncLeft: synced,
    syncRight: synced,
    divisionLeft: division,
    divisionRight: division,
    timeLeftMs: timeMs,
    timeRightMs: timeMs,
    filterHz: clamp(Math.sqrt(lowCutHz * highCutHz), DELAY_FILTER_HZ_MIN, DELAY_FILTER_HZ_MAX),
    filterWidth: clamp(Math.log2(highCutHz / lowCutHz), DELAY_FILTER_WIDTH_MIN, DELAY_FILTER_WIDTH_MAX),
  }
}
