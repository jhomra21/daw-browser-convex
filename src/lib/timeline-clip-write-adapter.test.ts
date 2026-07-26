import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { createLocalTimelineRepository } from './timeline-repository/local-timeline-repository'
import { createTimelineClipWriteAdapter } from './timeline-clip-write-adapter'

test('setFades normalizes against the local repository duration, not a caller projection', async () => {
  const projectId = 'project:fade-authoritative-duration'
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'track-1' })
  await repository.createClip({
    id: 'clip-1',
    trackId: 'track-1',
    startSec: 0,
    duration: 10,
  })

  const applied = await createTimelineClipWriteAdapter({ projectId, userId: undefined }).setFades('clip-1', {
    fadeInSec: 8,
    fadeOutSec: 8,
    fadeInCurve: 0,
    fadeOutCurve: 0,
  })

  expect(applied).toBe(true)
  expect((await repository.loadSnapshot()).clips[0]?.fades).toMatchObject({
    fadeInSec: 8,
    fadeOutSec: 2,
  })
})

test('deleteClips exposes permanent shared rejection without reporting optimistic removals', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => new Response('clip no longer exists', { status: 400 }),
    { preconnect: originalFetch.preconnect },
  )
  try {
    await expect(createTimelineClipWriteAdapter({
      projectId: `shared-delete-rejection-${crypto.randomUUID()}`,
      userId: 'user-1',
    }).deleteClips(['clip-1'])).rejects.toThrow(
      'Permanent failure: Shared timeline operation failed: 400 clip no longer exists',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
