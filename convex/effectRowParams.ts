import {
  AUDIO_EFFECT_PARAMS_VERSIONING,
  isAudioEffectKind,
  migrateAudioEffectParams,
  migrateWrittenAudioEffectParams,
  type AudioEffectParamsVersioning,
  type JsonValue,
  type SharedUngroupRestoreEffect,
} from '@daw-browser/shared'
import type { Doc } from './_generated/dataModel'

type EffectParamsRow = Pick<Doc<'effects'>, 'type' | 'params' | 'paramsVersion'>

/** The single read boundary for stored effect rows: migrates params to the current version and drops the storage field. */
export const currentEffectRow = <Row extends EffectParamsRow>(
  row: Row,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): Omit<Row, 'paramsVersion'> => {
  const { paramsVersion, ...stored } = row

  if (!isAudioEffectKind(row.type)) return stored

  return { ...stored, params: migrateAudioEffectParams(row.type, row.params, paramsVersion, versioning) }
}

export const currentEffectRows = <Row extends EffectParamsRow>(
  rows: readonly Row[],
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): Omit<Row, 'paramsVersion'>[] => rows.map((row) => currentEffectRow(row, versioning))

/**
 * The write boundary for client-written params, as the read boundary above is for stored ones: brings them to the
 * current shape from the version the client wrote them at. Undefined means this server cannot read that version, so the
 * write is refused. No version means this server's own code wrote them in the current shape.
 */
export const writtenEffectParams = (type: string, params: JsonValue, paramsVersion: number | undefined): JsonValue | undefined => (
  paramsVersion === undefined ? params : migrateWrittenAudioEffectParams(type, params, paramsVersion)
)

/** Restored effects with their params brought to the current shape; null when one was written by a newer client. A missing version is version 1. */
export const writtenRestoreEffects = (effects: readonly SharedUngroupRestoreEffect[]): SharedUngroupRestoreEffect[] | null => {
  const written: SharedUngroupRestoreEffect[] = []

  for (const effect of effects) {
    const params = writtenEffectParams(effect.type, effect.params, effect.paramsVersion ?? 1)

    if (params === undefined) return null
    written.push({ ...effect, params })
  }

  return written
}

/** For callers holding an untyped `ctx`: fixes the row type so the migrated rows keep their document fields. */
export const currentEffectDocs = async (rows: Promise<Doc<'effects'>[]>) => currentEffectRows(await rows)
