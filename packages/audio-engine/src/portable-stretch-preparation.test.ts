import { expect, test } from 'bun:test'
import type { AudioAssetRef, PlanarPcm } from '../../audio-core-contract/src/index'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'
import type { Track } from '@daw-browser/timeline-core/types'
import {
  preparePortableStretchAsset,
  preparePortableStretchAssets,
  registerPortableStretchAsset,
  type PortablePreparedStretchAsset,
  type PortableStretchAssetRegistry,
  type PortableStretchDiagnosticCode,
} from './portable-stretch-preparation'

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

const buffer = (
  channels: readonly (readonly number[])[] = [[0, 0.25, -0.5, 1]],
  sampleRate = 4,
) => new TestAudioBuffer(
  channels.map((channel) => new Float32Array(channel)),
  sampleRate,
)

const clip = (source = buffer()): AudioStretchRuntimeClip => ({
  id: 'clip-stretch',
  startSec: 2,
  duration: 1,
  sourceAssetKey: 'source-a',
  audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
  buffer: source,
})

const preparedAsset = (): PortablePreparedStretchAsset => {
  const source = buffer()
  const asset: AudioAssetRef = {
    version: 1,
    assetId: 'portable-stretch:7:clip-stretch',
    frameCount: source.length,
    sampleRateHz: source.sampleRate,
    channelCount: source.numberOfChannels,
  }
  const plane = new Float32Array(source.getChannelData(0))
  const pcm: PlanarPcm = {
    frameCount: source.length,
    planes: [plane],
  }
  return {
    clipId: 'clip-stretch',
    sourceAssetKey: 'source-a',
    sourceDurationSec: 1,
    projectGeneration: 7,
    projectAssetId: asset.assetId,
    portableAssetId: asset.assetId,
    asset,
    pcm,
    transferables: [plane.buffer],
    timelineStartSec: 2,
    timelineDurationSec: 1,
    sourceStartSec: 0,
  }
}

test('prepares deterministic copied PCM and exact scheduling metadata', async () => {
  const rendered = buffer([[0.5, -0.25, 0.75, -1]])
  const result = await preparePortableStretchAsset({
    clip: clip(),
    projectBpm: 120,
    projectGeneration: 7,
    renderStretch: async () => ({
      buffer: rendered,
      timelineStartSec: 2,
      timelineDurationSec: 1,
      sourceStartSec: 0,
    }),
  })

  if (!result.supported) throw new Error(result.diagnostics.map((entry) => entry.message).join('\n'))
  expect(result.asset).toMatchObject({
    clipId: 'clip-stretch',
    projectGeneration: 7,
    asset: {
      frameCount: 4,
      sampleRateHz: 4,
      channelCount: 1,
    },
    timelineStartSec: 2,
    timelineDurationSec: 1,
    sourceStartSec: 0,
  })
  expect(result.asset.portableAssetId.startsWith('portable-stretch:7:clip-stretch:')).toBe(true)
  expect(result.asset.asset.assetId).toBe(result.asset.portableAssetId)
  rendered.getChannelData(0)[0] = 1
  expect(result.asset.pcm.planes[0]?.[0]).toBe(0.5)

  const changed = await preparePortableStretchAsset({
    clip: clip(),
    projectBpm: 120,
    projectGeneration: 7,
    renderStretch: async () => ({
      buffer: buffer([[0.25, -0.25, 0.75, -1]]),
      timelineStartSec: 2,
      timelineDurationSec: 1,
      sourceStartSec: 0,
    }),
  })
  if (!changed.supported) throw new Error(changed.diagnostics.map((entry) => entry.message).join('\n'))
  expect(changed.asset.portableAssetId).not.toBe(result.asset.portableAssetId)
})

