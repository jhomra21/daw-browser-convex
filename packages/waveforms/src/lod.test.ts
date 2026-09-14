import { describe, expect, test } from 'bun:test'
import {
  maximumCachedPeaksPerSecond,
  selectWaveformLod,
  waveformVisualMixFor,
} from './lod'

describe('selectWaveformLod', () => {
  test('uses the exact cached-peak boundary', () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      expect(selectWaveformLod({ sampleRate, sourceStartSec: 0, sourceEndSec: 1, widthPx: 399 })?.mode).toBe('cached-peaks')
      expect(selectWaveformLod({ sampleRate, sourceStartSec: 0, sourceEndSec: 1, widthPx: 400 })?.mode).toBe('cached-peaks')
      expect(selectWaveformLod({ sampleRate, sourceStartSec: 0, sourceEndSec: 1, widthPx: 401 })?.mode).toBe('pcm-envelope')
    }
  })

  test('uses source sample rate at the one-sample-per-pixel boundary', () => {
    expect(selectWaveformLod({ sampleRate: 47_999, sourceStartSec: 0, sourceEndSec: 1, widthPx: 48_000 })?.mode).toBe('pcm-line')
    expect(selectWaveformLod({ sampleRate: 48_000, sourceStartSec: 0, sourceEndSec: 1, widthPx: 48_000 })?.mode).toBe('pcm-envelope')
    expect(selectWaveformLod({ sampleRate: 48_001, sourceStartSec: 0, sourceEndSec: 1, widthPx: 48_000 })?.mode).toBe('pcm-envelope')
    expect(selectWaveformLod({ sampleRate: 48_000, sourceStartSec: 0, sourceEndSec: 1, widthPx: 48_001 })?.mode).toBe('pcm-line')
  })

  test('mixes envelope, line, and points monotonically across visual thresholds', () => {
    const lod = selectWaveformLod({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 1,
      widthPx: 240_000,
    })
    if (!lod || lod.mode !== 'pcm-line') throw new Error('Expected PCM line LOD')
    expect(lod.pixelsPerSample).toBe(5)
    const envelope = waveformVisualMixFor({ samplesPerPixel: 1.5 })
    const line = waveformVisualMixFor({ samplesPerPixel: 1 })
    const dense = waveformVisualMixFor({ samplesPerPixel: 2 / 3, pixelsPerSample: 2 })
    const pointsStart = waveformVisualMixFor({ samplesPerPixel: 0.2, pixelsPerSample: 4 })
    const pointsCenter = waveformVisualMixFor({ samplesPerPixel: 0.2, pixelsPerSample: 5 })
    const pointsEnd = waveformVisualMixFor({ samplesPerPixel: 0.2, pixelsPerSample: 6 })
    expect(envelope.lineOpacity).toBe(0)
    expect(envelope.envelopeOpacity).toBe(1)
    expect(line.lineOpacity).toBeGreaterThan(envelope.lineOpacity)
    expect(dense.lineOpacity).toBe(1)
    expect(pointsStart.pointOpacity).toBe(0)
    expect(pointsCenter.pointOpacity).toBeGreaterThan(pointsStart.pointOpacity)
    expect(pointsEnd.pointOpacity).toBe(1)
    expect(maximumCachedPeaksPerSecond).toBe(400)
  })

  test('starts the visual line mix before acquisition reaches pcm-line', () => {
    const values = [1.1, 1.05, 1.01, 1.001, 1, 0.999, 0.99, 0.95, 0.9, 0.8, 0.7, 2 / 3]
      .map((samplesPerPixel) => waveformVisualMixFor({ samplesPerPixel }).lineOpacity)
    expect(values[0]).toBeGreaterThan(0)
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThanOrEqual(values[index - 1] ?? 0)
    }
    expect(values.at(-1)).toBe(1)
  })
})
