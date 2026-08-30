import { describe, expect, test } from 'bun:test'

import { encodePeakByte, SILENCE_BYTE } from './extract-peaks'
import { createPcmEnvelopeAccumulator } from './pcm-envelope'

describe('createPcmEnvelopeAccumulator', () => {
  test('aggregates stereo pcm into independent visible min/max columns', () => {
    const accumulator = createPcmEnvelopeAccumulator({
      startFrame: 0,
      endFrame: 8,
      columns: 4,
      channelCount: 2,
    })

    accumulator.append({
      startFrame: 0,
      frameCount: 8,
      planes: [
        new Float32Array([-0.8, 0.2, -0.4, 0.6, -0.2, 0.9, -0.1, 0.3]),
        new Float32Array([0.7, 0.1, 0.5, -0.5, 0.2, -0.9, 0.4, -0.3]),
      ],
    })

    expect(accumulator.finish()).toEqual({
      columns: 4,
      channels: [
        new Uint8Array([
          encodePeakByte(-0.8), encodePeakByte(0.2),
          encodePeakByte(-0.4), encodePeakByte(0.6),
          encodePeakByte(-0.2), encodePeakByte(0.9),
          encodePeakByte(-0.1), encodePeakByte(0.3),
        ]),
        new Uint8Array([
          encodePeakByte(0.1), encodePeakByte(0.7),
          encodePeakByte(-0.5), encodePeakByte(0.5),
          encodePeakByte(-0.9), encodePeakByte(0.2),
          encodePeakByte(-0.3), encodePeakByte(0.4),
        ]),
      ],
    })
  })

  test('clips pages to the requested frame window and leaves uncovered columns silent', () => {
    const accumulator = createPcmEnvelopeAccumulator({
      startFrame: 4,
      endFrame: 12,
      columns: 4,
      channelCount: 1,
    })

    accumulator.append({
      startFrame: 0,
      frameCount: 6,
      planes: [new Float32Array([1, 1, 1, 1, -0.5, 0.25])],
    })

    expect(accumulator.finish().channels[0]).toEqual(new Uint8Array([
      encodePeakByte(-0.5), encodePeakByte(0.25),
      SILENCE_BYTE, SILENCE_BYTE,
      SILENCE_BYTE, SILENCE_BYTE,
      SILENCE_BYTE, SILENCE_BYTE,
    ]))
  })

  test('rejects inconsistent page channel metadata', () => {
    const accumulator = createPcmEnvelopeAccumulator({
      startFrame: 0,
      endFrame: 4,
      columns: 2,
      channelCount: 2,
    })

    expect(() => accumulator.append({
      startFrame: 0,
      frameCount: 4,
      planes: [new Float32Array(4)],
    })).toThrow('PCM waveform page metadata is inconsistent.')
  })
})
