import type { AudioEffectKind } from './audio-effect-registry'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

export const AUDIO_EFFECT_PARAMS_VERSION = {
  eq: 1,
  compressor: 1,
  saturator: 1,
  delay: 1,
  reverb: 1,
  autofilter: 1,
  gate: 1,
  limiter: 1,
  lofi: 1,
  chorus: 1,
  flanger: 1,
  phaser: 1,
  tremolo: 1,
  autopan: 1,
  ensemble: 1,
  spectral: 1,
  utility: 1,
  spectrum: 1,
} satisfies Record<AudioEffectKind, number>

export const readAudioEffectParamsVersion = (version: number | undefined): number => version ?? 1

export const audioEffectParamsVersion = (
  kind: AudioEffectKind,
  params: JsonValue,
): number => {
  if (
    kind !== 'eq'
    && kind !== 'compressor'
    && kind !== 'saturator'
    && kind !== 'delay'
    && kind !== 'reverb'
    && isJsonObject(params)
    && isJsonNumber(params.version)
  ) return params.version

  return AUDIO_EFFECT_PARAMS_VERSION[kind]
}

export const migrateAudioEffectParams = (
  kind: AudioEffectKind,
  params: JsonValue,
  storedVersion: number | undefined,
  migrations: Partial<Record<AudioEffectKind, Readonly<Record<number, (params: JsonValue) => JsonValue>>>> = {},
  currentVersion = AUDIO_EFFECT_PARAMS_VERSION[kind],
): JsonValue => {
  const embeddedVersion = isJsonObject(params)
    && isJsonNumber(params.version)
    && kind !== 'eq'
    && kind !== 'compressor'
    && kind !== 'saturator'
    && kind !== 'delay'
    && kind !== 'reverb'
    ? params.version
    : undefined

  let version = readAudioEffectParamsVersion(storedVersion ?? embeddedVersion)

  let current = params

  if (!Number.isInteger(version) || version < 1 || version > currentVersion) {
    throw new Error(`Unsupported ${kind} params version ${version}.`)
  }

  while (version < currentVersion) {
    const migrate = migrations[kind]?.[version]

    if (!migrate) throw new Error(`Missing ${kind} params migration from version ${version}.`)
    current = migrate(current)
    version += 1
  }

  return current
}
