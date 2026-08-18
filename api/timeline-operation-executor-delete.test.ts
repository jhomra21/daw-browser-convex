import { expect, test } from 'bun:test'

import { executeTimelineOperation, TimelineOperationTargetError } from './timeline-operation-executor'

const removeOperation = {
  kind: 'clips.removeMany',
  payload: {
    clipIds: ['deleted-clip-1'],
    operationId: 'delete-operation-1',
  },
}

test('delete retries reach the receipt-aware mutation before target validation', async () => {
  let queries = 0
  let mutations = 0
  const receipt = {
    removedClipIds: ['deleted-clip-1'],
    recoveries: [{ sourceClipId: 'deleted-clip-1', recoveryId: 'recovery-1' }],
    skippedClipIds: [],
    skipped: [],
  }
  const result = await executeTimelineOperation({
    projectId: 'project-1',
    convex: {
      query: async () => {
        queries += 1
        return { tracks: [], clips: [] }
      },
      mutation: async () => {
        mutations += 1
        return receipt
      },
    },
  }, removeOperation)

  expect(result).toEqual(receipt)
  expect(queries).toBe(0)
  expect(mutations).toBe(1)
})

test('a new delete propagates the strict mutation rejection without a post-validation query', async () => {
  const rejection = new Error('Clip deletion target was not found.')
  const promise = executeTimelineOperation({
    projectId: 'project-1',
    convex: {
      query: async () => {
        throw new Error('Delete target preflight should be deferred to the mutation.')
      },
      mutation: async () => { throw rejection },
    },
  }, removeOperation)

  await expect(promise).rejects.toBe(rejection)
})

test('classifies locked-track clip deletion as terminal forbidden', async () => {
  const promise = executeTimelineOperation({
    projectId: 'project-1',
    convex: {
      query: async () => ({ tracks: [], clips: [] }),
      mutation: async () => {
        throw new Error('Actor cannot delete clips on a locked track.')
      },
    },
  }, removeOperation)

  await expect(promise).rejects.toMatchObject({
    name: TimelineOperationTargetError.name,
    status: 403,
    message: 'Actor cannot delete clips on a locked track.',
  })
})