const preparedStretchTrack = (
  source: AudioBuffer,
  duration = source.duration,
  clipId = 'clip-stretch',
): Track<AudioBuffer> => ({
  id: 'track-stretch',
  name: 'Track',
  volume: 1,
  clips: [{
    id: clipId,
    name: 'Clip',
    color: '#fff',
    startSec: 2,
    duration,
    sourceAssetKey: 'source-a',
    sourceDurationSec: source.duration,
    sourceSampleRate: source.sampleRate,
    sourceChannelCount: source.numberOfChannels,
    audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    buffer: source,
  }],
})

const prepareAggregateStretch = async (
  source: AudioBuffer,
  requiredSampleRateHz?: number,
  maximumFrameCount?: number,
  duration = source.duration,
  options: {
    maximumAssetCount?: number
    maximumPreparationBytes?: number
    createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  } = {},
) => preparePortableStretchAssets({
  tracks: [preparedStretchTrack(source, duration)],
  projectBpm: 120,
  projectGeneration: 7,
  requiredSampleRateHz,
  maximumFrameCount,
  maximumAssetCount: options.maximumAssetCount,
  maximumPreparationBytes: options.maximumPreparationBytes,
  createBuffer: options.createBuffer ?? ((channels, frames, sampleRate) => new TestAudioBuffer(
    Array.from({ length: channels }, () => new Float32Array(frames)),
    sampleRate,
  )),
})

test('rejects Stretch preparation before rendering when estimated frames exceed native capacity', async () => {
  let createBufferCalls = 0
  const source = buffer([[0, 0.25, -0.5, 1]], 4)
  const result = await preparePortableStretchAssets({
    tracks: [preparedStretchTrack(source, 3)],
    projectBpm: 120,
    projectGeneration: 7,
    requiredSampleRateHz: 8,
    maximumFrameCount: 23,
    createBuffer: (channels, frames, sampleRate) => {
      createBufferCalls += 1
      return new TestAudioBuffer(
        Array.from({ length: channels }, () => new Float32Array(frames)),
        sampleRate,
      )
    },
  })

  expect(result).toMatchObject({
    supported: false,
    diagnostics: [{
      code: 'stretch-frame-capacity-exceeded',
      clipId: 'clip-stretch',
    }],
  })
  expect(createBufferCalls).toBe(0)
})

test('allows Stretch preparation at the estimated native frame boundary', async () => {
  const source = buffer([[0, 0.25, -0.5, 1]], 4)
  const result = await prepareAggregateStretch(source, 8, 24, 3, {
    maximumAssetCount: 1,
    maximumPreparationBytes: 36 * Float32Array.BYTES_PER_ELEMENT,
  })

  expect(result.supported).toBe(true)
})

test('rejects aggregate Stretch asset count before rendering', async () => {
  let createBufferCalls = 0
  const source = buffer()
  const track = preparedStretchTrack(source)
  const secondTrack = {
    ...preparedStretchTrack(source),
    id: 'track-stretch-2',
    clips: preparedStretchTrack(source, source.duration, 'clip-stretch-2').clips,
  }
  const result = await preparePortableStretchAssets({
    tracks: [track, secondTrack],
    projectBpm: 120,
    projectGeneration: 7,
    maximumAssetCount: 1,
    createBuffer: (channels, frames, sampleRate) => {
      createBufferCalls += 1
      return new TestAudioBuffer(
        Array.from({ length: channels }, () => new Float32Array(frames)),
        sampleRate,
      )
    },
    signal: undefined,
  })
  expect(result).toMatchObject({
    supported: false,
    diagnostics: [{ code: 'stretch-asset-count-exceeded' }],
  })
  expect(createBufferCalls).toBe(0)
})

test('rejects cumulative estimated Stretch bytes before rendering', async () => {
  let createBufferCalls = 0
  const source = buffer()
  const result = await preparePortableStretchAssets({
    tracks: [
      preparedStretchTrack(source),
      {
        ...preparedStretchTrack(source),
        id: 'track-stretch-2',
        clips: preparedStretchTrack(source, source.duration, 'clip-stretch-2').clips,
      },
    ],
    projectBpm: 120,
    projectGeneration: 7,
    maximumPreparationBytes: 2 * source.length * Float32Array.BYTES_PER_ELEMENT - 1,
    createBuffer: (channels, frames, sampleRate) => {
      createBufferCalls += 1
      return new TestAudioBuffer(
        Array.from({ length: channels }, () => new Float32Array(frames)),
        sampleRate,
      )
    },
  })
  expect(result).toMatchObject({
    supported: false,
    diagnostics: [{ code: 'stretch-preparation-bytes-exceeded' }],
  })
  expect(createBufferCalls).toBe(0)
})

