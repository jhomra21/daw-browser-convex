import { describe, expect, test } from 'bun:test'

import {
  clampSampleDetailWaveformViewport,
  fitSampleDetailWaveformViewport,
  panSampleDetailWaveformViewport,
  sampleDetailWaveformTimeAtX,
  sampleDetailWaveformXAtTime,
  zoomSampleDetailWaveformViewport,
} from './sample-detail-waveform-viewport'

describe('sample detail waveform viewport', () => {
  test('fits the full clip', () => {
    expect(fitSampleDetailWaveformViewport(10)).toEqual({ startSec: 0, endSec: 10 })
  })

  test('keeps cursor-anchored time stable while zooming', () => {
    const next = zoomSampleDetailWaveformViewport({
      viewport: { startSec: 0, endSec: 10 },
      clipDurationSec: 10,
      sampleRate: 48_000,
      anchorFraction: 0.25,
      zoomFactor: 2,
    })

    expect(next.startSec).toBeCloseTo(1.25)
    expect(next.endSec).toBeCloseTo(6.25)
    expect(next.startSec + (next.endSec - next.startSec) * 0.25).toBeCloseTo(2.5)
  })

  test('zooms symmetrically around the center', () => {
    expect(zoomSampleDetailWaveformViewport({
      viewport: { startSec: 2, endSec: 8 },
      clipDurationSec: 10,
      sampleRate: 48_000,
      anchorFraction: 0.5,
      zoomFactor: 2,
    })).toEqual({ startSec: 3.5, endSec: 6.5 })
  })

  test('clamps zoom and pan at clip boundaries without changing visible duration', () => {
    const zoomed = zoomSampleDetailWaveformViewport({
      viewport: { startSec: 0, endSec: 10 },
      clipDurationSec: 10,
      sampleRate: 48_000,
      anchorFraction: 0,
      zoomFactor: 2,
    })
    expect(zoomed).toEqual({ startSec: 0, endSec: 5 })

    const panned = panSampleDetailWaveformViewport({
      viewport: zoomed,
      clipDurationSec: 10,
      sampleRate: 48_000,
      deltaSec: 20,
    })
    expect(panned).toEqual({ startSec: 5, endSec: 10 })

    expect(panSampleDetailWaveformViewport({
      viewport: panned,
      clipDurationSec: 10,
      sampleRate: 48_000,
      deltaSec: Number.NaN,
    })).toEqual(panned)
  })

  test('never zooms past two source samples', () => {
    const next = clampSampleDetailWaveformViewport(
      { startSec: 5, endSec: 5.0000001 },
      { clipDurationSec: 10, sampleRate: 48_000 },
    )
    expect(next.endSec - next.startSec).toBeCloseTo(2 / 48_000)
  })

  test('maps viewport time and pixels directly', () => {
    const viewport = { startSec: 2, endSec: 6 }
    expect(sampleDetailWaveformTimeAtX({ viewport, xPx: 0, widthPx: 600 })).toBe(2)
    expect(sampleDetailWaveformTimeAtX({ viewport, xPx: 600, widthPx: 600 })).toBe(6)
    expect(sampleDetailWaveformTimeAtX({ viewport, xPx: 300, widthPx: 600 })).toBe(4)
    expect(sampleDetailWaveformXAtTime({ viewport, timeSec: 5, widthPx: 600 })).toBe(450)
    expect(sampleDetailWaveformXAtTime({ viewport, timeSec: 4, widthPx: 600 })).toBe(300)
    expect(sampleDetailWaveformTimeAtX({
      viewport,
      xPx: sampleDetailWaveformXAtTime({ viewport, timeSec: 5, widthPx: 600 }),
      widthPx: 600,
    })).toBe(5)
    expect(sampleDetailWaveformTimeAtX({ viewport, xPx: -150, widthPx: 600 })).toBe(1)
    expect(sampleDetailWaveformTimeAtX({ viewport, xPx: 750, widthPx: 600 })).toBe(7)
    expect(sampleDetailWaveformXAtTime({ viewport, timeSec: 1, widthPx: 600 })).toBe(-150)
    expect(sampleDetailWaveformXAtTime({ viewport, timeSec: 7, widthPx: 600 })).toBe(750)
  })
})
