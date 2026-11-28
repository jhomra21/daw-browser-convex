import { AUDIO_EFFECT_PARAMS_VERSIONING, audioEffectParamsVersionStamp, migrateAudioEffectParams, type AudioEffectParamsVersioning } from './audio-effect-param-versions'
import { isAudioEffectKind } from './audio-effect-registry'
import { INSTRUMENT_PARAMS_VERSION, migrateInstrumentParams, type VersionedInstrumentKind } from './instrument-param-versions'
import { isInstrumentKind } from './instrument-params'
import { isJsonObject, type JsonValue } from './json-value'

// An 'instrument' row stores { kind, instanceId, params }; a legacy 'synth' and an 'arpeggiator' row store the params themselves.
const instrumentRowKind = (type: string, params: JsonValue): VersionedInstrumentKind | undefined => {
  if (type === 'synth' || type === 'arpeggiator') return type

  return type === 'instrument' && isJsonObject(params) && isInstrumentKind(params.kind) ? params.kind : undefined
}

/**
 * The single migration for any stored effect row: audio effects, instruments, legacy synths and arpeggiators.
 * `type` is the row's type, so an 'instrument' row migrates the params inside its envelope by the envelope's kind.
 */
export const migrateEffectRowParams = (
  type: string,
  params: JsonValue,
  storedVersion: number | undefined,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): JsonValue => {
  if (isAudioEffectKind(type)) return migrateAudioEffectParams(type, params, storedVersion, versioning)
  const kind = instrumentRowKind(type, params)

  if (!kind) return params

  if (type !== 'instrument') return migrateInstrumentParams(kind, params, storedVersion)

  return isJsonObject(params) && params.params !== undefined ? { ...params, params: migrateInstrumentParams(kind, params.params, storedVersion) } : params
}

/** The storage field to write with every persisted effect row of any type; empty for rows outside the catalog. */
export const effectRowParamsVersionStamp = (type: string, params: JsonValue): { paramsVersion?: number } => {
  const kind = instrumentRowKind(type, params)

  return kind ? { paramsVersion: INSTRUMENT_PARAMS_VERSION[kind] } : audioEffectParamsVersionStamp(type)
}
