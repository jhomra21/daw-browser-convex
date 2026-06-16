import { describe, expect, test } from 'bun:test'

import { calculateAudioLeftResizeTiming } from '~/lib/audio-left-resize-timing'

const createClip = (input = {}) => ({
  id: 'clip',
  name: 'clip.wav',
  startSec: 0,
  duration: 5,
  sourceDurationSec: 5,
  color: '#fff',
  ...input,
})

describe('calculateAudioLeftResizeTiming', () => {
  test('uses the immutable drag baseline for repeated left trims', () => {
    const baselineClip = createClip()
    const firstMove = calculateAudioLeftResizeTiming({
      baselineClip,
      fixedRightSec: 5,
      newStartSec: 1,
      bufferDurationSec: 5,
      projectBpm: 120,
    })
    const secondMove = calculateAudioLeftResizeTiming({
      baselineClip,
      fixedRightSec: 5,
      newStartSec: 2,
      bufferDurationSec: 5,
      projectBpm: 120,
    })

    expect(firstMove.bufferOffsetSec).toBe(1)
    expect(secondMove.bufferOffsetSec).toBe(2)
    expect(secondMove).toMatchObject({
      startSec: 2,
      duration: 3,
      leftPadSec: 0,
    })
  })
})
