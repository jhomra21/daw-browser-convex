import { expect, test } from 'bun:test'

import { audioCoreContractVersion, type AudioAssetRef } from '../../audio-core-contract/src/index'
import type { Track } from '@daw-browser/timeline-core/types'
import { projectPortableMediaPageEvents, type PortableMediaPage } from './portable-media-page-projector'

const page = (sourceStartFrame: number, assetId: string): PortableMediaPage => ({
  sourceAssetId: 'long-source',
  sourceStartFrame,
  asset: {
    version: audioCoreContractVersion,
    assetId,
    frameCount: 96_000,
    sampleRateHz: 48_000,
    channelCount: 2,
  } satisfies AudioAssetRef,
})

const track: Track = {
  id: 'track-1',
  name: 'Track 1',
  volume: 1,
  clips: [{
    id: 'clip-1',
    name: 'Long source',
    color: '#fff',
    startSec: 0,
    duration: 6,
    sourceAssetKey: 'long-source',
    sourceDurationSec: 6,
    sourceSampleRate: 48_000,
    sourceChannelCount: 2,
  }],
}

test('splits one semantic clip across prepared source pages', () => {
  const projection = projectPortableMediaPageEvents({
    tracks: [track],
    pagesBySourceAssetId: new Map([[
      'long-source',
      [page(0, 'page-0'), page(96_000, 'page-1'), page(192_000, 'page-2')],
    ]]),
    bpm: 120,
    sampleRateHz: 48_000,
    rangeStartSec: 1.5,
    rangeEndSec: 5.5,
    epoch: 7,
    firstSequence: 10,
    includeStableIdentity: true,
  })

  expect(projection.supported).toBe(true)
  if (!projection.supported) throw new Error(projection.reasons.join(' '))
  expect([...projection.handledClipIds]).toEqual(['clip-1'])
  expect(projection.events.map((event) => ({
    assetId: event.assetId,
    startFrame: event.startFrame,
    stopFrame: event.stopFrame,
    sourceOffsetFrame: event.sourceOffsetFrame,
    sourceFrameCount: event.sourceFrameCount,
    sequence: event.sequence,
    sourceIdentity: 'sourceIdentity' in event ? event.sourceIdentity : undefined,
  }))).toEqual([
    { assetId: 'page-0', startFrame: 72_000, stopFrame: 96_000, sourceOffsetFrame: 72_000, sourceFrameCount: 24_000, sequence: 10, sourceIdentity: 'source:7:track-1:6:clip-1:page:0' },
    { assetId: 'page-1', startFrame: 96_000, stopFrame: 192_000, sourceOffsetFrame: 0, sourceFrameCount: 96_000, sequence: 11, sourceIdentity: 'source:7:track-1:6:clip-1:page:96000' },
    { assetId: 'page-2', startFrame: 192_000, stopFrame: 264_000, sourceOffsetFrame: 0, sourceFrameCount: 72_000, sequence: 12, sourceIdentity: 'source:7:track-1:6:clip-1:page:192000' },
  ])
})

test('fails explicitly when a requested source range has a page gap', () => {
  const projection = projectPortableMediaPageEvents({
    tracks: [track],
    pagesBySourceAssetId: new Map([[
      'long-source',
      [page(0, 'page-0'), page(192_000, 'page-2')],
    ]]),
    bpm: 120,
    sampleRateHz: 48_000,
    rangeStartSec: 1.5,
    rangeEndSec: 5.5,
    epoch: 7,
    firstSequence: 10,
  })

  expect(projection.supported).toBe(false)
  if (projection.supported) throw new Error('Expected missing source page to fail.')
  expect(projection.reasons.join(' ')).toContain('prepared source pages contain a gap')
})
