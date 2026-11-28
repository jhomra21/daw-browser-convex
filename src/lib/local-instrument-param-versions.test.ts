import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { INSTRUMENT_CONTRACTS, INSTRUMENT_KINDS, INSTRUMENT_PARAMS_VERSION, createDefaultArpeggiatorParams, normalizeSynthParams, type JsonValue } from '@daw-browser/shared'
import { captureLocalExportRenderRowsSnapshot } from '~/lib/export/capture-local-export-render-rows'
import { createLocalProject, createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { EFFECT_ROW_KIND } from '~/lib/local-project-rows'
import { getLocalEffect, listLocalEffects, localEffectRowId, setLocalEffect } from './local-effects'

const legacySynth = { wave1: 'square', wave2: 'sine', gain: 0.5, attackMs: 40, releaseMs: 300 }

const storedRow = (effect: 'synth' | 'instrument', params: JsonValue) => ({
  id: localEffectRowId('track-1', effect),
  targetId: 'track-1',
  effect,
  params,
  updatedAt: 1,
})

const rawEffectRows = async (projectId: string) => await (await openLocalProjectDb(projectId)).getAllFromIndex('entities', 'by-kind', EFFECT_ROW_KIND)

test('loads an unversioned legacy synth stored in an instrument row as the v2 shape', async () => {
  const project = await createLocalProject(`Legacy instrument ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  const row = storedRow('instrument', { kind: 'synth', instanceId: 'i-1', params: legacySynth })
  await db.put('entities', createLocalProjectEntityRow(EFFECT_ROW_KIND, row.id, row, 1))

  const synth = normalizeSynthParams(legacySynth)

  expect((await getLocalEffect(project.id, 'track-1', 'instrument'))?.params).toEqual({ kind: 'synth', instanceId: 'i-1', params: synth })
  expect((await listLocalEffects(project.id))[0]?.params).toMatchObject({ kind: 'synth', params: synth })
  expect((await captureLocalExportRenderRowsSnapshot(project.id)).effects[0]?.params).toMatchObject({ kind: 'synth', params: synth })
})

test('loads an unversioned legacy synth row as the instrument it migrates to', async () => {
  const project = await createLocalProject(`Legacy synth ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  const row = storedRow('synth', legacySynth)
  await db.put('entities', createLocalProjectEntityRow(EFFECT_ROW_KIND, row.id, row, 1))

  const instrument = await getLocalEffect(project.id, 'track-1', 'instrument')

  expect(instrument?.params.kind).toBe('synth')
  expect(instrument?.params.params).toEqual(normalizeSynthParams(legacySynth))
})

test('stamps every instrument kind and the arpeggiator on write and reads the same params back', async () => {
  const project = await createLocalProject(`Round trip ${crypto.randomUUID()}`)

  for (const kind of INSTRUMENT_KINDS) {
    const instrument = { kind, instanceId: `i-${kind}`, params: INSTRUMENT_CONTRACTS[kind].createDefaultParams() }
    await setLocalEffect(project.id, 'track-1', 'instrument', instrument)

    const raw = await rawEffectRows(project.id)

    expect(raw).toHaveLength(1)
    expect(raw[0]?.value).toMatchObject({ paramsVersion: INSTRUMENT_PARAMS_VERSION[kind] })
    expect((await getLocalEffect(project.id, 'track-1', 'instrument'))?.params.params).toEqual(instrument.params)
  }

  await setLocalEffect(project.id, 'track-1', 'arp', createDefaultArpeggiatorParams())

  const arp = (await rawEffectRows(project.id)).find((row) => row.id === localEffectRowId('track-1', 'arp'))

  expect(arp?.value).toMatchObject({ paramsVersion: INSTRUMENT_PARAMS_VERSION.arpeggiator })
  expect((await listLocalEffects(project.id)).every((row) => !('paramsVersion' in row))).toBe(true)
  expect((await getLocalEffect(project.id, 'track-1', 'arp'))?.params).toEqual(createDefaultArpeggiatorParams())
})
