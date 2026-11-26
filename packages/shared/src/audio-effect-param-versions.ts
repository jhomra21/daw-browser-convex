import { migrateCompressorParamsV1 } from './compressor-params-migration'
import { migrateDelayParamsV1 } from './delay-params-migration'
import { migrateGateParamsV1 } from './gate-params-migration'
import { migrateLimiterParamsV1 } from './limiter-params-migration'
import { migrateAutoPanParamsV1, migrateChorusParamsV1, migrateEnsembleParamsV1, migrateFlangerParamsV1, migratePhaserParamsV1, migrateTremoloParamsV1 } from './modulation-params-migration'
import { migrateSaturatorParamsV1 } from './saturator-params-migration'
import { migrateReverbParamsV1, migrateReverbStereoWidthV1 } from './reverb-params-migration'
import { migrateAutoFilterEnvelopeAmountV1, migrateAutoFilterParamsV1, migrateAutoFilterResonanceV1 } from './auto-filter-params-migration'
import { getAutomationParameterDescriptor } from './automation-parameters'
import { isAudioEffectKind, type AudioEffectKind } from './audio-effect-registry'
import { isJsonObject, type JsonValue } from './json-value'

// Storage-only versioning: persisted effect rows carry an optional `paramsVersion` (absent = 1).
// Public contracts and in-memory params always use the current shape; readers migrate before use.
export const AUDIO_EFFECT_PARAMS_VERSION: Readonly<Record<AudioEffectKind, number>> = {
  eq: 2,
  compressor: 2,
  saturator: 2,
  delay: 2,
  reverb: 2,
  autofilter: 2,
  gate: 2,
  limiter: 2,
  lofi: 1,
  chorus: 2,
  flanger: 2,
  phaser: 2,
  tremolo: 2,
  autopan: 2,
  ensemble: 2,
  spectral: 1,
  utility: 1,
  spectrum: 1,
}

type AudioEffectParamsMigrationStep = (params: JsonValue) => JsonValue

type AutomationValueMigration = (value: number) => number

export type AudioEffectParamsVersioning = {
  current: Readonly<Record<AudioEffectKind, number>>
  // migrations[kind][n] upgrades params stored at version n to version n + 1.
  migrations: Readonly<Partial<Record<AudioEffectKind, Readonly<Record<number, AudioEffectParamsMigrationStep>>>>>
  // parameterValues[kind][n][parameterId] rescales an automation point value recorded at version n to version n + 1.
  // A parameter with no entry keeps its value across that step.
  parameterValues: Readonly<Partial<Record<AudioEffectKind, Readonly<Record<number, Readonly<Record<string, AutomationValueMigration>>>>>>>
}

function migrateEqV1ToV2(params: JsonValue): JsonValue {
  if (!isJsonObject(params)) return params
  const bands = Array.isArray(params.bands) ? params.bands : []
  const curveB = bands.map((band, index) => (isJsonObject(band) ? { ...band, id: `b${index + 9}` } : band))

  return { ...params, bands: [...bands, ...curveB], adaptiveQ: false, scale: 1, outputDb: 0, highQuality: false }
}

export const AUDIO_EFFECT_PARAMS_VERSIONING: AudioEffectParamsVersioning = {
  current: AUDIO_EFFECT_PARAMS_VERSION,
  migrations: {
    autofilter: { 1: migrateAutoFilterParamsV1 },
    // EQ Eight: curve B (a copy of curve A, so L/R and M/S start identical), Scale 100 %, Output 0 dB, Adaptive Q off and
    // Hi-Quality off. Band types, frequencies, gains and Qs and the channel mode (incl. 'mono') carry over unchanged.
    eq: { 1: migrateEqV1ToV2 },
    // Compressor: Auto Makeup off, lookahead snapped to the nearest 0/1/10 ms step.
    compressor: { 1: migrateCompressorParamsV1 },
    // Gate: Flip off, sidechain Gain 0 dB, Dry/Wet 100 %, lookahead snapped to the nearest 0/1/10 ms step.
    gate: { 1: migrateGateParamsV1 },
    // Limiter: Gain 0 dB, Auto off, lookahead snapped to the nearest 1.5/3/6 ms step.
    limiter: { 1: migrateLimiterParamsV1 },
    // Delay: one time per channel (Mode and division carry to both, linked), the filter pair becomes the band-pass whose edges they were,
    // time smoothing Repitch, Freeze and offsets off.
    delay: { 1: migrateDelayParamsV1 },
    // Saturator: Color Amount becomes Amt Hi (x 12 dB), Hi-Quality on, Post Clip off; each old curve's small-signal gain moves into Drive so levels hold (saturator-params-migration.ts).
    saturator: { 1: migrateSaturatorParamsV1 },
    // Reverb: Density Sparse (the old 8 lines), the old in-loop cuts as shelves, Width as the Stereo angle, Chorus on, Smooth Fast.
    reverb: { 1: migrateReverbParamsV1 },
    // Chorus, Flanger, Ensemble, Phaser, Tremolo, Auto Pan: each added control starts at the value that keeps the old setting (modulation-params-migration.ts).
    chorus: { 1: migrateChorusParamsV1 },
    flanger: { 1: migrateFlangerParamsV1 },
    phaser: { 1: migratePhaserParamsV1 },
    tremolo: { 1: migrateTremoloParamsV1 },
    autopan: { 1: migrateAutoPanParamsV1 },
    ensemble: { 1: migrateEnsembleParamsV1 },
  },
  parameterValues: {
    reverb: { 1: { 'reverb.stereoWidth': migrateReverbStereoWidthV1 } },
    autofilter: {
      1: {
        'autofilter.resonance': migrateAutoFilterResonanceV1,
        'autofilter.envelope.amountOctaves': migrateAutoFilterEnvelopeAmountV1,
      },
    },
  },
}

