import type { AudioSourceMetadata } from '~/lib/audio-source'
import { loadPeakAssetRecord } from '@daw-browser/waveforms/peak-db'
import { primeClipSourceAsset } from '~/lib/clip-source-client'
import { createAudioPcmSourceDescriptor, inspectAudioSourceMetadata } from '@daw-browser/audio-engine/media-pages'

type DefaultSampleCacheInput = {
  assetKey: string
  url: string
}

const pendingDefaultSampleMetadata = new Map<string, Promise<AudioSourceMetadata | null>>()

function toAudioSourceMetadata(input: {
  durationSec: number
  sampleRate: number
  channelCount: number
}): AudioSourceMetadata {
  return {
    durationSec: input.durationSec,
    sampleRate: input.sampleRate,
    channelCount: input.channelCount,
  }
}

export async function loadCachedDefaultSampleMetadata(assetKey: string): Promise<AudioSourceMetadata | null> {
  const record = await loadPeakAssetRecord(assetKey)
  if (!record) return null
  return toAudioSourceMetadata(record)
}

export async function ensureDefaultSampleMetadata(input: DefaultSampleCacheInput): Promise<AudioSourceMetadata | null> {
  const pending = pendingDefaultSampleMetadata.get(input.assetKey)
  if (pending) return await pending

  const task = (async () => {
    const cached = await loadCachedDefaultSampleMetadata(input.assetKey)
    if (cached) return cached

    const metadata = await inspectAudioSourceMetadata(input.url)
    if (metadata.durationSec === undefined) return null
    const source = createAudioPcmSourceDescriptor({
      identity: `default-sample:${input.assetKey}`,
      durationSec: metadata.durationSec,
      frameCount: Math.round(metadata.durationSec * metadata.sampleRate),
      sampleRate: metadata.sampleRate,
      channelCount: metadata.channelCount,
      source: input.url,
    })
    const primed = await primeClipSourceAsset({
      sourceAssetKey: input.assetKey,
      source,
    })
    if (!primed) return null

    return toAudioSourceMetadata(primed)
  })()

  pendingDefaultSampleMetadata.set(input.assetKey, task)
  try {
    return await task
  } finally {
    if (pendingDefaultSampleMetadata.get(input.assetKey) === task) {
      pendingDefaultSampleMetadata.delete(input.assetKey)
    }
  }
}
