import { describe, expect, test } from 'bun:test'
import { encodePeakByte, SILENCE_BYTE } from './extract-peaks'
import { createPcmEnvelopeAccumulator } from './pcm-envelope'

const page = (startFrame: number, left: number[], right: number[] = []) => ({
  startFrame,
  frameCount: left.length,
  sampleRate: 48_000,
  channelCount: right.length > 0 ? 2 : 1,
  planes: right.length > 0
    ? [new Float32Array(left), new Float32Array(right)]
    : [new Float32Array(left)],
})

describe('createPcmEnvelopeAccumulator', () => {
  test('keeps stereo channels independent and preserves frame boundaries', () => {
    const accumulator = createPcmEnvelopeAccumulator({
      startFrame: 0,
      endFrame: 8,
      columns: 4,
      sampleRate: 48_000,
      channelCount: 2,
    })
    accumulator.append(page(0, [-0.8, 0.2, -0.4, 0.6, -0.2, 0.9, -0.1, 0.3], [0.7, 0.1, 0.5, -0.5, 0.2, -0.9, 0.4, -0.3]))
    const result = accumulator.finish()
    expect(result.channels[0]).toEqual(new Uint8Array([
      encodePeakByte(-0.8), encodePeakByte(0.2),
      76, encodePeakByte(0.6),
      encodePeakByte(-0.2), encodePeakByte(0.9),
      encodePeakByte(-0.1), encodePeakByte(0.3),
    ]))
    expect(result.channels[1]).toEqual(new Uint8Array([
      encodePeakByte(0.1), encodePeakByte(0.7),
      encodePeakByte(-0.5), encodePeakByte(0.5),
      encodePeakByte(-0.9), encodePeakByte(0.2),
      encodePeakByte(-0.3), encodePeakByte(0.4),
    ]))
  })

  test('leaves gaps as silence and rejects metadata changes', () => {
    const accumulator = createPcmEnvelopeAccumulator({
      startFrame: 4,
      endFrame: 12,
      columns: 4,
      sampleRate: 48_000,
      channelCount: 1,
    })
    accumulator.append(page(0, [1, 1, 1, 1, -0.5, 0.25]))
    accumulator.append(page(10, [0.5, -0.75, 1, 1, 1, 1]))
    expect(accumulator.finish().channels[0]).toEqual(new Uint8Array([
      encodePeakByte(-0.5), encodePeakByte(0.25),
      SILENCE_BYTE, SILENCE_BYTE,
      SILENCE_BYTE, SILENCE_BYTE,
      encodePeakByte(-0.75), encodePeakByte(0.5),
    ]))
    expect(() => accumulator.append({
      ...page(20, [0]),
      sampleRate: 44_100,
    })).toThrow('PCM waveform page metadata is inconsistent.')
  })

  test('maps four frames into the requested two envelope columns', () => {
    const accumulator = createPcmEnvelopeAccumulator({
      startFrame: 0,
      endFrame: 4,
      columns: 2,
      sampleRate: 48_000,
      channelCount: 1,
    })
    accumulator.append(page(0, [-1, 0, 0, 1]))
    const result = accumulator.finish()
    expect(result.columns).toBe(2)
    expect(result.channels[0]).toEqual(new Uint8Array([
      encodePeakByte(-1), encodePeakByte(0),
      encodePeakByte(0), encodePeakByte(1),
    ]))
  })
})
