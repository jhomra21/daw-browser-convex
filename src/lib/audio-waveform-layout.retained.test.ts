import { describe, expect, test } from 'bun:test'
import { cropWaveformDataToSourceRange } from './audio-waveform-layout'

describe('source-aligned waveform crop', () => {
  test('crops interval data by global interval index', () => {
    const data = {
      kind: 'intervals' as const,
      encoding: 'float32' as const,
      channels: [new Float32Array([-.5, .5, -.25, .25])],
      firstFrame: 0,
      sampleRate: 100,
      sourceFrameCount: 40,
      framesPerInterval: 10,
      intervalCount: 2,
    }
    const cropped = cropWaveformDataToSourceRange({ data, sourceStartSec: 0.1, sourceEndSec: 0.2 })
    expect(cropped?.sourceStartFrame).toBe(10)
    expect(cropped?.sourceEndFrame).toBe(20)
    expect(cropped?.data.firstFrame).toBe(10)
    expect(cropped?.data.channels[0]?.[0]).toBe(-.25)
  })

  test('keeps aligned ownership while reporting exact half-open source bounds', () => {
    const data = {
      kind: 'intervals' as const,
      encoding: 'float32' as const,
      channels: [new Float32Array([-.5, .5, -.25, .25, -.1, .1])],
      firstFrame: 0,
      sampleRate: 100,
      sourceFrameCount: 60,
      framesPerInterval: 10,
      intervalCount: 3,
    }
    const cropped = cropWaveformDataToSourceRange({ data, sourceStartSec: 0.15, sourceEndSec: 0.25 })
    expect(cropped?.sourceStartFrame).toBe(15)
    expect(cropped?.sourceEndFrame).toBe(25)
    expect(cropped?.data.firstFrame).toBe(10)
    expect(cropped?.data.kind).toBe('intervals')
    if (!cropped || cropped.data.kind !== 'intervals') throw new Error('Expected interval data')
    expect(cropped.data.intervalCount).toBe(2)
  })
})
