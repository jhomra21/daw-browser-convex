import {
  normalizeAudioSourceMetadataPatch,
  type AudioSourceKind,
} from '~/lib/audio-source-rules'

export type { AudioSourceKind } from '~/lib/audio-source-rules'

export type AudioSourceMetadata = {
  durationSec: number
  sampleRate: number
  channelCount: number
}

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

export function createAudioAssetKey() {
  return `asset:${crypto.randomUUID()}`
}

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

  const normalized = normalizeAudioSourceMetadataPatch({
    durationSec: source.sourceDurationSec,
    sampleRate: source.sourceSampleRate,
    channelCount: source.sourceChannelCount,
  })

  if (
    normalized.durationSec === undefined ||
    normalized.sampleRate === undefined ||
    normalized.channelCount === undefined
  ) {
    return undefined
  }

  return {
    durationSec: normalized.durationSec,
    sampleRate: normalized.sampleRate,
    channelCount: normalized.channelCount,
  }
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
