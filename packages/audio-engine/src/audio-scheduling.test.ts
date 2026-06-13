import { describe, expect, test } from 'bun:test'
import { getAudioBufferPlaybackDurationSec, getAudioClipTimeMap } from './audio-scheduling'

describe('audio clip playback duration', () => {
  test('uses source duration for repitch source-buffer playback', () => {
    const map = getAudioClipTimeMap({
      clip: {
        startSec: 0,
        duration: 4,
        audioWarp: {
          enabled: true,
          mode: 'repitch',
          sourceBpm: 60,
        },
      },
      bufferDurationSec: 20,
      projectBpm: 120,
      rangeStartSec: 0,
      rangeEndSec: 4,
    })

    expect(map).not.toBeNull()
    if (!map) return

    expect(map.timelineDurationSec).toBe(4)
    expect(map.sourceDurationSec).toBe(8)
    expect(getAudioBufferPlaybackDurationSec({ map })).toBe(8)
  })

  test('uses rendered buffer duration for ready stretch playback', () => {
    const map = getAudioClipTimeMap({
      clip: {
        startSec: 0,
        duration: 4,
        audioWarp: {
          enabled: true,
          mode: 'stretch',
          sourceBpm: 60,
        },
      },
      bufferDurationSec: 20,
      projectBpm: 120,
      rangeStartSec: 0,
      rangeEndSec: 4,
    })

    expect(map).not.toBeNull()
    if (!map) return

    expect(map.sourceDurationSec).toBe(8)
    expect(getAudioBufferPlaybackDurationSec({
      map,
      stretchedDurationSec: 4,
    })).toBe(4)
  })
})
