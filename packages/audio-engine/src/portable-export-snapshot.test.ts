import { expect, test } from 'bun:test'
import {
  createDefaultAutoPanParams,
  createDefaultChorusParams,
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultEnsembleParams,
  createDefaultEqParams,
  createDefaultFlangerParams,
  createDefaultGateParams,
  createDefaultLimiterParams,
  createDefaultPhaserParams,
  createDefaultReverbParams,
  createDefaultSaturatorParams,
  createDefaultTremoloParams,
} from '@daw-browser/shared'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { audioCoreContractVersion } from '../../audio-core-contract/src/index'
import { compilePortableExportSnapshot } from './portable-export-snapshot'
import type { PortablePreparedStretchAsset } from './portable-stretch-preparation'

class TestAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number

  constructor(
    private readonly channels: Float32Array<ArrayBuffer>[],
    sampleRate: number,
  ) {
    this.sampleRate = sampleRate
    this.numberOfChannels = channels.length
    this.length = channels[0]?.length ?? 0
    this.duration = this.length / sampleRate
  }

  copyFromChannel(destination: Float32Array, channel: number, offset = 0) {
    destination.set(this.channels[channel].subarray(offset, offset + destination.length))
  }

  copyToChannel(source: Float32Array, channel: number, offset = 0) {
    this.channels[channel].set(source, offset)
  }

  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    return this.channels[channel]
  }
}

const floats = (values: readonly number[]) => new Float32Array(new Float32Array(values))

const clip = (overrides: Partial<Clip<AudioBuffer>> = {}): Clip<AudioBuffer> => ({
  id: 'clip-1',
  name: 'clip-1',
  color: '#fff',
  startSec: 0,
  duration: 1,
  sourceAssetKey: 'source-a',
  buffer: new TestAudioBuffer([floats([0, 0.25, -0.5, 1]), floats([1, -0.5, 0.25, 0])], 48_000),
  ...overrides,
})

const track = (clips: Clip<AudioBuffer>[], overrides: Partial<Track<AudioBuffer>> = {}): Track<AudioBuffer> => ({
  id: 'track-1',
  name: 'track-1',
  volume: 1,
  clips,
  ...overrides,
})

const compile = (tracks: readonly Track<AudioBuffer>[]) => compilePortableExportSnapshot({
  tracks,
  bpm: 120,
  range: { mode: 'custom', startSec: 0, endSec: 1 },
  sampleRateHz: 48_000,
  revision: 1,
  epoch: 1,
  firstSequence: 1,
})

test('extracts stable transient asset identities and exact planar PCM copies', () => {
  const source = clip()
  const result = compile([track([source, clip({ id: 'clip-2', buffer: source.buffer })])])

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets).toHaveLength(1)
  expect(result.assets[0]).toMatchObject({
    asset: {
      assetId: 'portable-export:source-a',
      frameCount: 4,
      sampleRateHz: 48_000,
      channelCount: 2,
    },
    pcm: {
      frameCount: 4,
      planes: [floats([0, 0.25, -0.5, 1]), floats([1, -0.5, 0.25, 0])],
    },
  })
  result.assets[0]?.transferables.forEach((buffer, index) => {
    expect(buffer === result.assets[0]?.pcm.planes[index]?.buffer).toBe(true)
  })
  expect(result.events.map((event) => event.assetId)).toEqual(['portable-export:source-a', 'portable-export:source-a'])
})

test('compiles deterministic snapshots without retaining hydrated AudioBuffer data', () => {
  const source = clip()
  const input = [track([source])]
  const first = compile(input)
  const second = compile(input)

  if (!first.supported || !second.supported) throw new Error('Expected supported snapshot.')
  expect(second).toEqual(first)
  const sourceBuffer = source.buffer
  if (!sourceBuffer) throw new Error('Expected hydrated audio buffer.')
  sourceBuffer.getChannelData(0)[0] = 0.75
  expect(first.assets[0]?.pcm.planes[0]?.[0]).toBe(0)
})

