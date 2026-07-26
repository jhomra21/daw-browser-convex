import { expect, test } from 'bun:test'
import type { AudioAssetRef, PlanarPcm } from '../../audio-core-contract/src/index'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'
import {
  preparePortableStretchAsset,
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
