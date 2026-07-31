import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import {
  canonicalCapturedRecoveryPayloadV2,
  controlCapabilitiesV1,
  hashRecoveryPayloadSyncV1,
  localControlCapabilitiesV1,
  parseCapturedRecoveryPayload,
  parseRecoveryPayload,
  type ControlActionV1,
} from '@daw-browser/control'

import {
  createLocalProject,
  createLocalProjectEntityRow,
  openLocalProjectDb,
} from '~/lib/local-project-db'
import { setLocalExternalProcessor } from '~/lib/external-plugins'
import { projectLocalControlSnapshotV1, projectLocalControlSnapshotV2 } from './local-control-projector'
import { executeLocalControlRequestV1 } from './local-control-execution'
import { withLocalControlTransaction } from './local-control-state'

const snapshot = (projectId: string) => withLocalControlTransaction(projectId, 'readonly', (context) => (
  projectLocalControlSnapshotV1({
    projectId,
    fallbackMetadata: {
      version: 1,
      name: 'Fallback',
      updatedAt: 0,
      timeSignature: { numerator: 4, denominator: 4 },
    },
    entities: context.rows.entities,
    assets: context.rows.assets,
    projectState: context.rows.projectState,
    revision: context.state.revision,
  })
))

const snapshotV2 = (projectId: string) => withLocalControlTransaction(projectId, 'readonly', (context) => (
  projectLocalControlSnapshotV2({
    projectId,
    fallbackMetadata: {
      version: 1,
      name: 'Fallback',
      updatedAt: 0,
      timeSignature: { numerator: 4, denominator: 4 },
    },
    entities: context.rows.entities,
    assets: context.rows.assets,
    projectState: context.rows.projectState,
    revision: context.state.revision,
  })
))

test('executes sequential client references and persists the canonical result', async () => {
  const project = await createLocalProject(`Execution ${crypto.randomUUID()}`)
  const result = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'track.create', clientRef: 'instrument', trackKind: 'instrument' },
      {
        kind: 'clip.midi.create',
        clientRef: 'clip',
        track: { source: 'client', clientRef: 'instrument' },
        startSec: 0,
        duration: 1,
        wave: 'sine',
        notes: [],
      },
      { kind: 'clip.delete', clip: { source: 'client', clientRef: 'clip' } },
    ],
  })
  expect(result.changed).toBe(true)
  expect(result.resolvedRefs.map((entry) => entry.clientRef)).toEqual(['instrument'])
  const current = await snapshot(project.id)
  expect(current.tracks).toHaveLength(2)
  expect(current.clips).toEqual([])
  const recovery = result.recoveries[0]
  expect(recovery?.kind).toBe('clip.delete')
  if (!recovery) throw new Error('Expected clip recovery.')
  const restored = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{ kind: 'recovery.restore', recovery: { id: recovery.id } }],
  })
  expect(restored.restored[0]?.entities[0]?.entity).toBe('clip')
  expect((await snapshot(project.id)).clips).toHaveLength(1)
})

test('plans and executes legacy MIDI no-ops without dropping expanded local data', async () => {
  const project = await createLocalProject(`Expanded MIDI ${crypto.randomUUID()}`)
  const created = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'track.create', clientRef: 'instrument', trackKind: 'instrument' },
      {
        kind: 'clip.midi.create',
        clientRef: 'clip',
        track: { source: 'client', clientRef: 'instrument' },
        startSec: 0,
        duration: 1,
        wave: 'sine',
        gain: 0.5,
        inputChannel: 2,
        notes: [{ id: 'note-1', beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 2 }],
        cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0.5, channel: 2 }],
        pitchBends: [],
        channelPressure: [],
        polyPressure: [],
        mappings: [{ id: 'mapping-1', source: { kind: 'cc', controller: 1, channel: 2 }, target: { parameterId: 'volume' }, outputMin: 0, outputMax: 1 }],
      },
    ],
  })
  const clip = created.resolvedRefs.find((entry) => entry.entity === 'clip')
  if (!clip) throw new Error('Expected MIDI clip.')
  const result = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{
      kind: 'clip.midi.set',
      clip: { source: 'persisted', id: clip.id },
      wave: 'sine',
      gain: 0.5,
      notes: [{ beat: 0, length: 1, pitch: 60, velocity: 0.5 }],
    }],
  })
  expect(result.changed).toBe(false)
  expect((await snapshotV2(project.id)).clips.find((entry) => entry.id === clip.id)?.midi).toMatchObject({
    inputChannel: 2,
    notes: [{ id: 'note-1', channel: 2 }],
    cc: [{ id: 'cc-1', channel: 2 }],
  })
})

test('edits a legacy local MIDI note through the control resolver', async () => {
  const project = await createLocalProject(`Legacy edit ${crypto.randomUUID()}`)
  const created = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'track.create', clientRef: 'instrument', trackKind: 'instrument' },
      {
        kind: 'clip.midi.create',
        clientRef: 'clip',
        track: { source: 'client', clientRef: 'instrument' },
        startSec: 0,
        duration: 1,
        wave: 'sine',
        notes: [],
      },
    ],
  })
  const clip = created.resolvedRefs.find((entry) => entry.entity === 'clip')
  if (!clip) throw new Error('Expected MIDI clip.')
  const notes = Array.from({ length: 501 }, (_, index) => ({
    id: `note-${index}`, beat: index, length: 1, pitch: 60, velocity: 0.5, channel: 1,
  }))
  notes[0] = { id: 'invalid-note', beat: -2, length: -1, pitch: 200, velocity: 2, channel: 1 }
  const legacy = {
    wave: 'custom-legacy',
    gain: 7,
    notes,
    cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0.5, channel: 1 }],
    mappings: [{ id: 'mapping-1', source: { kind: 'cc' as const, controller: 1, channel: 1 }, target: { parameterId: 'gain' }, outputMin: 0, outputMax: 1 }],
  }
  const db = await openLocalProjectDb(project.id)
  const row = await db.get('entities', ['clip', clip.id])
  if (!row || typeof row.value !== 'object' || row.value === null || Array.isArray(row.value)) {
    throw new Error('Expected local clip row.')
  }
  await db.put('entities', { ...row, value: { ...row.value, midi: legacy } })
  await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{
      kind: 'clip.midi.set',
      clip: { source: 'persisted', id: clip.id },
      wave: 'custom-legacy',
      gain: 7,
      notes: notes.map((note) => note.id === 'invalid-note'
        ? { ...note, beat: 0, length: 1, pitch: 60, velocity: 0.5 }
        : note),
    }],
  })
  const midi = (await snapshotV2(project.id)).clips.find((entry) => entry.id === clip.id)?.midi
  expect(midi).toMatchObject({ wave: 'custom-legacy', gain: 7, cc: legacy.cc, mappings: legacy.mappings })
  expect(midi?.notes).toHaveLength(501)
  expect(midi?.notes.find((note) => note.id === 'invalid-note')).toMatchObject({
    id: 'invalid-note', beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 1,
  })
})

