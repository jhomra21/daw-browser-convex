import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS, AUDIO_EFFECT_KINDS, AUDIO_EFFECT_PARAMS_VERSION, isJsonObject, type AudioEffectParamsVersioning, type JsonValue } from '@daw-browser/shared'
import { captureLocalExportRenderRowsSnapshot } from '~/lib/export/capture-local-export-render-rows'
import { createLocalProject, createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { EFFECT_ROW_KIND } from '~/lib/local-project-rows'
import { currentLocalEffectRows, currentLocalEffectValue, getLocalEffect, listLocalEffects, localEffectRowId, setLocalEffect, setLocalEffectInstance } from './local-effects'

// Test-only chain: eq is pretended to be at version 3 with a rename step then an added field.
const exampleVersioning: AudioEffectParamsVersioning = {
  current: { ...AUDIO_EFFECT_PARAMS_VERSION, eq: 3 },
  migrations: {
    eq: {
      1: (params) => isJsonObject(params) ? { renamed: params.oldName } : params,
      2: (params) => isJsonObject(params) ? { ...params, current: true } : params,
    },
  },
}

type StoredRow = { id: string; targetId: string; effect: string; instanceId: string; params: JsonValue; updatedAt: number; paramsVersion?: number }

const storedRow = (params: JsonValue, paramsVersion?: number): StoredRow => {
  const row: StoredRow = { id: 'track-1:effect:eq-1', targetId: 'track-1', effect: 'eq', instanceId: 'eq-1', params, updatedAt: 1 }

  if (paramsVersion !== undefined) row.paramsVersion = paramsVersion

  return row
}

const rawEffectRows = async (projectId: string) => (await (await openLocalProjectDb(projectId)).getAllFromIndex('entities', 'by-kind', EFFECT_ROW_KIND))

test('runs a stored row through the migration chain and drops the storage field', () => {
  const migrated = currentLocalEffectValue(JSON.parse(JSON.stringify(storedRow({ oldName: 0.5 }, 1))), exampleVersioning)

  expect(migrated).toMatchObject({ id: 'track-1:effect:eq-1', params: { renamed: 0.5, current: true } })
  expect(migrated).not.toHaveProperty('paramsVersion')
})

test('treats a row without paramsVersion as version 1', async () => {
  const project = await createLocalProject(`Absent version ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('entities', createLocalProjectEntityRow(EFFECT_ROW_KIND, 'track-1:effect:eq-1', storedRow({ oldName: 0.5 }), 1))

  expect(currentLocalEffectRows(await rawEffectRows(project.id), exampleVersioning)[0]?.params).toEqual({ renamed: 0.5, current: true })
})

test('returns a newer stored version unchanged instead of dropping the effect', async () => {
  const project = await createLocalProject(`Future version ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  const params = { fromTheFuture: true }
  await db.put('entities', createLocalProjectEntityRow(EFFECT_ROW_KIND, 'track-1:effect:eq-1', storedRow(params, 99), 1))

  const listed = await listLocalEffects(project.id)

  expect(listed).toHaveLength(1)
  expect(listed[0]?.params).toEqual(params)
  expect((await captureLocalExportRenderRowsSnapshot(project.id)).effects[0]?.params).toEqual(params)
})

test('stamps every kind on write and reads the same params back', async () => {
  const project = await createLocalProject(`Round trip ${crypto.randomUUID()}`)

  for (const kind of AUDIO_EFFECT_KINDS) {
    const params = AUDIO_EFFECT_CONTRACTS[kind].createDefaultParams()
    await setLocalEffect(project.id, 'track-single', kind, params)
    await setLocalEffectInstance(project.id, 'track-many', `master-${kind}`, params, { instanceId: `${kind}-1` })

    expect((await getLocalEffect(project.id, 'track-single', kind))?.params).toEqual(params)
    expect(await getLocalEffect(project.id, 'track-single', kind)).not.toHaveProperty('paramsVersion')
  }

  const raw = await rawEffectRows(project.id)

  expect(raw).toHaveLength(AUDIO_EFFECT_KINDS.length * 2)

  for (const row of raw) {
    const kind = AUDIO_EFFECT_KINDS.find((candidate) => row.id.endsWith(`:${candidate}`) || row.id.endsWith(`:${candidate}-1`))

    expect(kind).toBeDefined()
    expect(row.value).toMatchObject({ paramsVersion: AUDIO_EFFECT_PARAMS_VERSION[kind ?? 'eq'] })
  }

  const listed = await listLocalEffects(project.id)

  expect(listed).toHaveLength(AUDIO_EFFECT_KINDS.length * 2)
  expect(listed.every((row) => !('paramsVersion' in row))).toBe(true)
  expect(localEffectRowId('track-many', 'master-eq', 'eq-1')).toBe('track-many:effect:eq-1')
})
