import { expect, test } from 'bun:test'
import { audioCoreContractVersion, type AudioAssetRef } from '../../audio-core-contract/src/index'
import type { Clip } from '@daw-browser/timeline-core/types'
import { projectPortableClipEvents } from './portable-clip-projector'
import type { PortablePreparedStretchAsset } from './portable-stretch-preparation'

const asset: AudioAssetRef = {
  version: audioCoreContractVersion,
  assetId: 'asset:one',
  frameCount: 240_000,
  sampleRateHz: 48_000,
  channelCount: 1,
}

const clip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  name: 'clip-1',
  startSec: 2,
  duration: 4,
  color: '#fff',
  sourceAssetKey: 'source-1',
  bufferOffsetSec: 1,
  gain: 0.5,
  fades: {
    fadeInSec: 1,
    fadeOutSec: 1,
    fadeInCurve: 0,
    fadeOutCurve: 0,
  },
  ...overrides,
})

const project = (clips: readonly Clip[]) => projectPortableClipEvents({
  tracks: [{
    id: 'track-1',
    name: 'track-1',
    volume: 1,
    clips: [...clips],
  }],
  assets: new Map([['source-1', asset]]),
  bpm: 120,
  sampleRateHz: 48_000,
  rangeStartSec: 0,
  rangeEndSec: 10,
  epoch: 3,
  firstSequence: 9,
})

const preparedStretchPlane = new Float32Array(192_000)

const preparedStretch: PortablePreparedStretchAsset = {
  clipId: 'clip-1',
  sourceAssetKey: 'source-1',
  sourceDurationSec: 5,
  projectGeneration: 7,
  projectAssetId: 'portable-stretch:7:clip-1',
  portableAssetId: 'portable-stretch:7:clip-1',
  asset: {
    version: audioCoreContractVersion,
    assetId: 'portable-stretch:7:clip-1',
    frameCount: 192_000,
    sampleRateHz: 48_000,
    channelCount: 1,
  },
  pcm: { frameCount: 192_000, planes: [preparedStretchPlane] },
  transferables: [preparedStretchPlane.buffer],
  timelineStartSec: 2,
  timelineDurationSec: 4,
  sourceStartSec: 0,
}

test('projects raw audio clips with source offsets and linear fades', () => {
  expect(project([clip()])).toEqual({
    supported: true,
    events: [{
      version: audioCoreContractVersion,
      epoch: 3,
      sequence: 9,
      sourceNodeId: 'track-1',
      assetId: 'asset:one',
      startFrame: 96_000,
      stopFrame: 288_000,
      sourceOffsetFrame: 48_000,
      sourceFrameCount: 192_000,
      gain: 0.5,
      fadeInStartFrame: 96_000,
      fadeInEndFrame: 144_000,
      fadeOutStartFrame: 240_000,
      fadeOutEndFrame: 288_000,
    }],
  })
})

test('uses the existing timeline time map for a scheduling range', () => {
  expect(projectPortableClipEvents({
    tracks: [{
      id: 'track-1',
      name: 'track-1',
      volume: 1,
      clips: [clip()],
    }],
    assets: new Map([['source-1', asset]]),
    bpm: 120,
    sampleRateHz: 48_000,
    rangeStartSec: 3,
    rangeEndSec: 4,
    epoch: 1,
    firstSequence: 1,
  })).toMatchObject({
    supported: true,
    events: [{
      startFrame: 144_000,
      stopFrame: 192_000,
      sourceOffsetFrame: 96_000,
      sourceFrameCount: 48_000,
    }],
  })
})

