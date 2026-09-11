import { expect, test } from 'bun:test'
import {
  localizeSampledInstrumentFrame,
  sampledInstrumentRegion,
  sampledInstrumentRegionBytes,
  sampledInstrumentRegionIdentity,
  sampledInstrumentRetainedBytes,
  sourceEndFrameForSampledInstrumentBuffer,
} from './sampled-instrument-region'

const source = { durationSec: 3, sampleRate: 48_000, channelCount: 2 }

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 12 / 48_000
  readonly length = 12
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  copyFromChannel(): void {}
  copyToChannel(): void {}
  getChannelData(_channel: number): Float32Array<ArrayBuffer> {
    return new Float32Array(this.length)
  }
}

test('uses rounded source frame bounds and localizes half-open frames', () => {
  const region = sampledInstrumentRegion(source, 1, 2)
  expect(region).toEqual({ sourceStartFrame: 48_000, sourceEndFrame: 96_000 })
  expect(localizeSampledInstrumentFrame(48_000, region)).toBe(0)
  expect(localizeSampledInstrumentFrame(96_000, region)).toBe(48_000)
  expect(sampledInstrumentRegionBytes(region, 2)).toBe(384_000)
})

test('identities are collision-safe and include exclusive end', () => {
  const first = sampledInstrumentRegionIdentity({ assetKey: 'a:b', url: '/a', sourceKind: 'upload', source }, { sourceStartFrame: 1, sourceEndFrame: 23 })
  const second = sampledInstrumentRegionIdentity({ assetKey: 'a', url: '/a', sourceKind: 'upload', source }, { sourceStartFrame: 1, sourceEndFrame: 23 })
  expect(first).not.toBe(second)
  expect(sampledInstrumentRegionIdentity({ assetKey: 'a:b', url: '/a', sourceKind: 'upload', source }, { sourceStartFrame: 1, sourceEndFrame: 24 })).not.toBe(first)
  expect(sampledInstrumentRegionIdentity({ assetKey: 'a:b', url: '/b', sourceKind: 'upload', source }, { sourceStartFrame: 1, sourceEndFrame: 23 })).not.toBe(first)
  expect(sampledInstrumentRegionIdentity({ assetKey: 'a:b', url: '/a', sourceKind: 'upload', source: { ...source, channelCount: 1 } }, { sourceStartFrame: 1, sourceEndFrame: 23 })).not.toBe(first)
})

test('derives source end from the transient wrapper', () => {
  expect(sourceEndFrameForSampledInstrumentBuffer({ buffer: new TestAudioBuffer(), sourceStartFrame: 8 })).toBe(20)
})

test('counts retained granular source and worklet PCM copies', () => {
  expect(sampledInstrumentRetainedBytes(384_000, 2)).toBe(768_000)
})
