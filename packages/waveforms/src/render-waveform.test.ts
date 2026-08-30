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
  test('draws positive and negative peak ranges on their actual side of zero', () => {
    const { ctx, rectangles } = createContext()

    drawWaveformPeaks({
      ctx,
      peaks: new Uint8Array([
        128, 255,
        0, 64,
      ]),
      drawCols: 2,
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 2,
      cssH: 100,
    })

    expect(rectangles).toHaveLength(2)
    expect(rectangles[0]?.x).toBe(0)
    expect(rectangles[0]?.y).toBeCloseTo(5)
    expect(rectangles[0]?.height).toBeCloseTo(44.8235294117647)
    expect(rectangles[1]?.x).toBe(1)
    expect(rectangles[1]?.y).toBeCloseTo(72.41176470588235)
    expect(rectangles[1]?.height).toBeCloseTo(22.58823529411765)
  })

  test('uses a stable full-scale vertical mapping instead of viewport normalization', () => {
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

    expect(rectangles).toEqual([{ x: 0, y: 5, width: 1, height: 90 }])
  })

  test('applies requested vertical and fade scaling without changing polarity', () => {
    const { ctx, rectangles } = createContext()

    drawWaveformPeaks({
      ctx,
      peaks: new Uint8Array([
        0, 255,
        0, 255,
        0, 255,
      ]),
      drawCols: 3,
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 3,
      cssH: 100,
      maxHeightFraction: 0.8,
      amplitudeScaleAtColumn: (column) => [0, 0.5, Number.POSITIVE_INFINITY][column],
    })

    expect(rectangles).toEqual([{ x: 1, y: 30, width: 1, height: 40 }])
  })
})
