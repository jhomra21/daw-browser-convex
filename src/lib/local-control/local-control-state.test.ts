import 'fake-indexeddb/auto'
import { afterEach, expect, test } from 'bun:test'

import {
  createLocalProjectEntityRow,
  createLocalProject,
  getProjectDbName,
  openLocalProjectDb,
} from '~/lib/local-project-db'
import { buildTimelineTrackRow } from '~/lib/timeline-repository/track-row-builder'
import { createMidiEditorPersistence } from '~/lib/midi/editor-persistence'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { withLocalControlTransaction } from './local-control-state'
import { resetHermeticBrowserEnvironment } from '~/lib/test/hermetic-browser-environment'

afterEach(resetHermeticBrowserEnvironment)

const openNativeDb = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(name)
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

test('serializes reconciliation after an independent connection changes semantic rows', async () => {
  const project = await createLocalProject(`Control ${crypto.randomUUID()}`)
  const first = await withLocalControlTransaction(project.id, 'readonly', (result) => result.state)
  const second = await withLocalControlTransaction(project.id, 'readonly', (result) => result.state)
  expect(first.revision).toBe(0)
  expect(second).toEqual(first)

  const track = buildTimelineTrackRow({ id: 'track-drift', index: 1, timestamp: 2 })
  const firstConnection = await openNativeDb(getProjectDbName(project.id))
  const writeTransaction = firstConnection.transaction('entities', 'readwrite')
  writeTransaction.objectStore('entities').put(createLocalProjectEntityRow('track', track.id, track, 2))
  await new Promise<void>((resolve, reject) => {
    writeTransaction.oncomplete = () => resolve()
    writeTransaction.onerror = () => reject(writeTransaction.error)
  })
  firstConnection.close()

  const [left, right] = await Promise.all([
    withLocalControlTransaction(project.id, 'readonly', (result) => result.state),
    withLocalControlTransaction(project.id, 'readonly', (result) => result.state),
  ])
  expect(left.revision).toBe(1)
  expect(right.revision).toBe(1)
  expect(left.digest).toBe(right.digest)

  const secondConnection = await openNativeDb(getProjectDbName(project.id))
  const readTransaction = secondConnection.transaction('controlState', 'readonly')
  const result = await new Promise<unknown>((resolve, reject) => {
    const request = readTransaction.objectStore('controlState').get('snapshot')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  secondConnection.close()
  expect(result).toEqual(expect.objectContaining({
    value: expect.objectContaining({ revision: 1, digest: left.digest }),
  }))
})

test('aborts callback failures and thenables without advancing the control revision', async () => {
  const project = await createLocalProject(`Control rollback ${crypto.randomUUID()}`)
  await expect(withLocalControlTransaction(project.id, 'readonly', () => {
    throw new Error('callback failed')
  })).rejects.toThrow('callback failed')

  const db = await openLocalProjectDb(project.id)
  expect(await db.get('controlState', 'snapshot')).toBeUndefined()

  const thenable = {}
  Object.defineProperty(thenable, String.fromCharCode(116, 104, 101, 110), { value: () => undefined })
  await expect(withLocalControlTransaction(project.id, 'readonly', () => thenable))
    .rejects.toThrow('synchronous callbacks')
  expect(await db.get('controlState', 'snapshot')).toBeUndefined()

  const state = await withLocalControlTransaction(project.id, 'readonly', (result) => result.state)
  expect(state.revision).toBe(0)
})

test('fails closed when an existing control state row is malformed', async () => {
  const project = await createLocalProject(`Control corruption ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  const valid = {
    key: 'snapshot',
    value: {
      version: 1,
      revision: 1,
      digest: 'a'.repeat(64),
      updatedAt: 1,
    },
    updatedAt: 1,
  }

  for (const value of [
    { ...valid.value, version: 3 },
    { ...valid.value, revision: -1 },
    { ...valid.value, digest: 'not-a-digest' },
    { ...valid.value, updatedAt: -1 },
  ]) {
    await db.put('controlState', { ...valid, value })
    await expect(withLocalControlTransaction(project.id, 'readonly', () => undefined))
      .rejects.toMatchObject({ kind: 'corruption' })
    expect(await db.get('controlState', 'snapshot')).toEqual({ ...valid, value })
  }
})

test('flushes pending MIDI before queuing a generic control transaction', async () => {
  const project = await createLocalProject(`Control MIDI ordering ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const track = await repository.createTrack({ id: 'midi-track', kind: 'instrument' })
  await repository.createClip({
    id: 'midi-clip',
    trackId: track.id,
    startSec: 0,
    duration: 1,
    midi: { wave: 'sine', notes: [{ id: 'note', beat: 0, length: 1, pitch: 60 }] },
  })
  const persistence = createMidiEditorPersistence({ projectId: project.id, clipId: 'midi-clip' })
  persistence.enqueue({ kind: 'update', id: 'note', changes: { pitch: 64 } })

  const snapshot = await withLocalControlTransaction(project.id, 'readonly', (context) => context.snapshot)
  persistence.dispose()

  expect(snapshot.clips[0]?.midi?.notes[0]?.pitch).toBe(64)
})

test('migrates a matching V1 digest state to V2 without advancing the revision', async () => {
  const project = await createLocalProject(`Control V1 digest migration ${crypto.randomUUID()}`)
  const initial = await withLocalControlTransaction(project.id, 'readonly', (result) => result.state)
  const db = await openLocalProjectDb(project.id)
  await db.put('controlState', {
    key: 'snapshot',
    value: {
      version: 1,
      revision: initial.revision,
      digest: initial.digest,
      updatedAt: initial.updatedAt,
    },
    updatedAt: initial.updatedAt,
  })

  const migrated = await withLocalControlTransaction(project.id, 'readonly', (result) => result.state)
  expect(migrated).toEqual({
    version: 2,
    revision: initial.revision,
    digest: initial.digest,
    updatedAt: initial.updatedAt,
  })
  expect(await db.get('controlState', 'snapshot')).toEqual({
    key: 'snapshot',
    value: migrated,
    updatedAt: initial.updatedAt,
  })
})
