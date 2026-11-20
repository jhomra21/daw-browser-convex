import type { AudioEffectKind } from './audio-effect-registry'
import { AUDIO_EFFECT_CONTRACTS } from './effects-params'
import { isJsonObject, type JsonObject, type JsonValue } from './json-value'

type AudioEffectParamsByKind = {
  [Kind in AudioEffectKind]: ReturnType<typeof AUDIO_EFFECT_CONTRACTS[Kind]['normalizeParams']>
}

// The kind with the params its contract normalizes to, in the two names a kind goes by: `kind` on a runtime
// instance and `effect` on a stored or history row.
type AudioEffectNormalizers = {
  [Kind in AudioEffectKind]: (params: JsonValue) => AudioEffectParamsByKind[Kind]
}

export type NormalizedAudioEffect<Kind extends AudioEffectKind = AudioEffectKind> = {
  [Match in Kind]: { kind: Match; params: AudioEffectParamsByKind[Match] }
}[Kind]

export type NormalizedAudioEffectRow<Kind extends AudioEffectKind = AudioEffectKind> = {
  [Match in Kind]: { effect: Match; params: AudioEffectParamsByKind[Match] }
}[Kind]

export type NormalizedAudioEffectChange<Kind extends AudioEffectKind = AudioEffectKind> = {
  [Match in Kind]: { effect: Match; from: AudioEffectParamsByKind[Match]; to: AudioEffectParamsByKind[Match] }
}[Kind]

export type NormalizedMasterAudioEffectChange<Kind extends AudioEffectKind = AudioEffectKind> = {
  [Match in Kind]: { effect: `master-${Match}`; from: AudioEffectParamsByKind[Match]; to: AudioEffectParamsByKind[Match] }
}[Kind]

const jsonRecord = (value: JsonValue): JsonObject => isJsonObject(value) ? value : {}

// The one per-kind dispatch to a params normalizer. Eq, compressor, saturator, delay and reverb normalize a plain
// object and take {} for stored params that are not one.
const NORMALIZERS: AudioEffectNormalizers = {
  utility: AUDIO_EFFECT_CONTRACTS.utility.normalizeParams,
  eq: (params) => AUDIO_EFFECT_CONTRACTS.eq.normalizeParams(jsonRecord(params)),
  autofilter: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams,
  gate: AUDIO_EFFECT_CONTRACTS.gate.normalizeParams,
  compressor: (params) => AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams(jsonRecord(params)),
  saturator: (params) => AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams(jsonRecord(params)),
  limiter: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams,
  lofi: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams,
  chorus: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams,
  flanger: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams,
  phaser: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams,
  tremolo: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams,
  autopan: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams,
  ensemble: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams,
  delay: (params) => AUDIO_EFFECT_CONTRACTS.delay.normalizeParams(jsonRecord(params)),
  reverb: (params) => AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams(jsonRecord(params)),
  spectral: AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams,
  spectrum: AUDIO_EFFECT_CONTRACTS.spectrum.normalizeParams,
}

export const normalizeAudioEffect = <Kind extends AudioEffectKind>(kind: Kind, params: JsonValue): NormalizedAudioEffect<Kind> => ({
  kind,
  params: NORMALIZERS[kind](params),
})

export const normalizeAudioEffectRow = <Kind extends AudioEffectKind>(effect: Kind, params: JsonValue): NormalizedAudioEffectRow<Kind> => ({
  effect,
  params: NORMALIZERS[effect](params),
})

export const normalizeAudioEffectChange = <Kind extends AudioEffectKind>(
  effect: Kind,
  from: JsonValue,
  to: JsonValue,
): NormalizedAudioEffectChange<Kind> => ({ effect, from: NORMALIZERS[effect](from), to: NORMALIZERS[effect](to) })

export const normalizeMasterAudioEffectChange = <Kind extends AudioEffectKind>(
  effect: Kind,
  from: JsonValue,
  to: JsonValue,
): NormalizedMasterAudioEffectChange<Kind> => ({ effect: `master-${effect}`, from: NORMALIZERS[effect](from), to: NORMALIZERS[effect](to) })
