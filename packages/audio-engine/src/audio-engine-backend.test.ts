import { describe, expect, test } from 'bun:test'
import { AudioEngine, type AudioEffectRuntimeInstance } from './audio-engine'
import { createAudioEngineBackend, LegacyWebAudioBackend } from './backends/legacy-web-audio-backend'
import { audioCoreContractVersion, type AudioAssetRef } from '../../audio-core-contract/src/index'

class FxInterceptingAudioEngine extends AudioEngine {
  readonly calls: Array<{ trackId: string; instances: AudioEffectRuntimeInstance[] }> = []

  override async setTrackFxInstances(trackId: string, instances: AudioEffectRuntimeInstance[]) {
    this.calls.push({ trackId, instances })
  }
}

describe('AudioEngine backend seam', () => {
  test('selects the legacy Web Audio backend', () => {
    const backend = createAudioEngineBackend()

    expect(backend).toBeInstanceOf(LegacyWebAudioBackend)
    expect(backend.kind).toBe('legacy')
  })

  test('keeps the AudioEngine facade lazy and overrideable', async () => {
    const engine = new FxInterceptingAudioEngine()

    expect(engine.getRuntimeSnapshot().state).toBe('uninitialized')
    await engine.setTrackFxInstances('track-1', [])

    expect(engine.calls).toEqual([{ trackId: 'track-1', instances: [] }])
  })

  test('keeps legacy asset registrations generation-safe while preserving the legacy backend', () => {
    const backend = createAudioEngineBackend()
    const asset: AudioAssetRef = {
      version: audioCoreContractVersion,
      assetId: 'asset:one',
      frameCount: 2,
      sampleRateHz: 48_000,
      channelCount: 1,
    }
    const pcm = { frameCount: 2, planes: [new Float32Array([0, 1])] }

    const first = backend.registerAsset(asset, pcm, 1)
    expect(first.status).toBe('registered')
    expect(backend.registerAsset(asset, pcm, 1)).toEqual(first)
    expect(backend.releaseAsset(asset.assetId, 1)).toEqual({ status: 'released' })
    expect(backend.retainAsset(asset.assetId, 1)).toEqual(first)
    expect(backend.releaseAsset(asset.assetId, 1)).toEqual({ status: 'released' })
    expect(backend.releaseAsset(asset.assetId, 1)).toEqual({ status: 'released' })
    expect(backend.retainAsset(asset.assetId, 1)).toEqual({ status: 'stale-generation' })
    expect(backend.registerAsset(asset, pcm, 2)).toEqual({ status: 'registered', handle: { slot: 1, generation: 1 } })
    expect(backend.retainAsset(asset.assetId, 1)).toEqual({ status: 'stale-generation' })
    backend.retireAssetGeneration(2)
    expect(backend.retainAsset(asset.assetId, 2)).toEqual({ status: 'stale-generation' })
  })
})
