import { describe, expect, test } from 'bun:test'

import type { Clip } from '@daw-browser/timeline-core/types'
import {
  getArrangementWaveformVisibleSegments,
  selectArrangementWaveformRoute,
} from './arrangement-waveform-window'

const clip = (patch: Partial<Clip<AudioBuffer>> = {}): Clip<AudioBuffer> => ({
  id: 'clip-1',
  name: 'Audio',
  startSec: 10,
  duration: 20,
  color: '#888888',
  sourceDurationSec: 20,
  sourceSampleRate: 48_000,
  sourceChannelCount: 2,
  ...patch,
})

describe('getArrangementWaveformVisibleSegments', () => {
  test('returns no work for an offscreen clip', () => {
    expect(getArrangementWaveformVisibleSegments({
      clip: clip(),
      cssWidthPx: 16_000,
      pixelsPerSecond: 800,
      projectBpm: 120,
      visibleRange: { startSec: 0, endSec: 5 },
    })).toEqual([])
  })

  test('maps a partial non-warp viewport to clip-local pixels and source seconds', () => {
    expect(getArrangementWaveformVisibleSegments({
      clip: clip(),
      cssWidthPx: 16_000,
      pixelsPerSecond: 800,
      projectBpm: 120,
      visibleRange: { startSec: 15, endSec: 17 },
    })).toEqual([{
      drawStartPx: 4_000,
      drawCols: 1_600,
      timelineStartSec: 15,
      timelineEndSec: 17,
      sourceStartSec: 5,
      sourceEndSec: 7,
    }])
  })

  test('uses canonical left padding and source offset mapping', () => {
    expect(getArrangementWaveformVisibleSegments({
      clip: clip({
        duration: 6,
        sourceDurationSec: 10,
        leftPadSec: 1,
        bufferOffsetSec: 2,
      }),
      cssWidthPx: 6_000,
      pixelsPerSecond: 1_000,
      projectBpm: 120,
      visibleRange: { startSec: 10.5, endSec: 13 },
    })).toEqual([{
      drawStartPx: 1_000,
      drawCols: 2_000,
      timelineStartSec: 11,
      timelineEndSec: 13,
      sourceStartSec: 2,
      sourceEndSec: 4,
    }])
  })

  test('keeps marker-warp source windows independent at a marker boundary', () => {
    expect(getArrangementWaveformVisibleSegments({
      clip: clip({
        duration: 4,
        sourceDurationSec: 4,
        audioWarp: {
          enabled: true,
          mode: 'stretch',
          sourceBpm: 120,
          markers: [
            { id: 'a', sourceBeat: 0, timelineBeat: 0 },
            { id: 'b', sourceBeat: 2, timelineBeat: 1 },
            { id: 'c', sourceBeat: 4, timelineBeat: 4 },
          ],
        },
      }),
      cssWidthPx: 4_000,
      pixelsPerSecond: 1_000,
      projectBpm: 120,
      visibleRange: { startSec: 10.25, endSec: 10.75 },
    })).toEqual([
      {
        drawStartPx: 250,
        drawCols: 250,
        timelineStartSec: 10.25,
        timelineEndSec: 10.5,
        sourceStartSec: 0.5,
        sourceEndSec: 1,
      },
      {
        drawStartPx: 500,
        drawCols: 250,
        timelineStartSec: 10.5,
        timelineEndSec: 10.75,
        sourceStartSec: 1,
        sourceEndSec: 1.1666666666666667,
      },
    ])
  })

  test('fails closed for malformed viewport input', () => {
    expect(getArrangementWaveformVisibleSegments({
      clip: clip(),
      cssWidthPx: 16_000,
      pixelsPerSecond: 800,
      projectBpm: 120,
      visibleRange: { startSec: Number.NaN, endSec: 17 },
    })).toEqual([])
  })
})

describe('selectArrangementWaveformRoute', () => {
  test('uses cached peaks below and at exactly 400 columns per source second', () => {
    expect(selectArrangementWaveformRoute({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 1,
      drawCols: 399,
    })).toBe('cached-peaks')
    expect(selectArrangementWaveformRoute({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 1,
      drawCols: 400,
    })).toBe('cached-peaks')
  })

  test('uses bounded PCM above 400 columns per source second', () => {
    expect(selectArrangementWaveformRoute({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 1,
      drawCols: 401,
    })).toBe('pcm-envelope')
  })

  test('fails closed for malformed route input', () => {
    expect(selectArrangementWaveformRoute({
      sampleRate: 0,
      sourceStartSec: 0,
      sourceEndSec: 1,
      drawCols: 400,
    })).toBeNull()
    expect(selectArrangementWaveformRoute({
      sampleRate: 48_000,
      sourceStartSec: 1,
      sourceEndSec: 1,
      drawCols: 400,
    })).toBeNull()
  })
})
