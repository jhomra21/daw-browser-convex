import {
  AUDIO_EFFECT_PARAMS_VERSIONING,
  effectParamsByInstanceId,
  migrateAutomationPointValues,
  type AudioEffectParamsVersioning,
  type JsonValue,
} from '@daw-browser/shared'
import type { Doc } from './_generated/dataModel'
import type { DatabaseReader } from './_generated/server'

export type CurrentAutomationDoc = Omit<Doc<'automationEnvelopes'>, 'valuesVersion'>

type AutomationValuesRow = Pick<Doc<'automationEnvelopes'>, 'parameterId' | 'points' | 'valuesVersion' | 'effectInstanceId'>

/**
 * The single read boundary for stored automation rows: migrates point values to the current version and drops the storage field.
 * `owners` are the lanes' effects; a lane whose effect is not in them (deleted, or not read by the caller) migrates without its owner's params.
 */
export const currentAutomationRow = <Row extends AutomationValuesRow>(
  row: Row,
  owners?: ReadonlyMap<string, JsonValue>,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): Omit<Row, 'valuesVersion'> => {
  const { valuesVersion, ...stored } = row
  const ownerParams = row.effectInstanceId === undefined ? undefined : owners?.get(row.effectInstanceId)

  return { ...stored, points: migrateAutomationPointValues(row.parameterId, row.points, valuesVersion, versioning, ownerParams) }
}

export const currentAutomationRows = <Row extends AutomationValuesRow>(
  rows: readonly Row[],
  owners?: ReadonlyMap<string, JsonValue>,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): Omit<Row, 'valuesVersion'>[] => rows.map((row) => currentAutomationRow(row, owners, versioning))

/** Every automation lane of a project in current units, migrated with the params of the effects they target. */
export const readProjectAutomation = async (db: DatabaseReader, projectId: string) => {
  const [rows, effects] = await Promise.all([
    db.query('automationEnvelopes').withIndex('by_project', (q) => q.eq('projectId', projectId)).collect(),
    db.query('effects').withIndex('by_room', (q) => q.eq('projectId', projectId)).collect(),
  ])

  return currentAutomationRows(rows, effectParamsByInstanceId(effects))
}

/** For callers holding an untyped `ctx`: fixes the row type so the migrated rows keep their document fields. */
export const currentAutomationDocs = async (rows: Promise<Doc<'automationEnvelopes'>[]>, owners?: ReadonlyMap<string, JsonValue>) =>
  currentAutomationRows(await rows, owners)
