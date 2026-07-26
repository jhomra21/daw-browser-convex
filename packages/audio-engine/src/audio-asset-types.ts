import type { AudioAssetRef, PlanarPcm } from '../../audio-core-contract/src/index'

export type AudioAssetHandle = {
  slot: number
  generation: number
}

export type AudioAssetRegistration =
  | { status: 'registered'; handle: AudioAssetHandle }
  | { status: 'capacity-exceeded' }
  | { status: 'stale-generation' }
  | { status: 'invalid-pcm' }

export type AudioAssetRelease =
  | { status: 'released' }
  | { status: 'stale-generation' }

export type AudioAssetRegistrationInput = {
  asset: AudioAssetRef
  pcm: PlanarPcm
  projectGeneration: number
}
