import type { JsonValue } from './json-value'

type ParamsMigrationStep = (params: JsonValue) => JsonValue

// `ownerParams` are the stored params of the processor the lane targets, or undefined when the caller does not know that processor.
export type AutomationValueMigration = (value: number, ownerParams?: JsonValue) => number

// The version tables shared by every kind of persisted processor params: audio effects, instruments and the arpeggiator.
export type ParamsVersioning<Kind extends string> = {
  current: Readonly<Record<Kind, number>>
  // migrations[kind][n] upgrades params stored at version n to version n + 1.
  migrations: Readonly<Partial<Record<Kind, Readonly<Record<number, ParamsMigrationStep>>>>>
  // parameterValues[kind][n][parameterId] rescales an automation point value recorded at version n to version n + 1.
  // A parameter with no entry keeps its value across that step.
  parameterValues: Readonly<Partial<Record<Kind, Readonly<Record<number, Readonly<Record<string, AutomationValueMigration>>>>>>>
}

// Remembers which unreadable versions were already reported so a project list does not log per row.
const warnedVersions = new Set<string>()

// The version to migrate from, or null when this build cannot read it (newer app, or corrupt): the caller keeps the stored data.
const readableVersion = (kind: string, storedVersion: number | undefined, current: number, noun: string): number | null => {
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
export const migrateParamsStepwise = <Kind extends string>(
  versioning: ParamsVersioning<Kind>,
  kind: Kind,
  params: JsonValue,
  storedVersion: number | undefined,
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

/** Rescales stored automation point values to the current version of their owner kind. Newer or unreadable versions pass through. */
export const migrateAutomationValuesStepwise = <Kind extends string, Point extends { value: number }>(
  versioning: ParamsVersioning<Kind>,
  kind: Kind,
  parameterId: string,
  points: Point[],
  storedVersion: number | undefined,
  ownerParams?: JsonValue,
): Point[] => {
  const current = versioning.current[kind]
  let version = readableVersion(kind, storedVersion, current, 'automation values')

  if (version === null) return points
  const steps: AutomationValueMigration[] = []

  for (; version < current; version += 1) {
    const step = versioning.parameterValues[kind]?.[version]?.[parameterId]

    if (step) steps.push(step)
  }

  return steps.length === 0 ? points : points.map((point) => ({ ...point, value: steps.reduce((value, step) => step(value, ownerParams), point.value) }))
}
