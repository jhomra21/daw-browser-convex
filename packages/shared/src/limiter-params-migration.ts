import { snapLimiterLookaheadMs } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 had no Gain or Auto, its lookahead was a continuous 1 to 5 ms that never changed the delay,
// and it carried a fixed detectorOversampling. Ceiling, Release and Link keep their meaning. The lookahead moves to the
// nearest of the new 1.5, 3 and 6 ms steps (the old 5 ms default becomes 6 ms).
export const migrateLimiterParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const wrapped = isJsonObject(params.state)
  const old = wrapped && isJsonObject(params.state) ? params.state : params

  const kept = Object.fromEntries(Object.entries(old).filter(([key]) => key !== 'detectorOversampling'))

  const state: JsonValue = {
    ...kept,
    gainDb: 0,
    autoRelease: false,
    lookaheadMs: snapLimiterLookaheadMs(isJsonNumber(old.lookaheadMs) && Number.isFinite(old.lookaheadMs) ? old.lookaheadMs : 5),
  }

  return wrapped ? { ...params, state } : state
}