test('captures and restores oversized legacy MIDI for local clip and track deletion', async () => {
  const oversizedMidi = {
    wave: 'custom-legacy',
    gain: 7,
    notes: Array.from({ length: 500 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
    cc: [{ beat: 0, controller: 1, value: 0 }],
  }
  for (const deletionKind of ['clip', 'track'] as const) {
    const project = await createLocalProject(`Oversized ${deletionKind} ${crypto.randomUUID()}`)
    const created = await executeLocalControlRequestV1({
      projectId: project.id,
      actions: [
        { kind: 'track.create', clientRef: 'track', trackKind: 'instrument' },
        {
          kind: 'clip.midi.create',
          clientRef: 'clip',
          track: { source: 'client', clientRef: 'track' },
          startSec: 0,
          duration: 1,
          wave: 'sine',
          notes: [],
        },
      ],
    })
    const track = created.resolvedRefs.find((entry) => entry.entity === 'track')
    const clip = created.resolvedRefs.find((entry) => entry.entity === 'clip')
    if (!track || !clip) throw new Error('Expected local track and clip.')
    const db = await openLocalProjectDb(project.id)
    const row = await db.get('entities', ['clip', clip.id])
    if (!row || typeof row.value !== 'object' || row.value === null || Array.isArray(row.value)) {
      throw new Error('Expected local clip row.')
    }
    await db.put('entities', { ...row, value: { ...row.value, midi: oversizedMidi } })
    const action = deletionKind === 'clip'
      ? { kind: 'clip.delete' as const, clip: { source: 'persisted' as const, id: clip.id } }
      : { kind: 'track.delete' as const, track: { source: 'persisted' as const, id: track.id } }
    const deleted = await executeLocalControlRequestV1({ projectId: project.id, actions: [action] })
    const recovery = deleted.recoveries[0]
    if (!recovery) throw new Error('Expected local recovery.')
    const recoveryRow = await db.get('controlRecoveries', recovery.id)
    if (!recoveryRow) throw new Error('Expected stored local recovery.')
    const payload = parseCapturedRecoveryPayload(recoveryRow.payload)
    expect(payload.kind).toBe(`${deletionKind}.delete`)
    expect(hashRecoveryPayloadSyncV1(recoveryRow.payload)).toBe(recoveryRow.payloadHash)
    await executeLocalControlRequestV1({
      projectId: project.id,
      actions: [{ kind: 'recovery.restore', recovery: { id: recovery.id } }],
    })
    const restored = await snapshotV2(project.id)
    expect(restored.clips[0]?.midi?.notes).toHaveLength(500)
    expect(restored.clips[0]?.midi?.cc).toHaveLength(1)
    expect(restored.clips[0]?.midi).toMatchObject({ wave: 'custom-legacy', gain: 7 })
  }
})

test('queues asset metadata deletion and restores it without touching its storage path', async () => {
  const project = await createLocalProject(`Asset recovery ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('assets', {
    id: 'asset-1',
    name: 'Kick.wav',
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: 'retained-kick.wav',
    sourceKind: 'upload',
    contentHash: 'a'.repeat(64),
    durationSec: 1,
    sampleRate: 48_000,
    channelCount: 2,
    createdAt: 1,
    updatedAt: 1,
  })
  const deleted = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{ kind: 'asset.delete', asset: { source: 'persisted', id: 'asset-1' } }],
  })
  const recovery = deleted.recoveries[0]
  if (!recovery) throw new Error('Expected asset recovery.')
  expect(await db.get('assets', 'asset-1')).toBeUndefined()
  expect((await db.get('controlAssetGc', `local-asset-gc:${recovery.id}`))?.storagePath).toBe('retained-kick.wav')
  const deletedAgain = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'recovery.restore', recovery: { id: recovery.id } },
      { kind: 'asset.delete', asset: { source: 'persisted', id: 'asset-1' } },
    ],
  })
  const secondRecovery = deletedAgain.recoveries[0]
  if (!secondRecovery) throw new Error('Expected second asset recovery.')
  const secondRow = await db.get('controlRecoveries', secondRecovery.id)
  if (!secondRow) throw new Error('Expected second stored recovery.')
  expect(hashRecoveryPayloadSyncV1(secondRow.payload)).toBe(secondRow.payloadHash)
  expect(parseCapturedRecoveryPayload(secondRow.payload)).toMatchObject({
    kind: 'asset.delete',
    data: { assetId: 'asset-1', asset: { storagePath: 'retained-kick.wav' } },
  })
})

test('uses original indexes for sequential creates and commits one revision', async () => {
  const project = await createLocalProject(`Sequential IDs ${crypto.randomUUID()}`)
  await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'track.create', trackKind: 'audio' },
      { kind: 'track.create', trackKind: 'audio' },
    ],
  })
  const current = await snapshot(project.id)
  expect(current.project.revision).toBe(1)
  expect(new Set(current.tracks.map((track) => track.id)).size).toBe(3)
})

test('returns the persisted local row ID for created effects', async () => {
  const project = await createLocalProject(`Effect identity ${crypto.randomUUID()}`)
  const track = (await snapshot(project.id)).tracks[0]
  if (!track) throw new Error('Expected initial track.')
  const result = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{
      kind: 'effect.upsert',
      clientRef: 'utility',
      target: { kind: 'track', track: { source: 'persisted', id: track.id } },
      effectKind: 'utility',
    }],
  })
  const resolved = result.resolvedRefs[0]
  if (!resolved) throw new Error('Expected resolved effect.')
  expect((await snapshot(project.id)).processors.map((processor) => processor.id)).toContain(resolved.id)
  expect(resolved.id).not.toStartWith('control:')
})

test('rebases client-created processor identities through automation and sidechains', async () => {
  const project = await createLocalProject(`Processor rebasing ${crypto.randomUUID()}`)
  const created = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'track.create', clientRef: 'source', trackKind: 'audio' },
      { kind: 'track.create', clientRef: 'target', trackKind: 'audio' },
      {
        kind: 'effect.upsert',
        clientRef: 'compressor',
        target: { kind: 'track', track: { source: 'client', clientRef: 'target' } },
        effectKind: 'compressor',
      },
      {
        kind: 'effect.upsert',
        clientRef: 'gate',
        target: { kind: 'track', track: { source: 'client', clientRef: 'target' } },
        effectKind: 'gate',
      },
      {
        kind: 'effect.upsert',
        clientRef: 'spectral',
        target: { kind: 'track', track: { source: 'client', clientRef: 'target' } },
        effectKind: 'spectral',
      },
      {
        kind: 'effect.upsert',
        clientRef: 'source-utility',
        target: { kind: 'track', track: { source: 'client', clientRef: 'source' } },
        effectKind: 'utility',
      },
      {
        kind: 'automation.set',
        target: { kind: 'track', track: { source: 'client', clientRef: 'target' } },
        effect: { source: 'client', clientRef: 'gate' },
        parameterId: 'gate.thresholdDb',
        enabled: true,
        points: [],
      },
      {
        kind: 'automation.set',
        target: { kind: 'track', track: { source: 'client', clientRef: 'target' } },
        effect: { source: 'client', clientRef: 'spectral' },
        parameterId: 'spectral.mix',
        enabled: true,
        points: [],
      },
      ...(['compressor', 'gate', 'spectral'] as const).map((clientRef) => ({
        kind: 'sidechain.set' as const,
        source: { source: 'client' as const, clientRef: 'source' },
        target: { source: 'client' as const, clientRef: 'target' },
        effect: { source: 'client' as const, clientRef },
      })),
    ],
  })
  const current = await snapshot(project.id)
  const refs = new Map(created.resolvedRefs.map((entry) => [entry.clientRef, entry.id]))
  const targetId = refs.get('target')
  if (!targetId) throw new Error('Expected target track reference.')
  const effects = current.processors.filter((processor) => (
    'trackId' in processor.target && processor.target.trackId === targetId
  ))
  const effectIds = ['compressor', 'gate', 'spectral'].map((clientRef) => {
    const id = refs.get(clientRef)
    if (!id) throw new Error(`Expected ${clientRef} effect reference.`)
    return id
  })
  expect(effects).toHaveLength(3)
  expect(effects.map((processor) => processor.id).sort()).toEqual(effectIds.sort())
  expect(effects.every((processor) => processor.instanceId?.startsWith('audio-effect:'))).toBe(true)
  expect(current.automation.every((entry) => (
    effects.some((processor) => processor.instanceId === entry.effectInstanceId)
  ))).toBe(true)
  expect(current.sidechains).toHaveLength(3)
  expect(current.sidechains.every((entry) => (
    effects.some((processor) => processor.instanceId === entry.effectInstanceId)
  ))).toBe(true)
  expect(JSON.stringify(current)).not.toContain('control:')
})

test('preserves malformed known rows and rejects tampered recovery payloads', async () => {
  const project = await createLocalProject(`Local integrity ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('entities', createLocalProjectEntityRow('track', 'malformed-track', {
    id: 'malformed-track',
    sends: [{ targetId: 42, amount: 1 }],
  }, 1))
  await db.put('entities', createLocalProjectEntityRow('unknown-kind', 'unknown-row', { retained: true }, 1))
  await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{ kind: 'project.rename', name: 'Renamed' }],
  })
  expect(await db.get('entities', ['track', 'malformed-track'])).toBeDefined()
  expect(await db.get('entities', ['unknown-kind', 'unknown-row'])).toBeDefined()

  const created = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'track.create', clientRef: 'instrument', trackKind: 'instrument' },
      {
        kind: 'clip.midi.create',
        clientRef: 'clip',
        track: { source: 'client', clientRef: 'instrument' },
        startSec: 0,
        duration: 1,
        wave: 'sine',
        notes: [],
      },
      { kind: 'clip.delete', clip: { source: 'client', clientRef: 'clip' } },
    ],
  })
  const recovery = created.recoveries[0]
  if (!recovery) throw new Error('Expected recovery.')
  const row = await db.get('controlRecoveries', recovery.id)
  if (!row) throw new Error('Expected recovery row.')
  await db.put('controlRecoveries', { ...row, payloadHash: '0'.repeat(64) })
  await expect(executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{ kind: 'recovery.restore', recovery: { id: recovery.id } }],
  })).rejects.toThrow('integrity')
})

