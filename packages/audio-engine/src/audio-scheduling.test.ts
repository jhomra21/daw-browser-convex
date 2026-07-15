import { describe, expect, test } from 'bun:test'
import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { getAudioBufferPlaybackDurationSec, getClipFadeSchedulePlan } from './audio-scheduling'
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

describe('clip fade scheduling', () => {
  test('uses timeline positions for a clipped playback window', () => {
    const plan = getClipFadeSchedulePlan({
      fades: { fadeInSec: 4, fadeOutSec: 2, fadeInCurve: 0, fadeOutCurve: 0 },
      clipStartSec: 10,
      clipDurationSec: 10,
      timelineStartSec: 12,
      timelineEndSec: 19,
      contextStartTime: 3,
      gain: 0.5,
    })
    expect(plan[0]).toEqual({ time: 3, gain: 0.25 })
    expect(plan.at(-1)).toEqual({ time: 10, gain: 0.25 })
    expect(plan.some((point) => point.time === 5 && point.gain === 0.5)).toBe(true)
  })

  test('starts inside a fade at the evaluated gain and skips empty windows', () => {
    const plan = getClipFadeSchedulePlan({
      fades: { fadeInSec: 4, fadeOutSec: 0, fadeInCurve: 0, fadeOutCurve: 0 },
      clipStartSec: 10,
      clipDurationSec: 8,
      timelineStartSec: 12,
      timelineEndSec: 14,
      contextStartTime: 1,
      gain: 0.5,
    })
    expect(plan[0]).toEqual({ time: 1, gain: 0.25 })
    expect(getClipFadeSchedulePlan({
      fades: undefined,
      clipStartSec: 10,
      clipDurationSec: 2,
      timelineStartSec: 20,
      timelineEndSec: 21,
      contextStartTime: 0,
      gain: 1,
    })).toEqual([])
  })

  test('holds silence outside moved fade endpoints', () => {
    const plan = getClipFadeSchedulePlan({
      fades: {
        fadeInStartSec: 2,
        fadeInSec: 4,
        fadeOutSec: 3,
        fadeOutEndSec: 1,
        fadeInCurve: 0,
        fadeOutCurve: 0,
        fadeInCurvePosition: 0.5,
        fadeOutCurvePosition: 0.5,
      },
      clipStartSec: 10,
      clipDurationSec: 10,
      timelineStartSec: 10,
      timelineEndSec: 20,
      contextStartTime: 0,
      gain: 1,
    })
    expect(plan.find((point) => point.time === 2)?.gain).toBe(0)
    expect(plan.find((point) => point.time === 4)?.gain).toBe(1)
    expect(plan.find((point) => point.time === 7)?.gain).toBe(1)
    expect(plan.find((point) => point.time === 9)?.gain).toBe(0)
  })
})
