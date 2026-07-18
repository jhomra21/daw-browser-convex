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