test('materializes master processors as master rows and preserves them across unrelated changes', async () => {
  const project = await createLocalProject(`Master processor ${crypto.randomUUID()}`)
  const created = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{
      kind: 'effect.upsert',
      clientRef: 'master-eq',
      target: { kind: 'master' },
      effectKind: 'eq',
    }],
  })
  const effect = created.resolvedRefs[0]
  if (!effect) throw new Error('Expected master effect.')
  const db = await openLocalProjectDb(project.id)
  const row = await db.get('entities', ['effect', effect.id])
  expect(row?.value).toMatchObject({ id: effect.id, targetId: 'master', effect: 'master-eq' })

  await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{ kind: 'project.rename', name: 'Master retained' }],
  })
  expect((await db.get('entities', ['effect', effect.id]))?.value).toMatchObject({ effect: 'master-eq' })

  await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{
      kind: 'effect.remove',
      target: { kind: 'master' },
      effectKind: 'eq',
      effect: { source: 'persisted', id: effect.id },
    }],
  })
  expect(await db.get('entities', ['effect', effect.id])).toBeUndefined()
})

test('preserves legacy synth rows until an instrument update migrates them transactionally', async () => {
  const project = await createLocalProject(`Legacy synth ${crypto.randomUUID()}`)
  await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{ kind: 'track.create', clientRef: 'instrument', trackKind: 'instrument' }],
  })
  const track = (await snapshot(project.id)).tracks.find((entry) => entry.kind === 'instrument')
  if (!track) throw new Error('Expected initial track.')
  const db = await openLocalProjectDb(project.id)
  const legacyId = `${track.id}:synth`
  await db.put('entities', createLocalProjectEntityRow('effect', legacyId, {
    id: legacyId,
    targetId: track.id,
    effect: 'synth',
    instanceId: 'instrument:legacy',
    params: { kind: 'synth', instanceId: 'instrument:legacy', params: {} },
    index: 0,
    updatedAt: 1,
  }, 1))

  await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{ kind: 'project.rename', name: 'Keeps legacy synth' }],
  })
  expect(await db.get('entities', ['effect', legacyId])).toBeDefined()

  await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [{
      kind: 'instrument.set',
      target: { kind: 'track', track: { source: 'persisted', id: track.id } },
      instrumentKind: 'synth',
    }],
  })
  expect(await db.get('entities', ['effect', legacyId])).toBeUndefined()
  const migrated = (await db.get('entities', ['effect', `${track.id}:instrument`]))?.value
  expect(migrated).toMatchObject({ effect: 'instrument', instanceId: expect.stringMatching(/^instrument:/) })
  if (!migrated || typeof migrated !== 'object' || !('instanceId' in migrated) || !('params' in migrated)) {
    throw new Error('Expected migrated instrument row.')
  }
  expect(migrated.params).toMatchObject({ instanceId: migrated.instanceId })
})

test('rejects duplicate recovery restores before a local plan is executed', async () => {
  const project = await createLocalProject(`Duplicate recovery ${crypto.randomUUID()}`)
  expect(() => executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'recovery.restore', recovery: { id: 'local-recovery:duplicate' } },
      { kind: 'recovery.restore', recovery: { id: 'local-recovery:duplicate' } },
    ],
  })).toThrow()
  expect((await snapshot(project.id)).project.revision).toBe(0)
})

type ActionFixture = {
  action: (ids: Record<string, string>) => ControlActionV1
  assert: (current: Awaited<ReturnType<typeof snapshot>>, ids: Record<string, string>) => void
}

