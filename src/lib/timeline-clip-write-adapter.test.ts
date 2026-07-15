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
