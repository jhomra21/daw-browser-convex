import { describe, expect, test } from 'bun:test'
import { drawWaveformPcmLine, drawWaveformPeaks } from './render-waveform'
import type { WaveformSampleChannelSlice } from './types'

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

describe('drawWaveformPcmLine', () => {
  test('draws points only when the LOD allows them and applies sample gain', () => {
    let arcs = 0
    const yValues: number[] = []
    const ctx: Parameters<typeof drawWaveformPcmLine>[0]['ctx'] = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      beginPath() {},
      moveTo(_x, y) { yValues.push(y) },
      lineTo(_x, y) { yValues.push(y) },
      stroke() {},
      fillRect() {},
      arc() { arcs += 1 },
      fill() {},
    }
    const pcm: WaveformSampleChannelSlice = {
      mode: 'pcm-line',
      channels: [new Float32Array([1, 1])],
      firstFrame: 0,
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 1 / 48_000,
    }
    drawWaveformPcmLine({
      ctx,
      pcm,
      topY: 0,
      contentH: 100,
      cssW: 10,
      fillStyle: 'white',
      pointRadius: 1,
      showPoints: false,
      amplitudeScaleAtSample: () => 0.5,
    })
    expect(arcs).toBe(0)
    expect(yValues[0]).toBe(27.5)
    drawWaveformPcmLine({
      ctx,
      pcm,
      topY: 0,
      contentH: 100,
      cssW: 10,
      fillStyle: 'white',
      pointRadius: 1,
      showPoints: true,
    })
    expect(arcs).toBe(2)
  })

  test('places samples from source frames instead of stretching the array', () => {
    const xValues: number[] = []
    const ctx: Parameters<typeof drawWaveformPcmLine>[0]['ctx'] = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      beginPath() {},
      moveTo(x) { xValues.push(x) },
      lineTo(x) { xValues.push(x) },
      stroke() {},
      fillRect() {},
      arc() {},
      fill() {},
    }
    const pcm: WaveformSampleChannelSlice = {
      mode: 'pcm-line',
      channels: [new Float32Array([0, 0])],
      firstFrame: 10,
      sampleRate: 10,
      sourceStartSec: 1,
      sourceEndSec: 1.2,
    }
    drawWaveformPcmLine({
      ctx,
      pcm,
      topY: 0,
      contentH: 100,
      cssW: 100,
    })
    expect(xValues[0]).toBeCloseTo(0)
    expect(xValues[1]).toBeCloseTo(50)
  })

  test('projects a raw PCM segment into its local draw width', () => {
    const xValues: number[] = []
    const ctx: Parameters<typeof drawWaveformPcmLine>[0]['ctx'] = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      beginPath() {},
      moveTo(x) { xValues.push(x) },
      lineTo(x) { xValues.push(x) },
      stroke() {},
      fillRect() {},
      arc() {},
      fill() {},
    }
    const pcm: WaveformSampleChannelSlice = {
      mode: 'pcm-line',
      channels: [new Float32Array([0, 0])],
      firstFrame: 0,
      sampleRate: 1,
      sourceStartSec: 0,
      sourceEndSec: 2,
    }
    drawWaveformPcmLine({
      ctx,
      pcm,
      topY: 0,
      contentH: 100,
      cssW: 20,
      xOffsetPx: 100,
    })
    expect(xValues[0]).toBe(100)
    expect(xValues[1]).toBe(110)
    expect(xValues.every((value) => value >= 100 && value <= 120)).toBe(true)
  })
})
