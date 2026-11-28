import { LOFI_SAMPLE_RATE_HZ_MAX, LOFI_SAMPLE_RATE_HZ_MIN } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. The old Rate was a fraction of the host rate; it is now in Hz. A ratio is taken at 48 kHz (the rate the old
// default engine ran at), so 0.25 becomes 12000 Hz at every host rate. Ratio 1 meant "no reduction" and becomes the top of the
// range, which passes every sample at every host rate. The band-limiting filters, the Floor offset correction and the sub-sample clock start off, so
// the sound of a stored setting does not change. The clip at one now applies only when the bit depth is under 24 or the rate is
// reduced, so a 24-bit full-rate Lo-Fi no longer clips a signal that was already over full scale.
const MIGRATION_HOST_RATE_HZ = 48000

const sampleRateForRatio = (ratio: number) => (
  ratio >= 1 ? LOFI_SAMPLE_RATE_HZ_MAX : Math.min(LOFI_SAMPLE_RATE_HZ_MAX, Math.max(LOFI_SAMPLE_RATE_HZ_MIN, ratio * MIGRATION_HOST_RATE_HZ))
)

export const migrateLoFiParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const wrapped = isJsonObject(params.state)
  const old = wrapped && isJsonObject(params.state) ? params.state : params
  const { sampleRateRatio, ...kept } = old

  const state: JsonValue = {
    ...kept,
    sampleRateHz: sampleRateForRatio(isJsonNumber(sampleRateRatio) && Number.isFinite(sampleRateRatio) ? sampleRateRatio : 1),
    preFilter: false,
    postFilter: false,
    dcCorrection: false,
    subSampleClock: false,
  }

  return wrapped ? { ...params, state } : state
}