const seedActionFixture = async (includeExternal = true) => {
  const project = await createLocalProject(`Action fixture ${crypto.randomUUID()}`)
  const created = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'track.create', clientRef: 'instrument', trackKind: 'instrument', name: 'Instrument' },
      { kind: 'track.create', clientRef: 'audio', trackKind: 'audio', name: 'Audio' },
      { kind: 'track.create', clientRef: 'target', trackKind: 'audio', name: 'Target' },
      { kind: 'track.create', clientRef: 'source', trackKind: 'audio', name: 'Source' },
      { kind: 'track.create', clientRef: 'group', channelRole: 'group', name: 'Group' },
      { kind: 'track.create', clientRef: 'return', channelRole: 'return', name: 'Return' },
      { kind: 'track.create', clientRef: 'routed', trackKind: 'audio', name: 'Routed' },
    ],
  })
  const ids = Object.fromEntries(created.resolvedRefs.map((entry) => [entry.clientRef, entry.id]))
  const instrument = ids.instrument
  const audio = ids.audio
  const target = ids.target
  const source = ids.source
  const group = ids.group
  const returnTrack = ids.return
  if (!instrument || !audio || !target || !source || !group || !returnTrack) throw new Error('Expected fixture track IDs.')
  const effects = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'effect.upsert', clientRef: 'utility', target: { kind: 'track', track: { source: 'persisted', id: target } }, effectKind: 'utility' },
      { kind: 'effect.upsert', clientRef: 'gate', target: { kind: 'track', track: { source: 'persisted', id: target } }, effectKind: 'gate' },
      { kind: 'effect.upsert', clientRef: 'compressor', target: { kind: 'track', track: { source: 'persisted', id: target } }, effectKind: 'compressor' },
      { kind: 'effect.upsert', clientRef: 'group-utility', target: { kind: 'track', track: { source: 'persisted', id: group } }, effectKind: 'utility' },
      { kind: 'arpeggiator.set', target: { kind: 'track', track: { source: 'persisted', id: instrument } }, params: { enabled: true, pattern: 'up', rate: '1/8', octaves: 1, gate: 0.8, hold: false } },
    ],
  })
  for (const entry of effects.resolvedRefs) ids[entry.clientRef] = entry.id
  const gate = ids.gate
  const compressor = ids.compressor
  if (!gate || !compressor) throw new Error('Expected fixture effect IDs.')
  const db = await openLocalProjectDb(project.id)
  const externalInstanceId = crypto.randomUUID()
  if (includeExternal) await setLocalExternalProcessor(project.id, {
    instanceId: externalInstanceId,
    targetId: target,
    chainIndex: 0,
    manifest: {
      identity: {
        format: 'vst3',
        classId: 'fixture-class',
        vendor: 'Fixture Vendor',
        name: 'Fixture VST3',
        version: '1',
        architecture: 'arm64',
        binaryFingerprint: 'a'.repeat(64),
      },
      role: 'effect',
      audioInputs: [{ name: 'Input', channels: 2, enabled: true }],
      audioOutputs: [{ name: 'Output', channels: 2, enabled: true }],
      sidechainInputs: [],
      parameters: [{
        id: 1,
        title: 'Gain',
        unit: '',
        minimum: 0,
        maximum: 1,
        defaultValue: 0.5,
        stepCount: 100,
        readOnly: false,
        hidden: false,
      }],
      latencyFrames: 0,
      tailFrames: 0,
      supportsBypass: true,
      supportsEditor: false,
      supportsState: true,
    },
    parameterOverrides: { '1': 0.25 },
    latencyFrames: 0,
    tailFrames: 0,
    bypassed: false,
    health: { state: 'ready', updatedAt: 1 },
    updatedAt: 1,
  })
  if (includeExternal) ids.external = `external-plugin:${externalInstanceId}`
  await db.put('assets', {
    id: 'fixture-asset',
    name: 'Fixture.wav',
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: 'fixture.wav',
    sourceKind: 'upload',
    contentHash: 'a'.repeat(64),
    durationSec: 1,
    sampleRate: 48_000,
    channelCount: 2,
    createdAt: 1,
    updatedAt: 1,
  })
  ids.asset = 'fixture-asset'
  await db.put('assets', {
    id: 'fixture-asset-two',
    name: 'Fixture two.wav',
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: 'fixture-two.wav',
    sourceKind: 'upload',
    contentHash: 'b'.repeat(64),
    durationSec: 1,
    sampleRate: 48_000,
    channelCount: 2,
    createdAt: 1,
    updatedAt: 1,
  })
  ids.assetTwo = 'fixture-asset-two'
  const clips = await executeLocalControlRequestV1({
    projectId: project.id,
    actions: [
      { kind: 'clip.midi.create', clientRef: 'midi', track: { source: 'persisted', id: instrument }, startSec: 0, duration: 1, wave: 'sine', notes: [] },
      { kind: 'clip.audio.create', clientRef: 'audio-clip', track: { source: 'persisted', id: audio }, asset: { source: 'persisted', id: ids.asset }, duration: 1 },
      { kind: 'track.group.set', track: { source: 'persisted', id: audio }, group: { source: 'persisted', id: group } },
      { kind: 'automation.set', target: { kind: 'track', track: { source: 'persisted', id: target } }, effect: { source: 'persisted', id: gate }, parameterId: 'gate.thresholdDb', enabled: true, points: [] },
      { kind: 'automation.set', target: { kind: 'track', track: { source: 'persisted', id: group } }, effect: { source: 'persisted', id: ids['group-utility'] }, parameterId: 'utility.gainDb', enabled: true, points: [] },
      { kind: 'sidechain.set', source: { source: 'persisted', id: source }, target: { source: 'persisted', id: target }, effect: { source: 'persisted', id: compressor } },
      { kind: 'sidechain.set', source: { source: 'persisted', id: group }, target: { source: 'persisted', id: target }, effect: { source: 'persisted', id: compressor } },
    ],
  })
  for (const entry of clips.resolvedRefs) ids[entry.clientRef] = entry.id
  const midi = ids.midi
  const audioClip = ids['audio-clip']
  if (!midi || !audioClip) throw new Error('Expected fixture clip IDs.')
  for (const [index, track] of (await snapshot(project.id)).tracks.entries()) ids[`reorder-${index}`] = track.id
  return { projectId: project.id, ids }
}

const persisted = (id: string) => ({ source: 'persisted' as const, id })
const trackTarget = (id: string) => ({ kind: 'track' as const, track: persisted(id) })

