import { describe, expect, test } from 'bun:test'
import { drawWaveformPeaks } from './render-waveform'

type Rectangle = {
  x: number
  y: number
  width: number
  height: number
}

function createContext() {
  const rectangles: Rectangle[] = []
  const ctx: Parameters<typeof drawWaveformPeaks>[0]['ctx'] = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect(x, y, width, height) {
      rectangles.push({ x, y, width, height })
    },
  }
  return { ctx, rectangles }
}

describe('drawWaveformPeaks', () => {
  test('keeps raw-peak normalization when no amplitude scale is provided', () => {
    const { ctx, rectangles } = createContext()

    drawWaveformPeaks({
      ctx,
      peaks: new Uint8Array([0, 255]),
      drawCols: 1,
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 1,
      cssH: 100,
    })

    expect(rectangles).toEqual([{ x: 0, y: 32, width: 1, height: 36 }])
  })

  test('uses the requested maximum rendered height fraction', () => {
    const { ctx, rectangles } = createContext()

    drawWaveformPeaks({
      ctx,
      peaks: new Uint8Array([0, 255]),
      drawCols: 1,
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 1,
      cssH: 100,
      maxHeightFraction: 0.9,
    })

    expect(rectangles).toEqual([{ x: 0, y: 5, width: 1, height: 90 }])
  })

  test('scales columns after raw-peak normalization and skips invalid or silent scales', () => {
    const { ctx, rectangles } = createContext()

    drawWaveformPeaks({
      ctx,
      peaks: new Uint8Array([0, 255, 0, 255, 0, 255]),
      drawCols: 3,
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 3,
      cssH: 100,
      amplitudeScaleAtColumn: (column) => [0, 0.5, Number.POSITIVE_INFINITY][column],
    })

    expect(rectangles).toEqual([{ x: 1, y: 41, width: 1, height: 18 }])
  })
})