test('admits a high-rate source when final normalized frames fit capacity', async () => {
  const source = new TestAudioBuffer([new Float32Array(288_000)], 96_000)
  const result = await prepareAggregateStretch(source, 48_000, 144_000, 3, {
    maximumAssetCount: 1,
    maximumPreparationBytes: 432_000 * Float32Array.BYTES_PER_ELEMENT,
  })
  if (!result.supported) throw new Error(result.diagnostics.map((entry) => entry.message).join('\n'))
  expect(result.assets[0]?.asset).toMatchObject({
    frameCount: 144_000,
    sampleRateHz: 48_000,
  })
})

test('rechecks actual cumulative prepared PCM bytes after rendering', async () => {
  const source = buffer()
  const result = await prepareAggregateStretch(source, undefined, undefined, source.duration, {
    maximumAssetCount: 1,
    maximumPreparationBytes: source.length * Float32Array.BYTES_PER_ELEMENT,
    createBuffer: (_channels, frames, sampleRate) => new TestAudioBuffer(
      [
        new Float32Array(frames),
        new Float32Array(frames),
      ],
      sampleRate,
    ),
  })
  expect(result).toMatchObject({
    supported: false,
    diagnostics: [{ code: 'stretch-preparation-bytes-exceeded' }],
  })
})

test('normalizes prepared Stretch PCM to the required sample rate while preserving identity metadata', async () => {
  const left = Float32Array.from({ length: 441 }, (_, index) => index / 440)
  const right = Float32Array.from({ length: 441 }, (_, index) => 1 - index / 440)
  const source = new TestAudioBuffer([left, right], 44_100)
  const normalized = await prepareAggregateStretch(source, 48_000)

  if (!normalized.supported) throw new Error(normalized.diagnostics.map((entry) => entry.message).join('\n'))
  const prepared = normalized.assets[0]
  if (!prepared) throw new Error('Expected a prepared Stretch asset.')
  expect(prepared).toMatchObject({
    clipId: 'clip-stretch',
    sourceAssetKey: 'source-a',
    sourceDurationSec: source.duration,
    projectGeneration: 7,
    timelineStartSec: 2,
    timelineDurationSec: source.duration,
    sourceStartSec: 0,
    asset: {
      frameCount: 480,
      sampleRateHz: 48_000,
      channelCount: 2,
    },
  })
  expect(prepared.pcm.frameCount).toBe(480)
  expect(prepared.pcm.planes).toHaveLength(2)
  expect(prepared.pcm.planes[0]?.[0]).toBeCloseTo(0)
  expect(prepared.pcm.planes[0]?.at(-1)).toBeCloseTo(1)
  expect(prepared.pcm.planes[1]?.[0]).toBeCloseTo(1)
  expect(prepared.pcm.planes[1]?.at(-1)).toBeCloseTo(0)
  expect(prepared.asset.assetId).toBe(prepared.portableAssetId)
  expect(prepared.projectAssetId).toBe(prepared.portableAssetId)
  const sameRate = await prepareAggregateStretch(source, 44_100)
  if (!sameRate.supported) throw new Error(sameRate.diagnostics.map((entry) => entry.message).join('\n'))
  expect(prepared.portableAssetId).not.toBe(sameRate.assets[0]?.portableAssetId)
  expect(prepared.transferables).toHaveLength(prepared.pcm.planes.length)
  expect(prepared.transferables.every((transferable, index) => (
    transferable === prepared.pcm.planes[index]?.buffer
  ))).toBeTrue()
})