const actionFixtures: Record<ControlActionV1['kind'], ActionFixture> = {
  'project.rename': { action: () => ({ kind: 'project.rename', name: 'Renamed' }), assert: (current) => expect(current.project.name).toBe('Renamed') },
  'project.settings.set': { action: () => ({ kind: 'project.settings.set', tempoBpm: 140 }), assert: (current) => expect(current.project.tempoBpm).toBe(140) },
  'track.create': { action: () => ({ kind: 'track.create', clientRef: 'new-track', name: 'New Track' }), assert: (current) => expect(current.tracks.some((track) => track.name === 'New Track')).toBe(true) },
  'track.rename': { action: (ids) => ({ kind: 'track.rename', track: persisted(ids.target!), name: 'Renamed Track' }), assert: (current, ids) => expect(current.tracks.find((track) => track.id === ids.target)?.name).toBe('Renamed Track') },
  'track.mix.set': { action: (ids) => ({ kind: 'track.mix.set', track: persisted(ids.target!), volume: 1.2 }), assert: (current, ids) => expect(current.tracks.find((track) => track.id === ids.target)?.volume).toBe(1.2) },
  'track.routing.set': { action: (ids) => ({ kind: 'track.routing.set', track: persisted(ids.routed!), sends: [{ target: persisted(ids.return!), amount: 0.5 }] }), assert: (current, ids) => expect(current.tracks.find((track) => track.id === ids.routed)?.sends[0]?.targetTrackId).toBe(ids.return) },
  'track.reorder': { action: (ids) => ({ kind: 'track.reorder', tracks: [...Object.entries(ids).filter(([key, id]) => key.startsWith('reorder-') && id !== ids.return).reverse(), ...Object.entries(ids).filter(([key, id]) => key.startsWith('reorder-') && id === ids.return)].map(([, id], index) => ({ track: persisted(id), index, group: id === ids.audio ? persisted(ids.group!) : null })) }), assert: (current) => expect(current.tracks.map((track) => track.index).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]) },
  'track.group.set': { action: (ids) => ({ kind: 'track.group.set', track: persisted(ids.source!), group: persisted(ids.group!) }), assert: (current, ids) => expect(current.tracks.find((track) => track.id === ids.source)?.groupId).toBe(ids.group) },
  'track.delete': { action: (ids) => ({ kind: 'track.delete', track: persisted(ids.source!) }), assert: (current, ids) => expect(current.tracks.some((track) => track.id === ids.source)).toBe(false) },
  'track.collapsed.set': { action: (ids) => ({ kind: 'track.collapsed.set', track: persisted(ids.target!), collapsed: true }), assert: (current, ids) => expect(current.tracks.find((track) => track.id === ids.target)?.collapsed).toBe(true) },
  'track.color.set': { action: (ids) => ({ kind: 'track.color.set', track: persisted(ids.target!), color: '#ff0000' }), assert: (current, ids) => expect(current.tracks.find((track) => track.id === ids.target)?.color).toBe('#ff0000') },
  'track.color.cascade': { action: (ids) => ({ kind: 'track.color.cascade', root: persisted(ids.group!), color: '#00ff00', cascadeClipColors: false }), assert: (current, ids) => expect(current.tracks.find((track) => track.id === ids.group)?.color).toBe('#00ff00') },
  'track.ungroup': { action: (ids) => ({ kind: 'track.ungroup', group: persisted(ids.group!) }), assert: (current, ids) => expect(current.tracks.some((track) => track.id === ids.group)).toBe(false) },
  'clip.midi.create': { action: (ids) => ({ kind: 'clip.midi.create', clientRef: 'new-midi', track: persisted(ids.instrument!), startSec: 2, duration: 1, wave: 'square', notes: [] }), assert: (current) => expect(current.clips.some((clip) => clip.startSec === 2 && clip.midi?.wave === 'square')).toBe(true) },
  'clip.move': { action: (ids) => ({ kind: 'clip.move', clip: persisted(ids.midi!), track: persisted(ids.instrument!), startSec: 3 }), assert: (current, ids) => expect(current.clips.find((clip) => clip.id === ids.midi)?.startSec).toBe(3) },
  'clip.timing.set': { action: (ids) => ({ kind: 'clip.timing.set', clip: persisted(ids.midi!), duration: 2 }), assert: (current, ids) => expect(current.clips.find((clip) => clip.id === ids.midi)?.duration).toBe(2) },
  'clip.rename': { action: (ids) => ({ kind: 'clip.rename', clip: persisted(ids.midi!), name: 'Renamed clip' }), assert: (current, ids) => expect(current.clips.find((clip) => clip.id === ids.midi)?.name).toBe('Renamed clip') },
  'clip.delete': { action: (ids) => ({ kind: 'clip.delete', clip: persisted(ids.midi!) }), assert: (current, ids) => expect(current.clips.some((clip) => clip.id === ids.midi)).toBe(false) },
  'timeline.range.delete': { action: (ids) => ({ kind: 'timeline.range.delete', tracks: [persisted(ids.instrument!)], startSec: 0, endSec: 1 }), assert: (current, ids) => expect(current.clips.some((clip) => clip.id === ids.midi)).toBe(false) },
  'master.volume.set': { action: () => ({ kind: 'master.volume.set', volume: 0.9 }), assert: (current) => expect(current.project.masterVolume).toBe(0.9) },
  'effect.upsert': { action: (ids) => ({ kind: 'effect.upsert', clientRef: 'new-eq', target: trackTarget(ids.target!), effectKind: 'eq' }), assert: (current) => expect(current.processors.some((processor) => processor.processor.kind === 'eq')).toBe(true) },
  'effect.remove': { action: (ids) => ({ kind: 'effect.remove', target: trackTarget(ids.target!), effectKind: 'utility', effect: persisted(ids.utility!) }), assert: (current, ids) => expect(current.processors.some((processor) => processor.id === ids.utility)).toBe(false) },
  'effect.reorder': { action: (ids) => ({ kind: 'effect.reorder', target: trackTarget(ids.target!), order: [{ effect: persisted(ids.compressor!), kind: 'compressor' }, { effect: persisted(ids.gate!), kind: 'gate' }, { effect: persisted(ids.utility!), kind: 'utility' }] }), assert: (current, ids) => expect(current.processors.find((processor) => processor.id === ids.compressor)?.index).toBe(0) },
  'external-plugin.parameters.set': { action: (ids) => ({ kind: 'external-plugin.parameters.set', target: trackTarget(ids.target!), processor: persisted(ids.external!), changes: [{ parameterId: 1, normalizedValue: 0.75 }] }), assert: (current, ids) => expect(current.processors.find((processor) => processor.id === ids.external)?.processor).toMatchObject({ kind: 'external-vst3', params: { parameterOverrides: { '1': 0.75 } } }) },
  'instrument.set': { action: (ids) => ({ kind: 'instrument.set', target: trackTarget(ids.instrument!), instrumentKind: 'sampler' }), assert: (current, ids) => expect(current.processors.find((processor) => 'trackId' in processor.target && processor.target.trackId === ids.instrument && processor.processor.kind === 'instrument')?.processor.params).toMatchObject({ kind: 'sampler' }) },
  'instrument.remove': { action: (ids) => ({ kind: 'instrument.remove', target: trackTarget(ids.instrument!) }), assert: (current, ids) => expect(current.processors.some((processor) => 'trackId' in processor.target && processor.target.trackId === ids.instrument && processor.processor.kind === 'instrument')).toBe(false) },
  'arpeggiator.set': { action: (ids) => ({ kind: 'arpeggiator.set', target: trackTarget(ids.instrument!), params: { enabled: true, pattern: 'down', rate: '1/8', octaves: 1, gate: 0.8, hold: false } }), assert: (current, ids) => expect(current.processors.find((processor) => 'trackId' in processor.target && processor.target.trackId === ids.instrument && processor.processor.kind === 'arpeggiator')?.processor.params).toMatchObject({ pattern: 'down' }) },
  'arpeggiator.remove': { action: (ids) => ({ kind: 'arpeggiator.remove', target: trackTarget(ids.instrument!) }), assert: (current, ids) => expect(current.processors.some((processor) => 'trackId' in processor.target && processor.target.trackId === ids.instrument && processor.processor.kind === 'arpeggiator')).toBe(false) },
  'automation.set': { action: (ids) => ({ kind: 'automation.set', target: trackTarget(ids.target!), effect: persisted(ids.gate!), parameterId: 'gate.thresholdDb', enabled: false, points: [] }), assert: (current, ids) => expect(current.automation.find((entry) => 'trackId' in entry.target && entry.target.trackId === ids.target && entry.parameterId === 'gate.thresholdDb')?.enabled).toBe(false) },
  'automation.delete': { action: (ids) => ({ kind: 'automation.delete', target: trackTarget(ids.target!), effect: persisted(ids.gate!), parameterId: 'gate.thresholdDb' }), assert: (current, ids) => expect(current.automation.some((entry) => 'trackId' in entry.target && entry.target.trackId === ids.target && entry.parameterId === 'gate.thresholdDb')).toBe(false) },
  'sidechain.set': { action: (ids) => ({ kind: 'sidechain.set', source: persisted(ids.audio!), target: persisted(ids.target!), effect: persisted(ids.compressor!) }), assert: (current, ids) => expect(current.sidechains.some((entry) => entry.sourceTrackId === ids.audio)).toBe(true) },
  'sidechain.remove': { action: (ids) => ({ kind: 'sidechain.remove', target: persisted(ids.target!), effect: persisted(ids.compressor!) }), assert: (current, ids) => expect(current.sidechains.some((entry) => entry.targetTrackId === ids.target)).toBe(false) },
  'clip.audio.create': { action: (ids) => ({ kind: 'clip.audio.create', clientRef: 'new-audio', track: persisted(ids.audio!), asset: persisted(ids.asset!), duration: 1 }), assert: (current) => expect(current.clips.some((clip) => clip.name === 'Fixture.wav')).toBe(true) },
  'clip.source.set': { action: (ids) => ({ kind: 'clip.source.set', clip: persisted(ids['audio-clip']!), asset: persisted(ids.assetTwo!) }), assert: (current, ids) => expect(current.clips.find((clip) => clip.id === ids['audio-clip'])?.source?.assetId).toBe(ids.assetTwo) },
  'clip.midi.set': { action: (ids) => ({ kind: 'clip.midi.set', clip: persisted(ids.midi!), wave: 'sawtooth', notes: [] }), assert: (current, ids) => expect(current.clips.find((clip) => clip.id === ids.midi)?.midi?.wave).toBe('sawtooth') },
  'clip.fades.set': { action: (ids) => ({ kind: 'clip.fades.set', clip: persisted(ids['audio-clip']!), fades: { fadeInSec: 0, fadeOutSec: 0, fadeInCurve: 0, fadeOutCurve: 0 } }), assert: (current, ids) => expect(current.clips.find((clip) => clip.id === ids['audio-clip'])?.fades).toBeDefined() },
  'clip.audioWarp.set': { action: (ids) => ({ kind: 'clip.audioWarp.set', clip: persisted(ids['audio-clip']!), audioWarp: { enabled: true, mode: 'repitch' } }), assert: (current, ids) => expect(current.clips.find((clip) => clip.id === ids['audio-clip'])?.audioWarp?.enabled).toBe(true) },
  'clip.color.set': { action: (ids) => ({ kind: 'clip.color.set', clip: persisted(ids.midi!), color: 'clip-midi' }), assert: (current, ids) => expect(current.clips.find((clip) => clip.id === ids.midi)?.color).toBe('clip-midi') },
  'asset.delete': { action: (ids) => ({ kind: 'asset.delete', asset: persisted(ids.assetTwo!) }), assert: (current, ids) => expect(current.assets.some((asset) => asset.id === ids.assetTwo)).toBe(false) },
  'recovery.restore': { action: (ids) => ({ kind: 'recovery.restore', recovery: { id: ids.recovery! } }), assert: (current) => expect(current.clips.some((clip) => clip.midi !== undefined)).toBe(true) },
}

