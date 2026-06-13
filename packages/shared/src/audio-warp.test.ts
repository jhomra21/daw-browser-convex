import { describe, expect, test } from 'bun:test'
import { audioWarpEqual, createDefaultAudioWarp, normalizeAudioWarp } from './audio-warp'
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

  test('normalizes shared operation warp payloads', () => {
    const operation = parseSharedTimelineOperation({
      kind: 'clips.setAudioWarp',
      payload: {
        clipId: 'clip-1',
        audioWarp: {
          enabled: true,
          sourceBpm: 12.2,
          mode: 'stretch',
        },
      },
    })

    expect(operation?.kind).toBe('clips.setAudioWarp')
    if (operation?.kind !== 'clips.setAudioWarp') return
    expect(operation.payload.audioWarp.enabled).toBe(true)
    expect(operation.payload.audioWarp.sourceBpm).toBe(30)
    expect(operation.payload.audioWarp.mode).toBe('stretch')
  })
})
