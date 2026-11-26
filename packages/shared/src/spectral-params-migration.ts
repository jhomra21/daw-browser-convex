import { isJsonNumber, isJsonObject, type JsonObject, type JsonValue } from './json-value'
import { createDefaultSpectralParams } from './spectral-params'

// Version 1 -> 2. Version 2 states the Gate threshold in dBFS, the level of a bin-centred sine, at every FFT size; version 1 compared
// the raw bin magnitude of the windowed FFT, which grows with the FFT size. The threshold moves by exactly the window's peak gain,
// newDb = oldDb - 20 log10(sum(window) / 2), so a stored Gate opens and closes on the same signal as before (clamped to the -120 to 0 dB
// range). The window is the periodic sqrt-Hann the kernel uses, whose sum is cot(pi / 2N). The new Gate also looks at the loudest of a bin and
// its two neighbours, which opens it slightly earlier on a bin the signal leaks into. Every other knob keeps its value; Learn
// (a rate before) is a toggle, so any rate above 0 becomes on; the Noise Reduce floor starts at the -30 dB the old spectral subtraction
// did not have but the new Wiener gain defaults to. Noise Reduce and HPSS sound different by design (owner decision, applies to every project).

const FFT_SIZES: readonly number[] = [512, 1024, 2048, 4096]

const DEFAULT_FFT_SIZE = 2048

/** The gain, in dB, of a full-scale bin-centred sine in the raw FFT of the sqrt-Hann window at this size. */
export const spectralGateDbOffset = (fftSize: number) => 20 * Math.log10(1 / Math.tan(Math.PI / (2 * fftSize)) / 2)

const clampThreshold = (db: number) => Math.min(0, Math.max(-120, db))

/** A Gate threshold recorded at version 1, moved to dBFS for the given FFT size (the default size when it is not a legal one). */
export const migrateSpectralGateThresholdV1 = (thresholdDb: number, fftSize: number = DEFAULT_FFT_SIZE) =>
  clampThreshold(thresholdDb - spectralGateDbOffset(FFT_SIZES.includes(fftSize) ? fftSize : DEFAULT_FFT_SIZE))

const spectralStateOf = (params: JsonObject): JsonObject => (isJsonObject(params.state) ? params.state : params)

/** The FFT size an effect's stored params carry (the unwrapped or `state`-wrapped form), or undefined when it has none. */
export const storedSpectralFftSize = (params: JsonValue | undefined): number | undefined => {
  const fftSize = isJsonObject(params) ? spectralStateOf(params).fftSize : undefined

  return isJsonNumber(fftSize) ? fftSize : undefined
}

export const migrateSpectralParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const wrapped = isJsonObject(params.state)
  const old = spectralStateOf(params)
  const defaults = createDefaultSpectralParams()
  const threshold = isJsonNumber(old.gateThresholdDb) && Number.isFinite(old.gateThresholdDb) ? old.gateThresholdDb : defaults.gateThresholdDb
  const learn = isJsonNumber(old.profileLearn) && old.profileLearn > 0

  const state: JsonValue = {
    noiseFloorDb: defaults.noiseFloorDb,
    ...old,
    gateThresholdDb: migrateSpectralGateThresholdV1(threshold, storedSpectralFftSize(params)),
    profileLearn: learn ? 1 : 0,
  }

  return wrapped ? { ...params, state } : state
}
