import { peakAssetMatchesSourceIdentity } from './source-identity'
import type { PeakAssetRecord } from './types'

declare const describe: (name: string, run: () => void) => void
declare const test: (name: string, run: () => void) => void
declare const expect: (value: unknown) => { toBe: (expected: unknown) => void }

const record: PeakAssetRecord = {
  assetKey: 'project:asset',
  durationSec: 2,
  sampleRate: 44100,
  channelCount: 2,
  levels: [],
}

describe('peakAssetMatchesSourceIdentity', () => {
  test('accepts matching identity metadata', () => {
    expect(peakAssetMatchesSourceIdentity(record, {
      assetKey: 'project:asset',
      durationSec: 2,
      sampleRate: 44100,
      channelCount: 2,
    })).toBe(true)
  })

  test('rejects stale peaks when source metadata changes', () => {
    expect(peakAssetMatchesSourceIdentity(record, {
      assetKey: 'project:asset',
      durationSec: 3,
      sampleRate: 44100,
      channelCount: 2,
    })).toBe(false)
    expect(peakAssetMatchesSourceIdentity(record, {
      assetKey: 'project:asset',
      durationSec: 2,
      sampleRate: 48000,
      channelCount: 2,
    })).toBe(false)
    expect(peakAssetMatchesSourceIdentity(record, {
      assetKey: 'other:asset',
    })).toBe(false)
  })
})
