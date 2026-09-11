import { beforeEach, describe, expect, test } from 'bun:test'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import { clearWaveformAssetCache } from './asset-store'
import { getWaveformSlice } from './select-waveform-window'

const source = (reads: { count: number }): AudioPcmSourceDescriptor => ({
  identity: 'deep-zoom-source',
  durationSec: 1,
  frameCount: 48_000,
  sampleRate: 48_000,
  channelCount: 1,
  readPages: async function* (options = {}) {
    reads.count += 1
    options.signal?.throwIfAborted()
    yield {
      startFrame: options.startFrame ?? 0,
      frameCount: (options.endFrame ?? 1) - (options.startFrame ?? 0),
      sampleRate: 48_000,
      channelCount: 1,
      planes: [new Float32Array((options.endFrame ?? 1) - (options.startFrame ?? 0))],
    }
  },
})

describe('getWaveformSlice', () => {
  beforeEach(() => clearWaveformAssetCache())

  test('does not request the source at deep zoom', async () => {
    const reads = { count: 0 }
    const result = await getWaveformSlice({
      assetKey: 'deep-zoom',
      source: source(reads),
      sourceStartSec: 0,
      sourceEndSec: 1 / 48_000,
      bins: 2,
    })
    expect(result).toBeNull()
    expect(reads.count).toBe(0)
  })
})
