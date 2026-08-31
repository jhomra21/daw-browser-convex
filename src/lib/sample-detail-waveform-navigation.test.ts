import { expect, test } from 'bun:test'

import {
  createSampleDetailWaveformSelection,
  getSampleDetailWaveformSelectionRect,
  getSampleDetailWaveformSelectionViewport,
  popSampleDetailWaveformViewportHistory,
  pushSampleDetailWaveformViewportHistory,
} from './sample-detail-waveform-navigation'

test('normalizes reversed selections and clamps them to the clip', () => {
  expect(createSampleDetailWaveformSelection({
    anchorSec: 8,
    focusSec: -2,
    clipDurationSec: 10,
  })).toEqual({ startSec: 0, endSec: 8 })
  expect(createSampleDetailWaveformSelection({
    anchorSec: 4,
    focusSec: 4,
    clipDurationSec: 10,
  })).toBeNull()
})

test('maps only the visible part of a selection into viewport pixels', () => {
  expect(getSampleDetailWaveformSelectionRect({
    selection: { startSec: 1, endSec: 7 },
    viewport: { startSec: 4, endSec: 8 },
    widthPx: 400,
  })).toEqual({ leftPx: 0, widthPx: 300 })

  expect(getSampleDetailWaveformSelectionRect({
    selection: { startSec: 0, endSec: 1 },
    viewport: { startSec: 4, endSec: 8 },
    widthPx: 400,
  })).toBeNull()
})

test('rejects malformed selection rectangle viewports', () => {
  expect(getSampleDetailWaveformSelectionRect({
    selection: { startSec: 1, endSec: 2 },
    viewport: { startSec: Number.NaN, endSec: 4 },
    widthPx: 400,
  })).toBeNull()
  expect(getSampleDetailWaveformSelectionRect({
    selection: { startSec: -1, endSec: 2 },
    viewport: { startSec: -1, endSec: 4 },
    widthPx: 400,
  })).toBeNull()
})

test('zooms to a selection while preserving the two-sample minimum', () => {
  expect(getSampleDetailWaveformSelectionViewport({
    selection: { startSec: 3, endSec: 5 },
    clipDurationSec: 10,
    sampleRate: 48_000,
  })).toEqual({ startSec: 3, endSec: 5 })

  const tiny = getSampleDetailWaveformSelectionViewport({
    selection: { startSec: 4, endSec: 4.000001 },
    clipDurationSec: 10,
    sampleRate: 48_000,
  })
  expect(tiny).not.toBeNull()
  expect((tiny?.endSec ?? 0) - (tiny?.startSec ?? 0)).toBeCloseTo(2 / 48_000, 12)
  expect(((tiny?.startSec ?? 0) + (tiny?.endSec ?? 0)) / 2).toBeCloseTo(4.0000005, 9)
})

test('selection zoom clamps at clip boundaries without changing the selected scale', () => {
  const left = getSampleDetailWaveformSelectionViewport({
    selection: { startSec: 0, endSec: 0.25 },
    clipDurationSec: 10,
    sampleRate: 48_000,
  })
  expect(left).toEqual({ startSec: 0, endSec: 0.25 })

  const right = getSampleDetailWaveformSelectionViewport({
    selection: { startSec: 9.75, endSec: 10 },
    clipDurationSec: 10,
    sampleRate: 48_000,
  })
  expect(right).toEqual({ startSec: 9.75, endSec: 10 })
})

test('viewport history is discrete, deduplicated, and last-in-first-out', () => {
  const first = { startSec: 0, endSec: 10 }
  const second = { startSec: 2, endSec: 4 }
  const third = { startSec: 2.5, endSec: 3 }

  const withFirst = pushSampleDetailWaveformViewportHistory([], first)
  const deduplicated = pushSampleDetailWaveformViewportHistory(withFirst, first)
  expect(deduplicated).toEqual([first])

  const history = pushSampleDetailWaveformViewportHistory(
    pushSampleDetailWaveformViewportHistory(deduplicated, second),
    third,
  )
  const poppedThird = popSampleDetailWaveformViewportHistory(history)
  expect(poppedThird.viewport).toEqual(third)
  expect(poppedThird.history).toEqual([first, second])

  const poppedSecond = popSampleDetailWaveformViewportHistory(poppedThird.history)
  expect(poppedSecond.viewport).toEqual(second)
  expect(poppedSecond.history).toEqual([first])
})

test('invalid selection and history inputs fail closed', () => {
  expect(createSampleDetailWaveformSelection({
    anchorSec: Number.NaN,
    focusSec: 1,
    clipDurationSec: 10,
  })).toBeNull()
  expect(getSampleDetailWaveformSelectionViewport({
    selection: { startSec: 1, endSec: 2 },
    clipDurationSec: 10,
    sampleRate: 0,
  })).toBeNull()
  expect(pushSampleDetailWaveformViewportHistory(
    [{ startSec: 0, endSec: 1 }],
    { startSec: 2, endSec: 2 },
  )).toEqual([{ startSec: 0, endSec: 1 }])
  expect(popSampleDetailWaveformViewportHistory([])).toEqual({ history: [] })
})

test('selection zoom rejects selections fully outside the clip', () => {
  expect(getSampleDetailWaveformSelectionViewport({
    selection: { startSec: -5, endSec: -1 },
    clipDurationSec: 10,
    sampleRate: 48_000,
  })).toBeNull()
  expect(getSampleDetailWaveformSelectionViewport({
    selection: { startSec: 11, endSec: 12 },
    clipDurationSec: 10,
    sampleRate: 48_000,
  })).toBeNull()
})

test('viewport history rejects malformed entries without mutating input', () => {
  const malformed = [{ startSec: 0, endSec: 1 }, { startSec: 2, endSec: Number.NaN }]
  const snapshot = malformed.map((viewport) => ({ ...viewport }))
  expect(pushSampleDetailWaveformViewportHistory(malformed, { startSec: 3, endSec: 4 })).toEqual([])
  expect(malformed).toEqual(snapshot)
  expect(popSampleDetailWaveformViewportHistory(malformed)).toEqual({ history: [] })
})
