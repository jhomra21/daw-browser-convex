import { primeWaveformAsset } from '~/lib/audio-peaks/asset-store'
import { getAudioSourceMetadata } from '~/lib/audio-source'

export async function primeClipSourceAsset(input: {
  sourceAssetKey: string
  sampleUrl?: string
  buffer?: AudioBuffer | null
}) {
  const record = await primeWaveformAsset({
    assetKey: input.sourceAssetKey,
    sampleUrl: input.sampleUrl,
    buffer: input.buffer ?? null,
  })

  if (!record) {
    if (input.buffer) {
      const metadata = getAudioSourceMetadata(input.buffer)
      return {
        assetKey: input.sourceAssetKey,
        durationSec: metadata.durationSec,
        sampleRate: metadata.sampleRate,
        channelCount: metadata.channelCount,
      }
    }
    return null
  }

  return {
    assetKey: input.sourceAssetKey,
    durationSec: record.durationSec,
    sampleRate: record.sampleRate,
    channelCount: record.channelCount,
  }
}


