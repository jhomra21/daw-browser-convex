import { snapCompressorLookaheadMs } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 had no Auto Makeup and a continuous 0 to 10 ms lookahead that always delayed the audio by the
// full 10 ms. The lookahead moves to the nearest of the 0, 1 and 10 ms steps and now sets the delay. Every other knob keeps
// its meaning, and Auto Makeup starts off so a saved project keeps its level.
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
