import { describe, expect, test } from 'bun:test'
import {
  clipRecordingPreviewToViewport,
  recordingPreviewRequiresViewportClip,
} from './RecordingPreview'

describe('RecordingPreview viewport geometry', () => {
  test('clips retained points to a bounded viewport-local width', () => {
    const clipped = clipRecordingPreviewToViewport({
      startSec: 100,
      points: [
        { offset: 0, amplitude: 0.1 },
        { offset: 5, amplitude: 0.5 },
        { offset: 10, amplitude: 0.9 },
      ],
      visibleStartSec: 104,
      visibleEndSec: 106,
      pixelsPerSecond: 100_000,
    })
    expect(clipped?.leftPx).toBe(0)
    expect(clipped?.widthPx).toBe(200_000)
    expect(clipped?.points.map((point) => point.offset)).toEqual([0, 1, 2])
  })

  test('detects long recordings at extreme zoom', () => {
    expect(recordingPreviewRequiresViewportClip({
      lastOffsetSec: 10,
      pixelsPerSecond: 100_000,
      visibleWidthPx: 1000,
    })).toBe(true)
  })
})
