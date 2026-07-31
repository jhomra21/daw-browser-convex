import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { externalProcessorSchema } from '@daw-browser/external-plugins'
import { createLocalProject, openLocalProjectDb } from '~/lib/local-project-db'
import {
  deleteLocalExternalProcessor,
  mergeLocalExternalProcessorParameterOverride,
  mergeLocalExternalProcessorParameterOverrides,
  setLocalExternalProcessor,
  setLocalExternalProcessorBypassed,
} from './external-plugins'

const createProcessor = (instanceId: string) => externalProcessorSchema.parse({
  instanceId,
  targetId: 'track-1',
  chainIndex: 0,
  manifest: {
    identity: {
      format: 'vst3',
      classId: 'class-1',
      vendor: 'Vendor',
      name: 'Fixture',
      version: '1',
      architecture: 'arm64',
      discoveredPath: '/local/Fixture.vst3',
      binaryFingerprint: 'a'.repeat(64),
    },
    role: 'effect',
    audioInputs: [{ name: 'Input', channels: 2, enabled: true }],
    audioOutputs: [{ name: 'Output', channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [
      {
        id: 1,
        title: 'Gain',
        unit: '',
        minimum: 0,
        maximum: 1,
        defaultValue: 0.5,
        stepCount: 100,
        readOnly: false,
        hidden: false,
      },
      {
        id: 2,
        title: 'Read only',
        unit: '',
        minimum: 0,
        maximum: 1,
        defaultValue: 0,
        stepCount: 1,
        readOnly: true,
        hidden: false,
      },
      {
        id: 0xffff_ffff,
        title: 'High-bit',
        unit: '',
        minimum: 0,
        maximum: 1,
        defaultValue: 0,
        stepCount: 1,
        readOnly: false,
        hidden: false,
      },
    ],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: true,
    supportsEditor: true,
    supportsState: true,
  },
  parameterOverrides: { '1': 0.25, '9': 0.75, '4294967295': 0.1 },
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  health: { state: 'ready', updatedAt: 1 },
  updatedAt: 1,
})

test('atomically merges a VST parameter override and strips discovery paths', async () => {
  const project = await createLocalProject(`Parameter feedback ${crypto.randomUUID()}`)
  const instanceId = crypto.randomUUID()
  await setLocalExternalProcessor(project.id, createProcessor(instanceId))

  const updated = await mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 1, 0.875)
  expect(updated?.current).toMatchObject({
    parameterOverrides: { '1': 0.875, '9': 0.75 },
  })
  expect(updated?.current.manifest.identity).not.toHaveProperty('discoveredPath')
  const db = await openLocalProjectDb(project.id)
  const row = await db.get('entities', ['external-plugin', `external-plugin:${instanceId}`])
  expect(row?.value).toMatchObject({
    parameterOverrides: { '1': 0.875, '9': 0.75 },
  })
  expect(row?.value).not.toHaveProperty('manifest.identity.discoveredPath')
})

test('round trips high-bit IDs and atomically merges multiple parameter overrides', async () => {
  const project = await createLocalProject(`High-bit parameter feedback ${crypto.randomUUID()}`)
  const instanceId = crypto.randomUUID()
  await setLocalExternalProcessor(project.id, createProcessor(instanceId))
  const updated = await mergeLocalExternalProcessorParameterOverrides(project.id, instanceId, [
    { parameterId: 1, normalizedValue: 0.2 },
    { parameterId: 0xffff_ffff, normalizedValue: 0.9 },
  ])
  expect(updated?.current.parameterOverrides).toMatchObject({
    '1': 0.2,
    '4294967295': 0.9,
  })
  expect(() => mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 0x1_0000_0000, 0.5)).not.toThrow()
  expect(await mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 0x1_0000_0000, 0.5)).toBeUndefined()
})

test('serializes concurrent writes to the same VST parameter', async () => {
  const project = await createLocalProject(`Concurrent parameter feedback ${crypto.randomUUID()}`)
  const instanceId = crypto.randomUUID()
  await setLocalExternalProcessor(project.id, createProcessor(instanceId))

  await Promise.all([
    mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 1, 0.375),
    mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 1, 0.875),
  ])

  const db = await openLocalProjectDb(project.id)
  const row = await db.get('entities', ['external-plugin', `external-plugin:${instanceId}`])
  expect(row?.value).toMatchObject({
    parameterOverrides: { '1': 0.875, '9': 0.75 },
  })
})

test('ignores unknown and read-only VST parameters', async () => {
  const project = await createLocalProject(`Ignored parameter feedback ${crypto.randomUUID()}`)
  const instanceId = crypto.randomUUID()
  await setLocalExternalProcessor(project.id, createProcessor(instanceId))

  await expect(mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 99, 0.5)).resolves.toBeUndefined()
  await expect(mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 2, 0.5)).resolves.toBeUndefined()
})

test('preserves concurrent parameter and bypass patches from the latest committed row', async () => {
  const project = await createLocalProject(`Concurrent parameter and bypass ${crypto.randomUUID()}`)
  const instanceId = crypto.randomUUID()
  await setLocalExternalProcessor(project.id, createProcessor(instanceId))

  const [{ current: parameter }, { current: bypassed }] = await Promise.all([
    mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 1, 0.875).then((commit) => {
      if (!commit) throw new Error('Expected parameter commit')
      return commit
    }),
    setLocalExternalProcessorBypassed(project.id, instanceId, true).then((commit) => {
      if (!commit) throw new Error('Expected bypass commit')
      return commit
    }),
  ])

  expect(parameter.parameterOverrides['1']).toBe(0.875)
  expect(bypassed.bypassed).toBeTrue()
  const db = await openLocalProjectDb(project.id)
  const row = await db.get('entities', ['external-plugin', `external-plugin:${instanceId}`])
  expect(row?.value).toMatchObject({
    parameterOverrides: { '1': 0.875, '9': 0.75 },
    bypassed: true,
  })
})

test('does not recreate a deleted external processor during an interactive patch', async () => {
  const project = await createLocalProject(`Deleted interactive patch ${crypto.randomUUID()}`)
  const instanceId = crypto.randomUUID()
  await setLocalExternalProcessor(project.id, createProcessor(instanceId))
  await deleteLocalExternalProcessor(project.id, instanceId)

  await expect(mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 1, 0.5)).resolves.toBeUndefined()
  await expect(setLocalExternalProcessorBypassed(project.id, instanceId, true)).resolves.toBeUndefined()
  const db = await openLocalProjectDb(project.id)
  await expect(db.get('entities', ['external-plugin', `external-plugin:${instanceId}`])).resolves.toBeUndefined()
})