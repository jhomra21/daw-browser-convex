import { describe, expect, test } from 'bun:test'
import { encodePeakByte } from '@daw-browser/waveforms/extract-peaks'
import type { WaveformPcmResult } from '@daw-browser/waveforms/types'
import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { cropWaveformDataToSourceRange, getAudioWaveformLayout } from './audio-waveform-layout'
import { createRetainedRasterLayout, projectRetainedWaveformData } from './retained-waveform'
import type { Clip } from '@daw-browser/timeline-core/types'

const clip = (input: Partial<Clip<AudioBuffer>> = {}): Clip<AudioBuffer> => ({
  id: 'retained-clip',
  name: 'retained',
  startSec: 10,
  duration: 4,
  sourceDurationSec: 4,
  sourceSampleRate: 48_000,
  sourceChannelCount: 1,
  color: '#fff',
  ...input,
})

describe('retained waveform provenance', () => {
  test('crops PCM by exact source frames', () => {
    const data: WaveformPcmResult = {
      mode: 'pcm-line',
      channels: [Float32Array.from([0, 1, 2, 3, 4, 5])],
      firstFrame: 100,
      sampleRate: 100,
      sourceStartSec: 1,
      sourceEndSec: 1.06,
    }
    const cropped = cropWaveformDataToSourceRange({
      data,
      sourceStartSec: 1.02,
      sourceEndSec: 1.05,
    })
    expect(cropped?.data.mode).toBe('pcm-line')
    if (!cropped || cropped.data.mode !== 'pcm-line') throw new Error('Expected PCM data')
    expect(cropped.data.firstFrame).toBe(102)
    expect(Array.from(cropped.data.channels[0] ?? [])).toEqual([2, 3, 4])
    expect(cropped.data.channels[0]?.buffer).toBe(data.channels[0]?.buffer)
    expect(cropped.sourceStartSec).toBe(1.02)
    expect(cropped.sourceEndSec).toBe(1.05)
  })

  test('crops peak columns using the retained partition', () => {
    const data: WaveformPcmResult = {
      mode: 'pcm-envelope',
      columns: 4,
      channels: [Uint8Array.from([
        encodePeakByte(-1), encodePeakByte(0),
        encodePeakByte(-0.5), encodePeakByte(0.5),
        encodePeakByte(-0.25), encodePeakByte(0.25),
        encodePeakByte(0), encodePeakByte(1),
      ])],
      sourceStartSec: 0,
      sourceEndSec: 4,
    }
    const cropped = cropWaveformDataToSourceRange({
      data,
      sourceStartSec: 1,
      sourceEndSec: 3,
    })
    expect(cropped?.data.mode).toBe('pcm-envelope')
    if (!cropped || cropped.data.mode !== 'pcm-envelope') throw new Error('Expected peaks')
    expect(cropped.data.columns).toBe(2)
    expect(Array.from(cropped.data.channels[0] ?? [])).toEqual(Array.from(data.channels[0]?.slice(2, 6) ?? []))
    expect(cropped.data.channels[0]?.buffer).toBe(data.channels[0]?.buffer)
    expect(cropped.sourceStartSec).toBe(1)
    expect(cropped.sourceEndSec).toBe(3)
  })

  test('projects retained source overlap through the canonical raw map', () => {
    const currentClip = clip({ leftPadSec: 0.5, bufferOffsetSec: 1 })
    const map = getAudioClipTimeMap({
      clip: currentClip,
      bufferDurationSec: 4,
      projectBpm: 120,
      rangeStartSec: currentClip.startSec,
      rangeEndSec: currentClip.startSec + currentClip.duration,
    })
    if (!map) throw new Error('Expected raw time map')
    const sourceStartSec = 1
    const sourceEndSec = 1.04
    const canvasStartSec = map.sourceToTimelineSec(sourceStartSec)
    const canvasEndSec = map.sourceToTimelineSec(sourceEndSec)
    const retained: WaveformPcmResult = {
      mode: 'pcm-line',
      channels: [Float32Array.from({ length: 4 }, (_, index) => index)],
      firstFrame: 100,
      sampleRate: 100,
      sourceStartSec: 1,
      sourceEndSec: 1.04,
    }
    const segments = [{
      drawCols: 16,
      sourceStartSec,
      sourceEndSec,
      startPx: 0,
      endPx: 16,
      canvasStartSec,
      canvasEndSec,
    }]
    const projected = projectRetainedWaveformData({
      retainedByKey: new Map([['raw', {
        data: retained,
        sourceStartSec: retained.sourceStartSec,
        sourceEndSec: retained.sourceEndSec,
      }]]),
      segments: segments.map((segment) => ({ requestKey: 'raw', segment })),
      map,
    })
    expect(projected).toHaveLength(1)
    expect(projected[0]?.startPx).toBeGreaterThanOrEqual(0)
    expect(projected[0]?.endPx).toBeGreaterThan(projected[0]?.startPx ?? 0)
    expect(projected[0]?.data.mode).toBe('pcm-line')
  })

  test('matches marker-warp segments by source overlap instead of segment index', () => {
    const currentClip = clip({
      duration: 4,
      sourceDurationSec: 2,
      audioWarp: {
        enabled: true,
        mode: 'stretch',
        sourceBpm: 120,
        markers: [
          { id: 'a', sourceBeat: 0, timelineBeat: 0 },
          { id: 'b', sourceBeat: 1, timelineBeat: 4 },
          { id: 'c', sourceBeat: 4, timelineBeat: 8 },
        ],
      },
    })
    const map = getAudioClipTimeMap({
      clip: currentClip,
      bufferDurationSec: 2,
      projectBpm: 120,
      rangeStartSec: currentClip.startSec,
      rangeEndSec: currentClip.startSec + currentClip.duration,
    })
    if (!map) throw new Error('Expected marker-warp time map')
    const layout = getAudioWaveformLayout(currentClip, 400, 2, 120)
    const retained: WaveformPcmResult = {
      mode: 'pcm-envelope',
      columns: 4,
      channels: [new Uint8Array(8).fill(128)],
      sourceStartSec: 0,
      sourceEndSec: 2,
    }
    const projected = projectRetainedWaveformData({
      retainedByKey: new Map([['marker', { data: retained, sourceStartSec: 0, sourceEndSec: 2 }]]),
      segments: (layout.segments ?? []).map((segment) => ({ requestKey: 'marker', segment })),
      map,
    })
    expect(projected.length).toBe(2)
    expect(projected[0]?.sourceStartSec).toBe(0)
    expect(projected[1]?.sourceEndSec).toBe(2)
  })

  test('reprojects retained marker coverage across canonical map segments', () => {
    const currentClip = clip({
      duration: 4,
      sourceDurationSec: 2,
      audioWarp: {
        enabled: true,
        mode: 'stretch',
        sourceBpm: 120,
        markers: [
          { id: 'a', sourceBeat: 0, timelineBeat: 0 },
          { id: 'b', sourceBeat: 1, timelineBeat: 4 },
          { id: 'c', sourceBeat: 4, timelineBeat: 8 },
        ],
      },
    })
    const map = getAudioClipTimeMap({
      clip: currentClip,
      bufferDurationSec: 2,
      projectBpm: 120,
      rangeStartSec: currentClip.startSec,
      rangeEndSec: currentClip.startSec + currentClip.duration,
    })
    if (!map) throw new Error('Expected marker-warp time map')
    const layout = getAudioWaveformLayout(currentClip, 100, 2, 120)
    const segment = layout.segments?.[0]
    if (!segment) throw new Error('Expected a marker-warp segment')
    const retained = createRetainedRasterLayout({
      plan: {
        requests: [],
        segments: [{ requestKey: 'marker', segment }],
      },
      map,
      pixelsPerSecond: 100,
      coverageByKey: new Map([['marker', { sourceStartSec: 0, sourceEndSec: 2 }]]),
      canonicalSegments: (layout.segments ?? []).map((item) => ({
        sourceStartSec: item.sourceStartSec,
        sourceEndSec: item.sourceEndSec,
        canvasStartSec: item.canvasStartSec,
        canvasEndSec: item.canvasEndSec,
      })),
    })
    expect(retained?.segments).toHaveLength(2)
    expect(retained?.segments.map((item) => [
      item.segment.sourceStartSec,
      item.segment.sourceEndSec,
      item.segment.canvasStartSec,
      item.segment.canvasEndSec,
    ])).toEqual((layout.segments ?? []).map((item) => [
      item.sourceStartSec,
      item.sourceEndSec,
      item.canvasStartSec,
      item.canvasEndSec,
    ]))
  })
})
