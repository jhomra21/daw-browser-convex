import { parseSharedTimelineOperation } from '@daw-browser/shared'

import { buildRestoreChainMutationArgs } from './timeline-operation-executor'

declare function test(name: string, run: () => void): void
declare function expect(value: unknown): {
  toEqual(expected: unknown): void
}

test('forwards a parsed restore-chain payload without transport-only fields', () => {
  const operation = parseSharedTimelineOperation({
    kind: 'effects.restoreChain',
    payload: {
      trackId: 'track-1',
      operationId: 'restore-1',
      audioEffects: [{
        id: 'limiter-1',
        kind: 'limiter',
        params: { version: 1, state: {} },
      }],
    },
  })
  if (!operation || operation.kind !== 'effects.restoreChain') {
    throw new Error('Expected restore-chain operation to parse')
  }

  expect(buildRestoreChainMutationArgs('project-1', operation.payload)).toEqual({
    projectId: 'project-1',
    trackId: 'track-1',
    operationId: 'restore-1',
    audioEffects: [{
      id: 'limiter-1',
      kind: 'limiter',
      params: {
        version: 1,
        state: {
          enabled: true,
          ceilingDbtp: -1,
          releaseMs: 100,
          lookaheadMs: 5,
          link: 1,
          detectorOversampling: 4,
        },
      },
    }],
  })
})
