import { isAudioEffectKind, type AudioEffectKind } from './audio-effect-registry'
import type { JsonValue } from './json-value'

// Storage-only versioning: persisted effect rows carry an optional `paramsVersion` (absent = 1).
// Public contracts and in-memory params always use the current shape; readers migrate before use.
export const AUDIO_EFFECT_PARAMS_VERSION: Readonly<Record<AudioEffectKind, number>> = {
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
}

type AudioEffectParamsMigrationStep = (params: JsonValue) => JsonValue

export type AudioEffectParamsVersioning = {
  current: Readonly<Record<AudioEffectKind, number>>
  // migrations[kind][n] upgrades params stored at version n to version n + 1.
  migrations: Readonly<Partial<Record<AudioEffectKind, Readonly<Record<number, AudioEffectParamsMigrationStep>>>>>
}

export const AUDIO_EFFECT_PARAMS_VERSIONING: AudioEffectParamsVersioning = {
  current: AUDIO_EFFECT_PARAMS_VERSION,
  migrations: {},
}

// Remembers which unreadable versions were already reported so a project list does not log per row.
const warnedVersions = new Set<string>()

/**
 * Upgrades stored params to the current version. A version this build cannot read
 * (newer app, or corrupt) returns the params unchanged so the normalizers apply as they do today.
 * A gap in the migration table is a programming error and throws.
 */
export const migrateAudioEffectParams = (
  kind: AudioEffectKind,
  params: JsonValue,
  storedVersion: number | undefined,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): JsonValue => {
  const current = versioning.current[kind]
  let version = storedVersion ?? 1

  if (!Number.isInteger(version) || version < 1 || version > current) {
    const key = `${kind}@${version}`

    if (!warnedVersions.has(key)) {
      warnedVersions.add(key)
      console.warn(`Stored ${kind} params version ${version} is not readable by this build (current ${current}); using params as stored.`)
    }

    return params
  }

  let migrated = params

  for (; version < current; version += 1) {
    const step = versioning.migrations[kind]?.[version]

    if (!step) throw new Error(`Missing ${kind} params migration from version ${version} to ${version + 1}.`)
    migrated = step(migrated)
  }

  return migrated
}

/** The storage field to write with every persisted effect; empty for non-catalog rows such as instruments. */
export const audioEffectParamsVersionStamp = (kind: string): { paramsVersion?: number } => (
  isAudioEffectKind(kind) ? { paramsVersion: AUDIO_EFFECT_PARAMS_VERSION[kind] } : {}
)
