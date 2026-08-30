import { describe, expect, test } from 'bun:test'

import { decodePeakByte, extractPeakAsset } from './extract-peaks'
import { peakAssetFormatVersion } from './types'

function createStereoBuffer(): AudioBuffer {
  const channels = [
    new Float32Array([0.75, 0.75]),
    new Float32Array([-0.5, -0.5]),
  ]
  return {
    duration: 1,
    length: 2,
    numberOfChannels: channels.length,
    sampleRate: 2,
    getChannelData: (channel) => channels[channel] ?? new Float32Array(2),
    copyFromChannel: (destination, channelNumber, bufferOffset = 0) => {
      destination.set((channels[channelNumber] ?? new Float32Array()).subarray(bufferOffset, bufferOffset + destination.length))
    },
    copyToChannel: (source, channelNumber, bufferOffset = 0) => {
      channels[channelNumber]?.set(source, bufferOffset)
    },
  }
}

const assertChannelValues = (data: Uint8Array, peakCount: number) => {
  const rightOffset = peakCount * 2
  expect(decodePeakByte(data[0] ?? 128)).toBeCloseTo(0.75, 2)
  expect(decodePeakByte(data[1] ?? 128)).toBeCloseTo(0.75, 2)
  expect(decodePeakByte(data[rightOffset] ?? 128)).toBeCloseTo(-0.5, 2)
  expect(decodePeakByte(data[rightOffset + 1] ?? 128)).toBeCloseTo(-0.5, 2)
}

describe('extractPeakAsset', () => {
  test('preserves each channel independently across peak levels', () => {
    const extracted = extractPeakAsset(createStereoBuffer(), 'stereo-source')

    expect(extracted.record.formatVersion).toBe(peakAssetFormatVersion)
    expect(extracted.record.channelCount).toBe(2)

    const highResolution = extracted.chunks.find((chunk) => chunk.meta.chunkKey.includes(':400:'))
    const lowerResolution = extracted.chunks.find((chunk) => chunk.meta.chunkKey.includes(':100:'))
    if (!highResolution || !lowerResolution) throw new Error('Expected waveform peak levels.')

    expect(highResolution.data).toHaveLength(highResolution.meta.peakCount * 2 * 2)
    expect(lowerResolution.data).toHaveLength(lowerResolution.meta.peakCount * 2 * 2)
    assertChannelValues(highResolution.data, highResolution.meta.peakCount)
    assertChannelValues(lowerResolution.data, lowerResolution.meta.peakCount)
  })
})
