import { expect, test } from 'bun:test'

import { clearClipMovePatch, reconcileTimelineProjectionSnapshot } from './useTimelineProjectionState'

test('clears a reflected committed fade patch without affecting other projection state', () => {
  const fades = { fadeInSec: 1, fadeOutSec: 2, fadeInCurve: 0.5, fadeOutCurve: -0.5 }
  const pendingTrackEntriesById = new Map()
  const pendingClipCreatesById = new Map()
  const removedTrackIds = new Set<string>()
  const removedClipIds = new Set<string>()
  const pendingTrackLocksById = new Map()

  const next = reconcileTimelineProjectionSnapshot({
    committedClipEditsById: new Map([['clip-1', { fades }]]),
    pendingTrackEntriesById,
    pendingClipCreatesById,
    removedTrackIds,
    removedClipIds,
    pendingTrackLocksById,
  }, {
    tracks: [],
    clips: [{
      _id: 'clip-1',
      trackId: 'track-1',
      startSec: 0,
      duration: 4,
      fades,
    }],
  })

  expect(next.committedClipEditsById).toEqual(new Map())
  expect(next.pendingTrackEntriesById).toBe(pendingTrackEntriesById)
  expect(next.pendingClipCreatesById).toBe(pendingClipCreatesById)
  expect(next.removedTrackIds).toBe(removedTrackIds)
  expect(next.removedClipIds).toBe(removedClipIds)
  expect(next.pendingTrackLocksById).toBe(pendingTrackLocksById)
})

test('retains a fade draft when clearing unrelated move fields', () => {
  const fades = { fadeInSec: 1, fadeOutSec: 2, fadeInCurve: 0.5, fadeOutCurve: -0.5 }

  expect(clearClipMovePatch({
    trackId: 'track-2',
    startSec: 3,
    fades,
  })).toEqual({ fades })
})
