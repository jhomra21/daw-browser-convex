import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { externalProcessorSchema } from '@daw-browser/external-plugins'
import { createLocalProject, createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { createDefaultDrumRackParams, createDefaultGranularParams, createDefaultSamplerParams, normalizeTrackInstrumentParams } from '@daw-browser/shared'
import type { DrumRackPadSample, SamplerZone, TrackInstrumentParams } from '@daw-browser/shared'
import type { LocalProjectStoredValue } from '~/lib/local-project-db'
import {
  appendLocalExternalProcessor,
  deleteLocalExternalProcessor,
  listLocalExternalProcessors,
  mergeLocalExternalProcessorParameterOverride,
  mergeLocalExternalProcessorParameterOverrides,
  persistLocalExternalProcessorState,
  readLocalExternalProcessorState,
  setLocalExternalProcessor,
  setLocalExternalProcessorBypassed,
} from './external-plugins'
import { getLocalEffect, reorderLocalMixedEffects, restoreLocalTrackEffectChain, setLocalEffect, setLocalEffectInstance } from './local-effects'
import { readInstrumentParamsFromEffectRow } from './effect-row-instrument-params'
import { z } from 'zod'
import { sha256 } from '@noble/hashes/sha2.js'

const storedObjectSchema = z.record(z.string(), z.custom<LocalProjectStoredValue>())
const indexedStoredObjectSchema = z.object({ index: z.number() }).passthrough()
const identifiedStoredObjectSchema = z.object({ id: z.string() }).passthrough()

test('persists and restores normalized Sampler and Drum Rack instruments', async () => {
  const project = await createLocalProject(`Instrument persistence ${crypto.randomUUID()}`)
  const sample: DrumRackPadSample = {
    assetKey: 'sample:persist',
    url: 'local-asset:sample:persist',
    sourceKind: 'upload',
    source: { durationSec: 2, sampleRate: 48000, channelCount: 2 },
  }
  const sampler = normalizeTrackInstrumentParams({
    kind: 'sampler',
    instanceId: 'instrument:sampler:persist',
    params: { ...createDefaultSamplerParams(), zones: [{ id: 'zone:persist', sample }] },
  })
  const drumRack = normalizeTrackInstrumentParams({
    kind: 'drum-rack',
    instanceId: 'instrument:drum-rack:persist',
    params: { ...createDefaultDrumRackParams(), pads: [{ sample }] },
  })
  if (!sampler || !drumRack) throw new Error('Expected normalized instruments.')

  await setLocalEffect(project.id, 'track:sampler', 'instrument', sampler)
  await setLocalEffect(project.id, 'track:drum-rack', 'instrument', drumRack)
  expect((await getLocalEffect(project.id, 'track:sampler', 'instrument'))?.params).toEqual(sampler)
  expect((await getLocalEffect(project.id, 'track:drum-rack', 'instrument'))?.params).toEqual(drumRack)

  const legacyId = 'track:legacy-instrument'
  const legacyInstrument: TrackInstrumentParams = {
    kind: 'sampler',
    instanceId: 'instrument:sampler:legacy',
    params: {
      ...createDefaultSamplerParams(),
      zones: [{
        id: 'zone:legacy',
        sample: {
          assetKey: sample.assetKey,
          url: sample.url,
          name: undefined,
          sourceKind: 'upload',
          source: sample.source,
        },
        keyLow: 0,
        keyHigh: 127,
        velocityLow: 1,
        velocityHigh: 127,
        rootNote: 60,
        tuneCents: 0,
        gain: 1,
        pan: 0,
        roundRobinGroup: 0,
        roundRobinIndex: 0,
        playbackMode: 'one-shot',
        startSec: 0,
        endSec: 2,
        loopStartSec: undefined,
        loopEndSec: undefined,
        crossfadeSec: 0,
        chokeGroup: 0,
      }],
    },
  }
  const db = await openLocalProjectDb(project.id)
  const legacyRow = {
    id: `${legacyId}:instrument`,
    targetId: legacyId,
    effect: 'instrument',
    params: legacyInstrument,
    updatedAt: Date.now(),
  }
  await db.put('entities', createLocalProjectEntityRow('effect', legacyRow.id, legacyRow, legacyRow.updatedAt))
  expect((await getLocalEffect(project.id, legacyId, 'instrument'))?.params).toMatchObject({
    kind: 'sampler',
    instanceId: 'instrument:sampler:legacy',
    params: { zones: [{ id: 'zone:legacy', playbackMode: 'one-shot' }] },
  })

  await restoreLocalTrackEffectChain(project.id, 'track:sampler', {
    audioEffects: [],
    instrument: sampler,
  })
  await restoreLocalTrackEffectChain(project.id, 'track:drum-rack', {
    audioEffects: [],
    instrument: drumRack,
  })
  expect((await getLocalEffect(project.id, 'track:sampler', 'instrument'))?.params).toEqual(sampler)
  expect((await getLocalEffect(project.id, 'track:drum-rack', 'instrument'))?.params).toEqual(drumRack)
})

test('normalizes nested Granular zone metadata through save, reload, and restore', async () => {
  const project = await createLocalProject(`Granular persistence ${crypto.randomUUID()}`)
  const sample = {
    assetKey: 'sample:granular',
    url: 'local-asset:sample:granular',
    sourceKind: 'upload',
    source: { durationSec: 2, sampleRate: 48000, channelCount: 2 },
  }
  const granular = normalizeTrackInstrumentParams({
    kind: 'granular',
    instanceId: 'instrument:granular:persist',
    params: {
      ...createDefaultGranularParams(),
      zone: {
        id: 'zone:granular',
        sample,
        keyLow: 0,
        keyHigh: 127,
        velocityLow: 1,
        velocityHigh: 127,
        rootNote: 60,
        tuneCents: 0,
        gain: 1,
        pan: 0,
        roundRobinGroup: 0,
        roundRobinIndex: 0,
        playbackMode: 'one-shot',
        startSec: 0,
        crossfadeSec: 0,
        chokeGroup: 0,
      },
    },
  })
  if (!granular) throw new Error('Expected normalized Granular instrument.')

  if (granular.kind !== 'granular') throw new Error('Expected Granular instrument params.')
  const granularWithUndefined = structuredClone(granular)
  const zone = granularWithUndefined.params.zone
  if (zone) {
    zone.sample.name = undefined
    zone.endSec = undefined
    zone.loopStartSec = undefined
    zone.loopEndSec = undefined
  }
  const normalized = readInstrumentParamsFromEffectRow({
    effect: 'instrument',
    params: granularWithUndefined,
  })
  if (!normalized) throw new Error('Expected nested Granular zone normalization.')
  if (normalized.kind !== 'granular') throw new Error('Expected Granular instrument params.')
  const edited = { ...normalized, params: { ...normalized.params, grainSizeMs: 120 } }

  await setLocalEffect(project.id, 'track:granular', 'instrument', edited)
  expect((await getLocalEffect(project.id, 'track:granular', 'instrument'))?.params).toEqual(edited)
  await restoreLocalTrackEffectChain(project.id, 'track:granular', {
    audioEffects: [],
    instrument: edited,
  })
  expect((await getLocalEffect(project.id, 'track:granular', 'instrument'))?.params).toEqual(edited)
})

test('round-trips nested undefined instrument fields through edits and chain restore', async () => {
  const project = await createLocalProject(`Undefined instrument persistence ${crypto.randomUUID()}`)
  const sample: DrumRackPadSample = {
    assetKey: 'sample:undefined',
    url: 'local-asset:sample:undefined',
    sourceKind: 'upload',
    source: { durationSec: 2, sampleRate: 48000, channelCount: 2 },
  }
  const sampler: TrackInstrumentParams = {
    kind: 'sampler',
    instanceId: 'instrument:sampler:undefined',
    params: {
      ...createDefaultSamplerParams(),
      zones: [{
        id: 'zone:sampler',
        sample: { ...sample, name: undefined },
        keyLow: 0,
        keyHigh: 127,
        velocityLow: 1,
        velocityHigh: 127,
        rootNote: 60,
        tuneCents: 0,
        gain: 1,
        pan: 0,
        roundRobinGroup: 0,
        roundRobinIndex: 0,
        playbackMode: 'one-shot',
        startSec: 0,
        endSec: undefined,
        crossfadeSec: 0,
        chokeGroup: 0,
      }],
    },
  }
  const drumRack: TrackInstrumentParams = {
    kind: 'drum-rack',
    instanceId: 'instrument:drum-rack:undefined',
    params: {
      ...createDefaultDrumRackParams(),
      pads: [{ ...createDefaultDrumRackParams().pads[0], sample: { ...sample, name: undefined }, endSec: undefined }],
    },
  }
  const granularZone: SamplerZone = {
    id: 'zone:granular',
    sample: { ...sample, name: undefined },
    keyLow: 0,
    keyHigh: 127,
    velocityLow: 1,
    velocityHigh: 127,
    rootNote: 60,
    tuneCents: 0,
    gain: 1,
    pan: 0,
    roundRobinGroup: 0,
    roundRobinIndex: 0,
    playbackMode: 'one-shot',
    startSec: 0,
    endSec: undefined,
    crossfadeSec: 0,
    chokeGroup: 0,
  }
  const granular: TrackInstrumentParams = {
    kind: 'granular',
    instanceId: 'instrument:granular:undefined',
    params: {
      ...createDefaultGranularParams(),
      zone: granularZone,
    },
  }

  const instruments: Array<{ targetId: string; instrument: TrackInstrumentParams }> = [
    { targetId: 'track:sampler-undefined', instrument: sampler },
    { targetId: 'track:drum-rack-undefined', instrument: drumRack },
    { targetId: 'track:granular-undefined', instrument: granular },
  ]
  for (const { targetId, instrument } of instruments) {
    const normalized = readInstrumentParamsFromEffectRow({ effect: 'instrument', params: instrument })
    if (!normalized) throw new Error('Expected instrument normalization.')
    let edited: TrackInstrumentParams
    if (normalized.kind === 'granular') {
      edited = { ...normalized, params: { ...normalized.params, grainSizeMs: 140 } }
    } else if (normalized.kind === 'sampler') {
      edited = { ...normalized, params: { ...normalized.params, polyphony: 12 } }
    } else if (normalized.kind === 'drum-rack') {
      edited = { ...normalized, params: { ...normalized.params, pads: [...normalized.params.pads] } }
    } else {
      throw new Error('Unexpected instrument kind.')
    }
    await setLocalEffect(project.id, targetId, 'instrument', edited)
    const reloaded = await getLocalEffect(project.id, targetId, 'instrument')
    expect(reloaded?.params).toEqual(edited)
    await restoreLocalTrackEffectChain(project.id, targetId, {
      audioEffects: [],
      instrument: edited,
    })
    expect((await getLocalEffect(project.id, targetId, 'instrument'))?.params).toEqual(edited)
  }
})

const createProcessor = (instanceId: string) => externalProcessorSchema.parse({
  instanceId,
  targetId: 'track-1',
  index: 0,
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

const createLegacyProcessor = (instanceId: string, index: number) => {
  const processor = createProcessor(instanceId)
  const { index: _index, ...withoutIndex } = processor
  return {
    ...withoutIndex,
    chainIndex: index,
    state: {
      artifactId: '00000000-0000-4000-8000-000000000010',
      sha256: 'b'.repeat(64),
      byteLength: 64,
      artifactKind: 'plugin-state' as const,
      ownerId: 'owner-1',
      acl: 'owner' as const,
      bucket: 'local' as const,
      location: 'plugin-state/valhalla',
    },
    launchReference: {
      version: 1 as const,
      classId: 'class-1',
      vendorId: 'Vendor',
      architecture: 'arm64' as const,
      bundleFingerprint: 'c'.repeat(64),
      binaryFingerprint: 'a'.repeat(64),
      scannerCatalogVersion: 2,
    },
  }
}

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

test('persists VST state atomically and removes its artifact on processor deletion', async () => {
  const project = await createLocalProject(`VST persistence ${crypto.randomUUID()}`)
  const processor = await setLocalExternalProcessor(project.id, createProcessor(crypto.randomUUID()))
  const bytes = new Uint8Array([5, 8, 13])
  const hash = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

  const persisted = await persistLocalExternalProcessorState(project.id, processor.instanceId, { bytes, sha256: hash }, 'user-1')
  expect(persisted?.state).toMatchObject({ sha256: hash, byteLength: bytes.byteLength })
  expect(await readLocalExternalProcessorState(project.id, persisted ?? processor, 'user-1')).toEqual({ bytes, sha256: hash })

  const db = await openLocalProjectDb(project.id)
  expect(await db.get('externalPluginArtifacts', persisted?.state?.artifactId ?? '')).toBeDefined()
  await deleteLocalExternalProcessor(project.id, processor.instanceId)
  expect(await db.get('externalPluginArtifacts', persisted?.state?.artifactId ?? '')).toBeUndefined()
})

test('preserves a shared local artifact until its last processor is deleted', async () => {
  const project = await createLocalProject(`Shared VST state ${crypto.randomUUID()}`)
  const first = await setLocalExternalProcessor(project.id, createProcessor(crypto.randomUUID()))
  const second = await setLocalExternalProcessor(project.id, {
    ...createProcessor(crypto.randomUUID()),
    targetId: first.targetId,
  })
  const bytes = new Uint8Array([8, 13, 21])
  const hash = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const persisted = await persistLocalExternalProcessorState(project.id, first.instanceId, { bytes, sha256: hash })
  if (!persisted?.state) throw new Error('Expected shared VST state.')
  await setLocalExternalProcessor(project.id, { ...second, state: persisted.state })
  const db = await openLocalProjectDb(project.id)
  await deleteLocalExternalProcessor(project.id, first.instanceId)
  expect(await db.get('externalPluginArtifacts', persisted.state.artifactId)).toBeDefined()
  await deleteLocalExternalProcessor(project.id, second.instanceId)
  expect(await db.get('externalPluginArtifacts', persisted.state.artifactId)).toBeUndefined()
})

test('preserves persisted state ownership across auth transitions', async () => {
  const project = await createLocalProject(`Stable VST state owner ${crypto.randomUUID()}`)
  const processor = await setLocalExternalProcessor(project.id, createProcessor(crypto.randomUUID()))
  const firstBytes = new Uint8Array([1, 2, 3])
  const firstHash = Array.from(sha256(firstBytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const first = await persistLocalExternalProcessorState(
    project.id,
    processor.instanceId,
    { bytes: firstBytes, sha256: firstHash },
    'user-1',
  )
  if (!first) throw new Error('Expected first VST state persistence.')

  const nextBytes = new Uint8Array([4, 5, 6])
  const nextHash = Array.from(sha256(nextBytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const next = await persistLocalExternalProcessorState(
    project.id,
    processor.instanceId,
    { bytes: nextBytes, sha256: nextHash },
    'user-2',
  )

  expect(next?.state?.ownerId).toBe('user-1')
  await expect(readLocalExternalProcessorState(project.id, next ?? processor)).resolves.toEqual({
    bytes: nextBytes,
    sha256: nextHash,
  })
  await expect(readLocalExternalProcessorState(project.id, next ?? processor, 'user-2')).rejects.toThrow('owner mismatch')
})

test('uses the local project as stable VST state ownership when signed out', async () => {
  const project = await createLocalProject(`Signed-out VST persistence ${crypto.randomUUID()}`)
  const processor = await setLocalExternalProcessor(project.id, createProcessor(crypto.randomUUID()))
  const bytes = new Uint8Array([21, 34, 55])
  const hash = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

  const persisted = await persistLocalExternalProcessorState(
    project.id,
    processor.instanceId,
    { bytes, sha256: hash },
  )

  if (!persisted) throw new Error('Expected signed-out VST state to persist.')
  expect(persisted.state?.ownerId).toBe(project.id)
  await expect(readLocalExternalProcessorState(project.id, persisted, undefined)).resolves.toEqual({
    bytes,
    sha256: hash,
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

test('deleting an external effect compacts the remaining mixed chain', async () => {
  const project = await createLocalProject(`Delete mixed effect ${crypto.randomUUID()}`)
  const externalId = crypto.randomUUID()
  const builtinId = crypto.randomUUID()
  await setLocalExternalProcessor(project.id, { ...createProcessor(externalId), index: 0 })
  await setLocalEffectInstance(project.id, 'track-1', 'delay', {}, { instanceId: builtinId, index: 1 })

  await deleteLocalExternalProcessor(project.id, externalId)

  const db = await openLocalProjectDb(project.id)
  const rows = await db.getAll('entities')
  const builtin = rows.find((row) => {
    const parsed = storedObjectSchema.safeParse(row.value)
    return row.kind === 'effect' && parsed.success && parsed.data.instanceId === builtinId
  })
  expect(builtin?.value).toMatchObject({ index: 0 })
})

test('persists an exact mixed-chain permutation atomically and keeps instruments out of it', async () => {
  const project = await createLocalProject(`Mixed chain reorder ${crypto.randomUUID()}`)
  const firstId = crypto.randomUUID()
  const secondId = crypto.randomUUID()
  const externalId = crypto.randomUUID()
  const instrumentId = crypto.randomUUID()
  await setLocalEffectInstance(project.id, 'track-1', 'delay', {}, { instanceId: firstId, index: 0 })
  await setLocalExternalProcessor(project.id, { ...createProcessor(externalId), index: 1 })
  await setLocalEffectInstance(project.id, 'track-1', 'chorus', {}, { instanceId: secondId, index: 2 })
  const instrument = createProcessor(instrumentId)
  const savedInstrument = await setLocalExternalProcessor(project.id, {
    ...instrument,
    index: 9,
    manifest: { ...instrument.manifest, role: 'instrument', audioInputs: [] },
  })
  expect(savedInstrument.index).toBe(0)

  await reorderLocalMixedEffects(project.id, 'track-1', [
    { kind: 'builtin', instanceId: firstId },
    { kind: 'external', instanceId: externalId },
    { kind: 'builtin', instanceId: secondId },
  ])

  const db = await openLocalProjectDb(project.id)
  const rows = await db.getAll('entities')
  const indexFor = (id: string) => {
    const row = rows.find((entry) => entry.id.endsWith(id))
    const parsed = indexedStoredObjectSchema.safeParse(row?.value)
    return parsed.success ? parsed.data.index : undefined
  }
  expect(indexFor(firstId)).toBe(0)
  expect(indexFor(externalId)).toBe(1)
  expect(indexFor(secondId)).toBe(2)
  expect(indexFor(instrumentId)).toBe(0)
  const timestampsBeforeNoOp = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row.updatedAt]))
  await reorderLocalMixedEffects(project.id, 'track-1', [
    { kind: 'builtin', instanceId: firstId },
    { kind: 'external', instanceId: externalId },
    { kind: 'builtin', instanceId: secondId },
  ])
  const rowsAfterNoOp = await db.getAll('entities')
  expect(new Map(rowsAfterNoOp.map((row) => [`${row.kind}:${row.id}`, row.updatedAt])))
    .toEqual(timestampsBeforeNoOp)
  await expect(reorderLocalMixedEffects(project.id, 'track-1', [
    { kind: 'builtin', instanceId: firstId },
  ])).rejects.toThrow('every effect exactly once')
  expect(indexFor(firstId)).toBe(0)
  expect(indexFor(externalId)).toBe(1)
  expect(indexFor(secondId)).toBe(2)
})

test('preserves concurrent external overrides while atomically reordering the mixed chain', async () => {
  const operations = ['parameter', 'bypass', 'reorder'] as const
  const permutations = [
    operations,
    ['parameter', 'reorder', 'bypass'],
    ['bypass', 'parameter', 'reorder'],
    ['bypass', 'reorder', 'parameter'],
    ['reorder', 'parameter', 'bypass'],
    ['reorder', 'bypass', 'parameter'],
  ] as const

  for (const permutation of permutations) {
    const project = await createLocalProject(`Concurrent mixed reorder ${crypto.randomUUID()}`)
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    const externalId = crypto.randomUUID()
    await setLocalEffectInstance(project.id, 'track-1', 'delay', { marker: 'first' }, { instanceId: firstId, index: 0 })
    await setLocalExternalProcessor(project.id, { ...createProcessor(externalId), index: 1 })
    await setLocalEffectInstance(project.id, 'track-1', 'chorus', { marker: 'second' }, { instanceId: secondId, index: 2 })

    const actions = {
      parameter: () => mergeLocalExternalProcessorParameterOverride(project.id, externalId, 1, 0.875),
      bypass: () => setLocalExternalProcessorBypassed(project.id, externalId, true),
      reorder: () => reorderLocalMixedEffects(project.id, 'track-1', [
        { kind: 'external', instanceId: externalId },
        { kind: 'builtin', instanceId: firstId },
        { kind: 'builtin', instanceId: secondId },
      ]),
    }
    await Promise.all(permutation.map((operation) => actions[operation]()))

    const db = await openLocalProjectDb(project.id)
    const externalRow = await db.get('entities', ['external-plugin', `external-plugin:${externalId}`])
    expect(externalRow?.value).toMatchObject({
      index: 0,
      parameterOverrides: { '1': 0.875, '9': 0.75 },
      bypassed: true,
    })
    expect(externalRow?.value).toHaveProperty('health.state', 'ready')
    const rows = await db.getAll('entities')
    const indexFor = (id: string) => {
      const row = rows.find((entry) => entry.id.endsWith(id))
      const parsed = indexedStoredObjectSchema.safeParse(row?.value)
      return parsed.success ? parsed.data.index : undefined
    }
    expect(indexFor(firstId)).toBe(1)
    expect(indexFor(secondId)).toBe(2)
  }
})

test('lists captured chainIndex rows and transactionally self-heals them during append', async () => {
  const project = await createLocalProject(`Legacy VST migration ${crypto.randomUUID()}`)
  const legacyId = crypto.randomUUID()
  const builtinId = crypto.randomUUID()
  const newId = crypto.randomUUID()
  const db = await openLocalProjectDb(project.id)
  const track = (await db.getAll('entities')).find((row) => row.kind === 'track')
  if (!track) throw new Error('Expected the project track.')
  const parsedTrack = identifiedStoredObjectSchema.safeParse(track.value)
  if (!parsedTrack.success) {
    throw new Error('Expected a valid project track.')
  }
  const targetId = parsedTrack.data.id
  await db.put('entities', createLocalProjectEntityRow(
    'external-plugin',
    `external-plugin:${legacyId}`,
    { ...createLegacyProcessor(legacyId, 0), targetId },
    1,
  ))

  const listed = await listLocalExternalProcessors(project.id)
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({
    instanceId: legacyId,
    index: 0,
    state: { artifactKind: 'plugin-state' },
    launchReference: { classId: 'class-1', scannerCatalogVersion: 2 },
  })

  await setLocalEffectInstance(project.id, targetId, 'delay', {}, { instanceId: builtinId, index: 1 })
  const { index: _index, ...appendInput } = { ...createProcessor(newId), targetId }
  const appended = await appendLocalExternalProcessor(project.id, appendInput)
  expect(appended.index).toBe(2)

  const rows = await db.getAll('entities')
  const externalRows = rows.filter((row) => row.kind === 'external-plugin')
  expect(externalRows).toHaveLength(2)
  expect(externalRows.map((row) => {
    const parsed = storedObjectSchema.safeParse(row.value)
    return parsed.success ? parsed.data.index : undefined
  }).sort()).toEqual([0, 2])
  expect(rows.filter((row) => row.kind === 'effect' || row.kind === 'external-plugin').map((row) => {
    const parsed = storedObjectSchema.safeParse(row.value)
    return parsed.success ? parsed.data.index : undefined
  }).sort()).toEqual([0, 1, 2])
  expect(externalRows.every((row) => {
    const parsed = storedObjectSchema.safeParse(row.value)
    return parsed.success && !Object.hasOwn(parsed.data, 'chainIndex')
  })).toBeTrue()
  expect(externalRows.find((row) => row.id.endsWith(legacyId))?.value).toMatchObject({
    index: 0,
    state: { location: 'plugin-state/valhalla' },
    launchReference: { bundleFingerprint: 'c'.repeat(64) },
  })
})

test('rejects genuinely invalid external rows instead of migrating them', async () => {
  const project = await createLocalProject(`Invalid VST row ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('entities', createLocalProjectEntityRow(
    'external-plugin',
    'external-plugin:invalid',
    { instanceId: 'not-a-uuid', chainIndex: 0 },
    1,
  ))

  await expect(listLocalExternalProcessors(project.id)).rejects.toThrow('incompatible or corrupt')
})

test('reorder and delete paths repair legacy rows before compacting the chain', async () => {
  const project = await createLocalProject(`Legacy VST reorder ${crypto.randomUUID()}`)
  const legacyId = crypto.randomUUID()
  const builtinId = crypto.randomUUID()
  const db = await openLocalProjectDb(project.id)
  await db.put('entities', createLocalProjectEntityRow(
    'external-plugin',
    `external-plugin:${legacyId}`,
    createLegacyProcessor(legacyId, 0),
    1,
  ))
  await setLocalEffectInstance(project.id, 'track-1', 'delay', {}, { instanceId: builtinId, index: 1 })

  await reorderLocalMixedEffects(project.id, 'track-1', [
    { kind: 'external', instanceId: legacyId },
    { kind: 'builtin', instanceId: builtinId },
  ])
  const repaired = await db.get('entities', ['external-plugin', `external-plugin:${legacyId}`])
  expect(repaired?.value).toMatchObject({ index: 0 })
  const repairedValue = storedObjectSchema.safeParse(repaired?.value)
  if (!repairedValue.success) {
    throw new Error('Expected repaired external processor row.')
  }
  expect(Object.hasOwn(repairedValue.data, 'chainIndex')).toBeFalse()

  await deleteLocalExternalProcessor(project.id, legacyId)
  const remaining = await db.get('entities', ['effect', `track-1:effect:${builtinId}`])
  expect(remaining?.value).toMatchObject({ index: 0 })
})