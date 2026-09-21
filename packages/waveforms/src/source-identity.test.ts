import { describe, expect, test } from 'bun:test'
import { peakAssetMatchesSourceIdentity } from './source-identity'
import { peakAssetFormatVersion, type PeakAssetRecord } from './types'

const record: PeakAssetRecord = {
  formatVersion: peakAssetFormatVersion,
  assetKey: 'project:asset',
  generationId: 'generation-1',
  frameCount: 96_000,
  durationSec: 2,
  sampleRate: 48_000,
  channelCount: 2,
  levels: [],
}

describe('waveform source identity', () => {
  test('accepts matching metadata and rejects stale source changes', () => {
    expect(peakAssetMatchesSourceIdentity(record, {
      assetKey: 'project:asset',
      frameCount: 96_000,
      durationSec: 2,
      sampleRate: 48_000,
      channelCount: 2,
    })).toBe(true)
    expect(peakAssetMatchesSourceIdentity(record, {
      assetKey: 'project:asset',
      frameCount: 144_000,
    })).toBe(false)
    expect(peakAssetMatchesSourceIdentity(record, {
      assetKey: 'other:asset',
    })).toBe(false)
  })
})
