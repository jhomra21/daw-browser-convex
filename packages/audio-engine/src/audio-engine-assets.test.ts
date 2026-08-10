import { describe, expect, test } from 'bun:test'
import { AudioEngine, type AudioEffectRuntimeInstance } from './audio-engine'
import { audioCoreContractVersion, type AudioAssetRef } from '../../audio-core-contract/src/index'

class FxInterceptingAudioEngine extends AudioEngine {
  readonly calls: Array<{ trackId: string; instances: AudioEffectRuntimeInstance[] }> = []

  override async setTrackFxInstances(trackId: string, instances: AudioEffectRuntimeInstance[]) {
    this.calls.push({ trackId, instances })
  }
}

describe('AudioEngine assets', () => {
  test('keeps the AudioEngine facade lazy and overrideable', async () => {
    const engine = new FxInterceptingAudioEngine()

    expect(engine.getRuntimeSnapshot().state).toBe('uninitialized')
    await engine.setTrackFxInstances('track-1', [])

    expect(engine.calls).toEqual([{ trackId: 'track-1', instances: [] }])
  })

  test('keeps asset registrations generation-safe', () => {
    const engine = new AudioEngine()
    const asset: AudioAssetRef = {
      version: audioCoreContractVersion,
      assetId: 'asset:one',
      frameCount: 2,
      sampleRateHz: 48_000,
      channelCount: 1,
    }
    const pcm = { frameCount: 2, planes: [new Float32Array([0, 1])] }

    const first = engine.registerAsset(asset, pcm, 1)
    expect(first.status).toBe('registered')
    expect(engine.registerAsset(asset, pcm, 1)).toEqual(first)
    expect(engine.releaseAsset(asset.assetId, 1)).toEqual({ status: 'released' })
    expect(engine.retainAsset(asset.assetId, 1)).toEqual(first)
    expect(engine.releaseAsset(asset.assetId, 1)).toEqual({ status: 'released' })
    expect(engine.releaseAsset(asset.assetId, 1)).toEqual({ status: 'released' })
    expect(engine.retainAsset(asset.assetId, 1)).toEqual({ status: 'stale-generation' })
    expect(engine.registerAsset(asset, pcm, 2)).toEqual({ status: 'registered', handle: { slot: 1, generation: 1 } })
    expect(engine.retainAsset(asset.assetId, 1)).toEqual({ status: 'stale-generation' })
    engine.retireAssetGeneration(2)
    expect(engine.retainAsset(asset.assetId, 2)).toEqual({ status: 'stale-generation' })
  })

  test('rejects malformed planar PCM without allocating an asset slot', () => {
    const engine = new AudioEngine()
    const asset: AudioAssetRef = {
      version: audioCoreContractVersion,
      assetId: 'asset:invalid',
      frameCount: 2,
      sampleRateHz: 48_000,
      channelCount: 1,
    }

    expect(engine.registerAsset(asset, { frameCount: 2, planes: [new Float32Array([0])] }, 1))
      .toEqual({ status: 'invalid-pcm' })
    expect(engine.registerAsset(asset, { frameCount: 2, planes: [new Float32Array([0, 1])] }, 1))
      .toEqual({ status: 'registered', handle: { slot: 0, generation: 1 } })
  })
})