test('keeps same-rate aggregate Stretch preparation identical to the existing behavior', async () => {
  const source = new TestAudioBuffer([
    Float32Array.from({ length: 441 }, (_, index) => index / 440),
  ], 44_100)
  const withoutRequirement = await prepareAggregateStretch(source)
  const sameRate = await prepareAggregateStretch(source, 44_100)

  expect(sameRate).toEqual(withoutRequirement)
})

test('resamples one-frame Stretch sources without reading outside the source plane', async () => {
  const source = new TestAudioBuffer([new Float32Array([0.25])], 44_100)
  const normalized = await prepareAggregateStretch(source, 48_000)

  if (!normalized.supported) throw new Error(normalized.diagnostics.map((entry) => entry.message).join('\n'))
  const prepared = normalized.assets[0]
  if (!prepared) throw new Error('Expected a prepared Stretch asset.')
  expect(prepared.asset.frameCount).toBe(1)
  expect(prepared.pcm.planes[0]).toEqual(new Float32Array([0.25]))
})

test('uses source-time positions for exact 2x Stretch upsampling', async () => {
  const source = new TestAudioBuffer([new Float32Array([0, 1])], 2)
  const normalized = await prepareAggregateStretch(source, 4)

  if (!normalized.supported) throw new Error(normalized.diagnostics.map((entry) => entry.message).join('\n'))
  expect(normalized.assets[0]?.pcm.planes[0]).toEqual(new Float32Array([0, 0.5, 1, 1]))
})

test('uses weighted source-time averages for Stretch downsampling', async () => {
  const source = new TestAudioBuffer([new Float32Array([1, 0, 0, 0])], 4)
  const normalized = await prepareAggregateStretch(source, 2)

  if (!normalized.supported) throw new Error(normalized.diagnostics.map((entry) => entry.message).join('\n'))
  expect(normalized.assets[0]?.pcm.planes[0]).toEqual(new Float32Array([0.5, 0]))
})

test('keeps fractional downsampling cursor positions across weighted intervals', async () => {
  const source = new TestAudioBuffer([new Float32Array([1, 2, 3, 4])], 4)
  const normalized = await prepareAggregateStretch(source, 3)

  if (!normalized.supported) throw new Error(normalized.diagnostics.map((entry) => entry.message).join('\n'))
  expect(normalized.assets[0]?.pcm.planes[0]).toEqual(new Float32Array([
    1.25,
    2.5,
    3.75,
  ]))
})

test('uses weighted averaging when downsampling multiple source frames to one', async () => {
  const source = new TestAudioBuffer([new Float32Array([1, 3])], 2)
  const normalized = await prepareAggregateStretch(source, 1)

  if (!normalized.supported) throw new Error(normalized.diagnostics.map((entry) => entry.message).join('\n'))
  expect(normalized.assets[0]?.pcm.planes[0]).toEqual(new Float32Array([2]))
})

test('reports cancellation and rejects invalid rendered channel metadata', async () => {
  const cancelled = await preparePortableStretchAsset({
    clip: clip(),
    projectBpm: 120,
    projectGeneration: 7,
    signal: AbortSignal.abort(),
    renderStretch: async () => {
      throw new Error('must not render')
    },
  })
  expect(cancelled).toMatchObject({
    supported: false,
    diagnostics: [{ code: 'stretch-render-cancelled', clipId: 'clip-stretch' }],
  })

  const invalid = await preparePortableStretchAsset({
    clip: clip(),
    projectBpm: 120,
    projectGeneration: 7,
    renderStretch: async () => ({
      buffer: buffer([[0], [0], [0]], 48_000),
      timelineStartSec: 2,
      timelineDurationSec: 1 / 48_000,
      sourceStartSec: 0,
    }),
  })
  expect(invalid).toMatchObject({
    supported: false,
    diagnostics: [{ code: 'stretch-invalid-channel-count', clipId: 'clip-stretch' }],
  })
})

