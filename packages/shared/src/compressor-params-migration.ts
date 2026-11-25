import { snapCompressorLookaheadMs } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 had no Auto Makeup and a continuous 0 to 10 ms lookahead that always delayed the audio by the
// full 10 ms. The lookahead moves to the nearest of the 0, 1 and 10 ms steps and now sets the delay. Every other knob keeps
// its meaning, and Auto Makeup starts off so a saved project keeps its level.
//
// Owner decision (R8): the v2 kernel's program-dependent Auto Release (0.25x to 2x of Release) and its 10 ms RMS time
// constant intentionally change the sound of migrated devices; nothing is stored to compensate.
//
// Expand mode became upward expansion (Live's: above the threshold every dB in adds ratio - 1 dB) and Auto Makeup no
// longer applies in Expand. That changes the meaning of the stored values and not their form: every stored threshold,
// ratio, knee and makeup is still valid and in range, and a saved Expand device is meant to sound as the new Expand,
// so no params version bump and no rewrite of stored values is needed.
export const migrateCompressorParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const wrapped = isJsonObject(params.state)
  const old = wrapped && isJsonObject(params.state) ? params.state : params

  const state: JsonValue = {
    ...old,
    autoMakeup: false,
    lookaheadMs: snapCompressorLookaheadMs(isJsonNumber(old.lookaheadMs) && Number.isFinite(old.lookaheadMs) ? old.lookaheadMs : 0),
  }

  return wrapped ? { ...params, state } : state
}
