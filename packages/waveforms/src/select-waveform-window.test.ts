import { beforeEach, describe, expect, test } from 'bun:test'

import { clearWaveformAssetCache } from './asset-store'
import { getWaveformChannelSlice } from './select-waveform-window'

function createTestBuffer(): AudioBuffer {
  const sampleRate = 48_000
  const data = new Float32Array(sampleRate)

  return {
    duration: 1,
    length: data.length,
    numberOfChannels: 1,
    sampleRate,
    getChannelData: () => data,
    copyFromChannel: (destination) => {
      destination.set(data.subarray(0, destination.length))
    },
    copyToChannel: (source) => {
      data.set(source.subarray(0, data.length))
    },
  }
}

describe('getWaveformChannelSlice', () => {
  beforeEach(() => {
    clearWaveformAssetCache()
  })

  test('uses the 400 pps cache at its native resolution', async () => {
    const buffer = createTestBuffer()
    const slice = await getWaveformChannelSlice({
      assetKey: 'asset',
      buffer,
      sourceStartSec: 0,
      sourceEndSec: 1,
      bins: 400,
    })

    expect(slice?.columns).toBe(400)
  })

  test('does not stretch the 400 pps cache into fake higher resolution', async () => {
    const buffer = createTestBuffer()
    const slice = await getWaveformChannelSlice({
      assetKey: 'asset',
      buffer,
      sourceStartSec: 0,
      sourceEndSec: 1,
      bins: 401,
    })

    expect(slice).toBeNull()
  })
})