test('registers generation-safe assets and releases the exact registered identity', async () => {
  const calls: string[] = []
  const registry: PortableStretchAssetRegistry = {
    register: async (asset, _pcm, generation) => {
      calls.push(`register:${asset.assetId}:${generation}`)
      return { status: 'registered', handle: { slot: 3, generation: 2 } }
    },
    release: async (assetId, generation) => {
      calls.push(`release:${assetId}:${generation}`)
      return { status: 'released' }
    },
  }
  const result = await registerPortableStretchAsset({
    prepared: preparedAsset(),
    projectGeneration: 7,
    registry,
  })

  if (!result.supported) throw new Error(result.diagnostics.map((entry) => entry.message).join('\n'))
  expect(result.registered.entry).toEqual({
    projectAssetId: 'portable-stretch:7:clip-stretch',
    portableAssetId: 'portable-stretch:7:clip-stretch',
    projectGeneration: 7,
    handle: { slot: 3, generation: 2 },
    decoded: { sampleRateHz: 4, channelCount: 1, frameCount: 4 },
  })
  expect(await result.registered.release()).toEqual({ released: true })
  expect(await result.registered.release()).toEqual({ released: true })
  expect(calls).toEqual([
    'register:portable-stretch:7:clip-stretch:7',
    'release:portable-stretch:7:clip-stretch:7',
  ])
})

test('rejects stale registrations and releases an asset registered before cancellation', async () => {
  let registerCalls = 0
  const stale = await registerPortableStretchAsset({
    prepared: preparedAsset(),
    projectGeneration: 8,
    registry: {
      register: async () => {
        registerCalls += 1
        return { status: 'registered', handle: { slot: 0, generation: 1 } }
      },
      release: async () => ({ status: 'released' }),
    },
  })
  expect(stale).toMatchObject({
    supported: false,
    diagnostics: [{ code: 'stretch-asset-stale-generation' }],
  })
  expect(registerCalls).toBe(0)

  const controller = new AbortController()
  let releases = 0
  const cancelled = await registerPortableStretchAsset({
    prepared: preparedAsset(),
    projectGeneration: 7,
    signal: controller.signal,
    registry: {
      register: async () => {
        controller.abort()
        return { status: 'registered', handle: { slot: 0, generation: 1 } }
      },
      release: async () => {
        releases += 1
        return { status: 'released' }
      },
    },
  })
  expect(cancelled).toMatchObject({
    supported: false,
    diagnostics: [{ code: 'stretch-render-cancelled' }],
  })
  expect(releases).toBe(1)
})

test('maps core registration failures to precise typed diagnostics', async () => {
  const cases: readonly {
    status: 'capacity-exceeded' | 'stale-generation' | 'invalid-pcm'
    code: PortableStretchDiagnosticCode
  }[] = [
    { status: 'capacity-exceeded', code: 'stretch-registration-capacity-exceeded' },
    { status: 'stale-generation', code: 'stretch-registration-stale-generation' },
    { status: 'invalid-pcm', code: 'stretch-registration-invalid-pcm' },
  ]
  for (const { status, code } of cases) {
    const result = await registerPortableStretchAsset({
      prepared: preparedAsset(),
      projectGeneration: 7,
      registry: {
        register: async () => ({ status }),
        release: async () => ({ status: 'released' }),
      },
    })
    expect(result).toMatchObject({
      supported: false,
      diagnostics: [{ code, clipId: 'clip-stretch' }],
    })
  }
})

test('reports stale release generations without marking the asset released', async () => {
  const result = await registerPortableStretchAsset({
    prepared: preparedAsset(),
    projectGeneration: 7,
    registry: {
      register: async () => ({ status: 'registered', handle: { slot: 0, generation: 1 } }),
      release: async () => ({ status: 'stale-generation' }),
    },
  })
  if (!result.supported) throw new Error(result.diagnostics.map((entry) => entry.message).join('\n'))
  expect(await result.registered.release()).toMatchObject({
    released: false,
    diagnostic: { code: 'stretch-release-stale-generation' },
  })
})