test('rebases custom-range events to the Worker render origin', () => {
  const result = compilePortableExportSnapshot({
    tracks: [track([clip({ startSec: 2, duration: 1 })])],
    bpm: 120,
    range: { mode: 'custom', startSec: 2, endSec: 3 },
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
  })

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.events).toEqual([
    expect.objectContaining({
      startFrame: 0,
      stopFrame: 4,
    }),
  ])
})

test('uses pre-rendered Stretch PCM as the only portable source asset', () => {
  const source = clip({
    audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
  })
  const sourceBuffer = source.buffer
  if (!sourceBuffer) throw new Error('Expected hydrated source buffer.')
  const planes = [
    floats([0.5, 0.25, 0, -0.25]),
    floats([-0.5, -0.25, 0, 0.25]),
  ]
  const prepared: PortablePreparedStretchAsset = {
    clipId: source.id,
    sourceAssetKey: source.sourceAssetKey,
    sourceDurationSec: sourceBuffer.duration,
    projectGeneration: 7,
    projectAssetId: 'portable-stretch:7:clip-1',
    portableAssetId: 'portable-stretch:7:clip-1',
    asset: {
      version: audioCoreContractVersion,
      assetId: 'portable-stretch:7:clip-1',
      frameCount: 4,
      sampleRateHz: 48_000,
      channelCount: 2,
    },
    pcm: { frameCount: 4, planes },
    transferables: planes.map((plane) => plane.buffer),
    timelineStartSec: 0,
    timelineDurationSec: 4 / 48_000,
    sourceStartSec: 0,
  }
  const result = compilePortableExportSnapshot({
    tracks: [track([source])],
    bpm: 120,
    range: { mode: 'custom', startSec: 0, endSec: 1 },
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    projectGeneration: 7,
    preparedStretchAssets: [prepared],
  })

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets).toEqual([prepared])
  expect(result.events).toEqual([
    expect.objectContaining({
      assetId: 'portable-stretch:7:clip-1',
      startFrame: 0,
      stopFrame: 4,
      sourceOffsetFrame: 0,
      sourceFrameCount: 4,
    }),
  ])
})

test('returns typed diagnostics when offline Stretch assets are absent or stale', () => {
  const source = clip({
    audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
  })
  const missing = compile([track([source])])
  expect(missing).toMatchObject({
    supported: false,
    diagnostics: [{
      code: 'stretch-prepared-asset-required',
      clipId: 'clip-1',
    }],
  })
  expect(compile([track([clip({
    audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 },
  })])])).toMatchObject({
    supported: false,
    diagnostics: [{
      code: 'warp-mode-unsupported',
      clipId: 'clip-1',
      message: 'clip-1: repitch warp is not supported by portable export.',
    }],
  })

  const sourceBuffer = source.buffer
  if (!sourceBuffer) throw new Error('Expected hydrated source buffer.')
  const plane = floats([0, 0.25, -0.5, 1])
  const stale = compilePortableExportSnapshot({
    tracks: [track([source])],
    bpm: 120,
    range: { mode: 'custom', startSec: 0, endSec: 1 },
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    projectGeneration: 8,
    preparedStretchAssets: [{
      clipId: source.id,
      sourceAssetKey: source.sourceAssetKey,
      sourceDurationSec: sourceBuffer.duration,
      projectGeneration: 7,
      projectAssetId: 'portable-stretch:7:clip-1',
      portableAssetId: 'portable-stretch:7:clip-1',
      asset: {
        version: audioCoreContractVersion,
        assetId: 'portable-stretch:7:clip-1',
        frameCount: 4,
        sampleRateHz: 48_000,
        channelCount: 1,
      },
      pcm: { frameCount: 4, planes: [plane] },
      transferables: [plane.buffer],
      timelineStartSec: 0,
      timelineDurationSec: 4 / 48_000,
      sourceStartSec: 0,
    }],
  })
  expect(stale).toMatchObject({
    supported: false,
    diagnostics: [{
      code: 'stretch-asset-stale-generation',
      clipId: 'clip-1',
    }],
  })
})

