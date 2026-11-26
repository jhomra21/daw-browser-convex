import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS, AUDIO_EFFECT_PARAMS_VERSION, AUTO_FILTER_MAX_Q, AUTO_FILTER_MIN_Q, automationTargetKey, type AutomationEnvelope, type AutomationTarget } from '@daw-browser/shared'
import { captureLocalExportRenderRowsSnapshot } from '~/lib/export/capture-local-export-render-rows'
import { createLocalProject, createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { AUTOMATION_ROW_KIND, EFFECT_ROW_KIND } from '~/lib/local-project-rows'
import { loadLocalAutomationEnvelopes, setLocalAutomationEnvelope } from './local-automation'

const qOf = (resonance: number) => AUTO_FILTER_MIN_Q * (AUTO_FILTER_MAX_Q / AUTO_FILTER_MIN_Q) ** resonance

const filterTarget: AutomationTarget = { kind: 'track', trackId: 'track-1', effectInstanceId: 'autofilter-1' }
const mixerTarget: AutomationTarget = { kind: 'track', trackId: 'track-1' }

const lane = (projectId: string, target: AutomationTarget, parameterId: string, value: number): AutomationEnvelope => ({
  id: automationTargetKey(target, parameterId),
  projectId,
  target,
  targetKey: automationTargetKey(target, parameterId),
  parameterId,
  enabled: true,
  points: [{ id: 'p0', timeSec: 0, value, interpolation: 'linear' }],
  updatedAt: 1,
})

const putRaw = async (projectId: string, envelope: AutomationEnvelope, valuesVersion?: number) => {
  const db = await openLocalProjectDb(projectId)
  await db.put('entities', createLocalProjectEntityRow(AUTOMATION_ROW_KIND, envelope.targetKey, valuesVersion === undefined ? envelope : { ...envelope, valuesVersion }, 1))
}

const rawRows = async (projectId: string) => (await openLocalProjectDb(projectId)).getAllFromIndex('entities', 'by-kind', AUTOMATION_ROW_KIND)

test('an unversioned resonance lane reads back migrated by load and export capture, and the stamp is not exposed', async () => {
  const project = await createLocalProject(`Old lane ${crypto.randomUUID()}`)
  await putRaw(project.id, lane(project.id, filterTarget, 'autofilter.resonance', 0.25))

  const [loaded] = await loadLocalAutomationEnvelopes(project.id)
  const [captured] = (await captureLocalExportRenderRowsSnapshot(project.id)).automationEnvelopes

  expect(qOf(loaded?.points[0]?.value ?? -1)).toBeCloseTo(0.5 + 19.5 * 0.25, 6)
  expect(captured?.points[0]?.value).toBe(loaded?.points[0]?.value)
  expect(loaded).not.toHaveProperty('valuesVersion')
})

test('a version 1 Spectral threshold lane reads back at its own effect threshold at 512 and 4096 (load and export capture)', async () => {
  for (const fftSize of [512, 4096]) {
    const project = await createLocalProject(`Spectral lane ${fftSize} ${crypto.randomUUID()}`)
    const params = { fftSize, gateThresholdDb: -20 }
    const target: AutomationTarget = { kind: 'track', trackId: 'track-1', effectInstanceId: 'spectral-1' }
    const db = await openLocalProjectDb(project.id)
    await db.put('entities', createLocalProjectEntityRow(EFFECT_ROW_KIND, 'track-1:effect:spectral-1', {
      id: 'track-1:effect:spectral-1', targetId: 'track-1', effect: 'spectral', instanceId: 'spectral-1', params, updatedAt: 1,
    }, 1))
    await putRaw(project.id, lane(project.id, target, 'spectral.gateThresholdDb', -20), 1)

    const [loaded] = await loadLocalAutomationEnvelopes(project.id)
    const captured = await captureLocalExportRenderRowsSnapshot(project.id)
    const own = AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(captured.effects[0]?.params).state.gateThresholdDb
    const asAt2048 = -20 - 20 * Math.log10(1 / Math.tan(Math.PI / 4096) / 2)

    expect(loaded?.points[0]?.value).toBeCloseTo(own, 9)
    expect(captured.automationEnvelopes[0]?.points[0]?.value).toBeCloseTo(own, 9)
    expect(Math.abs(own - asAt2048)).toBeGreaterThan(5)
  }
})

test('a current lane and a mixer lane are unchanged', async () => {
  const project = await createLocalProject(`Current lane ${crypto.randomUUID()}`)
  await putRaw(project.id, lane(project.id, filterTarget, 'autofilter.resonance', 0.25), AUDIO_EFFECT_PARAMS_VERSION.autofilter)
  await putRaw(project.id, lane(project.id, mixerTarget, 'volume', 0.25))

  const loaded = await loadLocalAutomationEnvelopes(project.id)

  expect(loaded.map((envelope) => envelope.points[0]?.value).sort()).toEqual([0.25, 0.25])
})

test('writes stamp effect lanes only, and the lane reads back as written', async () => {
  const project = await createLocalProject(`Round trip ${crypto.randomUUID()}`)
  await setLocalAutomationEnvelope(project.id, lane(project.id, filterTarget, 'autofilter.resonance', 0.6))
  await setLocalAutomationEnvelope(project.id, lane(project.id, mixerTarget, 'volume', 0.6))

  const raw = await rawRows(project.id)
  const byParameter = (parameterId: string) => raw.find((row) => row.id.includes(parameterId))?.value

  expect(byParameter('autofilter.resonance')).toMatchObject({ valuesVersion: AUDIO_EFFECT_PARAMS_VERSION.autofilter })
  expect(byParameter('volume')).not.toHaveProperty('valuesVersion')
  expect((await loadLocalAutomationEnvelopes(project.id)).map((envelope) => envelope.points[0]?.value)).toEqual([0.6, 0.6])
})

test('a lane from a newer build is returned as stored', async () => {
  const project = await createLocalProject(`Future lane ${crypto.randomUUID()}`)
  await putRaw(project.id, lane(project.id, filterTarget, 'autofilter.resonance', 0.25), 99)

  expect((await loadLocalAutomationEnvelopes(project.id))[0]?.points[0]?.value).toBe(0.25)
})
