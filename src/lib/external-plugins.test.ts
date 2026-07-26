import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { externalProcessorSchema } from '@daw-browser/external-plugins'
import { createLocalProject, createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { appendLocalExternalProcessor, listLocalExternalProcessors, setLocalExternalProcessor } from '~/lib/external-plugins'
import { buildProjectManifest } from '~/lib/project-manifest'
import { buildTimelineTrackRow } from '~/lib/timeline-repository/track-row-builder'

test('reports malformed persisted external plugin rows instead of silently omitting them', async () => {
  const project = await createLocalProject(`External plugin corruption ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('entities', createLocalProjectEntityRow(
    'external-plugin',
    'external-plugin:corrupt',
    { instanceId: 'not-a-uuid' },
    1,
  ))

  await expect(listLocalExternalProcessors(project.id)).rejects.toThrow(
    'External plugin row "external-plugin:corrupt" is incompatible or corrupt',
  )
})

test('keeps a local discovery path readable while excluding it from project manifests', async () => {
  const project = await createLocalProject(`External plugin archive ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  const value = {
    instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
    targetId: 'track-1',
    chainIndex: 0,
    manifest: {
      identity: {
        format: 'vst3',
        classId: 'class-1',
        vendor: 'Vendor',
        name: 'Example',
        version: '1',
        architecture: 'arm64',
        discoveredPath: '/Users/me/Library/Audio/Plug-Ins/VST3/Example.vst3',
        binaryFingerprint: 'a'.repeat(64),
      },
      role: 'effect',
      audioInputs: [],
      audioOutputs: [{ name: 'Out', channels: 2, enabled: true }],
      sidechainInputs: [],
      parameters: [],
      latencyFrames: 0,
      tailFrames: 0,
      supportsBypass: true,
      supportsEditor: false,
      supportsState: false,
    },
    parameterOverrides: {},
    latencyFrames: 0,
    tailFrames: 0,
    bypassed: true,
    health: { state: 'degraded', reason: 'Not available in browser.', updatedAt: 1 },
    updatedAt: 1,
  }
  await db.put('entities', createLocalProjectEntityRow('external-plugin', 'external-plugin:archive-safe', value, 1))

  expect((await listLocalExternalProcessors(project.id))[0]?.manifest.identity.discoveredPath).toContain('Example.vst3')
  const manifest = await buildProjectManifest(project.id)
  expect(JSON.stringify(manifest)).not.toContain('discoveredPath')
  expect(JSON.stringify(manifest)).not.toContain('/Users/me/')
})

const processor = (instanceId: string, targetId = 'track-1') => externalProcessorSchema.parse({
  instanceId,
  targetId,
  chainIndex: 0,
  manifest: {
    identity: {
      format: 'vst3',
      classId: 'class-1',
      vendor: 'Vendor',
      name: 'Example',
      version: '1',
      architecture: 'arm64',
      discoveredPath: '/Users/me/Library/Audio/Plug-Ins/VST3/Example.vst3',
      binaryFingerprint: 'a'.repeat(64),
    },
    role: 'effect',
    audioInputs: [{ name: 'Input', channels: 2, enabled: true }],
    audioOutputs: [{ name: 'Output', channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: false,
    supportsEditor: false,
    supportsState: false,
  },
  parameterOverrides: {},
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: true,
  health: { state: 'degraded', reason: 'Native activation is gated.', updatedAt: 1 },
  updatedAt: 1,
})

test('removes native discovery paths before local persistence', async () => {
  const project = await createLocalProject(`External plugin path-free ${crypto.randomUUID()}`)
  const stored = await setLocalExternalProcessor(project.id, processor(crypto.randomUUID()))

  expect(stored.manifest.identity.discoveredPath).toBeUndefined()
  expect(JSON.stringify((await listLocalExternalProcessors(project.id))[0])).not.toContain('/Users/me/')
})

test('appends external processors in deterministic target chain order', async () => {
  const project = await createLocalProject(`External plugin chain ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  const track = buildTimelineTrackRow({ id: 'track-1', index: 0, timestamp: 1 })
  await db.put('entities', createLocalProjectEntityRow('track', track.id, track, 1))
  const first = processor(crypto.randomUUID())
  const second = processor(crypto.randomUUID())

  const insertedFirst = await appendLocalExternalProcessor(project.id, (({ chainIndex: _chainIndex, ...value }) => value)(first))
  const insertedSecond = await appendLocalExternalProcessor(project.id, (({ chainIndex: _chainIndex, ...value }) => value)(second))

  expect([insertedFirst.chainIndex, insertedSecond.chainIndex]).toEqual([0, 1])
})

test('rejects external processor insertion when the target track disappeared', async () => {
  const project = await createLocalProject(`External plugin missing target ${crypto.randomUUID()}`)
  const value = processor(crypto.randomUUID())

  await expect(appendLocalExternalProcessor(
    project.id,
    (({ chainIndex: _chainIndex, ...processorValue }) => processorValue)(value),
  )).rejects.toThrow('target track was not found')
  expect(await listLocalExternalProcessors(project.id)).toEqual([])
})
