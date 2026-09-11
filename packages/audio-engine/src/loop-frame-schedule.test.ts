import { expect, test } from 'bun:test'
import {
  arrangementFrameForLoop,
  loopFramesForTransport,
  splitLoopScheduleRange,
} from './loop-frame-schedule'

test('maps transport loops to safe frame boundaries without duration-sized allocation', () => {
  const loop = loopFramesForTransport({
    loopEnabled: true,
    loopStartSec: 2,
    loopEndSec: 4.5,
  }, 48_000)

  expect(loop).toEqual({ startFrame: 96_000, endFrame: 216_000, lengthFrames: 120_000 })
  expect(arrangementFrameForLoop(95_999, loop)).toBe(95_999)
  expect(arrangementFrameForLoop(216_000, loop)).toBe(96_000)
  expect(arrangementFrameForLoop(336_001, loop)).toBe(96_001)
})

test('rejects malformed loop ranges', () => {
  expect(loopFramesForTransport({
    loopEnabled: true,
    loopStartSec: 4,
    loopEndSec: 4,
  }, 48_000)).toBeUndefined()
  expect(loopFramesForTransport({
    loopEnabled: false,
    loopStartSec: 0,
    loopEndSec: 1,
  }, 48_000)).toBeUndefined()
})

test('splits loop windows into contiguous native slices', () => {
  const loop = loopFramesForTransport({
    loopEnabled: true,
    loopStartSec: 2,
    loopEndSec: 4,
  }, 10)
  expect(loop).toBeDefined()
  expect(splitLoopScheduleRange(0, 80, loop)).toEqual([
    { nativeStartFrame: 0, nativeEndFrame: 20, arrangementStartFrame: 0, arrangementEndFrame: 20, iteration: 0 },
    { nativeStartFrame: 20, nativeEndFrame: 40, arrangementStartFrame: 20, arrangementEndFrame: 40, iteration: 1 },
    { nativeStartFrame: 40, nativeEndFrame: 60, arrangementStartFrame: 20, arrangementEndFrame: 40, iteration: 2 },
    { nativeStartFrame: 60, nativeEndFrame: 80, arrangementStartFrame: 20, arrangementEndFrame: 40, iteration: 3 },
  ])
})