test('exhaustively executes all advertised local control action fixtures', async () => {
  expect(Object.keys(actionFixtures).sort()).toEqual([...localControlCapabilitiesV1.actionKinds].sort())
  expect(Object.keys(actionFixtures)).toHaveLength(40)
  for (const [kind, fixture] of Object.entries(actionFixtures)) {
    const { projectId, ids } = await seedActionFixture()
    if (kind === 'recovery.restore') {
      const deletion = await executeLocalControlRequestV1({
        projectId,
        actions: [{ kind: 'clip.delete', clip: persisted(ids.midi!) }],
      })
      ids.recovery = deletion.recoveries[0]?.id ?? ''
    }
    const before = await snapshot(projectId)
    await executeLocalControlRequestV1({ projectId, actions: [fixture.action(ids)] })
    const current = await snapshot(projectId)
    try {
      fixture.assert(current, ids)
    } catch (error) {
      throw new Error(`${kind} fixture failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      expect(current.project.revision).toBe(before.project.revision + 1)
    } catch (error) {
      throw new Error(`${kind} revision fixture failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    expect(JSON.stringify(current)).not.toContain('control:')
  }
})

type RecoveryKind = Extract<ControlActionV1['kind'],
  'track.delete' | 'track.ungroup' | 'clip.delete' | 'effect.remove'
  | 'instrument.remove' | 'arpeggiator.remove' | 'automation.delete'
  | 'sidechain.remove' | 'asset.delete' | 'timeline.range.delete'
>

const recoveryFixtures: Record<RecoveryKind, {
  action: (ids: Record<string, string>) => ControlActionV1
  assertDestroyed: (current: Awaited<ReturnType<typeof snapshot>>, ids: Record<string, string>) => void
}> = {
  'clip.delete': {
    action: (ids) => ({ kind: 'clip.delete', clip: persisted(ids.midi!) }),
    assertDestroyed: (current, ids) => expect(current.clips.some((clip) => clip.id === ids.midi)).toBe(false),
  },
  'timeline.range.delete': {
    action: (ids) => ({ kind: 'timeline.range.delete', tracks: [persisted(ids.instrument!)], startSec: 0, endSec: 1 }),
    assertDestroyed: (current, ids) => expect(current.clips.some((clip) => clip.id === ids.midi)).toBe(false),
  },
  'effect.remove': {
    action: (ids) => ({ kind: 'effect.remove', target: trackTarget(ids.target!), effectKind: 'gate', effect: persisted(ids.gate!) }),
    assertDestroyed: (current, ids) => {
      expect(current.processors.some((effect) => effect.id === ids.gate)).toBe(false)
      expect(current.automation.some((entry) => entry.parameterId === 'gate.thresholdDb' && 'trackId' in entry.target && entry.target.trackId === ids.target)).toBe(false)
    },
  },
  'instrument.remove': {
    action: (ids) => ({ kind: 'instrument.remove', target: trackTarget(ids.instrument!) }),
    assertDestroyed: (current, ids) => expect(current.processors.some((effect) => (
      'trackId' in effect.target && effect.target.trackId === ids.instrument && effect.processor.kind === 'instrument'
    ))).toBe(false),
  },
  'arpeggiator.remove': {
    action: (ids) => ({ kind: 'arpeggiator.remove', target: trackTarget(ids.instrument!) }),
    assertDestroyed: (current, ids) => expect(current.processors.some((effect) => (
      'trackId' in effect.target && effect.target.trackId === ids.instrument && effect.processor.kind === 'arpeggiator'
    ))).toBe(false),
  },
  'automation.delete': {
    action: (ids) => ({ kind: 'automation.delete', target: trackTarget(ids.target!), effect: persisted(ids.gate!), parameterId: 'gate.thresholdDb' }),
    assertDestroyed: (current, ids) => expect(current.automation.some((entry) => (
      entry.parameterId === 'gate.thresholdDb' && 'trackId' in entry.target && entry.target.trackId === ids.target
    ))).toBe(false),
  },
  'sidechain.remove': {
    action: (ids) => ({ kind: 'sidechain.remove', target: persisted(ids.target!), effect: persisted(ids.compressor!) }),
    assertDestroyed: (current, ids) => expect(current.sidechains.some((entry) => entry.targetTrackId === ids.target)).toBe(false),
  },
  'asset.delete': {
    action: (ids) => ({ kind: 'asset.delete', asset: persisted(ids.assetTwo!) }),
    assertDestroyed: (current, ids) => expect(current.assets.some((asset) => asset.id === ids.assetTwo)).toBe(false),
  },
  'track.delete': {
    action: (ids) => ({ kind: 'track.delete', track: persisted(ids.target!) }),
    assertDestroyed: (current, ids) => {
      expect(current.tracks.some((track) => track.id === ids.target)).toBe(false)
      expect(current.automation.some((entry) => entry.parameterId === 'gate.thresholdDb')).toBe(false)
      expect(current.sidechains).toEqual([])
    },
  },
  'track.ungroup': {
    action: (ids) => ({ kind: 'track.ungroup', group: persisted(ids.group!) }),
    assertDestroyed: (current, ids) => {
      expect(current.tracks.some((track) => track.id === ids.group)).toBe(false)
      expect(current.automation.some((entry) => entry.parameterId === 'utility.gainDb')).toBe(false)
      expect(current.sidechains.some((entry) => entry.sourceTrackId === ids.group)).toBe(false)
    },
  },
}

const recoveryPayloadSources = (payload: ReturnType<typeof parseRecoveryPayload>) => {
  if (payload.kind === 'clip.delete') return [{ entity: 'clip', sourceId: payload.data.clipId }]
  if (payload.kind === 'asset.delete') return [{ entity: 'asset', sourceId: payload.data.assetId }]
  if (payload.kind === 'automation.delete') return [{ entity: 'automation', sourceId: payload.data.automationId }]
  if (payload.kind === 'sidechain.remove') return [{ entity: 'sidechain', sourceId: payload.data.sidechainId }]
  if (payload.kind === 'timeline.range.delete') return payload.data.deletedClips.map((entry) => ({
    entity: 'clip',
    sourceId: entry.id,
  }))
  if (payload.kind === 'track.delete' || payload.kind === 'track.ungroup') return [
    ...payload.data.tracks.map((entry) => ({ entity: 'track', sourceId: entry.id })),
    ...payload.data.clips.map((entry) => ({ entity: 'clip', sourceId: entry.id })),
    ...payload.data.effects.map((entry) => ({ entity: 'effect', sourceId: entry.id })),
    ...payload.data.automation.map((entry) => ({ entity: 'automation', sourceId: entry.id })),
    ...payload.data.sidechains.map((entry) => ({ entity: 'sidechain', sourceId: entry.id })),
  ]
  return [
    ...payload.data.effects.map((entry) => ({ entity: 'effect', sourceId: entry.id })),
    ...payload.data.automation.map((entry) => ({ entity: 'automation', sourceId: entry.id })),
    ...payload.data.sidechains.map((entry) => ({ entity: 'sidechain', sourceId: entry.id })),
  ]
}

test('exhaustively restores all 10 local recovery kinds with canonical payloads and exact mappings', async () => {
  expect(Object.keys(recoveryFixtures).sort()).toEqual([...controlCapabilitiesV1.recovery.supportedKinds].sort())
  expect(Object.keys(recoveryFixtures)).toHaveLength(10)
  for (const [kind, fixture] of Object.entries(recoveryFixtures) as Array<[RecoveryKind, typeof recoveryFixtures[RecoveryKind]]>) {
    const { projectId, ids } = await seedActionFixture(false)
    const before = await snapshot(projectId)
    const deleted = await executeLocalControlRequestV1({ projectId, actions: [fixture.action(ids)] })
    const recovery = deleted.recoveries[0]
    if (!recovery) throw new Error(`${kind} did not create a recovery row.`)
    expect(recovery.kind).toBe(kind)
    const db = await openLocalProjectDb(projectId)
    const recoveryRow = await db.get('controlRecoveries', recovery.id)
    if (!recoveryRow) throw new Error(`${kind} recovery row is missing.`)
    const payload = parseRecoveryPayload(recoveryRow.payload)
    expect(payload.kind).toBe(kind)
    expect(hashRecoveryPayloadSyncV1(recoveryRow.payload)).toBe(recoveryRow.payloadHash)
    expect(canonicalCapturedRecoveryPayloadV2(payload)).toBe(recoveryRow.payload)
    if (payload.kind === 'timeline.range.delete') {
      expect(Object.keys(payload.data).sort()).toEqual([
        'automation', 'createdClips', 'deletedClips', 'range', 'updatedClips',
      ])
      expect(payload.data.createdClips.every((entry) => !entry.id.startsWith('control:'))).toBe(true)
    }
    fixture.assertDestroyed(await snapshot(projectId), ids)

    const restored = await executeLocalControlRequestV1({
      projectId,
      actions: [{ kind: 'recovery.restore', recovery: { id: recovery.id } }],
    })
    const mappings = restored.restored[0]?.entities
    if (!mappings) throw new Error(`${kind} did not return recovery mappings.`)
    expect(mappings.map(({ entity, sourceId }) => ({ entity, sourceId })).sort((left, right) => (
      `${left.entity}:${left.sourceId}`.localeCompare(`${right.entity}:${right.sourceId}`)
    ))).toEqual(recoveryPayloadSources(payload).sort((left, right) => (
      `${left.entity}:${left.sourceId}`.localeCompare(`${right.entity}:${right.sourceId}`)
    )))
    for (const mapping of mappings) {
      if (mapping.entity === 'asset') expect(await db.get('assets', mapping.restoredId)).toBeDefined()
      else expect(await db.get('entities', [mapping.entity === 'automation' ? 'automation-envelope' : mapping.entity === 'sidechain' ? 'sidechain-route' : mapping.entity, mapping.restoredId])).toBeDefined()
    }
    const restoredSnapshot = await snapshot(projectId)
    expect(restoredSnapshot.project.revision).toBe(before.project.revision + 2)
    expect((await db.get('controlRecoveries', recovery.id))?.consumedAt).toEqual(expect.any(Number))
    expect(JSON.stringify(restoredSnapshot)).not.toContain('control:')
  }
})

test('restores a locally split range after semantic drift verification', async () => {
  const { projectId, ids } = await seedActionFixture()
  const sourceId = ids['audio-clip']
  if (!sourceId) throw new Error('Expected audio clip fixture.')
  const db = await openLocalProjectDb(projectId)
  const clipRow = await db.get('entities', ['clip', sourceId])
  if (!clipRow || typeof clipRow.value !== 'object' || clipRow.value === null || Array.isArray(clipRow.value)) {
    throw new Error('Expected source clip row.')
  }
  await db.put('entities', {
    ...clipRow,
    value: { ...clipRow.value, historyRef: 'durable-range-clip-ref' },
  })
  const before = (await snapshot(projectId)).clips.find((clip) => clip.id === sourceId)
  if (!before) throw new Error('Expected source clip.')
  const deleted = await executeLocalControlRequestV1({
    projectId,
    actions: [{
      kind: 'timeline.range.delete',
      tracks: [persisted(ids.audio!)],
      startSec: 0.25,
      endSec: 0.75,
    }],
  })
  expect((await snapshot(projectId)).clips.filter((clip) => clip.trackId === ids.audio)).toHaveLength(2)
  const recovery = deleted.recoveries[0]
  if (!recovery) throw new Error('Expected range recovery.')
  await executeLocalControlRequestV1({
    projectId,
    actions: [{ kind: 'recovery.restore', recovery: { id: recovery.id } }],
  })
  expect((await snapshot(projectId)).clips.find((clip) => clip.id === sourceId)).toEqual(before)
  expect((await db.get('entities', ['clip', sourceId]))?.value).toMatchObject({
    historyRef: 'durable-range-clip-ref',
  })
})

test('restores a locally deleted clip with its durable history reference', async () => {
  const { projectId, ids } = await seedActionFixture()
  const sourceId = ids['audio-clip']
  if (!sourceId) throw new Error('Expected audio clip fixture.')
  const db = await openLocalProjectDb(projectId)
  const clipRow = await db.get('entities', ['clip', sourceId])
  if (!clipRow || typeof clipRow.value !== 'object' || clipRow.value === null || Array.isArray(clipRow.value)) {
    throw new Error('Expected source clip row.')
  }
  await db.put('entities', {
    ...clipRow,
    value: { ...clipRow.value, historyRef: 'durable-deleted-clip-ref' },
  })
  const deleted = await executeLocalControlRequestV1({
    projectId,
    actions: [{ kind: 'clip.delete', clip: persisted(sourceId) }],
  })
  const recovery = deleted.recoveries[0]
  if (!recovery) throw new Error('Expected clip recovery.')
  const restored = await executeLocalControlRequestV1({
    projectId,
    actions: [{ kind: 'recovery.restore', recovery: { id: recovery.id } }],
  })
  const restoredId = restored.restored[0]?.entities.find((entity) => entity.entity === 'clip')?.restoredId
  if (!restoredId) throw new Error('Expected restored clip ID.')
  expect((await db.get('entities', ['clip', restoredId]))?.value).toMatchObject({
    historyRef: 'durable-deleted-clip-ref',
  })
})

test('preserves every earlier deletion across cumulative local actions', async () => {
  {
    const { projectId, ids } = await seedActionFixture()
    const before = await snapshot(projectId)
    await executeLocalControlRequestV1({ projectId, actions: [
      { kind: 'effect.remove', target: trackTarget(ids.target!), effectKind: 'utility', effect: persisted(ids.utility!) },
      { kind: 'project.rename', name: 'Effect removed' },
    ] })
    expect((await snapshot(projectId)).project.revision).toBe(before.project.revision + 1)
    expect((await snapshot(projectId)).processors.some((effect) => effect.id === ids.utility)).toBe(false)
  }
  {
    const { projectId, ids } = await seedActionFixture()
    const before = await snapshot(projectId)
    await executeLocalControlRequestV1({ projectId, actions: [
      { kind: 'clip.delete', clip: persisted(ids.midi!) },
      { kind: 'track.rename', track: persisted(ids.instrument!), name: 'Clip deleted' },
    ] })
    expect((await snapshot(projectId)).project.revision).toBe(before.project.revision + 1)
    expect((await snapshot(projectId)).clips.some((clip) => clip.id === ids.midi)).toBe(false)
  }
  {
    const { projectId, ids } = await seedActionFixture()
    const before = await snapshot(projectId)
    await executeLocalControlRequestV1({ projectId, actions: [
      { kind: 'track.delete', track: persisted(ids.source!) },
      { kind: 'track.create', clientRef: 'replacement', name: 'Replacement', trackKind: 'audio' },
    ] })
    const current = await snapshot(projectId)
    expect(current.project.revision).toBe(before.project.revision + 1)
    expect(current.tracks.some((track) => track.id === ids.source)).toBe(false)
    expect(current.tracks.some((track) => track.name === 'Replacement')).toBe(true)
  }
  {
    const { projectId, ids } = await seedActionFixture()
    const before = await snapshot(projectId)
    await executeLocalControlRequestV1({ projectId, actions: [
      { kind: 'automation.delete', target: trackTarget(ids.target!), effect: persisted(ids.gate!), parameterId: 'gate.thresholdDb' },
      {
        kind: 'effect.upsert',
        target: trackTarget(ids.target!),
        effect: persisted(ids.utility!),
        effectKind: 'utility',
        params: {
          version: 1,
          state: {
            enabled: true, gainDb: -3, polarity: 'normal', inputMode: 'stereo',
            pan: 0, balance: 0, width: 1, matrix: 'stereo', swap: false, dcBlock: false,
          },
        },
      },
    ] })
    const current = await snapshot(projectId)
    expect(current.project.revision).toBe(before.project.revision + 1)
    expect(current.automation.some((entry) => entry.parameterId === 'gate.thresholdDb')).toBe(false)
    expect(current.processors.find((effect) => effect.id === ids.utility)?.processor.params).toMatchObject({
      state: { gainDb: -3 },
    })
  }
  {
    const { projectId, ids } = await seedActionFixture()
    const before = await snapshot(projectId)
    await executeLocalControlRequestV1({ projectId, actions: [
      { kind: 'sidechain.remove', target: persisted(ids.target!), effect: persisted(ids.compressor!) },
      { kind: 'track.routing.set', track: persisted(ids.routed!), sends: [{ target: persisted(ids.return!), amount: 0.5 }] },
    ] })
    const current = await snapshot(projectId)
    expect(current.project.revision).toBe(before.project.revision + 1)
    expect(current.sidechains.some((entry) => entry.targetTrackId === ids.target)).toBe(false)
    expect(current.tracks.find((track) => track.id === ids.routed)?.sends).toEqual([{
      targetTrackId: ids.return, amount: 0.5,
    }])
  }
})
