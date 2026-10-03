import { describe, expect, test } from 'bun:test'
import { drawWaveformSignal } from '@daw-browser/waveforms/draw-waveform-signal'
import { getAudioClipTimeMap, getMarkerWarpTimelineSegments } from '@daw-browser/timeline-core/audio-clip-time-map'
import type { Clip } from '@daw-browser/timeline-core/types'

describe('unified waveform painter', () => {
  test('submits one geometry path for a signed interval', () => {
    let fills = 0
    const ctx = {
      fillStyle: '',
      beginPath() {},
      moveTo() {},
      lineTo() {},
      fill() { fills += 1 },
      arc() {},
    }
    drawWaveformSignal(ctx, {
      data: {
        kind: 'intervals',
        encoding: 'float32',
        channels: [new Float32Array([-.5, .5])],
        firstFrame: 0,
        sampleRate: 100,
        sourceFrameCount: 10,
        framesPerInterval: 10,
        intervalCount: 1,
      },
      sourceStartFrame: 0,
      sourceEndFrame: 10,
      startPx: 0,
      endPx: 100,
      topY: 0,
      contentH: 40,
      channelCount: 1,
    })
    expect(fills).toBe(1)
  })

  test('preserves canonical normal, trim, repitch, and source-offset timing', () => {
    const base: Clip = {
      id: 'timing',
      name: 'timing',
      startSec: 10,
      duration: 4,
      sourceDurationSec: 8,
      color: '#fff',
    }
    const cases: readonly {
      readonly clip: Clip
      readonly sourceStartSec: number
      readonly sourceEndSec: number
      readonly mode: 'raw' | 'repitch' | 'stretch'
    }[] = [
      { clip: base, sourceStartSec: 0, sourceEndSec: 4, mode: 'raw' },
      {
        clip: { ...base, leftPadSec: 0.5, bufferOffsetSec: 1 },
        sourceStartSec: 1,
        sourceEndSec: 4.5,
        mode: 'raw',
      },
      {
        clip: {
          ...base,
          audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 60, sourceBeatOffset: 1 },
        },
        sourceStartSec: 0,
        sourceEndSec: 7,
        mode: 'repitch',
      },
      {
        clip: {
          ...base,
          audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
        },
        sourceStartSec: 0,
        sourceEndSec: 4,
        mode: 'stretch',
      },
    ]
    for (const item of cases) {
      const map = getAudioClipTimeMap({
        clip: item.clip,
        bufferDurationSec: 8,
        projectBpm: 120,
        rangeStartSec: 10,
        rangeEndSec: 14,
      })
      expect(map?.mode).toBe(item.mode)
      expect(map?.sourceStartSec).toBe(item.sourceStartSec)
      expect(map?.sourceEndSec).toBe(item.sourceEndSec)
    }
  })

  test('keeps marker-warp seams half-open and source aligned', () => {
    const clip: Clip = {
      id: 'marker-timing',
      name: 'marker',
      startSec: 0,
      duration: 4,
      sourceDurationSec: 2,
      color: '#fff',
      audioWarp: {
        enabled: true,
        mode: 'stretch',
        sourceBpm: 120,
        markers: [
          { id: 'a', sourceBeat: 0, timelineBeat: 0 },
          { id: 'b', sourceBeat: 1, timelineBeat: 2 },
          { id: 'c', sourceBeat: 3, timelineBeat: 4 },
        ],
      },
    }
    const map = getAudioClipTimeMap({
      clip,
      bufferDurationSec: 2,
      projectBpm: 120,
      rangeStartSec: 0,
      rangeEndSec: 4,
    })
    if (!map) throw new Error('Expected marker map')
    const segments = getMarkerWarpTimelineSegments({
      clip,
      map,
      projectBpm: 120,
      timelineEndSec: 4,
    })
    expect(segments).toHaveLength(3)
    expect(segments[0]?.timelineEndSec).toBe(segments[1]?.timelineStartSec)
    expect(segments[1]?.timelineEndSec).toBe(segments[2]?.timelineStartSec)
    expect(segments[0]?.sourceEndSec).toBe(segments[1]?.sourceStartSec)
  })

  test('keeps UI-authored marker source beats aligned without reapplying source-beat offsets', () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      for (const channelCount of [1, 2]) {
        const sourceBeatOffset = 0.5
        const sourceBpm = 120
        const clip: Clip = {
          id: `stretch-${sampleRate}-${channelCount}`,
          name: 'stretch precision',
          startSec: 0,
          duration: 2,
          sourceDurationSec: 4,
          color: '#fff',
          audioWarp: {
            enabled: true,
            mode: 'stretch',
            sourceBpm,
            sourceBeatOffset,
            markers: [
              { id: 'a', sourceBeat: sourceBeatOffset, timelineBeat: 0 },
              { id: 'b', sourceBeat: 2 + sourceBeatOffset, timelineBeat: 2 },
              { id: 'c', sourceBeat: 4 + sourceBeatOffset, timelineBeat: 4 },
            ],
          },
        }
        const map = getAudioClipTimeMap({
          clip,
          bufferDurationSec: 4,
          projectBpm: 120,
          rangeStartSec: 0,
          rangeEndSec: 2,
        })
        if (!map) throw new Error('Expected offset marker map')
        const expectedSourceFrame = Math.round(sourceBeatOffset * 60 / sourceBpm * sampleRate)
        const mappedSourceFrame = Math.round(map.timelineToSourceSec(0) * sampleRate)
        expect(Math.abs(mappedSourceFrame - expectedSourceFrame)).toBeLessThanOrEqual(1)
        expect(map.sourceToTimelineSec(mappedSourceFrame / sampleRate)).toBeCloseTo(0, 9)
      }
    }
  })
})
