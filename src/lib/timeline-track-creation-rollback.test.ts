import { expect, test } from 'bun:test'
import 'fake-indexeddb/auto'
import { buildTimelineTrackRow } from '~/lib/timeline-repository/track-row-builder'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { toLocalTimelineTrack } from '~/lib/timeline-repository/track-row-adapter'
import { applyCreatedTrackInsertion } from './timeline-track-creation-rollback'

test('rolls back a failed local insertion in persistence and projection', async () => {
  const projectId = `project:track-rollback-${crypto.randomUUID()}`
  const repository = createLocalTimelineRepository(projectId)
  const row = await repository.createTrack({ id: 'created-track', kind: 'audio' })
  const track = toLocalTimelineTrack(row)
  const removed: string[] = []

  expect(await applyCreatedTrackInsertion({
    projectId,
    track,
    apply: () => false,
    removeLocalTrack: (trackId) => removed.push(trackId),
    removeCloudTrack: async () => {
      throw new Error('cloud rollback should not run')
    },
  })).toBe(false)

  expect(removed).toEqual([track.id])
  expect((await repository.loadSnapshot()).tracks).toEqual([])
})

test('rolls back a failed cloud insertion without touching unrelated tracks', async () => {
  const track = toLocalTimelineTrack(buildTimelineTrackRow({
    id: 'created-cloud-track',
    index: 0,
    timestamp: 1,
  }))
  const removed: string[] = []

  expect(await applyCreatedTrackInsertion({
    projectId: 'cloud-project',
    track,
    apply: async () => {
      throw new Error('insert failed')
    },
    removeLocalTrack: (trackId) => removed.push(trackId),
    removeCloudTrack: async (removedTrack) => {
      removed.push(removedTrack.id)
    },
  })).toBe(false)

  expect(removed).toEqual([track.id])
})

test('preserves a successfully applied insertion', async () => {
  const track = toLocalTimelineTrack(buildTimelineTrackRow({
    id: 'successful-track',
    index: 0,
    timestamp: 1,
  }))
  let rollbackCalled = false

  expect(await applyCreatedTrackInsertion({
    projectId: 'cloud-project',
    track,
    apply: () => true,
    removeLocalTrack: () => {
      rollbackCalled = true
    },
    removeCloudTrack: async () => {
      rollbackCalled = true
    },
  })).toBe(true)

  expect(rollbackCalled).toBe(false)
})
