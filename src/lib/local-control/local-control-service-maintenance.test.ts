import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { createLocalProject } from '~/lib/local-project-db'
import { subscribeToLocalProjectChanges } from '~/lib/local-project-changes'

import { createLocalControlService } from './local-control-service'

test('publishes an applied commit once when no GC work is due', async () => {
  const project = await createLocalProject(`GC maintenance ${crypto.randomUUID()}`)
  const service = createLocalControlService({
    actor: { subject: 'local:00000000-0000-4000-8000-000000000000' },
  })
  let changes = 0
  const unsubscribe = subscribeToLocalProjectChanges(project.id, () => { changes += 1 })
  try {
    const request = {
      version: 'v1' as const,
      projectId: project.id,
      idempotencyKey: 'gc-failure-replay',
      actions: [{ kind: 'project.rename' as const, name: 'Durable despite GC failure' }],
    }
    expect((await service.commit(request)).idempotencyReplay).toBe(false)
    expect(changes).toBe(1)
    expect((await service.commit(request)).idempotencyReplay).toBe(true)
    expect(changes).toBe(1)
  } finally {
    unsubscribe()
  }
})
