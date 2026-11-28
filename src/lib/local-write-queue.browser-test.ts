import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { getLocalEntityWriteQueue, getLocalEntityWriteQueueIfCreated, releaseLocalEntityWriteQueue } from '~/lib/local-write-queue'

test('local entity queue reports saving, failed, then saved after durable flush', async () => {
  const projectId = `project:write-queue-${crypto.randomUUID()}`
  const db = await openLocalProjectDb(projectId)
  const originalTransaction = db.transaction.bind(db)
  const queue = getLocalEntityWriteQueue(projectId)
  const states: string[] = []
  queue.subscribe((status) => states.push(status))
  queue.schedulePut(createLocalProjectEntityRow('track', 'track-1', { name: 'Track' }))
  expect(queue.getStatus()).toBe('saving')

  Object.defineProperty(db, 'transaction', {
    configurable: true,
    value: () => { throw new Error('IndexedDB write failed.') },
  })
  await expect(queue.flush()).rejects.toThrow('IndexedDB write failed.')
  expect(queue.getStatus()).toBe('failed')

  Object.defineProperty(db, 'transaction', {
    configurable: true,
    value: originalTransaction,
  })
  await queue.flush()

  expect(states).toEqual(['saving', 'failed', 'saved'])
  expect(queue.getStatus()).toBe('saved')
  expect(await db.get('entities', ['track', 'track-1'])).toMatchObject({
    kind: 'track',
    id: 'track-1',
    value: { name: 'Track' },
  })
})

test('releasing a project queue flushes pending rows before unregistering it', async () => {
  const projectId = `project:write-queue-release-${crypto.randomUUID()}`
  const db = await openLocalProjectDb(projectId)
  const queue = getLocalEntityWriteQueue(projectId)
  queue.schedulePut(createLocalProjectEntityRow('track', 'track-1', { name: 'Track' }))

  await releaseLocalEntityWriteQueue(projectId)

  expect(await db.get('entities', ['track', 'track-1'])).toMatchObject({
    kind: 'track',
    id: 'track-1',
    value: { name: 'Track' },
  })
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()
})
