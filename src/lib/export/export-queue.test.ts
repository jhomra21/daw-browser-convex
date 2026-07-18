import { expect, test } from 'bun:test'

import { createExportQueue } from '~/lib/export/export-queue'

test('shares one serial queue with progress, status, and cancellation', async () => {
  const queue = createExportQueue(() => 'job-1')
  const statuses: string[] = []
  const unsubscribe = queue.subscribe((job) => statuses.push(job?.progress?.phase ?? 'idle'))
  let releaseFirst: (() => void) | undefined
  const first = queue.enqueue({ name: 'first' }, async (signal, progress) => {
    progress({ phase: 'rendering' })
    await new Promise<void>((resolve) => { releaseFirst = resolve })
    return signal.aborted ? { type: 'canceled', outputs: [] } : { type: 'success', outputs: [] }
  })
  const second = queue.enqueue({ name: 'second' }, async () => ({ type: 'success', outputs: [] }))

  await Promise.resolve()
  expect(queue.activeJob()?.name).toBe('first')
  queue.cancel('job-1')
  releaseFirst?.()
  expect((await first).type).toBe('canceled')
  expect((await second).type).toBe('success')
  expect(statuses).toEqual(['idle', 'idle', 'rendering', 'idle', 'idle', 'idle'])
  unsubscribe()
})

test('submits a synchronously addressable serial job', async () => {
  let nextId = 0
  const queue = createExportQueue(() => `job-${++nextId}`)
  let release: (() => void) | undefined
  const first = queue.submit({ name: 'first' }, async (signal) => {
    await new Promise<void>((resolve) => { release = resolve })
    return signal.aborted ? { type: 'canceled', outputs: [] } : { type: 'success', outputs: [] }
  })
  const second = queue.submit({ name: 'second' }, async () => ({ type: 'success', outputs: [] }))

  expect(first.id).toBe('job-1')
  expect(second.id).toBe('job-2')
  await Promise.resolve()
  first.cancel()
  release?.()
  expect((await first.completion).type).toBe('canceled')
  expect((await second.completion).type).toBe('success')
})

test('cancels queued work before it opens an output target', async () => {
  let nextId = 0
  const queue = createExportQueue(() => `job-${++nextId}`)
  let release: (() => void) | undefined
  const first = queue.submit({ name: 'first' }, async () => {
    await new Promise<void>((resolve) => { release = resolve })
    return { type: 'success', outputs: [] }
  })
  let ran = false
  const second = queue.submit({ name: 'second' }, async () => {
    ran = true
    return { type: 'success', outputs: [] }
  })
  second.cancel()
  await Promise.resolve()
  release?.()
  await first.completion
  expect(await second.completion).toEqual({ type: 'canceled', outputs: [] })
  expect(ran).toBeFalse()
})
