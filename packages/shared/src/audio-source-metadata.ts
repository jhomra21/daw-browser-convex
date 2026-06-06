import { normalizeAudioSourceMetadataPatch } from './audio-source-rules'

export type AudioSourceMetadata = {
  durationSec: number
  sampleRate: number
  channelCount: number
}

type AudioSourceMetadataLike = {
  sourceDurationSec?: number
  sourceSampleRate?: number
  sourceChannelCount?: number
}

export function getPersistableAudioSourceMetadata(source: AudioSourceMetadataLike): AudioSourceMetadata | undefined {
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
