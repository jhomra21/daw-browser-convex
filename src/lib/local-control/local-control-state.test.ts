import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import {
  createLocalProjectEntityRow,
  createLocalProject,
  getProjectDbName,
  openLocalProjectDb,
} from '~/lib/local-project-db'
import { buildTimelineTrackRow } from '~/lib/timeline-repository/track-row-builder'
import { withLocalControlTransaction } from './local-control-state'

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
    { ...valid.value, version: 2 },
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
