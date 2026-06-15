import { describe, expect, test } from 'bun:test'
import { getAudioBufferPlaybackDurationSec, getAudioClipTimeMap } from './audio-scheduling'
import { clipSchedulerTestInternals } from './clip-scheduler'

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

  test('applies positive source beat offset as leading silence without changing clip duration', () => {
    const map = getAudioClipTimeMap({
      clip: {
        startSec: 10,
        duration: 4,
        audioWarp: {
          enabled: true,
          mode: 'repitch',
          sourceBpm: 120,
          sourceBeatOffset: 1,
        },
      },
      bufferDurationSec: 20,
      projectBpm: 120,
      rangeStartSec: 10,
      rangeEndSec: 14,
    })

    expect(map).not.toBeNull()
    if (!map) return

    expect(map.timelineStartSec).toBe(10.5)
    expect(map.timelineEndSec).toBe(14)
    expect(map.sourceStartSec).toBe(0)
    expect(map.sourceDurationSec).toBe(3.5)
  })

  test('applies positive source beat offset before an existing buffer offset', () => {
    const map = getAudioClipTimeMap({
      clip: {
        startSec: 10,
        duration: 4,
        bufferOffsetSec: 2,
        audioWarp: {
          enabled: true,
          mode: 'repitch',
          sourceBpm: 120,
          sourceBeatOffset: 1,
        },
      },
      bufferDurationSec: 20,
      projectBpm: 120,
      rangeStartSec: 10,
      rangeEndSec: 14,
    })

    expect(map).not.toBeNull()
    if (!map) return

    expect(map.timelineStartSec).toBe(10.5)
    expect(map.sourceStartSec).toBe(2)
    expect(map.sourceDurationSec).toBe(3.5)
  })

  test('applies negative source beat offset as a source-domain trim without changing clip duration', () => {
    const map = getAudioClipTimeMap({
      clip: {
        startSec: 10,
        duration: 4,
        audioWarp: {
          enabled: true,
          mode: 'stretch',
          sourceBpm: 120,
          sourceBeatOffset: -2,
        },
      },
      bufferDurationSec: 20,
      projectBpm: 120,
      rangeStartSec: 10,
      rangeEndSec: 14,
    })

    expect(map).not.toBeNull()
    if (!map) return

    expect(map.timelineStartSec).toBe(10)
    expect(map.timelineEndSec).toBe(14)
    expect(map.sourceStartSec).toBe(1)
    expect(map.sourceDurationSec).toBe(4)
  })

  test('ignores preserved source beat offset when warp is disabled', () => {
    const map = getAudioClipTimeMap({
      clip: {
        startSec: 0,
        duration: 4,
        audioWarp: {
          enabled: false,
          mode: 'repitch',
          sourceBpm: 120,
          sourceBeatOffset: 1,
        },
      },
      bufferDurationSec: 20,
      projectBpm: 120,
      rangeStartSec: 0,
      rangeEndSec: 4,
    })

    expect(map).not.toBeNull()
    if (!map) return

    expect(map.timelineStartSec).toBe(0)
    expect(map.sourceStartSec).toBe(0)
    expect(map.sourceDurationSec).toBe(4)
    expect(map.mode).toBe('raw')
  })
})

describe('clip scheduler stretch horizon', () => {
  test('includes stretch clips inside the live render horizon', () => {
    expect(clipSchedulerTestInternals.shouldScheduleStretchSource({
      playheadSec: 10,
      renderAheadSec: 30,
      timelineStartSec: 39,
      timelineDurationSec: 4,
    })).toBe(true)
  })

  test('excludes stretch clips beyond the live render horizon', () => {
    expect(clipSchedulerTestInternals.shouldScheduleStretchSource({
      playheadSec: 10,
      renderAheadSec: 30,
      timelineStartSec: 40,
      timelineDurationSec: 4,
    })).toBe(false)
  })

  test('uses requested end limit before stretch render horizon', () => {
    expect(clipSchedulerTestInternals.shouldScheduleStretchSource({
      playheadSec: 10,
      renderAheadSec: 30,
      endLimitSec: 20,
      timelineStartSec: 20,
      timelineDurationSec: 4,
    })).toBe(false)
  })
})
