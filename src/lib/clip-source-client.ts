import { ensurePeakAsset } from '@daw-browser/waveforms/asset-store'
import { getAudioSourceMetadata } from '~/lib/audio-source'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'

export async function primeClipSourceAsset(input: {
  sourceAssetKey: string
  buffer?: AudioBuffer | null
  source?: AudioPcmSourceDescriptor
}) {
  const record = await ensurePeakAsset({
    assetKey: input.sourceAssetKey,
    buffer: input.buffer ?? null,
    source: input.source,
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