test('projects fixture-proven static, modulation, and dynamics processors for offline export while rejecting unsupported processors', () => {
  const source = track([clip()])
  const result = compilePortableExportSnapshot({
    tracks: [source],
    bpm: 120,
    range: { mode: 'custom', startSec: 0, endSec: 1 },
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    fx: {
      masterFxInstances: [],
      trackFx: {
        'track-1': {
          instances: [
            {
              id: 'portable-saturator',
              kind: 'saturator',
              params: { ...createDefaultSaturatorParams(), driveDb: 12 },
            },
            {
              id: 'portable-eq',
              kind: 'eq',
              params: { ...createDefaultEqParams(), channelMode: 'mono' },
            },
            {
              id: 'portable-chorus',
              kind: 'chorus',
              params: { version: 1, state: createDefaultChorusParams() },
            },
            {
              id: 'portable-flanger',
              kind: 'flanger',
              params: { version: 1, state: createDefaultFlangerParams() },
            },
            {
              id: 'portable-phaser',
              kind: 'phaser',
              params: { version: 1, state: createDefaultPhaserParams() },
            },
            {
              id: 'portable-tremolo',
              kind: 'tremolo',
              params: { version: 1, state: createDefaultTremoloParams() },
            },
            {
              id: 'portable-autopan',
              kind: 'autopan',
              params: { version: 1, state: createDefaultAutoPanParams() },
            },
            {
              id: 'portable-ensemble',
              kind: 'ensemble',
              params: { version: 1, state: createDefaultEnsembleParams() },
            },
            {
              id: 'portable-gate',
              kind: 'gate',
              params: { version: 1, state: createDefaultGateParams() },
            },
            {
              id: 'portable-compressor',
              kind: 'compressor',
              params: createDefaultCompressorParams(),
            },
          ],
        },
      },
    },
  })
  expect(result.supported).toBe(true)
  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.find((node) => node.id === 'track-1')?.processorOrder.map((processor) => [
    processor.kind,
    processor.latencyFrames,
    processor.tailFrames,
    processor.parameterTargets,
  ])).toEqual([
    ['saturator', 0, 0, []],
    ['eq', 0, 0, []],
    ['chorus', 0, 768, []],
    ['flanger', 0, 1_080, []],
    ['phaser', 0, 48, []],
    ['tremolo', 0, 0, []],
    ['autopan', 0, 0, []],
    ['ensemble', 0, 1_152, []],
    ['gate', 96, 0, []],
    ['compressor', 480, 0, []],
  ])

  const unsupported = compilePortableExportSnapshot({
    tracks: [source],
    bpm: 120,
    range: { mode: 'custom', startSec: 0, endSec: 1 },
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    fx: {
      masterFxInstances: [],
      trackFx: {
        'track-1': {
          instances: [
            {
              id: 'unsupported-limiter',
              kind: 'limiter',
              params: { version: 1, state: createDefaultLimiterParams() },
            },
            {
              id: 'unsupported-delay',
              kind: 'delay',
              params: createDefaultDelayParams(),
            },
            {
              id: 'unsupported-reverb',
              kind: 'reverb',
              params: createDefaultReverbParams(),
            },
          ],
        },
      },
    },
  })
  expect(unsupported).toEqual({
    supported: false,
    reasons: [
      'unsupported-limiter: processor "limiter" is not supported by the portable core.',
      'unsupported-delay: processor "delay" is not supported by the portable core.',
      'unsupported-reverb: processor "reverb" is not supported by the portable core.',
    ],
    diagnostics: [],
  })
})

test('reports portable support rejections without emitting a partial snapshot', () => {
  const result = compilePortableExportSnapshot({
    tracks: [
      track([clip({ id: 'warped', audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 } })], { volume: 0.5 }),
      track([clip({ id: 'midi', midi: { wave: 'sine', notes: [] } })], { id: 'instrument', kind: 'instrument' }),
      track([clip({ id: 'routed' })], { id: 'routed-track', outputTargetId: 'track-1' }),
    ],
    bpm: 120,
    range: { mode: 'custom', startSec: 0, endSec: 1 },
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    hasExternalPlugins: true,
  })

  expect(result).toEqual({
    supported: false,
    reasons: [
      'Live external plugins must be frozen or bypassed before portable export.',
      'track-1: track gain, mute, solo, or routing is not supported.',
      'instrument: instrument tracks are not supported.',
      'routed-track: track gain, mute, solo, or routing is not supported.',
    ],
    diagnostics: [],
  })
})
