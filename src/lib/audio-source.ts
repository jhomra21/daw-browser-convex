import type { AudioSourceKind } from '@daw-browser/shared'
import { createLocalAssetId } from '@daw-browser/shared'
import {
  getPersistableAudioSourceMetadata as getPersistableAudioSourceMetadataFromFields,
  type AudioSourceMetadata,
} from '@daw-browser/shared'

export type { AudioSourceKind } from '@daw-browser/shared'
export type { AudioSourceMetadata } from '@daw-browser/shared'

type PersistedAudioSource = {
  assetKey: string
  sourceKind: AudioSourceKind
  source: AudioSourceMetadata
}

type AudioSourceMetadataLike = {
  buffer?: AudioBuffer | null
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  sourceDurationSec?: number
  sourceSampleRate?: number
  sourceChannelCount?: number
}

export const createAudioAssetKey = createLocalAssetId

export function getAudioSourceMetadata(buffer: AudioBuffer): AudioSourceMetadata {
  return {
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
  }
}

export function getPersistableAudioSourceMetadata(source: AudioSourceMetadataLike): AudioSourceMetadata | undefined {
  if (source.buffer) {
    return getAudioSourceMetadata(source.buffer)
  }

  return getPersistableAudioSourceMetadataFromFields({
    sourceDurationSec: source.sourceDurationSec,
    sourceSampleRate: source.sourceSampleRate,
    sourceChannelCount: source.sourceChannelCount,
  })
}

export function getPersistedAudioSource(source: AudioSourceMetadataLike): PersistedAudioSource | undefined {
  if (!source.sourceAssetKey || !source.sourceKind) {
    return undefined
  }

  const metadata = getPersistableAudioSourceMetadata(source)
  if (!metadata) {
    return undefined
  }

  return {
    assetKey: source.sourceAssetKey,
    sourceKind: source.sourceKind,
    source: metadata,
  }
}
