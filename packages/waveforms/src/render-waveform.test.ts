import { describe, expect, test } from 'bun:test'
import { drawWaveformPeaks, drawWaveformSamples } from './render-waveform'

type Rectangle = {
  x: number
  y: number
  width: number
  height: number
}

type Point = { x: number; y: number }

function createPeakContext() {
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

function createSampleContext() {
  const moves: Point[] = []
  const lines: Point[] = []
  const arcs: Array<Point & { radius: number }> = []
  let strokes = 0
  let fills = 0
  const ctx: Parameters<typeof drawWaveformSamples>[0]['ctx'] = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    beginPath() {},
    moveTo(x, y) {
      moves.push({ x, y })
    },
    lineTo(x, y) {
      lines.push({ x, y })
    },
    stroke() {
      strokes += 1
    },
    arc(x, y, radius) {
      arcs.push({ x, y, radius })
    },
    fill() {
      fills += 1
    },
  }
  return {
    ctx,
    moves,
    lines,
    arcs,
    strokeCount: () => strokes,
    fillCount: () => fills,
  }
}

describe('drawWaveformPeaks', () => {
  test('draws positive and negative peak ranges on their actual side of zero', () => {
    const { ctx, rectangles } = createPeakContext()

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
    const { ctx, rectangles } = createPeakContext()

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
    const { ctx, rectangles } = createPeakContext()

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

describe('drawWaveformSamples', () => {
  test('draws actual sample values as independent stereo polylines', () => {
    const context = createSampleContext()

    drawWaveformSamples({
      ctx: context.ctx,
      samples: {
        channels: [
          new Float32Array([1, 0, -1]),
          new Float32Array([-1, 0, 1]),
        ],
        firstFrame: 0,
        sampleRate: 2,
        sourceStartSec: 0,
        sourceEndSec: 1,
      },
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 100,
    })

    expect(context.strokeCount()).toBe(2)
    expect(context.moves[0]).toEqual({ x: 0, y: 0 })
    expect(context.lines[0]).toEqual({ x: 50, y: 25 })
    expect(context.lines[1]).toEqual({ x: 100, y: 50 })
    expect(context.moves[1]).toEqual({ x: 0, y: 100 })
    expect(context.lines[2]).toEqual({ x: 50, y: 75 })
    expect(context.lines[3]).toEqual({ x: 100, y: 50 })
  })

  test('adds sample points only when requested', () => {
    const context = createSampleContext()

    drawWaveformSamples({
      ctx: context.ctx,
      samples: {
        channels: [new Float32Array([0.5, -0.5])],
        firstFrame: 10,
        sampleRate: 10,
        sourceStartSec: 1,
        sourceEndSec: 1.1,
      },
      padPx: 0,
      topY: 0,
      contentH: 40,
      cssW: 50,
      showPoints: true,
      pointRadiusPx: 2,
    })

    expect(context.arcs).toEqual([
      { x: 0, y: 10, radius: 2 },
      { x: 50, y: 30, radius: 2 },
    ])
    expect(context.fillCount()).toBe(1)
  })

  test('applies render-only amplitude scaling without mutating samples', () => {
    const samples = {
      channels: [new Float32Array([1, 1])],
      firstFrame: 0,
      sampleRate: 2,
      sourceStartSec: 0,
      sourceEndSec: 1,
    }
    drawWaveformSamples({
      ctx: createSampleContext().ctx,
      samples,
      padPx: 0,
      topY: 0,
      contentH: 100,
      cssW: 100,
      strokeStyle: 'white',
      amplitudeScaleAtProgress: (progress) => progress,
    })
    expect(samples.channels[0]?.[0]).toBe(1)
    expect(samples.channels[0]?.[1]).toBe(1)
  })

  test('vertical zoom clips to the channel bounds without viewport normalization', () => {
    const context = createSampleContext()

    drawWaveformSamples({
      ctx: context.ctx,
      samples: {
        channels: [new Float32Array([0.25, -0.25])],
        firstFrame: 0,
        sampleRate: 1,
        sourceStartSec: 0,
        sourceEndSec: 1,
      },
      padPx: 0,
      topY: 10,
      contentH: 80,
      cssW: 100,
      verticalZoom: 8,
    })

    expect(context.moves[0]).toEqual({ x: 0, y: 10 })
    expect(context.lines[0]).toEqual({ x: 100, y: 90 })
  })
})
