import { expect, test } from 'bun:test'
import 'fake-indexeddb/auto'

import {
  MidiEditorConflictError,
  applyMidiEditorOperations,
  createAwaitingMidiReconciliation,
  createMidiEditorPersistence,
  projectMidiEditorOperations,
  reconcileMidiEditorOperationBatch,
  reconcileAwaitingMidiReconciliation,
  reconcileMidiEditorOperations,
  type MidiEditorNote,
} from './editor-persistence'
import { normalizeLegacyMidiClip } from '@daw-browser/shared'
import { createLocalProject, createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-pending-writes'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'

const note = (id: string): MidiEditorNote => ({
  id,
  beat: 0,
  length: 1,
  pitch: 60,
  velocity: 0.9,
  channel: 1,
})

const midi = {
  wave: 'sawtooth' as const,
  gain: 0.8,
  inputChannel: 2,
  notes: [note('one')],
  cc: [{ id: 'cc', beat: 0, controller: 1, value: 0.5, channel: 1 }],
  pitchBends: [],
  channelPressure: [],
  polyPressure: [],
  mappings: [],
}

test('semantic MIDI operations preserve unrelated expanded MIDI data', () => {
  const result = applyMidiEditorOperations(midi, [
    { kind: 'update', id: 'one', changes: { pitch: 64 } },
    { kind: 'insert', note: note('two') },
  ])

  expect(result.notes).toEqual([{ ...note('one'), pitch: 64 }, note('two')])
  expect(result.cc).toEqual(midi.cc)
  expect(result.inputChannel).toBe(2)
})

test('semantic mapping operations rebase independently from note edits', () => {
  const result = applyMidiEditorOperations(midi, [
    {
      kind: 'insert-mapping',
      mapping: {
        id: 'mapping-one',
        source: { kind: 'cc', controller: 1 },
        target: { parameterId: 'volume' },
        outputMin: 0,
        outputMax: 1,
      },
    },
    { kind: 'update', id: 'one', changes: { pitch: 67 } },
    { kind: 'update-mapping', id: 'mapping-one', changes: { outputMax: 0.5 } },
  ])

  expect(result.notes[0]?.pitch).toBe(67)
  expect(result.mappings).toEqual([expect.objectContaining({ id: 'mapping-one', outputMax: 0.5 })])
})

test('semantic MIDI deletes are idempotent and conflicting inserts are rejected', () => {
  expect(applyMidiEditorOperations(midi, [{ kind: 'delete', id: 'missing' }]).notes).toEqual(midi.notes)
  expect(() => applyMidiEditorOperations(midi, [{
    kind: 'insert',
    note: { ...note('one'), pitch: 61 },
  }])).toThrow(MidiEditorConflictError)
})

test('projection retains pending edits over newer remote MIDI and drops removed-note conflicts', () => {
  const remote = {
    ...midi,
    notes: [note('one'), note('other')],
  }
  expect(projectMidiEditorOperations(remote, [{
    kind: 'update',
    id: 'one',
    changes: { pitch: 67 },
  }]).notes).toEqual([{ ...note('one'), pitch: 67 }, note('other')])
  expect(projectMidiEditorOperations({ ...remote, notes: [note('other')] }, [{
    kind: 'update',
    id: 'one',
    changes: { pitch: 67 },
  }]).notes).toEqual([note('other')])
})

test('isolates a conflicting note update while projecting unrelated valid operations', () => {
  const conflicting = { kind: 'update' as const, id: 'removed', changes: { pitch: 67 } }
  const valid = { kind: 'update' as const, id: 'one', changes: { pitch: 65 } }

  expect(reconcileMidiEditorOperationBatch(midi, [conflicting, valid])).toEqual({
    midi: { ...midi, notes: [{ ...note('one'), pitch: 65 }] },
    conflicts: [conflicting],
  })
})

test('subscription lag retains committed operations until their touched fields are reflected', () => {
  const inserted = note('two')
  const operations = [
    { kind: 'insert' as const, note: inserted },
    { kind: 'update' as const, id: 'one', changes: { pitch: 67 } },
  ]
  expect(reconcileMidiEditorOperations(midi, operations)).toEqual(operations)
  expect(reconcileMidiEditorOperations({
    ...midi,
    notes: [{ ...note('one'), pitch: 67 }, inserted],
  }, operations)).toEqual([])
  expect(reconcileMidiEditorOperations({ ...midi, notes: [...midi.notes, note('three')] }, [
    { kind: 'delete', id: 'three' },
  ])).toEqual([{ kind: 'delete', id: 'three' }])
})

test('a collaborator base update retains a committed MIDI overlay until exact reflection', () => {
  const operation = { kind: 'update' as const, id: 'one', changes: { pitch: 67 } }
  const overlay = createAwaitingMidiReconciliation([operation], 4)

  expect(reconcileAwaitingMidiReconciliation(overlay, midi)).toEqual(overlay)
  expect(reconcileAwaitingMidiReconciliation(overlay, {
    ...midi,
    notes: [{ ...note('one'), pitch: 65 }],
  })).toEqual(overlay)
  expect(reconcileAwaitingMidiReconciliation(overlay, {
    ...midi,
    notes: [{ ...note('one'), pitch: 67 }],
  })).toBeUndefined()
})

test('rebases a new touched-field edit on the reflected collaborator value', () => {
  const reflected = {
    ...midi,
    notes: [{ ...note('one'), pitch: 65 }],
  }
  const next = applyMidiEditorOperations(reflected, [{
    kind: 'update',
    id: 'one',
    changes: { beat: 2 },
  }])
  expect(next.notes).toEqual([{ ...note('one'), beat: 2, pitch: 65 }])
})

test('local MIDI persistence flushes other local work without recursively flushing itself', async () => {
  const project = await createLocalProject(`MIDI persistence ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const track = await repository.createTrack({ id: 'midi-track', kind: 'instrument' })
  await repository.createClip({
    id: 'midi-clip',
    trackId: track.id,
    startSec: 0,
    duration: 1,
    midi: { wave: 'sine', notes: [note('one')] },
  })
  let flushedEffects = 0
  const unregister = registerPendingLocalProjectWriteFlusher('effects', project.id, async () => {
    flushedEffects += 1
  })
  const persistence = createMidiEditorPersistence({ projectId: project.id, clipId: 'midi-clip' })
  persistence.enqueue({ kind: 'update', id: 'one', changes: { pitch: 64 } })
  await persistence.flush()
  persistence.dispose()
  unregister()

  expect(flushedEffects).toBeGreaterThan(0)
  expect((await repository.loadSnapshot()).clips[0]?.midi?.notes[0]?.pitch).toBe(64)
})

test('accepts a valid no-op MIDI commit as a successful reconciliation', async () => {
  const project = await createLocalProject(`No-op MIDI ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const track = await repository.createTrack({ id: 'midi-track', kind: 'instrument' })
  await repository.createClip({
    id: 'midi-clip',
    trackId: track.id,
    startSec: 0,
    duration: 1,
    midi: { wave: 'sine', notes: [note('one')] },
  })
  let committed = 0
  let error: { retryable: boolean } | undefined
  const editor = createMidiEditorPersistence({
    projectId: project.id,
    clipId: 'midi-clip',
    onCommitted: () => { committed += 1 },
    onError: (value) => { error = value },
  })
  editor.enqueue({ kind: 'update', id: 'one', changes: { pitch: 60 } })
  await editor.flush()
  editor.dispose()

  expect(committed).toBe(1)
  expect(error).toBeUndefined()
  expect(editor.pendingOperations()).toEqual([])
})

test('edits and deletes historical ID-less notes using their canonical persistence IDs', async () => {
  const project = await createLocalProject(`Historical MIDI ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const track = await repository.createTrack({ id: 'midi-track', kind: 'instrument' })
  const legacyMidi = { wave: 'sine', notes: [{ beat: 0, length: 1, pitch: 60 }] }
  const db = await openLocalProjectDb(project.id)
  await db.put('entities', createLocalProjectEntityRow('clip', 'midi-clip', {
    id: 'midi-clip',
    trackId: track.id,
    historyRef: 'midi-clip',
    name: 'Historical MIDI',
    startSec: 0,
    duration: 1,
    color: 'clip-midi',
    midi: legacyMidi,
    createdAt: 1,
    updatedAt: 1,
  }, 1))
  const id = normalizeLegacyMidiClip(legacyMidi).notes[0]?.id
  if (!id) throw new Error('Expected canonical historical MIDI ID.')

  const editor = createMidiEditorPersistence({ projectId: project.id, clipId: 'midi-clip' })
  editor.enqueue({ kind: 'update', id, changes: { pitch: 64 } })
  await editor.flush()
  editor.enqueue({ kind: 'delete', id })
  await editor.flush()
  editor.dispose()

  expect((await repository.loadSnapshot()).clips[0]?.midi?.notes).toEqual([])
})

test('drops terminal remote-deletion work without blocking later project MIDI flushes', async () => {
  const project = await createLocalProject(`Terminal MIDI ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const track = await repository.createTrack({ id: 'midi-track', kind: 'instrument' })
  const clip = await repository.createClip({
    id: 'midi-clip',
    trackId: track.id,
    startSec: 0,
    duration: 1,
    midi: { wave: 'sine', notes: [note('one')] },
  })
  let error: { retryable: boolean } | undefined
  const editor = createMidiEditorPersistence({
    projectId: project.id,
    clipId: clip.id,
    onError: (value) => { error = value },
  })
  editor.enqueue({ kind: 'update', id: 'one', changes: { pitch: 64 } })
  await repository.deleteClip(clip.id)

  await editor.flush()
  await editor.flush()
  editor.dispose()

  expect(error).toEqual(expect.objectContaining({ retryable: false }))
  expect(editor.pendingOperations()).toEqual([])
})
