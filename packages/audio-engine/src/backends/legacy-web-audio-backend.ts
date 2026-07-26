import {
  closeAudioRuntime,
  createAudioRuntime,
  decodeAudioData,
  getOutputLatencySec,
} from '../audio-runtime'
import { isPlanarPcmForAsset, type AudioAssetRef, type PlanarPcm } from '@daw-browser/audio-core-contract'
import type { AudioAssetRegistration, AudioAssetRelease } from '../audio-asset-types'

export type AudioEngineBackend = {
  readonly kind: 'legacy'
  createRuntime: typeof createAudioRuntime
  decodeAudioData: typeof decodeAudioData
  getOutputLatencySec: typeof getOutputLatencySec
  closeRuntime: typeof closeAudioRuntime
  registerAsset: (asset: AudioAssetRef, pcm: PlanarPcm, projectGeneration: number) => AudioAssetRegistration
  retainAsset: (assetId: string, projectGeneration: number) => AudioAssetRegistration
  releaseAsset: (assetId: string, projectGeneration: number) => AudioAssetRelease
  retireAssetGeneration: (projectGeneration: number) => void
}

export class LegacyWebAudioBackend implements AudioEngineBackend {
  readonly kind = 'legacy'
  readonly createRuntime = createAudioRuntime
  readonly decodeAudioData = decodeAudioData
  readonly getOutputLatencySec = getOutputLatencySec
  readonly closeRuntime = closeAudioRuntime
  private nextAssetSlot = 0
  private assets = new Map<string, {
    readonly handle: { slot: number; generation: number }
    readonly projectGeneration: number
    retainCount: number
  }>()

  registerAsset(asset: AudioAssetRef, _pcm: PlanarPcm, projectGeneration: number): AudioAssetRegistration {
    if (!isPlanarPcmForAsset(asset, _pcm)) return { status: 'invalid-pcm' }
    const existing = this.assets.get(asset.assetId)
    if (existing) {
      if (existing.projectGeneration !== projectGeneration) return { status: 'stale-generation' }
      existing.retainCount += 1
      return { status: 'registered', handle: existing.handle }
    }
    const handle = { slot: this.nextAssetSlot, generation: 1 }
    this.nextAssetSlot += 1
    this.assets.set(asset.assetId, { handle, projectGeneration, retainCount: 1 })
    return { status: 'registered', handle }
  }

  retainAsset(assetId: string, projectGeneration: number): AudioAssetRegistration {
    const existing = this.assets.get(assetId)
    if (!existing || existing.projectGeneration !== projectGeneration) return { status: 'stale-generation' }
    existing.retainCount += 1
    return { status: 'registered', handle: existing.handle }
  }

  releaseAsset(assetId: string, projectGeneration: number): AudioAssetRelease {
    const existing = this.assets.get(assetId)
    if (!existing || existing.projectGeneration !== projectGeneration) return { status: 'stale-generation' }
    existing.retainCount -= 1
    if (existing.retainCount === 0) this.assets.delete(assetId)
    return { status: 'released' }
  }

  retireAssetGeneration(projectGeneration: number) {
    for (const [assetId, asset] of this.assets) {
      if (asset.projectGeneration === projectGeneration) this.assets.delete(assetId)
    }
  }
}

export const createAudioEngineBackend = (): AudioEngineBackend => new LegacyWebAudioBackend()
