import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import {
  acquireLocalEntityWriteQueue,
  getAllLocalEntityWriteQueues,
  getLocalEntityWriteQueue,
  getLocalEntityWriteQueueIfCreated,
} from '~/lib/local-write-queue'

const row = (id: string, name: string) => createLocalProjectEntityRow('track', id, { name })

const failTransactions = (db: Awaited<ReturnType<typeof openLocalProjectDb>>) => {
  const original = db.transaction.bind(db)
  Object.defineProperty(db, 'transaction', {
    configurable: true,
    value: () => { throw new Error('IndexedDB write failed.') },
  })
  return () => Object.defineProperty(db, 'transaction', { configurable: true, value: original })
}

test('an unheld queue leaves the registry once its writes are durable', async () => {
  const projectId = `project:queue-idle-${crypto.randomUUID()}`
  const db = await openLocalProjectDb(projectId)
  const queue = getLocalEntityWriteQueue(projectId)
  queue.schedulePut(row('a', 'A'))
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBe(queue)

  await queue.flush()

  expect(await db.get('entities', ['track', 'a'])).toMatchObject({ value: { name: 'A' } })
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()
})

test('a failed write keeps its queue registered, and a reopen shares it so a newer write supersedes the retry', async () => {
  const projectId = `project:queue-failed-${crypto.randomUUID()}`
  const db = await openLocalProjectDb(projectId)
  const restore = failTransactions(db)
  const queue = getLocalEntityWriteQueue(projectId)
  queue.schedulePut(row('a', 'old'))
  await expect(queue.flush()).rejects.toThrow('IndexedDB write failed.')

  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBe(queue)
  expect(getAllLocalEntityWriteQueues()).toContain(queue)
  const reopened = getLocalEntityWriteQueue(projectId)
  expect(reopened).toBe(queue)
  reopened.schedulePut(row('a', 'new'))
  restore()
  await reopened.flush()

  expect(await db.get('entities', ['track', 'a'])).toMatchObject({ value: { name: 'new' } })
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()
})

test('a reopen during an in-flight flush shares the queue and its later write is not dropped', async () => {
  const projectId = `project:queue-reopen-${crypto.randomUUID()}`
  const db = await openLocalProjectDb(projectId)
  const queue = getLocalEntityWriteQueue(projectId)
  queue.schedulePut(row('a', 'A'))
  const flushing = queue.flush()
  const reopened = getLocalEntityWriteQueue(projectId)
  reopened.schedulePut(row('b', 'B'))
  await flushing
  await reopened.flush()

  expect(reopened).toBe(queue)
  expect(await db.get('entities', ['track', 'a'])).toBeDefined()
  expect(await db.get('entities', ['track', 'b'])).toBeDefined()
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()
})

test('a held queue stays registered until its last holder lets go', async () => {
  const projectId = `project:queue-holders-${crypto.randomUUID()}`
  await openLocalProjectDb(projectId)
  const first = acquireLocalEntityWriteQueue(projectId)
  const second = acquireLocalEntityWriteQueue(projectId)
  expect(second.queue).toBe(first.queue)
  first.queue.schedulePut(row('a', 'A'))
  await first.queue.flush()

  first.release()
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBe(first.queue)
  first.release()
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBe(first.queue)
  second.release()
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()
})

test('letting go with writes pending flushes them first and then releases', async () => {
  const projectId = `project:queue-last-holder-${crypto.randomUUID()}`
  const db = await openLocalProjectDb(projectId)
  const { queue, release } = acquireLocalEntityWriteQueue(projectId)
  queue.schedulePut(row('a', 'A'))

  release()
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBe(queue)
  await queue.flush()

  expect(await db.get('entities', ['track', 'a'])).toBeDefined()
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()
})

test('a failed write outlives its last holder and is retried before release', async () => {
  const projectId = `project:queue-held-failed-${crypto.randomUUID()}`
  const db = await openLocalProjectDb(projectId)
  const { queue, release } = acquireLocalEntityWriteQueue(projectId)
  const restore = failTransactions(db)
  queue.schedulePut(row('a', 'A'))
  await expect(queue.flush()).rejects.toThrow('IndexedDB write failed.')

  release()
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBe(queue)
  restore()
  await queue.flush()

  expect(await db.get('entities', ['track', 'a'])).toBeDefined()
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()
})

test('a repository held across a release keeps writing through the one registered queue', async () => {
  const projectId = `project:queue-repository-${crypto.randomUUID()}`
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'track' })
  await repository.createClip({ id: 'clip', trackId: 'track', startSec: 0, duration: 4 })
  await repository.updateClip({ clipId: 'clip', startSec: 1 })
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()

  await repository.updateClip({ clipId: 'clip', startSec: 2 })
  await repository.moveClips([{ clipId: 'clip', trackId: 'track', startSec: 3 }])

  expect((await repository.loadSnapshot()).clips[0]?.startSec).toBe(3)
  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()
})

test('reading through a repository does not register a queue', async () => {
  const projectId = `project:queue-read-${crypto.randomUUID()}`
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'track' })
  await repository.loadSnapshot()
  await repository.updateTrack({ trackId: 'missing', name: 'x' }).catch(() => undefined)

  expect(getLocalEntityWriteQueueIfCreated(projectId)).toBeUndefined()
})
