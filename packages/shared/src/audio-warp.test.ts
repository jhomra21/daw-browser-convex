import { describe, expect, test } from 'bun:test'
import { audioWarpEqual, createDefaultAudioWarp, mapSourceBeatToTimelineBeat, mapTimelineBeatToSourceBeat, normalizeAudioWarp } from './audio-warp'
import { parseSharedTimelineOperation } from './shared-timeline-operations'

describe('audio warp normalization', () => {
  test('returns undefined for non-object input', () => {
    expect(normalizeAudioWarp(null)).toBe(undefined)
    expect(normalizeAudioWarp('warp')).toBe(undefined)
  })

  test('normalizes partial warp data', () => {
    const audioWarp = normalizeAudioWarp({ enabled: 1, sourceBpm: 12.4, mode: 'invalid' })
    expect(audioWarp?.enabled).toBe(true)
    expect(audioWarp?.sourceBpm).toBe(30)
    expect(audioWarp?.mode).toBe('repitch')
  })

  test('clamps and rounds source bpm', () => {
    expect(normalizeAudioWarp({ enabled: true, sourceBpm: 329.6, mode: 'stretch' })?.sourceBpm).toBe(300)
    expect(normalizeAudioWarp({ enabled: true, sourceBpm: 127.6, mode: 'stretch' })?.sourceBpm).toBe(128)
  })

  test('clamps and rounds source beat offset', () => {
    expect(normalizeAudioWarp({ enabled: true, sourceBeatOffset: 18, mode: 'stretch' })?.sourceBeatOffset).toBe(16)
    expect(normalizeAudioWarp({ enabled: true, sourceBeatOffset: -18, mode: 'stretch' })?.sourceBeatOffset).toBe(-16)
    expect(normalizeAudioWarp({ enabled: true, sourceBeatOffset: 1.2345, mode: 'stretch' })?.sourceBeatOffset).toBe(1.235)
  })

  test('omits effectively zero source beat offset', () => {
    expect(normalizeAudioWarp({ enabled: true, sourceBeatOffset: 0, mode: 'stretch' })?.sourceBeatOffset).toBe(undefined)
    expect(normalizeAudioWarp({ enabled: true, sourceBeatOffset: -0, mode: 'stretch' })?.sourceBeatOffset).toBe(undefined)
  })

  test('creates default disabled warp from project bpm', () => {
    const audioWarp = createDefaultAudioWarp(400)
    expect(audioWarp.enabled).toBe(false)
    expect(audioWarp.sourceBpm).toBe(300)
    expect(audioWarp.mode).toBe('repitch')
  })

  test('treats omitted and disabled default warp as equivalent', () => {
    expect(audioWarpEqual(undefined, { enabled: false, mode: 'repitch' })).toBe(true)
    expect(audioWarpEqual(undefined, { enabled: false, sourceBpm: 120, mode: 'repitch' })).toBe(false)
  })

  test('treats omitted and zero source beat offsets as equivalent', () => {
    expect(audioWarpEqual(
      { enabled: true, sourceBpm: 120, mode: 'stretch' },
      { enabled: true, sourceBpm: 120, sourceBeatOffset: 0, mode: 'stretch' },
    )).toBe(true)
  })

  test('detects material warp differences', () => {
    expect(audioWarpEqual(
      { enabled: true, sourceBpm: 120, mode: 'repitch' },
      { enabled: true, sourceBpm: 120, mode: 'stretch' },
    )).toBe(false)
    expect(audioWarpEqual(
      { enabled: true, sourceBpm: 120, mode: 'stretch' },
      { enabled: true, sourceBpm: 121, mode: 'stretch' },
    )).toBe(false)
  })

  test('normalizes markers into a monotonic mapping', () => {
    const audioWarp = normalizeAudioWarp({
      enabled: true,
      sourceBpm: 120,
      mode: 'stretch',
      markers: [
        { id: 'b', sourceBeat: 4, timelineBeat: 4 },
        { id: 'duplicate', sourceBeat: 3, timelineBeat: 3 },
        { id: 'a', sourceBeat: 0, timelineBeat: 0 },
        { id: 'crossing', sourceBeat: 2, timelineBeat: 5 },
        { id: 'duplicate', sourceBeat: 6, timelineBeat: 6 },
      ],
    })

    expect(audioWarp?.markers).toEqual([
      { id: 'a', sourceBeat: 0, timelineBeat: 0 },
      { id: 'duplicate', sourceBeat: 3, timelineBeat: 3 },
      { id: 'b', sourceBeat: 4, timelineBeat: 4 },
    ])
  })

  test('maps between timeline and source beats across marker segments', () => {
    const markers = [
      { id: 'a', sourceBeat: 0, timelineBeat: 0 },
      { id: 'b', sourceBeat: 2, timelineBeat: 4 },
      { id: 'c', sourceBeat: 6, timelineBeat: 8 },
    ]

    expect(mapTimelineBeatToSourceBeat(markers, 2)).toBe(1)
    expect(mapTimelineBeatToSourceBeat(markers, 6)).toBe(4)
    expect(mapSourceBeatToTimelineBeat(markers, 1)).toBe(2)
    expect(mapSourceBeatToTimelineBeat(markers, 4)).toBe(6)
  })

  test('normalizes shared operation warp payloads', () => {
    const operation = parseSharedTimelineOperation({
      kind: 'clips.setAudioWarp',
      payload: {
        clipId: 'clip-1',
        audioWarp: {
          enabled: true,
          sourceBpm: 12.2,
          sourceBeatOffset: 1.2345,
          mode: 'stretch',
        },
      },
    })

    expect(operation?.kind).toBe('clips.setAudioWarp')
    if (operation?.kind !== 'clips.setAudioWarp') return
    expect(operation.payload.audioWarp.enabled).toBe(true)
    expect(operation.payload.audioWarp.sourceBpm).toBe(30)
    expect(operation.payload.audioWarp.sourceBeatOffset).toBe(1.235)
    expect(operation.payload.audioWarp.mode).toBe('stretch')
  })
})
