import { expect, test } from 'bun:test'
import { audioCoreContractVersion, type AudioAssetRef, type AudioCoreGraphSnapshot } from '../../audio-core-contract/src/index'
import { nativeAudioHostMaximumAssetFramesForChannels } from '@daw-browser/desktop-protocol/native-audio-host'
import {
  chunkNativePcmProjection,
  type NativeProjectedSourceEvent,
} from './native-pcm-chunking'

const graph = (instrument?: AudioCoreGraphSnapshot['nodes'][number]['instrument']): AudioCoreGraphSnapshot => ({
  version: audioCoreContractVersion,
  revision: 1,
  contractHash: '',
  nodes: instrument ? [{
    id: 'instrument',
    kind: 'instrument',
    inputLayout: 'stereo',
    outputLayout: 'stereo',
    processorOrder: [],
    latencyFrames: 0,
    instrument,
  }] : [],
  edges: [],
  masterNodeId: 'master',
  assets: [],
})

const asset = (assetId: string, frameCount: number, channelCount = 2): AudioAssetRef => ({
  version: audioCoreContractVersion,
  assetId,
  frameCount,
  sampleRateHz: 48_000,
  channelCount,
})

const event = (input: Partial<NativeProjectedSourceEvent> = {}): NativeProjectedSourceEvent => ({
  version: audioCoreContractVersion,
  epoch: 1,
  sequence: 1,
  sourceNodeId: 'track',
  assetId: 'source',
  startFrame: 100,
  stopFrame: 100 + 131_071,
  sourceOffsetFrame: 3,
  sourceOffsetFraction: 0.25,
  sourceFrameCount: 131_071,
  gain: 0.75,
  fadeInStartFrame: 80,
  fadeInEndFrame: 120,
  fadeOutStartFrame: 100_150,
  fadeOutEndFrame: 100_171,
  fadeInCurve: 0.25,
  fadeInCurvePosition: 0.3,
  fadeOutCurve: -0.5,
  fadeOutCurvePosition: 0.8,
  sourceIdentity: 'source:track:clip',
  ...input,
})

test('chunks stereo PCM at the exact payload-safe boundary with one-frame overlap', () => {
  const capacity = nativeAudioHostMaximumAssetFramesForChannels(2)
  const frameCount = capacity + 10
  const planes = [new Float32Array(frameCount), new Float32Array(frameCount)]
  planes[0]![capacity - 1] = 0.25
  planes[0]![capacity] = 0.5
  const result = chunkNativePcmProjection({
    graph: graph(),
    assets: [{ asset: asset('source', frameCount), pcm: { frameCount, planes } }],
    events: [event({ sourceFrameCount: frameCount })],
    firstSequence: 1,
  })
  if ('supported' in result) throw new Error(result.reason)
  expect(result.assets).toHaveLength(2)
  expect(result.assets.map(({ asset: entry }) => entry.frameCount)).toEqual([capacity, 11])
  expect(result.assets[0]?.pcm.planes[0]?.at(-1)).toBe(0.25)
  expect(result.assets[1]?.pcm.planes[0]?.[0]).toBe(0.25)
  expect(result.events).toHaveLength(2)
  expect(result.events.map((source) => source.assetId)).toEqual([
    'source:native-chunk:0',
    'source:native-chunk:1',
  ])
  expect(result.events.map((source) => source.sequence)).toEqual([1, 2])
  expect(result.events[0]).toMatchObject({
    sourceOffsetFrame: 3,
    sourceOffsetFraction: 0.25,
    fadeInStartFrame: 80,
    fadeInEndFrame: 120,
    fadeOutStartFrame: 100_150,
    fadeOutEndFrame: 100_171,
    fadeInCurve: 0.25,
    fadeInCurvePosition: 0.3,
    fadeOutCurve: -0.5,
    fadeOutCurvePosition: 0.8,
  })
  expect(result.events[1]?.sourceOffsetFrame).toBe(0)
  expect(result.events[1]?.sourceOffsetFraction).toBeUndefined()
})

test('preserves a fractional source seam and absolute fade anchors', () => {
  const capacity = nativeAudioHostMaximumAssetFramesForChannels(2)
  const frameCount = capacity + 10
  const result = chunkNativePcmProjection({
    graph: graph(),
    assets: [{
      asset: asset('source', frameCount),
      pcm: {
        frameCount,
        planes: [new Float32Array(frameCount), new Float32Array(frameCount)],
      },
    }],
    events: [event({
      startFrame: 0,
      stopFrame: frameCount * 2,
      sourceOffsetFrame: capacity - 2,
      sourceOffsetFraction: 0.5,
      sourceFrameCount: 4,
      fadeInStartFrame: 1,
      fadeInEndFrame: 3,
      fadeOutStartFrame: frameCount * 2 - 3,
      fadeOutEndFrame: frameCount * 2 - 1,
    })],
    firstSequence: 10,
  })
  if ('supported' in result) throw new Error(result.reason)
  expect(result.events).toHaveLength(2)
  expect(result.events.map((source) => source.sequence)).toEqual([10, 11])
  expect(result.events[0]).toMatchObject({
    sourceOffsetFrame: capacity - 2,
    sourceOffsetFraction: 0.5,
    fadeInStartFrame: 1,
    fadeInEndFrame: 3,
    fadeOutStartFrame: frameCount * 2 - 3,
    fadeOutEndFrame: frameCount * 2 - 1,
  })
  expect(result.events[1]).toMatchObject({
    sourceOffsetFrame: 0,
    sourceOffsetFraction: undefined,
    fadeInStartFrame: 1,
    fadeInEndFrame: 3,
    fadeOutStartFrame: frameCount * 2 - 3,
    fadeOutEndFrame: frameCount * 2 - 1,
  })
})

test('rejects oversized instrument-owned PCM because state has one asset identity', () => {
  const capacity = nativeAudioHostMaximumAssetFramesForChannels(1)
  const instrument: NonNullable<AudioCoreGraphSnapshot['nodes'][number]['instrument']> = {
    version: audioCoreContractVersion,
    kind: 'granular',
    voiceCapacity: 2,
    outputLayout: 'stereo',
    assetId: 'source',
    seed: 1,
    maxGrains: 1,
    'windowShape': 'hann',
    freeze: false,
    grainSizeMs: 5,
    densityHz: 1,
    position: 0.5,
    spray: 0,
    pitchSemitones: 0,
    reverseProbability: 0,
    stereoSpread: 0,
  }
  const frameCount = capacity + 1
  const result = chunkNativePcmProjection({
    graph: graph(instrument),
    assets: [{
      asset: asset('source', frameCount, 1),
      pcm: { frameCount, planes: [new Float32Array(frameCount)] },
    }],
    events: [],
    firstSequence: 1,
  })
  expect(result).toEqual({
    supported: false,
    reason: 'Native PCM asset "source" is owned by an instrument and exceeds the native payload capacity.',
  })
})
