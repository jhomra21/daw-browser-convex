import {
  AUDIO_EFFECT_PARAMS_VERSIONING,
  isAudioEffectKind,
  migrateAudioEffectParams,
  type AudioEffectParamsVersioning,
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

/** For callers holding an untyped `ctx`: fixes the row type so the migrated rows keep their document fields. */
export const currentEffectDocs = async (rows: Promise<Doc<'effects'>[]>) => currentEffectRows(await rows)
