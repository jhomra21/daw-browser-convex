import { describe, expect, test } from 'bun:test'
import { encodePeakByte } from './extract-peaks'
import { drawWaveformPcmLine, drawWaveformPeaks, waveformSampleY } from './render-waveform'
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
    globalAlpha: 1,
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

  test('maps retained peak columns across the projected destination width', () => {
    const { ctx, rectangles } = createContext()

    drawWaveformPeaks({
      ctx,
      peaks: new Uint8Array([128, 128, 128, 255]),
      drawCols: 8,
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 8,
      cssH: 100,
    })

    expect(rectangles.map((rectangle) => rectangle.x)).toEqual([4, 5, 6, 7])
    expect(rectangles.every((rectangle) => rectangle.height > 0)).toBeTruthy()
  })

  test('preserves extrema from every source interval when downsampling', () => {
    const { ctx, rectangles } = createContext()

    drawWaveformPeaks({
      ctx,
      peaks: new Uint8Array([
        128, 128,
        0, 128,
        128, 128,
        128, 255,
      ]),
      drawCols: 2,
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 2,
      cssH: 100,
    })

    expect(rectangles.map((rectangle) => rectangle.x)).toEqual([0, 1])
    expect(rectangles.map((rectangle) => rectangle.height)).toEqual([
      18.070588235294117,
      17.929411764705883,
    ])
  })

  test('preserves signed positive, negative, and asymmetric intervals', () => {
    const { ctx, rectangles } = createContext()

    drawWaveformPeaks({
      ctx,
      peaks: new Uint8Array([
        192, 255,
        0, 64,
        64, 192,
      ]),
      drawCols: 3,
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 3,
      cssH: 100,
      maxHeightFraction: 1,
    })

    expect(rectangles[0]?.y).toBeCloseTo(0)
    expect(rectangles[0]?.height).toBeCloseTo(24.70588235)
    expect(rectangles[1]?.y).toBeCloseTo(74.90196078)
    expect(rectangles[1]?.height).toBeCloseTo(25.09803922)
    expect(rectangles[2]?.y).toBeCloseTo(24.70588235)
    expect(rectangles[2]?.height).toBeCloseTo(50.19607843)
  })

  test('shares exact sample coordinates between envelope and PCM', () => {
    const samples = [-1, -0.75, -0.25, 0, 0.25, 0.75, 1]
    for (const sample of samples) {
      const expected = waveformSampleY({
        sample,
        topY: 10,
        contentH: 80,
        maxHeightFraction: 0.72,
        amplitudeScale: 0.6,
      })
      const yValues: number[] = []
      drawWaveformPcmLine({
        ctx: {
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 1,
          beginPath() {},
          moveTo(_x, y) { yValues.push(y) },
          lineTo(_x, y) { yValues.push(y) },
          stroke() {},
          fillRect() {},
          arc() {},
          fill() {},
        },
        pcm: {
          mode: 'pcm-line',
          channels: [new Float32Array([sample])],
          firstFrame: 0,
          sampleRate: 1,
          sourceStartSec: 0,
          sourceEndSec: 1,
        },
        topY: 10,
        contentH: 80,
        cssW: 1,
        maxHeightFraction: 0.72,
        amplitudeScaleAtSample: () => 0.6,
      })
      expect(yValues[0]).toBe(expected)
    }
  })

  test('keeps one-sample envelopes at the exact PCM coordinate', () => {
    for (const sample of [-1, -0.75, -0.25, 0, 0.25, 0.75, 1]) {
      const { ctx, rectangles } = createContext()
      drawWaveformPeaks({
        ctx,
        peaks: new Uint8Array([encodePeakByte(sample), encodePeakByte(sample)]),
        drawCols: 1,
        padPx: 0,
        topY: 10,
        contentH: 80,
        cssW: 1,
        cssH: 100,
        maxHeightFraction: 0.72,
        drawBoundary: false,
      })
      if (sample === 0) {
        expect(rectangles).toHaveLength(0)
      } else {
        expect(rectangles[0]?.y).toBeCloseTo(
          waveformSampleY({
            sample: encodePeakByte(sample) / 127.5 - 1,
            topY: 10,
            contentH: 80,
            maxHeightFraction: 0.72,
          }),
        )
        expect(rectangles[0]?.height).toBe(0)
      }
    }
  })
})

describe('drawWaveformPcmLine', () => {
  test('draws points only when the LOD allows them and applies sample gain', () => {
    let arcs = 0
    const alphaChanges: number[] = []
    const yValues: number[] = []
    const ctx: Parameters<typeof drawWaveformPcmLine>[0]['ctx'] = {
      fillStyle: '',
      get globalAlpha() { return alphaChanges.at(-1) ?? 0.75 },
      set globalAlpha(value: number) { alphaChanges.push(value) },
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
      lineOpacity: 0.5,
      pointOpacity: 0,
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
      lineOpacity: 1,
      pointOpacity: 1,
    })
    expect(arcs).toBe(2)
    expect(alphaChanges.at(-1)).toBe(0.75)
    expect(alphaChanges).toContain(0.375)
    expect(alphaChanges).toContain(0.75)
  })

  test('skips zero-opacity work without changing canvas state', () => {
    let strokes = 0
    let arcs = 0
    const ctx: Parameters<typeof drawWaveformPcmLine>[0]['ctx'] = {
      fillStyle: '',
      globalAlpha: 0.5,
      strokeStyle: '',
      lineWidth: 1,
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() { strokes += 1 },
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
      lineOpacity: 0,
      pointOpacity: 0,
      pointRadius: 1,
    })
    expect(strokes).toBe(0)
    expect(arcs).toBe(0)
    expect(ctx.globalAlpha).toBe(0.5)
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
