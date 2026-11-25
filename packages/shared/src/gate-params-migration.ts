import { snapGateLookaheadMs } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 had no Flip and its lookahead was a continuous 0 to 2 ms knob; the delay was a fixed 2 ms
// whatever it said. The lookahead moves to the nearest of the 0, 1 and 10 ms steps and now sets the delay. The detector
// filter was always a high-pass, and the key from another track was used as it came, so Gain starts at 0 dB and Dry/Wet at
// 100 %. Every other knob keeps its value. Attack and Release now mean the time the gain takes to cover the whole Floor
// range, where they used to be one-pole time constants.
export const migrateGateParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const wrapped = isJsonObject(params.state)
  const old = wrapped && isJsonObject(params.state) ? params.state : params
  const sidechain = isJsonObject(old.sidechain) ? old.sidechain : {}

  const state: JsonValue = {
    ...old,
    lookaheadMs: snapGateLookaheadMs(isJsonNumber(old.lookaheadMs) && Number.isFinite(old.lookaheadMs) ? old.lookaheadMs : 0),
    flip: false,
    sidechain: { ...sidechain, filterType: 'highpass', gainDb: 0, mix: 1 },
  }

  return wrapped ? { ...params, state } : state
}