// Remembers which unreadable versions were already reported so a project list does not log per row.
const warnedVersions = new Set<string>()

// The version to migrate from, or null when this build cannot read it (newer app, or corrupt): the caller keeps the stored data.
const readableVersion = (kind: AudioEffectKind, storedVersion: number | undefined, current: number, noun: string): number | null => {
  const version = storedVersion ?? 1

  if (Number.isInteger(version) && version >= 1 && version <= current) return version
  const key = `${noun}:${kind}@${version}`

  if (!warnedVersions.has(key)) {
    warnedVersions.add(key)
    console.warn(`Stored ${kind} ${noun} version ${version} is not readable by this build (current ${current}); using ${noun} as stored.`)
  }

  return null
}

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
  let version = readableVersion(kind, storedVersion, current, 'params')

  if (version === null) return params
  let migrated = params

  for (; version < current; version += 1) {
    const step = versioning.migrations[kind]?.[version]

    if (!step) throw new Error(`Missing ${kind} params migration from version ${version} to ${version + 1}.`)
    migrated = step(migrated)
  }

  return migrated
}

/**
 * Params a client wrote at `writtenVersion`, brought to this build's current shape. Undefined when this build cannot
 * read that version (the client is newer, or the number is malformed), so the write must be refused: stamping it with
 * the current version would pass newer params off as current. Kinds outside the catalog pass through.
 */
export const migrateWrittenAudioEffectParams = (
  kind: string,
  params: JsonValue,
  writtenVersion: number,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): JsonValue | undefined => {
  if (!isAudioEffectKind(kind)) return params

  if (!Number.isInteger(writtenVersion) || writtenVersion < 1 || writtenVersion > versioning.current[kind]) return undefined

  return migrateAudioEffectParams(kind, params, writtenVersion, versioning)
}

/** The storage field to write with every persisted effect; empty for non-catalog rows such as instruments. */
export const audioEffectParamsVersionStamp = (kind: string): { paramsVersion?: number } => (
  isAudioEffectKind(kind) ? { paramsVersion: AUDIO_EFFECT_PARAMS_VERSION[kind] } : {}
)

// Automation envelopes that target an effect parameter carry the same storage field idea: `valuesVersion` (absent = 1) is the
// version of the effect kind whose parameter units the point values were written in. Mixer and instrument lanes have no kind.
const automationParameterEffectKind = (parameterId: string): AudioEffectKind | null => {
  const owner = getAutomationParameterDescriptor(parameterId)?.owner

  return isAudioEffectKind(owner) ? owner : null
}

/** Rescales stored automation point values to the current version of the parameter's effect kind. Newer or unreadable versions pass through. */
export const migrateAutomationPointValues = <Point extends { value: number }>(
  parameterId: string,
  points: Point[],
  storedVersion: number | undefined,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): Point[] => {
  const kind = automationParameterEffectKind(parameterId)

  if (!kind) return points
  const current = versioning.current[kind]
  let version = readableVersion(kind, storedVersion, current, 'automation values')

  if (version === null) return points
  const steps: AutomationValueMigration[] = []

  for (; version < current; version += 1) {
    const step = versioning.parameterValues[kind]?.[version]?.[parameterId]

    if (step) steps.push(step)
  }

  return steps.length === 0 ? points : points.map((point) => ({ ...point, value: steps.reduce((value, step) => step(value), point.value) }))
}

/** The storage field to write with every persisted automation envelope; empty for lanes that do not target an effect parameter. */
export const automationValuesVersionStamp = (parameterId: string): { valuesVersion?: number } => {
  const kind = automationParameterEffectKind(parameterId)

  return kind ? { valuesVersion: AUDIO_EFFECT_PARAMS_VERSION[kind] } : {}
}
