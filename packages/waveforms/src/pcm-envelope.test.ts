import { describe, expect, test } from 'bun:test'

import { encodePeakByte, SILENCE_BYTE } from './extract-peaks'
import { createPcmEnvelopeAccumulator } from './pcm-envelope'

describe('createPcmEnvelopeAccumulator', () => {
  test('aggregates stereo pcm into independent visible min/max columns', () => {
    const left = new Float32Array([-0.8, 0.2, -0.4, 0.6, -0.2, 0.9, -0.1, 0.3])
    const right = new Float32Array([0.7, 0.1, 0.5, -0.5, 0.2, -0.9, 0.4, -0.3])
    const accumulator = createPcmEnvelopeAccumulator({
      startFrame: 0,
      endFrame: 8,
      columns: 4,
      channelCount: 2,
    })

    accumulator.append({
      startFrame: 0,
      frameCount: 8,
      planes: [left, right],
    })

    expect(accumulator.finish()).toEqual({
      columns: 4,
      channels: [
        new Uint8Array([
          encodePeakByte(left[0]!), encodePeakByte(left[1]!),
          encodePeakByte(left[2]!), encodePeakByte(left[3]!),
          encodePeakByte(left[4]!), encodePeakByte(left[5]!),
          encodePeakByte(left[6]!), encodePeakByte(left[7]!),
        ]),
        new Uint8Array([
          encodePeakByte(right[1]!), encodePeakByte(right[0]!),
          encodePeakByte(right[3]!), encodePeakByte(right[2]!),
          encodePeakByte(right[5]!), encodePeakByte(right[4]!),
          encodePeakByte(right[7]!), encodePeakByte(right[6]!),
        ]),
      ],
    })
  })

  test('combines adjacent pages without duplicating or omitting their boundary', () => {
    const left = new Float32Array([-1, -0.5, 0, 0.25, 0.5, 0.75, 1, 0.5])
    const right = new Float32Array([1, 0.5, 0, -0.25, -0.5, -0.75, -1, -0.5])
    const pagesAccumulator = createPcmEnvelopeAccumulator({
      startFrame: 0,
      endFrame: 8,
      columns: 4,
      channelCount: 2,
    })
    pagesAccumulator.append({
      startFrame: 0,
      frameCount: 4,
      planes: [left.slice(0, 4), right.slice(0, 4)],
    })
    pagesAccumulator.append({
      startFrame: 4,
      frameCount: 4,
      planes: [left.slice(4), right.slice(4)],
    })

    const fullPageAccumulator = createPcmEnvelopeAccumulator({
      startFrame: 0,
      endFrame: 8,
      columns: 4,
      channelCount: 2,
    })
    fullPageAccumulator.append({
      startFrame: 0,
      frameCount: 8,
      planes: [left, right],
    })

    expect(pagesAccumulator.finish()).toEqual(fullPageAccumulator.finish())
  })

  test('clips pages on both sides of the requested frame window and leaves gaps silent', () => {
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
    accumulator.append({
      startFrame: 10,
      frameCount: 6,
      planes: [new Float32Array([0.5, -0.75, 1, 1, 1, 1])],
    })

    expect(accumulator.finish().channels[0]).toEqual(new Uint8Array([
      encodePeakByte(-0.5), encodePeakByte(0.25),
      SILENCE_BYTE, SILENCE_BYTE,
      SILENCE_BYTE, SILENCE_BYTE,
      encodePeakByte(-0.75), encodePeakByte(0.5),
    ]))
  })

  test('rejects inconsistent page channel, plane length, and frame range metadata', () => {
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
    expect(() => accumulator.append({
      startFrame: 0,
      frameCount: 4,
      planes: [new Float32Array(3), new Float32Array(4)],
    })).toThrow('PCM waveform page metadata is inconsistent.')
    expect(() => accumulator.append({
      startFrame: Number.MAX_SAFE_INTEGER - 1,
      frameCount: 2,
      planes: [new Float32Array(2), new Float32Array(2)],
    })).toThrow('PCM waveform page metadata is inconsistent.')
  })
})
