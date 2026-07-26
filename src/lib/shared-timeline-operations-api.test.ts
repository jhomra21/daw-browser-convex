import { expect, test } from 'bun:test'
import {
  publishSharedTimelineOperation,
  SharedTimelineOperationRejectedError,
} from './shared-timeline-operations-api'

const respondWith = (result: unknown): typeof fetch => (
  Object.assign(
    async () => new Response(JSON.stringify(result), { status: 200 }),
    { preconnect: globalThis.fetch.preconnect },
  )
)

test('rejects a null clip create result', async () => {
  const fetch = respondWith(null)

  await expect(publishSharedTimelineOperation('project-1', {
    kind: 'clips.create',
    payload: {
      trackId: 'track-1',
      startSec: 0,
      duration: 1,
      operationId: 'operation-1',
    },
  }, { fetch })).rejects.toEqual(new SharedTimelineOperationRejectedError('Clip creation was rejected.'))
})

test('rejects null items in a clip createMany result', async () => {
  const fetch = respondWith(['clip-1', null])

  await expect(publishSharedTimelineOperation('project-1', {
    kind: 'clips.createMany',
    payload: {
      items: [
        { trackId: 'track-1', startSec: 0, duration: 1 },
        { trackId: 'track-1', startSec: 1, duration: 1 },
      ],
      operationId: 'operation-1',
    },
  }, { fetch })).rejects.toEqual(new SharedTimelineOperationRejectedError('One or more clip creations were rejected.'))
})

test('preserves null results for operations whose contract permits them', async () => {
  const fetch = respondWith(null)

  await expect(publishSharedTimelineOperation('project-1', {
    kind: 'tracks.lock',
    payload: { trackId: 'track-1' },
  }, { fetch })).resolves.toBeNull()
})
