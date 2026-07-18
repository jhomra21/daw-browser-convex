import { parseSharedTimelineOperation } from '@daw-browser/shared'

import { buildClipFadesMutationArgs, buildClipMidiMutationArgs, buildRestoreChainMutationArgs, buildTrackCreateMutationArgs } from './timeline-operation-executor'

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

test('forwards name and collapsed state when creating a track', () => {
  const operation = parseSharedTimelineOperation({
    kind: 'tracks.create',
    payload: {
      name: 'Named return',
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
    name: 'Named return',
    index: 2,
    kind: 'audio',
    channelRole: 'return',
    collapsed: false,
    color: '#22c55e',
    operationId: 'create-1',
  })
})

test('forwards a parsed fade operation to the clips.setFades mutation', () => {
  const operation = parseSharedTimelineOperation({
    kind: 'clips.setFades',
    payload: {
      clipId: 'clip-1',
      fades: {
        fadeInSec: 1,
        fadeOutSec: 2,
        fadeInCurve: 0.5,
        fadeOutCurve: -0.5,
      },
    },
  })
  if (!operation || operation.kind !== 'clips.setFades') {
    throw new Error('Expected clip-fades operation to parse')
  }

  const expected: ReturnType<typeof buildClipFadesMutationArgs> = {
    clipId: 'clip-1',
    fades: {
      fadeInStartSec: 0,
      fadeInSec: 1,
      fadeOutSec: 2,
      fadeOutEndSec: 0,
      fadeInCurve: 0.5,
      fadeOutCurve: -0.5,
      fadeInCurvePosition: 0.5,
      fadeOutCurvePosition: 0.5,
    },
  }

  expect(buildClipFadesMutationArgs(operation.payload)).toEqual(expected)
})

test('forwards a parsed durable MIDI operation to the server mutation', () => {
  const operation = parseSharedTimelineOperation({
    kind: 'clips.setMidi',
    payload: {
      clipId: 'clip-1',
      operationId: 'midi-1',
      midi: { wave: 'sine', notes: [{ beat: 0, length: 1, pitch: 60 }] },
    },
  })
  if (!operation || operation.kind !== 'clips.setMidi') throw new Error('Expected MIDI operation to parse')
  expect(buildClipMidiMutationArgs('project-1', operation.payload)).toEqual({
    projectId: 'project-1',
    clipId: 'clip-1',
    operationId: 'midi-1',
    midi: { wave: 'sine', notes: [{ beat: 0, length: 1, pitch: 60 }] },
  })
})
