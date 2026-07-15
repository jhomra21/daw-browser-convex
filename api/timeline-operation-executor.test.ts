import { parseSharedTimelineOperation } from '@daw-browser/shared'

import { buildRestoreChainMutationArgs, buildTrackCreateMutationArgs } from './timeline-operation-executor'

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

test('forwards collapsed state when creating a track', () => {
  const operation = parseSharedTimelineOperation({
    kind: 'tracks.create',
    payload: {
      index: 2,
      kind: 'audio',
      channelRole: 'return',
      collapsed: false,
      color: '#22c55e',
      operationId: 'create-1',
    },
  })
  if (!operation || operation.kind !== 'tracks.create') {
    throw new Error('Expected track-create operation to parse')
  }

  expect(buildTrackCreateMutationArgs('project-1', operation.payload)).toEqual({
    projectId: 'project-1',
    index: 2,
    kind: 'audio',
    channelRole: 'return',
    collapsed: false,
    color: '#22c55e',
    operationId: 'create-1',
  })
})