test('projects only exact pre-rendered Stretch metadata through the existing time map', () => {
  expect(projectPortableClipEvents({
    tracks: [{
      id: 'track-1',
      name: 'track-1',
      volume: 1,
      clips: [clip({ audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 } })],
    }],
    assets: new Map([['source-1', asset]]),
    preparedStretchAssets: new Map([['clip-1', preparedStretch]]),
    projectGeneration: 7,
    warpContext: 'offline',
    bpm: 120,
    sampleRateHz: 48_000,
    rangeStartSec: 3,
    rangeEndSec: 4,
    epoch: 1,
    firstSequence: 1,
  })).toMatchObject({
    supported: true,
    events: [{
      assetId: 'portable-stretch:7:clip-1',
      startFrame: 144_000,
      stopFrame: 192_000,
      sourceOffsetFrame: 48_000,
      sourceFrameCount: 48_000,
    }],
  })
})

test('rejects pre-rendered Stretch PCM that would require portable resampling', () => {
  const plane = new Float32Array(176_400)
  const mismatched: PortablePreparedStretchAsset = {
    ...preparedStretch,
    asset: {
      ...preparedStretch.asset,
      frameCount: plane.length,
      sampleRateHz: 44_100,
    },
    pcm: { frameCount: plane.length, planes: [plane] },
    transferables: [plane.buffer],
  }
  expect(projectPortableClipEvents({
    tracks: [{
      id: 'track-1',
      name: 'track-1',
      volume: 1,
      clips: [clip({ audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 } })],
    }],
    assets: new Map(),
    preparedStretchAssets: new Map([['clip-1', mismatched]]),
    projectGeneration: 7,
    warpContext: 'offline',
    bpm: 120,
    sampleRateHz: 48_000,
    rangeStartSec: 0,
    rangeEndSec: 10,
    epoch: 1,
    firstSequence: 1,
  })).toEqual({
    supported: false,
    reasons: [
      'clip-1: pre-rendered Stretch audio must match the portable session sample rate.',
    ],
    diagnostics: [{
      code: 'stretch-invalid-sample-rate',
      clipId: 'clip-1',
      message: 'clip-1: pre-rendered Stretch audio must match the portable session sample rate.',
    }],
  })
})

test('rejects a pre-rendered session asset from a stale generation', () => {
  expect(projectPortableClipEvents({
    tracks: [{
      id: 'track-1',
      name: 'track-1',
      volume: 1,
      clips: [clip({ audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 } })],
    }],
    assets: new Map(),
    preparedStretchAssets: new Map([['clip-1', preparedStretch]]),
    projectGeneration: 8,
    warpContext: 'realtime',
    bpm: 120,
    sampleRateHz: 48_000,
    rangeStartSec: 0,
    rangeEndSec: 10,
    epoch: 1,
    firstSequence: 1,
  })).toEqual({
    supported: false,
    reasons: [
      'clip-1: pre-rendered Stretch asset belongs to a stale project generation.',
    ],
    diagnostics: [{
      code: 'stretch-asset-stale-generation',
      clipId: 'clip-1',
      message: 'clip-1: pre-rendered Stretch asset belongs to a stale project generation.',
    }],
  })
})

test('rejects realtime Stretch without silently scheduling the raw asset', () => {
  expect(project([
    clip({ audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 } }),
  ])).toEqual({
    supported: false,
    reasons: [
      'clip-1: realtime Stretch warp is not supported by the portable core.',
    ],
    diagnostics: [{
      code: 'stretch-realtime-unsupported',
      clipId: 'clip-1',
      message: 'clip-1: realtime Stretch warp is not supported by the portable core.',
    }],
  })
})

test('reports unsupported project features without producing a partial schedule', () => {
  expect(project([
    clip({ audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 } }),
    clip({
      id: 'clip-2',
      fades: {
        fadeInSec: 1,
        fadeOutSec: 0,
        fadeInCurve: 0.5,
        fadeOutCurve: 0,
      },
    }),
  ])).toEqual({
    supported: false,
    reasons: [
      'clip-1: realtime repitch warp is not supported by the portable core.',
      'clip-2: curved fades are not supported.',
    ],
    diagnostics: [{
      code: 'warp-mode-unsupported',
      clipId: 'clip-1',
      message: 'clip-1: realtime repitch warp is not supported by the portable core.',
    }],
  })
})
