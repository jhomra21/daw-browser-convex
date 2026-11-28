import {
  AUDIO_EFFECT_PARAMS_VERSIONING,
  migrateAutomationPointValues,
  type AudioEffectParamsVersioning,
} from '@daw-browser/shared'
import type { Doc } from './_generated/dataModel'

export type CurrentAutomationDoc = Omit<Doc<'automationEnvelopes'>, 'valuesVersion'>

type AutomationValuesRow = Pick<Doc<'automationEnvelopes'>, 'parameterId' | 'points' | 'valuesVersion'>

/** The single read boundary for stored automation rows: migrates point values to the current version and drops the storage field. */
export const currentAutomationRow = <Row extends AutomationValuesRow>(
  row: Row,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): Omit<Row, 'valuesVersion'> => {
  const { valuesVersion, ...stored } = row

  return { ...stored, points: migrateAutomationPointValues(row.parameterId, row.points, valuesVersion, versioning) }
}

export const currentAutomationRows = <Row extends AutomationValuesRow>(
  rows: readonly Row[],
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): Omit<Row, 'valuesVersion'>[] => rows.map((row) => currentAutomationRow(row, versioning))

/** For callers holding an untyped `ctx`: fixes the row type so the migrated rows keep their document fields. */
export const currentAutomationDocs = async (rows: Promise<Doc<'automationEnvelopes'>[]>) => currentAutomationRows(await rows)
