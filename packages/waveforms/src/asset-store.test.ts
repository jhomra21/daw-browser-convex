import { clearWaveformAssetCache, ensurePeakAsset } from './asset-store'

declare const beforeEach: (run: () => void) => void
declare const describe: (name: string, run: () => void) => void
declare const test: (name: string, run: () => Promise<void>) => void
declare const expect: (value: unknown) => { toBe: (expected: unknown) => void }

function createTestBuffer(duration: number): AudioBuffer {
  const sampleRate = 10
  const data = new Float32Array(Math.max(1, Math.round(duration * sampleRate)))

  return {
    duration,
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

describe('ensurePeakAsset', () => {
  beforeEach(() => {
    clearWaveformAssetCache()
  })

  test('serializes source changes for one asset key and rechecks identity before extraction', async () => {
    const firstIdentity = {
      assetKey: 'project:asset',
      durationSec: 1,
      sampleRate: 10,
      channelCount: 1,
    }
    const secondIdentity = {
      assetKey: 'project:asset',
      durationSec: 2,
      sampleRate: 10,
      channelCount: 1,
    }

    const [first, second] = await Promise.all([
      ensurePeakAsset({
        assetKey: 'project:asset',
        sourceIdentity: firstIdentity,
        buffer: createTestBuffer(1),
      }),
      ensurePeakAsset({
        assetKey: 'project:asset',
        sourceIdentity: secondIdentity,
        buffer: createTestBuffer(2),
      }),
    ])

    expect(first?.durationSec).toBe(1)
    expect(second?.durationSec).toBe(2)

    const cachedSecond = await ensurePeakAsset({
      assetKey: 'project:asset',
      sourceIdentity: secondIdentity,
    })

    expect(cachedSecond?.durationSec).toBe(2)
  })

  test('derives source identity from buffers when no explicit identity is passed', async () => {
    const first = await ensurePeakAsset({
      assetKey: 'project:asset',
      buffer: createTestBuffer(1),
    })
    const second = await ensurePeakAsset({
      assetKey: 'project:asset',
      buffer: createTestBuffer(2),
    })

    expect(first?.durationSec).toBe(1)
    expect(second?.durationSec).toBe(2)
  })
})
