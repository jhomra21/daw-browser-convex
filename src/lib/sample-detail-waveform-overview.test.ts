import { expect, test } from 'bun:test'

import {
  getSampleDetailWaveformOverviewGrabOffset,
  getSampleDetailWaveformOverviewViewportRect,
  moveSampleDetailWaveformOverviewViewport,
} from './sample-detail-waveform-overview'

test('maps the visible viewport into the whole-clip overview', () => {
  expect(getSampleDetailWaveformOverviewViewportRect({
    viewport: { startSec: 2, endSec: 5 },
    clipDurationSec: 10,
    widthPx: 1_000,
  })).toEqual({ leftPx: 200, widthPx: 300 })
})

test('maps the fitted viewport across the complete overview', () => {
  expect(getSampleDetailWaveformOverviewViewportRect({
    viewport: { startSec: 0, endSec: 10 },
    clipDurationSec: 10,
    widthPx: 640,
  })).toEqual({ leftPx: 0, widthPx: 640 })
})

test('preserves the pointer grab position while dragging inside the viewport', () => {
  const viewport = { startSec: 2, endSec: 6 }
  const grabOffsetSec = getSampleDetailWaveformOverviewGrabOffset(viewport, 3)
  expect(grabOffsetSec).toBe(1)
  expect(moveSampleDetailWaveformOverviewViewport({
    viewport,
    clipDurationSec: 10,
    sampleRate: 48_000,
    pointerSec: 7,
    grabOffsetSec,
  })).toEqual({ startSec: 6, endSec: 10 })
})

test('clicking outside the viewport recenters it before dragging', () => {
  const viewport = { startSec: 1, endSec: 3 }
  const grabOffsetSec = getSampleDetailWaveformOverviewGrabOffset(viewport, 7)
  expect(grabOffsetSec).toBe(1)
  expect(moveSampleDetailWaveformOverviewViewport({
    viewport,
    clipDurationSec: 10,
    sampleRate: 48_000,
    pointerSec: 7,
    grabOffsetSec,
  })).toEqual({ startSec: 6, endSec: 8 })
})

test('overview dragging clamps at clip boundaries without changing zoom', () => {
  const viewport = { startSec: 2, endSec: 5 }
  expect(moveSampleDetailWaveformOverviewViewport({
    viewport,
    clipDurationSec: 10,
    sampleRate: 48_000,
    pointerSec: -5,
    grabOffsetSec: 1,
  })).toEqual({ startSec: 0, endSec: 3 })
  expect(moveSampleDetailWaveformOverviewViewport({
    viewport,
    clipDurationSec: 10,
    sampleRate: 48_000,
    pointerSec: 20,
    grabOffsetSec: 1,
  })).toEqual({ startSec: 7, endSec: 10 })
})

test('invalid overview geometry is inert', () => {
  expect(getSampleDetailWaveformOverviewViewportRect({
    viewport: { startSec: 1, endSec: 2 },
    clipDurationSec: 0,
    widthPx: 500,
  })).toEqual({ leftPx: 0, widthPx: 0 })

  const viewport = { startSec: 1, endSec: 2 }
  expect(moveSampleDetailWaveformOverviewViewport({
    viewport,
    clipDurationSec: 10,
    sampleRate: 48_000,
    pointerSec: Number.NaN,
    grabOffsetSec: 0.5,
  })).toEqual(viewport)
})
