import { describe, expect, test } from 'bun:test'
import { clipSchedulerTestInternals, createClipScheduler } from './clip-scheduler'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

const createTrack = (clips: Clip<AudioBuffer>[]): Track<AudioBuffer> => ({
  id: 'track-1',
  name: 'Track 1',
  volume: 1,
  clips,
})

const createAudioClip = (id: string, startSec: number, duration: number): Clip<AudioBuffer> => ({
  id,
  name: id,
  startSec,
  duration,
  color: '#fff',
  buffer: Object.assign(Object.create(null), { duration: 60 }),
  audioWarp: {
    enabled: true,
    mode: 'stretch',
    sourceBpm: 60,
  },
})

const createMidiClip = (id: string, startSec: number): Clip<AudioBuffer> => ({
  id,
  name: id,
  startSec,
  duration: 4,
  color: '#fff',
  midi: {
    wave: 'sine',
    notes: [],
  },
})

const createTestScheduler = (overrides?: {
  getStretchedClip?: (clip: Clip<AudioBuffer>) => null
  scheduleMidiClip?: (track: Track<AudioBuffer>, clip: Clip<AudioBuffer>) => boolean
}) => createClipScheduler({
  getAudioContext: () => Object.assign(Object.create(null), {
    createBufferSource: () => Object.assign(Object.create(null), {
      playbackRate: { value: 1 },
      connect: () => {},
      start: () => {},
    }),
  }),
  getBpm: () => 120,
  timelineToCtxTime: (timelineSec) => timelineSec,
  updateTrackGains: () => {},
  ensureTrackInput: () => Object.create(null),
  stopClipSources: () => {},
  stopSourcesForClip: () => {},
  scheduleMidiClip: overrides?.scheduleMidiClip ?? (() => false),
  ensureStretchedClip: () => {},
  getStretchedClip: overrides?.getStretchedClip ?? (() => null),
  stretchRenderAheadSec: 30,
  sources: {
    add: () => {},
    remove: () => {},
    snapshot: () => [],
    clear: () => {},
    stopClip: () => {},
  },
})

describe('clip scheduler stretch render horizon', () => {
  test('pre-renders all scheduled stretched clips with the default unbounded horizon', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: clipSchedulerTestInternals.defaultStretchRenderAheadSec,
      timelineStartSec: 120,
      timelineDurationSec: 4,
    })).toBe(true)
  })

  test('pre-renders stretched clips inside the live horizon', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: 30,
      timelineStartSec: 35,
      timelineDurationSec: 4,
    })).toBe(true)
  })

  test('does not pre-render stretched clips beyond the live horizon', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: 30,
      timelineStartSec: 40,
      timelineDurationSec: 4,
    })).toBe(false)
  })

  test('uses loop end as the live horizon when it is sooner', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: 30,
      endLimitSec: 24,
      timelineStartSec: 25,
      timelineDurationSec: 4,
    })).toBe(false)
  })

  test('pre-renders stretched clips already overlapping the playhead', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: 30,
      timelineStartSec: 8,
      timelineDurationSec: 4,
    })).toBe(true)
  })
})

describe('clip scheduler append ranges', () => {
  test('includes only entries intersecting the appended window', () => {
    const shouldSchedule = clipSchedulerTestInternals.shouldScheduleEntryInRange

    expect(shouldSchedule({ startSec: 0, endSec: 10 }, 10, 20)).toBe(false)
    expect(shouldSchedule({ startSec: 5, endSec: 12 }, 10, 20)).toBe(true)
    expect(shouldSchedule({ startSec: 20, endSec: 30 }, 10, 20)).toBe(false)
    expect(shouldSchedule({ startSec: 19, endSec: 30 }, 10, 20)).toBe(true)
  })
})

describe('clip scheduler stretch fallback policy', () => {
  test('defers future stretch segments while the render is not ready', () => {
    expect(clipSchedulerTestInternals.canFallbackToRepitchStretch({
      playheadSec: 10,
      timelineStartSec: 12,
      timelineEndSec: 16,
    })).toBe(false)
  })

  test('allows repitch fallback for imminent stretch segments', () => {
    expect(clipSchedulerTestInternals.canFallbackToRepitchStretch({
      playheadSec: 10,
      timelineStartSec: 11,
      timelineEndSec: 15,
    })).toBe(true)
  })

  test('allows repitch fallback for stretch segments already overlapping the playhead', () => {
    expect(clipSchedulerTestInternals.canFallbackToRepitchStretch({
      playheadSec: 10,
      timelineStartSec: 8,
      timelineEndSec: 12,
    })).toBe(true)
  })
})

describe('clip scheduler deferred stretch windows', () => {
  test('returns deferred metadata when a future stretch render is not ready', () => {
    const scheduler = createTestScheduler()
    const result = scheduler.scheduleAllClipsFromPlayhead([
      createTrack([createAudioClip('clip-1', 12, 4)]),
    ], 10, { endLimitSec: 40 })

    expect(result.deferredStretchWindows).toEqual([
      { clipId: 'clip-1', startSec: 12, endSec: 16 },
    ])
  })

  test('returns replace metadata when repitch fallback is imminent', () => {
    const scheduler = createTestScheduler()
    const result = scheduler.scheduleAllClipsFromPlayhead([
      createTrack([createAudioClip('clip-1', 11, 4)]),
    ], 10, { endLimitSec: 40 })

    expect(result.deferredStretchWindows).toEqual([
      { clipId: 'clip-1', startSec: 11, endSec: 15, replaceExistingSource: true },
    ])
  })

  test('clip filter limits append retries to matching clips', () => {
    const scheduledClipIds: string[] = []
    const scheduler = createTestScheduler({
      scheduleMidiClip: (_track, clip) => {
        scheduledClipIds.push(clip.id)
        return true
      },
    })

    scheduler.scheduleAllClipsFromPlayhead([
      createTrack([
        createMidiClip('clip-1', 12),
        createMidiClip('clip-2', 12),
      ]),
    ], 10, {
      preserveExisting: true,
      startLimitSec: 12,
      endLimitSec: 16,
      clipIds: ['clip-2'],
    })

    expect(scheduledClipIds).toEqual(['clip-2'])
  })

  test('reschedule returns deferred metadata for future stretch renders', () => {
    const scheduler = createTestScheduler()
    const result = scheduler.rescheduleClipsAtPlayhead([
      createTrack([createAudioClip('clip-1', 12, 4)]),
    ], 10, ['clip-1'], { endLimitSec: 40 })

    expect(result.deferredStretchWindows).toEqual([
      { clipId: 'clip-1', startSec: 12, endSec: 16 },
    ])
  })
})
